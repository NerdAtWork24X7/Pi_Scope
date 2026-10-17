/**
 * pi-bundle.ts — the Pi coding agent bundled with Pi Scope.
 *
 * Pi Scope installs its own copy of the [`pi`]
 * coding agent (the `@earendil-works/pi-coding-agent` npm package) into its
 * per-user data directory — `~/.pi-scope/pi` — and this module locates that copy
 * and, when it is present, exposes a `pi` shim on PATH that runs the bundled
 * agent with the Pi Scope extension force-loaded.
 *
 * The effect: every `pi` process Pi Scope launches — Chat subprocesses, the
 * git-commit-message generator, the in-browser Terminal's shell, and the nested
 * subagents the agent-team extension spawns by bare name — resolves to the
 * bundled agent and reports telemetry, with no global `pi` install required.
 * The shim also pins `PI_CODING_AGENT_DIR` to Pi Scope's own agent dir
 * (agent-dir.ts), so the bundled agent never reads or writes the user's global
 * pi agent dir and can't collide with a globally-installed pi extension, and
 * `PI_BROWSER_MODULE_ROOT` to the agent dir's own npm project (`<agentDir>/pi`),
 * so extensions that resolve their own npm packages at runtime (the `browser`
 * extension) find the ones pi-extensions-install.mjs installed there. It also
 * names the shared Python venv (`SCOPE_PYTHON_VENV`, `<venv>/bin` first on PATH)
 * so the Python-dependent elements (web_fetch, video-creator) reuse it, and
 * `PLAYWRIGHT_BROWSERS_PATH` (once a build is installed) so the Node `browser`
 * extension and the Python elements share one Chromium.
 *
 * Where the bundle is installed, and who puts it there, is `pi-bundle-paths.ts`
 * and `apps/scope-desktop/pi-bundle-install.mjs` (the launcher, the installers
 * and the packaged app all call it). This module only resolves it.
 *
 * Resolution order:
 *   1. `SCOPE_PI_BIN` — explicit operator override (e.g. the e2e tests' stub,
 *      or a power user pointing at a different pi). When set, the bundle is not
 *      used and no shim is installed.
 *   2. The bundled pi: `SCOPE_PI_BUNDLE_DIR` (operator override, or the
 *      packaged launcher's read-only `resources/pi` fallback) → the managed
 *      install `~/.pi-scope/pi` → a dev checkout's `apps/scope-desktop/pi-bundle`.
 *   3. `pi` on PATH — the legacy global install (so nothing breaks if the
 *      bundle is missing).
 *
 * Exports are resolved once, at import time; importing this module installs the
 * shim and prepends its directory to `process.env.PATH`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
// Resolving Pi Scope's own agent dir also pins PI_CODING_AGENT_DIR, so the pi
// processes this module sets up never read the user's global pi agent dir.
import { AGENT_DIR, AGENT_PI_DIR, SCOPE_VENV_DIR } from "./agent-dir.ts";
import { isWindows } from "../../shared/shell.ts";
import { PROJECT_ROOT, piBundleDirs, piCliIn, resolvePiBundleRoot } from "./pi-bundle-paths.ts";

/** The shim's file name for this platform: `pi` is a POSIX shell script, while
 *  Windows needs `pi.cmd` (a `.cmd` is the only thing cmd/the shell can run). */
const SHIM_NAME = isWindows() ? "pi.cmd" : "pi";

// Re-exported so callers (Settings → Update / Authentication) can find the
// bundled agent without importing the paths module directly.
export { resolvePiBundleRoot };

/** Absolute path to the Pi Scope telemetry extension, preferring the copy
 *  shipped inside the bundle (packaged) over the dev checkout's source. */
function resolveExtension(bundleDir: string): string | null {
  const candidates = [
    path.join(bundleDir, "pi-scope.ts"),
    path.join(PROJECT_ROOT, "extension", "pi-scope.ts"),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* try next */ }
  }
  return null;
}

/** Single-quote a value for POSIX `sh`, so paths with spaces/quotes survive. */
function sh(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

interface PiBundleInfo {
  /** How `pi` resolves for spawned processes. */
  source: "override" | "bundled" | "global";
  /** The executable/entry Chat and friends invoke. */
  bin: string;
  /**
   * The argv to actually launch `bin` with, when Pi Scope can bypass its own
   * shim. The bundled agent is a Node CLI, so it is started as
   * `node <cli.js> --extension <pi-scope.ts>` — a real executable on every
   * platform, which on Windows means no `cmd.exe` in the middle and no argument
   * escaping (the prompt rides in argv). The override and global sources are
   * somebody else's binary: `file` is their `bin` and `args` is empty.
   */
  launch: { file: string; args: string[] };
  /** Bundled pi CLI entry (`dist/bundle/cli.js`), when bundled. */
  cli: string | null;
  /** Force-loaded Pi Scope extension path, when bundled. */
  extension: string | null;
  /** The bundle root (the npm project holding `node_modules/@earendil-works/
   *  pi-coding-agent`), when a bundle was resolved. `null` for the override and
   *  global sources, which Pi Scope does not own and cannot update. */
  dir: string | null;
}

/**
 * Install the `pi` shim: a tiny script that runs the bundled CLI under the node
 * that runs this server (the portable Node in a packaged AppImage) and passes
 * `--extension <pi-scope.ts>` before the caller's args, so the telemetry
 * extension loads even when the user's global pi `settings.json` never mentions
 * it. Regenerated on every boot so it can never go stale, and written next to
 * the auth token — a directory that is writable both in dev (`tmp/`) and
 * packaged (`~/.pi-scope/`).
 *
 * POSIX gets a `#!/bin/sh` script; Windows gets `pi.cmd` (see `shimBody`).
 * Either way the file is there for the processes Pi Scope does NOT spawn: the
 * agent-team extension launches nested subagents by the bare name `pi`, so the
 * shim has to resolve through PATH on the platform the server runs on.
 */
function installShim(cli: string, extension: string | null, moduleRoot: string): string {
  const tokenFile = process.env.SCOPE_TOKEN_FILE ?? path.join(PROJECT_ROOT, "tmp", "scope_token");
  const binDir = path.join(path.dirname(tokenFile), "bin");
  const shimPath = path.join(binDir, SHIM_NAME);

  const body = shimBody(cli, extension, moduleRoot);
  try {
    fs.mkdirSync(binDir, { recursive: true });
    // Rewrite only when the content changed, so we don't churn the mtime.
    let current = "";
    try { current = fs.readFileSync(shimPath, "utf8"); } catch { /* absent */ }
    if (current !== body) {
      fs.writeFileSync(shimPath, body, { mode: 0o755 });
      fs.chmodSync(shimPath, 0o755);
    }
  } catch (err) {
    // A read-only runtime dir (unusual) must not take the server down; the
    // caller still gets the bundle path and Chat can invoke it directly.
    console.error(`  Pi bundle: could not write shim at ${shimPath}:`, (err as Error).message);
    return binDir;
  }
  return binDir;
}

/**
 * The shim's text for this platform.
 *
 * Both forms run the same node + CLI entry with the extension force-loaded, the
 * agent dir pinned and the agent dir's npm project named as the extension module
 * root:
 *
 *   POSIX    exec env VAR=… '<node>' '<cli>' --extension '<ext>' "$@"
 *   Windows  set "VAR=…"  then  "\<node>" "\<cli>" --extension "\<ext>" %*
 *
 * The Windows form quotes every path (node, CLI and the extension can all live
 * under `C:\Program Files\…`), and `%*` forwards the caller's arguments
 * untouched. Each is factored out so the two differ only in syntax.
 */
function shimBody(cli: string, extension: string | null, moduleRoot: string): string {
  const node = process.execPath;
  if (isWindows()) {
    const ext = extension ? ` --extension "${extension}"` : "";
    const venvBin = path.join(SCOPE_VENV_DIR, "Scripts");
    return [
      "@echo off",
      "rem Generated by Pi Scope - runs the bundled Pi coding agent with the Pi Scope",
      "rem extension force-loaded, using Pi Scope's own agent dir. Do not edit;",
      "rem rewritten on every server boot.",
      `set "PI_CODING_AGENT_DIR=${AGENT_DIR}"`,
      `set "PI_BROWSER_MODULE_ROOT=${moduleRoot}"`,
      `set "SCOPE_PYTHON_VENV=${SCOPE_VENV_DIR}"`,
      ...(process.env.PLAYWRIGHT_BROWSERS_PATH
        ? [`set "PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH}"`]
        : []),
      `set "PATH=${venvBin};%PATH%"`,
      ...(extension ? [`set "PI_SCOPE_FORCE_EXTENSION=${extension}"`] : []),
      `"${node}" "${cli}"${ext} %*`,
      "",
    ].join("\r\n");
  }
  const ext = extension ? `--extension ${sh(extension)} ` : "";
  // PI_SCOPE_FORCE_EXTENSION names the authoritative copy of the extension, so
  // a *different* copy loaded from elsewhere makes itself a no-op instead of
  // registering the same flags (which pi reports as a hard error).
  const forceEnv = extension ? `PI_SCOPE_FORCE_EXTENSION=${sh(extension)} ` : "";
  // Pin the bundled agent to Pi Scope's own agent dir. This is what keeps Pi
  // Scope from discovering (or mutating) anything in the user's global pi agent
  // dir — including a stale pi-scope.ts whose flags would collide with the
  // force-loaded copy.
  const agentEnv = `PI_CODING_AGENT_DIR=${sh(AGENT_DIR)} `;
  // Extensions resolve their own npm packages from the agent dir's npm project
  // (pi-extensions-install.mjs installs them into <agentDir>/pi), which is what
  // the `browser` extension's PI_BROWSER_MODULE_ROOT looks for. Naming it here
  // instead of leaving the extension to fall back on cwd/$HOME means an
  // extension finds its packages wherever the agent was started from.
  const moduleEnv = `PI_BROWSER_MODULE_ROOT=${sh(moduleRoot)} `;
  // The shared Python venv: name it and put its bin dir first, so the
  // Python-dependent elements (web_fetch, video-creator) reuse it instead of a
  // system interpreter.
  const venvEnv = `SCOPE_PYTHON_VENV=${sh(SCOPE_VENV_DIR)} PATH=${sh(path.join(SCOPE_VENV_DIR, "bin"))}:$PATH `;
  // Pi Scope's Playwright browser builds (agent-dir.ts set the variable once the
  // dir holds a build, or the user overrode it). Named here so a shim-launched pi
  // — e.g. typed into the in-app Terminal — finds the same Chromium.
  const browsersEnv = process.env.PLAYWRIGHT_BROWSERS_PATH
    ? `PLAYWRIGHT_BROWSERS_PATH=${sh(process.env.PLAYWRIGHT_BROWSERS_PATH)} `
    : "";
  return [
    "#!/bin/sh",
    "# Generated by Pi Scope — runs the bundled Pi coding agent with the Pi Scope",
    "# extension force-loaded, using Pi Scope's own agent dir. Do not edit;",
    "# rewritten on every server boot.",
    `exec env ${agentEnv}${moduleEnv}${venvEnv}${browsersEnv}${forceEnv}${sh(node)} ${sh(cli)} ${ext}"$@"`,
    "",
  ].join("\n");
}

/**
 * Keep any copy of the extension inside the agent dir in step with the one the
 * launcher force-loads.
 *
 * pi discovers every file under `<agentDir>/extensions/` *in addition to* the
 * paths listed in settings.json, so such a copy is loaded alongside the
 * force-loaded one. Two things keep that from being fatal: the launcher names
 * its own copy in PI_SCOPE_FORCE_EXTENSION (see `resolve`), and the extension
 * stands down when it is a *different* file than the one named there. A copy
 * from an older build predates both, so it registers the same CLI flags as the
 * force-loaded copy, pi reports `Flag "--obs-server-url" conflicts with …` and
 * exits before the first prompt — which is what a plain `pi-scope.ts` sitting in
 * the agent dir does to every process Pi Scope spawns.
 *
 * Refreshing on every boot (like the shim itself) means the copy can never go
 * stale. A copy that isn't there is left alone: the shim is the delivery path,
 * so there is nothing to repair and nothing new is created.
 */
function syncAgentDirExtension(extension: string): void {
  const target = path.join(AGENT_DIR, "extensions", path.basename(extension));
  try {
    if (!fs.statSync(target).isFile()) return;
    const want = fs.readFileSync(extension, "utf8");
    if (fs.readFileSync(target, "utf8") === want) return;
    fs.writeFileSync(target, want);
    console.log(
      `  Pi bundle: refreshed the stale copy at ${target} — it predates the guard that ` +
      `keeps a discovered copy from colliding with the force-loaded one on shared flags`,
    );
  } catch {
    // Absent (normal), or unreadable/unwritable — never fatal: the force-loaded
    // extension is what Pi Scope's own processes use.
  }
}

/** Prepend `dir` to PATH when it isn't already there. */
function prependPath(dir: string): void {
  const parts = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  if (parts.includes(dir)) return;
  process.env.PATH = [dir, ...parts].join(path.delimiter);
}

function resolve(): PiBundleInfo {
  // 1. Explicit override — the e2e tests point this at a stub, and an operator
  //    may deliberately pin a different pi. Leave PATH/shim untouched.
  const override = (process.env.SCOPE_PI_BIN || "").trim();
  if (override) {
    return {
      source: "override", bin: override, launch: { file: override, args: [] },
      cli: null, extension: null, dir: null,
    };
  }

  // 2. Bundled pi.
  for (const dir of piBundleDirs()) {
    const cli = piCliIn(dir);
    if (!cli) continue;
    const extension = resolveExtension(dir);
    // Repair a stale in-agent-dir copy before anything is spawned: pi discovers
    // it too, and a second, older registration of the same flags is fatal.
    if (extension) syncAgentDirExtension(extension);
    const binDir = installShim(cli, extension, AGENT_PI_DIR);
    prependPath(binDir);
    const bin = path.join(binDir, SHIM_NAME);
    // Chat's resolver prefers SCOPE_PI_BIN; set it so every code path (and the
    // child env it builds) agrees on the bundled agent.
    process.env.SCOPE_PI_BIN = bin;
    // Name the force-loaded copy as authoritative in THIS process too, exactly
    // as the shim does for processes that go through PATH. `launch` below is
    // node + the CLI entry, so it bypasses the shim entirely — and without the
    // marker a copy pi discovers on its own (e.g. `~/…/agent/extensions/
    // pi-scope.ts`) registers the very same CLI flags as the `--extension`
    // copy, which pi reports as `Flag "--o-name" conflicts with …` and turns
    // into a hard exit before the first prompt. That is what broke the
    // git-commit-message generator (and would break Chat wherever it can't
    // spawn through the user's shell): both spawn `launch` with the env
    // `chatChildEnv` builds from this one.
    if (extension) process.env.PI_SCOPE_FORCE_EXTENSION = extension;
    // Same reason as the shim's own copy: this env is what chatChildEnv builds
    // the direct (no-shell) spawn from, and pi-extensions-install.mjs put the
    // extensions' packages in the agent dir's own npm project (<agentDir>/pi).
    process.env.PI_BROWSER_MODULE_ROOT = AGENT_PI_DIR;
    // Spawned directly it is a Node CLI, not a shim: no shell, no `.cmd`. The
    // extension flag is passed exactly as the shim would.
    const launch = { file: process.execPath, args: [cli, ...(extension ? ["--extension", extension] : [])] };
    return { source: "bundled", bin, launch, cli, extension, dir };
  }

  // 3. Fall back to whatever `pi` global install is on PATH.
  return {
    source: "global", bin: process.env.SCOPE_PI_BIN || "pi", launch: { file: process.env.SCOPE_PI_BIN || "pi", args: [] },
    cli: null, extension: null, dir: null,
  };
}

export const PI_BUNDLE: PiBundleInfo = resolve();
/** Executable to launch the Pi coding agent (bundled shim, override, or `pi`). */
export const PI_BIN: string = PI_BUNDLE.bin;
/** How to launch it: `{ file, args }` to spread into a spawn (see PiBundleInfo). */
export const PI_LAUNCH: { file: string; args: string[] } = PI_BUNDLE.launch;

console.log(
  `  Pi bundle: pi -> ${PI_BIN} (${PI_BUNDLE.source}` +
  `${PI_BUNDLE.dir ? ` at ${PI_BUNDLE.dir}` : ""}${PI_BUNDLE.extension ? `, extension ${PI_BUNDLE.extension}` : ""})`,
);
