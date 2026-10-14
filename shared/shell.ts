/**
 * shell.ts — shared shell/env helpers for the scope server's user-shell
 * integration.
 *
 * The server is frequently launched from a GUI/desktop session that never
 * sources the user's shell rc files, so anything exported only there is
 * invisible to it. Both chat.ts (PLAYWRIGHT_BROWSERS_PATH for pi's web tools)
 * and stt.ts (GROQ_API_KEY for dictation) have to read those files the same
 * way, and both chat.ts and terminal.ts have to quote values for `sh -c`.
 * Those were three near-identical local copies; they live here now.
 *
 * The bottom of the file is the **platform layer**: how to launch a program on
 * Windows, where `npm`, `pi` and every coding-agent CLI is a `.cmd` shim that
 * CreateProcess cannot run directly, and where a shell one-liner is `cmd /c`
 * rather than `sh -c`. Every helper there takes the platform as an optional
 * argument so the win32 paths are unit-tested from Linux (see
 * apps/scope-server/test/windows-compat.test.mjs).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";

/** Shell rc files an interactive terminal sources, in the order we check them. */
export function shellRcFiles(): string[] {
  const home = os.homedir();
  return [".zshenv", ".zshrc", ".zprofile", ".zlogin", ".bash_profile", ".bashrc", ".profile"]
    .map((f) => path.join(home, f))
    .filter((p) => fs.existsSync(p));
}

/** Expand a leading `~` and `$HOME`/`${HOME}` the way a shell would. */
export function expandShellPath(value: string): string {
  const home = os.homedir();
  return value.replace(/^~(?=\/|$)/, home).replace(/\$\{HOME\}|\$HOME/g, home);
}

/**
 * Every `NAME=value` (optionally `export NAME=value`) assignment for `name`
 * found in the user's shell rc files, in file order and unexpanded. Comment and
 * blank lines are skipped; matching surrounding quotes are stripped. Callers
 * that need a specific value (e.g. a dir that must exist) can scan the list
 * instead of guessing which file wins.
 */
export function readShellEnvValues(name: string): string[] {
  const out: string[] = [];
  for (const rc of shellRcFiles()) {
    let content: string;
    try { content = fs.readFileSync(rc, "utf8"); } catch { continue; }
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const assignment = line.startsWith("export ") ? line.slice(7).trim() : line;
      const eq = assignment.indexOf("=");
      if (eq <= 0 || assignment.slice(0, eq).trim() !== name) continue;
      const val = assignment.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, "$2").trim();
      if (val) out.push(val);
    }
  }
  return out;
}

/** First assignment for `name` in the shell rc files, or "" — the rc-file
 *  equivalent of reading a single environment variable. */
export function readShellEnvValue(name: string): string {
  const [first] = readShellEnvValues(name);
  return first ? expandShellPath(first) : "";
}

/**
 * Every `NAME=value` assignment reachable from the shell rc files, as one map
 * (first occurrence wins; `$HOME`/`~` expanded). Follows `source`/`.` includes
 * whose path is a file under the user's home, so a key defined in a sourced env
 * file (e.g. `~/.free-coding-models.env`) is seen the way a shell would — one
 * pass, bounded depth and file count.
 */
const MAX_SOURCE_DEPTH = 3;
const MAX_SOURCE_FILES = 25;
/** `source <path>` / `. <path>` after a line start or a shell separator. */
const SOURCE_RE = /(?:^|[;&|]\s*)(?:source|\.)\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g;

export function readShellEnvMap(): Record<string, string> {
  const out: Record<string, string> = {};
  const home = os.homedir();
  const seen = new Set<string>();
  const visit = (file: string, depth: number): void => {
    let real: string;
    try { real = fs.realpathSync(file); } catch { return; }
    if (seen.has(real) || seen.size >= MAX_SOURCE_FILES) return;
    seen.add(real);
    let content: string;
    try { content = fs.readFileSync(real, "utf8"); } catch { return; }
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const assignment = line.startsWith("export ") ? line.slice(7).trim() : line;
      const eq = assignment.indexOf("=");
      if (eq > 0) {
        const name = assignment.slice(0, eq).trim();
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !(name in out)) {
          const val = assignment.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, "$2").trim();
          if (val) out[name] = expandShellPath(val);
        }
      }
      if (depth >= MAX_SOURCE_DEPTH) continue;
      for (const match of line.matchAll(SOURCE_RE)) {
        const raw = match[1].replace(/^(['"])(.*)\1$/, "$2").trim();
        // Only literal paths and $HOME: a variable we can't expand is skipped.
        if (!raw || raw.replace(/\$\{HOME\}|\$HOME/g, "").includes("$")) continue;
        const resolved = path.resolve(expandShellPath(raw));
        // Never follow system paths or anything outside the user's home.
        if (!resolved.startsWith(home + path.sep)) continue;
        try { if (fs.statSync(resolved).isFile()) visit(resolved, depth + 1); } catch { /* absent */ }
      }
    }
  };
  for (const rc of shellRcFiles()) visit(rc, 0);
  return out;
}

/** POSIX single-quote escaping for a shell argument (bash/zsh): safe for
 *  spaces, quotes, and metacharacters in paths. */
export function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * System binary directories to search *in addition to* $PATH.
 *
 * The server is routinely launched from a GUI/desktop session whose PATH lacks
 * the dirs a login shell would add, so looked-up executables (`bash`, `rec`,
 * `claude`, …) resolve only if these are searched too. Override with
 * SCOPE_SYSTEM_BIN_DIRS (a path-delimiter-separated list) — e.g. to point at a
 * Homebrew or Nix prefix. Empty on Windows, where PATHEXT handles the rest.
 */
export function systemBinDirs(): string[] {
  const override = process.env.SCOPE_SYSTEM_BIN_DIRS;
  if (override) return override.split(path.delimiter).map((d) => d.trim()).filter(Boolean);
  if (process.platform === "win32") return [];
  return [
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/opt/homebrew/bin",
    path.join(os.homedir(), ".local", "bin"),
  ];
}

/** $PATH entries first, then the platform system dirs (de-duplicated). */
export function executableSearchDirs(): string[] {
  const dirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of systemBinDirs()) if (!dirs.includes(dir)) dirs.push(dir);
  return dirs;
}

/**
 * Resolve an executable name to an absolute path, or null.
 *
 * An absolute/relative path is validated and returned as-is; a bare name is
 * searched across `executableSearchDirs()` with the platform's extension
 * suffixes. One implementation replaces the four near-identical `which`
 * deep-probes that chat.ts, terminal.ts, stt.ts and the subagent-workflow
 * plugin each carried (and honour SCOPE_SYSTEM_BIN_DIRS uniformly).
 */
export function resolveExecutable(name: string): string | null {
  const bin = String(name || "").trim();
  if (!bin) return null;
  if (bin.includes("/") || bin.includes("\\")) {
    try { fs.accessSync(bin, fs.constants.X_OK); return bin; } catch { return null; }
  }
  const exts = process.platform === "win32"
    ? String(process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  for (const dir of executableSearchDirs()) {
    for (const ext of exts) {
      const full = path.join(dir, bin + ext);
      try {
        if (fs.statSync(full).isFile()) { fs.accessSync(full, fs.constants.X_OK); return full; }
      } catch { /* keep looking */ }
    }
  }
  return null;
}

/** Whether `name` resolves to an executable (see resolveExecutable). */
export function hasExecutable(name: string): boolean {
  return resolveExecutable(name) !== null;
}

// ─── Platform layer (Windows-first) ─────────────────────────────────────────
//
// On Windows a `npm`, `pi`, `claude` or `codex` on PATH is almost never an
// image CreateProcess can run: it is a `.cmd`/`.bat` shim that must be handed
// to the command processor. Node has refused to spawn one without a shell since
// CVE-2024-27980 (`EINVAL`), and Node's own `shell: true` joins argv into a
// command line *without* escaping it — which is wrong the moment an argument is
// a user's prompt. So the escaping lives here, once, with tests.

/** True on Windows, or on the `platform` a caller passes in (for tests). */
export function isWindows(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

/** This platform's command processor — `cmd.exe` on Windows. */
export function windowsShell(): string {
  return (process.env.ComSpec || process.env.COMSPEC || "cmd.exe").trim() || "cmd.exe";
}

/**
 * The characters cmd.exe reads as syntax. Each is escaped with a caret, which
 * is how a value survives cmd's own parsing as a literal. (The escaping rules
 * are cmd's, from https://qntm.org/cmd — the same ones cross-spawn uses, so a
 * shim behaves the same whichever way it is launched.)
 */
const CMD_META_RE = /([()\][%!^"`<>&|;, *?])/g;

/** One *command* (a program path): escape its metacharacters, add no quotes. */
function escapeCmdCommand(arg: string): string {
  return String(arg).replace(CMD_META_RE, "^$1");
}

/**
 * One *argument*: quote it for cmd, then escape what quoting cannot cover.
 *
 * A run of backslashes before a double quote is doubled (so the quote is not
 * swallowed as an escape), the same at the end of the string (so the closing
 * quote we add is not itself escaped), then the whole thing is wrapped in
 * quotes and every cmd metacharacter — including the `%` that would otherwise
 * expand a variable — is caret-escaped. `double` escapes them a second time,
 * which a shim inside `node_modules/.bin` needs: cmd strips one level when it
 * parses the command line, and the shim's inner cmd parses it again.
 */
function escapeCmdArgument(arg: string, double = false): string {
  let s = String(arg);
  s = s.replace(/(?=(\\+?)?)\1"/g, "$1$1\\\"");
  s = s.replace(/(?=(\\+?)?)\1$/, "$1$1");
  s = `"${s}"`;
  s = s.replace(CMD_META_RE, "^$1");
  if (double) s = s.replace(CMD_META_RE, "^$1");
  return s;
}

/** A full cmd.exe command line for `file arg arg…`, each part escaped. */
export function windowsCommandLine(file: string, args: string[], doubleEscapeMetaChars = false): string {
  return [escapeCmdCommand(file), ...args.map((a) => escapeCmdArgument(String(a), doubleEscapeMetaChars))].join(" ");
}

/** How to launch something: the resolved file, its args, and spawn options. */
export interface SpawnPlan {
  file: string;
  args: string[];
  shell: boolean;
  /** Set when `args` is already a finished command line (Windows + cmd.exe). */
  windowsVerbatimArguments?: boolean;
}

/**
 * How to really launch `file args…` on `platform`.
 *
 * POSIX (and any Windows target that is a genuine image — `.exe`/`.com`): spawn
 * the file directly, exactly as before. A Windows `.cmd`/`.bat` shim, or a bare
 * name that resolves to one, is run through cmd.exe with every argument escaped
 * (see `windowsCommandLine`); `windowsVerbatimArguments` then tells Node to pass
 * that line through untouched instead of quoting it a second time.
 *
 * `file` should be an absolute path where one is known (`resolveExecutable`
 * returns one), so no shell is needed to find it.
 */
export function planSpawn(file: string, args: string[] = [], platform: NodeJS.Platform = process.platform): SpawnPlan {
  const target = String(file || "");
  const argv = args.map((a) => String(a));
  if (!isWindows(platform)) return { file: target, args: argv, shell: false };
  // A real executable needs no shell. `.exe`/`.com` is what CreateProcess runs;
  // anything else (`.cmd`, `.bat`, or a bare `npm`) is script text.
  if (/\.(exe|com)$/i.test(target)) return { file: target, args: argv, shell: false };
  const double = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(target);
  return {
    file: windowsShell(),
    args: ["/d", "/s", "/c", `"${windowsCommandLine(target, argv, double)}"`],
    shell: false,
    windowsVerbatimArguments: true,
  };
}

/**
 * Spawn `file args…`, handling the Windows shim case (see `planSpawn`). Every
 * server spawn of a PATH program — pi, npm, a Workflow node's harness — goes
 * through this so the .cmd rules live in one place.
 */
export function spawnCli(
  file: string,
  args: string[] = [],
  options: SpawnOptions = {},
  platform: NodeJS.Platform = process.platform,
): ChildProcess {
  const plan = planSpawn(file, args, platform);
  return spawn(plan.file, plan.args, {
    ...options,
    shell: plan.shell,
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
  });
}

/**
 * How to run a shell one-liner — the portable `sh -c "…"`.
 *
 * POSIX: `$SHELL` (or `/bin/sh`) with `-c`, so the command runs in the user's
 * own shell. Windows: the command processor with `/d /s /c`; a custom command
 * written for POSIX needs `%SW_PROMPT%`-style variables there, which is why the
 * Workflow's Custom-command hint says so.
 */
export function shellCommandPlan(command: string, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  if (isWindows(platform)) return { file: windowsShell(), args: ["/d", "/s", "/c", String(command)] };
  return { file: (process.env.SHELL || "/bin/sh").trim() || "/bin/sh", args: ["-c", String(command)] };
}

/**
 * Shells the in-browser Terminal may open, best first. Git for Windows ships a
 * real bash, and the Terminal's cwd sync and `cd` injection speak POSIX, so it
 * is preferred when it is installed; PowerShell and `cmd` are the fallbacks
 * every Windows machine has.
 */
export function interactiveShellCandidates(platform: NodeJS.Platform = process.platform): string[] {
  if (isWindows(platform)) return ["bash", "pwsh", "powershell", "cmd"];
  return ["bash", "zsh", "sh"];
}

/**
 * Whether a resolved shell understands the POSIX syntax the Terminal uses to
 * follow the workspace rail (`cd -- <path>`). False for PowerShell and `cmd`,
 * where that injection is skipped instead of typing nonsense into the shell.
 */
export function supportsPosixCommandSyntax(shellPath: string): boolean {
  // Split on both separators: the answer must not depend on which platform is
  // asking (a Windows shell path is checked from Windows, but tests run here).
  const base = String(shellPath || "").split(/[\\/]/).pop()!.toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
  return ["bash", "zsh", "sh", "dash", "ksh", "ash"].includes(base);
}

/**
 * Stop a process **and everything it started**.
 *
 * POSIX: a signal to the process group leader we spawned. Windows has no
 * signals and `child.kill()` only ends the direct child — a harness started
 * through cmd.exe would leave its real work running — so the tree is taken down
 * with `taskkill /T /F`, and `kill()` is still called as a backstop.
 */
export function killTree(
  child: { pid?: number; kill: (signal?: NodeJS.Signals | number) => boolean } | null | undefined,
  signal: NodeJS.Signals = "SIGTERM",
  platform: NodeJS.Platform = process.platform,
): void {
  if (!child) return;
  if (isWindows(platform)) {
    const pid = Number(child.pid);
    if (Number.isFinite(pid) && pid > 0) {
      try { spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* already gone */ }
    }
  }
  try { child.kill(signal); } catch { /* already gone */ }
}
