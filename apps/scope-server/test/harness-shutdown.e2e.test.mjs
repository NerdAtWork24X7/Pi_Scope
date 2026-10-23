// End-to-end test for closing the app while a harness is running.
//
// A real server is started with a fake `claude` that writes its pid and then
// idles. POST /chat runs it; the server is then stopped the way the desktop
// shell stops it (SIGTERM) and, in the second test, the launcher pid it watches
// is killed instead. In both cases the harness (and the shell child it started)
// must be gone — no orphan left behind after the window closes.
//
//   node --test apps/scope-server/test/harness-shutdown.e2e.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as net from "node:net";
import * as path from "node:path";
import * as url from "node:url";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, "..", "server.ts");
const TOKEN = "harness-shutdown-token";

const cleanups = [];
after(() => {
  for (const fn of cleanups.reverse()) {
    try { fn(); } catch { /* already gone */ }
  }
});

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

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

/** A fake harness: record its pid, print something, then wait to be stopped. */
function fakeHarness(dir) {
  const pidFile = path.join(dir, "harness.pid");
  const file = path.join(dir, "claude");
  fs.writeFileSync(file, `#!/bin/sh\necho $$ > ${JSON.stringify(pidFile)}\necho working\nsleep 300\n`, { mode: 0o755 });
  return { file, pidFile };
}

async function waitFor(read, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out");
}

async function launchServer(dir, extraEnv = {}) {
  const port = await freePort();
  const token = path.join(dir, "token");
  const child = spawn(process.execPath, [SERVER], {
    cwd: path.dirname(SERVER),
    env: {
      ...process.env,
      SCOPE_PORT: String(port),
      SCOPE_HOST: "127.0.0.1",
      SCOPE_AUTH_TOKEN: TOKEN,
      SCOPE_DB_PATH: path.join(dir, "scope.db"),
      SCOPE_TOKEN_FILE: token,
      SCOPE_FILE_ROOT: dir,
      SCOPE_HARNESS_BIN_CLAUDE: path.join(dir, "claude"),
      ...extraEnv,
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  cleanups.push(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  let healthy = false;
  while (Date.now() < deadline && !healthy) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
    try { healthy = (await fetch(`${base}/health`)).ok; } catch { /* booting */ }
    if (!healthy) await new Promise((r) => setTimeout(r, 200));
  }
  if (!healthy) throw new Error("server did not become healthy");
  return { child, base, port };
}

/** Start one harness run and resolve with its pid once the CLI is up. */
async function startHarness(dir, base, pidFile) {
  const res = await fetch(`${base}/chat`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ cwd: dir, harness: "claude", prompt: "hello", sessionId: `s-${Date.now()}` }),
  });
  assert.equal(res.status, 200);
  // Drain the stream so the server never blocks writing into it.
  void res.body?.getReader().read().catch(() => {});
  const pid = await waitFor(() => {
    try {
      const n = Number(fs.readFileSync(pidFile, "utf8").trim());
      return Number.isInteger(n) && n > 0 ? n : 0;
    } catch { return 0; }
  });
  // The server spawns the harness detached, so kill its whole group if this
  // test fails before the shutdown path has run.
  cleanups.push(() => {
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  });
  assert.equal(alive(pid), true);
  return pid;
}

test("stopping the server closes the harness it started", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-harness-stop-"));
  const { pidFile } = fakeHarness(dir);
  const { child, base } = await launchServer(dir);
  const pid = await startHarness(dir, base, pidFile);

  child.kill("SIGTERM");
  await waitFor(() => child.exitCode !== null || child.signalCode !== null);
  assert.equal(alive(pid), false, "the harness did not outlive the server");
});

test("the server shuts down when its launcher dies", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-harness-parent-"));
  const { pidFile } = fakeHarness(dir);
  // A stand-in for the Electron/launcher process: it must stay alive until we
  // kill it, so the server starts normally and only then sees it disappear.
  const launcher = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  cleanups.push(() => { try { launcher.kill("SIGKILL"); } catch { /* gone */ } });
  await new Promise((resolve, reject) => {
    launcher.once("spawn", resolve);
    launcher.once("error", reject);
  });

  const { child, base } = await launchServer(dir, { SCOPE_PARENT_PID: String(launcher.pid) });
  const pid = await startHarness(dir, base, pidFile);

  launcher.kill("SIGKILL");
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, 15_000);
  assert.equal(alive(pid), false, "the harness followed the launcher's server down");
});
