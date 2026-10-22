// External-harness turn recording: Chat turns a harness run into the same
// observation events a pi session records, so the conversation appears in the
// workspace rail (GET /sessions) and can be replayed later.
//
//   node --test apps/scope-server/test/harness-record.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { harnessStartEvents, harnessEndEvents } from "../harness-record.ts";
import { createDb, prepare, toRow, toSessionRow, rowToSession } from "../db.ts";
import { startChat, setHarnessRecorder, killChatSession } from "../chat.ts";

const cleanups = [];
after(() => {
  setHarnessRecorder(null);
  for (const fn of cleanups) {
    try { fn(); } catch { /* already gone */ }
  }
});

/** A seq allocator seeded the way the server seeds it from getMaxSeq. */
function counter(start = -1) {
  let seq = start;
  return () => { seq += 1; return seq; };
}

test("a harness turn becomes a recorded session with harness attribution", () => {
  const at = Date.parse("2026-10-22T10:00:00.000Z");
  const next = counter();
  const events = [
    ...harnessStartEvents({
      sessionId: "harness-session-1",
      cwd: "/work/project",
      harness: "claude",
      model: "sonnet",
      prompt: "rename the widget",
      at,
    }, next),
    ...harnessEndEvents({
      sessionId: "harness-session-1",
      cwd: "/work/project",
      harness: "claude",
      model: "sonnet",
      text: "Renamed it.",
      thinking: "find the symbol first",
      tools: [{ name: "Read", args: '{"file":"widget.ts"}' }],
      outcome: "done",
      at: at + 1000,
    }, next),
  ];

  assert.deepEqual(events.map((e) => e.type), [
    "turn_start", "user_message", "tool_call", "assistant_message", "turn_end",
  ]);
  assert.deepEqual(events.map((e) => e.seq), [0, 1, 2, 3, 4], "one shared growing seq");
  assert.equal(events[0].session_id, "harness-session-1");
  assert.equal(events[0].cwd, "/work/project");
  assert.equal(events[0].agent_name, "claude");
  assert.deepEqual(events[0].tags, ["harness:claude"]);
  assert.equal(events[1].payload.text, "rename the widget", "the prompt the user typed, for rail adoption");
  assert.equal(events[3].payload.harness, "claude", "the reply names its harness");
  assert.equal(events[3].payload.text, "Renamed it.");
  assert.equal(events[3].payload.thinking, "find the symbol first");
  assert.equal(events[3].payload.model, "sonnet");
  assert.equal(events[4].payload.reason, "done");
});

test("an aborted turn keeps the partial reply and an error turn keeps its message", () => {
  const at = Date.parse("2026-10-22T10:00:00.000Z");
  const base = { sessionId: "s", cwd: "/w", harness: "codex", model: "gpt-5", at };
  const aborted = harnessEndEvents({ ...base, text: "half an ans", outcome: "aborted" }, counter(5));
  assert.equal(aborted.find((e) => e.type === "assistant_message").payload.text, "half an ans");
  assert.equal(aborted.find((e) => e.type === "assistant_message").payload.stop_reason, "cancelled");

  const silent = harnessEndEvents({ ...base, text: "", outcome: "aborted" }, counter(7));
  assert.deepEqual(silent.map((e) => e.type), ["turn_end"], "stopping before any output leaves no blank bubble");

  const failed = harnessEndEvents({ ...base, text: "", outcome: "error", error: "login required" }, counter(9));
  const message = failed.find((e) => e.type === "assistant_message");
  assert.equal(message.payload.error_message, "login required");
  assert.equal(message.payload.stop_reason, "error");
});

test("recording events makes the session visible in the rail's session list", () => {
  const db = createDb(":memory:");
  const q = prepare(db);
  const at = Date.now();
  const next = counter();
  const events = [
    ...harnessStartEvents({
      sessionId: "harness-session-2",
      cwd: "/work/rail",
      harness: "claude",
      model: "sonnet",
      prompt: "show up in the workspace rail",
      at,
    }, next),
    ...harnessEndEvents({
      sessionId: "harness-session-2",
      cwd: "/work/rail",
      harness: "claude",
      model: "sonnet",
      text: "I am here.",
      outcome: "done",
      at: at + 500,
    }, next),
  ];
  for (const event of events) {
    q.insertEvent.run(toRow(event));
    q.upsertSession.run(toSessionRow(event, true));
  }

  const rows = q.listSessions.all({ $pool: "", $tag: "", $limit: 50 }).map(rowToSession);
  const row = rows.find((s) => s.session_id === "harness-session-2");
  assert.ok(row, "the harness conversation is listed next to pi sessions");
  assert.equal(row.cwd, "/work/rail");
  assert.equal(row.agent_name, "claude");
  assert.equal(row.model, "sonnet");
  assert.equal(row.first_msg, "show up in the workspace rail");
  assert.deepEqual(row.tags, ["harness:claude"]);
  assert.equal(row.last_turn_event, "turn_end", "the turn is finished, not left running");
  db.close();
});

test("Chat reports a harness run's start and end to the recorder", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-harness-record-"));
  const bin = path.join(dir, "claude");
  fs.writeFileSync(bin, "#!/bin/sh\nprintf 'recorded answer'\n", { mode: 0o755 });
  const before = process.env.SCOPE_HARNESS_BIN_CLAUDE;
  process.env.SCOPE_HARNESS_BIN_CLAUDE = bin;
  cleanups.push(() => {
    if (before === undefined) delete process.env.SCOPE_HARNESS_BIN_CLAUDE;
    else process.env.SCOPE_HARNESS_BIN_CLAUDE = before;
  });

  const records = [];
  setHarnessRecorder((record) => records.push(record));
  const sid = `harness-record-${Date.now()}`;
  cleanups.push(() => killChatSession(sid));

  const response = startChat({ cwd: dir, harness: "claude", prompt: "say hello", sessionId: sid, model: "sonnet" });
  await drain(response);

  assert.equal(records.length, 2, "one start and one end record per turn");
  assert.equal(records[0].kind, "start");
  assert.equal(records[0].start.sessionId, sid);
  assert.equal(records[0].start.harness, "claude");
  assert.equal(records[0].start.prompt, "say hello");
  assert.equal(records[1].kind, "end");
  assert.equal(records[1].end.text, "recorded answer");
  assert.equal(records[1].end.outcome, "done");
  assert.equal(records[1].end.tools.length, 0);
});

/** Read an NDJSON response to the terminal `done` event. */
async function drain(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      if (JSON.parse(line).type === "done") return;
    }
    if (done) return;
  }
}
