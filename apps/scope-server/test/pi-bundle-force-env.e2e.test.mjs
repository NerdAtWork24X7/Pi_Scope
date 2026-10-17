// The bundled launch must name its force-loaded extension as authoritative.
//
// Pi Scope force-loads the telemetry extension with `--extension <pi-scope.ts>`,
// but pi *also* discovers every file under `<agentDir>/extensions/`. A copy left
// there (by a user following the README, or by an older build) registers the very
// same CLI flags, and pi aborts every process Pi Scope spawns with
//
//   Error: Failed to load extension "…/agent/extensions/pi-scope.ts":
//   Flag "--o-name" conflicts with …/extension/pi-scope.ts
//
// before the first prompt. The `pi` shim prevents that by exporting
// PI_SCOPE_FORCE_EXTENSION — the marker the extension's duplicate-copy guard
// stands down on — but the git-commit-message generator (and Chat wherever it
// can't spawn through the user's shell) runs the bundled CLI directly, bypassing
// the shim. Without the marker on that path the run dies at startup, which the
// Git view reported as "could not generate a commit message: Error: Failed to
// load extension …".
//
// So the marker is part of the launch contract, not a shim-only detail: whatever
// argv Pi Scope force-loads, the environment has to name the same file. These
// tests pin that, and prove (with a deliberately broken extension in the agent
// dir) that the child really does discover extensions from there — otherwise the
// no-collision assertion below would pass for the wrong reason.
//
// Skips when the dev pi bundle isn't installed: without it the server falls back
// to whatever `pi` is on PATH and none of this is exercised.
//
//   node --test apps/scope-server/test/pi-bundle-force-env.e2e.test.mjs

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { fileURLToPath } from "node:url";
import { PI_BUNDLE_CLI, piBundleDirs } from "./bundle-path.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const SERVER = path.join(ROOT, "apps", "scope-server", "server.ts");
const EXTENSION = path.join(ROOT, "extension", "pi-scope.ts");
const BUNDLE_CLI = PI_BUNDLE_CLI;
const HAS_BUNDLE = Boolean(BUNDLE_CLI) && fs.existsSync(EXTENSION);

/** Merge the launch env the way chatChildEnv does: the server's own environment
 *  (which is where the marker lives) plus a per-run agent dir. */
function childEnv(agentDir) {
  return { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir };
}

/** Run the bundled agent exactly as the direct launch would, and collect every
 *  line it prints. The model is deliberately nonexistent: the run must fail
 *  *after* extension loading, so any extension error in the output came from
 *  startup and not from the provider call. */
function runLaunched(args, env, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { out += String(d); });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      reject(new Error(`pi did not exit within ${timeoutMs}ms:\n${out}`));
    }, timeoutMs);
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", () => { clearTimeout(timer); resolve(out); });
  });
}

describe("bundled pi: the force-loaded extension is named in the environment", {
  skip: HAS_BUNDLE ? false : `dev pi bundle not installed (${BUNDLE_CLI})`,
}, () => {
  let tmpDir;
  let PI_LAUNCH;
  let PI_BUNDLE;

  before(async () => {
    // Temp runtime dirs so the import's side effects (shim, agent dir) stay out
    // of ~/.pi-scope and the repo.
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-pi-force-env-")));
    process.env.SCOPE_AGENT_DIR = path.join(tmpDir, "agent");
    process.env.SCOPE_TOKEN_FILE = path.join(tmpDir, "scope_token");
    // Never let an operator override win: this test is about the bundled path.
    process.env.SCOPE_PI_BIN = "";
    process.env.SCOPE_PYTHON_VENV = "";
    ({ PI_LAUNCH, PI_BUNDLE } = await import(new URL("../pi-bundle.ts", import.meta.url).href));
  });

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("the bundled agent resolves from the user's own install", () => {
    // The install lives in the data dir (~/.pi-scope/pi) and is seeded there by
    // the launcher / the packaged app — never inside the checkout. A
    // checkout that predates that layout still resolves, which is what keeps an
    // old dev tree working until the launcher migrates it.
    assert.ok(piBundleDirs().includes(PI_BUNDLE.dir), `${PI_BUNDLE.dir} is a candidate: ${piBundleDirs().join(", ")}`);
    assert.ok(fs.existsSync(PI_BUNDLE.cli), `the CLI exists: ${PI_BUNDLE.cli}`);
    assert.ok(fs.existsSync(PI_BUNDLE.bin), `the shim exists: ${PI_BUNDLE.bin}`);
    assert.ok(fs.existsSync(PI_BUNDLE.extension), `the extension exists: ${PI_BUNDLE.extension}`);
  });

  test("the launch argv and the marker name the same extension", () => {
    const at = PI_LAUNCH.args.indexOf("--extension");
    assert.ok(at >= 0, `the bundled launch force-loads the extension: ${PI_LAUNCH.args.join(" ")}`);
    const forced = PI_LAUNCH.args[at + 1];
    assert.equal(
      process.env.PI_SCOPE_FORCE_EXTENSION,
      forced,
      "the environment must name the force-loaded copy, or a copy pi discovers on its own collides with it",
    );
  });

  test("the shim names the agent dir's npm project as the extensions' module root", () => {
    // Extensions that resolve their own npm packages at run time (the `browser`
    // extension) look at PI_BROWSER_MODULE_ROOT, and pi-extensions-install.mjs
    // installed those packages into the agent dir's own npm project
    // (<agentDir>/pi). Pointing at it here — rather than leaving the extension to
    // fall back on cwd/$HOME — is what makes them findable however the agent was
    // started.
    const agentPiDir = path.join(process.env.SCOPE_AGENT_DIR, "pi");
    assert.equal(process.env.PI_BROWSER_MODULE_ROOT, agentPiDir);
    const shim = fs.readFileSync(PI_BUNDLE.bin, "utf8");
    assert.ok(shim.includes("PI_BROWSER_MODULE_ROOT"), `the shim exports the module root:\n${shim}`);
    assert.ok(shim.includes(agentPiDir), `the shim names the agent npm project (${agentPiDir}):\n${shim}`);
  });

  test("the shim names the shared Python venv and puts it on PATH", () => {
    // The Python-dependent elements (web_fetch, video-creator) reuse one venv
    // built by pi-python-install.mjs; the shim names it and prepends its bin so
    // `python`/`playwright` resolve from it however the agent was started.
    const scopeVenv = path.join(tmpDir, ".venv");
    assert.equal(process.env.SCOPE_PYTHON_VENV, scopeVenv);
    const shim = fs.readFileSync(PI_BUNDLE.bin, "utf8");
    assert.ok(shim.includes("SCOPE_PYTHON_VENV"), `the shim exports the venv variable:\n${shim}`);
    assert.ok(shim.includes(scopeVenv), `the shim names the shared venv (${scopeVenv}):\n${shim}`);
  });

  test("the child really discovers extensions in the agent dir", async () => {
    // The control for the test below. A broken file pi finds on its own must be
    // reported, proving that the copy in the next test is loaded too — and that
    // its silence there means the guard stood down, not that pi never looked.
    const agentDir = path.join(tmpDir, "probe-agent");
    fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "extensions", "zz-probe.ts"),
      "export default function (pi) { syntax error (((\n",
    );

    const out = await runLaunched([...PI_LAUNCH.args, "--print", "--no-session", "--model", "does-not/exist", "hi"], childEnv(agentDir));
    assert.match(out, /Failed to load extension .*zz-probe\.ts/, `expected the probe to be reported, got:\n${out}`);
  });

  test("a copy in the agent dir no longer collides with the force-loaded one", async () => {
    // The exact failure state: the extension sits in the agent dir *and* is
    // force-loaded, at two different paths, so path identity can't save us.
    const agentDir = path.join(tmpDir, "collide-agent");
    fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "extensions", "pi-scope.ts"), fs.readFileSync(EXTENSION));

    const out = await runLaunched([...PI_LAUNCH.args, "--print", "--no-session", "--model", "does-not/exist", "hi"], childEnv(agentDir));
    assert.ok(
      !/conflicts with/.test(out),
      `the discovered copy must stand down, got:\n${out}`,
    );
    assert.ok(
      !/Failed to load extension/.test(out),
      `no extension may fail to load, got:\n${out}`,
    );
  });
});

// The same guarantee, end to end through the interface that reported it: the
// Git view's "✨ generate" button. The server is run for real against the bundled
// agent, with the extension sitting in its agent dir, and the commit-message
// model pointed at a model that cannot resolve — so pi reaches the point where
// it would have died on the flag conflict and fails on the model instead. The
// failure the user saw (`could not generate a commit message: Error: Failed to
// load extension … Flag "--o-name" conflicts with …`) must be gone.
describe("git commit message generation with a copy in the agent dir", {
  skip: HAS_BUNDLE ? false : `dev pi bundle not installed (${BUNDLE_CLI})`,
}, () => {
  const TOKEN = "pi-force-env-token";
  const UNKNOWN_MODEL = "does-not/exist";
  let tmpDir;
  let repoDir;
  let base;
  let child;
  let logged = "";

  function git(cwd, args) {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  }

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
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-pi-force-env-e2e-")));
    const agentDir = path.join(tmpDir, "agent");
    // The reported state: the extension lives in the agent dir too, so pi loads
    // it as well as the copy the launch force-loads.
    fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "extensions", "pi-scope.ts"), fs.readFileSync(EXTENSION));

    repoDir = path.join(tmpDir, "repo");
    fs.mkdirSync(repoDir, { recursive: true });
    git(repoDir, ["init", "-q"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repoDir, "README.md"), "# fixture\n");
    git(repoDir, ["add", "README.md"]);
    git(repoDir, ["commit", "-qm", "chore: seed"]);
    fs.writeFileSync(path.join(repoDir, "feature.js"), "export const answer = 42;\n");
    git(repoDir, ["add", "feature.js"]);

    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const env = {
      ...process.env,
      SCOPE_PORT: String(port),
      SCOPE_HOST: "127.0.0.1",
      SCOPE_DB_PATH: path.join(tmpDir, "scope.db"),
      SCOPE_AUTH_TOKEN: TOKEN,
      SCOPE_PLUGINS_DIR: path.join(tmpDir, "plugins"),
      SCOPE_AGENT_DIR: agentDir,
      SCOPE_TOKEN_FILE: path.join(tmpDir, "scope_token"),
      SCOPE_FILE_ROOT: repoDir,
      // No override: the bundled agent (and therefore this test’s subject) is used.
      SCOPE_PI_BIN: "",
      SCOPE_MODEL_CATALOG: "off",
    };
    // This file imported pi-bundle.ts in its own process (see above), which set
    // the marker there. Drop it, so the only way the server’s child can see it is
    // the server setting it itself — otherwise this test would pass on the
    // harness’s env, not on the fix.
    delete env.PI_SCOPE_FORCE_EXTENSION;

    child = spawn(process.execPath, [SERVER], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => { logged += String(d); });
    child.stderr.on("data", (d) => { logged += String(d); });

    const start = Date.now();
    while (Date.now() - start < 20_000) {
      try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok((await fetch(`${base}/health`)).ok, `server never became healthy:\n${logged}`);

    const set = await api("/settings", {
      method: "POST", body: JSON.stringify({ action: "setGitCommitModel", value: UNKNOWN_MODEL }),
    });
    assert.ok(set.res.ok, `could not pin the commit model: ${JSON.stringify(set.data)}`);
  });

  after(async () => {
    if (child) {
      child.kill("SIGKILL");
      await new Promise((r) => child.once("exit", r));
    }
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("the draft fails on the model, not on a duplicate extension", async () => {
    const { res, data } = await api("/git/commit-message", {
      method: "POST", body: JSON.stringify({ cwd: repoDir }),
    });
    const error = String(data?.error ?? "");

    assert.equal(res.status, 502, `expected 502, got ${res.status}: ${JSON.stringify(data)}`);
    assert.ok(!/conflicts with/.test(error), `a discovered copy collided with the force-loaded one: ${error}`);
    assert.ok(!/Failed to load extension/.test(error), `an extension failed to load: ${error}`);
    // …and the failure is the model one, which means pi got past extension
    // loading and resolved the (deliberately unknown) model.
    assert.match(error, /does-not\/exist|not found/i, `unexpected failure: ${error}`);
  });
});
