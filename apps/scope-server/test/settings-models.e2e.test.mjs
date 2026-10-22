// End-to-end test for the model refresh control in Settings → Models.
//
// The refresh used to live on the Update tab; it now sits in the Models tab
// under the Model cost table, and a click must re-check every provider and
// update that list. This drives the REAL server (against a stub `pi` and a local
// models.dev stand-in) in headless Chromium, so the whole path is covered:
// button click → POST /pi-update {action:"refresh-models"} → pi rewrites
// models-store.json → GET /settings re-read → the new rows appear.
//
//   node --test apps/scope-server/test/settings-models.e2e.test.mjs

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import * as http from "node:http";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import { sleep } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const SERVER = path.join(ROOT, "apps", "scope-server", "server.ts");
const TOKEN = "settings-models-token";

/** The provider/model store the stub `pi` writes when asked to update models. */
const REFRESHED_STORE = {
  stubprovider: { models: [{ id: "stub-model-1", contextWindow: 4096, maxTokens: 512, cost: { input: 1, output: 2 } }] },
};

let browser;
let child;
let base;
let tmpDir;
let agentDir;
let modelsDev;
let opencodeModels;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

/** A stub `pi` that, like the real `pi update --models`, rewrites the model
 *  store inside $PI_CODING_AGENT_DIR — so a click that fails to reach pi would
 *  leave the list unchanged and fail the test. */
function writeStubPi(dir) {
  const file = path.join(dir, "pi");
  const store = JSON.stringify(REFRESHED_STORE);
  fs.writeFileSync(file, [
    "#!/bin/sh",
    'case " $* " in',
    '  *" update --models "*)',
    `    printf '%s' ${JSON.stringify(store)} > "$PI_CODING_AGENT_DIR/models-store.json"`,
    "    echo 'Model catalogs refreshed' ;;",
    "  *) echo 'unexpected pi invocation' >&2; exit 2 ;;",
    "esac",
    "",
  ].join("\n"));
  fs.chmodSync(file, 0o755);
}

async function waitForHealth(timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* not up */ }
    await sleep(200);
  }
  throw new Error("server did not become healthy");
}

async function api(pathname, init = {}) {
  const res = await fetch(`${base}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers || {}) },
  });
  return { res, data: await res.json().catch(() => null) };
}

/** Open the Settings page on `sec` and wait for the panel to render. */
async function openSection(sec) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e?.message ?? e)));
  await page.goto(`${base}/?token=${TOKEN}#view=settings`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(`.settings-nav-item[data-sec="${sec}"]`);
  await page.click(`.settings-nav-item[data-sec="${sec}"]`);
  await page.waitForSelector(".settings-panel");
  return { page, errors };
}

before(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-settings-models-")));
  agentDir = path.join(tmpDir, "agent");
  const stubDir = path.join(tmpDir, "bin");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(stubDir, { recursive: true });
  writeStubPi(stubDir);

  // A stub opencode whose `models` answer the test rewrites. The refresh must
  // ask it again, not answer from the five-minute cache.
  opencodeModels = path.join(tmpDir, "opencode-models.txt");
  fs.writeFileSync(opencodeModels, "acme/old-model\n");
  const opencode = path.join(stubDir, "opencode");
  fs.writeFileSync(opencode, `#!/bin/sh\ncat ${JSON.stringify(opencodeModels)}\n`, { mode: 0o755 });

  // The providers the app already knows about, before any refresh. More than
  // one model is what makes the default-model picker searchable.
  fs.writeFileSync(path.join(agentDir, "models-store.json"), JSON.stringify({
    firstprovider: { models: [
      { id: "first-model", cost: { input: 3, output: 4 } },
      { id: "first-fast", cost: { input: 1, output: 1 } },
    ] },
    secondprovider: { models: [{ id: "second-model", cost: { input: 5, output: 6 } }] },
  }, null, 2));

  // A local models.dev stand-in, so the release-cache half never hits the network.
  const devPort = await freePort();
  modelsDev = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      google: { models: { "gemini-2.5-pro": { family: "gemini", release_date: "2025-06-17", type: "chat" } } },
    }));
  });
  await new Promise((r) => modelsDev.listen(devPort, "127.0.0.1", r));

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
      SCOPE_AGENT_DIR: agentDir,
      SCOPE_PLUGINS_DIR: path.join(tmpDir, "plugins"),
      SCOPE_TOKEN_FILE: path.join(tmpDir, "scope_token"),
      SCOPE_PI_BIN: path.join(stubDir, "pi"),
      SCOPE_MODELS_DEV_URL: `http://127.0.0.1:${devPort}/api.json`,
      // One harness that can list its own models. The others are pinned to a
      // missing path so the refresh is deterministic on a developer machine
      // that happens to have kilo or cursor installed.
      SCOPE_HARNESS_BIN_OPENCODE: path.join(stubDir, "opencode"),
      SCOPE_HARNESS_BIN_KILO: path.join(stubDir, "missing-kilo"),
      SCOPE_HARNESS_BIN_CURSOR: path.join(stubDir, "missing-cursor"),
      // Protocol-backed harnesses are pinned away too: a developer machine with
      // Claude/Codex/Gemini installed must not make this test spawn them.
      SCOPE_HARNESS_BIN_CLAUDE: path.join(stubDir, "missing-claude"),
      SCOPE_HARNESS_BIN_CODEX: path.join(stubDir, "missing-codex"),
      SCOPE_HARNESS_BIN_GEMINI: path.join(stubDir, "missing-gemini"),
      SCOPE_HARNESS_BIN_CLINE: path.join(stubDir, "missing-cline"),
      // No background refresh, so the click is the only thing that can change the list.
      SCOPE_MODEL_CATALOG: "off",
      PI_OFFLINE: "1",
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
  if (modelsDev) await new Promise((r) => modelsDev.close(r));
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("settings → models → model update", () => {
  test("the refresh control lives in Models, between the memory model and Model cost", async () => {
    const { page, errors } = await openSection("models");
    await page.waitForSelector("#set-models-refresh");

    // The providers the app knows about before the click, straight from the store.
    assert.ok(await page.$('[data-cost-key="firstprovider/first-model"]'),
      "the seeded provider is listed in the cost table");

    const placement = await page.evaluate(() => {
      const panel = document.querySelector(".settings-panel");
      const mem = panel.querySelector('select[data-act="setMemoryModel"]');
      const card = panel.querySelector("#set-models-refresh");
      const table = panel.querySelector(".set-cost-table");
      if (!mem || !card || !table) return "missing";
      const after = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      return `${after(mem, card)}/${after(card, table)}`;
    });
    assert.equal(placement, "true/true",
      "the control sits below the memory model and above the Model cost table");

    // And it is gone from the Update tab it used to live on.
    await page.click('.settings-nav-item[data-sec="update"]');
    await page.waitForSelector(".settings-panel .set-update-card");
    assert.equal(await page.$(".settings-panel #set-models-refresh"), null,
      "the Update tab no longer offers the model refresh");

    assert.deepEqual(errors, [], "no page errors");
    await page.close();
  });

  test("the default-model picker filters the catalogue as you type", async () => {
    const { page, errors } = await openSection("models");
    const sel = page.locator('select[data-model-select][data-act="setDefaultModel"]');
    await sel.waitFor();
    const all = await sel.locator("option").count();
    assert.ok(all > 2, `the catalogue offers more than one model (${all})`);

    // Center it first, then let Playwright's scroll settle: the picker closes on
    // a scroll it did not originate, so a click that races the scroll event
    // opens and immediately closes the panel.
    await sel.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(150);
    await sel.click();
    await page.waitForSelector(".scope-sel-pop:not([hidden])");
    assert.equal(await page.locator(".scope-sel-opt").count(), all, "every option is listed to start with");
    await page.keyboard.type("fast");
    const rows = await page.locator(".scope-sel-opt .scope-sel-name").allInnerTexts();
    assert.equal(rows.length, 1, `one row matches (${rows})`);
    assert.match(rows[0], /fast/);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".scope-sel-pop")?.hidden === true);
    assert.equal(await sel.inputValue(), "firstprovider/first-fast", "Enter picks the match");
    let saved = "";
    for (let i = 0; i < 50 && saved !== "firstprovider/first-fast"; i++) {
      saved = (await api("/settings")).data.defaultModel;
      if (saved !== "firstprovider/first-fast") await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(saved, "firstprovider/first-fast", "the pick is written like any other change");
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("clicking it fetches every provider and updates the list", async () => {
    const { page, errors } = await openSection("models");
    await page.waitForSelector("#set-models-refresh");
    assert.equal(await page.$('[data-cost-key="stubprovider/stub-model-1"]'), null,
      "the refreshed provider is not listed yet");

    await page.click("#set-models-refresh");

    // The click round-trips: pi rewrites the store, the page re-reads /settings.
    await page.waitForSelector('[data-cost-key="stubprovider/stub-model-1"]', { timeout: 15_000 });
    assert.equal(await page.$('[data-cost-key="firstprovider/first-model"]'), null,
      "the list now reflects the freshly fetched store");
    assert.equal(await page.$eval("#set-models-refresh", (b) => b.disabled), false,
      "the button returns to its idle state");

    assert.deepEqual(errors, [], "no page errors");
    await page.close();
  });

  test("refreshing models also re-asks every harness CLI", async () => {
    // Warm the server's five-minute harness cache with the old answer.
    const before = await api("/chat/harness-models?harness=opencode");
    assert.equal(before.res.status, 200);
    assert.deepEqual(before.data.models, ["acme/old-model"]);

    fs.writeFileSync(opencodeModels, "acme/new-model\n");
    const { res, data } = await api("/pi-update", {
      method: "POST",
      body: JSON.stringify({ action: "refresh-models" }),
    });
    assert.equal(res.status, 200);
    const opencode = (data.harnessModels || []).find((h) => h.id === "opencode");
    assert.ok(opencode, "the response reports the harness that was asked");
    assert.deepEqual(opencode.models, ["acme/new-model"], "the refresh bypassed the cached list");

    // The server cache now holds the fresh answer, so Chat/Workflow asking
    // normally (no refresh flag) still see it.
    const after = await api("/chat/harness-models?harness=opencode");
    assert.deepEqual(after.data.models, ["acme/new-model"]);
  });
});
