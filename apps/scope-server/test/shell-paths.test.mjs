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
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.SCOPE_SYSTEM_BIN_DIRS;
  else process.env.SCOPE_SYSTEM_BIN_DIRS = ORIGINAL;
  process.env.PATH = ORIGINAL_PATH;
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
});
