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
import { resolveExecutable, spawnCli } from "../../shared/shell.ts";

/** How a command is invoked: `{ file, args }` to spawn, plus a label for messages. */
export interface CommandSpec {
  file: string;
  args: string[];
  label: string;
}

/** Keep only the tail of a command's output — it is for diagnostics, not display. */
const MAX_OUTPUT = 8_000;

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
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
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
      if (code === 0) resolve(out.trim());
      else reject(new Error(`${exitLabel} exited with code ${code}${out.trim() ? `\n${out.trim()}` : ""}`));
    });
  });
}
