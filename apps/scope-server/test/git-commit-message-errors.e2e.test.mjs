// End-to-end tests for the AI commit-message generator's FAILURE handling.
//
// pi prints benign startup warnings ("Warning: No models match pattern …") to
// stderr on every run — including for stale model patterns in the user's own
// settings. Those used to be reported verbatim as the failure, so a run that
// produced nothing surfaced as "could not generate a commit message: Warning: …"
// with no indication of what actually went wrong. The generator now filters
// those lines and reports a timeout explicitly.
//
// A stub pi (driven by a mode file) stands in for the real binary.
//
//   node --test apps/scope-server/test/git-commit-message-errors.e2e.test.mjs

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const SERVER = path.join(ROOT, "apps", "scope-server", "server.ts");
const TOKEN = "git-msg-errors-token";
const TIMEOUT_MS = 500;

let child;
let base;
let tmpDir;
let repoDir;
let modeFile;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
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

const generate = () => api("/git/commit-message", { method: "POST", body: JSON.stringify({ cwd: repoDir }) });

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-git-msg-err-"));
  repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(path.join(tmpDir, "plugins"), { recursive: true });
  fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, ["init", "-q"]);
  git(repoDir, ["config", "user.email", "test@example.com"]);
  git(repoDir, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repoDir, "README.md"), "# fixture\n");
  git(repoDir, ["add", "README.md"]);
  git(repoDir, ["commit", "-qm", "seed"]);
  fs.writeFileSync(path.join(repoDir, "feature.js"), "export const answer = 42;\n");
  git(repoDir, ["add", "feature.js"]);

  modeFile = path.join(tmpDir, "mode");
  fs.writeFileSync(modeFile, "ok");
  const stub = path.join(tmpDir, "fake-pi");
  fs.writeFileSync(
    stub,
    `#!/bin/sh\n` +
      `mode=$(cat "$STUB_MODE_FILE" 2>/dev/null || echo ok)\n` +
      `case "$mode" in\n` +
      // Never produces stdout: the generator must time out and say so.
      `  hang) sleep 60 ;;\n` +
      // Realistic failure: pi warns on stderr, then a real error, no stdout.
      `  warn) printf '%s\\n' 'Warning: No models match pattern "kilo/x:free"' 'Warning: Invalid thinking level "free"' >&2; printf '%s\\n' 'error: no API key for provider' >&2; exit 1 ;;\n` +
      `  *) printf '%s\\n' 'chore: stubbed message' ;;\n` +
      `esac\n`,
  );
  fs.chmodSync(stub, 0o755);

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
      SCOPE_PI_BIN: stub,
      SCOPE_COMMIT_TIMEOUT_MS: String(TIMEOUT_MS),
      STUB_MODE_FILE: modeFile,
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
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("git commit message generation — failures", () => {
  test("a silent run is reported as a timeout, not as pi's warnings", async () => {
    fs.writeFileSync(modeFile, "hang");
    const t0 = Date.now();
    const { res, data } = await generate();
    const elapsed = Date.now() - t0;

    assert.equal(res.status, 502, `expected 502, got ${res.status}`);
    assert.match(data.error, /no message within/i, `unexpected error: ${data.error}`);
    assert.ok(!/Warning:/i.test(data.error), `warnings leaked into the error: ${data.error}`);
    // The stub sleeps 60s; the configured 500ms cap must bound the wait.
    assert.ok(elapsed < 10_000, `took too long: ${elapsed}ms`);
  });

  test("pi's startup warnings are filtered so the real error is shown", async () => {
    fs.writeFileSync(modeFile, "warn");
    const { res, data } = await generate();

    assert.equal(res.status, 502, `expected 502, got ${res.status}`);
    assert.match(data.error, /no API key for provider/, `real error missing: ${data.error}`);
    assert.ok(!/Warning:/i.test(data.error), `warnings leaked into the error: ${data.error}`);
  });

  test("a normal run still returns the generated message", async () => {
    fs.writeFileSync(modeFile, "ok");
    const { res, data } = await generate();

    assert.ok(res.ok, `expected 200, got ${res.status}: ${JSON.stringify(data)}`);
    assert.equal(data.ok, true);
    assert.equal(data.message, "chore: stubbed message");
  });
});
