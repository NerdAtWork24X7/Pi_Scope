/**
 * pi-update.ts — check for and install a newer Pi coding agent.
 *
 * Pi Scope ships its own copy of the [`pi`](https://github.com/disler/pi-agent-observability)
 * coding agent in a small npm project (`apps/scope-desktop/pi-bundle` in dev,
 * `resources/pi` packaged) — see pi-bundle.ts. This module answers two
 * questions the Settings → Update tab asks:
 *
 *   1. *What version is installed, and is there a newer one?* — reads the
 *      bundled package's `package.json` and asks the npm registry for the
 *      `latest` dist-tag.
 *   2. *Install it.* — runs `npm install @earendil-works/pi-coding-agent@latest`
 *      in the bundle, so the next `pi` process (the next Chat prompt or
 *      subagent) runs the new agent. No server restart is required: the shim
 *      re-execs the bundle's CLI on every spawn.
 *
 * Only a bundle Pi Scope owns can be updated. When `pi` resolves to an operator
 * override or a global install the status is reported as not updatable with a
 * reason, rather than silently touching someone else's install.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { PI_BUNDLE } from "./pi-bundle.ts";

/** The npm package Pi Scope bundles. */
export const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/** npm registry root; override with SCOPE_PI_REGISTRY (tests point this at a
 *  local server, air-gapped installs at a mirror). */
const DEFAULT_REGISTRY = "https://registry.npmjs.org";
/** How long the registry lookup may take before it is treated as unreachable. */
const CHECK_TIMEOUT_MS = 10_000;
/** How long `npm install` may run before it is killed. */
const UPDATE_TIMEOUT_MS = 5 * 60_000;
/** Keep only the tail of npm's output — it is for diagnostics, not display. */
const MAX_OUTPUT = 8_000;

export interface PiUpdateStatus {
  /** npm package under management. */
  package: string;
  /** How `pi` resolves: "bundled" | "override" | "global". */
  source: string;
  /** Bundle root Pi Scope owns (null when it doesn't own the install). */
  bundleDir: string | null;
  /** Version on disk, or null when the package is absent. */
  installed: string | null;
  /** Version published to npm, or null when that could not be determined. */
  latest: string | null;
  /** True when `latest` is strictly newer than `installed`. */
  updateAvailable: boolean;
  /** True when this module can install into the bundle. */
  updatable: boolean;
  /** Why an update cannot be installed (present only when !updatable). */
  reason?: string;
  /** ISO timestamp of the last registry check. */
  checkedAt: string | null;
  /** Last error (registry unreachable, npm failed, …), if any. */
  error?: string;
  /** Tail of the last `npm install` output, when an install ran. */
  output?: string;
}

/** Path of the package inside a bundle's node_modules. */
function packageDir(bundleDir: string): string {
  return path.join(bundleDir, "node_modules", ...PI_PACKAGE.split("/"));
}

/** Version of the package installed under `bundleDir`, or null if absent. */
function readInstalled(bundleDir: string | null): string | null {
  if (!bundleDir) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageDir(bundleDir), "package.json"), "utf8"));
    return typeof pkg?.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/** Whether the bundle directory can be written to (a packaged AppImage mount
 *  is read-only, so its bundled copy cannot be updated in place). */
function isWritable(dir: string): boolean {
  try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; }
}

function registryBase(): string {
  return (process.env.SCOPE_PI_REGISTRY || DEFAULT_REGISTRY).replace(/\/+$/, "");
}

/** Fetch the `latest` dist-tag from the npm registry. Throws on any failure so
 *  callers can surface a clear message instead of a false "up to date". */
async function fetchLatest(): Promise<string> {
  const url = `${registryBase()}/${PI_PACKAGE.replace("/", "%2F")}/latest`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`registry HTTP ${res.status}`);
    const data: any = await res.json();
    if (typeof data?.version !== "string" || !data.version) throw new Error("registry response had no version");
    return data.version;
  } catch (err: any) {
    if (err?.name === "AbortError") throw new Error(`registry timed out after ${CHECK_TIMEOUT_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Split a semver into numeric components + a prerelease string. */
function parseVersion(v: string): { nums: number[]; pre: string } {
  const [core, ...pre] = String(v).trim().split("-");
  return { nums: core.split(".").map((n) => parseInt(n, 10) || 0), pre: pre.join("-") };
}

/** -1 / 0 / 1 for `a` before / equal to / after `b`. Release beats prerelease. */
function compareVersions(a: string, b: string): number {
  const A = parseVersion(a);
  const B = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    const diff = (A.nums[i] ?? 0) - (B.nums[i] ?? 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  if (A.pre === B.pre) return 0;
  if (!A.pre) return 1;
  if (!B.pre) return -1;
  return A.pre > B.pre ? 1 : -1;
}

/** Starting shape every response shares: where the agent is, what's installed,
 *  and whether Pi Scope may update it. */
function baseStatus(): PiUpdateStatus {
  const bundleDir = PI_BUNDLE.source === "bundled" ? PI_BUNDLE.dir : null;
  const installed = readInstalled(bundleDir);
  let updatable = false;
  let reason: string | undefined;
  if (!bundleDir) {
    reason = PI_BUNDLE.source === "override"
      ? "Pi Scope is using an external pi via SCOPE_PI_BIN — update that install yourself."
      : "Pi Scope is using a globally installed pi on PATH — update it with npm install -g.";
  } else if (!isWritable(bundleDir)) {
    reason = "The bundled agent lives on a read-only filesystem (packaged app), so it cannot be updated in place.";
  } else if (!installed) {
    reason = "No bundled pi-coding-agent package was found to update.";
  } else {
    updatable = true;
  }
  return {
    package: PI_PACKAGE,
    source: PI_BUNDLE.source,
    bundleDir,
    installed,
    latest: null,
    updateAvailable: false,
    updatable,
    reason,
    checkedAt: null,
  };
}

/** Read the installed version and ask npm for the latest. Never throws: a
 *  registry failure comes back in `error` so the tab can still show the
 *  installed version. */
export async function checkPiUpdate(): Promise<PiUpdateStatus> {
  const status = baseStatus();
  if (!status.installed) {
    return { ...status, checkedAt: new Date().toISOString() };
  }
  try {
    status.latest = await fetchLatest();
    status.updateAvailable = compareVersions(status.latest, status.installed) > 0;
  } catch (err: any) {
    status.error = `Could not reach the npm registry: ${err?.message || err}`;
  }
  status.checkedAt = new Date().toISOString();
  return status;
}

/** Run a command to completion, resolving with its combined output. */
function run(bin: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    let settled = false;
    const proc = spawn(bin, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
      reject(new Error(`npm install timed out after ${UPDATE_TIMEOUT_MS / 60_000} minutes`));
    }, UPDATE_TIMEOUT_MS);
    const collect = (chunk: Buffer) => { out = (out + chunk.toString()).slice(-MAX_OUTPUT); };
    proc.stdout?.on("data", collect);
    proc.stderr?.on("data", collect);
    proc.on("error", (err: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err?.code === "ENOENT" ? new Error(`npm not found (${bin}) — install npm or set SCOPE_NPM_BIN`) : err);
    });
    proc.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`npm install exited with code ${code}${out.trim() ? `\n${out.trim()}` : ""}`));
    });
  });
}

/** Deduplicate concurrent update requests — `npm install` must not run twice. */
let inFlight: Promise<PiUpdateStatus> | null = null;

/** Whether an install is currently running. */
export function isUpdating(): boolean {
  return inFlight !== null;
}

/** Install the newest Pi coding agent into the bundled npm project and return
 *  the resulting status. Rejected promise (surfaced as a 500) when the agent
 *  isn't one Pi Scope can update or npm fails. */
export function updatePi(): Promise<PiUpdateStatus> {
  if (inFlight) return inFlight;
  inFlight = runUpdate().finally(() => { inFlight = null; });
  return inFlight;
}

async function runUpdate(): Promise<PiUpdateStatus> {
  const status = baseStatus();
  if (!status.bundleDir) throw new Error(status.reason || "no bundled pi to update");
  if (!status.updatable) throw new Error(status.reason || "the bundled pi cannot be updated");
  const npm = (process.env.SCOPE_NPM_BIN || "npm").trim() || "npm";
  const args = ["install", "--no-audit", "--no-fund", "--save-exact", `${PI_PACKAGE}@latest`];
  const output = await run(npm, args, status.bundleDir);
  // Re-read the on-disk version and the registry (npm may report success while
  // a mirror still serves the old version).
  const after = await checkPiUpdate();
  after.bundleDir = status.bundleDir;
  after.updatable = true;
  after.installed = readInstalled(status.bundleDir);
  if (after.latest) after.updateAvailable = compareVersions(after.latest, after.installed || "0.0.0") > 0;
  after.output = output;
  return after;
}
