/**
 * pi-bundle.ts — the Pi coding agent bundled with Pi Scope.
 *
 * Pi Scope ships its own copy of the [`pi`](https://github.com/disler/pi-agent-observability)
 * coding agent (`apps/scope-desktop/pi-bundle`, installed from
 * `@earendil-works/pi-coding-agent`). This module locates that copy and, when it
 * is present, exposes a `pi` shim on PATH that runs the bundled agent with the
 * Pi Scope extension force-loaded.
 *
 * The effect: every `pi` process Pi Scope launches — Chat subprocesses, the
 * git-commit-message generator, the in-browser Terminal's shell, and the nested
 * subagents the agent-team extension spawns by bare name — resolves to the
 * bundled agent and reports telemetry, with no global `pi` install required.
 * The shim also pins `PI_CODING_AGENT_DIR` to Pi Scope's own agent dir
 * (agent-dir.ts), so the bundled agent never reads or writes the user's global
 * pi agent dir and can't collide with a globally-installed pi extension.
 *
 * Resolution order:
 *   1. `SCOPE_PI_BIN` — explicit operator override (e.g. the e2e tests' stub,
 *      or a power user pointing at a different pi). When set, the bundle is not
 *      used and no shim is installed.
 *   2. The bundled pi, from `SCOPE_PI_BUNDLE_DIR` (set by the packaged launcher)
 *      or the dev checkout path.
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
import { AGENT_DIR } from "./agent-dir.ts";

/** Repo root in dev; the app resources dir when packaged. Only reliable for
 *  locating dev paths — packaged callers pass `SCOPE_PI_BUNDLE_DIR`. */
const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..");

/** Path to the pi CLI entry inside a bundle directory, or null if it isn't one. */
function cliIn(bundleDir: string | undefined): string | null {
  if (!bundleDir) return null;
  const cli = path.join(
    bundleDir,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "bundle",
    "cli.js",
  );
  try {
    return fs.statSync(cli).isFile() ? cli : null;
  } catch {
    return null;
  }
}

/** Candidate bundle directories, most specific first. */
function candidateBundleDirs(): string[] {
  const out: string[] = [];
  const configured = (process.env.SCOPE_PI_BUNDLE_DIR || "").trim();
  if (configured) out.push(configured);
  // Dev checkout: <project>/apps/scope-desktop/pi-bundle.
  out.push(path.join(PROJECT_ROOT, "apps", "scope-desktop", "pi-bundle"));
  return out;
}

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

export interface PiBundleInfo {
  /** How `pi` resolves for spawned processes. */
  source: "override" | "bundled" | "global";
  /** The executable/entry Chat and friends invoke. */
  bin: string;
  /** Directory containing the `pi` shim, when one was installed. */
  binDir: string | null;
  /** Bundled pi CLI entry (`dist/bundle/cli.js`), when bundled. */
  cli: string | null;
  /** Force-loaded Pi Scope extension path, when bundled. */
  extension: string | null;
}

/**
 * Install the `pi` shim: a tiny shell script that runs the bundled CLI under
 * the node that runs this server (the portable Node in a packaged AppImage) and
 * passes `--extension <pi-scope.ts>` before the caller's args, so the telemetry
 * extension loads even when the user's global pi `settings.json` never
 * mentions it. Regenerated on every boot so it can never go stale, and written
 * next to the auth token — a directory that is writable both in dev (`tmp/`)
 * and packaged (`~/.pi-scope/`).
 */
function installShim(cli: string, extension: string | null): string {
  const tokenFile = process.env.SCOPE_TOKEN_FILE ?? path.join(PROJECT_ROOT, "tmp", "scope_token");
  const binDir = path.join(path.dirname(tokenFile), "bin");
  const shimPath = path.join(binDir, "pi");
  const node = process.execPath;

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
  const body = [
    "#!/bin/sh",
    "# Generated by Pi Scope — runs the bundled Pi coding agent with the Pi Scope",
    "# extension force-loaded, using Pi Scope's own agent dir. Do not edit;",
    "# rewritten on every server boot.",
    `exec env ${agentEnv}${forceEnv}${sh(node)} ${sh(cli)} ${ext}"$@"`,
    "",
  ].join("\n");

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
 * Keep any copy of the extension inside the agent dir in step with the one the
 * shim force-loads.
 *
 * pi discovers every file under `<agentDir>/extensions/` *in addition to* the
 * paths listed in settings.json. A copy left behind by an older build is not
 * byte-identical to the force-loaded file, so the duplicate-detection inside the
 * extension (which compares real paths and only stands down for a *different*
 * file than the forced one) can't recognise it: both copies register the same
 * CLI flags, pi reports `Flag "--obs-server-url" conflicts with …` and exits
 * before the first prompt — which is what a plain `pi-scope.ts` sitting in the
 * agent dir does to every process Pi Scope spawns.
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
      `  Pi bundle: refreshed the stale copy at ${target} — pi discovers it as well as the ` +
      `force-loaded one, and a mismatch makes them collide on shared flags`,
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
    return { source: "override", bin: override, binDir: null, cli: null, extension: null };
  }

  // 2. Bundled pi.
  for (const dir of candidateBundleDirs()) {
    const cli = cliIn(dir);
    if (!cli) continue;
    const extension = resolveExtension(dir);
    // Repair a stale in-agent-dir copy before anything is spawned: pi discovers
    // it too, and a second, older registration of the same flags is fatal.
    if (extension) syncAgentDirExtension(extension);
    const binDir = installShim(cli, extension);
    prependPath(binDir);
    const bin = path.join(binDir, "pi");
    // Chat's resolver prefers SCOPE_PI_BIN; set it so every code path (and the
    // child env it builds) agrees on the bundled agent.
    process.env.SCOPE_PI_BIN = bin;
    return { source: "bundled", bin, binDir, cli, extension };
  }

  // 3. Fall back to whatever `pi` global install is on PATH.
  return { source: "global", bin: process.env.SCOPE_PI_BIN || "pi", binDir: null, cli: null, extension: null };
}

export const PI_BUNDLE: PiBundleInfo = resolve();
/** Executable to launch the Pi coding agent (bundled shim, override, or `pi`). */
export const PI_BIN: string = PI_BUNDLE.bin;
/** Directory of the bundled `pi` shim, when one is on PATH. */
export const PI_BIN_DIR: string | null = PI_BUNDLE.binDir;
/** Force-loaded Pi Scope extension, when the bundled agent is in use. */
export const PI_EXTENSION: string | null = PI_BUNDLE.extension;

console.log(
  `  Pi bundle: pi -> ${PI_BIN} (${PI_BUNDLE.source}${PI_EXTENSION ? `, extension ${PI_EXTENSION}` : ""})`,
);
