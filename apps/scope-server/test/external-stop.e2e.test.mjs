// End-to-end test for stopping a pi that runs in the user's OWN terminal.
//
// The whole chain is exercised against the real server: an event carrying the
// writer's pid is ingested, GET /sessions annotates the row with it, and
// POST /chat/stop signals that pid (there is no chat subprocess for the
// session), recording a closing turn_end so every view settles.
//
//   node --test apps/scope-server/test/external-stop.e2e.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as net from "node:net";
import * as path from "node:path";
import * as url from "node:url";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const SERVER = path.join(ROOT, "apps", "scope-server", "server.ts");
const TOKEN = "external-stop-token";
const SID = "ext-stop";

let child = null;      // the server
let pi = null;         // the fake "terminal pi"
let tmpDir = null;
let base = "";

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

const authHeaders = () => ({ Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" });

async function api(pathname, { method = "GET", body } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: authHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  return { res, data };
}

/** A node process that idles until signalled, standing in for `pi` in the
 *  user's terminal. Resolves with its pid. */
function startFakePi() {
  pi = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  return new Promise((resolve, reject) => {
    pi.once("spawn", () => resolve(pi.pid));
    pi.once("error", reject);
  });
}

/** The same, but it holds `file` open and names itself `pi` — how the server
 *  finds a pi whose extension never stamped a pid. */
function startFakePiHolding(file) {
  const code = `const fs = require("node:fs"); fs.openSync(${JSON.stringify(file)}, "a"); setInterval(() => {}, 1000);`;
  pi = spawn(process.execPath, ["-e", code, "pi"], { stdio: "ignore" });
  return new Promise((resolve, reject) => {
    pi.once("spawn", () => resolve(pi.pid));
    pi.once("error", reject);
  });
}

function exited(child, ms = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the pi process did not exit")), ms);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

before(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-external-stop-")));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: { ...process.env, SCOPE_PORT: String(port), SCOPE_DB_PATH: path.join(tmpDir, "scope.db"), SCOPE_AUTH_TOKEN: TOKEN, SCOPE_HOST: "127.0.0.1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  await waitForHealth();
});

after(async () => {
  for (const p of [pi, child]) {
    if (!p) continue;
    if (p.exitCode !== null || p.signalCode !== null) continue; // already exited
    try { p.kill("SIGKILL"); } catch { /* gone */ }
    await new Promise((r) => p.once("exit", r));
  }
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("a terminal pi's pid is annotated and Stop signals it", async () => {
  const pid = await startFakePi();
  const now = new Date().toISOString();
  // A working turn, exactly as the extension would post it: the pid rides on
  // every event envelope, the turn lifecycle on turn_start/turn_end.
  const seed = await api("/events", {
    method: "POST",
    body: [
      { event_id: "ext-1", session_id: SID, seq: 0, ts: now, type: "user_message", cwd: tmpDir, pool: "default", tags: [], payload: { text: "work in the terminal" }, pid, pid_started_at: Date.now() },
      { event_id: "ext-2", session_id: SID, seq: 1, ts: now, type: "turn_start", cwd: tmpDir, pool: "default", tags: [], payload: { turn_index: 0 }, pid, pid_started_at: Date.now() },
    ],
  });
  assert.ok(seed.res.ok, `POST /events answered (${seed.res.status})`);

  const before = await api("/sessions?limit=10");
  const row = (before.data.sessions || []).find((s) => s.session_id === SID);
  assert.ok(row, "the session is listed");
  assert.equal(row.pid, pid, "GET /sessions annotates the writer's pid");
  assert.equal(row.last_turn_event, "turn_start", "the turn is open");
  assert.equal(row.turn_live, true, "and still live");

  const stop = await api("/chat/stop", { method: "POST", body: { sessionId: SID } });
  assert.equal(stop.res.status, 200);
  assert.equal(stop.data.ok, true, "the stop succeeded");
  assert.equal(stop.data.external, true, "it killed the terminal process");
  assert.equal(stop.data.chat, false, "there was no chat subprocess to abort");
  assert.equal(stop.data.pid, pid);

  await exited(pi);

  // The killed extension could not record the end of its own turn: the server
  // wrote a closing turn_end instead, and the pid is no longer offered.
  const after_ = await api("/sessions?limit=10");
  const afterRow = (after_.data.sessions || []).find((s) => s.session_id === SID);
  assert.equal(afterRow.last_turn_event, "turn_end", "the turn is closed");
  assert.equal(afterRow.pid, undefined, "the dangling pid is gone");
  assert.equal(afterRow.has_shutdown, false, "a stop is not a session shutdown");
});

test("a terminal pi with no pid in its events is found by its session file", async () => {
  const sid = "ext-stop-file";
  const file = path.join(tmpDir, `${sid}.jsonl`);
  fs.writeFileSync(file, "");
  const pid = await startFakePiHolding(file);
  const now = new Date().toISOString();
  // Give the process a moment to open the file (the lookup caches a miss).
  await new Promise((r) => setTimeout(r, 300));
  // An extension too old to stamp a pid: the events carry the session file, and
  // that file is held open by the running pi.
  const seed = await api("/events", {
    method: "POST",
    body: [
      { event_id: `${sid}-1`, session_id: sid, seq: 0, ts: now, type: "user_message", session_file: file, cwd: tmpDir, pool: "default", tags: [], payload: { text: "legacy work" } },
      { event_id: `${sid}-2`, session_id: sid, seq: 1, ts: now, type: "turn_start", session_file: file, cwd: tmpDir, pool: "default", tags: [], payload: { turn_index: 0 } },
    ],
  });
  assert.ok(seed.res.ok);

  const before = await api("/sessions?limit=10");
  const row = (before.data.sessions || []).find((s) => s.session_id === sid);
  assert.equal(row.pid, pid, "GET /sessions resolved the pid from the session file");

  const stop = await api("/chat/stop", { method: "POST", body: { sessionId: sid } });
  assert.equal(stop.data.ok, true);
  assert.equal(stop.data.external, true);
  await exited(pi);
  const after_ = await api("/sessions?limit=10");
  assert.equal((after_.data.sessions || []).find((s) => s.session_id === sid).last_turn_event, "turn_end");
});

test("Stop on a session with no known process reports why", async () => {
  const r = await api("/chat/stop", { method: "POST", body: { sessionId: SID } });
  assert.equal(r.res.status, 200);
  assert.equal(r.data.ok, false, "there is nothing left to signal");
  assert.equal(r.data.external, false);
});
