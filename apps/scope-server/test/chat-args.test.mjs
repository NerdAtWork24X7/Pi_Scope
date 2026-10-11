// Unit tests for the chat subprocess argv (chat.ts).
//
// A caller may hand a chat session per-run capabilities — the Workflow plugin's
// Pi nodes pass the skills/tools/extensions picked in the node sidebar — and a
// caller that passes none must get exactly the argv the Chat view has always
// used, since that argv is what the whole app's conversations run on.
//
//   node --test apps/scope-server/test/chat-args.test.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { chatSpawnArgs } from "../chat.ts";

describe("chat spawn args", () => {
  test("a plain chat gets the long-standing argv", () => {
    assert.deepEqual(chatSpawnArgs("google/gemini-2.5-flash"), ["--mode", "rpc", "--model", "google/gemini-2.5-flash"]);
    assert.deepEqual(chatSpawnArgs("m", {}), ["--mode", "rpc", "--model", "m"]);
    assert.deepEqual(
      chatSpawnArgs("m", { skills: [], tools: [], extensions: [] }),
      ["--mode", "rpc", "--model", "m"],
      "empty selections add nothing",
    );
  });

  test("a node's capabilities map onto pi's own flags", () => {
    assert.deepEqual(
      chatSpawnArgs("m", {
        skills: ["/agent/skills/one", "/agent/skills/two"],
        tools: ["bash", "read"],
        extensions: ["/agent/extensions/demo/index.ts"],
      }),
      [
        "--mode", "rpc", "--model", "m",
        "--skill", "/agent/skills/one",
        "--skill", "/agent/skills/two",
        "--tools", "bash,read",
        "--extension", "/agent/extensions/demo/index.ts",
      ],
    );
  });

  test("each capability is independent", () => {
    assert.deepEqual(chatSpawnArgs("m", { tools: ["grep"] }), ["--mode", "rpc", "--model", "m", "--tools", "grep"]);
    assert.deepEqual(chatSpawnArgs("m", { skills: ["s"] }), ["--mode", "rpc", "--model", "m", "--skill", "s"]);
    assert.deepEqual(chatSpawnArgs("m", { extensions: ["e"] }), ["--mode", "rpc", "--model", "m", "--extension", "e"]);
  });
});
