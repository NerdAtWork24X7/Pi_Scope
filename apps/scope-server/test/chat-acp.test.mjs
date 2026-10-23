// Chat ↔ ACP integration: an ACP harness must be driven as a live session (not
// a print-mode child), its permission request must surface as an answerable
// select dialog, and the second prompt must reuse the SAME session.
//
//   node --test apps/scope-server/test/chat-acp.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { answerChatUi, killChatSession, startChat } from "../chat.ts";

// Keep the restart-resume store out of the real agent dir: these tests create
// chat sessions whose ids must never land in the user's app state.
process.env.SCOPE_ACP_SESSIONS_FILE = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "scope-acp-store-")),
  "sessions.json",
);

const AGENT = `
import * as fs from "node:fs";
import * as readline from "node:readline";
const countFile = process.argv[2];
const send = (v) => process.stdout.write(JSON.stringify(v) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let frame;
  try { frame = JSON.parse(line); } catch { return; }
  if (frame.method === "initialize") return send({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: 1 } });
  if (frame.method === "session/new") {
    send({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact", description: "Reduce context", input: { type: "text", hint: "[instructions]" } }] } } });
    return send({ jsonrpc: "2.0", id: frame.id, result: { sessionId: "acp-session-1", modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }, { id: "plan", name: "Plan" }] } } });
  }
  if (frame.method === "session/load") {
    fs.appendFileSync(countFile + ".ctl", "session/load=" + frame.params.sessionId + "\\n");
    return send({ jsonrpc: "2.0", id: frame.id, result: { modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }, { id: "plan", name: "Plan" }] } } });
  }
  if (frame.method === "session/set_model" || frame.method === "session/set_mode") {
    fs.appendFileSync(countFile + ".ctl", frame.method + "=" + (frame.params.modelId || frame.params.modeId) + "\\n");
    return send({ jsonrpc: "2.0", id: frame.id, result: {} });
  }
  if (frame.method === "session/cancel") return;
  if (frame.id === 90) {
    send({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " allowed" } } } });
    return send({ jsonrpc: "2.0", id: frame.id - 90 + promptId, result: { stopReason: "end_turn" } });
  }
  if (frame.method === "session/prompt") {
    promptId = frame.id;
    const prompts = (() => { try { return JSON.parse(fs.readFileSync(countFile, "utf8")); } catch { return []; } })();
    prompts.push(frame.params.prompt[0].text);
    fs.writeFileSync(countFile, JSON.stringify(prompts));
    send({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello " + prompts.length } } } });
    send({ jsonrpc: "2.0", id: 90, method: "session/request_permission", params: { sessionId: "acp-session-1", toolCall: { title: "Run bash: echo hi" }, options: [{ optionId: "allow-once", name: "Allow once" }, { optionId: "reject", name: "Reject" }] } });
  }
});
let promptId = 0;
`;

function fakeGemini() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-chat-acp-"));
  const countFile = path.join(dir, "prompts.json");
  fs.writeFileSync(path.join(dir, "agent.mjs"), AGENT);
  const file = path.join(dir, "gemini");
  fs.writeFileSync(
    file,
    `#!/bin/sh\nexec node "$(dirname "$0")/agent.mjs" '${countFile}' "$@"\n`,
    { mode: 0o755 },
  );
  return { file, countFile, dir };
}

// An agent that exposes a model config option but refuses to change it. The
// point is that Chat must NOT fall through to `session/prompt` on the agent's
// default model: the user would see an answer from a model they did not pick.
const REFUSING_MODEL_AGENT = `
import * as fs from "node:fs";
import * as readline from "node:readline";
const countFile = process.argv[2];
const send = (v) => process.stdout.write(JSON.stringify(v) + "\\n");
const modelOption = (current) => [{ id: "model", name: "Model", category: "model", type: "select", currentValue: current, options: [{ value: "default-model", name: "Default" }, { value: "chosen-model", name: "Chosen" }] }];
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let frame;
  try { frame = JSON.parse(line); } catch { return; }
  if (frame.method === "initialize") return send({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: 2 } });
  if (frame.method === "session/new") return send({ jsonrpc: "2.0", id: frame.id, result: { sessionId: "acp-refused-model", configOptions: modelOption("default-model") } });
  if (frame.method === "session/set_model") return send({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "Method not found" } });
  if (frame.method === "session/set_config_option") return send({ jsonrpc: "2.0", id: frame.id, error: { code: -32000, message: "Authentication required: provider authentication required" } });
  if (frame.method === "session/prompt") {
    fs.appendFileSync(countFile, "prompted\\n");
    return send({ jsonrpc: "2.0", id: frame.id, result: { stopReason: "end_turn" } });
  }
});
`;

function fakeRefusingModelAgent() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-chat-acp-refuse-"));
  const countFile = path.join(dir, "prompts.log");
  fs.writeFileSync(path.join(dir, "agent.mjs"), REFUSING_MODEL_AGENT);
  const file = path.join(dir, "gemini");
  fs.writeFileSync(
    file,
    `#!/bin/sh\nexec node "$(dirname "$0")/agent.mjs" '${countFile}' "$@"\n`,
    { mode: 0o755 },
  );
  return { file, countFile, dir };
}

/** Read one NDJSON stream into events, stopping at `done`. */
async function readRun(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) continue;
      const event = JSON.parse(line);
      events.push(event);
      await onEvent?.(event);
      if (event.type === "done") return events;
    }
    if (done) return events;
  }
}

const cleanups = [];
after(() => {
  for (const fn of cleanups) {
    try { fn(); } catch { /* already gone */ }
  }
});

test("Chat drives an ACP harness as a live session with a permission card", async () => {
  const { file, countFile, dir } = fakeGemini();
  const before = process.env.SCOPE_HARNESS_BIN_GEMINI;
  process.env.SCOPE_HARNESS_BIN_GEMINI = file;
  cleanups.push(() => {
    if (before === undefined) delete process.env.SCOPE_HARNESS_BIN_GEMINI;
    else process.env.SCOPE_HARNESS_BIN_GEMINI = before;
  });

  const sid = `acp-test-${Date.now()}`;
  cleanups.push(() => killChatSession(sid));

  const events = await readRun(
    startChat({ cwd: dir, harness: "gemini", prompt: "first", sessionId: sid }),
    (event) => {
      if (event.type === "ui_select") {
        assert.match(event.title, /echo hi/);
        assert.deepEqual(event.options, ["Allow once", "Reject"]);
        assert.equal(answerChatUi(sid, event.id, { value: "Allow once" }), true, "the card resolves the ACP request");
      }
    },
  );

  const texts = events.filter((e) => e.type === "text").map((e) => e.delta).join("");
  assert.match(texts, /hello 1/);
  assert.match(texts, / allowed/, "the agent continued after the answer");
  assert.ok(events.some((e) => e.type === "done" && !e.error), "the run settled without an error");

  // A second prompt on the same conversation continues the SAME ACP session,
  // and a model/mode chosen in the composer is pushed into it.
  let modes = null;
  const second = await readRun(
    startChat({ cwd: dir, harness: "gemini", prompt: "second", sessionId: sid, model: "fast", mode: "plan" }),
    (event) => {
      if (event.type === "session_modes") modes = event;
      if (event.type === "ui_select") answerChatUi(sid, event.id, { value: "Reject" });
    },
  );
  assert.ok(modes, "the session's modes reach the page");
  assert.deepEqual(modes.modes.map((m) => m.id), ["build", "plan"]);
  const controls = fs.readFileSync(`${countFile}.ctl`, "utf8");
  assert.match(controls, /session\/set_model=fast/);
  assert.match(controls, /session\/set_mode=plan/);
  assert.match(second.filter((e) => e.type === "text").map((e) => e.delta).join(""), /hello 2/);
  const prompts = JSON.parse(fs.readFileSync(countFile, "utf8"));
  assert.deepEqual(prompts, ["first", "second"], "the harness kept the conversation instead of being restarted");
});

test("a slash command is sent verbatim and the session's own command list reaches the page", async () => {
  const { file, countFile, dir } = fakeGemini();
  const before = process.env.SCOPE_HARNESS_BIN_GEMINI;
  process.env.SCOPE_HARNESS_BIN_GEMINI = file;
  cleanups.push(() => {
    if (before === undefined) delete process.env.SCOPE_HARNESS_BIN_GEMINI;
    else process.env.SCOPE_HARNESS_BIN_GEMINI = before;
  });

  const sid = `acp-command-${Date.now()}`;
  cleanups.push(() => killChatSession(sid));
  let advertised = null;
  const events = await readRun(
    startChat({
      cwd: dir,
      harness: "gemini",
      prompt: "/compact focus on the API",
      sessionId: sid,
      // A fresh ACP session normally gets the reference library/transcript
      // preamble. A native command must not: it has to be the whole prompt.
      libraryBlock: "REFERENCE LIBRARY BLOCK",
    }),
    (event) => {
      if (event.type === "session_commands") advertised = event;
      if (event.type === "ui_select") answerChatUi(sid, event.id, { value: "Allow once" });
    },
  );

  const prompts = JSON.parse(fs.readFileSync(countFile, "utf8"));
  assert.deepEqual(prompts, ["/compact focus on the API"]);
  assert.ok(advertised, "the live session advertised its commands");
  assert.equal(advertised.harness, "gemini");
  assert.deepEqual(advertised.commands, [
    { command: "/compact", description: "Reduce context", argumentHint: "[instructions]", source: "acp" },
  ]);
  assert.ok(events.some((e) => e.type === "done" && !e.error));
});

test("a saved ACP session is resumed with session/load after a restart", async () => {
  const { file, countFile, dir } = fakeGemini();
  const before = process.env.SCOPE_HARNESS_BIN_GEMINI;
  const beforeFile = process.env.SCOPE_ACP_SESSIONS_FILE;
  const store = path.join(dir, "acp-sessions.json");
  process.env.SCOPE_HARNESS_BIN_GEMINI = file;
  process.env.SCOPE_ACP_SESSIONS_FILE = store;
  cleanups.push(() => {
    if (before === undefined) delete process.env.SCOPE_HARNESS_BIN_GEMINI;
    else process.env.SCOPE_HARNESS_BIN_GEMINI = before;
    if (beforeFile === undefined) delete process.env.SCOPE_ACP_SESSIONS_FILE;
    else process.env.SCOPE_ACP_SESSIONS_FILE = beforeFile;
  });

  const sid = `acp-resume-${Date.now()}`;
  cleanups.push(() => killChatSession(sid));
  // What an earlier server process left behind for this conversation.
  fs.writeFileSync(store, JSON.stringify({ [sid]: { harness: "gemini", cwd: dir, acpSessionId: "saved-1", at: Date.now() } }));

  const events = await readRun(
    startChat({ cwd: dir, harness: "gemini", prompt: "continue", sessionId: sid }),
    (event) => {
      if (event.type === "ui_select") answerChatUi(sid, event.id, { value: "Allow once" });
    },
  );
  assert.ok(events.some((e) => e.type === "done" && !e.error), JSON.stringify(events.filter((e) => e.error)));
  const ctl = fs.readFileSync(`${countFile}.ctl`, "utf8");
  assert.match(ctl, /session\/load=saved-1/, "the stored session was loaded, not replaced");
});

test("a model the harness refuses fails the turn instead of prompting on its default", async () => {
  const { file, countFile, dir } = fakeRefusingModelAgent();
  const before = process.env.SCOPE_HARNESS_BIN_OPENCODE;
  process.env.SCOPE_HARNESS_BIN_OPENCODE = file;
  cleanups.push(() => {
    if (before === undefined) delete process.env.SCOPE_HARNESS_BIN_OPENCODE;
    else process.env.SCOPE_HARNESS_BIN_OPENCODE = before;
  });

  const sid = `acp-refused-model-${Date.now()}`;
  cleanups.push(() => killChatSession(sid));

  const events = await readRun(
    startChat({ cwd: dir, harness: "opencode", prompt: "hello", sessionId: sid, model: "chosen-model" }),
  );

  const error = events.find((e) => e.type === "error");
  assert.ok(error, `expected an error event, got ${JSON.stringify(events)}`);
  assert.match(error.message, /could not use model "chosen-model"/);
  assert.match(error.message, /Authentication required/);
  const done = events.find((e) => e.type === "done");
  assert.ok(done?.error, "the run settles with an error");
  assert.equal(fs.existsSync(countFile), false, "session/prompt was never sent, so the default model never answered");
});
