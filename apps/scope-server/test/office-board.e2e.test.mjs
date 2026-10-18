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

import { test, before, after, beforeEach, describe } from "node:test";
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
/** The plugin's project-scoped store (api.projectStore →
 *  `<cwd>/.pi-scope/plugins/.data/office.json`). */
const storePath = (cwd = ws) => path.join(fs.realpathSync(cwd), ".pi-scope", "plugins", ".data", "office.json");
const readStore = (cwd = ws) => JSON.parse(fs.readFileSync(storePath(cwd), "utf8"));
/** The state the plugin kept for one workspace. */
const stored = (cwd = ws) => readStore(cwd).workspaces[fs.realpathSync(cwd)];
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

// The shared workspace's runner starts PAUSED before every test, so a test that
// only exercises board writes never accidentally dispatches a real run (the
// server now owns the queue and would start one).
beforeEach(async () => { await post({ action: "setRunnerPaused", paused: true }); });

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
    assert.deepEqual(await snapshot(), { tasks: [], runnerPaused: true, serverRunner: true }, "an untouched office starts empty and paused, and the server runs the queue");

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
    // A distinctive state to see restored across a disable/enable cycle.
    await post({ action: "setRunnerPaused", paused: false });
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

  test("a task's title and brief can be edited in place, without moving its column", async () => {
    await post({ action: "addTask", title: "rough draft", note: "first pass" });
    const id = (await snapshot()).tasks.find((t) => t.title === "rough draft").id;

    const { res } = await post({ action: "updateTask", id, title: "  refined   draft ", note: "second pass" });
    assert.ok(res.ok);
    const t = await task(id);
    assert.equal(t.title, "refined draft", "the title is collapsed and trimmed");
    assert.equal(t.note, "second pass", "the brief is rewritten");
    assert.equal(t.status, "todo", "editing never changes the column");

    // An omitted brief clears the note; the validation mirrors addTask.
    await post({ action: "updateTask", id, title: "refined draft" });
    assert.equal((await task(id)).note, undefined, "an omitted brief clears the note");
    assert.equal((await post({ action: "updateTask", id, title: "   " })).res.status, 400, "an empty title is refused");
    assert.equal((await post({ action: "updateTask", id, title: "x".repeat(201) })).res.status, 400, "an over-long title is refused");
    assert.equal((await post({ action: "updateTask", id: "nope", title: "x" })).res.status, 404, "an unknown task is a 404");
    assert.equal((await task(id)).title, "refined draft", "a refused edit changes nothing");
    await post({ action: "removeTask", id });
  });

  test("planned tasks are placed by drag-and-drop, and that order is what the board reads", async () => {
    for (const t of (await snapshot()).tasks) await post({ action: "removeTask", id: t.id });
    for (const title of ["one", "two", "three"]) {
      await post({ action: "addTask", title });
      const id = (await snapshot()).tasks.find((t) => t.title === title).id;
      await post({ action: "moveTask", id, status: "planned" });
      await new Promise((r) => setTimeout(r, 2)); // distinct plannedAt, like a human
    }
    const order = async () => (await snapshot()).tasks
      .filter((t) => t.status === "planned")
      .sort((a, b) => a.plannedAt - b.plannedAt)
      .map((t) => t.title);
    const idOf = async (title) => (await snapshot()).tasks.find((t) => t.title === title).id;
    assert.deepEqual(await order(), ["one", "two", "three"], "planned tasks queue FIFO");

    // Dropping "two" before "one" resequences the queue.
    assert.ok((await post({ action: "placeTask", id: await idOf("two"), status: "planned", beforeId: await idOf("one") })).res.ok);
    assert.deepEqual(await order(), ["two", "one", "three"], "dropping before a task moves it there");
    // Dropping "two" at the end (empty beforeId) appends.
    assert.ok((await post({ action: "placeTask", id: await idOf("two"), status: "planned", beforeId: "" })).res.ok);
    assert.deepEqual(await order(), ["one", "three", "two"], "an empty target appends to the back");
    // An unknown target also appends rather than losing the task.
    assert.ok((await post({ action: "placeTask", id: await idOf("two"), status: "planned", beforeId: "nope" })).res.ok);
    assert.deepEqual(await order(), ["one", "three", "two"], "an unknown target appends");

    // A task planned AFTER a resequence still sorts to the back of the queue.
    await post({ action: "addTask", title: "four" });
    await post({ action: "placeTask", id: await idOf("four"), status: "planned", beforeId: "" });
    assert.deepEqual(await order(), ["one", "three", "two", "four"], "a later task sorts to the back");

    // A drag between columns is the same action: a Todo card dropped into Planned.
    await post({ action: "addTask", title: "from todo" });
    const moved = await post({ action: "placeTask", id: await idOf("from todo"), status: "planned", beforeId: await idOf("three") });
    assert.ok(moved.res.ok);
    assert.deepEqual(await order(), ["one", "from todo", "three", "two", "four"], "a cross-column drop lands at the position");
    // And a Planned card dropped into Done leaves the queue.
    assert.ok((await post({ action: "placeTask", id: await idOf("one"), status: "done" })).res.ok);
    assert.deepEqual(await order(), ["from todo", "three", "two", "four"], "moving to Done leaves the queue");

    // Validation: an unknown task is a 404, an invalid status a 400, an empty id a 400.
    assert.equal((await post({ action: "placeTask", id: "nope", status: "planned" })).res.status, 404, "an unknown task is a 404");
    assert.equal((await post({ action: "placeTask", id: await idOf("two"), status: "sideways" })).res.status, 400, "an invalid status is refused");
    assert.equal((await post({ action: "placeTask", id: "", status: "planned" })).res.status, 400, "a missing id is refused");
  });

  test("beginRun records the run session, and leaving In Progress clears it", async () => {
    await post({ action: "addTask", title: "dispatched work" });
    const id = (await snapshot()).tasks.find((t) => t.title === "dispatched work").id;
    await post({ action: "moveTask", id, status: "planned" });

    // A runner announces the chat session its dispatch will use in ONE write
    // with the move to In Progress.
    const began = await post({ action: "beginRun", id, sessionId: "sess-1" });
    assert.ok(began.res.ok);
    const t = await task(id);
    assert.equal(t.status, "in_progress");
    assert.equal(t.runSessionId, "sess-1", "the run session is recorded");
    assert.ok(t.startedAt > 0, "startedAt is stamped");

    // The snapshot reports the run's live status (this session is unknown to the
    // chat manager, so it reads as gone — the orphan case the runner recovers).
    assert.deepEqual((await snapshot()).runStates[id], { present: false, active: false, outcome: null });

    // Leaving In Progress ends the run, and the derived map disappears with it.
    await post({ action: "moveTask", id, status: "todo" });
    assert.equal((await task(id)).runSessionId, undefined, "the run session is dropped");
    assert.equal("runStates" in (await snapshot()), false, "a board with no run keeps the bare snapshot shape");
  });

  test("beginRun needs a session id, and stopRun returns its task to Planned", async () => {
    await post({ action: "addTask", title: "stoppable work" });
    const id = (await snapshot()).tasks.find((t) => t.title === "stoppable work").id;
    await post({ action: "moveTask", id, status: "planned" });

    assert.equal((await post({ action: "beginRun", id })).res.status, 400, "a session id is required");
    assert.ok((await post({ action: "beginRun", id, sessionId: "sess-2" })).res.ok);

    // stopRun (Pause on a run this page does not own) hands the task back.
    assert.ok((await post({ action: "stopRun", id })).res.ok);
    const t = await task(id);
    assert.equal(t.status, "planned", "the task waits in Planned again");
    assert.equal(t.runSessionId, undefined, "and its run record is cleared");
  });

  test("beginRun is the single-runner lock: a second concurrent run is refused", async () => {
    // The office works one task at a time. Two dispatches racing (two tabs, a
    // stale board) must not both start — the loser is refused, not duplicated.
    const add = async (title) => {
      await post({ action: "addTask", title });
      const id = (await snapshot()).tasks.find((t) => t.title === title).id;
      await post({ action: "moveTask", id, status: "planned" });
      return id;
    };
    const a = await add("running now");
    assert.ok((await post({ action: "beginRun", id: a, sessionId: "sess-lock-1" })).res.ok);

    const b = await add("wants to run");
    const second = await post({ action: "beginRun", id: b, sessionId: "sess-lock-2" });
    assert.equal(second.res.status, 409, "the second dispatch is refused");
    assert.equal(second.data.code, "conflict", "with a conflict code the client can act on");
    assert.equal((await task(b)).status, "planned", "the losing task stays in Planned");
    assert.equal((await task(b)).runSessionId, undefined, "and never gets a run session");

    // Once the first run leaves In Progress, the lock frees and the next starts.
    await post({ action: "moveTask", id: a, status: "done" });
    assert.ok((await post({ action: "beginRun", id: b, sessionId: "sess-lock-3" })).res.ok, "the lock frees up");
    assert.equal((await task(b)).status, "in_progress");
  });

  test("a second task cannot be moved or dragged into a busy In Progress", async () => {
    // Clear whatever the lock test left In Progress so this one starts clean.
    for (const t of (await snapshot()).tasks) if (t.status === "in_progress") await post({ action: "moveTask", id: t.id, status: "done" });

    const add = async (title) => {
      await post({ action: "addTask", title });
      const id = (await snapshot()).tasks.find((t) => t.title === title).id;
      await post({ action: "moveTask", id, status: "planned" });
      return id;
    };
    const a = await add("busy task");
    assert.ok((await post({ action: "beginRun", id: a, sessionId: "sess-busy" })).res.ok);
    const b = await add("second task");

    const moved = await post({ action: "moveTask", id: b, status: "in_progress" });
    assert.equal(moved.res.status, 409, "moveTask into a busy In Progress is refused");
    assert.equal(moved.data.code, "conflict");
    assert.equal((await task(b)).status, "planned", "the task is untouched");

    const placed = await post({ action: "placeTask", id: b, status: "in_progress", beforeId: "" });
    assert.equal(placed.res.status, 409, "placeTask (drag) is refused too");

    // Moving the busy task out frees the column for the next one.
    await post({ action: "moveTask", id: a, status: "done" });
    assert.ok((await post({ action: "moveTask", id: b, status: "in_progress" })).res.ok, "the column frees up");
  });

  test("failTask persists the failure, and a move or fresh run re-arms it", async () => {
    // Clear whatever the previous test left In Progress so the lock is free.
    for (const t of (await snapshot()).tasks) if (t.status === "in_progress") await post({ action: "moveTask", id: t.id, status: "done" });
    await post({ action: "addTask", title: "doomed" });
    const id = (await snapshot()).tasks.find((t) => t.title === "doomed").id;
    await post({ action: "moveTask", id, status: "planned" });
    await post({ action: "beginRun", id, sessionId: "sess-fail" });

    const failed = await post({ action: "failTask", id });
    assert.ok(failed.res.ok);
    const t = await task(id);
    assert.equal(t.status, "planned", "a failed task waits in Planned");
    assert.ok(t.failedAt > 0, "and is marked failed (persisted)");
    assert.equal(t.runSessionId, undefined, "its run record is cleared");

    // A fresh dispatch clears the failure.
    assert.ok((await post({ action: "beginRun", id, sessionId: "sess-retry" })).res.ok);
    assert.equal((await task(id)).failedAt, undefined, "a fresh run clears the failure");

    // So does the user moving the card.
    await post({ action: "failTask", id });
    assert.ok((await task(id)).failedAt > 0);
    await post({ action: "moveTask", id, status: "planned" });
    assert.equal((await task(id)).failedAt, undefined, "moving the task re-arms it");
  });

  test("Waiting is a real column: it keeps the run it holds, and holds the lock", async () => {
    // Clear whatever an earlier test left held, so the lock starts free.
    for (const t of (await snapshot()).tasks) {
      if (t.status === "in_progress" || t.status === "waiting") await post({ action: "moveTask", id: t.id, status: "done" });
    }
    await post({ action: "addTask", title: "needs an answer" });
    const id = (await snapshot()).tasks.find((t) => t.title === "needs an answer").id;
    await post({ action: "moveTask", id, status: "planned" });
    assert.ok((await post({ action: "beginRun", id, sessionId: "sess-wait" })).res.ok);

    // Parking the card in Waiting (what the read-time reconcile does on its own,
    // and what the user can do by hand) keeps the recorded run: that run is live,
    // it is only blocked on an answer.
    assert.ok((await post({ action: "placeTask", id, status: "waiting", beforeId: "" })).res.ok);
    const parked = await task(id);
    assert.equal(parked.status, "waiting");
    assert.equal(parked.runSessionId, "sess-wait", "the run record survives the move to Waiting");
    assert.ok(parked.runStartedAt > 0, "and so does its start stamp");

    // The blocked run still owns the orchestrator, so nothing else may start —
    // not a dispatch, not a drag.
    await post({ action: "addTask", title: "wants to run" });
    const other = (await snapshot()).tasks.find((t) => t.title === "wants to run").id;
    await post({ action: "moveTask", id: other, status: "planned" });
    assert.equal((await post({ action: "beginRun", id: other, sessionId: "sess-second" })).res.status, 409, "a dispatch behind a Waiting task is refused");
    assert.equal((await post({ action: "moveTask", id: other, status: "in_progress" })).res.status, 409, "and so is a drag into In Progress");
    assert.equal((await task(other)).status, "planned", "the losing task is untouched");

    // Leaving Waiting releases the run record, like leaving In Progress.
    assert.ok((await post({ action: "moveTask", id, status: "planned" })).res.ok);
    assert.equal((await task(id)).runSessionId, undefined, "leaving Waiting clears the run record");
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
    const all = readStore(blank);
    const key = fs.realpathSync(blank);
    delete all.workspaces[key].runnerPaused;
    fs.writeFileSync(storePath(blank), JSON.stringify(all, null, 2));
    assert.equal((await snapshot(blank)).runnerPaused, true, "an absent field reads as paused");
  });
});

describe("read-time self-heal", () => {
  test("a stale In Progress board heals on the first read after a restart", async () => {
    // A board left In Progress whose run is gone (the server restarted, no page
    // open) must not stall the runner forever. The first read returns the stale
    // task to Planned — but a run that is only just starting is left alone.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-office-heal-"));
    const cwd = fs.realpathSync(dir);
    const agentDir2 = path.join(dir, "agent");
    const pluginsDir2 = path.join(dir, "plugins");
    fs.mkdirSync(agentDir2, { recursive: true });
    fs.mkdirSync(pluginsDir2, { recursive: true });
    const past = Date.now() - 60_000;
    // The board now lives in the project's own store, not the plugins dir.
    fs.mkdirSync(path.join(cwd, ".pi-scope", "plugins", ".data"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".pi-scope", "plugins", ".data", "office.json"), JSON.stringify({
      workspaces: {
        [cwd]: {
          runnerPaused: false,
          tasks: [
            { id: "gone", title: "run that died with the server", status: "in_progress", startedAt: past, runSessionId: "dead-session", runStartedAt: past },
            { id: "manual", title: "old manual In Progress", status: "in_progress", startedAt: past },
            { id: "fresh", title: "a run just starting", status: "in_progress", startedAt: Date.now(), runSessionId: "starting-session", runStartedAt: Date.now() },
          ],
        },
      },
    }, null, 2));

    const port = await freePort();
    const base2 = `http://127.0.0.1:${port}`;
    const proc = spawn(process.execPath, [SERVER], {
      cwd: ROOT,
      env: {
        ...process.env,
        SCOPE_PORT: String(port), SCOPE_HOST: "127.0.0.1",
        SCOPE_DB_PATH: path.join(dir, "scope.db"), SCOPE_AUTH_TOKEN: "heal-token",
        SCOPE_PLUGINS_DIR: pluginsDir2, SCOPE_FILE_ROOT: dir,
        SCOPE_AGENT_DIR: agentDir2, SCOPE_PI_BIN: "/bin/true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const start = Date.now();
      for (;;) {
        try { if ((await fetch(`${base2}/health`)).ok) break; } catch { /* not up */ }
        if (Date.now() - start > 20_000) throw new Error("server did not start");
        await new Promise((r) => setTimeout(r, 250));
      }
      const res = await fetch(`${base2}/office?cwd=${encodeURIComponent(cwd)}`, { headers: { authorization: "Bearer heal-token" } });
      const data = await res.json();
      const by = (id) => data.tasks.find((t) => t.id === id);
      assert.equal(by("gone").status, "planned", "a run whose session is gone is returned to Planned");
      assert.equal(by("gone").runSessionId, undefined, "and its run record is cleared");
      assert.equal(by("manual").status, "planned", "an old manual In Progress entry heals too");
      assert.equal(by("fresh").status, "in_progress", "a run only just starting is left alone");
      assert.equal(by("fresh").runSessionId, "starting-session", "with its session intact");
    } finally {
      proc.kill("SIGKILL");
      await new Promise((r) => proc.once("exit", r));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a Waiting card stays where it is unless the run it holds is gone", async () => {
    // Waiting is a legitimate resting place: a card the user parked there by hand
    // has no run and must never be bounced back to Planned — but a card whose
    // blocked run died with the server has to come back to the queue.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-office-wait-"));
    const cwd = fs.realpathSync(dir);
    const agentDir2 = path.join(dir, "agent");
    const pluginsDir2 = path.join(dir, "plugins");
    fs.mkdirSync(agentDir2, { recursive: true });
    fs.mkdirSync(pluginsDir2, { recursive: true });
    const past = Date.now() - 60_000;
    fs.mkdirSync(path.join(cwd, ".pi-scope", "plugins", ".data"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".pi-scope", "plugins", ".data", "office.json"), JSON.stringify({
      workspaces: {
        [cwd]: {
          runnerPaused: true,
          tasks: [
            { id: "byhand", title: "parked by the user", status: "waiting", createdAt: past, startedAt: past },
            { id: "orphan", title: "blocked run that died", status: "waiting", createdAt: past, startedAt: past, runSessionId: "dead-session", runStartedAt: past },
          ],
        },
      },
    }, null, 2));

    const port = await freePort();
    const base2 = `http://127.0.0.1:${port}`;
    const proc = spawn(process.execPath, [SERVER], {
      cwd: ROOT,
      env: {
        ...process.env,
        SCOPE_PORT: String(port), SCOPE_HOST: "127.0.0.1",
        SCOPE_DB_PATH: path.join(dir, "scope.db"), SCOPE_AUTH_TOKEN: "wait-token",
        SCOPE_PLUGINS_DIR: pluginsDir2, SCOPE_FILE_ROOT: dir,
        SCOPE_AGENT_DIR: agentDir2, SCOPE_PI_BIN: "/bin/true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const start = Date.now();
      for (;;) {
        try { if ((await fetch(`${base2}/health`)).ok) break; } catch { /* not up */ }
        if (Date.now() - start > 20_000) throw new Error("server did not start");
        await new Promise((r) => setTimeout(r, 250));
      }
      const res = await fetch(`${base2}/office?cwd=${encodeURIComponent(cwd)}`, { headers: { authorization: "Bearer wait-token" } });
      const data = await res.json();
      const by = (id) => data.tasks.find((t) => t.id === id);
      assert.equal(by("byhand").status, "waiting", "a hand-parked card is left alone");
      assert.equal(by("orphan").status, "planned", "a Waiting card whose run is gone returns to the queue");
      assert.equal(by("orphan").runSessionId, undefined, "and its run record is cleared");
    } finally {
      proc.kill("SIGKILL");
      await new Promise((r) => proc.once("exit", r));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
