// End-to-end security regression tests.
//
// Two classes of bug are locked down here:
//   1. Caller-supplied values that reach a git argv slot must never be read as
//      an option (a leading "-"). Every git route validates via rejectOptionLike.
//   2. A path inside the sandbox must not escape it through a symlink
//      (resolveWithinCwd resolves the real path, not just the lexical one).
//
// The real server runs against a temp repo; SCOPE_FILE_ROOT scopes the sandbox.
//
//   node --test apps/scope-server/test/security.e2e.test.mjs

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

const TOKEN = "security-test-token";

let child;
let base;
let tmpDir;
let repoDir;
let outsideDir;

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

const post = (pathname, body) => api(pathname, { method: "POST", body: JSON.stringify(body) });

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-security-"));
  outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-outside-"));
  repoDir = path.join(tmpDir, "repo");

  fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, ["init", "-q"]);
  git(repoDir, ["config", "user.email", "test@example.com"]);
  git(repoDir, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repoDir, "README.md"), "# fixture\n");
  git(repoDir, ["add", "README.md"]);
  git(repoDir, ["commit", "-qm", "init"]);

  // A directory symlink inside the repo pointing out of the sandbox.
  fs.symlinkSync(outsideDir, path.join(repoDir, "escape"), "dir");

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
      // Only the repo's parent is allowed — outsideDir is deliberately not.
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
  if (outsideDir) fs.rmSync(outsideDir, { recursive: true, force: true });
});

describe("git option-injection guards", () => {
  test("GET /git/show rejects an option-like sha but accepts a real one", async () => {
    const bad = await api(`/git/show?cwd=${encodeURIComponent(repoDir)}&sha=--all`);
    assert.equal(bad.res.status, 400);

    const head = git(repoDir, ["rev-parse", "HEAD"]);
    const good = await api(`/git/show?cwd=${encodeURIComponent(repoDir)}&sha=${head}`);
    assert.ok(good.res.ok, `expected 200, got ${good.res.status}`);
    assert.equal(good.data.ok, true);
  });

  test("push/pull/fetch reject option-like remote or branch", async () => {
    for (const route of ["/git/push", "/git/pull", "/git/fetch"]) {
      const remote = await post(route, { cwd: repoDir, remote: "--force" });
      assert.equal(remote.res.status, 400, `${route} rejected option-like remote`);
      const branch = await post(route, { cwd: repoDir, branch: "--tags" });
      assert.equal(branch.res.status, 400, `${route} rejected option-like branch`);
    }
  });

  test("checkpoints reject a malformed ref and an option-like merge target", async () => {
    const restore = await post("/checkpoints/restore", { cwd: repoDir, ref: "refs/checkpoints/../../HEAD" });
    assert.equal(restore.res.status, 400);

    const merge = await post("/checkpoints/merge", {
      cwd: repoDir, ref: "refs/checkpoints/aaaa/bbbb", target: "--help",
    });
    assert.equal(merge.res.status, 400, "option-like target refused before any git call");

    const del = await post("/checkpoints/delete", { cwd: repoDir, ref: "refs/checkpoints/a/b/c" });
    assert.equal(del.res.status, 400);
  });
});

describe("sandbox escapes via symlink", () => {
  test("POST /files/save cannot write through a symlink that leaves the root", async () => {
    const { res, data } = await post("/files/save", {
      cwd: repoDir, file: "escape/pwn.txt", content: "escaped",
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(data)}`);
    assert.equal(fs.existsSync(path.join(outsideDir, "pwn.txt")), false, "nothing written outside the root");
  });

  test("POST /files/save still writes a normal in-root file", async () => {
    const { res, data } = await post("/files/save", {
      cwd: repoDir, file: "sub/ok.txt", content: "hello",
    });
    assert.ok(res.ok, `expected 200, got ${res.status}: ${JSON.stringify(data)}`);
    assert.equal(data.ok, true);
    assert.equal(fs.readFileSync(path.join(repoDir, "sub", "ok.txt"), "utf8"), "hello");
  });
});
