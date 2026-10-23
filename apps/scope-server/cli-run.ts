/**
 * cli-run.ts — run a short-lived CLI to completion, and find npm.
 *
 * Pi Scope shells out to package managers for Settings → Update: `npm install
 * …@latest` into the bundled pi project, and the global update of a coding
 * harness (or the harness's own `update`/`upgrade` subcommand). These two
 * concerns used to live inside pi-update.ts; they are shared here now that the
 * Update tab also updates external harnesses.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { killTree, resolveExecutable, spawnCli } from "../../shared/shell.ts";
import { trackProcess } from "./process-registry.ts";

/** How a command is invoked: `{ file, args }` to spawn, plus a label for messages. */
export interface CommandSpec {
  file: string;
  args: string[];
  label: string;
}

/** Keep only the tail of a command's output — it is for diagnostics, not display. */
const MAX_OUTPUT = 8_000;

// ANSI escapes a CLI paints its progress with: CSI (colours, cursor moves,
// erase-line), OSC (window titles, hyperlinks) and the two-byte forms.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
// Control characters that have no meaning in the Settings log. Tab and newline
// survive; carriage returns are handled below.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Command output the way a terminal would have left it, as plain text.
 *
 * Settings → Update prints the updater's output in a <pre>. Updaters (and npm)
 * paint that output with ANSI escapes and redraw progress lines with a bare
 * carriage return or backspace. Escaped into HTML those sequences show up as
 * literal `[32m` / `←[2K` garbage, and every progress redraw adds a line, so
 * the log reads as noise instead of the text the updater meant to show. This
 * strips the escapes and collapses each line to what was last left visible —
 * the log is diagnostics, not a terminal emulator.
 */
export function sanitizeCommandOutput(raw: string): string {
  const text = String(raw ?? "").replace(ANSI_ESCAPE_RE, "").replace(/\r\n/g, "\n");
  return text
    .split("\n")
    .map((line) => {
      // `\r` returns to column 0; only the final redraw was visible. A line
      // that merely ends in `\r` keeps its text (the cursor just moved back).
      const redraw = line.split("\r");
      let visible = redraw[redraw.length - 1];
      if (!visible) {
        for (let i = redraw.length - 2; i >= 0 && !visible; i--) visible = redraw[i];
      }
      // Spinners erase with backspace rather than overwriting: apply the
      // backspaces so `⠋\b⠙\b⠹` reads as `⠹` instead of all three glyphs.
      if (visible.includes("\b")) {
        let out = "";
        for (const ch of visible) {
          if (ch === "\b") out = out.slice(0, -1);
          else out += ch;
        }
        visible = out;
      }
      return visible;
    })
    .join("\n")
    .replace(CONTROL_RE, "");
}

/**
 * npm's own CLI as shipped with the Node running this server, or null.
 *
 * Running it through `node` is the one form that works on every platform: no
 * PATH lookup and no `.cmd` for CreateProcess to refuse. A packaged app has no
 * npm on PATH, but its portable Node bundles one — this is how Settings → Update
 * stays usable there (the seeded agent in `~/.pi-scope/pi` is writable, unlike
 * the copy inside the package). Positions checked: a POSIX install
 * (`<prefix>/bin/node` → `<prefix>/lib/node_modules/npm`) and a Windows one
 * (`<dir>\node.exe` → `<dir>\node_modules\npm`).
 */
function npmCliBesideNode(): string | null {
  const dir = path.dirname(process.execPath);
  const candidates = [
    path.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(dir, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(dir, "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const candidate of candidates) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* try next */ }
  }
  return null;
}

/** How npm is invoked: `{ file, args }` to spawn, plus a label for messages.
 *  `SCOPE_NPM_BIN` (an operator's npm, or the e2e suite's stub) always wins. */
export function npmCommand(): CommandSpec {
  const configured = (process.env.SCOPE_NPM_BIN || "").trim();
  if (configured) return { file: configured, args: [], label: configured };
  const cli = npmCliBesideNode();
  if (cli) return { file: process.execPath, args: [cli], label: "npm (bundled with Node)" };
  return { file: "npm", args: [], label: "npm" };
}

/**
 * npm for a *global harness* update.
 *
 * This is deliberately not the npm beside `process.execPath`: in a packaged app
 * that is the portable Node inside the (often read-only) app bundle, whose
 * global prefix is not the one the user's CLIs were installed into. A harness
 * update must use the npm on PATH — the same Node installation that owns
 * `~/.nvm/…/bin/gemini`, for example. Fall back to the bundled npm only when
 * PATH has none (and let the updater explain the failure).
 */
export function systemNpmCommand(): CommandSpec {
  const configured = (process.env.SCOPE_NPM_BIN || "").trim();
  if (configured) return { file: configured, args: [], label: configured };
  const onPath = resolveExecutable("npm");
  if (onPath) return { file: onPath, args: [], label: "npm" };
  return npmCommand();
}

export interface RunOptions {
  cwd: string;
  /** Kill the child after this long. */
  timeoutMs: number;
  /** Message used when the timeout fires. */
  timeoutMessage: string;
  /** Prefix for a non-zero exit, e.g. "npm install" → "npm install exited with code 1". */
  exitLabel: string;
  /** Appended to a "not found" error, e.g. "install npm or set SCOPE_NPM_BIN". */
  missingHint?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Run a command to completion, resolving with its combined output.
 *
 * `spawnCli`, not `spawn`: on Windows `npm` is `npm.cmd`, which Node refuses to
 * spawn directly (and `SCOPE_NPM_BIN` usually points straight at one).
 */
export function runCommand(command: CommandSpec, args: string[], opts: RunOptions): Promise<string> {
  const { cwd, timeoutMs, timeoutMessage, exitLabel, missingHint, env } = opts;
  return new Promise((resolve, reject) => {
    let out = "";
    let settled = false;
    const proc = spawnCli(command.file, [...command.args, ...args], {
      cwd,
      env: env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    // Tracked so closing the app stops an updater it started (npm, a harness's
    // own `update` command) instead of leaving it writing to disk unwatched.
    trackProcess(proc, {
      kind: "command",
      label: command.label,
      group: process.platform !== "win32",
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTree(proc, "SIGKILL");
      reject(new Error(timeoutMessage));
    }, timeoutMs);
    const collect = (chunk: Buffer) => { out = (out + chunk.toString()).slice(-MAX_OUTPUT); };
    proc.stdout?.on("data", collect);
    proc.stderr?.on("data", collect);
    proc.on("error", (err: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err?.code === "ENOENT"
        ? new Error(`${command.label} not found${missingHint ? ` — ${missingHint}` : ""}`)
        : err);
    });
    proc.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const clean = sanitizeCommandOutput(out).trim();
      if (code === 0) resolve(clean);
      else reject(new Error(`${exitLabel} exited with code ${code}${clean ? `\n${clean}` : ""}`));
    });
  });
}
