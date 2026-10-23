// ── Orchestration: process manager + dispatch + RPC handlers ──

import { writeFileSync, existsSync } from "fs";
import { join } from "path";
import type { AgentProc } from "./core";
import { spawnRpcSubprocess } from "./core";
import { SessionLogger, agentKey, agentNameKey, clearTimers, resetForDispatch, blankProcState, displayName, extractLastLine, isWritable, parseModelId, safeUnlink, shortModel, MAX_COLLECTED_TEXT, DEFAULT_DISPATCH_TIMEOUT_MS, type BatchDispatchResult, type BatchTaskResult, type AgentDef } from "./core";
import type { AgentTeamContext, AgentMode } from "./core";
import { resolveSkillPath } from "./config";
import { buildExtensionCliArgs } from "./extensions";
import { availableAgentNames, piBin } from "./helpers";

const KILLALL_TIMEOUT_MS = 5_000;
const SPAWN_READY_TIMEOUT_MS = 15_000;
/** Minimum time between streaming-token UI invalidations. Prevents render
 *  thrashing when a subagent emits many rapid text_delta events. */
const STREAM_INVALIDATE_THROTTLE_MS = 100;

export const MAX_RESPONSE_LENGTH = 600000; // Subagent tool-result cap. Keep the truncation marker in formatBatchParts (integrations.ts) in sync.
export const PONG_TIMEOUT = 600_000;  // 10 min — inactivity (reset on any RPC event)

/** Loop guard: stop a subagent that repeats the exact same tool call (same name
 *  AND same arguments) this many times within one dispatch. Healthy agents in
 *  measured runs repeated a signature at most twice, so this has high precision. */
export const STUCK_REPEAT_LIMIT = 3;
/** Loop guard: stop a subagent that makes this many consecutive tool calls
 *  without emitting any assistant text. A worker that acts forever and never
 *  reports cannot converge — it would otherwise run until the wall-clock cap
 *  (or a provider timeout) and return nothing. The count is a streak that
 *  resets on every assistant text (see `toolsSinceAssistantText`), so a
 *  subagent that answers once and then loops forever is still stopped; healthy
 *  agents keep reporting, so this never fires on a productive worker. */
export const STUCK_TOOL_LIMIT = 40;

/** Post-process a subagent's static system prompt before it is handed to the
 *  `pi` subprocess. This is the single hook where the subagent prompt can be
 *  adjusted at runtime (e.g. for the orchestrator's creative/standard mode).
 *
 *  In `creative` mode, drop the YAGNI / principles / minimalism constraints so
 *  the subagent can explore freely (mirrors the orchestrator prompt behavior).
 *  In `standard` mode the prompt is returned unchanged.
 *
 *  Returns the transformed prompt; callers append any trailing newline. */
export function postProcessAgentPrompt(prompt: string, mode: AgentMode): string {
  if (mode !== "creative") return prompt;
  let out = prompt;
  // Remove "# Principles" sections (heading -> next heading or EOF).
  const lines = out.split("\n");
  const filtered: string[] = [];
  let inPrinciples = false;
  for (const line of lines) {
    if (/^# Principles\s*$/.test(line.trim())) { inPrinciples = true; continue; }
    if (inPrinciples) {
      if (/^#\s+/.test(line)) { inPrinciples = false; }
      else continue;
    }
    filtered.push(line);
  }
  out = filtered.join("\n");
  // Remove explicit minimalism / YAGNI / KISS guidance lines (whole-line).
  out = out
    .replace(/^- Make the smallest diff that satisfies the task\.\s*$/gm, "")
    .replace(/^- Keep diffs minimal\.\s*$/gm, "")
    .replace(/^- \*\*Minimalism & Craftsmanship\*\*.*\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

/** Auto-compactions tolerated within one dispatch before aborting as
 *  TASK_TOO_LARGE. Compactions are allowed to complete — the subagent keeps
 *  working — so large tasks aren't killed at their first sign of pressure.
 *  Only an aborted compaction or exceeding this cap is treated as a bail. */
const MAX_AUTO_COMPACTIONS = 2;

/** Shared elapsed-time ticker for every in-flight dispatch.
 *  Previously each subagent owned its own `setInterval(500ms)` purely to
 *  refresh its elapsed-seconds label, so a 5-task batch ran 5 timers that each
 *  triggered a full-widget repaint (10 renders/s) on top of the streaming
 *  repaints. One timer now refreshes every running proc and repaints once.
 *
 *  Entries are self-healing: a proc is dropped as soon as it leaves
 *  running/starting, so no cleanup call site can leak a tick or keep the timer
 *  alive. The timer is unref'd so it never holds the process open. */
const activeRuns = new Map<AgentProc, number>(); // proc → start timestamp
let elapsedTicker: ReturnType<typeof setInterval> | undefined;
let elapsedTickerCtx: AgentTeamContext | null = null;

export function startElapsedTicker(ctx: AgentTeamContext, ap: AgentProc, t0: number) {
  activeRuns.set(ap, t0);
  elapsedTickerCtx = ctx;
  if (elapsedTicker) return;
  elapsedTicker = setInterval(() => {
    if (activeRuns.size === 0) { stopElapsedTicker(); return; }
    const now = Date.now();
    for (const [proc, start] of activeRuns) {
      if (proc.status !== "running" && proc.status !== "starting") { activeRuns.delete(proc); continue; }
      proc.elapsed = now - start;
    }
    if (activeRuns.size === 0) { stopElapsedTicker(); return; }
    elapsedTickerCtx?.invalidate();
  }, 500);
  // Don't keep an otherwise-idle pi process alive just for the label.
  if (typeof (elapsedTicker as any)?.unref === "function") (elapsedTicker as any).unref();
}

/** Stop the shared ticker and forget every tracked run. Used on teardown. */
export function stopElapsedTicker() {
  if (elapsedTicker) { clearInterval(elapsedTicker); elapsedTicker = undefined; }
  activeRuns.clear();
  elapsedTickerCtx = null;
}

// Map of event type → log message formatter for simple delegation
const simpleLogEvents: Record<string, (ev: any) => string> = {
  auto_retry_end: (ev) => `AUTO-RETRY ${ev.success ? "succeeded" : "failed"} (attempt ${ev.attempt})`,
};

const UI_FIRE_AND_FORGET = new Set(["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]);

/** Build the signal returned to the orchestrator when a subagent's context
 *  genuinely cannot be managed — repeated auto-compactions or a compaction
 *  that was aborted. The `TASK_TOO_LARGE:` prefix must stay first: the
 *  orchestrator's Escalation Protocol routes on it and splits the task.
 *  A single completed auto-compaction is NOT a failure — the subagent keeps
 *  working and this only fires once the cap is exceeded or compaction fails. */
const taskTooLargeSignal = (why: string) =>
  `TASK_TOO_LARGE: ${why}. Split this task into smaller pieces and re-dispatch.`;

/** First non-empty captured output for a dispatch, in precedence order.
 *  Shared by the completion and process-close fallback paths so they can't
 *  drift apart. */
function capturedText(ap: AgentProc): string {
  return ap.lastAssistantText.trim() || ap.currentMessageText.trim() || ap.collectedText.trim();
}

/** Build the result text for a dispatch that was force-killed (inactivity or
 *  wall-clock timeout). Keeps any partial output the subagent produced before
 *  the kill, prefixed with an explicit reason, so the orchestrator (a) knows
 *  WHY the task did not complete and (b) can still use partial findings instead
 *  of discarding them. */
function timeoutOutput(ap: AgentProc, reason: string): string {
  const partial = capturedText(ap);
  return partial
    ? `TIMEOUT: ${reason}.\n\n--- Partial output captured before the timeout ---\n${partial}`
    : `TIMEOUT: ${reason}. No output was produced.`;
}

/** Deterministic serialization of tool-call arguments, so key order in the
 *  model's JSON cannot make two logically identical calls look different. */
function stableKey(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? String(v);
  if (Array.isArray(v)) return "[" + v.map(stableKey).join(",") + "]";
  const obj = v as Record<string, unknown>;
  return "{" + Object.keys(obj).sort().map(k => JSON.stringify(k) + ":" + stableKey(obj[k])).join(",") + "}";
}

/** Identity of a tool call: tool name + normalized arguments. */
function toolSignature(ev: any): string {
  let args: unknown = ev.args ?? ev.input ?? {};
  if (typeof args === "string") { try { args = JSON.parse(args); } catch { /* keep raw */ } }
  return `${ev.toolName ?? ev.name ?? "?"}\u0000${stableKey(args)}`;
}

/** Terminate the dispatch with a STUCK_LOOP signal (including the concrete
 *  reason) so the orchestrator narrows and re-dispatches, instead of waiting
 *  for the wall-clock cap. Mirrors abortTooLarge. */
function abortStuck(ctx: AgentTeamContext, ap: AgentProc, why: string) {
  if (ap.stuckAborted) return;
  ap.stuckAborted = true;
  ctx.logger.logErrorBox(ap, "STUCK LOOP", `${why} — stopping the subagent`);
  ctx.resolveIfPending(ap, `STUCK_LOOP: ${why}. The subagent was repeating itself without converging and was stopped. Narrow the scope (specific files/sections) and re-dispatch.`, 1);
  ctx.killProc(ap, true);
  if (ctx.wCtx) ctx.wCtx.ui.notify(ctx.tag(ap, "stuck loop — stopped"), "error");
  ctx.invalidate();
}

/** Record one tool call and report whether the subagent has become stuck.
 *  Two independent rules, both calibrated against real runs:
 *    1. the exact same tool call repeated ≥ STUCK_REPEAT_LIMIT times, or
 *    2. ≥ STUCK_TOOL_LIMIT consecutive tool calls with no assistant text
 *       emitted in between (the streak resets on every assistant text, so a
 *       subagent that reported once and then loops is still caught).
 *  Either means the subagent stopped making progress; returning true tells the
 *  caller to skip the call (the dispatch has already been resolved + killed). */
function noteToolCall(ctx: AgentTeamContext, ap: AgentProc, ev: any): boolean {
  if (ap.status !== "running" || ap.stuckAborted) return false;
  if (!ap.toolSigCounts) ap.toolSigCounts = new Map();
  const sig = toolSignature(ev);
  const n = (ap.toolSigCounts.get(sig) ?? 0) + 1;
  ap.toolSigCounts.set(sig, n);
  const sinceText = ++ap.toolsSinceAssistantText;
  if (n >= STUCK_REPEAT_LIMIT) {
    abortStuck(ctx, ap, `repeated the same ${ev.toolName ?? ev.name ?? "tool"} call ${n}× with identical arguments`);
    return true;
  }
  if (sinceText >= STUCK_TOOL_LIMIT) {
    abortStuck(ctx, ap, `${sinceText} tool calls without producing any answer`);
    return true;
  }
  return false;
}

export function handleEvent(ctx: AgentTeamContext, ap: AgentProc, line: string) {
  let ev: any;
  try { ev = JSON.parse(line); } catch { return; }

  // Completion events can arrive after the proc has been marked done.
  // Keep refreshing activity while the child is still owned by this dispatch;
  // otherwise a final response/close gap can look like a stuck worker.
  if (ap.status === "running" || ap.status === "done") {
    ap.lastActivity = Date.now();
    ap.resetPongTimeout?.();
  }

  if (SessionLogger.debugLevel >= 1) {
    // Trace every RPC event type (and its completion relevance) without
    // dumping payloads — the raw bytes go to the level-2 trace file.
    const completionRelevant = ev.type === "response" || ev.type === "agent_end" || ev.type === "agent_settled" ||
      (ev.type === "message_end" && ev.message?.role === "assistant") ? " [completion-relevant]" : "";
    ctx.logger.debug(ap, `event ${ev.type}${completionRelevant} (pendingResolve=${ap.resolveDispatch ? "yes" : "no"})`);
  }

  switch (ev.type) {
    case "response": return handleResponse(ctx, ap, ev);
    case "message_start": return handleMessageStart(ctx, ap, ev);
    case "message_update": return handleMessageUpdate(ctx, ap, ev);
    case "auto_retry_start": return handleAutoRetryStart(ctx, ap, ev);
    case "message_end": return handleMessageEnd(ctx, ap, ev);
    case "tool_execution_start": return handleToolStart(ctx, ap, ev);
    case "tool_execution_end": return handleToolEnd(ctx, ap, ev);
    // pi ≥0.85 renamed the RPC completion event from `agent_end` to
    // `agent_settled` (its own RpcClient resolves prompts on agent_settled,
    // and agent_end no longer reaches the JSONL stream at all). Handle both
    // names so we stay compatible with either pi version. resolveIfPending
    // guarantees exactly-once resolution if both ever arrive.
    case "agent_end":
    case "agent_settled": return handleAgentEnd(ctx, ap, ev);
    case "extension_ui_request": return autoRespondUI(ap, ev);
    case "compaction_start": return handleCompactionStart(ctx, ap, ev);
    case "compaction_end": return handleCompactionEnd(ctx, ap, ev);
    default: {
      const fmt = simpleLogEvents[ev.type];
      if (fmt) ctx.logger.log(fmt(ev), ap);
    }
  }
}

/** Auto-compaction in a subagent means its context is under pressure. Let the
 *  compaction complete and the subagent continue — killing on every compaction
 *  made large tasks impossible (the orchestrator itself compacts and keeps
 *  working). Only abort when a dispatch auto-compacts too many times or a
 *  compaction is aborted (context genuinely unmanageable). */
function handleCompactionStart(ctx: AgentTeamContext, ap: AgentProc, ev: any) {
  // Ignore duplicate events after we've already terminated.
  if (ap.autoCompacted) return;
  const reason = ev.reason || "auto";
  // Manual compacts are intentional; never abort on them.
  if (reason === "manual") {
    ctx.logger.log(`COMPACT start (reason: manual)`, ap);
    return;
  }
  ap.compactionCount++;
  ctx.logger.log(`COMPACT auto #${ap.compactionCount} — continuing dispatch`, ap);
  if (ap.compactionCount > MAX_AUTO_COMPACTIONS) {
    abortTooLarge(ctx, ap, `auto-compacted ${ap.compactionCount} times`);
  }
}

/** compaction_end: a completed compaction is fine (the subagent keeps going);
 *  an aborted one means the context could not be summarized — the task
 *  genuinely doesn't fit, so abort and signal the orchestrator to split it. */
function handleCompactionEnd(ctx: AgentTeamContext, ap: AgentProc, ev: any) {
  if (ap.autoCompacted) return;
  if (!ev.aborted) {
    ctx.logger.log(`COMPACT done`, ap);
    return;
  }
  ctx.logger.log(`COMPACT aborted — context could not be compacted`, ap);
  abortTooLarge(ctx, ap, "compaction aborted");
}

/** Terminate the dispatch with a TASK_TOO_LARGE signal (including the concrete
 *  reason) so the orchestrator splits the task instead of retrying it whole. */
function abortTooLarge(ctx: AgentTeamContext, ap: AgentProc, why: string) {
  if (ap.autoCompacted) return;
  ap.autoCompacted = true;
  ctx.logger.logErrorBox(ap, "AUTO-COMPACT", `subagent context grew too large (${why}) — ending dispatch`);
  ctx.resolveIfPending(ap, taskTooLargeSignal(why), 1);
  ctx.killProc(ap, true);
  if (ctx.wCtx) ctx.wCtx.ui.notify(ctx.tag(ap, `auto-compacted — ${why}`), "warning");
  ctx.invalidate();
}

export function handleResponse(ctx: AgentTeamContext, ap: AgentProc, ev: any) {
  if (!ap.ready) {
    // Only accept the readiness probe when it succeeded. The get_state
    // response arrives while status is "starting", so the error branch
    // below (which checks "running") would otherwise never fire.
    if (ev.success) {
      ap.ready = true;
      ap.status = "idle";
      if (SessionLogger.debugLevel >= 1) ctx.logger.debug(ap, `ready probe OK model=${ev.data?.model?.id ?? "?"} ctxWindow=${ev.data?.model?.contextWindow ?? "?"}`);
      // Clear the spawn-readiness timeout — ready flipped to true via
      // the probe response, not the timeout. This closes the race where
      // the timeout fires just after the probe resolves.
      if (ap.readyTimeout) { clearTimeout(ap.readyTimeout); ap.readyTimeout = undefined; }
      if (ev.data?.model?.contextWindow) {
        ap.contextWindow = ev.data.model.contextWindow;
      }
    } else {
      const errMsg = ev.error || `${ev.command} failed`;
      ctx.logger.logErrorBox(ap, "READY PROBE FAILED", errMsg);
      if (SessionLogger.debugLevel >= 1) ctx.logger.debug(ap, `ready probe FAILED: ${errMsg}`);
      if (ap.readyTimeout) { clearTimeout(ap.readyTimeout); ap.readyTimeout = undefined; }
    }
    ctx.invalidate();
    if (ap.readyResolve) { ap.readyResolve(ev.success === true); ap.readyResolve = null; }
  }
  // Capture successful response text even when the host emits `response`
  // after `agent_end` has transitioned the proc to `done`. Bash/tool-heavy
  // turns are especially likely to expose this ordering. Keeping the latest
  // payload also gives the close fallback a complete result.
  if (ev.success && (ap.status === "running" || ap.status === "done")) {
    const resultText =
      typeof ev.data === "string" ? ev.data
        : (ev.data?.result?.text ?? ev.data?.text ?? ev.data?.content ?? "");
    // Always accept the latest response text — multi-turn subagents may have
    // earlier message_end events that set lastAssistantText with stale content.
    if (resultText) { ap.lastAssistantText = String(resultText); ap.toolsSinceAssistantText = 0; }
  }

  if (!ev.success && ap.status === "running" && ap.resolveDispatch) {
    const errMsg = ev.error || `${ev.command} failed`;
    ctx.logger.logErrorBox(ap, "PROMPT ERROR", errMsg);
    ap.lastWork = `Error: ${errMsg}`;
    ap.status = "error";
    ctx.invalidate();
    if (SessionLogger.debugLevel >= 1) ctx.logger.debug(ap, `error response resolving dispatch (code=1)`);
    ctx.resolveIfPending(ap, errMsg, 1);
  }
}

/** Timestamp of the last streaming-driven repaint. Deliberately GLOBAL rather
 *  than per-agent: a per-agent throttle let N concurrent clones each spend
 *  their own budget, so a 5-task batch repainted up to 50×/s — every one of
 *  which re-renders every agent's card and log panel. One global budget caps
 *  total repaints (and therefore total render work) regardless of fan-out,
 *  with the same 100 ms staleness bound per agent. */
let lastStreamInvalidate = 0;

export function handleMessageStart(ctx: AgentTeamContext, ap: AgentProc, ev: any) {
  if (ev.message?.role !== "assistant") return;
  // Mark where this attempt's streamed text begins so a mid-stream provider
  // error followed by auto-retry (which re-streams the whole message from
  // scratch) can roll back the failed attempt's lines instead of duplicating.
  ap.streamLogIdx = ap.logLines.length;
}

/** Mid-stream provider error: pi drops the failed partial assistant message
 *  and re-streams it from the beginning. Roll back the failed attempt's
 *  streamed log lines and buffers so the retried stream isn't appended on
 *  top of its own partial copy (which rendered the same text N times). */
export function handleAutoRetryStart(ctx: AgentTeamContext, ap: AgentProc, ev: any) {
  // Retry rollback is only meaningful before the ring wraps. Once wrapped,
  // the logical index no longer maps directly to the physical array.
  if (ap.logHead === 0) ap.logLines.length = Math.min(ap.streamLogIdx, ap.logLines.length);
  ap.streamLineBuf = "";
  ap.currentMessageText = "";
  ctx.logger.log(`AUTO-RETRY attempt ${ev.attempt}/${ev.maxAttempts} (${ev.delayMs}ms)`, ap);
  ctx.invalidate();
}

export function handleMessageUpdate(ctx: AgentTeamContext, ap: AgentProc, ev: any) {
  const delta = ev.assistantMessageEvent;
  if (delta?.type !== "text_delta") return;
  const chunk = delta.delta || "";
  // Assistant text clears the "no-report" streak that STUCK_TOOL_LIMIT measures:
  // only uninterrupted stretches of unreported tool work count as a loop.
  if (chunk) ap.toolsSinceAssistantText = 0;
  ap.collectedText += chunk;
  ap.currentMessageText += chunk;
  // Cap collectedText and currentMessageText to prevent unbounded memory
  // growth during long streams. lastAssistantText (set on message_end) is
  // the authoritative output; collectedText is only a fallback for
  // process-close edge cases. currentMessageText feeds lastAssistantText
  // so it must be capped too, otherwise a single subagent can produce an
  // enormous output that overflows the combined batch result downstream.
  if (ap.collectedText.length > MAX_COLLECTED_TEXT) {
    ap.collectedText = ap.collectedText.slice(-MAX_COLLECTED_TEXT);
  }
  if (ap.currentMessageText.length > MAX_COLLECTED_TEXT) {
    ap.currentMessageText = ap.currentMessageText.slice(-MAX_COLLECTED_TEXT);
  }
  ctx.logger.logStreamingText(ap, chunk);
  // Throttle the once-per-token work ("last work" label + UI invalidation) to
  // one pass per STREAM_INVALIDATE_THROTTLE_MS. Doing it per token also
  // allocated a fresh label string on every delta. The final state is still
  // rendered on message_end / agent_end.
  const now = Date.now();
  if (now - lastStreamInvalidate > STREAM_INVALIDATE_THROTTLE_MS) {
    lastStreamInvalidate = now;
    const tail = chunk.slice(chunk.lastIndexOf("\n") + 1);
    if (tail.trim()) ap.lastWork = tail.slice(0, 80);
    ctx.invalidate();
  }
}

export function handleMessageEnd(ctx: AgentTeamContext, ap: AgentProc, ev: any) {
  if (ev.message?.role !== "assistant") return;
  const u = ev.message.usage;
  if (u) {
    const dispatchTokensOut = u.output || 0;
    ap.cacheRead = u.cacheRead || 0;
    ap.cacheWrite = u.cacheWrite || 0;
    ap.cacheSavedTotal += ap.cacheRead;
    let dispatchTokensUsed = u.input || 0;
    if (u.totalTokens) {
      const derived = u.totalTokens - dispatchTokensOut - ap.cacheRead - ap.cacheWrite;
      dispatchTokensUsed = u.input || (derived > 0 ? derived : u.totalTokens - dispatchTokensOut);
    }
    ap.tokensOut += dispatchTokensOut;
    ap.tokensUsed += dispatchTokensUsed;
  }
  ctx.logger.flushStreamBuf(ap);
  // Don't promote partial text from an errored/aborted stream — a following
  // auto-retry re-streams the real message and would overwrite it anyway.
  const stop = ev.message?.stopReason;
  if (ap.currentMessageText.trim()) ap.toolsSinceAssistantText = 0;
  if (stop !== "error" && stop !== "aborted" && ap.currentMessageText.trim()) ap.lastAssistantText = ap.currentMessageText;
  ap.currentMessageText = "";
  ctx.invalidate();
}

/** Format a single tool-call argument for the log line. Strings are sliced to
 *  80 chars; arrays/objects become compact JSON. Null/undefined/empty values
 *  are skipped so a tool never renders with a dangling `=`. */
function fmtToolArg(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.trim() ? v.slice(0, 80) : "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  // objects / arrays → compact JSON (skip empty containers)
  try {
    const s = JSON.stringify(v);
    return s && s !== "[]" && s !== "{}" ? s.slice(0, 80) : "";
  } catch {
    return String(v).slice(0, 80);
  }
}

export function handleToolStart(ctx: AgentTeamContext, ap: AgentProc, ev: any) {
  ap.toolCount++;
  // Loop guard: a subagent that repeats itself (or never reports) is stopped
  // here with a concrete reason instead of burning the whole dispatch budget.
  if (noteToolCall(ctx, ap, ev)) return;
  let detail = "";
  let args: unknown = ev.args;
  // Some hosts serialize args as a JSON string rather than an object.
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { /* keep the raw string */ }
  }
  if (args && typeof args === "object" && !Array.isArray(args)) {
    detail = Object.entries(args as Record<string, unknown>)
      .map(([k, v]) => {
        const s = fmtToolArg(v);
        return s ? `${k}=${s}` : "";
      })
      .filter(Boolean)
      .join(" ");
  } else if (Array.isArray(args)) {
    detail = (args as unknown[]).map(fmtToolArg).filter(Boolean).join(" ");
  } else if (typeof args === "string" && args.trim()) {
    detail = args.slice(0, 80);
  }
  // Never render a bare tool name: a call with no visible args is still
  // meaningful, and a blank detail reads as a logging bug.
  ctx.logger.logToolStart(ap, ev.toolName, detail || "(no args)");
  ctx.invalidate();
}

export function handleToolEnd(ctx: AgentTeamContext, ap: AgentProc, ev: any) {
  const isError = ev.isError === true || typeof ev.error === "string";
  ctx.logger.logToolEnd(ap, ev.toolName, !isError, ev.durationMs);
  if (isError && (ev.error || ev.result)) {
    const detail = typeof ev.error === "string"
      ? ev.error
      : typeof ev.result === "string" ? ev.result : JSON.stringify(ev.result);
    ctx.logger.logErrorBox(ap, "TOOL ERROR", `${ev.toolName}: ${detail}`);
  }
  // The ✓/✗ + duration update rewrites the tool-start line in place; make
  // sure the TUI repaints it instead of waiting for the next event.
  ctx.invalidate();
}

/** Completion of a subagent run: resolves the pending dispatch with the
 *  final output. Fired on `agent_end` (pi ≤0.84) or `agent_settled`
 *  (pi ≥0.85) — both route here. */
export function handleAgentEnd(ctx: AgentTeamContext, ap: AgentProc, _ev: any) {
  // If we already terminated the subagent because it auto-compacted or got
  // stuck, ignore any late completion event and don't overwrite that signal.
  if (ap.autoCompacted || ap.stuckAborted) return;
  // The shared elapsed ticker drops this proc on the next tick (status flips
  // to "done" below) — no per-dispatch timer to clear here.
  ctx.logger.flushStreamBuf(ap);

  const output = capturedText(ap) || "(no output)";
  // A subagent that settles its turn without emitting any final text did NOT
  // complete its task. Reporting that as a successful "done" with "(no output)"
  // is what made the orchestrator treat a stuck/empty worker as finished (and
  // redo the work). Treat it as a failure with a concrete reason instead.
  const completed = output !== "(no output)";
  const finalOutput = completed
    ? output
    : `Subagent ended without producing any output after ${ap.toolCount} tool call(s) — the task was likely too broad or the model stalled. Narrow the scope and re-dispatch.`;

  if (!completed) {
    ctx.logger.logErrorBox(ap, "EMPTY RESPONSE",
      `lastAssistant:${ap.lastAssistantText ? "yes" : "no"} curMsg:${ap.currentMessageText.length}c collected:${ap.collectedText.length}c`);
  }

  if (SessionLogger.debugLevel >= 1) {
    ctx.logger.debug(ap, `agent_end: output=${output.length}c source=${ap.lastAssistantText.trim() ? "lastAssistantText" : ap.currentMessageText.trim() ? "currentMessageText" : ap.collectedText.trim() ? "collectedText" : "none"
      } pendingResolve=${ap.resolveDispatch ? "yes" : "no"} status=${ap.status}`);
  }

  ctx.logger.logDoneBox(ap, Math.round(ap.elapsed / 1000), ap.toolCount);
  ap.status = "done";
  ap.lastWork = extractLastLine(finalOutput);

  // Keep the captured output until the dispatch promise has resolved and the
  // process close handler has had a chance to drain trailing stdout. Clearing
  // these fields here loses the final answer when bash causes response/close
  // events to arrive immediately after the completion event.
  ap.collectedText = "";
  ap.currentMessageText = "";

  ctx.invalidate();

  if (ctx.wCtx) {
    ctx.wCtx.ui.notify(
      ctx.tag(ap, completed
        ? `done (${Math.round(ap.elapsed / 1000)}s, ${ap.toolCount} tools)`
        : `no output (${Math.round(ap.elapsed / 1000)}s) — not completed`),
      completed ? "success" : "error",
    );
  }

  // Resolve from the completion event, but leave the captured final text
  // intact until the close fallback has had a chance to run. This is safe
  // because resolveIfPending clears the callback exactly once.
  if (SessionLogger.debugLevel >= 1) ctx.logger.debug(ap, `agent_end: resolving dispatch code=${completed ? 0 : 1}`);
  ctx.resolveIfPending(ap, finalOutput, completed ? 0 : 1);
  // `lastAssistantText` is deliberately cleared by the next dispatch reset,
  // not before the child has finished flushing its final RPC events.
}

export function autoRespondUI(ap: AgentProc, ev: any) {
  if (!ap.proc) return;
  const stdin = ap.proc.stdin;
  if (!stdin?.writable) return;
  const { id, method } = ev;

  // Fire-and-forget methods
  if (UI_FIRE_AND_FORGET.has(method)) return;

  // Dialog methods: auto-respond
  let resp: any;
  if (method === "confirm") {
    resp = { type: "extension_ui_response", id, confirmed: true };
  } else if (method === "select" && ev.options?.length > 0) {
    resp = { type: "extension_ui_response", id, value: ev.options[0] };
  } else {
    resp = { type: "extension_ui_response", id, cancelled: true };
  }
  try { stdin.write(JSON.stringify(resp) + "\n"); } catch { }
}

/** Resolve an agent name to its team-member proc, or the standard
 *  not-found / disabled error message. Shared by all dispatch entry points. */
function resolveAgent(ctx: AgentTeamContext, name: string): { ap: AgentProc } | { error: string } {
  const key = agentNameKey(name);
  const ap = ctx.procs.get(key);
  if (!ap) return { error: `Agent "${name}" not found. Available: ${availableAgentNames(ctx)}` };
  if (ctx.disabledAgents.has(key)) {
    return { error: `Agent "${name}" is disabled. Enable it from the sidebar (Alt+S).` };
  }
  return { ap };
}

/** Run a single subagent to completion. Safe to call concurrently for distinct
 *  AgentProc instances (ephemeral clones or different team members). Callers
 *  are responsible for locking (see `dispatchTasks`). */
export async function runAgent(
  ctx: AgentTeamContext,
  ap: AgentProc,
  task: string,
): Promise<{ output: string; code: number; elapsed: number }> {
  ctx.wipeSessionFile(ap);

  // Spawn fresh process for this task
  ap.status = "dead";
  const started = await ctx.spawnProc(ap);
  if (!started) {
    return { output: `${displayName(ap.def.name)} failed to start.`, code: 1, elapsed: 0 };
  }

  if (!ap.ready || !ap.proc) {
    const output = `${displayName(ap.def.name)} failed readiness: process exited or did not answer the readiness probe.`;
    ctx.logger.logErrorBox(ap, "NOT READY", output);
    return { output, code: 1, elapsed: 0 };
  }

  // Level-2 debug: open this dispatch's raw JSONL trace for the window where
  // the result is in flight. Closed (path dropped) once the dispatch resolves.
  if (SessionLogger.debugLevel >= 2) {
    SessionLogger.setFileTrace(ap, true);
    ctx.logger.debug(ap, `raw JSONL trace opened: ${ap.debugTracePath}`);
  }

  // Start dispatch
  ap.status = "running";
  ap.task = task;
  ap.toolCount = 0;
  ap.toolsSinceAssistantText = 0;
  ap.elapsed = 0;
  ap.tokensUsed = 0;
  ap.tokensOut = 0;
  ap.cacheRead = 0;
  ap.cacheWrite = 0;
  ap.lastWork = "";
  ap.runCount++;
  ap.lastActivity = Date.now();
  if (SessionLogger.debugLevel >= 1) {
    ctx.logger.debug(ap, `dispatch #${ap.runCount} start model=${shortModel(ap.model)} writable=${isWritable(ap.def, ctx.destructiveTools)} task=${task.length}c`);
  }
  ctx.invalidate();

  const t0 = Date.now();
  startElapsedTicker(ctx, ap, t0);

  // ── Activity-based timeout ──
  // Resets on every RPC event (streaming, tool calls, responses, etc.)
  // If 10 min passes with no activity → stuck → kill
  const doResetPongTimeout = () => {
    if (ap.dispatchTimeout) clearTimeout(ap.dispatchTimeout);
    ap.dispatchTimeout = setTimeout(() => {
      const silence = Math.round((Date.now() - ap.lastActivity) / 1000);
      ctx.logger.logErrorBox(ap, "NO ACTIVITY", `no event for ${silence}s — force-killing`);
      ap.lastWork = `Timed out (${silence}s silence)`;
      ctx.resolveIfPending(ap, timeoutOutput(ap, `no activity for ${silence}s`), 1);
      ctx.killProc(ap, true);
      if (ctx.wCtx) ctx.wCtx.ui.notify(ctx.tag(ap, `NO ACTIVITY (${silence}s) — killed`), "error");
      ctx.invalidate();
    }, PONG_TIMEOUT);
  };
  ap.resetPongTimeout = doResetPongTimeout;

  doResetPongTimeout(); // start initial 10-min timer

  // ── Hard wall-clock backstop ──
  // The inactivity timer is reset by every event, so a busy-but-stuck
  // subagent (observed at ~1300s) never trips it. This fires once after the
  // configured dispatch timeout (agent-team-config.json `dispatchTimeoutMs`,
  // default 20 min) no matter the traffic, bounding the dispatch and reporting
  // the reason so the orchestrator retries only this task.
  ap.wallClockTimeout = setTimeout(() => {
    const secs = Math.round((Date.now() - t0) / 1000);
    ctx.logger.logErrorBox(ap, "DISPATCH TIMEOUT", `still running after ${secs}s — force-killing`);
    ap.lastWork = `Timed out (${secs}s wall clock)`;
    ctx.resolveIfPending(ap, timeoutOutput(ap, `still running after ${secs}s`), 1);
    ctx.killProc(ap, true);
    if (ctx.wCtx) ctx.wCtx.ui.notify(ctx.tag(ap, `DISPATCH TIMEOUT (${secs}s) — killed`), "error");
    ctx.invalidate();
  }, ctx.dispatchTimeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS);

  ctx.logger.logTaskBox(ap, ap.runCount, task);

  const cmdPayload = { type: "prompt", message: task };
  const failDispatch = (msg: string): { output: string; code: number; elapsed: number } => {
    clearTimers(ap);
    ap.resetPongTimeout = undefined;
    ap.resolveDispatch = null;
    ap.status = "error";
    ctx.invalidate();
    return { output: msg, code: 1, elapsed: 0 };
  };
  try {
    if (!ap.proc?.stdin?.writable) {
      return failDispatch(`Process died before task could be sent`);
    }
    ap.proc.stdin.write(JSON.stringify(cmdPayload) + "\n");
  } catch (err: any) {
    return failDispatch(`Write error: ${err.message}`);
  }

  const result = await new Promise<{ output: string; code: number; elapsed: number }>((resolve) => {
    ap.resolveDispatch = (output, code) => {
      // Clear timeout immediately to prevent race with normal completion.
      // Keep the resolver installed until the subprocess close handler has
      // drained trailing stdout; late response/agent_end events can otherwise
      // be lost between resolution and process teardown.
      if (ap.dispatchTimeout) { clearTimeout(ap.dispatchTimeout); ap.dispatchTimeout = undefined; }
      if (ap.wallClockTimeout) { clearTimeout(ap.wallClockTimeout); ap.wallClockTimeout = undefined; }
      if (SessionLogger.debugLevel >= 1) {
        ctx.logger.debug(ap, `dispatch promise resolved code=${code} output=${output.length}c elapsed=${Math.round(ap.elapsed / 1000)}s`);
      }
      resolve({ output, code, elapsed: ap.elapsed });
    };
  });

  // Level-2 debug: the result is now safely in the caller's hands — close
  // the raw trace and report how much protocol traffic it captured.
  if (SessionLogger.debugLevel >= 2) {
    const traced = ap.debugLines ?? 0;
    const tracePath = ap.debugTracePath;
    SessionLogger.setFileTrace(ap, false);
    ctx.logger.debug(ap, `raw JSONL trace closed: ${tracePath ?? "?"} (${traced} line(s))`);
  }

  // Task complete — kill the subagent process but KEEP the terminal pane alive
  // so the user can scroll back and see what the agent did.
  // The pane will be reused on the next dispatch (same agent = same pane).
  ctx.killProc(ap, true);

  ctx.wipeSessionFile(ap);

  ap.status = "dead";
  ctx.invalidate();

  return result;
}

/** Build an ephemeral AgentProc clone for a concurrent/parallel run. Clones do
 *  NOT touch the shared team-member AgentProc (which drives the widget), and
 *  carry a unique `runId` so their session/prompt files never collide. */
function makeClone(def: AgentDef, model: string, teamModel: string | undefined, runId: string): AgentProc {
  return {
    def,
    teamModel,
    model,
    runId,
    ...blankProcState(),
  };
}

/** Kill a running/starting clone and reset its state (abort path). */
function killActiveClone(ctx: AgentTeamContext, ap: AgentProc) {
  if (ap.status !== "running" && ap.status !== "starting") return;
  ctx.killProc(ap, true);
  ctx.wipeSessionFile(ap);
  ap.status = "dead";
  ctx.invalidate();
}

interface CloneSpec {
  agent: string;
  task: string;
  def: AgentDef;
  model: string;
  teamModel: string | undefined;
}

/** Run clone subprocesses through a worker pool (at most `max` concurrent),
 *  with abort handling and per-task result capture. `max = 1` makes the pool
 *  strictly sequential in `specs` order (the serialized dispatch path). Tasks
 *  still queued when an abort arrives are marked Aborted instead of
 *  spawning new work. */
async function runClonePool(
  ctx: AgentTeamContext,
  specs: CloneSpec[],
  max: number,
  signal?: AbortSignal,
): Promise<BatchTaskResult[]> {
  const results: BatchTaskResult[] = new Array(specs.length);
  const maxWorkers = Math.max(1, Math.min(max, specs.length));
  const clones: AgentProc[] = [];
  const onAbort = () => { for (const clone of clones) killActiveClone(ctx, clone); };
  signal?.addEventListener("abort", onAbort);
  try {
    let cursor = 0;
    const runOne = async (idx: number) => {
      const spec = specs[idx];
      if (signal?.aborted) {
        results[idx] = { agent: spec.agent, task: spec.task, output: "Aborted", code: 1, elapsed: 0, error: "Aborted" };
        return;
      }
      const clone = makeClone(spec.def, spec.model, spec.teamModel, `${spec.agent}-${idx}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
      clones.push(clone);
      ctx.batchClones.add(clone);
      try {
        const r = await runAgent(ctx, clone, spec.task);
        results[idx] = { agent: spec.agent, task: spec.task, output: r.output, code: r.code, elapsed: r.elapsed, error: null };
      } catch (e: any) {
        const msg = `${spec.agent} failed: ${String(e?.message || e)}`;
        ctx.logger.logErrorBox(clone, "DISPATCH ERROR", msg);
        results[idx] = { agent: spec.agent, task: spec.task, output: msg, code: 1, elapsed: 0, error: msg };
      } finally {
        ctx.batchClones.delete(clone);
      }
    };
    const worker = async () => {
      let i: number;
      while ((i = cursor++) < specs.length) await runOne(i);
    };
    await Promise.all(Array.from({ length: maxWorkers }, worker));
    return results;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Dispatch a batch of {agent, task} pairs, each in its own isolated clone
 *  subprocess. A single-task call is just a one-element batch.
 *
 *  Concurrency is driven by the `parallelDispatch` setting plus whether any
 *  task targets a writable (file-mutating) agent:
 *    - parallel ON and every task read-only → up to `maxParallel` clones run
 *      at once under the shared read lock, so independent batches overlap.
 *    - parallel OFF, or any writable task → one task at a time, in the
 *      caller's order, under the exclusive write lock. The write lock also
 *      serializes concurrent dispatch calls issued in the same turn.
 *  Writes are therefore NEVER parallel, regardless of the setting. */
export async function dispatchTasks(
  ctx: AgentTeamContext,
  tasks: Array<{ agent: string; task: string }>,
  signal?: AbortSignal,
): Promise<BatchDispatchResult> {
  const specs: CloneSpec[] = [];
  let anyWritable = false;
  for (const t of tasks) {
    const r = resolveAgent(ctx, t.agent);
    if ("error" in r) return { ok: false, error: r.error, results: [] };
    if (isWritable(r.ap.def, ctx.destructiveTools)) anyWritable = true;
    specs.push({ agent: t.agent, task: t.task, def: r.ap.def, model: r.ap.model, teamModel: r.ap.teamModel });
  }

  const parallel = ctx.parallelDispatch && !anyWritable;
  const max = parallel ? Math.max(1, Math.min(ctx.maxParallel || 5, specs.length)) : 1;
  // Always run the pool, even when the turn's abort signal already fired: the
  // pool marks not-yet-started tasks "Aborted" and kills in-flight clones
  // while PRESERVING the results of tasks that already completed. Returning an
  // empty `results: []` on abort (as before) discarded finished subagent work
  // and forced the orchestrator to redo it.
  const run = async (): Promise<BatchDispatchResult> =>
    ({ ok: true, results: await runClonePool(ctx, specs, max, signal) });
  return parallel ? ctx.dispatchLock.read(run) : ctx.dispatchLock.write(run);
}

export async function activateTeam(ctx: AgentTeamContext, name: string) {
  await ctx.killAll();
  ctx.procs.clear();
  ctx.activeTeam = name;

  const members = ctx.teams[name] || [];
  const byName = new Map(ctx.allDefs.map(d => [agentNameKey(d.name), d]));

  // Duty is per team: this team's roster rows are the whole truth for it.
  // Rebuild the off-list from scratch so a member disabled on the team we just
  // left cannot silence a same-named member of the team we switch to (the
  // Scope UI reads the same teams.yaml rows and follows the same rule).
  ctx.disabledAgents.clear();
  for (const m of members) {
    const def = byName.get(agentNameKey(m.name));
    if (!def) continue;
    const key = agentNameKey(def.name);
    ctx.procs.set(key, {
      def,
      teamModel: m.model,
      model: m.model || def.model || ctx.orchestratorModel || "",
      ...blankProcState(),
    });
    if (m.active === false) {
      ctx.disabledAgents.add(key);
    }
  }
  ctx.persist();
}

export class ProcessManager {
  constructor(
    private sessionDir: () => string,
    private cachedExtPaths: () => string[],
    private orchestratorModel: () => string,
    private invalidate: () => void,
    private logger: SessionLogger,
  ) { }

  // ── Resolve helper ──────────────────────────────────────────────

  resolveIfPending(ap: AgentProc, output: string, code: number) {
    if (!ap.resolveDispatch) {
      if (SessionLogger.debugLevel >= 1) {
        this.logger.debug(ap, `resolveIfPending: SKIPPED — no pending dispatch (status=${ap.status}) output=${output.length}c code=${code}`);
      }
      return;
    }
    if (SessionLogger.debugLevel >= 1) {
      this.logger.debug(ap, `resolveIfPending: resolving code=${code} output=${output.length}c status=${ap.status}`);
    }
    const resolve = ap.resolveDispatch;
    ap.resolveDispatch = null;
    clearTimers(ap);
    resolve(output, code);
  }

  /** Safely delete session file if it exists */
  wipeSessionFile(ap: AgentProc) {
    safeUnlink(ap.sessionFile);
  }

  // Write system prompt to temp file (avoids shell escaping issues with multi-line prompts)
  //
  // `memory` carries the persistent project-memory info; when memory is
  // enabled, the same "## Project Memory" section the orchestrator gets (see
  // buildSystemPrompt in ui.ts) is appended to the subagent's prompt so
  // dispatched subagents can read prior decisions, facts, and preferences
  // from the memory files. When memory is disabled (null/undefined) nothing
  // is appended — mirroring how creative/standard mode is injected.
  writeSystemPrompt(ap: AgentProc, mode: AgentMode = "standard", memory?: { dir: string; files: Array<{ path: string; heading: string }> } | null) {
    const memorySection = memory && (memory.dir || (memory.files && memory.files.length))
      ? "\n## Project Memory\n" +
      "Persistent project knowledge is maintained across turns in:\n" +
      "`" + memory.dir + "`\n\n" +
      "A background summarizer updates these per-category files after each turn:\n" +
      memory.files.map((f) => "- `" + f.path + "` - " + f.heading).join("\n") + "\n\n" +
      "**VERY IMPORTANT** Read memory files to understand Repo before working on any Task.\n\n  ## Alive Trigger \n - Add a pong assisted message after 10 consecutive tool calls \n"
      : "\n\n\n ## Alive Trigger \n - Add a pong assisted message after 10 consecutive tool calls \n";
    const content = `${postProcessAgentPrompt(ap.def.systemPrompt, mode)}${memorySection}\n\n`;
    if (ap.lastPromptHash === content && ap.systemPromptFile && existsSync(ap.systemPromptFile)) return; // skip if unchanged and file still exists
    ap.lastPromptHash = content;
    const key = agentKey(ap) + (ap.runId ? `-${ap.runId}` : "");
    ap.systemPromptFile = join(this.sessionDir(), `${key}-system-prompt.txt`);
    writeFileSync(ap.systemPromptFile, content);
  }

  cleanSystemPrompt(ap: AgentProc) {
    safeUnlink(ap.systemPromptFile);
  }

  killProc(ap: AgentProc, immediate = false) {
    const wasActive = ap.status === "running" || ap.status === "starting";
    // Detach ownership before closing streams. Late events from this child are
    // rejected by the stale-process guard and cannot affect a replacement.
    const procRef = ap.procRef;
    ap.procRef = null;
    ap.proc = null;
    this.resolveIfPending(ap, wasActive ? "Process killed" : "", 1);
    if (procRef) {
      // Each child owns its own stdin. End only this pipe; never touch the
      // orchestrator stdin or any other subagent's streams.
      try { procRef.proc.stdin?.end(); } catch { }
      try {
        if (immediate) procRef.proc.kill("SIGKILL");
        else procRef.kill("SIGTERM");
      } catch { }
    }
    this.cleanSystemPrompt(ap);
    ap.status = "dead";
    ap.ready = false;
    ap.stdoutBuf = "";
    // sigkillTimeout is no longer used; sub.kill() handles the backstop
    clearTimers(ap);
  }

  async killAll(ctx: AgentTeamContext) {
    const exitPromises: Promise<void>[] = [];
    // Snapshot both team-member procs and active parallel clones so we don't
    // miss any in-flight subprocess if the set is mutated during iteration.
    const allProcs = [...ctx.procs.values(), ...ctx.batchClones];
    for (const ap of allProcs) {
      const dying = ap.proc;
      if (dying) {
        // Skip the wait if the process has already exited — its 'close' event
        // has fired and any listener we attach now would be a no-op.
        const alreadyDead = dying.exitCode !== null || dying.signalCode !== null || dying.killed;
        if (!alreadyDead) {
          exitPromises.push(new Promise<void>(res => {
            const timer = setTimeout(res, KILLALL_TIMEOUT_MS);
            dying.on("close", () => { clearTimeout(timer); res(); });
          }));
        }
      }
      this.killProc(ap);
    }
    if (exitPromises.length) await Promise.all(exitPromises);
  }

  spawnProc(ctx: AgentTeamContext, ap: AgentProc): Promise<boolean> {
    // Ensure clean slate
    if (ap.proc) this.killProc(ap);
    resetForDispatch(ap);

    ap.status = "starting";
    ap.sessionFile = join(this.sessionDir(), `${agentKey(ap)}${ap.runId ? `-${ap.runId}` : ""}.json`);

    // Write system prompt to temp file to avoid CLI escaping issues
    this.writeSystemPrompt(ap, ctx.mode);

    // Sync model: if agent def has no model, always use current orchestrator model
    const model = ap.teamModel || ap.def.model || this.orchestratorModel() || "google/gemini-2.5-flash";
    ap.model = model;
    const bin = piBin();

    // Build args: --no-extensions to block auto-discovery (including agent-team),
    // then explicitly load only non-agent-team extensions via -e.
    // --tools uses the agent's prompt-file tools as the allowlist.

    // Split provider from model if model contains a provider prefix
    const { provider, model: modelName } = parseModelId(model);

    const extPaths = this.cachedExtPaths();

    // Build skill flags: disable global skill discovery and load exactly the
    // skills the agent's OWN definition names in its `skills:` key — the single
    // source of truth for what a subagent may use. No key (or an empty one)
    // means no skills: there is no shared subagent default to fall back to.
    const skillFlags: string[] = ["--no-skills"];
    const skillNames = ap.def.skills ?? [];
    for (const skillName of skillNames) {
      const skillPath = resolveSkillPath(skillName);
      if (skillPath) {
        skillFlags.push("--skill", skillPath);
      } else {
        ctx.logger.log(`Unknown skill: ${skillName}`, ap);
      }
    }

    const args = [
      "--mode", "rpc",
      "-p",
      // Route extensions to this child's tools/provider so a dispatch doesn't
      // pay for modules its agent can never call.
      ...buildExtensionCliArgs(extPaths, { tools: ap.def.tools, provider }),
      ...skillFlags,
      ...(provider ? ["--provider", provider] : []),
      "--model", modelName,
      ...(ap.def.thinking ? ["--thinking", ap.def.thinking] : []),
      "--tools", ap.def.tools,
      "--system-prompt", ap.systemPromptFile,
      "--session", ap.sessionFile,
      "--name", ap.def.name,
    ];

    const sub = spawnRpcSubprocess({
      bin,
      args,
      // PI_SUBAGENT marks the child as a spawned worker: extensions that gate
      // host-only work (e.g. pi-scope's boot probes and completion flush) skip
      // it. Cheap for children, and it keeps the orchestrator's own behaviour
      // untouched.
      //
      // OBS_NAME is the role name. It must be an env var, not the Pi Scope
      // `--o-name` flag: that flag is only registered when the authoritative
      // Pi Scope extension copy is force-loaded (the app's bundled shim). A
      // terminal `pi` that inherits PI_SCOPE_FORCE_EXTENSION but resolves to a
      // different binary makes the agent-dir copy no-op before registerFlag,
      // so `--o-name` becomes an unknown option and the child exits before the
      // readiness probe ("<agent> failed to start."). OBS_NAME is read by
      // pi-scope.ts regardless of which binary or agent dir the child uses.
      env: { ...process.env, PI_SUBAGENT: "1", OBS_NAME: ap.def.name },
      logger: ctx.logger,
      owner: ap,
      onStderr: (line) => {
        // Keep stderr owned by this exact subprocess. Never write it to the
        // orchestrator's process streams or another agent's logger.
        ctx.logger.logBoxed(line, ap);
      },
      onLine: (line) => {
        if (ap.proc !== sub.proc) return; // stale process guard
        ctx.handleEvent(ap, line);
      },
      onError: (err) => {
        if (ap.proc !== sub.proc) return; // stale process guard
        const detail = `${displayName(ap.def.name)} subprocess error: ${err.message}`;
        ctx.logger.logErrorBox(ap, "PROCESS ERROR", detail);
        ap.status = "error";
        ap.lastWork = detail;
        // A spawn error can happen before the dispatch promise is installed;
        // reject the readiness wait as well as the active task handoff.
        ap.proc = null;
        ap.procRef = null;
        ap.readyResolve?.(false);
        ap.readyResolve = null;
        this.resolveIfPending(ap, detail, 1);
      },
      onClose: (code, signal) => {
        if (ap.proc !== sub.proc) return; // stale process guard
        const exitDetail = signal
          ? `${displayName(ap.def.name)} subprocess terminated by ${signal}`
          : `${displayName(ap.def.name)} subprocess exited with code ${code ?? "unknown"}`;
        if (SessionLogger.debugLevel >= 1) {
          const capturedNow = ap.lastAssistantText.length || ap.currentMessageText.length || ap.collectedText.length;
          this.logger.debug(ap, `subprocess close code=${code ?? "?"} signal=${signal ?? "none"} status=${ap.status} pendingResolve=${ap.resolveDispatch ? "yes" : "no"} capturedText=${capturedNow}c`);
        }
        // Detach this child before cleanup so callbacks from its streams cannot
        // be mistaken for events from a later process using the same AgentProc.
        ap.proc = null;
        ap.procRef = null;
        // A child that dies BEFORE answering the readiness probe (rejected CLI
        // flag, failed boot) must reject the readiness wait here, exactly like
        // the spawn-error path does. Without this the wait only ends when
        // SPAWN_READY_TIMEOUT_MS fires, so an instant crash is reported as a
        // 15-second stall and the caller never learns why. Guarded on !ap.ready
        // so a normally-completed child does not log a bogus READY FAILED.
        if (!ap.ready) {
          ap.readyResolve?.(false);
          ap.readyResolve = null;
        }
        // If we intentionally killed the subagent because it auto-compacted,
        // don't log a scary PROCESS EXIT box and don't overwrite the
        // TASK_TOO_LARGE signal that was already resolved.
        if (!ap.autoCompacted && !ap.stuckAborted) {
          const captured = capturedText(ap);
          if (code !== 0 && !captured) {
            ctx.logger.logErrorBox(ap, "PROCESS EXIT", exitDetail);
          }
          if (code === 0 && !captured) {
            ctx.logger.logErrorBox(ap, "EMPTY RESPONSE", exitDetail);
          }
          // A clean RPC child exit is a successful completion even when no
          // completion event arrived (or pi omitted it). Resolve only after
          // stdout has been fully drained. An exit with no captured output is
          // NOT a success: report a concrete failure reason so the orchestrator
          // retries only that task instead of trusting an empty result.
          const ok = code === 0 && !!captured;
          const text = captured || (code === 0
            ? `Subagent exited without producing any output after ${ap.toolCount} tool call(s) — task not completed.`
            : exitDetail);
          this.resolveIfPending(ap, text, ok ? 0 : 1);
        }
        // stdin is already owned and closed by the RPC wrapper/kill path.
        ap.status = "dead";
        ap.ready = false;
        clearTimers(ap);
        this.invalidate();
      },
    });
    ap.proc = sub.proc;
    ap.procRef = sub;
    if (SessionLogger.debugLevel >= 1) {
      this.logger.debug(ap, `spawn pid=${sub.proc.pid ?? "?"} model=${shortModel(model)} args=${args.length}`);
    }
    this.invalidate();

    // ── Readiness probe: send get_state, wait for response ──

    return new Promise<boolean>((resolve) => {
      // Give process 15s to become ready
      ap.readyTimeout = setTimeout(() => {
        ap.readyTimeout = undefined;
        if (!ap.ready) {
          ctx.logger.logErrorBox(ap, "READY TIMEOUT", `status=${ap.status}`);
          if (SessionLogger.debugLevel >= 1) ctx.logger.debug(ap, `readiness timeout after ${SPAWN_READY_TIMEOUT_MS}ms — proceeding with proc=${ap.proc ? "alive" : "dead"}`);
          ap.status = ap.proc ? "idle" : "dead";
          ap.ready = ap.proc != null; // only ready if process is alive
          resolve(ap.proc != null);
        }
      }, SPAWN_READY_TIMEOUT_MS);

      ap.readyResolve = (success: boolean) => {
        if (ap.readyTimeout) { clearTimeout(ap.readyTimeout); ap.readyTimeout = undefined; }
        if (!success) {
          const detail = `${displayName(ap.def.name)} readiness probe failed`;
          ctx.logger.logErrorBox(ap, "READY FAILED", detail);
        }
        resolve(success);
      }

      // Send get_state immediately as the readiness probe. The child's stdin
      // pipe buffers the request until its RPC reader is up, so there is no
      // need for a fixed startup delay — the response (or the 15s timeout)
      // determines readiness.
      if (ap.proc) {
        const stdin = ap.proc.stdin;
        if (stdin?.writable) {
          try {
            stdin.write(JSON.stringify({ type: "get_state" }) + "\n");
          } catch { }
        }
      }
    });
  }
}

/** Returns a (ap, line) => void closure with the ctx baked in. Used by memory.ts
 *  (which cannot import this module) — caller wires it up in index.ts. */
export function makeHandleEvent(ctx: AgentTeamContext): (ap: AgentProc, line: string) => void {
  return (ap, line) => handleEvent(ctx, ap, line);
}
