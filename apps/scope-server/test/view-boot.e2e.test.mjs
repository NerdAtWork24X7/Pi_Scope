// End-to-end tests for the view boot contract: a document that lands straight
// on a view (`#view=terminal`, a deep link, or the Chat nav's full reload) must
// get that view's first `onShow` — the feature scripts are parsed AFTER app.js,
// whose boot `setView()` fired the hook before it existed. Before the fix the
// Terminal never auto-reconnected (and git never adopted a draft started before
// a reload, trajectory/settings carried their own workarounds).
//
// The page is instrumented with property setters on the `window.__<view>…`
// hooks, so the test observes hook DELIVERY instead of a downstream side effect.
//
//   node --test apps/scope-server/test/view-boot.e2e.test.mjs

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
const TOKEN = "view-boot-token";

// Every view hook the feature scripts publish (single's lives in app.js and is
// bound BEFORE the boot setView, so it is deliberately not probed).
const HOOKS = [
  "__terminalOnShow",
  "__filesOnView",
  "__checkpointsOnView",
  "__gitOnView",
  "__chatOnView",
  "__trajectoryOnView",
  "__settingsOnView",
];

let browser;
let child;
let base;
let tmpDir;
let repoDir;

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
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-view-boot-")));
  repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(path.join(tmpDir, "plugins"), { recursive: true });
  fs.mkdirSync(repoDir, { recursive: true });

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
      SCOPE_PLUGINS_DIR: path.join(tmpDir, "plugins"),
      SCOPE_AGENT_DIR: path.join(tmpDir, "agent"),
      SCOPE_SETTINGS_JSON: path.join(tmpDir, "agent", "settings.json"),
      SCOPE_FILE_ROOT: repoDir,
      SCOPE_MODEL_CATALOG: "off",
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
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Open the app on `view` with an instrumented hook log. */
async function boot(view, { cwd } = {}) {
  const page = await browser.newPage();
  await page.addInitScript(({ hooks, cwd: dir }) => {
    window.__viewShowLog = [];
    if (dir) { try { localStorage.setItem("scope-cwd", dir); } catch { /* private mode */ } }
    for (const name of hooks) {
      let fn;
      Object.defineProperty(window, name, {
        configurable: true,
        get: () => fn,
        set: (value) => {
          // Record the CALL, not the assignment: a hook that is never called at
          // boot is exactly the bug this suite pins.
          fn = typeof value === "function"
            ? function (...args) { window.__viewShowLog.push(name); return value.apply(this, args); }
            : value;
        },
      });
    }
  }, { hooks: HOOKS, cwd });

  await page.goto(`${base}/?token=${TOKEN}#view=${view}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.SCOPE?.Plugins?.isSynced?.() === true, null, { timeout: 15_000 });
  return page;
}

const shows = (page) => page.evaluate(() => window.__viewShowLog);

describe("a deep link gets the view's first show", () => {
  test("the Terminal re-presents itself on a boot that lands on it", async () => {
    // The cleanest probe in the app: `terminal` declares ONLY onShow (no
    // onSessions/onCwd), so a delivered show is unambiguous. Before the fix this
    // log stayed empty and the pane sat on the shell chooser forever — a deep
    // link could not reconnect the shell the user last used.
    const page = await boot("terminal", { cwd: repoDir });
    await page.waitForFunction(() => window.__viewShowLog.includes("__terminalOnShow"), null, { timeout: 5000 });
    assert.deepEqual(await shows(page), ["__terminalOnShow"], "delivered exactly once");
    assert.ok(await page.locator("#terminal-mount").count(), "the terminal pane is mounted");
    await page.close();
  });

  test("the Files and Checkpoints views are shown on boot without waiting for a poll", async () => {
    for (const [view, hook] of [["files", "__filesOnView"], ["checkpoints", "__checkpointsOnView"]]) {
      const page = await boot(view, { cwd: repoDir });
      await page.waitForFunction((h) => window.__viewShowLog.includes(h), hook, { timeout: 5000 });
      const log = await shows(page);
      assert.equal(log.filter((h) => h === hook).length, 1, `${view}: shown exactly once`);
      await page.close();
    }
  });

  test("Settings is shown too (its ad-hoc boot workaround is gone)", async () => {
    const page = await boot("settings");
    await page.waitForFunction(() => window.__viewShowLog.includes("__settingsOnView"), null, { timeout: 5000 });
    // The hook is not a no-op: the panel leaves its "loading" state.
    await page.waitForFunction(
      () => !/Loading settings/i.test(document.querySelector("#settings-content")?.textContent || ""),
      null,
      { timeout: 10_000 }
    );
    await page.close();
  });

  test("the Chat view (the default landing) is shown", async () => {
    const page = await boot("chat", { cwd: repoDir });
    await page.waitForFunction(() => window.__viewShowLog.includes("__chatOnView"), null, { timeout: 5000 });
    assert.ok(await page.locator("#chat-composer").count(), "the chat composer is present");
    await page.close();
  });

  test("Trajectory announces itself once the session list is in", async () => {
    const page = await boot("trajectory");
    await page.waitForFunction(() => window.__viewShowLog.includes("__trajectoryOnView"), null, { timeout: 10_000 });
    await page.close();
  });

  test("a view that is not on screen is never shown, and ready() is idempotent", async () => {
    // ready() is a one-shot announcement: a view that is not active must not be
    // presented behind the user's back, and re-announcing must not re-show it.
    const page = await boot("terminal", { cwd: repoDir });
    const before = await shows(page);
    const after = await page.evaluate(() => {
      window.SCOPE.Plugins.ready("checkpoints");
      window.SCOPE.Plugins.ready("terminal");
      window.SCOPE.Plugins.ready("files");
      window.SCOPE.Plugins.ready("terminal");
      return window.__viewShowLog;
    });
    assert.deepEqual(after, before, "no hook fired for an inactive view, and no repeat show");
    // Switching to one of them does show it — the normal path still works.
    await page.evaluate(() => window.setView("checkpoints"));
    await page.waitForFunction(() => window.__viewShowLog.includes("__checkpointsOnView"), null, { timeout: 5000 });
    await page.close();
  });

  test("a view script that throws while presenting itself cannot break the boot", async () => {
    // `ready()` runs spec.view.onShow inside the host: a broken view must not
    // take the app (or the other views) down with it.
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e?.message ?? e)));
    await page.addInitScript(() => {
      window.__viewShowLog = [];
      let real;
      Object.defineProperty(window, "__gitOnView", {
        configurable: true,
        get: () => real,
        set: (fn) => {
          real = function () { window.__viewShowLog.push("__gitOnView"); throw new Error("view boom"); };
        },
      });
    });
    await page.goto(`${base}/?token=${TOKEN}#view=git`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.SCOPE?.Plugins?.isSynced?.() === true, null, { timeout: 15_000 });
    await page.waitForFunction(() => window.__viewShowLog.includes("__gitOnView"), null, { timeout: 5000 });
    // The app is alive and usable after the throwing show.
    assert.equal(await page.evaluate(() => window.SCOPE.Plugins.activeView()?.id), "git");
    await page.evaluate(() => window.setView("checkpoints"));
    assert.equal(await page.evaluate(() => window.SCOPE.Plugins.activeView()?.id), "checkpoints");
    assert.deepEqual(errors, [], "the throw was contained by the host");
    await page.close();
  });
});
