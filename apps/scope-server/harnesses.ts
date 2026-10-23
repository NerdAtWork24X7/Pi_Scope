/**
 * harnesses.ts — the coding-agent CLIs the Chat view can drive.
 *
 * Pi Scope's Chat view started out as a front end for the bundled Pi agent: one
 * `pi --mode rpc` subprocess per conversation, speaking pi's own NDJSON
 * protocol. Plenty of people run Claude Code, Codex CLI, opencode or one of the
 * other terminal agents instead, and the Workflow plugin already knows how to
 * launch them (`plugins/subagent-workflow/server.ts`). This module is the same
 * idea for Chat, kept in one place so the picker, the availability report and
 * the spawn command can never disagree.
 *
 * Pi stays first-class: `pi` is listed here so the picker has one uniform list,
 * but it is *not* spawned from this module. `chat.ts` keeps its long-lived RPC
 * subprocess for it (conversation context, session resume, thinking levels,
 * tool events); the other harnesses are one-shot CLIs, launched fresh for every
 * prompt (see `startHarnessChat` in chat.ts).
 *
 * Two things come from outside this file:
 *
 *   • **Binary overrides** — `SCOPE_HARNESS_BIN_<ID>` (this module) and the
 *     per-harness paths a user set in Settings → Plugins → Workflow (read from
 *     that plugin's store by `workflow-harness-settings.ts`).
 *   • **Custom harnesses** — the ones defined in the same Workflow settings are
 *     offered here too, so a CLI the app does not ship only has to be described
 *     once.
 *
 * Flags were taken from each CLI's own `--help` / published reference and match
 * the Workflow plugin's built-ins:
 *
 *   claude  -p <prompt>                   (print / non-interactive)
 *   codex   exec <prompt>                 (non-interactive subcommand)
 *   gemini  -p <prompt>
 *   opencode run                          (message on stdin — see below)
 *   cline   []                            (message on stdin)
 *   kilo    run                           (message on stdin)
 *   aider   --yes --message <prompt>
 *   cursor  -p <prompt>                   (cursor-agent)
 *
 * `promptStdin` marks the harnesses whose prompt travels on the child's stdin.
 * That is not a nicety: on Windows every one of these is a `.cmd` shim started
 * through cmd.exe, and cmd ends a command line at the first newline — a
 * multi-line chat prompt would silently arrive truncated. It is also the only
 * way to hand opencode/cline/kilo a prompt without quoting it into a shell.
 *
 * `modelsArgs` is the CLI's own "list my models" command, where it has one
 * (`opencode models`, `kilo models`, `cursor-agent --list-models`). The model
 * pill asks the installed CLI for its real list instead of showing a curated
 * handful: opencode's list is whatever providers the user signed that CLI up
 * for, which no baked-in list can know. Harnesses without such a command keep
 * the curated aliases below (Claude Code's `sonnet`/`opus`/`haiku` are aliases,
 * not a catalogue, and Codex/Gemini expose no listing command).
 */
import { spawn } from "node:child_process";
import { expandShellPath, resolveExecutable, spawnCli, killTree } from "../../shared/shell.ts";
import {
  discoverAcpModels,
  discoverClaudeModels,
  discoverCodexModels,
  type ProtocolModelsResult,
} from "./harness-model-discovery.ts";
import { trackProcess } from "./process-registry.ts";

/** A harness the Chat composer can offer. */
export interface ChatHarness {
  id: string;
  label: string;
  /** The executable looked up on PATH (null for the built-in Pi runner). */
  bin: string | null;
  /** Flags of the non-interactive invocation, with the prompt when it is argv. */
  args: (prompt: string) => string[];
  /** The harness reads its prompt from stdin instead of argv. */
  promptStdin: boolean;
  /** The CLI's model flag (null when it has none). */
  modelFlag: string | null;
  /** A short curated list offered when the CLI cannot list its own models. */
  models: string[];
  /** The CLI's own model listing command, when it has one. */
  modelsArgs?: string[];
  /** How to ask for models over the CLI's protocol when it has no listing
   *  command (Claude's initialize, Codex's app-server, ACP session/new). */
  modelsVia?: "claude-control" | "codex-app-server" | "acp";
  /** How the composer's `/` menu learns this CLI's own commands (see
   *  harness-commands.ts). Absent = the CLI publishes no command interface. */
  commandsVia?: "pi-rpc" | "claude-control" | "codex-skills" | "acp";
  /** Arguments that start the CLI's ACP server (`commandsVia: "acp"`). */
  acpArgs?: string[];
  /** Defined in Settings → Plugins → Workflow rather than shipped here. */
  user?: boolean;
}

/**
 * Built-in harnesses, in picker order. `pi` is first because it is the app's
 * own agent and the default for every existing conversation.
 */
export const CHAT_HARNESSES: Record<string, ChatHarness> = {
  pi: {
    id: "pi",
    label: "Pi (built-in)",
    bin: null,
    args: () => [],
    promptStdin: false,
    modelFlag: "--model",
    models: [],
    commandsVia: "pi-rpc",
  },
  claude: {
    id: "claude",
    label: "Claude Code",
    bin: "claude",
    args: (prompt) => ["-p", prompt],
    promptStdin: false,
    modelFlag: "--model",
    models: ["sonnet", "opus", "haiku", "claude-sonnet-4-5", "claude-opus-4-1"],
    // Claude's control channel reports the models this install can run; the
    // curated list above is only a fallback for an older/unavailable CLI.
    modelsVia: "claude-control",
    commandsVia: "claude-control",
  },
  codex: {
    id: "codex",
    label: "Codex CLI",
    bin: "codex",
    // `--skip-git-repo-check`: a Chat workspace need not be a git checkout, and
    // Codex otherwise refuses to start outside a trusted repository.
    args: (prompt) => ["exec", "--skip-git-repo-check", prompt],
    promptStdin: false,
    modelFlag: "--model",
    models: ["gpt-5-codex", "gpt-5", "gpt-5-mini", "o3", "o4-mini"],
    modelsVia: "codex-app-server",
    commandsVia: "codex-skills",
  },
  gemini: {
    id: "gemini",
    label: "Gemini CLI",
    bin: "gemini",
    // `--skip-trust`: the workspace was picked in this app, and Gemini otherwise
    // aborts every non-interactive run in a directory it has not been taught to
    // trust (there is no TTY here to answer its prompt).
    args: (prompt) => ["-p", prompt, "--skip-trust"],
    promptStdin: false,
    modelFlag: "--model",
    models: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-flash-latest"],
    modelsVia: "acp",
    commandsVia: "acp",
    acpArgs: ["--acp", "--skip-trust"],
  },
  opencode: {
    id: "opencode",
    label: "opencode",
    bin: "opencode",
    args: () => ["run"],
    promptStdin: true,
    modelFlag: "--model",
    models: ["anthropic/claude-sonnet-4-5", "openai/gpt-5", "google/gemini-2.5-pro"],
    // Verified against the installed CLI: one `provider/model` id per line.
    modelsArgs: ["models"],
    commandsVia: "acp",
    acpArgs: ["acp"],
  },
  cline: {
    id: "cline",
    label: "Cline",
    bin: "cline",
    args: () => [],
    promptStdin: true,
    modelFlag: "--model",
    models: [],
    modelsVia: "acp",
    commandsVia: "acp",
    acpArgs: ["--acp"],
  },
  kilo: {
    id: "kilo",
    label: "Kilo Code",
    bin: "kilo",
    args: () => ["run"],
    promptStdin: true,
    modelFlag: "--model",
    models: [
      "z-ai/glm-5.3-flash",
      "kilo/~deepseek/deepseek-flash-latest",
      "kilo/~anthropic/claude-sonnet-latest",
      "kilo/~google/gemini-flash-latest",
    ],
    modelsArgs: ["models"],
    commandsVia: "acp",
    acpArgs: ["acp"],
  },
  aider: {
    id: "aider",
    label: "Aider",
    bin: "aider",
    args: (prompt) => ["--yes", "--message", prompt],
    promptStdin: false,
    modelFlag: "--model",
    models: ["gpt-5", "claude-sonnet-4-5", "deepseek/deepseek-chat"],
  },
  cursor: {
    id: "cursor",
    label: "Cursor Agent",
    bin: "cursor-agent",
    args: (prompt) => ["-p", prompt],
    promptStdin: false,
    modelFlag: "--model",
    models: ["sonnet-4", "sonnet-4-thinking", "gpt-5"],
    // Cursor CLI documents `--list-models` (the interactive `/model` list is a
    // TUI view, not usable from a pipe).
    modelsArgs: ["--list-models"],
  },
};

/** The harness a chat uses when the client does not name one. */
export const DEFAULT_CHAT_HARNESS = "pi";

/** The picker order (`Object.keys` order is insertion order for these ids). */
export const CHAT_HARNESS_IDS = Object.keys(CHAT_HARNESSES);

// ─── Harness settings owned by the Workflow feature ─────────────────────────

/** A harness defined in Settings → Plugins → Workflow. */
export interface UserHarnessSetting {
  id: string;
  label: string;
  bin: string;
  /** Argument template; `{prompt}` is replaced with the message. */
  args: string;
  models: string[];
  modelFlag: string;
}

/** The parts of the Workflow plugin's settings Chat consumes. */
export interface HarnessSettings {
  /** Per-harness binary overrides (harness id → executable path). */
  bins: Record<string, string>;
  /** Custom harnesses defined by the user. */
  userHarnesses: UserHarnessSetting[];
}

export const EMPTY_HARNESS_SETTINGS: HarnessSettings = { bins: {}, userHarnesses: [] };

/** Workflow's constraints, mirrored so a malformed store entry is simply skipped. */
const HARNESS_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const USER_HARNESS_MAX = 50;
const HARNESS_LABEL_MAX = 60;
const HARNESS_ARGS_MAX = 500;
const HARNESS_MODELS_MAX = 20;
const HARNESS_MODEL_MAX = 64;
const DEFAULT_HARNESS_ARGS = "{prompt}";

const collapse = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();

/** A model list from a comma/space string or an array: trimmed, de-duped, capped. */
function parseModels(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : String(v ?? "").split(/[\s,]+/);
  const out: string[] = [];
  for (const m of raw) {
    const s = collapse(m).slice(0, HARNESS_MODEL_MAX);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= HARNESS_MODELS_MAX) break;
  }
  return out;
}

/** Split a user-typed argument template on whitespace, honouring quotes. */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const ch of String(s || "")) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) { out.push(cur); cur = ""; }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Validate the Workflow-owned settings into the shape this module uses.
 *
 * Deliberately the same rules as the Workflow server: a built-in id is reserved,
 * an id/name/binary has to be sane, and a custom harness starts from `{prompt}`
 * when no template was given. Garbage in the store (a hand-edited file, a
 * workflow imported from another machine) is dropped rather than trusted.
 */
export function normaliseHarnessSettings(raw: { bins?: unknown; userHarnesses?: unknown } | null | undefined): HarnessSettings {
  const bins: Record<string, string> = {};
  if (raw?.bins && typeof raw.bins === "object" && !Array.isArray(raw.bins)) {
    for (const [id, value] of Object.entries(raw.bins as Record<string, unknown>)) {
      const key = String(id ?? "").trim();
      const p = expandShellPath(String(value ?? "").trim());
      if (HARNESS_ID_RE.test(key) && p && p.length <= 1024) bins[key] = p;
    }
  }
  const userHarnesses: UserHarnessSetting[] = [];
  const list = Array.isArray(raw?.userHarnesses) ? raw.userHarnesses : [];
  for (const entry of list.slice(0, USER_HARNESS_MAX)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const id = String(e.id ?? "").trim();
    const bin = expandShellPath(String(e.bin ?? "").trim());
    // A built-in id is reserved, so a user harness can never shadow one.
    if (!HARNESS_ID_RE.test(id) || CHAT_HARNESSES[id] || !bin) continue;
    userHarnesses.push({
      id,
      label: collapse(e.label).slice(0, HARNESS_LABEL_MAX) || id,
      bin: bin.slice(0, 1024),
      args: String(e.args ?? "").trim().slice(0, HARNESS_ARGS_MAX) || DEFAULT_HARNESS_ARGS,
      models: parseModels(e.models),
      modelFlag: collapse(e.modelFlag).slice(0, 64),
    });
  }
  return { bins, userHarnesses };
}

/** Every spec this install can offer: built-ins plus the user's own. */
export function allHarnesses(settings: HarnessSettings = EMPTY_HARNESS_SETTINGS): Record<string, ChatHarness> {
  const map: Record<string, ChatHarness> = { ...CHAT_HARNESSES };
  for (const u of settings.userHarnesses) {
    map[u.id] = {
      id: u.id,
      label: u.label,
      bin: u.bin,
      user: true,
      // Split the template *then* substitute, so a prompt with spaces or quotes
      // stays one argv element.
      args: (prompt: string) =>
        splitArgs(u.args).map((t) => (t.includes("{prompt}") ? t.replace(/\{prompt\}/g, prompt) : t)),
      promptStdin: false,
      modelFlag: u.modelFlag || null,
      models: u.models.slice(),
    };
  }
  return map;
}

/** A harness id the client sent, normalized; unknown ids stay (lowercased) so a
 *  run reports "unknown harness: x" instead of silently switching to Pi. */
export function normalizeHarnessId(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase() || DEFAULT_CHAT_HARNESS;
}

/** The spec for an id, or null when this install does not know it. */
export function chatHarness(id: unknown, settings: HarnessSettings = EMPTY_HARNESS_SETTINGS): ChatHarness | null {
  const all = allHarnesses(settings);
  const raw = String(id ?? "").trim();
  return all[raw] || all[normalizeHarnessId(raw)] || null;
}

/** Whether a string names a harness this app can run. */
export function isChatHarness(id: unknown, settings: HarnessSettings = EMPTY_HARNESS_SETTINGS): boolean {
  return !!chatHarness(id, settings);
}

/**
 * Per-harness binary override from the environment, for a CLI installed where a
 * desktop launch does not look (an nvm / npm-global prefix, `~/.opencode/bin`,
 * a custom prefix). `SCOPE_HARNESS_BIN_CLAUDE=/opt/claude/bin/claude` pins Claude
 * Code, for example. It wins over the path set in the Workflow settings.
 */
export function harnessBinOverride(id: string): string {
  const key = `SCOPE_HARNESS_BIN_${normalizeHarnessId(id).toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const value = String(process.env[key] || "").trim();
  // `~` and `$HOME` are expanded so an override written by hand (or copied from
  // a shell rc) works from a GUI launch that never let a shell expand it.
  return value ? expandShellPath(value) : "";
}

/** The absolute path this harness would run, or null when it is not installed.
 *  Precedence: environment override → Workflow settings → the spec's own bin. */
export function resolveHarnessBin(id: string, settings: HarnessSettings = EMPTY_HARNESS_SETTINGS): string | null {
  const spec = chatHarness(id, settings);
  if (!spec || !spec.bin) return null;
  const wanted = harnessBinOverride(spec.id) || settings.bins[spec.id] || spec.bin;
  return resolveExecutable(wanted);
}

/** What the Chat composer needs to render the picker and explain a mismatch. */
export interface ChatHarnessInfo {
  id: string;
  label: string;
  bin: string | null;
  /** The CLI this install would run (null when it was not found). */
  resolved: string | null;
  available: boolean;
  models: string[];
  modelFlag: string | null;
  /** True when the prompt is piped on stdin rather than passed as argv. */
  promptStdin: boolean;
  /** The CLI's own model listing command, when it has one. */
  modelsArgs: string[] | null;
  /** Whether the CLI publishes its commands (the `/` menu asks it on demand). */
  hasCommands: boolean;
  /** Defined in Settings → Plugins → Workflow. */
  user: boolean;
}

/** The picker's catalog, with availability resolved on this machine. */
export function chatHarnessList(settings: HarnessSettings = EMPTY_HARNESS_SETTINGS): ChatHarnessInfo[] {
  const specs = allHarnesses(settings);
  // Built-ins in their declared order, then the user's own in the order they
  // were defined — a stable picker rather than Object-key order from a store.
  const ids = [...CHAT_HARNESS_IDS.filter((id) => specs[id]), ...settings.userHarnesses.map((u) => u.id)];
  return ids.map((id) => {
    const spec = specs[id];
    const resolved = resolveHarnessBin(id, settings);
    return {
      id,
      label: spec.label,
      bin: spec.bin,
      resolved,
      // Pi needs no binary here: chat.ts launches the bundled agent itself.
      available: id === "pi" ? true : !!resolved,
      models: spec.models.slice(),
      modelFlag: spec.modelFlag,
      promptStdin: spec.promptStdin,
      modelsArgs: spec.modelsArgs ? spec.modelsArgs.slice() : null,
      hasCommands: !!spec.commandsVia,
      user: !!spec.user,
    };
  });
}

/** How to launch one non-Pi harness for one prompt. */
export interface HarnessLaunch {
  ok: true;
  file: string;
  args: string[];
  /** Write `prompt` to the child's stdin and close it (instead of argv). */
  promptOnStdin: boolean;
  prompt: string;
  harness: ChatHarness;
}

export interface HarnessLaunchError {
  ok: false;
  error: string;
}

/**
 * Resolve the executable and argv for one prompt.
 *
 * A model is only appended when the harness declares a `modelFlag` AND a model
 * was chosen; an empty model means "whatever the CLI is configured to use".
 * The error text names the fix (install it, or point the environment override
 * at it) instead of surfacing a bare ENOENT from deep inside a spawn.
 */
export function buildHarnessLaunch(
  id: string,
  opts: { prompt: string; model?: string },
  settings: HarnessSettings = EMPTY_HARNESS_SETTINGS,
): HarnessLaunch | HarnessLaunchError {
  const spec = chatHarness(id, settings);
  if (!spec) return { ok: false, error: `unknown harness: ${normalizeHarnessId(id)}` };
  if (!spec.bin) {
    return { ok: false, error: `${spec.label} is not an external harness — it runs through the built-in chat runner` };
  }
  const file = resolveHarnessBin(id, settings);
  if (!file) {
    const override = harnessBinOverride(spec.id) || settings.bins[spec.id] || "";
    return {
      ok: false,
      error: override
        ? `the configured binary for ${spec.label} is not executable: ${override}`
        : `${spec.bin} was not found on PATH — install ${spec.label}, or set SCOPE_HARNESS_BIN_${spec.id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`,
    };
  }
  const prompt = String(opts.prompt ?? "");
  const model = String(opts.model ?? "").trim();
  let args = spec.args(spec.promptStdin ? "" : prompt);
  if (model && spec.modelFlag) args = [...args, spec.modelFlag, model];
  return { ok: true, file, args, promptOnStdin: spec.promptStdin, prompt, harness: spec };
}

// ─── The CLI's own model list ───────────────────────────────────────────────

export interface HarnessModelsResult {
  models: string[];
  /** The command that answered (`opencode models`), or null when there is none. */
  source: string | null;
  error?: string;
}

/** How long a CLI's answer is reused; models change at the CLI's own pace. */
const MODELS_TTL_MS = 5 * 60 * 1000;
/** How long a listing command may take before it is killed. */
const MODELS_TIMEOUT_MS = 20_000;
/** Cap on what a CLI may contribute (and on the memory the parse holds). */
const MODELS_MAX = 4000;
const MODELS_OUTPUT_MAX = 400_000;
const modelsCache = new Map<string, { at: number; result: HarnessModelsResult }>();

/** Strip the SGR/cursor sequences a CLI may paint around its list. */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * A listing command's stdout as model ids.
 *
 * One id per line, and only lines that *are* an id: a CLI that also prints a
 * banner, a header, a progress line or a bulleted description contributes
 * nothing from it (anything with whitespace is not a model id). Ids may carry
 * `/`, `:`, `@`, `.`, `-`, `_` and `+` — `provider/model`, `org/model:free`,
 * `kilo/~anthropic/...`.
 */
export function parseHarnessModelLines(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of String(raw ?? "").replace(ANSI_RE, "").split(/\r?\n/)) {
    const id = line.trim();
    if (!id || id.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9_.:/@+-]*$/.test(id)) continue;
    // A heading such as `Models:` is shaped like an id (it has a colon, which
    // real ids use for `:free`); no model id ends in a separator.
    if (/[:./@+-]$/.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MODELS_MAX) break;
  }
  return out;
}

/**
 * Ask a harness for the models it is set up for: a listing command where the
 * CLI has one (`opencode models`, `kilo models`, `cursor-agent --list-models`),
 * otherwise the metadata protocol it already speaks (Claude's initialize,
 * Codex's app-server, ACP session/new — see harness-model-discovery.ts). Cached
 * for a few minutes and keyed by the resolved binary so repointing a harness
 * re-asks.
 *
 * A harness with neither interface answers with its curated aliases and
 * `source: null`. A failure (missing binary, non-zero exit, empty list) is
 * returned with `error` and is NOT cached, so fixing the install or signing in
 * shows up on the next open instead of after the TTL.
 */
export async function discoverHarnessModels(
  id: string,
  settings: HarnessSettings = EMPTY_HARNESS_SETTINGS,
  opts: { timeoutMs?: number; force?: boolean } = {},
): Promise<HarnessModelsResult> {
  const spec = chatHarness(id, settings);
  if (!spec) return { models: [], source: null, error: `unknown harness: ${normalizeHarnessId(id)}` };
  // A CLI with neither a listing command nor a metadata protocol keeps the
  // curated aliases this module declares.
  if (!spec.modelsArgs?.length && !spec.modelsVia) return { models: spec.models.slice(), source: null };
  const file = resolveHarnessBin(spec.id, settings);
  const source = spec.modelsArgs?.length
    ? `${spec.bin} ${spec.modelsArgs.join(" ")}`
    : spec.modelsVia === "claude-control"
      ? `${spec.bin} initialize`
      : spec.modelsVia === "codex-app-server"
        ? `${spec.bin} app-server model/list`
        : `${spec.bin} ACP session/new`;
  if (!file) return { models: [], source, error: `${spec.bin} was not found on PATH` };

  const key = `${spec.id}\u0000${file}\u0000${spec.modelsVia || "cli"}`;
  const hit = modelsCache.get(key);
  if (!opts.force && hit && Date.now() - hit.at < MODELS_TTL_MS) return hit.result;

  // Protocol discovery (Claude/Codex/Gemini/Cline) is a short metadata exchange,
  // not a catalogue print, so it has its own path and error shapes.
  if (!spec.modelsArgs?.length) {
    let protocol: ProtocolModelsResult;
    try {
      const cwd = process.cwd();
      protocol = spec.modelsVia === "claude-control"
        ? await discoverClaudeModels(file, cwd, opts.timeoutMs ?? MODELS_TIMEOUT_MS)
        : spec.modelsVia === "codex-app-server"
          ? await discoverCodexModels(file, cwd, opts.timeoutMs ?? MODELS_TIMEOUT_MS)
          : await discoverAcpModels(file, spec.acpArgs || [], cwd, opts.timeoutMs ?? MODELS_TIMEOUT_MS);
    } catch (err: any) {
      return { models: [], source, error: String(err?.message ?? err) };
    }
    if (!protocol.models.length) return { models: [], source, error: `${source} returned no models` };
    const result: HarnessModelsResult = { models: protocol.models, source };
    modelsCache.set(key, { at: Date.now(), result });
    return result;
  }

  const parsed = await new Promise<{ models: string[]; error?: string; detail?: string }>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      // spawnCli owns the Windows `.cmd` rules: a CLI that is a shim there
      // cannot be handed to spawn() directly (EINVAL).
      child = spawnCli(file, spec.modelsArgs!.slice(), {
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      trackProcess(child, {
        kind: "discovery",
        label: `${spec.bin} models`,
        group: process.platform !== "win32",
      });
    } catch (err: any) {
      resolve({ models: [], error: `could not run ${spec.bin}: ${err?.message ?? err}` });
      return;
    }
    let out = "";
    let err = "";
    let settled = false;
    const finish = (models: string[], error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { killTree(child); } catch { /* already gone */ }
      resolve({ models, error, detail: err.trim().slice(-400) });
    };
    const timer = setTimeout(() => finish([], `timed out after ${Math.round((opts.timeoutMs ?? MODELS_TIMEOUT_MS) / 1000)}s`), opts.timeoutMs ?? MODELS_TIMEOUT_MS);
    child.stdout?.on("data", (d: Buffer) => { out = (out + d.toString()).slice(-MODELS_OUTPUT_MAX); });
    // Drained so a chatty CLI can never block on a full stderr pipe; its content
    // is a diagnostic, not a model list.
    child.stderr?.on("data", (d: Buffer) => { err = (err + d.toString()).slice(-8000); });
    child.on("error", (e: any) => finish([], e?.code === "ENOENT" ? `${spec.bin} was not found on PATH` : String(e?.message ?? e)));
    child.on("close", (code) => {
      const models = parseHarnessModelLines(out);
      if (code === 0 && models.length) finish(models);
      else if (code === 0) finish([], `${source} returned no models`);
      else finish([], `${source} exited with code ${code}`);
    });
  });

  const result: HarnessModelsResult = { models: parsed.models, source };
  if (parsed.error) {
    result.error = parsed.detail ? `${parsed.error} — ${parsed.detail}` : parsed.error;
    return result;
  }
  modelsCache.set(key, { at: Date.now(), result });
  return result;
}

export interface HarnessModelsRefresh {
  id: string;
  label: string;
  models: string[];
  /** The command that answered, or null for a harness with a curated list. */
  source: string | null;
  error?: string;
}

/**
 * Ask every installed harness for its current list, bypassing the five-minute
 * cache. Settings → Models calls this next to the pi catalog refresh, so one
 * click updates the models offered by Pi and by every CLI it can ask — the
 * listing commands (opencode, kilo, cursor) and the protocol-backed ones
 * (Claude, Codex, Gemini, Cline), not just pi's provider store.
 *
 * Harnesses with neither interface still answer with their curated aliases
 * (`source: null`): the refresh reports them rather than silently leaving them
 * out of "all harnesses". A missing/unknown harness is skipped — only CLIs this
 * install can actually run are asked.
 */
export async function refreshHarnessModels(
  settings: HarnessSettings = EMPTY_HARNESS_SETTINGS,
): Promise<HarnessModelsRefresh[]> {
  clearHarnessModelCache();
  const targets = chatHarnessList(settings).filter((h) => h.id !== "pi" && h.available);
  return Promise.all(targets.map(async (h) => {
    try {
      const result = await discoverHarnessModels(h.id, settings, { force: true });
      return {
        id: h.id,
        label: h.label,
        models: result.models,
        source: result.source,
        ...(result.error ? { error: result.error } : {}),
      };
    } catch (err: any) {
      // One broken harness must never fail the whole refresh (or leave the
      // route's other work un-awaited); report it in the same shape.
      return {
        id: h.id,
        label: h.label,
        models: [],
        source: null,
        error: String(err?.message ?? err),
      };
    }
  }));
}

/** Drop the cached model lists (tests, and a Settings action that re-points a
 *  harness binary and wants the next open re-asked). */
export function clearHarnessModelCache(): void {
  modelsCache.clear();
}
