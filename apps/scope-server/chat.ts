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
import { readStoredKeys } from "./api-keys.ts";
import { expandShellPath, readShellEnvValues, shellQuote, resolveExecutable } from "../../shared/shell.ts";
// Importing this resolves the bundled Pi coding agent and puts its `pi` shim on
// PATH (force-loading the Pi Scope extension). Must be imported before PI_BIN is
// used so chat subprocesses launch the bundled agent, not a global install.
import { PI_BIN } from "./pi-bundle.ts";

const ENCODER = new TextEncoder();

// Replay buffer bounds for an in-flight run. A browser that attaches late (a
// reloaded page, a second tab) replays the run from its first event, so the log
// is bounded by BOTH a count and a byte budget — a tool-heavy run must not be
// able to grow the server's heap without limit. When the budget is exceeded the
// oldest events are dropped (the turn's tail is what is still streaming).
const RUN_LOG_MAX_EVENTS = 20000;
const RUN_LOG_MAX_BYTES = 4 * 1024 * 1024;

/**
 * A prompt pi refuses *before* a turn starts is a preflight failure — nothing
 * streamed, no agent started. The one that bites in practice is the credential
 * check: pi resolves a provider's auth asynchronously at boot, so a prompt that
 * lands in the first moments after spawn can be refused with "No API key found
 * for <provider>" even though the key is stored (the workflow runner and the
 * office queue prompt immediately, which is exactly when this happens). That is
 * transient, so the prompt is re-sent a couple of times before the run is
 * failed. Anything else — a genuinely missing key, an unknown model — fails
 * after the same few attempts instead of hanging.
 */
const PROMPT_RETRY_MAX = 3;
/** The first retry's wait; each further attempt waits this long times its number
 *  (1.2s, 2.4s, 3.6s), which covers a credential resolution that needs a network
 *  round trip without making a genuine misconfiguration feel like a hang. */
const PROMPT_RETRY_DELAY_MS = 1200;
/** The preflight refusals worth retrying: a credential/model resolution that has
 *  not finished, rather than a configuration that will never work. */
const TRANSIENT_PROMPT_ERROR = /No API key found|No model selected|Authentication failed|Credentials may have expired|while compaction is in progress/i;

/**
 * One in-flight prompt (a "run") on a chat session.
 *
 * The run OWNS the readers watching it rather than the other way around: the
 * response stream of the POST /chat that started it is just the first
 * subscriber. A page that reloads when its fetch is cancelled (or a second tab)
 * therefore ATTACHES to the same run instead of losing the turn — the bounded
 * `log` lets the attach replay everything emitted so far, and pi's completion is
 * still recorded server-side either way.
 */
interface ChatRun {
  subs: Set<ReadableStreamDefaultController<Uint8Array>>;
  log: Array<{ obj: any; bytes: number }>; // replay buffer for late subscribers
  bytes: number; // running size of `log`
  prompt: string; // the user prompt that started this run
  startedAt: number;
  openUi: Map<string, any>; // extension_ui dialogs still waiting for an answer
  promptRetries: number; // preflight refusals already retried (see PROMPT_RETRY_MAX)
  /** Re-send this run's prompt. Set by `startChat` (the prompt writer lives in
   *  its stream closure); used to retry a preflight refusal from `handleLine`. */
  resend: (() => void) | null;
}

interface ChatSession {
  id: string;
  cwd: string;
  model: string;
  proc: ChildProcess;
  buffer: string;
  stderrBuf: string; // accumulated stderr, used to surface the real pi error on close
  run: ChatRun | null;
  lastUsed: number;
  dead: boolean;
  prompted: boolean; // has ever received a prompt (vs idle pre-spawn)
  thinkingLevel: string | null; // last thinking level pushed to this subprocess (null = pi's boot default)
  resumedFile: string | null; // pi session file this subprocess is currently on
  resumeCallback: (() => void) | null; // prompt write deferred until a pending switch_session/new_session resolves
  stopRequested: boolean; // a /chat/stop abort was issued for the current run
  fresh: boolean; // pre-spawned "new conversation" subprocess (vs bound to a recorded session)
  librarySent: boolean; // the reference-library block has been injected into this conversation
  runState: "running" | null; // a prompt is in flight in pi (cleared when agent_settled arrives)
  lastRun: { outcome: "done" | "error" | "aborted"; at: number } | null; // how the last run ended
}

const sessions = new Map<string, ChatSession>();
const IDLE_TIMEOUT = 10 * 60 * 1000;

// Reap idle chat subprocesses so they don't linger after the user walks away.
setInterval(() => {
  const now = Date.now();
  for (const [id, sess] of sessions) {
    // A run in flight is never "idle": a long turn can be silent for a while (a
    // single slow tool call, or pi blocked on a host dialog), and killing it
    // would drop the turn the user is watching. `handleLine` keeps lastUsed
    // fresh while output streams; this guard covers the silent stretches.
    if (sess.run) continue;
    if (now - sess.lastUsed > IDLE_TIMEOUT) {
      try { sess.proc.kill(); } catch { /* already dead */ }
      sessions.delete(id);
    }
  }
}, 60_000).unref();

function enqueueRaw(controller: ReadableStreamDefaultController<Uint8Array>, line: string): boolean {
  try {
    controller.enqueue(ENCODER.encode(line));
    return true;
  } catch {
    return false; // the reader is gone (closed/errored) — the caller drops it
  }
}

function enqueue(controller: ReadableStreamDefaultController<Uint8Array>, obj: any) {
  enqueueRaw(controller, JSON.stringify(obj) + "\n");
}

/** Emit one event of a run: record it in the replay buffer (so a late attach
 *  can rebuild the whole turn) and push it to every attached reader. */
function runEmit(run: ChatRun, obj: any) {
  const line = JSON.stringify(obj);
  // UTF-8 bytes, not UTF-16 code units: the budget guards heap, and a reply full
  // of multi-byte characters (CJK, emoji) must not slip past it.
  const bytes = Buffer.byteLength(line, "utf8") + 1;
  run.log.push({ obj, bytes });
  run.bytes += bytes;
  while (run.log.length > RUN_LOG_MAX_EVENTS || (run.bytes > RUN_LOG_MAX_BYTES && run.log.length > 1)) {
    run.bytes -= run.log.shift()!.bytes;
  }
  const encoded = line + "\n";
  for (const c of [...run.subs]) {
    // A controller that refuses bytes is a reader nobody is reading: drop it, so
    // a dead stream is not written to for the rest of the run.
    if (!enqueueRaw(c, encoded)) run.subs.delete(c);
  }
}

/** Finish a run: hand the terminal events (error, then done) to every attached
 *  reader, close them, and drop the run (the idle session stays alive for the
 *  next prompt). */
function endRun(sess: ChatSession, ...events: any[]) {
  const run = sess.run;
  if (!run) return;
  sess.run = null;
  run.openUi.clear();
  for (const c of run.subs) {
    for (const ev of events) enqueue(c, ev);
    try { c.close(); } catch { /* already closed */ }
  }
  run.subs.clear();
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
  // Streaming output is proof of life: an idle-reaper kill must never land
  // mid-run (a long turn can outlast the 10-minute idle window), and lastUsed
  // is what the reaper reads.
  sess.lastUsed = Date.now();

  // Completion is recorded even when no browser is reading the stream: a page
  // that reloads away (or a second tab) abandons the response, but pi keeps
  // running. The office queue runner reads this to settle a task whose run
  // outlived the client that dispatched it, instead of re-dispatching it.
  if (ev.type === "agent_settled") {
    sess.runState = null;
    sess.lastRun = { outcome: sess.stopRequested ? "aborted" : "done", at: Date.now() };
    endRun(sess, { type: "done", sessionId: sess.id, model: sess.model, aborted: sess.stopRequested });
    sess.stopRequested = false;
    return;
  }

  const run = sess.run;
  if (!run) return; // stray event with no in-flight prompt — ignore

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
          runEmit(run, { type: "error", message: "⚠ could not resume the session — continuing without it" });
          cb();
        }
        return;
      }
      // A rejected command (e.g. a queued steer/follow-up that pi refused)
      // should surface to the client instead of a misleading "accepted".
      if (ev.success === false) {
        const message = String(ev.error || "pi rejected the command");
        // A refused *prompt* is a preflight failure: no turn started, so nothing
        // will ever follow — pi keeps the process alive waiting for the next
        // command. Leaving the run open would hang every reader that waits for
        // the stream to close (the workflow runner, the office queue), so the
        // run is either retried (a startup credential race) or ended here.
        if (ev.command === "prompt" && sess.run === run) {
          const attempts = run.promptRetries + 1;
          if (TRANSIENT_PROMPT_ERROR.test(message) && attempts <= PROMPT_RETRY_MAX) {
            run.promptRetries = attempts;
            runEmit(run, { type: "stderr", text: `${message}\n\n(pi refused the prompt before the turn started — retrying, attempt ${attempts + 1}/${PROMPT_RETRY_MAX + 1})` });
            setTimeout(() => {
              if (sess.run !== run) return; // stopped, killed or replaced meanwhile
              run.resend?.();
            }, PROMPT_RETRY_DELAY_MS * attempts);
            return;
          }
          endRun(sess, { type: "error", message }, { type: "done", sessionId: sess.id, model: sess.model, error: message });
          return;
        }
        runEmit(run, { type: "error", message });
        return;
      }
      runEmit(run, { type: "accepted" });
      return;
    }
    case "message_update":
      if (ev.assistantMessageEvent) {
        const a = ev.assistantMessageEvent;
        if (a.type === "text_delta") runEmit(run, { type: "text", delta: a.delta || "" });
        else if (a.type === "thinking_delta") runEmit(run, { type: "thinking", delta: a.delta || "" });
      }
      if (ev.usage) runEmit(run, { type: "usage", usage: ev.usage });
      return;
    case "message_start":
      // A single run can contain several assistant messages (one per LLM call in
      // a tool loop). Tell the client a new bubble starts so streamed deltas and
      // the per-message `final` snapshot land in their own message instead of
      // piling into one bubble where a later snapshot overwrites earlier text.
      if (ev.message?.role === "assistant") {
        runEmit(run, { type: "msg_start" });
      } else if (ev.message?.role === "user") {
        // A queued steer/follow-up message was just picked up by pi's run loop.
        // pi does NOT emit a fresh agent_start for these (they run inside the
        // current loop unless a continuation is forced), so surface an
        // equivalent run_start. This lets the client adopt the queued user
        // bubble as the anchor for the incoming assistant response AND drop the
        // "waiting for its turn" status the moment pi starts working on it.
        runEmit(run, { type: "run_start" });
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
        runEmit(run, { type: "final", text, thinking });
      }
      return;
    }
    case "tool_execution_start":
      runEmit(run, { type: "tool_start", name: ev.toolName || ev.tool || "", args: ev.args || "" });
      return;
    case "tool_execution_end":
      runEmit(run, { type: "tool_end", name: ev.toolName || ev.tool || "" });
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
        const dlg = {
          type: "ui_select",
          id,
          title: typeof u.title === "string" ? u.title : "",
          options: Array.isArray(u.options) ? u.options.filter((o: any) => typeof o === "string") : [],
        };
        // Remember the question until it is answered: pi BLOCKS on it, so a page
        // that reattaches must be able to show (and answer) it again instead of
        // leaving the agent waiting on a dialog nobody can see.
        run.openUi.set(id, dlg);
        runEmit(run, dlg);
      } else if (u.method === "input") {
        const dlg = {
          type: "ui_input",
          id,
          title: typeof u.title === "string" ? u.title : "",
          placeholder: typeof u.placeholder === "string" ? u.placeholder : "",
        };
        run.openUi.set(id, dlg);
        runEmit(run, dlg);
      } else if (u.method === "notify") {
        // Fire-and-forget host notifications; surface as a lightweight status.
        runEmit(run, { type: "ui_notify", message: u.message || "", kind: u.notifyType || "info" });
      }
      return;
    }
    case "agent_start":
      // A new low-level agent run began. The client uses this to anchor the
      // assistant messages of a queued steer/follow-up right after the user
      // bubble that triggered it (and to place an earlier run's leftover
      // tool-loop messages before that bubble).
      runEmit(run, { type: "run_start" });
      return;
    case "agent_end":
      // A single low-level run completed; queued steer/follow-up, retry or
      // compaction may still follow, so wait for agent_settled.
      return;
    default:
      return;
  }
}

/** Venv bin directories to expose to the chat pi subprocess, most specific
 *  first. Pi is spawned inside the user's interactive shell (see spawnChat), so
 *  their rc files are sourced — but activating a project's Python venv is a manual
 *  step nobody puts in an rc, so the venv is still absent from PATH and pi's
 *  web-fetch-style tools fail with "cannot find playwright" even though it is
 *  installed there. Mirror what `source .venv/bin/activate` does in a terminal:
 *  prepend the venv's bin dir to PATH.
 *
 *  Only existing dirs that actually look like a venv (have a bin/{activate,
 *  python, python3}) are added; a workspace-local venv wins over the home one. */
function venvBinDirs(cwd: string): string[] {
  const candidates = [
    path.join(cwd, ".venv", "bin"),
    path.join(cwd, "venv", "bin"),
    path.join(os.homedir(), ".venv", "bin"),
  ];
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const dir of candidates) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    try {
      const looksLikeVenv =
        fs.existsSync(path.join(dir, "activate")) ||
        fs.existsSync(path.join(dir, "python")) ||
        fs.existsSync(path.join(dir, "python3"));
      if (looksLikeVenv) dirs.push(dir);
    } catch { /* unreadable — skip */ }
  }
  return dirs;
}

/** True when `dir` holds an installed Playwright browser build (a subdirectory
 *  named like chromium-<build>, firefox-<build>, webkit-<build>,
 *  headless_shell-<build>, or chromium_headless_shell-<build>). Used so we
 *  only adopt a candidate browsers dir that will actually work — never a stale
 *  rc path that would break an otherwise-fine default resolution. */
function looksLikePlaywrightBrowsersDir(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((name) =>
      /^(chromium|firefox|webkit|headless_shell|chromium_headless_shell)-/.test(name)
    );
  } catch {
    return false;
  }
}

/** Resolve the Playwright browsers dir the way the user's interactive terminal
 *  would, so chat-spawned pi subprocesses see the same Chromium as the
 *  terminal. Order:
 *  1. The server's own env, when the launcher already carried it through.
 *  2. An `export PLAYWRIGHT_BROWSERS_PATH=...` (or bare assignment) in the
 *     user's shell rc files — the typical setup for a custom browser dir
 *     (e.g. `~/.zshrc` → `export PLAYWRIGHT_BROWSERS_PATH=$HOME/playwright-browsers`).
 *     Quotes are stripped and `$HOME`/`${HOME}`/`~` expanded.
 *  3. Playwright's own default cache locations, when they actually hold a
 *     browser build (Linux `~/.cache/ms-playwright`, macOS
 *     `~/Library/Caches/ms-playwright`, Windows `%LOCALAPPDATA%\ms-playwright`).
 *  Returns null when nothing usable is found, so the child keeps its inherited
 *  (default) resolution instead of pointing at a bogus path. */
function resolvePlaywrightBrowsersPath(): string | null {
  const explicit = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (explicit) return explicit;
  const home = os.homedir();
  // First rc assignment that actually points at an installed browser build wins.
  for (const val of readShellEnvValues("PLAYWRIGHT_BROWSERS_PATH")) {
    const dir = expandShellPath(val);
    if (looksLikePlaywrightBrowsersDir(dir)) return dir;
  }
  const candidates = [
    process.env.XDG_CACHE_HOME ? path.join(process.env.XDG_CACHE_HOME, "ms-playwright") : "",
    path.join(home, ".cache", "ms-playwright"),
    path.join(home, "Library", "Caches", "ms-playwright"),
    path.join(home, "AppData", "Local", "ms-playwright"),
  ];
  for (const dir of candidates) {
    if (dir && looksLikePlaywrightBrowsersDir(dir)) return dir;
  }
  return null;
}

/** Child env for the chat pi subprocess: the server's environment with
 *  PI_OFFLINE set (pi's startup network ops are skipped — see spawnChat), plus
 *  PATH additions so the spawned pi sees everything the user's terminal would.
 *  In order, prepended before the inherited PATH:
 *
 *  1. The workspace's Python venv bin dirs (see venvBinDirs) — tools like
 *     web-fetch that need the venv's `playwright` keep working in Chat.
 *  2. SCOPE_EXTRA_PATH (colon-separated) — explicit user override, e.g.
 *     `SCOPE_EXTRA_PATH=~/.pyenv/versions/3.12/bin apps/scope-desktop/run.sh`.
 *  3. The pi binary's own directory, so the agent-team extension running INSIDE
 *     that pi process can spawn further `pi` subprocesses (subagents, the
 *     memory summarizer) by their bare name from the inherited environment —
 *     desktop/GUI launches often leave the pnpm global bin dir off PATH and
 *     those nested spawns then die with ENOENT ("<agent> failed to start").
 *  4. The server's own node binary's directory: `pi` is usually a pnpm shim
 *     shell script whose final fallback is `exec node <cli.js>`, so it needs a
 *     `node` on PATH. The bundled AppImage server runs under a portable Node
 *     that lives in resources/ (never on PATH), and the GUI session that
 *     launched it may not have nvm's node dir either — without this the shim
 *     dies instantly with "exec: node: not found" (stderr) and every chat
 *     fails with the generic "process closed".
 *
 *  Beyond PATH, PLAYWRIGHT_BROWSERS_PATH is restored from the user's shell rc
 *  (see resolvePlaywrightBrowsersPath) so pi's web-fetch-style tools find the
 *  Chromium binaries exactly like they do in the terminal.
 *
 *  API keys saved on the Settings page are injected too (see readStoredKeys),
 *  so pi extensions that read process.env (omni-router, kilo,
 *  speech-to-text, …) work without the key having to live in a shell profile
 *  the GUI launch never sources. A stored key overrides the inherited value. */
function chatChildEnv(cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PI_OFFLINE: "1" };
  const parts = String(env.PATH || "").split(path.delimiter).filter(Boolean);
  const prepend = (dir: string) => {
    if (dir && !parts.includes(dir)) parts.unshift(dir);
  };
  // Workspace venv first so `python`/`playwright` resolve from it, mirroring
  // what `source .venv/bin/activate` does in the terminal.
  for (const dir of venvBinDirs(cwd)) prepend(dir);
  // Explicit user-configured dirs (SCOPE_EXTRA_PATH), e.g. a non-standard venv
  // or a pyenv/conda env the auto-detect can't find. A leading `~` is expanded
  // so `SCOPE_EXTRA_PATH=~/.venv/bin` works from any shell.
  for (const dir of String(process.env.SCOPE_EXTRA_PATH || "").split(path.delimiter).filter(Boolean)) {
    const d = dir.trim();
    prepend(d === "~" ? os.homedir() : d.startsWith("~/") ? path.join(os.homedir(), d.slice(2)) : d);
  }
  // The server's own node (bundled portable Node when packaged) so pnpm-shim
  // pi binaries can find `node`.
  prepend(path.dirname(process.execPath));
  // The pi binary's dir must WIN, not merely be present: the agent-team
  // extension spawns subagents by the bare name `pi`, so whichever `pi` comes
  // first on PATH is the agent the orchestrator itself runs under — and the two
  // must be the same build. A plain prepend() skips an already-inherited entry,
  // which left the shim behind pnpm's global bin dir: subagents then ran the
  // global pi, rejected the Pi Scope extension's flags (`Unknown option:
  // --o-name`) and exited 1, surfacing as "<agent> failed to start".
  if (PI_BIN.includes("/")) {
    const dir = path.dirname(PI_BIN);
    const at = parts.indexOf(dir);
    if (at > 0) parts.splice(at, 1);
    if (!parts.includes(dir)) parts.unshift(dir);
  }
  env.PATH = parts.join(path.delimiter);
  // Playwright browser binaries (pi's web-fetch / crawl tools): the GUI
  // session that launched the server never sources the user's shell rc, so a
  // PLAYWRIGHT_BROWSERS_PATH exported there (e.g. a custom ~/playwright-browsers
  // instead of the default ~/.cache/ms-playwright) is missing from the child
  // env. Without it playwright can import fine (venv PATH fix above) but cannot
  // find Chromium, so web-fetch fails in Chat while working in the terminal.
  const pwBrowsers = resolvePlaywrightBrowsersPath();
  if (pwBrowsers) env.PLAYWRIGHT_BROWSERS_PATH = pwBrowsers;
  // API keys entered on the Settings page — applied last so a value the user
  // saved there wins over whatever the launcher's environment carried.
  for (const [name, value] of Object.entries(readStoredKeys())) env[name] = value;
  return env;
}

/** The user's interactive shell, used to spawn pi with the environment their
 *  terminal would have. Prefers $SHELL when it is bash/zsh (so the user's own
 *  shell rc is the one sourced), then bash, then zsh. Null when neither is
 *  installed — spawnChat then falls back to a direct spawn. */
function resolveInteractiveShell(): string | null {
  const candidates: string[] = [];
  const fromEnv = (process.env.SHELL || "").trim();
  if (fromEnv) candidates.push(fromEnv);
  candidates.push("bash", "zsh");
  for (const candidate of candidates) {
    const base = path.basename(candidate);
    if (base !== "bash" && base !== "zsh") continue;
    const resolved = resolveExecutable(candidate);
    if (resolved) return resolved;
  }
  return null;
}
const CHAT_SHELL = resolveInteractiveShell();
console.log(`  Chat: pi spawn shell: ${CHAT_SHELL ?? "(direct)"}`);

/** Directories child paths put ahead of the inherited PATH, re-applied inside
 *  the shell because an rc file that reassigns PATH would otherwise drop the
 *  venv / node / pi-bin dirs.
 *
 *  The pi binary's own directory is ALWAYS led — even when it is already on the
 *  inherited PATH. `chatChildEnv` moves it to the front of the child env, but
 *  the interactive shell sources the user's rc BEFORE this export runs, and an
 *  rc that prepends a dir holding a different `pi` (e.g. pnpm's global bin,
 *  which `~/.bashrc` / `~/.zshrc` put ahead of everything) shadows the bundled
 *  shim. The agent-team extension spawns subagents by the bare name `pi`, so
 *  the shadowed shim meant subagents ran the global agent and died ("<agent>
 *  failed to start"). Leading with it here re-asserts the shim after the rc. */
function chatPathPrefix(cwd: string): string {
  const child = String(chatChildEnv(cwd).PATH || "").split(path.delimiter).filter(Boolean);
  const inherited = new Set(String(process.env.PATH || "").split(path.delimiter).filter(Boolean));
  const extra = child.filter((dir) => !inherited.has(dir));
  const piDir = PI_BIN.includes("/") ? path.dirname(PI_BIN) : "";
  const prefix: string[] = [];
  if (piDir) prefix.push(piDir);
  for (const dir of extra) if (dir !== piDir) prefix.push(dir);
  return prefix.join(path.delimiter);
}

/**
 * Per-run capability allowlists a caller may hand to a chat subprocess. They map
 * onto pi's own flags (`--skill <path>`, `--tools a,b`, `--extension <path>`) and
 * are only meaningful at spawn time, which is why every caller that needs them
 * uses a session id of its own (a fresh subprocess). All optional: omitting them
 * produces exactly the argv this module has always used.
 */
export interface ChatSpawnExtras {
  /** Skill files or directories to load (`--skill`, repeated). */
  skills?: string[];
  /** Comma-joined tool allowlist (`--tools`). */
  tools?: string[];
  /** Extension files or `builtin:<name>` entries (`--extension`, repeated). */
  extensions?: string[];
}

/**
 * The argv for a chat subprocess. Exported so the flag shape is testable without
 * spawning the bundled agent.
 */
export function chatSpawnArgs(model: string, extras: ChatSpawnExtras = {}): string[] {
  const args = ["--mode", "rpc", "--model", model];
  for (const skill of extras.skills ?? []) args.push("--skill", skill);
  if (extras.tools?.length) args.push("--tools", extras.tools.join(","));
  for (const ext of extras.extensions ?? []) args.push("--extension", ext);
  return args;
}

function spawnChat(id: string, cwd: string, model: string, fresh = false, extras: ChatSpawnExtras = {}): ChatSession {
  const args = chatSpawnArgs(model, extras);
  // PI_OFFLINE=1 tells pi (and its pi-updater extension) to skip startup network
  // operations. Without it, pi-updater fires async version checks on
  // session_start; when the user resumes a recorded session and the scope server
  // issues switch_session mid-flight, pi invalidates the extension ctx and the
  // in-flight check throws a stale-ctx error that kills the whole subprocess.
  const env = chatChildEnv(cwd);
  let proc: ChildProcess;
  let out: NodeJS.ReadableStream;

  if (CHAT_SHELL) {
    // Spawn pi through the user's INTERACTIVE shell (`-ic`) so it gets the
    // environment their terminal would: ~/.bashrc (bash) or ~/.zshrc (zsh) is
    // sourced, which is where API keys, PATH entries and tool versions are
    // usually exported. `-i` without `-l` is deliberate — the login profile
    // files (~/.bash_profile, ~/.profile, ~/.zprofile) are skipped, so a login
    // shell's slower startup or interactive-only banners can't delay or corrupt
    // the RPC handshake. The server itself is often launched from a desktop
    // session that never reads any of this — chatChildEnv patches the few vars
    // we know about, but a shell is what makes the rest correct.
    //
    // Two details matter:
    //   • pi speaks NDJSON on stdout, and rc files print banners/escape codes
    //     there. So pi's output is redirected to fd 3 (the pipe we read as the
    //     RPC stream) and the shell's own stdout goes to /dev/null.
    //   • `exec` replaces the shell with pi, so the pid we hold stays pi itself —
    //     signals, killing and the idle reaper keep working.
    const pathPrefix = chatPathPrefix(cwd);
    const cmd =
      (pathPrefix ? `export PATH=${shellQuote(pathPrefix + ":")}"$PATH"; ` : "") +
      // An rc file may have changed directory; put pi back in the workspace.
      `cd ${shellQuote(cwd)} || exit 1; ` +
      `exec ${[PI_BIN, ...args].map(shellQuote).join(" ")} 1>&3`;
    proc = spawn(CHAT_SHELL, ["-ic", cmd], {
      cwd,
      env,
      stdio: ["pipe", "ignore", "pipe", "pipe"],
    });
    // fd 3 is pi's stdout; fd 1 (shell/rc noise) was discarded, fd 2 is stderr.
    out = proc.stdio[3] as NodeJS.ReadableStream;
  } else {
    proc = spawn(PI_BIN, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    out = proc.stdout as NodeJS.ReadableStream;
  }

  const sess: ChatSession = { id, cwd, model, proc, buffer: "", stderrBuf: "", run: null, lastUsed: Date.now(), dead: false, prompted: false, thinkingLevel: null, resumedFile: null, resumeCallback: null, stopRequested: false, fresh, librarySent: false, runState: null, lastRun: null };

  out.on("data", (d: Buffer) => {
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
    if (sess.run) runEmit(sess.run, { type: "stderr", text: d.toString() });
  });
  proc.on("error", () => {
    sess.dead = true;
    // A failed spawn (e.g. ENOENT) can emit "error" without ever emitting
    // "close", leaving the entry in the sessions Map until the 10-min idle
    // reaper. Drop an idle entry now; an in-flight run still gets its "close"
    // teardown (and its recorded outcome) below.
    if (!sess.run) sessions.delete(id);
  });
  proc.on("close", () => {
    sess.dead = true;
    // A process that dies mid-run is a failed run, recorded even if the browser
    // that started it is gone (the office's queue settles the task on it).
    if (sess.runState === "running") {
      sess.runState = null;
      sess.lastRun = { outcome: "error", at: Date.now() };
    }
    endRun(sess, { type: "done", sessionId: id, model, error: extractPiError(sess.stderrBuf) || "process closed" });
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
export function startChat(opts: { cwd: string; model?: string; thinkingLevel?: string; prompt: string; sessionId?: string; sessionFile?: string; streamingBehavior?: string; libraryBlock?: string } & ChatSpawnExtras): Response {
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
    // Skills/tools/extensions are spawn-time flags, so they only apply to the
    // subprocess started here: they are ignored for an already-running session
    // (whose argv is fixed) rather than silently appearing to work.
    sess = spawnChat(sid, cwd, model, false, {
      skills: opts.skills,
      tools: opts.tools,
      extensions: opts.extensions,
    });
    sessions.set(sid, sess);
  }
  sess.lastUsed = Date.now();
  sess.prompted = true;
  if (sess.run) {
    // A prompt is already streaming to this session. With a steer/follow-up
    // behavior we queue the message to pi (it streams back over the existing
    // run); without one we reject, preserving the one-at-a-time rule. This also
    // holds while NO reader is attached (every browser reloaded): pi is still
    // working, and a second prompt would interleave into the running turn.
    if (opts.streamingBehavior === "steer" || opts.streamingBehavior === "followUp") {
      try {
        sess.proc.stdin.write(JSON.stringify({ type: "prompt", message: prompt, streamingBehavior: opts.streamingBehavior }) + "\n");
      } catch (err: any) {
        console.error("Failed to queue prompt to chat subprocess", err);
        return new Response(JSON.stringify({ error: "failed to queue prompt" }), { status: 500, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true, queued: true, streamingBehavior: opts.streamingBehavior }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: "a prompt is already running" }), { status: 409, headers: { "content-type": "application/json" } });
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // The run exists as soon as the prompt is accepted: it owns this reader
      // (and any later attach) plus the replay buffer of everything emitted.
      const run: ChatRun = {
        subs: new Set([controller]),
        log: [],
        bytes: 0,
        prompt,
        startedAt: Date.now(),
        openUi: new Map(),
        promptRetries: 0,
        resend: null,
      };
      sess!.run = run;
      // A prompt is now in flight: record it so a page that abandons this stream
      // (reload) can still learn how the run ended (see chatRunStatus) and
      // re-attach to it (see attachChatRun).
      sess!.runState = "running";
      sess!.lastRun = null;
      // Announce the real subprocess session id first. The browser may not have
      // one yet (no pre-spawn, or a request without a sessionId), but answers to
      // extension dialogs (POST /chat/ui) must target the actual session.
      runEmit(run, { type: "session", sessionId: sid, model });
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
            runEmit(run, { type: "error", message: err.message || String(err) });
          }
        }
        if (level) {
          try {
            sess!.proc.stdin.write(JSON.stringify({ type: "set_thinking_level", level }) + "\n");
            sess!.thinkingLevel = level;
          } catch (err: any) {
            runEmit(run, { type: "error", message: err.message || String(err) });
          }
        }
      };
      writePrefCommands(false);
      // The workspace's reference library is a preamble for a NEW conversation
      // only: a resumed session already received it, a second turn must not
      // repeat it, and a subprocess told to start a fresh session gets it again.
      const promptForSend = () => {
        const block = (opts.libraryBlock || "").trim();
        if (!block || sessionFile || sess!.librarySent) return prompt;
        sess!.librarySent = true;
        return `${block}\n\n${prompt}`;
      };
      // A write into a dead subprocess ends the run immediately (pi never got
      // the prompt, so no agent_settled will ever arrive).
      const failRun = (err: any) => {
        sess!.runState = null;
        sess!.lastRun = { outcome: "error", at: Date.now() };
        endRun(sess!, { type: "error", message: err.message || String(err) }, { type: "done", sessionId: sid, model });
      };
      const sendPrompt = () => {
        try {
          sess!.proc.stdin.write(JSON.stringify({ type: "prompt", message: promptForSend() }) + "\n");
        } catch (err: any) {
          failRun(err);
        }
      };
      // `handleLine` runs outside this closure, so it reaches the prompt writer
      // through the run: that is how a preflight refusal is retried.
      run.resend = sendPrompt;
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
          failRun(err);
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
        sess!.librarySent = false; // a new conversation gets the library again
        queueResume({ type: "new_session" });
      } else {
        sendPrompt();
      }
    },
    // The browser went away (a reload abandons the fetch). The run is NOT
    // cancelled: pi keeps working, the events keep accumulating in the replay
    // log, and the run stays attached to the session so a returning page can
    // attach to it (GET /chat/attach) and pick up where this reader stopped.
    cancel() {
      const run = sess?.run;
      if (run) run.subs.delete(controller);
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
    if (sess.run || sess.prompted) continue; // in-flight or already conversed
    if (sess.cwd !== opts.cwd || sess.model !== model) {
      try { sess.proc.kill(); } catch { /* already dead */ }
      sessions.delete(id);
    }
  }
  for (const sess of sessions.values()) {
    if (!sess.fresh) continue;
    if (sess.cwd === opts.cwd && sess.model === model && !sess.dead && sess.proc.exitCode === null && !sess.run) {
      sess.lastUsed = Date.now();
      return { sessionId: sess.id, reused: true };
    }
  }
  const sid = crypto.randomUUID();
  sessions.set(sid, spawnChat(sid, opts.cwd, model, true));
  return { sessionId: sid, reused: false };
}

/** What a chat session's run is doing right now, and how its last run ended.
 *  `active` stays true across a client disconnect (the response stream is
 *  abandoned but pi keeps working), so a task dispatcher that outlived its page
 *  can tell a live run from a genuinely orphaned one. */
export function chatRunStatus(id: string): { present: boolean; active: boolean; outcome: "done" | "error" | "aborted" | null } {
  const sess = sessions.get(id);
  if (!sess) return { present: false, active: false, outcome: null };
  return { present: true, active: sess.runState === "running" && !sess.dead, outcome: sess.lastRun?.outcome ?? null };
}

/** Everything a page needs to pick a live run back up after it lost its stream
 *  (a reload or a view switch that reloads Chat) or never had one (a second
 *  tab): which chat sessions exist on the server, where they run, whether a
 *  prompt is in flight, and what that prompt was.
 *
 *  A run whose reader went away is reported `active` — pi keeps working — which
 *  is exactly the state the Chat view must recover: the "working" badge, the
 *  animated run pill and the Stop button all derive from it. */
export interface ChatLiveRun {
  sessionId: string;
  cwd: string;
  model: string;
  active: boolean;
  fresh: boolean; // a workspace's own "new conversation" subprocess
  prompted: boolean; // has ever been prompted (vs an idle pre-spawn)
  resumedFile: string | null; // pi session file it is currently on
  startedAt: number | null; // start of the in-flight run (null when idle)
  prompt: string; // the prompt of the in-flight run ("" when idle)
}

export function chatLiveRuns(): ChatLiveRun[] {
  const out: ChatLiveRun[] = [];
  for (const [id, sess] of sessions) {
    if (sess.dead || sess.proc.exitCode !== null) continue;
    const run = sess.run;
    out.push({
      sessionId: id,
      cwd: sess.cwd,
      model: sess.model,
      active: !!run && sess.runState === "running",
      fresh: sess.fresh,
      prompted: sess.prompted,
      resumedFile: sess.resumedFile,
      startedAt: run ? run.startedAt : null,
      prompt: run ? run.prompt : "",
    });
  }
  return out;
}

/** Attach a NEW reader to a run that is already in flight, replaying everything
 *  emitted so far (bounded — see RUN_LOG_MAX_*) and then streaming live. Returns
 *  null when the session has no live run, so the caller can answer "the run
 *  already finished" instead of leaving a page waiting on a stream that will
 *  never produce anything.
 *
 *  Answered extension dialogs are NOT replayed (their id can no longer be
 *  answered); the still-open ones are re-emitted as `ui_open` so the page can
 *  render and answer the question pi is blocked on. */
export function attachChatRun(id: string): Response | null {
  const sess = sessions.get(id);
  const run = sess?.run;
  if (!sess || !run || sess.dead || sess.proc.exitCode !== null) return null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const entry of run.log) {
        // Extension dialogs are replayed separately (below): a request that was
        // already answered must not come back as an answerable card, and the
        // ones still open are re-sent as `ui_open`.
        if (entry.obj.type === "ui_select" || entry.obj.type === "ui_input") continue;
        enqueue(controller, entry.obj);
      }
      for (const dlg of run.openUi.values()) enqueue(controller, { type: "ui_open", dlg });
      run.subs.add(controller);
    },
    cancel() {
      run.subs.delete(controller);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no" },
  });
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
  // The question is resolved — a page that attaches later must not be shown a
  // card for it again (see attachChatRun's open-dialog replay).
  sess.run?.openUi.delete(uiId);
  return true;
}

/** Abort the agent's current run in a chat session (and drop any queued
 *  steer/follow-up messages) so the user can stop it without killing the
 *  subprocess and losing the conversation context. pi emits agent_settled after
 *  the abort, which closes the in-flight stream with `aborted: true`. */
export function stopChat(id: string): boolean {
  const sess = sessions.get(id);
  if (!sess) return false;
  const wasActive = !!sess.run;
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

// ANSI escape sequences (SGR colours, cursor moves) that a print-mode pi run
// may emit alongside its text answer.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * One-shot, non-interactive pi run (`--print`) that drafts a commit message from
 * a prepared prompt.
 *
 * Used by Git → “✨ generate”. It deliberately reuses `chatChildEnv` so the call
 * runs with the same API keys / PATH / venv the Chat view gets — a commit
 * message must not fail because the server was launched from a GUI session that
 * never sourced the user's shell rc. `--no-session` keeps this housekeeping run
 * out of pi's session store.
 *
 * Resolves to the trimmed plain-text answer; throws when pi fails with no
 * output at all (the caller surfaces the message).
 *
 * pi emits benign startup warnings (e.g. `Warning: No models match pattern …`
 * for stale settings patterns) on stderr for every run, so those are filtered
 * out of the error — previously they were reported verbatim as the failure,
 * which is why a slow/killed run surfaced as "could not generate…: Warning: …"
 * with no hint that nothing was actually produced. A run that is still silent
 * at the deadline is killed and reported as a timeout; the window defaults to
 * 3 minutes (was 1) because the first `pi` of a session can spend a while
 * refreshing its model catalog before it emits anything.
 */
export async function generateCommitMessage(opts: {
  cwd: string;
  model: string;
  prompt: string;
  timeoutMs?: number;
}): Promise<string> {
  const { cwd, model, prompt } = opts;
  const args = ["--print", "--no-session", "--model", model, prompt];
  const proc = spawn(PI_BIN, args, { cwd, env: chatChildEnv(cwd), stdio: ["ignore", "pipe", "pipe"] });

  let out = "";
  let err = "";
  proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
  proc.stderr?.on("data", (d: Buffer) => { err += d.toString(); });

  // Overridable so a slow model/provider can be given more room without a code
  // change (SCOPE_COMMIT_TIMEOUT_MS), e.g. on a heavily loaded machine.
  const envTimeout = Number(process.env.SCOPE_COMMIT_TIMEOUT_MS);
  const timeoutMs =
    opts.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 180_000);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill("SIGKILL"); } catch { /* already gone */ }
  }, timeoutMs);
  const code = await new Promise<number>((resolve) => {
    let done = false;
    const finish = (c: number) => { if (!done) { done = true; resolve(c); } };
    // `close` fires once every stdio pipe is closed. A killed pi may have left
    // child processes (extensions) holding those pipes, so after a timeout we
    // fall back to process `exit` plus a short grace instead of hanging.
    proc.on("close", (c) => finish(c ?? -1));
    proc.on("exit", (c) => { if (timedOut) setTimeout(() => finish(c ?? -1), 1500); });
  });
  clearTimeout(timer);

  const text = out.replace(ANSI_RE, "").trim();
  if (text) return text;
  if (timedOut) throw new Error(`pi produced no message within ${Math.round(timeoutMs / 1000)}s — the model may be slow or unreachable`);
  // Keep only the meaningful stderr lines; drop pi's per-run startup warnings.
  const detail = err
    .split(/\r?\n/)
    .map((l) => l.replace(ANSI_RE, "").trim())
    .filter((l) => l && !/^warning:/i.test(l))
    .slice(-3)
    .join(" ");
  throw new Error(detail || `pi exited with code ${code} and no message`);
}

/** Kill every chat subprocess (called on server shutdown). */
export function shutdownChatSessions(): void {
  for (const [, sess] of sessions) {
    try { sess.proc.kill(); } catch { /* ignore */ }
  }
  sessions.clear();
}
