/**
 * acp-client.ts — a small Agent Client Protocol client for the harnesses that
 * speak it (Gemini CLI, opencode, Kilo Code, Cline).
 *
 * Instead of one-shot `-p` invocations, an ACP harness is a live session: this
 * module starts the CLI's ACP server, creates a session in the workspace, and
 * then streams each turn's updates (`agent_message_chunk`, `tool_call`, …). That
 * is what makes the harness's own slash commands, permission requests and
 * multi-turn context work — a print-mode run has none of those.
 *
 * Only the parts the app renders are implemented, and everything the agent asks
 * the CLIENT to do on its own (read/write files, run a terminal command) is
 * refused: the harness runs its tools itself, so a client-side fs/terminal call
 * would be a second, unreported execution path.
 */
import type { ChildProcess } from "node:child_process";
import { killTree, spawnCli } from "../../shared/shell.ts";

/** One choice an agent offers for a permission request. */
export interface AcpPermissionOption {
  id: string;
  label: string;
  kind?: string;
}

/** A request the agent is blocked on until the user answers. */
export interface AcpPermissionRequest {
  /** Dialog id the chat client posts back (`/chat/ui`). */
  id: string;
  title: string;
  options: AcpPermissionOption[];
}

export interface AcpHandlers {
  onText(delta: string): void;
  onThought?(delta: string): void;
  onToolStart?(name: string, args: string): void;
  onToolEnd?(name: string): void;
  onPermission?(request: AcpPermissionRequest): void;
  /** A session-scoped notice worth showing (auth, unsupported command, …). */
  onNotice?(message: string, kind: "info" | "warning" | "error"): void;
}

export interface AcpSessionOptions {
  file: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  handlers: AcpHandlers;
  /** `opus`… the harness's own model id; applied with `session/set_model`. */
  model?: string;
  /** Overall budget for the handshake (initialize + session/new). */
  startTimeoutMs?: number;
  /** Resume an existing session (`session/load`) instead of creating one. The
   *  agent must advertise `loadSession`; a failure falls back to a new session. */
  resumeSessionId?: string;
}

interface PendingPermission {
  requestId: number;
  options: AcpPermissionOption[];
}

const START_TIMEOUT_MS = 30_000;
const MAX_LINE = 4_000_000;

/** The JSON-RPC id a permission dialog carries; matching id → request. */
export function permissionDialogId(requestId: string | number): string {
  return `acp-${String(requestId)}`;
}

export class AcpSession {
  private readonly file: string;
  private readonly args: string[];
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  /** Swapped per turn: a session is reused across prompts, and the run that
   *  receives its updates is a different object each time. */
  private handlers: AcpHandlers;
  private readonly model: string;
  private readonly startTimeoutMs: number;
  private readonly resumeSessionId: string;
  /** Modes the agent advertised at session creation (`session/set_mode` takes
   *  one of these ids). Empty when the harness has no modes. */
  private modes: Array<{ id: string; name: string; description?: string }> = [];
  private currentMode = "";
  /** The version the agent settled on in `initialize`. A v1 agent has no
   *  capability map to inspect, so resuming keeps the old `session/load` try. */
  private protocolVersion = 1;
  /** What the agent advertised in `initialize` (ACP v2 uses this to choose
   *  between `session/load` and `session/resume`). */
  private agentCapabilities: Record<string, any> = {};
  /** Whether this process attached to the saved conversation rather than
   *  creating a new one. */
  private resumed = false;

  private child: ChildProcess | null = null;
  private buffer = "";
  private nextId = 1;
  private closed = false;
  private stderrText = "";
  private sid = "";
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  /** Open permission dialogs, by JSON-RPC id. */
  private permissions = new Map<number, PendingPermission>();

  constructor(opts: AcpSessionOptions) {
    this.file = opts.file;
    this.args = opts.args;
    this.cwd = opts.cwd;
    this.env = opts.env || { ...process.env };
    this.handlers = opts.handlers;
    this.model = String(opts.model || "").trim();
    this.startTimeoutMs = opts.startTimeoutMs ?? START_TIMEOUT_MS;
    this.resumeSessionId = String(opts.resumeSessionId || "").trim();
  }

  /** Point this session's updates at the run that is streaming now. */
  setHandlers(handlers: AcpHandlers): void {
    this.handlers = handlers;
  }

  get sessionId(): string { return this.sid; }
  /** The ACP protocol version negotiated with the agent. */
  get acpProtocolVersion(): number { return this.protocolVersion; }
  /** True when `start()` loaded/resumed the saved conversation. */
  get resumedSession(): boolean { return this.resumed; }
  get availableModes(): Array<{ id: string; name: string; description?: string }> {
    return this.modes.map((m) => ({ ...m }));
  }
  get mode(): string { return this.currentMode; }
  get pid(): number | null {
    const pid = Number(this.child?.pid);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }
  get alive(): boolean { return !!this.child && !this.closed && this.child.exitCode === null; }

  /** Start the CLI and create a session in `cwd`. Idempotent. */
  async start(): Promise<string> {
    if (this.sid) return this.sid;
    const child = spawnCli(this.file, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdin?.on("error", () => { /* the CLI exited mid-turn */ });
    child.stdout?.on("data", (chunk: Buffer) => this.read(chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrText = (this.stderrText + chunk.toString()).slice(-4000);
    });
    child.on("close", (code, signal) => {
      this.failAll(new Error(this.cliError("exited")));
    });
    child.on("error", (err: any) => this.failAll(new Error(this.cliError(String(err?.message ?? err)))));

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(this.cliError("did not start in time"))), this.startTimeoutMs);
      // Never keep the process alive just for the deadline.
      (timer as any)?.unref?.();
    });
    const handshake = (async () => {
      // ACP 2 is the current protocol (the same version t3code negotiates):
      // a v1-only agent answers with `protocolVersion: 1`, and `session/load`
      // stays the way to resume. A v2 agent tells us through its capabilities
      // which resume method it actually implements.
      const initialized = await this.request("initialize", {
        protocolVersion: 2,
        clientInfo: { name: "Pi Scope", version: "1.0.0" },
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      });
      this.protocolVersion = Number(initialized?.protocolVersion) || 1;
      this.agentCapabilities = initialized?.agentCapabilities && typeof initialized.agentCapabilities === "object"
        ? initialized.agentCapabilities
        : {};
      // Resume first: the session carries the conversation and its context, so a
      // server restart continues instead of starting over. An agent that cannot
      // load (older build, expired id) falls back to a fresh session.
      let created: any = null;
      if (this.resumeSessionId) {
        const caps = this.agentCapabilities;
        const canLoad = this.protocolVersion < 2 || caps.loadSession === true;
        const canResume = caps.sessionCapabilities?.resume != null;
        if (canLoad) {
          try {
            const loaded = await this.request("session/load", {
              sessionId: this.resumeSessionId,
              cwd: this.cwd,
              mcpServers: [],
            });
            // A load answer may carry the session's modes (Gemini does); keep them.
            created = { ...(loaded && typeof loaded === "object" ? loaded : {}), sessionId: this.resumeSessionId };
            this.resumed = true;
          } catch {
            created = null;
          }
        }
        if (!created && canResume) {
          try {
            const resumed = await this.request("session/resume", {
              sessionId: this.resumeSessionId,
              cwd: this.cwd,
              mcpServers: [],
            });
            created = { ...(resumed && typeof resumed === "object" ? resumed : {}), sessionId: this.resumeSessionId };
            this.resumed = true;
          } catch {
            created = null;
          }
        }
      }
      if (!created) created = await this.request("session/new", { cwd: this.cwd, mcpServers: [] });
      this.sid = String(created?.sessionId || "");
      if (!this.sid) throw new Error("the harness created no session");
      this.readModes(created);
      if (this.model) {
        // Best effort: agents that do not implement the unstable method answer
        // with an error, which must not fail the session.
        this.request("session/set_model", { sessionId: this.sid, modelId: this.model }).catch(() => {});
      }
      return this.sid;
    })();
    try {
      return await Promise.race([handshake, timeout]);
    } catch (error) {
      this.close();
      throw error;
    } finally {
      // A settled handshake must not leave a timer that rejects later (an
      // unhandled rejection would take the whole server down).
      if (timer) clearTimeout(timer);
    }
  }

  /** Send one prompt and resolve with the agent's stop reason when it settles. */
  async prompt(text: string): Promise<string> {
    if (!this.alive) throw new Error(this.cliError("is not running"));
    if (!this.sid) await this.start();
    const result = await this.request("session/prompt", {
      sessionId: this.sid,
      prompt: [{ type: "text", text: String(text ?? "") }],
    });
    return String(result?.stopReason || "end_turn");
  }

  /** Switch the model mid-session (no-op when the agent does not support it). */
  async setModel(modelId: string): Promise<boolean> {
    const id = String(modelId || "").trim();
    if (!id || !this.sid || !this.alive) return false;
    try {
      await this.request("session/set_model", { sessionId: this.sid, modelId: id });
      return true;
    } catch {
      return false;
    }
  }

  /** Switch the agent's mode (`session/set_mode`), e.g. Gemini's plan/yolo. */
  async setMode(modeId: string): Promise<boolean> {
    const id = String(modeId || "").trim();
    if (!id || !this.sid || !this.alive) return false;
    try {
      await this.request("session/set_mode", { sessionId: this.sid, modeId: id });
      this.currentMode = id;
      return true;
    } catch {
      return false;
    }
  }

  /** Ask the agent to stop the current turn (the session stays usable). */
  cancel(): void {
    if (!this.alive || !this.sid) return;
    this.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.sid } });
  }

  /**
   * Answer the permission dialog the chat client just showed.
   *
   * `value` is the option label the user picked (the chat's select dialog posts
   * the raw line back) or `""` when it was dismissed, which cancels the request.
   */
  answerPermission(dialogId: string, value: string, cancelled: boolean): boolean {
    const requestId = Number(String(dialogId || "").replace(/^acp-/, ""));
    const pendingPermission = this.permissions.get(requestId);
    if (!pendingPermission || !Number.isFinite(requestId)) return false;
    this.permissions.delete(requestId);
    const want = String(value || "").trim();
    const option = cancelled
      ? null
      : pendingPermission.options.find((o) => o.label === want)
        || pendingPermission.options.find((o) => want && o.label.startsWith(want))
        || (want ? pendingPermission.options.find((o) => o.id === want) : null);
    if (option) {
      this.send({
        jsonrpc: "2.0",
        id: requestId,
        result: { outcome: { outcome: "selected", optionId: option.id } },
      });
    } else {
      this.send({ jsonrpc: "2.0", id: requestId, result: { outcome: { outcome: "cancelled" } } });
    }
    return true;
  }

  /** Close any unanswered permission dialog (the run is ending). */
  cancelPermissions(): void {
    for (const [id] of this.permissions) {
      this.send({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
    }
    this.permissions.clear();
  }

  close(): void {
    this.closed = true;
    this.cancelPermissions();
    this.failAll(new Error("the session was closed"));
    const child = this.child;
    this.child = null;
    if (child) {
      try { killTree(child, "SIGTERM"); } catch { /* already gone */ }
    }
  }

  // ─── JSON-RPC plumbing ────────────────────────────────────────────────────

  private send(value: unknown): void {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) return;
    try {
      stdin.write(JSON.stringify(value) + "\n");
    } catch { /* the CLI exited between the check and the write */ }
  }

  private request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error: any) {
        this.pending.delete(id);
        reject(new Error(String(error?.message ?? error)));
      }
    });
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE) this.buffer = this.buffer.slice(-MAX_LINE);
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (!line) continue;
      let frame: any;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      this.dispatch(frame);
    }
  }

  private dispatch(frame: any): void {
    if (!frame || typeof frame !== "object") return;
    // A response to one of our requests.
    if (frame.id !== undefined && frame.method === undefined) {
      const waiter = this.pending.get(frame.id);
      if (!waiter) return;
      this.pending.delete(frame.id);
      if (frame.error) waiter.reject(new Error(String(frame.error.message || "request failed")));
      else waiter.resolve(frame.result);
      return;
    }
    // A request from the agent (permission, fs, terminal).
    if (frame.id !== undefined && typeof frame.method === "string") {
      this.handleRequest(frame);
      return;
    }
    if (frame.method === "session/update") {
      this.handleUpdate(frame.params?.update);
    }
  }

  private handleRequest(frame: any): void {
    if (frame.method === "session/request_permission") {
      const params = frame.params || {};
      const options: AcpPermissionOption[] = (Array.isArray(params.options) ? params.options : [])
        .map((o: any) => ({
          id: String(o?.optionId ?? o?.id ?? ""),
          label: String(o?.name ?? o?.label ?? o?.optionId ?? ""),
          kind: o?.kind ? String(o.kind) : undefined,
        }))
        .filter((o: AcpPermissionOption) => o.id && o.label);
      const title = permissionTitle(params.toolCall);
      this.permissions.set(frame.id, { requestId: frame.id, options });
      this.handlers.onPermission?.({
        id: permissionDialogId(frame.id),
        title,
        options: options.map((o) => ({ ...o })),
      });
      return;
    }
    // Client-side fs/terminal calls: refuse. The agent runs its own tools.
    this.send({
      jsonrpc: "2.0",
      id: frame.id,
      error: { code: -32601, message: `this client does not implement ${frame.method}` },
    });
  }

  private handleUpdate(update: any): void {
    if (!update || typeof update !== "object") return;
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        if (update.content?.type === "text" && update.content.text) this.handlers.onText(String(update.content.text));
        return;
      }
      case "agent_thought_chunk": {
        if (update.content?.type === "text" && update.content.text) this.handlers.onThought?.(String(update.content.text));
        return;
      }
      case "tool_call": {
        const name = String(update.title || update.kind || update.toolCallId || "tool");
        const args = update.rawInput === undefined ? "" : safeJson(update.rawInput);
        this.handlers.onToolStart?.(name, args);
        return;
      }
      case "current_mode_update": {
        if (update.currentModeId) this.currentMode = String(update.currentModeId);
        return;
      }
      case "tool_call_update": {
        const status = String(update.status || "");
        if (status === "completed" || status === "failed") {
          this.handlers.onToolEnd?.(String(update.title || update.toolCallId || "tool"));
        }
        return;
      }
      default:
        return;
    }
  }

  /** Record the modes a session advertises (session/new or session/load). */
  private readModes(created: any): void {
    const available = created?.modes?.availableModes;
    if (Array.isArray(available)) {
      this.modes = available
        .map((m: any) => ({
          id: String(m?.id || ""),
          name: String(m?.name || m?.id || ""),
          ...(m?.description ? { description: String(m.description) } : {}),
        }))
        .filter((m: any) => m.id);
    }
    if (created?.modes?.currentModeId) this.currentMode = String(created.modes.currentModeId);
  }

  private failAll(error: Error): void {
    for (const [, waiter] of this.pending) waiter.reject(error);
    this.pending.clear();
  }

  private cliError(what: string): string {
    const detail = this.stderrText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-2)
      .join(" ");
    return `${this.file} ${what}${detail ? ` — ${detail}` : ""}`;
  }
}

/** The dialog title for a permission request: what the agent wants to do. */
function permissionTitle(toolCall: any): string {
  const call = toolCall && typeof toolCall === "object" ? toolCall : {};
  const title = String(call.title || "").trim();
  if (title) return title.slice(0, 240);
  const kind = String(call.kind || "").trim();
  return kind ? `Allow ${kind}?` : "Allow this action?";
}

function safeJson(value: unknown): string {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return String(text ?? "").slice(0, 2000);
  } catch {
    return "";
  }
}
