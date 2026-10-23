/**
 * harness-commands.ts — ask each installed harness for the slash commands IT
 * offers, instead of shipping a hand-written table.
 *
 * A slash command is the harness's own vocabulary (`/compact` in Claude Code,
 * `/review` in opencode, a project skill, an extension command…). A copied list
 * drifts the moment the CLI is upgraded, and it advertises commands the CLI does
 * not actually have on this machine. Every agent session that talks to a
 * harness therefore exposes a discovery interface, and this module speaks it:
 *
 *   pi        `pi --mode rpc`            → `get_commands` response
 *   claude    `claude -p` stream-json    → control_request `initialize`
 *   codex     `codex app-server`         → `skills/list`
 *   gemini    `gemini --acp`             → ACP `available_commands_update`
 *   opencode  `opencode acp`             → ACP `available_commands_update`
 *   kilo      `kilo acp`                 → ACP `available_commands_update`
 *   cline     `cline --acp`              → ACP `available_commands_update`
 *
 * A harness with none of these (Aider's commands are TUI verbs, Cursor's are not
 * published to a pipe) answers with an empty list and `source: null` — no menu,
 * rather than commands that do not exist.
 *
 * Discovery never submits a prompt: each protocol is asked for metadata only, and
 * the child is killed as soon as it answers. Answers are cached for five minutes
 * per harness+binary+directory (project commands and skills are directory
 * scoped) and concurrent lookups share one process.
 */
import type { ChildProcess } from "node:child_process";
import { killTree, resolveExecutable, spawnCli } from "../../shared/shell.ts";
import { trackProcess } from "./process-registry.ts";
import {
  chatHarness,
  resolveHarnessBin,
  type HarnessSettings,
  EMPTY_HARNESS_SETTINGS,
} from "./harnesses.ts";

/** One command the harness itself advertises. `command` has the leading slash. */
export interface HarnessCommand {
  command: string;
  description: string;
  /** The harness's own argument placeholder, when it publishes one. */
  argumentHint?: string;
  /** Where the command comes from (`skill`, `extension`, `prompt`, …). */
  source?: string;
}

export interface HarnessCommandsResult {
  commands: HarnessCommand[];
  /** The interface that answered (`ACP session/new`), or null when none exists. */
  source: string | null;
  error?: string;
}

/** How long an answer is reused. Commands change when the user installs a skill
 *  or upgrades a CLI — far slower than a page reload. */
const CACHE_TTL_MS = 5 * 60 * 1000;
/** Per-protocol budget. A cold ACP server can take a few seconds to boot. */
const DEFAULT_TIMEOUT_MS = 20_000;
const PI_TIMEOUT_MS = 15_000;
/** Bound on the frames retained while looking for the answer. */
const OUTPUT_MAX = 2_000_000;
const MAX_COMMANDS = 512;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 400;

const cache = new Map<string, { at: number; result: HarnessCommandsResult }>();
const inFlight = new Map<string, Promise<HarnessCommandsResult>>();
/** Commands a LIVE ACP session advertised (`available_commands_update`). The
 *  ephemeral probe below is a fallback: when the chat already has a session
 *  open, that session is the authoritative source and asking again would start
 *  a second CLI just to repeat what it said. Keyed by harness + cwd, because a
 *  live session has no resolved binary path to add to the key. */
const liveCache = new Map<string, { at: number; result: HarnessCommandsResult }>();
const liveKey = (id: string, cwd: string) => `${id}\u0000${cwd}`;

const collapse = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();

/** A harness command name, or "" when it is not something a `/` token can name.
 *  Gemini advertises sub-commands as `memory show`; the composer's draft is one
 *  token, so only single-word commands can be offered. */
function commandName(raw: unknown): string {
  const name = collapse(raw).replace(/^\/+/, "");
  // ACP names skills `$skill`: those are invoked with a `$` token, not a slash
  // command, so putting them in the `/` menu would insert something the agent
  // cannot dispatch.
  if (!name || name.startsWith("$") || name.length > MAX_NAME || !/^[^\s/]+$/.test(name)) return "";
  return `/${name}`;
}

/** Coerce one protocol's entries into the shape the composer paints. */
export function normalizeHarnessCommands(
  entries: Array<Record<string, unknown>>,
  opts: { source?: (entry: Record<string, unknown>) => string | undefined } = {},
): HarnessCommand[] {
  const out: HarnessCommand[] = [];
  const seen = new Set<string>();
  for (const entry of entries.slice(0, MAX_COMMANDS * 2)) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.userInvocable === false || entry.enabled === false) continue;
    const command = commandName(entry.name ?? entry.command);
    if (!command) continue;
    if (seen.has(command)) continue;
    seen.add(command);
    const description = collapse(entry.description).slice(0, MAX_DESCRIPTION);
    // ACP advertises an argument placeholder as `input: { type: "text", hint }`;
    // Claude/pi/codex use flat fields. Accept all three so the composer can show
    // the same hint whichever protocol answered.
    const input = entry.input && typeof entry.input === "object" ? (entry.input as Record<string, unknown>) : null;
    const hint = collapse(entry.argumentHint ?? entry.inputHint ?? input?.hint).slice(0, MAX_DESCRIPTION);
    const source = opts.source ? opts.source(entry) : collapse(entry.source);
    out.push({
      command,
      description,
      ...(hint ? { argumentHint: hint } : {}),
      ...(source ? { source } : {}),
    });
    if (out.length >= MAX_COMMANDS) break;
  }
  return out;
}

// ─── NDJSON / JSON-RPC child ────────────────────────────────────────────────

/** A child process the discovery protocols talk to one JSON object per line.
 *  Reading is pull-based (`next()`), so each protocol can skip the frames it
 *  does not care about without buffering the whole conversation. */
interface Wire {
  child: ChildProcess;
  send(value: unknown): void;
  next(): Promise<any>;
  close(): void;
  /** Everything the child wrote to stderr, for a diagnostic message. */
  stderr(): string;
}

const END = Symbol("end");

function openWire(file: string, args: string[], cwd: string): Wire {
  const child = spawnCli(file, args, {
    cwd,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  trackProcess(child, {
    kind: "discovery",
    label: `${file} commands`,
    group: process.platform !== "win32",
  });
  child.stdin?.on("error", () => { /* the harness exited before reading */ });

  let buffered = "";
  let err = "";
  let ended = false;
  const frames: any[] = [];
  const waiters: Array<(value: any) => void> = [];

  const push = (value: any) => {
    const waiter = waiters.shift();
    if (waiter) waiter(value);
    else frames.push(value);
  };
  const end = () => {
    if (ended) return;
    ended = true;
    while (waiters.length) waiters.shift()!(END);
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    buffered += chunk.toString();
    if (buffered.length > OUTPUT_MAX) buffered = buffered.slice(-OUTPUT_MAX);
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
      if (!line) continue;
      try {
        push(JSON.parse(line));
      } catch {
        /* a banner or a log line, not a frame */
      }
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    err = (err + chunk.toString()).slice(-4000);
  });
  child.on("error", end);
  child.on("close", end);

  return {
    child,
    send(value) {
      if (!child.stdin || child.stdin.destroyed) throw new Error("the harness closed its input");
      child.stdin.write(JSON.stringify(value) + "\n");
    },
    next() {
      if (frames.length) return Promise.resolve(frames.shift());
      if (ended) return Promise.resolve(END);
      return new Promise((resolve) => waiters.push(resolve));
    },
    close() {
      try { killTree(child); } catch { /* already gone */ }
    },
    stderr: () => collapse(err),
  };
}

/** Run one protocol with a hard deadline; the child never outlives the call. */
async function withWire<T>(
  file: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  run: (wire: Wire) => Promise<T>,
): Promise<T> {
  const wire = openWire(file, args, cwd);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(wire),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`the harness did not answer within ${Math.round(timeoutMs / 1000)}s`)),
          timeoutMs,
        );
      }),
    ]);
  } catch (error: any) {
    const detail = wire.stderr();
    const reason = String(error?.message ?? error ?? "discovery failed");
    throw new Error(detail ? `${reason} — ${detail.slice(-300)}` : reason);
  } finally {
    if (timer) clearTimeout(timer);
    wire.close();
  }
}

/** Read frames until `pick` returns a value. */
async function until<T>(wire: Wire, pick: (frame: any) => T | undefined): Promise<T> {
  for (;;) {
    const frame = await wire.next();
    if (frame === END) throw new Error("the harness exited before answering");
    const value = pick(frame);
    if (value !== undefined) return value;
  }
}

// ─── Per-protocol parsers (exported for the unit tests) ─────────────────────

/** pi's `get_commands` response: extension commands, prompt templates, skills. */
export function parsePiCommands(response: any): HarnessCommand[] | null {
  if (response?.type !== "response" || response?.success !== true) return null;
  const entries = response?.data?.commands;
  if (!Array.isArray(entries)) return null;
  return normalizeHarnessCommands(entries);
}

/** Claude's control_response `initialize` payload (or a `system/init` frame):
 *  `commands` carries name/description/argumentHint, older builds only ship a
 *  `slash_commands` name array. */
export function parseClaudeCommands(frame: any): HarnessCommand[] | null {
  const data =
    frame?.type === "control_response" && frame?.response?.subtype === "success"
      ? frame.response.response
      : frame?.type === "system" && (frame?.subtype === "init" || frame?.subtype === "commands_changed")
        ? frame
        : null;
  if (!data) return null;
  const entries = data.commands ?? data.slash_commands;
  if (!Array.isArray(entries)) return null;
  const normalized = entries.map((entry: any) =>
    typeof entry === "string" ? { name: entry } : entry,
  );
  return normalizeHarnessCommands(normalized);
}

/** Codex app-server `skills/list`: one `skills` array per requested cwd. */
export function parseCodexSkills(result: any): HarnessCommand[] | null {
  const data = Array.isArray(result?.data) ? result.data : Array.isArray(result) ? result : null;
  if (!data) return null;
  const entries: Array<Record<string, unknown>> = [];
  for (const group of data) {
    const skills = Array.isArray(group?.skills) ? group.skills : [];
    for (const skill of skills) {
      if (!skill || typeof skill !== "object") continue;
      entries.push({
        ...skill,
        name: skill.name,
        description: skill.description ?? skill.shortDescription,
        source: skill.scope ? `skill (${skill.scope})` : "skill",
      });
    }
  }
  return normalizeHarnessCommands(entries);
}

/** ACP `session/update` → `available_commands_update`, or a session/new result
 *  that already carries the list. */
export function parseAcpCommands(frame: any): HarnessCommand[] | null {
  const update = frame?.params?.update;
  if (update?.sessionUpdate === "available_commands_update" && Array.isArray(update.availableCommands)) {
    return normalizeHarnessCommands(update.availableCommands, {
      source: (entry) => collapse(entry.source) || "acp",
    });
  }
  if (Array.isArray(frame?.result?.availableCommands)) {
    return normalizeHarnessCommands(frame.result.availableCommands, {
      source: (entry) => collapse(entry.source) || "acp",
    });
  }
  return null;
}

// ─── Per-protocol discovery ─────────────────────────────────────────────────

const PI_REQUEST_ID = "scope-commands";
const CLAUDE_REQUEST_ID = "scope-commands";

async function discoverPi(file: string, cwd: string, timeoutMs: number): Promise<HarnessCommandsResult> {
  const commands = await withWire(file, ["--mode", "rpc", "--no-session"], cwd, timeoutMs, async (wire) => {
    wire.send({ type: "get_commands", id: PI_REQUEST_ID });
    return until(wire, (frame) => {
      if (frame?.type !== "response" || frame?.id !== PI_REQUEST_ID) return undefined;
      const parsed = parsePiCommands(frame);
      if (!parsed) throw new Error(collapse(frame?.error) || "get_commands failed");
      return parsed;
    });
  });
  return { commands, source: "pi get_commands" };
}

async function discoverClaude(file: string, cwd: string, timeoutMs: number): Promise<HarnessCommandsResult> {
  const commands = await withWire(
    file,
    [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--settings", '{"disableAllHooks":true}',
      "--no-session-persistence",
    ],
    cwd,
    timeoutMs,
    async (wire) => {
      wire.send({
        type: "control_request",
        request_id: CLAUDE_REQUEST_ID,
        request: { subtype: "initialize", hooks: null },
      });
      return until(wire, (frame) => {
        // A control_request from the CLI is a permission/tool call; discovery
        // answers it with an error instead of executing anything.
        if (frame?.type === "control_request" && frame?.request_id) {
          wire.send({
            type: "control_response",
            response: {
              subtype: "error",
              request_id: frame.request_id,
              error: "Command discovery does not execute requests",
            },
          });
          return undefined;
        }
        if (frame?.type !== "control_response" || frame?.response?.request_id !== CLAUDE_REQUEST_ID) {
          return undefined;
        }
        if (frame?.response?.subtype !== "success") {
          throw new Error(collapse(frame?.response?.error) || "initialize failed");
        }
        return parseClaudeCommands(frame) ?? [];
      });
    },
  );
  return { commands, source: "claude initialize" };
}

async function discoverCodex(file: string, cwd: string, timeoutMs: number): Promise<HarnessCommandsResult> {
  const commands = await withWire(file, ["app-server"], cwd, timeoutMs, async (wire) => {
    wire.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "pi-scope", version: "0" }, capabilities: {} },
    });
    await until(wire, (frame) => {
      if (frame?.id !== 1) return undefined;
      if (frame?.error) throw new Error(collapse(frame.error.message) || "initialize failed");
      return frame.result ?? null;
    });
    wire.send({
      jsonrpc: "2.0",
      id: 2,
      method: "skills/list",
      params: { cwds: [cwd], forceReload: true },
    });
    return until(wire, (frame) => {
      if (frame?.id !== 2) return undefined;
      if (frame?.error) throw new Error(collapse(frame.error.message) || "skills/list failed");
      const parsed = parseCodexSkills(frame.result);
      return parsed ?? [];
    });
  });
  return { commands, source: "codex skills/list" };
}

/** ACP: initialize, then a session, then wait for the command list. Creating a
 *  session is the only way ACP publishes commands; it is ephemeral — the process
 *  is killed right after, no prompt is sent and nothing is resumed. */
async function discoverAcp(
  file: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<HarnessCommandsResult> {
  const commands = await withWire(file, args, cwd, timeoutMs, async (wire) => {
    wire.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        // Ask for the current protocol, exactly like the chat's live session
        // does. A v1-only agent answers with protocolVersion 1 and keeps working.
        protocolVersion: 2,
        clientInfo: { name: "Pi Scope", version: "1.0.0" },
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      },
    });
    await until(wire, (frame) => {
      if (frame?.id !== 1) return undefined;
      if (frame?.error) throw new Error(collapse(frame.error.message) || "initialize failed");
      return frame.result ?? null;
    });
    wire.send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd, mcpServers: [] },
    });
    return until(wire, (frame) => {
      // A session can ask the client to run a tool (fs/terminal). Discovery
      // refuses instead of acting on the user's machine.
      if (frame?.method && typeof frame?.id === "number") {
        wire.send({
          jsonrpc: "2.0",
          id: frame.id,
          error: { code: -32000, message: "Command discovery does not run tools" },
        });
        return undefined;
      }
      if (frame?.id === 2 && frame?.error) {
        throw new Error(collapse(frame.error.message) || "session/new failed");
      }
      return parseAcpCommands(frame) ?? undefined;
    });
  });
  return { commands, source: "ACP session/new" };
}

// ─── Public entry point ─────────────────────────────────────────────────────

/**
 * Remember the commands a live ACP session just advertised.
 *
 * An ACP agent publishes commands on its session (`available_commands_update`),
 * and the set can grow mid-conversation as project skills load. Recording that
 * here means the composer's `/` menu reflects the session the user is actually
 * talking to — and does not spawn a second CLI process to re-ask.
 */
export function rememberHarnessCommands(
  id: string,
  cwd: string,
  commands: HarnessCommand[],
  source = "ACP session",
): void {
  const harness = String(id || "").trim();
  if (!harness) return;
  const result: HarnessCommandsResult = {
    commands: commands
      .filter((c) => c && typeof c.command === "string" && /^\/\S+$/.test(c.command))
      .map((c) => ({ ...c })),
    source,
  };
  liveCache.set(liveKey(harness, String(cwd || "").trim()), { at: Date.now(), result });
  if (liveCache.size > 32) {
    const oldest = [...liveCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) liveCache.delete(oldest[0]);
  }
}

/**
 * The commands one harness advertises for `cwd`, cached for five minutes and
 * deduplicated across concurrent callers.
 *
 * A harness without a discovery interface (or without the binary installed)
 * returns an empty list — the composer then shows no menu. A protocol failure
 * returns `error` and is not cached, so signing in or upgrading the CLI is
 * picked up on the next attempt.
 */
export async function discoverHarnessCommands(
  id: string,
  settings: HarnessSettings = EMPTY_HARNESS_SETTINGS,
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<HarnessCommandsResult> {
  const spec = chatHarness(id, settings);
  if (!spec) return { commands: [], source: null, error: `unknown harness: ${String(id ?? "").trim()}` };
  if (!spec.commandsVia) return { commands: [], source: null };
  if (spec.user) return { commands: [], source: null, error: "a custom harness has no command interface" };

  const cwd = String(opts.cwd || "").trim() || process.cwd();
  // A live ACP session already told us what it offers; trust it over a probe.
  const live = liveCache.get(liveKey(spec.id, cwd));
  if (live && Date.now() - live.at < CACHE_TTL_MS) return live.result;

  // Pi's runner is the app's own bundled agent; every other harness resolves
  // through the same override chain a prompt uses.
  const file =
    spec.id === "pi"
      ? resolveExecutable(String(process.env.SCOPE_PI_BIN || "").trim() || "pi")
      : resolveHarnessBin(spec.id, settings);
  if (!file) {
    return {
      commands: [],
      source: null,
      error: `${spec.label} was not found on PATH — install it, or point the app at its binary`,
    };
  }

  const key = `${spec.id}\u0000${file}\u0000${cwd}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;
  const pending = inFlight.get(key);
  if (pending) return pending;

  const timeoutMs = opts.timeoutMs ?? (spec.id === "pi" ? PI_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
  const task = (async (): Promise<HarnessCommandsResult> => {
    try {
      if (spec.commandsVia === "pi-rpc") return await discoverPi(file, cwd, timeoutMs);
      if (spec.commandsVia === "claude-control") return await discoverClaude(file, cwd, timeoutMs);
      if (spec.commandsVia === "codex-skills") return await discoverCodex(file, cwd, timeoutMs);
      return await discoverAcp(file, spec.acpArgs || [], cwd, timeoutMs);
    } catch (error: any) {
      return {
        commands: [],
        source: null,
        error: `${spec.label}: ${collapse(error?.message ?? error) || "could not read its commands"}`,
      };
    }
  })();

  inFlight.set(key, task);
  try {
    const result = await task;
    if (!result.error) {
      cache.set(key, { at: Date.now(), result });
      // Bound the map: commands are keyed per workspace, and a user can visit a
      // lot of them. The oldest entry goes first.
      if (cache.size > 32) {
        const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) cache.delete(oldest[0]);
      }
    }
    return result;
  } finally {
    inFlight.delete(key);
  }
}

/** Drop cached answers (tests, and a Settings action that re-points a binary). */
export function clearHarnessCommandCache(): void {
  cache.clear();
  liveCache.clear();
}
