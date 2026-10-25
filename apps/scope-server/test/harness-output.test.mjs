// Unit tests for the answer/reasoning splitter (Cline paints its thinking dim).
//
//   node --test apps/scope-server/test/harness-output.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { createThinkingSplitter } from "../harness-output.ts";

/** Feed every chunk and merge what came back, in order. */
function run(chunks) {
  const split = createThinkingSplitter();
  const out = { text: "", thinking: "" };
  for (const chunk of chunks) {
    const part = split.feed(chunk);
    out.text += part.text;
    out.thinking += part.thinking;
  }
  const tail = split.flush();
  out.text += tail.text;
  out.thinking += tail.thinking;
  return out;
}

const DIM = "\u001b[2m";
const RESET = "\u001b[0m";

test("Cline's dim reasoning becomes thinking, the answer stays text", () => {
  const out = run([
    `${DIM}[thinking] ${RESET}`,
    `${DIM}The user asked a simple question.${RESET}`,
    "\nA for loop repeats a block.\n",
  ]);
  assert.equal(out.thinking, "The user asked a simple question.");
  assert.equal(out.text, "A for loop repeats a block.\n",
    "the blank line Cline leaves before the answer is not part of it");
});

test("per-word dim chunks are stitched into one reasoning block", () => {
  const out = run([
    `${DIM}[thinking] ${RESET}`,
    `${DIM}The${RESET}${DIM} user${RESET}${DIM} wants${RESET}`,
    `${DIM} OK${RESET}`,
    "OK\n",
  ]);
  assert.equal(out.thinking, "The user wants OK");
  assert.equal(out.text, "OK\n");
});

test("an escape sequence cut across chunks still toggles the lane", () => {
  const out = run(["\u001b", "[2m", "[thinking] ", "half a thought", "\u001b[0", "m", "answer"]);
  assert.equal(out.thinking, "half a thought");
  assert.equal(out.text, "answer");
});

test("an unstyled stream is all answer", () => {
  // No dim attribute means no way to tell reasoning from the answer: nothing is
  // invented, the text is shown as the CLI wrote it.
  const out = run(["[thinking] ", "plain reasoning\n", "the answer\n"]);
  assert.equal(out.thinking, "");
  assert.equal(out.text, "[thinking] plain reasoning\nthe answer\n");
});

test("a stream with no reasoning is passed through untouched", () => {
  const out = run(["just an answer, in two parts", ".\n"]);
  assert.equal(out.thinking, "");
  assert.equal(out.text, "just an answer, in two parts.\n");
});
