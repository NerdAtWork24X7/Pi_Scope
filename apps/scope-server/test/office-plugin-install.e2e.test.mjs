// End-to-end tests for installing the Office as a *user* plugin.
//
// The Office ships self-contained (manifest + server + client bundle +
// stylesheet in one directory), so the same directory can be dropped into the
// user plugin root and override the built-in copy by id. That is what lets an
// upgraded Office ship without a new build of the app. This suite proves the
// whole path against the REAL server:
//
//   • the user copy is discovered as `source: "user"` and overrides the built-in,
//   • the app serves and runs THAT copy (its own manifest identity, its own
//     /office routes, and a marker appended to its bundle),
//   • its state lands in the user plugins' own store,
//   • the bundled browser loads it and draws the floor with its own stylesheet,
//   • uninstalling it falls back to the built-in without losing the board.
//
//   node --test apps/scope-server/test/office-plugin-install.e2e.test.mjs

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
const BUILTIN_OFFICE = path.join(ROOT, "apps", "scope-server", "plugins", "office");
const TOKEN = "office-install-token";
/** Lets the test prove the *user* copy is the one in play. */
const USER_COPY_NAME = "Office (user copy)";

let browser;
let child;
let base;
let tmpDir;
let pluginsDir;
let installedDir;
/** The workspace the test drives, so nothing resolves to the developer's repo. */
let ws;

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

/** The plugin record the server reports for the Office. */
const officeRecord = async () => (await api("/plugins")).data.plugins.find((p) => p.id === "office");
/** The workspace's office state, through the plugin's own route. */
const snapshot = async (cwd = ws) => (await api(`/office?cwd=${encodeURIComponent(cwd)}`)).data;
const storePath = () => path.join(pluginsDir, ".data", "office.json");

before(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-office-install-")));
  pluginsDir = path.join(tmpDir, "plugins");
  installedDir = path.join(pluginsDir, "office");
  ws = fs.mkdirSync(path.join(tmpDir, "ws"), { recursive: true }) || path.join(tmpDir, "ws");
  fs.mkdirSync(pluginsDir, { recursive: true });
  // "Install" it the documented way, then mark the copy so every layer of the
  // stack can prove which copy of the plugin is actually in play.
  fs.cpSync(BUILTIN_OFFICE, installedDir, { recursive: true });
  const manifestPath = path.join(installedDir, "plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.name = USER_COPY_NAME;
  manifest.version = "9.9.9";
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  fs.appendFileSync(path.join(installedDir, "client.js"), "\nwindow.__officeUserCopy = true;\n");

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
      SCOPE_AGENT_DIR: path.join(tmpDir, "agent"),
      SCOPE_FILE_ROOT: tmpDir,
      SCOPE_PI_BIN: "/bin/true",
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

describe("office installed as a user plugin", () => {
  test("the user copy overrides the built-in and keeps its own identity", async () => {
    const record = await officeRecord();
    assert.ok(record, "the office plugin is still listed (it was not shadowed out of the table)");
    assert.equal(record.source, "user", "the installed copy wins");
    assert.equal(record.enabled, true);
    assert.equal(record.name, USER_COPY_NAME, "the user copy's manifest is the one the app reports");
    assert.equal(record.version, "9.9.9");
    assert.equal(record.dir, installedDir, "and the user directory is where it loads from");
    assert.equal(record.hasServer, true, "the server half came with it");
    assert.equal(record.hasClient, true, "so did the client bundle");
    assert.match(record.clientUrl, /^\/plugins\/file\/office\//);
    // The built-in copy still exists on disk; it is simply not the active one.
    assert.ok(fs.existsSync(path.join(BUILTIN_OFFICE, "plugin.json")));
  });

  test("the installed copy's bundle, stylesheet and routes are what run", async () => {
    // The host serves files out of the *user* plugin directory.
    for (const file of ["client.js", "client.css", "server.ts"]) {
      const res = await fetch(`${base}/plugins/file/office/${file}?token=${TOKEN}`);
      assert.equal(res.status, 200, `${file} is served from the user plugin dir`);
    }
    const js = await (await fetch(`${base}/plugins/file/office/client.js?token=${TOKEN}`)).text();
    assert.match(js, /S\.Plugins\.register/, "it is the office bundle");
    assert.match(js, /__officeUserCopy/, "and it is the *installed* copy that is served");

    // Its own routes answer for a workspace the plugin has never touched.
    assert.deepEqual(await api(`/office?cwd=${encodeURIComponent(ws)}`).then((r) => r.data), { tasks: [], runnerPaused: true });
    await api("/office", { method: "POST", body: JSON.stringify({ action: "setOfficeName", name: "User Copy HQ", cwd: ws }) });
    assert.equal((await snapshot()).officeName, "User Copy HQ");

    // Its state is the user plugins' store, keyed by workspace.
    assert.ok(fs.existsSync(storePath()), "the store lives beside the user plugins");
    assert.equal(JSON.parse(fs.readFileSync(storePath(), "utf8")).workspaces[ws].officeName, "User Copy HQ");
  });

  test("the browser loads that copy: it runs its bundle and draws the floor with its stylesheet", async () => {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e?.message ?? e)));
    // Pin the workspace the app (and so the office view) works in, so the state
    // it reads is this test's and not whatever the server would default to.
    await page.addInitScript((cwd) => {
      try { localStorage.setItem("scope-cwd", cwd); } catch { /* private mode */ }
    }, ws);
    await page.goto(`${base}/?token=${TOKEN}#view=office`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#office-pane .office-room");
    assert.equal(await page.locator("#btn-office").count(), 1, "the installed plugin owns the nav button");
    // The marker appended to the installed bundle ran: this page is running the
    // user copy, not the one the app shipped with.
    assert.equal(await page.evaluate(() => window.__officeUserCopy), true, "the installed bundle is what executed");
    // Its stylesheet arrived with the bundle: the room's palette resolves.
    const floor = await page.locator("#office-pane .office-scene").evaluate((el) =>
      getComputedStyle(el).getPropertyValue("--office-floor").trim());
    assert.match(floor, /^#|rgb/, `the office palette is loaded (${floor || "missing"})`);
    // …and it is wired to the plugin's own routes: the name stored through
    // /office is the name on the wall.
    await page.waitForFunction(() => document.getElementById("office-name")?.textContent === "User Copy HQ");
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("removing the installed copy falls back to the built-in", async () => {
    // Uninstall: the override disappears and the shipped copy takes over again.
    // (Disabling first keeps the routes gated while the files are gone.)
    const off = await api("/plugins", { method: "POST", body: JSON.stringify({ action: "disable", id: "office" }) });
    assert.ok(off.res.ok);
    fs.rmSync(installedDir, { recursive: true, force: true });
    const reloaded = await api("/plugins", { method: "POST", body: JSON.stringify({ action: "reload" }) });
    assert.ok(reloaded.res.ok);
    let record = (reloaded.data.plugins || []).find((p) => p.id === "office");
    assert.ok(record, "the shipped copy is discovered again");
    assert.equal(record.source, "builtin");
    assert.equal(record.version, "1.0.0", "and it is the app's own copy");
    assert.equal(record.enabled, false, "the disable choice survives the uninstall");

    const on = await api("/plugins", { method: "POST", body: JSON.stringify({ action: "enable", id: "office" }) });
    assert.ok(on.res.ok);
    record = on.data.plugins.find((p) => p.id === "office");
    assert.equal(record.enabled, true);

    // Uninstalling must not take the user's board with it: the state is keyed by
    // workspace, not by which copy of the plugin is active.
    assert.equal((await snapshot()).officeName, "User Copy HQ");
  });
});
