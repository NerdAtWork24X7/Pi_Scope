/**
 * acp-client.ts — a small Agent Client Protocol client for the harnesses that
 * speak it (Gemini CLI, opencode, Kilo Code, Cline).
 *
 * Instead of one-shot `-p` invocations, an ACP harness is a live session: this
 * module starts the CLI's ACP server, creates a session in the workspace, and
 * then streams each turn's updates (`agent_message_chunk`, `tool_call`, …). That
 * is what makes the harness's own slash commands, permission requests and
 * multi-turn context work — a print-mode run has none of those. The agent also
 * publishes the commands it accepts (`available_commands_update`), so the
 * composer mirrors the live session instead of shipping a copied list.
 *
 * Only the parts the app renders are implemented, and everything the agent asks
 * the CLIENT to do on its own (read/write files, run a terminal command) is
 * refused: the harness runs its tools itself, so a client-side fs/terminal call
 * would be a second, unreported execution path.
 *
 * This file is the shared transport. Harness-specific model behavior (which
 * ACP method to use, which config option, waits/retries) lives in
 * `acp-harness.ts`, one profile per CLI, so changing opencode cannot change
 * Gemini, Cline or Kilo.
 */
import type { ChildProcess } from "node:child_process";
import { killTree, spawnCli } from "../../shared/shell.ts";
import { trackProcess } from "./process-registry.ts";
import {
  acpHarnessProfile,
  type AcpHarnessProfile,
} from "./acp-harness.ts";

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

/** One slash command an ACP agent advertises for its session. */
export interface AcpCommand {
  /** The agent's name, without a leading slash (`review`, `compact`). */
  name: string;
  description: string;
  /** Placeholder for the command's argument (`input.hint` in ACP v2). */
  argumentHint?: string;
}

export interface AcpHandlers {
  onText(delta: string): void;
  onThought?(delta: string): void;
  onToolStart?(name: string, args: string): void;
  onToolEnd?(name: string): void;
  onPermission?(request: AcpPermissionRequest): void;
  /** The session's slash commands, from `session/new` or a live
   *  `available_commands_update` (project commands can appear mid-turn). */
  onCommands?(commands: AcpCommand[]): void;
  /** A session-scoped notice worth showing (auth, unsupported command, …). */
  onNotice?(message: string, kind: "info" | "warning" | "error"): void;
}

export interface AcpSessionOptions {
  file: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  handlers: AcpHandlers;
  /** `opus`… the harness's own model id. Applied during `start()` with this
   *  harness's profile; a refusal fails the session instead of using the
   *  agent's default. */
  model?: string;
  /** The harness id (`opencode`, `gemini`, …). Selects the per-harness model
   *  profile. When omitted, the executable's basename is used. */
  harness?: string;
  /** Explicit profile, for tests or a caller that already resolved one. */
  profile?: AcpHarnessProfile;
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

/** One `configOptions` entry a session advertises (`select` or `boolean`). */
interface AcpConfigOption {
  id: string;
  name: string;
  category?: string;
  type?: string;
  currentValue?: string | boolean;
  options: Array<{ value: string; name: string }>;
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
  /** Per-harness model contract (mechanism order, option ids, waits). */
  private readonly profile: AcpHarnessProfile;
  private readonly startTimeoutMs: number;
  private readonly resumeSessionId: string;
  /** Modes the agent advertised at session creation (`session/set_mode` takes
   *  one of these ids). Empty when the harness has no modes. */
  private modes: Array<{ id: string; name: string; description?: string }> = [];
  private currentMode = "";
  /** Select/boolean options the session advertised (`configOptions` in ACP v2).
   *  Some agents (opencode) publish the model only as one of these and reject
   *  `session/set_model`; `session/set_config_option` switches it instead. */
  private configOptions: AcpConfigOption[] = [];
  /** The model the session reports as current (either mechanism). */
  private currentModel = "";
  /** Model ids the agent advertised (session/new models or its model config
   *  option). Used by profiles that must reject an unlisted id themselves. */
  private modelCatalogue: string[] = [];
  /** Why the last `setModel` could not apply the requested id. Empty after a
   *  successful switch (or when no switch was attempted). */
  private modelError = "";
  /** Handshakes waiting for the agent to advertise its model config option. */
  private modelOptionWaiters = new Set<() => void>();
  /** Commands the session advertised, kept so a reopened composer can paint
   *  immediately without re-asking the agent. */
  private commands: AcpCommand[] = [];
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
    this.profile = opts.profile
      || acpHarnessProfile(opts.harness || opts.file);
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
  get availableCommands(): AcpCommand[] {
    return this.commands.map((c) => ({ ...c }));
  }
  get mode(): string { return this.currentMode; }
  /** The model the session is using, as reported by the agent. */
  get modelId(): string { return this.currentModel; }
  /** Human-readable reason the last `setModel` failed, for the Chat/Workflow
   *  error. Empty when the requested model was applied. */
  get modelErrorDetail(): string { return this.modelError; }
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
      // The ACP server is the conversation: keep it in its own process group so
      // shutdown reaches the agent's own node/tool children too.
      detached: process.platform !== "win32",
    });
    this.child = child;
    trackProcess(child, {
      kind: "acp",
      label: `${this.file} ACP session`,
      group: process.platform !== "win32",
    });
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
      this.readConfigOptions(created?.configOptions);
      this.readModelCatalogue(created);
      if (created?.models?.currentModelId) this.currentModel = String(created.models.currentModelId);
      // Some agents return the list on session/new; most publish it just after.
      if (Array.isArray(created?.availableCommands)) this.adoptCommands(created.availableCommands);
      if (this.model) {
        // Await the switch: the first prompt must already run on the selected
        // model. If the agent refuses it, fail loudly instead of quietly
        // prompting on its default model (the exact failure that made opencode
        // answer with `recursive/flint-v1.0:free` whatever the composer said).
        if (!(await this.setModel(this.model))) {
          throw new Error(this.modelFailure(this.model));
        }
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

  /** Switch the model mid-session using this harness's own ACP contract.
   *  On success `modelId` is the requested id (or the agent's canonical id for
   *  it). On failure this returns false and `modelErrorDetail` explains why, so
   *  a caller never has to guess whether a prompt will run on the model the user
   *  picked. */
  async setModel(modelId: string): Promise<boolean> {
    const id = String(modelId || "").trim();
    this.modelError = "";
    if (!id) return false;
    if (!this.sid || !this.alive) {
      this.modelError = "the agent session is not running";
      return false;
    }
    const previousModel = this.currentModel;
    if (id === previousModel) return true;
    // Cline accepts any string for both mechanisms; a typo would otherwise end
    // the turn with an empty answer instead of an error. Its session lists the
    // models it can actually run, so reject anything outside that list.
    if (this.profile.validateAdvertisedModel && this.modelCatalogue.length && !this.modelCatalogue.includes(id)) {
      this.modelError = `the agent does not list "${id}" among its ${this.modelCatalogue.length} models`;
      return false;
    }

    let lastError = "";
    for (const via of this.profile.modelVia) {
      const outcome = via === "set_model"
        ? await this.trySetModel(id, previousModel)
        : await this.trySetConfigOption(id, previousModel);
      if (outcome.ok) return true;
      lastError = outcome.error || lastError;
    }
    this.modelError = lastError || `the ${this.profile.id} agent refused "${id}"`;
    return false;
  }

  /** The standard ACP method (Gemini, Cline, Kilo). A successful response may
   *  carry the agent's canonical model id; an empty response is trusted. */
  private async trySetModel(id: string, previousModel: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const result = await this.request("session/set_model", { sessionId: this.sid, modelId: id });
      const reported = this.reportedModel(result);
      if (reported && reported === previousModel && reported !== id) {
        return { ok: false, error: `the agent kept "${reported}" instead of "${id}"` };
      }
      this.currentModel = reported || id;
      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: String(error?.message ?? error ?? "set_model failed").trim() };
    }
  }

  /** The config-option path (opencode, and Cline's older fallback). The wait
   *  and retry values come from the harness profile, never from a shared
   *  default, so tuning opencode cannot slow down Gemini/Kilo. */
  private async trySetConfigOption(id: string, previousModel: string): Promise<{ ok: boolean; error?: string }> {
    const preferred = this.profile.modelConfigIds;
    let option = this.modelConfigOption(preferred);
    if (!option && this.profile.modelOptionWaitMs > 0) {
      option = await this.waitForModelOption(this.profile.modelOptionWaitMs, preferred);
    }
    if (!option) {
      return { ok: false, error: "the agent exposes no model config option via ACP" };
    }
    // The option's own currentValue is authoritative even when `currentModel`
    // was never seeded (some agents publish the option only after session/new).
    const optionPrevious = typeof option.currentValue === "string" && option.currentValue
      ? option.currentValue
      : previousModel;
    if (optionPrevious === id) {
      this.currentModel = id;
      return { ok: true };
    }
    const attempts = this.profile.modelRetryMs > 0 ? 2 : 1;
    let lastError = "";
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const result = await this.request("session/set_config_option", {
          sessionId: this.sid,
          configId: option.id,
          value: id,
        });
        if (Array.isArray(result?.configOptions)) this.readConfigOptions(result.configOptions);
        else option.currentValue = id;
        // Some agents accept the option but silently keep their old model. Do
        // not claim success when the session still advertises the previous
        // value. A different, non-previous value is the agent's canonical id
        // for the switch (e.g. it rewrote the provider prefix): keep that.
        const advertised = this.currentModel;
        if (advertised && advertised === optionPrevious && advertised !== id) {
          return { ok: false, error: `the agent kept "${advertised}" instead of "${id}"` };
        }
        this.currentModel = advertised || id;
        return { ok: true };
      } catch (error: any) {
        lastError = String(error?.message ?? error ?? "set_config_option failed").trim();
        // Re-discover the option: the retry may follow a fresh
        // `config_option_update`, and an agent can rebuild the option object.
        option = this.modelConfigOption(preferred) || option;
        if (attempt + 1 < attempts) {
          await new Promise((resolve) => setTimeout(resolve, this.profile.modelRetryMs));
        }
      }
    }
    return { ok: false, error: lastError || `the agent refused "${id}"` };
  }

  /** Read a model id out of a successful ACP response. Agents differ: ACP v2
   *  reports `models.currentModelId`, some report `configOptions`, and several
   *  (Gemini, Cline, Kilo) return `{}` for set_model. */
  private reportedModel(payload: any): string {
    if (Array.isArray(payload?.configOptions)) this.readConfigOptions(payload.configOptions);
    const direct = payload?.models?.currentModelId ?? payload?.currentModelId;
    if (direct) return String(direct);
    if (Array.isArray(payload?.configOptions)) return this.currentModel;
    return "";
  }

  private modelFailure(id: string): string {
    return `${this.file} could not use model "${id}"${this.modelError ? `: ${this.modelError}` : ""}`;
  }

  /** Resolve once the agent advertises a model config option, or after the
   *  timeout. Used by `setModel` so a late `config_option_update` still applies. */
  private waitForModelOption(timeoutMs: number, preferredIds: readonly string[] = []): Promise<AcpConfigOption | undefined> {
    const existing = this.modelConfigOption(preferredIds);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        if (timer) clearTimeout(timer);
        this.modelOptionWaiters.delete(done);
        resolve(this.modelConfigOption(preferredIds));
      };
      timer = setTimeout(done, Math.max(0, timeoutMs));
      (timer as any)?.unref?.();
      this.modelOptionWaiters.add(done);
    });
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
      case "available_commands_update": {
        // The agent's own slash commands. ACP publishes them for the live
        // session, so the composer never has to guess (or start a second CLI).
        this.adoptCommands(update.availableCommands);
        return;
      }
      case "current_mode_update": {
        if (update.currentModeId) this.currentMode = String(update.currentModeId);
        return;
      }
      case "config_option_update": {
        // ACP v2 publishes the whole option list after a config change (the
        // model is one of them when the agent manages it that way).
        this.readConfigOptions(update.configOptions ?? update.configOption);
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

  /** Keep the session's command list and hand it to the current run. */
  private adoptCommands(raw: unknown): void {
    this.commands = parseAcpAvailableCommands(raw);
    this.handlers.onCommands?.(this.availableCommands);
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

  /** Record the config options a session advertises (`session/new`,
   *  `session/load` or a live `config_option_update`). */
  private readConfigOptions(raw: unknown): void {
    const entries = Array.isArray(raw) ? raw : [];
    this.configOptions = entries
      .slice(0, 128)
      .map((o: any) => ({
        id: String(o?.id || ""),
        name: String(o?.name || o?.id || ""),
        ...(o?.category ? { category: String(o.category) } : {}),
        ...(o?.type ? { type: String(o.type) } : {}),
        ...(typeof o?.currentValue === "string" || typeof o?.currentValue === "boolean"
          ? { currentValue: o.currentValue }
          : {}),
        options: (Array.isArray(o?.options) ? o.options : [])
          .map((x: any) => ({ value: String(x?.value ?? ""), name: String(x?.name ?? x?.value ?? "") }))
          .filter((x: { value: string }) => x.value),
      }))
      .filter((o: AcpConfigOption) => o.id);
    const model = this.modelConfigOption(this.profile.modelConfigIds);
    if (typeof model?.currentValue === "string" && model.currentValue) this.currentModel = model.currentValue;
    if (model) {
      this.mergeModelCatalogue(model.options.map((o) => o.value));
      for (const resolve of this.modelOptionWaiters) resolve();
      this.modelOptionWaiters.clear();
    }
  }

  /** Record the model ids a session advertises. ACP v2 puts them in
   *  `models.availableModels` (Gemini, Cline); Kilo/opencode put the same ids
   *  in their model config option. Kept as a union so either shape works. */
  private readModelCatalogue(created: any): void {
    const available = created?.models?.availableModels;
    if (Array.isArray(available)) {
      this.mergeModelCatalogue(available.map((m: any) => m?.modelId ?? m?.id ?? m?.value));
    }
  }

  private mergeModelCatalogue(ids: readonly unknown[]): void {
    const merged = new Set(this.modelCatalogue);
    for (const raw of ids) {
      const id = String(raw ?? "").trim();
      if (id && id !== "default") merged.add(id);
    }
    this.modelCatalogue = [...merged];
  }

  /** The option that carries the model. A profile can name its preferred ids
   *  first; otherwise opencode/Kilo use `id: "model"`, and Cline also has a
   *  separate `id: "provider"` option in the same category. */
  private modelConfigOption(preferredIds: readonly string[] = []): AcpConfigOption | undefined {
    for (const id of preferredIds) {
      const found = this.configOptions.find((o) => o.id === id);
      if (found) return found;
    }
    return this.configOptions.find((o) => o.id === "model")
      || this.configOptions.find((o) => o.category === "model" && o.id !== "provider")
      || this.configOptions.find((o) => o.category === "model");
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

/**
 * Coerce an ACP `availableCommands` array into the shape the composer paints.
 *
 * ACP v2 describes an argument placeholder as `input: { type: "text", hint }`.
 * Names starting with `$` are skills, which take a `$` token rather than a
 * slash command, so they are not offered in the `/` menu.
 */
export function parseAcpAvailableCommands(value: unknown): AcpCommand[] {
  const entries = Array.isArray(value) ? value : [];
  const out: AcpCommand[] = [];
  const seen = new Set<string>();
  for (const entry of entries.slice(0, 512)) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, any>;
    const name = String(record.name ?? "").trim().replace(/^\/+/, "");
    if (!name || name.startsWith("$") || name.length > 64 || /[\s/]/.test(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    const description = String(record.description ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
    const input = record.input && typeof record.input === "object" ? record.input : null;
    const hint = String(input?.hint ?? record.argumentHint ?? record.inputHint ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 400);
    out.push({ name, description, ...(hint ? { argumentHint: hint } : {}) });
  }
  return out;
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
