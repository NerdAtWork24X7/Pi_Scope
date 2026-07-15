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
function herdrSockPath(): string | null {
  if (process.env.HERDR_SOCKET_PATH && fs.existsSync(process.env.HERDR_SOCKET_PATH)) {
    return process.env.HERDR_SOCKET_PATH;
  }
  const p = path.join(os.homedir(), ".config/herdr/herdr.sock");
  return fs.existsSync(p) ? p : null;
}

function herdrFocusedCwd(): Promise<string | null> {
  return new Promise((resolve) => {
    const sockPath = herdrSockPath();
    if (!sockPath) return resolve(null);
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
    sock.on("error", () => finish(null));
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

  wss.on("connection", (ws: WebSocket) => {
    const shell = process.env.SHELL || "bash";
    const term = pty.spawn(shell, [], {
      name: "xterm-256color", cols: 80, rows: 24, cwd: cfg.launchCwd,
      env: { ...process.env, TERM: "xterm-256color" },
    });

    term.onData((data: string) => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
    term.onExit(() => { try { ws.close(); } catch {} });

    // Keep the shared session directory in sync with the live shell cwd.
    // Two sources compete:
    //   1. the in-browser shell's own cwd (the "normal" terminal) via /proc/<pid>/cwd
    //   2. Herdr's focused pane cwd (the user's real terminal) via its socket
    // When the in-browser PTY is running Herdr, mirror Herdr's focused pane so
    // the UI follows the user's actual terminal. Otherwise trust the in-browser
    // shell's cwd once it has navigated away from its launch dir. This keeps
    // the cwd consistent when switching between Terminal, Files and Checkpoints.
    let lastCwd = "";
    let cwdBusy = false;
    let shellNavigated = false;
    let lastHerdrDetected: boolean | null = null;
    const pushCwd = async () => {
      if (cwdBusy) return;
      cwdBusy = true;
      const shellCwd = getShellCwd(term.pid);
      const runningHerdr = hasHerdrDescendant(term.pid);
      if (shellCwd && shellCwd !== cfg.launchCwd) shellNavigated = true;
      let cwd: string | null = shellCwd;
      // Prefer Herdr's focused pane cwd when:
      //   1. the in-browser PTY is running Herdr (shell cwd is just the launch dir), or
      //   2. the in-browser shell hasn't navigated away from its launch dir yet,
      //      so its cwd is not a useful source of truth.
      if (runningHerdr || !shellNavigated) {
        const h = await herdrFocusedCwd();
        if (h) cwd = h;
      }
      cwdBusy = false;
      if (cwd && cwd !== lastCwd) {
        lastCwd = cwd;
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "cwd", cwd }));
        cfg.onCwdChange?.(ws, cwd);
      }
      if (runningHerdr !== lastHerdrDetected) {
        lastHerdrDetected = runningHerdr;
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "herdr", detected: runningHerdr }));
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
          if (ctrl.type === "cwdReq") {
            // Live read of the in-browser shell's real cwd — what the user is
            // actually inside — independent of the auto-detect display logic.
            const shellCwd = getShellCwd(term.pid);
            if (ws.readyState === WebSocket.OPEN)
              ws.send(JSON.stringify({ type: "cwdRes", cwd: shellCwd }));
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

