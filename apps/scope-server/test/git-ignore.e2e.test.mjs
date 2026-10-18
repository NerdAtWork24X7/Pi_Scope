// End-to-end tests for the Git view's "Add to .gitignore" action: right-clicking
// an untracked file appends it to the repo's `.gitignore`, which then drops it
// out of `/git/status`.
//
// The real server runs against a temp repo.
//
//   node --test apps/scope-server/test/git-ignore.e2e.test.mjs

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

const TOKEN = "git-ignore-test-token";

let child;
let base;
let tmpDir;
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-git-ignore-"));
  repoDir = path.join(tmpDir, "repo");

  fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, ["init", "-q"]);
  git(repoDir, ["config", "user.email", "test@example.com"]);
  git(repoDir, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repoDir, "README.md"), "# fixture\n");
  git(repoDir, ["add", "README.md"]);
  git(repoDir, ["commit", "-qm", "init"]);

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

describe("git ignore (add to .gitignore)", () => {
  test("appends untracked files and they leave /git/status", async () => {
    fs.writeFileSync(path.join(repoDir, "secret.txt"), "shh\n");
    fs.mkdirSync(path.join(repoDir, "logs"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "logs", "app.log"), "log\n");

    const { res, data } = await api("/git/ignore", {
      method: "POST",
      body: JSON.stringify({ cwd: repoDir, paths: ["secret.txt", "logs/app.log"] }),
    });
    assert.ok(res.ok, `HTTP ${res.status}`);
    assert.equal(data.ok, true);
    assert.deepEqual(data.added, ["secret.txt", "logs/app.log"]);

    const ignore = fs.readFileSync(path.join(repoDir, ".gitignore"), "utf8");
    assert.ok(ignore.split(/\r?\n/).includes("secret.txt"), ".gitignore has secret.txt");
    assert.ok(ignore.split(/\r?\n/).includes("logs/app.log"), ".gitignore has logs/app.log");

    const status = await api(`/git/status?cwd=${encodeURIComponent(repoDir)}`);
    const paths = status.data.files.map((f) => f.path);
    assert.ok(!paths.includes("secret.txt"), "secret.txt is gone from the Git view");
    assert.ok(!paths.includes("logs/app.log"), "logs/app.log is gone from the Git view");
  });

  test("is idempotent — re-adding the same path writes nothing", async () => {
    const before = fs.readFileSync(path.join(repoDir, ".gitignore"), "utf8");
    const { res, data } = await api("/git/ignore", {
      method: "POST",
      body: JSON.stringify({ cwd: repoDir, paths: ["secret.txt"] }),
    });
    assert.ok(res.ok, `HTTP ${res.status}`);
    assert.equal(data.ok, true);
    assert.deepEqual(data.added, []);
    assert.equal(fs.readFileSync(path.join(repoDir, ".gitignore"), "utf8"), before);
  });

  test("escapes a leading '#' so it stays a literal filename", async () => {
    fs.writeFileSync(path.join(repoDir, "#hash.txt"), "hash\n");
    const { res, data } = await api("/git/ignore", {
      method: "POST",
      body: JSON.stringify({ cwd: repoDir, paths: ["#hash.txt"] }),
    });
    assert.ok(res.ok, `HTTP ${res.status}`);
    assert.equal(data.ok, true);
    const ignore = fs.readFileSync(path.join(repoDir, ".gitignore"), "utf8");
    assert.ok(ignore.split(/\r?\n/).includes("\\#hash.txt"), "the '#' is escaped");
    assert.equal(git(repoDir, ["check-ignore", "#hash.txt"]), "#hash.txt");
  });

  test("rejects paths that escape the cwd", async () => {
    const { res } = await api("/git/ignore", {
      method: "POST",
      body: JSON.stringify({ cwd: repoDir, paths: ["../outside.txt"] }),
    });
    assert.equal(res.status, 400);
  });
});
