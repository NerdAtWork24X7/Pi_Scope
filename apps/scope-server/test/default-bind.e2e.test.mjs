// The server binds every interface by default, so the header's phone button can
// render a scannable QR with no setup. Every other e2e suite pins
// SCOPE_HOST=127.0.0.1 (to stay hermetic), which is exactly why the default is
// otherwise untested — this file boots the real server WITHOUT SCOPE_HOST and
// asserts GET /lan advertises the LAN.
//
//   node --test apps/scope-server/test/default-bind.e2e.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const SERVER = path.join(ROOT, "apps", "scope-server", "server.ts");
const TOKEN = "default-bind-token";

let child = null;
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

before(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-default-bind-")));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  // Deliberately NO SCOPE_HOST: the default is what is under test.
  const env = { ...process.env, SCOPE_PORT: String(port), SCOPE_DB_PATH: path.join(tmpDir, "scope.db"), SCOPE_AUTH_TOKEN: TOKEN };
  delete env.SCOPE_HOST;
  child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  await waitForHealth();
});

after(async () => {
  if (child) {
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
  }
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("GET /lan advertises the LAN by default (the QR can be scanned)", async () => {
  const res = await fetch(`${base}/lan?token=${TOKEN}`);
  assert.ok(res.ok, `expected 200, got ${res.status}`);
  const data = await res.json();
  assert.equal(data.bind_host, "0.0.0.0", "the default bind is every interface");
  assert.equal(data.lan_exposed, true, "a wildcard bind is treated as LAN-exposed");
  // A machine with at least one routable IPv4 (the common case, and CI runners
  // included) must get scannable URLs. When there is genuinely no interface the
  // panel says so instead; accept that environment rather than fail on it.
  if (data.ips.length > 0) {
    assert.ok(data.urls.length > 0, "a reachable address yields a QR URL");
    assert.match(data.urls[0], /^http:\/\/[^/]+\/\?token=/, "the URL carries this run's token");
  }
});
