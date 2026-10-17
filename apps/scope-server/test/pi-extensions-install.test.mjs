// Tests for apps/scope-desktop/pi-extensions-install.mjs — the installer that
// walks the extensions pi has available, reads the npm packages each one
// declares in a nearby package.json, and installs the missing ones into the
// agent dir's own npm project (<agent dir>/pi by default, or an explicit
// --bundle).
//
// It is deliberately plain Node with no repo imports, so these tests run it as a
// real child process against temp agent dirs and bundles, with a stub package
// manager, and never touch the developer's own install or the network.
//
//   node --test apps/scope-server/test/pi-extensions-install.test.mjs

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const INSTALLER = path.join(ROOT, "apps", "scope-desktop", "pi-extensions-install.mjs");
const EXAMPLE_AGENT = path.join(ROOT, "examples", "pi_local", "agent");

let tmpDir;
let stub;
let runsFile;

/** Run the installer and capture its output. */
function install(args, env = {}) {
  const res = spawnSync(process.execPath, [INSTALLER, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, SCOPE_NPM_BIN: stub, STUB_RUNS: runsFile, ...env },
  });
  return { status: res.status, out: res.stdout || "", err: res.stderr || "" };
}

/**
 * Run the installer without blocking, so two can overlap (the way two launches
 * of Pi Scope start it). Resolves with the same shape `install` returns.
 */
function installAsync(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [INSTALLER, ...args], {
      cwd: ROOT,
      env: { ...process.env, SCOPE_NPM_BIN: stub, STUB_RUNS: runsFile, ...env },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("close", (status) => resolve({ status, out, err }));
  });
}

const runs = () => (fs.existsSync(runsFile) ? fs.readFileSync(runsFile, "utf8").trim().split("\n").filter(Boolean) : []);
/** Forget the installs earlier tests triggered (the log is shared on purpose). */
const resetRuns = () => fs.rmSync(runsFile, { force: true });

/**
 * A stub package manager: records the directory it ran in and installs every
 * dependency the bundle's manifest names — the part of `npm install` the
 * installer's verification depends on.
 *
 * `mode: "transient"` makes it fail with npm's `ENOTEMPTY` (and install nothing)
 * on its first two runs, then succeed. That is the state an interrupted npm run
 * leaves behind, and it is what the installer's recover-and-retry has to clear.
 */
function makeNpmStub({ mode = "sync" } = {}) {
  const file = path.join(tmpDir, mode === "sync" ? "npm-stub" : `npm-stub-${mode}`);
  const counter = path.join(tmpDir, `npm-count-${mode}`);
  fs.writeFileSync(counter, "0");
  const lines = [
    "#!/usr/bin/env node",
    "const fs = require('node:fs'), path = require('node:path');",
    "fs.appendFileSync(process.env.STUB_RUNS, process.cwd() + '\\n');",
  ];
  if (mode === "slow") {
    // Hold the install open long enough that a second installer started at the
    // same time finds the lock held (SCOPE_EXTENSIONS_LOCK_WAIT_MS is lowered).
    lines.push("Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);");
  }
  if (mode === "transient") {
    lines.push(
      "const countFile = process.env.STUB_COUNT;",
      "const n = Number(fs.readFileSync(countFile, 'utf8')) + 1;",
      "fs.writeFileSync(countFile, String(n));",
      // The first run reproduces an interrupted npm run exactly: nothing is
      // installed and the removal of a half-empty tree fails with ENOTEMPTY. The
      // second run (the installer's retry from a clean tree) succeeds.
      "if (n <= 1) {",
      "  console.error('npm error code ENOTEMPTY');",
      "  console.error('npm error syscall rmdir');",
      "  console.error(\"npm error ENOTEMPTY: directory not empty, rmdir 'node_modules/fs-extra/lib/ensure'\");",
      "  process.exit(1);",
      "}",
    );
  }
  lines.push(
    "const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));",
    "for (const name of Object.keys(pkg.dependencies ?? {})) {",
    "  const dir = path.join('node_modules', ...name.split('/'));",
    "  fs.mkdirSync(dir, { recursive: true });",
    "  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '9.9.9' }));",
    "}",
    "",
  );
  fs.writeFileSync(file, lines.join("\n"));
  fs.chmodSync(file, 0o755);
  return { file, counter };
}

/** An agent dir with the given extension files and, optionally, a manifest. */
function makeAgent(name, { files = {}, manifest, settings } = {}) {
  const root = path.join(tmpDir, name);
  for (const [rel, contents] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  if (manifest) fs.writeFileSync(path.join(root, "extensions", "package.json"), JSON.stringify(manifest, null, 2));
  if (settings) fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify(settings, null, 2));
  fs.mkdirSync(path.join(root, "extensions"), { recursive: true });
  return root;
}

/** A bundle whose manifest looks like the installed pi project. */
function makeBundle(name, dependencies = {}) {
  const root = path.join(tmpDir, name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "pi-scope-pi-bundle", private: true, dependencies }, null, 2));
  return root;
}

const installedIn = (bundle, spec) => fs.existsSync(path.join(bundle, "node_modules", ...spec.split("/"), "package.json"));
const readManifest = (bundle) => JSON.parse(fs.readFileSync(path.join(bundle, "package.json"), "utf8"));

before(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-pi-extensions-")));
  stub = makeNpmStub().file;
  runsFile = path.join(tmpDir, "runs.txt");
});

after(() => { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe("extension deps: what pi has available", () => {
  test("only extensions pi would load are inspected, and host packages are skipped", () => {
    const agent = makeAgent("available", {
      files: {
        "extensions/browser.ts": "export default () => {};\n",
        "extensions/notes.md": "not an extension\n",
        "extensions/team/index.ts": "export default () => {};\n",
        "extensions/not-an-extension/index.ts": "export default () => {};\n",
      },
      manifest: {
        dependencies: { playwright: "^1.63.0", "@earendil-works/pi-ai": "*", "@mariozechner/pi-tui": "*", typebox: "*" },
      },
      settings: { extensions: ["+extensions/browser.ts", "-extensions/team/index.ts"] },
    });
    const bundle = makeBundle("available-bundle", { "ws": "^8.18.0" });

    const { status, out } = install(["--agent", agent, "--bundle", bundle]);
    assert.equal(status, 0, out);
    const expected = [
      "extensions available to pi: 1",
      `npm dependencies in ${path.join("extensions", "package.json")}: playwright`,
      `disabled in settings.json: ${path.join("extensions", "team")}`,
    ];
    for (const line of expected) assert.ok(out.includes(line), `${JSON.stringify(line)} missing from:\n${out}`);

    // Only the browser extension's package was installed — not a file that is
    // not an extension, not the disabled one, and none of pi's own packages.
    assert.ok(installedIn(bundle, "playwright"), "playwright installed");
    for (const spec of ["@earendil-works/pi-ai", "@mariozechner/pi-tui", "typebox"]) {
      assert.ok(!installedIn(bundle, spec), `${spec} must not be installed (pi provides it)`);
    }
  });

  test("an extension with no nearby manifest contributes nothing", () => {
    const agent = makeAgent("no-manifest", { files: { "extensions/hello.ts": "export default () => {};\n" } });
    const bundle = makeBundle("no-manifest-bundle");
    resetRuns();

    const { status, out } = install(["--agent", agent, "--bundle", bundle]);
    assert.equal(status, 0, out);
    assert.deepEqual(runs(), [], "no package manager run");
    assert.match(out, /extensions available to pi: 1$/m, out);
  });

  test("a directory extension and its index entry are the same extension", () => {
    const agent = makeAgent("canonical", {
      files: { "extensions/team/index.ts": "export default () => {};\n" },
      manifest: { dependencies: { playwright: "^1.63.0" } },
      settings: { extensions: ["+extensions/team/index.ts", "+extensions/team"] },
    });
    const bundle = makeBundle("canonical-bundle");
    const { status, out } = install(["--agent", agent, "--bundle", bundle, "--json"]);
    assert.equal(status, 0, out);

    const report = JSON.parse(out);
    assert.deepEqual(report.extensions, [path.join(agent, "extensions", "team")]);
    assert.equal(report.manifests.length, 1, JSON.stringify(report.manifests));
  });
});

describe("extension deps: installing into the bundled pi project", () => {
  test("the missing packages are installed there and recorded in its manifest", () => {
    const agent = makeAgent("install", {
      files: { "extensions/browser.ts": "export default () => {};\n" },
      manifest: { dependencies: { playwright: "^1.63.0", "puppeteer-extra-plugin-stealth": "^2.11.2" }, allowScripts: { playwright: true } },
    });
    const bundle = makeBundle("install-bundle", { "ws": "^8.18.0" });
    resetRuns();

    const { status, out } = install(["--agent", agent, "--bundle", bundle]);
    assert.equal(status, 0, out);
    assert.equal(runs().length, 1, "one install run");
    // It reused the bundle's tree, in the bundle's own directory.
    assert.deepEqual(runs(), [fs.realpathSync(bundle)]);
    for (const spec of ["playwright", "puppeteer-extra-plugin-stealth"]) {
      assert.ok(installedIn(bundle, spec), `${spec} installed in the bundle`);
    }
    // …and the bundle's manifest now carries them, so a later `npm install`
    // (or Settings → Update) keeps the tree reproducible. The entry it already
    // had is untouched.
    const manifest = readManifest(bundle);
    assert.equal(manifest.dependencies.playwright, "^1.63.0");
    assert.equal(manifest.dependencies.ws, "^8.18.0");
    assert.equal(manifest.allowScripts.playwright, true);
  });

  test("an extension's range never rewrites a version the bundle already has", () => {
    const agent = makeAgent("keep-range", {
      files: { "extensions/browser.ts": "export default () => {};\n" },
      manifest: { dependencies: { playwright: "^1.0.0" } },
    });
    const bundle = makeBundle("keep-range-bundle", { playwright: "1.63.0" });

    assert.equal(install(["--agent", agent, "--bundle", bundle]).status, 0);
    assert.equal(readManifest(bundle).dependencies.playwright, "1.63.0");
  });

  test("a second run is a no-op", () => {
    const agent = makeAgent("again", {
      files: { "extensions/browser.ts": "export default () => {};\n" },
      manifest: { dependencies: { playwright: "^1.63.0" } },
    });
    const bundle = makeBundle("again-bundle");
    resetRuns();
    assert.equal(install(["--agent", agent, "--bundle", bundle]).status, 0);
    const manifest = path.join(bundle, "package.json");
    const before = fs.statSync(manifest).mtimeMs;
    const runsBefore = runs().length;

    const second = install(["--agent", agent, "--bundle", bundle]);
    assert.equal(second.status, 0, second.out);
    assert.match(second.out, /already installed/, second.out);
    assert.equal(runs().length, runsBefore, "no second install run");
    assert.equal(fs.statSync(manifest).mtimeMs, before, "the manifest is not rewritten");
  });

  test("with no --bundle it installs into the agent dir's own project (<agent>/pi)", () => {
    const agent = makeAgent("default-root", {
      files: { "extensions/browser.ts": "export default () => {};\n" },
      manifest: { dependencies: { playwright: "^1.63.0" }, allowScripts: { playwright: true } },
    });
    resetRuns();

    const { status, out } = install(["--agent", agent]);
    assert.equal(status, 0, out);
    const project = path.join(agent, "pi");
    assert.deepEqual(runs(), [fs.realpathSync(project)], "the package manager runs inside <agent>/pi");
    assert.ok(installedIn(project, "playwright"), "playwright installed in <agent>/pi");
    const manifest = readManifest(project);
    assert.equal(manifest.dependencies.playwright, "^1.63.0");
    assert.equal(manifest.allowScripts.playwright, true);
  });
});

describe("extension deps: nothing to do", () => {
  test("no agent dir yet is a normal state", () => {
    const { status, out } = install(["--agent", path.join(tmpDir, "missing-agent"), "--bundle", path.join(tmpDir, "missing-bundle")]);
    assert.equal(status, 0);
    assert.match(out, /no agent dir/);
  });

  test("an agent dir without extensions is left alone", () => {
    const agent = makeAgent("empty", {});
    resetRuns();
    const { status, out } = install(["--agent", agent, "--bundle", makeBundle("empty-bundle")]);
    assert.equal(status, 0);
    assert.match(out, /no extensions in/, out);
    assert.deepEqual(runs(), [], "no package manager run");
  });
});

describe("extension deps: failures are reported, never hidden", () => {
  test("no bundled pi project to install into", () => {
    const agent = makeAgent("no-bundle", {
      files: { "extensions/browser.ts": "export default () => {};\n" },
      manifest: { dependencies: { playwright: "^1.63.0" } },
    });
    const bundle = path.join(tmpDir, "does-not-exist");
    const { status, err } = install(["--agent", agent, "--bundle", bundle]);
    assert.equal(status, 1);
    assert.match(err, /no bundled pi project/, err);
  });

  test("a failing package manager is a non-zero exit with a reason", () => {
    const agent = makeAgent("fail", {
      files: { "extensions/browser.ts": "export default () => {};\n" },
      manifest: { dependencies: { playwright: "^1.63.0" } },
    });
    const bundle = makeBundle("fail-bundle");
    const failing = path.join(tmpDir, "npm-fail");
    fs.writeFileSync(failing, "#!/bin/sh\nexit 3\n");
    fs.chmodSync(failing, 0o755);

    const { status, err } = install(["--agent", agent, "--bundle", bundle], { SCOPE_NPM_BIN: failing });
    assert.equal(status, 1);
    assert.match(err, /install failed/, err);
    assert.ok(!installedIn(bundle, "playwright"));
  });

  test("a package the manager does not produce is caught by the verification", () => {
    const agent = makeAgent("verify", {
      files: { "extensions/browser.ts": "export default () => {};\n" },
      manifest: { dependencies: { playwright: "^1.63.0" } },
    });
    const bundle = makeBundle("verify-bundle");
    const noop = path.join(tmpDir, "npm-noop");
    fs.writeFileSync(noop, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(noop, 0o755);

    const { status, err } = install(["--agent", agent, "--bundle", bundle], { SCOPE_NPM_BIN: noop });
    assert.equal(status, 1);
    assert.match(err, /still missing/, err);
  });
});

describe("extension deps: an agent dir seeded before the manifest existed", () => {
  test("--seed-manifest declares the shipped extensions' packages for it", () => {
    // No manifest in the agent dir (the dir is seeded once and never re-seeded),
    // so the shipped one is the only declaration available.
    const agent = makeAgent("seeded-earlier", { files: { "extensions/browser.ts": "export default () => {};\n" } });
    const bundle = makeBundle("seeded-earlier-bundle");
    const seed = path.join(EXAMPLE_AGENT, "extensions", "package.json");
    resetRuns();

    const { status, out } = install(["--agent", agent, "--bundle", bundle, "--seed-manifest", seed, "--json"]);
    assert.equal(status, 0, out);

    const report = JSON.parse(out);
    assert.equal(report.seedManifest, fs.realpathSync(seed));
    assert.equal(report.manifests.length, 1);
    assert.equal(report.manifests[0].manifest, fs.realpathSync(seed));
    assert.equal(report.manifests[0].shipped, true);
    assert.deepEqual(report.manifests[0].extensions, [path.join(agent, "extensions", "browser.ts")]);
    for (const spec of ["playwright", "playwright-extra", "puppeteer-extra", "puppeteer-extra-plugin-stealth"]) {
      assert.ok(installedIn(bundle, spec), `${spec} installed into the bundle`);
    }
    assert.deepEqual(readManifest(bundle).allowScripts, { playwright: true });
  });

  test("a missing --seed-manifest is ignored, not an error", () => {
    const agent = makeAgent("no-seed", { files: { "extensions/hello.ts": "export default () => {};\n" } });
    const { status } = install([
      "--agent", agent, "--bundle", makeBundle("no-seed-bundle"),
      "--seed-manifest", path.join(tmpDir, "not-there.json"),
    ]);
    assert.equal(status, 0);
  });
});

describe("extension deps: concurrent launches and interrupted installs", () => {
  test("two overlapping installers run npm only once", async () => {
    // The state that produced the ENOTEMPTY report: two launches both start this
    // installer in the background against the same tree. The lock serialises
    // them, and the second finds the work already done.
    const agent = makeAgent("concurrent", {
      files: { "extensions/browser.ts": "export default () => {};\n" },
      manifest: { dependencies: { playwright: "^1.63.0" } },
    });
    const bundle = makeBundle("concurrent-bundle");
    const { file: slow, counter } = makeNpmStub({ mode: "slow" });
    resetRuns();
    const env = { SCOPE_NPM_BIN: slow, STUB_COUNT: counter, SCOPE_EXTENSIONS_LOCK_WAIT_MS: "30000" };

    const [a, b] = await Promise.all([
      installAsync(["--agent", agent, "--bundle", bundle], env),
      installAsync(["--agent", agent, "--bundle", bundle], env),
    ]);
    assert.equal(a.status, 0, `${a.out}\n${a.err}`);
    assert.equal(b.status, 0, `${b.out}\n${b.err}`);
    assert.equal(runs().length, 1, `npm must run once, ran ${runs().length} time(s)`);
    assert.ok(installedIn(bundle, "playwright"), "playwright installed");
  });

  test("a transient ENOTEMPTY is retried from a clean tree", () => {
    const agent = makeAgent("transient", {
      files: { "extensions/browser.ts": "export default () => {};\n" },
      manifest: { dependencies: { playwright: "^1.63.0" } },
    });
    const bundle = makeBundle("transient-bundle");
    const { file: flaky, counter } = makeNpmStub({ mode: "transient" });
    resetRuns();

    const { status, out, err } = install(
      ["--agent", agent, "--bundle", bundle],
      { SCOPE_NPM_BIN: flaky, STUB_COUNT: counter },
    );
    // The stub fails its first run before succeeding; the installer clears the
    // tree and tries again, so the final result is a real install, not the error.
    assert.equal(status, 0, `${out}\n${err}`);
    assert.match(out, /transient error/, out);
    assert.equal(runs().length, 2, `expected one failure and one retry, ran ${runs().length}`);
    assert.ok(installedIn(bundle, "playwright"), "playwright installed after the retry");
  });

  test("a real failure is retried but still reported, never hidden", () => {
    const agent = makeAgent("still-fails", {
      files: { "extensions/browser.ts": "export default () => {};\n" },
      manifest: { dependencies: { playwright: "^1.63.0" } },
    });
    const bundle = makeBundle("still-fails-bundle");
    // Always ENOTEMPTY: recovery runs, but the failure is genuine and must surface.
    const always = path.join(tmpDir, "npm-always-transient");
    fs.writeFileSync(always, [
      "#!/bin/sh",
      "echo \"npm error code ENOTEMPTY\" >&2",
      "echo \"npm error syscall rmdir\" >&2",
      "exit 1",
      "",
    ].join("\n"));
    fs.chmodSync(always, 0o755);
    resetRuns();

    const { status, err } = install(["--agent", agent, "--bundle", bundle], { SCOPE_NPM_BIN: always });
    assert.equal(status, 1);
    assert.match(err, /install failed/, err);
    assert.ok(!installedIn(bundle, "playwright"));
  });
});

describe("extension deps: the extensions Pi Scope ships", () => {
  test("their declarations install into the bundle, as one tree", () => {
    // The real template's extensions + settings.json, against a temp bundle.
    const bundle = makeBundle("shipped-bundle");
    const { status, out } = install(["--agent", EXAMPLE_AGENT, "--bundle", bundle, "--json"]);
    assert.equal(status, 0, out);

    const report = JSON.parse(out);
    const browser = path.join(EXAMPLE_AGENT, "extensions", "browser.ts");
    assert.ok(report.extensions.includes(browser), `browser.ts must be discovered: ${JSON.stringify(report.extensions)}`);
    // The shipped manifest is the single place the `browser` extension's
    // packages are declared (pi provides the @mariozechner/* ones, so they are
    // not repeated here).
    const manifest = report.manifests.find((entry) => entry.extensions.includes(browser));
    assert.ok(manifest, `no manifest covers browser.ts: ${JSON.stringify(report.manifests)}`);
    assert.equal(manifest.manifest, path.join(EXAMPLE_AGENT, "extensions", "package.json"));
    assert.deepEqual(Object.keys(manifest.dependencies).sort(), [
      "playwright", "playwright-extra", "puppeteer-extra", "puppeteer-extra-plugin-stealth",
    ]);
    for (const spec of Object.keys(manifest.dependencies)) {
      assert.ok(installedIn(bundle, spec), `${spec} installed into the bundle`);
    }
    assert.equal(report.ok, true);
  });
});
