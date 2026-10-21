// Unit tests for the Chat harness catalogue and its spawn plans.
//
//   node --test apps/scope-server/test/harnesses.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  DEFAULT_CHAT_HARNESS,
  buildHarnessLaunch,
  chatHarness,
  chatHarnessList,
  clearHarnessModelCache,
  discoverHarnessModels,
  isChatHarness,
  normaliseHarnessSettings,
  normalizeHarnessId,
} from "../harnesses.ts";

/** A real executable file an override can point at. */
function fakeBin(name, script = "#!/bin/sh\nexit 0\n") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-harness-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, script, { mode: 0o755 });
  return file;
}

const ENV = "SCOPE_HARNESS_BIN_CLAUDE";

function withClaudeBin(value, fn) {
  const before = process.env[ENV];
  process.env[ENV] = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env[ENV];
    else process.env[ENV] = before;
  }
}

test("the catalogue starts with Pi and knows the common CLIs", () => {
  assert.equal(DEFAULT_CHAT_HARNESS, "pi");
  const list = chatHarnessList();
  assert.equal(list[0].id, "pi", "Pi is the default and the first option");
  assert.equal(list[0].available, true, "the built-in runner needs no binary");
  for (const id of ["claude", "codex", "gemini", "opencode", "cline", "kilo", "aider", "cursor"]) {
    const info = list.find((h) => h.id === id);
    assert.ok(info, `${id} is offered`);
    assert.equal(info.label.length > 0, true);
    assert.equal(typeof info.available, "boolean");
  }
});

test("the catalogue says which harnesses publish their own commands", () => {
  const list = chatHarnessList();
  const publishes = (id) => list.find((h) => h.id === id).hasCommands;
  // A discovery interface exists for these: ACP (gemini/opencode/kilo/cline),
  // Claude's initialize response, Codex's skills/list, pi's get_commands.
  for (const id of ["pi", "claude", "codex", "gemini", "opencode", "cline", "kilo"]) {
    assert.equal(publishes(id), true, `${id} can be asked for its commands`);
  }
  // Aider and Cursor Agent publish no command interface to a pipe: the composer
  // must not invent a list for them.
  for (const id of ["aider", "cursor"]) {
    assert.equal(publishes(id), false, `${id} advertises nothing`);
  }
  // No harness ships a copied command table any more.
  assert.ok(list.every((h) => !("slashCommands" in h)), "commands are discovered, never baked in");
});

test("harness ids normalize and unknown ids are reported instead of hidden", () => {
  assert.equal(normalizeHarnessId("  Claude "), "claude");
  assert.equal(normalizeHarnessId(""), "pi");
  assert.equal(normalizeHarnessId(null), "pi");
  assert.equal(isChatHarness("opencode"), true);
  assert.equal(isChatHarness("not-a-harness"), false);
  assert.equal(chatHarness("not-a-harness"), null);
  // A user's own empty model is not a harness id.
  assert.equal(normalizeHarnessId("   "), "pi");
});

test("Claude Code's plan is `-p <prompt>` with the model flag appended", () => {
  const bin = fakeBin("claude");
  withClaudeBin(bin, () => {
    const launch = buildHarnessLaunch("claude", { prompt: "fix the tests", model: "sonnet" });
    assert.equal(launch.ok, true);
    assert.equal(launch.file, bin);
    assert.deepEqual(launch.args, ["-p", "fix the tests", "--model", "sonnet"]);
    assert.equal(launch.promptOnStdin, false);
  });
});

test("a stdin harness gets no prompt in argv and an empty model is omitted", () => {
  const bin = fakeBin("opencode");
  const before = process.env.SCOPE_HARNESS_BIN_OPENCODE;
  process.env.SCOPE_HARNESS_BIN_OPENCODE = bin;
  try {
    // No model: the CLI's own default is used, so no --model is passed.
    const plain = buildHarnessLaunch("opencode", { prompt: "multi\nline" });
    assert.equal(plain.ok, true);
    assert.deepEqual(plain.args, ["run"]);
    assert.equal(plain.promptOnStdin, true);
    assert.equal(plain.prompt, "multi\nline");

    const withModel = buildHarnessLaunch("opencode", { prompt: "x", model: "openai/gpt-5" });
    assert.deepEqual(withModel.args, ["run", "--model", "openai/gpt-5"]);
  } finally {
    if (before === undefined) delete process.env.SCOPE_HARNESS_BIN_OPENCODE;
    else process.env.SCOPE_HARNESS_BIN_OPENCODE = before;
  }
});

test("the override decides availability, and a broken override fails clearly", () => {
  const bin = fakeBin("claude");
  withClaudeBin(bin, () => {
    const info = chatHarnessList().find((h) => h.id === "claude");
    assert.equal(info.available, true);
    assert.equal(info.resolved, bin);
  });
  withClaudeBin(path.join(os.tmpdir(), "definitely-not-a-claude"), () => {
    const info = chatHarnessList().find((h) => h.id === "claude");
    assert.equal(info.available, false, "a configured-but-missing binary is not available");
    const launch = buildHarnessLaunch("claude", { prompt: "x" });
    assert.equal(launch.ok, false);
    assert.match(launch.error, /configured binary for Claude Code is not executable/);
  });
});

test("the built-in runner is not launched as an external CLI", () => {
  const launch = buildHarnessLaunch("pi", { prompt: "x" });
  assert.equal(launch.ok, false);
  assert.match(launch.error, /built-in chat runner/);
});

test("an unknown harness is a plan error, never a silent fallback to Pi", () => {
  const launch = buildHarnessLaunch("not-a-harness", { prompt: "x" });
  assert.equal(launch.ok, false);
  assert.match(launch.error, /unknown harness: not-a-harness/);
});

// ─── Workflow-defined harnesses ─────────────────────────────────────────────

test("custom harnesses from the Workflow settings are offered and launched", () => {
  const bin = fakeBin("deepseek-cli");
  const settings = normaliseHarnessSettings({
    userHarnesses: [{
      id: "deepseek-cli",
      label: "DeepSeek CLI",
      bin,
      args: "chat --prompt {prompt} --quiet",
      models: "deepseek-chat, deepseek-reasoner",
      modelFlag: "--model",
    }],
  });
  const info = chatHarnessList(settings).find((h) => h.id === "deepseek-cli");
  assert.ok(info, "a custom harness appears in the picker");
  assert.equal(info.label, "DeepSeek CLI");
  assert.equal(info.user, true);
  assert.equal(info.available, true);
  assert.deepEqual(info.models, ["deepseek-chat", "deepseek-reasoner"]);

  const launch = buildHarnessLaunch("deepseek-cli", { prompt: "hello world", model: "deepseek-chat" }, settings);
  assert.equal(launch.ok, true);
  assert.equal(launch.file, bin);
  // The prompt substitutes inside ONE argv element, then the model flag follows.
  assert.deepEqual(launch.args, ["chat", "--prompt", "hello world", "--quiet", "--model", "deepseek-chat"]);
});

test("a custom harness cannot shadow a built-in, and malformed entries are ignored", () => {
  const settings = normaliseHarnessSettings({
    userHarnesses: [
      { id: "claude", label: "Fake Claude", bin: "/nope/claude" },
      { id: "bad id!", label: "Bad", bin: "/nope/bad" },
      { id: "ok-cli", label: "", bin: "" },
    ],
  });
  assert.deepEqual(settings.userHarnesses, []);
  assert.equal(chatHarnessList(settings).filter((h) => h.id === "claude").length, 1);
});

test("a Workflow binary override decides which executable Chat runs", () => {
  const bin = fakeBin("claude");
  const settings = normaliseHarnessSettings({ bins: { claude: bin } });
  const info = chatHarnessList(settings).find((h) => h.id === "claude");
  assert.equal(info.resolved, bin);
  const launch = buildHarnessLaunch("claude", { prompt: "x" }, settings);
  assert.equal(launch.file, bin);
});

// ─── The CLI's own model list ───────────────────────────────────────────────

test("the CLI's model listing is parsed and cached", async () => {
  clearHarnessModelCache();
  const bin = fakeBin(
    "opencode",
    "#!/bin/sh\nprintf 'acme/coder\nacme/fast:free\n\nModels:\nnot a model\n'\n",
  );
  const settings = normaliseHarnessSettings({ bins: { opencode: bin } });
  const first = await discoverHarnessModels("opencode", settings);
  assert.deepEqual(first.models, ["acme/coder", "acme/fast:free"], "banners and prose are not models");
  assert.equal(first.source, "opencode models");

  // The cached answer is reused: rewriting the script does not change the list.
  fs.writeFileSync(bin, "#!/bin/sh\nprintf 'other/model\\n'\n", { mode: 0o755 });
  const cached = await discoverHarnessModels("opencode", settings);
  assert.deepEqual(cached.models, ["acme/coder", "acme/fast:free"]);

  clearHarnessModelCache();
  const refreshed = await discoverHarnessModels("opencode", settings);
  assert.deepEqual(refreshed.models, ["other/model"]);
});

test("a harness without a listing command falls back to its curated aliases", async () => {
  const result = await discoverHarnessModels("claude");
  assert.ok(result.models.includes("sonnet"));
  assert.equal(result.source, null);
});

test("a failing listing command reports why and is retried next time", async () => {
  clearHarnessModelCache();
  const bin = fakeBin("opencode", "#!/bin/sh\necho 'not signed in' >&2\nexit 3\n");
  const settings = normaliseHarnessSettings({ bins: { opencode: bin } });
  const failed = await discoverHarnessModels("opencode", settings);
  assert.deepEqual(failed.models, []);
  assert.match(failed.error, /exited with code 3/);
  assert.match(failed.error, /not signed in/);

  // A failure is not cached: fixing the CLI is picked up immediately.
  fs.writeFileSync(bin, "#!/bin/sh\nprintf 'acme/coder\\n'\n", { mode: 0o755 });
  const fixed = await discoverHarnessModels("opencode", settings);
  assert.deepEqual(fixed.models, ["acme/coder"]);
});
