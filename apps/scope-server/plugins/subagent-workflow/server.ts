/**
 * subagent-workflow plugin — server half.
 *
 * Backs the **Workflow** view: a canvas where each node is a *coding-agent
 * harness* — Claude Code (`claude -p`), Codex CLI (`codex exec`), Gemini CLI
 * (`gemini -p`), opencode, Aider, Cursor Agent, the app's own Pi runner, or a
 * user-typed shell command. Nodes are wired into a **fan-out DAG** between a
 * `start` node and an `end` node, and a run executes the graph **server-side, in
 * the background** — it keeps going with no page open, streaming each node's
 * output into the run log.
 *
 * A **`loop` node** repeats a step `config.count` times, one pass after the
 * next. It has one input and two outputs: **Repeat** and **Exit**. Wiring
 * Repeat to a node makes that node — and everything it reaches that the Exit
 * side does not own — the loop's section; between passes the loop hands the
 * section the result it just produced, so each pass improves the last, and only
 * the Exit output carries the finished loop on. Without a Repeat connection the
 * loop keeps its original behaviour: it repeats the section it *dominates* (the
 * nodes that exist only because the loop feeds them) and that section always
 * starts from the same material. Either way the section sees
 * `{iteration}`/`{iterations}`/`{loop}` (and `SW_ITERATION`/`SW_ITERATIONS`/
 * `SW_LOOP` for a command), an approval gate inside the section asks again on
 * every pass, and the loop node's own output is its **final pass's result** —
 * the finished work of the step wired to its Repeat output — so a downstream
 * node reads the loop's *answer*, not a log of the seed and every pass. A step
 * wired to the Exit waits for the loop to settle, while only the section runs
 * during passes, and a node wired *straight from a section step* (the last body
 * step feeding the end node, say) reads that same finished loop.
 * A node the `start` node
 * can still reach without the loop is *not* in a dominated section — it runs
 * once.
 *
 *   GET  /subagent-workflow?cwd=<workspace>            → graph + run + history +
 *                                                        triggers snapshot
 *   GET  /subagent-workflow/harnesses                  → harness list + availability,
 *                                                        and the model catalogue
 *                                                        the app's own runner offers
 *   GET  /subagent-workflow/models?harness=<id>        → the models that harness's own
 *                                                        CLI reports (`opencode models`)
 *   POST /subagent-workflow/harness-paths { harness,   → set/clear one harness's
 *     path }                                             binary override
 *   POST /subagent-workflow/user-harnesses { action,   → define / edit / remove a
 *     name, bin, args, models }                          harness of the user's own
 *   GET  /subagent-workflow/run?cwd=<workspace>        → the workspace's live run
 *   GET  /subagent-workflow/history?cwd=[&id=]         → past runs, or one of them
 *   GET  /subagent-workflow/triggers?cwd=<workspace>   → schedule + event watch
 *   POST /subagent-workflow { action, cwd, … }         → graph edits
 *   POST /subagent-workflow/run { action, cwd, … }     → start / stop / approve / reject
 *   POST /subagent-workflow/triggers { cwd, … }        → arm or disarm triggers
 *
 * Graph edits: `setWorkflowName`, `addNode`, `updateNode`, `moveNode`,
 * `removeNode`, `duplicateNode`, `addEdge`, `removeEdge`, `importWorkflow`, and
 * the per-node reference list (`addRef`, `updateRef`, `removeRef`).
 *
 * ── Reference files ───────────────────────────────────────────────────────
 * An agent node can be given **reference files**: paths the user adds, each with
 * an optional description. The node's user message is sent with the query in a
 * `<user query>` tag and the reference paths + descriptions in a
 * `<reference files/folder>` tag after it (see `buildRefBlock`) — so every
 * harness — and a custom shell command's `$SW_REFS` — is pointed at the material
 * the step needs without pasting it into the message. A relative path is resolved against the workspace
 * and canonicalised when it is added; a path that has since gone missing is
 * reported in the run log and marked "(not found)" in the block.
 * Every edit is validated server-side: one start / one end node, no self-loops,
 * no duplicate edges, no edges into the start or out of the end (both take any
 * number of connections in the other direction — that is how a graph fans out
 * and fans back in), and no cycles — except a loop's `repeat` output, which is
 * the one connection allowed to close a cycle because it is what a repeat *is*.
 *
 * ── Run history ────────────────────────────────────────────────────────────
 * Every run is recorded in the project store when it starts and whenever it
 * changes state, so it survives a page reload and a server restart. The newest
 * few are kept (`HISTORY_MAX`), each with a trimmed log, and a record that was
 * still in flight when the process stopped is reported as `interrupted` rather
 * than as a phantom live run.
 *
 * ── Triggers ───────────────────────────────────────────────────────────────
 * A workflow can start itself: an interval / daily **schedule** and a watch on
 * the live **event** stream, both stored with the workflow and armed from the
 * settings popup. A trigger only starts a run while the workspace is idle — a busy
 * workflow skips the occurrence instead of queueing one up.
 *
 * ── Human-in-the-loop ──────────────────────────────────────────────────────
 * An `approval` node is a gate a person opens: when the run reaches one it
 * pauses (the node goes `waiting`, the run stays `running`), the reviewer reads
 * the gate's message and the upstream output, and `POST /subagent-workflow/run
 * { action: "approve" | "reject", nodeId, note }` settles it. Approval forwards
 * the reviewed input downstream (with the note appended); rejection fails the
 * node, aborting the run unless it opted into `continueOnError`.
 *
 * ── Guards, gates and retries ───────────────────────────────────────────────
 * Beyond the harness/model/prompt a node can be **switched off** (`enabled:
 * false`) or **gated** on the run's data (`when: { mode, value }`). A node that
 * is off, or whose gate does not match the joined upstream output, is a
 * *pass-through*: it settles without spawning anything and forwards its
 * upstream input to its children, so a step can be toggled or branched without
 * rewiring the graph. A failing agent is retried `retries` times (waiting
 * `retryDelaySec` between attempts) before the run treats it as an error.
 *
 * ── Execution model ─────────────────────────────────────────────────────────
 * A run walks the graph from the start node. A node runs the chosen harness in
 * the workspace with a prompt built from its own template, where `{input}` is
 * the joined output of its upstream nodes and `{task}` is the run's task. An
 * agent node runs once its parents have settled (`join: all`, the default, or
 * `join: first`); a node's `fanout` setting decides whether its children run in
 * parallel or one after another. Neither is edited from the settings popup any more,
 * so with the defaults the *wiring* decides the order: everything hanging off a
 * node together runs together, and a chain runs one node after another. Output flows along the edges; `end` finishes
 * the run. A failing node aborts the run unless the node opted into
 * `continueOnError`. Runs are capped at a small concurrency limit.
 *
 * A workflow belongs to a project, so the graph lives in the project's own
 * store — `<workspace>/.pi-scope/plugins/.data/subagent-workflow.json`
 * (`api.projectStore`) — exactly like the Office keeps its board. A pre-move
 * global bucket is migrated into the project file on first read.
 *
 * Disabled → `disabledPluginForRoute()` refuses `/subagent-workflow` with a 403.
 *
 * The plugin is self-contained: it imports only `node:*` — platform launch rules
 * come from the host's kit — so the same directory installs as a plain **user**
 * plugin (`cp -r apps/scope-server/plugins/subagent-workflow
 * ~/.pi-scope/plugins/`), overriding the built-in by id.
 *
 * ── Windows ───────────────────────────────────────────────────────────────
 * A harness on PATH is a `.cmd` shim there (`claude.cmd`, `codex.cmd`, …), which
 * Node refuses to spawn directly, so a node's process is started through the
 * host's `spawnCli` (cmd.exe with every argument escaped) and stopped through
 * `killTree` (taskkill /T) — the process a run holds is the command processor,
 * not the agent. A `custom` node is a `cmd /d /s /c` one-liner there, whose
 * variables are `%SW_PROMPT%`-style instead of `$SW_PROMPT`.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** Node kinds. `approval` is a human gate that pauses the run; `loop` repeats
 *  the section it dominates. */
const NODE_TYPES = ["start", "agent", "approval", "loop", "end"];
/** Where the graph lives in the plugin store: `{ [workspace]: graph }`. */
const KEY = "workspaces";

const MAX_NODES = 200;
const MAX_EDGES = 400;
/** A loop node's pass count is clamped to MAX_LOOPS. Nesting multiplies (an
 *  inner loop runs fully inside every pass of its parent), so a RUN also carries
 *  a total-pass budget — MAX_LOOP_PASSES across every loop — and is aborted with
 *  an error when it is spent, rather than exploring a product of user counts.
 *  `SCOPE_MAX_LOOP_PASSES` overrides it (the e2e suite lowers it, so the guard
 *  itself is exercised in a dozen passes instead of five hundred). */
const MAX_LOOPS = 100;
const MAX_LOOP_PASSES = (() => {
  const env = Number(process.env.SCOPE_MAX_LOOP_PASSES);
  return Number.isFinite(env) && env > 0 ? Math.floor(env) : 500;
})();
const NAME_MAX = 60;
const DESC_MAX = 300;
const PROMPT_MAX = 20000;
const MODEL_MAX = 120;
const CWD_MAX = 1000;
const ARGS_MAX = 2000;
const CANVAS_MAX = 6000;

/**
 * Reference files a node hands its agent. Each entry names a path — stored
 * absolute, resolved against the workspace when the user added it — and an
 * optional note. The paths (with a description of each) are appended to the
 * node's user message: see `buildRefBlock`. Same idea as the Office's
 * reference library, but per node instead of per workspace.
 */
const REF_PATH_MAX = 1024;
const REF_NOTE_MAX = 200;
const REF_MAX = 20;
/** How much of a reference is read to describe it when the user wrote no note. */
const REF_DESC_READ_MAX = 8192;
const REF_DESC_MAX = 160;

/**
 * Run history. A finished run is kept in the project store so a past run can be
 * reopened after a page (or server) reload. Records are capped so the store file
 * stays small: the newest `HISTORY_MAX` runs, at most `HISTORY_LOG_MAX` log lines
 * each, each line clipped to `HISTORY_LOG_LINE_MAX`.
 */
const HISTORY_KEY = "runs";
const HISTORY_MAX = 10;
const HISTORY_LOG_MAX = 120;
const HISTORY_LOG_LINE_MAX = 1000;

/** Live run caps. */
const MAX_CONCURRENT = 4;
const RUN_LOG_MAX = 400;
const RUN_LOG_LINE_MAX = 2000;
const RUN_OUTPUT_MAX = 200_000;
const RUN_INPUT_MAX = 20_000;

/**
 * Control sequences a coding harness writes to a pipe: SGR colours and resets
 * (`\u001b[0m`, `\u001b[91m`), cursor moves, an erase-in-line, an OSC window
 * title. A run's output is shown as *prose* — the messages sidebar prints it a
 * line at a time, an approval gate's brief and the end node's answer read it as
 * text, and a downstream node is handed it as `{input}` — so a sequence has to
 * be stripped as the harness's bytes enter the run. Otherwise the view shows a
 * control character plus its literal `[0m` tail in the middle of a sentence:
 * `\u001b[0m◈ \u001b[0mWeb Search …` in place of `◈ Web Search …`. The host's
 * chat pipeline strips the same sequences out of a print-mode pi run (see
 * `ANSI_RE` in chat.ts).
 */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/**
 * Harness output as run text: escape sequences gone, and the control characters
 * a terminal would *act* on (a bell, a backspace, a bare carriage return from a
 * progress redraw) dropped rather than shown as a box in the browser. Tabs and
 * newlines stay — the sidebar renders both.
 */
function cleanRunText(text: unknown): string {
  return String(text ?? "")
    .replace(ANSI_RE, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

/**
 * Keep at most `max` characters of `text` — its tail when `fromEnd` — without
 * cutting a surrogate pair in half. Half an emoji is not a character a browser
 * can draw: it comes out as `�`, which is exactly the kind of stray glyph this
 * file works to keep out of a message.
 */
function clipText(text: string, max: number, fromEnd = false): string {
  if (text.length <= max) return text;
  let cut = fromEnd ? text.slice(-max) : text.slice(0, max);
  const first = cut.charCodeAt(0), last = cut.charCodeAt(cut.length - 1);
  if (first >= 0xdc00 && first <= 0xdfff) cut = cut.slice(1);       // a cut left the low half
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);     // …or the high half
  return cut;
}

/**
 * A row a CLI paints as live status rather than prose: opencode's `> agent ·
 * model` banner, its `◈` / `%` tool rows, and a braille spinner frame. These are
 * repainted as the agent works, so they say nothing about *why* a run failed.
 */
const STATUS_LINE_RE = /^(?:>\s+\S+\s+·|◈|%|[\u2800-\u28ff])/u;

/**
 * The line a failed harness actually meant to report, out of what it wrote to
 * stderr. A harness that paints a live status line writes it again on every step
 * and every wait (`opencode` reprints `> build · model`, then its `◈`/`%` tool
 * rows), and through a pipe each repaint arrives as an ordinary line — so the
 * tail of a failed run can be nothing but banners, which as a node's error says
 * nothing at all. A line the CLI labelled as an error wins; failing that, the
 * last row that is not live status is the best answer left. Empty when only
 * status rows were written, so the caller can fall back to the exit code.
 */
function errorFromStderr(text: unknown): string {
  const lines = cleanRunText(text).split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^(?:error|fatal|failed|failure)\b/i.test(lines[i])) return clipText(lines[i], RUN_LOG_LINE_MAX);
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!STATUS_LINE_RE.test(lines[i])) return clipText(lines[i], RUN_LOG_LINE_MAX);
  }
  return "";
}

const collapse = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
/** A stable id slug from a harness name (`"DeepSeek CLI"` → `"deepseek-cli"`). */
const slug = (v) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
/** A model list from a comma/space string or an array: trimmed, de-duped, capped. */
const parseModels = (v: any): string[] => {
  const raw = Array.isArray(v) ? v : String(v ?? "").split(/[\s,]+/);
  const out: string[] = [];
  for (const m of raw) {
    const s = collapse(m).slice(0, HARNESS_MODEL_MAX);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= HARNESS_MODELS_MAX) break;
  }
  return out;
};
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));
const multiline = (v) => String(v ?? "").replace(/\r\n?/g, "\n").trim();
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Per-harness binary overrides, set from Settings → Plugins → Workflow. A
 * global (machine-level) map of harness id → an executable the user pointed at
 * by hand, used instead of the PATH lookup. It is the escape hatch for a
 * harness installed where a desktop launch does not search — an nvm or
 * npm-global prefix, opencode's `~/.opencode/bin`, a custom location. Stored in
 * the plugin's own store, never pi's `settings.json`.
 */
const BINS_KEY = "harnessBins";
const BIN_PATH_MAX = 1024;

/**
 * Harnesses the user defines (name + binary), stored as a list beside the
 * per-harness binary overrides. `id` is a slug the server derives from the name;
 * a built-in id stays reserved, so a user harness can never shadow one.
 */
const USER_HARNESS_KEY = "userHarnesses";
const USER_HARNESS_MAX = 50;
/**
 * One id rule, used in both directions: a user-harness id the store may hold,
 * and a harness id a node may name. Deliberately permissive about case — a node
 * that names an id this installation does not know keeps it (the run then says
 * so) rather than being silently rewritten. `slug()` produces the canonical
 * lowercase form.
 */
const HARNESS_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const HARNESS_LABEL_MAX = 60;
const HARNESS_ARGS_MAX = 500;
const HARNESS_MODELS_MAX = 20;
const HARNESS_MODEL_MAX = 64;
/** The argument template a custom harness starts with (see `allHarnesses`). */
const DEFAULT_HARNESS_ARGS = "{prompt}";

/**
 * Built-in harnesses. `bin` is the executable looked up on PATH; `args(prompt)`
 * builds the non-interactive command; `modelFlag` names the model flag the CLI
 * understands. `pi` runs through the host's own chat runner and has no binary;
 * `custom` is a shell command the user supplies.
 *
 * `models` is the dropdown the node's Model field offers — a curated list of the
 * aliases/ids that CLI documents, NOT a hard limit: the Model field keeps a
 * "Custom…" entry for anything newer. `pi` leaves it empty here because the app
 * already knows the real catalogue, which `harnessList()` fills in from the
 * host's model registry (`api.kit.modelsMeta`) as `<provider>/<id>` keys.
 *
 * `capabilities` says how a node's skills / tools / extensions selection reaches
 * that harness:
 *   { flag, style: "csv" }     → `flag a,b,c`        (one argument)
 *   { flag, style: "repeat" }  → `flag a flag b`     (one per value)
 *   null                       → the harness has no such flag; a selection form
 *                                says so instead of pretending the toggle does
 *                                something. Every selection is also exported as
 *                                `SW_SKILLS` / `SW_TOOLS` / `SW_EXTENSIONS` for
 *                                `custom` shell commands.
 *
 * Flag forms were taken from the harness's own `--help` (pi: `--tools`/
 * `--skill`/`--extension`, verified against the bundled agent) or its published
 * CLI reference (claude `--allowedTools`, gemini `--allowed-tools`).
 *
 * `promptStdin: true` says the harness reads its prompt from stdin rather than
 * from `args(prompt)`, which then builds the launch with no message at all —
 * see `opencode` below for the one that needs it, and `runCliHarness` for how
 * the prompt is written.
 */
const HARNESSES: Record<string, any> = {
  claude: {
    label: "Claude Code", bin: "claude", args: (p: string) => ["-p", p], modelFlag: "--model",
    models: ["sonnet", "opus", "haiku", "claude-sonnet-4-5", "claude-opus-4-1"],
    capabilities: {
      tools: { flag: "--allowedTools", style: "csv" },
      // Claude Code discovers skills from `.claude/skills/` and its extensions
      // are MCP servers — neither is a Pi Scope skill/extension entry.
      skills: null,
      extensions: null,
    },
  },
  codex: {
    label: "Codex CLI", bin: "codex", args: (p: string) => ["exec", p], modelFlag: "--model",
    models: ["gpt-5-codex", "gpt-5", "gpt-5-mini", "o3", "o4-mini"],
    capabilities: { tools: null, skills: null, extensions: null },
  },
  gemini: {
    label: "Gemini CLI", bin: "gemini", args: (p: string) => ["-p", p], modelFlag: "--model",
    models: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-flash-latest"],
    capabilities: {
      // Comma-separated tool names that bypass the confirmation prompt.
      tools: { flag: "--allowed-tools", style: "csv" },
      skills: null,      // Gemini has no skill loader flag
      extensions: null,  // `--extensions` takes *Gemini* extension names, not agent-dir ones
    },
  },
  opencode: {
    // `opencode run` accepts the message as a positional argument *or* reads it
    // from stdin, and the prompt has to take the stdin route: on Windows the CLI
    // is a `.cmd` shim, so `spawnCli` launches it through cmd.exe — and cmd.exe
    // ends the command line at the first newline, dropping the rest silently (a
    // truncated launch still exits 0). Every prompt this runner builds is
    // multi-line (`<user query>` on a line of its own, then the reference
    // block), so opencode was handed just the first line, `<user query>`, and
    // answered "your message came through empty" while the run looked healthy.
    // Verified against the real CLI: the same prompt on stdin answers correctly,
    // and an *empty* prompt behaves exactly as an empty argument does ("You must
    // provide a message").
    label: "opencode", bin: "opencode", args: () => ["run"], modelFlag: "--model",
    promptStdin: true,
    models: ["anthropic/claude-sonnet-4-5", "openai/gpt-5", "google/gemini-2.5-pro"],
    // opencode can print its own catalogue — every provider/model it is set up for
    // on this machine, one per line — which is a far better Model list than any
    // short list baked in here (see `cliModelsFor`). Verified against
    // `opencode models`: `provider/model` per line, exit 0, no network needed.
    modelsArgs: ["models"],
    capabilities: { tools: null, skills: null, extensions: null },
  },
  aider: {
    label: "Aider", bin: "aider", args: (p: string) => ["--yes", "--message", p], modelFlag: "--model",
    models: ["gpt-5", "claude-sonnet-4-5", "deepseek/deepseek-chat"],
    capabilities: { tools: null, skills: null, extensions: null },
  },
  cursor: {
    label: "Cursor Agent", bin: "cursor-agent", args: (p: string) => ["-p", p], modelFlag: "--model",
    models: ["sonnet-4", "sonnet-4-thinking", "gpt-5"],
    capabilities: { tools: null, skills: null, extensions: null },
  },
  // The app's own runner: skills/tools/extensions map onto pi's own flags, which
  // the host chat runner appends to the subprocess it spawns for this node.
  pi: {
    label: "Pi (built-in)", bin: null,
    models: [],
    capabilities: {
      tools: { flag: "--tools", style: "csv" },
      skills: { flag: "--skill", style: "repeat" },
      extensions: { flag: "--extension", style: "repeat" },
    },
  },
  custom: { label: "Custom command", bin: null, models: [], capabilities: { tools: null, skills: null, extensions: null } },
};

/** Is `bin` executable somewhere on PATH? Returns its absolute path or null. */
function which(bin: string, resolve: (name: string) => string | null): string | null {
  return resolve(bin);
}

/** Split a user-typed argument string on whitespace, honouring quotes. */
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

// ─── Graph normalisation ────────────────────────────────────────────────────

/** A skill directory or tool name a node may allowlist. */
const CAP_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
/** An extension id, as settings.json writes it (`extensions/agent-team/index.ts`). */
const CAP_PATH_RE = /^[A-Za-z0-9_./-]{1,200}$/;
const MAX_CAPS = 100;

/**
 * How many times a failing agent is retried, and how long to wait between
 * attempts. A node's `retries` is *additional* attempts, so the default of 0
 * means "run once", exactly as before.
 */
const RETRIES_MAX = 5;
const RETRY_DELAY_MAX = 120;

/**
 * The gate operators a node can be conditioned on. Deliberately no regex: the
 * subject is model output, and a pathological pattern would stall the run's
 * single-threaded scheduler. `equals`/`contains` on trimmmed text cover the
 * routing cases ("did the upstream say PASS?", "did it report a failure?").
 */
const WHEN_MODES = ["always", "contains", "notContains", "equals", "notEmpty"];
const WHEN_VALUE_MAX = 200;

/** Longest note a reviewer can attach to an approve / reject decision. */
const NOTE_MAX = 500;

/**
 * Triggers — what starts a run when nobody pressed Run.
 *
 * An interval / daily schedule and a live-event watch are stored per *project*
 * (they belong to the workflow, like the graph), while a small install-level
 * index lists the workspaces that have one armed, so the ticker never has to
 * guess which projects exist. A trigger only starts a run when the workspace is
 * idle: a busy workflow skips the occurrence instead of queueing them up.
 */
const TRIGGER_KEY = "triggers";
const TRIGGER_INDEX_KEY = "triggerWorkspaces";
const TRIGGER_MODES = ["off", "interval", "daily"];
const EVERY_SECONDS_MIN = 5;
const EVERY_SECONDS_MAX = 86_400;
const TRIGGER_TYPE_MAX = 60;
const TRIGGER_TYPES_MAX = 20;
const TRIGGER_EVENT_DEBOUNCE_MS = 15_000;
/** How often schedules are evaluated. Overridable so a test need not wait 20s. */
const TRIGGER_TICK_MS = Math.max(250, Number(process.env.SCOPE_WORKFLOW_TRIGGER_TICK_MS) || 20_000);

function normaliseTriggerConfig(raw: any) {
  const r = raw && typeof raw === "object" ? raw : {};
  const s = r.schedule && typeof r.schedule === "object" ? r.schedule : {};
  const mode = TRIGGER_MODES.includes(String(s.mode)) ? String(s.mode) : "off";
  const every = Number(s.everySeconds);
  const at = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s.at)) ? String(s.at) : "09:00";
  const e = r.event && typeof r.event === "object" ? r.event : {};
  const types: string[] = [];
  if (Array.isArray(e.types)) {
    for (const t of e.types) {
      const v = collapse(t).slice(0, TRIGGER_TYPE_MAX);
      if (!v || types.includes(v)) continue;
      types.push(v);
      if (types.length >= TRIGGER_TYPES_MAX) break;
    }
  }
  return {
    schedule: {
      mode,
      everySeconds: Number.isFinite(every) && every > 0
        ? clamp(Math.floor(every), EVERY_SECONDS_MIN, EVERY_SECONDS_MAX) : 300,
      at,
    },
    event: { enabled: e.enabled === true, types },
    task: multiline(r.task).slice(0, PROMPT_MAX),
    // When each trigger last fired — state, but stored beside its config.
    lastScheduleAt: Number(r.lastScheduleAt) || 0,
    lastEventAt: Number(r.lastEventAt) || 0,
  };
}

/** Today's slot for `HH:MM`, or tomorrow's once today's has passed. */
function nextDailyAt(at: string, now: number): number {
  const [h, m] = at.split(":").map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  const t = d.getTime();
  return t > now ? t : t + 24 * 60 * 60 * 1000;
}

/** Trim, drop anything that is not a safe name/path, de-duplicate, cap length.
 *  The value ends up in a subprocess argument, so it is validated here rather
 *  than trusted from the client. */
function normaliseCapList(raw: any, re: RegExp): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= MAX_CAPS) break;
    const v = String(item ?? "").trim();
    if (!v || !re.test(v) || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * Clean a stored reference list (absent/garbage → []). Stored entries are
 * trusted — they were resolved when the user added them — so this only guards
 * against a hand-edited config and a workflow imported from another machine.
 */
function normaliseRefs(raw: any) {
  if (!Array.isArray(raw)) return [];
  const out: any[] = [];
  const paths = new Set<string>();
  const ids = new Set<string>();
  for (const item of raw) {
    if (out.length >= REF_MAX) break;
    if (!item || typeof item !== "object") continue;
    const p = collapse(item.path).slice(0, REF_PATH_MAX);
    if (!p || paths.has(p)) continue;
    paths.add(p);
    const want = String(item.id ?? "").trim().slice(0, 40);
    const id = want && !ids.has(want) ? want : `ref_${out.length}`;
    ids.add(id);
    const ref: any = { id, path: p };
    const note = collapse(item.note).slice(0, REF_NOTE_MAX);
    if (note) ref.note = note;
    out.push(ref);
  }
  return out;
}

/**
 * What a reference file *is*, in one line: the user's own note when they wrote
 * one, otherwise read from the file itself — its first markdown heading, or its
 * first non-empty line. Never throws: an unreadable path is reported as such,
 * and a path that no longer exists simply has no description (the injected
 * block marks it "not found").
 */
function describeRef(ref: any): string {
  const note = collapse(ref?.note).slice(0, REF_NOTE_MAX);
  if (note) return note;
  const p = String(ref?.path ?? "");
  let stat: fs.Stats;
  try { stat = fs.statSync(p); } catch { return ""; }
  if (stat.isDirectory()) return "folder";
  if (!stat.isFile()) return "";
  let fd: number | null = null;
  try {
    fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(Math.min(REF_DESC_READ_MAX, stat.size));
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, read).toString("utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      const heading = t.match(/^#{1,6}\s+(.+)$/);
      // A comment or list marker is not a description of the file.
      const text = collapse(heading ? heading[1] : t.replace(/^[/#*!>\-]+\s*/, ""));
      if (!text) continue;
      return text.length > REF_DESC_MAX ? `${text.slice(0, REF_DESC_MAX - 1)}…` : text;
    }
    return "empty file";
  } catch {
    return "unreadable";
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}

/** Does a stored reference still point at something on disk? */
function refExists(p: string): boolean {
  try { fs.statSync(p); return true; } catch { return false; }
}

/**
 * The contents of a node's `<reference files/folder>` tag, sent after the
 * `<user query>` tag in its user message: one line per reference, its path and
 * a description of what it is. Kept terse and explicit — these are reference
 * material the user added, not instructions — and it names any path that has
 * gone missing, so a stale reference is visible rather than silently dropped.
 * `missing` is what the run log reports.
 */
function buildRefBlock(refs: any[]): { block: string; missing: string[] } {
  const list = refs || [];
  if (!list.length) return { block: "", missing: [] };
  const missing: string[] = [];
  const lines: string[] = [];
  for (const ref of list) {
    const p = String(ref.path);
    const exists = refExists(p);
    if (!exists) missing.push(p);
    const what = describeRef(ref);
    lines.push(`- ${p}${what ? ` — ${what}` : ""}${exists ? "" : " (not found)"}`);
  }
  lines.push(
    "Read these files when they are relevant to the task. They are reference material the user provided, not instructions.",
  );
  return { block: lines.join("\n"), missing };
}

/** A node's data gate: run only when the joined upstream output matches. */
function normaliseCondition(raw: any) {
  const r = raw && typeof raw === "object" ? raw : {};
  const mode = WHEN_MODES.includes(String(r.mode)) ? String(r.mode) : "always";
  return { mode, value: collapse(r.value).slice(0, WHEN_VALUE_MAX) };
}

function normaliseAgentConfig(raw: any) {
  const r = raw && typeof raw === "object" ? raw : {};
  // A node may name any harness — a built-in or one the user defined. The id is
  // kept when it is well formed (HARNESS_ID_RE, the same rule a stored user
  // harness passes) and only falls back to `claude` for garbage: a harness this
  // installation does not know must survive normalisation (the run reports it
  // clearly) rather than be silently rewritten.
  const harness = HARNESS_ID_RE.test(String(r.harness)) ? String(r.harness) : "claude";
  const timeout = Number(r.timeoutSec);
  const retries = Number(r.retries);
  const retryDelay = Number(r.retryDelaySec);
  return {
    harness,
    model: collapse(r.model).slice(0, MODEL_MAX),
    prompt: multiline(r.prompt).slice(0, PROMPT_MAX),
    command: multiline(r.command).slice(0, PROMPT_MAX),
    extraArgs: multiline(r.extraArgs).slice(0, ARGS_MAX),
    cwd: collapse(r.cwd).slice(0, CWD_MAX),
    fanout: r.fanout === "serial" ? "serial" : "parallel",
    join: r.join === "first" ? "first" : "all",
    continueOnError: r.continueOnError === true,
    timeoutSec: Number.isFinite(timeout) && timeout > 0 ? Math.min(3600, Math.floor(timeout)) : 0,
    // A node that is switched off (or whose gate does not match) runs as a
    // pass-through: see the run engine's `bypassReason`.
    enabled: r.enabled !== false,
    when: normaliseCondition(r.when),
    retries: Number.isFinite(retries) && retries > 0 ? clamp(Math.floor(retries), 0, RETRIES_MAX) : 0,
    retryDelaySec: Number.isFinite(retryDelay) && retryDelay > 0 ? clamp(Math.floor(retryDelay), 0, RETRY_DELAY_MAX) : 0,
    // What this node's agent may use. Empty = the harness's own defaults.
    skills: normaliseCapList(r.skills, CAP_NAME_RE),
    tools: normaliseCapList(r.tools, CAP_NAME_RE),
    extensions: normaliseCapList(r.extensions, CAP_PATH_RE),
    // Reference files, injected into the node's message with a description of
    // each (see buildRefBlock).
    refs: normaliseRefs(r.refs),
  };
}

/**
 * The arguments a harness needs to honour a node's capability selection.
 *
 * Values are passed exactly as a selection lists them (skill directory names,
 * tool names, extension ids); `pi` resolves them to real paths in `runPiHarness`
 * because its flags take files, not names. A capability the harness has no flag
 * for contributes nothing — the caller marks those rows as unsupported.
 */
function capabilityArgs(spec: any, caps: { skills?: string[]; tools?: string[]; extensions?: string[] }): string[] {
  const out: string[] = [];
  for (const key of ["tools", "skills", "extensions"] as const) {
    const values = caps[key] || [];
    const c = spec?.capabilities?.[key];
    if (!c || !c.flag || !values.length) continue;
    if (c.style === "repeat") for (const v of values) out.push(c.flag, v);
    else out.push(c.flag, values.join(","));
  }
  return out;
}

/**
 * A human gate between agent steps. `message` is what the reviewer reads while
 * the run is paused (`{input}`/`{task}` interpolate like an agent prompt); the
 * guard fields let the gate be bypassed or conditioned exactly like an agent.
 */
function normaliseApprovalConfig(raw: any) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    description: collapse(r.description).slice(0, DESC_MAX),
    message: multiline(r.message).slice(0, PROMPT_MAX),
    enabled: r.enabled !== false,
    when: normaliseCondition(r.when),
  };
}

/**
 * The loop node's config: how many passes it runs. `count` is clamped to
 * 1…MAX_LOOPS; the default (2) is the smallest count that actually loops, so a
 * freshly dropped node is visible as a loop. A loop whose **Repeat** output is
 * wired back to a node re-runs that node each pass (feeding it the previous
 * pass's result); one with no Repeat connection repeats the section it
 * dominates, exactly as it always has.
 */
function normaliseLoopConfig(raw: any) {
  const r = raw && typeof raw === "object" ? raw : {};
  const n = Math.round(Number(r.count));
  return {
    description: collapse(r.description).slice(0, DESC_MAX),
    count: Number.isFinite(n) ? clamp(n, 1, MAX_LOOPS) : 2,
    enabled: r.enabled !== false,
    when: normaliseCondition(r.when),
  };
}

function normaliseNode(raw: any, index: number) {
  if (!raw || typeof raw !== "object") return null;
  const type = NODE_TYPES.includes(String(raw.type)) ? String(raw.type) : null;
  if (!type) return null;
  const node: any = {
    id: String(raw.id ?? "").trim() || `node_${index}`,
    type,
    name: collapse(raw.name).slice(0, NAME_MAX) ||
      (type === "start" ? "Start" : type === "end" ? "End" : type === "approval" ? "Approval" : type === "loop" ? "Loop" : "agent"),
    x: clamp(Number(raw.x), 0, CANVAS_MAX),
    y: clamp(Number(raw.y), 0, CANVAS_MAX),
  };
  const r = raw.config && typeof raw.config === "object" ? raw.config : {};
  if (type === "agent") node.config = normaliseAgentConfig(r);
  else if (type === "approval") node.config = normaliseApprovalConfig(r);
  else if (type === "loop") node.config = normaliseLoopConfig(r);
  else node.config = { description: collapse(r.description).slice(0, DESC_MAX), defaultTask: type === "start" ? multiline(r.defaultTask).slice(0, PROMPT_MAX) : undefined };
  return node;
}

function normaliseNodes(raw: any) {
  if (!Array.isArray(raw)) return [];
  const out: any[] = [];
  const seen = new Set<string>();
  let sawStart = false;
  let sawEnd = false;
  for (const item of raw) {
    if (out.length >= MAX_NODES) break;
    const node = normaliseNode(item, out.length);
    if (!node || seen.has(node.id)) continue;
    if (node.type === "start") { if (sawStart) continue; sawStart = true; }
    if (node.type === "end") { if (sawEnd) continue; sawEnd = true; }
    seen.add(node.id);
    out.push(node);
  }
  return out;
}

function normaliseEdges(raw: any, nodes: any[]) {
  if (!Array.isArray(raw)) return [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: any[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= MAX_EDGES) break;
    if (!item || typeof item !== "object") continue;
    const from = String(item.from ?? "").trim();
    const to = String(item.to ?? "").trim();
    if (from === to) continue;
    const a = byId.get(from) as any;
    const b = byId.get(to) as any;
    if (!a || !b || a.type === "end" || b.type === "start") continue;
    const key = `${from}\u0000${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // A `repeat` connection is a loop's feedback output: the one edge kind that
    // may close a cycle (see `hasCycle`), because closing that cycle is exactly
    // what "repeat this step" means. The same rules `addEdge` enforces apply
    // here, so an imported file can never hold a repeat edge `addEdge` would
    // have refused — only a loop has one, and it never points at the end node.
    const port = String(item.port ?? "") === "repeat" && a.type === "loop" && b.type !== "end" ? "repeat" : "";
    out.push({ id: String(item.id ?? "").trim() || `edge_${out.length}`, from, to, ...(port ? { port } : {}) });
  }
  return out;
}

function normaliseState(raw: any) {
  const r = raw && typeof raw === "object" ? raw : {};
  const nodes = normaliseNodes(r.nodes);
  return {
    name: collapse(r.name).slice(0, NAME_MAX) || "My Workflow",
    nodes,
    edges: normaliseEdges(r.edges, nodes),
  };
}

/** The starter graph a workspace gets on first open: start → agent → end. */
function seedState() {
  return normaliseState({
    name: "My Workflow",
    nodes: [
      { id: "node_start", type: "start", name: "Start", x: 80, y: 240, config: { description: "", defaultTask: "" } },
      {
        id: "node_agent_1", type: "agent", name: "claude", x: 360, y: 200,
        config: {
          harness: "claude",
          prompt: "{input}",
          fanout: "parallel",
          join: "all",
        },
      },
      { id: "node_end", type: "end", name: "End", x: 700, y: 240, config: { description: "" } },
    ],
    edges: [
      { id: "edge_1", from: "node_start", to: "node_agent_1" },
      { id: "edge_2", from: "node_agent_1", to: "node_end" },
    ],
  });
}

/** Does the whole edge list contain a cycle? Used to vet an imported graph —
 *  the runner's scheduler waits on parents, so a cycle would wedge a run.
 *  A loop's `repeat` edge is skipped: it *is* a cycle by design (the loop feeds
 *  the step it re-runs), and the loop engine handles it, not the scheduler. */
function hasCycle(nodes: any[], edges: any[]): boolean {
  const adj = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) if (e.port !== "repeat") adj.get(e.from)?.push(e.to);
  const state = new Map<string, number>(); // 0 unvisited, 1 on stack, 2 done
  const visit = (id: string): boolean => {
    const st = state.get(id) || 0;
    if (st === 1) return true;
    if (st === 2) return false;
    state.set(id, 1);
    for (const next of adj.get(id) || []) if (visit(next)) return true;
    state.set(id, 2);
    return false;
  };
  for (const n of nodes) if (visit(n.id)) return true;
  return false;
}

function createsCycle(nodes: any[], edges: any[], from: string, to: string) {
  const adj = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) if (e.port !== "repeat") adj.get(e.from)?.push(e.to);
  adj.get(from)?.push(to);
  const stack = [to];
  const seen = new Set([to]);
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === from) return true;
    for (const next of adj.get(cur) || []) {
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(next);
    }
  }
  return false;
}

/** The light shape of a stored run: enough to list and pick one, no log body. */
function summariseRun(rec: any) {
  const states = rec && rec.nodes && typeof rec.nodes === "object" ? Object.values(rec.nodes) as any[] : [];
  return {
    id: String(rec?.id ?? ""),
    status: String(rec?.status ?? "unknown"),
    task: String(rec?.task ?? ""),
    startedAt: rec?.startedAt ?? null,
    finishedAt: rec?.finishedAt ?? null,
    interrupted: rec?.interrupted === true,
    nodes: states.length,
    done: states.filter((s) => s?.status === "done").length,
    failed: states.filter((s) => s?.status === "error").length,
    logLines: Array.isArray(rec?.log) ? rec.log.length : 0,
  };
}

/** A trigger is "armed" when it could start a run on its own. */
const triggerArmed = (cfg: any) => !!cfg && (cfg.schedule?.mode !== "off" || cfg.event?.enabled === true);

/** The wire shape of a workspace's triggers, including when the next run is due. */
function publicTrigger(cfg: any) {
  const now = Date.now();
  return {
    schedule: cfg.schedule,
    event: cfg.event,
    task: cfg.task,
    lastScheduleAt: cfg.lastScheduleAt || 0,
    lastEventAt: cfg.lastEventAt || 0,
    armed: triggerArmed(cfg),
    nextRunAt: cfg.schedule.mode === "interval"
      ? (cfg.lastScheduleAt || now) + cfg.schedule.everySeconds * 1000
      : cfg.schedule.mode === "daily" ? nextDailyAt(cfg.schedule.at, now) : null,
  };
}

export function activate(api: any): void {
  const { jsonResponse, readBody } = api.kit;
  const resolveProjectDir: (cwd: string | null) => string | null =
    api.kit.resolveProjectDir ?? ((cwd) => cwd);
  const validateCwd: (cwd: string) => string | null =
    api.kit.validateCwd ?? ((cwd) => cwd || null);

  const workspaceOf = (cwd: unknown) => String(resolveProjectDir(cwd ? String(cwd) : null) ?? "default");

  // The graph is project state: `api.projectStore` puts it under
  // `<workspace>/.pi-scope/plugins/.data/subagent-workflow.json`. A host that
  // predates the helper (or a workspace that is not a real directory) falls back
  // to the plugin's global store, so this stays installable everywhere.
  // The host's agent dir holds the skills and extensions a pi node can be given.
  // Absent when the host predates the helper — handled per node, never assumed.
  const agentDir: string = typeof api.kit.agentDir === "string" ? api.kit.agentDir : "";

  // Resolve a harness binary through the HOST's resolver (PATH + the platform's
  // extra bin dirs + SCOPE_SYSTEM_BIN_DIRS) — a plugin must not import the
  // server's modules directly (the packaged build copies plugins outside the
  // bundle, so a shared import would not resolve). An older host without the
  // helper simply resolves nothing, so no harness reports as available.
  const resolveBin: (name: string) => string | null =
    typeof api.kit.resolveExecutable === "function" ? api.kit.resolveExecutable : () => null;

  // ─── Platform launch rules ────────────────────────────────────────────────
  //
  // On Windows a harness on PATH (`claude`, `codex`, `gemini`, …) is a `.cmd`
  // shim, and Node refuses to spawn one without a shell (EINVAL since
  // CVE-2024-27980); a custom command's shell one-liner is `cmd /d /s /c` rather
  // than `sh -c`; and stopping a node has to kill the process *tree*, because
  // the process we hold is cmd.exe. The host hands those rules over in its kit
  // (`spawnCli`, `shellCommandPlan`, `killTree`, `isWindows`) so they are not
  // re-derived here. Each is feature-detected with a POSIX-only fallback: an
  // older host provides none of them, and on Linux/macOS the fallback is exactly
  // what this plugin always did.
  const isWindows: () => boolean =
    typeof api.kit.isWindows === "function" ? api.kit.isWindows : () => process.platform === "win32";
  const spawnCli: (file: string, args: string[], opts?: any) => any =
    typeof api.kit.spawnCli === "function" ? api.kit.spawnCli : (file, args, opts) => spawn(file, args, opts);
  const planCommand: (command: string) => { file: string; args: string[] } =
    typeof api.kit.shellCommandPlan === "function"
      ? api.kit.shellCommandPlan
      : (command) => ({ file: process.env.SHELL || "/bin/sh", args: ["-c", command] });
  const killTree: (child: any, signal?: any) => void =
    typeof api.kit.killTree === "function"
      ? api.kit.killTree
      : (child, signal = "SIGTERM") => { try { child?.kill(signal); } catch { /* gone */ } };
  /** The default shell a `custom` node runs when the user typed no command. */
  const DEFAULT_CUSTOM_COMMAND = isWindows() ? "echo %SW_PROMPT%" : 'echo "$SW_PROMPT"';

  const hasProjectStore = typeof api.projectStore === "function";
  const storeFor = (workspace: string) => (hasProjectStore ? api.projectStore(workspace) : api.store);
  const readStoreAll = (workspace: string): Record<string, any> => {
    const all = storeFor(workspace).get(KEY, {});
    return all && typeof all === "object" ? all : {};
  };
  /** A workspace's bucket in the old global store, if it has not migrated yet. */
  function globalBucket(workspace: string): any {
    const all = api.store.get(KEY, {});
    return all && typeof all === "object" ? all[workspace] : undefined;
  }
  function dropGlobalBucket(workspace: string): void {
    const all = api.store.get(KEY, {});
    if (all && typeof all === "object" && workspace in all) {
      delete all[workspace];
      api.store.set(KEY, all);
    }
  }

  /** The workflow for `workspace`, seeding it (or migrating it) on first open. */
  function readState(workspace: string) {
    const store = storeFor(workspace);
    const all = readStoreAll(workspace);
    if (workspace in all) return normaliseState(all[workspace]);
    const moved = globalBucket(workspace);
    const seeded = moved !== undefined ? normaliseState(moved) : seedState();
    all[workspace] = seeded;
    store.set(KEY, all);
    if (moved !== undefined) dropGlobalBucket(workspace);
    return seeded;
  }

  function commit(workspace: string, mutate: (state: any) => any) {
    const store = storeFor(workspace);
    const next = normaliseState(mutate(readState(workspace)));
    const all = readStoreAll(workspace);
    all[workspace] = next;
    store.set(KEY, all);
    return next;
  }

  const nextId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const parseBody = (ctx: any) => readBody(ctx.req).then((raw: string) => JSON.parse(raw || "{}"));

  // ─── Harness availability ───────────────────────────────────────────────

  /**
   * Every model this installation can run, as the `<provider>/<id>` key pi
   * resolves. Read from the host's model registry (pi's model store, the dynamic
   * provider caches and pi's own available-models read, merged by the host) —
   * the same catalogue Settings' and the Office's model pickers offer. Sorted,
   * and empty on a host that predates `modelsMeta`.
   */
  function piModelKeys(): string[] {
    if (typeof api.kit.modelsMeta !== "function") return [];
    try { return Object.keys(api.kit.modelsMeta() || {}).sort(); } catch { return []; }
  }

  /**
   * pi takes a model as `<provider>/<id>`; a bare id is ambiguous the moment two
   * authenticated providers ship the same name, and pi fails the whole node with
   * `Model "x" is ambiguous across providers: …`. Qualify what the catalogue can
   * disambiguate so a node saved with a bare id (an older graph, or one written
   * by a script) still runs, and say what to fix when it genuinely is ambiguous.
   */
  function qualifyPiModel(raw: unknown): { model: string; note?: string; warn?: string } {
    const model = String(raw ?? "").trim();
    if (!model) return { model: "" };
    // Already `<provider>/<id>`: pi's own syntax, taken as written (it may name
    // a provider the registry does not list).
    if (model.includes("/")) return { model };
    const id = (key: string) => key.split("/").slice(1).join("/");
    const matches = piModelKeys().filter((key) => id(key) === model);
    if (matches.length === 1) return { model: matches[0], note: `◦ model "${model}" → ${matches[0]}` };
    if (matches.length > 1) {
      return { model, warn: `⚠ model "${model}" is offered by ${matches.length} providers (${matches.join(", ")}) — set this node's model to provider/model` };
    }
    return { model };
  }

  // ─── Harness resolution: built-ins, the user's own, and binary overrides ───
  //
  // Everything below resolves a harness through `resolveHarness`, never through
  // `which` directly, so a user-set override reaches both availability and the
  // run. Both stores are read fresh on each lookup: they are tiny, and reading
  // them keeps one source of truth (a write also drops the list cache).

  /**
   * The harnesses the user defined (Settings → Plugins → ⚙ Workflow): a name and
   * a binary, plus an argument template. They sit *beside* the built-ins, never
   * replacing them, so a CLI Pi Scope does not ship — DeepSeek, a private
   * wrapper, anything — can be wired into a workflow. Global, like the overrides:
   * a harness belongs to the machine, not to one workspace.
   */
  function userHarnesses(): any[] {
    const raw = api.store.get(USER_HARNESS_KEY, []);
    if (!Array.isArray(raw)) return [];
    const out: any[] = [];
    for (const e of raw.slice(0, USER_HARNESS_MAX)) {
      const id = String(e?.id ?? "").trim();
      const bin = String(e?.bin ?? "").trim();
      // A built-in id is reserved; a malformed id or an empty binary is dropped.
      if (!HARNESS_ID_RE.test(id) || HARNESSES[id] || !bin) continue;
      out.push({
        id,
        label: collapse(e?.label).slice(0, HARNESS_LABEL_MAX) || id,
        bin: bin.slice(0, BIN_PATH_MAX),
        args: String(e?.args ?? "").trim().slice(0, HARNESS_ARGS_MAX) || DEFAULT_HARNESS_ARGS,
        models: parseModels(e?.models),
        modelFlag: collapse(e?.modelFlag).slice(0, 64),
      });
    }
    return out;
  }

  /** Every harness a node may name: the built-ins plus the user's own. */
  function allHarnesses(): Record<string, any> {
    const map: Record<string, any> = { ...HARNESSES };
    for (const u of userHarnesses()) {
      map[u.id] = {
        label: u.label,
        bin: u.bin,
        user: true,
        userArgs: u.args,
        // Split the template *then* substitute, so a prompt with spaces or quotes
        // stays one argv element (a `custom` node differs: it is a shell line).
        args: (prompt: string) =>
          splitArgs(u.args).map((t) => (t.includes("{prompt}") ? t.replace(/\{prompt\}/g, prompt) : t)),
        modelFlag: u.modelFlag || undefined,
        models: u.models,
        capabilities: { tools: null, skills: null, extensions: null },
      };
    }
    return map;
  }

  /** The user's per-harness binary overrides (harness id → path). Global. */
  function harnessBins(): Record<string, string> {
    const raw = api.store.get(BINS_KEY, {});
    if (!raw || typeof raw !== "object") return {};
    const known = allHarnesses();
    const out: Record<string, string> = {};
    for (const [id, v] of Object.entries(raw)) {
      const p = String(v ?? "").trim();
      if (p && known[id]?.bin) out[id] = p;
    }
    return out;
  }

  /** True when `p` names an existing executable file (symlinks followed). */
  function executableAt(p: string): boolean {
    try {
      if (!fs.statSync(p).isFile()) return false;
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch { return false; }
  }

  /**
   * Drop binary overrides that can never resolve again — a harness with no
   * binary, or one the user removed — while keeping a key that is merely
   * unresolvable for now (its harness still exists, its path is just missing).
   * Called after every write that can change the harness set.
   */
  function pruneBins(): void {
    const raw = api.store.get(BINS_KEY, {});
    if (!raw || typeof raw !== "object") return;
    const known = allHarnesses();
    const next: Record<string, any> = { ...raw };
    let changed = false;
    for (const k of Object.keys(next)) if (!known[k]?.bin) { delete next[k]; changed = true; }
    if (changed) api.store.set(BINS_KEY, next);
  }

  /**
   * The binary a harness should run. A user override wins over the harness's own
   * `bin`; an absolute path is validated directly, a bare command name goes
   * through the host's PATH resolver. `null` means nothing resolves — which keeps
   * `available` honest, and turns a run of an unreachable harness into a clear
   * error instead of a bare ENOENT.
   */
  function resolveHarness(id: string, spec: any): string | null {
    const wanted = harnessBins()[id] || spec?.bin;
    if (!wanted) return null;
    return wanted.includes("/") || wanted.includes("\\")
      ? (executableAt(wanted) ? wanted : null)
      : which(wanted, resolveBin);
  }

  let harnessCache: { at: number; list: any[] } | null = null;
  function harnessList() {
    if (harnessCache && Date.now() - harnessCache.at < 30_000) return harnessCache.list;
    const bins = harnessBins();
    const list = Object.entries(allHarnesses()).map(([id, h]: [string, any]) => {
      const resolved = h.bin ? resolveHarness(id, h) : null;
      return {
        id,
        label: h.label,
        bin: h.bin,
        // A user-defined harness, and the argument template it was given (so the
        // Settings popup can edit it back).
        user: !!h.user,
        argsTemplate: h.user ? h.userArgs : null,
        // What the user set by hand (Settings → Plugins → Workflow) and the path
        // it actually resolves to; `available` follows the override, not just PATH.
        override: bins[id] || null,
        resolved,
        // `custom` runs whatever shell line the user typed — nothing to detect, so
        // it is always "available"; `pi` is the host's own runner, whose only
        // precondition the run engine checks is a chat runner (`runPiHarness`
        // returns "the host has no chat runner" without `startChat`).
        available: h.bin ? !!resolved : id === "custom" ? true : typeof api.kit.startChat === "function",
        modelFlag: h.modelFlag || null,
      // The models this harness offers: the curated aliases/ids a CLI documents,
      // or — for the app's own runner — the whole model catalogue, each key
      // carrying its provider.
      models: id === "pi" ? piModelKeys() : (Array.isArray(h.models) ? h.models : []),
      // The CLI's own models command, when it has one (see `cliModelsFor`). The
      // node's Model dropdown asks the binary for the rest of its list itself, so
      // this says *what* to ask and lets the form say so while it waits.
      modelsArgs: Array.isArray(h.modelsArgs) && h.modelsArgs.length ? h.modelsArgs : null,
      // Which of skills / tools / extensions this harness can be told about,
      // and the flag each maps to — `null` means "no such flag".
      capabilities: {
        skills: h.capabilities?.skills ? { flag: h.capabilities.skills.flag } : null,
        tools: h.capabilities?.tools ? { flag: h.capabilities.tools.flag } : null,
        extensions: h.capabilities?.extensions ? { flag: h.capabilities.extensions.flag } : null,
      },
      };
    });
    harnessCache = { at: Date.now(), list };
    return list;
  }

  // ─── A provider's own model list ─────────────────────────────────────────
  //
  // A node's Model field is not limited to what this plugin knows: a harness that
  // can print its catalogue is asked, so the list is what the tool on *this*
  // machine actually offers — the models the user signed that CLI up for, not the
  // handful of names baked into `HARNESSES`.

  /** How long a CLI's answer is reused, and how long it may take to arrive. */
  const CLI_MODELS_TTL_MS = 5 * 60 * 1000;
  const CLI_MODELS_TIMEOUT_MS = 20_000;
  const CLI_MODELS_MAX = 4000;
  const cliModelsCache = new Map<string, { at: number; models: string[] }>();

  /**
   * A models command's stdout as a list: one model per line, and only lines that
   * are a bare id — a CLI that also prints a banner, a warning or a progress line
   * (anything with whitespace in it) contributes that as no model. Deduped, in the
   * CLI's own order, capped.
   */
  function parseModelLines(raw: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const line of cleanRunText(raw).split("\n")) {
      const id = line.trim();
      if (!id || /\s/.test(id) || id.length > 120 || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      if (out.length >= CLI_MODELS_MAX) break;
    }
    return out;
  }

  /**
   * What `harness`'s own CLI says its models are (`opencode models`), cached for
   * a few minutes so opening two nodes — or the same node twice — asks it once,
   * while a model the user has just added to their CLI shows up on the next open
   * rather than the next restart.
   *
   * `source` is the command line that answered (for the form's hint), and `null`
   * for a harness that has no models command at all (`custom`, or any harness that
   * only documents a fixed list). A failure is not cached: a missing binary or a
   * broken install can be fixed without restarting the server.
   */
  async function cliModelsFor(id: string): Promise<{ models: string[]; source: string | null; error?: string }> {
    const spec = allHarnesses()[id];
    if (!spec || !spec.bin || !Array.isArray(spec.modelsArgs) || !spec.modelsArgs.length) {
      return { models: [], source: null };
    }
    const source = `${spec.bin} ${spec.modelsArgs.join(" ")}`;
    const cmd = resolveHarness(id, spec);
    if (!cmd) return { models: [], source, error: `${spec.bin} was not found on PATH` };
    const key = `${id}\u0000${cmd}`;
    const hit = cliModelsCache.get(key);
    if (hit && Date.now() - hit.at < CLI_MODELS_TTL_MS) return { models: hit.models, source };
    // stdout only: a CLI that prints its list to stderr as well would otherwise
    // contribute its single-word notices as "models" (opencode's own update
    // chatter goes to stderr, which is why a run sees it as a red line).
    const raw = await new Promise<string>((resolve) => {
      const decoder = new TextDecoder();
      let out = "";
      let settled = false;
      const finish = (text: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { killTree(child); } catch { /* already gone */ }
        resolve(text);
      };
      let child: any;
      try {
        child = spawnCli(cmd, spec.modelsArgs.slice(), { stdio: ["ignore", "pipe", "pipe"] });
      } catch {
        resolve("");
        return;
      }
      const timer = setTimeout(() => finish(out), CLI_MODELS_TIMEOUT_MS);
      child.stdout?.on("data", (d: Buffer) => { out = (out + decoder.decode(d, { stream: true })).slice(-400_000); });
      // Drained so the child never blocks on a full stderr pipe; its content is
      // not a model list.
      child.stderr?.resume?.();
      child.on("error", () => finish(out));
      child.on("close", () => finish(out));
    });
    const models = parseModelLines(raw);
    if (!models.length) return { models: [], source, error: `${source} reported no models` };
    cliModelsCache.set(key, { at: Date.now(), models });
    return { models, source };
  }

  // ─── The run engine ─────────────────────────────────────────────────────

  /** Live runs, keyed by workspace. One run per workspace at a time. */
  const RUNS = new Map<string, any>();
  let disposed = false;
  let triggerTimer: any = null;

  function logLine(run: any, nodeId: string | null, stream: string, text: string) {
    // A bare escape sequence is a whole "line" to a harness that writes it on its
    // own (`\u001b[0m`, then the text that follows): once it is stripped the line
    // is empty, and an empty row in the messages sidebar is not a message.
    const clean = clipText(cleanRunText(text), RUN_LOG_LINE_MAX);
    if (!clean.trim()) return;
    // A CLI that paints a live status line writes the same text again on every
    // tick (`opencode` reprints `> build · model` while it waits on a model), and
    // through a pipe each repaint is a new line. Consecutive identical lines from
    // one node are one message being repainted — not the agent starting again —
    // so the row is kept once and counts the repeats instead of filling the log.
    const prev = run.log[run.log.length - 1];
    if (prev && prev.nodeId === nodeId && prev.stream === stream && prev.text === clean) {
      prev.ts = Date.now();
      prev.repeat = (prev.repeat || 1) + 1;
      return;
    }
    run.seq++;
    run.log.push({ seq: run.seq, ts: Date.now(), nodeId, stream, text: clean });
    if (run.log.length > RUN_LOG_MAX) run.log.splice(0, run.log.length - RUN_LOG_MAX);
  }

  /**
   * The wire shape of a run. `since` makes it incremental: the client polls with
   * the last seq it saw and receives only newer log lines (and no per-node
   * output tails), so a long run streams without resending everything every
   * tick. A full read (no `since`) is what a page uses when it opens.
   */
  function publicRun(run: any, since?: number | null) {
    if (!run) return null;
    const incremental = typeof since === "number" && Number.isFinite(since);
    const nodes: Record<string, any> = {};
    for (const [id, s] of Object.entries(run.nodes) as [string, any][]) {
      nodes[id] = {
        status: s.status,
        error: s.error || null,
        exitCode: s.exitCode ?? null,
        startedAt: s.startedAt ?? null,
        finishedAt: s.finishedAt ?? null,
        // True when the node settled without running (switched off, or its
        // gate did not match) and passed its input straight through.
        bypassed: s.bypassed === true,
        // Set while an approval node is holding the run, and cleared once the
        // reviewer decides (the decision itself rides along).
        approval: s.approval || null,
        decision: s.decision || null,
      };
      // A loop node reports which pass it is on, so the canvas can show "2/5"
      // without a second request.
      if (s.iterations > 0) {
        nodes[id].iteration = s.iteration || 0;
        nodes[id].iterations = s.iterations;
      }
      // A settled node's output tail rides along even on an incremental poll:
      // it is what the messages sidebar shows as a step's final result (an
      // approval gate's input, the end node's answer), and waiting for the whole
      // run to finish — the next full read — would leave those blank until then.
      // A node that is still running streams through the log anyway, so its
      // (partial) tail stays out of the incremental payload.
      const final = s.status === "done" || s.status === "error" || s.status === "skipped" || s.status === "stopped";
      if (!incremental || final) nodes[id].outputTail = s.output ? clipText(cleanRunText(s.output), 4000, true) : "";
    }
    return {
      id: run.id, status: run.status, task: run.task,
      startedAt: run.startedAt, finishedAt: run.finishedAt || null,
      seq: run.seq, nodes,
      log: incremental ? run.log.filter((l: any) => l.seq > since) : run.log.slice(-200),
      concurrency: MAX_CONCURRENT,
    };
  }

  // ─── Run history ────────────────────────────────────────────────────────

  /** The stored run list for a workspace (newest first). */
  function readHistoryList(workspace: string): any[] {
    const all = storeFor(workspace).get(HISTORY_KEY, {});
    const list = all && typeof all === "object" ? all[workspace] : null;
    return Array.isArray(list) ? list : [];
  }
  function writeHistoryList(workspace: string, list: any[]): void {
    const store = storeFor(workspace);
    const all = store.get(HISTORY_KEY, {});
    const next = all && typeof all === "object" ? all : {};
    next[workspace] = list.slice(0, HISTORY_MAX);
    store.set(HISTORY_KEY, next);
  }

  /** A compact, storable snapshot of a run (upserts by id, so it is cheap to
   *  call again whenever the run's state moves). */
  function toRecord(run: any, interrupted = false) {
    const full = publicRun(run);
    return {
      ...full,
      status: interrupted ? "interrupted" : full.status,
      log: (full.log || [])
        .slice(-HISTORY_LOG_MAX)
        .map((l: any) => ({ seq: l.seq, ts: l.ts, nodeId: l.nodeId, stream: l.stream, text: clipText(String(l.text), HISTORY_LOG_LINE_MAX) })),
      interrupted,
    };
  }

  function saveRun(run: any): void {
    if (!run || !run.workspace) return;
    try {
      const list = readHistoryList(run.workspace).filter((r) => r && r.id !== run.id);
      list.unshift(toRecord(run));
      writeHistoryList(run.workspace, list);
    } catch (err: any) {
      api.log(`could not record run ${run.id}: ${err?.message ?? err}`);
    }
  }

  /**
   * A stored record with the escape sequences an older build let through taken
   * back out of its text. Harness output used to be kept raw, so a run recorded
   * before this cleanup still reads as `\u001b[0m◈ \u001b[0mWeb Search …` —
   * reopening it in the Workflow view is exactly when a reader notices. The
   * record is cleaned as it is served; the next run writes a clean one.
   */
  function cleanRecord(rec: any): any {
    if (!rec || typeof rec !== "object") return rec;
    const log = Array.isArray(rec.log)
      ? rec.log
        .map((l: any) => (l && typeof l.text === "string"
          ? { ...l, text: clipText(cleanRunText(l.text), HISTORY_LOG_LINE_MAX) }
          : l))
        // A row that held nothing but an escape sequence is not a line the run
        // has to say — `logLine` never records one, and neither does a read.
        .filter((l: any) => !(l && typeof l.text === "string") || l.text.trim())
      : rec.log;
    let nodes = rec.nodes;
    if (nodes && typeof nodes === "object") {
      nodes = { ...nodes };
      for (const [id, state] of Object.entries(nodes) as [string, any][]) {
        if (state && typeof state.outputTail === "string") {
          nodes[id] = { ...state, outputTail: clipText(cleanRunText(state.outputTail), 4000, true) };
        }
      }
    }
    return { ...rec, log, nodes };
  }

  /**
   * The runs a workspace remembers. A record that was still `running` (or
   * `waiting` on a gate) when the last process stopped can never be resumed —
   * its child processes are gone — so it is surfaced as `interrupted` rather
   * than as a phantom live run.
   */
  function readHistory(workspace: string): any[] {
    const list = readHistoryList(workspace);
    if (!list.length) return [];
    const live = RUNS.get(workspace);
    let changed = false;
    const fixed = list.map((rec) => {
      if (rec && (rec.status === "running" || rec.status === "waiting") && (!live || live.id !== rec.id)) {
        changed = true;
        return cleanRecord({ ...rec, status: "interrupted", interrupted: true });
      }
      return cleanRecord(rec);
    });
    if (changed) writeHistoryList(workspace, fixed);
    return fixed;
  }

  // ─── Triggers ─────────────────────────────────────────────────────────────

  /** The install-level list of workspaces that may have a trigger armed. */
  function indexedWorkspaces(): string[] {
    const list = api.store.get(TRIGGER_INDEX_KEY, []);
    return Array.isArray(list) ? list.filter((w) => typeof w === "string" && w) : [];
  }
  function writeIndex(list: string[]): void {
    api.store.set(TRIGGER_INDEX_KEY, [...new Set(list)].slice(0, 200));
  }
  function readTriggerConfig(workspace: string): any {
    const all = storeFor(workspace).get(TRIGGER_KEY, {});
    const cfg = all && typeof all === "object" ? all[workspace] : null;
    return cfg ? normaliseTriggerConfig(cfg) : null;
  }
  function writeTriggerConfig(workspace: string, cfg: any): void {
    const store = storeFor(workspace);
    const all = store.get(TRIGGER_KEY, {});
    const next = all && typeof all === "object" ? all : {};
    next[workspace] = cfg;
    store.set(TRIGGER_KEY, next);
  }
  const triggersFor = (workspace: string) =>
    publicTrigger(readTriggerConfig(workspace) || normaliseTriggerConfig({}));

  const scheduleDue = (cfg: any, now: number): boolean => {
    const { mode, everySeconds, at } = cfg.schedule;
    if (mode === "interval") {
      return !!cfg.lastScheduleAt && now - cfg.lastScheduleAt >= everySeconds * 1000;
    }
    if (mode === "daily") {
      const [h, m] = at.split(":").map(Number);
      const d = new Date(now);
      d.setHours(h, m, 0, 0);
      const occurrence = d.getTime();
      return now >= occurrence && (cfg.lastScheduleAt || 0) < occurrence;
    }
    return false;
  };

  const startNodeTask = (workspace: string) =>
    readState(workspace).nodes.find((n: any) => n.type === "start")?.config?.defaultTask ?? "";

  /** Start a run for `workspace` unless one is already in flight. */
  async function fireTrigger(workspace: string, reason: string): Promise<boolean> {
    const live = RUNS.get(workspace);
    if (live && live.status === "running") {
      api.log(`trigger skipped for ${workspace}: a run is already in progress`);
      return false;
    }
    const cfg = readTriggerConfig(workspace);
    try {
      const run = await startRun(workspace, cfg?.task || startNodeTask(workspace));
      logLine(run, null, "status", `⚡ started by ${reason}`);
      saveRun(run);
      return true;
    } catch (err: any) {
      api.log(`trigger for ${workspace} could not start a run: ${err?.message ?? err}`);
      return false;
    }
  }

  function tickTriggers(): void {
    if (disposed) return;
    const now = Date.now();
    for (const workspace of indexedWorkspaces()) {
      let cfg: any;
      try { cfg = readTriggerConfig(workspace); } catch { continue; }
      if (!triggerArmed(cfg)) continue;
      if (cfg.schedule.mode === "interval" && !cfg.lastScheduleAt) {
        // Armed just now (or on a fresh boot): the clock starts here, not at 0.
        cfg.lastScheduleAt = now;
        writeTriggerConfig(workspace, cfg);
        continue;
      }
      if (!scheduleDue(cfg, now)) continue;
      // Claimed before the async start, so a slow run cannot double-fire.
      cfg.lastScheduleAt = now;
      writeTriggerConfig(workspace, cfg);
      void fireTrigger(workspace, `schedule (${cfg.schedule.mode})`);
    }
  }

  function anyTriggerArmed(): boolean {
    return indexedWorkspaces().some((ws) => {
      try { return triggerArmed(readTriggerConfig(ws)); } catch { return false; }
    });
  }
  function syncTriggerTimer(): void {
    const armedNow = anyTriggerArmed();
    if (armedNow && !triggerTimer && !disposed) {
      triggerTimer = setInterval(tickTriggers, TRIGGER_TICK_MS);
      triggerTimer.unref?.();
    } else if (!armedNow && triggerTimer) {
      clearInterval(triggerTimer);
      triggerTimer = null;
    }
  }

  // A live event from a workspace with an armed event trigger starts a run. The
  // debounce is claimed synchronously so a burst of events starts one run, not N.
  api.onEvent?.((evt: any) => {
    try {
      const workspace = resolveProjectDir(evt?.cwd ? String(evt.cwd) : null);
      if (!workspace || !indexedWorkspaces().includes(workspace)) return;
      const cfg = readTriggerConfig(workspace);
      if (!cfg || !cfg.event.enabled) return;
      if (cfg.event.types.length && !cfg.event.types.includes(String(evt.type))) return;
      const now = Date.now();
      if (now - (cfg.lastEventAt || 0) < TRIGGER_EVENT_DEBOUNCE_MS) return;
      cfg.lastEventAt = now;
      writeTriggerConfig(workspace, cfg);
      void fireTrigger(workspace, `event:${evt.type}`);
    } catch (err: any) {
      api.log(`event trigger failed: ${err?.message ?? err}`);
    }
  });

  /** Kill every process a run currently owns. */
  function killRun(run: any) {
    // `killTree`, not `kill`: a Windows harness runs under the cmd.exe wrapper
    // `spawnCli` started, so signal-the-child alone would leave the agent alive.
    for (const child of run.children) killTree(child, "SIGTERM");
    run.children.clear();
    if (typeof api.kit.stopChat === "function") {
      for (const sid of run.sessions) { try { api.kit.stopChat(sid); } catch { /* gone */ } }
      run.sessions.clear();
    }
  }

  function abortRun(run: any, status: string, reason: string) {
    if (run.status !== "running") return;
    run.status = status;
    run.finishedAt = Date.now();
    killRun(run);
    for (const s of Object.values(run.nodes) as any[]) {
      if (s.status === "pending") s.status = "skipped";
      else if (s.status === "running" || s.status === "waiting") {
        s.status = status === "stopped" ? "stopped" : "error";
        s.approval = null;
        s.finishedAt = Date.now();
      }
    }
    if (reason) logLine(run, null, "status", reason);
    saveRun(run);
  }

  async function startRun(workspace: string, task: string) {
    const existing = RUNS.get(workspace);
    if (existing && existing.status === "running") throw new Error("a workflow run is already in progress");
    const wf = readState(workspace);
    const start = wf.nodes.find((n: any) => n.type === "start");
    if (!start) throw new Error("the workflow has no start node");
    const run: any = {
      id: `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`,
      workspace, status: "running", task, startedAt: Date.now(), finishedAt: 0, seq: 0,
      nodes: {}, log: [], children: new Set<any>(), sessions: new Set<string>(),
    };
    for (const n of wf.nodes) {
      run.nodes[n.id] = { status: "pending", output: "", error: "", exitCode: null, startedAt: null, finishedAt: null, bypassed: false, approval: null, decision: null };
    }
    RUNS.set(workspace, run);
    logLine(run, null, "status", `▶ run started${task ? `: ${task}` : ""}`);
    saveRun(run); // recorded immediately, so an ungraceful stop leaves a trace
    void execute(wf, run).catch((err) => {
      if (run.status === "running") abortRun(run, "error", `run failed: ${err?.message ?? err}`);
    });
    return run;
  }

  function stopRun(workspace: string) {
    const run = RUNS.get(workspace);
    if (!run || run.status !== "running") return false;
    abortRun(run, "stopped", "■ run stopped by the user");
    return true;
  }

  /** The DAG scheduler: decide which nodes may start, start them, finish. */
  async function execute(wf: any, run: any) {
    const byId = new Map<string, any>(wf.nodes.map((n: any) => [n.id, n]));
    const parents = new Map<string, string[]>(wf.nodes.map((n: any) => [n.id, []]));
    const children = new Map<string, string[]>(wf.nodes.map((n: any) => [n.id, []]));
    // `deps` is the same graph *minus the repeat edges*: a repeat edge is the
    // loop's feedback output, so it feeds the step's `{input}` (see `parents`)
    // without ever gating when that step may run.
    const deps = new Map<string, string[]>(wf.nodes.map((n: any) => [n.id, []]));
    for (const e of wf.edges) {
      parents.get(e.to)?.push(e.from);
      children.get(e.from)?.push(e.to);
      if (e.port !== "repeat") deps.get(e.to)?.push(e.from);
    }
    // Reachability: only what the start node can reach is executed.
    const start = wf.nodes.find((n: any) => n.type === "start");
    const reachable = new Set<string>();
    const queue = [start.id];
    while (queue.length) {
      const id = queue.pop()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const c of children.get(id) || []) queue.push(c);
    }
    for (const n of wf.nodes) if (!reachable.has(n.id)) run.nodes[n.id].status = "skipped";

    // The start node is instant: its output is the run's task.
    const ss = run.nodes[start.id];
    ss.status = "done";
    ss.output = run.task;
    ss.startedAt = ss.finishedAt = Date.now();
    logLine(run, start.id, "status", `start → ${run.task || "(empty task)"}`);

    const running = new Set<string>();      // node ids currently executing
    const runningByParent = new Map<string, Set<string>>();

    // ── Loops ───────────────────────────────────────────────────────────────
    // A loop node repeats a step `config.count` times, one pass after another.
    // Its **Repeat** output names the step(s) it re-runs: those nodes, and
    // everything they reach that the loop's Exit side does not own, form the
    // section. Between passes the loop hands the section the result it just
    // produced, so each pass improves the last. A loop with NO Repeat
    // connection keeps its original meaning: it repeats the section it
    // *dominates* — the nodes that exist only because the loop feeds them — and
    // that section always starts from the same material. Either way the engine
    // re-arms the section between passes instead of letting it settle once, and
    // the loop node keeps the run open until the last pass ends.
    const loopNodes = wf.nodes.filter((n: any) => n.type === "loop" && reachable.has(n.id));
    /** loop id → the nodes wired to its Repeat output (the feedback targets). */
    const loopFeedback = new Map<string, string[]>();
    for (const e of wf.edges) {
      if (e.port !== "repeat" || byId.get(e.from)?.type !== "loop" || !reachable.has(e.to)) continue;
      if (!loopFeedback.has(e.from)) loopFeedback.set(e.from, []);
      loopFeedback.get(e.from)!.push(e.to);
    }
    /** loop id → the nodes one pass of it runs (never includes the end node). */
    const loopBodies = new Map<string, string[]>();
    /** loop id → the body's terminal nodes, whose output one pass hands back. */
    const loopExits = new Map<string, string[]>();
    /** loop id → its body as a Set, for O(1) membership tests in the pump. */
    const loopBodySet = new Map<string, Set<string>>();
    for (const L of loopNodes) {
      const feedback = loopFeedback.get(L.id) || [];
      let body: string[];
      if (feedback.length) {
        // Everything the Repeat output reaches…
        const forward = new Set<string>();
        const qf = [...feedback];
        while (qf.length) {
          const id = qf.pop()!;
          if (forward.has(id)) continue;
          forward.add(id);
          for (const c of children.get(id) || []) qf.push(c);
        }
        // …minus everything the loop's **Exit** side already owns (the nodes its
        // ordinary out-connections reach), so a step on the exit path is never
        // repeated, and never the loop itself or the end node. The Repeat target
        // is the section, whether or not the graph also draws the way back.
        const exitSide = new Set<string>();
        const qe = wf.edges.filter((e: any) => e.from === L.id && e.port !== "repeat").map((e: any) => e.to);
        while (qe.length) {
          const id = qe.pop()!;
          if (exitSide.has(id)) continue;
          exitSide.add(id);
          for (const c of children.get(id) || []) qe.push(c);
        }
        body = [...forward].filter((id) => !exitSide.has(id) && id !== L.id && byId.get(id)?.type !== "end");
      } else {
        // Everything downstream of the loop…
        const downstream = new Set<string>();
        const q = [...(children.get(L.id) || [])];
        while (q.length) {
          const id = q.pop()!;
          if (downstream.has(id)) continue;
          downstream.add(id);
          for (const c of children.get(id) || []) q.push(c);
        }
        // …minus everything the start node can still reach WITHOUT going through
        // the loop. Those nodes do not exist because of the loop, so it must not
        // re-run them (and with two loops, this is exactly what makes their
        // sections disjoint and nest correctly). The end node is never repeated.
        const avoided = new Set<string>();
        const q2 = [start.id];
        while (q2.length) {
          const id = q2.pop()!;
          if (id === L.id || avoided.has(id)) continue;
          avoided.add(id);
          for (const c of children.get(id) || []) q2.push(c);
        }
        body = [...downstream].filter((id) => !avoided.has(id) && byId.get(id)?.type !== "end");
      }
      loopBodies.set(L.id, body);
      loopBodySet.set(L.id, new Set(body));
      loopExits.set(L.id, body.filter((id) => !(children.get(id) || []).some((c) => body.includes(c))));
    }
    /** Passes this run has completed, across every loop — the run-level budget. */
    let totalPasses = 0;

    /**
     * Who must settle before `node` may run. Two rules keep a feedback loop from
     * deadlocking itself:
     *   • a **repeat edge is never a dependency** — it is the loop's own output
     *     of the previous pass, not something to wait for;
     *   • a node is never gated by the **body of a loop it is not in**… which is
     *     the loop itself: a feedback loop does not wait for the step it re-runs,
     *     because it starts that step.
     * A node whose only connections are repeat edges keeps them (the loop-first
     * wiring `start → loop`, `loop.repeat → agent` is started *by* the loop), and
     * so does a loop fed only by its own section (`start → agent → loop`): that
     * first run has to happen before the loop can begin.
     */
    function effectiveDeps(node: any): string[] {
      const own = deps.get(node.id) || [];
      const ps = own.length ? own : parents.get(node.id) || [];
      const body = loopBodySet.get(node.id);
      if (!body || !body.size) return ps;
      const outside = ps.filter((p) => !body.has(p));
      return outside.length ? outside : ps;
    }

    /**
     * The innermost loop whose section contains `nodeId` — the loop a step
     * belongs to. A nested loop shadows its parent, the same way
     * `loopContextFor` picks the tightest body for `{iteration}`.
     */
    function enclosingLoop(nodeId: string): any {
      let best: any = null;
      for (const L of loopNodes) {
        const body = loopBodySet.get(L.id);
        if (!body || !body.has(nodeId)) continue;
        if (!best || (loopBodies.get(L.id)?.length || 0) <= (loopBodies.get(best.id)?.length || 0)) best = L;
      }
      return best;
    }

    /**
     * Whose output `{input}` is assembled from — every incoming connection,
     * repeat edges included (they are how a pass receives the previous pass's
     * result). A feedback loop is the one node that ignores its own section:
     * the section is what it *produces*, not what it reads.
     *
     * A node reading from a loop's section reads the **loop**, not that step's
     * raw output: the loop's own output is its final pass's result, so wiring
     * the last body step straight into the end node carries the finished loop on
     * just as the Exit output does — and, like the Exit, it waits for the loop
     * to settle rather than reading a mid-run pass. A loop that was
     * switched off never iterated, though: it is a plain wire whose input passes
     * through, so the section's own output is read as-is.
     */
    function effectiveInputs(node: any): string[] {
      const ps = parents.get(node.id) || [];
      const body = loopBodySet.get(node.id);
      const base = body && body.size && ps.some((p) => !body.has(p)) ? ps.filter((p) => !body.has(p)) : ps;
      const out: string[] = [];
      const seen = new Set<string>();
      for (const p of base) {
        // A loop already carries its whole run in its own output, so it is never
        // collapsed into a loop that encloses it.
        const owner = byId.get(p)?.type === "loop" ? null : enclosingLoop(p);
        const collapse = owner && !loopBodySet.get(owner.id)?.has(node.id) && run.nodes[owner.id]?.bypassed !== true;
        const use = collapse ? owner.id : p;
        if (seen.has(use)) continue;
        seen.add(use);
        out.push(use);
      }
      return out;
    }

    const settled = (id: string) => {
      const s = run.nodes[id].status;
      return s === "done" || s === "error" || s === "skipped" || s === "stopped";
    };
    /**
     * Whether `parent` already satisfies the child waiting on it. A loop may
     * satisfy the nodes of its **own section** as soon as it starts iterating —
     * those are the steps it drives, so they must run while it is still looping
     * (it never settles until the last pass). A node wired to the loop's
     * **Exit** output, however, has to wait for the whole loop to settle: the
     * loop's own output is only assembled once the last pass has run, so letting
     * an exit-side step start early would feed it the loop's *input* instead of
     * its result.
     */
    const provides = (id: string, child: any) => {
      if (settled(id)) return true;
      const parent = byId.get(id);
      if (parent?.type === "loop" && run.nodes[id].status === "running") {
        return loopBodySet.get(id)?.has(child.id) === true;
      }
      return false;
    };
    /** True while any loop still has passes to run — nothing may finish yet. */
    const loopBusy = () => loopNodes.some((L: any) => run.nodes[L.id].status === "running");
    /** True once every node of a loop's section has settled: one pass is done. */
    const passDone = (id: string) => (loopBodies.get(id) || []).every((b) => settled(b));
    /**
     * The loop a node is currently running inside, innermost first (the tightest
     * body wins, so a nested loop's counter shadows its parent's). Drives
     * `{iteration}`/`{iterations}`/`{loop}` and the SW_* variables.
     */
    const loopContextFor = (nodeId: string) => {
      let ctx: any = null;
      for (const L of loopNodes) {
        const s = run.nodes[L.id];
        if (s.status !== "running") continue;
        const body = loopBodies.get(L.id) || [];
        if (!body.includes(nodeId)) continue;
        if (!ctx || body.length <= ctx.size) ctx = { size: body.length, loop: L.name, iteration: s.iteration, iterations: s.iterations };
      }
      return ctx;
    };
    /** Re-arm one pass: every node in the section goes back to pending. */
    function rearmBody(ids: string[]) {
      for (const id of ids) {
        const s = run.nodes[id];
        s.status = "pending";
        s.output = "";
        s.error = "";
        s.exitCode = null;
        s.startedAt = null;
        s.finishedAt = null;
        s.bypassed = false;
        s.approval = null;
        s.decision = null;
        // A nested loop in this section re-reads its own count on the next pass.
        s.iteration = 0;
        s.iterations = 0;
        s.passes = 0;
      }
    }
    /** What one pass produced: the settled output of the loop section's terminal
     *  nodes — the finished work of the step (or steps) the loop re-runs. It is
     *  both what a feedback loop hands the next pass and, on the last pass, the
     *  loop's own output. */
    function passOutput(loopId: string) {
      return (loopExits.get(loopId) || [])
        .map((id) => run.nodes[id].output)
        .filter(Boolean)
        .join("\n\n---\n\n");
    }
    const parentsReady = (node: any) => {
      const ps = effectiveDeps(node);
      if (!ps.length) return false;
      const join = node.type === "agent" ? node.config.join : "all";
      if (join === "first") return ps.some((p) => provides(p, node));
      return ps.every((p) => provides(p, node));
    };
    const gateFree = (node: any) => {
      for (const pid of effectiveDeps(node)) {
        const parent = byId.get(pid) as any;
        if (!parent || parent.type !== "agent" || parent.config.fanout !== "serial") continue;
        if ((runningByParent.get(pid)?.size || 0) > 0) return false;
      }
      return true;
    };

    function upstreamOutput(node: any) {
      const parts: string[] = [];
      for (const pid of effectiveInputs(node)) {
        const out = run.nodes[pid]?.output;
        if (out) parts.push(String(out));
      }
      return parts.join("\n\n---\n\n").slice(0, RUN_INPUT_MAX);
    }

    function resolvePrompt(node: any) {
      const input = upstreamOutput(node);
      const tmpl = node.config.prompt && node.config.prompt.trim() ? node.config.prompt : "{input}";
      // `{iteration}`/`{iterations}`/`{loop}` are only meaningful inside a loop's
      // section; elsewhere they render empty rather than as literal braces.
      const it = loopContextFor(node.id);
      return tmpl
        .replace(/\{input\}/g, input)
        .replace(/\{task\}/g, run.task)
        .replace(/\{iteration\}/g, it ? String(it.iteration) : "")
        .replace(/\{iterations\}/g, it ? String(it.iterations) : "")
        .replace(/\{loop\}/g, it ? it.loop : "")
        .trim();
    }

    /**
     * Why this node should NOT run, or null when it should. A node is switched
     * off with `enabled: false`; otherwise its `when` gate is tested against the
     * joined output of its parents. Either way the node becomes a *pass-through*
     * at settle time: it forwards its upstream input to its children so a step
     * can be toggled or branched without cutting the graph.
     */
    function bypassReason(node: any): string | null {
      if (node.config.enabled === false) return "switched off";
      const w = node.config.when;
      if (!w || w.mode === "always") return null;
      const hay = upstreamOutput(node);
      const needle = String(w.value || "");
      const hit =
        w.mode === "contains" ? hay.includes(needle)
        : w.mode === "notContains" ? !hay.includes(needle)
        : w.mode === "equals" ? hay.trim() === needle.trim()
        : w.mode === "notEmpty" ? hay.trim().length > 0
        : true;
      if (hit) return null;
      return `gate “${w.mode}${needle ? ` ${needle}` : ""}” not met`;
    }

    function pump() {
      if (run.status !== "running" || disposed) return;
      let progressed = true;
      while (progressed) {
        progressed = false;
        // A loop whose section has settled either starts its next pass (re-arming
        // the section) or, on the last one, settles itself and lets the run go on.
        for (const L of loopNodes) {
          const s = run.nodes[L.id];
          if (s.status !== "running" || !passDone(L.id)) continue;
          const body = loopBodies.get(L.id) || [];
          // The pass that just finished: its section is settled and not re-armed
          // yet, so its terminal nodes still hold this pass's result.
          // The run's whole loop budget, spent: stop with an error rather than
          // walking a product of counts (nested loops multiply).
          if (totalPasses >= MAX_LOOP_PASSES) {
            s.status = "error";
            s.error = `the run used its whole loop budget (${MAX_LOOP_PASSES} passes) at ${L.name}`;
            s.finishedAt = Date.now();
            logLine(run, L.id, "status", `✖ ${L.name}: ${s.error}`);
            saveRun(run);
            abortRun(run, "error", `run aborted: ${L.name} hit the loop ceiling (${MAX_LOOP_PASSES})`);
            return;
          }
          const pass = passOutput(L.id);
          totalPasses++;
          if (s.iteration < s.iterations) {
            s.iteration++;
            s.passes++;
            // A feedback loop hands its section the result it just produced, so
            // each pass improves the last. A dominated-section loop keeps passing
            // the same material, exactly as before.
            if (loopFeedback.has(L.id) && pass) s.output = pass.slice(0, RUN_OUTPUT_MAX);
            rearmBody(body);
            logLine(run, L.id, "status", `↻ ${L.name} — pass ${s.iteration}/${s.iterations}`);
            saveRun(run);
          } else {
            s.status = "done";
            s.finishedAt = Date.now();
            // The loop's own output is what its **last** pass produced — the
            // finished work of the step wired to its Repeat output. It is never
            // the seed plus a log of every pass, so a node after the loop (or on
            // its Exit) reads the answer rather than the history.
            s.output = pass.slice(0, RUN_OUTPUT_MAX);
            logLine(run, L.id, "status", `✔ ${L.name} — ${s.iterations} pass${s.iterations === 1 ? "" : "es"} done`);
            saveRun(run);
          }
          progressed = true;
        }
        for (const node of wf.nodes) {
          if (node.type === "start" || !reachable.has(node.id)) continue;
          if (run.nodes[node.id].status !== "pending") continue;
          if (!parentsReady(node) || !gateFree(node)) continue;
          // The end node is a sentinel: it settles as soon as its parents do —
          // but never while a loop still has passes to run, or the run would be
          // declared finished mid-loop.
          if (node.type === "end") {
            if (loopBusy()) continue;
            const s = run.nodes[node.id];
            s.status = "done";
            s.output = upstreamOutput(node);
            s.startedAt = s.finishedAt = Date.now();
            logLine(run, node.id, "status", `✔ ${node.name} reached`);
            progressed = true;
            continue;
          }
          // Off, or gated out: settle it in place and pass the input along (for a
          // loop, that means its section runs exactly once, like a pass-through).
          const skipped = node.type === "agent" || node.type === "approval" || node.type === "loop" ? bypassReason(node) : null;
          if (skipped) {
            const s = run.nodes[node.id];
            s.status = "skipped";
            s.bypassed = true;
            s.error = "";
            s.output = upstreamOutput(node);
            s.startedAt = s.finishedAt = Date.now();
            logLine(run, node.id, "status", `⏭ ${node.name} bypassed (${skipped})`);
            progressed = true;
            continue;
          }
          // A human gate: the run parks here until a reviewer decides. It is
          // not "running" (no process is spawned) and not settled, so
          // `maybeFinish` leaves the run alone while it waits.
          if (node.type === "approval") {
            const s = run.nodes[node.id];
            s.status = "waiting";
            s.output = upstreamOutput(node);
            s.error = "";
            s.startedAt = Date.now();
            s.approval = { message: approvalMessage(node), requestedAt: Date.now() };
            logLine(run, node.id, "status", `⏸ ${node.name} awaiting approval`);
            saveRun(run);
            progressed = true;
            continue;
          }
          // A loop holds its section open: it starts iterating here, and only
          // settles once its last pass has run (see the top of this loop).
          if (node.type === "loop") {
            const s = run.nodes[node.id];
            const body = loopBodies.get(node.id) || [];
            // Nothing to repeat: no Repeat connection and no dominated section.
            // Settle it in place as a pass-through instead of burning the run's
            // whole pass budget iterating an empty section.
            if (!body.length) {
              s.status = "done";
              s.output = upstreamOutput(node).slice(0, RUN_OUTPUT_MAX);
              s.startedAt = s.finishedAt = Date.now();
              logLine(run, node.id, "status", `🔁 ${node.name} — no step is wired back to it, so it passes through`);
              saveRun(run);
              progressed = true;
              continue;
            }
            s.status = "running";
            s.startedAt = Date.now();
            s.iterations = s.iterations > 0 ? s.iterations : clamp(Math.round(Number(node.config.count)), 1, MAX_LOOPS);
            s.iteration = 1;
            s.passes = s.passes || 0;
            // Until its last pass settles, the loop carries what reached it: a
            // feedback loop overwrites this with each pass's result as it goes,
            // and the finished pass replaces it for good at the end.
            s.output = upstreamOutput(node).slice(0, RUN_OUTPUT_MAX);
            logLine(run, node.id, "status", loopFeedback.has(node.id)
              ? `🔁 ${node.name} — ${s.iterations} ${s.iterations === 1 ? "pass" : "passes"} over the step wired to its Repeat output`
              : `🔁 ${node.name} — ${s.iterations} ${s.iterations === 1 ? "pass" : "passes"} over ${body.length} node${body.length === 1 ? "" : "s"}`);
            saveRun(run);
            progressed = true;
            continue;
          }
          if (running.size >= MAX_CONCURRENT) return;
          startNode(node);
          progressed = true;
        }
      }
      maybeFinish();
    }

    /** What the reviewer reads: the node's message, with the run's own data
     *  interpolated, falling back to its note so a gate is never blank. */
    function approvalMessage(node: any) {
      const tmpl = node.config.message && node.config.message.trim() ? node.config.message : "";
      const it = loopContextFor(node.id);
      const rendered = tmpl
        .replace(/\{input\}/g, upstreamOutput(node))
        .replace(/\{task\}/g, run.task)
        .replace(/\{iteration\}/g, it ? String(it.iteration) : "")
        .replace(/\{iterations\}/g, it ? String(it.iterations) : "")
        .replace(/\{loop\}/g, it ? it.loop : "")
        .trim();
      return (rendered || node.config.description || "").slice(0, PROMPT_MAX);
    }

    /**
     * Settle a waiting gate with the reviewer's decision. Approval forwards the
     * reviewed input downstream (with the note appended when one was given); a
     * rejection fails the node, which aborts the run unless it opted into
     * `continueOnError`. Returns false when the node is not actually waiting.
     */
    function resolveApproval(nodeId: string, approve: boolean, note: string): boolean {
      const node = byId.get(nodeId) as any;
      const s = run.nodes[nodeId];
      if (run.status !== "running" || !node || !s || s.status !== "waiting") return false;
      // Keep the message the reviewer actually read — the rendered text the
      // gate's sidebar card showed, `{input}`/`{task}` already interpolated —
      // so a decided gate still shows what was reviewed. Recomputing it would be
      // the same text, but falling back to the stored template would replace the
      // material with a literal `{input}` the moment the gate is approved.
      const reviewedMessage = s.approval?.message || approvalMessage(node);
      s.approval = null;
      s.decision = { approve, note, at: Date.now(), message: reviewedMessage };
      s.finishedAt = Date.now();
      if (approve) {
        const reviewed = upstreamOutput(node);
        const withNote = note ? `${reviewed}\n\n---\n\nHuman review: ${note}` : reviewed;
        s.output = withNote.slice(0, RUN_OUTPUT_MAX);
        s.status = "done";
        s.error = "";
        logLine(run, nodeId, "status", `✔ ${node.name} approved${note ? ` — \u201c${note}\u201d` : ""}`);
      } else {
        s.status = "error";
        s.error = note ? `rejected: ${note}` : "rejected by the user";
        logLine(run, nodeId, "status", `✖ ${node.name} rejected${note ? ` — \u201c${note}\u201d` : ""}`);
        if (node.config.continueOnError !== true) {
          abortRun(run, "error", `run aborted: ${node.name} was rejected`);
          return true;
        }
      }
      saveRun(run);
      pump();
      return true;
    }
    // The approve/reject route runs outside this closure, so the engine hands it
    // the resume hook for the run it owns.
    run.resolveApproval = resolveApproval;

    function startNode(node: any) {
      const s = run.nodes[node.id];
      s.status = "running";
      s.startedAt = Date.now();
      running.add(node.id);
      // Registered under the node's *dependencies*, so `gateFree` (which reads
      // the same list) sees exactly the children it knows about.
      const nodeDeps = effectiveDeps(node);
      for (const pid of nodeDeps) {
        if (!runningByParent.has(pid)) runningByParent.set(pid, new Set());
        runningByParent.get(pid)!.add(node.id);
      }
      logLine(run, node.id, "status", `▶ ${node.name} (${node.config.harness})`);
      void runNode(node).finally(() => {
        running.delete(node.id);
        for (const pid of nodeDeps) runningByParent.get(pid)?.delete(node.id);
        s.finishedAt = Date.now();
        logLine(run, node.id, "status", s.status === "done" ? `✔ ${node.name}` : `✖ ${node.name}: ${s.error || s.status}`);
        if (s.status === "error" && !node.config.continueOnError) {
          abortRun(run, "error", `run aborted: ${node.name} failed`);
          return;
        }
        pump();
      });
    }

    /**
     * Run a node's agent, retrying a failure up to the node's `retries` (with
     * `retryDelaySec` between attempts) before the run treats it as an error.
     * Only the *last* attempt's output/error is kept, and each retry is logged, so
     * a flaky harness is visible in the run log rather than swallowed.
     */
    async function runNode(node: any) {
      const s = run.nodes[node.id];
      // The node's user message leads in a `<user query>` tag, then its
      // reference files (paths + a description of each) follow in a
      // `<reference files/folder>` tag — the query first, then the material it
      // points at. Every harness gets the same text, since this is the prompt
      // itself, not one CLI's flag.
      const refs = buildRefBlock(node.config.refs);
      if (refs.missing.length) {
        logLine(run, node.id, "status", `⚠ reference file(s) not found: ${refs.missing.join(", ")}`);
      }
      const userMessage = resolvePrompt(node);
      // The message is tagged so the model can tell the person's ask from the
      // material it points at: the query in `<user query>`, then the reference
      // files/folders in `<reference files/folder>` (only when there are any).
      // An empty message stays empty — the tags are framing, so framing nothing
      // would turn "this node has no prompt" into a run that spawns an agent to
      // answer `<user query></user query>`; the Pi runner reports the emptiness
      // instead ("the prompt is empty").
      const queryTag = userMessage.trim() ? `<user query>\n${userMessage}\n</user query>` : "";
      const prompt = refs.block
        ? `${queryTag ? `${queryTag}\n\n` : ""}<reference files/folder>\n${refs.block}\n</reference files/folder>`
        : queryTag;
      const cwd = resolveNodeCwd(node);
      const attempts = 1 + (Number.isFinite(node.config.retries) ? node.config.retries : 0);
      for (let attempt = 1; attempt <= attempts; attempt++) {
        if (run.status !== "running" || disposed) return;
        let result: { text: string; code: number | null; error?: string };
        try {
          result = node.config.harness === "pi"
            ? await runPiHarness(node, prompt, cwd, s)
            : await runCliHarness(node, prompt, cwd, s);
        } catch (err: any) {
          result = { text: s.output || "", code: null, error: String(err?.message ?? err) };
        }
        s.output = String(result.text || "").slice(0, RUN_OUTPUT_MAX);
        s.exitCode = result.code ?? 0;
        if (!result.error) { s.status = "done"; s.error = ""; return; }
        s.error = result.error;
        // The node only *becomes* an error once its attempts are spent; while it
        // still has a retry left it stays running, so the canvas badge does not
        // flash red between attempts.
        if (attempt >= attempts) { s.status = "error"; return; }
        s.status = "running";
        const wait = node.config.retryDelaySec || 0;
        logLine(run, node.id, "status", `↻ ${node.name} failed (${result.error}) — retrying, attempt ${attempt + 1}/${attempts}${wait ? ` in ${wait}s` : ""}`);
        if (wait) await delay(wait * 1000);
      }
    }

    function resolveNodeCwd(node: any) {
      if (node.config.cwd) {
        const abs = validateCwd(node.config.cwd);
        if (abs) return abs;
      }
      const ws = validateCwd(run.workspace);
      return ws || run.workspace || process.cwd();
    }

    /** Run a PATH harness (or a custom shell command), streaming its output. */
    function runCliHarness(node: any, prompt: string, cwd: string, s: any): Promise<{ text: string; code: number | null; error?: string }> {
      return new Promise((resolve) => {
        // The node's capability selection always rides along as env vars (a
        // `custom` shell command can use them); a harness that has a real flag
        // for one of them also gets it as an argument below. Inside a loop's
        // section the pass counter is exported too, so a command can act on it.
        const it = loopContextFor(node.id);
        const env = {
          ...process.env,
          SW_PROMPT: prompt, SW_TASK: run.task, SW_NODE: node.name, SW_WORKFLOW: wf.name,
          SW_MODEL: node.config.model || "",
          SW_ITERATION: it ? String(it.iteration) : "",
          SW_ITERATIONS: it ? String(it.iterations) : "",
          SW_LOOP: it ? it.loop : "",
          // The node's reference files, one path per entry (already part of
          // $SW_PROMPT, which carries each with its description).
          SW_REFS: (node.config.refs || []).map((r: any) => r.path).join(","),
          SW_SKILLS: (node.config.skills || []).join(","),
          SW_TOOLS: (node.config.tools || []).join(","),
          SW_EXTENSIONS: (node.config.extensions || []).join(","),
        };
        let cmd: string;
        let args: string[];
        // Whether this node's prompt travels on the child's stdin instead of the
        // command line (a `promptStdin` harness — see HARNESSES.opencode).
        let promptOnStdin = false;
        if (node.config.harness === "custom") {
          // A custom node is a shell one-liner, so it runs through the platform's
          // shell — `$SHELL -c` on POSIX, the command processor on Windows, where
          // the node's variables are `%SW_PROMPT%`-style (see DEFAULT_CUSTOM_COMMAND
          // and the hint in the node's settings popup).
          const template = node.config.command && node.config.command.trim() ? node.config.command : DEFAULT_CUSTOM_COMMAND;
          const plan = planCommand(template.replace(/\{prompt\}/g, prompt).replace(/\{task\}/g, run.task));
          cmd = plan.file;
          args = plan.args;
        } else {
          const spec = allHarnesses()[node.config.harness] as any;
          if (!spec || !spec.bin) { resolve({ text: "", code: null, error: `unknown harness: ${node.config.harness}` }); return; }
          // A stdin harness is launched with no message at all: its prompt is
          // written to the pipe below, where a multi-line prompt cannot be lost.
          promptOnStdin = !!spec.promptStdin;
          args = spec.args(promptOnStdin ? "" : prompt);
          if (node.config.model && spec.modelFlag) args = [...args, spec.modelFlag, node.config.model];
          if (node.config.extraArgs) args = [...args, ...splitArgs(node.config.extraArgs)];
          args = [...args, ...capabilityArgs(spec, node.config)];
          // Launch the binary the host resolved to an absolute path, not the bare
          // name: on Windows that is how a `claude.cmd`/`codex.cmd` is found at all
          // (and on every platform it pins the one this node was validated against).
          // A Settings → Plugins override wins; if one is set but does not resolve,
          // fail clearly instead of running whatever PATH happens to hold.
          const override = harnessBins()[node.config.harness];
          cmd = resolveHarness(node.config.harness, spec) || "";
          if (!cmd) {
            resolve({ text: "", code: null, error: override
              ? `the configured binary for ${node.config.harness} is not executable: ${override}`
              : `${spec.bin} was not found on PATH — install it, or set a binary path in Settings → Plugins → Workflow` });
            return;
          }
        }

        let child: any;
        try {
          // spawnCli owns the platform's launch rules: a `.cmd` shim is run
          // through cmd.exe with every argument escaped, a real image is spawned
          // directly, and POSIX is unchanged. A stdin harness needs that pipe to
          // exist (`ignore` leaves it closed, and it would read nothing).
          child = spawnCli(cmd, args, { cwd, env, stdio: [promptOnStdin ? "pipe" : "ignore", "pipe", "pipe"] });
        } catch (err: any) {
          resolve({ text: "", code: null, error: `failed to spawn ${cmd}: ${err?.message ?? err}` });
          return;
        }
        run.children.add(child);
        // Hand a stdin harness its prompt and close the pipe, so it starts on it
        // at once instead of waiting for input that will never come. A command
        // that exits before reading the prompt closes the pipe under us; with the
        // listener in place that is a no-op, not an unhandled EPIPE that would
        // take the whole server down.
        if (promptOnStdin) {
          child.stdin?.on("error", () => { /* the harness exited before reading it */ });
          child.stdin?.end(prompt);
        }
        let output = "";
        let errBuf = "";
        let timedOut = false;
        const timer = node.config.timeoutSec
          ? setTimeout(() => { timedOut = true; killTree(child, "SIGKILL"); }, node.config.timeoutSec * 1000)
          : null;

        /**
         * Read one of the child's readable streams as whole log lines.
         *
         * A harness writes *bytes*, not strings: one UTF-8 character (the em-dash
         * in an agent's sentence, an emoji) can be cut in half by a chunk
         * boundary, so the chunk goes through a streaming TextDecoder rather than
         * `toString()` — otherwise the halves decode as `�` and the message shows
         * a replacement character where the author wrote an em-dash. A *line* can
         * be cut the same way, so the text after the last newline waits for the
         * rest of its line instead of being logged as a fragment of one: opencode
         * writes `\u001b[0m` and then `◈ Web Search …`, which used to land in the
         * sidebar as a row holding nothing but an escape sequence and another
         * starting mid-sentence.
         */
        const consume = (stream: string) => {
          const decoder = new TextDecoder();
          let pending = "";
          const feed = (data: Buffer) => {
            const text = decoder.decode(data, { stream: true });
            // The node's *output* is what the harness published on stdout: the
            // answer the messages sidebar shows as the agent's words and the
            // text a downstream node is handed as `{input}`. stderr is the
            // harness's own chatter — opencode's `> build · model` banner and
            // its `◈` / `%` tool rows arrive there — and is kept for the log
            // and the failure report, never folded into the answer.
            if (stream === "stderr") errBuf = (errBuf + text).slice(-8000);
            else { output = (output + text).slice(-RUN_OUTPUT_MAX); s.output = cleanRunText(output); }
            pending += text;
            let nl: number;
            while ((nl = pending.indexOf("\n")) >= 0) {
              logLine(run, node.id, stream, pending.slice(0, nl));
              pending = pending.slice(nl + 1);
            }
          };
          // A command that ends mid-line (`printf`, a harness killed on its last
          // line) still reports that line — with any character or escape sequence
          // the decoder was still holding.
          const flush = () => {
            const rest = pending + decoder.decode();
            pending = "";
            if (rest.trim()) logLine(run, node.id, stream, rest);
          };
          return { feed, flush };
        };
        const out = consume("stdout"), err = consume("stderr");
        child.stdout?.on("data", out.feed);
        child.stderr?.on("data", err.feed);
        const flush = () => { out.flush(); err.flush(); };
        child.on("error", (fail: any) => {
          if (timer) clearTimeout(timer);
          run.children.delete(child);
          flush();
          resolve({ text: cleanRunText(output), code: null, error: `failed to run ${cmd}: ${fail?.message ?? fail}` });
        });
        child.on("close", (code: number | null) => {
          if (timer) clearTimeout(timer);
          run.children.delete(child);
          flush();
          const error = timedOut ? `timed out after ${node.config.timeoutSec}s`
            : code === 0 ? undefined
            : (errorFromStderr(errBuf) || `exited with code ${code}`);
          resolve({ text: cleanRunText(output), code, error });
        });
      });
    }

    /**
     * pi's `--skill` and `--extension` take *paths*, so this node's selected
     * skill directories / extension entries are resolved against the host's
     * agent dir and only the ones that exist are passed. Without the agent dir
     * (an older host) the selection is reported and skipped rather than resolved
     * against some other directory.
     */
    function piCapabilityOpts(node: any): { skills?: string[]; tools?: string[]; extensions?: string[] } {
      const skills = (node.config.skills || []).map((n: string) => path.join(agentDir, "skills", n));
      const extensions = (node.config.extensions || [])
        .map((e: string) => (path.isAbsolute(e) ? e : path.join(agentDir, e)));
      const present = (p: string) => { try { fs.statSync(p); return true; } catch { return false; } };
      return {
        skills: skills.filter(present),
        tools: node.config.tools || [],
        extensions: extensions.filter(present),
      };
    }

    /** Run the app's own Pi agent through the host chat runner. */
    async function runPiHarness(node: any, prompt: string, cwd: string, s: any): Promise<{ text: string; code: number | null; error?: string }> {
      if (typeof api.kit.startChat !== "function") return { text: "", code: null, error: "the host has no chat runner" };
      const sessionId = `wf_${run.id}_${node.id}`;
      // Report the model this node will run *before* anything can fail: a bare
      // id that the catalogue pins to one provider is qualified (so pi accepts
      // it), and one that several providers offer is named here rather than
      // only in pi's own error.
      const chosen = qualifyPiModel(node.config.model);
      if (chosen.note) logLine(run, node.id, "status", chosen.note);
      if (chosen.warn) logLine(run, node.id, "status", chosen.warn);
      // Report what this node asked for before anything can fail, so a node that
      // does not run still says which skills/extensions it was configured with.
      const wantsCaps = (node.config.skills || []).length || (node.config.extensions || []).length;
      const caps = agentDir ? piCapabilityOpts(node) : null;
      if (wantsCaps) {
        if (caps) {
          const missing = wantsCaps - ((caps.skills?.length || 0) + (caps.extensions?.length || 0));
          if (missing > 0) logLine(run, node.id, "status", `⚠ ${missing} selected skill/extension path(s) not found in ${agentDir}`);
        } else {
          logLine(run, node.id, "status", "◦ skills/extensions ignored: the host did not report its agent dir");
        }
      }
      if (!prompt.trim()) return { text: "", code: null, error: "the prompt is empty" };
      let res: any;
      try {
        res = api.kit.startChat({
          cwd, model: chosen.model, prompt, sessionId,
          // Feature-detected: a host whose chat runner predates per-run
          // capabilities ignores these, and the node still runs.
          ...(caps || {}),
        });
      } catch (err: any) {
        return { text: "", code: null, error: String(err?.message ?? err) };
      }
      if (!res || !res.ok || !res.body) return { text: "", code: null, error: "chat runner refused the prompt" };
      run.sessions.add(sessionId);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let text = "";
      let error: string | undefined;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev: any = null;
          try { ev = JSON.parse(line); } catch { continue; }
          if (!ev) continue;
          if (ev.type === "text" && ev.delta) { text += ev.delta; logLine(run, node.id, "stdout", String(ev.delta).trim()); }
          else if (ev.type === "final" && typeof ev.text === "string") text = ev.text;
          else if (ev.type === "tool_start" && ev.name) logLine(run, node.id, "tool", `⚙ ${ev.name}`);
          else if (ev.type === "error") { error = String(ev.message ?? "agent error"); logLine(run, node.id, "stderr", error); }
          else if (ev.type === "done") { if (ev.error) error = String(ev.error); }
        }
      }
      run.sessions.delete(sessionId);
      s.output = text.slice(-RUN_OUTPUT_MAX);
      return { text, code: error ? 1 : 0, error };
    }

    function maybeFinish() {
      if (run.status !== "running") return;
      if (running.size > 0) return;
      // A loop between passes spawns no process, so it is not in `running` — but
      // the run is not over until its section has run its last pass.
      if (loopBusy()) return;
      const end = wf.nodes.find((n: any) => n.type === "end");
      const endSettled = !!(end && reachable.has(end.id) && settled(end.id));
      // "Unsettled" covers a node that is still eligible *and* one parked on an
      // approval gate — otherwise a paused run would be declared finished.
      const anyUnsettled = wf.nodes.some((n: any) => {
        if (!reachable.has(n.id)) return false;
        const st = run.nodes[n.id].status;
        return st === "pending" || st === "waiting";
      });
      if (!endSettled && anyUnsettled) return; // something is still eligible; pump handles it
      const anyError = Object.values(run.nodes).some((s: any) => s.status === "error");
      run.status = anyError ? "error" : "done";
      run.finishedAt = Date.now();
      logLine(run, null, "status", anyError ? "✖ run finished with errors" : endSettled ? "✔ run finished" : "run finished (no end node reached)");
      saveRun(run);
    }

    pump();
  }

  api.onDispose?.(() => {
    disposed = true;
    if (triggerTimer) { clearInterval(triggerTimer); triggerTimer = null; }
    for (const run of RUNS.values()) if (run.status === "running") abortRun(run, "stopped", "plugin disabled");
  });

  // ─── Routes ─────────────────────────────────────────────────────────────

  api.route("GET", "/subagent-workflow", (ctx: any) => {
    const workspace = workspaceOf(ctx.url.searchParams.get("cwd"));
    return {
      ...readState(workspace), workspace,
      run: publicRun(RUNS.get(workspace)),
      history: readHistory(workspace).map(summariseRun),
      triggers: triggersFor(workspace),
    };
  });

  api.route("GET", "/subagent-workflow/triggers", (ctx: any) => {
    const workspace = workspaceOf(ctx.url.searchParams.get("cwd"));
    return { workspace, triggers: triggersFor(workspace) };
  });

  api.route("POST", "/subagent-workflow/triggers", async (ctx: any) => {
    let body: any;
    try { body = await parseBody(ctx); } catch { return jsonResponse({ error: "invalid JSON" }, 400); }
    const workspace = workspaceOf(body?.cwd);
    const previous = readTriggerConfig(workspace);
    const next = normaliseTriggerConfig({
      schedule: body?.schedule,
      event: body?.event,
      task: body?.task,
      // A freshly saved schedule starts counting from now, so saving a trigger
      // never fires a run on the next tick.
      lastScheduleAt: Date.now(),
      lastEventAt: previous?.lastEventAt || 0,
    });
    writeTriggerConfig(workspace, next);
    const others = indexedWorkspaces().filter((w) => w !== workspace);
    writeIndex(triggerArmed(next) ? [...others, workspace] : others);
    syncTriggerTimer();
    return jsonResponse({ workspace, triggers: publicTrigger(next) });
  });

  // The run history: a list of summaries, or one run's full record with `?id=`.
  api.route("GET", "/subagent-workflow/history", (ctx: any) => {
    const workspace = workspaceOf(ctx.url.searchParams.get("cwd"));
    const list = readHistory(workspace);
    const id = ctx.url.searchParams.get("id");
    if (!id) return { workspace, history: list.map(summariseRun) };
    const rec = list.find((r) => r && r.id === id);
    if (!rec) return jsonResponse({ error: "no such run" }, 404);
    return { workspace, run: rec };
  });

  // `platform` rides along so the node's settings popup can say `$SW_PROMPT` or
  // `%SW_PROMPT%` — a custom command is the one thing a user types per platform.
  api.route("GET", "/subagent-workflow/harnesses", () => ({
    harnesses: harnessList(), platform: process.platform,
  }));

  /**
   * The models a provider's own CLI reports, for a node's Model dropdown (see
   * `cliModelsFor`). A harness with no models command answers with an empty list
   * and a null `source`: there is nothing to ask, and the dropdown keeps offering
   * the list the harness declares.
   */
  api.route("GET", "/subagent-workflow/models", async (ctx: any) => {
    const id = String(ctx.url.searchParams.get("harness") ?? "").trim();
    if (!allHarnesses()[id]) return jsonResponse({ error: `unknown harness: ${id || "(none)"}` }, 400);
    return cliModelsFor(id);
  });

  /**
   * Point one harness at a binary, or clear the override. `path` is an absolute
   * executable (or a bare command name resolved on PATH); an empty `path`
   * restores auto-detection. Global, because a harness lives on the machine, not
   * in one workspace. Validation is immediate, so a wrong path is refused here
   * rather than surfacing later as a failed node. Returns the refreshed list.
   */
  api.route("POST", "/subagent-workflow/harness-paths", async (ctx: any) => {
    let body: any;
    try { body = await parseBody(ctx); } catch { return jsonResponse({ error: "invalid JSON" }, 400); }
    const id = String(body?.harness ?? "").trim();
    const spec = allHarnesses()[id];
    if (!spec || !spec.bin) return jsonResponse({ error: `unknown harness: ${id || "(none)"}` }, 400);
    const raw = String(body?.path ?? "").trim();
    if (raw.length > BIN_PATH_MAX) {
      return jsonResponse({ error: `the path may be up to ${BIN_PATH_MAX} characters` }, 400);
    }
    // Mutate the RAW stored map, never the filtered view `harnessBins()` returns:
    // a write must not silently drop a key the user set — even one whose path is
    // temporarily unresolvable, or whose harness id we no longer recognise — just
    // because it is not part of the effective map right now.
    const stored = api.store.get(BINS_KEY, {});
    const bins: Record<string, any> = stored && typeof stored === "object" ? { ...stored } : {};
    if (!raw) {
      delete bins[id];
    } else {
      const isPath = raw.includes("/") || raw.includes("\\");
      if (isPath ? !executableAt(raw) : !which(raw, resolveBin)) {
        return jsonResponse({ error: `no executable at ${raw}` }, 400);
      }
      bins[id] = raw;
    }
    api.store.set(BINS_KEY, bins);
    pruneBins(); // an override for a harness that no longer has a binary goes too
    harnessCache = null; // availability just changed — never serve a stale list
    return jsonResponse({ harnesses: harnessList(), platform: process.platform });
  });

  /**
   * Define, edit or remove a harness of the user's own — a name and a binary,
   * plus an optional argument template (with a `{prompt}` placeholder) and the
   * models it offers (shown in the node's Model dropdown). The id is a slug of
   * the name; a built-in id is reserved. Global, like the binary overrides.
   * Returns the refreshed harness list.
   */
  api.route("POST", "/subagent-workflow/user-harnesses", async (ctx: any) => {
    let body: any;
    try { body = await parseBody(ctx); } catch { return jsonResponse({ error: "invalid JSON" }, 400); }
    const list = userHarnesses();
    const action = String(body?.action ?? "save");

    if (action === "remove") {
      const id = String(body?.id ?? "").trim();
      api.store.set(USER_HARNESS_KEY, list.filter((h) => h.id !== id));
      pruneBins(); // the removed harness's binary override goes with it
      harnessCache = null;
      return jsonResponse({ harnesses: harnessList(), platform: process.platform });
    }
    if (action !== "save") return jsonResponse({ error: `unknown action: ${action}` }, 400);

    // The id is stable once created (an edit sends it back); a new harness's id is
    // the slug of its name, so renaming never orphans the nodes that use it.
    // Contract: `save` with an `id` updates that harness; without one it creates
    // (or, when the name already slugs to that id, updates) — the same name always
    // resolves to the same id, so a repeat never duplicates a harness.
    const name = collapse(body?.name).slice(0, HARNESS_LABEL_MAX);
    const id = String(body?.id ?? "").trim() || slug(name);
    const bin = String(body?.bin ?? "").trim();
    const args = String(body?.args ?? "").trim().slice(0, HARNESS_ARGS_MAX) || DEFAULT_HARNESS_ARGS;
    const models = parseModels(body?.models);
    // A harness that offers models needs a way to be handed one; `--model` is the
    // convention every CLI harness here follows, so it is the default when a model
    // list is given and no flag is set.
    const modelFlag = collapse(body?.modelFlag).slice(0, 64) || (models.length ? "--model" : "");

    if (!HARNESS_ID_RE.test(id)) {
      return jsonResponse({ error: `give the harness a name with at least one letter or digit (id: "${id}")` }, 400);
    }
    if (HARNESSES[id]) return jsonResponse({ error: `"${id}" is a built-in harness` }, 400);
    if (!bin) return jsonResponse({ error: "a binary is required" }, 400);
    if (bin.length > BIN_PATH_MAX) return jsonResponse({ error: `the binary may be up to ${BIN_PATH_MAX} characters` }, 400);
    const isPath = bin.includes("/") || bin.includes("\\");
    if (isPath ? !executableAt(bin) : !which(bin, resolveBin)) {
      return jsonResponse({ error: `no executable at ${bin}` }, 400);
    }
    const entry = { id, label: name || id, bin, args, models, modelFlag };
    const next = list.some((h) => h.id === id) ? list.map((h) => (h.id === id ? entry : h)) : [...list, entry];
    if (next.length > USER_HARNESS_MAX) {
      return jsonResponse({ error: `at most ${USER_HARNESS_MAX} custom harnesses` }, 400);
    }
    api.store.set(USER_HARNESS_KEY, next);
    harnessCache = null;
    return jsonResponse({ harnesses: harnessList(), platform: process.platform });
  });

  /**
   * One folder of the workspace, for the reference browser: folders first, then
   * files, hidden entries skipped. `path` is relative to the workspace and may
   * not escape it — the browser walks down from the root and nothing else, so a
   * reference is picked from the same tree the node will run in.
   */
  api.route("GET", "/subagent-workflow/entries", (ctx: any) => {
    const workspace = workspaceOf(ctx.url.searchParams.get("cwd"));
    const root = validateCwd(workspace) || workspace;
    const rel = String(ctx.url.searchParams.get("path") ?? "").trim();
    const target = rel ? path.resolve(root, rel) : root;
    if (target !== root && !target.startsWith(root + path.sep)) {
      return jsonResponse({ error: "outside the workspace" }, 400);
    }
    let dirents: any[];
    try { dirents = fs.readdirSync(target, { withFileTypes: true }); }
    catch { return jsonResponse({ error: `cannot read ${rel || "the workspace"}` }, 400); }
    const entries = dirents
      .filter((e: any) => !e.name.startsWith("."))
      .map((e: any) => {
        const abs = path.join(target, e.name);
        let dir = e.isDirectory();
        if (!dir && e.isSymbolicLink()) { try { dir = fs.statSync(abs).isDirectory(); } catch { /* broken link */ } }
        return { name: e.name, rel: path.relative(root, abs).split(path.sep).join("/"), dir };
      })
      .sort((a: any, b: any) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
      .slice(0, 500);
    return {
      workspace: root,
      path: target,
      rel: path.relative(root, target).split(path.sep).join("/"),
      entries,
    };
  });

  api.route("GET", "/subagent-workflow/run", (ctx: any) => {
    const workspace = workspaceOf(ctx.url.searchParams.get("cwd"));
    const sinceRaw = ctx.url.searchParams.get("since");
    const since = sinceRaw === null || sinceRaw === "" ? null : Number(sinceRaw);
    return { workspace, run: publicRun(RUNS.get(workspace), since) };
  });

  api.route("POST", "/subagent-workflow/run", async (ctx: any) => {
    let body: any;
    try { body = await parseBody(ctx); } catch { return jsonResponse({ error: "invalid JSON" }, 400); }
    const workspace = workspaceOf(body?.cwd);
    const action = String(body?.action ?? "");
    if (action === "start") {
      // There is no run-level task box any more: an explicit task (a trigger, or
      // an API client) still wins, and otherwise the run's material is the start
      // node's own default task — each node's message is its real prompt.
      const task = multiline(body.task).slice(0, PROMPT_MAX) || startNodeTask(workspace);
      try {
        const run = await startRun(workspace, task);
        return jsonResponse({ workspace, run: publicRun(run) });
      } catch (err: any) {
        return jsonResponse({ error: String(err?.message ?? err) }, 409);
      }
    }
    if (action === "stop") {
      const stopped = stopRun(workspace);
      return jsonResponse({ workspace, stopped, run: publicRun(RUNS.get(workspace)) });
    }
    if (action === "approve" || action === "reject") {
      const run = RUNS.get(workspace);
      if (!run || run.status !== "running") {
        return jsonResponse({ error: "no run is waiting for a decision" }, 409);
      }
      const nodeId = String(body.nodeId ?? "").trim();
      if (!nodeId) return jsonResponse({ error: "missing nodeId" }, 400);
      const note = collapse(body.note).slice(0, NOTE_MAX);
      if (typeof run.resolveApproval !== "function") {
        return jsonResponse({ error: "this run cannot take a decision" }, 409);
      }
      if (!run.resolveApproval(nodeId, action === "approve", note)) {
        return jsonResponse({ error: "that node is not awaiting approval" }, 409);
      }
      return jsonResponse({ workspace, run: publicRun(run) });
    }
    return jsonResponse({ error: `unknown action: ${action}` }, 400);
  });

  api.route("POST", "/subagent-workflow", async (ctx: any) => {
    let body: any;
    try { body = await parseBody(ctx); } catch { return jsonResponse({ error: "invalid JSON" }, 400); }
    const workspace = workspaceOf(body?.cwd);
    const action = String(body?.action ?? "");

    switch (action) {
      case "setWorkflowName": {
        const name = collapse(body.name).slice(0, NAME_MAX);
        const state = commit(workspace, (current) => { current.name = name || "My Workflow"; return current; });
        return jsonResponse(state);
      }

      case "addNode": {
        const type = NODE_TYPES.includes(String(body.type)) ? String(body.type) : "agent";
        let full = false;
        let exists = false;
        const state = commit(workspace, (current) => {
          if (current.nodes.length >= MAX_NODES) { full = true; return current; }
          if (type === "start" && current.nodes.some((n: any) => n.type === "start")) { exists = true; return current; }
          if (type === "end" && current.nodes.some((n: any) => n.type === "end")) { exists = true; return current; }
          const node: any = {
            id: nextId("node"), type,
            name: type === "start" ? "Start" : type === "end" ? "End" : type === "approval" ? "Approval" : type === "loop" ? "Loop" : "agent",
            x: clamp(Number(body.x), 0, CANVAS_MAX), y: clamp(Number(body.y), 0, CANVAS_MAX),
          };
          node.config = type === "agent" ? normaliseAgentConfig({})
            : type === "approval" ? normaliseApprovalConfig({})
            : type === "loop" ? normaliseLoopConfig({})
            : { description: "", defaultTask: "" };
          current.nodes.push(node);
          return current;
        });
        if (full) return jsonResponse({ error: `the canvas is full (${MAX_NODES} nodes)` }, 400);
        if (exists) return jsonResponse({ error: `the workflow already has a ${type} node` }, 409);
        return jsonResponse(state);
      }

      case "updateNode": {
        const id = String(body.id ?? "").trim();
        if (!id) return jsonResponse({ error: "missing id" }, 400);
        const name = body.name == null ? null : collapse(body.name).slice(0, NAME_MAX);
        if (name != null && !name) return jsonResponse({ error: "a node needs a name" }, 400);
        let found = false;
        const state = commit(workspace, (current) => {
          const node = current.nodes.find((n: any) => n.id === id);
          if (!node) return current;
          found = true;
          if (name != null) node.name = name;
          const patch = body.config && typeof body.config === "object" ? body.config : null;
          if (patch) {
            if (node.type === "agent") {
              node.config = normaliseAgentConfig({
                harness: patch.harness != null ? patch.harness : node.config.harness,
                model: patch.model != null ? patch.model : node.config.model,
                prompt: patch.prompt != null ? patch.prompt : node.config.prompt,
                command: patch.command != null ? patch.command : node.config.command,
                extraArgs: patch.extraArgs != null ? patch.extraArgs : node.config.extraArgs,
                cwd: patch.cwd != null ? patch.cwd : node.config.cwd,
                fanout: patch.fanout != null ? patch.fanout : node.config.fanout,
                join: patch.join != null ? patch.join : node.config.join,
                continueOnError: patch.continueOnError != null ? patch.continueOnError : node.config.continueOnError,
                timeoutSec: patch.timeoutSec != null ? patch.timeoutSec : node.config.timeoutSec,
                // The run guards: switching a node off, gating it on upstream
                // output, and how many times a failure is retried.
                enabled: patch.enabled != null ? patch.enabled : node.config.enabled,
                when: patch.when != null ? patch.when : node.config.when,
                retries: patch.retries != null ? patch.retries : node.config.retries,
                retryDelaySec: patch.retryDelaySec != null ? patch.retryDelaySec : node.config.retryDelaySec,
                // The node's access allowlists. Each is replaced wholesale by the
                // sidebar's checkbox set, so an empty array is a real "nothing"
                // rather than "leave as it was".
                skills: patch.skills != null ? patch.skills : node.config.skills,
                tools: patch.tools != null ? patch.tools : node.config.tools,
                extensions: patch.extensions != null ? patch.extensions : node.config.extensions,
                refs: patch.refs != null ? patch.refs : node.config.refs,
              });
            } else if (node.type === "approval") {
              node.config = normaliseApprovalConfig({
                description: patch.description != null ? patch.description : node.config.description,
                message: patch.message != null ? patch.message : node.config.message,
                enabled: patch.enabled != null ? patch.enabled : node.config.enabled,
                when: patch.when != null ? patch.when : node.config.when,
              });
            } else if (node.type === "loop") {
              node.config = normaliseLoopConfig({
                description: patch.description != null ? patch.description : node.config.description,
                count: patch.count != null ? patch.count : node.config.count,
                enabled: patch.enabled != null ? patch.enabled : node.config.enabled,
                when: patch.when != null ? patch.when : node.config.when,
              });
            } else {
              node.config = {
                description: collapse(patch.description != null ? patch.description : node.config.description).slice(0, DESC_MAX),
                defaultTask: node.type === "start" ? multiline(patch.defaultTask != null ? patch.defaultTask : node.config.defaultTask).slice(0, PROMPT_MAX) : undefined,
              };
            }
          }
          return current;
        });
        if (!found) return jsonResponse({ error: "no such node" }, 404);
        return jsonResponse(state);
      }

      case "moveNode": {
        const id = String(body.id ?? "").trim();
        if (!id) return jsonResponse({ error: "missing id" }, 400);
        let found = false;
        const state = commit(workspace, (current) => {
          const node = current.nodes.find((n: any) => n.id === id);
          if (!node) return current;
          found = true;
          node.x = clamp(Number(body.x), 0, CANVAS_MAX);
          node.y = clamp(Number(body.y), 0, CANVAS_MAX);
          return current;
        });
        if (!found) return jsonResponse({ error: "no such node" }, 404);
        return jsonResponse(state);
      }

      case "removeNode": {
        const id = String(body.id ?? "").trim();
        if (!id) return jsonResponse({ error: "missing id" }, 400);
        return jsonResponse(commit(workspace, (current) => {
          current.nodes = current.nodes.filter((n: any) => n.id !== id);
          current.edges = current.edges.filter((e: any) => e.from !== id && e.to !== id);
          return current;
        }));
      }

      case "duplicateNode": {
        const id = String(body.id ?? "").trim();
        if (!id) return jsonResponse({ error: "missing id" }, 400);
        let found = false;
        let full = false;
        const before = readState(workspace);
        const src = before.nodes.find((n: any) => n.id === id);
        if (!src) return jsonResponse({ error: "no such node" }, 404);
        // A graph has exactly one start and one end, so only the repeatable
        // kinds (agents, approval gates and loops) clone.
        if (src.type !== "agent" && src.type !== "approval" && src.type !== "loop") {
          return jsonResponse({ error: "only agent, approval and loop nodes can be duplicated" }, 409);
        }
        const state = commit(workspace, (current) => {
          const from = current.nodes.find((n: any) => n.id === id);
          if (!from) return current;
          found = true;
          if (current.nodes.length >= MAX_NODES) { full = true; return current; }
          const copy: any = { ...from, id: nextId("node"), name: `${from.name} copy`.slice(0, NAME_MAX) };
          // Deep-copy the config so an edit to the clone never touches the source.
          copy.config = JSON.parse(JSON.stringify(from.config));
          copy.x = clamp(from.x + 40, 0, CANVAS_MAX);
          copy.y = clamp(from.y + 60, 0, CANVAS_MAX);
          current.nodes.push(copy);
          return current;
        });
        if (full) return jsonResponse({ error: `the canvas is full (${MAX_NODES} nodes)` }, 400);
        if (!found) return jsonResponse({ error: "no such node" }, 404);
        return jsonResponse(state);
      }

      // ── Reference files (a node's own "read this first" list) ────────────
      // Added, described and removed one at a time rather than through the
      // panel's whole-config save: the path has to be resolved and checked on
      // the machine that will read it, which only the server can do.
      case "addRef": {
        const nodeId = String(body.nodeId ?? "").trim();
        const raw = String(body.path ?? "").trim();
        if (!nodeId) return jsonResponse({ error: "missing nodeId" }, 400);
        if (!raw) return jsonResponse({ error: "missing path" }, 400);
        if (raw.length > REF_PATH_MAX) return jsonResponse({ error: `paths may be up to ${REF_PATH_MAX} characters` }, 400);
        const node = readState(workspace).nodes.find((n: any) => n.id === nodeId);
        if (!node) return jsonResponse({ error: "no such node" }, 404);
        if (node.type !== "agent") return jsonResponse({ error: "only an agent node can be given reference files" }, 400);
        // A relative path is taken against this request's workspace and the
        // result canonicalised, so two spellings of one file cannot both be
        // added, and the run inlines a path the agent can actually open.
        const base = resolveProjectDir(body.cwd ? String(body.cwd) : null) || validateCwd(String(body.cwd || "")) || process.cwd();
        let abs: string;
        try {
          abs = fs.realpathSync(path.isAbsolute(raw) ? raw : path.resolve(base, raw));
        } catch {
          return jsonResponse({ error: `no such file or folder: ${raw}` }, 400);
        }
        // A folder is stored with a trailing separator, so the injected block
        // reads as "this is a directory" without the agent having to stat it.
        try { if (fs.statSync(abs).isDirectory() && !abs.endsWith(path.sep)) abs += path.sep; } catch { /* raced away */ }
        const refs = node.config.refs || [];
        if (refs.some((r: any) => r.path === abs)) {
          return jsonResponse({ error: "that file is already a reference of this node" }, 409);
        }
        if (refs.length >= REF_MAX) {
          return jsonResponse({ error: `a node can carry ${REF_MAX} reference files` }, 400);
        }
        const ref = { id: nextId("ref"), path: abs, note: collapse(body.note).slice(0, REF_NOTE_MAX) };
        return jsonResponse(commit(workspace, (current) => {
          const n = current.nodes.find((x: any) => x.id === nodeId);
          if (n) n.config.refs = normaliseRefs([...(n.config.refs || []), ref]);
          return current;
        }));
      }

      case "updateRef": {
        const nodeId = String(body.nodeId ?? "").trim();
        const refId = String(body.refId ?? "").trim();
        if (!nodeId || !refId) return jsonResponse({ error: "missing nodeId/refId" }, 400);
        const note = collapse(body.note).slice(0, REF_NOTE_MAX);
        let found = false;
        const state = commit(workspace, (current) => {
          const n = current.nodes.find((x: any) => x.id === nodeId);
          const ref = n && (n.config.refs || []).find((r: any) => r.id === refId);
          if (!ref) return current;
          found = true;
          if (note) ref.note = note;
          else delete ref.note;
          return current;
        });
        if (!found) return jsonResponse({ error: "no such reference" }, 404);
        return jsonResponse(state);
      }

      case "removeRef": {
        const nodeId = String(body.nodeId ?? "").trim();
        const refId = String(body.refId ?? "").trim();
        if (!nodeId || !refId) return jsonResponse({ error: "missing nodeId/refId" }, 400);
        let found = false;
        const state = commit(workspace, (current) => {
          const n = current.nodes.find((x: any) => x.id === nodeId);
          if (!n || !(n.config.refs || []).some((r: any) => r.id === refId)) return current;
          found = true;
          n.config.refs = n.config.refs.filter((r: any) => r.id !== refId);
          return current;
        });
        if (!found) return jsonResponse({ error: "no such reference" }, 404);
        return jsonResponse(state);
      }

      case "importWorkflow": {
        const raw = body.data;
        if (!raw || typeof raw !== "object" || !Array.isArray(raw.nodes)) {
          return jsonResponse({ error: "not a workflow file (expected an object with a nodes array)" }, 400);
        }
        const next = normaliseState(raw);
        if (!next.nodes.length) return jsonResponse({ error: "the file has no usable nodes" }, 400);
        if (!next.nodes.some((n: any) => n.type === "agent")) {
          return jsonResponse({ error: "the workflow has no agent node" }, 400);
        }
        if (hasCycle(next.nodes, next.edges)) {
          return jsonResponse({ error: "the workflow contains a cycle" }, 400);
        }
        // Imported edges are trimmed to the nodes that actually survived
        // normalisation, so a hand-edited file can never produce a dangling edge.
        return jsonResponse(commit(workspace, () => next));
      }

      case "addEdge": {
        const from = String(body.from ?? "").trim();
        const to = String(body.to ?? "").trim();
        if (!from || !to) return jsonResponse({ error: "missing from/to" }, 400);
        if (from === to) return jsonResponse({ error: "a node cannot connect to itself" }, 400);
        // A `repeat` connection is the loop's feedback output — the only edge
        // that may close a cycle, because the loop engine owns that cycle.
        const port = String(body.port ?? "") === "repeat" ? "repeat" : "";
        const before = readState(workspace);
        const a = before.nodes.find((n: any) => n.id === from);
        const b = before.nodes.find((n: any) => n.id === to);
        if (!a || !b) return jsonResponse({ error: "no such node" }, 404);
        if (a.type === "end") return jsonResponse({ error: "the end node has no outgoing connections" }, 400);
        if (b.type === "start") return jsonResponse({ error: "the start node has no incoming connections" }, 400);
        if (port === "repeat" && a.type !== "loop") {
          return jsonResponse({ error: "only a loop node has a repeat output" }, 400);
        }
        if (port === "repeat" && b.type === "end") {
          return jsonResponse({ error: "a loop cannot repeat the end node" }, 400);
        }
        // Start and end are allowed any number of connections: everything wired
        // off the start runs in parallel (up to the run's concurrency limit) and
        // the end waits for all of its parents, so a fan-out / fan-in graph is
        // just a matter of drawing it.
        if (before.edges.some((e: any) => e.from === from && e.to === to)) {
          return jsonResponse({ error: "those nodes are already connected" }, 409);
        }
        // A repeat edge is exempt: it is meant to close the loop's own cycle.
        if (port !== "repeat" && createsCycle(before.nodes, before.edges, from, to)) {
          return jsonResponse({ error: "that connection would create a cycle" }, 400);
        }
        const state = commit(workspace, (current) => {
          current.edges.push({ id: nextId("edge"), from, to, ...(port ? { port } : {}) });
          return current;
        });
        return jsonResponse(state);
      }

      case "removeEdge": {
        const id = String(body.id ?? "").trim();
        if (!id) return jsonResponse({ error: "missing id" }, 400);
        return jsonResponse(commit(workspace, (current) => {
          current.edges = current.edges.filter((e: any) => e.id !== id);
          return current;
        }));
      }

      default:
        return jsonResponse({ error: `unknown action: ${action}` }, 400);
    }
  });

  // Start the schedule ticker if any workspace booted with a trigger armed.
  syncTriggerTimer();
}
