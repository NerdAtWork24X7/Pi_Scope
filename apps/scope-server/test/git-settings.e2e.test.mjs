// End-to-end tests for where Pi Scope's Git fields live: the Git plugin's own
// store, `<plugins dir>/.data/git.json` — the same file `api.store` hands the
// plugin and every other plugin's state lives in.
//
// The commit-message model and template are Pi Scope's own fields — pi does not
// read them — so they must not ride in pi's settings.json. This suite runs the
// REAL server and covers the whole path:
//
//   • the one-time import from where they used to live (the interim
//     `<agent dir>/git_setting.json`, then pi's settings.json), with the newer
//     file winning and both sources cleaned up,
//   • a value already in the store winning over either legacy source,
//   • writes landing in the store (and never touching pi's file),
//   • pi's own fields (e.g. editorPaddingX, which pi reads from settings.json)
//     being left exactly where pi expects them.
//
//   node --test apps/scope-server/test/git-settings.e2e.test.mjs

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const SERVER = path.join(ROOT, "apps", "scope-server", "server.ts");
const TOKEN = "git-settings-token";

/** The pre-store shape: our fields sitting in pi's file alongside pi's own. */
const LEGACY_SETTINGS = {
  theme: "cyberpunk",
  defaultModel: "prov/model",
  defaultThinkingLevel: "high",
  editorPaddingX: 1,
  gitCommitModel: "legacy/model",
  gitCommitTemplate: "legacy {{diff}}",
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

/**
 * Boot a real server against a fresh temp agent dir + plugins dir.
 *
 * `seed` optionally pre-writes any of the three files, so a test can describe
 * what the user's disk looked like before the move: `pi` (settings.json),
 * `interim` (`<agent dir>/git_setting.json`) and `store`
 * (`<plugins dir>/.data/git.json`).
 */
async function startServer(seed = {}) {
  const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-git-settings-")));
  const agentDir = path.join(tmpDir, "agent");
  const pluginsDir = path.join(tmpDir, "plugins");
  fs.mkdirSync(agentDir, { recursive: true });
  const paths = {
    tmpDir,
    agentDir,
    pluginsDir,
    settings: path.join(agentDir, "settings.json"),
    interim: path.join(agentDir, "git_setting.json"),
    store: path.join(pluginsDir, ".data", "git.json"),
  };
  if (seed.pi) fs.writeFileSync(paths.settings, JSON.stringify(seed.pi, null, 2) + "\n");
  if (seed.interim) {
    fs.writeFileSync(paths.interim, JSON.stringify(seed.interim, null, 2) + "\n");
  }
  if (seed.store) {
    fs.mkdirSync(path.dirname(paths.store), { recursive: true });
    fs.writeFileSync(paths.store, JSON.stringify(seed.store, null, 2) + "\n");
  }

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      SCOPE_PORT: String(port),
      SCOPE_HOST: "127.0.0.1",
      SCOPE_DB_PATH: path.join(tmpDir, "scope.db"),
      SCOPE_AUTH_TOKEN: TOKEN,
      SCOPE_PLUGINS_DIR: pluginsDir,
      SCOPE_AGENT_DIR: agentDir,
      SCOPE_FILE_ROOT: tmpDir,
      SCOPE_PI_BIN: "/bin/true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }

  const api = async (pathname, init = {}) => {
    const res = await fetch(`${base}${pathname}`, {
      ...init,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers || {}) },
    });
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    return { res, data };
  };
  const stop = async () => {
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  };
  return { api, paths, stop };
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

describe("git fields move into the Git plugin's store", () => {
  let server;
  before(async () => {
    server = await startServer({
      pi: LEGACY_SETTINGS,
      // The interim per-feature file: the newer of the two legacy homes, so its
      // copy of the template must win.
      interim: { gitCommitTemplate: "interim {{diff}}" },
    });
  });
  after(async () => { if (server) await server.stop(); });

  test("both legacy homes are imported on first read, and cleaned up", async () => {
    // Reading the settings snapshot is what triggers the import.
    const { res, data } = await server.api("/settings");
    assert.ok(res.ok);
    assert.equal(data.gitCommitModel, "legacy/model", "the model is carried over from pi's settings.json");
    assert.equal(data.gitCommitTemplate, "interim {{diff}}", "the newer interim file wins for the template");

    assert.deepEqual(readJson(server.paths.store), {
      commitModel: "legacy/model",
      commitTemplate: "interim {{diff}}",
    }, "both values land in the plugin's store, namespaced to the plugin's keys");

    // Pi's file keeps everything pi reads, and nothing of ours.
    const pi = readJson(server.paths.settings);
    assert.equal("gitCommitModel" in pi, false, "the model left pi's settings.json");
    assert.equal("gitCommitTemplate" in pi, false, "the template left pi's settings.json");
    assert.equal(pi.theme, "cyberpunk");
    assert.equal(pi.defaultModel, "prov/model");
    assert.equal(pi.defaultThinkingLevel, "high");
    // `editorPaddingX` is pi's own field (the bundled agent reads it from
    // settings.json to pad its editor), so it deliberately stays put.
    assert.equal(pi.editorPaddingX, 1, "pi's editor padding stays in settings.json");

    // The store has taken over, so the stale interim file is removed.
    assert.equal(fs.existsSync(server.paths.interim), false, "the interim file is gone");

    // A later read does not re-import or re-write anything.
    const piBefore = fs.readFileSync(server.paths.settings, "utf8");
    const storeBefore = fs.readFileSync(server.paths.store, "utf8");
    await server.api("/settings");
    assert.equal(fs.readFileSync(server.paths.settings, "utf8"), piBefore, "pi's settings.json is left alone");
    assert.equal(fs.readFileSync(server.paths.store, "utf8"), storeBefore, "the store is not rewritten");
  });

  test("writes land in the plugin store and leave pi's settings.json alone", async () => {
    const piBefore = fs.readFileSync(server.paths.settings, "utf8");

    const model = await server.api("/settings", {
      method: "POST", body: JSON.stringify({ action: "setGitCommitModel", value: "new/model" }),
    });
    assert.ok(model.res.ok, `set failed: ${JSON.stringify(model.data)}`);
    assert.equal(model.data.gitCommitModel, "new/model", "the write is echoed back");
    assert.equal(readJson(server.paths.store).commitModel, "new/model", "the model is stored in the plugin's store");

    const template = await server.api("/settings", {
      method: "POST", body: JSON.stringify({ action: "setGitCommitTemplate", value: "" }),
    });
    assert.ok(template.res.ok);
    assert.equal(readJson(server.paths.store).commitTemplate, "", "an empty template is stored (and means the default)");
    assert.equal(template.data.gitCommitTemplateDefault.length > 0, true, "the default is still advertised");

    assert.equal(fs.readFileSync(server.paths.settings, "utf8"), piBefore, "pi's settings.json was not written");
    assert.equal(fs.existsSync(server.paths.interim), false, "no interim file is written back");

    const after = await server.api("/settings");
    assert.equal(after.data.gitCommitModel, "new/model");
    assert.equal(after.data.gitCommitTemplate, "");
  });
});

describe("a store value is authoritative over the legacy files", () => {
  let server;
  before(async () => {
    // An established store (already moved once) alongside stale legacy copies:
    // the stored model must not be clobbered by the older file.
    server = await startServer({
      pi: LEGACY_SETTINGS,
      interim: { gitCommitTemplate: "interim {{diff}}" },
      store: { commitModel: "store/model" },
    });
  });
  after(async () => { if (server) await server.stop(); });

  test("the stored model wins, and the legacy copies are still cleared", async () => {
    const { data } = await server.api("/settings");
    assert.equal(data.gitCommitModel, "store/model", "the store's own value is kept");
    assert.equal(data.gitCommitTemplate, "interim {{diff}}", "a key the store lacks is still imported");

    const pi = readJson(server.paths.settings);
    assert.equal("gitCommitModel" in pi, false);
    assert.equal("gitCommitTemplate" in pi, false);
    assert.equal(pi.editorPaddingX, 1);
    assert.equal(fs.existsSync(server.paths.interim), false, "the stale interim file is removed");

    assert.deepEqual(readJson(server.paths.store), {
      commitModel: "store/model",
      commitTemplate: "interim {{diff}}",
    });
  });
});
