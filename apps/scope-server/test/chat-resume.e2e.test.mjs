// End-to-end tests for continuing a recorded session in Chat: the prompt that
// carries a `sessionFile` may only leave the subprocess with the recorded
// conversation it claims to continue.
//
// The server runs for real against a temporary workspace; `SCOPE_PI_BIN` points
// at a stub "pi" that records every RPC line it receives on stdin, so the
// switch_session the resume would issue — and the prompt that follows — can be
// asserted exactly. No model, no network.
//
// Why this matters: pi's `switch_session` OPENS the given path and, when it is
// not there, silently starts a brand-new EMPTY session IN THAT FILE. A session
// whose pi file is gone (the agent-team harness deletes its subagent logs when a
// dispatch ends) therefore answered from no context while the Chat view still
// showed its transcript — and the app recreated a file another tool owns. The
// resume must be refused instead, with a reason the user can read.
//
//   node --test apps/scope-server/test/chat-resume.e2e.test.mjs

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { fileURLToPath } from "node:url";

import { resumeTargetProblem } from "../chat.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const SERVER = path.join(ROOT, "apps", "scope-server", "server.ts");
const TOKEN = "chat-resume-token";

let child;
let base;
let ws;
let agentDir;
let rpcLog;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not become healthy");
}

/** Every RPC line the stub pi has received, parsed. */
function rpcLines() {
  try {
    return fs.readFileSync(rpcLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
/** The RPC lines received since `from` — so one test never reads another's. */
const rpcSince = (from) => rpcLines().slice(from);
const switches = (lines) => lines.filter((l) => l.type === "switch_session");
const prompts = (lines) => lines.filter((l) => l.type === "prompt");

/** Drive one chat turn to completion and return its parsed NDJSON events. */
async function chat(body) {
  const res = await fetch(`${base}/chat`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ cwd: ws, prompt: "hello there", ...body }),
  });
  assert.equal(res.status, 200, `POST /chat → ${res.status}`);
  const text = await res.text();
  const events = text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  assert.ok(events.some((e) => e.type === "done"), "the turn settles");
  return events;
}

const warnings = (events) => events.filter((e) => e.type === "error").map((e) => e.message || "");

/** A pi session file: the session header line pi writes first, then an entry. */
function writeSessionFile(file, id = "sess-1") {
  fs.writeFileSync(file, [
    JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: ws }),
    JSON.stringify({ type: "message", id: "m1", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "earlier" }] } }),
    "",
  ].join("\n"));
}

before(async () => {
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-chat-resume-")));
  agentDir = path.join(ws, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  rpcLog = path.join(ws, "rpc.jsonl");

  // A stub pi: record every RPC line, answer commands, and settle each prompt so
  // the chat turn completes (and the session can take another prompt).
  const stub = path.join(ws, "stub-pi.mjs");
  fs.writeFileSync(stub, [
    'import * as fs from "node:fs";',
    'let buf = "";',
    'process.stdin.on("data", (chunk) => {',
    "  buf += chunk.toString();",
    "  let i;",
    '  while ((i = buf.indexOf("\\n")) >= 0) {',
    "    const line = buf.slice(0, i);",
    "    buf = buf.slice(i + 1);",
    "    if (!line.trim()) continue;",
    '    fs.appendFileSync(process.env.STUB_LOG, line + "\\n");',
    "    let ev = {};",
    '    try { ev = JSON.parse(line); } catch { continue; }',
    '    if (ev.type === "prompt") {',
    '      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");',
    "    } else {",
    '      process.stdout.write(JSON.stringify({ type: "response", command: ev.type, success: true }) + "\\n");',
    "    }",
    "  }",
    "});",
    "setInterval(() => {}, 60_000);",
    "",
  ].join("\n"));
  const bin = path.join(ws, "fake-pi");
  fs.writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(stub)}\n`);
  fs.chmodSync(bin, 0o755);

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      SCOPE_PORT: String(port),
      SCOPE_HOST: "127.0.0.1",
      SCOPE_DB_PATH: path.join(ws, "scope.db"),
      SCOPE_AUTH_TOKEN: TOKEN,
      SCOPE_PLUGINS_DIR: path.join(ws, "plugins"),
      // /chat only accepts a cwd inside the file root (or a known workspace).
      SCOPE_FILE_ROOT: ws,
      SCOPE_AGENT_DIR: agentDir,
      SCOPE_PI_BIN: bin,
      STUB_LOG: rpcLog,
      PI_OFFLINE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  await waitForHealth();
});

after(async () => {
  if (child) {
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
  }
  if (ws) fs.rmSync(ws, { recursive: true, force: true });
});

describe("resume target inspection", () => {
  test("a real pi session file is resumable", () => {
    const file = path.join(ws, "unit-ok.jsonl");
    writeSessionFile(file);
    assert.equal(resumeTargetProblem(file), "");
    // pi session files are recognised by their CONTENT, not their extension —
    // the agent-team harness names its logs `<agent>-<run>.json`.
    const dotted = path.join(ws, "unit-ok.json");
    writeSessionFile(dotted, "sess-json");
    assert.equal(resumeTargetProblem(dotted), "");
  });

  test("a missing, empty, directory or non-session path is refused with a reason", () => {
    const gone = path.join(ws, "unit-gone.jsonl");
    assert.match(resumeTargetProblem(gone), /pi session file is gone/);

    const empty = path.join(ws, "unit-empty.jsonl");
    fs.writeFileSync(empty, "");
    assert.match(resumeTargetProblem(empty), /pi session file is empty/);

    assert.match(resumeTargetProblem(ws), /is not a file/);

    const stray = path.join(ws, "unit-stray.json");
    fs.writeFileSync(stray, '{"level":"info","message":"not a pi session"}\n');
    assert.match(resumeTargetProblem(stray), /is not a pi session file/);
  });
});

describe("continuing a recorded session", () => {
  test("an existing session file is resumed exactly as before", async () => {
    const file = path.join(ws, "resumable.jsonl");
    writeSessionFile(file);
    const from = rpcLines().length;
    const events = await chat({ sessionId: "resume-ok", sessionFile: file });
    const lines = rpcSince(from);
    assert.deepEqual(switches(lines).map((l) => l.sessionPath), [file], "pi is pointed at the recorded file");
    assert.equal(prompts(lines).length, 1, "the prompt follows the switch");
    assert.deepEqual(warnings(events), [], "no warning is shown for a real resume");
  });

  test("a gone session file is not switched to, and is not created", async () => {
    const gone = path.join(ws, "agent-team-log", "image_analyzer-1.json");
    fs.mkdirSync(path.dirname(gone), { recursive: true });
    const from = rpcLines().length;
    const events = await chat({ sessionId: "resume-gone", sessionFile: gone });
    const lines = rpcSince(from);
    assert.deepEqual(switches(lines), [], "a missing target is never handed to pi");
    assert.deepEqual(lines.filter((l) => l.type === "new_session"), [], "and the conversation stays where it is");
    assert.equal(prompts(lines).length, 1, "the prompt is still sent");
    assert.equal(fs.existsSync(gone), false, "the path another tool owns is left alone");
    const said = warnings(events);
    assert.equal(said.length, 1, "the user is told once");
    assert.match(said[0], /cannot resume this session — its pi session file is gone/);
    assert.match(said[0], /starts a fresh conversation/);
  });

  test("an empty or non-session file is refused without being touched", async () => {
    const empty = path.join(ws, "empty.jsonl");
    fs.writeFileSync(empty, "");
    const stray = path.join(ws, "stray.json");
    const strayBody = '{"level":"info","message":"a log, not a session"}\n';
    fs.writeFileSync(stray, strayBody);

    for (const [sid, file, pattern] of [
      ["resume-empty", empty, /pi session file is empty/],
      ["resume-stray", stray, /is not a pi session file/],
    ]) {
      const from = rpcLines().length;
      const events = await chat({ sessionId: sid, sessionFile: file });
      assert.deepEqual(switches(rpcSince(from)), [], `${path.basename(file)}: no switch`);
      assert.match(warnings(events).join(" "), pattern);
    }
    assert.equal(fs.readFileSync(empty, "utf8"), "", "the empty file is left empty");
    assert.equal(fs.readFileSync(stray, "utf8"), strayBody, "the stray file is left untouched");
  });

  test("the recorded transcript is handed to the fresh conversation instead", async () => {
    // A session whose own pi file is gone (the agent-team harness deletes its
    // subagent logs when a dispatch ends) cannot be resumed by pi — but Pi Scope
    // still holds the conversation. Continuing it seeds a fresh session with a
    // bounded transcript, so the reply carries the work instead of starting from
    // nothing, and the stream says so.
    const gone = path.join(ws, "agent-team-log", "image_analyzer-2.json");
    fs.mkdirSync(path.dirname(gone), { recursive: true });
    const sid = "resume-seeded";
    const now = new Date().toISOString();
    const seeded = await fetch(`${base}/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify([
        { event_id: `${sid}-1`, session_id: sid, seq: 1, ts: now, type: "session_start", cwd: ws, session_file: gone, payload: { reason: "start" } },
        { event_id: `${sid}-2`, session_id: sid, seq: 2, ts: now, type: "user_message", cwd: ws, session_file: gone, payload: { text: "chart the revenue by quarter" } },
        { event_id: `${sid}-3`, session_id: sid, seq: 3, ts: now, type: "assistant_message", cwd: ws, session_file: gone, payload: { text: "Chart written to tmp/chart.png." } },
      ]),
    });
    assert.ok(seeded.ok, `seeding the recorded session → ${seeded.status}`);

    const from = rpcLines().length;
    const first = await chat({ sessionId: sid, sessionFile: gone });
    const sent = prompts(rpcSince(from));
    assert.equal(sent.length, 1, "the prompt is still delivered");
    const message = String(sent[0].message || "");
    assert.ok(message.startsWith("[Continued session transcript"), "the turn opens with the seeded transcript");
    assert.match(message, /chart the revenue by quarter/, "the recorded question is carried over");
    assert.match(message, /Chart written to tmp\/chart\.png\./, "and what the agent did about it");
    assert.ok(message.endsWith("hello there"), "the user's own message is still last");
    assert.ok(message.includes("[End of continued session transcript]"), "the block is delimited");
    assert.deepEqual(switches(rpcSince(from)), [], "still no switch onto the missing file");
    assert.equal(fs.existsSync(gone), false, "and still no file created at that path");

    const said = warnings(first);
    assert.equal(said.length, 1, "the user is told once");
    assert.match(said[0], /cannot resume this session/);
    assert.match(said[0], /recorded transcript was carried into this conversation instead/);

    // The next turn is the same conversation: it already has the transcript in
    // its history, so the seed is not repeated (and would only cost tokens).
    const second = await chat({ sessionId: sid, sessionFile: gone });
    const again = String(prompts(rpcSince(from))[1].message || "");
    assert.equal(again, "hello there", "the second turn carries no seed");
    assert.deepEqual(warnings(second), [], "and no second warning");
  });

  test("the same unusable target is reported once, not on every turn", async () => {
    const gone = path.join(ws, "gone-twice.jsonl");
    const from = rpcLines().length;
    const first = await chat({ sessionId: "resume-warn-once", sessionFile: gone });
    const second = await chat({ sessionId: "resume-warn-once", sessionFile: gone });
    assert.equal(warnings(first).length, 1, "the first turn explains itself");
    assert.deepEqual(warnings(second), [], "the second turn does not repeat it");
    assert.equal(prompts(rpcSince(from)).length, 2, "both turns reached pi");
    assert.equal(fs.existsSync(gone), false, "still no file created at that path");
  });
});
