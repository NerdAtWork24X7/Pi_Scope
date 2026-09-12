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

/** Shell rc files an interactive terminal sources, in the order we check them.
 *  A GUI/desktop-launched server never reads these, so env vars exported only
 *  there are invisible to chat-spawned subprocesses — chatChildEnv mirrors the
 *  few the pi web tools depend on. */
function shellRcFiles(): string[] {
  const home = os.homedir();
  return [".zshenv", ".zshrc", ".bash_profile", ".bashrc", ".profile"]
    .map((f) => path.join(home, f))
    .filter((p) => fs.existsSync(p));
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
  const expand = (v: string) =>
    v.replace(/^~(?=\/|$)/, home).replace(/\$\{HOME\}|\$HOME/g, home);
  for (const rc of shellRcFiles()) {
    let content: string;
    try { content = fs.readFileSync(rc, "utf8"); } catch { continue; }
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      const m = line.match(/^(?:export\s+)?PLAYWRIGHT_BROWSERS_PATH\s*=\s*(.+)$/);
      if (!m) continue;
      const val = m[1].trim().replace(/^(['"])(.*)\1$/, "$2").trim();
      if (!val) continue;
      const dir = expand(val);
      if (looksLikePlaywrightBrowsersDir(dir)) return dir;
    }
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
 *     `SCOPE_EXTRA_PATH=~/.pyenv/versions/3.12/bin apps/scope-launcher/run.sh`.
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
  if (PI_BIN.includes("/")) prepend(path.dirname(PI_BIN));
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

/** Single-quote a value for `sh -c` (bash/zsh): safe for spaces, quotes, and
 *  shell metacharacters in paths/assets. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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
    if (candidate.includes("/")) {
      try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { continue; }
    }
    const dirs = [...(process.env.PATH || "").split(":").filter(Boolean), "/bin", "/usr/bin"];
    for (const dir of dirs) {
      const p = path.join(dir, candidate);
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next dir */ }
    }
  }
  return null;
}
const CHAT_SHELL = resolveInteractiveShell();
console.log(`  Chat: pi spawn shell: ${CHAT_SHELL ?? "(direct)"}`);

/** Directories chatChildEnv adds to PATH, as a delimiter-joined prefix. Re-applied
 *  inside the shell because an rc file that reassigns PATH (rather than
 *  prepending to it) would otherwise drop the venv / node / pi-bin dirs. */
function chatPathPrefix(cwd: string): string {
  const child = String(chatChildEnv(cwd).PATH || "").split(path.delimiter).filter(Boolean);
  const inherited = new Set(String(process.env.PATH || "").split(path.delimiter).filter(Boolean));
  return child.filter((dir) => !inherited.has(dir)).join(path.delimiter);
}

function spawnChat(id: string, cwd: string, model: string, fresh = false): ChatSession {
  const args = ["--mode", "rpc", "--model", model];
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

  const sess: ChatSession = { id, cwd, model, proc, buffer: "", stderrBuf: "", active: null, lastUsed: Date.now(), dead: false, prompted: false, thinkingLevel: null, resumedFile: null, resumeCallback: null, stopRequested: false, fresh };

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
        console.error("Failed to queue prompt to chat subprocess", err);
        return new Response(JSON.stringify({ error: "failed to queue prompt" }), { status: 500, headers: { "content-type": "application/json" } });
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
