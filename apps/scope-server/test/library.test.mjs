// Unit tests for the project reference library (library.ts): how a typed path
// is resolved, what survives a round trip through the config, and the block
// injected at the start of a conversation.
//
//   node --test apps/scope-server/test/library.test.mjs

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { LIBRARY_MAX_ENTRIES, buildLibraryPrompt, libraryGroups, normaliseEntries, resolveLibraryEntry } from "../library.ts";

let ws;

before(() => {
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-library-")));
  fs.mkdirSync(path.join(ws, "docs"));
  fs.writeFileSync(path.join(ws, "docs", "arch.md"), "# Arch\n");
  fs.writeFileSync(path.join(ws, "app.ts"), "export {};\n");
});
after(() => { if (ws) fs.rmSync(ws, { recursive: true, force: true }); });

describe("library", () => {
  test("a relative path is taken against the workspace and canonicalised", () => {
    const r = resolveLibraryEntry("docs/arch.md", "the API map", ws);
    assert.equal(r.ok, true);
    assert.equal(r.entry.path, path.join(ws, "docs", "arch.md"));
    assert.equal(r.entry.note, "the API map");
    assert.match(r.entry.id, /^lib_[0-9a-f]{10}$/, "entries get a stable id");
    // The same file, spelled absolutely, resolves to the same path — so the
    // library can dedupe on it.
    const again = resolveLibraryEntry(path.join(ws, "docs", "arch.md"), "", ws);
    assert.equal(again.ok, true);
    assert.equal(again.entry.path, r.entry.path);
  });

  test("a folder is stored with a trailing separator; a missing path is refused", () => {
    const dir = resolveLibraryEntry("docs", "", ws);
    assert.equal(dir.ok, true);
    assert.equal(dir.entry.path, path.join(ws, "docs") + path.sep, "a directory reads as a directory");

    const missing = resolveLibraryEntry("docs/nope.md", "", ws);
    assert.equal(missing.ok, false);
    assert.match(missing.error, /no such file or folder/);
    assert.equal(resolveLibraryEntry("   ", "", ws).ok, false);
    assert.equal(resolveLibraryEntry("docs/arch.md", "two\nlines", ws).ok, false, "notes are one line");
  });

  test("a reference can be assigned to one agent, and is kept per agent", () => {
    const r = resolveLibraryEntry("app.ts", "", ws, "builder");
    assert.equal(r.ok, true);
    assert.equal(r.entry.target, "builder");
    assert.equal(resolveLibraryEntry("app.ts", "", ws, "bad target!").ok, false, "targets are agent ids");

    // The same file may be listed for two agents — but never twice for one.
    const list = normaliseEntries([
      { id: "a", path: "/x/a.ts", target: "builder" },
      { id: "b", path: "/x/a.ts", target: "critic" },
      { id: "c", path: "/x/a.ts", target: "builder" },
    ]);
    assert.deepEqual(list.map((e) => e.target), ["builder", "critic"]);
  });

  test("stored entries are cleaned and de-duplicated", () => {
    const list = normaliseEntries([
      { id: "a", path: "/x/one.ts", note: "  trim me  " },
      { path: "/x/one.ts" },
      { path: "/x/two/" },
      null,
      { nope: 1 },
    ]);
    assert.equal(list.length, 2, "one duplicate and the junk are dropped");
    assert.equal(list[0].note, "trim me");
    assert.equal(list[1].path, "/x/two/");
    assert.equal(normaliseEntries("nonsense").length, 0);
    assert.equal(normaliseEntries(Array.from({ length: LIBRARY_MAX_ENTRIES + 5 }, (_, i) => ({ path: `/x/${i}` }))).length, LIBRARY_MAX_ENTRIES);
  });

  test("the injected block names every reference, and is empty when the library is", () => {
    assert.equal(buildLibraryPrompt([]), "");
    assert.equal(buildLibraryPrompt([{ path: "  " }]), "", "an unusable entry contributes nothing");

    const block = buildLibraryPrompt([
      { id: "a", path: "/ws/docs/arch.md", note: "the API map" },
      { id: "b", path: "/ws/src/" },
    ]);
    assert.match(block, /Session library/);
    assert.match(block, /For the whole team:/);
    assert.match(block, /^- \/ws\/docs\/arch\.md — the API map$/m);
    assert.match(block, /^- \/ws\/src\/$/m);
    assert.match(block, /not instructions/, "the block says where the paths came from");
  });

  test("the block says which agent each reference is for", () => {
    const block = buildLibraryPrompt([
      { id: "a", path: "/ws/shared.md" },
      { id: "b", path: "/ws/brief.md", target: "orchestrator", note: "the brief" },
      { id: "c", path: "/ws/api.ts", target: "builder" },
      { id: "d", path: "/ws/style.md", target: "critic" },
    ]);
    const lines = block.split("\n");
    // Whole team, then the orchestrator, then the subagents — each path under
    // the agent it was assigned to.
    assert.deepEqual(lines.slice(0, 7), [
      "[Session library — files and folders the user assigned for this workspace]",
      "For the whole team:",
      "- /ws/shared.md",
      "For orchestrator:",
      "- /ws/brief.md — the brief",
      "For builder:",
      "- /ws/api.ts",
    ]);
    assert.ok(lines.includes("For critic:"));
    assert.match(block, /pass it the references listed under its name/);

    const groups = libraryGroups([
      { path: "/b.ts", target: "critic" },
      { path: "/a.ts", target: "orchestrator" },
      { path: "/t.md" },
    ]);
    assert.deepEqual(groups.map((g) => g.label), ["For the whole team", "For orchestrator", "For critic"]);
  });
});
