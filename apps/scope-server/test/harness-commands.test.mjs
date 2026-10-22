// Unit tests for harness-command discovery: each protocol's parser, and a real
// child process asked over that protocol (fake CLIs written as shell scripts).
//
//   node --test apps/scope-server/test/harness-commands.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  clearHarnessCommandCache,
  discoverHarnessCommands,
  normalizeHarnessCommands,
  parseAcpCommands,
  parseClaudeCommands,
  parseCodexSkills,
  parsePiCommands,
  rememberHarnessCommands,
} from "../harness-commands.ts";

function fakeBin(name, script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-commands-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, script, { mode: 0o755 });
  return file;
}

async function withEnv(name, value, fn) {
  const before = process.env[name];
  process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  }
}

test("command normalization drops names a slash token cannot address", () => {
  const commands = normalizeHarnessCommands([
    { name: "compact", description: "  Compact   the conversation ", argumentHint: "[focus]" },
    { name: "/model", description: "Change the model" },
    { name: "memory show", description: "Sub-command, not one token" },
    { name: "bad/name", description: "Slashes are not a command" },
    { name: "" },
    { name: "compact", description: "duplicate" },
    { name: "hidden", userInvocable: false },
    { name: "off", enabled: false },
    { name: "deploy", source: "extension" },
  ]);
  assert.deepEqual(commands.map((c) => c.command), ["/compact", "/model", "/deploy"]);
  assert.equal(commands[0].description, "Compact the conversation");
  assert.equal(commands[0].argumentHint, "[focus]");
  assert.equal(commands[2].source, "extension");
});

test("each protocol's answer is parsed into the composer's shape", () => {
  assert.deepEqual(
    parsePiCommands({
      type: "response",
      id: "scope-commands",
      success: true,
      data: { commands: [{ name: "agents-team", description: "Select a team", source: "extension" }] },
    }).map((c) => [c.command, c.source]),
    [["/agents-team", "extension"]],
  );
  assert.equal(parsePiCommands({ type: "response", success: false }), null);

  // Objects (with descriptions) and the legacy name-array both work.
  const fromObjects = parseClaudeCommands({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "scope-commands",
      response: { commands: [{ name: "compact", description: "Free context", argumentHint: "" }] },
    },
  });
  assert.deepEqual(fromObjects.map((c) => c.command), ["/compact"]);
  assert.equal(fromObjects[0].description, "Free context");
  const fromNames = parseClaudeCommands({
    type: "system",
    subtype: "init",
    slash_commands: ["clear", "model"],
  });
  assert.deepEqual(fromNames.map((c) => c.command), ["/clear", "/model"]);

  const skills = parseCodexSkills({
    data: [
      {
        cwd: "/p",
        skills: [
          { name: "imagegen", description: "Make images", scope: "system", enabled: true },
          { name: "off", description: "Disabled", enabled: false },
        ],
      },
    ],
  });
  assert.deepEqual(skills.map((c) => c.command), ["/imagegen"]);
  assert.match(skills[0].source, /skill/);

  const acp = parseAcpCommands({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "review", description: "Review changes", input: { hint: "[focus]" } },
          { name: "memory show" },
        ],
      },
    },
  });
  assert.deepEqual(acp.map((c) => c.command), ["/review"]);
  assert.equal(acp[0].argumentHint, "[focus]", "ACP v2's input.hint reaches the composer");
  assert.equal(parseAcpCommands({ params: { update: { sessionUpdate: "agent_message_chunk" } } }), null);

  // ACP names skills `$skill`; they take a `$` token, not a `/` command, so the
  // slash menu must not offer something the agent cannot dispatch.
  const acpSkills = parseAcpCommands({
    params: { update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "$review" }] } },
  });
  assert.deepEqual(acpSkills, []);
});

test("pi is asked over its RPC get_commands, in the workspace", async () => {
  clearHarnessCommandCache();
  const bin = fakeBin(
    "pi",
    '#!/bin/sh\npwd > "$0.cwd"\nread line\nprintf \'%s\\n\' \'{"type":"response","id":"scope-commands","success":true,"data":{"commands":[{"name":"deploy","description":"Ship it","source":"extension"}]}}\'\n',
  );
  const result = await withEnv("SCOPE_PI_BIN", bin, () =>
    discoverHarnessCommands("pi", undefined, { cwd: os.tmpdir(), timeoutMs: 5000 }),
  );
  assert.equal(result.error, undefined);
  assert.equal(result.source, "pi get_commands");
  assert.deepEqual(result.commands.map((c) => c.command), ["/deploy"]);
  const seenCwd = fs.readFileSync(`${bin}.cwd`, "utf8").trim();
  assert.equal(fs.realpathSync(seenCwd), fs.realpathSync(os.tmpdir()), "project commands load from the chat's cwd");
});

test("Claude is asked through its stream-json control channel", async () => {
  clearHarnessCommandCache();
  const bin = fakeBin(
    "claude",
    '#!/bin/sh\nread line\nprintf \'%s\\n\' \'{"type":"control_response","response":{"subtype":"success","request_id":"scope-commands","response":{"commands":[{"name":"deep-research","description":"Fan out searches","argumentHint":"<topic>"}]}}}\'\n',
  );
  const result = await withEnv("SCOPE_HARNESS_BIN_CLAUDE", bin, () =>
    discoverHarnessCommands("claude", undefined, { cwd: os.tmpdir(), timeoutMs: 5000 }),
  );
  assert.equal(result.source, "claude initialize");
  assert.deepEqual(result.commands, [
    { command: "/deep-research", description: "Fan out searches", argumentHint: "<topic>" },
  ]);
});

test("an ACP harness gets its available_commands_update", async () => {
  clearHarnessCommandCache();
  const bin = fakeBin(
    "gemini",
    '#!/bin/sh\nread init\nprintf \'%s\\n\' \'{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\'\nread session\nprintf \'%s\\n\' \'{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"available_commands_update","availableCommands":[{"name":"init","description":"Create a GEMINI.md"},{"name":"restore","description":"Restore a checkpoint"}]}}}\'\n',
  );
  const result = await withEnv("SCOPE_HARNESS_BIN_GEMINI", bin, () =>
    discoverHarnessCommands("gemini", undefined, { cwd: os.tmpdir(), timeoutMs: 5000 }),
  );
  assert.equal(result.source, "ACP session/new");
  assert.deepEqual(result.commands.map((c) => c.command), ["/init", "/restore"]);
});

test("answers are cached, failures are retried, and a no-interface CLI is never started", async () => {
  clearHarnessCommandCache();
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "scope-commands-")), "ran");
  const aider = fakeBin("aider", `#!/bin/sh\ntouch '${marker}'\n`);
  const aiderResult = await withEnv("SCOPE_HARNESS_BIN_AIDER", aider, () =>
    discoverHarnessCommands("aider", undefined, { cwd: os.tmpdir(), timeoutMs: 5000 }),
  );
  assert.deepEqual(aiderResult.commands, []);
  assert.equal(aiderResult.source, null);
  assert.equal(fs.existsSync(marker), false, "aider publishes no interface, so no process starts");

  const bin = fakeBin("kilo", '#!/bin/sh\necho "not signed in" >&2\nexit 3\n');
  const failed = await withEnv("SCOPE_HARNESS_BIN_KILO", bin, () =>
    discoverHarnessCommands("kilo", undefined, { cwd: os.tmpdir(), timeoutMs: 5000 }),
  );
  assert.deepEqual(failed.commands, []);
  assert.match(failed.error, /not signed in/);

  // The failure was not cached: the fixed CLI answers on the next attempt.
  const fixed = fakeBin(
    "kilo",
    '#!/bin/sh\nread init\nprintf \'%s\\n\' \'{"jsonrpc":"2.0","id":1,"result":{}}\'\nread session\nprintf \'%s\\n\' \'{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"available_commands_update","availableCommands":[{"name":"review"}]}}}\'\n',
  );
  const ok = await withEnv("SCOPE_HARNESS_BIN_KILO", fixed, () =>
    discoverHarnessCommands("kilo", undefined, { cwd: os.tmpdir(), timeoutMs: 5000 }),
  );
  assert.deepEqual(ok.commands.map((c) => c.command), ["/review"]);

  // Second call is served from the cache (rewriting the binary changes nothing).
  fs.writeFileSync(fixed, "#!/bin/sh\nexit 9\n", { mode: 0o755 });
  const cached = await withEnv("SCOPE_HARNESS_BIN_KILO", fixed, () =>
    discoverHarnessCommands("kilo", undefined, { cwd: os.tmpdir(), timeoutMs: 5000 }),
  );
  assert.deepEqual(cached.commands.map((c) => c.command), ["/review"]);
});

test("an unknown harness is reported instead of guessed", async () => {
  const result = await discoverHarnessCommands("not-a-harness", undefined, { cwd: os.tmpdir(), timeoutMs: 1000 });
  assert.deepEqual(result.commands, []);
  assert.match(result.error, /unknown harness/);
});

test("commands from a live ACP session are reused instead of starting a probe", async () => {
  clearHarnessCommandCache();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scope-live-commands-"));
  const marker = path.join(cwd, "started");
  const bin = fakeBin("gemini", `#!/bin/sh\ntouch '${marker}'\n`);
  rememberHarnessCommands("gemini", cwd, [
    { command: "/review", description: "Review changes", argumentHint: "[focus]" },
  ]);
  const result = await withEnv("SCOPE_HARNESS_BIN_GEMINI", bin, () =>
    discoverHarnessCommands("gemini", undefined, { cwd, timeoutMs: 5000 }),
  );
  assert.equal(result.source, "ACP session");
  assert.deepEqual(result.commands, [
    { command: "/review", description: "Review changes", argumentHint: "[focus]" },
  ]);
  assert.equal(fs.existsSync(marker), false, "the live session already answered; no second CLI was started");
});
