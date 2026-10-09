// End-to-end tests for Settings → Update: the /pi-update check + install flow.
//
// The server is run for real against a temporary pi bundle (SCOPE_PI_BUNDLE_DIR)
// whose installed pi-coding-agent version is 1.0.3. A tiny local HTTP server
// stands in for the npm registry and advertises 1.1.0, and a stub "npm" script
// performs the "install" by rewriting the package.json. That keeps the test
// hermetic: no real npm, no real network.
//
//   node --test apps/scope-server/test/pi-update.e2e.test.mjs

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const SERVER = path.join(ROOT, "apps", "scope-server", "server.ts");
const TOKEN = "pi-update-token";
const PKG = "@earendil-works/pi-coding-agent";
const INSTALLED = "1.0.3";
const LATEST = "1.1.0";

let child;
let base;
let registry;
let tmpDir;
let bundleDir;

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

before(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-pi-update-")));
  bundleDir = path.join(tmpDir, "pi-bundle");
  const pkgDir = path.join(bundleDir, "node_modules", ...PKG.split("/"));
  const cli = path.join(pkgDir, "dist", "bundle", "cli.js");
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(path.join(bundleDir, "package.json"),
    JSON.stringify({ name: "pi-scope-pi-bundle", private: true, dependencies: { [PKG]: INSTALLED } }, null, 2));
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: PKG, version: INSTALLED }, null, 2));
  fs.writeFileSync(cli, "// stub pi cli\n");

  // Stub "npm install": rewrite the installed package version to 1.1.0.
  const npmStub = path.join(tmpDir, "npm-stub.sh");
  fs.writeFileSync(npmStub,
    "#!/bin/sh\n" +
    "set -e\n" +
    `printf '{"name":"${PKG}","version":"${LATEST}"}\\n' > "node_modules/${PKG}/package.json"\n` +
    "echo 'added 1 package'\n");
  fs.chmodSync(npmStub, 0o755);

  // Local npm registry advertising the newer version.
  registry = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (pathname === `/${PKG}/latest`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: PKG, version: LATEST }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  const regPort = await freePort();
  await new Promise((r) => registry.listen(regPort, "127.0.0.1", r));

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      SCOPE_PORT: String(port),
      SCOPE_HOST: "127.0.0.1",
      SCOPE_DB_PATH: path.join(tmpDir, "scope.db"),
      SCOPE_AUTH_TOKEN: TOKEN,
      SCOPE_AGENT_DIR: path.join(tmpDir, "agent"),
      SCOPE_PLUGINS_DIR: path.join(tmpDir, "plugins"),
      SCOPE_TOKEN_FILE: path.join(tmpDir, "scope_token"),
      // Use our throwaway bundle (not a global pi) and hermetic registry/npm.
      SCOPE_PI_BIN: "",
      SCOPE_PI_BUNDLE_DIR: bundleDir,
      SCOPE_PI_REGISTRY: `http://127.0.0.1:${regPort}`,
      SCOPE_NPM_BIN: npmStub,
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
  if (registry) await new Promise((r) => registry.close(r));
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("pi update", () => {
  test("check reports the installed and latest versions", async () => {
    const { res, data } = await api("/pi-update");
    assert.ok(res.ok);
    assert.equal(data.source, "bundled");
    assert.equal(data.installed, INSTALLED);
    assert.equal(data.latest, LATEST);
    assert.equal(data.updateAvailable, true);
    assert.equal(data.updatable, true);
    assert.equal(data.bundleDir, bundleDir);
    assert.ok(data.checkedAt, "check is timestamped");
    assert.equal(data.error, undefined);
  });

  test("update installs the newer version and reports it up to date", async () => {
    const { res, data } = await api("/pi-update", { method: "POST", body: JSON.stringify({ action: "update" }) });
    assert.ok(res.ok, data?.error);
    assert.equal(data.installed, LATEST);
    assert.equal(data.latest, LATEST);
    assert.equal(data.updateAvailable, false);
    // The install actually changed the on-disk package.
    const onDisk = JSON.parse(fs.readFileSync(path.join(bundleDir, "node_modules", ...PKG.split("/"), "package.json"), "utf8"));
    assert.equal(onDisk.version, LATEST);

    // A follow-up check stays up to date.
    const after = await api("/pi-update");
    assert.equal(after.data.installed, LATEST);
    assert.equal(after.data.updateAvailable, false);
  });

  test("the check action is read-only and unknown actions are refused", async () => {
    const before = fs.readFileSync(path.join(bundleDir, "node_modules", ...PKG.split("/"), "package.json"), "utf8");
    const check = await api("/pi-update", { method: "POST", body: JSON.stringify({ action: "check" }) });
    assert.ok(check.res.ok);
    assert.equal(check.data.installed, LATEST);
    const after = fs.readFileSync(path.join(bundleDir, "node_modules", ...PKG.split("/"), "package.json"), "utf8");
    assert.equal(after, before, "check did not touch the install");

    const bad = await api("/pi-update", { method: "POST", body: JSON.stringify({ action: "nope" }) });
    assert.equal(bad.res.status, 400);
  });
});
