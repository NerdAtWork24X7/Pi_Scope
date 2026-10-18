// Unit tests for the session seed (session-seed.ts): the bounded transcript of a
// recorded conversation that a fresh pi session is handed when the session's own
// pi file is gone.
//
// The block is built against an in-memory scope DB (the real schema and the real
// prepared queries), and the client half — the strip that keeps the seeded text
// out of the user's own bubble — is exercised on the very block it produces, so
// the two marker strings cannot drift apart.
//
//   node --test apps/scope-server/test/session-seed.test.mjs

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import { fileURLToPath } from "node:url";

import { createDb, prepare, toRow, toSessionRow } from "../db.ts";
import { buildSessionSeed, SEED_HEAD, SEED_TAIL, SEED_MAX_CHARS, SEED_TEXT_MAX } from "../session-seed.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** helpers.js is a browser IIFE that hangs its exports on window.SCOPE, so it is
 *  evaluated in a bare VM context with a stub window/document (same harness as
 *  helpers.test.mjs). */
function loadScope() {
  const SRC = fs.readFileSync(path.join(HERE, "..", "public", "helpers.js"), "utf8");
  const sandbox = { console, document: { body: { hasAttribute: () => false } } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  new vm.Script(SRC, { filename: "helpers.js" }).runInContext(sandbox);
  return sandbox.window.SCOPE;
}
const SCOPE = loadScope();

let db;
let q;

/** Record one event exactly the way the server's ingest does. */
let seq = 0;
function record(e) {
  const ev = {
    event_id: `e${++seq}`,
    session_id: e.session_id,
    seq: seq,
    ts: new Date(1700000000000 + seq * 1000).toISOString(),
    type: e.type,
    cwd: e.cwd ?? "/ws",
    pool: "default",
    tags: [],
    payload: e.payload ?? {},
    session_file: e.session_file,
  };
  q.insertEvent.run(toRow(ev));
  q.upsertSession.run(toSessionRow(ev, true));
  return ev;
}

before(() => {
  db = createDb(":memory:");
  q = prepare(db);
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
});

describe("the seeded transcript block", () => {
  test("reads as a continuation of the work, oldest first, and is delimited", () => {
    const sid = "seed-basic";
    const file = "/ws/.pi/agent-team-log/agent-sessions/subagent-1.json";
    record({ session_id: sid, session_file: file, type: "session_start", payload: { reason: "start" } });
    record({ session_id: sid, session_file: file, type: "user_message", payload: { text: "chart the revenue by quarter" } });
    record({ session_id: sid, session_file: file, type: "assistant_message", payload: { text: "Reading the spreadsheet.", thinking: "private reasoning", tool_call_ids: ["c1"] } });
    record({ session_id: sid, session_file: file, type: "tool_call", payload: { tool_call_id: "c1", tool_name: "read", args: { path: "revenue.csv" } } });
    record({ session_id: sid, session_file: file, type: "tool_result", payload: { tool_call_id: "c1", tool_name: "read", content_text: "quarter,total\nQ1,10" } });
    record({ session_id: sid, session_file: file, type: "llm_request", payload: { system_prompt: "x".repeat(9000) } });
    record({ session_id: sid, session_file: file, type: "assistant_message", payload: { text: "Chart written to tmp/chart.png." } });

    const block = buildSessionSeed(q, { sessionFile: file, sessionId: "not-a-row", reason: "its pi session file is gone" });

    assert.ok(block.startsWith(SEED_HEAD), "the block opens with the marker");
    assert.match(block, /its pi session file is gone/, "it names why the file could not be resumed");
    assert.ok(block.endsWith(SEED_TAIL), "and closes with the end marker");

    // Chronological: the opening question sits before the final answer.
    const asked = block.indexOf("chart the revenue by quarter");
    const answered = block.indexOf("Chart written to tmp/chart.png.");
    assert.ok(asked > 0 && answered > asked, `the transcript is oldest-first (${asked} < ${answered})`);
    assert.match(block, /### user/, "turns are labelled");
    assert.match(block, /### assistant/);
    assert.match(block, /→ read \{"path":"revenue\.csv"\}/, "a tool call is summarised with its arguments");
    assert.match(block, /← read: quarter,total/, "and its result");
    assert.ok(!block.includes("private reasoning"), "thinking is left out (and the header says so)");
    assert.ok(!block.includes("x".repeat(200)), "system prompts are not part of the conversation");
    assert.deepEqual(block.split("\n").filter((l) => l.startsWith("### ")).length, 3, "only real turns are labelled");
  });

  test("an unknown session has nothing to hand over", () => {
    assert.equal(buildSessionSeed(q, { sessionId: "no-such-session" }), "");
    assert.equal(buildSessionSeed(q, { sessionFile: "/ws/never-recorded.json", sessionId: "no-such-session" }), "");
    assert.equal(buildSessionSeed(q, {}), "", "and neither has a call with no identity at all");
  });

  test("a session with no readable conversation yields no block", () => {
    const sid = "seed-quiet";
    record({ session_id: sid, session_file: "/ws/quiet.jsonl", type: "session_start", payload: {} });
    record({ session_id: sid, session_file: "/ws/quiet.jsonl", type: "turn_start", payload: { turn_index: 0 } });
    assert.equal(buildSessionSeed(q, { sessionId: sid }), "");
  });

  test("a provider failure the turn died on is carried over", () => {
    const sid = "seed-error";
    record({ session_id: sid, type: "user_message", payload: { text: "do the thing" } });
    record({ session_id: sid, type: "assistant_message", payload: { text: "", error_message: "Error: model overloaded" } });
    const block = buildSessionSeed(q, { sessionId: sid });
    assert.match(block, /\(failed: Error: model overloaded\)/, "the failure is part of the memory");
  });

  test("the file owner outranks the caller's session id", () => {
    // A chat subprocess key is not a session row: the conversation is whatever
    // owns the file being continued (one file == one conversation).
    const file = "/ws/shared.jsonl";
    record({ session_id: "row-owner", session_file: file, type: "user_message", payload: { text: "the real conversation" } });
    record({ session_id: "another-row", type: "user_message", payload: { text: "a different one" } });
    const block = buildSessionSeed(q, { sessionFile: file, sessionId: "another-row" });
    assert.match(block, /the real conversation/);
    assert.ok(!block.includes("a different one"), "the id only decides when no row owns the file");
  });
});

describe("the seed stays bounded", () => {
  test("one long message cannot take the whole block", () => {
    const sid = "seed-huge-message";
    record({ session_id: sid, type: "user_message", payload: { text: "a".repeat(50_000) } });
    record({ session_id: sid, type: "assistant_message", payload: { text: "noted" } });
    const block = buildSessionSeed(q, { sessionId: sid });
    assert.ok(block.includes("…(truncated)"), "the long message is clamped");
    assert.match(block, /noted/, "and the rest of the turn still comes through");
    assert.ok(block.length < 50_000, "the block is far smaller than the text it summarised");
  });

  test("a long conversation keeps its newest events and says what it dropped", () => {
    const sid = "seed-long";
    for (let i = 0; i < 60; i++) {
      record({ session_id: sid, type: "user_message", payload: { text: `question ${i} ${"x".repeat(1_200)}` } });
      record({ session_id: sid, type: "assistant_message", payload: { text: `answer ${i} ${"y".repeat(1_200)}` } });
    }
    const block = buildSessionSeed(q, { sessionId: sid });
    assert.ok(block.includes("Earlier parts of this conversation are omitted"), "the reader is told the head is missing");
    assert.match(block, /question 59/, "the newest turn is there");
    assert.ok(!/question 0 /.test(block), "the oldest is not");
    assert.ok(block.length <= SEED_MAX_CHARS + 400, `the block respects its budget (${block.length} chars)`);
  });

  test("a mid-sized conversation is carried whole", () => {
    const sid = "seed-snug";
    record({ session_id: sid, type: "user_message", payload: { text: "u".repeat(SEED_TEXT_MAX) } });
    record({ session_id: sid, type: "assistant_message", payload: { text: "the answer" } });
    const block = buildSessionSeed(q, { sessionId: sid });
    assert.ok(!block.includes("Earlier parts"), "nothing was dropped");
    assert.ok(!block.includes("…(truncated)"), "and nothing was clamped");
  });
});

describe("the client shows the user's own message, not the seeded context", () => {
  test("the strip removes exactly the block the server builds", () => {
    const sid = "seed-round-trip";
    record({ session_id: sid, type: "user_message", payload: { text: "what is in this chart" } });
    record({ session_id: sid, type: "assistant_message", payload: { text: "a bar series" } });
    const block = buildSessionSeed(q, { sessionId: sid, reason: "its pi session file is gone (/tmp/x.json)" });
    const typed = "continue";
    const recorded = `${block}\n\n${typed}`;

    assert.equal(SCOPE.stripSessionSeed(recorded), typed, "the user's own text survives, alone");
  });

  test("anything without the markers is left exactly as recorded", () => {
    assert.equal(SCOPE.stripSessionSeed("just a message"), "just a message");
    assert.equal(SCOPE.stripSessionSeed(""), "");
    assert.equal(SCOPE.stripSessionSeed(null), "");
    // A truncated record (the tail never made it into the snapshot) is shown as
    // it was stored rather than silently reduced to an empty bubble.
    const cut = `${SEED_HEAD} — gone (/tmp/x.json)]\n### user\nhello`;
    assert.equal(SCOPE.stripSessionSeed(cut), cut);
  });
});
