// End-to-end tests for the Office queue runner running SERVER-SIDE, against the
// REAL server with a stub `pi`. The whole point is that no browser is involved:
// the plugin dispatches the next planned task, consumes the run, settles it, and
// continues the queue on its own — so a queue keeps advancing with no page open.
//
// The stub `pi` speaks the RPC protocol chat.ts expects: it reads a prompt and
// writes agent_settled (so the run succeeds), stays silent for a SLOW prompt (so
// the test can pause mid-run), and exits on FAIL (so the run fails).
//
//   node --test apps/scope-server/test/office-runner.e2e.test.mjs

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
const TOKEN = "office-runner-token";

const STUB = `#!/usr/bin/env node
let buf = "";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const finish = () => {
  send({ type: "agent_start" });
  send({ type: "message_start", message: { role: "assistant" } });
  send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ok" } });
  send({ type: "agent_settled" });
};
process.stdin.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === "prompt") {
      const msg = String(ev.message || "");
      if (/FAIL/.test(msg)) process.exit(1);
      if (/SLOW/.test(msg)) setTimeout(finish, 30000);
      else finish();
    } else if (ev.type === "abort") {
      send({ type: "agent_settled" });
      process.exit(0);
    }
  }
});
`;

let child;
let base;
let ws;
let agentDir;
let pluginsDir;
let stubBin; // the stub `pi` wrapper, reused by the restart test

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

const post = (body) => api("/office", { method: "POST", body: JSON.stringify({ ...body, cwd: ws }) });
const snapshot = async () => (await api(`/office?cwd=${encodeURIComponent(ws)}`)).data;
const byTitle = (s, title) => (s.tasks || []).find((t) => t.title === title);

async function until(fn, what, timeout = 15_000) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Put one task in Planned and return its id. */
async function planTask(title) {
  await post({ action: "addTask", title });
  const id = byTitle(await snapshot(), title).id;
  await post({ action: "moveTask", id, status: "planned" });
  return id;
}

async function clearBoard() {
  await post({ action: "setRunnerPaused", paused: true });
  for (const t of (await snapshot()).tasks) await post({ action: "removeTask", id: t.id });
}

before(async () => {
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-office-runner-")));
  agentDir = path.join(ws, "agent");
  pluginsDir = path.join(ws, "plugins");
  const stubDir = path.join(ws, "stub");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(stubDir, { recursive: true });
  const stubMjs = path.join(stubDir, "stub-pi.mjs");
  fs.writeFileSync(stubMjs, STUB);
  const wrapper = path.join(stubDir, "pi");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(stubMjs)} "$@"\n`);
  fs.chmodSync(wrapper, 0o755);
  stubBin = wrapper;

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      SCOPE_PORT: String(port), SCOPE_HOST: "127.0.0.1",
      SCOPE_DB_PATH: path.join(ws, "scope.db"), SCOPE_AUTH_TOKEN: TOKEN,
      SCOPE_PLUGINS_DIR: pluginsDir, SCOPE_FILE_ROOT: ws,
      SCOPE_AGENT_DIR: agentDir, SCOPE_PI_BIN: wrapper,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  await waitForHealth();
});

after(async () => {
  if (child) { child.kill("SIGKILL"); await new Promise((r) => child.once("exit", r)); }
  if (ws) fs.rmSync(ws, { recursive: true, force: true });
});

describe("the server-side queue runner", () => {
  test("dispatches and continues the queue with no page open", async () => {
    await clearBoard();
    await post({ action: "setRunnerPaused", paused: false });
    // Two planned tasks; the runner takes them one at a time, on its own.
    await planTask("first task");
    await planTask("second task");
    await until(async () => {
      const s = await snapshot();
      return byTitle(s, "first task").status === "done" && byTitle(s, "second task").status === "done";
    }, "both tasks run to Done with no browser");

    const s = await snapshot();
    assert.equal(byTitle(s, "first task").status, "done");
    assert.equal(byTitle(s, "second task").status, "done");
    assert.equal(byTitle(s, "first task").failedAt, undefined, "a clean run is not marked failed");
  });

  test("Pause stops the run in flight and returns its task to Planned", async () => {
    await clearBoard();
    const id = await planTask("SLOW one");
    await post({ action: "setRunnerPaused", paused: false });
    await until(async () => byTitle(await snapshot(), "SLOW one").status === "in_progress", "the slow run starts");

    await post({ action: "setRunnerPaused", paused: true });
    await until(async () => byTitle(await snapshot(), "SLOW one").status === "planned", "Pause returns the task to Planned");
    const s = await snapshot();
    assert.equal(s.runnerPaused, true);
    assert.equal(byTitle(s, "SLOW one").failedAt, undefined, "a paused task is not failed");
    assert.ok(byTitle(s, "SLOW one").id === id);
  });

  test("a run that dies is marked failed and not retried", async () => {
    await clearBoard();
    await planTask("FAIL now");
    await post({ action: "setRunnerPaused", paused: false });
    await until(async () => {
      const t = byTitle(await snapshot(), "FAIL now");
      return t.status === "planned" && t.failedAt > 0;
    }, "the dead run is marked failed");
    // The runner must not retry it on its own.
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(byTitle(await snapshot(), "FAIL now").status, "planned", "a failed task waits for the user");
  });

  test("disabling the plugin stops a run in flight", async () => {
    await clearBoard();
    await planTask("SLOW dispose");
    await post({ action: "setRunnerPaused", paused: false });
    await until(async () => byTitle(await snapshot(), "SLOW dispose").status === "in_progress", "the slow run starts");

    // Disable the plugin: its dispose hook must abort the run (no orphaned pi).
    assert.ok((await api("/plugins", { method: "POST", body: JSON.stringify({ action: "disable", id: "office" }) })).res.ok);
    assert.equal((await api(`/office?cwd=${encodeURIComponent(ws)}`)).res.status, 403, "the route is gated");

    // The aborted run returns its task to Planned — read the store directly, the
    // route is gated while disabled.
    const storePath = path.join(ws, ".pi-scope", "plugins", ".data", "office.json");
    const storedStatus = () => {
      try {
        const all = JSON.parse(fs.readFileSync(storePath, "utf8"));
        for (const w of Object.values(all.workspaces || {})) {
          const t = (w.tasks || []).find((x) => x.title === "SLOW dispose");
          if (t) return t.status;
        }
      } catch { /* not written yet */ }
      return null;
    };
    await until(() => storedStatus() === "planned", "the aborted run returns its task to Planned", 8000);

    // Re-enable (the resume pass may restart it), then pause so the suite is clean.
    assert.ok((await api("/plugins", { method: "POST", body: JSON.stringify({ action: "enable", id: "office" }) })).res.ok);
    await post({ action: "setRunnerPaused", paused: true });
    await until(async () => byTitle(await snapshot(), "SLOW dispose").status === "planned", "the resumed run is stopped again");
  });

  test("resumes a queue left running when the server restarts", async () => {
    // A fresh server over a store whose workspace was left RUNNING: the queue
    // resumes at boot, with no page and no API call to start it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-office-resume-"));
    const cwd = fs.realpathSync(dir);
    const agentDir2 = path.join(dir, "agent");
    const pluginsDir2 = path.join(dir, "plugins");
    fs.mkdirSync(agentDir2, { recursive: true });
    fs.mkdirSync(pluginsDir2, { recursive: true });
    // The board lives in the project's own store; the plugins dir keeps only the
    // index of known projects, which is what the boot resume pass reads.
    fs.mkdirSync(path.join(cwd, ".pi-scope", "plugins", ".data"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".pi-scope", "plugins", ".data", "office.json"), JSON.stringify({
      workspaces: { [cwd]: { runnerPaused: false, tasks: [
        { id: "r1", title: "resume me", status: "planned", createdAt: 1, plannedAt: 2 },
      ] } },
    }, null, 2));
    fs.mkdirSync(path.join(pluginsDir2, ".data"), { recursive: true });
    fs.writeFileSync(path.join(pluginsDir2, ".data", "office.json"), JSON.stringify({ projects: [cwd] }, null, 2));

    const port = await freePort();
    const base2 = `http://127.0.0.1:${port}`;
    const proc = spawn(process.execPath, [SERVER], {
      cwd: ROOT,
      env: {
        ...process.env,
        SCOPE_PORT: String(port), SCOPE_HOST: "127.0.0.1",
        SCOPE_DB_PATH: path.join(dir, "scope.db"), SCOPE_AUTH_TOKEN: "resume-token",
        SCOPE_PLUGINS_DIR: pluginsDir2, SCOPE_FILE_ROOT: dir,
        SCOPE_AGENT_DIR: agentDir2, SCOPE_PI_BIN: stubBin,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const snap = async () => (await (await fetch(`${base2}/office?cwd=${encodeURIComponent(cwd)}`, {
      headers: { authorization: "Bearer resume-token" },
    })).json());
    try {
      const start = Date.now();
      for (;;) {
        try { if ((await fetch(`${base2}/health`)).ok) break; } catch { /* not up */ }
        if (Date.now() - start > 20_000) throw new Error("server did not start");
        await new Promise((r) => setTimeout(r, 200));
      }
      const t0 = Date.now();
      for (;;) {
        const t = (await snap()).tasks.find((x) => x.id === "r1");
        if (t && t.status === "done") break;
        if (Date.now() - t0 > 15_000) throw new Error("the resumed queue did not finish");
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal((await snap()).tasks.find((x) => x.id === "r1").status, "done", "the queue resumed at boot");
    } finally {
      proc.kill("SIGKILL");
      await new Promise((r) => proc.once("exit", r));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
