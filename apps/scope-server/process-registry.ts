/**
 * process-registry.ts — every agent process this server starts, by pid.
 *
 * The server is the parent of the coding agents Pi Scope runs: the bundled
 * `pi --mode rpc` behind a Chat conversation, an external harness CLI
 * (`claude -p`, `codex exec`, `gemini -p`, …), an ACP session, a Workflow node,
 * a model/command discovery child. Most of those start children of their own
 * (a shell tool, an MCP server, Gemini's node wrapper), so a pid alone is not
 * enough to stop one cleanly — the whole tree has to go.
 *
 * This registry is the one place that knows what the server opened. Every spawn
 * site registers a child the moment it exists; shutdown walks the registry,
 * asks each process to stop (SIGTERM on POSIX, `taskkill /T` without `/F` on
 * Windows), gives it a short grace period, and only then forces it.
 * Entries remove themselves when their child exits, so a conversation that
 * finished normally leaves no stale pid behind.
 *
 * On POSIX the agents are spawned detached (their own process group) wherever
 * possible. Signalling `-pid` then reaches the CLI *and* everything it started,
 * which is what stops a harness from leaving its tools behind when the app is
 * closed. A process registered without a group still gets its descendants
 * collected and signalled individually.
 *
 * Nothing here is persisted: a pid is meaningful only on the machine that
 * issued it, and a stale pid file can name an unrelated process after a reboot.
 * The server normally outlives the agents it started, so this in-memory ledger
 * is enough; if the server is killed with a signal it cannot catch, no
 * in-process cleanup can run — which is why the launchers ask it to stop and
 * `watchLauncher()` covers the launcher dying first.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import type { ChildProcess } from "node:child_process";
import { isWindows } from "../../shared/shell.ts";

/** What the process is doing — for logs and tests, never for signalling. */
export type TrackedProcessKind = "pi" | "harness" | "acp" | "workflow" | "command" | "discovery";

export interface TrackedProcessInfo {
  /** Registry-local id (stable until the child exits). */
  id: string;
  pid: number;
  kind: TrackedProcessKind;
  /** Short human label: the harness id, the chat session, the workflow node. */
  label: string;
  /** Epoch ms the child was registered. */
  startedAt: number;
  /** True when the child is its own POSIX process-group leader. */
  group: boolean;
}

export interface TrackProcessOptions {
  kind: TrackedProcessKind;
  label?: string;
  /** Set when the child was spawned with `detached` on POSIX (see above). */
  group?: boolean;
}

export interface TrackedProcessHandle extends TrackedProcessInfo {
  /** Stop tracking now, without signalling the process. */
  release(): void;
}

interface Entry extends TrackedProcessInfo {
  /** Set while stopTrackedProcesses is working on it, so a second call is a no-op. */
  stopping?: boolean;
}

const entries = new Map<string, Entry>();
let nextId = 1;
/** How long a graceful signal gets before SIGKILL/taskkill /F follows. */
const DEFAULT_GRACE_MS = 2_500;
/** How long to wait for SIGKILL to take effect before moving on. */
const FORCE_WAIT_MS = 1_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether a pid (or, with `group`, its process group) exists. A process owned
 * by another user answers EPERM and is still alive.
 */
export function isProcessAlive(pid: number, group = false): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(group && !isWindows() ? -pid : pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

/**
 * Remember a child the server just started. The entry disappears on its own
 * when the process exits or fails to spawn; the returned `release` is for code
 * that hands the child to another owner (or discards it without waiting).
 */
export function trackProcess(
  child: ChildProcess | null | undefined,
  opts: TrackProcessOptions,
): TrackedProcessHandle | null {
  const pid = Number(child?.pid);
  if (!child || !Number.isInteger(pid) || pid <= 0) return null;
  const id = `${pid}:${nextId++}`;
  const entry: Entry = {
    id,
    pid,
    kind: opts.kind,
    label: opts.label || opts.kind,
    startedAt: Date.now(),
    group: !!opts.group,
  };
  entries.set(id, entry);
  const release = () => { entries.delete(id); };
  // `exit` fires for a normal end and for a signal; `error` covers a spawn
  // that failed before a pid was usable. Both are one-shot.
  child.once("exit", release);
  child.once("error", release);
  return { ...entry, release };
}

/** Stop tracking one child without signalling it. */
export function releaseTrackedProcess(id: string): void {
  entries.delete(id);
}

/** A snapshot of the live entries, oldest first. */
export function trackedProcesses(): TrackedProcessInfo[] {
  return [...entries.values()]
    .filter((entry) => !entry.stopping)
    .sort((a, b) => a.startedAt - b.startedAt)
    .map(({ stopping: _stopping, ...entry }) => ({ ...entry }));
}

/** For tests: forget every entry without touching any process. */
export function clearTrackedProcesses(): void {
  entries.clear();
}

// ─── Stopping ───────────────────────────────────────────────────────────────

/**
 * Direct children of `pid` (best effort). Linux reads /proc; macOS asks
 * pgrep. A platform that cannot answer returns [] and the caller falls back to
 * signalling the pid itself.
 */
function childPids(pid: number): number[] {
  const out: number[] = [];
  if (process.platform === "linux") {
    let names: string[];
    try { names = fs.readdirSync("/proc"); } catch { return out; }
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
        // `pid (comm) state ppid …`: comm may contain spaces/parens, so parse
        // after the LAST ')'. Field 0 is state, field 1 is ppid.
        const close = stat.lastIndexOf(")");
        if (close < 0) continue;
        if (Number(stat.slice(close + 2).split(" ")[1]) === pid) out.push(Number(name));
      } catch { /* raced away */ }
    }
    return out;
  }
  if (process.platform === "darwin") {
    try {
      const raw = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8", timeout: 2_000 });
      for (const line of raw.split("\n")) {
        const n = Number(line.trim());
        if (Number.isInteger(n) && n > 0) out.push(n);
      }
    } catch { /* pgrep has no match */ }
  }
  return out;
}

/** Every descendant of `pid`, parents before children (bounded). */
function processTree(pid: number, max = 256): number[] {
  const out: number[] = [];
  const queue = [pid];
  const seen = new Set<number>([pid]);
  while (queue.length && out.length < max) {
    const current = queue.shift()!;
    for (const child of childPids(current)) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
      if (out.length >= max) break;
    }
  }
  return out;
}

function signalPid(pid: number, signal: NodeJS.Signals, group: boolean): void {
  try {
    // A detached child is a group leader: the negative pid reaches it and
    // everything it started. A non-leader simply answers ESRCH, so the direct
    // pid below is still tried.
    if (group && !isWindows()) process.kill(-pid, signal);
    else process.kill(pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
}

function signalEntry(entry: Entry, signal: NodeJS.Signals): void {
  if (entry.group && !isWindows()) {
    signalPid(entry.pid, signal, true);
    return;
  }
  // No group: take the current tree, deepest first, then the root. Children
  // are signalled first so a parent cannot respawn them while we work.
  const tree = processTree(entry.pid);
  for (const pid of tree.reverse()) {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
  signalPid(entry.pid, signal, false);
}

function taskkill(pid: number, force: boolean): void {
  try {
    execFileSync("taskkill", ["/pid", String(pid), "/T", ...(force ? ["/F"] : [])], {
      stdio: "ignore",
      timeout: 5_000,
    });
  } catch { /* already gone, or no permission */ }
}

async function waitForGone(list: Entry[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (list.every((entry) => !isProcessAlive(entry.pid, entry.group))) return;
    await sleep(50);
  }
}

/**
 * Stop every process the server started: graceful signal → short grace period
 * → force. Resolves with what was asked to stop. New registrations after the
 * snapshot are stopped by the next call; during shutdown there are none.
 *
 * This is awaited by `gracefulShutdown()` before the HTTP server closes, which
 * is what makes closing the Pi Scope app close the harnesses it opened instead
 * of leaving them orphaned.
 */
export async function stopTrackedProcesses(opts: { graceMs?: number } = {}): Promise<TrackedProcessInfo[]> {
  const all = [...entries.values()];
  if (!all.length) return [];
  for (const entry of all) entry.stopping = true;

  const alive = all.filter((entry) => isProcessAlive(entry.pid, entry.group));
  if (isWindows()) {
    // Without /F taskkill asks a GUI process to close; a console harness that
    // ignores it is forced after the grace period below.
    for (const entry of alive) taskkill(entry.pid, false);
  } else {
    for (const entry of alive) signalEntry(entry, "SIGTERM");
  }

  // Windows' non-forced taskkill only asks a *windowed* process to close; a
  // console harness answers "can only be terminated forcefully". Give it a
  // short chance anyway, but do not make every app close wait out the full
  // POSIX grace period before the forced pass.
  const graceMs = isWindows() ? Math.min(opts.graceMs ?? DEFAULT_GRACE_MS, 500) : (opts.graceMs ?? DEFAULT_GRACE_MS);
  await waitForGone(alive, graceMs);

  const left = alive.filter((entry) => isProcessAlive(entry.pid, entry.group));
  if (left.length) {
    if (isWindows()) {
      for (const entry of left) taskkill(entry.pid, true);
    } else {
      for (const entry of left) signalEntry(entry, "SIGKILL");
    }
    await waitForGone(left, FORCE_WAIT_MS);
  }

  for (const entry of all) entries.delete(entry.id);
  return all.map(({ stopping: _stopping, ...entry }) => ({ ...entry }));
}

/**
 * Synchronous last-resort stop for `process.on("exit")`. The process is already
 * leaving, so nothing can be awaited and no grace period is meaningful: force,
 * or a harness that ignores SIGTERM becomes the orphan this registry exists to
 * prevent. The graceful path (`stopTrackedProcesses`) has normally run already.
 */
export function stopTrackedProcessesSync(): void {
  for (const entry of entries.values()) {
    entry.stopping = true;
    if (isWindows()) taskkill(entry.pid, true);
    else signalEntry(entry, "SIGKILL");
  }
  entries.clear();
}
