// Unit tests for the platform layer in shared/shell.ts — the rules that let one
// codebase launch programs on Windows, where `npm`, `pi` and every coding-agent
// CLI is a `.cmd` shim that CreateProcess cannot run (Node refuses to spawn one
// without a shell, and Node's own `shell: true` joins argv without escaping it).
//
// Every helper takes the platform as an argument, so the win32 branches are
// exercised here on Linux/macOS — which is the point of the design, not a
// courtesy. The functional test at the bottom proves the POSIX plan really does
// spawn (the win32 plan cannot be executed off Windows; its *shape* is asserted
// instead, and the escaping is pinned string-for-string).
//
//   node --test apps/scope-server/test/windows-compat.test.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  isWindows, windowsCommandLine, planSpawn, spawnCli, shellCommandPlan,
  interactiveShellCandidates, supportsPosixCommandSyntax, killTree, resolveExecutable,
} from "../../../shared/shell.ts";

describe("platform: detection and shell choice", () => {
  test("isWindows is about the platform it is asked about", () => {
    assert.equal(isWindows("win32"), true);
    assert.equal(isWindows("linux"), false);
    assert.equal(isWindows("darwin"), false);
  });

  test("a shell one-liner is `sh -c` on POSIX and `cmd /d /s /c` on Windows", () => {
    const posix = shellCommandPlan("echo $SW_PROMPT", "linux");
    assert.equal(posix.args[0], "-c");
    assert.equal(posix.args[1], "echo $SW_PROMPT");
    assert.match(posix.file, /sh$/, "the user's shell, or /bin/sh");

    const win = shellCommandPlan("echo %SW_PROMPT%", "win32");
    assert.deepEqual(win.args, ["/d", "/s", "/c", "echo %SW_PROMPT%"]);
    assert.match(win.file, /cmd(\.exe)?$/i, "the command processor");
  });

  test("the Terminal's shell candidates are the platform's own", () => {
    assert.deepEqual(interactiveShellCandidates("linux"), ["bash", "zsh", "sh"]);
    // Git Bash first: it is a real POSIX shell, so the cwd sync and the `cd`
    // injection behave exactly as they do on Linux.
    assert.deepEqual(interactiveShellCandidates("win32"), ["bash", "pwsh", "powershell", "cmd"]);
  });

  test("only a POSIX shell understands the `cd -- <path>` injection", () => {
    assert.equal(supportsPosixCommandSyntax("/bin/bash"), true);
    assert.equal(supportsPosixCommandSyntax("/usr/bin/zsh"), true);
    assert.equal(supportsPosixCommandSyntax("C:\\Program Files\\Git\\bin\\bash.exe"), true);
    assert.equal(supportsPosixCommandSyntax("C:\\Program Files\\PowerShell\\7\\pwsh.exe"), false);
    assert.equal(supportsPosixCommandSyntax("C:\\Windows\\System32\\cmd.exe"), false);
    assert.equal(supportsPosixCommandSyntax(""), false);
  });
});

describe("platform: cmd.exe argument escaping", () => {
  test("a command's metacharacters are caret-escaped", () => {
    // The path is a *command*: its space is escaped, and so is everything else
    // cmd reads as syntax (a `&` here would otherwise run a second command).
    assert.equal(windowsCommandLine("C:\\tools\\my app\\npm.cmd", []),
      "C:\\tools\\my^ app\\npm.cmd");
    assert.equal(windowsCommandLine("C:\\a&b\\claude.cmd", []), "C:\\a^&b\\claude.cmd");
  });

  test("an argument is quoted, and what quoting cannot cover is escaped", () => {
    // Quoted, and its own metacharacters (here the space) caret-escaped inside.
    assert.equal(windowsCommandLine("x", ["a b"]), "x ^\"a^ b^\"");
    // `&`, `%` and `|` are exactly the ones that would otherwise run a command
    // or expand a variable.
    assert.equal(windowsCommandLine("x", ["a&b"]), "x ^\"a^&b^\"");
    assert.equal(windowsCommandLine("x", ["100%"]), "x ^\"100^%^\"");
    assert.equal(windowsCommandLine("x", ["a|b"]), "x ^\"a^|b^\"");
  });

  test("a quote inside an argument is escaped, not left to end the argument", () => {
    // `say "hi"`: each inner quote is backslash-escaped (so it cannot end the
    // argument) and then caret-escaped (so cmd keeps it literal).
    assert.equal(windowsCommandLine("x", ['say "hi"']), 'x ^"say^ \\^"hi\\^"^"');
  });

  test("a run of backslashes before a quote is doubled, and so is a trailing run", () => {
    // A trailing backslash is doubled, so the closing quote we add is not the
    // thing it escapes: `a\` → `^"a\\\\^"`.
    assert.equal(windowsCommandLine("x", ["a\\"]), "x ^\"a\\\\^\"");
    // `a\"b` (a backslash, then a quote): the backslash run in front of the
    // quote is doubled AND the quote is escaped, which is what keeps the quote
    // from ending the argument early.
    assert.equal(windowsCommandLine("x", ['a\\"b']), 'x ^"a\\\\\\^"b^"');
  });

  test("a shim under node_modules/.bin is escaped twice", () => {
    const single = windowsCommandLine("C:\\p\\node_modules\\.bin\\claude.cmd", ["--model", "sonnet"]);
    const double = windowsCommandLine("C:\\p\\node_modules\\.bin\\claude.cmd", ["--model", "sonnet"], true);
    assert.notEqual(single, double, "the nested shim needs the second pass");
    assert.ok(double.includes("^^"), "metacharacters are escaped twice for it");
  });
});

describe("platform: how a program is launched", () => {
  test("POSIX spawns the binary directly", () => {
    assert.deepEqual(planSpawn("/usr/bin/node", ["-p", "1+1"], "linux"),
      { file: "/usr/bin/node", args: ["-p", "1+1"], shell: false });
    assert.deepEqual(planSpawn("/usr/local/bin/claude", [], "darwin"),
      { file: "/usr/local/bin/claude", args: [], shell: false });
  });

  test("Windows spawns an .exe directly, but hands a .cmd to cmd.exe", () => {
    assert.deepEqual(planSpawn("C:\\node\\node.exe", ["x"], "win32"),
      { file: "C:\\node\\node.exe", args: ["x"], shell: false });

    const shim = planSpawn("C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd", ["-p", "hi"], "win32");
    assert.match(shim.file, /cmd(\.exe)?$/i);
    assert.equal(shim.args[0], "/d");
    assert.equal(shim.args[1], "/s");
    assert.equal(shim.args[2], "/c");
    assert.equal(shim.windowsVerbatimArguments, true,
      "the command line is finished: Node must not quote it again");
    assert.equal(shim.shell, false, "cmd.exe is spawned directly — the escaping is ours, not Node's");
    assert.match(shim.args[3], /^"C:\\Users\\dev\\AppData\\Roaming\\npm\\claude\.cmd \^"-p\^" \^"hi\^""$/);
  });

  test("Windows wraps a bare program name too (only cmd.exe can find the .cmd)", () => {
    const bare = planSpawn("codex", ["exec", "go"], "win32");
    assert.match(bare.file, /cmd(\.exe)?$/i);
    assert.match(bare.args[3], /^"codex \^"exec\^" \^"go\^""$/);
  });

  test("a prompt with quotes and shell syntax survives as one escaped argument", () => {
    const prompt = 'Fix the "quoted" bits & say 100% done | tee out.txt';
    const plan = planSpawn("claude.cmd", ["-p", prompt], "win32");
    const line = plan.args[3];
    // Every cmd metacharacter in the prompt is caret-escaped, so cmd cannot act
    // on it: no `&`, `|` or `%…%` survives as syntax.
    for (const ch of ["&", "|", "%", '"']) {
      assert.ok(line.includes("^" + ch), `${ch} is escaped`);
    }
    assert.ok(line.startsWith('"claude.cmd'), "the command line is one quoted string");
    assert.ok(line.endsWith('"'));
  });

  test("spawnCli really spawns on this platform (the POSIX plan in action)", async () => {
    const child = spawnCli(process.execPath, ["-p", "'plan ' + (1 + 1)"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 0);
    assert.equal(out.trim(), "plan 2");
  });

  test("a missing program fails as an error/exit, not by throwing at the call site", () => {
    const child = spawnCli("definitely-not-a-real-binary-xyz", [], { stdio: ["ignore", "ignore", "ignore"] });
    // Node reports this asynchronously; the point is that planning a spawn never
    // throws for a program that is not there (the run engine turns it into a
    // node failure).
    child.on("error", () => {});
  });
});

describe("platform: stopping processes", () => {
  test("POSIX sends the signal to the process itself", () => {
    const calls = [];
    killTree({ pid: 42, kill: (s) => { calls.push(s); return true; } }, "SIGTERM", "linux");
    assert.deepEqual(calls, ["SIGTERM"]);
  });

  test("Windows takes the whole tree down (the child is a cmd.exe wrapper)", () => {
    // taskkill is not on this machine, so the backstop is what runs — but the
    // signal still goes to the child, and nothing throws either way.
    const calls = [];
    killTree({ pid: 4242, kill: (s) => { calls.push(s); return true; } }, "SIGKILL", "win32");
    assert.deepEqual(calls, ["SIGKILL"]);
    killTree(null, "SIGTERM", "win32");   // must not throw
    killTree(undefined, "SIGTERM", "linux");
  });
});

describe("platform: executable resolution stays a POSIX/no-op helper where it must", () => {
  test("resolveExecutable is unchanged for this platform", () => {
    assert.equal(resolveExecutable(""), null);
    assert.equal(resolveExecutable("/definitely/not/here"), null);
    assert.equal(resolveExecutable(process.execPath), process.execPath);
  });
});
