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
//   • the canvas, the harness inspector and a run started from the UI.
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
let ws5;   // node sidebar (models + access toggles)
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
  for (const d of [ws, ws2, ws3, ws4, ws5]) fs.mkdirSync(d, { recursive: true });

  // One skill and one extension in the agent dir, so the node sidebar has real
  // catalogue entries to toggle (the skill is a plain directory, the extension
  // is a settings.json entry like the Settings page writes).
  fs.mkdirSync(path.join(agentDir, "skills", "demo-skill"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "skills", "demo-skill", "SKILL.md"),
    "---\nname: demo-skill\ndescription: toggled by the workflow tests\n---\nDo the demo.\n");
  fs.mkdirSync(path.join(agentDir, "extensions", "demo-ext"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "extensions", "demo-ext", "index.ts"), "export {};\n");
  fs.writeFileSync(path.join(agentDir, "settings.json"),
    JSON.stringify({ extensions: ["+extensions/demo-ext/index.ts"] }, null, 2));

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
    assert.deepEqual(by.pi.models, [], "Pi's list comes from the app's own catalogue");

    // A harness with no such flag says so, so the sidebar can mark the rows.
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
    assert.equal((await act("addEdge", { from: start.id, to: a2.id })).res.status, 409, "single root");
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
    const radius = await page.locator(".sw-node").first().evaluate((el) => getComputedStyle(el).borderRadius);
    assert.notEqual(radius, "0px");
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("configures a node's harness in the inspector and saves it", async () => {
    const { page, context, errors } = await openWorkflow(ws);
    const s = await snapshot(ws);
    const agent = s.nodes.find((n) => n.type === "agent");
    await page.click(`.sw-node[data-id="${agent.id}"] .sw-node-name`);
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
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("offers the harness's models and the machine's skills/tools/extensions in the node sidebar", async () => {
    const s = await snapshot(ws5);
    const agent = s.nodes.find((n) => n.type === "agent");
    // Start from a node with nothing selected, so the toggles below are the only
    // thing the saved config can reflect.
    assert.ok((await act("updateNode", { id: agent.id, config: { harness: "claude", skills: [], tools: [], extensions: [] } }, ws5)).res.ok);

    const { page, context, errors } = await openWorkflow(ws5);
    await page.click(`.sw-node[data-id="${agent.id}"] .sw-node-name`);
    await page.waitForSelector("#sw-f-harness");

    // Pi's dropdown is exactly the app's own model catalogue.
    await page.selectOption("#sw-f-harness", "pi");
    const models = (await api("/models")).data.models;
    assert.deepEqual(
      await page.$$eval("#sw-f-model option", (o) => o.map((x) => x.value)),
      ["", ...models, "__custom__"],
      "Pi's models come from GET /models, plus a Custom… entry",
    );

    // Switching harness swaps in that harness's list without touching the rest
    // of the form.
    await page.selectOption("#sw-f-harness", "claude");
    assert.deepEqual(
      await page.$$eval("#sw-f-model option", (o) => o.map((x) => x.value)),
      ["", "sonnet", "opus", "haiku", "claude-sonnet-4-5", "claude-opus-4-1", "__custom__"],
    );

    // The machine's own skill and extension are listed. Claude Code has no skill
    // or extension flag, so those rows are disabled and say why; its tools row
    // is live and names the flag it will use.
    assert.equal(await page.locator('[data-cap="skills"][value="demo-skill"]').count(), 1);
    assert.ok(await page.locator('[data-cap="skills"][value="demo-skill"]').isDisabled());
    assert.equal(await page.locator('[data-cap="extensions"][value="extensions/demo-ext/index.ts"]').count(), 1);
    assert.ok(await page.locator('[data-cap="extensions"][value="extensions/demo-ext/index.ts"]').isDisabled());
    assert.ok(await page.locator('[data-cap="tools"][value="bash"]').isEnabled());
    const heads = await page.$$eval(".sw-caps-head", (els) => els.map((e) => e.textContent || ""));
    assert.match(heads.find((h) => h.startsWith("Tools")), /--allowedTools/);
    assert.match(heads.find((h) => h.startsWith("Skills")), /no flag/);

    // On the app's own runner the same rows are live; toggling them saves.
    await page.selectOption("#sw-f-harness", "pi");
    await page.check('[data-cap="tools"][value="bash"]');
    await page.check('[data-cap="skills"][value="demo-skill"]');
    await page.check('[data-cap="extensions"][value="extensions/demo-ext/index.ts"]');
    await page.click("#sw-save");
    await page.waitForFunction((id) =>
      document.querySelector(`.sw-node[data-id="${id}"]`)?.dataset.id === id, agent.id);
    const saved = (await snapshot(ws5)).nodes.find((n) => n.id === agent.id).config;
    assert.equal(saved.harness, "pi");
    assert.deepEqual(saved.tools, ["bash"]);
    assert.deepEqual(saved.skills, ["demo-skill"]);
    assert.deepEqual(saved.extensions, ["extensions/demo-ext/index.ts"]);
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
});
