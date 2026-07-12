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
import { execFileSync } from "node:child_process";
import pty from "node-pty";
import { WebSocketServer, WebSocket } from "ws";

interface TerminalConfig { port: number; host: string; token: string; projectRoot: string; }

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
    let lastCwd = "";
    const pushCwd = () => {
      const cwd = getShellCwd(term.pid);
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

