// Unit tests for process-registry.ts — the pid ledger behind graceful app exit.
//
// The registry is exercised against real children: a tracked child must be
// signalled and exit, a child that ignores SIGTERM must be forced after the
// grace period, and a detached child's own child (a harness's tool process)
// must go down with it when the group is signalled.
//
//   node --test apps/scope-server/test/process-registry.test.mjs

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  trackProcess,
  trackedProcesses,
  releaseTrackedProcess,
  clearTrackedProcesses,
  stopTrackedProcesses,
  isProcessAlive,
} from "../process-registry.ts";

const POSIX = process.platform !== "win32";
const spawned = new Set();

function spawnNode(code, { detached = POSIX } = {}) {
  const child = spawn(process.execPath, ["-e", code], { stdio: "ignore", detached });
  spawned.add(child);
  return new Promise((resolve, reject) => {
    child.once("spawn", () => resolve(child));
    child.once("error", reject);
  });
}

function exited(child, ms = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child did not exit")), ms);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

async function reap(pid) {
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

afterEach(() => {
  for (const child of spawned) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    // Detached children lead their own group; take that down so a failing test
    // never leaves a grandchild behind.
    if (POSIX) {
      try { process.kill(-child.pid, "SIGKILL"); continue; } catch { /* not a leader */ }
    }
    try { child.kill("SIGKILL"); } catch { /* gone */ }
  }
  spawned.clear();
  clearTrackedProcesses();
});

describe("the process registry", () => {
  test("tracks a child by pid and forgets it when the child exits", async () => {
    const child = await spawnNode("setTimeout(() => {}, 50)");
    const handle = trackProcess(child, { kind: "harness", label: "claude s1", group: POSIX });
    assert.ok(handle);
    assert.equal(handle.pid, child.pid);
    assert.equal(handle.kind, "harness");
    assert.equal(handle.label, "claude s1");
    assert.deepEqual(trackedProcesses().map((p) => p.pid), [child.pid]);

    await exited(child);
    assert.deepEqual(trackedProcesses(), [], "the exit listener removed the entry");
  });

  test("release stops tracking without signalling", async () => {
    const child = await spawnNode("setInterval(() => {}, 1000)");
    const handle = trackProcess(child, { kind: "pi", label: "pi s2", group: POSIX });
    releaseTrackedProcess(handle.id);
    assert.deepEqual(trackedProcesses(), []);
    assert.equal(isProcessAlive(child.pid), true, "the child is untouched");
  });

  test("stops a tracked child gracefully", async () => {
    const child = await spawnNode("setInterval(() => {}, 1000)");
    trackProcess(child, { kind: "harness", label: "codex s3", group: POSIX });

    const stopped = await stopTrackedProcesses({ graceMs: 2_000 });
    assert.equal(stopped.length, 1);
    assert.equal(stopped[0].pid, child.pid);
    await exited(child);
    assert.equal(isProcessAlive(child.pid), false);
    assert.deepEqual(trackedProcesses(), []);
  });

  test("forces a child that ignores SIGTERM after the grace period", async () => {
    const child = await spawnNode("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)");
    trackProcess(child, { kind: "harness", label: "stubborn s4", group: POSIX });

    const started = Date.now();
    await stopTrackedProcesses({ graceMs: 150 });
    await exited(child);
    assert.equal(isProcessAlive(child.pid), false);
    assert.ok(Date.now() - started < 5_000, "it was killed, not waited on forever");
  });

  test("a detached harness's own child goes down with it", { skip: POSIX ? false : "POSIX process groups only" }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-registry-"));
    const pidFile = path.join(dir, "grandchild.pid");
    const code = `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      setInterval(() => {}, 1000);
    `;
    const parent = await spawnNode(code);
    trackProcess(parent, { kind: "harness", label: "grouped", group: true });

    const deadline = Date.now() + 5_000;
    let grandchild = 0;
    while (!grandchild && Date.now() < deadline) {
      try { grandchild = Number(fs.readFileSync(pidFile, "utf8")); } catch { /* not written yet */ }
      if (!grandchild) await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(grandchild > 0, "the child wrote its pid");
    assert.equal(isProcessAlive(grandchild), true);

    await stopTrackedProcesses({ graceMs: 2_000 });
    await exited(parent);
    assert.equal(isProcessAlive(parent.pid), false);
    assert.equal(isProcessAlive(grandchild), false, "the whole process group was stopped");
  });
});

describe("stopTrackedProcesses", () => {
  test("returns [] when nothing is tracked", async () => {
    assert.deepEqual(await stopTrackedProcesses(), []);
  });

  test("stops several tracked children in one pass", async () => {
    const one = await spawnNode("setInterval(() => {}, 1000)");
    const two = await spawnNode("setInterval(() => {}, 1000)");
    trackProcess(one, { kind: "pi", label: "one", group: POSIX });
    trackProcess(two, { kind: "acp", label: "two", group: POSIX });

    const stopped = await stopTrackedProcesses({ graceMs: 2_000 });
    assert.equal(stopped.length, 2);
    await Promise.all([exited(one), exited(two)]);
    assert.equal(isProcessAlive(one.pid), false);
    assert.equal(isProcessAlive(two.pid), false);
  });
});
