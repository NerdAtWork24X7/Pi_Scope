/**
 * terminal.ts — WebSocket ↔ node-pty bridge for an in-browser terminal.
 *
 * Clients connect to ws://<host>/terminal?token=<token> with xterm.js.
 * Raw frames are keystrokes written to the PTY; JSON control frames:
 *   { type: "resize", cols, rows }  -> pty.resize
 */
import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import net from "node:net";
import { execFileSync } from "node:child_process";
import pty from "node-pty";
import { WebSocketServer, WebSocket } from "ws";

interface TerminalConfig {
  port: number;
  host: string;
  token: string;
  launchCwd: string;
  /** Called whenever the terminal's live cwd changes. */
  onCwdChange?: (ws: WebSocket, cwd: string) => void;
  /** Called when a terminal connection closes. */
  onClose?: (ws: WebSocket) => void;
}

// ─── Herdr integration ────────────────────────────────────────────────────
// When Herdr (a terminal multiplexer) is the user's actual terminal, the
// in-browser shell's cwd stays frozen at its launch dir while the user
// navigates Herdr panes. Herdr exposes the focused pane's live cwd over its
// socket API (pane.current -> foreground_cwd), so we use that as the source
// of truth when a socket is reachable, falling back to /proc/<pid>/cwd.
// Resolve the socket path dynamically so a late-starting Herdr is detected.

const CWD_DEBUG = !!(process.env.SCOPE_VERBOSE || process.env.SCOPE_CWD_DEBUG);
function logCwd(...args: unknown[]) {
  if (CWD_DEBUG) console.log("[cwd]", ...args);
}

function possibleHerdrSockPaths(): string[] {
  const paths: (string | undefined)[] = [
    process.env.HERDR_SOCKET_PATH,
    process.env.HERDR_SOCK,
  ];
  const home = os.homedir();
  const xdgConfig = process.env.XDG_CONFIG_HOME;
  const xdgRuntime = process.env.XDG_RUNTIME_DIR;
  paths.push(
    xdgConfig && path.join(xdgConfig, "herdr", "herdr.sock"),
    path.join(home, ".config", "herdr", "herdr.sock"),
    path.join(home, ".local", "share", "herdr", "herdr.sock"),
    xdgRuntime && path.join(xdgRuntime, "herdr", "herdr.sock"),
    xdgRuntime && path.join(xdgRuntime, "herdr.sock"),
  );
  return paths.filter((p): p is string => !!p && typeof p === "string");
}

let herdrSockCache: { path: string | null; at: number } | null = null;
const HERDR_SOCK_CACHE_TTL_MS = 3000;

function herdrSockPath(): string | null {
  const now = Date.now();
  if (herdrSockCache && now - herdrSockCache.at < HERDR_SOCK_CACHE_TTL_MS) {
    return herdrSockCache.path;
  }
  let found: string | null = null;
  for (const p of possibleHerdrSockPaths()) {
    try { if (fs.existsSync(p)) { found = p; break; } } catch {}
  }
  (herdrSockCache as { path: string | null; at: number } | null) = { path: found, at: now };
  return found;
}

function herdrFocusedCwd(): Promise<string | null> {
  return new Promise((resolve) => {
    const sockPath = herdrSockPath();
    if (!sockPath) {
      logCwd("herdr socket not found; searched:", possibleHerdrSockPaths());
      return resolve(null);
    }
    logCwd("connecting to herdr socket:", sockPath);
    const sock = net.connect(sockPath);
    let buf = "";
    let done = false;
    const to = setTimeout(() => finish(null), 1500);
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(to);
      try { sock.destroy(); } catch {}
      resolve(v);
    };
    sock.on("connect", () =>
      sock.write(JSON.stringify({ id: "cwd", method: "pane.current", params: {} }) + "\n"),
    );
    sock.on("data", (d) => {
      buf += d.toString();
      for (const line of buf.split("\n")) {
        if (!line.trim()) continue;
        try {
          const j = JSON.parse(line);
          if (j.result?.pane) return finish(j.result.pane.foreground_cwd || j.result.pane.cwd || null);
          if (j.error) return finish(null);
        } catch {}
      }
    });
    sock.on("error", (err) => {
      logCwd("herdr socket error:", (err as Error).message);
      finish(null);
    });
  });
}

export function attachTerminal(server: Server, cfg: TerminalConfig): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== "/terminal") { socket.destroy(); return; }
    if (url.searchParams.get("token") !== cfg.token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const reqUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const shellParam = reqUrl.searchParams.get("shell");
    const selectedShell = shellParam === "herdr" ? "herdr" : "bash";
    const shellName = shellParam === "herdr" ? "herdr" : (process.env.SHELL || "bash");
    const shell = resolveShellPath(shellName);
    if (CWD_DEBUG) console.log("[terminal] spawning shell:", shellName, "->", shell);
    let term: ReturnType<typeof pty.spawn>;
    try {
      term = pty.spawn(shell, [], {
        name: "xterm-256color", cols: 80, rows: 24, cwd: cfg.launchCwd,
        env: { ...process.env, TERM: "xterm-256color" },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[terminal] failed to spawn shell:", shellName, message);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "error", message: `Failed to spawn ${shellName}: ${message}` }));
      }
      try { ws.close(); } catch {}
      return;
    }

    term.onData((data: string) => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
    term.onExit(() => { try { ws.close(); } catch {} });

    // Keep the shared session directory in sync with the live shell cwd.
    // The CWD source depends on which shell the user selected:
    //   - Bash (or any non-Herdr shell): use the in-browser PTY's cwd via /proc/<pid>/cwd.
    //   - Herdr: use Herdr's focused pane cwd via its socket, falling back to
    //     the in-browser shell's cwd if the socket is unreachable.
    // This keeps the cwd consistent when switching between Terminal, Files and Checkpoints.
    let lastCwd = "";
    let cwdBusy = false;
    let lastHerdrDetected: boolean | null = null;
    const pushCwd = async () => {
      if (cwdBusy) return;
      cwdBusy = true;
      const shellCwd = getShellCwd(term.pid);
      logCwd("pushCwd shellCwd=", shellCwd, "launchCwd=", cfg.launchCwd, "selectedShell=", selectedShell);
      let cwd: string | null = null;
      if (selectedShell === "herdr") {
        // Prefer Herdr's focused pane cwd when a socket is reachable.
        // Process-tree detection is unreliable in packaged/AppImage builds because
        // herdr may run as a separate server. Trust the socket when it responds;
        // fall back to the in-browser shell's cwd.
        cwd = await herdrFocusedCwd();
        if (!cwd) cwd = shellCwd;
      } else {
        // For Bash (or any non-Herdr selection), trust the in-browser shell's cwd.
        cwd = shellCwd;
      }
      cwdBusy = false;
      if (cwd && cwd !== lastCwd) {
        lastCwd = cwd;
        logCwd("sending cwd update:", cwd);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "cwd", cwd }));
        cfg.onCwdChange?.(ws, cwd);
      }
      // Only report Herdr detection when Herdr is the selected shell.
      if (selectedShell === "herdr") {
        const runningHerdr = hasHerdrDescendant(term.pid);
        if (runningHerdr !== lastHerdrDetected) {
          lastHerdrDetected = runningHerdr;
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "herdr", detected: runningHerdr }));
        }
      }
    };
    pushCwd();
    const cwdTimer = setInterval(pushCwd, 2000);

    ws.on("message", async (msg: Buffer | ArrayBuffer | Buffer[]) => {
      const raw = typeof msg === "string" ? msg : Buffer.from(msg as Uint8Array).toString();
      if (raw.charCodeAt(0) === 0x7b /* '{' */) {
        try {
          const ctrl = JSON.parse(raw);
          if (ctrl.type === "resize" && Number.isInteger(ctrl.cols) && Number.isInteger(ctrl.rows)) {
            term.resize(Math.max(1, ctrl.cols), Math.max(1, ctrl.rows)); return;
          }
          if (ctrl.type === "terminalFocus" && typeof ctrl.focused === "boolean") {
            // Focus changed (e.g. user switched to/from the Terminal pane);
            // push an updated cwd immediately.
            pushCwd();
            return;
          }
        } catch {}
      }
      term.write(raw);
    });
    ws.on("close", () => { try { clearInterval(cwdTimer); } catch {} try { term.kill(); } catch {} cfg.onClose?.(ws); });
    ws.on("error", () => { try { clearInterval(cwdTimer); } catch {} try { term.kill(); } catch {} cfg.onClose?.(ws); });
  });
}

// Resolve an executable name to a full path so node-pty doesn't fail with
// "execvp(3) failed.: No such file or directory" when the server process has
// a limited PATH (e.g. launched from a desktop session).
function resolveShellPath(name: string): string {
  if (path.isAbsolute(name)) return name;
  const dirs = new Set<string>([
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/opt/homebrew/bin",
    path.join(os.homedir(), ".local", "bin"),
  ]);
  if (process.env.PATH) {
    for (const dir of process.env.PATH.split(path.delimiter)) {
      if (dir) dirs.add(dir);
    }
  }
  for (const dir of dirs) {
    const full = path.join(dir, name);
    try {
      if (fs.existsSync(full) && fs.statSync(full).isFile()) {
        try { fs.accessSync(full, fs.constants.X_OK); return full; } catch {}
      }
    } catch {}
  }
  try {
    const out = execFileSync("which", [name], { encoding: "utf8" }).trim();
    if (out) return out;
  } catch {}
  return name;
}

// Resolve the PTY shell's current working directory so the UI can keep the
// shared session directory in sync with wherever the terminal actually is.
function getShellCwd(pid: number): string | null {
  try {
    if (process.platform === "linux") return fs.realpathSync(`/proc/${pid}/cwd`);
    if (process.platform === "darwin") {
      const out = execFileSync("lsof", ["-p", String(pid), "-d", "cwd", "-Fn"], {
        encoding: "utf8",
      });
      const line = out.split("\n").find((l) => l.startsWith("n"));
      return line ? line.slice(1) : null;
    }
  } catch {}
  return null;
}

const herdrDescendantCache = new Map<number, { result: boolean; at: number }>();
const HERDR_CACHE_TTL_MS = 3000;
const HERDR_CACHE_MAX_SIZE = 50;

function cleanupHerdrDescendantCache(now: number): void {
  for (const [pid, entry] of herdrDescendantCache) {
    if (now - entry.at >= HERDR_CACHE_TTL_MS) herdrDescendantCache.delete(pid);
  }
}

function isHerdrExecutable(name: string): boolean {
  const base = path.basename(name).toLowerCase();
  return base === "herdr" || base.startsWith("herdr");
}

// Detect whether the PTY process (or any of its descendants) is Herdr.
// When the in-browser terminal is running Herdr directly, /proc/<pid>/cwd is
// the launch directory and is not useful; we must mirror Herdr's focused pane
// cwd instead. Herdr may be a child/grandchild of the shell, so we walk the
// process tree rather than only checking the PTY process itself.
function hasHerdrDescendant(pid: number): boolean {
  const now = Date.now();
  const cached = herdrDescendantCache.get(pid);
  if (cached && now - cached.at < HERDR_CACHE_TTL_MS) return cached.result;
  // Prevent unbounded growth from reused PIDs or many short-lived shells.
  if (herdrDescendantCache.size >= HERDR_CACHE_MAX_SIZE) cleanupHerdrDescendantCache(now);
  const result = hasHerdrDescendantInner(pid, new Set());
  herdrDescendantCache.set(pid, { result, at: now });
  return result;
}

function hasHerdrDescendantInner(pid: number, seen: Set<number>): boolean {
  if (seen.has(pid)) return false;
  seen.add(pid);
  try {
    if (process.platform === "linux") {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      // cmdline is null-separated; the first element is the executable path.
      const exe = cmdline.split("\0")[0];
      if (isHerdrExecutable(exe)) return true;
      const children = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
      for (const child of children) {
        const childPid = parseInt(child, 10);
        if (!Number.isNaN(childPid) && hasHerdrDescendantInner(childPid, seen)) return true;
      }
      return false;
    }
    if (process.platform === "darwin") {
      const out = execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" });
      if (isHerdrExecutable(out.trim())) return true;
      // Get direct children via pgrep.
      try {
        const children = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
        for (const child of children) {
          const childPid = parseInt(child, 10);
          if (!Number.isNaN(childPid) && hasHerdrDescendantInner(childPid, seen)) return true;
        }
      } catch {}
      return false;
    }
  } catch {}
  return false;
}

