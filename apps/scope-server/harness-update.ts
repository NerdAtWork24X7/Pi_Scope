/**
 * harness-update.ts — keep the external coding-agent CLIs current.
 *
 * Settings → Update has always managed Pi Scope's own bundled pi. Chat can also
 * drive Claude Code, Codex, Gemini CLI, opencode, Cline, Kilo, Aider and Cursor
 * Agent (see harnesses.ts), and those CLIs go stale on their own schedule. This
 * module answers the same two questions for them that pi-update.ts answers for
 * pi:
 *
 *   1. *What is installed, and is there a newer release?* — runs the CLI's own
 *      `--version`, then asks its package registry for `latest` (npm, or PyPI
 *      for aider).
 *   2. *Update it.* — runs the CLI's own updater (`claude update`,
 *      `opencode upgrade`, …) where it has one, otherwise the package manager
 *      command the maintainers document (`npm install -g …@latest`).
 *
 * Why the CLI's own updater first: these tools know how *they* were installed —
 * a native binary in `~/.opencode/bin`, a Homebrew keg, an npm global — and
 * `npm install -g` would otherwise create a second, shadowed copy. Only Gemini
 * CLI has no self-update command, so it goes through npm; Aider updates itself
 * with `--upgrade`.
 *
 * Ownership is deliberately different from pi: Pi Scope only reports and
 * updates a harness it can actually find on this machine. A custom harness
 * defined in Settings → Plugins → Workflow is listed but never touched — its
 * installer is the user's business.
 *
 * Everything is cached briefly (versions 60s, registry answers 10min) because
 * the Settings tab asks on every visit, and a check runs one short subprocess
 * per installed CLI. `force` (the tab's "Check" button) bypasses both caches.
 */
import * as os from "node:os";
import { killTree, spawnCli } from "../../shared/shell.ts";
import { trackProcess } from "./process-registry.ts";
import { chatHarnessList, type ChatHarnessInfo } from "./harnesses.ts";
import { workflowHarnessSettings } from "./workflow-harness-settings.ts";
import { compareVersions, findVersion } from "./semver.ts";
import { runCommand, systemNpmCommand } from "./cli-run.ts";

/** Registry roots; SCOPE_HARNESS_REGISTRY / SCOPE_HARNESS_PYPI point tests (or
 *  an air-gapped install) at a mirror. */
const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";
const DEFAULT_PYPI = "https://pypi.org";
/** How long a registry lookup may take before it is treated as unreachable. */
const CHECK_TIMEOUT_MS = 8_000;
/** How long a CLI's `--version` may take. */
const VERSION_TIMEOUT_MS = 10_000;
/** How long one updater may run before it is killed. */
const UPDATE_TIMEOUT_MS = 5 * 60_000;
/** Version probes are cheap but not free; reuse one for a minute. */
const VERSION_TTL_MS = 60_000;
/** Registry answers change at the project's release pace. */
const LATEST_TTL_MS = 10 * 60_000;

/** How this harness is updated. */
interface HarnessUpdater {
  /** npm package whose `latest` tag is the release to compare against. */
  npm?: string;
  /** PyPI project (aider). */
  pypi?: string;
  /** Arguments for the CLI's own updater; the resolved binary is the file. */
  self?: string[];
}

/**
 * The built-in harnesses and their update channels.
 *
 * `self` wins over a package manager: `claude update` and `kilo upgrade` know
 * where that install lives. Gemini publishes no updater command, so it uses the
 * package the docs tell people to install.
 */
const UPDATERS: Record<string, HarnessUpdater> = {
  claude: { npm: "@anthropic-ai/claude-code", self: ["update"] },
  codex: { npm: "@openai/codex", self: ["update"] },
  gemini: { npm: "@google/gemini-cli" },
  opencode: { npm: "opencode-ai", self: ["upgrade"] },
  cline: { npm: "cline", self: ["update"] },
  kilo: { npm: "@kilocode/cli", self: ["upgrade"] },
  aider: { pypi: "aider-chat", self: ["--yes", "--upgrade"] },
  // Cursor's CLI is installed by its own script and publishes no npm package,
  // so there is no release to compare against — only the updater it ships.
  cursor: { self: ["update"] },
};

/** One harness's update status, as the Settings → Update card renders it. */
export interface HarnessUpdateStatus {
  id: string;
  label: string;
  /** Executable name (`claude`) — what the picker shows. */
  bin: string;
  /** Absolute path this install resolved to. */
  path: string | null;
  /** Version the CLI reports, or null when it did not answer. */
  installed: string | null;
  /** Newest published release, when its registry could be read. */
  latest: string | null;
  /** True when `latest` is strictly newer than `installed`. */
  updateAvailable: boolean;
  /** True when this module knows how to update it. */
  updatable: boolean;
  /** "cli" (its own updater), "npm" or "pypi"; null when not updatable. */
  manager: string | null;
  /** The command the Update button runs, for the card's hint/tooltip. */
  command: string | null;
  /** Why it cannot be updated (present only when !updatable). */
  reason?: string;
  /** Last check error (registry unreachable, no version reported, …). */
  error?: string;
  /** Tail of the last update output, when an update ran this session. */
  output?: string;
  /** ISO timestamp of the last check for this row. */
  checkedAt: string;
}

export interface HarnessUpdateOutcome {
  /** When the update reached its terminal state. */
  at: string;
  /** Harness id, or "all" for Update all. */
  id: string;
  ok: boolean;
  /** Installed version on success (for "all": "2/3"). */
  installed: string;
  /** Failure reason on error. */
  error: string;
  /** Tail of the updater's output. */
  output?: string;
}

/** Install state a client can read at any time (reload recovery, like pi). */
export interface HarnessUpdateState {
  running: boolean;
  /** Harness id being updated, or "all"; null when idle. */
  id: string | null;
  startedAt: string | null;
  last: HarnessUpdateOutcome | null;
}

// ─── Caches ──────────────────────────────────────────────────────────────────

const versionCache = new Map<string, { at: number; version: string | null; error?: string }>();
const latestCache = new Map<string, { at: number; version: string | null; error?: string }>();
/** Rows from the last completed check (see harnessStatusSnapshot). */
let statusSnapshot: HarnessUpdateStatus[] | null = null;

function clearVersionCache(path?: string): void {
  if (path) versionCache.delete(path);
  else versionCache.clear();
}

function clearLatestCache(key?: string): void {
  if (key) latestCache.delete(key);
  else latestCache.clear();
}

function registryBase(): string {
  return (process.env.SCOPE_HARNESS_REGISTRY || DEFAULT_NPM_REGISTRY).replace(/\/+$/, "");
}

function pypiBase(): string {
  return (process.env.SCOPE_HARNESS_PYPI || DEFAULT_PYPI).replace(/\/+$/, "");
}

/** Fetch JSON with a timeout, turning an abort into a readable message. */
async function fetchJson(url: string): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err: any) {
    if (err?.name === "AbortError") throw new Error(`timed out after ${CHECK_TIMEOUT_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Ask the npm registry for a package's `latest` tag. */
async function fetchNpmLatest(pkg: string): Promise<string> {
  const data = await fetchJson(`${registryBase()}/${encodeURIComponent(pkg)}/latest`);
  if (typeof data?.version !== "string" || !data.version) throw new Error("registry response had no version");
  return data.version;
}

/** Ask PyPI for a project's newest release. */
async function fetchPypiLatest(pkg: string): Promise<string> {
  const data = await fetchJson(`${pypiBase()}/pypi/${encodeURIComponent(pkg)}/json`);
  const version = data?.info?.version;
  if (typeof version !== "string" || !version) throw new Error("PyPI response had no version");
  return version;
}

/** The newest published version for a harness, or null when it has no registry. */
async function readLatest(updater: HarnessUpdater | undefined, force: boolean): Promise<{ version: string | null; error?: string }> {
  if (!updater?.npm && !updater?.pypi) return { version: null };
  const key = updater.npm ? `npm:${updater.npm}` : `pypi:${updater.pypi}`;
  const hit = latestCache.get(key);
  if (!force && hit && Date.now() - hit.at < LATEST_TTL_MS) return { version: hit.version, error: hit.error };
  try {
    const version = updater.npm ? await fetchNpmLatest(updater.npm) : await fetchPypiLatest(updater.pypi!);
    latestCache.set(key, { at: Date.now(), version });
    return { version };
  } catch (err: any) {
    const registry = updater.npm ? "npm registry" : "PyPI";
    const error = `Could not reach the ${registry}: ${err?.message || err}`;
    // Cache the failure briefly too, so one settings visit with the network
    // down does not launch the same doomed request for every harness.
    latestCache.set(key, { at: Date.now(), version: null, error });
    return { version: null, error };
  }
}

// ─── Reading a CLI's version ─────────────────────────────────────────────────

/** Run `<bin> --version` and parse the version out of its output. */
function probeVersion(path: string, bin: string): Promise<{ version: string | null; error?: string }> {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(path, ["--version"], {
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      trackProcess(child, {
        kind: "discovery",
        label: `${bin} --version`,
        group: process.platform !== "win32",
      });
    } catch (err: any) {
      resolve({ version: null, error: `could not run ${bin}: ${err?.message || err}` });
      return;
    }
    const finish = (result: { version: string | null; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { killTree(child); } catch { /* already gone */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ version: null, error: `${bin} --version timed out` }), VERSION_TIMEOUT_MS);
    child.stdout?.on("data", (d: Buffer) => { out = (out + d.toString()).slice(-4_000); });
    // Drained so a chatty CLI cannot block on stderr; some CLIs print the
    // version there, but stdout is what every one of these uses.
    child.stderr?.on("data", () => { /* drain */ });
    child.on("error", (err: any) => finish({
      version: null,
      error: err?.code === "ENOENT" ? `${bin} was not found` : String(err?.message || err),
    }));
    child.on("close", () => {
      const version = findVersion(out);
      finish(version ? { version } : { version: null, error: `${bin} did not report a version` });
    });
  });
}

async function readInstalled(path: string, bin: string, force: boolean): Promise<{ version: string | null; error?: string }> {
  const hit = versionCache.get(path);
  if (!force && hit && Date.now() - hit.at < VERSION_TTL_MS) return { version: hit.version, error: hit.error };
  const result = await probeVersion(path, bin);
  versionCache.set(path, { at: Date.now(), ...result });
  return result;
}

// ─── Status ──────────────────────────────────────────────────────────────────

/** The command string shown in the card, matching what updateHarness runs. */
function describeCommand(updater: HarnessUpdater, bin: string): string {
  if (updater.self) return `${bin} ${updater.self.join(" ")}`;
  if (updater.npm) return `npm install -g ${updater.npm}@latest`;
  if (updater.pypi) return `pip install -U ${updater.pypi}`;
  return "";
}

/** One row for a harness this install can run. */
async function statusFor(info: ChatHarnessInfo, force: boolean): Promise<HarnessUpdateStatus> {
  const updater = UPDATERS[info.id];
  const bin = info.bin || info.id;
  const path = info.resolved;
  const base = {
    id: info.id,
    label: info.label,
    bin,
    path,
    manager: updater ? (updater.self ? "cli" : updater.npm ? "npm" : "pypi") : null,
    command: updater ? describeCommand(updater, bin) : null,
    checkedAt: new Date().toISOString(),
  };

  // A harness defined by the user has no updater Pi Scope can vouch for. Its
  // version is still useful, but never spell out a command we would not run.
  if (!updater) {
    const installed = path ? (await readInstalled(path, bin, force)).version : null;
    return {
      ...base,
      installed,
      latest: null,
      updateAvailable: false,
      updatable: false,
      reason: "Custom harness — update it with its own installer.",
    };
  }

  const [local, remote] = await Promise.all([
    path ? readInstalled(path, bin, force) : Promise.resolve({ version: null, error: `${bin} was not found on PATH` }),
    readLatest(updater, force),
  ]);
  const installed = local.version;
  const latest = remote.version;
  const updateAvailable = !!(installed && latest && compareVersions(latest, installed) > 0);
  return {
    ...base,
    installed,
    latest,
    updateAvailable,
    updatable: true,
    ...(local.error || remote.error ? { error: remote.error || local.error } : {}),
  };
}

/**
 * Every built-in/installed harness with its version and update availability.
 * Harnesses that are not installed are left out: the card is about what this
 * machine can actually run and update.
 */
export async function checkHarnessUpdates(opts: { force?: boolean } = {}): Promise<HarnessUpdateStatus[]> {
  if (opts.force) {
    clearVersionCache();
    clearLatestCache();
  }
  const settings = workflowHarnessSettings();
  const installed = chatHarnessList(settings).filter((h) => h.id !== "pi" && h.available);
  const statuses = await Promise.all(installed.map((h) => statusFor(h, !!opts.force)));
  statusSnapshot = statuses;
  return statuses;
}

/** The rows from the most recent check, without probing anything. The GET route
 *  serves this while an update runs so a page polling for the outcome does not
 *  spawn a `--version` process every two seconds (or read a binary mid-replace). */
export function harnessStatusSnapshot(): HarnessUpdateStatus[] | null {
  return statusSnapshot;
}

// ─── Running an update ───────────────────────────────────────────────────────

/** How to invoke an updater: a command plus the argv to append. `self` runs the
 *  resolved harness itself; package managers go through cli-run.ts. */
function updaterCommand(updater: HarnessUpdater, status: HarnessUpdateStatus): {
  command: { file: string; args: string[]; label: string };
  args: string[];
  cwd: string;
  exitLabel: string;
  missingHint: string;
} {
  if (updater.self) {
    if (!status.path) throw new Error(`${status.label} was not found on PATH`);
    return {
      command: { file: status.path, args: [], label: status.bin },
      args: updater.self,
      cwd: os.homedir(),
      exitLabel: `${status.bin} ${updater.self[0]}`,
      missingHint: "install it again, or re-point the harness binary in Settings → Plugins → Workflow",
    };
  }
  if (updater.npm) {
    return {
      command: systemNpmCommand(),
      args: ["install", "-g", "--no-audit", "--no-fund", `${updater.npm}@latest`],
      cwd: os.homedir(),
      exitLabel: `npm install ${updater.npm}`,
      missingHint: "install npm or set SCOPE_NPM_BIN",
    };
  }
  // PyPI fallback. No built-in harness uses it today (aider has its own
  // updater), but keeping it means adding one is a one-line change.
  const python = process.env.SCOPE_PYTHON_BIN || "python3";
  return {
    command: { file: python, args: [], label: python },
    args: ["-m", "pip", "install", "-U", updater.pypi!],
    cwd: os.homedir(),
    exitLabel: `pip install ${updater.pypi}`,
    missingHint: "install Python/pip or set SCOPE_PYTHON_BIN",
  };
}

/** Run one updater. Never touches the running-state singleton — callers own it. */
async function runHarnessUpdate(status: HarnessUpdateStatus): Promise<HarnessUpdateStatus> {
  const updater = UPDATERS[status.id];
  if (!updater) throw new Error(`${status.label} is a custom harness and cannot be updated from here`);
  if (!status.updatable) throw new Error(status.reason || `${status.label} cannot be updated from here`);
  const spec = updaterCommand(updater, status);
  const output = await runCommand(spec.command, spec.args, {
    cwd: spec.cwd,
    timeoutMs: UPDATE_TIMEOUT_MS,
    timeoutMessage: `${status.bin} update timed out after ${UPDATE_TIMEOUT_MS / 60_000} minutes`,
    exitLabel: spec.exitLabel,
    missingHint: spec.missingHint,
  });
  // Re-read the version and drop the cached registry answer for this package:
  // the updater may have installed the very release we were comparing against.
  clearVersionCache(status.path || undefined);
  const key = updater.npm ? `npm:${updater.npm}` : updater.pypi ? `pypi:${updater.pypi}` : undefined;
  clearLatestCache(key);
  const installed = status.path
    ? (await readInstalled(status.path, status.bin, true)).version
    : null;
  return {
    ...status,
    installed: installed || status.installed,
    updateAvailable: !!(installed && status.latest && compareVersions(status.latest, installed) > 0),
    checkedAt: new Date().toISOString(),
    output,
    error: undefined,
  };
}

// ─── Install state (reload recovery) ─────────────────────────────────────────

let runningId: string | null = null;
let runningStartedAt: string | null = null;
let lastOutcome: HarnessUpdateOutcome | null = null;

export function harnessUpdateState(): HarnessUpdateState {
  return { running: runningId !== null, id: runningId, startedAt: runningStartedAt, last: lastOutcome };
}

/**
 * Update one harness and return its refreshed row. Rejects when another update
 * is already running (two `npm install -g`s must not race) or the updater fails.
 */
export async function updateHarness(id: string, opts: { force?: boolean } = {}): Promise<HarnessUpdateStatus> {
  if (runningId) throw new Error(`${runningId === "all" ? "an update" : runningId} is already running`);
  // Reserve the slot before the first await: two Settings pages (or a double
  // click) must not both get past the guard and run their updaters at once.
  runningId = id;
  runningStartedAt = new Date().toISOString();
  try {
    const statuses = await checkHarnessUpdates({ force: !!opts.force });
    const status = statuses.find((s) => s.id === id);
    if (!status) throw new Error(`unknown or not installed harness: ${id}`);
    if (!status.updatable) throw new Error(status.reason || `${status.label} cannot be updated from here`);
    const updated = await runHarnessUpdate(status);
    lastOutcome = {
      at: new Date().toISOString(),
      id,
      ok: true,
      installed: updated.installed || "",
      error: "",
      output: updated.output,
    };
    return updated;
  } catch (err: any) {
    const message = String(err?.message ?? err);
    lastOutcome = { at: new Date().toISOString(), id, ok: false, installed: "", error: message };
    throw err;
  } finally {
    runningId = null;
    runningStartedAt = null;
  }
}

/**
 * Update every harness that has an update (or no way to tell). Runs the
 * updaters one after another — package managers contend for the same global
 * prefix — and reports each failure instead of aborting the rest.
 */
export async function updateAllHarnesses(): Promise<{
  harnesses: HarnessUpdateStatus[];
  results: Array<{ id: string; label: string; ok: boolean; error?: string }>;
}> {
  if (runningId) throw new Error(`${runningId === "all" ? "an update" : runningId} is already running`);
  // Reserve before the check (see updateHarness): a second Update all must not
  // slip in while the first is still reading versions.
  runningId = "all";
  runningStartedAt = new Date().toISOString();
  try {
    const statuses = await checkHarnessUpdates();
    const targets = statuses.filter((s) => s.updatable && (s.updateAvailable || !s.latest));
    if (!targets.length) return { harnesses: statuses, results: [] };
    const results: Array<{ id: string; label: string; ok: boolean; error?: string }> = [];
    let okCount = 0;
    const byId = new Map(statuses.map((s) => [s.id, s]));
    for (const target of targets) {
      try {
        const updated = await runHarnessUpdate(target);
        byId.set(target.id, updated);
        results.push({ id: target.id, label: target.label, ok: true });
        okCount++;
      } catch (err: any) {
        results.push({ id: target.id, label: target.label, ok: false, error: String(err?.message ?? err) });
      }
    }
    lastOutcome = {
      at: new Date().toISOString(),
      id: "all",
      ok: okCount === targets.length,
      installed: `${okCount}/${targets.length}`,
      error: results.filter((r) => !r.ok).map((r) => `${r.label}: ${r.error}`).join("\n"),
    };
    return { harnesses: [...byId.values()], results };
  } finally {
    runningId = null;
    runningStartedAt = null;
  }
}
