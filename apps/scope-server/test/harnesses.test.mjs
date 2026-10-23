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
  refreshHarnessModels,
} from "../harnesses.ts";
import {
  parseAcpModels,
  parseClaudeModels,
  parseCodexModels,
} from "../harness-model-discovery.ts";

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

test("each print-mode harness appends its own model flag", () => {
  const cases = [
    { id: "claude", model: "sonnet", args: ["-p", "x", "--model", "sonnet"] },
    { id: "codex", model: "gpt-5", args: ["exec", "--skip-git-repo-check", "x", "--model", "gpt-5"] },
    { id: "aider", model: "gpt-5", args: ["--yes", "--message", "x", "--model", "gpt-5"] },
    { id: "cursor", model: "sonnet-4", args: ["-p", "x", "--model", "sonnet-4"] },
  ];
  for (const c of cases) {
    const key = `SCOPE_HARNESS_BIN_${c.id.toUpperCase()}`;
    const before = process.env[key];
    const bin = fakeBin(c.id === "cursor" ? "cursor-agent" : c.id);
    process.env[key] = bin;
    try {
      const launch = buildHarnessLaunch(c.id, { prompt: "x", model: c.model });
      assert.equal(launch.ok, true, `${c.id} launch: ${launch.error || ""}`);
      assert.deepEqual(launch.args, c.args, `${c.id} must carry the selected model`);
    } finally {
      if (before === undefined) delete process.env[key];
      else process.env[key] = before;
    }
  }
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

test("a forced refresh bypasses the cache and re-asks every installed harness", async () => {
  clearHarnessModelCache();
  const bin = fakeBin("opencode", "#!/bin/sh\nprintf 'acme/one\\n'\n");
  const settings = normaliseHarnessSettings({ bins: { opencode: bin } });
  const first = await discoverHarnessModels("opencode", settings);
  assert.deepEqual(first.models, ["acme/one"]);

  fs.writeFileSync(bin, "#!/bin/sh\nprintf 'acme/two\\n'\n", { mode: 0o755 });
  // The ordinary read still answers from the cache…
  assert.deepEqual((await discoverHarnessModels("opencode", settings)).models, ["acme/one"]);
  // …while a forced read asks the CLI again (what Settings → Models does).
  assert.deepEqual((await discoverHarnessModels("opencode", settings, { force: true })).models, ["acme/two"]);

  // A whole-catalogue refresh clears every cached list, so the next read for any
  // harness is fresh too — not just the one that was forced.
  fs.writeFileSync(bin, "#!/bin/sh\nprintf 'acme/three\\n'\n", { mode: 0o755 });
  // Make every other harness unavailable, so the refresh is deterministic and
  // never spawns a real CLI on the machine running the tests.
  const others = ["kilo", "cursor", "claude", "codex", "gemini", "cline"];
  const saved = Object.fromEntries(others.map((id) => [id, process.env[`SCOPE_HARNESS_BIN_${id.toUpperCase()}`]]));
  for (const id of others) process.env[`SCOPE_HARNESS_BIN_${id.toUpperCase()}`] = path.join(os.tmpdir(), `scope-missing-${id}`);
  try {
    const all = await refreshHarnessModels(settings);
    const opencode = all.find((h) => h.id === "opencode");
    assert.ok(opencode, "the installed CLI is part of the refresh");
    assert.deepEqual(opencode.models, ["acme/three"], "the refreshed list is the CLI's current one");
    assert.equal(opencode.source, "opencode models");
    assert.equal(all.some((h) => h.id === "pi"), false, "pi's models come from the provider catalog, not a CLI");
    assert.deepEqual((await discoverHarnessModels("opencode", settings)).models, ["acme/three"],
      "the freshly asked list is what the normal read serves afterwards");
  } finally {
    for (const id of others) {
      const key = `SCOPE_HARNESS_BIN_${id.toUpperCase()}`;
      if (saved[id] === undefined) delete process.env[key];
      else process.env[key] = saved[id];
    }
  }
});

test("the protocol-backed harnesses publish the models they actually offer", () => {
  // Claude's initialize response uses `value` as the alias `--model` accepts.
  assert.deepEqual(
    parseClaudeModels({ models: [
      { value: "default", resolvedModel: "claude-opus-5-5" },
      { value: "opus", resolvedModel: "claude-opus-5-5" },
      { value: "sonnet", resolvedModel: "claude-sonnet-5-5" },
      { value: "sonnet", resolvedModel: "duplicate" },
    ] }),
    ["opus", "sonnet"],
    "the default pseudo-model is dropped and duplicates are removed",
  );
  assert.equal(parseClaudeModels({}), null, "a response without models is not an empty catalogue");

  // Codex's app-server model/list marks models hidden when they must not be offered.
  assert.deepEqual(
    parseCodexModels({ data: [
      { id: "gpt-6.1-sol" },
      { id: "gpt-6-astra", hidden: true },
      { model: "o4-mini" },
      { id: "gpt-6.1-sol" },
    ] }),
    ["gpt-6.1-sol", "o4-mini"],
  );
  assert.equal(parseCodexModels({}), null);

  // ACP session/new carries `models.availableModels`.
  assert.deepEqual(
    parseAcpModels({ models: { availableModels: [
      { modelId: "auto", name: "Auto" },
      { modelId: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
      { modelId: "auto", name: "Auto again" },
    ] } }),
    ["auto", "gemini-3.8-flash"],
  );
  assert.equal(parseAcpModels({ modes: {} }), null);
});

test("a harness with no listing command and no protocol keeps its aliases", async () => {
  const aider = chatHarness("aider");
  assert.ok(aider);
  assert.equal(aider.modelsVia, undefined);
  const result = await discoverHarnessModels("aider");
  assert.deepEqual(result.models, aider.models, "Aider publishes no catalogue to ask for");
  assert.equal(result.source, null);
});

test("a missing protocol-backed harness reports why instead of faking a live list", async () => {
  clearHarnessModelCache();
  const settings = normaliseHarnessSettings({
    bins: { claude: path.join(os.tmpdir(), "scope-missing-claude") },
  });
  const result = await discoverHarnessModels("claude", settings);
  assert.deepEqual(result.models, []);
  assert.equal(result.source, "claude initialize");
  assert.match(result.error, /not found/);
});

test("a protocol-backed harness that exits early is an error, not a server crash", async () => {
  clearHarnessModelCache();
  const bin = fakeBin("claude", "#!/bin/sh\nexit 0\n");
  const settings = normaliseHarnessSettings({ bins: { claude: bin } });
  const result = await discoverHarnessModels("claude", settings, { force: true, timeoutMs: 3000 });
  assert.deepEqual(result.models, []);
  assert.equal(result.source, "claude initialize");
  assert.match(result.error, /exited before answering/);
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
