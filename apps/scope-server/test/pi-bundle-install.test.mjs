// Tests for apps/scope-desktop/pi-bundle-install.mjs — the one installer every
// entry point uses to put the bundled `pi` coding agent in the user's data dir
// (~/.pi-scope/pi): the dev launcher (pi-scope.mjs / run.sh), install.sh,
// install.ps1 and the packaged app's scope-control.js.
//
// It is deliberately plain Node with no repo imports, which is why it can run
// under the packaged app's portable Node on every platform — these tests run it
// as a real child process, with temp dirs and a stub "npm", so nothing here
// touches the developer's own install or the network.
//
//   node --test apps/scope-server/test/pi-bundle-install.test.mjs

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const INSTALLER = path.join(ROOT, "apps", "scope-desktop", "pi-bundle-install.mjs");
const EXTENSION = path.join(ROOT, "extension", "pi-scope.ts");
const PKG = "@earendil-works/pi-coding-agent";

let tmpDir;

/** Run the installer and capture its output. */
function install(args, env = {}) {
  const res = spawnSync(process.execPath, [INSTALLER, ...args], {
    cwd: ROOT, encoding: "utf8", env: { ...process.env, ...env },
  });
  return { status: res.status, out: res.stdout || "", err: res.stderr || "" };
}

/** A source tree shaped like the repo template: manifest + an installed agent. */
function makeSource(name, { withModules = true, withLock = true } = {}) {
  const root = path.join(tmpDir, name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"),
    JSON.stringify({ name: "pi-scope-pi-bundle", private: true, dependencies: { [PKG]: "1.2.3" } }, null, 2));
  if (withLock) fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ name: "pi-scope-pi-bundle", lockfileVersion: 3 }));
  if (withModules) {
    const pkg = path.join(root, "node_modules", ...PKG.split("/"));
    fs.mkdirSync(path.join(pkg, "dist", "bundle"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: PKG, version: "1.2.3" }));
    fs.writeFileSync(path.join(pkg, "dist", "bundle", "cli.js"), "// stub cli\n");
  }
  return root;
}

/** A stub package manager: records its cwd and creates a fake installed agent. */
function makeNpmStub(name, { fail = false } = {}) {
  const stub = path.join(tmpDir, name);
  fs.writeFileSync(stub, [
    "#!/bin/sh",
    fail ? "exit 3" : "",
    `printf '%s' "$PWD" > npm-cwd.txt`,
    `mkdir -p "node_modules/${PKG}/dist/bundle"`,
    `printf '{"name":"${PKG}","version":"9.9.9"}' > "node_modules/${PKG}/package.json"`,
    `: > "node_modules/${PKG}/dist/bundle/cli.js"`,
    "",
  ].join("\n"));
  fs.chmodSync(stub, 0o755);
  return stub;
}

const versionOf = (root) => {
  try { return JSON.parse(fs.readFileSync(path.join(root, "node_modules", ...PKG.split("/"), "package.json"), "utf8")).version; }
  catch { return null; }
};

before(() => { tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-pi-install-"))); });
after(() => { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe("pi bundle installer: seeding from an installed source", () => {
  test("--move migrates the modules and never leaves them behind", () => {
    const src = makeSource("move-src");
    const tgt = path.join(tmpDir, "move-tgt");
    const { status, out } = install(["--from", src, "--target", tgt, "--move"]);

    assert.equal(status, 0, out);
    assert.equal(versionOf(tgt), "1.2.3");
    assert.ok(fs.existsSync(path.join(tgt, "node_modules", ...PKG.split("/"), "dist", "bundle", "cli.js")), "the CLI is in place");
    assert.ok(!fs.existsSync(path.join(src, "node_modules")), "the source no longer holds the modules");
    // The npm project travels with the manifest, so a later `npm install` in the
    // target resolves the same versions.
    assert.ok(fs.existsSync(path.join(tgt, "package.json")));
    assert.ok(fs.existsSync(path.join(tgt, "package-lock.json")));
    // …and so does the extension the shim force-loads.
    assert.equal(fs.readFileSync(path.join(tgt, "pi-scope.ts"), "utf8"), fs.readFileSync(EXTENSION, "utf8"));
    assert.match(out, /installed in/, out);
  });

  test("without --move the source is copied (a package's read-only seed)", () => {
    const src = makeSource("copy-src");
    const tgt = path.join(tmpDir, "copy-tgt");
    const { status } = install(["--from", src, "--target", tgt]);

    assert.equal(status, 0);
    assert.equal(versionOf(tgt), "1.2.3");
    assert.ok(fs.existsSync(path.join(src, "node_modules")), "the read-only source is untouched");
  });

  test("a second run is a no-op", () => {
    const src = makeSource("again-src");
    const tgt = path.join(tmpDir, "again-tgt");
    assert.equal(install(["--from", src, "--target", tgt, "--move"]).status, 0);
    const marker = path.join(tgt, "package.json");
    const before = fs.statSync(marker).mtimeMs;

    const second = install(["--from", src, "--target", tgt, "--move"]);
    assert.equal(second.status, 0);
    assert.match(second.out, /already installed/, second.out);
    assert.equal(fs.statSync(marker).mtimeMs, before, "the install is not rewritten");
  });

  test("an incomplete target is replaced, not trusted", () => {
    const src = makeSource("stale-src");
    const tgt = path.join(tmpDir, "stale-tgt");
    // Exactly the state a killed copy leaves: a manifest and an empty modules dir.
    fs.mkdirSync(path.join(tgt, "node_modules"), { recursive: true });

    const { status } = install(["--from", src, "--target", tgt, "--move"]);
    assert.equal(status, 0);
    assert.equal(versionOf(tgt), "1.2.3");
  });
});

describe("pi bundle installer: a template without node_modules", () => {
  test("installs with the package manager in the target directory", () => {
    const src = makeSource("empty-src", { withModules: false });
    const tgt = path.join(tmpDir, "empty-tgt");
    const stub = makeNpmStub("npm-ok.sh");

    const { status, out } = install(["--from", src, "--target", tgt], { SCOPE_NPM_BIN: stub });
    assert.equal(status, 0, out);
    assert.equal(versionOf(tgt), "9.9.9");
    // The install ran *in the target* — that is where the manifest was staged.
    assert.equal(fs.readFileSync(path.join(tgt, "npm-cwd.txt"), "utf8"), fs.realpathSync(tgt));
  });

  test("a failing package manager is a non-zero exit, with a reason on stderr", () => {
    const src = makeSource("fail-src", { withModules: false });
    const tgt = path.join(tmpDir, "fail-tgt");
    const stub = makeNpmStub("npm-fail.sh", { fail: true });

    const { status, err } = install(["--from", src, "--target", tgt], { SCOPE_NPM_BIN: stub });
    assert.equal(status, 1, "the caller must be able to report the failure");
    assert.match(err, /install failed/, err);
    assert.equal(versionOf(tgt), null);
  });
});

describe("pi bundle installer: refusals", () => {
  test("a source that is not a bundle is refused", () => {
    const { status, err } = install(["--from", path.join(tmpDir, "does-not-exist"), "--target", path.join(tmpDir, "nope-tgt")]);
    assert.equal(status, 1);
    assert.match(err, /nothing to install from/, err);
  });

  test("an unknown package manager is refused before anything is written", () => {
    const src = makeSource("pm-src");
    const tgt = path.join(tmpDir, "pm-tgt");
    const { status, err } = install(["--from", src, "--target", tgt, "--pm", "yarn"]);
    assert.equal(status, 1);
    assert.match(err, /--pm must be npm, pnpm or bun/);
    assert.ok(!fs.existsSync(tgt), "nothing was created");
  });

  test("an unknown option is refused", () => {
    const { status, err } = install(["--wat"]);
    assert.equal(status, 1);
    assert.match(err, /unknown option/);
  });
});

describe("pi bundle installer: it never destroys what is already installed", () => {
  // chmod-based unreadability is meaningless to root, and Windows has no real
  // mode bits — the failure is only interacting with the filesystem's rules.
  const canMakeUnreadable = process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0;

  test("a staging failure leaves the previous install untouched", { skip: !canMakeUnreadable && "needs POSIX permissions" }, () => {
    const src = makeSource("break-src");
    fs.chmodSync(path.join(src, "node_modules"), 0o000);   // the copy cannot be read
    const tgt = path.join(tmpDir, "break-tgt");
    // An incomplete install: no agent package, so the installer will not take the
    // "already installed" shortcut and must actually stage a replacement.
    fs.mkdirSync(path.join(tgt, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(tgt, "package.json"), JSON.stringify({ name: "pi-scope-pi-bundle" }));

    try {
      const { status, err } = install(["--from", src, "--target", tgt]);
      assert.equal(status, 1, "the failure is reported");
      assert.match(err, /could not seed/, err);
      // The point: the old target is still there. Deleting it before the swap
      // would leave nothing at all — and the packaged seed has no network to
      // rebuild from.
      assert.ok(fs.existsSync(path.join(tgt, "package.json")), "the target survived");
    } finally {
      fs.chmodSync(path.join(src, "node_modules"), 0o755);
    }
  });

  test("stale staging dirs are swept, a concurrent run's is left alone", () => {
    const src = makeSource("sweep-src");
    const tgt = path.join(tmpDir, "sweep-tgt");
    const parent = path.dirname(tgt);
    const prefix = `.${path.basename(tgt)}.tmp-`;
    const stale = path.join(parent, `${prefix}999`);
    const fresh = path.join(parent, `${prefix}1000`);
    const staleAside = path.join(parent, `${prefix}old-999`);
    for (const dir of [stale, fresh, staleAside]) fs.mkdirSync(dir, { recursive: true });
    const longAgo = Date.now() / 1000 - 2 * 60 * 60;
    for (const dir of [stale, staleAside]) fs.utimesSync(dir, longAgo, longAgo);

    assert.equal(install(["--from", src, "--target", tgt]).status, 0);
    assert.ok(!fs.existsSync(stale), "an abandoned staging dir is reclaimed");
    assert.ok(!fs.existsSync(staleAside), "so is a swap's aside copy");
    assert.ok(fs.existsSync(fresh), "a run that just started is left alone");
  });
});
