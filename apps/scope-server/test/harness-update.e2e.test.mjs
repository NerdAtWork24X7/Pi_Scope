// End-to-end tests for Settings → Update → Coding harnesses.
//
// The server is run for real with a PATH that contains only stub CLIs, a local
// npm registry, and a stub npm. That keeps the suite hermetic: no real harness
// is probed or updated, and no network is touched.
//
//   node --test apps/scope-server/test/harness-update.e2e.test.mjs

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const SERVER = path.join(ROOT, "apps", "scope-server", "server.ts");
const TOKEN = "harness-update-token";
const LATEST = "2.0.0";

let child;
let base;
let registry;
let tmpDir;
let binDir;
let browser;
let claudeVersion;
let geminiVersion;

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

function writeStub(name, body) {
  const file = path.join(binDir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

before(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-harness-update-")));
  binDir = path.join(tmpDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  claudeVersion = path.join(tmpDir, "claude-version");
  geminiVersion = path.join(tmpDir, "gemini-version");
  fs.writeFileSync(claudeVersion, "1.0.0");
  fs.writeFileSync(geminiVersion, "1.0.0");

  // A self-updating harness (`claude update`) and a package-managed one
  // (gemini has no updater command). codex always fails so the failure path is
  // covered too.
  writeStub("claude", `
if [ "$1" = "--version" ]; then echo "$(cat "${claudeVersion}") (Claude Code)"; exit 0; fi
if [ "$1" = "update" ]; then echo "Claude Code updated"; echo "${LATEST}" > "${claudeVersion}"; exit 0; fi
exit 0`);
  writeStub("gemini", `if [ "$1" = "--version" ]; then cat "${geminiVersion}"; fi`);
  writeStub("codex", `
if [ "$1" = "--version" ]; then echo "codex-cli 1.0.0"; exit 0; fi
if [ "$1" = "update" ]; then echo "simulated codex failure" >&2; exit 1; fi
exit 0`);

  // Stub npm performs gemini's global install.
  writeStub("npm", `echo "installed @google/gemini-cli@${LATEST}"; echo "${LATEST}" > "${geminiVersion}"`);

  // Stub pi so the server never resolves a real bundle.
  const piStub = writeStub("pi", `exit 0`);

  registry = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    const packages = {
      "/@anthropic-ai/claude-code/latest": "@anthropic-ai/claude-code",
      "/@openai/codex/latest": "@openai/codex",
      "/@google/gemini-cli/latest": "@google/gemini-cli",
    };
    const name = packages[pathname];
    if (name) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name, version: LATEST }));
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
      SCOPE_PI_BIN: piStub,
      // Only the stubs resolve as harnesses; the real installs on this machine
      // (or a CI image's) must not leak into the assertions. The server itself
      // runs through absolute paths (process.execPath), so only /bin is kept for
      // the stubs' own `cat`/`echo`.
      PATH: `${binDir}:/bin`,
      SCOPE_SYSTEM_BIN_DIRS: binDir,
      SCOPE_HARNESS_REGISTRY: `http://127.0.0.1:${regPort}`,
      SCOPE_NPM_BIN: path.join(binDir, "npm"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  await waitForHealth();
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  if (browser) await browser.close();
  if (child) {
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
  }
  if (registry) await new Promise((r) => registry.close(r));
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

const row = (data, id) => (data.harnesses || []).find((h) => h.id === id);

describe("harness update API", () => {
  test("lists only installed harnesses, with their own updater", async () => {
    const { res, data } = await api("/harness-update");
    assert.ok(res.ok, data?.error);
    const ids = data.harnesses.map((h) => h.id).sort();
    assert.deepEqual(ids, ["claude", "codex", "gemini"], "one row per installed stub");

    const claude = row(data, "claude");
    assert.equal(claude.installed, "1.0.0");
    assert.equal(claude.latest, LATEST);
    assert.equal(claude.updateAvailable, true);
    assert.equal(claude.updatable, true);
    assert.equal(claude.manager, "cli");
    assert.equal(claude.command, "claude update");

    const gemini = row(data, "gemini");
    assert.equal(gemini.manager, "npm");
    assert.equal(gemini.command, `npm install -g @google/gemini-cli@latest`);
    assert.equal(gemini.updateAvailable, true);

    assert.deepEqual(data.update, { running: false, id: null, startedAt: null, last: null });
  });

  test("update runs the CLI's own updater and reports the new version", async () => {
    const { res, data } = await api("/harness-update", {
      method: "POST",
      body: JSON.stringify({ action: "update", id: "claude" }),
    });
    assert.ok(res.ok, data?.error);
    assert.equal(data.updated.installed, LATEST);
    assert.match(data.updated.output, /Claude Code updated/);
    assert.equal(row(data, "claude").installed, LATEST);
    assert.equal(row(data, "claude").updateAvailable, false);
    assert.equal(data.update.last.ok, true);
    assert.equal(data.update.last.id, "claude");
    assert.equal(data.update.last.installed, LATEST);
    assert.ok(data.update.last.at, "the outcome is timestamped");
  });

  test("a package-managed harness installs through npm", async () => {
    const { res, data } = await api("/harness-update", {
      method: "POST",
      body: JSON.stringify({ action: "update", id: "gemini" }),
    });
    assert.ok(res.ok, data?.error);
    assert.equal(row(data, "gemini").installed, LATEST);
    assert.equal(row(data, "gemini").updateAvailable, false);
    assert.match(String(data.updated.output), /installed @google\/gemini-cli/);
  });

  test("a failed updater is reported without touching the other rows", async () => {
    const { res, data } = await api("/harness-update", {
      method: "POST",
      body: JSON.stringify({ action: "update", id: "codex" }),
    });
    assert.equal(res.status, 500);
    assert.match(String(data.error), /simulated codex failure/);
    assert.equal(data.update.running, false);
    assert.equal(data.update.last.ok, false);
    assert.equal(data.update.last.id, "codex");
    assert.match(data.update.last.error, /simulated codex failure/);
    const after = await api("/harness-update");
    assert.equal(row(after.data, "codex").installed, "1.0.0", "version unchanged");
    assert.equal(row(after.data, "claude").installed, LATEST, "another row survived");
  });

  test("update-all skips up-to-date harnesses and reports each result", async () => {
    fs.writeFileSync(claudeVersion, "1.0.0");
    fs.writeFileSync(geminiVersion, "1.0.0");
    const forced = await api("/harness-update", { method: "POST", body: JSON.stringify({ action: "check" }) });
    assert.ok(forced.res.ok);
    assert.equal(row(forced.data, "claude").updateAvailable, true);
    assert.equal(row(forced.data, "gemini").updateAvailable, true);

    const { res, data } = await api("/harness-update", {
      method: "POST",
      body: JSON.stringify({ action: "update-all" }),
    });
    assert.ok(res.ok, data?.error);
    const results = data.results;
    // codex publishes a newer version too, so it is attempted and fails; the
    // other two succeed. That is exactly the per-row reporting this covers.
    assert.deepEqual(results.map((r) => r.id).sort(), ["claude", "codex", "gemini"]);
    assert.equal(results.find((r) => r.id === "claude").ok, true);
    assert.equal(results.find((r) => r.id === "gemini").ok, true);
    assert.equal(results.find((r) => r.id === "codex").ok, false);
    assert.equal(data.update.last.installed, "2/3");
    assert.equal(row(data, "claude").installed, LATEST);
    assert.equal(row(data, "gemini").installed, LATEST);
  });

  test("check bypasses the cache and unknown harnesses are refused", async () => {
    const check = await api("/harness-update", { method: "POST", body: JSON.stringify({ action: "check" }) });
    assert.ok(check.res.ok);
    assert.equal(row(check.data, "claude").installed, LATEST);
    const bad = await api("/harness-update", {
      method: "POST",
      body: JSON.stringify({ action: "update", id: "nope" }),
    });
    assert.equal(bad.res.status, 500);
    assert.match(String(bad.data.error), /unknown or not installed/);
    const action = await api("/harness-update", { method: "POST", body: JSON.stringify({ action: "nope" }) });
    assert.equal(action.res.status, 400);
  });

  test("Settings → Update shows the harness rows", async () => {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${base}/?token=${TOKEN}#view=settings`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('.settings-nav-item[data-sec="update"]', { timeout: 15_000 });
    await page.click('.settings-nav-item[data-sec="update"]');
    await page.waitForSelector(".set-harness-row", { timeout: 15_000 });
    const names = await page.$$eval(".set-harness-name b", (els) => els.map((e) => e.textContent));
    assert.deepEqual(names.sort(), ["Claude Code", "Codex CLI", "Gemini CLI"]);
    // claude and gemini are current after the tests above; codex still reports
    // an update and keeps its per-row button enabled.
    assert.match(await page.textContent(".settings-panel"), /Coding harnesses/);
    assert.match(await page.textContent(".settings-panel"), /Check harnesses|Update all/);
    assert.equal(errors.length, 0, `no page errors: ${errors.join("; ")}`);
    await page.close();
  });
});
