// Tests for apps/scope-desktop/pi-python-install.mjs — the installer that
// builds Pi Scope's shared Python venv (~/.pi-scope/.venv) with uv from
// pi-venv/requirements.txt, so every Python-dependent element (web_fetch,
// video-creator) reuses one environment.
//
// It is deliberately plain Node with no repo imports, so these tests run it as a
// real child process against temp venvs, with a stub uv + interpreter, and
// never touch the developer's own venv, the network or the real uv.
//
//   node --test apps/scope-server/test/pi-python-install.test.mjs

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const INSTALLER = path.join(ROOT, "apps", "scope-desktop", "pi-python-install.mjs");

let tmpDir;
let stubUv;
let uvRunsFile;
let pyRunsFile;

/** Run the installer and capture its output. */
function install(args, env = {}) {
  const res = spawnSync(process.execPath, [INSTALLER, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, STUB_UV_RUNS: uvRunsFile, STUB_PY_RUNS: pyRunsFile, ...env },
  });
  return { status: res.status, out: res.stdout || "", err: res.stderr || "" };
}

const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : []);
const uvRuns = () => lines(uvRunsFile);
const pyRuns = () => lines(pyRunsFile);
const resetRuns = () => { fs.rmSync(uvRunsFile, { force: true }); fs.rmSync(pyRunsFile, { force: true }); };

/** A requirements file the tests own (playwright pulls in the Chromium step). */
function writeRequirements(name, body = "playwright==1.63.0\nhtml-to-markdown==3.12.2\n") {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, body);
  return file;
}

/**
 * A stub `uv` that records every invocation and, on `venv`, drops in a stub
 * interpreter. The interpreter records the commands the installer runs through
 * it and exits with $STUB_PY_EXIT — that is how the Chromium-download failure
 * path is exercised.
 */
function makeUvStub() {
  const file = path.join(tmpDir, "uv-stub");
  fs.writeFileSync(file, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs'), path = require('node:path');",
    "const a = process.argv.slice(2);",
    "fs.appendFileSync(process.env.STUB_UV_RUNS, JSON.stringify(a) + '\\n');",
    "if (a[0] === 'venv') {",
    "  const dir = a[a.length - 1];",
    "  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });",
    "  const py = path.join(dir, 'bin', 'python3');",
    "  fs.writeFileSync(py, '#!/usr/bin/env node\\n' +",
    "    'require(\"node:fs\").appendFileSync(process.env.STUB_PY_RUNS, JSON.stringify({ args: process.argv.slice(2), browsers: process.env.PLAYWRIGHT_BROWSERS_PATH ?? null, downloadTimeout: process.env.PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT ?? null }) + \"\\\\n\");\\n' +",
    "    'process.exit(Number(process.env.STUB_PY_EXIT || 0));\\n');",
    "  fs.chmodSync(py, 0o755);",
    "}",
    "",
  ].join("\n"));
  fs.chmodSync(file, 0o755);
  return file;
}

before(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-pi-python-")));
  stubUv = makeUvStub();
  uvRunsFile = path.join(tmpDir, "uv-runs.txt");
  pyRunsFile = path.join(tmpDir, "py-runs.txt");
});

after(() => { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe("python venv: building it", () => {
  test("creates the venv, installs the requirements and ensures Chromium", () => {
    const requirements = writeRequirements("build.txt");
    const venv = path.join(tmpDir, "build-venv");
    const browsers = path.join(tmpDir, "build-browsers");
    resetRuns();

    const { status, out } = install(["--venv", venv, "--requirements", requirements, "--browsers", browsers, "--uv", stubUv, "--json"]);
    assert.equal(status, 0, out);
    const report = JSON.parse(out);
    assert.deepEqual(report.installed, ["venv", "requirements", "chromium"]);
    assert.equal(report.upToDate, false);
    assert.equal(report.browsers, browsers);

    const calls = uvRuns();
    assert.deepEqual(JSON.parse(calls[0]), ["venv", "--python", "3.12", venv]);
    assert.deepEqual(JSON.parse(calls[1]), ["pip", "install", "--python", path.join(venv, "bin", "python3"), "-r", requirements]);
    const pyCalls = pyRuns().map((l) => JSON.parse(l));
    assert.equal(pyCalls.length, 1);
    assert.deepEqual(pyCalls[0].args, ["-m", "playwright", "install", "chromium"]);
    assert.equal(pyCalls[0].browsers, browsers, "Chromium installs into Pi Scope's own browsers dir");
    assert.equal(pyCalls[0].downloadTimeout, "600000", "a slow first-run download gets 10 minutes, not Playwright's 30s default");
  });

  test("a satisfied venv is a pure no-op", () => {
    const requirements = writeRequirements("noop.txt");
    const venv = path.join(tmpDir, "noop-venv");
    assert.equal(install(["--venv", venv, "--requirements", requirements, "--uv", stubUv]).status, 0);
    resetRuns();

    const { status, out } = install(["--venv", venv, "--requirements", requirements, "--uv", stubUv, "--json"]);
    assert.equal(status, 0, out);
    assert.equal(JSON.parse(out).upToDate, true);
    assert.deepEqual(uvRuns(), [], "no uv run");
    assert.deepEqual(pyRuns(), [], "no Chromium run");
  });

  test("changed requirements rebuild; an unchanged file does after that", () => {
    const requirements = writeRequirements("rebuild.txt", "playwright==1.63.0\n");
    const venv = path.join(tmpDir, "rebuild-venv");
    assert.equal(install(["--venv", venv, "--requirements", requirements, "--uv", stubUv]).status, 0);
    resetRuns();

    fs.writeFileSync(requirements, "playwright==1.63.0\nhtml-to-markdown==3.12.2\n");
    const second = install(["--venv", venv, "--requirements", requirements, "--uv", stubUv, "--json"]);
    assert.equal(second.status, 0, second.out);
    assert.deepEqual(JSON.parse(second.out).installed, ["requirements", "chromium"], "re-installed, no new venv");
  });

  test("moving the browsers dir reinstalls Chromium, without re-resolving pip", () => {
    const requirements = writeRequirements("browsers.txt", "playwright==1.63.0\n");
    const venv = path.join(tmpDir, "browsers-venv");
    const first = path.join(tmpDir, "browsers-a");
    const second = path.join(tmpDir, "browsers-b");
    assert.equal(install(["--venv", venv, "--requirements", requirements, "--browsers", first, "--uv", stubUv]).status, 0);
    resetRuns();

    const res = install(["--venv", venv, "--requirements", requirements, "--browsers", second, "--uv", stubUv, "--json"]);
    assert.equal(res.status, 0, res.out);
    assert.deepEqual(JSON.parse(res.out).installed, ["chromium"]);
    assert.deepEqual(uvRuns(), [], "no pip resolve");
    assert.equal(pyRuns().map((l) => JSON.parse(l))[0].browsers, second);
  });
});

describe("python venv: failures", () => {
  test("a missing requirements file is a clean error", () => {
    const { status, err } = install(["--venv", path.join(tmpDir, "missing-venv"), "--requirements", path.join(tmpDir, "not-there.txt"), "--uv", stubUv]);
    assert.equal(status, 1);
    assert.match(err, /requirements file not found/, err);
  });

  test("a failed Chromium download is non-fatal and retried next launch, without re-running pip", () => {
    const requirements = writeRequirements("chromium.txt", "playwright==1.63.0\n");
    const venv = path.join(tmpDir, "chromium-venv");
    resetRuns();

    const first = install(["--venv", venv, "--requirements", requirements, "--uv", stubUv, "--json"], { STUB_PY_EXIT: "1" });
    assert.equal(first.status, 0, first.out);
    assert.deepEqual(JSON.parse(first.out).installed, ["venv", "requirements"], "the venv is usable without a browser");
    assert.equal(JSON.parse(fs.readFileSync(path.join(venv, ".pi-scope-venv.json"), "utf8")).chromium, false);

    // Next launch: the packages are already there, so only Chromium is retried.
    resetRuns();
    const second = install(["--venv", venv, "--requirements", requirements, "--uv", stubUv, "--json"], { STUB_PY_EXIT: "1" });
    assert.equal(second.status, 0, second.out);
    assert.deepEqual(uvRuns(), [], "no pip resolve");
    assert.deepEqual(pyRuns().map((l) => JSON.parse(l).args), [["-m", "playwright", "install", "chromium"]]);
  });
});
