// Unit tests for command output shown in Settings → Update.
//
//   node --test apps/scope-server/test/cli-run.test.mjs

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { runCommand, sanitizeCommandOutput } from "../cli-run.ts";

describe("sanitizeCommandOutput", () => {
  test("strips SGR colours instead of leaking the escape bytes", () => {
    assert.equal(
      sanitizeCommandOutput("\u001b[1m\u001b[32mInstalled\u001b[0m @scope/pi@1.2.3"),
      "Installed @scope/pi@1.2.3",
    );
  });

  test("strips cursor moves, erase-line and OSC sequences", () => {
    assert.equal(
      sanitizeCommandOutput("\u001b[2K\u001b[1Gfetched\u001b]0;npm\u0007 package"),
      "fetched package",
    );
  });

  test("keeps only the final redraw of a carriage-return progress line", () => {
    assert.equal(
      sanitizeCommandOutput("Downloading 10%\rDownloading 55%\rDownloading 100%\nDone"),
      "Downloading 100%\nDone",
    );
  });

  test("keeps the text when a line only ends in a carriage return", () => {
    assert.equal(sanitizeCommandOutput("already done\r\nnext"), "already done\nnext");
  });

  test("applies backspace erases from spinner redraws", () => {
    assert.equal(sanitizeCommandOutput("⠋\b⠙\b⠹ installing"), "⠹ installing");
  });

  test("drops other control characters but keeps tabs and newlines", () => {
    assert.equal(sanitizeCommandOutput("a\u0007b\tc\nd\u007f"), "ab\tc\nd");
  });

  test("tolerates empty and non-string input", () => {
    assert.equal(sanitizeCommandOutput(""), "");
    assert.equal(sanitizeCommandOutput(null), "");
    assert.equal(sanitizeCommandOutput(undefined), "");
  });
});

describe("runCommand", () => {
  test("resolves the sanitised output of a real command", async () => {
    const out = await runCommand(
      { file: process.execPath, args: [], label: "node" },
      ["-e", "process.stdout.write('\\u001b[32mok\\u001b[0m\\r\\n1%\\r100%')"],
      {
        cwd: process.cwd(),
        timeoutMs: 10_000,
        timeoutMessage: "timed out",
        exitLabel: "node",
      },
    );
    assert.equal(out, "ok\n100%");
  });

  test("a failure message carries the sanitised output, never escape bytes", async () => {
    await assert.rejects(
      runCommand(
        { file: process.execPath, args: [], label: "node" },
        ["-e", "process.stderr.write('\\u001b[31mboom\\u001b[0m'); process.exitCode = 3"],
        {
          cwd: process.cwd(),
          timeoutMs: 10_000,
          timeoutMessage: "timed out",
          exitLabel: "node",
        },
      ),
      (err) => {
        assert.match(err.message, /^node exited with code 3\nboom$/);
        assert.ok(!err.message.includes("\u001b"), "no escape bytes survive into the error");
        return true;
      },
    );
  });
});
