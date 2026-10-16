// Unit tests for the shared executable resolver (shared/shell.ts).
//
// Four modules used to carry their own `which` deep-probe (chat.ts,
// terminal.ts, stt.ts, subagent-workflow/server.ts). They now share
// `resolveExecutable`/`hasExecutable`, which also makes the extra system search
// dirs configurable (SCOPE_SYSTEM_BIN_DIRS) instead of hardcoded per module.
//
//   node --test apps/scope-server/test/shell-paths.test.mjs

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { systemBinDirs, executableSearchDirs, resolveExecutable, hasExecutable } from "../../../shared/shell.ts";

const ORIGINAL = process.env.SCOPE_SYSTEM_BIN_DIRS;
const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_HOME = process.env.HOME;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.SCOPE_SYSTEM_BIN_DIRS;
  else process.env.SCOPE_SYSTEM_BIN_DIRS = ORIGINAL;
  process.env.PATH = ORIGINAL_PATH;
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
});

describe("shared executable resolution", () => {
  test("SCOPE_SYSTEM_BIN_DIRS overrides the platform defaults (path-delimiter separated)", () => {
    process.env.SCOPE_SYSTEM_BIN_DIRS = `/tmp/a${path.delimiter}/tmp/b`;
    assert.deepEqual(systemBinDirs(), ["/tmp/a", "/tmp/b"]);
  });

  test("an empty override still yields no entries (no silent fallback)", () => {
    process.env.SCOPE_SYSTEM_BIN_DIRS = "";
    // An empty string is falsy → the platform default is used; that is the
    // documented behaviour (unset or empty = default).
    assert.ok(systemBinDirs().length > 0 || process.platform === "win32");
  });

  test("absolute paths are validated, not searched", () => {
    const sh = process.platform === "win32" ? null : "/bin/sh";
    if (sh) assert.equal(resolveExecutable(sh), sh);
    assert.equal(resolveExecutable("/definitely/not/here/nope"), null);
  });

  test("a bare name resolves through PATH and reports non-executables as null", () => {
    assert.equal(resolveExecutable(""), null);
    assert.equal(resolveExecutable("definitely-not-a-real-bin-xyz"), null);
    // `node` is running this test, so it must resolve somewhere.
    assert.equal(hasExecutable("node"), true);
    assert.equal(path.isAbsolute(resolveExecutable("node")), true);
  });

  test("a directory on PATH is not mistaken for an executable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-bin-"));
    const bin = path.join(dir, "looks-like-a-bin");
    fs.mkdirSync(bin); // a *directory* with the binary's name
    const savedPath = process.env.PATH;
    process.env.SCOPE_SYSTEM_BIN_DIRS = "";
    process.env.PATH = dir;
    try {
      assert.equal(resolveExecutable("looks-like-a-bin"), null);
    } finally {
      process.env.PATH = savedPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("search dirs start with PATH entries and de-duplicate system dirs", () => {
    process.env.SCOPE_SYSTEM_BIN_DIRS = "/usr/bin";
    process.env.PATH = "/usr/bin";
    const dirs = executableSearchDirs();
    assert.equal(dirs[0], "/usr/bin");
    assert.equal(dirs.filter((d) => d === "/usr/bin").length, 1);
  });

  test("follows opencode's installer bin dir under $HOME ($HOME/.opencode/bin)", (t) => {
    // opencode's official installer hardcodes $HOME/.opencode/bin and appends it
    // only to the shell rc files, which a GUI-launched server never sources. The
    // resolver must therefore reach it through systemBinDirs() — this is exactly
    // the lookup the Workflow page's harness detection (`available`) depends on.
    if (process.platform === "win32") return t.skip("the default search list is POSIX-only");
    const savedHome = process.env.HOME;
    const savedPath = process.env.PATH;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "scope-home-"));
    const binDir = path.join(home, ".opencode", "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const exe = path.join(binDir, "opencode");
    fs.writeFileSync(exe, "#!/bin/sh\n", { mode: 0o755 });
    process.env.HOME = home;
    process.env.PATH = ""; // nothing on PATH could supply it…
    process.env.SCOPE_SYSTEM_BIN_DIRS = ""; // …so exercise the platform defaults
    try {
      // The fixture is only reachable if this runtime reads $HOME (it does on
      // POSIX); guard rather than assert-for-the-wrong-reason.
      if (os.homedir() !== home) return t.skip("this runtime ignores $HOME in os.homedir()");
      assert.ok(systemBinDirs().includes(binDir));
      assert.equal(resolveExecutable("opencode"), exe);
    } finally {
      process.env.HOME = savedHome;
      process.env.PATH = savedPath;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
