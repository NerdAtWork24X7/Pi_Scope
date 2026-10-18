/**
 * external-process.ts — the process ids behind sessions that run in the user's
 * OWN terminal.
 *
 * Chat owns a pi subprocess per session (see chat.ts), so stopping one is a
 * message to a child process. A `pi` started in the user's terminal has no such
 * handle: Pi Scope only sees the events its extension posts. Those events carry
 * the writer's `process.pid` and start time (see createEventEnvelope in
 * extension/pi-scope.ts), which is what lets Chat offer Stop on that session at
 * all: the server remembers the last pid it saw per session and, when asked to
 * stop it, signals that pid — after checking the process it is about to kill is
 * still the one that posted the events.
 *
 * Kept in memory on purpose. A pid is only meaningful on the machine that
 * issued it, and a pid persisted across a server restart can be recycled by an
 * unrelated process; dropping the map with the process means the worst case is
 * "Stop is unavailable until pi posts again", never a stale kill.
 *
 * A pi started before this feature existed (or from a stale extension copy)
 * posts no pid. The session file it is writing is held open by that process, so
 * the server can still find it there — findProcessBySessionFile scans /proc
 * (Linux) or asks lsof (macOS), which is how an already-running terminal pi
 * stays stoppable without restarting it.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { isWindows } from "../../shared/shell.ts";

export interface ExternalProcess {
  pid: number;
  /** Approximate epoch ms the process started (0 when unknown). */
  startedAt: number;
  /** When an event from this process was last ingested. */
  seenAt: number;
}

/** How long a pid stays valid without a fresh event from it. A working agent
 *  posts constantly; a day of silence means the mapping is long dead. */
export const EXTERNAL_PROCESS_TTL_MS = 12 * 60 * 60 * 1000;
/** Clock slop between the process's own `Date.now() - uptime` and what a
 *  platform query returns for the same instant. */
export const PID_START_TOLERANCE_MS = 2_000;
/** How long a SIGTERM is given before SIGKILL follows on POSIX. */
const SIGKILL_GRACE_MS = 2_000;

const processes = new Map<string, ExternalProcess>();

/** Remember (or refresh) the pid behind a session. Ignores a missing or invalid
 *  pid so an older extension that does not stamp one simply never registers. */
export function noteExternalProcess(sessionId: string, pid: unknown, startedAt?: unknown, now = Date.now()): void {
  const n = Number(pid);
  if (!sessionId || !Number.isInteger(n) || n <= 0) return;
  const start = Number(startedAt);
  processes.set(sessionId, {
    pid: n,
    startedAt: Number.isFinite(start) && start > 0 ? start : 0,
    seenAt: now,
  });
}

/** The live-ish pid recorded for a session, or null when there is none (or it
 *  has gone stale). Expired entries are dropped as they are found. */
export function externalProcessFor(sessionId: string, now = Date.now()): ExternalProcess | null {
  const entry = processes.get(sessionId);
  if (!entry) return null;
  if (now - entry.seenAt > EXTERNAL_PROCESS_TTL_MS) {
    processes.delete(sessionId);
    return null;
  }
  return entry;
}

/** Drop a session's pid without signalling anything (session deleted, or the
 *  server's own chat subprocess took the session over). */
export function forgetExternalProcess(sessionId: string): void {
  processes.delete(sessionId);
}

// ─── Finding a pi by the session file it is writing ────────────────────────
// Used only when a live session has no pid: an extension too old to stamp one,
// or events that landed before this server run. The pi keeps its session .jsonl
// open for the whole conversation, so the holding process IS that pi.
const FILE_LOOKUP_TTL_MS = 15_000;
const fileLookups = new Map<string, { pid: number; at: number }>();

/** Does this process look like pi? A false positive here would mean signalling
 *  an unrelated process that happened to open the file, so the command line
 *  has to name pi (any install layout) before its pid is accepted. */
function looksLikePi(pid: number): boolean {
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    // \bpi\b matches `pi`, `.../pi/dist/cli.js`, `pi-coding-agent` and
    // `pi-scope`, but not `pip`, `python` or `spidermonkey`.
    return /\bpi\b/i.test(cmd) || /pi-coding-agent/i.test(cmd);
  } catch {
    return false;
  }
}

function findOnLinux(file: string): number | null {
  let real = path.resolve(file);
  try { real = fs.realpathSync(file); } catch { /* the file may not exist yet */ }
  let names: string[];
  try { names = fs.readdirSync("/proc"); } catch { return null; }
  for (const name of names) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    let fds: string[];
    try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    let holds = false;
    for (const fd of fds) {
      try {
        if (fs.readlinkSync(`/proc/${pid}/fd/${fd}`) === real) { holds = true; break; }
      } catch { /* fd raced away */ }
    }
    if (holds && looksLikePi(pid)) return pid;
  }
  return null;
}

function findOnMac(file: string): number | null {
  let out = "";
  try {
    out = execFileSync("lsof", ["-t", "-w", "--", file], { encoding: "utf8", timeout: 2500 });
  } catch {
    return null; // lsof missing, or the file is not open anywhere
  }
  for (const line of out.split("\n")) {
    const pid = Number(line.trim());
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    try {
      const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
      });
      if (/\bpi\b/i.test(cmd) || /pi-coding-agent/i.test(cmd)) return pid;
    } catch { /* process gone between lsof and ps */ }
  }
  return null;
}

/** The pid holding a pi session file open, or null when it cannot be found
 *  (Windows, a file no process holds, or a holder that is not pi). Results are
 *  cached briefly so the /sessions poll does not rescan /proc every few seconds. */
export function findProcessBySessionFile(
  sessionFile: string,
  opts: { platform?: NodeJS.Platform; now?: number } = {},
): number | null {
  const file = String(sessionFile || "").trim();
  if (!file) return null;
  const platform = opts.platform ?? process.platform;
  const now = opts.now ?? Date.now();
  const cached = fileLookups.get(file);
  if (cached && now - cached.at < FILE_LOOKUP_TTL_MS) return cached.pid || null;
  const pid = platform === "linux" ? findOnLinux(file) : platform === "darwin" ? findOnMac(file) : null;
  fileLookups.set(file, { pid: pid || 0, at: now });
  return pid;
}

/** Whether a pid names a process this user can signal. A process owned by
 *  another user answers EPERM and is still alive. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

/** The epoch ms a process started, or 0 when the platform cannot say. Linux
 *  reads /proc; macOS asks ps; Windows returns 0 and relies on the pid check
 *  alone (its taskkill path cannot reuse a running pid for an unrelated
 *  process any more than POSIX can in the seconds between check and kill). */
export function processStartedAt(pid: number, platform: NodeJS.Platform = process.platform): number {
  try {
    if (platform === "linux") {
      // /proc/<pid>/stat: `pid (comm) state …`. comm can contain spaces and
      // parens, so split after the LAST ')' — field 22 (starttime, in clock
      // ticks) is then index 19 of the remainder.
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      if (close < 0) return 0;
      const startTicks = Number(stat.slice(close + 2).split(" ")[19]);
      const boot = /^btime (\d+)$/m.exec(fs.readFileSync("/proc/stat", "utf8"));
      if (!Number.isFinite(startTicks) || !boot) return 0;
      // USER_HZ is 100 on every architecture Linux supports.
      return (Number(boot[1]) + startTicks / 100) * 1000;
    }
    if (platform === "darwin") {
      const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
      }).trim();
      const t = Date.parse(out);
      return Number.isFinite(t) ? t : 0;
    }
  } catch {
    // Process gone, no procfs, or ps unavailable — the caller decides what a
    // missing start time means (it only ever skips the reuse check).
  }
  return 0;
}

/** Signal the pi behind a session. Returns `ok:false` with a reason when there
 *  is nothing safe to kill (no pid, the pid belongs to Pi Scope itself, the
 *  process is gone, or the pid was recycled). On success SIGTERM goes out on
 *  POSIX and a SIGKILL follows if it is still alive after a short grace;
 *  Windows takes the whole tree down with taskkill /T. */
export function killExternalProcess(
  sessionId: string,
  opts: { platform?: NodeJS.Platform; now?: number } = {},
): { ok: boolean; pid?: number; reason?: string } {
  const platform = opts.platform ?? process.platform;
  const entry = externalProcessFor(sessionId, opts.now);
  if (!entry) return { ok: false, reason: "no terminal process is known for this session" };
  // Consume the mapping before signalling: a kill is one-shot, and a failure
  // must not leave a pid the UI would offer again.
  processes.delete(sessionId);

  const { pid } = entry;
  if (pid === process.pid) return { ok: false, pid, reason: "refusing to kill the Pi Scope server" };
  if (pid <= 1) return { ok: false, pid, reason: "invalid process id" };
  if (!isAlive(pid)) return { ok: false, pid, reason: "the pi process has already exited" };

  if (entry.startedAt > 0) {
    const actual = processStartedAt(pid, platform);
    if (actual > 0 && Math.abs(actual - entry.startedAt) > PID_START_TOLERANCE_MS) {
      return { ok: false, pid, reason: "the process id now belongs to another process" };
    }
  }

  try {
    if (isWindows(platform)) {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGTERM");
      const timer = setTimeout(() => {
        if (!isAlive(pid)) return;
        try { process.kill(pid, "SIGKILL"); } catch { /* raced us to the exit */ }
      }, SIGKILL_GRACE_MS);
      timer.unref?.();
    }
  } catch (err: any) {
    return { ok: false, pid, reason: err?.message || String(err) };
  }
  return { ok: true, pid };
}
