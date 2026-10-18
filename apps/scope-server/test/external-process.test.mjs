// Unit tests for external-process.ts — the pid bookkeeping behind stopping a pi
// the user started in their OWN terminal (Chat can only watch it otherwise).
//
// The kill path is exercised against a real child process: a node that just
// idles, registered with its actual pid and start time, must be signalled and
// exit; a pid whose recorded start time does not match the live process, or the
// Pi Scope server's own pid, must be refused untouched.
//
//   node --test apps/scope-server/test/external-process.test.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  noteExternalProcess,
  externalProcessFor,
  forgetExternalProcess,
  killExternalProcess,
  processStartedAt,
  findProcessBySessionFile,
  EXTERNAL_PROCESS_TTL_MS,
  PID_START_TOLERANCE_MS,
} from "../external-process.ts";

/** A node process that does nothing until it is signalled. */
function idleChild() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  return new Promise((resolve, reject) => {
    child.once("spawn", () => resolve(child));
    child.once("error", reject);
  });
}

/** Wait for a child to exit, or fail the test after `ms`. */
function exited(child, ms = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child did not exit")), ms);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

/** Best-effort cleanup so a failed assertion never leaks the child. */
function reap(child) {
  try { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); } catch { /* gone */ }
}

describe("the external-process map", () => {
  test("remembers the last pid per session and refreshes it", () => {
    noteExternalProcess("s1", 1001, 5000, 1000);
    assert.deepEqual(externalProcessFor("s1", 1500), { pid: 1001, startedAt: 5000, seenAt: 1000 });
    noteExternalProcess("s1", 1002, 6000, 2000);
    assert.equal(externalProcessFor("s1", 2000).pid, 1002, "a newer event wins");
  });

  test("ignores a missing or invalid pid", () => {
    noteExternalProcess("s2", undefined, Date.now(), 1000);
    noteExternalProcess("s2", "nope", Date.now(), 1000);
    noteExternalProcess("s2", -1, Date.now(), 1000);
    noteExternalProcess("", 1234, Date.now(), 1000);
    assert.equal(externalProcessFor("s2", 1000), null);
  });

  test("expires a mapping that has not refreshed within the TTL", () => {
    noteExternalProcess("s3", 1003, Date.now(), 1000);
    assert.ok(externalProcessFor("s3", 1000 + EXTERNAL_PROCESS_TTL_MS), "still valid at the edge");
    assert.equal(externalProcessFor("s3", 1001 + EXTERNAL_PROCESS_TTL_MS), null, "drops once stale");
    assert.equal(externalProcessFor("s3", 1002 + EXTERNAL_PROCESS_TTL_MS), null, "and stays dropped");
  });

  test("forget removes the mapping without signalling", () => {
    noteExternalProcess("s4", 1004, Date.now(), 1000);
    forgetExternalProcess("s4");
    assert.equal(externalProcessFor("s4", 1000), null);
  });
});

describe("processStartedAt", () => {
  test("reports this process's own start on Linux/macOS", { skip: process.platform === "win32" ? "no process start query on Windows" : false }, () => {
    const expected = Date.now() - process.uptime() * 1000;
    const actual = processStartedAt(process.pid);
    assert.ok(actual > 0, "the platform could report a start time");
    assert.ok(
      Math.abs(actual - expected) <= PID_START_TOLERANCE_MS,
      `start time ${actual} is within tolerance of ${Math.round(expected)}`,
    );
  });

  test("returns 0 for a pid that does not exist", () => {
    assert.equal(processStartedAt(2 ** 30 - 1), 0);
  });
});

describe("killExternalProcess", () => {
  test("refuses a session with no known pid", () => {
    const r = killExternalProcess("nobody");
    assert.equal(r.ok, false);
    assert.match(r.reason, /no terminal process/);
  });

  test("refuses to kill the Pi Scope server itself", () => {
    noteExternalProcess("self", process.pid, 0, Date.now());
    const r = killExternalProcess("self");
    assert.equal(r.ok, false);
    assert.equal(r.pid, process.pid);
    assert.match(r.reason, /Pi Scope server/);
    assert.equal(externalProcessFor("self"), null, "a refusal still consumes the mapping");
  });

  test("refuses a pid that has already exited", async () => {
    const child = await idleChild();
    try {
      const pid = child.pid;
      child.kill("SIGKILL");
      await exited(child);
      noteExternalProcess("dead", pid, 0, Date.now());
      const r = killExternalProcess("dead");
      assert.equal(r.ok, false);
      assert.match(r.reason, /already exited/);
    } finally {
      reap(child);
    }
  });

  test("signals the tracked process when its start time matches", async () => {
    const child = await idleChild();
    try {
      const pid = child.pid;
      // The event's own stamp would be `Date.now() - uptime` in the child; any
      // value within the tolerance window stands in for it.
      noteExternalProcess("live", pid, Date.now(), Date.now());
      const r = killExternalProcess("live");
      assert.equal(r.ok, true, r.reason);
      assert.equal(r.pid, pid);
      await exited(child);
      assert.equal(externalProcessFor("live"), null, "the mapping is one-shot");
    } finally {
      reap(child);
    }
  });

  test("refuses a recycled pid whose start time does not match", async () => {
    const child = await idleChild();
    try {
      const pid = child.pid;
      noteExternalProcess("recycled", pid, 1, Date.now()); // 1970 — nothing live matches
      const r = killExternalProcess("recycled");
      assert.equal(r.ok, false);
      assert.match(r.reason, /another process/);
      assert.equal(child.exitCode, null, "the unrelated process was left alone");
    } finally {
      reap(child);
    }
  });
});

describe("finding a pi by the session file it holds", () => {
  /** A node process holding `file` open and naming itself `pi` on the command
   *  line — the shape the lookup requires. */
  function holderChild(file) {
    const code = `const fs = require("node:fs"); fs.openSync(${JSON.stringify(file)}, "a"); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ["-e", code, "pi"], { stdio: "ignore" });
    return new Promise((resolve, reject) => {
      child.once("spawn", () => resolve(child));
      child.once("error", reject);
    });
  }

  test("returns null for an empty path", () => {
    assert.equal(findProcessBySessionFile(""), null);
    assert.equal(findProcessBySessionFile(null), null);
  });

  test("returns null when no process holds the file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-ext-none-"));
    try {
      assert.equal(findProcessBySessionFile(path.join(dir, "nobody.jsonl")), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("finds the process holding the file open", { skip: process.platform === "win32" ? "no fd scan on Windows" : false }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-ext-holder-"));
    const file = path.join(dir, "session.jsonl");
    fs.writeFileSync(file, "");
    const child = await holderChild(file);
    try {
      // The child opens the file a moment after spawn (and the lookup caches a
      // miss for a few seconds), so give it a beat before asking.
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(findProcessBySessionFile(file), child.pid);
    } finally {
      reap(child);
      await exited(child);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
