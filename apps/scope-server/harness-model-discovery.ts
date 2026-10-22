/**
 * harness-model-discovery.ts — ask the harnesses that do NOT have a
 * `models`-style CLI command for their model list over the protocol they
 * already speak.
 *
 *   claude   `claude -p` stream-json   → control_response `initialize` → `.models`
 *   codex    `codex app-server`        → `model/list`
 *   gemini   `gemini --acp`            → ACP `session/new` → `.models.availableModels`
 *   cline    `cline --acp`             → ACP `session/new` → `.models.availableModels`
 *
 * `harnesses.ts` handles the CLIs that can print their catalogue directly
 * (`opencode models`, `kilo models`, `cursor-agent --list-models`). The rest
 * used to fall back to a hand-written alias list that ages with every CLI
 * release; these protocols publish the models the installed CLI actually
 * offers, so the Chat model pill can show those instead.
 *
 * Discovery never sends a prompt: each child is asked for metadata only and is
 * killed as soon as it answers (or the timeout fires). No session is resumed.
 */
import type { ChildProcess } from "node:child_process";
import { killTree, spawnCli } from "../../shared/shell.ts";

export interface ProtocolModelsResult {
  models: string[];
  /** The interface that answered, e.g. `claude initialize`. */
  source: string;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const OUTPUT_MAX = 2_000_000;
const MAX_MODELS = 4000;

const collapse = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();

/** End-of-stream sentinel. One identity for the wire and `until`. */
const END = Symbol("end");

interface Wire {
  child: ChildProcess;
  send(value: unknown): void;
  next(): Promise<any>;
  close(): void;
  stderr(): string;
}

function openWire(file: string, args: string[], cwd: string): Wire {
  // Detach on POSIX so the whole process group can be killed: some ACP CLIs
  // (Gemini) run the actual agent in a child of the node wrapper, and killing
  // only the wrapper would leave that child behind after every refresh.
  const child = spawnCli(file, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let buffered = "";
  let err = "";
  const frames: any[] = [];
  const waiters: ((value: any) => void)[] = [];
  let ended = false;

  const push = (value: any) => {
    const waiter = waiters.shift();
    if (waiter) waiter(value);
    else frames.push(value);
  };
  const end = () => {
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
  // A CLI may exit (or close stdin) before we finish the handshake. The write
  // then fails asynchronously with EPIPE; without this listener that becomes an
  // unhandled 'error' event and takes the whole server down. `next()` learns
  // about the exit from the `close` handler below.
  child.stdin?.on("error", () => { /* the child closed its input */ });
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
      // Metadata is already parsed, so there is nothing to lose by ending the
      // exchange hard. On Windows killTree uses `taskkill /T /F`; on POSIX the
      // detached child is a process-group leader, so the negative pid reaches
      // the CLI's own node child too.
      try { child.stdin?.end(); } catch { /* already closed */ }
      if (process.platform !== "win32" && child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); return; } catch { /* group gone */ }
      }
      try { killTree(child); } catch { /* already gone */ }
    },
    stderr: () => collapse(err),
  };
}

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

async function until<T>(wire: Wire, pick: (frame: any) => T | undefined): Promise<T> {
  for (;;) {
    const frame = await wire.next();
    if (frame === END) throw new Error("the harness exited before answering");
    const value = pick(frame);
    if (value !== undefined) return value;
  }
}

/** Dedupe, drop the empty/"default" pseudo-model, and cap the list. */
function cleanModels(values: unknown): string[] {
  const out: string[] = [];
  for (const value of Array.isArray(values) ? values : []) {
    const id = collapse(value);
    if (!id || id === "default" || id.length > 120 || out.includes(id)) continue;
    out.push(id);
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

// ─── Pure parsers (exported for the unit tests) ─────────────────────────────

/** Claude's initialize response: `{ models: [{ value, displayName, … }] }`.
 *  `value` is what `--model` accepts (an alias such as `opus`/`sonnet`). */
export function parseClaudeModels(payload: any): string[] | null {
  const entries = payload?.models ?? payload?.response?.models;
  if (!Array.isArray(entries)) return null;
  return cleanModels(entries.map((m: any) => m?.value ?? m?.id ?? m?.model));
}

/** Codex app-server `model/list`: `{ data: [{ id, model, hidden, … }] }`. */
export function parseCodexModels(result: any): string[] | null {
  const entries = Array.isArray(result?.data) ? result.data : Array.isArray(result) ? result : null;
  if (!entries) return null;
  return cleanModels(
    entries
      .filter((m: any) => m && m.hidden !== true)
      .map((m: any) => m.id ?? m.model),
  );
}

/** ACP `session/new`: `{ models: { availableModels: [{ modelId, name }] } }`. */
export function parseAcpModels(result: any): string[] | null {
  const container = result?.models;
  const entries = Array.isArray(container?.availableModels)
    ? container.availableModels
    : Array.isArray(container)
      ? container
      : Array.isArray(result?.availableModels)
        ? result.availableModels
        : null;
  if (!entries) return null;
  return cleanModels(entries.map((m: any) => m?.modelId ?? m?.id ?? m?.value));
}

// ─── Per-protocol discovery ─────────────────────────────────────────────────

/** Claude Code's control channel, initialized exactly as command discovery does. */
export async function discoverClaudeModels(
  file: string,
  cwd: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ProtocolModelsResult> {
  const source = "claude initialize";
  const models = await withWire(
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
        request_id: "pi-scope-models",
        request: { subtype: "initialize", hooks: null },
      });
      return until(wire, (frame) => {
        if (frame?.type === "control_request" && frame?.request_id) {
          wire.send({
            type: "control_response",
            response: {
              subtype: "error",
              request_id: frame.request_id,
              error: "Model discovery does not execute requests",
            },
          });
          return undefined;
        }
        if (frame?.type !== "control_response" || frame?.response?.request_id !== "pi-scope-models") {
          return undefined;
        }
        if (frame?.response?.subtype !== "success") {
          throw new Error(collapse(frame?.response?.error) || "initialize failed");
        }
        const parsed = parseClaudeModels(frame?.response?.response);
        if (!parsed) throw new Error("claude did not report its models");
        return parsed;
      });
    },
  );
  return { models, source };
}

/** Codex's app-server (`initialize` → `model/list`). */
export async function discoverCodexModels(
  file: string,
  cwd: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ProtocolModelsResult> {
  const source = "codex app-server model/list";
  const models = await withWire(file, ["app-server"], cwd, timeoutMs, async (wire) => {
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
    wire.send({ jsonrpc: "2.0", id: 2, method: "model/list", params: {} });
    return until(wire, (frame) => {
      if (frame?.id !== 2) return undefined;
      if (frame?.error) throw new Error(collapse(frame.error.message) || "model/list failed");
      const parsed = parseCodexModels(frame.result);
      if (!parsed) throw new Error("codex did not report its models");
      return parsed;
    });
  });
  return { models, source };
}

/** An ACP harness's `session/new` result (Gemini, Cline, …). */
export async function discoverAcpModels(
  file: string,
  args: string[],
  cwd: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ProtocolModelsResult> {
  const source = "ACP session/new";
  const models = await withWire(file, args, cwd, timeoutMs, async (wire) => {
    wire.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
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
      if (frame?.method && typeof frame?.id === "number") {
        wire.send({
          jsonrpc: "2.0",
          id: frame.id,
          error: { code: -32000, message: "Model discovery does not run tools" },
        });
        return undefined;
      }
      if (frame?.id !== 2) return undefined;
      if (frame?.error) throw new Error(collapse(frame.error.message) || "session/new failed");
      const parsed = parseAcpModels(frame.result);
      if (!parsed) throw new Error("the harness did not report its models");
      return parsed;
    });
  });
  return { models, source };
}
