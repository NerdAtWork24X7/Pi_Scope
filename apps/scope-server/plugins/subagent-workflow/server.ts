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
 *   GET  /subagent-workflow?cwd=<workspace>            → graph snapshot + run
 *   GET  /subagent-workflow/harnesses                  → harness list + availability
 *   GET  /subagent-workflow/run?cwd=<workspace>        → the workspace's live run
 *   POST /subagent-workflow { action, cwd, … }         → graph edits
 *   POST /subagent-workflow/run { action, cwd, task }  → start / stop a run
 *
 * Graph edits: `setWorkflowName`, `addNode`, `updateNode`, `moveNode`,
 * `removeNode`, `addEdge`, `removeEdge`. Every edit is validated server-side:
 * one start / one end node, no self-loops, no duplicate edges, no edges into the
 * start or out of the end, and no cycles.
 *
 * ── Execution model ─────────────────────────────────────────────────────────
 * A run walks the graph from the start node. A node runs the chosen harness in
 * the workspace with a prompt built from its own template, where `{input}` is
 * the joined output of its upstream nodes and `{task}` is the run's task. An
 * agent node runs once its parents have settled (`join: all`, the default, or
 * `join: first`); a node's `fanout` setting decides whether its children run in
 * parallel or one after another. Output flows along the edges; `end` finishes
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
 * The plugin is self-contained: it imports only `node:*`, so the same directory
 * installs as a plain **user** plugin (`cp -r apps/scope-server/plugins/
 * subagent-workflow ~/.pi-scope/plugins/`), overriding the built-in by id.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** Node kinds. */
const NODE_TYPES = ["start", "agent", "end"];
/** Where the graph lives in the plugin store: `{ [workspace]: graph }`. */
const KEY = "workspaces";

const MAX_NODES = 200;
const MAX_EDGES = 400;
const NAME_MAX = 60;
const DESC_MAX = 300;
const PROMPT_MAX = 20000;
const MODEL_MAX = 120;
const CWD_MAX = 1000;
const ARGS_MAX = 2000;
const CANVAS_MAX = 6000;

/** Live run caps. */
const MAX_CONCURRENT = 4;
const RUN_LOG_MAX = 400;
const RUN_LOG_LINE_MAX = 2000;
const RUN_OUTPUT_MAX = 200_000;
const RUN_INPUT_MAX = 20_000;

const collapse = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));
const multiline = (v) => String(v ?? "").replace(/\r\n?/g, "\n").trim();

/**
 * Built-in harnesses. `bin` is the executable looked up on PATH; `args(prompt)`
 * builds the non-interactive command; `modelFlag` names the model flag the CLI
 * understands. `pi` runs through the host's own chat runner and has no binary;
 * `custom` is a shell command the user supplies.
 *
 * `models` is the dropdown the node's Model field offers — a curated list of the
 * aliases/ids that CLI documents, NOT a hard limit: the inspector keeps a
 * "Custom…" entry for anything newer. `pi` leaves it empty because the app
 * already knows the real catalogue (`GET /models`), which the client merges in.
 *
 * `capabilities` says how a node's skills / tools / extensions selection reaches
 * that harness:
 *   { flag, style: "csv" }     → `flag a,b,c`        (one argument)
 *   { flag, style: "repeat" }  → `flag a flag b`     (one per value)
 *   null                       → the harness has no such flag; the inspector
 *                                says so instead of pretending the toggle does
 *                                something. Every selection is also exported as
 *                                `SW_SKILLS` / `SW_TOOLS` / `SW_EXTENSIONS` for
 *                                `custom` shell commands.
 *
 * Flag forms were taken from the harness's own `--help` (pi: `--tools`/
 * `--skill`/`--extension`, verified against the bundled agent) or its published
 * CLI reference (claude `--allowedTools`, gemini `--allowed-tools`).
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
    label: "opencode", bin: "opencode", args: (p: string) => ["run", p], modelFlag: "--model",
    models: ["anthropic/claude-sonnet-4-5", "openai/gpt-5", "google/gemini-2.5-pro"],
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

/** Is `bin` executable somewhere on PATH? */
function which(bin: string): string | null {
  if (!bin) return null;
  const dirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const full = path.join(dir, bin);
    try {
      if (fs.statSync(full).isFile()) { fs.accessSync(full, fs.constants.X_OK); return full; }
    } catch { /* keep looking */ }
  }
  return null;
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

function normaliseAgentConfig(raw: any) {
  const r = raw && typeof raw === "object" ? raw : {};
  const harness = HARNESSES[String(r.harness)] ? String(r.harness) : "claude";
  const timeout = Number(r.timeoutSec);
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
    // What this node's agent may use. Empty = the harness's own defaults.
    skills: normaliseCapList(r.skills, CAP_NAME_RE),
    tools: normaliseCapList(r.tools, CAP_NAME_RE),
    extensions: normaliseCapList(r.extensions, CAP_PATH_RE),
  };
}

/**
 * The arguments a harness needs to honour a node's capability selection.
 *
 * Values are passed exactly as the sidebar lists them (skill directory names,
 * tool names, extension ids); `pi` resolves them to real paths in `runPiHarness`
 * because its flags take files, not names. A capability the harness has no flag
 * for contributes nothing — the inspector marks those rows as unsupported.
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

function normaliseNode(raw: any, index: number) {
  if (!raw || typeof raw !== "object") return null;
  const type = NODE_TYPES.includes(String(raw.type)) ? String(raw.type) : null;
  if (!type) return null;
  const node: any = {
    id: String(raw.id ?? "").trim() || `node_${index}`,
    type,
    name: collapse(raw.name).slice(0, NAME_MAX) || (type === "start" ? "Start" : type === "end" ? "End" : "agent"),
    x: clamp(Number(raw.x), 0, CANVAS_MAX),
    y: clamp(Number(raw.y), 0, CANVAS_MAX),
  };
  const r = raw.config && typeof raw.config === "object" ? raw.config : {};
  if (type === "agent") node.config = normaliseAgentConfig(r);
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
    out.push({ id: String(item.id ?? "").trim() || `edge_${out.length}`, from, to });
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

function createsCycle(nodes: any[], edges: any[], from: string, to: string) {
  const adj = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) adj.get(e.from)?.push(e.to);
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

  let harnessCache: { at: number; list: any[] } | null = null;
  function harnessList() {
    if (harnessCache && Date.now() - harnessCache.at < 30_000) return harnessCache.list;
    const list = Object.entries(HARNESSES).map(([id, h]: [string, any]) => ({
      id,
      label: h.label,
      bin: h.bin,
      available: h.bin ? !!which(h.bin) : id === "custom" ? true : typeof api.kit.startChat === "function",
      modelFlag: h.modelFlag || null,
      // Suggested models for this harness. `pi` is filled in by the client from
      // the app's own catalogue (`GET /models`), which the host owns.
      models: Array.isArray(h.models) ? h.models : [],
      // Which of skills / tools / extensions this harness can be told about,
      // and the flag each maps to — `null` means "no such flag".
      capabilities: {
        skills: h.capabilities?.skills ? { flag: h.capabilities.skills.flag } : null,
        tools: h.capabilities?.tools ? { flag: h.capabilities.tools.flag } : null,
        extensions: h.capabilities?.extensions ? { flag: h.capabilities.extensions.flag } : null,
      },
    }));
    harnessCache = { at: Date.now(), list };
    return list;
  }

  // ─── The run engine ─────────────────────────────────────────────────────

  /** Live runs, keyed by workspace. One run per workspace at a time. */
  const RUNS = new Map<string, any>();
  let disposed = false;

  function logLine(run: any, nodeId: string | null, stream: string, text: string) {
    const clean = String(text ?? "").replace(/\r/g, "");
    if (!clean) return;
    run.seq++;
    run.log.push({ seq: run.seq, ts: Date.now(), nodeId, stream, text: clean.slice(0, RUN_LOG_LINE_MAX) });
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
      };
      if (!incremental) nodes[id].outputTail = s.output ? String(s.output).slice(-4000) : "";
    }
    return {
      id: run.id, status: run.status, task: run.task,
      startedAt: run.startedAt, finishedAt: run.finishedAt || null,
      seq: run.seq, nodes,
      log: incremental ? run.log.filter((l: any) => l.seq > since) : run.log.slice(-200),
      concurrency: MAX_CONCURRENT,
    };
  }

  /** Kill every process a run currently owns. */
  function killRun(run: any) {
    for (const child of run.children) { try { child.kill("SIGTERM"); } catch { /* gone */ } }
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
      else if (s.status === "running") { s.status = status === "stopped" ? "stopped" : "error"; s.finishedAt = Date.now(); }
    }
    if (reason) logLine(run, null, "status", reason);
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
    for (const n of wf.nodes) run.nodes[n.id] = { status: "pending", output: "", error: "", exitCode: null, startedAt: null, finishedAt: null };
    RUNS.set(workspace, run);
    logLine(run, null, "status", `▶ run started${task ? `: ${task}` : ""}`);
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
    for (const e of wf.edges) {
      parents.get(e.to)?.push(e.from);
      children.get(e.from)?.push(e.to);
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

    const settled = (id: string) => {
      const s = run.nodes[id].status;
      return s === "done" || s === "error" || s === "skipped" || s === "stopped";
    };
    const parentsReady = (node: any) => {
      const ps = parents.get(node.id) || [];
      if (!ps.length) return false;
      const join = node.type === "agent" ? node.config.join : "all";
      if (join === "first") return ps.some(settled);
      return ps.every(settled);
    };
    const gateFree = (node: any) => {
      for (const pid of parents.get(node.id) || []) {
        const parent = byId.get(pid) as any;
        if (!parent || parent.type !== "agent" || parent.config.fanout !== "serial") continue;
        if ((runningByParent.get(pid)?.size || 0) > 0) return false;
      }
      return true;
    };

    function upstreamOutput(node: any) {
      const parts: string[] = [];
      for (const pid of parents.get(node.id) || []) {
        const out = run.nodes[pid]?.output;
        if (out) parts.push(String(out));
      }
      return parts.join("\n\n---\n\n").slice(0, RUN_INPUT_MAX);
    }

    function resolvePrompt(node: any) {
      const input = upstreamOutput(node);
      const tmpl = node.config.prompt && node.config.prompt.trim() ? node.config.prompt : "{input}";
      return tmpl.replace(/\{input\}/g, input).replace(/\{task\}/g, run.task).trim();
    }

    function pump() {
      if (run.status !== "running" || disposed) return;
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (const node of wf.nodes) {
          if (node.type === "start" || !reachable.has(node.id)) continue;
          if (run.nodes[node.id].status !== "pending") continue;
          if (!parentsReady(node) || !gateFree(node)) continue;
          // The end node is a sentinel: it settles as soon as its parents do.
          if (node.type === "end") {
            const s = run.nodes[node.id];
            s.status = "done";
            s.output = upstreamOutput(node);
            s.startedAt = s.finishedAt = Date.now();
            logLine(run, node.id, "status", `✔ ${node.name} reached`);
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

    function startNode(node: any) {
      const s = run.nodes[node.id];
      s.status = "running";
      s.startedAt = Date.now();
      running.add(node.id);
      for (const pid of parents.get(node.id) || []) {
        if (!runningByParent.has(pid)) runningByParent.set(pid, new Set());
        runningByParent.get(pid)!.add(node.id);
      }
      logLine(run, node.id, "status", `▶ ${node.name} (${node.config.harness})`);
      void runNode(node).finally(() => {
        running.delete(node.id);
        for (const pid of parents.get(node.id) || []) runningByParent.get(pid)?.delete(node.id);
        s.finishedAt = Date.now();
        logLine(run, node.id, "status", s.status === "done" ? `✔ ${node.name}` : `✖ ${node.name}: ${s.error || s.status}`);
        if (s.status === "error" && !node.config.continueOnError) {
          abortRun(run, "error", `run aborted: ${node.name} failed`);
          return;
        }
        pump();
      });
    }

    async function runNode(node: any) {
      const s = run.nodes[node.id];
      const prompt = resolvePrompt(node);
      const cwd = resolveNodeCwd(node);
      try {
        const result = node.config.harness === "pi"
          ? await runPiHarness(node, prompt, cwd, s)
          : await runCliHarness(node, prompt, cwd, s);
        s.output = String(result.text || "").slice(0, RUN_OUTPUT_MAX);
        s.exitCode = result.code ?? 0;
        if (result.error) { s.status = "error"; s.error = result.error; }
        else s.status = "done";
      } catch (err: any) {
        s.status = "error";
        s.error = String(err?.message ?? err);
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
        // for one of them also gets it as an argument below.
        const env = {
          ...process.env,
          SW_PROMPT: prompt, SW_TASK: run.task, SW_NODE: node.name, SW_WORKFLOW: wf.name,
          SW_MODEL: node.config.model || "",
          SW_SKILLS: (node.config.skills || []).join(","),
          SW_TOOLS: (node.config.tools || []).join(","),
          SW_EXTENSIONS: (node.config.extensions || []).join(","),
        };
        let cmd: string;
        let args: string[];
        if (node.config.harness === "custom") {
          const template = node.config.command && node.config.command.trim() ? node.config.command : "echo \"$SW_PROMPT\"";
          cmd = process.env.SHELL || "/bin/sh";
          args = ["-c", template.replace(/\{prompt\}/g, prompt).replace(/\{task\}/g, run.task)];
        } else {
          const spec = HARNESSES[node.config.harness] as any;
          if (!spec || !spec.bin) { resolve({ text: "", code: null, error: `unknown harness: ${node.config.harness}` }); return; }
          args = spec.args(prompt);
          if (node.config.model && spec.modelFlag) args = [...args, spec.modelFlag, node.config.model];
          if (node.config.extraArgs) args = [...args, ...splitArgs(node.config.extraArgs)];
          args = [...args, ...capabilityArgs(spec, node.config)];
          cmd = spec.bin;
        }

        let child: any;
        try {
          child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
        } catch (err: any) {
          resolve({ text: "", code: null, error: `failed to spawn ${cmd}: ${err?.message ?? err}` });
          return;
        }
        run.children.add(child);
        let output = "";
        let errBuf = "";
        let timedOut = false;
        const timer = node.config.timeoutSec
          ? setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch { /* gone */ } }, node.config.timeoutSec * 1000)
          : null;

        const consume = (stream: string) => (data: Buffer) => {
          const text = data.toString();
          if (stream === "stderr") errBuf = (errBuf + text).slice(-8000);
          s.output = (output = (output + text).slice(-RUN_OUTPUT_MAX));
          for (const line of text.split("\n")) if (line.trim()) logLine(run, node.id, stream, line);
        };
        child.stdout?.on("data", consume("stdout"));
        child.stderr?.on("data", consume("stderr"));
        child.on("error", (err: any) => {
          if (timer) clearTimeout(timer);
          run.children.delete(child);
          resolve({ text: output, code: null, error: `failed to run ${cmd}: ${err?.message ?? err}` });
        });
        child.on("close", (code: number | null) => {
          if (timer) clearTimeout(timer);
          run.children.delete(child);
          const error = timedOut ? `timed out after ${node.config.timeoutSec}s`
            : code === 0 ? undefined
            : (errBuf.trim() || `exited with code ${code}`);
          resolve({ text: output, code, error });
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
          cwd, model: node.config.model || "", prompt, sessionId,
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
      const end = wf.nodes.find((n: any) => n.type === "end");
      const endSettled = !!(end && reachable.has(end.id) && settled(end.id));
      const anyPending = wf.nodes.some((n: any) => reachable.has(n.id) && run.nodes[n.id].status === "pending");
      if (!endSettled && anyPending) return; // something is still eligible; pump handles it
      const anyError = Object.values(run.nodes).some((s: any) => s.status === "error");
      run.status = anyError ? "error" : "done";
      run.finishedAt = Date.now();
      logLine(run, null, "status", anyError ? "✖ run finished with errors" : endSettled ? "✔ run finished" : "run finished (no end node reached)");
    }

    pump();
  }

  api.onDispose?.(() => {
    disposed = true;
    for (const run of RUNS.values()) if (run.status === "running") abortRun(run, "stopped", "plugin disabled");
  });

  // ─── Routes ─────────────────────────────────────────────────────────────

  api.route("GET", "/subagent-workflow", (ctx: any) => {
    const workspace = workspaceOf(ctx.url.searchParams.get("cwd"));
    return { ...readState(workspace), workspace, run: publicRun(RUNS.get(workspace)) };
  });

  api.route("GET", "/subagent-workflow/harnesses", () => ({ harnesses: harnessList() }));

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
      const task = multiline(body.task).slice(0, PROMPT_MAX);
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
            name: type === "start" ? "Start" : type === "end" ? "End" : "agent",
            x: clamp(Number(body.x), 0, CANVAS_MAX), y: clamp(Number(body.y), 0, CANVAS_MAX),
          };
          node.config = type === "agent" ? normaliseAgentConfig({}) : { description: "", defaultTask: "" };
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
                // The node's access allowlists. Each is replaced wholesale by the
                // sidebar's checkbox set, so an empty array is a real "nothing"
                // rather than "leave as it was".
                skills: patch.skills != null ? patch.skills : node.config.skills,
                tools: patch.tools != null ? patch.tools : node.config.tools,
                extensions: patch.extensions != null ? patch.extensions : node.config.extensions,
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

      case "addEdge": {
        const from = String(body.from ?? "").trim();
        const to = String(body.to ?? "").trim();
        if (!from || !to) return jsonResponse({ error: "missing from/to" }, 400);
        if (from === to) return jsonResponse({ error: "a node cannot connect to itself" }, 400);
        const before = readState(workspace);
        const a = before.nodes.find((n: any) => n.id === from);
        const b = before.nodes.find((n: any) => n.id === to);
        if (!a || !b) return jsonResponse({ error: "no such node" }, 404);
        if (a.type === "end") return jsonResponse({ error: "the end node has no outgoing connections" }, 400);
        if (b.type === "start") return jsonResponse({ error: "the start node has no incoming connections" }, 400);
        if (a.type === "start" && before.edges.some((e: any) => e.from === from)) {
          return jsonResponse({ error: "the start node already points at an agent" }, 409);
        }
        if (before.edges.some((e: any) => e.from === from && e.to === to)) {
          return jsonResponse({ error: "those nodes are already connected" }, 409);
        }
        if (createsCycle(before.nodes, before.edges, from, to)) {
          return jsonResponse({ error: "that connection would create a cycle" }, 400);
        }
        const state = commit(workspace, (current) => {
          current.edges.push({ id: nextId("edge"), from, to });
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
}
