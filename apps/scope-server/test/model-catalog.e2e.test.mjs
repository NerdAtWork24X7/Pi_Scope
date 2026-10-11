// End-to-end tests for the model-catalog refresher.
//
// Pi Scope runs pi with PI_OFFLINE=1, so pi itself no longer refreshes
// `models-store.json` (its provider/model store) or `model-update-cache.json`
// (the pi-updater extension's models.dev cache) while the app is in use. The
// app now does it: while the server is up it refreshes whichever file has gone
// past the TTL (and creates the ones that are missing), and the Settings → Update
// endpoint can force it.
//
// These tests run the REAL server against a stub `pi` (SCOPE_PI_BIN) and a local
// models.dev stand-in (SCOPE_MODELS_DEV_URL), so both halves — pi's own command
// and the HTTP catalog — are exercised without touching the network or the
// user's real agent dir.
//
//   node --test apps/scope-server/test/model-catalog.e2e.test.mjs

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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const SERVER = path.join(ROOT, "apps", "scope-server", "server.ts");
const TOKEN = "model-catalog-token";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A models.dev-shaped catalog. The second google entry has no `release_date`
 *  and the embeddings entry is not a chat model: both must be dropped. */
const CATALOG = {
  google: {
    models: {
      "gemini-2.5-pro": { family: "gemini", release_date: "2025-06-17", type: "chat" },
      "broken-entry": { family: "gemini" },
    },
  },
  openai: {
    models: {
      "gpt-5": { family: "gpt", release_date: "2025-08-07", canonical_model_id: "openai/gpt-5" },
    },
  },
  embedders: {
    models: { "text-embed": { family: "embed", release_date: "2024-01-01", type: "embedding" } },
  },
};

let tmpDir;
let stubDir;
let badStubDir;
let stubLog;
let modelsDev;
let modelsDevUrl;
/** What the local models.dev stand-in serves; the failure test flips this. */
let catalogBody = CATALOG;
let catalogHits = 0;

let browser;
let auto;   // server with the background scheduler on
let manual; // server with it off, so explicit refreshes are deterministic
let fresh;  // server whose agent dir has no catalogs at all
let empty;  // no catalogs, scheduler off — for the failure paths
let broken; // no catalogs, and a `pi` whose update fails

const agentOf = (name) => path.join(tmpDir, name);
const storePath = (name) => path.join(agentOf(name), "models-store.json");
const cachePath = (name) => path.join(agentOf(name), "model-update-cache.json");

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

/** A stub `pi` standing in for the bundled agent. It records the argv and the
 *  agent dir it was handed, and — like the real `pi update --models` — rewrites
 *  (or, when there is none, creates) the model store inside
 *  $PI_CODING_AGENT_DIR. If the app failed to pin that variable, the store would
 *  not change and the test would fail. */
function writeStubPi(dir, log) {
  const file = path.join(dir, "pi");
  fs.writeFileSync(file, [
    "#!/bin/sh",
    `{ printf '%s\\n' "$@"; printf 'PI_CODING_AGENT_DIR=%s\\n' "$PI_CODING_AGENT_DIR"; } >> ${JSON.stringify(log)}`,
    'case " $* " in',
    '  *" update --models "*)',
    "    printf '%s' '{\"stubprovider\":{\"models\":[{\"id\":\"stub-model-1\"}]}}' > \"$PI_CODING_AGENT_DIR/models-store.json\"",
    "    echo 'Model catalogs refreshed' ;;",
    "  *) echo 'unexpected pi invocation' >&2; exit 2 ;;",
    "esac",
    "",
  ].join("\n"));
  fs.chmodSync(file, 0o755);
}

/** A stub `pi` whose update fails, to prove a failed run creates nothing. */
function writeFailingPi(dir, log) {
  const file = path.join(dir, "pi");
  fs.writeFileSync(file, [
    "#!/bin/sh",
    `printf '%s\\n' "$@" >> ${JSON.stringify(log)}`,
    "echo 'could not reach the registry' >&2",
    "exit 3",
    "",
  ].join("\n"));
  fs.chmodSync(file, 0o755);
}

async function waitForHealth(base, timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if ((await fetch(`${base}/health`)).ok) return true; } catch { /* not up */ }
    await sleep(200);
  }
  return false;
}

/** Boot the real server for one agent dir. `catalog` controls the auto refresh;
 *  `opts.piBin` swaps in a different stub. */
async function startServer(agentDir, catalog, opts = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      SCOPE_PORT: String(port),
      SCOPE_HOST: "127.0.0.1",
      SCOPE_DB_PATH: path.join(tmpDir, `scope-${path.basename(agentDir)}.db`),
      SCOPE_AUTH_TOKEN: TOKEN,
      SCOPE_AGENT_DIR: agentDir,
      SCOPE_PLUGINS_DIR: path.join(tmpDir, "plugins"),
      SCOPE_TOKEN_FILE: path.join(tmpDir, "scope_token"),
      SCOPE_PI_BIN: opts.piBin ?? path.join(stubDir, "pi"),
      SCOPE_MODELS_DEV_URL: modelsDevUrl,
      SCOPE_MODEL_CATALOG: catalog,
      // Keep pi's own startup checks out of the way.
      PI_OFFLINE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  assert.ok(await waitForHealth(base), "server never became healthy");
  return { base, child };
}

async function api(base, pathname, init = {}) {
  const res = await fetch(`${base}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers || {}) },
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { res, data };
}

const status = async (base) => (await api(base, "/pi-update")).data.modelCatalog;
const refresh = (base) =>
  api(base, "/pi-update", { method: "POST", body: JSON.stringify({ action: "refresh-models" }) });

/** Lines the stub pi logged (argv + agent dir), or [] when it never ran. */
function stubCalls() {
  try { return fs.readFileSync(stubLog, "utf8").trim().split("\n").filter(Boolean); } catch { return []; }
}

before(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-models-")));
  stubDir = path.join(tmpDir, "bin");
  stubLog = path.join(tmpDir, "pi-calls.log");
  fs.mkdirSync(stubDir, { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "plugins"), { recursive: true });
  writeStubPi(stubDir, stubLog);

  // A stale pair of catalogs, exactly as pi and pi-updater leave them.
  for (const dir of [agentOf("manual"), agentOf("auto")]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "models-store.json"),
      JSON.stringify({ oldprovider: { models: [{ id: "old-model" }] } }, null, 2));
    fs.writeFileSync(path.join(dir, "model-update-cache.json"),
      JSON.stringify({ checkedAt: 0, models: [], notified: ["already-notified"] }));
    // Backdate the store so it reads as stale without waiting for the TTL.
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    fs.utimesSync(path.join(dir, "models-store.json"), past, past);
  }
  // A machine that has never run pi online: no catalogs to start from.
  for (const dir of [agentOf("fresh"), agentOf("empty"), agentOf("broken")]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  badStubDir = path.join(tmpDir, "bad-bin");
  fs.mkdirSync(badStubDir, { recursive: true });
  writeFailingPi(badStubDir, path.join(tmpDir, "bad-pi-calls.log"));

  // Local models.dev stand-in.
  const devPort = await freePort();
  modelsDev = http.createServer((req, res) => {
    if (!req.url?.startsWith("/api.json")) { res.writeHead(404); res.end("nope"); return; }
    catalogHits++;
    if (catalogBody === "garbage") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"unexpected":"shape"}');
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(catalogBody));
  });
  await new Promise((r) => modelsDev.listen(devPort, "127.0.0.1", r));
  modelsDevUrl = `http://127.0.0.1:${devPort}/api.json`;

  manual = await startServer(agentOf("manual"), "off");
  auto = await startServer(agentOf("auto"), "");
  fresh = await startServer(agentOf("fresh"), "");
  empty = await startServer(agentOf("empty"), "off");
  broken = await startServer(agentOf("broken"), "off", { piBin: path.join(badStubDir, "pi") });
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  if (browser) await browser.close();
  for (const server of [auto, manual, fresh, empty, broken]) {
    if (!server) continue;
    server.child.kill("SIGKILL");
    await new Promise((r) => server.child.once("exit", r));
  }
  if (modelsDev) await new Promise((r) => modelsDev.close(r));
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("model catalogs", () => {
  test("reports both catalogs and their staleness", async () => {
    const s = await status(manual.base);
    assert.equal(s.storePath, storePath("manual"));
    assert.equal(s.cachePath, cachePath("manual"));
    assert.equal(s.ttlMs, 4 * 60 * 60 * 1000, "the TTL matches pi-updater's own interval");
    assert.equal(s.storeStale, true, "a day-old store is stale");
    assert.equal(s.cacheStale, true, "a cache checked at 0 is stale");
    assert.equal(s.scheduled, false, "SCOPE_MODEL_CATALOG=off disables the background scheduler");
  });

  test("the background scheduler is armed while the app is open", async () => {
    const s = await status(auto.base);
    assert.equal(s.scheduled, true, "the app refreshes the catalogs by itself");
  });

  // Settings → Models renders the refresh from the settings snapshot (the card
  // moved there), so the same status has to ride on GET /settings.
  test("the settings snapshot carries the same catalog status", async () => {
    const fromPiUpdate = await status(manual.base);
    const { res, data } = await api(manual.base, "/settings");
    assert.ok(res.ok, JSON.stringify(data));
    const fromSettings = data.modelCatalog;
    assert.ok(fromSettings, "GET /settings reports modelCatalog");
    for (const key of ["storePath", "cachePath", "ttlMs", "storeStale", "cacheStale", "scheduled", "cacheModels", "cacheProviders"]) {
      assert.deepEqual(fromSettings[key], fromPiUpdate[key], `modelCatalog.${key} matches /pi-update`);
    }
  });

  test("refreshing runs pi's own command and rewrites the release cache", async () => {
    const before = await status(manual.base);
    const callsBefore = stubCalls().length;

    const { res, data } = await refresh(manual.base);
    assert.ok(res.ok, JSON.stringify(data));
    const s = data.modelCatalog;

    // pi was asked to refresh its catalogs, with the agent dir pinned.
    const calls = stubCalls();
    assert.deepEqual(calls.slice(callsBefore, callsBefore + 2), [
      "update",
      "--models",
    ], `expected the pi update command, got: ${JSON.stringify(calls.slice(callsBefore))}`);
    assert.ok(
      calls.includes(`PI_CODING_AGENT_DIR=${agentOf("manual")}`),
      "the refresh writes the store inside the agent dir the server reads",
    );

    // The store is pi's file: the stub's payload is what now sits on disk.
    const store = JSON.parse(fs.readFileSync(storePath("manual"), "utf8"));
    assert.ok(store.stubprovider, "the model store was rewritten by pi");
    assert.equal(s.storeUpdatedAt > before.storeUpdatedAt, true, "the store is newer than before");
    assert.equal(s.storeStale, false);

    // The release cache now holds the fetched catalog: valid chat models only,
    // and pi-updater's own `notified` list survives.
    const cache = JSON.parse(fs.readFileSync(cachePath("manual"), "utf8"));
    assert.deepEqual(
      cache.models.map((m) => `${m.provider}/${m.id}`).sort(),
      ["google/gemini-2.5-pro", "openai/gpt-5"],
      "entries without a release date, and non-chat models, are dropped",
    );
    assert.deepEqual(cache.notified, ["already-notified"], "notified releases are preserved");
    assert.ok(cache.checkedAt > 0, "the check is recorded");
    assert.deepEqual(cache.models.find((m) => m.id === "gpt-5").canonicalId, "openai/gpt-5");
    assert.equal(s.cacheModels, 2);
    assert.equal(s.cacheProviders, 2,
      "the cache names two providers (google, openai) — not the providers the cost table lists");
    assert.equal(s.cacheStale, false);
    assert.equal(s.lastResult.cache.refreshed, true);
    assert.equal(s.lastResult.store.refreshed, true, s.lastResult.store.error || "");
    assert.equal(s.refreshing, false, "a returned status never claims a refresh is still running");
    assert.match(s.lastResult.store.output || "", /refreshed/);
  });

  test("a catalog that cannot be parsed never replaces the good one", async () => {
    // Force a re-check, and make the endpoint answer with something that is not
    // a models.dev catalog at all.
    await refresh(manual.base);
    const good = JSON.parse(fs.readFileSync(cachePath("manual"), "utf8"));
    catalogBody = "garbage";
    try {
      const { data } = await refresh(manual.base);
      const cache = JSON.parse(fs.readFileSync(cachePath("manual"), "utf8"));
      assert.deepEqual(cache.models, good.models, "the previous catalog is kept");
      assert.deepEqual(cache.notified, ["already-notified"]);
      assert.ok(cache.checkedAt >= good.checkedAt, "the attempt is still recorded, so it is not retried in a loop");
      assert.match(data.modelCatalog.lastError, /no model release metadata/);
    } finally {
      catalogBody = CATALOG;
    }
  });

  test("creates both catalogs on a machine that has none", async () => {
    // The scheduler is on for this instance: having the app open is the trigger,
    // so no request is made here.
    await sleep(7_000);
    const s = await status(fresh.base);
    assert.equal(s.storePresent, true, "pi's own command created the model store");
    assert.equal(s.cachePresent, true, "the release cache was fetched from models.dev");
    assert.equal(s.storeStale, false);
    assert.equal(s.cacheStale, false);

    const store = JSON.parse(fs.readFileSync(storePath("fresh"), "utf8"));
    assert.ok(store.stubprovider, "the store holds what pi wrote");
    const cache = JSON.parse(fs.readFileSync(cachePath("fresh"), "utf8"));
    assert.deepEqual(
      cache.models.map((m) => `${m.provider}/${m.id}`).sort(),
      ["google/gemini-2.5-pro", "openai/gpt-5"],
      "the created cache holds the fetched, validated catalog",
    );
    assert.deepEqual(cache.notified, [], "a fresh cache starts with no releases notified");
  });

  test("a missing catalog is not fabricated when its source fails", async () => {
    // No store, and a `pi` whose update exits non-zero: creating a file anyway
    // would be the app inventing pi's state.
    const { data } = await refresh(broken.base);
    assert.equal(fs.existsSync(storePath("broken")), false, "a failed pi run creates no store");
    assert.equal(data.modelCatalog.lastResult.store.refreshed, false);
    assert.match(data.modelCatalog.lastError, /exited with code 3/);

    // No cache, and a models.dev answer that is not a catalog: same rule.
    catalogBody = "garbage";
    try {
      const { data: r } = await refresh(empty.base);
      assert.equal(fs.existsSync(cachePath("empty")), false, "a bad response creates no cache");
      assert.equal(r.modelCatalog.lastResult.cache.refreshed, false);
      assert.match(r.modelCatalog.lastError, /no model release metadata/);
    } finally {
      catalogBody = CATALOG;
    }
  });

  test("Settings → Models shows the catalogs above the cost table and can force a refresh", async () => {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e?.message ?? e)));
    await page.goto(`${manual.base}/?token=${TOKEN}#view=settings`, { waitUntil: "domcontentloaded" });
    await page.click('.settings-nav-item[data-sec="models"]');
    await page.waitForSelector("#set-models-refresh");

    // The refresh sits between the memory-model picker and the cost table.
    const order = await page.evaluate(() => {
      const panel = document.querySelector(".settings-panel");
      const mem = panel.querySelector('select[data-act="setMemoryModel"]');
      const card = panel.querySelector("#set-models-refresh");
      const table = panel.querySelector(".set-cost-table");
      if (!mem || !card || !table) return "missing";
      const after = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      return `${after(mem, card)}/${after(card, table)}`;
    });
    assert.equal(order, "true/true", "the model update sits below the memory model and above the cost table");

    const card = await page.textContent(".settings-panel .set-update-card");
    assert.match(card, /Model store/, "the store's state is shown");
    assert.match(card, /models.dev releases/);
    assert.match(card, /Cost table below/, "the card reconciles the release count with the table's own");
    assert.match(card, /Automatic refresh/);

    // The "Cost table below" row is not a claim about the store file — it has to
    // be the count of what the table actually lists, or the card would mislead
    // exactly the way the release-cache number used to.
    const counts = await page.evaluate(() => {
      const label = "Cost table below";
      const row = [...document.querySelectorAll(".settings-panel .set-update-row")]
        .find((r) => r.querySelector(".set-update-row-label")?.textContent?.trim() === label);
      const rows = [...document.querySelectorAll(".settings-panel .set-cost-row[data-cost-key]")];
      const providers = new Set(rows.map((r) => r.querySelector(".set-cost-prov")?.textContent?.trim()).filter(Boolean));
      const plural = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;
      return {
        row: row ? row.querySelector(".set-update-row-value").textContent.trim() : null,
        expected: `${plural(providers.size, "provider")} · ${plural(rows.length, "model")}`,
      };
    });
    assert.equal(counts.row, counts.expected, "the card's counts are the cost table's counts");
    assert.match(card, /off \(SCOPE_MODEL_CATALOG=off\)/, "the scheduler's state is honest about this instance");

    // The button performs a real refresh, not just a re-render.
    const before = (await status(manual.base)).lastCheckedAt ?? 0;
    const callsBefore = stubCalls().length;
    await page.click("#set-models-refresh");
    let after = 0;
    for (let i = 0; i < 60; i++) {
      after = (await status(manual.base)).lastCheckedAt ?? 0;
      if (after > before) break;
      await sleep(150);
    }
    assert.ok(after > before, "the button ran a refresh");
    assert.ok(stubCalls().length > callsBefore, "and it asked pi to refresh the store");
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("the app refreshes the catalogs by itself while it is open", async () => {
    // The auto instance's scheduler fires shortly after boot with no request at
    // all — that is the behaviour a user gets simply by opening Pi Scope.
    const start = Date.now();
    let s = await status(auto.base);
    while (s.storeStale || s.cacheStale) {
      if (Date.now() - start > 20_000) break;
      await sleep(300);
      s = await status(auto.base);
    }
    assert.equal(s.storeStale, false, "the store was refreshed without being asked");
    assert.equal(s.cacheStale, false, "the release cache was refreshed without being asked");
    // No request was ever made against this instance: only its own periodic pass
    // can have done the work, and it recorded that it did.
    assert.equal(s.lastResult?.store?.refreshed, true, "the scheduled pass refreshed the store");
    assert.equal(s.lastResult?.cache?.refreshed, true, "the scheduled pass refreshed the cache");
    assert.ok(s.lastCheckedAt > 0, "the pass is recorded in the status");
    const store = JSON.parse(fs.readFileSync(storePath("auto"), "utf8"));
    assert.ok(store.stubprovider, "pi rewrote the store");
    const cache = JSON.parse(fs.readFileSync(cachePath("auto"), "utf8"));
    assert.ok(cache.models.length >= 2, "the catalog was fetched");
    assert.deepEqual(cache.notified, ["already-notified"]);
    assert.ok(catalogHits > 0, "models.dev was actually asked");
  });
});
