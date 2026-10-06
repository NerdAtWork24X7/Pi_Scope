// End-to-end tests for the Git view's Branches tab: the listing must surface
// remote-tracking branches alongside the local ones, and selecting a remote
// branch must check out a local branch that tracks it.
//
// The real server runs against a temp repo with a bare "origin" remote.
//
//   node --test apps/scope-server/test/git-branches.e2e.test.mjs

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

const TOKEN = "git-branches-test-token";

let child;
let base;
let tmpDir;
let remoteDir;
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

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-git-branches-"));
  remoteDir = path.join(tmpDir, "remote.git");
  repoDir = path.join(tmpDir, "repo");

  // A bare "origin" that holds main + a branch we only ever see as remote.
  fs.mkdirSync(remoteDir, { recursive: true });
  git(remoteDir, ["init", "-q", "--bare"]);

  fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, ["init", "-q"]);
  git(repoDir, ["config", "user.email", "test@example.com"]);
  git(repoDir, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repoDir, "README.md"), "# fixture\n");
  git(repoDir, ["add", "README.md"]);
  git(repoDir, ["commit", "-qm", "init"]);
  git(repoDir, ["branch", "-m", "main"]);
  git(repoDir, ["remote", "add", "origin", remoteDir]);
  git(repoDir, ["push", "-q", "origin", "main"]);

  fs.writeFileSync(path.join(repoDir, "feature.txt"), "feature\n");
  git(repoDir, ["add", "feature.txt"]);
  git(repoDir, ["commit", "-qm", "feature"]);
  git(repoDir, ["branch", "feature"]);
  git(repoDir, ["push", "-q", "origin", "feature"]);
  git(repoDir, ["fetch", "-q", "origin"]);
  // Leave only the remote-tracking ref behind, and add origin's HEAD alias
  // (origin/HEAD → origin/main), which the listing must skip.
  git(repoDir, ["branch", "-D", "feature"]);
  git(repoDir, ["remote", "set-head", "origin", "main"]);

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
      SCOPE_FILE_ROOT: tmpDir,
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

describe("git branches (local + remote)", () => {
  test("lists local branches and remote-tracking branches, skipping <remote>/HEAD", async () => {
    const { res, data } = await api(`/git/branches?cwd=${encodeURIComponent(repoDir)}`);
    assert.ok(res.ok);
    assert.equal(data.ok, true);
    assert.equal(data.current, "main");

    const local = data.branches.map((b) => b.name);
    assert.deepEqual(local, ["main"], "only the local branches are listed as local");

    const remote = data.remoteBranches.map((b) => b.name);
    assert.ok(remote.includes("origin/main"), "origin/main is listed");
    assert.ok(remote.includes("origin/feature"), "origin/feature is listed despite having no local branch");
    assert.ok(!remote.some((n) => n.endsWith("/HEAD")), "origin/HEAD alias is skipped");

    const feature = data.remoteBranches.find((b) => b.name === "origin/feature");
    assert.equal(feature.remote, "origin");
    assert.equal(feature.short, "feature");
    assert.ok(feature.sha && feature.sha.length >= 4, "remote branch carries a short sha");
  });

  test("checking out a remote branch creates the local branch that tracks it", async () => {
    const { res, data } = await api("/git/branch", {
      method: "POST",
      body: JSON.stringify({ cwd: repoDir, action: "checkout-remote", name: "origin/feature" }),
    });
    assert.ok(res.ok, `HTTP ${res.status}`);
    assert.equal(data.ok, true);
    assert.equal(git(repoDir, ["branch", "--show-current"]), "feature");
    assert.equal(git(repoDir, ["rev-parse", "--abbrev-ref", "feature@{upstream}"]), "origin/feature");

    // …and it now shows up as a local branch whose upstream is the remote one,
    // so the client can mark the remote row as tracked.
    const after = await api(`/git/branches?cwd=${encodeURIComponent(repoDir)}`);
    const localFeature = after.data.branches.find((b) => b.name === "feature");
    assert.ok(localFeature, "feature is now a local branch");
    assert.equal(localFeature.upstream, "origin/feature");
  });

  test("checkout-remote reuses an existing local branch of the same name", async () => {
    // `feature` already exists locally now; the action must switch to it rather
    // than fail trying to create it again.
    git(repoDir, ["switch", "-q", "main"]);
    const { res, data } = await api("/git/branch", {
      method: "POST",
      body: JSON.stringify({ cwd: repoDir, action: "checkout-remote", name: "origin/feature" }),
    });
    assert.ok(res.ok, `HTTP ${res.status}`);
    assert.equal(data.ok, true);
    assert.equal(git(repoDir, ["branch", "--show-current"]), "feature");
  });
});
