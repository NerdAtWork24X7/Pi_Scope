// Unit tests for the read-only Workflow-harness settings reader.
//
//   node --test apps/scope-server/test/workflow-harness-settings.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { workflowHarnessSettings, workflowHarnessStorePath } from "../workflow-harness-settings.ts";

function withStore(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-workflow-store-"));
  const file = path.join(dir, "subagent-workflow.json");
  if (content !== null) fs.writeFileSync(file, JSON.stringify(content));
  const before = process.env.SCOPE_WORKFLOW_STORE;
  process.env.SCOPE_WORKFLOW_STORE = file;
  try {
    return fn(file);
  } finally {
    if (before === undefined) delete process.env.SCOPE_WORKFLOW_STORE;
    else process.env.SCOPE_WORKFLOW_STORE = before;
  }
}

test("a missing Workflow store means no customisations", () => {
  withStore(null, () => {
    assert.deepEqual(workflowHarnessSettings(), { bins: {}, userHarnesses: [] });
  });
});

test("the Workflow harness bins and custom harnesses reach Chat", () => {
  withStore({
    harnessBins: { claude: "/opt/claude/bin/claude" },
    userHarnesses: [{
      id: "deepseek-cli",
      label: "DeepSeek CLI",
      bin: "/opt/deepseek/bin/deepseek",
      args: "chat {prompt}",
      models: ["deepseek-chat"],
      modelFlag: "--model",
    }],
  }, () => {
    const settings = workflowHarnessSettings();
    assert.deepEqual(settings.bins, { claude: "/opt/claude/bin/claude" });
    assert.equal(settings.userHarnesses.length, 1);
    assert.equal(settings.userHarnesses[0].id, "deepseek-cli");
    assert.equal(settings.userHarnesses[0].label, "DeepSeek CLI");
    assert.deepEqual(settings.userHarnesses[0].models, ["deepseek-chat"]);
  });
});

test("a store written after the server started is read on the next call", () => {
  withStore({ userHarnesses: [{ id: "one-cli", label: "One", bin: "/bin/one" }] }, (file) => {
    assert.equal(workflowHarnessSettings().userHarnesses[0].id, "one-cli");
    fs.writeFileSync(file, JSON.stringify({
      userHarnesses: [{ id: "two-cli", label: "Two", bin: "/bin/two" }],
    }));
    assert.equal(workflowHarnessSettings().userHarnesses[0].id, "two-cli");
  });
});

test("a store with a reserved or malformed harness is sanitised, not trusted", () => {
  withStore({
    userHarnesses: [
      { id: "claude", label: "Shadow Claude", bin: "/bin/fake" },
      { id: "no-bin", label: "No binary" },
    ],
  }, () => {
    assert.deepEqual(workflowHarnessSettings().userHarnesses, []);
  });
});

test("the store path follows SCOPE_PLUGINS_DIR unless explicitly overridden", () => {
  const beforePlugins = process.env.SCOPE_PLUGINS_DIR;
  const beforeStore = process.env.SCOPE_WORKFLOW_STORE;
  try {
    delete process.env.SCOPE_WORKFLOW_STORE;
    process.env.SCOPE_PLUGINS_DIR = "/tmp/custom-plugins";
    assert.equal(
      workflowHarnessStorePath(),
      path.join("/tmp/custom-plugins", ".data", "subagent-workflow.json"),
    );
    process.env.SCOPE_WORKFLOW_STORE = "/tmp/other-store.json";
    assert.equal(workflowHarnessStorePath(), "/tmp/other-store.json");
  } finally {
    if (beforePlugins === undefined) delete process.env.SCOPE_PLUGINS_DIR;
    else process.env.SCOPE_PLUGINS_DIR = beforePlugins;
    if (beforeStore === undefined) delete process.env.SCOPE_WORKFLOW_STORE;
    else process.env.SCOPE_WORKFLOW_STORE = beforeStore;
  }
});
