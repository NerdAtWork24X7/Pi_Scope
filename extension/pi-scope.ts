import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// ━━ Truncation constants & helper ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// These were previously (erroneously) imported from "./pi-scope.ts" — a
// self-import that resolves to `undefined` at runtime. They live here instead.
const MAX_TEXT_FIELD = 16 * 1024;   // 16 KiB cap for free-text fields
const MAX_ARGS_BYTES = 4 * 1024;    // 4 KiB cap per tool-call argument
const MAX_RESULT_BYTES = 16 * 1024; // 16 KiB cap for tool-result text

interface TruncateResult {
  text: string;
  truncated: boolean;
}

/** Truncate a UTF-8 string to at most `maxBytes` bytes without splitting a
 *  multi-byte character. Returns the (possibly shortened) text plus a flag. */
function truncateToBytes(s: string, maxBytes: number): TruncateResult {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return { text: s, truncated: false };
  // Walk back to a code-point boundary so we never cut a multi-byte char.
  let cut = maxBytes;
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
  return { text: buf.subarray(0, cut).toString("utf8"), truncated: true };
}

// ━━ Local event payload types (previously self-imported, now defined here) ━━
interface ObsEventEnvelope<T = unknown> {
  event_id: string;
  ts: string;
  type: string;
  session_id: string;
  session_file?: string;
  cwd: string;
  agent_name?: string;
  pool: string;
  tags: string[];
  provider?: string;
  model?: string;
  payload: T;
  seq: number;
}

interface SessionStartPayload {
  reason?: string;
  pi_version?: string;
  previous_session_file?: string;
}

interface SessionShutdownPayload {
  reason?: string;
}

interface AgentStartPayload {
  prompt: string;
  images_count: number;
  session_id: string;
  session_file?: string;
}

interface LLMRequestPayload {
  system_prompt: string;
  tools?: string[];
  model?: string;
  message_count?: number;
}

interface AgentEndPayload {
  message_count: number;
  final_response?: string;
  final_response_truncated?: boolean;
}

interface TurnStartPayload {
  turn_index: number;
}

interface UsageSummary {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  total_tokens: number;
  cost_total: number;
}

interface TurnEndPayload {
  turn_index: number;
  usage: UsageSummary | undefined;
}

interface UserMessagePayload {
  text: string;
  images_count: number;
}

interface AssistantMessagePayload {
  text: string;
  thinking: string;
  tool_call_ids: string[];
  stop_reason: string;
  usage: UsageSummary;
  error_message?: string;
  latency_ms?: number;
  prefill_ms?: number;
  generation_ms?: number;
  output_tps?: number;
  turn_index: number;
}

interface ThinkingPayload {
  text: string;
}

interface ToolCallPayload {
  tool_call_id: string;
  tool_name: string;
  args: Record<string, any>;
  args_truncated: boolean;
}

interface ToolResultPayload {
  tool_call_id: string;
  tool_name: string;
  content_text: string;
  content_truncated: boolean;
  is_error: boolean;
  details_summary?: Record<string, any>;
}

interface ModelChangePayload {
  provider: string;
  model: string;
  previous_provider?: string;
  previous_model?: string;
  source?: string;
}

interface CompactionPayload {
  reason: string;
  tokens_before: number;
  first_kept_entry_id: string;
  summary_preview: string;
}

interface BranchNavPayload {
  from_id: string;
  to_id: string;
  has_summary: boolean;
  summary_preview?: string;
}

// ━━ Module-scope state ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
let seqCounter = 0;

// Per-run server token is persisted to tmp/scope_token by the server; reuse it
// so the extension and server agree on auth without a hardcoded constant.
const EXT_PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const SCOPE_TOKEN_FILE = path.join(EXT_PROJECT_ROOT, "tmp", "scope_token");

// Friendly random agent name used when neither --o-name nor OBS_NAME is set,
// so sessions stop falling back to the cwd folder name (e.g. "pi-agent-observability").
const AGENT_ADJ = ["calm", "bold", "quick", "quiet", "keen", "wise", "brave", "swift", "cool", "fuzzy"];
const AGENT_NOUN = ["otter", "lynx", "wren", "fox", "heron", "moth", "ibex", "newt", "raven", "yeti"];
function genAgentName(): string {
  const a = AGENT_ADJ[Math.floor(Math.random() * AGENT_ADJ.length)];
  const n = AGENT_NOUN[Math.floor(Math.random() * AGENT_NOUN.length)];
  const k = Math.floor(Math.random() * 90 + 10);
  return `${a}-${n}-${k}`;
}

// ━━ Helper functions ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function loadEnv(cwd: string) {
  const envPaths = [
    path.join(cwd, ".env"),
    path.join(cwd, ".env.local"),
  ];
  for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
      try {
        const content = fs.readFileSync(envPath, "utf8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const eqIdx = trimmed.indexOf("=");
          if (eqIdx <= 0) continue;
          const key = trimmed.slice(0, eqIdx).trim();
          let val = trimmed.slice(eqIdx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          // Don't overwrite vars already set by the shell (avoid stale-.env footgun)
          if (process.env[key] === undefined) process.env[key] = val;
        }
      } catch {
        // ignore errors reading env files
      }
    }
  }
}

// Lightweight reachability check against the obs server's unauthenticated
// /health endpoint. Short timeout so a dead server never stalls agent boot.
async function probeServer(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function truncateArgs(args: Record<string, any>): { args: Record<string, any>; truncated: boolean } {
  let truncated = false;
  let copy: Record<string, any>;
  try {
    copy = JSON.parse(JSON.stringify(args));
  } catch {
    return { args, truncated: false };
  }

  function walk(obj: any) {
    if (!obj || typeof obj !== "object") return;
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === "string") {
        const res = truncateToBytes(obj[key], MAX_ARGS_BYTES);
        if (res.truncated) {
          obj[key] = res.text;
          truncated = true;
        }
      } else if (typeof obj[key] === "object") {
        walk(obj[key]);
      }
    }
  }

  walk(copy);
  return { args: copy, truncated };
}

function extractUserMessage(content: any): { text: string; images_count: number } {
  if (typeof content === "string") {
    return { text: content, images_count: 0 };
  }
  let text = "";
  let images_count = 0;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && block.type === "text") {
        text += (block.text || "") + "\n";
      } else if (block && block.type === "image") {
        images_count++;
      }
    }
  }
  return { text: text.trim(), images_count };
}

function sha256hex(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

// Extract the FINAL system prompt (and a few request-shape facts) from the raw
// provider request payload. pi hands us the exact body it ships to the model:
// Anthropic keeps the system prompt in `payload.system` (string or array of
// {type:"text",text}); OpenAI-style puts it as `payload.messages[0]` with role
// "system"/"developer". Tools/message-count are normalized when present.
function extractFinalSystemPrompt(payload: any): { text: string; tools: string[]; model?: string; messageCount?: number } {
  let text = "";
  const tools: string[] = [];
  let model: string | undefined;
  let messageCount: number | undefined;
  if (!payload || typeof payload !== "object") return { text, tools, model, messageCount };

  if (payload.system != null) {
    if (typeof payload.system === "string") {
      text = payload.system;
    } else if (Array.isArray(payload.system)) {
      text = payload.system
        .map((b: any) => (typeof b === "string" ? b : (b?.text ?? "")))
        .join("\n");
    }
  }
  if (!text && Array.isArray(payload.messages)) {
    const sysMsg = payload.messages.find(
      (m: any) => m && (m.role === "system" || m.role === "developer")
    );
    if (sysMsg) {
      text = typeof sysMsg.content === "string" ? sysMsg.content : JSON.stringify(sysMsg.content);
    }
  }
  if (Array.isArray(payload.tools)) {
    for (const t of payload.tools) {
      if (!t || typeof t !== "object") continue;
      const name = typeof t.name === "string" ? t.name : t.function?.name;
      if (typeof name === "string") tools.push(name);
    }
  }
  if (typeof payload.model === "string") model = payload.model;
  if (Array.isArray(payload.messages)) messageCount = payload.messages.length;
  return { text, tools, model, messageCount };
}

function createEventEnvelope<T>(
  type: string,
  payload: T,
  sessionInfo: {
    sessionId: string;
    sessionFile?: string;
    cwd: string;
    agentName?: string;
    pool: string;
    tags: string[];
    provider?: string;
    model?: string;
  }
): ObsEventEnvelope<T> {
  const seq = seqCounter++;
  return {
    event_id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    type: type as any,
    session_id: sessionInfo.sessionId,
    session_file: sessionInfo.sessionFile,
    cwd: sessionInfo.cwd,
    agent_name: sessionInfo.agentName,
    pool: sessionInfo.pool,
    tags: sessionInfo.tags,
    provider: sessionInfo.provider,
    model: sessionInfo.model,
    payload,
    seq,
  };
}

// ━━ Event Queue Manager ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class EventQueue {
  private queue: any[] = [];
  private maxQueueSize = 10000;
  private flushTimer: NodeJS.Timeout | null = null;
  private backoffMs = 250;
  private maxBackoffMs = 5000;
  private isFlushing = false;
  private consecutiveFailures = 0;
  private droppedEventsCount = 0;
  private getNextSeq: () => number;

  constructor(
    private serverUrl: string,
    private tokenProvider: () => string,
    private pi: ExtensionAPI,
    private onPostFailed: (err: any) => void,
    getNextSeq: () => number
  ) {
    this.getNextSeq = getNextSeq;
  }

  public push(event: any) {
    if (this.queue.length >= this.maxQueueSize) {
      this.queue.shift(); // Drop oldest
      this.droppedEventsCount++;
      if (this.droppedEventsCount === 1) {
        const overflowError = this.createOverflowErrorEvent(event.session_id, event.cwd, event.pool, event.tags);
        this.queue.push(overflowError);
      }
    }
    this.queue.push(event);

    if (this.queue.length >= 50) {
      void this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  private createOverflowErrorEvent(sessionId: string, cwd: string, pool: string, tags: string[]): any {
    return {
      event_id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      type: "error",
      session_id: sessionId,
      cwd: cwd,
      pool: pool,
      tags: tags,
      payload: {
        message: "Extension event queue overflowed. Oldest events dropped.",
        where: "extension-queue",
      },
      // Allocate a real monotonic seq instead of -1 (which would collide on the
      // server's (session_id, seq) UNIQUE index if overflow recurs).
      seq: this.getNextSeq(),
    };
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.backoffMs);
  }

  public async flush() {
    if (this.isFlushing || this.queue.length === 0) return;
    this.isFlushing = true;

    const batch = this.queue.slice(0, 50);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      const tok = this.tokenProvider();
      if (tok) {
        headers["Authorization"] = `Bearer ${tok}`;
      }

      const response = await fetch(`${this.serverUrl}/events`, {
        method: "POST",
        headers,
        body: JSON.stringify(batch),
      });

      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
      }

      // Success! Remove sent items from the queue
      this.queue.splice(0, batch.length);
      this.consecutiveFailures = 0;
      this.backoffMs = 250;
      this.droppedEventsCount = 0;
    } catch (err) {
      this.consecutiveFailures++;
      this.onPostFailed(err);
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    } finally {
      this.isFlushing = false;
      if (this.queue.length > 0) {
        this.scheduleFlush();
      }
    }
  }

  public async stop() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.queue.length > 0) {
      await this.flush();
    }
  }
}

// ━━ Default Export (Extension Entry) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export default function (pi: ExtensionAPI) {
  // ━━ CLI flag registrations ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  pi.registerFlag("obs-server-url", {
    description: "Pi Scope server URL (overrides env OBS_SERVER_URL)",
    type: "string",
    default: undefined,
  });
  pi.registerFlag("obs-token", {
    description: "Bearer token for authenticating with the Pi Scope server",
    type: "string",
    default: undefined,
  });
  pi.registerFlag("o-pool", {
    description: "Logical pool name (overrides env OBS_POOL)",
    type: "string",
    default: undefined,
  });
  pi.registerFlag("o-tag", {
    description: "Observation tags (comma-separated or repeated)",
    type: "string",
    default: undefined,
  });
  pi.registerFlag("o-name", {
    description: "Friendly name for the agent (overrides env OBS_NAME)",
    type: "string",
    default: undefined,
  });
  // Captures the `--o-name <role>` the agent-teams harness passes to each spawned
  // process (subagents, memory summarizer, …) so observability labels it by its real
  // role. NOTE: pi's built-in `--name` is NOT forwarded to extensions, so `--o-name`
  // (which pi.getFlag DOES forward) is the signal used.
  pi.registerFlag("obs-disable", {
    description: "Disable Pi Scope extension entirely (overrides env OBS_DISABLE)",
    type: "boolean",
    default: false,
  });

  const isDisabled = pi.getFlag("obs-disable") === true || process.env.OBS_DISABLE === "true";
  if (isDisabled) {
    return;
  }

  let queue: EventQueue | null = null;
  let sessionInfo: {
    sessionId: string;
    sessionFile?: string;
    cwd: string;
    agentName?: string;
    pool: string;
    tags: string[];
    provider?: string;
    model?: string;
  } | null = null;

  let activeTurnIndex = 0;
  let lastFinalSysSig: string | null = null;
  const turnStartTimes = new Map<number, number>();
  // turnIndex → ts of first text/thinking delta (per-turn TTFT marker).
  // Cleared alongside turnStartTimes at message_end.
  const firstTokenTimes = new Map<number, number>();

  function logObs(message: string, extra?: any) {
    try {
      pi.appendEntry("obs-log", { message, timestamp: new Date().toISOString(), ...extra });
    } catch {
      // ignore
    }
  }

  // ━━ session_start ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  pi.on("session_start", async (event, ctx) => {
    // 1. Load env files from CWD
    loadEnv(ctx.cwd);

    // 2. Resolve parameters
    const serverUrl = (pi.getFlag("obs-server-url") as string) || process.env.OBS_SERVER_URL || "http://127.0.0.1:43190";
    // Resolve the auth token lazily: prefer an explicit flag/env, then fall
    // back to the per-run token the server wrote to tmp/scope_token. Using a
    // provider (not a snapshot) means a token generated after this extension
    // started is still picked up on the first POST.
    const resolveToken = (): string => {
      const explicit = (pi.getFlag("obs-token") as string) || process.env.OBS_AUTH_TOKEN;
      if (explicit) return explicit;
      try { return fs.readFileSync(SCOPE_TOKEN_FILE, "utf8").trim(); } catch { return ""; }
    };
    const token = resolveToken();
    const pool = (pi.getFlag("o-pool") as string) || process.env.OBS_POOL || "default";
    // Resolution order:
    //   1. explicit operator override (--o-name / OBS_NAME)
    //   2. spawned-process role (--o-name, passed by agent-teams to subagents & memory summarizer)
    //   3. orchestrator label (SCOPE_NAME=orchestrator, set by agent-teams when a team is active)
    //   4. random friendly name (standalone sessions)
    const name =
      (pi.getFlag("o-name") as string) ||
      process.env.OBS_NAME ||
      process.env.SCOPE_NAME ||
      genAgentName();

    // Parse tags
    const rawTag = pi.getFlag("o-tag");
    let tags: string[] = [];
    if (rawTag) {
      if (Array.isArray(rawTag)) {
        tags = rawTag.map(t => String(t).trim()).filter(Boolean);
      } else if (typeof rawTag === "string") {
        tags = rawTag.split(",").map(t => t.trim()).filter(Boolean);
      }
    } else if (process.env.OBS_TAG) {
      tags = process.env.OBS_TAG.split(",").map(t => t.trim()).filter(Boolean);
    }

    // 3. Reset seq counter + boot-snapshot gate
    seqCounter = 0;
    lastFinalSysSig = null;

    // 4. Initialize Queue Manager
    queue = new EventQueue(
      serverUrl,
      resolveToken,
      pi,
      (err) => {
        logObs("post_failed", { error: err?.message || String(err) });
      },
      () => seqCounter++
    );

    if (!token) {
      // Loud, single-line warning. Server will 401 every POST otherwise.
      try {
        ctx.ui?.notify?.(
          `📡 Pi Scope: no auth token — set OBS_AUTH_TOKEN env or --obs-token to match the server.`,
          "warning",
        );
      } catch { /* hasUI may be false */ }
      logObs("no_token_configured", { server_url: serverUrl });
    }

    // 4b. Simple connectivity check — tell the operator whether the obs server
    // is reachable. Fire-and-forget with a short timeout so boot never blocks.
    void (async () => {
      const connected = await probeServer(serverUrl);
      try {
        if (connected) {
          ctx.ui?.notify?.(`📡 Pi Scope: connected to ${serverUrl}`, "info");
        } else {
          ctx.ui?.notify?.(
            `📡 Pi Scope: NOT connected to ${serverUrl}. If that's intentional, ignore this — otherwise start the server with \`just obs\`.`,
            "warning",
          );
        }
      } catch { /* hasUI may be false */ }
      logObs(connected ? "server_connected" : "server_unreachable", { server_url: serverUrl });
    })();

    // 5. Initialize session info
    sessionInfo = {
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile(),
      cwd: ctx.cwd,
      agentName: name,
      pool,
      tags,
      provider: ctx.model?.provider,
      model: ctx.model?.id,
    };

    // 6. Log boot
    logObs("obs boot", { serverUrl, pool, tags, agentName: name });

    // 7. Emit session_start event
    const startPayload: SessionStartPayload = {
      reason: event.reason,
      pi_version: (pi as any).version || undefined,
      previous_session_file: event.previousSessionFile,
    };
    queue.push(createEventEnvelope("session_start", startPayload, sessionInfo));
  });

  // ━━ before_agent_start (agent_start) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Emits only the turn's prompt + images_count (+ session ids). llm_request is
  // the sole system-prompt record, so agent_start carries no system-prompt data.
  pi.on("before_agent_start", async (event, _ctx) => {
    if (!queue || !sessionInfo) return;
    const payload: AgentStartPayload = {
      prompt: event.prompt ?? "",
      images_count: event.images ? event.images.length : 0,
      session_id: sessionInfo.sessionId,
      session_file: sessionInfo.sessionFile,
    };
    queue.push(createEventEnvelope("agent_start", payload, sessionInfo));
  });


  // ━━ before_provider_request (final LLM request) ━━━━━━━━━━━━━━━━━━━━━━━━━
  // Captures the FINAL system prompt exactly as sent to the LLM — the real
  // provider request payload (event.payload), not the intermediate assembly
  // available on before_agent_start. This is the SOLE system-prompt record: it
  // carries the full final prompt verbatim (no truncation). Fires once per
  // distinct system prompt (gated on sha256) so overrides/compactions/retries don't spam events.
  pi.on("before_provider_request", async (event, _ctx) => {
    if (!queue || !sessionInfo) return;
    const { text, tools, model, messageCount } = extractFinalSystemPrompt(event.payload);
    if (!text) return;
    const sig = sha256hex(text + "\u0000" + tools.join(",") + "\u0000" + (model ?? ""));
    if (sig === lastFinalSysSig) return;
    lastFinalSysSig = sig;
    const payload: LLMRequestPayload = { system_prompt: text };
    if (tools.length) payload.tools = tools;
    if (model) payload.model = model;
    if (messageCount != null) payload.message_count = messageCount;
    queue.push(createEventEnvelope("llm_request", payload, sessionInfo));
  });

  // ━━ agent_end ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  pi.on("agent_end", async (event, _ctx) => {
    if (!queue || !sessionInfo) return;
    const messages = Array.isArray(event.messages) ? event.messages : [];
    let final_response: string | undefined;
    let final_response_truncated = false;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && m.role === "assistant") {
        let text = "";
        if (typeof m.content === "string") {
          text = m.content;
        } else if (Array.isArray(m.content)) {
          for (const b of m.content) {
            if (b && b.type === "text") text += (b.text || "") + "\n";
          }
        }
        const tr = truncateToBytes(text.trim(), MAX_TEXT_FIELD);
        final_response = tr.text || undefined;
        final_response_truncated = tr.truncated;
        break;
      }
    }
    const payload: AgentEndPayload = {
      message_count: messages.length,
      final_response,
      final_response_truncated,
    };
    queue.push(createEventEnvelope("agent_end", payload, sessionInfo));
  });

  // ━━ turn_start ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  pi.on("turn_start", async (event, _ctx) => {
    if (!queue || !sessionInfo) return;
    activeTurnIndex = event.turnIndex;
    turnStartTimes.set(event.turnIndex, Date.now());
    const payload: TurnStartPayload = {
      turn_index: event.turnIndex,
    };
    queue.push(createEventEnvelope("turn_start", payload, sessionInfo));
  });

  // ━━ turn_end ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  pi.on("turn_end", async (event, _ctx) => {
    if (!queue || !sessionInfo) return;
    let usage: UsageSummary | undefined = undefined;
    if (event.message?.usage) {
      const u = event.message.usage;
      usage = {
        input: u.input ?? 0,
        output: u.output ?? 0,
        cache_read: u.cacheRead ?? 0,
        cache_write: u.cacheWrite ?? 0,
        total_tokens: u.totalTokens ?? 0,
        cost_total: u.cost?.total ?? 0,
      };
    }
    const payload: TurnEndPayload = {
      turn_index: event.turnIndex,
      usage,
    };
    queue.push(createEventEnvelope("turn_end", payload, sessionInfo));
  });

  // ━━ message_start (user_message) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  pi.on("message_start", async (event, _ctx) => {
    if (!queue || !sessionInfo) return;
    if (event.message?.role !== "user") return;

    const { text, images_count } = extractUserMessage(event.message.content);
    const payload: UserMessagePayload = {
      text: truncateToBytes(text, MAX_TEXT_FIELD).text,
      images_count,
    };
    queue.push(createEventEnvelope("user_message", payload, sessionInfo));
  });

  // First-token timing for TTFT — we watch streaming deltas only to record
  // the first-token timestamp, not to emit per-delta observability events.
  // Either text or thinking counts as "first token on the wire". Using
  // activeTurnIndex (set in turn_start) since event.turnIndex isn't
  // guaranteed on message_update payloads (obv-flash review note).
  pi.on("message_update", async (event: any, _ctx) => {
    if (firstTokenTimes.has(activeTurnIndex)) return;
    const d = event?.assistantMessageEvent;
    if (d?.type === "text_delta" || d?.type === "thinking_delta") {
      firstTokenTimes.set(activeTurnIndex, Date.now());
    }
  });

  // ━━ message_end (assistant_message & thinking) ━━━━━━━━━━━━━━━━━━━━━━━━━━━
  pi.on("message_end", async (event, _ctx) => {
    if (!queue || !sessionInfo) return;
    if (event.message?.role !== "assistant") return;

    let text = "";
    let thinking = "";
    const tool_call_ids: string[] = [];

    if (Array.isArray(event.message.content)) {
      for (const block of event.message.content) {
        if (block.type === "text") {
          text += (block.text || "") + "\n";
        } else if (block.type === "thinking") {
          thinking += (block.thinking || block.text || "") + "\n";
        } else if (block.type === "toolCall") {
          if (block.id) {
            tool_call_ids.push(block.id);
          }
        }
      }
    } else if (typeof event.message.content === "string") {
      text = event.message.content;
    }

    text = truncateToBytes(text.trim(), MAX_TEXT_FIELD).text;
    thinking = truncateToBytes(thinking.trim(), MAX_TEXT_FIELD).text;

    let usage: UsageSummary = {
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
      total_tokens: 0,
      cost_total: 0,
    };
    if (event.message.usage) {
      const u = event.message.usage;
      usage = {
        input: u.input ?? 0,
        output: u.output ?? 0,
        cache_read: u.cacheRead ?? 0,
        cache_write: u.cacheWrite ?? 0,
        total_tokens: u.totalTokens ?? 0,
        cost_total: u.cost?.total ?? 0,
      };
    }

    const startTs = turnStartTimes.get(activeTurnIndex);
    const firstTs = firstTokenTimes.get(activeTurnIndex);
    const endTs   = Date.now();
    const latency_ms    = startTs ? endTs - startTs : undefined;
    const prefill_ms    = startTs && firstTs ? firstTs - startTs : undefined;
    const generation_ms = firstTs ? endTs - firstTs : undefined;
    // Floor at 50 ms: below that the streaming window is too small to measure
    // a rate (batched deltas produce e.g. 4 ms → 18000 TPS, pure measurement
    // noise). 50 ms × 2000 TPS ceiling = 100 tokens, which is still well above
    // any realistic single-batch arrival, so the floor only drops noise.
    const output_tps    = generation_ms && generation_ms >= 50 && usage.output > 0
      ? Math.round((usage.output / generation_ms) * 1000)
      : undefined;
    // Memory hygiene (obv-flash v3 nit, bundled here): clean both Maps so they
    // don't accumulate one entry per turn over the life of the session.
    turnStartTimes.delete(activeTurnIndex);
    firstTokenTimes.delete(activeTurnIndex);

    const payload: AssistantMessagePayload = {
      text,
      thinking,
      tool_call_ids,
      stop_reason: event.message.stopReason || "stop",
      usage,
      error_message: event.message.errorMessage,
      latency_ms,
      prefill_ms,
      generation_ms,
      output_tps,
      turn_index: activeTurnIndex,
    };

    queue.push(createEventEnvelope("assistant_message", payload, sessionInfo));

    if (thinking) {
      const thinkingPayload: ThinkingPayload = {
        text: thinking,
      };
      queue.push(createEventEnvelope("thinking", thinkingPayload, sessionInfo));
    }
  });

  // ━━ tool_call (do NOT block) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  pi.on("tool_call", async (event, _ctx) => {
    if (!queue || !sessionInfo) return;
    const { args, truncated } = truncateArgs(event.input || {});
    const payload: ToolCallPayload = {
      tool_call_id: event.toolCallId,
      tool_name: event.toolName,
      args,
      args_truncated: truncated,
    };
    queue.push(createEventEnvelope("tool_call", payload, sessionInfo));
  });

  // ━━ tool_result (do NOT modify) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  pi.on("tool_result", async (event, _ctx) => {
    if (!queue || !sessionInfo) return;
    let content_text = "";
    if (Array.isArray(event.content)) {
      for (const block of event.content) {
        if (block.type === "text") {
          content_text += (block.text || "") + "\n";
        }
      }
    } else if (typeof event.content === "string") {
      content_text = event.content;
    }

    const tr = truncateToBytes(content_text.trim(), MAX_RESULT_BYTES);

    let details_summary: Record<string, any> | undefined = undefined;
    if (event.details && typeof event.details === "object") {
      details_summary = {};
      if ("exitCode" in event.details) details_summary.exit_code = event.details.exitCode;
      if ("exit_code" in event.details) details_summary.exit_code = event.details.exit_code;
      if ("cancelled" in event.details) details_summary.cancelled = event.details.cancelled;
      if ("truncated" in event.details) details_summary.truncated = event.details.truncated;
    }

    const payload: ToolResultPayload = {
      tool_call_id: event.toolCallId,
      tool_name: event.toolName,
      content_text: tr.text,
      content_truncated: tr.truncated,
      is_error: event.isError === true,
      details_summary,
    };
    queue.push(createEventEnvelope("tool_result", payload, sessionInfo));
  });

  // ━━ model_select ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  pi.on("model_select", async (event, _ctx) => {
    if (!queue || !sessionInfo) return;

    sessionInfo.provider = event.model.provider;
    sessionInfo.model = event.model.id;

    const payload: ModelChangePayload = {
      provider: event.model.provider,
      model: event.model.id,
      previous_provider: event.previousModel?.provider,
      previous_model: event.previousModel?.id,
      source: event.source ?? "set",
    };
    queue.push(createEventEnvelope("model_change", payload, sessionInfo));
  });

  // ━━ session_compact ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  pi.on("session_compact", async (event, _ctx) => {
    if (!queue || !sessionInfo) return;
    const ce = event.compactionEntry;
    const payload: CompactionPayload = {
      reason: event.fromExtension ? "manual" : "auto",
      tokens_before: ce?.tokensBefore ?? 0,
      first_kept_entry_id: ce?.firstKeptEntryId ?? "",
      summary_preview: truncateToBytes(ce?.summary ?? "", 2000).text,
    };
    queue.push(createEventEnvelope("compaction", payload, sessionInfo));
  });

  // ━━ session_tree ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  pi.on("session_tree", async (event, _ctx) => {
    if (!queue || !sessionInfo) return;
    const se = event.summaryEntry;
    const payload: BranchNavPayload = {
      from_id: event.oldLeafId ?? "",
      to_id:   event.newLeafId ?? "",
      has_summary: !!se,
      summary_preview: se ? truncateToBytes(se.summary ?? "", 2000).text : undefined,
    };
    queue.push(createEventEnvelope("branch_nav", payload, sessionInfo));
  });

  // ━━ session_shutdown ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  pi.on("session_shutdown", async (event, _ctx) => {
    if (!queue || !sessionInfo) return;

    const shutdownPayload: SessionShutdownPayload = {
      reason: event.reason,
    };
    queue.push(createEventEnvelope("session_shutdown", shutdownPayload, sessionInfo));

    await queue.stop();
  });
}