// End-to-end tests for Settings → Update: the /pi-update check + install flow.
//
// The install runs server-side and outlives the request that started it, so the
// suite also pins the install STATE a reloaded page reads (GET /pi-update and
// the /settings snapshot carry it) and the Settings card adopting an install it
// did not start.
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
const TOKEN = "pi-update-token";
const PKG = "@earendil-works/pi-coding-agent";
const INSTALLED = "1.0.3";
const LATEST = "1.1.0";

let child;
let base;
let registry;
let tmpDir;
let bundleDir;
let browser;
let slowFile;
let failFile;
let runsLog;
let extRunsLog;
let extFailFile;
let extSlowFile;

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
  fs.mkdirSync(path.join(tmpDir, "agent"), { recursive: true });
  fs.writeFileSync(path.join(bundleDir, "package.json"),
    JSON.stringify({ name: "pi-scope-pi-bundle", private: true, dependencies: { [PKG]: INSTALLED } }, null, 2));
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: PKG, version: INSTALLED }, null, 2));

  // Stub "pi update --extensions": record each call, optionally fail, and say
  // what it reconciled. PI_EXT_RUNS_LOG counts invocations; PI_EXT_FAIL_FILE
  // makes it exit non-zero.
  extRunsLog = path.join(tmpDir, "pi-ext-runs.log");
  extFailFile = path.join(tmpDir, "pi-ext-fail");
  extSlowFile = path.join(tmpDir, "pi-ext-slow");
  fs.writeFileSync(cli,
    "const fs = require('node:fs');\n" +
    "if (!process.argv.includes('--extensions')) {\n" +
    "  console.log('model store refreshed');\n" +
    "  process.exit(0);\n" +
    "}\n" +
    "if (process.env.PI_EXT_RUNS_LOG) fs.appendFileSync(process.env.PI_EXT_RUNS_LOG, 'run\\n');\n" +
    "if (process.env.PI_EXT_SLOW_FILE && fs.existsSync(process.env.PI_EXT_SLOW_FILE)) {\n" +
    "  const seconds = Number(fs.readFileSync(process.env.PI_EXT_SLOW_FILE, 'utf8')) || 0;\n" +
    "  if (seconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);\n" +
    "}\n" +
    "if (process.env.PI_EXT_FAIL_FILE && fs.existsSync(process.env.PI_EXT_FAIL_FILE)) {\n" +
    "  console.error('simulated extension failure');\n" +
    "  process.exit(1);\n" +
    "}\n" +
    "console.log('reconciled configured packages');\n");

  // Stub "npm install": rewrite the installed package version to 1.1.0.
  // NPM_SLOW_FILE makes it sleep that many seconds (a real install takes
  // minutes), NPM_FAIL_FILE makes it fail, NPM_RUNS_LOG counts invocations.
  runsLog = path.join(tmpDir, "npm-runs.log");
  slowFile = path.join(tmpDir, "npm-slow");
  failFile = path.join(tmpDir, "npm-fail");
  const npmStub = path.join(tmpDir, "npm-stub.sh");
  fs.writeFileSync(npmStub,
    "#!/bin/sh\n" +
    "set -e\n" +
    `if [ -n "$NPM_RUNS_LOG" ]; then printf 'run\\n' >> "$NPM_RUNS_LOG"; fi\n` +
    `if [ -n "$NPM_SLOW_FILE" ] && [ -f "$NPM_SLOW_FILE" ]; then sleep "$(cat "$NPM_SLOW_FILE")"; fi\n` +
    `if [ -n "$NPM_FAIL_FILE" ] && [ -f "$NPM_FAIL_FILE" ]; then echo 'npm ERR! simulated failure' >&2; exit 1; fi\n` +
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
      NPM_RUNS_LOG: runsLog,
      NPM_SLOW_FILE: slowFile,
      NPM_FAIL_FILE: failFile,
      PI_EXT_RUNS_LOG: extRunsLog,
      PI_EXT_FAIL_FILE: extFailFile,
      PI_EXT_SLOW_FILE: extSlowFile,
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

  test("update with extensions also reconciles the configured packages", async () => {
    const extRuns = () => (fs.existsSync(extRunsLog) ? fs.readFileSync(extRunsLog, "utf8").trim().split("\n").filter(Boolean).length : 0);
    const before = extRuns();
    const { res, data } = await api("/pi-update", { method: "POST", body: JSON.stringify({ action: "update", extensions: true }) });
    assert.ok(res.ok, data?.error);
    assert.equal(data.installed, LATEST);
    assert.equal(data.extensions.ok, true);
    assert.match(data.extensions.output, /reconciled configured packages/);
    assert.ok(data.extensions.at, "the extension step is timestamped");
    assert.equal(extRuns(), before + 1, "pi update --extensions ran exactly once");
  });

  test("an extension failure is reported without losing the agent update", async () => {
    const extRuns = () => (fs.existsSync(extRunsLog) ? fs.readFileSync(extRunsLog, "utf8").trim().split("\n").filter(Boolean).length : 0);
    fs.writeFileSync(extFailFile, "1");
    try {
      const before = extRuns();
      const { res, data } = await api("/pi-update", { method: "POST", body: JSON.stringify({ action: "update", extensions: true }) });
      assert.ok(res.ok, "the agent update itself still succeeded");
      assert.equal(data.installed, LATEST);
      assert.equal(data.extensions.ok, false);
      assert.match(data.extensions.error, /simulated extension failure/);
      assert.equal(extRuns(), before + 1);
    } finally {
      fs.rmSync(extFailFile, { force: true });
    }
  });

  test("a reloaded page can read the extension step while it is running", async () => {
    const updateState = async () => (await api("/pi-update")).data.update;
    fs.writeFileSync(extSlowFile, "3");
    const started = api("/pi-update", { method: "POST", body: JSON.stringify({ action: "update", extensions: true }) });
    try {
      const t0 = Date.now();
      let running = null;
      while (Date.now() - t0 < 15_000) {
        const up = await updateState();
        if (up?.extensions?.running) { running = up; break; }
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(running, "the extension step is reported as running");
      assert.ok(running.extensions.startedAt, "the running step is timestamped");

      const result = await started;
      assert.ok(result.res.ok, result.data?.error);
      assert.equal(result.data.extensions.ok, true);

      const snap = await updateState();
      assert.equal(snap.extensions.running, false);
      assert.equal(snap.extensions.startedAt, null);
      assert.equal(snap.extensions.last.ok, true);
      assert.ok(snap.extensions.last.at, "the extension outcome is timestamped");
    } finally {
      await started.catch(() => {});
      fs.rmSync(extSlowFile, { force: true });
    }
  });

  test("update without the option leaves extensions alone", async () => {
    const extRuns = () => (fs.existsSync(extRunsLog) ? fs.readFileSync(extRunsLog, "utf8").trim().split("\n").filter(Boolean).length : 0);
    const before = extRuns();
    const { res, data } = await api("/pi-update", { method: "POST", body: JSON.stringify({ action: "update" }) });
    assert.ok(res.ok, data?.error);
    assert.equal(data.extensions, undefined);
    assert.equal(extRuns(), before, "pi update --extensions did not run");
  });

  test("an install outlives the request that started it, and a second request joins it", async () => {
    const updateState = async () => (await api("/pi-update")).data.update;
    const runs = () => (fs.existsSync(runsLog) ? fs.readFileSync(runsLog, "utf8").trim().split("\n").filter(Boolean).length : 0);
    const waitFor = async (want, timeoutMs = 20_000) => {
      const t0 = Date.now();
      let last = null;
      while (Date.now() - t0 < timeoutMs) {
        last = await updateState();
        if (last?.running === want) return last;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`install never reported running=${want} (last: ${JSON.stringify(last)})`);
    };

    const before = runs();
    fs.writeFileSync(slowFile, "3");
    try {
      // The request is dropped (a reloaded page) — the install keeps going.
      const first = api("/pi-update", { method: "POST", body: JSON.stringify({ action: "update" }) });
      const running = await waitFor(true);
      assert.ok(running.startedAt, "a running install is timestamped");
      // A second request (re-click, another tab) joins the run instead of npm
      // installing twice.
      const second = api("/pi-update", { method: "POST", body: JSON.stringify({ action: "update" }) });
      const [a, b] = await Promise.all([first, second]);
      assert.ok(a.res.ok && b.res.ok, `joins failed: ${JSON.stringify([a.data, b.data])}`);
      assert.equal(runs(), before + 1, "npm install ran exactly once");

      const done = await waitFor(false);
      assert.equal(done.startedAt, null);
      assert.equal(done.last.ok, true);
      assert.equal(done.last.installed, LATEST);
      assert.ok(done.last.at, "the outcome is timestamped");
    } finally {
      fs.rmSync(slowFile, { force: true });
    }
  });

  test("a failed install is recorded for a client that lost the request", async () => {
    fs.writeFileSync(failFile, "1");
    try {
      const { res, data } = await api("/pi-update", { method: "POST", body: JSON.stringify({ action: "update" }) });
      assert.equal(res.status, 500);
      assert.match(String(data.error), /simulated failure/);

      const snap = (await api("/pi-update")).data.update;
      assert.equal(snap.running, false);
      assert.equal(snap.last.ok, false);
      assert.match(snap.last.error, /simulated failure/);
      // The version on disk is untouched, and a later install still succeeds.
      const onDisk = JSON.parse(fs.readFileSync(path.join(bundleDir, "node_modules", ...PKG.split("/"), "package.json"), "utf8"));
      assert.equal(onDisk.version, LATEST);
    } finally {
      fs.rmSync(failFile, { force: true });
    }
  });

  test("the settings snapshot carries the install state (no npm round trip)", async () => {
    const { res, data } = await api("/settings");
    assert.ok(res.ok);
    // `piInstall`, not `piUpdate`: the latter is the Settings client's own
    // npm-check status object (assigned from this same snapshot), so the install
    // state needs its own key.
    assert.ok(data.piInstall, "snapshot has piInstall");
    assert.equal(data.piInstall.running, false);
    assert.equal(typeof data.piInstall.last?.ok, "boolean");
    assert.equal(typeof data.piInstall.extensions?.running, "boolean");
    assert.equal(data.piUpdate, undefined, "the install state never shadows the status field");
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

describe("Settings → Update extension option", () => {
  test("the card offers it, checked by default, and sends it with the update", async () => {
    // Make a newer agent available again so Update pi is enabled (the previous
    // test left a failure outcome behind; the card still checks on entering).
    const pkgFile = path.join(bundleDir, "node_modules", ...PKG.split("/"), "package.json");
    fs.writeFileSync(pkgFile, JSON.stringify({ name: PKG, version: INSTALLED }, null, 2));
    const extRuns = () => (fs.existsSync(extRunsLog) ? fs.readFileSync(extRunsLog, "utf8").trim().split("\n").filter(Boolean).length : 0);
    const before = extRuns();

    const page = await browser.newPage();
    try {
      await page.goto(`${base}/?token=${TOKEN}#view=settings`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('.settings-nav-item[data-sec="update"]', { timeout: 15_000 });
      await page.click('.settings-nav-item[data-sec="update"]');
      await page.waitForSelector("#set-update-extensions", { timeout: 15_000 });
      assert.equal(await page.isChecked("#set-update-extensions"), true, "extensions update is on by default");
      assert.match(
        await page.evaluate(() => document.querySelector("#set-update-extensions")?.closest("label")?.textContent || ""),
        /Also update extensions/,
      );

      try {
        await page.waitForSelector("#set-update-run:not([disabled])", { timeout: 15_000 });
      } catch (err) {
        console.log("[ui] update card:", await page.textContent(".settings-panel"));
        throw err;
      }
      await page.click("#set-update-run");
      await page.waitForFunction(
        () => /Up to date/i.test(document.querySelector(".set-update-verdict")?.textContent || ""),
        null,
        { timeout: 30_000 },
      );
      await page.waitForSelector(".set-field-hint .set-update-verdict.ok", { timeout: 15_000 });
      assert.match(await page.textContent(".set-field-hint"), /Extensions reconciled/i);
      assert.equal(extRuns(), before + 1, "the update request carried the extension step");
    } finally {
      await page.close();
    }
  });

  test("a page opened during the extension step restores it and adopts the outcome", async () => {
    const updateState = async () => (await api("/pi-update")).data.update;
    fs.writeFileSync(extSlowFile, "5");
    const started = api("/pi-update", { method: "POST", body: JSON.stringify({ action: "update", extensions: true }) });
    const page = await browser.newPage();
    try {
      // Wait until the agent install is done and only the extension step is left:
      // exactly the window a reload used to lose.
      const t0 = Date.now();
      let running = null;
      while (Date.now() - t0 < 15_000) {
        const up = await updateState();
        if (up?.extensions?.running) { running = up; break; }
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(running, "the extension step is running before the page opens");

      await page.goto(`${base}/?token=${TOKEN}#view=settings`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('.settings-nav-item[data-sec="update"]', { timeout: 15_000 });
      await page.click('.settings-nav-item[data-sec="update"]');
      await page.waitForSelector(".set-update-verdict.busy", { timeout: 10_000 });
      assert.match(await page.textContent(".set-update-verdict.busy"), /Updating extensions/i);
      assert.equal(await page.isDisabled("#set-update-run"), true, "no parallel update while extensions reconcile");

      // The page follows it to the adopted outcome without being re-driven.
      await page.waitForSelector(".set-field-hint .set-update-verdict.ok", { timeout: 30_000 });
      assert.match(await page.textContent(".set-field-hint"), /Extensions reconciled/i);
      const result = await started;
      assert.ok(result.res.ok, result.data?.error);
    } finally {
      await page.close();
      await started.catch(() => {});
      fs.rmSync(extSlowFile, { force: true });
    }
  });
});

describe("Settings → Update adopts an install it did not start", () => {
  test("a page opened mid-install shows the busy card and then the finished state", async () => {
    // Reported class: the install runs server-side for minutes; the page that
    // asked for it can be gone (a reload) by the time it ends. The card must
    // restore the running state instead of offering a stale "update available",
    // and it must settle on the outcome on its own.
    fs.writeFileSync(slowFile, "8");
    const started = api("/pi-update", { method: "POST", body: JSON.stringify({ action: "update" }) });
    try {
      const page = await browser.newPage();
      await page.goto(`${base}/?token=${TOKEN}#view=settings`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('.settings-nav-item[data-sec="update"]', { timeout: 15_000 });
      await page.click('.settings-nav-item[data-sec="update"]');

      await page.waitForSelector(".set-update-verdict.busy", { timeout: 5000 });
      assert.match(await page.textContent(".set-update-verdict.busy"), /Installing/i);
      assert.equal(await page.isDisabled("#set-update-run"), true, "cannot start a second install");
      assert.equal(await page.textContent("#set-update-run"), "Updating…");

      // The page follows the install to completion without being re-driven.
      await page.waitForFunction(
        () => !!document.querySelector(".set-update-verdict.ok"),
        null,
        { timeout: 30_000 }
      );
      assert.match(await page.textContent(".set-update-verdict.ok"), /Up to date/i);
      assert.match(
        await page.textContent(".settings-panel"),
        new RegExp(LATEST.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      );
      assert.equal(await page.isDisabled("#set-update-run"), true, "nothing left to install");
      await page.close();
      const result = await started;
      assert.ok(result.res.ok, `install failed: ${JSON.stringify(result.data)}`);
    } finally {
      await started.catch(() => {});
      fs.rmSync(slowFile, { force: true });
    }
  });

  test("a stale outcome from an earlier install is not re-announced", async () => {
    // The card only announces what THIS page watched: opening Settings long
    // after an install finished shows the fresh status, with no replayed toast.
    const page = await browser.newPage();
    await page.addInitScript(() => {
      window.__toasts = [];
      const observe = () => {
        new MutationObserver(() => {
          const el = document.getElementById("settings-toast");
          if (el && el.classList.contains("show") && el.textContent) window.__toasts.push(el.textContent);
        }).observe(document.documentElement, {
          childList: true, subtree: true, characterData: true,
          attributes: true, attributeFilter: ["class"],
        });
      };
      if (document.body) observe(); else document.addEventListener("DOMContentLoaded", observe);
    });
    await page.goto(`${base}/?token=${TOKEN}#view=settings`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('.settings-nav-item[data-sec="update"]', { timeout: 15_000 });
    await page.click('.settings-nav-item[data-sec="update"]');
    await page.waitForSelector(".settings-panel", { timeout: 15_000 });
    await page.waitForFunction(() => !!document.querySelector(".set-update-verdict"), null, { timeout: 15_000 });
    // Long enough for the adopter's first poll (2 s interval) to run.
    await new Promise((r) => setTimeout(r, 3000));
    assert.deepEqual(await page.evaluate(() => window.__toasts), [], "no outcome was re-announced");
    assert.match(await page.textContent(".set-update-verdict"), /Up to date/i);
    await page.close();
  });

  test("a server that stops answering cannot leave the card stuck on Installing…", async () => {
    fs.writeFileSync(slowFile, "8");
    const started = api("/pi-update", { method: "POST", body: JSON.stringify({ action: "update" }) });
    try {
      const page = await browser.newPage();
      await page.goto(`${base}/?token=${TOKEN}#view=settings`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('.settings-nav-item[data-sec="update"]', { timeout: 15_000 });
      await page.click('.settings-nav-item[data-sec="update"]');
      await page.waitForSelector(".set-update-verdict.busy", { timeout: 5000 });

      // The install keeps running, but this page can no longer read its state.
      await page.route("**/pi-update*", (route) =>
        route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) })
      );
      await page.waitForFunction(
        () => !/Installing/i.test(document.querySelector(".set-update-verdict")?.textContent || ""),
        null,
        { timeout: 25_000 }
      );
      assert.match(await page.textContent(".set-update-verdict"), /Could not read the update state/i);
      assert.equal(await page.isDisabled("#set-update-run"), true, "no version data to update from");
      await page.close();
    } finally {
      await started.catch(() => {});
      fs.rmSync(slowFile, { force: true });
    }
  });
});
