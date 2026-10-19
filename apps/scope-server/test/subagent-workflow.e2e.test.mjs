// End-to-end tests for the Subagent Workflow plugin.
//
// The plugin is a standalone built-in: manifest, server (a real fan-out DAG
// runner that spawns coding harnesses) and a client bundle all live in
// plugins/subagent-workflow/. These tests run the REAL server and drive a REAL
// browser:
//
//   • discovery + the graph store + validation,
//   • the harness registry and availability,
//   • a full custom-command DAG run, with output flowing along the edges,
//   • stopping a long run,
//   • the canvas, a node's settings popup and a run started from the UI.
//
//   node --test apps/scope-server/test/subagent-workflow.e2e.test.mjs

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const SERVER = path.join(ROOT, "apps", "scope-server", "server.ts");

const TOKEN = "workflow-test-token";
const PLUGIN = "subagent-workflow";

/** The model catalogue the fixture agent dir declares (`models-store.json`), in
 *  the order the harness list reports it: `<provider>/<id>`, sorted. Two
 *  providers ship `mimo-v2.6-flash` — exactly the ambiguity pi refuses to
 *  resolve by itself — and `grok-4` has a single provider. */
const PI_MODELS = [
  "solo/solo-large",
  "tokenharbor/grok-4",
  "tokenharbor/mimo-v2.6-flash",
  "xiaomi/mimo-v2-pro",
  "xiaomi/mimo-v2.6-flash",
];
const enc = encodeURIComponent;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The runner tags the message it hands a node — `<user query>…</user query>`,
 * then a `<reference files/folder>` block — so a custom command's `$SW_PROMPT`
 * carries those tags. The graph/loop/retry fixtures below assert the *resolved
 * query* a node was handed, so they read it back out of the tag; the tag format
 * itself is covered by the reference-injection test. `QUERY` is the shell
 * command substitution that prints just that query.
 */
const QUERY = `$(printf '%s' "$SW_PROMPT" | sed '1d; /^<\\/user query>$/,$d')`;
/** A custom harness that prints `label[<the query it was handed>]`. */
const echoQuery = (label) => `printf '${label}[%s]' "${QUERY}"`;
/** `label<i>[…]`, with the loop's pass counter in front. */
const echoPassQuery = (label) => `printf '${label}%s[%s]' "$SW_ITERATION" "${QUERY}"`;

let browser;
let child;
let base;
let tmpDir;
let pluginsDir;
let ws;    // graph edit / validation / canvas
let ws2;   // run engine
let ws3;   // UI run
let ws4;   // harness flag wiring
let ws5;   // the node panel (provider + model + message)
let ws6;   // parallel vs sequential scheduling
let ws7;   // reference files (a node's injected paths)
let ws8;   // the reference browser + the messages sidebar
let stubDir;    // fake `claude` / `gemini` / `opencode` binaries, prepended to PATH
let claudeLog;  // argv the fake claude was invoked with
let geminiLog;  // argv the fake gemini was invoked with
let opencodeRuns; // how often the fake opencode ran (its `models` answer is cached)
let opencodePromptLog; // the argv + stdin the fake opencode's *run* was handed

/** A fake harness binary that records its argv and the SW_* env it was given,
 *  then prints a marker — so a node's flags can be asserted end to end. */
function writeStubHarness(dir, name, log, marker) {
  const file = path.join(dir, name);
  const script = [
    "#!/bin/sh",
    // Record the argv and the capability env the plugin handed the harness.
    "{ printf '%s\\n' \"$@\"; printf 'SW_TOOLS=%s SW_MODEL=%s\\n' \"$SW_TOOLS\" \"$SW_MODEL\"; } >> " + JSON.stringify(log),
    "printf '%s\\n' " + JSON.stringify(marker),
    "",
  ].join("\n");
  fs.writeFileSync(file, script);
  fs.chmodSync(file, 0o755);
}

/**
 * A fake `opencode` whose `models` subcommand prints a catalogue the way the real
 * CLI does — one `provider/model` per line, exit 0 — mixed with the noise a real
 * one can carry (an SGR escape, a human sentence, a blank line). Every
 * invocation appends to `runsLog`, so a test can prove the answer was cached.
 * A *run* additionally records the argv it was handed and the prompt it reads
 * from its stdin — opencode is given its message there (see the opencode stdin
 * test) — then prints a marker, so a test can see both halves of the launch.
 */
function writeModelsStubHarness(dir, runsLog, promptLog) {
  const file = path.join(dir, "opencode");
  const script = [
    "#!/bin/sh",
    `printf 'run\\n' >> ${JSON.stringify(runsLog)}`,
    `if [ "$1" = "models" ]; then`,
    `  printf 'zen/deepseek-v4.1-flash\\n'`,
    `  printf '\\033[0mzen/gpt-5\\n'`,
    `  printf 'opencode is up to date\\n'`,
    `  printf '\\n'`,
    `  printf 'local/qwen3\\n'`,
    "  exit 0",
    "fi",
    // A *run*: record the argv it was handed, then the prompt it reads off
    // stdin. `opencode run` takes its message either way, and the plugin sends
    // it on stdin on purpose — a command line cannot carry a multi-line prompt
    // on Windows (cmd.exe ends it at the first newline) and this runner's prompt
    // is always multi-line, so an argv prompt would arrive truncated.
    `{ printf 'argv: %s\\n' "$@" ; printf 'stdin: '; cat; printf '\\n'; } >> ${JSON.stringify(promptLog)}`,
    `printf 'OPENCODE_RUN_OK\\n'`,
    "exit 0",
    "",
  ].join("\n");
  fs.writeFileSync(file, script);
  fs.chmodSync(file, 0o755);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function waitForHealth(timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* not up */ }
    await sleep(250);
  }
  throw new Error("server did not become healthy");
}

async function api(pathname, init = {}) {
  const res = await fetch(`${base}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers || {}) },
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { res, data };
}

const snapshot = async (w = ws) => (await api(`/${PLUGIN}?cwd=${enc(w)}`)).data;
const act = (action, payload = {}, w = ws) =>
  api(`/${PLUGIN}`, { method: "POST", body: JSON.stringify({ action, cwd: w, ...payload }) });
const runApi = (action, payload = {}, w = ws) =>
  api(`/${PLUGIN}/run`, { method: "POST", body: JSON.stringify({ action, cwd: w, ...payload }) });
const liveRun = async (w = ws) => (await api(`/${PLUGIN}/run?cwd=${enc(w)}`)).data.run;
/** The plugin's project-scoped store: `<cwd>/.pi-scope/plugins/.data/<id>.json`. */
const storePath = (w = ws) => path.join(fs.realpathSync(w), ".pi-scope", "plugins", ".data", `${PLUGIN}.json`);

async function waitRun(w, timeoutMs = 25_000) {
  const start = Date.now();
  let run = null;
  while (Date.now() - start < timeoutMs) {
    run = await liveRun(w);
    if (run && run.status !== "running") return run;
    await sleep(120);
  }
  throw new Error(`run did not finish: ${JSON.stringify(run)?.slice(0, 400)}`);
}

/** Configure the seeded workspace into start → first → (a2, a3) → end, using
 *  custom `printf` harnesses so the run is hermetic (no external CLI). */
async function buildCustomGraph(w) {
  const s = await snapshot(w);
  const start = s.nodes.find((n) => n.type === "start");
  const first = s.nodes.find((n) => n.type === "agent");
  const end = s.nodes.find((n) => n.type === "end");

  const upd = await act("updateNode", { id: first.id, name: "first", config: {
    harness: "custom", command: echoQuery("A1"), prompt: "{task}",
  } }, w);
  assert.ok(upd.res.ok, upd.data?.error);

  const a2 = (await act("addNode", { type: "agent", x: 420, y: 460 }, w)).data.nodes.at(-1);
  const a3 = (await act("addNode", { type: "agent", x: 420, y: 620 }, w)).data.nodes.at(-1);
  for (const [node, label] of [[a2, "A2"], [a3, "A3"]]) {
    const u = await act("updateNode", { id: node.id, name: label.toLowerCase(), config: {
      harness: "custom", command: echoQuery(label), prompt: "{input}",
    } }, w);
    assert.ok(u.res.ok, u.data?.error);
  }
  for (const [from, to] of [[first.id, a2.id], [first.id, a3.id], [a2.id, end.id], [a3.id, end.id]]) {
    const e = await act("addEdge", { from, to }, w);
    assert.ok(e.res.ok, e.data?.error);
  }
  return { start, first, end, a2, a3 };
}

/** Wire a workspace into start → first → gate(approval) → last → end, with
 *  custom `printf` harnesses so a full run is hermetic. */
async function buildApprovalGraph(w) {
  const s = await snapshot(w);
  const start = s.nodes.find((n) => n.type === "start");
  const first = s.nodes.find((n) => n.type === "agent");
  const end = s.nodes.find((n) => n.type === "end");
  assert.ok((await act("updateNode", { id: first.id, name: "first", config: {
    harness: "custom", command: echoQuery("A1"), prompt: "{task}",
  } }, w)).res.ok);

  const gate = (await act("addNode", { type: "approval", x: 420, y: 200 }, w)).data.nodes.at(-1);
  assert.ok((await act("updateNode", { id: gate.id, name: "review", config: {
    description: "Plan review", message: "Please review: {input}",
  } }, w)).res.ok);
  const last = (await act("addNode", { type: "agent", x: 620, y: 200 }, w)).data.nodes.at(-1);
  assert.ok((await act("updateNode", { id: last.id, name: "last", config: {
    harness: "custom", command: echoQuery("L"), prompt: "{input}",
  } }, w)).res.ok);

  for (const e of s.edges) await act("removeEdge", { id: e.id }, w);
  for (const [from, to] of [[start.id, first.id], [first.id, gate.id], [gate.id, last.id], [last.id, end.id]]) {
    const r = await act("addEdge", { from, to }, w);
    assert.ok(r.res.ok, r.data?.error);
  }
  return { start, first, gate, last, end };
}

/**
 * Wire a workspace into start → first → loop → body → end, plus a *side* node
 * that the start node also feeds — it is reachable without the loop, so the loop
 * must not repeat it. Custom `printf` harnesses keep the run hermetic.
 */
async function buildLoopGraph(w, { count = 3, bodyPrompt = "{input}|{iteration}/{iterations}" } = {}) {
  const s = await snapshot(w);
  const start = s.nodes.find((n) => n.type === "start");
  const first = s.nodes.find((n) => n.type === "agent");
  const end = s.nodes.find((n) => n.type === "end");
  assert.ok((await act("updateNode", { id: first.id, name: "first", config: {
    harness: "custom", command: echoQuery("A1"), prompt: "{task}",
  } }, w)).res.ok);

  const loop = (await act("addNode", { type: "loop", x: 420, y: 120 }, w)).data.nodes.at(-1);
  assert.ok((await act("updateNode", { id: loop.id, name: "loop", config: { count } }, w)).res.ok);
  const body = (await act("addNode", { type: "agent", x: 640, y: 120 }, w)).data.nodes.at(-1);
  assert.ok((await act("updateNode", { id: body.id, name: "body", config: {
    harness: "custom", command: echoQuery("B"), prompt: bodyPrompt,
  } }, w)).res.ok);
  // A sibling branch off the start: not dominated by the loop.
  const side = (await act("addNode", { type: "agent", x: 420, y: 480 }, w)).data.nodes.at(-1);
  assert.ok((await act("updateNode", { id: side.id, name: "side", config: {
    harness: "custom", command: echoQuery("S"), prompt: "{task}",
  } }, w)).res.ok);

  for (const e of s.edges) await act("removeEdge", { id: e.id }, w);
  for (const [from, to] of [
    [start.id, first.id], [first.id, loop.id], [loop.id, body.id], [body.id, end.id],
    [start.id, side.id], [side.id, end.id],
  ]) {
    const r = await act("addEdge", { from, to }, w);
    assert.ok(r.res.ok, r.data?.error);
  }
  return { start, first, loop, body, side, end };
}

/** Wire a workspace into start → loop → end with the loop's **Repeat** output
 *  wired back to a single agent — the refinement shape: each pass re-runs that
 *  agent with the previous pass's result as its input. `back` also wires
 *  `agent → loop`, which the engine must read as the loop's own output rather
 *  than as a dependency (counting it would deadlock the pair). Custom `printf`
 *  harnesses keep the run hermetic, and the step prints its pass number so the
 *  chain is visible in its output. */
async function buildFeedbackGraph(w, { count = 3, back = false } = {}) {
  const s = await snapshot(w);
  const start = s.nodes.find((n) => n.type === "start");
  const end = s.nodes.find((n) => n.type === "end");
  const loop = (await act("addNode", { type: "loop", x: 360, y: 200 }, w)).data.nodes.at(-1);
  assert.ok((await act("updateNode", { id: loop.id, name: "refine", config: { count } }, w)).res.ok);
  const step = (await act("addNode", { type: "agent", x: 620, y: 120 }, w)).data.nodes.at(-1);
  assert.ok((await act("updateNode", { id: step.id, name: "step", config: {
    harness: "custom", command: echoPassQuery("B"), prompt: "{input}",
  } }, w)).res.ok);
  for (const e of s.edges) await act("removeEdge", { id: e.id }, w);
  const wire = async (from, to, port) => {
    const r = await act("addEdge", port ? { from, to, port } : { from, to }, w);
    assert.ok(r.res.ok, r.data?.error);
  };
  await wire(start.id, loop.id);
  await wire(loop.id, step.id, "repeat");
  await wire(loop.id, end.id);
  if (back) await wire(step.id, loop.id);
  return { start, loop, step, end };
}

/** Wait until one node reaches `status`, returning the whole run each poll. */
async function waitNode(w, nodeId, status, timeoutMs = 20_000) {
  const start = Date.now();
  let run = null;
  while (Date.now() - start < timeoutMs) {
    run = await liveRun(w);
    if (run?.nodes?.[nodeId]?.status === status) return run;
    await sleep(100);
  }
  throw new Error(`node ${nodeId} never reached ${status}: ${JSON.stringify(run)?.slice(0, 400)}`);
}

async function openWorkflow(w = ws) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript((v) => { try { localStorage.setItem("scope-cwd", v); } catch { /* private */ } }, w);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e?.message ?? e)));
  await page.goto(`${base}/?token=${TOKEN}#view=${PLUGIN}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#subagent-workflow-pane .sw-node");
  return { page, context, errors };
}

before(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-workflow-")));
  pluginsDir = path.join(tmpDir, "plugins");
  fs.mkdirSync(pluginsDir, { recursive: true });
  const agentDir = path.join(tmpDir, "agent");
  ws = path.join(tmpDir, "ws");
  ws2 = path.join(tmpDir, "ws2");
  ws3 = path.join(tmpDir, "ws3");
  ws4 = path.join(tmpDir, "ws4");
  ws5 = path.join(tmpDir, "ws5");
  ws6 = path.join(tmpDir, "ws6");
  ws7 = path.join(tmpDir, "ws7");
  ws8 = path.join(tmpDir, "ws8");
  for (const d of [ws, ws2, ws3, ws4, ws5, ws6, ws7, ws8]) fs.mkdirSync(d, { recursive: true });

  // Reference files a node can be pointed at: a markdown file with a heading (so
  // it can be described without a note), a plain text file, and a folder.
  for (const w of [ws7, ws8]) {
    fs.mkdirSync(path.join(w, "docs"), { recursive: true });
    fs.writeFileSync(path.join(w, "docs", "design.md"),
      "# Design notes\n\nThe API shape this step must follow.\n");
    fs.writeFileSync(path.join(w, "notes.txt"), "Run the linter before committing.\nsecond line\n");
    fs.mkdirSync(path.join(w, "src"), { recursive: true });
  }

  // One skill and one extension in the agent dir, so the harness catalogue has
  // real entries to report (the skill is a plain directory, the extension
  // is a settings.json entry like the Settings page writes).
  fs.mkdirSync(path.join(agentDir, "skills", "demo-skill"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "skills", "demo-skill", "SKILL.md"),
    "---\nname: demo-skill\ndescription: toggled by the workflow tests\n---\nDo the demo.\n");
  fs.mkdirSync(path.join(agentDir, "extensions", "demo-ext"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "extensions", "demo-ext", "index.ts"), "export {};\n");
  fs.writeFileSync(path.join(agentDir, "settings.json"),
    JSON.stringify({ extensions: ["+extensions/demo-ext/index.ts"] }, null, 2));
  // pi's model store: the catalogue a Pi node's Model field offers (the host
  // merges it into `modelsMeta`, which the plugin hands back with its harness
  // list). One id is offered by two providers on purpose — that is the shape
  // that makes a bare model id unresolvable.
  fs.writeFileSync(path.join(agentDir, "models-store.json"), JSON.stringify({
    tokenharbor: { models: [{ id: "mimo-v2.6-flash" }, { id: "grok-4" }] },
    xiaomi: { models: [{ id: "mimo-v2.6-flash" }, { id: "mimo-v2-pro" }] },
    solo: { models: [{ id: "solo-large", contextWindow: 4096 }] },
  }, null, 2));

  // Fake `claude` / `gemini` earlier on PATH than anything real: the plugin's
  // `which()` then finds them, and every flag it passes is observable at run time.
  stubDir = path.join(tmpDir, "bin");
  fs.mkdirSync(stubDir, { recursive: true });
  claudeLog = path.join(tmpDir, "claude-argv.log");
  geminiLog = path.join(tmpDir, "gemini-argv.log");
  writeStubHarness(stubDir, "claude", claudeLog, "CLAUDE_STUB_OK");
  writeStubHarness(stubDir, "gemini", geminiLog, "GEMINI_STUB_OK");
  opencodeRuns = path.join(tmpDir, "opencode-runs.log");
  opencodePromptLog = path.join(tmpDir, "opencode-prompt.log");
  writeModelsStubHarness(stubDir, opencodeRuns, opencodePromptLog);

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      SCOPE_PORT: String(port), SCOPE_HOST: "127.0.0.1",
      SCOPE_DB_PATH: path.join(tmpDir, "scope.db"),
      SCOPE_AUTH_TOKEN: TOKEN,
      SCOPE_PLUGINS_DIR: pluginsDir,
      SCOPE_AGENT_DIR: agentDir,
      SCOPE_FILE_ROOT: tmpDir,
      // Evaluate schedules fast, so a trigger test need not wait 20s a tick.
      SCOPE_WORKFLOW_TRIGGER_TICK_MS: "700",
      // A low run-level loop ceiling, so the "a runaway loop is cut off" test
      // reaches the guard in a dozen passes instead of five hundred.
      SCOPE_MAX_LOOP_PASSES: "12",
      // Keep the model catalogue exactly the fixture's `models-store.json`: the
      // runtime "available models" read would otherwise merge in whatever the
      // bundled agent reports for this machine's credentials.
      SCOPE_MODEL_CATALOG: "off",
      PATH: `${stubDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  await waitForHealth();
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  if (browser) await browser.close();
  if (child) { child.kill("SIGKILL"); await new Promise((r) => child.once("exit", r)); }
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("subagent workflow plugin (server)", () => {
  test("is discovered as a built-in with routes and a client bundle", async () => {
    const { res, data } = await api("/plugins");
    assert.ok(res.ok);
    const p = data.plugins.find((x) => x.id === PLUGIN);
    assert.ok(p, "the plugin is listed");
    assert.equal(p.source, "builtin");
    assert.equal(p.enabled, true);
    assert.equal(p.hasServer, true);
    assert.equal(p.hasClient, true);
    assert.match(p.clientUrl, /^\/plugins\/file\/subagent-workflow\//);
    assert.deepEqual(p.serverRoutes, ["/subagent-workflow"]);
  });

  test("seeds a start → agent → end graph on first read", async () => {
    const s = await snapshot();
    assert.deepEqual(s.nodes.map((n) => n.type).sort(), ["agent", "end", "start"]);
    assert.equal(s.edges.length, 2);
    const agent = s.nodes.find((n) => n.type === "agent");
    assert.ok(agent.config.harness, "the seeded node names a harness");
  });

  test("lists the harnesses with availability", async () => {
    const { res, data } = await api(`/${PLUGIN}/harnesses`);
    assert.ok(res.ok);
    const ids = data.harnesses.map((h) => h.id);
    for (const id of ["claude", "codex", "gemini", "opencode", "aider", "cursor", "pi", "custom"]) {
      assert.ok(ids.includes(id), `${id} is offered`);
    }
    const custom = data.harnesses.find((h) => h.id === "custom");
    assert.equal(custom.available, true);
    for (const h of data.harnesses) assert.equal(typeof h.available, "boolean");
    // A provider that can print its own catalogue says how to ask it; the others
    // have only the list they declare.
    assert.deepEqual(data.harnesses.find((h) => h.id === "opencode").modelsArgs, ["models"]);
    assert.equal(data.harnesses.find((h) => h.id === "claude").modelsArgs, null);
  });

  test("asks a provider's own CLI for its model list", async () => {
    // opencode can print the catalogue it is set up for on this machine
    // (`opencode models`): that is the list a node's Model dropdown adds to the
    // handful of ids this plugin hard-codes.
    const { res, data } = await api(`/${PLUGIN}/models?harness=opencode`);
    assert.ok(res.ok, data?.error);
    assert.deepEqual(data.models, ["zen/deepseek-v4.1-flash", "zen/gpt-5", "local/qwen3"],
      "one model per line — the escape stripped and the sentence dropped");
    assert.match(data.source, /opencode models/, "and the command that answered rides along");

    // Cached: opening a second node does not spawn the CLI a second time.
    const spawns = () => (fs.existsSync(opencodeRuns) ? fs.readFileSync(opencodeRuns, "utf8").trim().split("\n").length : 0);
    const ran = spawns();
    await api(`/${PLUGIN}/models?harness=opencode`);
    assert.equal(spawns(), ran, "a repeated read reuses the cached list");

    // A harness with no models command has nothing to ask, and an unknown one is
    // refused: the dropdown keeps the list the harness declares.
    const none = await api(`/${PLUGIN}/models?harness=claude`);
    assert.deepEqual(none.data, { models: [], source: null });
    assert.equal((await api(`/${PLUGIN}/models?harness=nope`)).res.status, 400);
  });

  test("reports each harness's models and which capabilities it can be given", async () => {
    const { res, data } = await api(`/${PLUGIN}/harnesses`);
    assert.ok(res.ok);
    const by = Object.fromEntries(data.harnesses.map((h) => [h.id, h]));

    // A CLI harness: a model list and its own tool-allowlist flag.
    assert.ok(by.claude.models.includes("sonnet"), "claude offers its model aliases");
    assert.equal(by.claude.modelFlag, "--model");
    assert.deepEqual(by.claude.capabilities.tools, { flag: "--allowedTools" });
    assert.equal(by.claude.capabilities.skills, null, "Claude Code has no skill flag");
    assert.equal(by.claude.capabilities.extensions, null);

    assert.deepEqual(by.gemini.capabilities.tools, { flag: "--allowed-tools" });
    assert.equal(by.gemini.capabilities.extensions, null, "Gemini's --extensions is not our extension concept");

    // The app's own runner takes all three, mapped onto pi's flags.
    assert.deepEqual(by.pi.capabilities.skills, { flag: "--skill" });
    assert.deepEqual(by.pi.capabilities.tools, { flag: "--tools" });
    assert.deepEqual(by.pi.capabilities.extensions, { flag: "--extension" });
    // Pi's list is the app's whole model catalogue, and every entry names its
    // provider: `<provider>/<id>` is what pi resolves (a bare id is ambiguous
    // when two authenticated providers ship the same model).
    assert.deepEqual(by.pi.models, PI_MODELS, "Pi offers the app's catalogue, provider-qualified");
    assert.equal(by.pi.models.some((m) => !m.includes("/")), false, "no bare ids are offered");

    // A harness with no such flag says so, so a settings form can mark the rows.
    assert.deepEqual(by.codex.capabilities, { skills: null, tools: null, extensions: null });
  });

  test("stores a node's skill/tool/extension selection, dropping unsafe names", async () => {
    const s = await snapshot();
    const agent = s.nodes.find((n) => n.type === "agent");
    const updated = await act("updateNode", { id: agent.id, name: "configured", config: {
      harness: "pi",
      skills: ["planner", "planner", "../../etc", "bad name"],
      tools: ["bash", "read", "$(rm -rf /)"],
      extensions: ["extensions/demo-ext/index.ts", "evil;rm"],
    } });
    assert.ok(updated.res.ok, updated.data?.error);
    const saved = updated.data.nodes.find((n) => n.id === agent.id).config;
    assert.deepEqual(saved.skills, ["planner"], "de-duplicated, unsafe names dropped");
    assert.deepEqual(saved.tools, ["bash", "read"]);
    assert.deepEqual(saved.extensions, ["extensions/demo-ext/index.ts"]);
  });

  test("stores a node's reference files, resolving each path against the workspace", async () => {
    const solo = path.join(tmpDir, "ws-refs");
    fs.mkdirSync(path.join(solo, "docs"), { recursive: true });
    fs.mkdirSync(path.join(solo, "src"), { recursive: true });
    fs.writeFileSync(path.join(solo, "docs", "design.md"), "# Design notes\n\nThe API shape.\n");
    fs.writeFileSync(path.join(solo, "notes.txt"), "Run the linter first.\n");
    const s = await snapshot(solo);
    const agent = s.nodes.find((n) => n.type === "agent");
    const refsOf = async () => (await snapshot(solo)).nodes.find((n) => n.id === agent.id).config.refs;
    const design = fs.realpathSync(path.join(solo, "docs", "design.md"));

    // A relative path is taken against the workspace and canonicalised, so the
    // run is handed a path the agent can open.
    const added = await act("addRef", { nodeId: agent.id, path: "docs/design.md", note: "the API contract" }, solo);
    assert.ok(added.res.ok, added.data?.error);
    assert.deepEqual((await refsOf()).map((r) => r.path), [design]);
    assert.equal((await refsOf())[0].note, "the API contract");
    assert.ok((await refsOf())[0].id, "a reference carries its own id");

    // The same file twice, a path that is not there, and a node that has no
    // message of its own are all refused rather than stored.
    assert.equal((await act("addRef", { nodeId: agent.id, path: "docs/design.md" }, solo)).res.status, 409);
    assert.equal((await act("addRef", { nodeId: agent.id, path: "/nope/missing.md" }, solo)).res.status, 400);
    const start = s.nodes.find((n) => n.type === "start");
    assert.equal((await act("addRef", { nodeId: start.id, path: "notes.txt" }, solo)).res.status, 400);
    assert.equal((await act("addRef", { nodeId: "node_ghost", path: "notes.txt" }, solo)).res.status, 404);

    // A folder is stored with its trailing separator, so the injected block says
    // "this is a directory" without the agent having to stat it first.
    assert.ok((await act("addRef", { nodeId: agent.id, path: "src" }, solo)).res.ok);
    assert.equal((await refsOf())[1].path, `${fs.realpathSync(path.join(solo, "src"))}/`);

    // The description is edited, and the reference removed, on their own.
    const refId = (await refsOf())[0].id;
    assert.ok((await act("updateRef", { nodeId: agent.id, refId, note: "changed" }, solo)).res.ok);
    assert.equal((await refsOf())[0].note, "changed");
    assert.equal((await act("updateRef", { nodeId: agent.id, refId: "ref_ghost", note: "x" }, solo)).res.status, 404);
    assert.ok((await act("removeRef", { nodeId: agent.id, refId }, solo)).res.ok);
    assert.deepEqual((await refsOf()).map((r) => r.path), [`${fs.realpathSync(path.join(solo, "src"))}/`]);
    assert.equal((await act("removeRef", { nodeId: agent.id, refId }, solo)).res.status, 404);

    // The panel's own save writes the three settings and leaves the references
    // it does not edit alone.
    assert.ok((await act("updateNode", { id: agent.id, config: { prompt: "{input}" } }, solo)).res.ok);
    assert.equal((await refsOf()).length, 1, "saving the node keeps its references");
  });

  test("lists the workspace's folders and files for the reference browser", async () => {
    const root = (await api(`/${PLUGIN}/entries?cwd=${enc(ws8)}`)).data;
    assert.equal(root.rel, "");
    assert.equal(root.path, fs.realpathSync(ws8));
    // Folders first: the browser walks down a tree, it does not hunt.
    const dirs = root.entries.filter((e) => e.dir).map((e) => e.name);
    assert.deepEqual(dirs, ["docs", "src"]);
    assert.deepEqual(root.entries.filter((e) => !e.dir).map((e) => e.name), ["notes.txt"]);
    assert.deepEqual(root.entries.map((e) => e.dir).slice(0, 2), [true, true]);
    assert.ok(!root.entries.some((e) => e.name.startsWith(".")), "hidden entries are skipped");

    // A subfolder is addressed relative to the workspace, and its entries carry
    // the path the reference will be stored as.
    const sub = (await api(`/${PLUGIN}/entries?cwd=${enc(ws8)}&path=docs`)).data;
    assert.equal(sub.rel, "docs");
    assert.deepEqual(sub.entries.map((e) => e.name), ["design.md"]);
    assert.equal(sub.entries[0].rel, "docs/design.md");

    // The browser stays inside the workspace, and says so for a path that is not
    // there.
    assert.equal((await api(`/${PLUGIN}/entries?cwd=${enc(ws8)}&path=../`)).res.status, 400);
    assert.equal((await api(`/${PLUGIN}/entries?cwd=${enc(ws8)}&path=docs/ghost`)).res.status, 400);
  });

  test("injects a node's reference files into the message it sends", async () => {
    const solo = path.join(tmpDir, "ws-ref-run");
    fs.mkdirSync(path.join(solo, "docs"), { recursive: true });
    fs.writeFileSync(path.join(solo, "docs", "plan.md"), "# The plan\n\nSteps to follow.\n");
    fs.writeFileSync(path.join(solo, "rules.txt"), "Never push to main.\n");
    const s = await snapshot(solo);
    const agent = s.nodes.find((n) => n.type === "agent");
    const plan = fs.realpathSync(path.join(solo, "docs", "plan.md"));
    const rules = fs.realpathSync(path.join(solo, "rules.txt"));

    assert.ok((await act("updateNode", { id: agent.id, name: "reader", config: {
      harness: "custom", command: `printf '%s\n--REFS--\n%s' "$SW_PROMPT" "$SW_REFS"`, prompt: "{task}",
    } }, solo)).res.ok);
    // One reference described by the user, one left to the file's own heading.
    assert.ok((await act("addRef", { nodeId: agent.id, path: "rules.txt", note: "house rules" }, solo)).res.ok);
    assert.ok((await act("addRef", { nodeId: agent.id, path: "docs/plan.md" }, solo)).res.ok);

    assert.ok((await runApi("start", { task: "review the API" }, solo)).res.ok);
    const run = await waitRun(solo);
    assert.equal(run.nodes[agent.id].status, "done", JSON.stringify(run.log));
    const out = run.nodes[agent.id].outputTail;
    const prompt = out.split("\n--REFS--\n")[0];
    // The message is tagged: the user's own query in <user query>, then both
    // reference paths in <reference files/folder>, each with a description —
    // the user's note, or the file's own first heading when they wrote none.
    assert.match(prompt, /^<user query>\n[\s\S]*\n<\/user query>/, prompt.slice(0, 200));
    assert.ok(prompt.includes("review the API"), prompt.slice(0, 200));
    assert.match(prompt, /<reference files\/folder>\n[\s\S]*\n<\/reference files\/folder>$/, prompt.slice(0, 400));
    assert.ok(prompt.includes(`${rules} — house rules`), prompt.slice(0, 400));
    assert.ok(prompt.includes(`${plan} — The plan`), prompt.slice(0, 400));
    assert.match(prompt, /not instructions/);
    // …in that order: the query tag comes before the reference tag.
    assert.ok(prompt.indexOf("<user query>") < prompt.indexOf("<reference files/folder>"));
    // A custom command gets the paths on their own as well, via $SW_REFS.
    assert.ok(out.split("\n--REFS--\n")[1].includes(rules), "$SW_REFS carries the paths");

    // A reference that has since disappeared is reported, not silently dropped.
    const gone = path.join(solo, "docs", "gone.md");
    fs.writeFileSync(gone, "# Gone\n");
    assert.ok((await act("addRef", { nodeId: agent.id, path: "docs/gone.md" }, solo)).res.ok);
    fs.rmSync(gone);
    assert.ok((await runApi("start", { task: "again" }, solo)).res.ok);
    const second = await waitRun(solo);
    assert.equal(second.nodes[agent.id].status, "done", JSON.stringify(second.log));
    assert.ok(
      second.log.some((l) => /reference file\(s\) not found: .*gone\.md/.test(l.text)),
      `expected a missing-reference report, got: ${JSON.stringify(second.log.map((l) => l.text))}`,
    );
    assert.match(second.nodes[agent.id].outputTail, /gone\.md \(not found\)/);
  });

  test("adds, configures and moves nodes; writes land in the plugin's store", async () => {
    const before = await snapshot();
    const added = await act("addNode", { type: "agent", x: 500, y: 480 });
    assert.ok(added.res.ok);
    const node = added.data.nodes.find((n) => !before.nodes.some((b) => b.id === n.id));
    assert.ok(node);

    const updated = await act("updateNode", { id: node.id, name: "researcher", config: {
      harness: "codex", model: "openai/gpt-5-mini", prompt: "Research {task}",
      extraArgs: "--yolo", fanout: "serial", join: "first", continueOnError: true, timeoutSec: 30,
    } });
    assert.ok(updated.res.ok);
    const saved = updated.data.nodes.find((n) => n.id === node.id);
    assert.equal(saved.name, "researcher");
    assert.equal(saved.config.harness, "codex");
    assert.equal(saved.config.model, "openai/gpt-5-mini");
    assert.equal(saved.config.fanout, "serial");
    assert.equal(saved.config.join, "first");
    assert.equal(saved.config.continueOnError, true);
    assert.equal(saved.config.timeoutSec, 30);

    assert.ok((await act("moveNode", { id: node.id, x: 900, y: 520 })).res.ok);
    const store = JSON.parse(fs.readFileSync(storePath(ws), "utf8"));
    assert.ok(store.workspaces[fs.realpathSync(ws)].nodes.some((n) => n.id === node.id && n.name === "researcher"));
  });

  test("stores a loop's pass count, clamped to the server's ceiling", async () => {
    const added = await act("addNode", { type: "loop", x: 300, y: 520 });
    assert.ok(added.res.ok);
    const loop = added.data.nodes.at(-1);
    assert.equal(loop.type, "loop");
    assert.equal(loop.name, "Loop");
    assert.equal(loop.config.count, 2, "a fresh loop repeats twice");

    const setCount = async (count) => {
      const r = await act("updateNode", { id: loop.id, config: { count } });
      assert.ok(r.res.ok, r.data?.error);
      return r.data.nodes.find((n) => n.id === loop.id).config.count;
    };
    assert.equal(await setCount(5), 5);
    assert.equal(await setCount(0.4), 1, "below 1 clamps to a single pass");
    assert.equal(await setCount(9999), 100, "and above the ceiling to the ceiling");
    assert.equal(await setCount("nonsense"), 2, "a non-number falls back to the default");
    // A loop is a repeatable kind, like an agent or a gate.
    assert.ok((await act("duplicateNode", { id: loop.id })).res.ok);
  });

  test("a loop repeats the section it dominates, and only that section", async () => {
    const solo = path.join(tmpDir, "ws-loop-run");
    fs.mkdirSync(solo, { recursive: true });
    const g = await buildLoopGraph(solo, { count: 3 });

    assert.ok((await runApi("start", { task: "world" }, solo)).res.ok);
    const run = await waitRun(solo);
    assert.equal(run.status, "done");
    assert.equal(run.nodes[g.loop.id].status, "done");
    assert.equal(run.nodes[g.loop.id].iterations, 3);
    assert.equal(run.nodes[g.loop.id].iteration, 3, "it reports the last pass it ran");

    const text = run.log.map((l) => l.text).join("\n");
    const ownLines = (id) => run.log.filter((l) => l.nodeId === id && l.stream === "stdout").map((l) => l.text);
    // The dominated section ran exactly once per pass…
    assert.equal(ownLines(g.body.id).length, 3, "the body ran on every pass");
    for (const i of [1, 2, 3]) {
      assert.ok(ownLines(g.body.id).some((t) => t.includes(`|${i}/3]`)), `pass ${i} knew its own number`);
    }
    assert.ok(/pass 2\/3/.test(text), "every pass is logged");
    // …while the sibling branch off the start, which the loop does not own, ran once.
    assert.equal(ownLines(g.side.id).length, 1, "a node outside the loop is not repeated");

    // The loop's own output is its **last** pass's result — the finished work of
    // the step it repeats — never the seed plus a log of every pass, so the node
    // after it reads the answer.
    const out = run.nodes[g.loop.id].outputTail;
    assert.equal(out.trim(), "B[A1[world]|3/3]", "the loop carries the last pass, and only it");
    // The end node is fed by the body step, and reads that same finished loop,
    // exactly as if the loop's Exit had been wired to it.
    const end = run.nodes[g.end.id].outputTail;
    assert.ok(end.startsWith(out.trim()), `the end node reads the finished loop (${end})`);
    assert.ok(!/\|1\/3\]|\|2\/3\]/.test(end), "no earlier pass leaks through the loop");
  });

  test("a switched-off loop runs its section exactly once", async () => {
    const solo = path.join(tmpDir, "ws-loop-off");
    fs.mkdirSync(solo, { recursive: true });
    const g = await buildLoopGraph(solo, { count: 4 });
    assert.ok((await act("updateNode", { id: g.loop.id, config: { enabled: false } }, solo)).res.ok);

    assert.ok((await runApi("start", { task: "world" }, solo)).res.ok);
    const run = await waitRun(solo);
    assert.equal(run.status, "done");
    assert.equal(run.nodes[g.loop.id].status, "skipped");
    assert.equal(run.nodes[g.loop.id].bypassed, true);
    const text = run.log.map((l) => l.text).join("\n");
    assert.equal(run.log.filter((l) => l.nodeId === g.body.id && l.stream === "stdout").length, 1,
      "a bypassed loop is a pass-through, not a repeater");
    assert.ok(!/passes over/.test(text), "and it never announces passes");
    // The end node still reads what the section produced: a bypassed loop is a
    // wire, not a hole in the graph.
    assert.match(run.nodes[g.end.id].outputTail, /B\[/, "the end node saw the section's output");
  });

  test("a nested loop runs its section fully inside every pass of its parent", async () => {
    const solo = path.join(tmpDir, "ws-loop-nested");
    fs.mkdirSync(solo, { recursive: true });
    const g = await buildLoopGraph(solo, { count: 2 });
    // Insert an inner loop between the outer loop and the body:
    //   outer → inner → body, so the inner section is inside the outer's.
    const inner = (await act("addNode", { type: "loop", x: 520, y: 120 }, solo)).data.nodes.at(-1);
    assert.ok((await act("updateNode", { id: inner.id, name: "inner", config: { count: 2 } }, solo)).res.ok);
    const outerToBody = (await snapshot(solo)).edges.find((e) => e.from === g.loop.id && e.to === g.body.id);
    assert.ok((await act("removeEdge", { id: outerToBody.id }, solo)).res.ok);
    assert.ok((await act("addEdge", { from: g.loop.id, to: inner.id }, solo)).res.ok);
    assert.ok((await act("addEdge", { from: inner.id, to: g.body.id }, solo)).res.ok);

    assert.ok((await runApi("start", { task: "world" }, solo)).res.ok);
    const run = await waitRun(solo);
    assert.equal(run.status, "done");
    // The inner section ran twice per outer pass, so the body ran 2 × 2 times.
    const bodyLines = run.log.filter((l) => l.nodeId === g.body.id && l.stream === "stdout");
    assert.equal(bodyLines.length, 4, "the body ran on every pass of the inner loop");
    // The innermost loop shadows its parent, so the body counts 1…2, twice.
    assert.equal(bodyLines.filter((l) => /\|1\/2\]/.test(l.text)).length, 2, "inner pass 1 in both outer passes");
    assert.equal(bodyLines.filter((l) => /\|2\/2\]/.test(l.text)).length, 2, "and inner pass 2 in both");
    assert.equal(run.nodes[inner.id].iterations, 2);
    assert.equal(run.nodes[g.loop.id].iterations, 2);
    // The outer loop's output is its last pass's result: the inner loop's
    // finished output from the final outer pass, rebuilt each pass and never
    // carried over stale or accumulated.
    const outerOut = run.nodes[g.loop.id].outputTail;
    assert.equal((outerOut.match(/B\[/g) || []).length, 1, `only the finished inner result (${outerOut})`);
    assert.match(outerOut, /\|2\/2\]$/, "the inner loop's last pass is what the outer loop hands on");
  });

  test("a node failing inside a loop stops the run at that pass", async () => {
    const solo = path.join(tmpDir, "ws-loop-fail");
    fs.mkdirSync(solo, { recursive: true });
    const g = await buildLoopGraph(solo, { count: 4 });
    assert.ok((await act("updateNode", { id: g.body.id, config: {
      harness: "custom", command: "printf 'boom' >&2; exit 3", prompt: "{input}",
    } }, solo)).res.ok);

    assert.ok((await runApi("start", { task: "world" }, solo)).res.ok);
    const run = await waitRun(solo);
    assert.equal(run.status, "error");
    assert.equal(run.nodes[g.body.id].status, "error");
    assert.ok(run.nodes[g.loop.id].status !== "done", "the loop did not complete");
    const text = run.log.map((l) => l.text).join("\n");
    assert.ok(!/pass 2\/4/.test(text), "no further pass was started");
  });

  test("a runaway loop is cut off by the run's pass budget, not wedged", async () => {
    const solo = path.join(tmpDir, "ws-loop-budget");
    fs.mkdirSync(solo, { recursive: true });
    // The suite lowers SCOPE_MAX_LOOP_PASSES to 12, so a 20-pass loop must be
    // stopped by the budget rather than run to its own count.
    const g = await buildLoopGraph(solo, { count: 20 });

    assert.ok((await runApi("start", { task: "world" }, solo)).res.ok);
    const run = await waitRun(solo);
    assert.equal(run.status, "error", "the run ends, it does not hang");
    assert.equal(run.nodes[g.loop.id].status, "error");
    assert.match(run.nodes[g.loop.id].error, /loop budget/);
    assert.ok(run.log.some((l) => /hit the loop ceiling/.test(l.text)));
    assert.ok(run.finishedAt, "and it is recorded as finished");
  });

  test("an approval gate inside a loop asks again on every pass", async () => {
    const solo = path.join(tmpDir, "ws-loop-gate");
    fs.mkdirSync(solo, { recursive: true });
    const g = await buildLoopGraph(solo, { count: 2 });
    const gate = (await act("addNode", { type: "approval", x: 520, y: 120 }, solo)).data.nodes.at(-1);
    assert.ok((await act("updateNode", { id: gate.id, name: "gate", config: {
      message: "pass {iteration}/{iterations}?",
    } }, solo)).res.ok);
    const len = (await snapshot(solo)).edges.find((e) => e.from === g.loop.id && e.to === g.body.id);
    assert.ok((await act("removeEdge", { id: len.id }, solo)).res.ok);
    assert.ok((await act("addEdge", { from: g.loop.id, to: gate.id }, solo)).res.ok);
    assert.ok((await act("addEdge", { from: gate.id, to: g.body.id }, solo)).res.ok);

    // Wait for the gate to ask a *specific* pass, so a stale wait can never be
    // mistaken for the next pass's.
    const waitAsk = async (message) => {
      const t0 = Date.now();
      for (;;) {
        const r = await liveRun(solo);
        if (r?.nodes?.[gate.id]?.status === "waiting" && r.nodes[gate.id].approval?.message === message) return r;
        if (Date.now() - t0 > 20_000) throw new Error(`the gate never asked “${message}”`);
        await sleep(100);
      }
    };

    assert.ok((await runApi("start", { task: "world" }, solo)).res.ok);
    await waitAsk("pass 1/2?");
    assert.ok((await runApi("approve", { nodeId: gate.id, note: "go" }, solo)).res.ok);
    await waitAsk("pass 2/2?");

    const mid = await liveRun(solo);
    assert.equal(mid.nodes[gate.id].decision, null, "the first pass's decision was cleared for the second");
    assert.ok((await runApi("approve", { nodeId: gate.id }, solo)).res.ok);
    const run = await waitRun(solo);
    assert.equal(run.status, "done");
    assert.equal(run.nodes[gate.id].decision.approve, true);
    assert.equal(run.nodes[gate.id].decision.note, "", "the second pass was decided on its own");
    assert.equal((run.log.map((l) => l.text).join("\n").match(/awaiting approval/g) || []).length, 2);
  });

  test("only a loop node may have a repeat output, and a repeat edge may close a cycle", async () => {
    const solo = path.join(tmpDir, "ws-loop-wire");
    fs.mkdirSync(solo, { recursive: true });
    const s = await snapshot(solo);
    const agent = s.nodes.find((n) => n.type === "agent");
    const end = s.nodes.find((n) => n.type === "end");
    const loop = (await act("addNode", { type: "loop", x: 300, y: 420 }, solo)).data.nodes.at(-1);

    // Repeat belongs to a loop alone…
    const fromAgent = await act("addEdge", { from: agent.id, to: loop.id, port: "repeat" }, solo);
    assert.equal(fromAgent.res.status, 400);
    assert.match(fromAgent.data.error, /only a loop/);
    // …and never points at the end node.
    const toEnd = await act("addEdge", { from: loop.id, to: end.id, port: "repeat" }, solo);
    assert.equal(toEnd.res.status, 400);
    assert.match(toEnd.data.error, /end node/);

    // A repeat edge closes the loop's own cycle — the one cycle the graph allows.
    const repeat = await act("addEdge", { from: loop.id, to: agent.id, port: "repeat" }, solo);
    assert.ok(repeat.res.ok, repeat.data?.error);
    assert.equal(repeat.data.edges.find((e) => e.from === loop.id && e.to === agent.id).port, "repeat");
    // An ordinary edge in the other direction is fine too — the engine reads it
    // as the loop's output, not as a dependency.
    assert.ok((await act("addEdge", { from: agent.id, to: loop.id }, solo)).res.ok);
    // The port survives a round-trip through the store, and an ordinary edge
    // that closes a real cycle is still refused.
    assert.equal((await snapshot(solo)).edges.find((e) => e.from === loop.id).port, "repeat");
    assert.equal((await act("addEdge", { from: agent.id, to: end.id, port: "repeat" }, solo)).res.status, 400);
  });

  test("imports a loop's repeat connection, but still refuses a real cycle", async () => {
    const solo = path.join(tmpDir, "ws-loop-import");
    fs.mkdirSync(solo, { recursive: true });
    await snapshot(solo);
    const file = (edges) => ({
      name: "Looped",
      nodes: [
        { id: "s", type: "start", name: "Start", x: 0, y: 0 },
        { id: "l", type: "loop", name: "refine", x: 200, y: 0, config: { count: 2 } },
        { id: "a", type: "agent", name: "step", x: 400, y: 0, config: { harness: "custom", command: "printf x", prompt: "{input}" } },
        { id: "e", type: "end", name: "End", x: 600, y: 0 },
      ],
      edges,
    });
    // step → loop → step, both ordinary: a real cycle, refused.
    const bad = await act("importWorkflow", { data: file([
      { from: "s", to: "l" }, { from: "l", to: "a" }, { from: "a", to: "l" }, { from: "l", to: "e" },
    ]) }, solo);
    assert.equal(bad.res.status, 400);
    assert.match(bad.data.error, /cycle/);

    // The same graph, with the loop's side of that cycle marked as its Repeat
    // output, is exactly a refinement loop — accepted, port intact.
    const good = await act("importWorkflow", { data: file([
      { from: "s", to: "l" }, { from: "l", to: "a", port: "repeat" }, { from: "a", to: "l" }, { from: "l", to: "e" },
    ]) }, solo);
    assert.ok(good.res.ok, good.data?.error);
    assert.equal(good.data.edges.find((e) => e.to === "a").port, "repeat");

    // A repeat edge at the end node is not a repeat — the same rule `addEdge`
    // enforces — so it imports as the ordinary connection it must be.
    const toEnd = await act("importWorkflow", { data: file([
      { from: "s", to: "l" }, { from: "l", to: "a" }, { from: "l", to: "e", port: "repeat" },
    ]) }, solo);
    assert.ok(toEnd.res.ok, toEnd.data?.error);
    assert.equal(toEnd.data.edges.find((e) => e.to === "e").port, undefined);
  });

  test("a feedback loop re-runs its step, each pass fed the previous pass's result", async () => {
    const solo = path.join(tmpDir, "ws-loop-feedback");
    fs.mkdirSync(solo, { recursive: true });
    const g = await buildFeedbackGraph(solo, { count: 3 });
    assert.ok((await runApi("start", { task: "seed" }, solo)).res.ok);
    const run = await waitRun(solo);
    assert.equal(run.status, "done");
    assert.equal(run.nodes[g.loop.id].status, "done");
    assert.equal(run.nodes[g.loop.id].iterations, 3);
    assert.equal(run.nodes[g.loop.id].iteration, 3, "it reports the last pass it ran");
    // Three passes, each seeded by the one before: seed → B1[seed] → B2[B1[seed]]
    // → B3[B2[B1[seed]]]. The chain is the whole point: the step never sees the
    // original seed again after its first pass.
    assert.equal(run.nodes[g.step.id].outputTail, "B3[B2[B1[seed]]]");
    // The loop's own output is its last pass's result — the finished work of the
    // step wired to its Repeat output — not the seed plus every pass.
    const out = run.nodes[g.loop.id].outputTail;
    assert.equal(out.trim(), "B3[B2[B1[seed]]]", "the loop carries the last pass alone");
    assert.ok(!out.includes("\n---\n"), "the passes are not accumulated");
    assert.match(run.nodes[g.end.id].outputTail, /B3\[B2\[B1\[seed\]\]\]/);
  });

  test("a loop fed by the step it repeats still runs that step", async () => {
    // The reported shape: start → agent → loop, with loop.repeat → agent. The
    // loop's only parent is the step it repeats, so it must wait for that first
    // run (stripping every parent would leave it, and its section, never running).
    const solo = path.join(tmpDir, "ws-loop-self-fed");
    fs.mkdirSync(solo, { recursive: true });
    const s = await snapshot(solo);
    const start = s.nodes.find((n) => n.type === "start");
    const agent = s.nodes.find((n) => n.type === "agent");
    const end = s.nodes.find((n) => n.type === "end");
    assert.ok((await act("updateNode", { id: agent.id, name: "step", config: {
      harness: "custom", command: echoPassQuery("B"), prompt: "{input}",
    } }, solo)).res.ok);
    const loop = (await act("addNode", { type: "loop", x: 600, y: 200 }, solo)).data.nodes.at(-1);
    assert.ok((await act("updateNode", { id: loop.id, name: "refine", config: { count: 3 } }, solo)).res.ok);
    for (const e of s.edges) await act("removeEdge", { id: e.id }, solo);
    for (const [from, to, port] of [[start.id, agent.id], [agent.id, loop.id], [loop.id, agent.id, "repeat"], [loop.id, end.id]]) {
      const r = await act("addEdge", port ? { from, to, port } : { from, to }, solo);
      assert.ok(r.res.ok, r.data?.error);
    }
    assert.ok((await runApi("start", { task: "seed" }, solo)).res.ok);
    const run = await waitRun(solo);
    assert.equal(run.status, "done", "the run neither stalls nor hangs");
    assert.equal(run.nodes[loop.id].status, "done");
    assert.equal(run.nodes[loop.id].iterations, 3);
    // The step really runs — the bug was that it never executed at all.
    const executions = run.log.filter((l) => /▶ step \(custom\)/.test(l.text)).length;
    assert.equal(executions, 3, "the step executes on every pass");
    // Each pass is fed the previous pass's result (the task stays in front of it,
    // because `start → step` is still wired): B[seed] → B2[…] → B3[…].
    assert.match(run.nodes[agent.id].outputTail, /^B3\[[\s\S]*B2\[[\s\S]*B\[seed\]/);
    assert.match(run.nodes[end.id].outputTail, /B3\[/, "the finished loop reaches the end node");
  });

  test("an agent wired back into its loop does not deadlock the run", async () => {
    const solo = path.join(tmpDir, "ws-loop-feedback-back");
    fs.mkdirSync(solo, { recursive: true });
    const g = await buildFeedbackGraph(solo, { count: 2, back: true });
    assert.ok((await runApi("start", { task: "seed" }, solo)).res.ok);
    const run = await waitRun(solo);
    assert.equal(run.status, "done", "the loop does not wait for the step it re-runs");
    assert.equal(run.nodes[g.step.id].outputTail, "B2[B1[seed]]");
    assert.match(run.nodes[g.end.id].outputTail, /B2\[B1\[seed\]\]/);
  });

  test("a step after the loop's Exit waits for the finished loop, not its seed", async () => {
    // The reported shape: start → first → loop, loop.repeat → body, and an
    // ordinary step off the loop's **Exit** → end. The exit-side step reads the
    // loop's own output — the finished last pass — so it must wait for the loop
    // to settle. The bug was that it started the moment the loop did and only
    // ever saw the material that reached the loop (`A1[seed]`).
    const solo = path.join(tmpDir, "ws-loop-exit");
    fs.mkdirSync(solo, { recursive: true });
    const s = await snapshot(solo);
    const start = s.nodes.find((n) => n.type === "start");
    const first = s.nodes.find((n) => n.type === "agent");
    const end = s.nodes.find((n) => n.type === "end");
    assert.ok((await act("updateNode", { id: first.id, name: "first", config: {
      harness: "custom", command: echoQuery("A1"), prompt: "{task}",
    } }, solo)).res.ok);
    const loop = (await act("addNode", { type: "loop", x: 420, y: 120 }, solo)).data.nodes.at(-1);
    assert.ok((await act("updateNode", { id: loop.id, name: "refine", config: { count: 3 } }, solo)).res.ok);
    const body = (await act("addNode", { type: "agent", x: 620, y: 60 }, solo)).data.nodes.at(-1);
    assert.ok((await act("updateNode", { id: body.id, name: "body", config: {
      harness: "custom", command: echoPassQuery("B"), prompt: "{input}",
    } }, solo)).res.ok);
    const post = (await act("addNode", { type: "agent", x: 620, y: 340 }, solo)).data.nodes.at(-1);
    assert.ok((await act("updateNode", { id: post.id, name: "post", config: {
      harness: "custom", command: echoQuery("P"), prompt: "{input}",
    } }, solo)).res.ok);
    for (const e of s.edges) await act("removeEdge", { id: e.id }, solo);
    for (const [from, to, port] of [
      [start.id, first.id], [first.id, loop.id], [loop.id, body.id, "repeat"],
      [loop.id, post.id], [post.id, end.id],
    ]) {
      const r = await act("addEdge", port ? { from, to, port } : { from, to }, solo);
      assert.ok(r.res.ok, r.data?.error);
    }
    assert.ok((await runApi("start", { task: "seed" }, solo)).res.ok);
    const run = await waitRun(solo);
    assert.equal(run.status, "done");
    const out = run.nodes[post.id].outputTail;
    assert.equal(out.trim(), "P[B3[B2[B1[A1[seed]]]]]", "the exit-side step saw the finished loop, not its seed");
    assert.match(run.nodes[end.id].outputTail, /B3\[B2\[B1\[A1\[seed\]\]\]\]/);
  });

  test("the end node reads the finished loop when the last body step feeds it directly", async () => {
    // The reported shape: start → first → loop, loop.repeat → body, and the body
    // step wired straight into the end node — no separate Exit connection. The
    // end must carry the finished loop (the last pass's result), exactly as if
    // the loop's Exit had been wired to it, rather than the seed or an earlier
    // pass.
    const solo = path.join(tmpDir, "ws-loop-body-end");
    fs.mkdirSync(solo, { recursive: true });
    const s = await snapshot(solo);
    const start = s.nodes.find((n) => n.type === "start");
    const first = s.nodes.find((n) => n.type === "agent");
    const end = s.nodes.find((n) => n.type === "end");
    assert.ok((await act("updateNode", { id: first.id, name: "first", config: {
      harness: "custom", command: echoQuery("A1"), prompt: "{task}",
    } }, solo)).res.ok);
    const loop = (await act("addNode", { type: "loop", x: 420, y: 120 }, solo)).data.nodes.at(-1);
    assert.ok((await act("updateNode", { id: loop.id, name: "refine", config: { count: 3 } }, solo)).res.ok);
    const body = (await act("addNode", { type: "agent", x: 620, y: 120 }, solo)).data.nodes.at(-1);
    assert.ok((await act("updateNode", { id: body.id, name: "body", config: {
      harness: "custom", command: echoPassQuery("B"), prompt: "{input}",
    } }, solo)).res.ok);
    for (const e of s.edges) await act("removeEdge", { id: e.id }, solo);
    for (const [from, to, port] of [
      [start.id, first.id], [first.id, loop.id], [loop.id, body.id, "repeat"], [body.id, end.id],
    ]) {
      const r = await act("addEdge", port ? { from, to, port } : { from, to }, solo);
      assert.ok(r.res.ok, r.data?.error);
    }
    assert.ok((await runApi("start", { task: "seed" }, solo)).res.ok);
    const run = await waitRun(solo);
    assert.equal(run.status, "done");
    const out = run.nodes[end.id].outputTail;
    assert.equal(out.trim(), "B3[B2[B1[A1[seed]]]]", "the end node reads the loop's finished pass alone");
  });

  test("a loop with nothing to repeat passes through instead of burning the pass budget", async () => {
    const solo = path.join(tmpDir, "ws-loop-open");
    fs.mkdirSync(solo, { recursive: true });
    const s = await snapshot(solo);
    const start = s.nodes.find((n) => n.type === "start");
    const end = s.nodes.find((n) => n.type === "end");
    const loop = (await act("addNode", { type: "loop", x: 300, y: 400 }, solo)).data.nodes.at(-1);
    // A count far past the run's pass ceiling (the suite lowers it to 12): a loop
    // that iterated an empty section would spend the budget and abort the run.
    assert.ok((await act("updateNode", { id: loop.id, name: "open", config: { count: 100 } }, solo)).res.ok);
    for (const e of s.edges) await act("removeEdge", { id: e.id }, solo);
    for (const [from, to] of [[start.id, loop.id], [loop.id, end.id]]) {
      const r = await act("addEdge", { from, to }, solo);
      assert.ok(r.res.ok, r.data?.error);
    }
    assert.ok((await runApi("start", { task: "t" }, solo)).res.ok);
    const run = await waitRun(solo);
    assert.equal(run.status, "done", "an empty loop does not burn the pass budget");
    assert.equal(run.nodes[loop.id].status, "done");
    assert.ok(!run.nodes[loop.id].iterations, "it never iterated");
    assert.equal(run.nodes[end.id].outputTail, "t", "it forwards what reached it");
  });

  test("an approved gate keeps the message it reviewed, not the raw template", async () => {
    const solo = path.join(tmpDir, "ws-gate-message");
    fs.mkdirSync(solo, { recursive: true });
    const g = await buildApprovalGraph(solo);
    assert.ok((await runApi("start", { task: "hello" }, solo)).res.ok);
    const waiting = await waitNode(solo, g.gate.id, "waiting");
    assert.equal(waiting.nodes[g.gate.id].approval.message, "Please review: A1[hello]");
    const decided = await runApi("approve", { nodeId: g.gate.id, note: "ok" }, solo);
    assert.ok(decided.res.ok);
    const d = decided.data.run.nodes[g.gate.id].decision;
    assert.equal(d.approve, true);
    assert.equal(d.message, "Please review: A1[hello]", "the rendered message survives the decision");
    assert.doesNotMatch(d.message, /\{input\}/);
  });

  test("refuses graph shapes the runner could not execute", async () => {
    const s = await snapshot();
    const start = s.nodes.find((n) => n.type === "start");
    const agents = s.nodes.filter((n) => n.type === "agent");
    const end = s.nodes.find((n) => n.type === "end");
    const [a1, a2] = agents;
    assert.ok(a1 && a2);

    assert.equal((await act("addEdge", { from: a1.id, to: a1.id })).res.status, 400);
    assert.equal((await act("addEdge", { from: a1.id, to: start.id })).res.status, 400);
    assert.equal((await act("addEdge", { from: end.id, to: a1.id })).res.status, 400);
    assert.equal((await act("addEdge", { from: a1.id, to: end.id })).res.status, 409);
    // A canvas may carry several entry points, each managed separately.
    const secondStart = await act("addNode", { type: "start" });
    assert.ok(secondStart.res.ok, secondStart.data?.error);
    assert.ok((await act("removeNode", { id: secondStart.data.nodes.at(-1).id })).res.ok);

    assert.ok((await act("addEdge", { from: a1.id, to: a2.id })).res.ok);
    assert.equal((await act("addEdge", { from: a2.id, to: a1.id })).res.status, 400, "cycle refused");

    // Start and end take as many connections as the graph needs: a fan-out from
    // start is several parallel roots, a fan-in to end is several branches
    // finishing the workflow.
    assert.equal((await act("addEdge", { from: start.id, to: a2.id })).res.ok, true, "a second root is allowed");
    const fan = await snapshot();
    assert.equal(fan.edges.filter((e) => e.from === start.id).length, 2, "start feeds both roots");
    assert.equal((await act("addEdge", { from: start.id, to: a2.id })).res.status, 409, "but the same pair is still refused");
    // (a1 already reaches the end in the seed, so the second parent is a2.)
    assert.ok((await act("addEdge", { from: a2.id, to: end.id })).res.ok, "a second branch may join the end node");
    assert.equal((await snapshot()).edges.filter((e) => e.to === end.id).length, 2, "end takes both parents");
  });

  test("runs a fan-out DAG to completion, flowing output along the edges", async () => {
    const g = await buildCustomGraph(ws2);
    const started = await runApi("start", { task: "hello" }, ws2);
    assert.ok(started.res.ok, started.data?.error);
    assert.equal(started.data.run.status, "running");

    const run = await waitRun(ws2);
    assert.equal(run.status, "done");
    assert.equal(run.nodes[g.first.id].status, "done");
    assert.equal(run.nodes[g.a2.id].status, "done");
    assert.equal(run.nodes[g.a3.id].status, "done");
    assert.equal(run.nodes[g.end.id].status, "done");
    assert.equal(run.nodes[g.first.id].outputTail, "A1[hello]");
    assert.equal(run.nodes[g.a2.id].outputTail, "A2[A1[hello]]");
    assert.equal(run.nodes[g.a3.id].outputTail, "A3[A1[hello]]");
    // The log streamed each node's output.
    assert.ok(run.log.some((l) => l.text.includes("A1[hello]")));
  });

  test("runs parallel branches together and a chain one node after another", async () => {
    // The graph is drawn, not configured:
    //
    //   start ─┬─> A ─┐
    //          ├─> B ─┴─> C ─> D ─┐
    //          └────────────────── end   (B also feeds end, so end has two parents)
    //
    // A and B hang off the start in parallel and must overlap; C joins both, so it
    // cannot start until the last of them finishes; D is a plain chain step.
    const s = await snapshot(ws6);
    const start = s.nodes.find((n) => n.type === "start");
    const end = s.nodes.find((n) => n.type === "end");
    const first = s.nodes.find((n) => n.type === "agent");

    const mk = async (name, x, y, command, prompt) => {
      const id = name === "a" ? first.id : (await act("addNode", { type: "agent", x, y }, ws6)).data.nodes.at(-1).id;
      const u = await act("updateNode", { id, name, config: { harness: "custom", command, prompt } }, ws6);
      assert.ok(u.res.ok, u.data?.error);
      return id;
    };
    const a = await mk("a", 340, 180, "sleep 0.6; " + echoQuery("A"), "{task}");
    const b = await mk("b", 340, 420, "sleep 0.6; " + echoQuery("B"), "{task}");
    const c = await mk("c", 640, 300, echoQuery("C"), "{input}");
    const d = await mk("d", 880, 300, echoQuery("D"), "{input}");

    // Two roots off the start, three branches into the end: both are allowed.
    // (The seed already wires start → the seeded agent and that agent → end.)
    const existing = new Set((await snapshot(ws6)).edges.map((e) => `${e.from}->${e.to}`));
    for (const [from, to] of [[start.id, a], [start.id, b], [a, c], [b, c], [c, d], [d, end.id], [b, end.id]]) {
      if (existing.has(`${from}->${to}`)) continue;
      const added = await act("addEdge", { from, to }, ws6);
      assert.ok(added.res.ok, `addEdge ${from} → ${to}: ${added.data?.error}`);
    }
    const graph = await snapshot(ws6);
    assert.equal(graph.edges.filter((e) => e.from === start.id).length, 2, "the start feeds both branches");
    assert.equal(graph.edges.filter((e) => e.to === end.id).length, 3, "and the end takes all three");

    const started = await runApi("start", { task: "go" }, ws6);
    assert.ok(started.res.ok, started.data?.error);
    const run = await waitRun(ws6, 40_000);
    assert.equal(run.status, "done");
    const timing = run.nodes;

    // Parallel: the two roots were in flight at the same time.
    assert.ok(Math.abs(timing[a].startedAt - timing[b].startedAt) <= 300,
      `A and B started together (${timing[a].startedAt - run.startedAt}ms vs ${timing[b].startedAt - run.startedAt}ms)`);
    assert.ok(timing[a].finishedAt > timing[b].startedAt && timing[b].finishedAt > timing[a].startedAt,
      "and their runs overlapped");

    // Sequential: the join waited for both parents, and the chain step waited for
    // the join.
    assert.ok(timing[c].startedAt >= timing[a].finishedAt - 20,
      `C waited for A (C ${timing[c].startedAt - run.startedAt}ms, A finished ${timing[a].finishedAt - run.startedAt}ms)`);
    assert.ok(timing[c].startedAt >= timing[b].finishedAt - 20, "C waited for B");
    assert.ok(timing[d].startedAt >= timing[c].finishedAt - 20, "D waited for C");

    // Both upstream outputs reached the join, and the whole run stayed well under
    // the 2.4s it would take if every step were serialised…
    assert.match(timing[c].outputTail, /A\[go\]/);
    assert.match(timing[c].outputTail, /B\[go\]/);
    assert.match(timing[d].outputTail, /C\[/);
    assert.equal(timing[end.id].status, "done");
    const wall = run.finishedAt - run.startedAt;
    assert.ok(wall < 2000, `the branches ran in parallel (run took ${wall}ms)`);
  });

  test("runs a harness with the node's model and tool selection as that CLI's own flags", async () => {
    const s = await snapshot(ws4);
    const agent = s.nodes.find((n) => n.type === "agent");
    const updated = await act("updateNode", { id: agent.id, name: "flag-check", config: {
      harness: "claude", model: "sonnet", tools: ["bash", "read"], prompt: "{task}",
    } }, ws4);
    assert.ok(updated.res.ok, updated.data?.error);

    const started = await runApi("start", { task: "flag check" }, ws4);
    assert.ok(started.res.ok, started.data?.error);
    const run = await waitRun(ws4);
    assert.equal(run.status, "done", JSON.stringify(run.log));
    assert.match(run.nodes[agent.id].outputTail, /CLAUDE_STUB_OK/);

    const argv = fs.readFileSync(claudeLog, "utf8").split("\n");
    assert.equal(argv[argv.indexOf("--model") + 1], "sonnet", "the model flag is passed");
    assert.equal(argv[argv.indexOf("--allowedTools") + 1], "bash,read", "the tool allowlist is passed as one csv argument");
    // Every harness also gets the selection as env vars, for shell commands.
    assert.ok(argv.includes("SW_TOOLS=bash,read SW_MODEL=sonnet"), "SW_* env reflects the node");
  });

  test("maps the same selection onto a different harness's flag", async () => {
    const s = await snapshot(ws4);
    const agent = s.nodes.find((n) => n.type === "agent");
    assert.ok((await act("updateNode", { id: agent.id, name: "gemini-check", config: {
      harness: "gemini", model: "gemini-2.5-flash", tools: ["run_shell_command"], prompt: "{task}",
    } }, ws4)).res.ok);

    const started = await runApi("start", { task: "gemini flags" }, ws4);
    assert.ok(started.res.ok, started.data?.error);
    const run = await waitRun(ws4);
    assert.equal(run.status, "done", JSON.stringify(run.log));
    assert.match(run.nodes[agent.id].outputTail, /GEMINI_STUB_OK/);
    const argv = fs.readFileSync(geminiLog, "utf8").split("\n");
    assert.equal(argv[argv.indexOf("--allowed-tools") + 1], "run_shell_command");
    assert.equal(argv[argv.indexOf("--model") + 1], "gemini-2.5-flash");
  });

  test("hands opencode its prompt on stdin, never on the command line", async () => {
    // On Windows `opencode` is a `.cmd` shim, so it is launched through cmd.exe,
    // and cmd.exe ends its command line at the first newline: an argv prompt
    // reached the CLI as the single word `<user query>` and the model answered
    // "your message came through empty" — with exit code 0, so the run looked
    // healthy. Every prompt this runner builds is multi-line (the tag alone is
    // three lines), so opencode's prompt has to travel on stdin instead.
    const solo = path.join(tmpDir, "ws-opencode-stdin");
    fs.mkdirSync(solo, { recursive: true });
    const s = await snapshot(solo);
    const agent = s.nodes.find((n) => n.type === "agent");
    assert.ok((await act("updateNode", { id: agent.id, name: "stdin-check", config: {
      harness: "opencode", model: "zen/deepseek-v4.1-flash", prompt: "stdin check {task}",
    } }, solo)).res.ok);

    fs.rmSync(opencodePromptLog, { force: true });
    const started = await runApi("start", { task: "go" }, solo);
    assert.ok(started.res.ok, started.data?.error);
    const run = await waitRun(solo);
    assert.equal(run.status, "done", JSON.stringify(run.log));
    assert.match(run.nodes[agent.id].outputTail, /OPENCODE_RUN_OK/);

    // The launch carries the subcommand and the model flag and no message…
    const record = fs.readFileSync(opencodePromptLog, "utf8").trimEnd().split("\n");
    assert.deepEqual(record, [
      "argv: run",
      "argv: --model",
      "argv: zen/deepseek-v4.1-flash",
      // …and the whole tagged prompt goes down its stdin, tags and all.
      "stdin: <user query>",
      "stdin check go",
      "</user query>",
    ]);
  });

  test("keeps a harness's escape sequences and split characters out of its message", async () => {
    const solo = path.join(tmpDir, "ws-escapes");
    fs.mkdirSync(solo, { recursive: true });
    const s = await snapshot(solo);
    const agent = s.nodes.find((n) => n.type === "agent");

    // A harness writes bytes to a pipe the way opencode does: an SGR reset on a
    // write of its own (`\u001b[91m\u001b[0m`), then the line it colours, then an
    // em-dash whose three UTF-8 bytes are split across two writes — a read
    // boundary can land inside a character just as easily as between lines.
    const command =
      "printf '\\033[91m\\033[0m'; sleep 0.3; " +
      "printf '\\342'; sleep 0.3; printf '\\200\\224 done\\033[0m\\n'";
    const upd = await act("updateNode", { id: agent.id, name: "escapey", config: {
      harness: "custom", command, prompt: "{task}",
    } }, solo);
    assert.ok(upd.res.ok, upd.data?.error);

    const started = await runApi("start", { task: "escape check" }, solo);
    assert.ok(started.res.ok, started.data?.error);
    const run = await waitRun(solo);
    assert.equal(run.status, "done", JSON.stringify(run.log));

    // The messages sidebar reads one row per line of output: the harness wrote
    // one sentence, so the node has one row holding that sentence — not a row of
    // nothing but escape bytes, and not a half-written fragment — and the
    // em-dash decodes as an em-dash instead of as a replacement character.
    const rows = run.log.filter((l) => l.nodeId === agent.id && l.stream === "stdout").map((l) => l.text);
    assert.deepEqual(rows, ["\u2014 done"]);
    assert.equal(run.nodes[agent.id].outputTail, "\u2014 done\n");
    assert.ok(!JSON.stringify(run).includes("\u001b"), "no escape sequence reaches the view");
    assert.ok(!JSON.stringify(run).includes("\ufffd"), "no character was cut in half");
  });

  test("keeps one row for a status line a harness repaints, counting the repeats", async () => {
    const solo = path.join(tmpDir, "ws-repaint");
    fs.mkdirSync(solo, { recursive: true });
    const s = await snapshot(solo);
    const agent = s.nodes.find((n) => n.type === "agent");

    // opencode paints `> build · model` again on every step and every wait; a
    // pipe turns each repaint into its own line, which used to read in the
    // sidebar as the agent restarting. Three repaints in a row are one row.
    const banner = "> build · deepseek-v4.1-flash-free";
    const command =
      "printf '> build · deepseek-v4.1-flash-free\\n'; sleep 0.2; " +
      "printf '> build · deepseek-v4.1-flash-free\\n'; sleep 0.2; " +
      "printf '> build · deepseek-v4.1-flash-free\\n'; " +
      "printf 'the answer\\n'";
    const upd = await act("updateNode", { id: agent.id, name: "repainter", config: {
      harness: "custom", command, prompt: "{task}",
    } }, solo);
    assert.ok(upd.res.ok, upd.data?.error);

    const started = await runApi("start", { task: "repaint check" }, solo);
    assert.ok(started.res.ok, started.data?.error);
    const run = await waitRun(solo);
    assert.equal(run.status, "done", JSON.stringify(run.log));

    const rows = run.log.filter((l) => l.nodeId === agent.id && l.stream === "stdout");
    assert.deepEqual(rows.map((l) => l.text), [banner, "the answer"],
      "the repaints collapse into the one row that was painted, then the answer");
    assert.equal(rows[0].repeat, 3, "and the row says how many times it was painted");

    // The node's own result is untouched: all three banners are still in it.
    assert.equal((run.nodes[agent.id].outputTail.match(/build ·/g) || []).length, 3,
      "collapsing the log does not rewrite the harness's output");
  });

  test("reports a failed harness's own error line, not the status banner it repainted", async () => {
    const solo = path.join(tmpDir, "ws-stderr-error");
    fs.mkdirSync(solo, { recursive: true });
    const s = await snapshot(solo);
    const agent = s.nodes.find((n) => n.type === "agent");

    // The mixed stderr a failing opencode leaves: its banner and a tool row, then
    // the provider's refusal — what the reader needs is the refusal.
    const command =
      "printf '> build · deepseek-v4.1-flash-free\\n' >&2; " +
      "printf '◈ Web Search via Exa \"x\"\\n' >&2; " +
      "printf 'Error: Provider request failed with HTTP 500\\n' >&2; exit 1";
    const upd = await act("updateNode", { id: agent.id, name: "failing", config: {
      harness: "custom", command, prompt: "{task}",
    } }, solo);
    assert.ok(upd.res.ok, upd.data?.error);

    const started = await runApi("start", { task: "fail check" }, solo);
    assert.ok(started.res.ok, started.data?.error);
    const run = await waitRun(solo);
    assert.equal(run.status, "error");
    assert.match(run.nodes[agent.id].error, /Provider request failed with HTTP 500/);
    assert.doesNotMatch(run.nodes[agent.id].error, /build ·/, "the banner is not the error");
  });

  test("falls back to the exit code when a failing harness wrote only status rows", async () => {
    const solo = path.join(tmpDir, "ws-status-only");
    fs.mkdirSync(solo, { recursive: true });
    const s = await snapshot(solo);
    const agent = s.nodes.find((n) => n.type === "agent");

    const command =
      "printf '> build · deepseek-v4.1-flash-free\\n' >&2; " +
      "printf '◈ Web Search via Exa \"x\"\\n' >&2; exit 3";
    const upd = await act("updateNode", { id: agent.id, name: "silent", config: {
      harness: "custom", command, prompt: "{task}",
    } }, solo);
    assert.ok(upd.res.ok, upd.data?.error);

    const started = await runApi("start", { task: "silent fail" }, solo);
    assert.ok(started.res.ok, started.data?.error);
    const run = await waitRun(solo);
    assert.equal(run.status, "error");
    assert.equal(run.nodes[agent.id].error, "exited with code 3",
      "a banner-only stderr leaves the exit code as the reason");
  });

  test("resolves a Pi node's skills against the agent dir, reporting what is missing", async () => {
    const s = await snapshot(ws5);
    const agent = s.nodes.find((n) => n.type === "agent");
    assert.ok((await act("updateNode", { id: agent.id, name: "pi-node", config: {
      harness: "pi", skills: ["demo-skill", "ghost-skill"], tools: ["read"], prompt: "{input}",
    } }, ws5)).res.ok);

    // An empty task makes the node's prompt empty, so it stops before spawning
    // Pi — but it has already resolved and reported its skills by then.
    const started = await runApi("start", { task: "" }, ws5);
    assert.ok(started.res.ok, started.data?.error);
    const run = await waitRun(ws5);
    assert.equal(run.nodes[agent.id].status, "error");
    assert.match(run.nodes[agent.id].error || "", /prompt is empty/);
    assert.ok(
      run.log.some((l) => /1 selected skill\/extension path\(s\) not found/.test(l.text)),
      `expected a missing-path report, got: ${JSON.stringify(run.log.map((l) => l.text))}`,
    );
  });

  test("qualifies a Pi node's bare model, and names the providers when it cannot", async () => {
    const solo = path.join(tmpDir, "ws-pi-model");
    fs.mkdirSync(solo, { recursive: true });
    const s = await snapshot(solo);
    const agent = s.nodes.find((n) => n.type === "agent");

    // A bare id exactly one provider offers: pi is handed the qualified key, so
    // a graph saved before the picker carried providers keeps running.
    assert.ok((await act("updateNode", { id: agent.id, name: "pi-node", config: {
      harness: "pi", model: "grok-4", prompt: "{input}",
    } }, solo)).res.ok);
    // An empty task stops the node before it spawns pi — by then it has already
    // reported the model it resolved.
    assert.ok((await runApi("start", { task: "" }, solo)).res.ok);
    let run = await waitRun(solo);
    assert.ok(
      run.log.some((l) => l.text.includes('model "grok-4" → tokenharbor/grok-4')),
      `expected the model to be qualified, got: ${JSON.stringify(run.log.map((l) => l.text))}`,
    );

    // An id two providers ship is not guessed at: the run names both, instead of
    // handing pi an id it refuses with "ambiguous across providers".
    assert.ok((await act("updateNode", { id: agent.id, config: { harness: "pi", model: "mimo-v2.6-flash" } }, solo)).res.ok);
    assert.ok((await runApi("start", { task: "" }, solo)).res.ok);
    run = await waitRun(solo);
    const warn = run.log.map((l) => l.text).find((t) => /offered by 2 providers/.test(t));
    assert.ok(warn, `expected an ambiguity report, got: ${JSON.stringify(run.log.map((l) => l.text))}`);
    assert.match(warn, /tokenharbor\/mimo-v2\.6-flash/);
    assert.match(warn, /xiaomi\/mimo-v2\.6-flash/);
  });

  test("stops a long run and marks it stopped", async () => {
    await buildCustomGraph(ws2); // (re-asserts the graph shape)
    const s = await snapshot(ws2);
    const first = s.nodes.find((n) => n.name === "first");
    await act("updateNode", { id: first.id, config: { harness: "custom", command: "sleep 30", prompt: "{task}" } }, ws2);

    const started = await runApi("start", { task: "linger" }, ws2);
    assert.ok(started.res.ok, started.data?.error);
    await sleep(600);
    const stopped = await runApi("stop", {}, ws2);
    assert.ok(stopped.res.ok);
    const run = stopped.data.run;
    assert.equal(run.status, "stopped");
    assert.equal(run.nodes[first.id].status, "stopped");
  });

  test("disabling the plugin refuses its routes with a 403", async () => {
    await api("/plugins", { method: "POST", body: JSON.stringify({ action: "disable", id: PLUGIN }) });
    assert.equal((await api(`/${PLUGIN}?cwd=${enc(ws)}`)).res.status, 403);
    await api("/plugins", { method: "POST", body: JSON.stringify({ action: "enable", id: PLUGIN }) });
    assert.equal((await api(`/${PLUGIN}?cwd=${enc(ws)}`)).res.status, 200);
  });

  // ── Run guards: enable / gate / retry ─────────────────────────────────────

  test("stores a node's run guards and clamps them to the server's caps", async () => {
    const solo = path.join(tmpDir, "ws-guards");
    fs.mkdirSync(solo, { recursive: true });
    const s = await snapshot(solo);
    const agent = s.nodes.find((n) => n.type === "agent");

    // A brand-new node is backwards compatible: on, always running, no retries.
    assert.equal(agent.config.enabled, true);
    assert.deepEqual(agent.config.when, { mode: "always", value: "" });
    assert.equal(agent.config.retries, 0);
    assert.equal(agent.config.retryDelaySec, 0);

    const upd = await act("updateNode", { id: agent.id, config: {
      enabled: false, when: { mode: "contains", value: "PASS" }, retries: 99, retryDelaySec: 9999,
    } }, solo);
    assert.ok(upd.res.ok, upd.data?.error);
    const c = upd.data.nodes.find((n) => n.id === agent.id).config;
    assert.equal(c.enabled, false);
    assert.deepEqual(c.when, { mode: "contains", value: "PASS" });
    assert.equal(c.retries, 5, "retries clamped to the cap");
    assert.equal(c.retryDelaySec, 120, "retry delay clamped to the cap");

    // An unknown gate operator falls back to "always" instead of being stored.
    const upd2 = await act("updateNode", { id: agent.id, config: { when: { mode: "regex", value: "x" } } }, solo);
    assert.deepEqual(upd2.data.nodes.find((n) => n.id === agent.id).config.when, { mode: "always", value: "x" });
  });

  test("runs a switched-off node as a pass-through and forwards its input", async () => {
    const solo = path.join(tmpDir, "ws-bypass");
    fs.mkdirSync(solo, { recursive: true });
    const g = await buildCustomGraph(solo);
    assert.ok((await act("updateNode", { id: g.a2.id, config: { enabled: false } }, solo)).res.ok);

    const started = await runApi("start", { task: "hello" }, solo);
    assert.ok(started.res.ok, started.data?.error);
    const run = await waitRun(solo);
    assert.equal(run.status, "done");
    assert.equal(run.nodes[g.a2.id].status, "skipped");
    assert.equal(run.nodes[g.a2.id].bypassed, true);
    assert.equal(run.nodes[g.a3.id].status, "done");
    assert.equal(run.nodes[g.end.id].status, "done");
    // The bypassed node never spawned, and its input reached the end node.
    assert.ok(!run.log.some((l) => l.text.includes("A2[")), "the bypassed node never ran");
    assert.match(run.nodes[g.end.id].outputTail, /A1\[hello\]/);
    assert.ok(run.log.some((l) => /bypassed \(switched off\)/.test(l.text)));
  });

  test("gates a node on its upstream output", async () => {
    const solo = path.join(tmpDir, "ws-gate");
    fs.mkdirSync(solo, { recursive: true });
    const g = await buildCustomGraph(solo);

    // The upstream output contains A1 → the gate matches and the node runs.
    assert.ok((await act("updateNode", { id: g.a2.id, config: { when: { mode: "contains", value: "A1" } } }, solo)).res.ok);
    assert.ok((await runApi("start", { task: "hello" }, solo)).res.ok);
    let run = await waitRun(solo);
    assert.equal(run.status, "done");
    assert.equal(run.nodes[g.a2.id].status, "done");
    assert.equal(run.nodes[g.a2.id].bypassed, false);

    // It does not contain ZZZ → bypassed, and the workflow still completes.
    assert.ok((await act("updateNode", { id: g.a2.id, config: { when: { mode: "contains", value: "ZZZ" } } }, solo)).res.ok);
    assert.ok((await runApi("start", { task: "hello" }, solo)).res.ok);
    run = await waitRun(solo);
    assert.equal(run.status, "done");
    assert.equal(run.nodes[g.a2.id].status, "skipped");
    assert.equal(run.nodes[g.a2.id].bypassed, true);
    assert.equal(run.nodes[g.a3.id].status, "done");
    assert.ok(run.log.some((l) => /contains ZZZ.*not met/.test(l.text)), JSON.stringify(run.log.map((l) => l.text)));
  });

  test("retries a failing agent, then gives up after the attempts run out", async () => {
    const solo = path.join(tmpDir, "ws-retry");
    fs.mkdirSync(solo, { recursive: true });
    const g = await buildCustomGraph(solo);

    // Fails the first two invocations, then succeeds — the run must still pass.
    try { fs.unlinkSync(path.join(solo, "retry-count")); } catch { /* none yet */ }
    const flaky = 'c=$(cat retry-count 2>/dev/null || echo 0); c=$((c+1)); echo $c > retry-count; ' +
      'if [ $c -lt 3 ]; then echo "boom $c" >&2; exit 1; fi; printf "OK[%s]" "' + QUERY + '"';
    assert.ok((await act("updateNode", { id: g.a3.id, config: {
      harness: "custom", command: flaky, prompt: "{input}", retries: 3, retryDelaySec: 0,
    } }, solo)).res.ok);

    assert.ok((await runApi("start", { task: "hello" }, solo)).res.ok);
    let run = await waitRun(solo);
    assert.equal(run.status, "done", JSON.stringify(run.log));
    assert.equal(run.nodes[g.a3.id].status, "done");
    assert.equal(run.nodes[g.a3.id].outputTail, "OK[A1[hello]]");
    assert.ok(run.log.some((l) => /attempt 2\/4/.test(l.text)));
    assert.ok(run.log.some((l) => /attempt 3\/4/.test(l.text)));

    // A node that never succeeds exhausts its retries and errors the run.
    assert.ok((await act("updateNode", { id: g.a2.id, config: {
      harness: "custom", command: "echo nope >&2; exit 3", prompt: "{input}", retries: 1, retryDelaySec: 0,
    } }, solo)).res.ok);
    assert.ok((await runApi("start", { task: "hello" }, solo)).res.ok);
    run = await waitRun(solo);
    assert.equal(run.nodes[g.a2.id].status, "error");
    assert.equal(run.status, "error");
    assert.ok(run.log.some((l) => /attempt 2\/2/.test(l.text)));
  });

  // ── Human-in-the-loop approval gates ────────────────────────────────────

  test("stores approval gates: repeatable, with a message and the shared guards", async () => {
    const solo = path.join(tmpDir, "ws-gate-config");
    fs.mkdirSync(solo, { recursive: true });
    await snapshot(solo);

    const a = (await act("addNode", { type: "approval" }, solo)).data.nodes.at(-1);
    assert.equal(a.type, "approval");
    assert.equal(a.name, "Approval");
    assert.deepEqual(a.config, { description: "", message: "", enabled: true, when: { mode: "always", value: "" } });
    const b = (await act("addNode", { type: "approval" }, solo)).data.nodes.at(-1);
    assert.notEqual(a.id, b.id, "a workflow can hold several gates");

    const upd = await act("updateNode", { id: a.id, name: "sign-off", config: {
      description: "Ship it?", message: "Review {task}:\n{input}", when: { mode: "notEmpty" }, enabled: false,
    } }, solo);
    assert.ok(upd.res.ok, upd.data?.error);
    const saved = upd.data.nodes.find((n) => n.id === a.id);
    assert.equal(saved.name, "sign-off");
    assert.equal(saved.config.message, "Review {task}:\n{input}");
    assert.equal(saved.config.enabled, false);
    assert.deepEqual(saved.config.when, { mode: "notEmpty", value: "" });

    // Gates clone like agents, and survive an export/import round-trip.
    assert.ok((await act("duplicateNode", { id: a.id }, solo)).res.ok);
    const snapshotNow = await snapshot(solo);
    const imp = await act("importWorkflow", { data: { name: "g", nodes: snapshotNow.nodes, edges: [] } }, solo);
    assert.ok(imp.res.ok, imp.data?.error);
    assert.ok(imp.data.nodes.some((n) => n.type === "approval"));
    assert.equal(imp.data.nodes.filter((n) => n.type === "approval").length, 3);
  });

  test("pauses a run at an approval gate until it is approved", async () => {
    const solo = path.join(tmpDir, "ws-approve");
    fs.mkdirSync(solo, { recursive: true });
    const g = await buildApprovalGraph(solo);

    assert.ok((await runApi("start", { task: "hello" }, solo)).res.ok);
    const waiting = await waitNode(solo, g.gate.id, "waiting");
    assert.equal(waiting.status, "running", "a paused run is still a live run");
    assert.equal(waiting.nodes[g.gate.id].approval.message, "Please review: A1[hello]");
    assert.equal(waiting.nodes[g.gate.id].bypassed, false);
    assert.equal(waiting.nodes[g.last.id].status, "pending", "downstream waits for the decision");
    assert.ok(waiting.log.some((l) => /awaiting approval/.test(l.text)));

    const decided = await runApi("approve", { nodeId: g.gate.id, note: "looks good" }, solo);
    assert.ok(decided.res.ok, decided.data?.error);
    const gateState = decided.data.run.nodes[g.gate.id];
    assert.equal(gateState.status, "done");
    assert.equal(gateState.approval, null);
    assert.equal(gateState.decision.approve, true);
    assert.equal(gateState.decision.note, "looks good");

    const run = await waitRun(solo);
    assert.equal(run.status, "done");
    assert.equal(run.nodes[g.last.id].status, "done");
    // The reviewed input reached the next agent, with the note appended.
    assert.match(run.nodes[g.last.id].outputTail, /^L\[A1\[hello\]/);
    assert.ok(run.nodes[g.last.id].outputTail.includes("Human review: looks good"));
    assert.ok(run.log.some((l) => /review approved/.test(l.text)));
  });

  test("a settled node's final result reaches an incremental run poll", async () => {
    // The incremental poll (the page's per-tick read) leaves out a running
    // node's tail on purpose, but a *settled* node's final result has to ride
    // along: the messages sidebar reads it as a waiting gate's input — and as
    // the end node's answer — before the whole run finishes, rather than waiting
    // for the next full read.
    const solo = path.join(tmpDir, "ws-gate-brief-tail");
    fs.mkdirSync(solo, { recursive: true });
    const g = await buildApprovalGraph(solo);
    assert.ok((await runApi("start", { task: "hello" }, solo)).res.ok);
    const waiting = await waitNode(solo, g.gate.id, "waiting");
    // Poll incrementally, exactly the way the open page does mid-run.
    const poll = (await api(`/${PLUGIN}/run?cwd=${enc(solo)}&since=${waiting.seq}`)).data.run;
    const first = poll.nodes[g.first.id];
    assert.equal(first.status, "done");
    assert.equal(first.outputTail, "A1[hello]", "the settled agent's final result is in the incremental payload");
    assert.equal(poll.log.some((l) => l.seq <= waiting.seq), false, "and it really is the incremental shape");
  });

  test("rejecting a gate fails the run and skips the downstream", async () => {
    const solo = path.join(tmpDir, "ws-reject");
    fs.mkdirSync(solo, { recursive: true });
    const g = await buildApprovalGraph(solo);

    assert.ok((await runApi("start", { task: "hello" }, solo)).res.ok);
    await waitNode(solo, g.gate.id, "waiting");
    const decided = await runApi("reject", { nodeId: g.gate.id, note: "not yet" }, solo);
    assert.ok(decided.res.ok, decided.data?.error);

    const run = await waitRun(solo);
    assert.equal(run.status, "error");
    assert.equal(run.nodes[g.gate.id].status, "error");
    assert.match(run.nodes[g.gate.id].error, /not yet/);
    assert.equal(run.nodes[g.last.id].status, "skipped");
    assert.ok(run.log.some((l) => /review rejected/.test(l.text)));
  });

  test("a switched-off or gated-out approval node never pauses the run", async () => {
    const solo = path.join(tmpDir, "ws-gate-off");
    fs.mkdirSync(solo, { recursive: true });
    const g = await buildApprovalGraph(solo);
    assert.ok((await act("updateNode", { id: g.gate.id, config: { enabled: false } }, solo)).res.ok);

    assert.ok((await runApi("start", { task: "hello" }, solo)).res.ok);
    const run = await waitRun(solo);
    assert.equal(run.status, "done");
    assert.equal(run.nodes[g.gate.id].status, "skipped");
    assert.equal(run.nodes[g.gate.id].bypassed, true);
    assert.equal(run.nodes[g.last.id].status, "done");
    assert.ok(!run.log.some((l) => /awaiting approval/.test(l.text)));
  });

  test("refuses decisions that no waiting gate is asking for", async () => {
    const solo = path.join(tmpDir, "ws-bad-decision");
    fs.mkdirSync(solo, { recursive: true });
    const g = await buildApprovalGraph(solo);

    assert.equal((await runApi("approve", { nodeId: g.gate.id }, solo)).res.status, 409, "no run yet");
    assert.ok((await runApi("start", { task: "hello" }, solo)).res.ok);
    await waitNode(solo, g.gate.id, "waiting");
    assert.equal((await runApi("approve", {}, solo)).res.status, 400, "a decision names its node");
    assert.equal((await runApi("approve", { nodeId: g.first.id }, solo)).res.status, 409, "an agent is not a gate");

    // Stopping clears the gate, so a late decision is refused rather than
    // reviving a dead run.
    assert.ok((await runApi("stop", {}, solo)).res.ok);
    assert.equal((await liveRun(solo)).nodes[g.gate.id].status, "stopped");
    assert.equal((await runApi("approve", { nodeId: g.gate.id }, solo)).res.status, 409);
  });

  // ── Run history ─────────────────────────────────────────────────────────

  test("records finished runs and serves them back, newest first", async () => {
    const solo = path.join(tmpDir, "ws-history");
    fs.mkdirSync(solo, { recursive: true });
    const g = await buildCustomGraph(solo);

    assert.ok((await runApi("start", { task: "hello" }, solo)).res.ok);
    const run = await waitRun(solo);
    assert.equal(run.status, "done");

    const list = await api(`/${PLUGIN}/history?cwd=${enc(solo)}`);
    assert.ok(list.res.ok);
    const entry = list.data.history.find((h) => h.id === run.id);
    assert.ok(entry, "the finished run is listed");
    assert.equal(entry.status, "done");
    assert.equal(entry.task, "hello");
    assert.equal(entry.interrupted, false);
    assert.ok(entry.done >= 3, "it counts the settled nodes");
    assert.ok(entry.logLines > 0);

    // The detail endpoint returns the run itself, log and output tails included.
    const detail = await api(`/${PLUGIN}/history?cwd=${enc(solo)}&id=${enc(run.id)}`);
    assert.ok(detail.res.ok);
    assert.equal(detail.data.run.id, run.id);
    assert.equal(detail.data.run.nodes[g.first.id].status, "done");
    assert.equal(detail.data.run.nodes[g.first.id].outputTail, "A1[hello]");
    assert.ok(detail.data.run.log.some((l) => /A1\[hello\]/.test(l.text)));

    // The graph snapshot carries the summaries, so opening the view has them.
    assert.ok((await snapshot(solo)).history.some((h) => h.id === run.id));

    // A new run pushes the previous one down; both stay reopenable.
    assert.ok((await runApi("start", { task: "again" }, solo)).res.ok);
    const run2 = await waitRun(solo);
    assert.notEqual(run2.id, run.id);
    const list2 = (await api(`/${PLUGIN}/history?cwd=${enc(solo)}`)).data.history;
    assert.equal(list2[0].id, run2.id, "newest first");
    assert.ok(list2.some((h) => h.id === run.id), "the older run is still there");
    assert.equal((await api(`/${PLUGIN}/history?cwd=${enc(solo)}&id=nope`)).res.status, 404);
  });

  test("reopens a run recorded before the cleanup without its escape junk", async () => {
    const solo = path.join(tmpDir, "ws-legacy-record");
    fs.mkdirSync(path.join(solo, ".pi-scope", "plugins", ".data"), { recursive: true });
    // A record as an older build wrote it: the harness's bytes kept raw, so the
    // agent's answer begins with a bare `\u001b[0m` (which a reader sees as
    // `[0m` in front of the first word).
    const legacy = {
      id: "run_legacy", status: "done", task: "old",
      startedAt: 1, finishedAt: 2, seq: 3, interrupted: false, concurrency: 4,
      nodes: { n1: { status: "done", outputTail: "\u001b[0m\u2014 done\n" } },
      log: [
        { seq: 1, ts: 1, nodeId: "n1", stream: "stderr", text: "\u001b[0m" },
        { seq: 2, ts: 2, nodeId: "n1", stream: "stdout", text: "\u001b[0m\u25c8 Web Search" },
      ],
    };
    fs.writeFileSync(storePath(solo), JSON.stringify({ runs: { [solo]: [legacy] } }, null, 2));

    const list = await api(`/${PLUGIN}/history?cwd=${enc(solo)}`);
    assert.ok(list.res.ok, list.data?.error);
    assert.equal(list.data.history.length, 1, "the stored record is listed");

    const detail = await api(`/${PLUGIN}/history?cwd=${enc(solo)}&id=run_legacy`);
    assert.ok(detail.res.ok, detail.data?.error);
    const run = detail.data.run;
    assert.equal(run.nodes.n1.outputTail, "\u2014 done\n");
    assert.deepEqual(run.log.map((l) => l.text), ["\u25c8 Web Search"],
      "the empty escape row is dropped and the rest reads as text");
  });

  test("caps the stored history and trims a chatty run's log", async () => {
    const solo = path.join(tmpDir, "ws-history-cap");
    fs.mkdirSync(solo, { recursive: true });
    const s = await snapshot(solo);
    const first = s.nodes.find((n) => n.type === "agent");
    assert.ok((await act("updateNode", { id: first.id, name: "chatty", config: {
      harness: "custom", prompt: "{task}",
      command: "i=0; while [ $i -lt 300 ]; do echo line-$i; i=$((i+1)); done",
    } }, solo)).res.ok);

    // Eleven short runs: the store keeps the most recent ten.
    for (let n = 0; n < 11; n++) {
      assert.ok((await runApi("start", { task: `run-${n}` }, solo)).res.ok);
      assert.equal((await waitRun(solo)).status, "done");
    }
    const history = (await api(`/${PLUGIN}/history?cwd=${enc(solo)}`)).data.history;
    assert.equal(history.length, 10, "older runs are dropped");
    assert.equal(history[0].task, "run-10", "the newest is kept");
    assert.ok(!history.some((h) => h.task === "run-0"), "the oldest is gone");

    const detail = (await api(`/${PLUGIN}/history?cwd=${enc(solo)}&id=${enc(history[0].id)}`)).data.run;
    assert.ok(detail.log.length <= 120, `stored log is capped, got ${detail.log.length}`);
    assert.ok(detail.log.every((l) => String(l.text).length <= 1000));
  });

  test("reports a run left unfinished by a restart as interrupted, not live", async () => {
    // A workspace the plugin has never touched, so its store file is read fresh
    // — exactly what happens after a restart, with no engine behind the record.
    const solo = path.join(tmpDir, "ws-interrupted");
    fs.mkdirSync(solo, { recursive: true });
    const real = fs.realpathSync(solo);
    const file = storePath(solo);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      runs: {
        [real]: [{
          id: "run_ghost", status: "running", task: "was in flight",
          startedAt: Date.now() - 5000, finishedAt: null, seq: 4,
          nodes: { n1: { status: "done" }, n2: { status: "running" } },
          log: [{ seq: 4, ts: Date.now(), nodeId: "n2", stream: "status", text: "started" }],
        }],
      },
    }, null, 2));

    const list = await api(`/${PLUGIN}/history?cwd=${enc(solo)}`);
    assert.ok(list.res.ok, list.data?.error);
    assert.equal(list.data.history.length, 1);
    assert.equal(list.data.history[0].status, "interrupted");
    assert.equal(list.data.history[0].interrupted, true);

    const detail = await api(`/${PLUGIN}/history?cwd=${enc(solo)}&id=run_ghost`);
    assert.equal(detail.data.run.status, "interrupted");
    assert.ok(detail.data.run.log.some((l) => l.text === "started"), "its log survives too");

    // The correction is persisted, so it is not recomputed on every read.
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(stored.runs[real][0].status, "interrupted");
  });

  // ── Triggers: schedule + events ─────────────────────────────────────────

  const setTriggers = (payload, w = ws) => api(`/${PLUGIN}/triggers`, {
    method: "POST", body: JSON.stringify({ cwd: w, ...payload }),
  });

  test("stores triggers: a schedule and an event watch, validated", async () => {
    const solo = path.join(tmpDir, "ws-triggers");
    fs.mkdirSync(solo, { recursive: true });
    await snapshot(solo);

    const initial = await api(`/${PLUGIN}/triggers?cwd=${enc(solo)}`);
    assert.ok(initial.res.ok);
    assert.equal(initial.data.triggers.armed, false);
    assert.equal(initial.data.triggers.schedule.mode, "off");
    assert.equal(initial.data.triggers.nextRunAt, null);
    assert.deepEqual(initial.data.triggers.event, { enabled: false, types: [] });

    const saved = await setTriggers({
      schedule: { mode: "interval", everySeconds: 1, at: "99:99" },
      event: { enabled: true, types: ["tool_call", "tool_call", "", "x".repeat(200)] },
      task: "nightly",
    }, solo);
    assert.ok(saved.res.ok, saved.data?.error);
    const t = saved.data.triggers;
    assert.equal(t.schedule.mode, "interval");
    assert.equal(t.schedule.everySeconds, 5, "clamped to the floor");
    assert.equal(t.schedule.at, "09:00", "a malformed time falls back");
    assert.equal(t.event.enabled, true);
    assert.deepEqual(t.event.types, ["tool_call", "x".repeat(60)], "de-duplicated and clipped");
    assert.equal(t.task, "nightly");
    assert.equal(t.armed, true);
    assert.ok(t.nextRunAt > Date.now(), "the next run is in the future");

    // The graph snapshot carries them, so the view has them on open.
    assert.equal((await snapshot(solo)).triggers.armed, true);

    // Turning everything off disarms it and clears the next run.
    const off = await setTriggers({ schedule: { mode: "off" }, event: { enabled: false }, task: "" }, solo);
    assert.equal(off.data.triggers.armed, false);
    assert.equal(off.data.triggers.nextRunAt, null);
  });

  test("an interval schedule starts a run on its own", async () => {
    const solo = path.join(tmpDir, "ws-trigger-interval");
    fs.mkdirSync(solo, { recursive: true });
    const g = await buildCustomGraph(solo);
    const startNode = (await snapshot(solo)).nodes.find((n) => n.type === "start");
    assert.ok((await act("updateNode", { id: startNode.id, config: { defaultTask: "scheduled" } }, solo)).res.ok);

    const saved = await setTriggers({ schedule: { mode: "interval", everySeconds: 5 }, event: { enabled: false } }, solo);
    assert.ok(saved.res.ok, saved.data?.error);
    assert.equal(saved.data.triggers.armed, true);
    assert.equal(await liveRun(solo), null, "saving a trigger never fires a run immediately");

    const run = await waitNode(solo, g.first.id, "done", 25_000);
    assert.equal(run.task, "scheduled", "the run takes the start node's default task");
    assert.ok(run.log.some((l) => /started by schedule/.test(l.text)));
    assert.equal((await waitRun(solo)).status, "done");
  });

  test("an observed event starts a run for its workspace", async () => {
    const solo = path.join(tmpDir, "ws-trigger-event");
    fs.mkdirSync(solo, { recursive: true });
    const g = await buildCustomGraph(solo);
    assert.ok((await setTriggers({
      schedule: { mode: "off" }, event: { enabled: true, types: ["tool_call"] }, task: "from an event",
    }, solo)).res.ok);
    assert.equal(await liveRun(solo), null);

    const post = (type) => api("/events", { method: "POST", body: JSON.stringify({
      event_id: `evt-${type}-${Math.random().toString(16).slice(2)}`,
      session_id: "s1", seq: 0, ts: new Date().toISOString(), type, cwd: solo, payload: {},
    }) });

    // A type this trigger does not watch starts nothing.
    await post("file_read");
    await sleep(800);
    assert.equal(await liveRun(solo), null, "an unmatched event starts no run");

    await post("tool_call");
    const run = await waitNode(solo, g.first.id, "done", 25_000);
    assert.equal(run.task, "from an event");
    assert.ok(run.log.some((l) => /started by event:tool_call/.test(l.text)));
  });

  test("a trigger never starts a second run while one is in flight", async () => {
    const solo = path.join(tmpDir, "ws-trigger-busy");
    fs.mkdirSync(solo, { recursive: true });
    const g = await buildApprovalGraph(solo);
    assert.ok((await setTriggers({ schedule: { mode: "interval", everySeconds: 5 }, event: { enabled: false } }, solo)).res.ok);

    // Park a run on the approval gate, so the workspace is busy when the
    // schedule comes due.
    assert.ok((await runApi("start", { task: "manual" }, solo)).res.ok);
    const parked = await waitNode(solo, g.gate.id, "waiting");
    await sleep(6000);

    const now = await liveRun(solo);
    assert.equal(now.id, parked.id, "the parked run is still the only run");
    assert.equal(now.status, "running");
    assert.ok(!now.log.some((l) => /started by schedule/.test(l.text)), "the due schedule was skipped");
  });

  test("several start / end pairs run separately from the chosen entry point", async () => {
    const solo = path.join(tmpDir, "ws-multi-entry");
    fs.mkdirSync(solo, { recursive: true });
    const seeded = await snapshot(solo);
    const startA = seeded.nodes.find((n) => n.type === "start");
    const agentA = seeded.nodes.find((n) => n.type === "agent");
    const endA = seeded.nodes.find((n) => n.type === "end");
    assert.ok((await act("updateNode", { id: agentA.id, name: "a", config: {
      harness: "custom", command: echoQuery("A"), prompt: "{task}",
    } }, solo)).res.ok);

    // A second, independent entry point with its own branch and end node.
    const startB = (await act("addNode", { type: "start", x: 80, y: 520 }, solo)).data.nodes.at(-1);
    const agentB = (await act("addNode", { type: "agent", x: 360, y: 520 }, solo)).data.nodes.at(-1);
    const endB = (await act("addNode", { type: "end", x: 700, y: 520 }, solo)).data.nodes.at(-1);
    assert.ok((await act("updateNode", { id: startB.id, name: "Start B", config: { defaultTask: "from B" } }, solo)).res.ok);
    assert.ok((await act("updateNode", { id: agentB.id, name: "b", config: {
      harness: "custom", command: echoQuery("B"), prompt: "{task}",
    } }, solo)).res.ok);
    for (const [from, to] of [[startB.id, agentB.id], [agentB.id, endB.id]]) {
      const e = await act("addEdge", { from, to }, solo);
      assert.ok(e.res.ok, e.data?.error);
    }
    const graph = await snapshot(solo);
    assert.equal(graph.nodes.filter((n) => n.type === "start").length, 2, "two start nodes coexist");
    assert.equal(graph.nodes.filter((n) => n.type === "end").length, 2, "two end nodes coexist");

    // A trigger belongs to one start node, not the workspace.
    const trig = await api(`/${PLUGIN}/triggers`, {
      method: "POST", body: JSON.stringify({ cwd: solo, nodeId: startB.id,
        schedule: { mode: "interval", everySeconds: 3600 }, event: { enabled: false } }),
    });
    assert.ok(trig.res.ok, trig.data?.error);
    const after = await snapshot(solo);
    assert.equal(after.nodes.find((n) => n.id === startB.id).config.triggers.schedule.mode, "interval");
    assert.equal(after.nodes.find((n) => n.id === startA.id).config.triggers.schedule.mode, "off",
      "the sibling start's triggers are untouched");

    // Running from B leaves A's branch alone, and B's end carries B's answer.
    const runB = await runApi("start", { startId: startB.id }, solo);
    assert.ok(runB.res.ok, runB.data?.error);
    assert.equal(runB.data.run.startId, startB.id);
    const b = await waitRun(solo);
    assert.equal(b.status, "done");
    assert.equal(b.nodes[agentB.id].outputTail, "B[from B]");
    assert.equal(b.nodes[endB.id].outputTail, "B[from B]");
    assert.equal(b.nodes[agentA.id].status, "skipped", "the other workflow's agent did not run");
    assert.equal(b.nodes[endA.id].status, "skipped", "nor did its end node");

    // Running from A executes the first branch instead.
    assert.ok((await runApi("start", { task: "from A" }, solo)).res.ok);
    const a = await waitRun(solo);
    assert.equal(a.startId, startA.id, "with no startId the first start is the default");
    assert.equal(a.nodes[agentA.id].outputTail, "A[from A]");
    assert.equal(a.nodes[endA.id].outputTail, "A[from A]");
    assert.equal(a.nodes[agentB.id].status, "skipped");
    assert.equal(a.nodes[endB.id].status, "skipped");
  });

  // ── Groups: named frames over part of the canvas ─────────────────────────

  test("groups nodes into a named frame, moves them together and folds it", async () => {
    const solo = path.join(tmpDir, "ws-groups");
    fs.mkdirSync(solo, { recursive: true });
    const seeded = await snapshot(solo);
    const start = seeded.nodes.find((n) => n.type === "start");
    const agent = seeded.nodes.find((n) => n.type === "agent");
    const end = seeded.nodes.find((n) => n.type === "end");

    // Two nodes become one named sub-workflow.
    const made = await act("addGroup", { name: "Delivery", nodeIds: [start.id, agent.id] }, solo);
    assert.ok(made.res.ok, made.data?.error);
    assert.equal(made.data.groups.length, 1);
    const group = made.data.groups[0];
    assert.equal(group.name, "Delivery");
    assert.deepEqual(group.nodeIds.slice().sort(), [start.id, agent.id].sort());
    assert.equal(group.collapsed, false);
    assert.ok(group.x <= start.x && group.y <= start.y, "the frame anchors at its first member");

    // A node belongs to one group: grouping it again moves it, rather than
    // letting two frames claim the same card.
    const second = await act("addGroup", { name: "Planning", nodeIds: [start.id] }, solo);
    assert.ok(second.res.ok, second.data?.error);
    assert.equal(second.data.groups.length, 2);
    const planning = second.data.groups.find((g) => g.name === "Planning");
    const delivery = second.data.groups.find((g) => g.name === "Delivery");
    assert.deepEqual(planning.nodeIds, [start.id]);
    assert.deepEqual(delivery.nodeIds, [agent.id], "the first frame lost the re-claimed node");

    // Moving a frame moves every member by the same delta — and no one else.
    const before = await snapshot(solo);
    const x0 = before.nodes.find((n) => n.id === agent.id).x;
    const y0 = before.nodes.find((n) => n.id === agent.id).y;
    const endX = before.nodes.find((n) => n.id === end.id).x;
    const moved = await act("moveGroup", { id: delivery.id, dx: 120, dy: 45 }, solo);
    assert.ok(moved.res.ok, moved.data?.error);
    const after = moved.data;
    const agentAfter = after.nodes.find((n) => n.id === agent.id);
    assert.equal(agentAfter.x, x0 + 120);
    assert.equal(agentAfter.y, y0 + 45);
    assert.equal(after.nodes.find((n) => n.id === end.id).x, endX, "ungrouped nodes stay put");
    const deliveryAfter = after.groups.find((g) => g.id === delivery.id);
    assert.equal(deliveryAfter.x, delivery.x + 120);
    assert.equal(deliveryAfter.y, delivery.y + 45);

    // Folding and naming are persisted; membership can be replaced wholesale.
    const folded = await act("updateGroup", {
      id: delivery.id, name: "Ship", collapsed: true,
      nodeIds: [agent.id, end.id],
    }, solo);
    assert.ok(folded.res.ok, folded.data?.error);
    const ship = folded.data.groups.find((g) => g.id === delivery.id);
    assert.equal(ship.name, "Ship");
    assert.equal(ship.collapsed, true);
    assert.deepEqual(ship.nodeIds.slice().sort(), [agent.id, end.id].sort());

    // Ungrouping is a frame operation: the nodes survive it.
    const removed = await act("removeGroup", { id: delivery.id }, solo);
    assert.ok(removed.res.ok, removed.data?.error);
    assert.equal(removed.data.groups.length, 1);
    assert.equal(removed.data.nodes.length, seeded.nodes.length, "the nodes stay on the canvas");

    // Removing a node leaves the frame behind, minus that node.
    const planningAfter = removed.data.groups[0];
    const pruned = await act("removeNode", { id: start.id }, solo);
    assert.ok(pruned.res.ok, pruned.data?.error);
    assert.equal(pruned.data.groups.find((g) => g.id === planningAfter.id).nodeIds.length, 0,
      "the removed node left its group");
  });

  test("stores a manually resized group frame and clamps its box", async () => {
    const solo = path.join(tmpDir, "ws-group-resize");
    fs.mkdirSync(solo, { recursive: true });
    const seeded = await snapshot(solo);
    const agent = seeded.nodes.find((n) => n.type === "agent");
    const made = await act("addGroup", { name: "Sized", nodeIds: [agent.id] }, solo);
    assert.ok(made.res.ok, made.data?.error);
    assert.equal(made.data.groups[0].resizable, true, "a new frame starts resizable");
    const id = made.data.groups[0].id;

    const resized = await act("updateGroup", { id, x: 40, y: 30, w: 520, h: 380 }, solo);
    assert.ok(resized.res.ok, resized.data?.error);
    let g = resized.data.groups[0];
    assert.deepEqual({ x: g.x, y: g.y, w: g.w, h: g.h }, { x: 40, y: 30, w: 520, h: 380 });

    // Too-small and negative values are clamped rather than stored as-is.
    const clamped = await act("updateGroup", { id, x: -50, y: -20, w: 10, h: 10 }, solo);
    assert.ok(clamped.res.ok, clamped.data?.error);
    g = clamped.data.groups[0];
    assert.equal(g.x, 0);
    assert.equal(g.y, 0);
    assert.equal(g.w, 160);
    assert.equal(g.h, 100);

    // Clearing the size returns the frame to measuring itself from members.
    const auto = await act("updateGroup", { id, w: null, h: null }, solo);
    assert.ok(auto.res.ok, auto.data?.error);
    assert.equal("w" in auto.data.groups[0], false);
    assert.equal("h" in auto.data.groups[0], false);

    // The resize lock is a stored property, not just a client-side class.
    const locked = await act("updateGroup", { id, resizable: false }, solo);
    assert.ok(locked.res.ok, locked.data?.error);
    assert.equal(locked.data.groups[0].resizable, false);
    assert.equal((await snapshot(solo)).groups[0].resizable, false, "the lock survives a re-read");
    const unlocked = await act("updateGroup", { id, resizable: true }, solo);
    assert.ok(unlocked.res.ok, unlocked.data?.error);
    assert.equal(unlocked.data.groups[0].resizable, true);
  });

  test("a group's master switch skips its members in a run and survives a re-read", async () => {
    const solo = path.join(tmpDir, "ws-group-toggle");
    fs.mkdirSync(solo, { recursive: true });
    const seeded = await snapshot(solo);
    const agent = seeded.nodes.find((n) => n.type === "agent");
    const end = seeded.nodes.find((n) => n.type === "end");
    assert.ok((await act("updateNode", { id: agent.id, name: "step", config: {
      harness: "custom", command: echoQuery("ran"), prompt: "{task}",
    } }, solo)).res.ok);

    const made = await act("addGroup", { name: "Delivery", nodeIds: [agent.id] }, solo);
    assert.ok(made.res.ok, made.data?.error);
    assert.equal(made.data.groups[0].enabled, true, "a new group starts enabled");
    const id = made.data.groups[0].id;

    // Switched off: the run skips the member and passes its input along, exactly
    // like a node with `enabled: false` — without changing the node's setting.
    const off = await act("updateGroup", { id, enabled: false }, solo);
    assert.ok(off.res.ok, off.data?.error);
    assert.equal(off.data.groups[0].enabled, false);
    assert.equal((await snapshot(solo)).groups[0].enabled, false, "the master switch survives a re-read");
    assert.notEqual((await snapshot(solo)).nodes.find((n) => n.id === agent.id).config.enabled, false,
      "the node's own switch is untouched");

    assert.ok((await runApi("start", { task: "go" }, solo)).res.ok);
    const skipped = await waitRun(solo);
    assert.equal(skipped.status, "done");
    assert.equal(skipped.nodes[agent.id].status, "skipped", "the group's node did not run");
    assert.equal(skipped.nodes[end.id].outputTail, "go", "the skipped node forwarded its input");

    // Switched back on, the same node runs again.
    const on = await act("updateGroup", { id, enabled: true }, solo);
    assert.ok(on.res.ok, on.data?.error);
    assert.equal(on.data.groups[0].enabled, true);
    assert.ok((await runApi("start", { task: "go" }, solo)).res.ok);
    const ran = await waitRun(solo);
    assert.equal(ran.nodes[agent.id].status, "done");
    assert.equal(ran.nodes[end.id].outputTail, "ran[go]");
  });

  test("normalises groups on import, trimming unknown and doubly-claimed nodes", async () => {
    const solo = path.join(tmpDir, "ws-groups-import");
    fs.mkdirSync(solo, { recursive: true });
    await snapshot(solo);
    const r = await act("importWorkflow", { data: {
      name: "Grouped import",
      nodes: [
        { id: "g1", type: "start", name: "Start", x: 20, y: 20 },
        { id: "g2", type: "agent", name: "a", x: 240, y: 20, config: {
          harness: "custom", command: "printf hi", prompt: "{task}",
        } },
        { id: "g3", type: "end", name: "End", x: 460, y: 20 },
      ],
      edges: [{ id: "e1", from: "g1", to: "g2" }, { id: "e2", from: "g2", to: "g3" }],
      groups: [
        { id: "grp_a", name: "A", x: 10, y: 10, w: 640, h: 420, collapsed: true, resizable: false, nodeIds: ["g1", "ghost", "g2"] },
        // The second claim on g2 and g1 is dropped; unknown ids never survive.
        { id: "grp_b", name: "B", x: 10, y: 10, nodeIds: ["g2", "g1", "g3"] },
      ],
    } }, solo);
    assert.ok(r.res.ok, r.data?.error);
    assert.equal(r.data.groups.length, 2);
    assert.deepEqual(r.data.groups[0].nodeIds, ["g1", "g2"]);
    assert.equal(r.data.groups[0].collapsed, true);
    assert.equal(r.data.groups[0].w, 640, "an imported manual frame keeps its size");
    assert.equal(r.data.groups[0].h, 420);
    assert.equal(r.data.groups[0].resizable, false, "an imported lock is kept");
    assert.equal(r.data.groups[0].enabled, true, "a frame without the flag stays enabled");
    assert.deepEqual(r.data.groups[1].nodeIds, ["g3"], "only unclaimed nodes join the second frame");
    assert.equal(r.data.groups[1].resizable, true, "a frame without the flag stays resizable");

    // The exported shape carries groups, so sharing a canvas keeps its frames.
    const now = await snapshot(solo);
    assert.deepEqual(now.groups.map((g) => g.id), ["grp_a", "grp_b"]);
  });

  // ── Duplicate + portability ─────────────────────────────────────────────

  test("duplicates an agent node with its settings, and refuses start/end", async () => {
    const solo = path.join(tmpDir, "ws-dupe");
    fs.mkdirSync(solo, { recursive: true });
    const s = await snapshot(solo);
    const agent = s.nodes.find((n) => n.type === "agent");
    assert.ok((await act("updateNode", { id: agent.id, name: "origin", config: {
      harness: "codex", model: "gpt-5", prompt: "P {input}",
    } }, solo)).res.ok);

    const dup = await act("duplicateNode", { id: agent.id }, solo);
    assert.ok(dup.res.ok, dup.data?.error);
    const copies = dup.data.nodes.filter((n) => n.id !== agent.id && n.name === "origin copy");
    assert.equal(copies.length, 1);
    const copy = copies[0];
    assert.equal(copy.type, "agent");
    assert.equal(copy.config.harness, "codex");
    assert.equal(copy.config.model, "gpt-5");
    assert.equal(copy.config.prompt, "P {input}");
    assert.ok(copy.x > agent.x && copy.y > agent.y, "the clone is offset from its source");

    // The clone is its own node: editing it leaves the original untouched.
    assert.ok((await act("updateNode", { id: copy.id, name: "changed" }, solo)).res.ok);
    assert.equal((await snapshot(solo)).nodes.find((n) => n.id === agent.id).name, "origin");

    const start = s.nodes.find((n) => n.type === "start");
    assert.equal((await act("duplicateNode", { id: start.id }, solo)).res.status, 409);
    assert.equal((await act("duplicateNode", { id: "nope" }, solo)).res.status, 404);
  });

  test("imports a workflow file, re-validating every node and edge", async () => {
    const solo = path.join(tmpDir, "ws-import");
    fs.mkdirSync(solo, { recursive: true });
    await snapshot(solo); // seed, so the import genuinely replaces something

    const file = {
      name: "Imported flow",
      nodes: [
        { id: "n1", type: "start", name: "Start", x: 20, y: 20 },
        { id: "n2", type: "agent", name: "solo", x: 240, y: 20, config: { harness: "custom", command: "printf hi", prompt: "{task}" } },
        { id: "n3", type: "end", name: "End", x: 460, y: 20 },
      ],
      edges: [
        { id: "e1", from: "n1", to: "n2" },
        { id: "e2", from: "n2", to: "n3" },
        { id: "e3", from: "n2", to: "ghost" },   // dangling → dropped
        { id: "e4", from: "n3", to: "n1" },      // out of the end → dropped
      ],
    };
    const r = await act("importWorkflow", { data: file }, solo);
    assert.ok(r.res.ok, r.data?.error);
    assert.equal(r.data.name, "Imported flow");
    assert.deepEqual(r.data.nodes.map((n) => n.id).sort(), ["n1", "n2", "n3"]);
    assert.deepEqual(r.data.edges.map((e) => e.id).sort(), ["e1", "e2"]);
    assert.equal((await snapshot(solo)).name, "Imported flow");

    // Rubbish and unusable graphs are refused rather than stored.
    assert.equal((await act("importWorkflow", { data: { nodes: "no" } }, solo)).res.status, 400);
    assert.equal((await act("importWorkflow", { data: { nodes: [{ id: "s", type: "start" }] } }, solo)).res.status, 400);
    assert.equal((await act("importWorkflow", { data: {
      nodes: [
        { id: "a", type: "agent", name: "a" },
        { id: "b", type: "agent", name: "b" },
      ],
      edges: [{ id: "x", from: "a", to: "b" }, { id: "y", from: "b", to: "a" }],
    } }, solo)).res.status, 400, "a cycle is refused");

    // The imported graph is a real, runnable workflow.
    assert.ok((await runApi("start", { task: "x" }, solo)).res.ok);
    const run = await waitRun(solo);
    assert.equal(run.status, "done");
    assert.equal(run.nodes.n2.outputTail, "hi");
  });
});

describe("subagent workflow plugin (client)", () => {
  test("renders the canvas with start, agent and end nodes and their connections", async () => {
    const { page, context, errors } = await openWorkflow(ws);
    assert.equal(await page.locator("#btn-subagent-workflow").count(), 1);
    const s = await snapshot(ws);
    assert.equal(await page.locator("#subagent-workflow-pane .sw-node").count(), s.nodes.length);
    assert.equal(await page.locator("#subagent-workflow-pane path.sw-edge").count(), s.edges.length);
    assert.equal(await page.locator(".sw-node.sw-t-start .sw-port-out").count(), 1);
    assert.equal(await page.locator(".sw-node.sw-t-end .sw-port-in").count(), 1);
    assert.equal(await page.locator(".sw-node.sw-t-end .sw-node-final.has-output").count(), 0,
      "the end node shows no workflow output until a run has reached it");
    const radius = await page.locator(".sw-node").first().evaluate((el) => getComputedStyle(el).borderRadius);
    assert.notEqual(radius, "0px");
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("a node's gear opens its settings popup over the canvas — and Escape closes it", async () => {
    const solo = path.join(tmpDir, "ws-gear");
    fs.mkdirSync(solo, { recursive: true });
    const s = await snapshot(solo);
    const agent = s.nodes.find((n) => n.type === "agent");
    const configOf = async () => (await snapshot(solo)).nodes.find((n) => n.id === agent.id).config;

    const { page, context, errors } = await openWorkflow(solo);
    // No settings sidebar any more: every node carries a gear instead, and the
    // diagram keeps the whole width it used to share.
    assert.equal(await page.locator("#subagent-workflow-pane .sw-inspector").count(), 0);
    assert.equal(await page.locator(".sw-node .sw-node-config").count(), s.nodes.length, "one gear per node");
    assert.equal(await page.locator(`.sw-node[data-id="${agent.id}"] .sw-node-config`).count(), 1);
    // Closed means nothing rendered, and nothing clickable through it.
    assert.equal(await page.locator("#sw-modal .sw-dlg-body").count(), 0);
    assert.equal(await page.locator("#sw-modal-backdrop:visible").count(), 0);

    // Selecting a node is a drag, not an edit: a plain click on the card must
    // not throw a form over it.
    await page.click(`.sw-node[data-id="${agent.id}"] .sw-node-name`);
    await page.waitForTimeout(250);
    assert.equal(await page.locator("#sw-modal .sw-dlg-body").count(), 0, "selecting is not configuring");
    assert.equal(await page.locator(`.sw-node[data-id="${agent.id}"].sel`).count(), 1, "the node reads as selected");

    // The gear is.
    await page.click(`.sw-node[data-id="${agent.id}"] .sw-node-config`);
    await page.waitForSelector("#sw-f-harness");
    const geom = await page.evaluate(() => {
      const back = document.getElementById("sw-modal-backdrop");
      const dlg = document.getElementById("sw-modal");
      const cs = getComputedStyle(back);
      const r = dlg.getBoundingClientRect();
      return {
        position: cs.position, z: Number(cs.zIndex), scrim: cs.backgroundColor,
        w: Math.round(r.width), h: Math.round(r.height),
        // The surface the popup covers: the pane it floats over, and the
        // viewport the pane sits in (a scrollbar is all it may leave over).
        vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight,
        // What the panel may be 80% *of*: the scrim's own width, less the
        // padding that is the gap around the panel.
        avail: Math.round(back.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)),
        availH: Math.round(back.getBoundingClientRect().height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)),
        canvas: Math.round(document.querySelector(".sw-canvas-scroll").getBoundingClientRect().width),
      };
    });
    assert.equal(geom.position, "fixed", "the popup floats over the pane, it is not a column in it");
    assert.ok(geom.z >= 1000, `it sits above the canvas (z=${geom.z})`);
    assert.notEqual(geom.scrim, "rgba(0, 0, 0, 0)", "with a scrim over the canvas");
    // A wide panel, not the whole screen: a node's references, the whole model
    // catalogue and the end node's final output all need the room, and 80% of
    // the window is what gives it to them while leaving the canvas it belongs to
    // visible down either side of the scrim. (A hair under 80% if the entry
    // animation is still running: `rect` reflects a live transform.)
    assert.ok(Math.abs(geom.w / geom.avail - 0.8) < 0.02, `80% of the window wide (${geom.w} of ${geom.avail})`);
    assert.ok(geom.h / geom.availH > 0.98, `full height, inset by the scrim's padding (${geom.h} of ${geom.availH})`);
    assert.ok(geom.canvas > 0, `the canvas stays behind it (${geom.canvas}px)`);

    // Escape closes it, leaving the node's settings exactly as they were.
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("#sw-modal .sw-dlg-body"));
    assert.equal(await page.locator("#sw-modal-backdrop:visible").count(), 0);
    assert.deepEqual(await configOf(), agent.config, "closing is not saving");

    // The ✕ in the head closes it too — it is the popup's only close control,
    // sitting outside the name field at the panel's top-right corner.
    await page.click(`.sw-node[data-id="${agent.id}"] .sw-node-config`);
    await page.waitForSelector("#sw-f-harness");
    assert.equal(await page.locator(".sw-dlg-actions #sw-close").count(), 0,
      "no Close button in the actions row");
    const headClose = await page.evaluate(() => {
      const head = document.querySelector(".sw-dlg-head").getBoundingClientRect();
      const name = document.querySelector(".sw-dlg-name-wrap").getBoundingClientRect();
      const x = document.querySelector("#sw-close-x").getBoundingClientRect();
      const hcs = getComputedStyle(document.querySelector(".sw-dlg-head"));
      return {
        outside: x.left >= name.right - 1,
        atRightEdge: Math.round(x.right) === Math.round(head.right - parseFloat(hcs.paddingRight)),
      };
    });
    assert.ok(headClose.outside, "the close ✕ sits outside the name field");
    assert.ok(headClose.atRightEdge, "at the head's right edge");
    await page.click("#sw-close-x");
    await page.waitForFunction(() => !document.querySelector("#sw-modal .sw-dlg-body"));

    // Double-clicking the card is the same as pressing its gear — and an edit
    // made in the popup is saved like any other.
    await page.dblclick(`.sw-node[data-id="${agent.id}"] .sw-node-body`);
    await page.waitForSelector("#sw-f-prompt");
    await page.fill("#sw-f-prompt", "check {input}");
    await page.click("#sw-save");
    await page.waitForTimeout(400);
    assert.equal((await configOf()).prompt, "check {input}");
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("configures a node's harness in its settings popup and saves it", async () => {
    const { page, context, errors } = await openWorkflow(ws);
    const s = await snapshot(ws);
    const agent = s.nodes.find((n) => n.type === "agent");
    await page.click(`.sw-node[data-id="${agent.id}"] .sw-node-config`);
    await page.waitForSelector("#sw-f-harness");
    assert.ok((await page.$$eval("#sw-f-harness option", (o) => o.map((e) => e.value))).includes("gemini"));
    await page.fill("#sw-f-name", "planner");
    await page.selectOption("#sw-f-harness", "gemini");
    // The model field is a dropdown of what the harness documents…
    await page.selectOption("#sw-f-model", "gemini-2.5-flash");
    await page.fill("#sw-f-prompt", "Plan: {task}");
    await page.click("#sw-save");
    await page.waitForFunction((id) =>
      document.querySelector(`.sw-node[data-id="${id}"] .sw-node-name`)?.textContent === "planner", agent.id);
    const saved = (await snapshot(ws)).nodes.find((n) => n.id === agent.id);
    assert.equal(saved.name, "planner");
    assert.equal(saved.config.harness, "gemini");
    assert.equal(saved.config.model, "gemini-2.5-flash");
    assert.equal(saved.config.prompt, "Plan: {task}");

    // …with "Custom…" for an id the list does not know, which still round-trips.
    await page.selectOption("#sw-f-model", "__custom__");
    await page.fill("#sw-f-model-custom", "google/gemini-2.5-pro-preview");
    await page.click("#sw-save");
    await page.waitForFunction((id) =>
      document.querySelector(`.sw-node[data-id="${id}"] .sw-node-name`)?.textContent === "planner", agent.id);
    assert.equal((await snapshot(ws)).nodes.find((n) => n.id === agent.id).config.model, "google/gemini-2.5-pro-preview");
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("+ Loop adds a loop node, and its settings edit the pass count", async () => {
    const solo = path.join(tmpDir, "ws-loop-ui");
    fs.mkdirSync(solo, { recursive: true });
    const { page, context, errors } = await openWorkflow(solo);

    await page.click("#sw-add-loop");
    await page.waitForSelector(".sw-node.sw-t-loop");
    const node = page.locator(".sw-node.sw-t-loop");
    assert.match(await node.textContent(), /Repeat ×2/, "a fresh loop shows its default count");

    await node.locator(".sw-node-config").click();
    await page.waitForSelector("#sw-f-count");
    assert.equal(await page.inputValue("#sw-f-count"), "2");
    // The section's nodes can read the pass they are on.
    assert.match(await page.textContent("#sw-modal .sw-dlg-body"), /\{iteration\}/);
    await page.fill("#sw-f-count", "4");
    await page.fill("#sw-f-desc", "review rounds");
    await page.click("#sw-save");

    await page.waitForFunction(() =>
      /Repeat ×4/.test(document.querySelector(".sw-node.sw-t-loop")?.textContent || ""));
    assert.match(await page.textContent(".sw-node.sw-t-loop"), /review rounds/);
    const loop = (await snapshot(solo)).nodes.find((n) => n.type === "loop");
    assert.equal(loop.config.count, 4);
    assert.equal(loop.config.description, "review rounds");
    // A count outside the range is clamped by the server, and the panel shows it.
    assert.ok((await act("updateNode", { id: loop.id, config: { count: 500 } }, solo)).res.ok);
    assert.equal((await snapshot(solo)).nodes.find((n) => n.id === loop.id).config.count, 100);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("a Pi node's model names its provider, and an ambiguous one is not guessed", async () => {
    const solo = path.join(tmpDir, "ws-model");
    fs.mkdirSync(solo, { recursive: true });
    const s = await snapshot(solo);
    const agent = s.nodes.find((n) => n.type === "agent");
    const stored = async () => (await snapshot(solo)).nodes.find((n) => n.id === agent.id).config.model;
    // A graph saved before the picker carried providers holds a bare id.
    assert.ok((await act("updateNode", { id: agent.id, name: "pi-node", config: {
      harness: "pi", model: "grok-4", prompt: "{input}",
    } }, solo)).res.ok);

    const { page, context, errors } = await openWorkflow(solo);
    await page.click(`.sw-node[data-id="${agent.id}"] .sw-node-config`);
    await page.waitForSelector("#sw-f-model");
    // The catalogue rides along with the harness list.
    await page.waitForFunction((n) => document.querySelectorAll("#sw-f-model option").length >= n, PI_MODELS.length + 2);
    assert.equal(await page.$eval("#sw-f-model", (el) => el.value), "tokenharbor/grok-4",
      "a bare id with one provider resolves to that provider's key");
    await page.click("#sw-save");
    await page.waitForTimeout(400);
    assert.equal(await stored(), "tokenharbor/grok-4", "saving writes the qualified id");

    // Two providers ship this one: it is kept as typed and says why. The
    // settings popup covers the toolbar, so close it to reach ↻ and open the
    // node again — a reload inside the popup would be a different test.
    assert.ok((await act("updateNode", { id: agent.id, config: { harness: "pi", model: "mimo-v2.6-flash" } }, solo)).res.ok);
    await page.click("#sw-close-x");
    await page.click("#sw-refresh");
    await page.click(`.sw-node[data-id="${agent.id}"] .sw-node-config`);
    await page.waitForFunction(() => document.querySelector("#sw-f-model")?.value === "__custom__");
    assert.equal(await page.$eval("#sw-f-model-custom", (el) => el.value), "mimo-v2.6-flash",
      "the ambiguous value stays in the free-text box");
    const warn = await page.textContent(".sw-dlg-body .sw-hint.sw-warn");
    assert.match(warn, /offered by 2 providers/);
    assert.match(warn, /tokenharbor\/mimo-v2\.6-flash/);
    assert.match(warn, /xiaomi\/mimo-v2\.6-flash/);
    await page.click("#sw-save");
    await page.waitForTimeout(400);
    assert.equal(await stored(), "mimo-v2.6-flash", "an ambiguous id is preserved, never silently picked");

    // Choosing one of the two providers is what disambiguates it.
    await page.selectOption("#sw-f-model", "xiaomi/mimo-v2.6-flash");
    await page.click("#sw-save");
    await page.waitForTimeout(400);
    assert.equal(await stored(), "xiaomi/mimo-v2.6-flash");
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("adds, describes and removes a node's reference files from the panel", async () => {
    const s = await snapshot(ws7);
    const agent = s.nodes.find((n) => n.type === "agent");
    const refsOf = async () => (await snapshot(ws7)).nodes.find((n) => n.id === agent.id).config.refs;
    const design = fs.realpathSync(path.join(ws7, "docs", "design.md"));

    const { page, context, errors } = await openWorkflow(ws7);
    await page.click(`.sw-node[data-id="${agent.id}"] .sw-node-config`);
    await page.waitForSelector("#sw-refs");
    // A reference may be a file or a whole folder, so the empty state says
    // “references” rather than promising only files.
    assert.match(await page.textContent("#sw-refs-empty"), /No references yet/);

    // The user types a workspace-relative path and what the file is for.
    await page.fill("#sw-ref-path", "docs/design.md");
    await page.fill("#sw-ref-note", "the API contract");
    await page.click("#sw-ref-add-btn");
    await page.waitForFunction(() => document.querySelectorAll(".sw-ref-row").length === 1);
    assert.equal(await page.textContent(".sw-ref-row .sw-ref-path"), "docs/design.md", "listed relative to the workspace");
    assert.equal(await page.$eval(".sw-ref-row .sw-ref-path", (el) => el.title), design, "the tooltip is the stored path");
    assert.equal(await page.$eval(".sw-ref-row .sw-ref-note", (el) => el.value), "the API contract");
    assert.deepEqual((await refsOf()).map((r) => r.path), [design]);
    // The node card says the message carries more than the panel's message box,
    // and the panel says what happens to the paths.
    assert.equal(await page.textContent(".sw-node.sw-t-agent .sw-ref-tag"), "📎 1");
    assert.match(await page.textContent("#sw-refs .sw-hint:last-child"), /injected into this node's message/);

    // The description saves on its own (blur writes it through).
    await page.fill(".sw-ref-row .sw-ref-note", "the contract to follow");
    await page.locator(".sw-ref-row .sw-ref-note").blur();
    for (let i = 0; i < 40 && (await refsOf())[0].note !== "the contract to follow"; i++) await sleep(50);
    assert.equal((await refsOf())[0].note, "the contract to follow");

    // A path that is not there is refused, and nothing is added.
    await page.fill("#sw-ref-path", "docs/ghost.md");
    await page.fill("#sw-ref-note", "");
    await page.click("#sw-ref-add-btn");
    await page.waitForFunction(() => /no such file or folder/.test(document.querySelector("#scope-toast")?.textContent || ""));
    assert.equal(await page.locator(".sw-ref-row").count(), 1, "the bad path was not stored");

    // Removing takes it off the node — in the panel and in the stored config.
    await page.click(".sw-ref-del");
    await page.waitForFunction(() => document.querySelectorAll(".sw-ref-row").length === 0);
    assert.deepEqual(await refsOf(), []);
    assert.equal(await page.locator(".sw-node.sw-t-agent .sw-ref-tag").count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("the run button toggles between Run and Stop", async () => {
    const solo = path.join(tmpDir, "ws-run-toggle");
    fs.mkdirSync(solo, { recursive: true });
    const s = await snapshot(solo);
    const agent = s.nodes.find((n) => n.type === "agent");
    // A long node keeps the run live long enough to see and press Stop.
    assert.ok((await act("updateNode", { id: agent.id, config: {
      harness: "custom", command: "sleep 30", prompt: "{task}",
    } }, solo)).res.ok);

    const { page, context, errors } = await openWorkflow(solo);
    const runBtn = page.locator("#sw-run");
    assert.equal(await page.locator("#sw-stop").count(), 0, "there is one run control, not two");
    assert.match((await runBtn.textContent()).trim(), /Run/);
    assert.equal(await runBtn.getAttribute("aria-label"), "Run workflow");

    await runBtn.click();
    await page.waitForFunction(() => /Stop/.test(document.querySelector("#sw-run")?.textContent || ""));
    assert.equal(await runBtn.getAttribute("aria-label"), "Stop workflow");
    assert.match(await runBtn.getAttribute("class"), /sw-danger/);

    await runBtn.click();
    await page.waitForFunction(() => /stopped/.test(document.querySelector("#sw-run-status")?.textContent || ""));
    await page.waitForFunction(() => /Run/.test(document.querySelector("#sw-run")?.textContent || ""));
    assert.equal(await runBtn.getAttribute("aria-label"), "Run workflow");
    assert.equal((await liveRun(solo)).status, "stopped");
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("runs the workflow from the UI and shows live node status and log", async () => {
    const g = await buildCustomGraph(ws3);
    // There is no run-level task box: the start node's own message is the run's
    // task, read by every node as `{task}`.
    assert.ok((await act("updateNode", { id: g.start.id, config: { defaultTask: "world" } }, ws3)).res.ok);
    const { page, context, errors } = await openWorkflow(ws3);
    assert.equal(await page.locator("#sw-task").count(), 0, "the run bar has no task box");
    await page.click("#sw-run");
    // Every node settles and its badge is drawn on the canvas.
    await page.waitForFunction(() =>
      document.querySelectorAll(".sw-node.sw-run-done").length >= 4, null, { timeout: 25_000 });
    assert.match(await page.textContent("#sw-run-status"), /done/);
    const log = await page.textContent("#sw-run-log");
    assert.match(log, /A1\[world\]/);
    assert.match(log, /A2\[A1\[world\]\]/);

    // The end node carries the workflow's final output: what the branches wired
    // into it produced (here A2 and A3 both ran).
    const endCard = await page.textContent(".sw-node.sw-t-end .sw-node-final");
    assert.match(endCard, /A2\[A1\[world\]\]/);
    assert.match(endCard, /A3\[A1\[world\]\]/);
    await page.click(".sw-node.sw-t-end .sw-node-config");
    // The output renders as markdown by default, and the Markdown / Raw switch
    // flips it to the exact bytes the run produced.
    await page.waitForSelector("#sw-final-body .sw-final-md");
    const final = await page.textContent("#sw-final-body .sw-final-md");
    assert.match(final, /A2\[A1\[world\]\]/);
    assert.match(final, /A3\[A1\[world\]\]/);
    await page.click('#sw-final-body [data-out-view="raw"]');
    await page.waitForSelector("#sw-final-body .sw-final-pre");
    assert.match(await page.textContent("#sw-final-body .sw-final-pre"), /A2\[A1\[world\]\]/);
    assert.match(await page.textContent("#sw-final-body .sw-final-pre"), /A3\[A1\[world\]\]/);
    await page.click('#sw-final-body [data-out-view="markdown"]');
    await page.waitForSelector("#sw-final-body .sw-final-md");
    assert.match(await page.textContent(".sw-final-meta"), /\d+ lines? · \d+ chars/);
    assert.equal(await page.locator("#sw-final-copy").count(), 1, "the output can be copied");
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("a node's settings are provider, model and user message — plus its references", async () => {
    const s = await snapshot(ws5);
    const agent = s.nodes.find((n) => n.type === "agent");
    // A seeded reference: the panel lists it, and must leave it alone when the
    // message is edited.
    const seededFile = path.join(ws5, "seeded.md");
    fs.writeFileSync(seededFile, "# Seeded\n");
    // Seed settings the panel does NOT edit, to prove they survive an edit made
    // from the panel (the config is merged, not rebuilt from the form).
    assert.ok((await act("updateNode", { id: agent.id, config: {
      harness: "claude", retries: 3, retryDelaySec: 5, timeoutSec: 90, continueOnError: true,
      extraArgs: "--yolo", cwd: "/tmp", fanout: "serial", join: "first",
      when: { mode: "contains", value: "PASS" }, skills: [], tools: [], extensions: [],
      refs: [{ id: "ref_seeded", path: seededFile, note: "seeded reference" }],
    } }, ws5)).res.ok);

    const { page, context, errors } = await openWorkflow(ws5);
    await page.click(`.sw-node[data-id="${agent.id}"] .sw-node-config`);
    await page.waitForSelector("#sw-f-harness");

    // Pi's dropdown is the app's whole model catalogue, every value carrying its
    // provider and grouped so the provider is visible in the choice.
    await page.selectOption("#sw-f-harness", "pi");
    assert.deepEqual(
      await page.$$eval("#sw-f-model option", (o) => o.map((x) => x.value)),
      ["", ...PI_MODELS, "__custom__"],
      "Pi's models come from the catalogue, plus a Custom… entry",
    );
    assert.deepEqual(
      await page.$$eval("#sw-f-model optgroup", (o) => o.map((x) => x.label)),
      ["solo", "tokenharbor", "xiaomi"],
      "grouped one group per provider",
    );

    // Switching harness swaps in that harness's list without touching the rest
    // of the form.
    await page.selectOption("#sw-f-harness", "claude");
    assert.deepEqual(
      await page.$$eval("#sw-f-model option", (o) => o.map((x) => x.value)),
      ["", "sonnet", "opus", "haiku", "claude-sonnet-4-5", "claude-opus-4-1", "__custom__"],
    );

    // The panel is three settings (plus the node's name) and the reference list.
    // Every control the inspector used to carry is gone, so nothing hidden can
    // be edited — and the seeded reference is listed without being re-resolved.
    const visibleFields = () => page.$$eval(".sw-dlg-body .sw-field > span", (els) =>
      els.filter((e) => e.offsetParent !== null)
        .map((e) => (e.textContent || "").trim().toLowerCase().split(" ")[0]));
    const labels = await visibleFields();
    assert.deepEqual(labels, ["provider", "model", "user", "reference"],
      `the panel shows its three settings and the reference list (${labels})`);
    assert.equal(await page.locator(".sw-ref-row").count(), 1, "the stored reference is listed");
    assert.equal(await page.$eval(".sw-ref-row .sw-ref-note", (el) => el.value), "seeded reference");

    // The one exception is a custom command: there the provider *is* the shell
    // command, so choosing it adds the field that says what to run.
    await page.selectOption("#sw-f-harness", "custom");
    assert.deepEqual(await visibleFields(), ["provider", "model", "user", "command", "reference"],
      "a custom provider also shows the command it runs");
    await page.selectOption("#sw-f-harness", "claude");
    assert.deepEqual(await visibleFields(), ["provider", "model", "user", "reference"], "and hides it again");
    for (const gone of [
      "#sw-f-enabled", "#sw-f-when-mode", "#sw-f-when-value", "#sw-f-caps-wrap",
      "#sw-f-extra", "#sw-f-cwd", "#sw-f-fanout", "#sw-f-join", "#sw-f-timeout",
      "#sw-f-continue", "#sw-f-retries", "#sw-f-retry-delay", "[data-cap]", ".sw-caps",
    ]) {
      assert.equal(await page.locator(gone).count(), 0, `${gone} is no longer in the panel`);
    }
    assert.equal(await page.locator(".sw-dlg-body .sw-check").count(), 0, "and no bypass checkbox");

    // Editing the message keeps every stored setting the panel does not show.
    await page.fill("#sw-f-prompt", "Review {input}");
    await page.click("#sw-save");
    await page.waitForTimeout(400);
    const saved = (await snapshot(ws5)).nodes.find((n) => n.id === agent.id).config;
    assert.equal(saved.prompt, "Review {input}", "the edit landed");
    assert.equal(saved.retries, 3, "the retry count was preserved");
    assert.equal(saved.retryDelaySec, 5);
    assert.equal(saved.timeoutSec, 90);
    assert.equal(saved.continueOnError, true);
    assert.equal(saved.extraArgs, "--yolo");
    assert.equal(saved.cwd, "/tmp");
    assert.equal(saved.fanout, "serial");
    assert.equal(saved.join, "first");
    assert.deepEqual(saved.when, { mode: "contains", value: "PASS" });
    assert.deepEqual(saved.refs, [{ id: "ref_seeded", path: seededFile, note: "seeded reference" }],
      "and the reference list, which the panel does not edit itself");
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("deleting a connection removes its path and delete button from the canvas", async () => {
    // A workspace of its own, so the rest of the suite sees a stable graph.
    const solo = path.join(tmpDir, "ws-delete");
    fs.mkdirSync(solo, { recursive: true });
    const seeded = await snapshot(solo);
    const agent = seeded.nodes.find((n) => n.type === "agent");
    const added = await act("addNode", { type: "agent", x: 420, y: 480 }, solo);
    const second = added.data.nodes.at(-1);
    assert.ok((await act("addEdge", { from: agent.id, to: second.id }, solo)).res.ok);

    const { page, context, errors } = await openWorkflow(solo);
    const edge = (await snapshot(solo)).edges.find((e) => e.from === agent.id && e.to === second.id);
    const before = await page.locator("#subagent-workflow-pane path.sw-edge").count();
    await page.click(`#subagent-workflow-pane .sw-edge-del[data-edge="${edge.id}"]`);
    await page.waitForFunction((n) => document.querySelectorAll("#subagent-workflow-pane path.sw-edge").length === n - 1, before);
    assert.equal(await page.locator(`#subagent-workflow-pane path.sw-edge[data-edge="${edge.id}"]`).count(), 0);
    assert.equal(await page.locator(`#subagent-workflow-pane .sw-edge-del[data-edge="${edge.id}"]`).count(), 0);
    assert.ok(!(await snapshot(solo)).edges.some((e) => e.id === edge.id));
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("connects two nodes by dragging from the output port to an input port", async () => {
    const pre = (await snapshot(ws)).nodes.map((n) => n.id);
    // A clear row near the top: the run panel leaves ~600px of visible canvas.
    const added = await act("addNode", { type: "agent", x: 340, y: 400 });
    assert.ok(added.res.ok);
    const freshId = added.data.nodes.find((n) => !pre.includes(n.id)).id;
    const from = added.data.nodes.find((n) => n.type === "agent" && n.id !== freshId);
    await act("moveNode", { id: from.id, x: 60, y: 400 });

    const { page, context, errors } = await openWorkflow(ws);
    await page.click("#sw-refresh");
    await page.waitForSelector(`.sw-node[data-id="${freshId}"]`);

    const source = await page.locator(`.sw-node[data-id="${from.id}"] .sw-port-out`).boundingBox();
    const target = await page.locator(`.sw-node[data-id="${freshId}"] .sw-port-in`).boundingBox();
    assert.ok(source && target);
    const edgesBefore = (await snapshot(ws)).edges.length;

    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
    await page.mouse.up();

    await page.waitForFunction((n) => document.querySelectorAll("path.sw-edge").length === n + 1, edgesBefore);
    const after = await snapshot(ws);
    assert.ok(after.edges.some((e) => e.from === from.id && e.to === freshId));
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("dragging a node moves the node itself and takes its connections with it", async () => {
    // The canvas rebuilt its node DOM on mousedown, so the element the drag was
    // handed had already been replaced: the model (and therefore the edge
    // routing) moved while the card on screen stood still. This walks the drag
    // one step at a time and checks the card, the edge and the saved position.
    const solo = path.join(tmpDir, "ws-drag");
    fs.mkdirSync(solo, { recursive: true });
    const seeded = await snapshot(solo);
    const agent = seeded.nodes.find((n) => n.type === "agent");
    assert.equal(seeded.edges.length, 2, "the seed wires start → agent → end");
    const edge = seeded.edges.find((e) => e.from === agent.id);

    const { page, context, errors } = await openWorkflow(solo);
    await page.click("#sw-refresh");
    await page.waitForSelector(`.sw-node[data-id="${agent.id}"]`);
    const pathOf = (id) => `.sw-node[data-id="${id}"] path.sw-edge`;
    const read = () => page.evaluate(([nodeId, edgeId]) => {
      const el = document.querySelector(`.sw-node[data-id="${nodeId}"]`);
      const path = document.querySelector(`path.sw-edge[data-edge="${edgeId}"]`);
      const d = path?.getAttribute("d") || "";
      return {
        left: Math.round(el.getBoundingClientRect().left),
        top: Math.round(el.getBoundingClientRect().top),
        to: (d.match(/M ([\d.-]+) ([\d.-]+)/) || []).slice(1, 3).map(Number),
      };
    }, [agent.id, edge.id]);

    const before = await read();
    const box = await page.locator(`.sw-node[data-id="${agent.id}"] .sw-node-head`).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 140, box.y + box.height / 2 + 60, { steps: 10 });
    await page.waitForTimeout(150);

    // Mid-drag, before any drop: the card follows the pointer…
    const during = await read();
    assert.ok(
      Math.abs(during.left - (before.left + 140)) <= 6,
      `the dragged card follows the pointer (left ${before.left} → ${during.left}, wanted ~${before.left + 140})`
    );
    assert.ok(Math.abs(during.top - (before.top + 60)) <= 6, `and so does its top (${before.top} → ${during.top})`);
    // …and the connection has been re-routed with it, in the same drag.
    assert.ok(
      Math.abs(during.to[0] - (before.to[0] + 140)) <= 6,
      `the edge follows the card (${before.to[0]} → ${during.to[0]})`
    );

    await page.mouse.up();
    await page.waitForTimeout(250);
    // The drop is persisted against the node's canvas coordinates, which move by
    // the same delta the pointer did (no zoom on the canvas).
    const saved = (await snapshot(solo)).nodes.find((n) => n.id === agent.id);
    assert.ok(Math.abs(saved.x - (agent.x + 140)) <= 8, `the drop position is saved (x ${agent.x} → ${saved.x})`);
    assert.ok(Math.abs(saved.y - (agent.y + 60)) <= 8, `and its vertical position too (y ${agent.y} → ${saved.y})`);
    assert.deepEqual(errors, []);
    await context.close();
  });

  // ── Provider marks, run guards, portability ────────────────────────────

  test("wears the selected provider's mark on the node and in its settings popup", async () => {
    const solo = path.join(tmpDir, "ws-mark");
    fs.mkdirSync(solo, { recursive: true });
    const seeded = await snapshot(solo);
    const agent = seeded.nodes.find((n) => n.type === "agent");
    assert.equal(agent.config.harness, "claude", "a seeded node runs Claude Code");

    const { page, context, errors } = await openWorkflow(solo);
    // One mark per agent node, tagged with the provider it stands for.
    const agents = seeded.nodes.filter((n) => n.type === "agent").length;
    assert.equal(await page.locator(".sw-node .sw-hicon").count(), agents);
    assert.equal(await page.locator('.sw-node .sw-hicon[data-harness="claude"] svg').count(), agents);

    // On the node it is a tinted chip that names its provider, so a canvas of
    // mixed harnesses reads without opening anything.
    const mark = await page.evaluate((id) => {
      const el = document.querySelector(`.sw-node[data-id="${id}"] .sw-hicon`);
      const cs = getComputedStyle(el);
      return {
        title: el.getAttribute("title"),
        size: Math.round(el.getBoundingClientRect().width),
        radius: cs.borderTopLeftRadius,
        bg: cs.backgroundColor,
        glyph: el.querySelectorAll("svg").length,
      };
    }, agent.id);
    assert.equal(mark.title, "Claude Code", "the mark names the provider it stands for");
    assert.equal(mark.glyph, 1, "and draws it");
    assert.ok(mark.size >= 18, `it is a chip on the node, not a bare glyph (${mark.size}px)`);
    assert.equal(mark.radius, "6px", "on the control radius");
    assert.notEqual(mark.bg, "rgba(0, 0, 0, 0)", "with a tinted background");

    await page.click(`.sw-node[data-id="${agent.id}"] .sw-node-config`);
    await page.waitForSelector("#sw-f-harness");
    assert.equal(await page.locator('#sw-harness-icon[data-harness="claude"]').count(), 1);

    // Switching harness repaints the field label, the popup head and — once
    // saved — the node itself.
    await page.selectOption("#sw-f-harness", "gemini");
    assert.equal(await page.locator('#sw-harness-icon[data-harness="gemini"]').count(), 1);
    assert.equal(await page.locator('.sw-dlg-head .sw-hicon[data-harness="gemini"]').count(), 1);
    await page.click("#sw-save");
    await page.waitForFunction((id) =>
      document.querySelector(`.sw-node[data-id="${id}"] .sw-hicon`)?.dataset.harness === "gemini", agent.id);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("a node switched off outside the panel stays bypassed, and stays off when saved", async () => {
    // The panel no longer offers the bypass switch, but the run engine still
    // honours `enabled: false` — so a node switched off through the API (or
    // arriving in an imported file) must still read as bypassed on the canvas,
    // and an edit from the panel must not silently re-enable it.
    const solo = path.join(tmpDir, "ws-off");
    fs.mkdirSync(solo, { recursive: true });
    const seeded = await snapshot(solo);
    const agent = seeded.nodes.find((n) => n.type === "agent");
    const off = await act("updateNode", { id: agent.id, config: { enabled: false, retries: 2 } }, solo);
    assert.ok(off.res.ok, off.data?.error);

    const { page, context, errors } = await openWorkflow(solo);
    await page.click(`.sw-node[data-id="${agent.id}"] .sw-node-config`);
    await page.waitForSelector("#sw-f-prompt");
    assert.equal(await page.locator("#sw-f-enabled").count(), 0, "the panel has no switch");
    assert.equal(await page.locator(`.sw-node[data-id="${agent.id}"].sw-off`).count(), 1, "the canvas marks it off");
    assert.equal(await page.locator(`.sw-node[data-id="${agent.id}"] .sw-off-tag`).count(), 1);

    await page.fill("#sw-f-prompt", "{input} and then some");
    await page.click("#sw-save");
    await page.waitForTimeout(400);
    const saved = (await snapshot(solo)).nodes.find((n) => n.id === agent.id).config;
    assert.equal(saved.enabled, false, "still switched off");
    assert.equal(saved.retries, 2, "with its retry count intact");
    assert.equal(saved.prompt, "{input} and then some");
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("exports the workflow as a JSON file", async () => {
    const solo = path.join(tmpDir, "ws-export");
    fs.mkdirSync(solo, { recursive: true });
    const seeded = await snapshot(solo);

    const { page, context, errors } = await openWorkflow(solo);
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#sw-export")]);
    assert.match(download.suggestedFilename(), /\.workflow\.json$/);
    let text = "";
    for await (const chunk of await download.createReadStream()) text += chunk;
    const parsed = JSON.parse(text);
    assert.deepEqual(parsed.nodes.map((n) => n.id).sort(), seeded.nodes.map((n) => n.id).sort());
    assert.equal(parsed.edges.length, seeded.edges.length);
    assert.equal(parsed.name, seeded.name);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("imports a workflow file from disk, replacing the graph", async () => {
    const solo = path.join(tmpDir, "ws-import-ui");
    fs.mkdirSync(solo, { recursive: true });
    await snapshot(solo);

    const { page, context, errors } = await openWorkflow(solo);
    page.on("dialog", (d) => d.accept());
    const file = JSON.stringify({
      name: "From a file",
      nodes: [
        { id: "s", type: "start", name: "Start", x: 20, y: 20 },
        { id: "a", type: "agent", name: "imported", x: 240, y: 20, config: { harness: "custom", command: "printf ok", prompt: "{task}" } },
        { id: "e", type: "end", name: "End", x: 460, y: 20 },
      ],
      edges: [{ id: "x", from: "s", to: "a" }, { id: "y", from: "a", to: "e" }],
    });
    await page.setInputFiles("#sw-import-file", { name: "wf.json", mimeType: "application/json", buffer: Buffer.from(file) });
    await page.waitForFunction(() => document.querySelector("#sw-name")?.value === "From a file");
    assert.equal(await page.locator("#subagent-workflow-pane .sw-node").count(), 3);
    assert.equal(await page.locator("#subagent-workflow-pane path.sw-edge").count(), 2);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("pauses on a gate and resumes when the gate's sidebar card approves it", async () => {
    const solo = path.join(tmpDir, "ws-approve-ui");
    fs.mkdirSync(solo, { recursive: true });
    const g = await buildApprovalGraph(solo);
    await act("updateNode", { id: g.start.id, config: { defaultTask: "hello" } }, solo);

    const { page, context, errors } = await openWorkflow(solo);
    // The run panel carries no task box and no separate approval banner: a gate
    // is decided from its own card in the gate node's messages sidebar.
    assert.equal(await page.locator("#sw-task").count(), 0, "no run-level task box");
    assert.equal(await page.locator(".sw-approvals").count(), 0, "no approval banner above the log");
    // The gate is on the canvas with its own mark and no provider icon.
    assert.equal(await page.locator(`.sw-node.sw-t-approval[data-id="${g.gate.id}"] .sw-node-glyph`).count(), 1);
    assert.equal(await page.locator(`.sw-node[data-id="${g.gate.id}"] .sw-hicon`).count(), 0);

    await page.click(`.sw-node[data-id="${g.gate.id}"] .sw-node-name`);
    await page.waitForFunction(() => document.querySelector("#sw-msg-title")?.textContent === "review");
    await page.click("#sw-run");
    await page.waitForSelector(".sw-msg-gate.waiting");
    assert.match(await page.textContent(".sw-msg-gate .sw-msg-gate-msg"), /Please review: A1\[hello\]/);
    assert.match(await page.textContent("#sw-run-status"), /waiting for approval/);
    assert.equal(await page.locator(".sw-msg-gate").count(), 1);
    // The canvas badges the waiting gate and leaves the downstream node alone.
    await page.waitForSelector(`.sw-node[data-id="${g.gate.id}"].sw-run-waiting`);
    assert.equal(await page.locator(`.sw-node[data-id="${g.last.id}"].sw-run-done`).count(), 0);

    await page.fill(".sw-msg-gate .sw-msg-note", "ship it");
    await page.click(".sw-msg-gate [data-approve]");
    await page.waitForFunction((id) =>
      document.querySelector(`.sw-node[data-id="${id}"]`)?.classList.contains("sw-run-done"), g.last.id, { timeout: 20_000 });
    assert.match(await page.textContent("#sw-run-log"), /review approved/);
    const finished = await waitRun(solo);
    assert.equal(finished.status, "done");
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("a gate on a loop's Exit reviews the finished loop, not an intermediate pass", async () => {
    const solo = path.join(tmpDir, "ws-gate-loop");
    fs.mkdirSync(solo, { recursive: true });
    // The reporter's shape: start → rob → pop, loop.repeat → rob, and the loop's
    // Exit → gate → end. The gate is fed the finished loop (pop's last pass), and
    // its sidebar card must show exactly that.
    const s = await snapshot(solo);
    const start = s.nodes.find((n) => n.type === "start");
    const end = s.nodes.find((n) => n.type === "end");
    const rob = s.nodes.find((n) => n.type === "agent");
    assert.ok((await act("updateNode", { id: start.id, config: { defaultTask: "seed" } }, solo)).res.ok);
    assert.ok((await act("updateNode", { id: rob.id, name: "rob", config: {
      harness: "custom", command: echoQuery("R"), prompt: "{input}",
    } }, solo)).res.ok);
    const pop = (await act("addNode", { type: "agent", x: 420, y: 120 }, solo)).data.nodes.at(-1);
    assert.ok((await act("updateNode", { id: pop.id, name: "pop", config: {
      harness: "custom", command: echoPassQuery("P"), prompt: "{input}",
    } }, solo)).res.ok);
    const loop = (await act("addNode", { type: "loop", x: 620, y: 120 }, solo)).data.nodes.at(-1);
    assert.ok((await act("updateNode", { id: loop.id, name: "loop", config: { count: 3 } }, solo)).res.ok);
    const gate = (await act("addNode", { type: "approval", x: 820, y: 120 }, solo)).data.nodes.at(-1);
    assert.ok((await act("updateNode", { id: gate.id, name: "review", config: {
      message: "Approve: {input}",
    } }, solo)).res.ok);
    for (const e of s.edges) await act("removeEdge", { id: e.id }, solo);
    for (const [from, to, port] of [
      [start.id, rob.id], [rob.id, pop.id], [pop.id, loop.id],
      [loop.id, rob.id, "repeat"], [loop.id, gate.id], [gate.id, end.id],
    ]) {
      const r = await act("addEdge", port ? { from, to, port } : { from, to }, solo);
      assert.ok(r.res.ok, r.data?.error);
    }

    assert.ok((await runApi("start", {}, solo)).res.ok);
    const waiting = await waitNode(solo, gate.id, "waiting");
    // What the gate reviews is the finished loop — its last pass alone, which is
    // pop's final result — never the loop's seed or an earlier pass.
    const loopOut = waiting.nodes[loop.id].outputTail.trim();
    assert.equal(loopOut, waiting.nodes[pop.id].outputTail.trim(), "the loop carries pop's final pass");
    assert.equal(waiting.nodes[gate.id].approval.message, `Approve: ${loopOut}`);
    assert.match(loopOut, /^P3\[/, "the third (last) pass, not an earlier one");

    // The sidebar reads the gate's input as the loop it is, showing the loop's
    // final result — not an intermediate pass, and not its raw stream.
    const { page, context, errors } = await openWorkflow(solo);
    await page.click(`.sw-node[data-id="${gate.id}"] .sw-node-name`);
    await page.waitForFunction(() => document.querySelector("#sw-msg-title")?.textContent === "review");
    await page.waitForSelector(".sw-msg-gate.waiting");
    const inputs = await page.$$eval("#sw-msg-body .sw-msg-input", (els) => els.map((e) => e.dataset.input));
    assert.deepEqual(inputs, [loop.id], "the loop is the gate's one input");
    const brief = page.locator(`#sw-msg-body .sw-msg-input[data-input="${loop.id}"]`);
    assert.match(await brief.locator(".sw-msg-pre").textContent(), /^P3\[/, "the loop's final result");
    assert.equal(await brief.locator(".sw-msg-lines").count(), 0, "no intermediate stream in the gate brief");
    assert.deepEqual(errors, []);
    await context.close();
    await runApi("stop", {}, solo);
  });

  test("reopens a past run from the picker after a reload", async () => {
    const solo = path.join(tmpDir, "ws-history-ui");
    fs.mkdirSync(solo, { recursive: true });
    await buildCustomGraph(solo);
    for (const task of ["first", "second"]) {
      assert.ok((await runApi("start", { task }, solo)).res.ok);
      assert.equal((await waitRun(solo)).status, "done");
    }

    const { page, context, errors } = await openWorkflow(solo);
    // The canvas shows the latest run; the earlier one is in the picker.
    assert.match(await page.textContent("#sw-run-log"), /A1\[second\]/);
    await page.waitForFunction(() => !document.querySelector("#sw-history")?.disabled);
    const past = await page.$eval("#sw-history option:nth-child(2)", (o) => o.value);
    assert.ok(past, "an older run is selectable");

    await page.selectOption("#sw-history", past);
    await page.waitForFunction(() => /past run/.test(document.querySelector("#sw-run-status")?.textContent || ""));
    assert.match(await page.textContent("#sw-run-log"), /A1\[first\]/);
    assert.ok(await page.locator(".sw-node.sw-run-done").count() >= 3, "the canvas replays the past run's badges");
    // A reopened record carries the workflow's final output as well — both on
    // the end node's card and, in full, in its panel.
    assert.match(await page.textContent(".sw-node.sw-t-end .sw-node-final"), /A2\[A1\[first\]\]/);
    await page.click(".sw-node.sw-t-end .sw-node-config");
    await page.waitForSelector("#sw-final-body .sw-final-md");
    assert.match(await page.textContent("#sw-final-body .sw-final-md"), /A3\[A1\[first\]\]/);

    // …and back to the live view.
    await page.selectOption("#sw-history", "");
    await page.waitForFunction(() => /A1\[second\]/.test(document.querySelector("#sw-run-log")?.textContent || ""));
    assert.doesNotMatch(await page.textContent("#sw-run-status"), /past run/);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("the messages sidebar appears only for the clicked node, not as one mixed feed", async () => {
    const solo = path.join(tmpDir, "ws-msgs-ui");
    fs.mkdirSync(solo, { recursive: true });
    const g = await buildCustomGraph(solo);
    await act("updateNode", { id: g.start.id, config: { defaultTask: "world" } }, solo);
    const { page, context, errors } = await openWorkflow(solo);

    // Opening the canvas selects nothing, so there is no feed and no sidebar.
    assert.equal(await page.locator("#sw-msg-side:visible").count(), 0, "the sidebar starts folded away");
    assert.equal(await page.locator("#sw-msg-body .sw-msg-section").count(), 0, "and renders no mixed feed");

    await page.click("#sw-run");
    await page.waitForFunction(() =>
      document.querySelectorAll(".sw-node.sw-run-done").length >= 4, null, { timeout: 25_000 });
    assert.equal(await page.locator("#sw-msg-side:visible").count(), 0, "a run alone does not open it");

    // Clicking an agent's card shows that node's messages — its own, and only
    // its own.
    await page.click(`.sw-node[data-id="${g.a2.id}"] .sw-node-name`);
    await page.waitForFunction(() => document.querySelector("#sw-msg-title")?.textContent === "a2");
    assert.equal(await page.locator("#sw-msg-side:visible").count(), 1);
    assert.equal(await page.locator("#sw-msg-body .sw-msg-section[data-node]").count(), 1, "one agent in focus");
    const focused = await page.textContent("#sw-msg-body");
    assert.match(focused, /A2\[A1\[world\]\]/);
    assert.doesNotMatch(focused, /A3\[A1\[world\]\]/, "another agent's messages are not in this view");
    // It reads as a conversation: what the node was handed, then what it said.
    assert.match(await page.textContent(".sw-msg-sent pre"), /\{input\}/);

    // Clicking another node swaps the view; the previous workflow's agent is
    // not carried along.
    await page.click(`.sw-node[data-id="${g.a3.id}"] .sw-node-name`);
    await page.waitForFunction(() => document.querySelector("#sw-msg-title")?.textContent === "a3");
    assert.match(await page.textContent("#sw-msg-body"), /A3\[A1\[world\]\]/);
    assert.doesNotMatch(await page.textContent("#sw-msg-body"), /A2\[A1\[world\]\]/);

    // It sits beside the canvas, not over it: the diagram keeps a workable
    // width and the two never overlap.
    const layout = await page.evaluate(() => {
      const side = document.getElementById("sw-msg-side").getBoundingClientRect();
      const canvas = document.querySelector(".sw-canvas-scroll").getBoundingClientRect();
      return { sideW: Math.round(side.width), sideL: Math.round(side.left), canvasR: Math.round(canvas.right), canvasW: Math.round(canvas.width) };
    });
    assert.ok(layout.sideW >= 240, `the sidebar has room to read (${layout.sideW}px)`);
    assert.ok(layout.sideL >= layout.canvasR, `and sits after the canvas (${layout.sideL} ≥ ${layout.canvasR})`);
    assert.ok(layout.canvasW >= 700, `which keeps its own width (${layout.canvasW}px)`);

    // Its close control clears the selection and folds the panel away again.
    await page.click("#sw-msg-close");
    await page.waitForFunction(() => !document.querySelector(".sw-node.sel"));
    assert.equal(await page.locator("#sw-msg-side:visible").count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("the messages sidebar shows what the agent said, not its harness's chatter", async () => {
    const solo = path.join(tmpDir, "ws-msgs-own");
    fs.mkdirSync(solo, { recursive: true });
    const s = await snapshot(solo);
    const agent = s.nodes.find((n) => n.type === "agent");

    // The mix a real CLI writes: the answer on stdout, its banner and tool rows
    // on stderr (opencode does exactly this). The sidebar is the conversation.
    const command =
      "printf 'The agent said this.\\n'; " +
      "printf '> build · deepseek-v4.1-flash-free\\n' >&2; " +
      "printf '⚙ execute {}\\n' >&2; " +
      "printf '◈ Web Search via Exa \"x\"\\n' >&2";
    assert.ok((await act("updateNode", { id: agent.id, name: "talker", config: {
      harness: "custom", command, prompt: "{task}",
    } }, solo)).res.ok);

    const started = await runApi("start", { task: "chat check" }, solo);
    assert.ok(started.res.ok, started.data?.error);
    const run = await waitRun(solo);
    assert.equal(run.status, "done", JSON.stringify(run.log));

    // The node's output is its answer alone: that is what the sidebar reads and
    // what a downstream node is handed. The stderr chatter stays in the log.
    assert.equal(run.nodes[agent.id].outputTail, "The agent said this.\n",
      "the output tail is stdout, not the harness's status stream");

    const { page, context, errors } = await openWorkflow(solo);
    // The sidebar is a node's context, so open it by clicking that node.
    await page.click(`.sw-node[data-id="${agent.id}"] .sw-node-name`);
    await page.waitForFunction(() => document.querySelector("#sw-msg-title")?.textContent === "talker");
    const body = await page.textContent("#sw-msg-body");
    assert.match(body, /The agent said this\./, "the agent's own words are in the sidebar");
    assert.doesNotMatch(body, /build ·/, "its banner is not");
    assert.doesNotMatch(body, /execute/, "nor its tool calls");
    assert.doesNotMatch(body, /Web Search/, "nor the tool rows");

    // Nothing was lost: the run log still carries the harness's whole stream.
    const logText = await page.textContent("#sw-run-log");
    assert.match(logText, /build ·/, "the run log keeps the banner");
    assert.match(logText, /Web Search/, "and the tool rows");

    assert.deepEqual(errors, []);
    await context.close();
  });

  test("the messages sidebar resizes by its handle and remembers the width", async () => {
    const solo = path.join(tmpDir, "ws-msgs-size");
    fs.mkdirSync(solo, { recursive: true });
    const g = await buildCustomGraph(solo);
    const { page, context, errors } = await openWorkflow(solo);
    // The sidebar only exists beside a selected node.
    await page.click(`.sw-node[data-id="${g.a2.id}"] .sw-node-name`);
    await page.waitForFunction(() => document.querySelector("#sw-msg-side")?.offsetParent);

    const sideW = () => page.$eval("#sw-msg-side", (el) => Math.round(el.getBoundingClientRect().width));
    const start = await sideW();
    assert.ok(start >= 300, `the sidebar starts at its default width (${start}px)`);

    // Drag the handle LEFT: the sidebar grows.
    const box = await page.locator("#sw-msg-resizer").boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 160, cy, { steps: 8 });
    await page.mouse.up();
    const grown = await sideW();
    assert.ok(grown >= start + 140, `the sidebar grew with the drag (${start} → ${grown})`);

    // It still sits flush at the canvas edge — the sidebar never covers the
    // canvas (the drag handle straddles the seam, costing the row no width) —
    // and the canvas keeps a workable width.
    const layout = await page.evaluate(() => {
      const side = document.getElementById("sw-msg-side").getBoundingClientRect();
      const canvas = document.querySelector(".sw-canvas-scroll").getBoundingClientRect();
      return { sideL: Math.round(side.left), canvasR: Math.round(canvas.right), canvasW: Math.round(canvas.width) };
    });
    assert.ok(Math.abs(layout.sideL - layout.canvasR) <= 1,
      `the sidebar sits flush at the canvas edge (${layout.sideL} vs ${layout.canvasR})`);
    assert.ok(layout.canvasW > 0, `which keeps its own width (${layout.canvasW}px)`);

    // The chosen width survives a reload (it is remembered per browser).
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#sw-msg-resizer", { state: "attached" });
    await page.click(`.sw-node[data-id="${g.a2.id}"] .sw-node-name`);
    await page.waitForFunction((w) =>
      Math.abs(document.getElementById("sw-msg-side").getBoundingClientRect().width - w) < 4, grown);

    // Double-clicking the handle restores the default.
    await page.dblclick("#sw-msg-resizer");
    await page.waitForFunction((w) =>
      Math.abs(document.getElementById("sw-msg-side").getBoundingClientRect().width - w) < 4, start);

    // The handle is a keyboard-operable separator, and it folds away with the
    // panel when the node selection is cleared.
    assert.equal(await page.getAttribute("#sw-msg-resizer", "role"), "separator");
    assert.equal(await page.getAttribute("#sw-msg-resizer", "aria-orientation"), "vertical");
    await page.focus("#sw-msg-resizer");
    await page.keyboard.press("ArrowLeft");
    assert.ok(await sideW() > start, "ArrowLeft grows the sidebar");
    await page.click("#sw-msg-close");
    assert.equal(await page.locator("#sw-msg-resizer:visible").count(), 0, "the handle folds away with the panel");
    await page.click(`.sw-node[data-id="${g.a2.id}"] .sw-node-name`);
    assert.equal(await page.locator("#sw-msg-resizer:visible").count(), 1);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("remembers pan and zoom separately for each workspace", async () => {
    const wa = path.join(tmpDir, "ws-view-a");
    const wb = path.join(tmpDir, "ws-view-b");
    fs.mkdirSync(wa, { recursive: true });
    fs.mkdirSync(wb, { recursive: true });
    await snapshot(wa);
    await snapshot(wb);
    const scrollOf = () => page.$eval(".sw-canvas-scroll", (el) => ({ x: el.scrollLeft, y: el.scrollTop }));

    const { page, context, errors } = await openWorkflow(wa);
    await page.click("#sw-zoom-in");
    assert.equal(await page.textContent("#sw-zoom-pct"), "120%");
    const view = await page.locator(".sw-canvas-scroll").boundingBox();
    const before = await scrollOf();
    await page.mouse.move(view.x + view.width - 60, view.y + view.height - 60);
    await page.mouse.down();
    await page.mouse.move(view.x + view.width - 280, view.y + view.height - 220, { steps: 10 });
    await page.mouse.up();
    const panned = await scrollOf();
    assert.ok(panned.x > before.x + 150 && panned.y > before.y + 100, "the view moved on both axes");
    await sleep(350); // let the debounced save land

    // A reload restores exactly this workspace's zoom and scroll.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#sw-zoom-pct");
    await page.waitForFunction(() => document.querySelector("#sw-zoom-pct")?.textContent === "120%");
    const restored = await scrollOf();
    assert.ok(Math.abs(restored.x - panned.x) <= 3, `x restored (${panned.x} → ${restored.x})`);
    assert.ok(Math.abs(restored.y - panned.y) <= 3, `y restored (${panned.y} → ${restored.y})`);

    // Another workspace has its own (default) view, not this one's. Switching
    // through the app's shared cwd — not a storage poke + reload — is the real
    // path the workspace rail uses.
    await page.evaluate((w) => window.__setCwd(w), wb);
    await page.waitForFunction(() =>
      document.querySelector("#subagent-workflow-pane .sw-node") &&
      document.querySelector("#sw-zoom-pct")?.textContent === "100%");
    assert.deepEqual(await scrollOf(), { x: 0, y: 0 }, "the other workspace starts at its own origin");

    // Give the second workspace a distinct view of its own.
    await page.click("#sw-zoom-out");
    const zoomB = await page.textContent("#sw-zoom-pct");
    const viewB = await page.locator(".sw-canvas-scroll").boundingBox();
    await page.mouse.move(viewB.x + viewB.width - 60, viewB.y + viewB.height - 60);
    await page.mouse.down();
    await page.mouse.move(viewB.x + viewB.width - 200, viewB.y + viewB.height - 170, { steps: 8 });
    await page.mouse.up();
    const pannedB = await scrollOf();
    assert.ok(pannedB.x > 80 && pannedB.y > 60, "the second workspace has its own pan");
    await sleep(350);

    // Returning to the first workspace brings its view back.
    await page.evaluate((w) => window.__setCwd(w), wa);
    await page.waitForFunction(() => document.querySelector("#sw-zoom-pct")?.textContent === "120%");
    const again = await scrollOf();
    assert.ok(Math.abs(again.x - panned.x) <= 3 && Math.abs(again.y - panned.y) <= 3,
      "the first workspace's pan came back");

    // A reload still opens the first workspace where it was left…
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#sw-zoom-pct")?.textContent === "120%");
    const afterReload = await scrollOf();
    assert.ok(Math.abs(afterReload.x - panned.x) <= 3 && Math.abs(afterReload.y - panned.y) <= 3,
      "and the reload kept it");

    // …and the second workspace still remembers its own view too.
    await page.evaluate((w) => window.__setCwd(w), wb);
    await page.waitForFunction((z) => document.querySelector("#sw-zoom-pct")?.textContent === z, zoomB);
    const againB = await scrollOf();
    assert.ok(Math.abs(againB.x - pannedB.x) <= 3 && Math.abs(againB.y - pannedB.y) <= 3,
      `the second workspace's pan came back (${pannedB.x},${pannedB.y} → ${againB.x},${againB.y})`);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("the canvas zooms, and a drag stays true to the pointer at any zoom", async () => {
    const solo = path.join(tmpDir, "ws-zoom");
    fs.mkdirSync(solo, { recursive: true });
    const g = await buildCustomGraph(solo);
    const { page, context, errors } = await openWorkflow(solo);

    const pct = () => page.textContent("#sw-zoom-pct");
    const canvasW = () => page.$eval("#sw-canvas", (el) => Math.round(el.getBoundingClientRect().width));
    const at1 = await canvasW();
    assert.equal(await pct(), "100%");

    await page.click("#sw-zoom-in");
    assert.equal(await pct(), "120%");
    assert.ok(Math.abs((await canvasW()) - at1 * 1.2) <= 2, `the canvas is scaled (${at1} → ${await canvasW()})`);

    // A node drag is measured in canvas px, so at 120% a 120px screen drag must
    // move the node 100 canvas px — not 120.
    const before = (await snapshot(solo)).nodes.find((n) => n.id === g.a2.id);
    const box = await page.locator(`.sw-node[data-id="${g.a2.id}"]`).boundingBox();
    await page.mouse.move(box.x + 60, box.y + 12);
    await page.mouse.down();
    await page.mouse.move(box.x + 60 + 120, box.y + 12 + 60, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction((id) => {
      const el = document.querySelector(`.sw-node[data-id="${id}"]`);
      return el && el.style.left !== "";
    }, g.a2.id);
    const moved = (await snapshot(solo)).nodes.find((n) => n.id === g.a2.id);
    assert.ok(Math.abs(moved.x - before.x - 100) <= 3, `x moved in canvas px (${before.x} → ${moved.x})`);
    assert.ok(Math.abs(moved.y - before.y - 50) <= 3, `and so did y (${before.y} → ${moved.y})`);

    // Ctrl/⌘ + wheel zooms about the pointer.
    await page.evaluate(() => {
      document.querySelector(".sw-canvas-scroll").dispatchEvent(new WheelEvent("wheel",
        { deltaY: -240, ctrlKey: true, clientX: 500, clientY: 300, bubbles: true, cancelable: true }));
    });
    assert.ok(parseInt(await pct(), 10) > 120, "ctrl+wheel zooms in");

    // The chosen zoom survives a reload, and the percentage resets it.
    const kept = await pct();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#sw-zoom-pct");
    assert.equal(await pct(), kept, "the zoom is remembered per browser");
    await page.click("#sw-zoom-pct");
    assert.equal(await pct(), "100%");

    // Fit brings the whole graph on screen (never zooming in past 1:1).
    await page.click("#sw-zoom-out");
    await page.click("#sw-zoom-fit");
    const fitted = parseInt(await pct(), 10);
    assert.ok(fitted <= 100 && fitted >= 40, `Fit picks a zoom that shows the graph (${fitted}%)`);
    const allInside = await page.evaluate(() => {
      const view = document.querySelector(".sw-canvas-scroll").getBoundingClientRect();
      return [...document.querySelectorAll("#sw-canvas .sw-node")].every((el) => {
        const r = el.getBoundingClientRect();
        return r.left >= view.left - 1 && r.right <= view.right + 1 && r.top >= view.top - 1 && r.bottom <= view.bottom + 1;
      });
    });
    assert.ok(allInside, "every node is on screen after Fit");
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("the end node's sidebar separates what each agent wired into it produced", async () => {
    const solo = path.join(tmpDir, "ws-msgs-end");
    fs.mkdirSync(solo, { recursive: true });
    const g = await buildCustomGraph(solo);
    assert.ok((await runApi("start", { task: "world" }, solo)).res.ok);
    assert.equal((await waitRun(solo)).status, "done");

    const { page, context, errors } = await openWorkflow(solo);
    await page.click(`.sw-node[data-id="${g.end.id}"] .sw-node-name`);
    await page.waitForFunction(() => document.querySelector("#sw-msg-title")?.textContent === "End");
    // One section per input agent, each holding that agent's own output and
    // never the other's…
    // The seeded first → end connection is still wired, so all three agents
    // that feed the end node get a section.
    const inputs = await page.$$eval("#sw-msg-body .sw-msg-input", (els) => els.map((e) => e.dataset.input));
    assert.deepEqual(inputs.slice().sort(), [g.first.id, g.a2.id, g.a3.id].sort());
    const a2 = await page.textContent(`#sw-msg-body .sw-msg-input[data-input="${g.a2.id}"] pre`);
    assert.match(a2, /A2\[A1\[world\]\]/);
    assert.doesNotMatch(a2, /A3/, "the sibling branch is not mixed in");
    const a3 = await page.textContent(`#sw-msg-body .sw-msg-input[data-input="${g.a3.id}"] pre`);
    assert.match(a3, /A3\[A1\[world\]\]/);
    assert.doesNotMatch(a3, /A2/);
    // …and the joined output those sections add up to.
    assert.match(await page.textContent("#sw-msg-body .sw-msg-final > .sw-msg-pre"),
      /A2\[A1\[world\]\][\s\S]*A3\[A1\[world\]\]/);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("a waiting gate is approved from the sidebar, with its input agents laid out", async () => {
    const solo = path.join(tmpDir, "ws-msgs-gate");
    fs.mkdirSync(solo, { recursive: true });
    const g = await buildApprovalGraph(solo);
    await act("updateNode", { id: g.start.id, config: { defaultTask: "hello" } }, solo);

    const { page, context, errors } = await openWorkflow(solo);
    // The gate's card is shown in the gate node's own sidebar context, so select
    // that node before running.
    await page.click(`.sw-node[data-id="${g.gate.id}"] .sw-node-name`);
    await page.waitForFunction(() => document.querySelector("#sw-msg-title")?.textContent === "review");
    await page.click("#sw-run");
    // The gate's card carries the same request as the banner, in the sidebar.
    await page.waitForSelector(".sw-msg-gate.waiting");
    assert.match(await page.textContent(".sw-msg-gate .sw-msg-gate-msg"), /Please review: A1\[hello\]/);
    assert.equal(await page.locator(".sw-msg-gate [data-approve]").count(), 1);
    assert.equal(await page.locator(".sw-msg-gate [data-reject]").count(), 1);

    // The focused gate reads each input node as a brief: the message it was
    // handed and its final result, never the raw stream.
    const inputs = await page.$$eval("#sw-msg-body .sw-msg-input", (els) => els.map((e) => e.dataset.input));
    assert.deepEqual(inputs, [g.first.id], "the agent feeding the gate");
    const brief = page.locator(`#sw-msg-body .sw-msg-input[data-input="${g.first.id}"]`);
    assert.match(await brief.locator(".sw-msg-sent pre").textContent(), /\{task\}/, "its user message");
    assert.match(await brief.locator(".sw-msg-pre").textContent(), /A1\[hello\]/, "its final result");
    assert.equal(await brief.locator(".sw-msg-lines").count(), 0, "no raw stream in a gate brief");

    // Approving from here decides the run, exactly like the banner.
    await page.fill(".sw-msg-gate .sw-msg-note", "ship it");
    await page.click(".sw-msg-gate [data-approve]");
    await page.waitForFunction((id) =>
      document.querySelector(`.sw-node[data-id="${id}"]`)?.classList.contains("sw-run-done"), g.last.id, { timeout: 20_000 });
    assert.equal(await page.locator(".sw-approvals").count(), 0, "there is no separate approval banner");
    assert.match(await page.textContent("#sw-run-log"), /review approved/);
    // The sidebar shows the decision too, now that the gate is settled.
    await page.waitForFunction(() => /approved/.test(document.querySelector(".sw-msg-gate")?.textContent || ""));
    // …and it keeps the message the reviewer actually read: the decided card
    // shows the interpolated text, never the raw `{input}` template.
    assert.match(await page.textContent(".sw-msg-gate .sw-msg-gate-msg"), /Please review: A1\[hello\]/);
    assert.doesNotMatch(await page.textContent(".sw-msg-gate .sw-msg-gate-msg"), /\{input\}/);
    assert.equal((await waitRun(solo)).status, "done");
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("Shift-dragging the canvas marquee-selects nodes for grouping", async () => {
    const solo = path.join(tmpDir, "ws-marquee");
    fs.mkdirSync(solo, { recursive: true });
    const seeded = await snapshot(solo);
    const start = seeded.nodes.find((n) => n.type === "start");
    const agent = seeded.nodes.find((n) => n.type === "agent");
    const end = seeded.nodes.find((n) => n.type === "end");

    const { page, context, errors } = await openWorkflow(solo);
    const startBox = await page.locator(`.sw-node[data-id="${start.id}"]`).boundingBox();
    const agentBox = await page.locator(`.sw-node[data-id="${agent.id}"]`).boundingBox();
    const endBox = await page.locator(`.sw-node[data-id="${end.id}"]`).boundingBox();
    const x = Math.min(startBox.x, agentBox.x) - 30;
    const y = Math.min(startBox.y, agentBox.y) - 30;
    const right = Math.max(startBox.x + startBox.width, agentBox.x + agentBox.width) + 30;
    const bottom = Math.max(startBox.y + startBox.height, agentBox.y + agentBox.height) + 30;
    assert.ok(right < endBox.x, "the box stops before the end node");

    await page.keyboard.down("Shift");
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(right, bottom, { steps: 8 });
    assert.equal(await page.locator("#sw-marquee:visible").count(), 1, "the drag paints a selection box");
    await page.mouse.up();
    await page.keyboard.up("Shift");

    assert.equal(await page.locator("#sw-canvas .sw-node.sel").count(), 2, "both cards inside the box are picked");
    await page.click("#sw-add-group");
    await page.waitForSelector(".sw-group");
    const made = await snapshot(solo);
    assert.equal(made.groups.length, 1);
    assert.deepEqual(made.groups[0].nodeIds.slice().sort(), [agent.id, start.id].sort());
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("groups selected nodes on the canvas, drags the frame, folds it and ungroups", async () => {
    const solo = path.join(tmpDir, "ws-groups-ui");
    fs.mkdirSync(solo, { recursive: true });
    const seeded = await snapshot(solo);
    const start = seeded.nodes.find((n) => n.type === "start");
    const agent = seeded.nodes.find((n) => n.type === "agent");
    const end = seeded.nodes.find((n) => n.type === "end");

    const { page, context, errors } = await openWorkflow(solo);
    // Pick two cards — a plain click, then Shift-click — and group them.
    await page.click(`.sw-node[data-id="${agent.id}"] .sw-node-name`);
    await page.locator(`.sw-node[data-id="${start.id}"] .sw-node-name`).click({ modifiers: ["Shift"] });
    assert.equal(await page.locator(".sw-node.sel").count(), 2, "both picked nodes read as selected");
    await page.click("#sw-add-group");
    await page.waitForSelector(".sw-group");
    assert.equal(await page.locator(".sw-group").count(), 1);
    assert.equal(await page.locator("#sw-canvas .sw-node").count(), 3, "grouping keeps every card");
    assert.equal(await page.inputValue(".sw-group-name"), "Group 1");
    assert.equal(await page.textContent(".sw-group-count"), "2 nodes");
    const made = await snapshot(solo);
    assert.equal(made.groups.length, 1);
    assert.deepEqual(made.groups[0].nodeIds.slice().sort(), [agent.id, start.id].sort());

    // Dragging the group's header moves the whole workflow — and nothing else.
    const before = await snapshot(solo);
    const a0 = before.nodes.find((n) => n.id === agent.id);
    const e0 = before.nodes.find((n) => n.id === end.id);
    const drag = await page.locator(".sw-group-count").boundingBox();
    await page.mouse.move(drag.x + drag.width / 2, drag.y + drag.height / 2);
    await page.mouse.down();
    await page.mouse.move(drag.x + drag.width / 2 + 120, drag.y + drag.height / 2 + 60, { steps: 8 });
    await page.mouse.up();
    let moved = null;
    for (let i = 0; i < 50; i++) {
      moved = await snapshot(solo);
      if (moved.nodes.find((n) => n.id === agent.id).x === a0.x + 120) break;
      await sleep(60);
    }
    const a1 = moved.nodes.find((n) => n.id === agent.id);
    const s1 = moved.nodes.find((n) => n.id === start.id);
    assert.equal(a1.x, a0.x + 120, "the member moved with the frame");
    assert.equal(a1.y, a0.y + 60);
    assert.equal(s1.x, before.nodes.find((n) => n.id === start.id).x + 120, "the other member moved too");
    assert.equal(moved.nodes.find((n) => n.id === end.id).x, e0.x, "a node outside the group stays put");
    assert.equal(moved.groups[0].collapsed, false);

    // Folding hides the members and their wiring behind one chip.
    await page.click(".sw-group-fold");
    await page.waitForSelector(".sw-group.collapsed");
    await page.waitForFunction(() => document.querySelectorAll("#sw-canvas .sw-node").length === 1);
    assert.equal(await page.locator("#sw-canvas .sw-node").count(), 1, "only the ungrouped end node remains");
    assert.equal(await page.locator("#sw-canvas path.sw-edge").count(), 0, "wiring into a folded group is hidden with it");
    assert.equal(await page.textContent(".sw-group-count"), "2 nodes");
    assert.equal((await snapshot(solo)).groups[0].collapsed, true, "the fold is remembered server-side");

    // Unfolding brings back the cards, their connections and the frame.
    await page.click(".sw-group-fold");
    await page.waitForFunction(() => document.querySelectorAll("#sw-canvas .sw-node").length === 3);
    assert.equal(await page.locator("#sw-canvas path.sw-edge").count(), seeded.edges.length);

    // The header's power button is the group's master switch: it dims the frame
    // and its cards, and the state is remembered server-side.
    assert.equal(await page.getAttribute(".sw-group-power", "aria-pressed"), "true");
    const powerBox = await page.locator(".sw-group-power").boundingBox();
    const lockBox = await page.locator(".sw-group-resize-toggle").boundingBox();
    assert.ok(powerBox.width >= 24 && powerBox.height >= 24,
      `the master switch is large enough to find (${powerBox.width}×${powerBox.height})`);
    assert.ok(lockBox.width >= 24 && lockBox.height >= 24,
      `the resize lock is large enough to find (${lockBox.width}×${lockBox.height})`);
    await page.click(".sw-group-power");
    await page.waitForFunction(() => document.querySelector(".sw-group")?.classList.contains("off"));
    assert.equal(await page.getAttribute(".sw-group-power", "aria-pressed"), "false");
    assert.equal(await page.locator(".sw-node.sw-group-off").count(), 2, "both members dim with the group");
    for (let i = 0; i < 40 && (await snapshot(solo)).groups[0].enabled !== false; i++) await sleep(50);
    assert.equal((await snapshot(solo)).groups[0].enabled, false, "the master switch is remembered server-side");
    await page.click(".sw-group-power");
    await page.waitForFunction(() => !document.querySelector(".sw-group")?.classList.contains("off"));
    assert.equal(await page.locator(".sw-node.sw-group-off").count(), 0);

    // The header field renames the workflow.
    await page.fill(".sw-group-name", "Release");
    await page.locator(".sw-group-name").evaluate((el) => el.blur());
    for (let i = 0; i < 40 && (await snapshot(solo)).groups[0].name !== "Release"; i++) await sleep(50);
    assert.equal((await snapshot(solo)).groups[0].name, "Release");

    // Dragging one card out of the frame leaves just that node ungrouped.
    const agentCard = await page.locator(`.sw-node[data-id="${agent.id}"] .sw-node-name`).boundingBox();
    const frameBeforeDragOut = await page.locator(".sw-group").boundingBox();
    await page.mouse.move(agentCard.x + 30, agentCard.y + 8);
    await page.mouse.down();
    await page.mouse.move(agentCard.x + 520, agentCard.y + 320, { steps: 10 });
    // The frame must stay still while the card is pulled out; it used to stretch
    // on every pointer move, following the node instead of letting it leave.
    await sleep(120);
    const frameDuringDragOut = await page.locator(".sw-group").boundingBox();
    assert.ok(Math.abs(frameDuringDragOut.width - frameBeforeDragOut.width) <= 1,
      `the frame holds still during the drag (${frameBeforeDragOut.width} → ${frameDuringDragOut.width})`);
    assert.ok(Math.abs(frameDuringDragOut.height - frameBeforeDragOut.height) <= 1,
      `and keeps its height (${frameBeforeDragOut.height} → ${frameDuringDragOut.height})`);
    await page.mouse.up();
    let afterOut = null;
    for (let i = 0; i < 50; i++) {
      afterOut = await snapshot(solo);
      if (afterOut.groups[0].nodeIds.length === 1) break;
      await sleep(60);
    }
    assert.deepEqual(afterOut.groups[0].nodeIds, [start.id], "only the dragged node left the group");
    assert.equal(afterOut.nodes.length, 3, "the ungrouped node stays on the canvas");
    assert.equal(await page.locator(`.sw-node[data-id="${agent.id}"]`).count(), 1);
    await page.waitForFunction((w) => {
      const el = document.querySelector(".sw-group");
      return !!el && el.getBoundingClientRect().width < w;
    }, frameBeforeDragOut.width);
    const frameAfterDrop = await page.locator(".sw-group").boundingBox();
    assert.ok(frameAfterDrop.width < frameBeforeDragOut.width,
      `the remaining frame shrinks back around its one member (${frameBeforeDragOut.width} → ${frameAfterDrop.width})`);

    // Ungrouping removes only the frame: every node is still on the canvas.
    await page.click(".sw-group-remove");
    await page.waitForFunction(() => !document.querySelector(".sw-group"));
    assert.equal(await page.locator("#sw-canvas .sw-node").count(), 3);
    assert.equal((await snapshot(solo)).groups.length, 0);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("dropping a node into a group expands its frame to hold it", async () => {
    const solo = path.join(tmpDir, "ws-group-drop");
    fs.mkdirSync(solo, { recursive: true });
    const seeded = await snapshot(solo);
    const start = seeded.nodes.find((n) => n.type === "start");
    const agent = seeded.nodes.find((n) => n.type === "agent");
    const end = seeded.nodes.find((n) => n.type === "end");
    const made = await act("addGroup", { name: "Team", nodeIds: [start.id, agent.id] }, solo);
    assert.ok(made.res.ok, made.data?.error);

    const { page, context, errors } = await openWorkflow(solo);
    const frame = await page.locator(".sw-group").boundingBox();
    const endCard = await page.locator(`.sw-node[data-id="${end.id}"] .sw-node-name`).boundingBox();

    // Drop the end card inside the frame's lower-right corner: close enough to
    // join the group, far enough right that the frame must grow around it.
    const dropX = frame.x + frame.width - 12;
    const dropY = frame.y + frame.height - 12;
    await page.mouse.move(endCard.x + endCard.width / 2, endCard.y + endCard.height / 2);
    await page.mouse.down();
    await page.mouse.move(dropX, dropY, { steps: 12 });
    await page.mouse.up();

    let after = null;
    for (let i = 0; i < 50; i++) {
      after = await snapshot(solo);
      if (after.groups[0].nodeIds.includes(end.id)) break;
      await sleep(60);
    }
    assert.deepEqual(after.groups[0].nodeIds.slice().sort(), [end.id, agent.id, start.id].sort(),
      "the dropped node joined the group");
    const grown = await page.locator(".sw-group").boundingBox();
    assert.ok(grown.width > frame.width + 100, `the frame grew to wrap it (${frame.width} → ${grown.width})`);
    assert.ok(grown.height >= frame.height, "and still wraps its old members");
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("dropping a node on a folded group adds it and unfolds the frame around it", async () => {
    const solo = path.join(tmpDir, "ws-group-drop-folded");
    fs.mkdirSync(solo, { recursive: true });
    const seeded = await snapshot(solo);
    const start = seeded.nodes.find((n) => n.type === "start");
    const agent = seeded.nodes.find((n) => n.type === "agent");
    const end = seeded.nodes.find((n) => n.type === "end");
    const made = await act("addGroup", { name: "Folded", nodeIds: [start.id, agent.id] }, solo);
    assert.ok(made.res.ok, made.data?.error);
    assert.ok((await act("updateGroup", { id: made.data.groups[0].id, collapsed: true }, solo)).res.ok);

    const { page, context, errors } = await openWorkflow(solo);
    await page.waitForSelector(".sw-group.collapsed");
    const foldedW = (await page.locator(".sw-group").boundingBox()).width;
    const chip = await page.locator(".sw-group-head").boundingBox();
    const endCard = await page.locator(`.sw-node[data-id="${end.id}"] .sw-node-name`).boundingBox();

    await page.mouse.move(endCard.x + endCard.width / 2, endCard.y + endCard.height / 2);
    await page.mouse.down();
    await page.mouse.move(chip.x + chip.width / 2, chip.y + chip.height / 2, { steps: 12 });
    await page.mouse.up();

    let after = null;
    for (let i = 0; i < 50; i++) {
      after = await snapshot(solo);
      if (after.groups[0].nodeIds.includes(end.id)) break;
      await sleep(60);
    }
    assert.deepEqual(after.groups[0].nodeIds.slice().sort(), [end.id, agent.id, start.id].sort());
    assert.equal(after.groups[0].collapsed, false, "the frame unfolds so the new member is visible");
    await page.waitForFunction(() => !document.querySelector(".sw-group.collapsed"));
    assert.equal(await page.locator("#sw-canvas .sw-node").count(), 3);
    const grownW = (await page.locator(".sw-group").boundingBox()).width;
    assert.ok(grownW > foldedW + 100, `the frame resizes around the new member (${foldedW} → ${grownW})`);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("resizes a group frame by its handles and persists the size", async () => {
    const solo = path.join(tmpDir, "ws-group-resize-ui");
    fs.mkdirSync(solo, { recursive: true });
    const seeded = await snapshot(solo);
    const start = seeded.nodes.find((n) => n.type === "start");
    const agent = seeded.nodes.find((n) => n.type === "agent");
    const made = await act("addGroup", { name: "Sized", nodeIds: [start.id, agent.id] }, solo);
    assert.ok(made.res.ok, made.data?.error);
    const groupId = made.data.groups[0].id;

    const { page, context, errors } = await openWorkflow(solo);
    assert.equal(await page.locator(".sw-group-handle").count(), 8, "an expanded frame has eight handles");
    const before = await page.locator(".sw-group").boundingBox();

    // Grow from the south-east corner.
    let handle = await page.locator(".sw-group-handle.sw-gh-se").boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 180, handle.y + handle.height / 2 + 120, { steps: 10 });
    await page.mouse.up();
    let after = null;
    for (let i = 0; i < 50; i++) {
      after = await snapshot(solo);
      const g = after.groups.find((x) => x.id === groupId);
      if (g.w > before.width + 100) break;
      await sleep(60);
    }
    let g = after.groups.find((x) => x.id === groupId);
    assert.ok(g.w > before.width + 100, `the frame grew wider (${before.width} → ${g.w})`);
    assert.ok(g.h > before.height + 60, `and taller (${before.height} → ${g.h})`);
    // The stored size lands before the client repaints; wait for the frame to
    // catch up rather than sampling whichever DOM is up at that instant.
    await page.waitForFunction((w) => {
      const el = document.querySelector(".sw-group");
      return !!el && parseFloat(el.style.width || "0") > w;
    }, before.width + 100);
    const grown = await page.evaluate(() => {
      const el = document.querySelector(".sw-group");
      const r = el.getBoundingClientRect();
      return { width: r.width, height: r.height };
    });
    assert.ok(grown.width > before.width + 100, "the rendered frame follows the stored size");

    // Grow again from the north-west corner: the frame's origin moves too.
    handle = await page.locator(".sw-group-handle.sw-gh-nw").boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 - 50, handle.y + handle.height / 2 - 40, { steps: 8 });
    await page.mouse.up();
    for (let i = 0; i < 50; i++) {
      after = await snapshot(solo);
      const x = after.groups.find((n) => n.id === groupId);
      if (x.x < g.x) { g = x; break; }
      await sleep(60);
    }
    assert.ok(g.x < made.data.groups[0].x, `the west edge moved out (${made.data.groups[0].x} → ${g.x})`);
    assert.ok(g.w > before.width + 200, "and the frame grew with it");

    // A reload keeps the hand-set box.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => {
      const el = document.querySelector(".sw-group");
      return !!el && el.style.width !== "" && parseFloat(el.style.width) > 0;
    });
    const persisted = await snapshot(solo);
    const kept = persisted.groups.find((x) => x.id === groupId);
    assert.equal(kept.w, g.w);
    assert.equal(kept.h, g.h);
    const rebuilt = await page.evaluate(() => {
      const el = document.querySelector(".sw-group");
      return el.getBoundingClientRect().width;
    });
    assert.ok(Math.abs(rebuilt - grown.width - 50) <= 24, `the frame comes back at its manual size (${grown.width} → ${rebuilt})`);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("the group lock button hides its resize handles and is remembered", async () => {
    const solo = path.join(tmpDir, "ws-group-resize-lock");
    fs.mkdirSync(solo, { recursive: true });
    const seeded = await snapshot(solo);
    const start = seeded.nodes.find((n) => n.type === "start");
    const agent = seeded.nodes.find((n) => n.type === "agent");
    const made = await act("addGroup", { name: "Fixed", nodeIds: [start.id, agent.id] }, solo);
    assert.ok(made.res.ok, made.data?.error);
    const groupId = made.data.groups[0].id;
    const before = { x: made.data.groups[0].x, y: made.data.groups[0].y };

    const { page, context, errors } = await openWorkflow(solo);
    const lock = page.locator("[data-group-resizable]");
    assert.equal(await lock.count(), 1, "the group header carries a resize lock");
    assert.equal(await lock.getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator(".sw-group-handle").count(), 8);

    // Locking hides the handles, stores the flag, and leaves the frame put.
    await lock.click();
    await page.waitForFunction(() =>
      document.querySelector("[data-group-resizable]")?.getAttribute("aria-pressed") === "false");
    await page.waitForFunction(() => document.querySelectorAll(".sw-group-handle").length === 0);
    let stored = (await snapshot(solo)).groups.find((g) => g.id === groupId);
    assert.equal(stored.resizable, false);
    assert.deepEqual({ x: stored.x, y: stored.y }, before, "locking does not move the frame");

    // A reload keeps the lock and its hidden handles.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() =>
      document.querySelector("[data-group-resizable]")?.getAttribute("aria-pressed") === "false");
    assert.equal(await page.locator(".sw-group-handle").count(), 0, "a locked frame has no resize handles");

    // The same button unlocks it and brings the handles back.
    await lock.click();
    await page.waitForFunction(() =>
      document.querySelector("[data-group-resizable]")?.getAttribute("aria-pressed") === "true");
    await page.waitForFunction(() => document.querySelectorAll(".sw-group-handle").length === 8);
    stored = (await snapshot(solo)).groups.find((g) => g.id === groupId);
    assert.equal(stored.resizable, true);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("a folded group's chip carries the run's live status and progress", async () => {
    const solo = path.join(tmpDir, "ws-group-status");
    fs.mkdirSync(solo, { recursive: true });
    const g = await buildCustomGraph(solo);
    assert.ok((await act("updateNode", { id: g.start.id, config: { defaultTask: "world" } }, solo)).res.ok);
    const made = await act("addGroup", { name: "Parallel", nodeIds: [g.a2.id, g.a3.id] }, solo);
    assert.ok(made.res.ok, made.data?.error);
    assert.ok((await act("updateGroup", { id: made.data.groups[0].id, collapsed: true }, solo)).res.ok);

    const { page, context, errors } = await openWorkflow(solo);
    await page.waitForSelector(".sw-group.collapsed");
    assert.equal(await page.textContent(".sw-group-status"), "not run", "an unrun folded workflow says so");

    await page.click("#sw-run");
    await page.waitForFunction(() =>
      /✔ 2\/2/.test(document.querySelector(".sw-group-status")?.textContent || ""), null, { timeout: 25_000 });
    const chip = await page.locator(".sw-group-status").evaluate((el) => ({
      text: el.textContent, cls: el.className, title: el.title,
    }));
    assert.equal(chip.text, "✔ 2/2", "the chip shows how many members finished");
    assert.match(chip.cls, /sw-gs-done/);
    assert.match(chip.title, /2\/2 done/);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("pans vertically even when the graph fits the viewport", async () => {
    const solo = path.join(tmpDir, "ws-pan-vertical");
    fs.mkdirSync(solo, { recursive: true });
    await snapshot(solo);
    const { page, context, errors } = await openWorkflow(solo);
    const view = await page.locator(".sw-canvas-scroll").boundingBox();
    const before = await page.$eval(".sw-canvas-scroll", (el) => ({ x: el.scrollLeft, y: el.scrollTop }));

    // Start on empty canvas near the bottom-right (the zoom cluster owns the
    // bottom-left corner), then drag up: the view has to move down even though
    // every node would fit on one screen.
    await page.mouse.move(view.x + view.width - 60, view.y + view.height - 60);
    await page.mouse.down();
    await page.mouse.move(view.x + view.width - 60, view.y + view.height - 260, { steps: 10 });
    await page.mouse.up();
    const after = await page.$eval(".sw-canvas-scroll", (el) => ({ x: el.scrollLeft, y: el.scrollTop }));
    assert.ok(after.y > before.y + 100, `an upward drag pans the view down (${before.y} → ${after.y})`);
    assert.ok(after.x >= before.x, "and does not disturb the horizontal position");
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("pans the canvas by dragging its background, and a click still clears the selection", async () => {
    const solo = path.join(tmpDir, "ws-pan");
    fs.mkdirSync(solo, { recursive: true });
    const s = await snapshot(solo);
    // Park the end node far away, so the canvas is definitely bigger than the
    // viewport and the pan has room to move the scroll position.
    await act("moveNode", { id: s.nodes.find((n) => n.type === "end").id, x: 2400, y: 1400 }, solo);

    const { page, context, errors } = await openWorkflow(solo);
    const scroll = () => page.$eval(".sw-canvas-scroll", (el) => ({ x: el.scrollLeft, y: el.scrollTop }));

    // Select a node first: a pan must not disturb it. The messages sidebar opens
    // with the selection, so measure the canvas after it is shown.
    await page.click(".sw-node.sw-t-agent .sw-node-name");
    await page.waitForFunction(() => !!document.querySelector(".sw-node.sel"));
    const box = await page.locator(".sw-canvas-scroll").boundingBox();

    const before = await scroll();
    await page.mouse.move(box.x + box.width - 60, box.y + box.height - 60);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 260, box.y + box.height - 160, { steps: 10 });
    await page.mouse.up();
    const after = await scroll();
    assert.ok(after.x > before.x + 100, `dragging left scrolls the view right (${before.x} → ${after.x})`);
    assert.ok(after.y > before.y + 50, `dragging up scrolls the view down (${before.y} → ${after.y})`);
    assert.equal(await page.locator(".sw-node.sel").count(), 1, "a pan is not a click — the selection stays");

    // Middle-button drag pans too, even from a node's own card — and it is a view
    // gesture, so it never clears the selection.
    const agentBox = await page.locator(".sw-node.sw-t-agent").boundingBox();
    const midBefore = await scroll();
    await page.mouse.move(agentBox.x + agentBox.width / 2, agentBox.y + agentBox.height / 2);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(agentBox.x + agentBox.width / 2 - 120, agentBox.y + agentBox.height / 2 - 60, { steps: 6 });
    await page.mouse.up({ button: "middle" });
    const midAfter = await scroll();
    assert.ok(midAfter.x > midBefore.x + 60, `a middle-drag over a node pans (${midBefore.x} → ${midAfter.x})`);
    assert.equal(await page.locator(".sw-node.sel").count(), 1, "a middle-drag keeps the selection");

    // A plain click on the background is still a deselect.
    await page.mouse.click(box.x + box.width - 60, box.y + box.height - 60);
    await page.waitForFunction(() => !document.querySelector(".sw-node.sel"));
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("a loop carries repeat and exit ports, and dragging repeat wires a feedback edge", async () => {
    const solo = path.join(tmpDir, "ws-loop-ui");
    fs.mkdirSync(solo, { recursive: true });
    const s = await snapshot(solo);
    const start = s.nodes.find((n) => n.type === "start");
    const agent = s.nodes.find((n) => n.type === "agent");
    const end = s.nodes.find((n) => n.type === "end");
    const loop = (await act("addNode", { type: "loop", x: 40, y: 220 }, solo)).data.nodes.at(-1);
    // Keep the four cards compact and near the top-left, so both the loop's
    // repeat port and the agent's input port are inside the scroller's viewport.
    await act("moveNode", { id: start.id, x: 40, y: 40 }, solo);
    await act("moveNode", { id: agent.id, x: 340, y: 40 }, solo);
    await act("moveNode", { id: end.id, x: 640, y: 40 }, solo);
    for (const e of s.edges) await act("removeEdge", { id: e.id }, solo);
    for (const [from, to] of [[start.id, loop.id], [loop.id, end.id], [start.id, agent.id]]) {
      const r = await act("addEdge", { from, to }, solo);
      assert.ok(r.res.ok, r.data?.error);
    }

    const { page, context, errors } = await openWorkflow(solo);
    const loopNode = `.sw-node[data-id="${loop.id}"]`;
    assert.equal(await page.locator(`${loopNode} .sw-port-out`).count(), 2, "a loop has repeat + exit");
    assert.equal(await page.locator(`${loopNode} .sw-port-repeat`).count(), 1);
    assert.equal(await page.locator(`${loopNode} .sw-port-next`).count(), 1);
    assert.equal(await page.locator(`${loopNode} .sw-port-cap`).count(), 2, "both outputs are named");
    // The layout the loop is drawn with: input and exit share the RIGHT edge
    // (input above), and the repeat output leaves the LEFT edge.
    await page.locator(`${loopNode} .sw-port-repeat`).scrollIntoViewIfNeeded();
    const nodeBox = await page.locator(loopNode).boundingBox();
    const inBox = await page.locator(`${loopNode} .sw-port-in`).boundingBox();
    const repeat = await page.locator(`${loopNode} .sw-port-repeat`).boundingBox();
    const exit = await page.locator(`${loopNode} .sw-port-next`).boundingBox();
    const rightEdge = nodeBox.x + nodeBox.width;
    const mid = (b) => b.x + b.width / 2;
    assert.ok(mid(inBox) > rightEdge - 20, `the input port is on the right edge (${mid(inBox)} vs ${rightEdge})`);
    assert.ok(mid(exit) > rightEdge - 20, "the exit port is on the right edge");
    assert.ok(mid(repeat) < nodeBox.x + 20, `the repeat port is on the left edge (${mid(repeat)} vs ${nodeBox.x})`);
    assert.ok(inBox.y < exit.y, "the input sits above the exit on the shared right edge");
    assert.ok(repeat.y < exit.y, "and the repeat sits above the exit too");

    // Drag repeat → the agent: the connection is stored as a feedback edge…
    await page.locator(`.sw-node[data-id="${agent.id}"] .sw-port-in`).scrollIntoViewIfNeeded();
    const target = await page.locator(`.sw-node[data-id="${agent.id}"] .sw-port-in`).boundingBox();
    await page.mouse.move(repeat.x + repeat.width / 2, repeat.y + repeat.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction((n) => document.querySelectorAll("path.sw-edge").length === n + 1, 3);
    const after = (await snapshot(solo)).edges;
    const fb = after.find((e) => e.from === loop.id && e.to === agent.id);
    assert.ok(fb, `the feedback edge was stored — edges: ${JSON.stringify(after.map((e) => [e.from, e.to, e.port]))}`);
    assert.equal(fb.port, "repeat");
    // …and drawn as the loop's own dashed connection.
    await page.waitForFunction((id) => !!document.querySelector(`path.sw-edge[data-edge="${id}"].sw-edge-repeat`), fb.id);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("picks a file or a folder as a reference from the workspace browser", async () => {
    const s = await snapshot(ws8);
    const agent = s.nodes.find((n) => n.type === "agent");
    const refsOf = async () => (await snapshot(ws8)).nodes.find((n) => n.id === agent.id).config.refs;

    const { page, context, errors } = await openWorkflow(ws8);
    await page.click(`.sw-node[data-id="${agent.id}"] .sw-node-config`);
    await page.waitForSelector("#sw-refs");
    assert.match(await page.textContent("#sw-refs > span"), /Reference files & folders/);
    assert.equal(await page.locator("#sw-ref-picker").count(), 1);
    assert.ok(await page.locator("#sw-ref-picker").isHidden(), "closed until asked for");

    // Browse: the workspace's folders and files, folders first.
    await page.click("#sw-ref-browse");
    await page.waitForSelector("#sw-ref-picker .sw-pick-row");
    const rows = await page.$$eval("#sw-ref-picker .sw-pick-row",
      (els) => els.map((e) => ({ name: e.querySelector(".sw-pick-name").textContent, dir: e.classList.contains("dir") })));
    assert.deepEqual(rows, [{ name: "docs", dir: true }, { name: "src", dir: true }, { name: "notes.txt", dir: false }]);

    // Clicking a file adds it as a reference, at its own path.
    await page.click('#sw-ref-picker [data-pick-nav="docs"] .sw-pick-name');
    await page.waitForFunction(() => document.querySelectorAll("#sw-ref-picker [data-pick-file]").length === 1);
    assert.equal(await page.textContent("#sw-ref-picker .sw-pick-dir"), "docs");
    await page.click('#sw-ref-picker [data-pick-file="docs/design.md"] .sw-pick-name');
    await page.waitForFunction(() => document.querySelectorAll(".sw-ref-row").length === 1);
    assert.deepEqual((await refsOf()).map((r) => r.path), [fs.realpathSync(path.join(ws8, "docs", "design.md"))]);

    // A folder is a reference too: “Use” on the row stores it with its trailing
    // separator, and the panel lists it as the folder it is.
    await page.click("#sw-ref-browse");
    await page.waitForSelector('#sw-ref-picker [data-pick-nav="src"] [data-pick-add]');
    await page.click('#sw-ref-picker [data-pick-nav="src"] [data-pick-add]');
    await page.waitForFunction(() => document.querySelectorAll(".sw-ref-row").length === 2);
    const src = fs.realpathSync(path.join(ws8, "src"));
    assert.deepEqual((await refsOf()).map((r) => r.path), [fs.realpathSync(path.join(ws8, "docs", "design.md")), `${src}/`]);
    assert.equal(await page.$$eval(".sw-ref-icon", (els) => els.map((e) => e.textContent).join("")), "📄📁");
    assert.equal(await page.textContent(".sw-ref-row:last-child .sw-ref-path"), "src/", "listed relative to the workspace, as a folder");

    // “Use this folder” at the root takes the whole workspace.
    await page.click("#sw-ref-browse");
    await page.waitForSelector("#sw-ref-picker .sw-pick-bar");
    await page.click('#sw-ref-picker .sw-pick-bar [data-pick-add]');
    await page.waitForFunction(() => document.querySelectorAll(".sw-ref-row").length === 3);
    assert.equal((await refsOf())[2].path, `${fs.realpathSync(ws8)}/`);

    // Navigating up stays inside the workspace: the root has no way up.
    await page.click("#sw-ref-browse");
    await page.waitForSelector("#sw-ref-picker .sw-pick-bar");
    assert.equal(await page.$eval("#sw-ref-picker .sw-pick-btn", (el) => el.disabled), true);
    assert.equal(await page.textContent("#sw-ref-picker .sw-pick-dir"), "workspace root");
    await page.click("#sw-ref-picker [data-pick-close]");
    assert.ok(await page.locator("#sw-ref-picker").isHidden(), "the ✕ hides the browser");
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("shows a node's output beside its message, with the references under it", async () => {
    const solo = path.join(tmpDir, "ws-node-output");
    fs.mkdirSync(solo, { recursive: true });
    const s = await snapshot(solo);
    const agent = s.nodes.find((n) => n.type === "agent");
    assert.ok((await act("updateNode", { id: agent.id, name: "writer", config: {
      harness: "custom", command: "printf 'written by the node\\n'", prompt: "{task}",
    } }, solo)).res.ok);

    const started = await runApi("start", { task: "output check" }, solo);
    assert.ok(started.res.ok, started.data?.error);
    const run = await waitRun(solo);
    assert.equal(run.status, "done", JSON.stringify(run.log));

    const { page, context, errors } = await openWorkflow(solo);
    await page.click(`.sw-node[data-id="${agent.id}"] .sw-node-config`);
    await page.waitForSelector("#sw-node-out");

    // The node's own result is in the panel, under an Output heading — the
    // message that produced it is the field beside it.
    assert.equal(await page.textContent(".sw-fld-out .sw-out-title"), "Output");
    assert.match(await page.textContent("#sw-node-out"), /written by the node/);

    // And the layout: references under the message on the left, output on the
    // right, starting where the fields do.
    const boxes = await page.evaluate(() => {
      const r = (sel) => document.querySelector(sel).getBoundingClientRect();
      const body = r(".sw-dlg-body");
      const prompt = r(".sw-fld-prompt"), refs = r(".sw-fld-refs"), out = r(".sw-fld-out");
      const bcs = getComputedStyle(document.querySelector(".sw-dlg-body"));
      const row = document.querySelector(".sw-dlg-actions").getBoundingClientRect();
      const rcs = getComputedStyle(document.querySelector(".sw-dlg-actions"));
      return {
        contentRight: Math.round(body.right - parseFloat(bcs.paddingRight)),
        promptLeft: Math.round(prompt.left), promptBottom: Math.round(prompt.bottom),
        refsLeft: Math.round(refs.left), refsTop: Math.round(refs.top),
        outLeft: Math.round(out.left), outRight: Math.round(out.right),
        actionsRight: Math.round(row.right - parseFloat(rcs.paddingRight)),
        saveLeft: Math.round(r("#sw-save").left), saveRight: Math.round(r("#sw-save").right),
        dupLeft: Math.round(r("#sw-duplicate").left), delLeft: Math.round(r("#sw-delete").left),
      };
    });
    assert.ok(boxes.refsTop >= boxes.promptBottom - 1, "the references sit under the message");
    assert.equal(boxes.refsLeft, boxes.promptLeft, "in the same left column");
    assert.ok(boxes.outLeft > boxes.refsLeft, "the output is the right-hand column");
    assert.equal(boxes.outRight, boxes.contentRight, "ending on the panel's content edge");

    // The node's own actions sit together in the bottom-right corner, read
    // Delete → Duplicate → Save node; the head's ✕ is the only close control.
    assert.equal(boxes.saveRight, boxes.actionsRight, "the actions end on the bottom-right edge");
    assert.ok(boxes.delLeft < boxes.dupLeft && boxes.dupLeft < boxes.saveLeft,
      "in Delete → Duplicate → Save node order");
    assert.equal(await page.locator("#sw-ok").count(), 0, "no OK button");
    assert.equal(await page.locator(".sw-dlg-actions #sw-close").count(), 0, "and no Close button in the actions row");

    // Save still writes the panel's fields.
    await page.fill("#sw-f-prompt", "saved {task}");
    await page.click("#sw-save");
    await page.waitForTimeout(400);
    assert.equal((await snapshot(solo)).nodes.find((n) => n.id === agent.id).config.prompt, "saved {task}",
      "Save node writes the field");

    assert.deepEqual(errors, []);
    await context.close();
  });

  test("each start node's triggers live in its own settings, saved per entry point", async () => {
    const solo = path.join(tmpDir, "ws-trigger-ui");
    fs.mkdirSync(solo, { recursive: true });
    const seeded = await snapshot(solo);
    const firstStart = seeded.nodes.find((n) => n.type === "start");
    const secondStart = (await act("addNode", { type: "start", x: 120, y: 460 }, solo)).data.nodes.at(-1);
    assert.equal(secondStart.type, "start", "a canvas accepts more than one start node");

    const { page, context, errors } = await openWorkflow(solo);
    // There is no workflow-level trigger popup any more.
    assert.equal(await page.locator("#sw-triggers").count(), 0, "the toolbar no longer carries triggers");
    await page.click(`.sw-node[data-id="${firstStart.id}"] .sw-node-config`);
    await page.waitForSelector("#sw-tr-mode");
    assert.equal(await page.locator("#sw-tr-task").count(), 0, "the start node's message is the task");
    assert.equal(await page.locator("#sw-tr-save").count(), 0, "Save node saves the whole start node");
    assert.doesNotMatch(await page.textContent("#sw-status"), /trigger armed/);
    // Its checkbox line keeps the trigger form's row layout.
    const box = await page.evaluate(() => {
      const el = document.querySelector(".sw-triggers .sw-check");
      const cs = getComputedStyle(el);
      return { display: cs.display, gap: cs.gap, align: cs.alignItems, box: Math.round(el.getBoundingClientRect().height) };
    });
    assert.match(box.display, /^(inline-)?flex$/, "the trigger checkbox keeps its row layout");
    assert.equal(box.gap, "6px", "with the box beside its text, not stacked on it");
    assert.equal(box.align, "center");
    assert.ok(box.box >= 16, `and a real hit area (${box.box}px)`);

    await page.selectOption("#sw-tr-mode", "interval");
    await page.fill("#sw-tr-every", "3600");
    await page.click("#sw-save");
    await page.waitForFunction(() => /trigger armed/.test(document.querySelector("#sw-status")?.textContent || ""));
    const savedFirst = (await snapshot(solo)).nodes.find((n) => n.id === firstStart.id).config.triggers;
    assert.equal(savedFirst.schedule.mode, "interval");
    assert.equal(savedFirst.schedule.everySeconds, 3600);
    // The other entry point was not touched by saving this one.
    assert.equal((await snapshot(solo)).nodes.find((n) => n.id === secondStart.id).config.triggers.schedule.mode, "off");

    // Saving never fires immediately, so no run exists yet.
    assert.equal(await liveRun(solo), null);

    // The second start's own popup reads its own (unarmed) triggers.
    await page.click("#sw-close-x");
    await page.click(`.sw-node[data-id="${secondStart.id}"] .sw-node-config`);
    await page.waitForSelector("#sw-tr-mode");
    assert.equal(await page.inputValue("#sw-tr-mode"), "off");

    // Turning the first start off disarms the canvas' only trigger.
    await page.click("#sw-close-x");
    await page.click(`.sw-node[data-id="${firstStart.id}"] .sw-node-config`);
    await page.selectOption("#sw-tr-mode", "off");
    await page.click("#sw-save");
    await page.waitForFunction(() => !/trigger armed/.test(document.querySelector("#sw-status")?.textContent || ""));
    assert.equal((await api(`/${PLUGIN}/triggers?cwd=${enc(solo)}&nodeId=${enc(firstStart.id)}`)).data.triggers.armed, false);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("a node's Model dropdown asks its provider's CLI for the list", async () => {
    const solo = path.join(tmpDir, "ws-cli-models-ui");
    fs.mkdirSync(solo, { recursive: true });
    const s = await snapshot(solo);
    const agent = s.nodes.find((n) => n.type === "agent");
    assert.ok((await act("updateNode", { id: agent.id, name: "picker", config: {
      harness: "opencode", model: "", prompt: "{input}",
    } }, solo)).res.ok);

    const { page, context, errors } = await openWorkflow(solo);
    await page.click(`.sw-node[data-id="${agent.id}"] .sw-node-config`);
    await page.waitForSelector("#sw-f-harness");
    // The curated list is there at once; the provider's own catalogue arrives a
    // round trip later and is folded into the same dropdown.
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll("#sw-f-model option")).some((o) => o.value === "local/qwen3"),
      null, { timeout: 15_000 });
    const values = await page.$$eval("#sw-f-model option", (o) => o.map((x) => x.value));
    for (const id of ["zen/deepseek-v4.1-flash", "zen/gpt-5", "local/qwen3"]) {
      assert.ok(values.includes(id), `${id} was offered (${values.slice(0, 6).join(", ")}…)`);
    }
    assert.ok(values.includes("__custom__"), "and a way to name a model of one's own");
    // Grouped by provider: the provider half is part of what opencode is handed.
    assert.ok((await page.$$eval("#sw-f-model optgroup", (o) => o.map((x) => x.label))).includes("local"));
    assert.match(await page.textContent("#sw-model-wrap .sw-hint"), /opencode models/,
      "the field says where the list came from");

    // A model of one's own stays with this node — it is not added to the shared
    // provider list, which is what makes trying a new id cheap.
    await page.selectOption("#sw-f-model", "__custom__");
    await page.fill("#sw-f-model-custom", "local/muse-glimmer-30b");
    await page.click("#sw-save");
    await page.waitForTimeout(400);
    assert.equal((await snapshot(solo)).nodes.find((n) => n.id === agent.id).config.model, "local/muse-glimmer-30b");
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("the ↻ reload re-reads the graph and re-wires every connection", async () => {
    const solo = path.join(tmpDir, "ws-reload-ui");
    fs.mkdirSync(solo, { recursive: true });
    const g = await buildFeedbackGraph(solo, { count: 2 });
    const { page, context, errors } = await openWorkflow(solo);

    // The loop's feedback edge is drawn from its Repeat (left) port, dashed.
    const fb = (await snapshot(solo)).edges.find((e) => e.from === g.loop.id && e.to === g.step.id);
    assert.equal(fb?.port, "repeat");
    assert.equal(await page.locator(`#subagent-workflow-pane path.sw-edge[data-edge="${fb.id}"].sw-edge-repeat`).count(), 1);

    // The graph changed elsewhere: one connection dropped, another drawn, and
    // the step wired to the loop moved. Reload must redraw all of it.
    const s0 = await snapshot(solo);
    const dropped = s0.edges.find((e) => e.from === g.loop.id && e.to === g.end.id);
    assert.ok((await act("removeEdge", { id: dropped.id }, solo)).res.ok);
    const added = await act("addEdge", { from: g.start.id, to: g.step.id }, solo);
    assert.ok(added.res.ok, added.data?.error);
    assert.ok((await act("moveNode", { id: g.step.id, x: 1100, y: 700 }, solo)).res.ok);

    await page.click("#sw-refresh");
    const want = await snapshot(solo);
    await page.waitForFunction((n) =>
      document.querySelectorAll("#subagent-workflow-pane path.sw-edge").length === n, want.edges.length);
    // The moved node is re-placed…
    await page.waitForFunction((id) =>
      document.querySelector(`.sw-node[data-id="${id}"]`)?.style.left === "1100px", g.step.id, { timeout: 5000 });
    // …the SVG matches the reloaded graph exactly…
    const ids = await page.$$eval("#subagent-workflow-pane path.sw-edge", (els) => els.map((e) => e.dataset.edge));
    assert.equal(ids.length, want.edges.length, "every connection is drawn exactly once");
    assert.ok(!ids.includes(dropped.id), "the dropped connection is gone");
    const newEdge = want.edges.find((e) => e.from === g.start.id && e.to === g.step.id);
    assert.ok(ids.includes(newEdge.id), "the new connection is drawn");
    // …and the repeat edge follows the step it re-runs.
    const d = await page.$eval(`#subagent-workflow-pane path.sw-edge[data-edge="${fb.id}"]`, (p) => p.getAttribute("d"));
    assert.match(d, /1100/, `the feedback edge re-routed to the moved step (${d})`);
    assert.deepEqual(errors, []);
    await context.close();
  });
});
