// End-to-end tests for the Git view's merge action (History → right-click →
// Merge into current branch). A merge takes a commit or a branch/tag name and
// integrates it into the checked-out branch: fast-forward, merge commit,
// "already up to date", conflict signalling and the identity fallback.
//
// The real server runs against temp repos.
//
//   node --test apps/scope-server/test/git-merge.e2e.test.mjs

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

const TOKEN = "git-merge-test-token";

let child;
let base;
let tmpDir;
let repoDir;
let bareRepoDir; // a repo with no user identity anywhere (no local or global git config)
let globalGitConfig;

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

// Environment that hides the developer's real global/system git config, so a
// repo can genuinely have no identity.
function noIdentityEnv() {
  return { GIT_CONFIG_GLOBAL: globalGitConfig, GIT_CONFIG_NOSYSTEM: "1" };
}

function git(cwd, args, env) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...(env || {}) } });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

// Commit in a repo with no configured identity: the -c flags supply one for this
// call only, so neither .git/config nor the global config gains user.name/email.
function identitylessCommit(cwd, message) {
  git(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", message], noIdentityEnv());
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

function merge(sha) {
  return api("/git/action", { method: "POST", body: JSON.stringify({ cwd: repoDir, action: "merge", sha }) });
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-git-merge-"));
  repoDir = path.join(tmpDir, "repo");
  bareRepoDir = path.join(tmpDir, "no-identity");
  globalGitConfig = path.join(tmpDir, "gitconfig");
  fs.writeFileSync(globalGitConfig, "");

  fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, ["init", "-q"]);
  git(repoDir, ["config", "user.email", "test@example.com"]);
  git(repoDir, ["config", "user.name", "Test"]);
  git(repoDir, ["branch", "-m", "main"]);
  fs.writeFileSync(path.join(repoDir, "README.md"), "# fixture\n");
  git(repoDir, ["add", "README.md"]);
  git(repoDir, ["commit", "-qm", "init"]);

  // feature: one commit ahead of main, so merging it fast-forwards.
  git(repoDir, ["switch", "-q", "-c", "feature"]);
  fs.writeFileSync(path.join(repoDir, "feature.txt"), "feature\n");
  git(repoDir, ["add", "feature.txt"]);
  git(repoDir, ["commit", "-qm", "feature work"]);
  git(repoDir, ["switch", "-q", "main"]);

  // no-identity: a repo that never configured user.name/user.email.
  const noId = noIdentityEnv();
  fs.mkdirSync(bareRepoDir, { recursive: true });
  git(bareRepoDir, ["init", "-q"], noId);
  git(bareRepoDir, ["branch", "-m", "main"], noId);
  fs.writeFileSync(path.join(bareRepoDir, "a.txt"), "a\n");
  git(bareRepoDir, ["add", "a.txt"]);
  identitylessCommit(bareRepoDir, "init");
  git(bareRepoDir, ["switch", "-q", "-c", "side"], noId);
  fs.writeFileSync(path.join(bareRepoDir, "side.txt"), "side\n");
  git(bareRepoDir, ["add", "side.txt"], noId);
  identitylessCommit(bareRepoDir, "side");
  git(bareRepoDir, ["switch", "-q", "main"], noId);
  fs.writeFileSync(path.join(bareRepoDir, "main.txt"), "main\n");
  git(bareRepoDir, ["add", "main.txt"], noId);
  identitylessCommit(bareRepoDir, "main work");

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
      // Same isolated git config as the identityless fixture, so its repo really
      // has no identity for the merge fallback to supply.
      ...noIdentityEnv(),
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

describe("git merge action", () => {
  test("merges a branch by name and fast-forwards the checked-out branch", async () => {
    const featureTip = git(repoDir, ["rev-parse", "feature"]);
    const { res, data } = await merge("feature");
    assert.ok(res.ok, `HTTP ${res.status}: ${data?.error}`);
    assert.equal(data.ok, true);
    assert.equal(git(repoDir, ["rev-parse", "HEAD"]), featureTip, "HEAD fast-forwarded to feature");
    assert.match(data.out, /Fast-forward/, "git's outcome is returned for the status bar");
  });

  test("merging an already-merged branch is a no-op, not an error", async () => {
    const before = git(repoDir, ["rev-parse", "HEAD"]);
    const { res, data } = await merge("feature");
    assert.ok(res.ok, `HTTP ${res.status}: ${data?.error}`);
    assert.equal(data.ok, true);
    assert.match(data.out, /Already up to date/);
    assert.equal(git(repoDir, ["rev-parse", "HEAD"]), before);
  });

  test("merges by commit sha and creates a merge commit for diverged history", async () => {
    // Both branches move forward independently, so the merge cannot fast-forward.
    git(repoDir, ["switch", "-q", "feature"]);
    fs.writeFileSync(path.join(repoDir, "feature2.txt"), "more\n");
    git(repoDir, ["add", "feature2.txt"]);
    git(repoDir, ["commit", "-qm", "feature two"]);
    git(repoDir, ["switch", "-q", "main"]);
    fs.writeFileSync(path.join(repoDir, "main.txt"), "main\n");
    git(repoDir, ["add", "main.txt"]);
    git(repoDir, ["commit", "-qm", "main work"]);
    const featureSha = git(repoDir, ["rev-parse", "feature"]);
    const { res, data } = await merge(featureSha);
    assert.ok(res.ok, `HTTP ${res.status}: ${data?.error}`);
    assert.equal(data.ok, true);
    assert.match(data.out, /Merge made by/);
    const parents = git(repoDir, ["rev-list", "--parents", "-n", "1", "HEAD"]).split(/\s+/);
    assert.equal(parents.length, 3, "HEAD is a merge commit with two parents");
    assert.equal(parents[2], featureSha, "second parent is the merged commit");
  });

  test("the identity fallback lets a merge commit land in a repo with no user config", async () => {
    const { res, data } = await api("/git/action", {
      method: "POST",
      body: JSON.stringify({ cwd: bareRepoDir, action: "merge", sha: "side" }),
    });
    assert.ok(res.ok, `HTTP ${res.status}: ${data?.error}`);
    assert.equal(data.ok, true);
    assert.match(data.out, /Merge made by/);
    assert.equal(git(bareRepoDir, ["rev-list", "--parents", "-n", "1", "HEAD"]).split(/\s+/).length, 3);
    assert.equal(git(bareRepoDir, ["log", "-1", "--format=%an <%ae>"], noIdentityEnv()), "Pi Scope <scope@localhost>");
  });

  test("a conflicting merge reports conflict: true and leaves the repo mid-merge", async () => {
    git(repoDir, ["switch", "-q", "-c", "clash"]);
    fs.writeFileSync(path.join(repoDir, "README.md"), "# clash branch\n");
    git(repoDir, ["commit", "-qam", "clash edit"]);
    git(repoDir, ["switch", "-q", "main"]);
    fs.writeFileSync(path.join(repoDir, "README.md"), "# main branch\n");
    git(repoDir, ["commit", "-qam", "main edit"]);

    const { res, data } = await merge("clash");
    assert.equal(res.status, 409);
    assert.equal(data.ok, false);
    assert.equal(data.conflict, true);
    assert.match(data.error, /CONFLICT/);
    assert.ok(fs.existsSync(path.join(repoDir, ".git", "MERGE_HEAD")), "repo is left mid-merge for the user to resolve");

    git(repoDir, ["merge", "--abort"]);
  });

  test("rejects an unknown ref, a missing sha and option-like input", async () => {
    const unknown = await merge("does-not-exist");
    assert.equal(unknown.res.status, 409);
    assert.equal(unknown.data.ok, false);

    const missing = await merge("");
    assert.equal(missing.res.status, 400);

    const option = await merge("-x");
    assert.equal(option.res.status, 400);
    assert.equal(option.data.error, "invalid sha or name");
  });
});
