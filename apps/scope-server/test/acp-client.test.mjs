// Unit tests for the ACP client: handshake, streamed updates, permission
// requests answered by label, and the refusal of client-side fs/terminal calls.
//
//   node --test apps/scope-server/test/acp-client.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { AcpSession, parseAcpAvailableCommands, permissionDialogId } from "../acp-client.ts";

const AGENT = `
import * as readline from "node:readline";
const send = (v) => process.stdout.write(JSON.stringify(v) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let frame;
  try { frame = JSON.parse(line); } catch { return; }
  if (frame.method === "initialize") return send({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: 1 } });
  if (frame.method === "session/new") return send({ jsonrpc: "2.0", id: frame.id, result: { sessionId: "sess-1", modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }, { id: "plan", name: "Plan" }] } } });
  if (frame.method === "session/load") return send({ jsonrpc: "2.0", id: frame.id, result: { modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }, { id: "plan", name: "Plan" }] } } });
  if (frame.method === "session/set_model" || frame.method === "session/set_mode") return send({ jsonrpc: "2.0", id: frame.id, result: {} });
  if (frame.method === "session/cancel") { process.stdout.write(JSON.stringify({ method: "cancelled" }) + "\\n"); return; }
  if (frame.id === 99) {
    send({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " picked=" + (frame.result?.outcome?.optionId || frame.result?.outcome?.outcome) } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", status: "completed", title: "Bash" } } });
    return send({ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } });
  }
  if (frame.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", title: "Bash", rawInput: { command: "ls" } } } });
    // A client-side tool call: the client must refuse it, not run it.
    send({ jsonrpc: "2.0", id: 77, method: "fs/read_text_file", params: { path: "/etc/passwd" } });
    send({ jsonrpc: "2.0", id: 99, method: "session/request_permission", params: {
      sessionId: "sess-1",
      toolCall: { title: "Run bash: rm -rf build" },
      options: [{ optionId: "allow-once", name: "Allow once" }, { optionId: "reject", name: "Reject" }],
    } });
    return;
  }
});
`;

function fakeAgent() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-acp-"));
  fs.writeFileSync(path.join(dir, "agent.mjs"), AGENT);
  const file = path.join(dir, "agent");
  fs.writeFileSync(file, `#!/bin/sh\nexec node "$(dirname "$0")/agent.mjs" "$@"\n`, { mode: 0o755 });
  return file;
}

test("a prompt streams text/tools and blocks on the permission dialog", async () => {
  const events = [];
  let permission = null;
  const session = new AcpSession({
    file: fakeAgent(),
    args: [],
    cwd: os.tmpdir(),
    startTimeoutMs: 10_000,
    handlers: {
      onText: (delta) => events.push(["text", delta]),
      onThought: (delta) => events.push(["thought", delta]),
      onToolStart: (name, args) => events.push(["tool_start", name, args]),
      onToolEnd: (name) => events.push(["tool_end", name]),
      onPermission: (request) => { permission = request; events.push(["permission", request.title]); },
    },
  });
  assert.equal(await session.start(), "sess-1");
  assert.equal(session.alive, true);

  const settled = session.prompt("do it");
  await new Promise((resolve) => {
    const tick = setInterval(() => { if (permission) { clearInterval(tick); resolve(); } }, 10);
  });
  assert.equal(permission.title, "Run bash: rm -rf build");
  assert.deepEqual(permission.options.map((o) => o.label), ["Allow once", "Reject"]);
  assert.equal(permission.id, permissionDialogId(99));

  // The user picks "Allow once" — the CLIENT sends the agent's own optionId.
  assert.equal(session.answerPermission(permission.id, "Allow once", false), true);
  assert.equal(await settled, "end_turn");
  assert.deepEqual(events.filter((e) => e[0] === "text"), [["text", "hello"], ["text", " picked=allow-once"]]);
  assert.ok(events.some((e) => e[0] === "thought" && e[1] === "thinking"));
  assert.ok(events.some((e) => e[0] === "tool_start" && e[1] === "Bash"));
  assert.ok(events.some((e) => e[0] === "tool_end" && e[1] === "Bash"));

  // The fs request was refused by the client (the agent got an error and kept
  // going), and no dialog was opened for it.
  assert.equal(events.filter((e) => e[0] === "permission").length, 1);
  session.close();
  assert.equal(session.alive, false);
});

test("the live session's available_commands_update reaches the current run", async () => {
  const AGENT = `
import * as readline from "node:readline";
const send = (v) => process.stdout.write(JSON.stringify(v) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
const commands = (list) => send({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "available_commands_update", availableCommands: list } } });
rl.on("line", (line) => {
  let frame;
  try { frame = JSON.parse(line); } catch { return; }
  if (frame.method === "initialize") return send({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: 2 } });
  if (frame.method === "session/new") {
    commands([{ name: "review", description: "Review changes", input: { type: "text", hint: "[focus]" } }, { name: "$skill" }]);
    return send({ jsonrpc: "2.0", id: frame.id, result: { sessionId: "sess-commands" } });
  }
  if (frame.method === "session/prompt") {
    commands([{ name: "compact", description: "Reduce context" }, { name: "review" }]);
    return send({ jsonrpc: "2.0", id: frame.id, result: { stopReason: "end_turn" } });
  }
});
`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-acp-commands-"));
  fs.writeFileSync(path.join(dir, "agent.mjs"), AGENT);
  const file = path.join(dir, "agent");
  fs.writeFileSync(file, `#!/bin/sh\nexec node "$(dirname "$0")/agent.mjs" "$@"\n`, { mode: 0o755 });

  const seen = [];
  const session = new AcpSession({
    file,
    args: [],
    cwd: os.tmpdir(),
    startTimeoutMs: 10_000,
    handlers: { onText: () => {}, onCommands: (commands) => seen.push(commands) },
  });
  await session.start();
  assert.deepEqual(session.availableCommands, [
    { name: "review", description: "Review changes", argumentHint: "[focus]" },
  ], "session/new commands are kept, and `$` skills stay out of the / menu");
  assert.deepEqual(seen.at(-1), session.availableCommands);

  await session.prompt("go");
  assert.deepEqual(session.availableCommands.map((c) => c.name), ["compact", "review"],
    "a mid-session update replaces the list");
  assert.equal(seen.length, 2, "the latest run handler saw the update");
  session.close();
});

test("parseAcpAvailableCommands accepts ACP v2's input.hint", () => {
  assert.deepEqual(parseAcpAvailableCommands([
    { name: "/status", description: "Show status", input: { type: "text", hint: "[verbose]" } },
    { name: "$skill" },
    { name: "two words" },
    { name: "status" },
  ]), [
    { name: "status", description: "Show status", argumentHint: "[verbose]" },
  ]);
});

test("a saved session is resumed with session/load, and model/mode switch live", async () => {
  const session = new AcpSession({
    file: fakeAgent(),
    args: [],
    cwd: os.tmpdir(),
    resumeSessionId: "sess-saved",
    model: "fast-model",
    startTimeoutMs: 10_000,
    handlers: { onText: () => {} },
  });
  assert.equal(await session.start(), "sess-saved", "the loaded session id is kept");
  assert.deepEqual(session.availableModes.map((m) => m.id), ["build", "plan"]);
  assert.equal(session.mode, "build");
  assert.equal(await session.setMode("plan"), true);
  assert.equal(session.mode, "plan");
  assert.equal(await session.setModel("other-model"), true);
  assert.equal(await session.setMode(""), false, "no mode means nothing to switch");
  session.close();
});

test("dismissing a permission dialog cancels the request", async () => {
  let permission = null;
  const session = new AcpSession({
    file: fakeAgent(),
    args: [],
    cwd: os.tmpdir(),
    startTimeoutMs: 10_000,
    handlers: { onText: () => {}, onPermission: (r) => { permission = r; } },
  });
  await session.start();
  const settled = session.prompt("go");
  await new Promise((resolve) => {
    const tick = setInterval(() => { if (permission) { clearInterval(tick); resolve(); } }, 10);
  });
  assert.equal(session.answerPermission(permission.id, "", true), true);
  assert.equal(await settled, "end_turn");
  assert.equal(session.answerPermission(permission.id, "Allow once", false), false, "a dialog answers once");
  session.close();
});

// ─── ACP v2 negotiation (t3code's protocol shape) ──────────────────────────

const V2_AGENT = `
import * as fs from "node:fs";
import * as readline from "node:readline";
const log = process.argv[2];
const mode = process.argv[3] || "none";
const send = (v) => process.stdout.write(JSON.stringify(v) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let frame;
  try { frame = JSON.parse(line); } catch { return; }
  if (frame.method === "initialize") {
    fs.appendFileSync(log, "initialize=" + JSON.stringify(frame.params) + "\\n");
    const capabilities =
      mode === "load" ? { loadSession: true }
      : mode === "resume" ? { sessionCapabilities: { resume: {} } }
      : {};
    return send({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: 2, agentCapabilities: capabilities } });
  }
  if (frame.method === "session/load" || frame.method === "session/resume" || frame.method === "session/new") {
    fs.appendFileSync(log, frame.method + "=" + (frame.params.sessionId || "") + "\\n");
    return send({ jsonrpc: "2.0", id: frame.id, result: frame.method === "session/new" ? { sessionId: "new-session" } : {} });
  }
  if (frame.method === "session/set_model") return send({ jsonrpc: "2.0", id: frame.id, result: {} });
});
`;

function fakeV2Agent(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-acp-v2-"));
  const log = path.join(dir, "methods.log");
  fs.writeFileSync(path.join(dir, "agent.mjs"), V2_AGENT);
  const file = path.join(dir, "agent");
  fs.writeFileSync(
    file,
    `#!/bin/sh\nexec node "$(dirname "$0")/agent.mjs" '${log}' '${mode}' "$@"\n`,
    { mode: 0o755 },
  );
  return { file, log };
}

for (const [mode, method, expectedId] of [
  ["load", "session/load", "saved-1"],
  ["resume", "session/resume", "saved-1"],
  ["none", "session/new", "new-session"],
]) {
  test(`ACP v2 with ${mode} capability resumes via ${method}`, async () => {
    const { file, log } = fakeV2Agent(mode);
    const session = new AcpSession({
      file,
      args: [],
      cwd: os.tmpdir(),
      resumeSessionId: "saved-1",
      startTimeoutMs: 10_000,
      handlers: { onText: () => {} },
    });
    assert.equal(await session.start(), expectedId);
    const calls = fs.readFileSync(log, "utf8").trim().split("\n");
    const init = JSON.parse(calls.find((l) => l.startsWith("initialize=")).slice("initialize=".length));
    assert.equal(init.protocolVersion, 2, "the client asks for the current ACP version");
    assert.equal(init.clientInfo.name, "Pi Scope");
    assert.ok(calls.includes(`${method}=` + (method === "session/new" ? "" : "saved-1")),
      `expected ${method}, got ${calls.join(", ")}`);
    assert.equal(session.resumedSession, mode !== "none");
    session.close();
  });
}
