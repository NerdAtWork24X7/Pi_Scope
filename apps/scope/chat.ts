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
    case "response":
      enqueue(ctrl, { type: "accepted" });
      return;
    case "message_update":
      if (ev.assistantMessageEvent) {
        const a = ev.assistantMessageEvent;
        if (a.type === "text_delta") enqueue(ctrl, { type: "text", delta: a.delta || "" });
        else if (a.type === "thinking_delta") enqueue(ctrl, { type: "thinking", delta: a.delta || "" });
      }
      if (ev.usage) enqueue(ctrl, { type: "usage", usage: ev.usage });
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
    case "agent_settled":
    case "agent_end":
      enqueue(ctrl, { type: "done", sessionId: sess.id, model: sess.model });
      closeActive(sess);
      return;
    default:
      return;
  }
}

function spawnChat(id: string, cwd: string, model: string): ChatSession {
  const proc = spawn(PI_BIN, ["--mode", "rpc", "--model", model], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const sess: ChatSession = { id, cwd, model, proc, buffer: "", stderrBuf: "", active: null, lastUsed: Date.now(), dead: false, prompted: false };

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
 *  streaming NDJSON Response. `cwd` must already be validated by the caller. */
export function startChat(opts: { cwd: string; model?: string; prompt: string; sessionId?: string }): Response {
  const { cwd, prompt } = opts;
  const model = (opts.model || "").trim() || "google/gemini-2.5-flash-lite";
  if (!prompt || !prompt.trim()) {
    return new Response(JSON.stringify({ error: "prompt required" }), { status: 400, headers: { "content-type": "application/json" } });
  }

  const sid = (opts.sessionId || "").trim() || crypto.randomUUID();
  let sess = sessions.get(sid);
  if (!sess || sess.dead || sess.proc.exitCode !== null) {
    try { if (sess) sess.proc.kill(); } catch { /* ignore */ }
    sess = spawnChat(sid, cwd, model);
    sessions.set(sid, sess);
  }
  sess.lastUsed = Date.now();
  sess.prompted = true;
  if (sess.active) {
    return new Response(JSON.stringify({ error: "a prompt is already running" }), { status: 409, headers: { "content-type": "application/json" } });
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      sess!.active = { controller };
      try {
        sess!.proc.stdin.write(JSON.stringify({ type: "prompt", message: prompt }) + "\n");
      } catch (err: any) {
        enqueue(controller, { type: "error", message: err.message || String(err) });
        enqueue(controller, { type: "done", sessionId: sid, model });
        try { controller.close(); } catch { /* ignore */ }
        sess!.active = null;
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

/** Pre-spawn (or reuse) a pi chat subprocess for a workspace without sending a
 *  prompt, so a session is already running the moment the user selects a
 *  workspace. Never disturbs sessions with an in-flight prompt or an existing
 *  conversation; at most one idle pre-spawn is kept (mismatched cwd/model ones
 *  are killed). */
export function startChatSession(opts: { cwd: string; model?: string }): { sessionId: string; reused: boolean } {
  const model = (opts.model || "").trim() || "google/gemini-2.5-flash-lite";
  for (const [id, sess] of sessions) {
    if (sess.active || sess.prompted) continue; // in-flight or already conversed
    if (sess.cwd !== opts.cwd || sess.model !== model) {
      try { sess.proc.kill(); } catch { /* already dead */ }
      sessions.delete(id);
    }
  }
  for (const sess of sessions.values()) {
    if (sess.cwd === opts.cwd && sess.model === model && !sess.dead && sess.proc.exitCode === null && !sess.active) {
      sess.lastUsed = Date.now();
      return { sessionId: sess.id, reused: true };
    }
  }
  const sid = crypto.randomUUID();
  sessions.set(sid, spawnChat(sid, opts.cwd, model));
  return { sessionId: sid, reused: false };
}

/** Kill a specific chat subprocess by session ID. */
export function killChatSession(id: string): void {
  const sess = sessions.get(id);
  if (!sess) return;
  try { sess.proc.kill(); } catch { /* already dead */ }
  sessions.delete(id);
}

/** Kill every chat subprocess (called on server shutdown). */
export function shutdownChatSessions(): void {
  for (const [, sess] of sessions) {
    try { sess.proc.kill(); } catch { /* ignore */ }
  }
  sessions.clear();
}
