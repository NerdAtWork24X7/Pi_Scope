// End-to-end tests for the project reference library: the meeting-room panel's
// two writes, and the block injected at the START of a fresh conversation.
//
// The server is run for real against a temporary workspace; `SCOPE_PI_BIN`
// points at a stub "pi" that records every RPC line it receives on stdin, so the
// prompt the agent would actually see can be asserted exactly — no model, no
// network.
//
//   node --test apps/scope-server/test/library.e2e.test.mjs

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const SERVER = path.join(ROOT, "apps", "scope-server", "server.ts");
const TOKEN = "library-test-token";

let child;
let base;
let ws;
let agentDir;
let promptLog;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not become healthy");
}

async function api(pathname, init = {}) {
  const res = await fetch(`${base}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers || {}) },
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { res, data };
}

const post = (body) => api("/agent-team", { method: "POST", body: JSON.stringify({ ...body, cwd: ws }) });
const snapshot = async () => (await api(`/agent-team?cwd=${encodeURIComponent(ws)}`)).data;

/** The RPC lines the stub pi received, parsed. */
function rpcLines() {
  try {
    return fs.readFileSync(promptLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
const prompts = () => rpcLines().filter((l) => l.type === "prompt").map((l) => String(l.message || ""));

/** Drive one chat turn and return the session id the server announced. */
async function chat(body) {
  const res = await fetch(`${base}/chat`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ cwd: ws, prompt: "hello there", ...body }),
  });
  assert.equal(res.status, 200, `POST /chat → ${res.status}`);
  const text = await res.text();
  const first = text.split("\n").find((l) => l.trim());
  const ev = first ? JSON.parse(first) : {};
  assert.equal(ev.type, "session", "the stream opens by naming the session");
  return ev.sessionId;
}

before(async () => {
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-library-e2e-")));
  agentDir = path.join(ws, "agent");
  fs.mkdirSync(path.join(ws, "docs"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
  fs.writeFileSync(path.join(ws, "docs", "arch.md"), "# Arch\n");
  fs.writeFileSync(path.join(ws, "app.ts"), "export {};\n");
  promptLog = path.join(ws, "rpc.jsonl");

  // A stub pi: record every RPC line, answer commands, and settle each prompt so
  // the chat turn completes (and the session can take another prompt).
  const stub = path.join(ws, "stub-pi.mjs");
  fs.writeFileSync(stub, [
    'import * as fs from "node:fs";',
    "let buf = \"\";",
    'process.stdin.on("data", (chunk) => {',
    "  buf += chunk.toString();",
    "  let i;",
    '  while ((i = buf.indexOf("\\n")) >= 0) {',
    "    const line = buf.slice(0, i);",
    "    buf = buf.slice(i + 1);",
    "    if (!line.trim()) continue;",
    '    fs.appendFileSync(process.env.STUB_LOG, line + "\\n");',
    "    let ev = {};",
    '    try { ev = JSON.parse(line); } catch { continue; }',
    '    if (ev.type === "prompt") {',
    '      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");',
    "    } else {",
    '      process.stdout.write(JSON.stringify({ type: "response", command: ev.type, success: true }) + "\\n");',
    "    }",
    "  }",
    "});",
    "setInterval(() => {}, 60_000);",
    "",
  ].join("\n"));
  const bin = path.join(ws, "fake-pi");
  fs.writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(stub)}\n`);
  fs.chmodSync(bin, 0o755);

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      SCOPE_PORT: String(port),
      SCOPE_HOST: "127.0.0.1",
      SCOPE_DB_PATH: path.join(ws, "scope.db"),
      SCOPE_AUTH_TOKEN: TOKEN,
      SCOPE_PLUGINS_DIR: path.join(ws, "plugins"),
      // /chat only accepts a cwd inside the file root (or a known workspace).
      SCOPE_FILE_ROOT: ws,
      SCOPE_AGENT_DIR: agentDir,
      SCOPE_PI_BIN: bin,
      STUB_LOG: promptLog,
      PI_OFFLINE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  await waitForHealth();
});

after(async () => {
  if (child) {
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
  }
  if (ws) fs.rmSync(ws, { recursive: true, force: true });
});

describe("reference library", () => {
  test("entries are added by relative or absolute path, de-duplicated, and removed by id", async () => {
    assert.deepEqual((await snapshot()).library, [], "the library starts empty");

    // A relative path is resolved against the workspace, for the agent named.
    assert.ok((await post({ action: "addLibraryEntry", path: "docs/arch.md", note: "the API map", target: "critic" })).res.ok);
    let lib = (await snapshot()).library;
    assert.equal(lib.length, 1);
    assert.equal(lib[0].path, path.join(ws, "docs", "arch.md"));
    assert.equal(lib[0].note, "the API map");

    // The same file for the same agent, spelled absolutely, is the same entry —
    // and a new note updates it.
    assert.ok((await post({ action: "addLibraryEntry", path: path.join(ws, "docs", "arch.md"), note: "updated", target: "critic" })).res.ok);
    lib = (await snapshot()).library;
    assert.equal(lib.length, 1, "the same file cannot be listed twice for one agent");
    assert.equal(lib[0].note, "updated");
    assert.equal(lib[0].target, "critic");

    // …but the same file may be listed for another agent.
    assert.ok((await post({ action: "addLibraryEntry", path: "docs/arch.md", target: "builder" })).res.ok);
    lib = (await snapshot()).library;
    assert.equal(lib.length, 2);
    assert.equal(lib[1].target, "builder");

    // A folder is stored as a folder (no target = the whole team).
    assert.ok((await post({ action: "addLibraryEntry", path: "docs" })).res.ok);
    lib = (await snapshot()).library;
    assert.equal(lib.length, 3);
    assert.equal(lib[2].path, path.join(ws, "docs") + path.sep);
    assert.equal(lib[2].target, undefined);

    // A row can be reassigned to another agent, or to the whole team.
    assert.ok((await post({ action: "setLibraryEntry", id: lib[0].id, target: "orchestrator", note: "the brief" })).res.ok);
    lib = (await snapshot()).library;
    const moved = lib.find((e) => e.path === path.join(ws, "docs", "arch.md") && e.target === "orchestrator");
    assert.ok(moved, "the reference moved to the orchestrator");
    assert.equal(moved.note, "the brief");
    assert.equal(
      (await post({ action: "setLibraryEntry", id: moved.id, target: "not valid!", note: "" })).res.status,
      400,
      "only agent ids are accepted as targets",
    );
    assert.equal((await post({ action: "setLibraryEntry", id: "lib_nope", target: "builder", note: "" })).res.status, 404);
    // Reassigning onto a file+agent that is already listed merges the two rows.
    assert.ok((await post({ action: "setLibraryEntry", id: moved.id, target: "builder" })).res.ok);
    lib = (await snapshot()).library;
    assert.equal(lib.filter((e) => e.path === path.join(ws, "docs", "arch.md")).length, 1, "the duplicate row merged away");
    assert.equal(lib.find((e) => e.path === path.join(ws, "docs", "arch.md")).target, "builder");

    // A path that does not exist is refused rather than stored.
    const missing = await post({ action: "addLibraryEntry", path: "docs/nope.md" });
    assert.equal(missing.res.status, 400);
    assert.match(missing.data.error, /no such file or folder/);
    assert.equal((await snapshot()).library.length, 2, "nothing was stored");

    // Remove by id: only that entry goes.
    const removed = await post({ action: "removeLibraryEntry", id: lib[1].id });
    assert.ok(removed.res.ok);
    const left = (await snapshot()).library;
    assert.deepEqual(left.map((e) => e.path), [path.join(ws, "docs", "arch.md")]);
  });

  test("the library is injected at the start of a fresh conversation — and only there", async () => {
    // One reference with a note, so the injected block has something to name.
    assert.ok((await post({ action: "addLibraryEntry", path: "app.ts", note: "entry point" })).res.ok);
    const before = prompts().length;

    const sid = await chat({ prompt: "hello there" });
    let sent = prompts();
    assert.equal(sent.length, before + 1, "the stub received exactly one prompt");
    const first = sent[sent.length - 1];
    const app = path.join(ws, "app.ts").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(first, /^\[Session library — files and folders the user assigned for this workspace\]/, "the block opens the message");
    // Grouped by the agent each reference is for: the whole team first, then
    // the subagent it was assigned to.
    assert.match(first, new RegExp(`^For the whole team:\n- ${app} — entry point$`, "m"));
    assert.match(first, /^For builder:\n- .*docs\/arch\.md$/m);
    assert.match(first, /pass it the references listed under its name/);
    assert.ok(first.endsWith("hello there"), "the user's own message is still last");

    // A second turn in the same conversation: no repeat.
    await chat({ sessionId: sid, prompt: "and again" });
    assert.equal(prompts().pop(), "and again", "the second turn is the user's text alone");

    // Continuing a recorded session: the block was already delivered when that
    // conversation started, so a resume must not re-inject it.
    await chat({ sessionId: sid, sessionFile: path.join(ws, "recorded.jsonl"), prompt: "resumed" });
    assert.equal(prompts().pop(), "resumed");

    // Starting a NEW conversation on the same subprocess: injected again.
    await chat({ sessionId: sid, prompt: "fresh conversation" });
    assert.match(prompts().pop(), /^\[Session library —/, "a new conversation gets the library again");
  });
});
