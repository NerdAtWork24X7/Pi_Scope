// End-to-end test for the Review dependency graph's import specifiers.
//
// The real server runs against a temp git repo. `/files/graph` must carry the
// literal specifier that created each file edge (`./a.js`, `../a.js`) so the
// diagram can print it on the wire.
//
//   node --test apps/scope-server/test/files-graph.e2e.test.mjs

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
const TOKEN = "files-graph-test-token";

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

async function api(pathname) {
  const res = await fetch(`${base}${pathname}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  return { res, data: await res.json() };
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-files-graph-"));
  repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(path.join(repoDir, "src", "folder"), { recursive: true });
  git(repoDir, ["init", "-q"]);
  git(repoDir, ["config", "user.email", "test@example.com"]);
  git(repoDir, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repoDir, "src", "a.js"), "export const a = 1;\n");
  fs.writeFileSync(path.join(repoDir, "src", "b.js"), 'import { a } from "./a.js";\n');
  fs.writeFileSync(path.join(repoDir, "src", "folder", "c.js"), 'import { a } from "../a.js";\n');
  git(repoDir, ["add", "."]);
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

describe("files graph wiring", () => {
  test("file and module edges carry the literal import specifier", async () => {
    const { res, data } = await api(`/files/graph?cwd=${encodeURIComponent(repoDir)}`);
    assert.ok(res.ok, `HTTP ${res.status}`);
    assert.equal(data.git, true);

    const bToA = data.fileEdges.find((e) => e.from === "src/b.js" && e.to === "src/a.js");
    assert.ok(bToA, "b.js → a.js edge exists");
    assert.deepEqual(bToA.specs, ["./a.js"]);

    const cToA = data.fileEdges.find((e) => e.from === "src/folder/c.js" && e.to === "src/a.js");
    assert.ok(cToA, "c.js → a.js edge exists");
    assert.deepEqual(cToA.specs, ["../a.js"]);

    const modEdge = data.edges.find((e) => e.from === "src/folder" && e.to === "src");
    assert.ok(modEdge, "src/folder → src module edge exists");
    assert.ok(modEdge.specs.includes("../a.js"), "the module edge keeps its specifier");
  });
});
