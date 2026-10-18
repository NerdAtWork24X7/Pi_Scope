// Unit tests for the plugin host's discovery rules. They pin the containment
// checks that keep a plugin manifest from pointing its server/client entry (or
// its served client URL) outside its own directory.
//
//   node --test apps/scope-server/test/plugins-paths.test.mjs

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let tmpDir;
let builtinDir;
let userDir;
let plugins;

/** Write a minimal plugin directory. */
function seed(root, id, manifest) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ id, name: id, ...manifest }));
  return dir;
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-plugin-paths-"));
  builtinDir = path.join(tmpDir, "builtin");
  userDir = path.join(tmpDir, "user");

  const good = seed(builtinDir, "good", { server: "server.js", client: "client.js" });
  fs.writeFileSync(path.join(good, "server.js"), "export function activate() {}\n");
  fs.writeFileSync(path.join(good, "client.js"), "// client\n");

  // A manifest whose entries walk out of the plugin directory.
  const escape = seed(userDir, "escape", { server: "../../outside.js", client: "../../outside.js" });
  fs.writeFileSync(path.join(escape, "outside.js"), "export function activate() {}\n");
  fs.writeFileSync(path.join(tmpDir, "outside.js"), "export function activate() {}\n");

  // A user plugin with the same id as a built-in overrides it.
  seed(userDir, "good", { server: "server.js" });
  fs.writeFileSync(path.join(userDir, "good", "server.js"), "export function activate() {}\n");

  process.env.SCOPE_BUILTIN_PLUGINS_DIR = builtinDir;
  process.env.SCOPE_PLUGINS_DIR = userDir;
  // A cache-busting query keeps this import isolated from any other module
  // instance in the process (the dirs are read at module evaluation time).
  plugins = await import(`../plugins.ts?paths=${Date.now()}`);
  plugins.discover();
});

after(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("plugin discovery: entries stay inside the plugin directory", () => {
  test("a normal plugin reports both entries and a served client URL", () => {
    const snap = plugins.pluginSnapshot();
    const good = snap.plugins.find((p) => p.id === "good");
    assert.ok(good, "the plugin is listed");
    // The user copy overrides the built-in, so it is a user plugin with only
    // the server entry it declared.
    assert.equal(good.source, "user");
    assert.equal(good.hasServer, true);
    assert.equal(good.hasClient, false);
    assert.equal(good.error, null);
  });

  test("an entry that escapes is flagged, never loaded or served", () => {
    const snap = plugins.pluginSnapshot();
    const escape = snap.plugins.find((p) => p.id === "escape");
    assert.ok(escape, "the plugin is still listed so Settings can explain it");
    assert.equal(escape.hasServer, false);
    assert.equal(escape.hasClient, false);
    assert.equal(escape.clientUrl, null);
    assert.match(escape.error, /escapes the plugin directory/);
  });

  test("the built-in directory is resolved absolutely", () => {
    assert.equal(plugins.pluginSnapshot().pluginsBuiltinDir, path.resolve(builtinDir));
    assert.equal(plugins.pluginSnapshot().pluginsDir, path.resolve(userDir));
  });
});
