// Regression test for the duplicate-extension failure:
//
//   Failed to load extension "/…/.pi-scope/agent/extensions/pi-scope.ts":
//   Flag "--obs-server-url" conflicts with /…/extension/pi-scope.ts
//
// pi discovers every file under `<agentDir>/extensions/` *in addition to* the
// extension Pi Scope's bundled-pi shim force-loads with `--extension`. A copy
// left behind by an older build is not byte-identical to the forced file, so the
// force-load guard inside the extension (which only stands down for a *different*
// file) can't recognise it — both register the same CLI flags and pi exits
// before the first prompt. The server refreshes such a copy on boot, so it can
// never go stale; this test pins that behaviour.
//
// Skips when the dev pi bundle isn't installed: without it the server falls back
// to whatever `pi` is on PATH and exercises none of this.
//
//   node --test apps/scope-server/test/pi-bundle-extension-sync.e2e.test.mjs

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
const EXTENSION = path.join(ROOT, "extension", "pi-scope.ts");
const BUNDLE_CLI = path.join(
  ROOT, "apps", "scope-desktop", "pi-bundle", "node_modules",
  "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js",
);
const TOKEN = "pi-bundle-sync-token";
const HAS_BUNDLE = fs.existsSync(BUNDLE_CLI) && fs.existsSync(EXTENSION);

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

async function waitForHealth(base, timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if ((await fetch(`${base}/health`)).ok) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

describe("bundled pi: extension copy in the agent dir", {
  skip: HAS_BUNDLE ? false : `dev pi bundle not installed (${BUNDLE_CLI})`,
}, () => {
  let child;
  let tmpDir;
  let agentDir;
  let logged = "";

  before(async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-pi-bundle-sync-")));
    agentDir = path.join(tmpDir, "agent");
    fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
    // The failure state: an out-of-date copy sitting in the agent dir, listed in
    // settings.json exactly like the real one that produced the error.
    fs.writeFileSync(path.join(agentDir, "extensions", "pi-scope.ts"), "// stale copy of the extension\n");
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
      extensions: ["+extensions/pi-scope.ts"],
    }, null, 2));

    const port = await freePort();
    child = spawn(process.execPath, [SERVER], {
      cwd: ROOT,
      env: {
        ...process.env,
        SCOPE_PORT: String(port),
        SCOPE_HOST: "127.0.0.1",
        SCOPE_DB_PATH: path.join(tmpDir, "scope.db"),
        SCOPE_AUTH_TOKEN: TOKEN,
        // Keep the shim (and the token) inside the temp dir: no SCOPE_PI_BIN, so
        // the bundled agent is resolved and the extension sync runs.
        SCOPE_TOKEN_FILE: path.join(tmpDir, "scope_token"),
        SCOPE_AGENT_DIR: agentDir,
        SCOPE_PI_BIN: "",
        PI_OFFLINE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => { logged += String(d); });
    child.stderr.on("data", (d) => { logged += String(d); });
    assert.ok(await waitForHealth(`http://127.0.0.1:${port}`), `server never became healthy:\n${logged}`);
  });

  after(async () => {
    if (child) {
      child.kill("SIGKILL");
      await new Promise((r) => child.once("exit", r));
    }
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("a stale copy is refreshed to match the force-loaded extension", () => {
    assert.match(logged, /refreshed the stale copy/, `expected a refresh notice, got:\n${logged}`);
    assert.equal(
      fs.readFileSync(path.join(agentDir, "extensions", "pi-scope.ts"), "utf8"),
      fs.readFileSync(EXTENSION, "utf8"),
      "the agent-dir copy now matches the file the shim force-loads",
    );
  });

  test("the repair touches only the copy — config is left alone", () => {
    // The sync never edits the user's config: a listed copy is harmless once it
    // matches the forced file, so settings.json keeps its entry.
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")).extensions,
      ["+extensions/pi-scope.ts"],
    );
  });
});
