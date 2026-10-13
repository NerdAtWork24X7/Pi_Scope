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
let stubDir;    // fake `claude` / `gemini` binaries, prepended to PATH
let claudeLog;  // argv the fake claude was invoked with
let geminiLog;  // argv the fake gemini was invoked with

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
    harness: "custom", command: `printf 'A1[%s]' "$SW_PROMPT"`, prompt: "{task}",
  } }, w);
  assert.ok(upd.res.ok, upd.data?.error);

  const a2 = (await act("addNode", { type: "agent", x: 420, y: 460 }, w)).data.nodes.at(-1);
  const a3 = (await act("addNode", { type: "agent", x: 420, y: 620 }, w)).data.nodes.at(-1);
  for (const [node, label] of [[a2, "A2"], [a3, "A3"]]) {
    const u = await act("updateNode", { id: node.id, name: label.toLowerCase(), config: {
      harness: "custom", command: `printf '${label}[%s]' "$SW_PROMPT"`, prompt: "{input}",
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
    harness: "custom", command: `printf 'A1[%s]' "$SW_PROMPT"`, prompt: "{task}",
  } }, w)).res.ok);

  const gate = (await act("addNode", { type: "approval", x: 420, y: 200 }, w)).data.nodes.at(-1);
  assert.ok((await act("updateNode", { id: gate.id, name: "review", config: {
    description: "Plan review", message: "Please review: {input}",
  } }, w)).res.ok);
  const last = (await act("addNode", { type: "agent", x: 620, y: 200 }, w)).data.nodes.at(-1);
  assert.ok((await act("updateNode", { id: last.id, name: "last", config: {
    harness: "custom", command: `printf 'L[%s]' "$SW_PROMPT"`, prompt: "{input}",
  } }, w)).res.ok);

  for (const e of s.edges) await act("removeEdge", { id: e.id }, w);
  for (const [from, to] of [[start.id, first.id], [first.id, gate.id], [gate.id, last.id], [last.id, end.id]]) {
    const r = await act("addEdge", { from, to }, w);
    assert.ok(r.res.ok, r.data?.error);
  }
  return { start, first, gate, last, end };
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
    // Both paths are injected, each with a description: the user's note, or the
    // file's own first heading when they wrote none.
    assert.ok(prompt.startsWith("[Reference files — added by the user for this step]"), prompt.slice(0, 200));
    assert.ok(prompt.includes(`${rules} — house rules`), prompt.slice(0, 400));
    assert.ok(prompt.includes(`${plan} — The plan`), prompt.slice(0, 400));
    assert.match(prompt, /not instructions/);
    // …ahead of the user's own message, which still ends the text sent.
    assert.match(prompt.trimEnd(), /review the API$/);
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
    assert.equal((await act("addNode", { type: "start" })).res.status, 409);

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
    const a = await mk("a", 340, 180, "sleep 0.6; printf 'A[%s]' \"$SW_PROMPT\"", "{task}");
    const b = await mk("b", 340, 420, "sleep 0.6; printf 'B[%s]' \"$SW_PROMPT\"", "{task}");
    const c = await mk("c", 640, 300, "printf 'C[%s]' \"$SW_PROMPT\"", "{input}");
    const d = await mk("d", 880, 300, "printf 'D[%s]' \"$SW_PROMPT\"", "{input}");

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
      'if [ $c -lt 3 ]; then echo "boom $c" >&2; exit 1; fi; printf "OK[%s]" "$SW_PROMPT"';
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
        canvas: Math.round(document.querySelector(".sw-canvas-scroll").getBoundingClientRect().width),
      };
    });
    assert.equal(geom.position, "fixed", "the popup floats over the pane, it is not a column in it");
    assert.ok(geom.z >= 1000, `it sits above the canvas (z=${geom.z})`);
    assert.notEqual(geom.scrim, "rgba(0, 0, 0, 0)", "with a scrim over the canvas");
    // Full screen: a node's references, the whole model catalogue and the end
    // node's final output all need the room, so the popup takes the viewport.
    assert.ok(geom.w >= geom.vw - 20, `full screen, scrollbars aside (${geom.w} of ${geom.vw})`);
    assert.ok(geom.h >= geom.vh - 20, `in both directions (${geom.h} of ${geom.vh})`);
    assert.ok(geom.canvas > 0, `the canvas stays behind it (${geom.canvas}px)`);

    // Escape closes it, leaving the node's settings exactly as they were.
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("#sw-modal .sw-dlg-body"));
    assert.equal(await page.locator("#sw-modal-backdrop:visible").count(), 0);
    assert.deepEqual(await configOf(), agent.config, "closing is not saving");

    // The ✕ in the head closes it too, and so does the actions row's Close.
    await page.click(`.sw-node[data-id="${agent.id}"] .sw-node-config`);
    await page.waitForSelector("#sw-f-harness");
    await page.click("#sw-close-x");
    await page.waitForFunction(() => !document.querySelector("#sw-modal .sw-dlg-body"));

    await page.click(`.sw-node[data-id="${agent.id}"] .sw-node-config`);
    await page.waitForSelector("#sw-f-harness");
    await page.click("#sw-close");
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
    await page.click("#sw-close");
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

  test("runs the workflow from the UI and shows live node status and log", async () => {
    await buildCustomGraph(ws3);
    const { page, context, errors } = await openWorkflow(ws3);
    await page.fill("#sw-task", "world");
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
    await page.waitForSelector("#sw-final-body .sw-final-pre");
    const final = await page.textContent("#sw-final-body .sw-final-pre");
    assert.match(final, /A2\[A1\[world\]\]/);
    assert.match(final, /A3\[A1\[world\]\]/);
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

  test("pauses on an approval gate and resumes when the banner approves it", async () => {
    const solo = path.join(tmpDir, "ws-approve-ui");
    fs.mkdirSync(solo, { recursive: true });
    const g = await buildApprovalGraph(solo);

    const { page, context, errors } = await openWorkflow(solo);
    // The gate is on the canvas with its own mark and no provider icon.
    assert.equal(await page.locator(`.sw-node.sw-t-approval[data-id="${g.gate.id}"] .sw-node-glyph`).count(), 1);
    assert.equal(await page.locator(`.sw-node[data-id="${g.gate.id}"] .sw-hicon`).count(), 0);

    await page.fill("#sw-task", "hello");
    await page.click("#sw-run");
    await page.waitForSelector(".sw-approvals.show .sw-approval");
    assert.match(await page.textContent(".sw-approval-msg"), /Please review: A1\[hello\]/);
    assert.match(await page.textContent("#sw-run-status"), /waiting for approval/);
    assert.equal(await page.locator(".sw-approvals .sw-approval").count(), 1);
    // The canvas badges the waiting gate and leaves the downstream node alone.
    await page.waitForSelector(`.sw-node[data-id="${g.gate.id}"].sw-run-waiting`);
    assert.equal(await page.locator(`.sw-node[data-id="${g.last.id}"].sw-run-done`).count(), 0);

    await page.fill(".sw-approval-note", "ship it");
    await page.click(".sw-approval [data-approve]");
    await page.waitForFunction((id) =>
      document.querySelector(`.sw-node[data-id="${id}"]`)?.classList.contains("sw-run-done"), g.last.id, { timeout: 20_000 });
    assert.equal(await page.locator(".sw-approvals.show").count(), 0, "the banner clears once decided");
    assert.match(await page.textContent("#sw-run-log"), /review approved/);
    const finished = await waitRun(solo);
    assert.equal(finished.status, "done");
    assert.deepEqual(errors, []);
    await context.close();
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
    await page.waitForSelector("#sw-final-body .sw-final-pre");
    assert.match(await page.textContent("#sw-final-body .sw-final-pre"), /A3\[A1\[first\]\]/);

    // …and back to the live view.
    await page.selectOption("#sw-history", "");
    await page.waitForFunction(() => /A1\[second\]/.test(document.querySelector("#sw-run-log")?.textContent || ""));
    assert.doesNotMatch(await page.textContent("#sw-run-status"), /past run/);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("the messages sidebar lists every agent, and one agent once its card is clicked", async () => {
    const solo = path.join(tmpDir, "ws-msgs-ui");
    fs.mkdirSync(solo, { recursive: true });
    const g = await buildCustomGraph(solo);
    const { page, context, errors } = await openWorkflow(solo);

    // With nothing in focus every node that carries messages is listed, each in
    // a section of its own.
    const sections = await page.$$eval("#sw-msg-body .sw-msg-section[data-node]",
      (els) => els.map((e) => e.dataset.node));
    assert.deepEqual(sections.slice().sort(), [g.first.id, g.a2.id, g.a3.id, g.end.id].sort());
    assert.match(await page.textContent("#sw-msg-sub"), /3 agents/);

    await page.fill("#sw-task", "world");
    await page.click("#sw-run");
    await page.waitForFunction(() =>
      document.querySelectorAll(".sw-node.sw-run-done").length >= 4, null, { timeout: 25_000 });
    const body = await page.textContent("#sw-msg-body");
    assert.match(body, /A1\[world\]/, "the first agent's own words");
    assert.match(body, /A2\[A1\[world\]\]/);
    assert.match(body, /A3\[A1\[world\]\]/);

    // Clicking an agent's card focuses its messages — its own, and only its own.
    await page.click(`.sw-node[data-id="${g.a2.id}"] .sw-node-name`);
    await page.waitForFunction(() => document.querySelector("#sw-msg-title")?.textContent === "a2");
    assert.equal(await page.locator("#sw-msg-body .sw-msg-section[data-node]").count(), 1, "one agent in focus");
    const focused = await page.textContent("#sw-msg-body");
    assert.match(focused, /A2\[A1\[world\]\]/);
    assert.doesNotMatch(focused, /A3\[A1\[world\]\]/, "another agent's messages are not in this view");
    // It reads as a conversation: what the node was handed, then what it said.
    assert.match(await page.textContent(".sw-msg-sent pre"), /\{input\}/);

    // “All agents” puts every section back, and a section in the sidebar is a
    // way to focus that agent too.
    await page.click("#sw-msg-all");
    await page.waitForFunction((n) =>
      document.querySelectorAll("#sw-msg-body .sw-msg-section[data-node]").length === n, 4);
    assert.match(await page.textContent("#sw-msg-body"), /A2\[A1\[world\]\]/);
    await page.click(`#sw-msg-body .sw-msg-section[data-node="${g.a3.id}"] .sw-msg-sec-name`);
    await page.waitForFunction(() => document.querySelector("#sw-msg-title")?.textContent === "a3");
    assert.match(await page.textContent("#sw-msg-body"), /A3\[A1\[world\]\]/);
    assert.doesNotMatch(await page.textContent("#sw-msg-body"), /A2\[A1\[world\]\]/,
      "and it replaces the all-agents view");

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

    // The sidebar can be folded away, and says so in the headers.
    await page.click("#sw-msg-toggle");
    assert.equal(await page.locator("#sw-msg-side:visible").count(), 0);
    await page.click("#sw-msg-toggle");
    assert.equal(await page.locator("#sw-msg-side:visible").count(), 1);
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

    const { page, context, errors } = await openWorkflow(solo);
    await page.fill("#sw-task", "hello");
    await page.click("#sw-run");
    // The gate's card carries the same request as the banner, in the sidebar.
    await page.waitForSelector(".sw-msg-gate.waiting");
    assert.match(await page.textContent(".sw-msg-gate .sw-msg-gate-msg"), /Please review: A1\[hello\]/);
    assert.equal(await page.locator(".sw-msg-gate [data-approve]").count(), 1);
    assert.equal(await page.locator(".sw-msg-gate [data-reject]").count(), 1);
    // Clicking the card focuses the gate: what it received, per input agent.
    await page.click(`#sw-msg-body .sw-msg-section[data-node="${g.gate.id}"] .sw-msg-gate-name`);
    await page.waitForFunction(() => document.querySelector("#sw-msg-title")?.textContent === "review");
    const inputs = await page.$$eval("#sw-msg-body .sw-msg-input", (els) => els.map((e) => e.dataset.input));
    assert.deepEqual(inputs, [g.first.id], "the agent feeding the gate");
    assert.match(await page.textContent(`#sw-msg-body .sw-msg-input[data-input="${g.first.id}"] pre`), /A1\[hello\]/);

    // Approving from here decides the run, exactly like the banner.
    await page.fill(".sw-msg-gate .sw-msg-note", "ship it");
    await page.click(".sw-msg-gate [data-approve]");
    await page.waitForFunction((id) =>
      document.querySelector(`.sw-node[data-id="${id}"]`)?.classList.contains("sw-run-done"), g.last.id, { timeout: 20_000 });
    assert.equal(await page.locator(".sw-approvals.show").count(), 0, "the banner clears once decided");
    assert.match(await page.textContent("#sw-run-log"), /review approved/);
    // The sidebar shows the decision too, now that the gate is settled.
    await page.waitForFunction(() => /approved/.test(document.querySelector(".sw-msg-gate")?.textContent || ""));
    assert.equal((await waitRun(solo)).status, "done");
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

  test("arms and disarms a trigger from the toolbar's triggers popup", async () => {
    const solo = path.join(tmpDir, "ws-trigger-ui");
    fs.mkdirSync(solo, { recursive: true });
    await snapshot(solo);

    const { page, context, errors } = await openWorkflow(solo);
    // The workflow-level form is the third thing the settings popup carries,
    // opened from ⏱ in the toolbar (a node's gear is the other way in).
    assert.equal(await page.locator("#sw-tr-save").count(), 0, "closed until asked for");
    await page.click("#sw-triggers");
    await page.waitForSelector("#sw-tr-save");
    assert.doesNotMatch(await page.textContent("#sw-status"), /trigger armed/);
    // Its checkbox line is still laid out on its own row: the node panel dropped
    // its bypass switch, and this form shares the same class.
    const box = await page.evaluate(() => {
      const el = document.querySelector(".sw-triggers .sw-check");
      const cs = getComputedStyle(el);
      return { display: cs.display, gap: cs.gap, align: cs.alignItems, box: Math.round(el.getBoundingClientRect().height) };
    });
    // The rule is `inline-flex`, which blockifies to `flex` as an item of the
    // trigger column — so assert the row itself, not the keyword.
    assert.match(box.display, /^(inline-)?flex$/, "the trigger checkbox keeps its row layout");
    assert.equal(box.gap, "6px", "with the box beside its text, not stacked on it");
    assert.equal(box.align, "center");
    assert.ok(box.box >= 16, `and a real hit area (${box.box}px)`);

    await page.selectOption("#sw-tr-mode", "interval");
    await page.fill("#sw-tr-every", "3600");
    await page.fill("#sw-tr-task", "from the ui");
    await page.click("#sw-tr-save");
    await page.waitForFunction(() => /trigger armed/.test(document.querySelector("#sw-status")?.textContent || ""));
    const saved = (await api(`/${PLUGIN}/triggers?cwd=${enc(solo)}`)).data.triggers;
    assert.equal(saved.schedule.mode, "interval");
    assert.equal(saved.schedule.everySeconds, 3600);
    assert.equal(saved.task, "from the ui");

    // Saving never fires immediately, so no run exists yet.
    assert.equal(await liveRun(solo), null);

    await page.selectOption("#sw-tr-mode", "off");
    await page.click("#sw-tr-save");
    await page.waitForFunction(() => !/trigger armed/.test(document.querySelector("#sw-status")?.textContent || ""));
    assert.equal((await api(`/${PLUGIN}/triggers?cwd=${enc(solo)}`)).data.triggers.armed, false);
    assert.deepEqual(errors, []);
    await context.close();
  });
});
