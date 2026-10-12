// End-to-end tests for the Git view's NETWORK operations (push / pull / fetch,
// submodule add + update).
//
// These used to run through `gitTry` (execFileSync), which parks the whole
// server for the duration of a remote round trip — a slow push froze the SSE
// feed the UI lives on, the terminal socket and every other request behind it.
// The suite proves the fix from the outside: while a push against a remote with
// a deliberately slow `pre-receive` hook is in flight, the server must still
// answer other requests promptly.
//
//   node --test apps/scope-server/test/git-network.e2e.test.mjs

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
const TOKEN = "git-network-token";
/** How long the remote's pre-receive hook sleeps. */
const HOOK_SLEEP_S = 3;

let child;
let base;
let tmpDir;
let repoDir;
let remoteDir;

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

function git(cwd, args, { allowFail = false } = {}) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (!allowFail) assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return (r.stdout ?? "").trim();
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

const push = (extra = {}) => api("/git/push", { method: "POST", body: JSON.stringify({ cwd: repoDir, ...extra }) });

before(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-git-net-")));
  repoDir = path.join(tmpDir, "repo");
  remoteDir = path.join(tmpDir, "remote.git");
  fs.mkdirSync(path.join(tmpDir, "plugins"), { recursive: true });
  fs.mkdirSync(repoDir, { recursive: true });

  // A bare "remote" whose receive is slow: pushing to it takes ~3s, so a push
  // that blocks the event loop is impossible to miss.
  git(tmpDir, ["init", "--bare", "-q", remoteDir]);
  const hook = path.join(remoteDir, "hooks", "pre-receive");
  fs.writeFileSync(hook, `#!/bin/sh\nsleep ${HOOK_SLEEP_S}\nexit 0\n`);
  fs.chmodSync(hook, 0o755);

  git(repoDir, ["init", "-q", "-b", "main"]);
  git(repoDir, ["config", "user.email", "test@example.com"]);
  git(repoDir, ["config", "user.name", "Test"]);
  git(repoDir, ["remote", "add", "origin", remoteDir]);
  fs.writeFileSync(path.join(repoDir, "README.md"), "# fixture\n");
  git(repoDir, ["add", "README.md"]);
  git(repoDir, ["commit", "-qm", "chore: seed"]);

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
      SCOPE_FILE_ROOT: `${repoDir},${tmpDir}`,
      SCOPE_MODEL_CATALOG: "off",
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

describe("network git operations keep serving", () => {
  test("a slow push does not block other requests", async () => {
    const t0 = Date.now();
    const pushing = push();
    // Let the push reach the remote's hook, then measure how long a completely
    // unrelated request takes. With execFileSync this waited for the whole push.
    await new Promise((r) => setTimeout(r, 500));
    const probeStart = Date.now();
    const health = await fetch(`${base}/health`);
    const probeMs = Date.now() - probeStart;
    assert.equal(health.status, 200);
    assert.ok(probeMs < 1000, `/health answered while the push was in flight (${probeMs}ms)`);

    // …and a second API call is served too (the git routes themselves).
    const probe2Start = Date.now();
    const status = await api(`/git/status?cwd=${encodeURIComponent(repoDir)}`);
    assert.ok(status.res.ok && status.data.git, "the Git API answered during the push");
    assert.ok(Date.now() - probe2Start < 1000, "the Git API answered promptly");

    const { res, data } = await pushing;
    const elapsed = Date.now() - t0;
    assert.ok(res.ok && data.ok, `push failed: ${JSON.stringify(data)}`);
    assert.ok(elapsed >= HOOK_SLEEP_S * 1000, `the remote really did delay the push (${elapsed}ms)`);
    // The push landed: the remote has the branch and the commit.
    assert.equal(git(remoteDir, ["rev-parse", "--verify", "refs/heads/main"], { allowFail: true }).length, 40);
  });

  test("push reports upstream wiring and pull/fetch run through the same path", async () => {
    // The first push had no upstream configured, so it pushed with
    // --set-upstream; report that, then a plain push must succeed.
    const second = await push();
    assert.ok(second.res.ok && second.data.ok, `second push failed: ${JSON.stringify(second.data)}`);
    const upstream = git(repoDir, ["rev-parse", "--abbrev-ref", "main@{upstream}"], { allowFail: true });
    assert.equal(upstream, "origin/main");

    // A commit made on a second clone is visible after fetch/pull through the API.
    const cloneDir = path.join(tmpDir, "clone");
    // The bare remote's HEAD still points at the default branch name, so check
    // out the branch we actually pushed.
    git(tmpDir, ["clone", "-q", "-b", "main", remoteDir, cloneDir]);
    git(cloneDir, ["config", "user.email", "other@example.com"]);
    git(cloneDir, ["config", "user.name", "Other"]);
    fs.writeFileSync(path.join(cloneDir, "from-remote.txt"), "remote change\n");
    git(cloneDir, ["add", "from-remote.txt"]);
    git(cloneDir, ["commit", "-qm", "feat: remote change"]);
    git(cloneDir, ["push", "-q", "origin", "main"]);

    const fetched = await api("/git/fetch", { method: "POST", body: JSON.stringify({ cwd: repoDir }) });
    assert.ok(fetched.res.ok && fetched.data.ok, `fetch failed: ${JSON.stringify(fetched.data)}`);
    const pulled = await api("/git/pull", { method: "POST", body: JSON.stringify({ cwd: repoDir }) });
    assert.ok(pulled.res.ok && pulled.data.ok, `pull failed: ${JSON.stringify(pulled.data)}`);
    assert.ok(fs.existsSync(path.join(repoDir, "from-remote.txt")), "pull applied the remote change");
  });
});
