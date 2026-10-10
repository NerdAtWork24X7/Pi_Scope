// End-to-end tests for the Office view's own state, against the REAL server:
// the office's name, the Kanban task queue (Todo → Planned → In Progress →
// Done), and the queue runner switch. These are the writes behind the floor's
// wall title and its meeting-room board.
//
// The Office is a standalone plugin, so this suite is also the contract for
// that: the state is served by the plugin's own `/office` routes, kept in the
// plugin's own store (`<plugins dir>/.data/office.json`, not the workspace's
// agent-team-config.json), refused with a 403 when the plugin is disabled, and
// seeded once from the old location so an existing board survives the move.
//
//   node --test apps/scope-server/test/office-board.e2e.test.mjs

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const SERVER = path.join(ROOT, "apps", "scope-server", "server.ts");
const TOKEN = "office-board-token";

let child;
let base;
let ws;
let agentDir;
let pluginsDir;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
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

const post = (body, cwd = ws) => api("/office", { method: "POST", body: JSON.stringify({ ...body, cwd }) });
const snapshot = async (cwd = ws) => (await api(`/office?cwd=${encodeURIComponent(cwd)}`)).data;
/** The plugin's own store, as the host persists it (api.store → .data/<id>.json). */
const storePath = () => path.join(pluginsDir, ".data", "office.json");
const readStore = () => JSON.parse(fs.readFileSync(storePath(), "utf8"));
/** The state the plugin kept for one workspace. */
const stored = (cwd = ws) => readStore().workspaces[fs.realpathSync(cwd)];
const task = async (id, cwd = ws) => (await snapshot(cwd)).tasks.find((t) => t.id === id);
/** The old, pre-plugin home of this state (used only to prove the migration). */
const legacyConfigPath = (cwd) => path.join(cwd, ".pi", "settings", "agent-team-config.json");

before(async () => {
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-office-board-")));
  agentDir = path.join(ws, "agent");
  pluginsDir = path.join(ws, "plugins");
  fs.mkdirSync(agentDir, { recursive: true });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      SCOPE_PORT: String(port),
      SCOPE_HOST: "127.0.0.1",
      SCOPE_DB_PATH: path.join(ws, "scope.db"),
      SCOPE_AUTH_TOKEN: TOKEN,
      SCOPE_PLUGINS_DIR: pluginsDir,
      SCOPE_FILE_ROOT: ws,
      SCOPE_AGENT_DIR: agentDir,
      SCOPE_PI_BIN: "/bin/true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  await waitForHealth();
});

after(async () => {
  if (child) {
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
  }
  if (ws) fs.rmSync(ws, { recursive: true, force: true });
});

describe("the office plugin's own state", () => {
  test("is served by the plugin, not by the shared agent-team config", async () => {
    // The roster route the office used to ride on must not carry this state any
    // more — the plugin owns it, so there is exactly one source of truth.
    const team = (await api(`/agent-team?cwd=${encodeURIComponent(ws)}`)).data;
    for (const key of ["officeName", "tasks", "runnerPaused"]) {
      assert.equal(key in team, false, `/agent-team no longer reports ${key}`);
    }
    assert.deepEqual(await snapshot(), { tasks: [], runnerPaused: true }, "an untouched office starts empty and paused");

    // And the state lands in the plugin's own store, beside the plugins dir.
    await post({ action: "setRunnerPaused", paused: false });
    assert.equal(stored().runnerPaused, false, "the plugin store holds the runner switch");
    assert.equal(fs.existsSync(legacyConfigPath(ws)), false, "nothing is written back to the workspace config");
  });

  test("is seeded once from the pre-plugin location, so no board is lost", async () => {
    // A workspace that predates the plugin kept its office state in
    // `.pi/settings/agent-team-config.json`. The first read imports it.
    const legacy = path.join(ws, "legacy-project");
    fs.mkdirSync(path.join(legacy, ".pi", "settings"), { recursive: true });
    fs.writeFileSync(legacyConfigPath(legacy), JSON.stringify({
      activeTeam: "dev",
      officeName: "  Legacy   HQ  ",
      runnerPaused: false,
      tasks: [{ id: "t9", title: "from the old config", status: "planned", createdAt: 1, plannedAt: 2 }],
    }, null, 2));

    const imported = await snapshot(legacy);
    assert.equal(imported.officeName, "Legacy HQ", "the old name is carried over");
    assert.equal(imported.runnerPaused, false);
    assert.deepEqual(imported.tasks.map((t) => [t.id, t.title, t.status]), [["t9", "from the old config", "planned"]]);
    assert.equal(stored(fs.realpathSync(legacy)).officeName, "Legacy HQ", "and written into the plugin store");

    // From then on the plugin store wins: the old file is not read again.
    fs.writeFileSync(legacyConfigPath(legacy), JSON.stringify({ officeName: "Stale" }, null, 2));
    assert.equal((await snapshot(fs.realpathSync(legacy))).officeName, "Legacy HQ");
  });

  test("a disabled plugin refuses its routes", async () => {
    const off = await api("/plugins", {
      method: "POST",
      body: JSON.stringify({ action: "disable", id: "office" }),
    });
    assert.ok(off.res.ok);
    assert.equal((await api(`/office?cwd=${encodeURIComponent(ws)}`)).res.status, 403, "GET /office is gated");
    assert.equal((await post({ action: "addTask", title: "nope" })).res.status, 403, "POST /office is gated");

    const on = await api("/plugins", {
      method: "POST",
      body: JSON.stringify({ action: "enable", id: "office" }),
    });
    assert.ok(on.res.ok);
    assert.equal((await snapshot()).runnerPaused, false, "re-enabling restores the state");
  });
});

describe("office name", () => {
  test("the name is stored, trimmed, capped and cleared", async () => {
    // Unnamed at first: the snapshot has no officeName (the view falls back to "Office").
    await post({ action: "setOfficeName", name: "" });
    assert.equal((await snapshot()).officeName, undefined, "an unnamed office has no stored name");

    await post({ action: "setOfficeName", name: "  Night   Shift HQ  " });
    assert.equal((await snapshot()).officeName, "Night Shift HQ", "whitespace is collapsed and trimmed");
    assert.equal(stored().officeName, "Night Shift HQ", "it is written to the plugin's store");

    // 60 characters is the cap; 61 is refused and leaves the stored name alone.
    const tooLong = "x".repeat(61);
    assert.equal((await post({ action: "setOfficeName", name: tooLong })).res.status, 400);
    assert.equal((await snapshot()).officeName, "Night Shift HQ", "the refused write changed nothing");

    await post({ action: "setOfficeName", name: "   " });
    assert.equal((await snapshot()).officeName, undefined, "clearing restores the default label");
    assert.equal("officeName" in stored(), false, "and drops the key from the store");
  });
});

describe("the Kanban queue", () => {
  test("a task is added in Todo and its title/brief round-trip", async () => {
    // Start from a clean board (the suites above left state behind).
    for (const t of (await snapshot()).tasks) await post({ action: "removeTask", id: t.id });
    assert.deepEqual((await snapshot()).tasks, [], "the board starts empty");

    const { res } = await post({ action: "addTask", title: "  draft   the plan ", note: "cover the migration" });
    assert.ok(res.ok);
    const tasks = (await snapshot()).tasks;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].title, "draft the plan", "the title is collapsed and trimmed");
    assert.equal(tasks[0].status, "todo", "a new task lands in Todo");
    assert.equal(tasks[0].note, "cover the migration");
    assert.ok(tasks[0].createdAt > 0, "and is stamped");

    // A task needs a title, and the board has a ceiling.
    assert.equal((await post({ action: "addTask", title: "   " })).res.status, 400, "an empty title is refused");
    assert.equal((await post({ action: "addTask", title: "x".repeat(201) })).res.status, 400, "an over-long title is refused");
    assert.equal((await snapshot()).tasks.length, 1, "no refused task was stored");
  });

  test("moving a task stamps the column it enters and validates the move", async () => {
    const id = (await snapshot()).tasks[0].id;

    assert.ok((await post({ action: "moveTask", id, status: "planned" })).res.ok);
    assert.equal((await task(id)).status, "planned");
    assert.ok((await task(id)).plannedAt > 0, "entering Planned stamps plannedAt");

    assert.ok((await post({ action: "moveTask", id, status: "in_progress" })).res.ok);
    assert.ok((await task(id)).startedAt > 0, "entering In Progress stamps startedAt");

    assert.ok((await post({ action: "moveTask", id, status: "done" })).res.ok);
    assert.ok((await task(id)).finishedAt > 0, "entering Done stamps finishedAt");

    // Back to Todo clears the column stamps again.
    assert.ok((await post({ action: "moveTask", id, status: "todo" })).res.ok);
    const back = await task(id);
    assert.equal(back.status, "todo");
    for (const k of ["plannedAt", "startedAt", "finishedAt"]) assert.equal(back[k], undefined, `${k} is cleared`);

    // Invalid targets and unknown ids are refused rather than silently accepted.
    assert.equal((await post({ action: "moveTask", id, status: "somewhere" })).res.status, 400);
    assert.equal((await post({ action: "moveTask", id: "nope", status: "done" })).res.status, 404);
    assert.equal((await post({ action: "moveTask", id, status: "todo" })).res.status, 200, "the task is still there");
  });

  test("a task can be removed", async () => {
    const before = (await snapshot()).tasks;
    const id = before[before.length - 1].id;
    assert.ok((await post({ action: "removeTask", id })).res.ok);
    assert.equal((await snapshot()).tasks.some((t) => t.id === id), false, "the task is gone");
    assert.equal((await post({ action: "removeTask", id: "" })).res.status, 400, "an empty id is refused");

    // Tasks survive in the plugin's store the next read resolves.
    await post({ action: "addTask", title: "persisted" });
    assert.ok(stored().tasks.some((t) => t.title === "persisted"));
    assert.ok((await snapshot()).tasks.some((t) => t.title === "persisted"));
  });

  test("an unknown action is refused, not silently accepted", async () => {
    assert.equal((await post({ action: "notAnAction" })).res.status, 400);
  });
});

describe("the queue runner switch", () => {
  test("defaults to paused, and round-trips through the plugin's store", async () => {
    const blank = path.join(ws, "blank-project");
    fs.mkdirSync(blank, { recursive: true });
    assert.equal((await snapshot(blank)).runnerPaused, true, "an untouched board starts paused");

    await post({ action: "setRunnerPaused", paused: false }, blank);
    assert.equal((await snapshot(blank)).runnerPaused, false, "Run persists");
    assert.equal(stored(blank).runnerPaused, false);

    await post({ action: "setRunnerPaused", paused: true }, blank);
    assert.equal((await snapshot(blank)).runnerPaused, true, "Pause persists");
    assert.equal(stored(blank).runnerPaused, true);

    // A hand-edited store with the field missing still reads as paused.
    const all = readStore();
    const key = fs.realpathSync(blank);
    delete all.workspaces[key].runnerPaused;
    fs.writeFileSync(storePath(), JSON.stringify(all, null, 2));
    assert.equal((await snapshot(blank)).runnerPaused, true, "an absent field reads as paused");
  });
});
