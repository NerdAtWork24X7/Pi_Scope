// chat.ts — real-time chat with the pi coding agent.
//
// The Chat view is a true CLI-style interaction: the browser sends a prompt to
// this server, which spawns (or reuses) a `pi --mode rpc` subprocess in the
// selected workspace and streams the assistant's thinking/text/tool events back
// to the browser as newline-delimited JSON. A single persistent `pi` process per
// chat session keeps conversation context alive between prompts, just like
// sitting in a terminal.
//
// RPC event protocol (pi --mode rpc):
//   {"type":"response","command":"prompt","success":true}           prompt accepted
//   {"type":"message_start",message:{role:"assistant",...}}
//   {"type":"message_update",assistantMessageEvent:{type:"text_delta",delta}}
//   {"type":"message_update",assistantMessageEvent:{type:"thinking_delta",delta}}
//   {"type":"message_update",usage:{...}}
//   {"type":"tool_execution_start",toolName,args}
//   {"type":"tool_execution_end",toolName}
//   {"type":"extension_ui_request",method:"select"/"input",...}  host dialog
//        (ask_user_question): forwarded to the client, which answers it by
//        writing {"type":"extension_ui_response",id,value|cancelled} back on
//        stdin (via POST /chat/ui → answerChatUi).
//   {"type":"agent_settled"}                                        prompt complete

import { spawn, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ENCODER = new TextEncoder();

/**
 * Resolve the pi binary without relying on spawn()'s PATH lookup. The server is
 * often launched by the Electron scope-launcher, whose npm-lifecycle PATH omits
 * ~/.local/share/pnpm/bin (where pi is installed) — spawning the bare name then
 * fails with ENOENT and every chat dies with "process closed" before any text.
 */
function resolvePiBin(): string {
  const configured = process.env.SCOPE_PI_BIN || "pi";
  if (configured.includes("/")) return configured;
  const dirs = [
    path.join(os.homedir(), ".local", "share", "pnpm", "bin"),
    ...(process.env.PATH || "").split(":").filter(Boolean),
    "/usr/local/bin",
    "/usr/bin",
  ];
  for (const dir of dirs) {
    const candidate = path.join(dir, configured);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* next */ }
  }
  return configured; // fall back to spawn()'s own PATH lookup
}
const PI_BIN = resolvePiBin();
console.log(`  Chat: pi binary: ${PI_BIN}`);

interface ActivePrompt {
  controller: ReadableStreamDefaultController<Uint8Array>;
}

interface ChatSession {
  id: string;
  cwd: string;
  model: string;
  proc: ChildProcess;
  buffer: string;
  stderrBuf: string; // accumulated stderr, used to surface the real pi error on close
  active: ActivePrompt | null;
  lastUsed: number;
  dead: boolean;
  prompted: boolean; // has ever received a prompt (vs idle pre-spawn)
  thinkingLevel: string | null; // last thinking level pushed to this subprocess (null = pi's boot default)
  resumedFile: string | null; // pi session file this subprocess is currently on
  resumeCallback: (() => void) | null; // prompt write deferred until a pending switch_session/new_session resolves
  stopRequested: boolean; // a /chat/stop abort was issued for the current run
  fresh: boolean; // pre-spawned "new conversation" subprocess (vs bound to a recorded session)
}

const sessions = new Map<string, ChatSession>();
const IDLE_TIMEOUT = 10 * 60 * 1000;

// Reap idle chat subprocesses so they don't linger after the user walks away.
setInterval(() => {
  const now = Date.now();
  for (const [id, sess] of sessions) {
    if (now - sess.lastUsed > IDLE_TIMEOUT) {
      try { sess.proc.kill(); } catch { /* already dead */ }
      sessions.delete(id);
    }
  }
}, 60_000).unref();

function enqueue(controller: ReadableStreamDefaultController<Uint8Array>, obj: any) {
  try {
    controller.enqueue(ENCODER.encode(JSON.stringify(obj) + "\n"));
  } catch {
    /* controller closed */
  }
}

function closeActive(sess: ChatSession) {
  const ctrl = sess.active?.controller;
  if (!ctrl) return;
  try { ctrl.close(); } catch { /* already closed */ }
  sess.active = null;
}

/** Pull the first fatal pi error line out of captured stderr. pi writes startup
 *  failures (e.g. "Error: Model ... is ambiguous across providers: ...") to
 *  stderr before exiting. Surfacing that instead of the generic "process closed"
 *  tells the user the real reason the session died. */
function extractPiError(stderr: string): string {
  if (!stderr) return "";
  const line = stderr
    .split("\n")
    .map((l) => l.trim())
    .find((l) => /^error\b/i.test(l));
  return line ? line.replace(/^error:\s*/i, "").trim() : "";
}

function handleLine(sess: ChatSession, line: string) {
  if (!line.trim()) return;
  let ev: any;
  try { ev = JSON.parse(line); } catch { return; }
  const ctrl = sess.active?.controller;
  if (!ctrl) return; // stray event with no in-flight prompt — ignore

  switch (ev.type) {
    case "response": {
      // A switch_session / new_session we issued before the prompt resolves by
      // firing the deferred prompt write once pi confirms the session swap.
      if (ev.command === "switch_session" || ev.command === "new_session") {
        const cb = sess.resumeCallback;
        sess.resumeCallback = null;
        if (!cb) return;
        if (ev.success && !ev.data?.cancelled) {
          cb();
        } else {
          enqueue(ctrl, { type: "error", message: "⚠ could not resume the session — continuing without it" });
          cb();
        }
        return;
      }
      // A rejected command (e.g. a queued steer/follow-up that pi refused)
      // should surface to the client instead of a misleading "accepted".
      if (ev.success === false) {
        enqueue(ctrl, { type: "error", message: ev.error || "pi rejected the command" });
        return;
      }
      enqueue(ctrl, { type: "accepted" });
      return;
    }
    case "message_update":
      if (ev.assistantMessageEvent) {
        const a = ev.assistantMessageEvent;
        if (a.type === "text_delta") enqueue(ctrl, { type: "text", delta: a.delta || "" });
        else if (a.type === "thinking_delta") enqueue(ctrl, { type: "thinking", delta: a.delta || "" });
      }
      if (ev.usage) enqueue(ctrl, { type: "usage", usage: ev.usage });
      return;
    case "message_start":
      // A single run can contain several assistant messages (one per LLM call in
      // a tool loop). Tell the client a new bubble starts so streamed deltas and
      // the per-message `final` snapshot land in their own message instead of
      // piling into one bubble where a later snapshot overwrites earlier text.
      if (ev.message?.role === "assistant") {
        enqueue(ctrl, { type: "msg_start" });
      } else if (ev.message?.role === "user") {
        // A queued steer/follow-up message was just picked up by pi's run loop.
        // pi does NOT emit a fresh agent_start for these (they run inside the
        // current loop unless a continuation is forced), so surface an
        // equivalent run_start. This lets the client adopt the queued user
        // bubble as the anchor for the incoming assistant response AND drop the
        // "waiting for its turn" status the moment pi starts working on it.
        enqueue(ctrl, { type: "run_start" });
      }
      return;
    case "message_end": {
      // Some providers only deliver the complete message on message_end; emit a
      // `final` snapshot so the client always ends up with the full text even if
      // it never saw any text_delta deltas.
      if (ev.message?.role === "assistant") {
        const content = Array.isArray(ev.message.content) ? ev.message.content : [];
        const text = content.filter((c: any) => c.type === "text").map((c: any) => c.text || "").join("");
        const thinking = content.filter((c: any) => c.type === "thinking").map((c: any) => c.thinking || "").join("");
        enqueue(ctrl, { type: "final", text, thinking });
      }
      return;
    }
    case "tool_execution_start":
      enqueue(ctrl, { type: "tool_start", name: ev.toolName || ev.tool || "", args: ev.args || "" });
      return;
    case "tool_execution_end":
      enqueue(ctrl, { type: "tool_end", name: ev.toolName || ev.tool || "" });
      return;
    case "extension_ui_request": {
      // An extension asked the HOST to render UI and is blocking until it gets a
      // reply (pi's dialog sub-protocol). The ask_user_question tool renders its
      // questionnaire through ui.select() / ui.input() here, so without handling
      // these events nothing would ever appear in the chat — the tool would just
      // hang. Forward the dialog to the client (which shows it as an answerable
      // card) and let POST /chat/ui write the extension_ui_response back.
      const u = ev as any;
      const id = typeof u.id === "string" ? u.id : "";
      if (!id) return;
      if (u.method === "select") {
        enqueue(ctrl, {
          type: "ui_select",
          id,
          title: typeof u.title === "string" ? u.title : "",
          options: Array.isArray(u.options) ? u.options.filter((o: any) => typeof o === "string") : [],
        });
      } else if (u.method === "input") {
        enqueue(ctrl, {
          type: "ui_input",
          id,
          title: typeof u.title === "string" ? u.title : "",
          placeholder: typeof u.placeholder === "string" ? u.placeholder : "",
        });
      } else if (u.method === "notify") {
        // Fire-and-forget host notifications; surface as a lightweight status.
        enqueue(ctrl, { type: "ui_notify", message: u.message || "", kind: u.notifyType || "info" });
      }
      return;
    }
    case "agent_start":
      // A new low-level agent run began. The client uses this to anchor the
      // assistant messages of a queued steer/follow-up right after the user
      // bubble that triggered it (and to place an earlier run's leftover
      // tool-loop messages before that bubble).
      enqueue(ctrl, { type: "run_start" });
      return;
    case "agent_settled":
      // Fully settled — no retry, compaction retry, or queued steer/follow-up
      // remains. Only now is the turn truly done; agent_end can be followed by
      // queued continuations, so it is never treated as completion.
      enqueue(ctrl, { type: "done", sessionId: sess.id, model: sess.model, aborted: sess.stopRequested });
      sess.stopRequested = false;
      closeActive(sess);
      return;
    case "agent_end":
      // A single low-level run completed; queued steer/follow-up, retry or
      // compaction may still follow, so wait for agent_settled.
      return;
    default:
      return;
  }
}

/** Child env for the chat pi subprocess: the server's environment with
 *  PI_OFFLINE set (pi's startup network ops are skipped — see spawnChat), and
 *  the pi binary's own directory prepended to PATH. The agent-team extension
 *  running INSIDE that pi process spawns further `pi` subprocesses (subagents,
 *  the memory summarizer) by their bare name from the inherited environment.
 *  Desktop/GUI launches often leave the pnpm global bin dir off PATH — we
 *  resolved the top-level binary by absolute path, but those nested spawns use
 *  plain `pi` and die with ENOENT ("<agent> failed to start") even though the
 *  same dispatch works from a terminal whose PATH includes the bin dir. */
function chatChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PI_OFFLINE: "1" };
  const binDir = PI_BIN.includes("/") ? path.dirname(PI_BIN) : "";
  if (binDir) {
    const parts = String(env.PATH || "").split(path.delimiter).filter(Boolean);
    if (!parts.includes(binDir)) parts.unshift(binDir);
    env.PATH = parts.join(path.delimiter);
  }
  return env;
}

function spawnChat(id: string, cwd: string, model: string, fresh = false): ChatSession {
  // PI_OFFLINE=1 tells pi (and its pi-updater extension) to skip startup network
  // operations. Without it, pi-updater fires async version checks on
  // session_start; when the user resumes a recorded session and the scope server
  // issues switch_session mid-flight, pi invalidates the extension ctx and the
  // in-flight check throws a stale-ctx error that kills the whole subprocess.
  const proc = spawn(PI_BIN, ["--mode", "rpc", "--model", model], {
    cwd,
    env: chatChildEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const sess: ChatSession = { id, cwd, model, proc, buffer: "", stderrBuf: "", active: null, lastUsed: Date.now(), dead: false, prompted: false, thinkingLevel: null, resumedFile: null, resumeCallback: null, stopRequested: false, fresh };

  proc.stdout.on("data", (d: Buffer) => {
    sess.buffer += d.toString();
    let idx: number;
    while ((idx = sess.buffer.indexOf("\n")) >= 0) {
      const line = sess.buffer.slice(0, idx);
      sess.buffer = sess.buffer.slice(idx + 1);
      handleLine(sess, line);
    }
  });
  proc.stderr.on("data", (d: Buffer) => {
    sess.stderrBuf += d.toString();
    // Bound the retained stderr: a long-lived session could otherwise accumulate
    // it forever. Keep only the tail — enough to surface the error on close.
    if (sess.stderrBuf.length > 64 * 1024) sess.stderrBuf = sess.stderrBuf.slice(-64 * 1024);
    const ctrl = sess.active?.controller;
    if (ctrl) enqueue(ctrl, { type: "stderr", text: d.toString() });
  });
  proc.on("error", () => { sess.dead = true; });
  proc.on("close", () => {
    sess.dead = true;
    const ctrl = sess.active?.controller;
    if (ctrl) {
      enqueue(ctrl, { type: "done", sessionId: id, model, error: extractPiError(sess.stderrBuf) || "process closed" });
      try { ctrl.close(); } catch { /* already closed */ }
      sess.active = null;
    }
    sessions.delete(id);
  });

  return sess;
}

/** Spawn/queue a prompt to a (possibly reused) pi subprocess and return a
 *  streaming NDJSON Response. `cwd` must already be validated by the caller.
 *
 *  When `streamingBehavior` is "steer" or "followUp" and a prompt is already in
 *  flight, the message is queued to pi (delivered after the current tool turn /
 *  after the agent settles) and a JSON `{ queued: true }` response is returned
 *  instead of a stream — the in-flight stream keeps delivering events to the
 *  client. */
export function startChat(opts: { cwd: string; model?: string; thinkingLevel?: string; prompt: string; sessionId?: string; sessionFile?: string; streamingBehavior?: string }): Response {
  const { cwd, prompt } = opts;
  const model = (opts.model || "").trim() || "google/gemini-2.5-flash-lite";
  if (!prompt || !prompt.trim()) {
    return new Response(JSON.stringify({ error: "prompt required" }), { status: 400, headers: { "content-type": "application/json" } });
  }

  const sid = (opts.sessionId || "").trim() || crypto.randomUUID();
  // The pi session file to continue. The scope extension records the agent's own
  // session file path, so when the user keeps chatting in a session they opened
  // from the rail we switch the subprocess onto that file and pi resumes with
  // the full conversation context instead of starting from scratch.
  const sessionFile = (opts.sessionFile || "").trim() || "";
  let sess = sessions.get(sid);
  if (!sess || sess.dead || sess.proc.exitCode !== null) {
    try { if (sess) sess.proc.kill(); } catch { /* ignore */ }
    // Every distinct session id gets its own pi subprocess, so different
    // conversations in a workspace run truly in parallel. A subprocess that
    // serves a recorded session is keyed by that session's id; the
    // pre-spawned "new conversation" subprocess (fresh) is keyed by its own
    // random id (spawned via startChatSession with fresh=true).
    sess = spawnChat(sid, cwd, model, false);
    sessions.set(sid, sess);
  }
  sess.lastUsed = Date.now();
  sess.prompted = true;
  if (sess.active) {
    // A prompt is already streaming to this session. With a steer/follow-up
    // behavior we queue the message to pi (it streams back over the existing
    // controller); without one we reject, preserving the old one-at-a-time rule.
    if (opts.streamingBehavior === "steer" || opts.streamingBehavior === "followUp") {
      try {
        sess.proc.stdin.write(JSON.stringify({ type: "prompt", message: prompt, streamingBehavior: opts.streamingBehavior }) + "\n");
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message || String(err) }), { status: 500, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true, queued: true, streamingBehavior: opts.streamingBehavior }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: "a prompt is already running" }), { status: 409, headers: { "content-type": "application/json" } });
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      sess!.active = { controller };
      // Announce the real subprocess session id first. The browser may not have
      // one yet (no pre-spawn, or a request without a sessionId), but answers to
      // extension dialogs (POST /chat/ui) must target the actual session.
      enqueue(controller, { type: "session", sessionId: sid, model });
      // Push the latest model/thinking choice into the running subprocess before
      // prompting. pi resolves --model and the thinking level only at boot, so a
      // subprocess spawned (or pointed at a recorded session) earlier would
      // otherwise keep serving stale values. The RPC set_model /
      // set_thinking_level commands update it in place — the conversation
      // context survives, which respawning could never guarantee.
      const writePrefCommands = (force: boolean) => {
        const level = (opts.thinkingLevel || "").trim();
        if (!force && sess!.model === model && (!level || sess!.thinkingLevel === level)) return;
        const slash = model.indexOf("/");
        if (slash > 0) {
          try {
            sess!.proc.stdin.write(JSON.stringify({ type: "set_model", provider: model.slice(0, slash), modelId: model.slice(slash + 1) }) + "\n");
            sess!.model = model;
          } catch (err: any) {
            enqueue(controller, { type: "error", message: err.message || String(err) });
          }
        }
        if (level) {
          try {
            sess!.proc.stdin.write(JSON.stringify({ type: "set_thinking_level", level }) + "\n");
            sess!.thinkingLevel = level;
          } catch (err: any) {
            enqueue(controller, { type: "error", message: err.message || String(err) });
          }
        }
      };
      writePrefCommands(false);
      const sendPrompt = () => {
        try {
          sess!.proc.stdin.write(JSON.stringify({ type: "prompt", message: prompt }) + "\n");
        } catch (err: any) {
          enqueue(controller, { type: "error", message: err.message || String(err) });
          enqueue(controller, { type: "done", sessionId: sid, model });
          try { controller.close(); } catch { /* ignore */ }
          sess!.active = null;
        }
      };
      // Point the subprocess at the requested session before the prompt and send
      // the prompt once pi confirms the swap; pi answers these with a `response`
      // event which fires sess.resumeCallback in handleLine.
      const queueResume = (cmd: any) => {
        // switch_session may restore the recorded session's own model/thinking
        // state, so re-push the requested prefs AFTER the swap confirms and
        // before the prompt lands (force: our in-memory tracking can't be
        // trusted across a session switch).
        sess!.resumeCallback = () => { writePrefCommands(true); sendPrompt(); };
        try {
          sess!.proc.stdin.write(JSON.stringify(cmd) + "\n");
        } catch (err: any) {
          sess!.resumeCallback = null;
          enqueue(controller, { type: "error", message: err.message || String(err) });
          enqueue(controller, { type: "done", sessionId: sid, model });
          try { controller.close(); } catch { /* ignore */ }
          sess!.active = null;
        }
      };
      if (sessionFile) {
        if (sess!.resumedFile !== sessionFile) {
          sess!.resumedFile = sessionFile;
          queueResume({ type: "switch_session", sessionPath: sessionFile });
        } else {
          sendPrompt(); // already on this session file — just continue
        }
      } else if (sess!.resumedFile) {
        // Fresh conversation on a subprocess that was previously pointed at a
        // recorded session: start a brand-new pi session instead of continuing.
        sess!.resumedFile = null;
        queueResume({ type: "new_session" });
      } else {
        sendPrompt();
      }
    },
    cancel() {
      if (sess && sess.active && sess.active.controller === controller) {
        sess.active = null;
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no" },
  });
}

/** Pre-spawn (or reuse) the workspace's "new conversation" pi subprocess
 *  without sending a prompt, so a fresh session is already running the moment
 *  the user selects a workspace. Only ever reuses or reaps the FRESH pre-spawn
 *  itself — subprocesses bound to recorded sessions (startChat keyed by a
 *  session id) are independent and must never be stolen or killed here, since
 *  they may still be mid-run for another conversation. */
export function startChatSession(opts: { cwd: string; model?: string }): { sessionId: string; reused: boolean } {
  const model = (opts.model || "").trim() || "google/gemini-2.5-flash-lite";
  for (const [id, sess] of sessions) {
    if (!sess.fresh) continue; // never touch recorded-session subprocesses
    if (sess.active || sess.prompted) continue; // in-flight or already conversed
    if (sess.cwd !== opts.cwd || sess.model !== model) {
      try { sess.proc.kill(); } catch { /* already dead */ }
      sessions.delete(id);
    }
  }
  for (const sess of sessions.values()) {
    if (!sess.fresh) continue;
    if (sess.cwd === opts.cwd && sess.model === model && !sess.dead && sess.proc.exitCode === null && !sess.active) {
      sess.lastUsed = Date.now();
      return { sessionId: sess.id, reused: true };
    }
  }
  const sid = crypto.randomUUID();
  sessions.set(sid, spawnChat(sid, opts.cwd, model, true));
  return { sessionId: sid, reused: false };
}

/** Kill a specific chat subprocess by session ID. */
export function killChatSession(id: string): void {
  const sess = sessions.get(id);
  if (!sess) return;
  try { sess.proc.kill(); } catch { /* already dead */ }
  sessions.delete(id);
}

/** Push the requested model + thinking level into a *live* chat subprocess via
 *  the RPC set_model / set_thinking_level commands, so a config change applies
 *  to a session that is already running (or pre-spawned) without killing it and
 *  losing the conversation context. Returns how many commands were sent.
 *
 *  This mirrors the pref-write path in startChat but runs on demand (not only
 *  just before a prompt), so e.g. changing the thinking level in Settings takes
 *  effect on the running agent immediately rather than on the next new session. */
export function pushChatPrefs(id: string, opts: { model?: string; thinkingLevel?: string }): { ok: boolean; sent: number } {
  const sess = sessions.get(id);
  if (!sess || sess.dead || sess.proc.exitCode !== null) return { ok: false, sent: 0 };
  const model = (opts.model || "").trim();
  const level = (opts.thinkingLevel || "").trim();
  let sent = 0;
  try {
    // set_model needs provider + modelId (the "provider/model" split).
    if (model) {
      const slash = model.indexOf("/");
      if (slash > 0) {
        sess.proc.stdin.write(JSON.stringify({ type: "set_model", provider: model.slice(0, slash), modelId: model.slice(slash + 1) }) + "\n");
        sess.model = model;
        sent++;
      }
    }
    if (level) {
      sess.proc.stdin.write(JSON.stringify({ type: "set_thinking_level", level }) + "\n");
      sess.thinkingLevel = level;
      sent++;
    }
  } catch {
    return { ok: false, sent };
  }
  return { ok: true, sent };
}

/** Answer a pending extension_ui dialog (e.g. ask_user_question's select/input)
 *  by writing an `extension_ui_response` line to the subprocess's stdin. pi
 *  resolves the matching dialog promise with `value` (or treats the request as
 *  dismissed when `cancelled`). Returns false when the session is gone/dead so
 *  the client can surface a stale-dialog error. */
export function answerChatUi(id: string, uiId: string, opts: { value?: string; cancelled?: boolean }): boolean {
  const sess = sessions.get(id);
  if (!sess || sess.dead || sess.proc.exitCode !== null || !uiId) return false;
  const body = opts?.cancelled ? { cancelled: true } : { value: String(opts?.value ?? "") };
  try {
    sess.proc.stdin.write(JSON.stringify({ type: "extension_ui_response", id: uiId, ...body }) + "\n");
  } catch {
    return false;
  }
  return true;
}

/** Abort the agent's current run in a chat session (and drop any queued
 *  steer/follow-up messages) so the user can stop it without killing the
 *  subprocess and losing the conversation context. pi emits agent_settled after
 *  the abort, which closes the in-flight stream with `aborted: true`. */
export function stopChat(id: string): boolean {
  const sess = sessions.get(id);
  if (!sess) return false;
  const wasActive = !!sess.active;
  if (wasActive) sess.stopRequested = true;
  try {
    // clear_queue first so queued steer/follow-up messages don't continue after
    // the abort; abort then stops the current run and waits for idle.
    sess.proc.stdin.write(JSON.stringify({ type: "clear_queue" }) + "\n");
    sess.proc.stdin.write(JSON.stringify({ type: "abort" }) + "\n");
  } catch {
    sess.stopRequested = false;
    return false;
  }
  return true;
}

/** Kill every chat subprocess (called on server shutdown). */
export function shutdownChatSessions(): void {
  for (const [, sess] of sessions) {
    try { sess.proc.kill(); } catch { /* ignore */ }
  }
  sessions.clear();
}
