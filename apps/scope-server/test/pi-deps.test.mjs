// Unit tests for pi-deps.ts — where the server gets its own runtime packages.
//
// Pi Scope keeps one npm install of runtime packages: the bundled pi project in
// the user's data dir (~/.pi-scope/pi). The server's `node-pty` (Terminal PTY)
// and `ws` (WebSocket layer) come from there, so a checkout does not compile a
// second native node-pty and the desktop app does not declare a duplicate.
//
//   node --test apps/scope-server/test/pi-deps.test.mjs

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { resolvePiDep, loadPiDep } from "../pi-deps.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const SERVER_PACKAGES = ["node-pty", "ws"];

let tmpDir;
let bundleDir;
let savedOverride;

/** Install a tiny (loadable) package into `root/node_modules`, like npm would. */
function seedPackage(root, spec, version) {
  const dir = path.join(root, "node_modules", ...spec.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: spec, version, main: "index.js" }));
  fs.writeFileSync(path.join(dir, "index.js"), `module.exports = { fixture: ${JSON.stringify(spec)} };\n`);
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

before(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-pi-deps-")));
  bundleDir = path.join(tmpDir, "bundle");
  for (const spec of SERVER_PACKAGES) seedPackage(bundleDir, spec, "1.0.0");
  savedOverride = process.env.SCOPE_PI_BUNDLE_DIR;
});

after(() => {
  if (savedOverride === undefined) delete process.env.SCOPE_PI_BUNDLE_DIR;
  else process.env.SCOPE_PI_BUNDLE_DIR = savedOverride;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("pi deps: loaded from the bundled pi install", () => {
  test("the bundle's copy is the one that resolves", () => {
    process.env.SCOPE_PI_BUNDLE_DIR = bundleDir;
    assert.equal(
      resolvePiDep("ws"),
      path.join(bundleDir, "node_modules", "ws", "index.js"),
    );
    assert.equal(loadPiDep("ws").fixture, "ws");
    assert.equal(loadPiDep("node-pty").fixture, "node-pty");
  });

  test("a package the bundle does not have names the install that provides it", () => {
    process.env.SCOPE_PI_BUNDLE_DIR = path.join(tmpDir, "empty");
    assert.throws(
      () => resolvePiDep("scope-fixture-not-installed"),
      /pi-bundle-install\.mjs/,
      "the failure must say how to install the bundle",
    );
  });

  test("neither workspace declares its own copy of the server's packages", () => {
    // The point of the move: the seed project is the only place they are
    // declared, so `npm install` in a checkout never builds a second node-pty.
    const seed = readJson(path.join(ROOT, "apps", "scope-desktop", "pi-bundle", "package.json"));
    for (const spec of SERVER_PACKAGES) {
      assert.ok(seed.dependencies?.[spec], `the pi bundle seed must declare ${spec}`);
    }
    for (const app of ["scope-server", "scope-desktop"]) {
      const pkg = readJson(path.join(ROOT, "apps", app, "package.json"));
      for (const spec of SERVER_PACKAGES) {
        assert.equal(pkg.dependencies?.[spec], undefined, `${app} must not declare ${spec} itself`);
      }
    }
  });
});
