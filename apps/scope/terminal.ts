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

interface TerminalConfig { port: number; host: string; token: string; projectRoot: string; }

// ─── Herdr integration ────────────────────────────────────────────────────
// When Herdr (a terminal multiplexer) is the user's actual terminal, the
// in-browser shell's cwd stays frozen at its launch dir while the user
// navigates Herdr panes. Herdr exposes the focused pane's live cwd over its
// socket API (pane.current -> foreground_cwd), so we use that as the source
// of truth when a socket is reachable, falling back to /proc/<pid>/cwd.
const HERDR_SOCK =
  process.env.HERDR_SOCKET_PATH && fs.existsSync(process.env.HERDR_SOCKET_PATH)
    ? process.env.HERDR_SOCKET_PATH
    : (() => { const p = path.join(os.homedir(), ".config/herdr/herdr.sock"); return fs.existsSync(p) ? p : null; })();

function herdrFocusedCwd(): Promise<string | null> {
  return new Promise((resolve) => {
    if (!HERDR_SOCK) return resolve(null);
    const sock = net.connect(HERDR_SOCK);
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
      name: "xterm-256color", cols: 80, rows: 24, cwd: cfg.projectRoot,
      env: { ...process.env, TERM: "xterm-256color" },
    });

    term.onData((data: string) => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
    term.onExit(() => { try { ws.close(); } catch {} });

    // Keep the shared session directory in sync with the live shell cwd.
    // Two sources compete:
    //   1. the in-browser shell's own cwd (the "normal" terminal) via /proc/<pid>/cwd
    //   2. Herdr's focused pane cwd (the user's real terminal) via its socket
    // We trust the in-browser shell the moment the user navigates it (cd's away
    // from the launch dir); until then we assume the user is actually driving
    // Herdr and mirror its focused pane. This way BOTH a normal in-browser
    // session and a Herdr session keep the cwd display in sync.
    let lastCwd = "";
    let cwdBusy = false;
    let shellNavigated = false;
    const pushCwd = async () => {
      if (cwdBusy) return;
      cwdBusy = true;
      const shellCwd = getShellCwd(term.pid);
      if (shellCwd && shellCwd !== cfg.projectRoot) shellNavigated = true;
      let cwd: string | null = shellCwd;
      if (!shellNavigated) {
        // Shell still parked at launch dir -> user is likely in Herdr.
        const h = HERDR_SOCK ? await herdrFocusedCwd() : null;
        if (h) cwd = h;
      }
      cwdBusy = false;
      if (cwd && cwd !== lastCwd) {
        lastCwd = cwd;
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "cwd", cwd }));
      }
    };
    pushCwd();
    const cwdTimer = setInterval(pushCwd, 2000);

    ws.on("message", (msg: Buffer | ArrayBuffer | Buffer[]) => {
      const raw = typeof msg === "string" ? msg : Buffer.from(msg as Uint8Array).toString();
      if (raw.charCodeAt(0) === 0x7b /* '{' */) {
        try {
          const ctrl = JSON.parse(raw);
          if (ctrl.type === "resize" && Number.isInteger(ctrl.cols) && Number.isInteger(ctrl.rows)) {
            term.resize(Math.max(1, ctrl.cols), Math.max(1, ctrl.rows)); return;
          }
        } catch {}
      }
      term.write(raw);
    });
    ws.on("close", () => { try { clearInterval(cwdTimer); } catch {} try { term.kill(); } catch {} });
    ws.on("error", () => { try { clearInterval(cwdTimer); } catch {} try { term.kill(); } catch {} });
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

