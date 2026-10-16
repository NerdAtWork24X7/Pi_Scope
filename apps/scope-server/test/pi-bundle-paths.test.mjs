// Unit tests for pi-bundle-paths.ts — the rules that decide where Pi Scope's
// bundled `pi` coding agent lives.
//
// The agent is *installed* into the user's data dir (`~/.pi-scope/pi`) instead of
// into the checkout or the package, so it can be updated in place and survives
// re-installing the app. These tests pin the resolution order and the
// homedir-based default, which is what makes the packaged launcher (Windows
// included: `%USERPROFILE%\.pi-scope\pi`) and a dev checkout agree.
//
//   node --test apps/scope-server/test/pi-bundle-paths.test.mjs

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  managedPiBundleDir, repoPiBundleDir, scopeHomeDir, piBundleDirs,
  piCliIn, piEntryIn, piPackageDirIn, resolvePiBundleRoot,
} from "../pi-bundle-paths.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");

let tmpDir;
let bundleDir;  // a fixture that looks like an installed bundle
let emptyDir;   // a fixture that does not
let savedHome;
let savedUserProfile;
let savedOverride;

/** Build `<root>/node_modules/@earendil-works/pi-coding-agent/…` like npm would. */
function seedBundle(root) {
  const pkg = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent");
  fs.mkdirSync(path.join(pkg, "dist", "bundle"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.2.3" }));
  fs.writeFileSync(path.join(pkg, "dist", "bundle", "cli.js"), "// stub cli\n");
  fs.writeFileSync(path.join(pkg, "dist", "index.js"), "// stub entry\n");
}

before(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-pi-paths-")));
  bundleDir = path.join(tmpDir, "bundle");
  emptyDir = path.join(tmpDir, "empty");
  seedBundle(bundleDir);
  fs.mkdirSync(emptyDir, { recursive: true });
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  savedOverride = process.env.SCOPE_PI_BUNDLE_DIR;
});

after(() => {
  for (const [key, value] of [["HOME", savedHome], ["USERPROFILE", savedUserProfile], ["SCOPE_PI_BUNDLE_DIR", savedOverride]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("pi bundle paths: the managed install", () => {
  test("lives in the user's own data dir, not in the checkout", () => {
    const home = path.join(tmpDir, "home-a");
    process.env.HOME = home;
    process.env.USERPROFILE = home;   // os.homedir() reads this one on Windows
    assert.equal(scopeHomeDir(), path.join(home, ".pi-scope"));
    assert.equal(managedPiBundleDir(), path.join(home, ".pi-scope", "pi"));
    // The old location is only a fallback for checkouts that predate this.
    assert.equal(repoPiBundleDir(), path.join(ROOT, "apps", "scope-desktop", "pi-bundle"));
  });

  test("the candidates are the override, the managed install, then the checkout", () => {
    const home = path.join(tmpDir, "home-b");
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.SCOPE_PI_BUNDLE_DIR;
    assert.deepEqual(piBundleDirs(), [
      path.join(home, ".pi-scope", "pi"),
      path.join(ROOT, "apps", "scope-desktop", "pi-bundle"),
    ]);

    process.env.SCOPE_PI_BUNDLE_DIR = bundleDir;
    assert.deepEqual(piBundleDirs(), [
      bundleDir,                                   // an explicit override wins
      path.join(home, ".pi-scope", "pi"),
      path.join(ROOT, "apps", "scope-desktop", "pi-bundle"),
    ]);

    // An override that is the managed dir (or blank) does not duplicate.
    process.env.SCOPE_PI_BUNDLE_DIR = path.join(home, ".pi-scope", "pi");
    assert.deepEqual(piBundleDirs(), [
      path.join(home, ".pi-scope", "pi"),
      path.join(ROOT, "apps", "scope-desktop", "pi-bundle"),
    ]);
    process.env.SCOPE_PI_BUNDLE_DIR = "   ";
    assert.deepEqual(piBundleDirs()[0], path.join(home, ".pi-scope", "pi"));
  });
});

describe("pi bundle paths: probing a bundle", () => {
  test("the CLI and library entries are the ones the server launches/imports", () => {
    const pkg = piPackageDirIn(bundleDir);
    assert.equal(pkg, path.join(bundleDir, "node_modules", "@earendil-works", "pi-coding-agent"));
    assert.equal(piCliIn(bundleDir), path.join(pkg, "dist", "bundle", "cli.js"));
    assert.equal(piEntryIn(bundleDir), path.join(pkg, "dist", "index.js"));
  });

  test("a directory without the package, or nothing at all, is not a bundle", () => {
    for (const candidate of [emptyDir, path.join(tmpDir, "missing"), undefined, ""]) {
      assert.equal(piCliIn(candidate), null, `piCliIn(${String(candidate)})`);
      assert.equal(piEntryIn(candidate), null, `piEntryIn(${String(candidate)})`);
    }
  });

  test("resolvePiBundleRoot honours the override and ignores an empty one", () => {
    process.env.SCOPE_PI_BUNDLE_DIR = bundleDir;
    assert.equal(resolvePiBundleRoot(), bundleDir);

    process.env.SCOPE_PI_BUNDLE_DIR = emptyDir;
    // The override is checked first but is not a bundle, so resolution falls
    // through to the other candidates (the managed dir, then the checkout) — the
    // result depends on what this machine has installed, so only assert that the
    // unusable dir was rejected.
    assert.notEqual(resolvePiBundleRoot(), emptyDir);
  });
});
