// End-to-end tests for the plugin architecture.
//
// Unlike chat.e2e.test.mjs (which drives a scripted mock backend), these tests
// run the REAL server (`node server.ts`) in a temp data directory, because the
// plugin host — discovery, enable/disable persistence, route gating, dynamic
// client-bundle loading — lives on the server and has no mock equivalent.
//
//   node --test apps/scope-server/test/plugins.e2e.test.mjs

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
const EXAMPLE_PLUGIN = path.join(ROOT, "examples", "plugins", "hello-insights");

const TOKEN = "plugin-test-token";
// Every built-in view. `office` is the standalone one: its client bundle is not
// in index.html — the host loads it from plugins/office/client.js at sync time,
// exactly like a user plugin's.
const BUILTIN_VIEWS = ["chat", "terminal", "files", "checkpoints", "git", "single", "office", "trajectory", "settings"];

let browser;
let child;
let base;
let tmpDir;
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
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not become healthy");
}

async function api(pathname, init = {}) {
  const res = await fetch(`${base}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers || {}) },
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { res, data };
}

async function openApp() {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e?.message ?? e)));
  await page.goto(`${base}/?token=${TOKEN}#view=single`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() =>
    window.SCOPE?.Plugins?.all?.().length > 0 && window.__SCOPE_STATE?.sessionsLoaded === true
  );
  // Wait for the async /plugins reconcile to finish so nav reflects the config.
  await page.waitForFunction(() => window.SCOPE.Plugins.isSynced());
  return { page, errors };
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-plugins-"));
  pluginsDir = path.join(tmpDir, "plugins");
  fs.mkdirSync(pluginsDir, { recursive: true });
  // Install the shipped example as a real user plugin.
  fs.cpSync(EXAMPLE_PLUGIN, path.join(pluginsDir, "hello-insights"), { recursive: true });

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
      SCOPE_PLUGINS_DIR: pluginsDir,
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

describe("plugin host (server)", () => {
  test("discovers built-in features and user plugins, activated and listed", async () => {
    const { res, data } = await api("/plugins");
    assert.ok(res.ok);
    assert.equal(data.pluginsDir, pluginsDir);

    const byId = new Map(data.plugins.map((p) => [p.id, p]));
    for (const id of BUILTIN_VIEWS) {
      const p = byId.get(id);
      assert.ok(p, `built-in plugin ${id} present`);
      assert.equal(p.source, "builtin");
      assert.equal(p.enabled, true);
    }
    const example = byId.get("hello-insights");
    assert.ok(example, "user plugin discovered");
    assert.equal(example.source, "user");
    assert.equal(example.hasServer, true);
    assert.equal(example.hasClient, true);
    assert.match(example.clientUrl, /^\/plugins\/file\/hello-insights\//);
  });

  test("a user plugin's server module exposes its route and observes events", async () => {
    const evt = {
      event_id: "plugin-test-1", session_id: "s-plugin", seq: 0,
      ts: "2026-10-06T00:00:00.000Z", type: "tool_call",
      payload: { name: "bash" },
    };
    const post = await fetch(`${base}/events`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(evt),
    });
    assert.ok(post.ok);

    const { res, data } = await api("/hello-insights/summary");
    assert.ok(res.ok);
    assert.equal(data.ok, true);
    assert.ok(data.total >= 1, "event counter advanced");
    assert.ok(data.byType.some((r) => r.type === "tool_call"));
  });

  test("a user plugin's client bundle is token-gated", async () => {
    const open = await fetch(`${base}/plugins/file/hello-insights/client.js?token=${TOKEN}`);
    assert.equal(open.status, 200);
    assert.match(open.headers.get("content-type"), /javascript/);
    const gated = await fetch(`${base}/plugins/file/hello-insights/client.js`);
    assert.equal(gated.status, 401);
  });

  test("disabling a feature refuses its server routes but leaves core routes alone", async () => {
    const off = await api("/plugins", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "disable", id: "git" }),
    });
    assert.ok(off.res.ok);
    assert.equal(off.data.plugins.find((p) => p.id === "git").enabled, false);

    const git = await api("/git/status?cwd=/tmp");
    assert.equal(git.res.status, 403);
    assert.equal(git.data.plugin, "git");

    // Core infrastructure (the session store the rail reads) is unaffected.
    const sessions = await api("/sessions");
    assert.equal(sessions.res.status, 200);

    // The choice is persisted.
    const cfg = JSON.parse(fs.readFileSync(path.join(pluginsDir, "plugins.json"), "utf8"));
    assert.ok(cfg.disabled.includes("git"));

    const on = await api("/plugins", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "enable", id: "git" }),
    });
    assert.equal(on.data.plugins.find((p) => p.id === "git").enabled, true);
    const gitBack = await api("/git/status?cwd=/tmp");
    assert.notEqual(gitBack.res.status, 403);
  });
});

describe("plugin host (client)", () => {
  test("the header nav is rendered from the registry", async () => {
    const { page, errors } = await openApp();
    for (const id of BUILTIN_VIEWS) {
      assert.equal(await page.locator(`#btn-${id}`).count(), 1, `#btn-${id} exists`);
    }
    // A user plugin contributed its own nav button.
    assert.equal(await page.locator("#btn-hello-insights").count(), 1);

    // Settings is an icon button in the header's right cluster, next to the live
    // status — not a text button in the centre view toggle.
    assert.equal(await page.locator("#header-actions #btn-settings").count(), 1, "Settings sits in #header-actions");
    assert.equal(await page.locator("#view-toggle #btn-settings").count(), 0, "Settings left the view toggle");
    assert.equal(await page.locator("#header-actions #btn-settings svg").count(), 1, "Settings shows an icon");
    const gear = await page.locator("#header-actions #btn-settings").boundingBox();
    const live = await page.locator("#live-indicator").boundingBox();
    assert.ok(gear && live && gear.x > live.x, "Settings sits right of the live status");
    const box = await page.locator("#header-actions #btn-settings").evaluate((el) => {
      const s = getComputedStyle(el);
      return { w: s.width, h: s.height, r: s.borderRadius };
    });
    assert.equal(box.w, box.h, "gear button is square");
    const rNum = parseFloat(box.r);
    const round = box.r.includes("%") ? rNum >= 50 : rNum >= parseFloat(box.w) / 2;
    assert.ok(round, `gear button is circular (${box.r} on ${box.w})`);

    // Narrower than the header's single-row minimum: the nav wraps and the
    // right cluster (live status + Settings) stays pinned — never pushed off.
    await page.setViewportSize({ width: 1000, height: 720 });
    await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth);
    const narrow = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      gear: document.querySelector("#header-actions #btn-settings")?.getBoundingClientRect(),
      header: document.querySelector("header").getBoundingClientRect(),
    }));
    assert.equal(narrow.overflow, false, "no horizontal overflow at 1000px");
    assert.ok(narrow.gear && narrow.gear.right <= narrow.header.right, "gear stays inside the header at 1000px");
    await page.setViewportSize({ width: 1280, height: 720 });

    // ...and it actually opens Settings from its new home.
    await page.locator("#header-actions #btn-settings").click();
    await page.waitForFunction(() => window.__SCOPE_STATE?.view === "settings");
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("setView switches the plugin's pane without knowing any view by name", async () => {
    const { page } = await openApp();
    assert.notEqual(await page.locator("#single-pane").evaluate((e) => e.style.display), "none");
    await page.evaluate(() => window.setView("git"));
    await page.waitForFunction(() => document.getElementById("git-pane").style.display !== "none");
    assert.equal(await page.locator("#single-pane").evaluate((e) => e.style.display), "none");
    assert.ok(await page.locator("#btn-git.active").count() === 1);
    await page.close();
  });

  test("a user plugin's view renders and calls its own server route", async () => {
    const { page, errors } = await openApp();
    await page.evaluate(() => window.setView("hello-insights"));
    await page.waitForFunction(() => document.getElementById("hello-insights-pane").style.display !== "none");
    // render() built the pane; refreshing hits /hello-insights/summary.
    await page.click("#hi-refresh");
    await page.waitForFunction(() => /events ingested/.test(document.getElementById("hi-status")?.textContent || ""));
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("a deep link to a user plugin's view is restored once its bundle loads", async () => {
    // The registry does not contain hello-insights when app.js boots, so this
    // exercises the deferred deep-link path in plugins.js.
    const page = await browser.newPage();
    await page.goto(`${base}/?token=${TOKEN}#view=hello-insights`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.SCOPE?.Plugins?.isSynced?.() === true);
    await page.waitForFunction(() => window.__SCOPE_STATE?.view === "hello-insights");
    assert.notEqual(await page.locator("#hello-insights-pane").evaluate((e) => e.style.display), "none");
    await page.close();
  });

  test("a built-in plugin's own client bundle, view and server route work end to end", async () => {
    // The Office is the standalone built-in: it ships client.js + client.css +
    // server.ts in its plugin directory, so this drives the whole path against
    // the real server — the host serving the bundle, the view registering
    // itself, and a write landing in the plugin's own store via /office.
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e?.message ?? e)));
    await page.goto(`${base}/?token=${TOKEN}#view=office`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#office-pane .office-room");
    assert.equal(await page.locator("#btn-office.active").count(), 1, "the Office view is active");

    // The plugin's own stylesheet came with the bundle: the room's palette is
    // defined by client.css, not by the core stylesheet.
    const floor = await page.locator("#office-pane .office-scene").evaluate((el) =>
      getComputedStyle(el).getPropertyValue("--office-floor").trim());
    assert.match(floor, /^#|rgb/, `the office palette is loaded (${floor || "missing"})`);

    await page.click("#office-name");
    await page.waitForSelector("#office-name-input");
    await page.fill("#office-name-input", "Night Shift HQ");
    await page.click("#office-dlg-backdrop .office-dialog-ok");
    await page.waitForFunction(() => document.getElementById("office-name")?.textContent === "Night Shift HQ");

    // The write reached the plugin's route…
    const { res, data } = await api(`/office?cwd=${encodeURIComponent(ROOT)}`);
    assert.ok(res.ok);
    assert.equal(data.officeName, "Night Shift HQ");
    // …and its own store, which is namespaced per plugin. The view's cwd is the
    // server's launch dir, so the bucket is found rather than assumed.
    const store = JSON.parse(fs.readFileSync(path.join(pluginsDir, ".data", "office.json"), "utf8"));
    assert.ok(
      Object.values(store.workspaces).some((w) => w.officeName === "Night Shift HQ"),
      "the office name is in the plugin's own store",
    );

    // Disabling the plugin takes the view away with it (routes and bundle).
    await api("/plugins", { method: "POST", body: JSON.stringify({ action: "disable", id: "office" }) });
    assert.equal((await api("/office")).res.status, 403, "the plugin's routes are gated");
    await api("/plugins", { method: "POST", body: JSON.stringify({ action: "enable", id: "office" }) });
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("Settings → Plugins lists features and toggling one removes its nav button", async () => {
    const { page } = await openApp();
    await page.evaluate(() => window.setView("settings"));
    await page.click('.settings-nav-item[data-sec="plugins"]');
    await page.waitForSelector('label[data-plugin-toggle="git"]');
    // Every built-in view is listed; Settings itself is core (not toggleable).
    assert.equal(await page.locator('label[data-plugin-toggle="chat"]').count(), 1);
    assert.equal(await page.locator('label[data-plugin-toggle="settings"]').count(), 0);

    await page.evaluate(() => document.querySelector('label[data-plugin-toggle="git"]').click());
    await page.waitForFunction(() => !document.getElementById("btn-git"));
    await page.waitForSelector('label[data-plugin-toggle="git"] input:not(:checked)');

    // Turning it back on restores the view.
    await page.evaluate(() => document.querySelector('label[data-plugin-toggle="git"]').click());
    await page.waitForFunction(() => !!document.getElementById("btn-git"));
    await page.close();
  });
});
