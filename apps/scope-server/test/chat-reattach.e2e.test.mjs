// End-to-end tests for chat RUN RECOVERY against the REAL server with a stub
// `pi`: the state a browser needs after it lost its stream (a page reload, a
// view switch that reloads Chat, a second tab).
//
// A chat run is owned by the SERVER, not by the response stream that started it:
//   • GET /chat/status  — which sessions are working right now (and on what)
//   • GET /chat/attach  — replay a run from its first event, then stream it live
//   • POST /chat        — refuses a second prompt while one is in flight
//   • POST /chat/stop   — aborts the run even when no original reader is left
//
// The stub `pi` speaks the RPC protocol chat.ts expects: a prompt streams two
// deltas with a gap (so the test can abandon the stream mid-run), `SLOW` adds a
// second delay before settling, `UI` raises a host dialog and stays blocked
// until it is answered, and `abort` settles + exits.
//
//   node --test apps/scope-server/test/chat-reattach.e2e.test.mjs

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
const TOKEN = "chat-reattach-token";

const STUB = `#!/usr/bin/env node
let buf = "";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const delta = (t) => send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: t } });
process.stdin.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === "prompt") {
      const msg = String(ev.message || "");
      send({ type: "message_start", message: { role: "assistant" } });
      if (/UI/.test(msg)) {
        send({ type: "extension_ui_request", id: "ui-1", method: "select", title: "Pick one", options: ["1. alpha", "2. beta"] });
        continue; // blocked until the host answers
      }
      delta("alpha");
      if (/SLOW/.test(msg)) setTimeout(() => delta("beta"), 500);
      else delta("beta");
      setTimeout(() => send({ type: "agent_settled" }), /SLOW/.test(msg) ? 2500 : 200);
    } else if (ev.type === "extension_ui_response") {
      delta("answered");
    } else if (ev.type === "abort") {
      send({ type: "agent_settled" });
      process.exit(0);
    }
  }
});
`;

let child;
let base;
let ws;
let agentDir;
let pluginsDir;

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Start a run and hand back its live response + the session id it was given. */
async function startRun(prompt, sessionId) {
  const res = await fetch(`${base}/chat`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ cwd: ws, prompt, sessionId: sessionId || "", model: "google/gemini-2.5-flash-lite" }),
  });
  return res;
}

/** Read an NDJSON response into events, optionally stopping early (which
 *  abandons the stream exactly like a page reload does). */
async function readEvents(res, { until, timeoutMs = 8000 } = {}) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const events = [];
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { /* partial */ }
    }
    if (until && until(events)) { try { await reader.cancel(); } catch { /* gone */ } break; }
  }
  return events;
}

const texts = (events) => events.filter((e) => e.type === "text").map((e) => e.delta).join("");

async function status() {
  const { res, data } = await api("/chat/status");
  assert.ok(res.ok, "GET /chat/status answers");
  return data.runs || [];
}

async function until(fn, what, timeout = 10_000) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

before(async () => {
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-chat-reattach-")));
  agentDir = path.join(ws, "agent");
  pluginsDir = path.join(ws, "plugins");
  const stubDir = path.join(ws, "stub");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(stubDir, { recursive: true });
  const stubMjs = path.join(stubDir, "stub-pi.mjs");
  fs.writeFileSync(stubMjs, STUB);
  const wrapper = path.join(stubDir, "pi");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(stubMjs)} "$@"\n`);
  fs.chmodSync(wrapper, 0o755);

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      SCOPE_PORT: String(port), SCOPE_HOST: "127.0.0.1",
      SCOPE_DB_PATH: path.join(ws, "scope.db"), SCOPE_AUTH_TOKEN: TOKEN,
      SCOPE_PLUGINS_DIR: pluginsDir, SCOPE_FILE_ROOT: ws,
      SCOPE_AGENT_DIR: agentDir, SCOPE_PI_BIN: wrapper,
      SCOPE_MODEL_CATALOG: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  await waitForHealth();
});

after(async () => {
  if (child) { child.kill("SIGKILL"); await new Promise((r) => child.once("exit", r)); }
  if (ws) fs.rmSync(ws, { recursive: true, force: true });
});

describe("chat run recovery", () => {
  test("a run abandoned by its reader is still reported, and a late reader replays it", async () => {
    // The browser starts a turn, then reloads: its fetch is cancelled while pi
    // keeps working. The server must keep the run (and its events) so the new
    // page can pick it up.
    const res = await startRun("SLOW one", "sess-replay");
    const early = await readEvents(res, { until: (evs) => evs.some((e) => e.type === "text") });
    assert.equal(texts(early), "alpha", "the reader saw the first delta before abandoning the stream");

    const run = (await status()).find((r) => r.sessionId === "sess-replay");
    assert.ok(run, "the abandoned run is still reported by /chat/status");
    assert.equal(run.active, true, "and it is marked as working");
    assert.equal(run.cwd, ws);
    assert.equal(run.prompt, "SLOW one", "the prompt that started it travels with the run");

    // The returning page attaches: everything emitted before the abandon is
    // replayed, then the run streams on to its end.
    const attach = await fetch(`${base}/chat/attach?sessionId=sess-replay`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(attach.status, 200);
    assert.match(attach.headers.get("content-type") || "", /ndjson/);
    const events = await readEvents(attach);
    assert.equal(texts(events), "alphabeta", "the replay + live tail make the whole turn");
    assert.ok(events.some((e) => e.type === "done" && e.sessionId === "sess-replay"), "the attach stream ends with done");

    const after = (await status()).find((r) => r.sessionId === "sess-replay");
    assert.equal(after.active, false, "the run is no longer active once it settled");
  });

  test("one prompt at a time: a second prompt during a run is refused", async () => {
    const res = await startRun("SLOW two", "sess-busy");
    await readEvents(res, { until: (evs) => evs.some((e) => e.type === "text") });

    const second = await startRun("a second prompt", "sess-busy");
    assert.equal(second.status, 409, "the second prompt is refused while the first is in flight");
    const body = await second.json();
    assert.match(body.error, /already running/);

    // Without a session id it targets the pre-spawn/new conversation instead —
    // unaffected by the busy session above.
    const stop = await api("/chat/stop", { method: "POST", body: JSON.stringify({ sessionId: "sess-busy" }) });
    assert.equal(stop.data.ok, true);
    await until(async () => {
      const r = (await status()).find((x) => x.sessionId === "sess-busy");
      return !r || !r.active;
    }, "the run to settle after the stop");
  });

  test("attaching after the run finished answers 409 instead of hanging", async () => {
    const res = await startRun("a quick one", "sess-done");
    const events = await readEvents(res);
    assert.equal(texts(events), "alphabeta");
    await sleep(150); // the subprocess settles (the run may still be in flight)

    await until(async () => {
      const r = (await status()).find((x) => x.sessionId === "sess-done");
      return r && r.active === false;
    }, "the quick run to settle");

    const attach = await fetch(`${base}/chat/attach?sessionId=sess-done`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(attach.status, 409, "nothing to attach to");
    const body = await attach.json();
    assert.equal(body.active, false);

    const missing = await fetch(`${base}/chat/attach?sessionId=never-existed`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(missing.status, 409, "an unknown session answers the same way");
    const bad = await fetch(`${base}/chat/attach`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(bad.status, 400, "a missing sessionId is a bad request");
  });

  test("an attached run can be stopped (the Stop button after a reload)", async () => {
    const res = await startRun("SLOW three", "sess-stop");
    await readEvents(res, { until: (evs) => evs.some((e) => e.type === "text") });

    const attach = await fetch(`${base}/chat/attach?sessionId=sess-stop`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(attach.status, 200);
    // Read the replay, then stop the run the way the Stop button does.
    const reader = attach.body.getReader();
    const dec = new TextDecoder();
    let seen = "";
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += dec.decode(value, { stream: true });
      if (seen.includes("alpha") && !seen.includes("done")) {
        const stop = await api("/chat/stop", { method: "POST", body: JSON.stringify({ sessionId: "sess-stop" }) });
        assert.equal(stop.data.ok, true, "the attached run was found and stopped");
        break;
      }
    }
    // Everything the reader was still owed arrives on the same stream.
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += dec.decode(value, { stream: true });
    }
    assert.match(seen, /"type":"done"/, "the attach stream is closed by the abort");
    assert.match(seen, /"aborted":true/, "and reports the abort the Stop button caused");
    const run = (await status()).find((r) => r.sessionId === "sess-stop");
    assert.ok(!run || !run.active, "the stopped run is no longer active");
  });

  test("a question pi is blocked on survives the attach; an answered one is not replayed", async () => {
    const res = await startRun("UI question", "sess-ui");
    await readEvents(res, { until: (evs) => evs.some((e) => e.type === "ui_select") });

    // A page that reloads while pi waits for an answer must still get the card.
    const first = await fetch(`${base}/chat/attach?sessionId=sess-ui`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const ev1 = await readEvents(first, { until: (evs) => evs.some((e) => e.type === "ui_open") || evs.some((e) => e.type === "done") });
    const open = ev1.find((e) => e.type === "ui_open");
    assert.ok(open, "the open question is replayed as ui_open");
    assert.equal(open.dlg.id, "ui-1");
    assert.equal(open.dlg.type, "ui_select");
    assert.deepEqual(open.dlg.options, ["1. alpha", "2. beta"]);

    // Answer it: pi continues, and the question is gone for the next attach.
    const answered = await api("/chat/ui", {
      method: "POST",
      body: JSON.stringify({ sessionId: "sess-ui", id: "ui-1", value: "1. alpha" }),
    });
    assert.equal(answered.data.ok, true);

    const second = await fetch(`${base}/chat/attach?sessionId=sess-ui`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(second.status, 200, "the run is still alive after the answer");
    const ev2 = await readEvents(second, {
      until: (evs) => evs.some((e) => e.type === "text" && e.delta === "answered"),
    });
    assert.ok(!ev2.some((e) => e.type === "ui_open"), "the answered question is not replayed");
    assert.ok(ev2.some((e) => e.type === "ui_select" && e.replayed === undefined) === false, "and neither is its original request");

    await api("/chat/stop", { method: "POST", body: JSON.stringify({ sessionId: "sess-ui" }) });
  });
});
