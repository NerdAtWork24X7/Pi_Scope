// End-to-end tests for the mobile layout.
//
// Pi Scope is a desktop-first dashboard, but a phone that pairs over the LAN
// should not get a 26k-line bundle rendered into a 390px viewport. The server
// resolves the DOCUMENT (server.ts → wantsMobileDocument): `/m` is the mobile
// entry the QR points at, `/` follows an explicit `ui=` override, a Client Hint
// or the User-Agent, and `/index.html` stays the desktop app.
//
// These tests run the REAL server against a stub `pi` and drive a REAL browser
// with a phone viewport + UA:
//
//   • which document each entry point gets (and that the phone never downloads
//     the desktop bundle: no xterm, no desktop shell),
//   • the sessions drawer, transcript and deep link,
//   • sending a prompt and streaming the reply into the phone bubble,
//   • Stop aborting a run,
//   • answering a question pi is blocked on,
//   • the escape hatch back to the desktop UI,
//   • the QR URL the pairing panel encodes.
//
//   node --test apps/scope-server/test/mobile.e2e.test.mjs

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const SERVER = path.join(ROOT, "apps", "scope-server", "server.ts");
const TOKEN = "mobile-test-token";
const enc = encodeURIComponent;

// An iPhone-ish UA. Chromium refuses to send Client Hints for a UA it did not
// set itself, so this is exactly the "hand-typed URL" path the server must
// still resolve — the QR path is covered by the `ui=mobile` URL it carries.
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

// Samsung Internet is Chromium-based, so Chromium with this UA plus a touch
// pointer is the right proxy for the Android phones that reach this server.
const SAMSUNG_UA =
  "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36";

// The same stub `pi` the chat-reattach suite uses: `prompt` streams two deltas
// (`SLOW` inserts a gap so a run can be abandoned/stopped mid-flight), `UI`
// raises a host dialog and stays blocked until it is answered, `abort` settles.
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
      if (/TOOLS/.test(msg)) {
        // A tool turn: thinking first, then a tool call, then the text — plus
        // token usage. Exercises the phone's live thinking/tool/usage rows.
        send({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "weighing options" }, usage: { total_tokens: 42, cost_total: 0.0012 } });
        send({ type: "tool_execution_start", toolName: "read_file", args: { path: "src/a.ts" } });
        send({ type: "tool_execution_end", toolName: "read_file" });
        delta("all done");
        setTimeout(() => send({ type: "agent_settled" }), 150);
        continue;
      }
      if (/NOTIFY/.test(msg)) {
        // A fire-and-forget host notification mid-run. pi raises it as an
        // extension_ui_request with method "notify"; the server forwards it as
        // ui_notify — the one path that paints the coral warning state.
        send({ type: "extension_ui_request", id: "ui-n1", method: "notify", message: "context is 92% full", notifyType: "warning" });
        delta("noted");
        setTimeout(() => send({ type: "agent_settled" }), 150);
        continue;
      }
      delta("alpha");
      if (/SLOW/.test(msg)) setTimeout(() => delta("beta"), 3000);
      else delta("beta");
      setTimeout(() => send({ type: "agent_settled" }), /SLOW/.test(msg) ? 8000 : 200);
    } else if (ev.type === "switch_session" || ev.type === "new_session") {
      // pi confirms a session swap before the queued prompt is written.
      send({ type: "response", command: ev.type, success: true });
    } else if (ev.type === "extension_ui_response") {
      delta("answered");
    } else if (ev.type === "abort") {
      send({ type: "agent_settled" });
      process.exit(0);
    }
  }
});
`;

let browser;
let child;
let base;
let tmpDir;
let agentDir;

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

/** Fetch a document with an explicit UA and cookie-free headers. */
async function doc(pathname, { ua, hints } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    headers: { ...(ua ? { "user-agent": ua } : {}), ...(hints || {}) },
    redirect: "manual",
  });
  return { res, body: await res.text() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-mobile-")));
  agentDir = path.join(tmpDir, "agent");
  const stubDir = path.join(tmpDir, "stub");
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
      SCOPE_PORT: String(port),
      SCOPE_HOST: "127.0.0.1",
      SCOPE_DB_PATH: path.join(tmpDir, "scope.db"),
      SCOPE_AUTH_TOKEN: TOKEN,
      SCOPE_PLUGINS_DIR: path.join(tmpDir, "plugins"),
      SCOPE_AGENT_DIR: agentDir,
      SCOPE_SETTINGS_JSON: path.join(agentDir, "settings.json"),
      SCOPE_PI_BIN: wrapper,
      SCOPE_FILE_ROOT: tmpDir,
      SCOPE_MODEL_CATALOG: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  await waitForHealth();
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  if (browser) await browser.close();
  if (child) {
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
  }
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── The document each entry point gets ─────────────────────────────────────

describe("the phone gets the mobile document, the desktop gets the app", () => {
  test("/m is the mobile layout, and it never pulls in the desktop bundle", async () => {
    const { res, body } = await doc("/m");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/html/);
    assert.match(body, /mobile\.js/, "loads the mobile client");
    assert.match(body, /id="m-composer"/, "mounts the mobile composer");
    assert.doesNotMatch(body, /xterm/, "no terminal bundle");
    assert.doesNotMatch(body, /id="view-toggle"/, "no desktop view nav");
    assert.doesNotMatch(body, /app\.js/, "no desktop app boot");
  });

  test("a phone User-Agent on / also gets the mobile layout", async () => {
    const { body } = await doc("/", { ua: IPHONE_UA });
    assert.match(body, /mobile\.js/);
    assert.doesNotMatch(body, /xterm/);
  });

  test("a desktop User-Agent on / still gets the full app", async () => {
    const { body } = await doc("/", { ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36" });
    assert.match(body, /xterm\.js/);
    assert.doesNotMatch(body, /mobile\.js/);
  });

  test("the ui= override wins over the User-Agent, both ways", async () => {
    const forced = await doc("/?ui=mobile", { ua: "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0" });
    assert.match(forced.body, /mobile\.js/, "?ui=mobile opens the phone layout in a desktop browser");

    const escaped = await doc("/?ui=desktop", { ua: IPHONE_UA });
    assert.match(escaped.body, /xterm\.js/, "?ui=desktop is the escape hatch on a phone");
    assert.doesNotMatch(escaped.body, /mobile\.js/);
  });

  test("a mobile Client Hint is honoured when the UA says nothing", async () => {
    const hinted = await doc("/", { ua: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/140.0", hints: { "sec-ch-ua-mobile": "?1" } });
    assert.match(hinted.body, /mobile\.js/);
  });

  test("a tablet-ish UA without a hint stays on the desktop app (no false positives)", async () => {
    const { body } = await doc("/", { ua: "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1" });
    assert.match(body, /xterm\.js/);
  });

  test("the token in the query survives, so the mobile page can authenticate", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, userAgent: IPHONE_UA });
    await page.goto(`${base}/m?token=${TOKEN}`, { waitUntil: "domcontentloaded" });
    // The client reads ?token= and uses it: the drawer fills from /sessions.
    await page.waitForFunction(() => document.querySelector("#m-sessions")?.textContent?.length > 0, null, { timeout: 15_000 });
    assert.equal(await page.evaluate(() => localStorage.getItem("scope-token")), TOKEN, "the token is remembered for the next visit");
    await page.close();
  });
});

// ─── The mobile layout in a browser ─────────────────────────────────────────

/** Seed one recorded session so the drawer and transcript have something real.
 *  `model: null` leaves the session without one, so the composer's model falls
 *  back to the configured default (used to assert that fallback). */
async function seedSession(sid, { agent = "orchestrator", cwd = tmpDir, model = "stub" } = {}) {
  const now = new Date().toISOString();
  const assistant = {
    event_id: `${sid}-3`, session_id: sid, seq: 3, ts: now, type: "assistant_message", cwd, agent_name: agent,
    payload: { text: "hi there — recording works", usage: { total_tokens: 12 } },
  };
  if (model) { assistant.model = model; assistant.payload = { ...assistant.payload, model }; }
  const events = [
    { event_id: `${sid}-1`, session_id: sid, seq: 1, ts: now, type: "session_start", cwd, agent_name: agent, payload: { reason: "start" } },
    { event_id: `${sid}-2`, session_id: sid, seq: 2, ts: now, type: "user_message", cwd, agent_name: agent, payload: { text: "hello from the phone" } },
    assistant,
    { event_id: `${sid}-4`, session_id: sid, seq: 4, ts: now, type: "tool_call", cwd, agent_name: agent, payload: { tool_name: "read_file", args: { path: "src/a.ts" } } },
    { event_id: `${sid}-5`, session_id: sid, seq: 5, ts: now, type: "tool_result", cwd, agent_name: agent, payload: { tool_name: "read_file", content_text: "file contents here" } },
  ];
  const { res, data } = await api("/events", { method: "POST", body: JSON.stringify(events) });
  assert.ok(res.ok, `seeding failed: ${JSON.stringify(data)}`);
}

const phonePage = async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, userAgent: IPHONE_UA });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e?.message ?? e)));
  return { page, errors };
};

/** Open the mobile layout on a seeded session and wait for its transcript. */
async function openMobile(sid) {
  const { page, errors } = await phonePage();
  await page.goto(`${base}/m?token=${TOKEN}&sid=${encodeURIComponent(sid)}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#m-composer");
  return { page, errors };
}

describe("the mobile layout", () => {
  const SID = "mobile-seeded";

  test("renders the phone shell, not the desktop app", async () => {
    const { page, errors } = await phonePage();
    await page.goto(`${base}/m?token=${TOKEN}`, { waitUntil: "domcontentloaded" });
    // The drawer has rendered something (a session list or its empty state) —
    // i.e. /sessions answered with the token from the URL.
    await page.waitForFunction(() => (document.querySelector("#m-sessions")?.textContent || "").trim().length > 0, null, { timeout: 15_000 });

    // The desktop shell is absent, and nothing tried to boot it.
    assert.equal(await page.locator("#terminal-mount, #header-center, #view-toggle, #chat-composer").count(), 0, "no desktop chrome in the DOM");
    assert.equal(await page.locator("script[src*='xterm']").count(), 0, "no terminal script is requested");
    assert.equal(await page.evaluate(() => typeof window.setView), "undefined", "the desktop app never booted");

    // The phone shell is present and reachable by touch.
    for (const sel of ["#m-top", "#m-drawer", "#m-transcript", "#m-composer", "#m-input", "#m-send"]) {
      assert.ok(await page.locator(sel).count(), `${sel} is mounted`);
    }
    const box = await page.locator("#m-input").boundingBox();
    assert.ok(box.height >= 44, `the composer is a touch target (${box.height}px)`);

    // No page errors: a broken script would be invisible otherwise.
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("the drawer lists workspaces/sessions and the deep link opens a transcript", async () => {
    await seedSession(SID, { agent: "orchestrator" });
    const { page, errors } = await openMobile(SID);

    // The seeded turn is rendered from the recording.
    await page.waitForFunction(() => document.querySelector("#m-transcript")?.textContent?.includes("hi there"), null, { timeout: 15_000 });
    const text = await page.locator("#m-transcript").textContent();
    assert.match(text, /hello from the phone/, "the user message is shown");
    assert.match(text, /hi there — recording works/, "the assistant reply is shown");
    assert.match(text, /read_file/, "a tool call is shown");
    assert.match(text, /file contents here/, "a tool result's output is readable");
    assert.match(await page.locator("#m-sub").textContent(), /waiting|running|stopped/, "the header carries the session state");

    // ☰ opens the drawer, which groups by workspace and marks the open session.
    await page.click("#m-menu");
    await page.waitForSelector("#m-drawer.open");
    assert.ok(await page.locator(".m-sess.active").count(), "the open session is highlighted");
    const drawerText = await page.locator("#m-sessions").textContent();
    assert.match(drawerText, /hello from the phone/, "the session is listed by its opening message");
    assert.doesNotMatch(drawerText, /orchestrator/, "not by the agent/subagent name");
    await page.click("#m-drawer-close");
    await page.waitForFunction(() => !document.querySelector("#m-drawer").classList.contains("open"));
    assert.equal(await page.getAttribute("#m-menu", "aria-expanded"), "false", "the drawer is announced as closed");

    assert.deepEqual(errors, []);
    await page.close();
  });

  test("Stop kills a pi the terminal is running when its events carry a pid", async () => {
    const sid = "mobile-ext-stop";
    const pi = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await new Promise((resolve, reject) => {
      pi.once("spawn", resolve);
      pi.once("error", reject);
    });
    try {
      const now = new Date().toISOString();
      const started = Date.now();
      const seeded = await api("/events", {
        method: "POST",
        body: JSON.stringify([
          { event_id: `${sid}-1`, session_id: sid, seq: 1, ts: now, type: "user_message", cwd: tmpDir, agent_name: "orchestrator", payload: { text: "terminal work" }, pid: pi.pid, pid_started_at: started },
          { event_id: `${sid}-2`, session_id: sid, seq: 2, ts: now, type: "turn_start", cwd: tmpDir, agent_name: "orchestrator", payload: {}, pid: pi.pid, pid_started_at: started },
        ]),
      });
      assert.ok(seeded.res.ok);

      const { page, errors } = await openMobile(sid);
      // The phone can only offer Stop because the row carries the pid now.
      await page.waitForSelector("#m-stop:not([hidden])", { timeout: 15_000 });
      await page.click("#m-stop");
      await page.waitForFunction(() => /stopped/.test(document.querySelector("#m-hint")?.textContent || ""), null, { timeout: 15_000 });
      if (pi.exitCode === null && pi.signalCode === null) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("the pi process did not exit")), 5000);
          pi.once("exit", () => { clearTimeout(timer); resolve(); });
        });
      }
      assert.deepEqual(errors, []);
      await page.close();
    } finally {
      try { if (pi.exitCode === null && pi.signalCode === null) pi.kill("SIGKILL"); } catch { /* gone */ }
    }
  });

  test("a picture a tool result returns is drawn beside its text", async () => {
    const sid = "mobile-image";
    const now = new Date().toISOString();
    const shot = "data:image/png;base64,iVBORw0KGgo=";
    await api("/events", { method: "POST", body: JSON.stringify([
      { event_id: `${sid}-1`, session_id: sid, seq: 1, ts: now, type: "assistant_message", cwd: tmpDir, agent_name: "orchestrator", payload: { text: "here it is" } },
      { event_id: `${sid}-2`, session_id: sid, seq: 2, ts: now, type: "tool_call", cwd: tmpDir, agent_name: "orchestrator", payload: { tool_name: "screenshot", args: {} } },
      { event_id: `${sid}-3`, session_id: sid, seq: 3, ts: now, type: "tool_result", cwd: tmpDir, agent_name: "orchestrator", payload: { tool_name: "screenshot", content_text: `shot: ${shot}` } },
    ]) });
    const { page, errors } = await openMobile(sid);

    // The picture is a real <img> under the row's text, not a leftover string.
    await page.waitForSelector("#m-transcript .m-tool .result-images img", { state: "attached", timeout: 15_000 });
    assert.equal(await page.getAttribute("#m-transcript .m-tool .result-images img", "src"), shot);
    assert.match(await page.locator("#m-transcript .m-tool:has(.result-images)").textContent(), /shot:/, "the raw text is kept");
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("a prompt sent from the phone streams the reply into the phone bubble", async () => {
    const { page, errors } = await openMobile(SID);
    await page.waitForFunction(() => document.querySelector("#m-transcript")?.textContent?.includes("hi there"), null, { timeout: 15_000 });

    await page.fill("#m-input", "phone turn");
    await page.click("#m-send");
    // The run is in flight (Stop offered) and the user's message landed…
    await page.waitForFunction(() => document.querySelector("#m-stop").hidden === false, null, { timeout: 10_000 });
    await page.waitForFunction(() => document.querySelector("#m-transcript")?.textContent?.includes("phone turn"), null, { timeout: 10_000 });
    await page.waitForFunction(() => {
      const nodes = [...document.querySelectorAll("#m-transcript .m-live .m-text")];
      return nodes.length && nodes[nodes.length - 1].textContent === "alphabeta";
    }, null, { timeout: 20_000 });

    // The run settled: the composer is released and Stop is gone.
    await page.waitForFunction(() => document.querySelector("#m-stop").hidden === true, null, { timeout: 20_000 });
    assert.equal(await page.locator("#m-input").inputValue(), "", "the composer was cleared");
    assert.equal(await page.isEnabled("#m-send"), false, "Send is disabled with an empty box");

    // …and the turn is a real chat run on the server (visible to the desktop).
    const { data } = await api("/chat/status");
    const run = (data.runs || []).find((r) => r.sessionId === SID);
    assert.ok(!run || !run.active, "the run is no longer in flight");

    assert.deepEqual(errors, []);
    await page.close();
  });

  test("a file attached on the phone is stored in tmp/attachments and sent by path", async () => {
    await seedSession(SID, { agent: "orchestrator" });
    const { page, errors } = await openMobile(SID);
    await page.waitForFunction(() => document.querySelector("#m-transcript")?.textContent?.includes("hi there"), null, { timeout: 15_000 });

    // Attach a file the way the phone's file picker does (the input stays
    // hidden; setting its files fires change).
    await page.setInputFiles("#m-attach-input", {
      name: "photo.png",
      mimeType: "image/png",
      buffer: Buffer.from("89504e470d0a1a0a", "hex"),
    });
    // The chip appears while the upload is in flight; Send arms only once it
    // settles (a path, not an uploading placeholder, is what pi can receive).
    await page.waitForSelector("#m-attachments .m-attach-chip:not(.uploading)");
    assert.match(await page.locator("#m-attachments").textContent(), /photo\.png/);
    await page.waitForSelector("#m-send:not([disabled])");
    assert.equal(await page.isEnabled("#m-send"), true, "an attachment alone enables Send");

    await page.click("#m-send");
    await page.waitForFunction(() => document.querySelector("#m-stop").hidden === false, null, { timeout: 10_000 });

    // While the run is in flight the server knows the prompt it was handed —
    // the block, and only the PATH (never the bytes).
    const { data } = await api("/chat/status");
    const run = (data.runs || []).find((r) => r.sessionId === SID);
    assert.ok(run, "the run is known to the server");
    assert.match(String(run.prompt), /Attached files \(read each from its path\):/);
    assert.match(String(run.prompt), /tmp\/attachments\/.+photo\.png/);

    await page.waitForFunction(() => {
      const nodes = [...document.querySelectorAll("#m-transcript .m-live .m-text")];
      return nodes.length && nodes[nodes.length - 1].textContent === "alphabeta";
    }, null, { timeout: 20_000 });
    await page.waitForFunction(() => document.querySelector("#m-stop").hidden === true, null, { timeout: 20_000 });

    // The sent bubble shows the file, and the composer is cleared.
    assert.match(await page.locator("#m-transcript .m-user .m-msg-att").textContent(), /photo\.png/);
    assert.equal(await page.locator("#m-attachments .m-attach-chip").count(), 0, "the composer cleared after sending");

    // The bytes landed in the workspace's tmp/attachments/.
    const dir = path.join(tmpDir, "tmp", "attachments");
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1, "one attachment stored");
    assert.match(files[0], /photo\.png$/);

    assert.deepEqual(errors, []);
    await page.close();
  });

  test("Stop aborts a run in flight", async () => {
    const { page, errors } = await openMobile(SID);
    await page.waitForFunction(() => document.querySelector("#m-transcript")?.textContent?.includes("hi there"), null, { timeout: 15_000 });

    await page.fill("#m-input", "SLOW stop-me");
    await page.click("#m-send");
    await page.waitForFunction(() => {
      const nodes = [...document.querySelectorAll("#m-transcript .m-live .m-text")];
      return nodes.length && nodes[nodes.length - 1].textContent === "alpha";
    }, null, { timeout: 15_000 });
    assert.equal(await page.isVisible("#m-stop"), true, "Stop is offered while the agent works");

    await page.click("#m-stop");
    await page.waitForFunction(() => document.querySelector("#m-stop").hidden === true, null, { timeout: 20_000 });
    assert.match(await page.locator("#m-hint").textContent(), /stopped/, "the phone is told the run stopped");

    // The abort reached the server: the run is no longer in flight for anyone.
    const deadline = Date.now() + 15_000;
    for (;;) {
      const { data } = await api("/chat/status");
      const run = (data.runs || []).find((r) => r.sessionId === SID);
      if (!run || !run.active) break;
      if (Date.now() > deadline) throw new Error("the run stayed active after Stop");
      await sleep(150);
    }

    assert.deepEqual(errors, []);
    await page.close();
  });

  test("thinking, tool activity and token usage stream into the bubble", async () => {
    const { page, errors } = await openMobile(SID);
    await page.waitForFunction(() => document.querySelector("#m-transcript")?.textContent?.includes("hi there"), null, { timeout: 15_000 });

    await page.fill("#m-input", "TOOLS please");
    await page.click("#m-send");
    await page.waitForFunction(() => document.querySelector("#m-stop").hidden === false, null, { timeout: 10_000 });
    await page.waitForFunction(() => {
      const live = [...document.querySelectorAll("#m-transcript .m-live")].pop();
      return !!live && live.textContent.includes("all done");
    }, null, { timeout: 20_000 });

    const live = page.locator("#m-transcript .m-live").last();
    const shown = await live.textContent();
    assert.match(shown, /weighing options/, "the thinking delta is shown");
    assert.match(shown, /read_file/, "the tool call is shown");
    assert.match(shown, /42 tk/, "token usage is shown");

    await page.waitForFunction(() => document.querySelector("#m-stop").hidden === true, null, { timeout: 20_000 });
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("a continuation the server cannot resume is shown, and the reply still lands", async () => {
    // A recorded row can point at a pi session file that is GONE — the
    // agent-team dispatcher deletes a subagent's log when its run ends. The
    // server refuses to switch onto it (that would recreate the path and answer
    // from no context), seeds the fresh session with the recorded transcript
    // instead, and says so mid-run, before the prompt it did send. A client that
    // drops that event leaves the reader believing nothing was carried over.
    const sid = "mobile-no-resume";
    const gone = path.join(tmpDir, "agent-team-log", "image_analyzer-9.json");
    fs.mkdirSync(path.dirname(gone), { recursive: true });
    const now = new Date().toISOString();
    const seeded = await api("/events", {
      method: "POST",
      body: JSON.stringify([
        { event_id: `${sid}-1`, session_id: sid, seq: 1, ts: now, type: "session_start", cwd: tmpDir, agent_name: "image_analyzer", session_file: gone, payload: { reason: "start" } },
        { event_id: `${sid}-2`, session_id: sid, seq: 2, ts: now, type: "user_message", cwd: tmpDir, agent_name: "image_analyzer", session_file: gone, payload: { text: "what is in this chart" } },
        { event_id: `${sid}-3`, session_id: sid, seq: 3, ts: now, type: "assistant_message", cwd: tmpDir, agent_name: "image_analyzer", session_file: gone, model: "stub", payload: { text: "hi there — the chart is a bar series", usage: { total_tokens: 12 } } },
      ]),
    });
    assert.ok(seeded.res.ok);
    assert.equal(fs.existsSync(gone), false, "the fixture's pi session file is absent");

    const { page, errors } = await openMobile(sid);
    await page.waitForFunction(() => document.querySelector("#m-transcript")?.textContent?.includes("bar series"), null, { timeout: 15_000 });

    await page.fill("#m-input", "continue please");
    await page.click("#m-send");
    await page.waitForFunction(() => {
      const live = [...document.querySelectorAll("#m-transcript .m-live")].pop();
      return !!live && live.textContent.includes("alpha");
    }, null, { timeout: 20_000 });

    const live = page.locator("#m-transcript .m-live").last();
    const note = live.locator(".m-note.err");
    assert.equal(await note.isHidden(), false, "the reason is on the live bubble, not swallowed");
    assert.match(await note.textContent(), /cannot resume this session/);
    assert.match(await note.textContent(), /pi session file is gone/);
    assert.match(await note.textContent(), /recorded transcript was carried into this conversation instead/);
    assert.match(await live.textContent(), /alpha/, "the reply the server did run still lands");
    assert.equal(fs.existsSync(gone), false, "and the missing file was NOT recreated");

    // The wording is the proof that the conversation was handed over: the server
    // says "carried into this conversation" only when it had a transcript to seed
    // with (the raw prompt is verified against pi itself in chat-resume's e2e).
    assert.match(await note.textContent(), /recorded transcript was carried into this conversation instead/);

    await page.waitForFunction(() => document.querySelector("#m-stop").hidden === true, null, { timeout: 20_000 });
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("the Markdown / Raw switch redraws an assistant reply and sticks", async () => {
    // The phone offers the same reply-view switch as the desktop: Markdown
    // parses pi's markdown, Raw shows the plain text unparsed. Only assistant
    // text is affected.
    const sid = "mobile-view-seed";
    const now = new Date().toISOString();
    await api("/events", {
      method: "POST",
      body: JSON.stringify([
        { event_id: `${sid}-1`, session_id: sid, seq: 1, ts: now, type: "session_start", cwd: tmpDir, agent_name: "orchestrator", payload: { reason: "start" } },
        { event_id: `${sid}-2`, session_id: sid, seq: 2, ts: now, type: "user_message", cwd: tmpDir, agent_name: "orchestrator", payload: { text: "what's up" } },
        { event_id: `${sid}-3`, session_id: sid, seq: 3, ts: now, type: "assistant_message", cwd: tmpDir, agent_name: "orchestrator", payload: { text: "**bold** answer\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n![a dot](data:image/png;base64,iVBORw0KGgo=)" } },
      ]),
    });

    const { page, errors } = await openMobile(sid);
    const ai = "#m-transcript .m-msg.m-ai .m-text";
    await page.waitForFunction(() => document.querySelector("#m-transcript")?.textContent?.includes("bold"), null, { timeout: 15_000 });

    // Markdown is the default: the markdown became a <strong> and a real table.
    await page.waitForSelector(`${ai}.m-md strong`);
    assert.equal(await page.getAttribute('#m-view-toggle [data-view="markdown"]', "aria-pressed"), "true");
    assert.equal(await page.locator(`${ai}.m-md strong`).count(), 1, "markdown parses the reply");
    assert.equal(await page.locator(`${ai}.m-md table tbody tr`).count(), 1, "markdown renders the table");
    assert.deepEqual(await page.locator(`${ai}.m-md table th`).allTextContents(), ["a", "b"]);
    assert.equal(
      await page.getAttribute(`${ai}.m-md img`, "alt"),
      "a dot",
      "markdown renders the image"
    );
    assert.equal(await page.locator(".m-msg.m-user .m-md").count(), 0, "the user's own row is untouched");

    // Raw: the same text unparsed — literal asterisks/pipes, no <strong> or <img>.
    await page.click('#m-view-toggle [data-view="raw"]');
    await page.waitForSelector(`${ai}:not(.m-md)`);
    assert.equal(await page.locator(`${ai} strong`).count(), 0, "raw does not parse the markdown");
    assert.equal(await page.locator(`${ai} table`).count(), 0, "raw does not build a table");
    assert.equal(await page.locator(`${ai} img`).count(), 0, "raw does not build an image");
    assert.match(await page.textContent(ai), /\*\*bold\*\* answer/);
    assert.match(await page.textContent(ai), /\| 1 \| 2 \|/);
    assert.match(await page.textContent(ai), /!\[a dot\]\(data:image\/png;base64,iVBORw0KGgo=\)/);

    // The choice is remembered per browser.
    assert.equal(await page.evaluate(() => localStorage.getItem("scope-chat-view")), "raw");

    // Back to Markdown reparses the text in place.
    await page.click('#m-view-toggle [data-view="markdown"]');
    await page.waitForSelector(`${ai}.m-md strong`);

    assert.deepEqual(errors, []);
    await page.close();
  });

  test("a question pi is blocked on is answerable from the phone", async () => {
    const { page, errors } = await openMobile(SID);
    await page.waitForFunction(() => document.querySelector("#m-transcript")?.textContent?.includes("hi there"), null, { timeout: 15_000 });

    await page.fill("#m-input", "UI question");
    await page.click("#m-send");
    await page.waitForFunction(() => document.querySelector("#m-stop").hidden === false, null, { timeout: 10_000 });
    await page.waitForSelector(".m-ask", { timeout: 15_000 });
    assert.match(await page.locator(".m-ask-title").textContent(), /Pick one/);
    assert.deepEqual(await page.locator(".m-ask-opt").allTextContents(), ["1. alpha", "2. beta"]);

    // Picking an option answers the dialog; pi then continues the same run.
    await page.click(".m-ask-opt >> nth=0");
    await page.waitForFunction(() => document.querySelector(".m-ask")?.classList.contains("answered"), null, { timeout: 10_000 });
    assert.match(await page.locator(".m-ask").textContent(), /You: 1\. alpha/);
    await page.waitForFunction(() => {
      const nodes = [...document.querySelectorAll("#m-transcript .m-live .m-text")];
      return nodes.length && nodes[nodes.length - 1].textContent.includes("answered");
    }, null, { timeout: 15_000 });

    await page.click("#m-stop");
    await page.waitForFunction(() => document.querySelector("#m-stop").hidden === true, null, { timeout: 20_000 });

    assert.deepEqual(errors, []);
    await page.close();
  });

  test("the desktop escape hatch leaves the phone layout", async () => {
    const { page, errors } = await openMobile(SID);
    await page.waitForFunction(() => document.querySelector("#m-transcript")?.textContent?.includes("hi there"), null, { timeout: 15_000 });

    const [nav] = await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), page.click("#m-desktop")]);
    assert.ok(nav, "the button navigates");
    const url = new URL(page.url());
    assert.equal(url.searchParams.get("ui"), "desktop", "the desktop layout is requested explicitly");
    assert.equal(url.searchParams.get("token"), TOKEN, "the token carries over");
    // The real desktop app boots (the composer itself stays hidden until a
    // workspace is picked — and this document is the desktop one, not mobile.html).
    await page.waitForFunction(() => window.SCOPE?.Plugins?.isSynced?.() === true, null, { timeout: 20_000 });
    assert.ok(await page.locator("#terminal-mount").count(), "the desktop shell is mounted");
    assert.equal(await page.evaluate(() => typeof window.setView), "function", "the desktop app booted");

    // The pairing panel encodes the mobile entry, not the desktop one.
    const mobileUrl = await page.evaluate(() => window.SCOPE.mobileUrlFor("http://10.0.0.5:43190/?token=abc"));
    assert.equal(mobileUrl, "http://10.0.0.5:43190/m?token=abc&ui=mobile");

    assert.deepEqual(errors, []);
    await page.close();
  });

  test("a session worked elsewhere streams into the open transcript", async () => {
    // The phone only watches: a turn driven from somewhere else (the desktop,
    // another phone) must appear without the user touching anything.
    const { page, errors } = await openMobile(SID);
    await page.waitForFunction(() => document.querySelector("#m-transcript")?.textContent?.includes("hi there"), null, { timeout: 15_000 });

    const now = new Date().toISOString();
    const reply = await api("/events", {
      method: "POST",
      body: JSON.stringify([
        { event_id: `${SID}-watch`, session_id: SID, seq: 9, ts: now, type: "assistant_message", cwd: tmpDir, agent_name: "orchestrator", payload: { text: "pushed from the desktop" } },
      ]),
    });
    assert.ok(reply.res.ok);

    await page.waitForFunction(
      () => document.querySelector("#m-transcript")?.textContent?.includes("pushed from the desktop"),
      null,
      { timeout: 15_000 }
    );
    assert.deepEqual(errors, []);
    await page.close();
  });
});

// ─── The skin: Amber Terminal Noir ─────────────────────────────────────────
//
// These tests do not assert "looks nice" — they assert the design SYSTEM, in
// computed styles: the flush square 57px navbar, the three-step grayscale text
// hierarchy with the accents rationed to fills/glyphs, the faint blueprint
// texture confined to panel backdrops, which face is used for which job, and
// that structure comes from hairlines rather than card chrome. They exist so a
// later edit cannot quietly drift off the system.

const SKIN_SID = "skin-seeded";

const css = (page, sel, prop, pseudo) =>
  page.evaluate(
    ([s, p, ps]) => getComputedStyle(document.querySelector(s), ps || null).getPropertyValue(p),
    [sel, prop, pseudo]
  );

describe("the mobile skin (Amber Terminal Noir)", () => {
  test("the navbar is a flush, square, 57px bar that never scrolls away", async () => {
    await seedSession(SKIN_SID, { cwd: tmpDir });
    const { page, errors } = await openMobile(SKIN_SID);
    await page.waitForFunction(() => document.querySelector("#m-transcript")?.textContent?.includes("hi there"), null, { timeout: 15_000 });

    const bar = await page.locator("#m-top").boundingBox();
    const vw = await page.evaluate(() => window.innerWidth);
    assert.equal(Math.round(bar.x), 0, "the bar is flush to the left edge");
    assert.equal(Math.round(bar.width), vw, "and spans the full viewport width (never inset)");
    assert.equal(Math.round(bar.height), 57, "it is exactly 57px tall");
    for (const corner of ["border-top-left-radius", "border-top-right-radius", "border-bottom-left-radius", "border-bottom-right-radius"]) {
      assert.equal(await css(page, "#m-top", corner), "0px", `${corner} stays square`);
    }
    assert.equal(await css(page, "#m-top", "background-color"), "rgb(10, 10, 10)", "the near-black field");

    // It is pinned: scrolling the transcript must not move it.
    await page.evaluate(() => { document.querySelector("#m-transcript").scrollTop = 9999; });
    const after = await page.locator("#m-top").boundingBox();
    assert.equal(Math.round(after.y), Math.round(bar.y), "the bar holds its place while the transcript scrolls");

    assert.deepEqual(errors, []);
    await page.close();
  });

  test("text uses exactly the three-step grayscale plus the rationed accents", async () => {
    // The palette, as the system defines it.
    const ALLOWED = [
      "rgb(255, 255, 255)",   // --text primary
      "rgb(113, 113, 122)",   // --text-2 secondary body
      "rgb(161, 161, 170)",   // --text-3 tertiary labels
      "rgb(82, 82, 91)",      // --text-muted readouts
      "rgb(245, 196, 0)",     // amber accent (as text/glyph)
      "rgb(255, 90, 60)",     // coral, eyebrow/rule ornament only
      "rgb(220, 38, 38)",     // danger
      "rgb(16, 185, 129)",    // success
      "rgb(0, 0, 0)",         // text on an amber fill
    ];
    await seedSession(SKIN_SID, { cwd: tmpDir });
    const { page } = await openMobile(SKIN_SID);
    await page.waitForFunction(() => document.querySelector("#m-transcript")?.textContent?.includes("hi there"), null, { timeout: 15_000 });

    // Every text-bearing element on screen, message body included.
    const used = await page.evaluate(() => {
      const seen = new Map();
      for (const el of document.querySelectorAll("body *")) {
        const hasOwnText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        if (!hasOwnText || !el.getClientRects().length) continue;
        const color = getComputedStyle(el).color;
        if (!seen.has(color)) seen.set(color, el.className || el.id || el.tagName);
      }
      return [...seen.entries()];
    });
    for (const [color, where] of used) {
      assert.ok(ALLOWED.includes(color), `${where} uses ${color}, which is outside the palette`);
    }
    assert.ok(used.some(([c]) => c === "rgb(255, 255, 255)"), "primary text is white");
    assert.ok(used.some(([c]) => c === "rgb(113, 113, 122)"), "secondary text is the mid gray");

    // Amber never fills a background on this screen: the send control is the
    // only amber fill that is actually rendered (the sheet is closed).
    const amberFills = await page.evaluate(() =>
      [...document.querySelectorAll("body *")]
        .filter((el) => el.getClientRects().length && getComputedStyle(el).backgroundColor === "rgb(245, 196, 0)")
        .map((el) => el.id || el.className)
    );
    assert.deepEqual(amberFills, ["m-send"], `amber fills only the send control (found: ${amberFills})`);

    // The coral accent has exactly one job here: the warning state. Drive it
    // the way it actually arrives — pi raises a `notify` host request mid-run,
    // the server forwards it as `ui_notify` — instead of painting the class by
    // hand, so this covers the wiring and not just the stylesheet.
    await page.fill("#m-input", "task NOTIFY");
    await page.click("#m-send");
    const warn = await page
      .waitForFunction(() => {
        const el = document.querySelector("#m-hint");
        if (!el || el.hidden || !el.classList.contains("warn")) return null;
        return { color: getComputedStyle(el).color, text: el.textContent };
      }, null, { timeout: 15_000 })
      .then((h) => h.jsonValue());
    assert.equal(warn.color, "rgb(255, 90, 60)", "the coral accent marks warnings");
    assert.match(warn.text, /context is 92% full/, "the host notification reached the status line");
    // Let the run settle so nothing is left streaming behind the checks below.
    await page.waitForFunction(() => document.querySelector("#m-stop").hidden === true, null, { timeout: 15_000 });

    // The amber radial wash exists, but only behind the hero panel — and the
    // hero is not on screen here, so no element carries it.
    const radials = await page.evaluate(() =>
      [...document.querySelectorAll("body *")]
        .filter((el) => el.getClientRects().length && getComputedStyle(el).backgroundImage.includes("radial-gradient"))
        .map((el) => el.id || el.className)
    );
    assert.deepEqual(radials, [], "no element paints the amber wash as a section background");
    for (const sel of ["#m-transcript", "#m-composer", "#m-drawer"]) {
      assert.ok(!(await css(page, sel, "background-image")).includes("radial-gradient"), `${sel} keeps the wash out`);
    }
    await page.close();
  });

  test("the amber wash sits behind the hero only, and the texture stays faint", async () => {
    // No session: the empty state (the layout's hero) is what is on screen.
    const { page, errors } = await phonePage();
    await page.goto(`${base}/m?token=${TOKEN}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#m-transcript .m-empty");

    // The rationed glow: one pseudo-element on the hero panel, top-center.
    const wash = await css(page, ".m-empty", "background-image", "::before");
    assert.match(wash, /radial-gradient/, "the hero panel carries the amber radial wash");
    assert.match(wash, /rgba\(245, 196, 0, 0\.07\)/, "and it is the rationed 7% alpha, not a filled background");

    // The blueprint texture: linear 1px rules only, 2-3% alpha, on panel
    // backdrops (never on the composer, never page-wide).
    for (const sel of ["#m-transcript", "#m-drawer"]) {
      const bg = await css(page, sel, "background-image");
      assert.match(bg, /linear-gradient/, `${sel} carries the blueprint texture`);
      assert.ok(!/radial-gradient/.test(bg), `${sel} has no wash`);
      const alphas = [...bg.matchAll(/rgba\(255, 255, 255, ([\d.]+)\)/g)].map((m) => Number(m[1]));
      assert.ok(alphas.length && Math.max(...alphas) <= 0.03, `${sel} keeps the texture at 2-3% alpha (${alphas})`);
    }
    assert.equal(await css(page, "#m-composer", "background-image"), "none", "the composer is not textured");

    assert.deepEqual(errors, []);
    await page.close();
  });

  test("display, body and mono each do their own job", async () => {
    await seedSession(SKIN_SID, { cwd: tmpDir });
    const { page, errors } = await openMobile(SKIN_SID);
    await page.waitForFunction(() => document.querySelector("#m-transcript")?.textContent?.includes("hi there"), null, { timeout: 15_000 });

    const fonts = await page.evaluate(async () => {
      await document.fonts.ready;
      const fam = (sel) => getComputedStyle(document.querySelector(sel)).fontFamily;
      return {
        loaded: {
          clash: document.fonts.check('600 18px "Clash Grotesk"'),
          satoshi: document.fonts.check('400 15px "Satoshi"'),
        },
        hero: fam("#m-title"),
        prose: fam(".m-text"),
        label: fam(".m-ai-head"),
        readout: fam(".m-sess-meta"),
        input: fam("#m-input"),
      };
    });

    // The self-hosted faces actually load (a bad path would silently fall back).
    assert.equal(fonts.loaded.clash, true, "Clash Grotesk is served and parsed");
    assert.equal(fonts.loaded.satoshi, true, "Satoshi is served and parsed");

    assert.match(fonts.hero, /Clash Grotesk/, "headlines are Clash Grotesk");
    assert.match(fonts.prose, /Satoshi/, "prose is Satoshi");
    assert.doesNotMatch(fonts.prose, /mono/i, "prose is never the console face");
    assert.match(fonts.readout, /mono/i, "metadata readouts are the console face");
    assert.match(fonts.label, /mono/i, "message lead labels are readouts");
    assert.match(fonts.input, /mono/i, "the command input is the console face");

    assert.deepEqual(errors, []);
    await page.close();
  });

  test("structure comes from hairlines, not card chrome", async () => {
    await seedSession(SKIN_SID, { cwd: tmpDir });
    const { page, errors } = await openMobile(SKIN_SID);
    await page.waitForFunction(() => document.querySelector("#m-transcript")?.textContent?.includes("hi there"), null, { timeout: 15_000 });

    // A message is a ghost row: no fill, no radius, no border of its own…
    const ghost = await page.evaluate(() => {
      const b = document.querySelector(".m-msg.m-ai .m-bubble");
      const cs = getComputedStyle(b);
      return { bg: cs.backgroundColor, radius: cs.borderRadius, border: cs.borderTopWidth, pad: cs.paddingLeft };
    });
    assert.equal(ghost.bg, "rgba(0, 0, 0, 0)", "the message container is zero-fill");
    assert.equal(ghost.radius, "0px", "and zero-radius");
    assert.equal(ghost.border, "0px", "with no chrome of its own");
    assert.equal(ghost.pad, "0px", "the row owns the padding, not the bubble");

    // …separated from its neighbour by a hairline (the first row needs none).
    const rules = await page.evaluate(() =>
      [...document.querySelectorAll(".m-msg")].map((el) => getComputedStyle(el).borderTopWidth)
    );
    assert.ok(rules.length >= 2, "the seeded turn rendered several rows");
    assert.equal(rules[0], "0px", "the first row needs no separator");
    assert.ok(rules.slice(1).every((w) => w === "1px"), `every later row is separated by a hairline (${rules})`);

    // Drawer rows are ghosts too, and the active one is marked with an amber rule.
    await page.click("#m-menu");
    await page.waitForSelector("#m-drawer.open");
    const row = await page.evaluate(() => {
      const el = document.querySelector(".m-sess");
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, radius: cs.borderRadius, rule: cs.borderLeftWidth, ruleColor: cs.borderLeftColor };
    });
    assert.equal(row.bg, "rgba(0, 0, 0, 0)", "session rows have no fill");
    assert.equal(row.radius, "0px", "zero radius");
    assert.equal(row.rule, "2px", "the active marker is a 2px rule");
    assert.ok(row.ruleColor === "rgb(245, 196, 0)" || row.ruleColor === "rgba(0, 0, 0, 0)", `the rule is amber or unused (${row.ruleColor})`);

    // Panels (the floating surfaces) DO get chrome: fill, radius, hairline.
    const panel = await page.evaluate(() => {
      const el = document.querySelector("#m-drawer");
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, radius: cs.borderTopLeftRadius };
    });
    assert.equal(panel.bg, "rgb(18, 18, 18)", "panels step up to #121212");
    assert.equal(panel.radius, "0px", "the drawer is flush to the viewport edge");

    assert.deepEqual(errors, []);
    await page.close();
  });

  test("controls use the radius scale and keep 44px touch targets", async () => {
    // A seeded session (not opened) puts a workspace in the sheet, so the ghost
    // option rows are there to measure.
    await seedSession("skin-radius-seed", { cwd: tmpDir });
    const { page, errors } = await phonePage();
    await page.goto(`${base}/m?token=${TOKEN}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#m-transcript .m-empty");

    // Radius tokens: button 8, control 6, card 12, panel 16, sharp 2.
    assert.equal(await css(page, ".m-btn-primary", "border-radius"), "8px", "the primary CTA is an 8px button");
    assert.equal(await css(page, "#m-input", "border-radius"), "6px", "the command input is a 6px control");
    assert.equal(await css(page, ".m-stats", "border-radius"), "0px", "the stat row has no chrome");
    await page.click("#m-new");
    await page.waitForSelector("#m-sheet:not([hidden])");
    const card = await page.evaluate(() => {
      const cs = getComputedStyle(document.querySelector(".m-sheet-card"));
      return { r: cs.borderTopLeftRadius, bg: cs.backgroundColor, shadow: cs.boxShadow };
    });
    assert.equal(card.r, "16px", "the sheet is a 16px panel");
    assert.equal(card.bg, "rgb(18, 18, 18)", "on the #121212 surface");
    assert.match(card.shadow, /rgba\(255, 255, 255, 0\.06\) 0px 0px 0px 1px/, "with the hairline-ring + deep drop shadow");
    await page.waitForSelector("#m-ws-list .m-opt", { timeout: 15_000 });
    assert.equal(await css(page, ".m-opt", "border-radius"), "0px", "option rows are ghosts inside the panel");
    assert.equal(await css(page, ".m-opts", "border-radius"), "12px", "the list container is a 12px card");

    // The reference's 34px controls are desktop-scale; a thumb needs 44.
    const sizes = await page.evaluate(() => {
      const h = (sel) => { const e = document.querySelector(sel); return e ? Math.round(e.getBoundingClientRect().height) : 0; };
      return { cta: h(".m-btn-primary"), input: h("#m-input"), icon: h("#m-menu"), close: h("#m-sheet-close") };
    });
    for (const [what, px] of Object.entries(sizes)) {
      assert.ok(px >= 44, `${what} is a 44px+ touch target (${px}px)`);
    }

    assert.deepEqual(errors, []);
    await page.close();
  });

  test("nothing overflows sideways, and the light theme keeps the system", async () => {
    await seedSession("skin-width-seed", { cwd: tmpDir });

    // A narrow phone is where a design like this breaks: rules, readouts and
    // the console panel must all stay inside the viewport.
    for (const width of [320, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 720 }, userAgent: IPHONE_UA });
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e?.message ?? e)));
      await page.goto(`${base}/m?token=${TOKEN}&sid=skin-width-seed`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector("#m-transcript")?.textContent?.includes("hi there"), null, { timeout: 15_000 });

      const noOverflow = async (where) => {
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.equal(over, 0, `no sideways scroll at ${width}px (${where})`);
      };
      await noOverflow("transcript");
      await page.click("#m-menu");
      await page.waitForSelector("#m-drawer.open");
      await noOverflow("drawer");
      await page.click("#m-drawer-close");
      await page.click("#m-new");
      await page.waitForSelector("#m-sheet:not([hidden])");
      await noOverflow("sheet");
      await page.click("#m-sheet-close");

      assert.deepEqual(errors, []);
      await page.close();
    }

    // The reference is dark-only; Pi Scope still honours an explicit light
    // choice, so the light theme must keep the same structure with the field
    // inverted and the accent darkened where it is used as TEXT.
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, userAgent: IPHONE_UA });
    await page.addInitScript(() => { try { localStorage.setItem("scope-theme", "light"); } catch { /* private mode */ } });
    await page.goto(`${base}/m?token=${TOKEN}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#m-transcript .m-empty");
    assert.equal(await page.evaluate(() => document.body.hasAttribute("data-ds-dark-theme")), false, "the light choice is honoured");
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(244, 244, 245)", "the paper field");
    assert.equal(await css(page, ".m-hero-amber", "color"), "rgb(122, 92, 0)", "the accent darkens as text");
    assert.equal(await css(page, ".m-btn-primary", "background-color"), "rgb(245, 196, 0)", "…while the amber fill stays amber");
    assert.equal(await css(page, "#m-top", "border-bottom-width"), "1px", "the hairline navbar rule survives the theme switch");
    await page.close();
  });

  test("the header toggle flips the theme and remembers it", async () => {
    const { page, errors } = await phonePage();
    await page.goto(`${base}/m?token=${TOKEN}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#m-transcript .m-empty");

    // Dark is the default for a fresh visitor, and the button offers the switch.
    assert.equal(await page.evaluate(() => document.body.hasAttribute("data-ds-dark-theme")), true, "dark by default");
    assert.equal(await page.getAttribute("#m-theme", "aria-label"), "Switch to light theme");
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#m-theme .m-ic-moon")).display), "block", "the moon is the dark-state glyph");
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#m-theme .m-ic-sun")).display), "none", "the sun stays hidden in the dark");

    await page.click("#m-theme");
    assert.equal(await page.evaluate(() => document.body.hasAttribute("data-ds-dark-theme")), false, "the toggle reaches light");
    assert.equal(await page.evaluate(() => localStorage.getItem("scope-theme")), "light", "the choice is remembered");
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(244, 244, 245)", "the paper field paints");
    assert.equal(await page.getAttribute("#m-theme", "aria-label"), "Switch to dark theme", "the label announces the next theme");
    const glyphs = await page.evaluate(() => ({
      moon: getComputedStyle(document.querySelector("#m-theme .m-ic-moon")).display,
      sun: getComputedStyle(document.querySelector("#m-theme .m-ic-sun")).display,
    }));
    assert.equal(glyphs.moon, "none", "the moon yields");
    assert.equal(glyphs.sun, "block", "the sun shows");

    // The choice survives a reload: the inline bootstrap applies it before paint.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#m-theme");
    assert.equal(await page.evaluate(() => document.body.hasAttribute("data-ds-dark-theme")), false, "the light choice reloads");

    await page.click("#m-theme");
    assert.equal(await page.evaluate(() => document.body.hasAttribute("data-ds-dark-theme")), true, "and back to dark");
    assert.equal(await page.evaluate(() => localStorage.getItem("scope-theme")), "dark", "the new choice is remembered");

    assert.deepEqual(errors, []);
    await page.close();
  });

  test("motion settles slowly, gives snappy feedback, and yields to reduced-motion", async () => {
    const { page, errors } = await phonePage();
    await page.goto(`${base}/m?token=${TOKEN}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#m-transcript .m-empty");

    // Macro transitions settle on the reference ease, not a bounce.
    const settle = await page.evaluate(() => {
      const cs = getComputedStyle(document.querySelector("#m-drawer"));
      return { dur: cs.transitionDuration, ease: cs.transitionTimingFunction };
    });
    assert.match(settle.ease, /cubic-bezier\(0\.22, 1, 0\.36, 1\)/, "the drawer uses the settle curve");
    assert.ok(parseFloat(settle.dur) >= 0.3, `and takes its time (${settle.dur})`);

    // Micro feedback (borders, colors) is fast.
    const micro = await page.evaluate(() => getComputedStyle(document.querySelector(".m-btn")).transitionDuration);
    assert.ok(parseFloat(micro) <= 0.2, `control feedback is fast (${micro})`);

    // The live status dot breathes.
    const anim = await page.evaluate(() => {
      const el = document.querySelector("#m-live");
      el.className = "m-dot green";
      return getComputedStyle(el).animationName;
    });
    assert.equal(anim, "m-pulse", "the live dot has the pulse keyframe");

    await page.emulateMedia({ reducedMotion: "reduce" });
    const reduced = await page.evaluate(() => getComputedStyle(document.querySelector("#m-drawer")).transitionDuration);
    assert.equal(reduced, "0s", "prefers-reduced-motion turns the macro transitions off");

    assert.deepEqual(errors, []);
    await page.close();
  });

  test("the phone baseline is sized to fit the screen, and no browser inflates it", async () => {
    // The report this covers: on a real phone the page read as oversized and
    // needed zooming out. Two causes, both pinned here — the browser's own text
    // autosizing, and a type scale that was desktop-generous.
    await seedSession("skin-density-seed", { cwd: tmpDir });
    const { page, errors } = await phonePage();
    await page.goto(`${base}/m?token=${TOKEN}&sid=skin-density-seed`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#m-transcript")?.textContent?.includes("hi there"), null, { timeout: 15_000 });

    // Text autosizing is off: what the stylesheet says is what the phone shows.
    const adjust = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return cs.webkitTextSizeAdjust || cs.textSizeAdjust || "";
    });
    assert.match(adjust, /100%/, `the page cannot be font-boosted (${adjust})`);

    // The reading baseline is the system's body-sm, not the desktop body-md.
    const type = await page.evaluate(() => {
      const body = getComputedStyle(document.body);
      const text = getComputedStyle(document.querySelector(".m-text"));
      return { size: body.fontSize, lh: body.lineHeight, msg: text.fontSize, msgLh: text.lineHeight };
    });
    assert.equal(type.size, "14px", "the base size is body-sm");
    assert.equal(type.msg, "14px", "and message prose matches it");
    assert.equal(type.msgLh, "21px", "on a 1.5 line box, not the desktop 1.63");

    assert.deepEqual(errors, []);
    await page.close();

    // The hero — the first screen a phone sees — stays in a phone-sized band
    // instead of the reference's 44px display block, and fits the narrowest
    // phones without sideways scroll.
    const hero = await phonePage();
    await hero.page.goto(`${base}/m?token=${TOKEN}`, { waitUntil: "domcontentloaded" });
    await hero.page.waitForSelector("#m-transcript .m-empty");
    for (const width of [320, 390]) {
      await hero.page.setViewportSize({ width, height: 720 });
      const size = await hero.page.evaluate(() => getComputedStyle(document.querySelector(".m-hero-title")).fontSize);
      const px = parseFloat(size);
      assert.ok(px >= 24 && px <= 34, `the hero headline is phone-scale (${size} at ${width}px)`);
      const over = await hero.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.equal(over, 0, `and it still fits at ${width}px`);
    }
    assert.deepEqual(hero.errors, []);
    await hero.page.close();
  });

  test("off the phone the layout keeps its phone shape instead of stretching", async () => {
    // ?ui=mobile in a desktop browser, or a phone in landscape, used to paint
    // this single column across the whole window — the mobile page reading as
    // enormous. Past 700px it now keeps a phone width and centers.
    await seedSession("skin-wide-seed", { cwd: tmpDir });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36",
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e?.message ?? e)));
    await page.goto(`${base}/m?token=${TOKEN}&sid=skin-wide-seed`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#m-transcript")?.textContent?.includes("hi there"), null, { timeout: 15_000 });

    // The branch is gated on a mouse-driven viewport, so it can never catch a
    // phone: this context must report one.
    assert.equal(
      await page.evaluate(() => matchMedia("(hover: hover) and (pointer: fine)").matches),
      true,
      "the column branch only applies to a fine-pointer viewport"
    );

    const col = await page.evaluate(() => {
      const r = document.body.getBoundingClientRect();
      return { l: Math.round(r.left), w: Math.round(r.width), centered: Math.abs((r.left + r.right) / 2 - document.documentElement.clientWidth / 2) <= 1 };
    });
    assert.ok(col.w <= 440, `the app column stays phone-width (${col.w}px)`);
    assert.ok(col.centered, "and is centered in the window");

    // The navbar still spans its layout flush — the guardrail is about never
    // insetting or rounding it, and the layout it fills is the column (measured
    // inside the column's 1px frame, not the border box).
    const bar = await page.locator("#m-top").boundingBox();
    const inner = await page.evaluate(() => ({
      left: Math.round(document.body.getBoundingClientRect().left + document.body.clientLeft),
      width: document.body.clientWidth,
    }));
    assert.equal(Math.round(bar.x), inner.left, "the bar is flush with the column's left edge");
    assert.equal(Math.round(bar.width), inner.width, "and spans it edge-to-edge");

    const strays = await page.evaluate(() => {
      const b = document.body.getBoundingClientRect();
      return [...document.querySelectorAll("#m-scrim, #m-sheet, .m-jump, #m-transcript")]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return (r.width || r.height) && getComputedStyle(el).opacity !== "0" && (r.left < b.left - 1 || r.right > b.right + 1);
        })
        .map((el) => el.id || el.className);
    });
    assert.deepEqual(strays, [], "no surface paints into the gutters");

    // The closed drawer parks fully off-screen, so it cannot appear in the left
    // margin; opening it comes to rest against the column.
    const closed = await page.evaluate(() => Math.round(document.querySelector("#m-drawer").getBoundingClientRect().right));
    assert.ok(closed <= 0, `the closed drawer is off-screen (right edge ${closed}px)`);
    await page.click("#m-menu");
    await page.waitForSelector("#m-drawer.open");
    await page.waitForTimeout(500);
    const open = await page.evaluate(() => {
      const d = document.querySelector("#m-drawer").getBoundingClientRect();
      const s = document.querySelector("#m-scrim").getBoundingClientRect();
      const b = document.body.getBoundingClientRect();
      return { dl: Math.round(d.left), sr: Math.round(s.right), bl: Math.round(b.left), br: Math.round(b.right) };
    });
    assert.equal(open.dl, open.bl, "the open drawer rests against the column");
    assert.equal(open.sr, open.br, "and its scrim covers the column, not the window");

    assert.deepEqual(errors, []);
    await page.close();
  });

  test("an Android phone keeps the full-bleed layout at every width it reports", async () => {
    // Android phones report widths a desktop viewport never does: 360-412px in
    // portrait, ~673px unfolded, and 980px when the browser is put in
    // Desktop-site mode. None of those may be taken for "a wide screen" and
    // pinched into the centered column — on the device that is a narrow strip
    // with gutters down both sides.
    await seedSession("skin-android-seed", { cwd: tmpDir });
    for (const width of [360, 393, 412, 673, 980]) {
      const page = await browser.newPage({
        viewport: { width, height: 800 },
        userAgent: SAMSUNG_UA,
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 3,
      });
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e?.message ?? e)));
      await page.goto(`${base}/m?token=${TOKEN}&sid=skin-android-seed`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector("#m-transcript")?.textContent?.includes("hi there"), null, { timeout: 15_000 });

      const seen = await page.evaluate(() => {
        const r = document.body.getBoundingClientRect();
        return {
          fine: matchMedia("(hover: hover) and (pointer: fine)").matches,
          coarse: matchMedia("(pointer: coarse)").matches,
          bodyW: Math.round(r.width),
          left: Math.round(r.left),
          over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
      assert.equal(seen.fine, false, `the viewport is not mouse-driven at ${width}px`);
      assert.equal(seen.coarse, true, `it is a touch pointer at ${width}px`);
      assert.equal(seen.bodyW, width, `the layout is full-bleed at ${width}px`);
      assert.equal(seen.left, 0, `flush to both edges at ${width}px, no gutter`);
      assert.equal(seen.over, 0, `and nothing scrolls sideways at ${width}px`);

      // The chrome a thumb uses is still on screen, full width and reachable.
      const bar = await page.locator("#m-top").boundingBox();
      assert.equal(Math.round(bar.width), width, `the navbar spans the screen at ${width}px`);
      assert.equal(Math.round(bar.y), 0, `and sits at the top edge at ${width}px`);
      const controls = await page.evaluate(() => {
        const box = (sel) => {
          const el = document.querySelector(sel);
          if (!el || el.hidden) return null;
          const r = el.getBoundingClientRect();
          return { l: Math.round(r.left), r: Math.round(r.right), h: Math.round(r.height) };
        };
        return { send: box("#m-send"), input: box("#m-input"), menu: box("#m-menu"), new: box("#m-new") };
      });
      for (const [what, b] of Object.entries(controls)) {
        assert.ok(b, `${what} is on screen at ${width}px`);
        assert.ok(b.h >= 44, `${what} is a 44px+ touch target at ${width}px`);
        assert.ok(b.l >= 0 && b.r <= width, `${what} sits inside the screen at ${width}px`);
      }

      assert.deepEqual(errors, []);
      await page.close();
    }
  });
});

// ─── Starting a conversation from the phone ─────────────────────────────────
//
// The phone used to be watch-and-steer only: creating a session, choosing a
// model or pointing the agent at another directory all needed the desktop. The
// sheet (＋ in the header, "New session" in the drawer) closes that gap using
// the same server contract the desktop uses — POST /chat with no sessionId and
// no sessionFile, which the server answers by spawning a fresh pi session.

describe("starting a session from the phone", () => {
  /** A workspace directory under the test root (which is SCOPE_FILE_ROOT, so
   *  the server accepts it as a cwd). Realpath'd: the server stores/resolves
   *  real paths and the assertions compare against them. */
  function mkws(name) {
    const p = path.join(tmpDir, name);
    fs.mkdirSync(p, { recursive: true });
    return fs.realpathSync(p);
  }

  /** The global agent config the server falls back to: the workspace list the
   *  sheet offers, the models it can choose from, and (when given) the project's
   *  current team/mode. */
  function seedGlobalConfig({ workspaces = [], models = [], defaultModel = "", activeTeam = "", mode = "" } = {}) {
    fs.mkdirSync(agentDir, { recursive: true });
    const cfg = { chatWorkspaces: workspaces, chatWorkspacesRemoved: [] };
    if (activeTeam) cfg.activeTeam = activeTeam;
    if (mode) cfg.mode = mode;
    fs.writeFileSync(path.join(agentDir, "agent-team-config.json"), JSON.stringify(cfg, null, 2));
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ enabledModels: models, defaultModel }, null, 2)
    );
  }

  /** The global teams.yaml a project falls back to (agent dir → agents/). */
  function seedTeams(names) {
    const dir = path.join(agentDir, "agents");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "teams.yaml"), names.map((n) => `${n}:\n  - name: coder\n`).join("\n"));
  }

  const openSheet = async (page, sel) => {
    await page.click(sel);
    await page.waitForSelector("#m-sheet:not([hidden])", { timeout: 10_000 });
  };

  test("the ＋ opens the session sheet with the known workspaces and enabled models", async () => {
    const wsA = mkws("sheet-a");
    const wsB = mkws("sheet-b");
    seedGlobalConfig({ workspaces: [wsA, wsB], models: ["stub/one", "stub/two"], defaultModel: "stub/one" });
    // No model on the session, so the sheet must fall back to the default.
    await seedSession("sheet-seed", { cwd: wsA, model: null });

    const { page, errors } = await openMobile("sheet-seed");
    await page.waitForFunction(() => document.querySelector("#m-transcript")?.textContent?.includes("hi there"), null, { timeout: 15_000 });

    await openSheet(page, "#m-new");
    assert.match(await page.locator("#m-sheet-title").textContent(), /new session/i);

    // Both workspaces are offered, by leaf name and by full path.
    for (const w of [wsA, wsB]) {
      await page.waitForSelector(`#m-ws-list .m-opt[data-ws="${w}"]`, { timeout: 15_000 });
    }
    // (The label is the path's tail — two segments — so the leaf stays readable
    // however deep the workspace sits.)
    const names = await page.locator("#m-ws-list .m-opt-name").allTextContents();
    assert.ok(names.some((n) => n.endsWith("/sheet-a")) && names.some((n) => n.endsWith("/sheet-b")), `workspaces are listed by their path tail (${names})`);
    assert.ok((await page.locator("#m-ws-list").textContent()).includes(wsB), "the full path is shown too");

    // The enabled models are the choices, with the configured default selected.
    await page.waitForSelector('#m-model-select option[value="stub/two"]', { state: "attached", timeout: 15_000 });
    const values = await page.locator("#m-model-select option").evaluateAll((os) => os.map((o) => o.value));
    assert.ok(values.includes("stub/one") && values.includes("stub/two"), `the enabled models are the choices (${values})`);
    assert.equal(await page.locator("#m-model-select").inputValue(), "stub/one", "the configured default is preselected");

    // The picker is searchable on the phone too: typing narrows the list.
    await page.click("#m-model-select");
    await page.waitForSelector(".scope-sel-pop:not([hidden])");
    await page.keyboard.type("two");
    await page.waitForFunction(() => document.querySelectorAll(".scope-sel-opt").length === 1);
    assert.match(await page.textContent(".scope-sel-opt"), /stub\/two/);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".scope-sel-pop").isHidden(), true);

    // Picking a workspace marks it, and Escape closes the sheet.
    await page.click(`#m-ws-list .m-opt[data-ws="${wsB}"]`);
    assert.equal(await page.locator(`#m-ws-list .m-opt[data-ws="${wsB}"]`).getAttribute("aria-pressed"), "true");
    assert.match(await page.locator(`#m-ws-list .m-opt[data-ws="${wsB}"] .m-opt-tick`).textContent(), /✓/);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector("#m-sheet").hidden === true, null, { timeout: 5_000 });

    assert.deepEqual(errors, []);
    await page.close();
  });

  test("a new session runs in the chosen workspace with the chosen model", async () => {
    const wsA = mkws("create-a");
    const wsB = mkws("create-b");
    seedGlobalConfig({ workspaces: [wsA, wsB], models: ["stub/one", "stub/two"], defaultModel: "stub/one" });
    await seedSession("create-seed", { cwd: wsA });

    const { page, errors } = await openMobile("create-seed");
    await page.waitForFunction(() => document.querySelector("#m-transcript")?.textContent?.includes("hi there"), null, { timeout: 15_000 });

    await openSheet(page, "#m-new");
    await page.waitForSelector(`#m-ws-list .m-opt[data-ws="${wsB}"]`, { timeout: 15_000 });
    await page.click(`#m-ws-list .m-opt[data-ws="${wsB}"]`);
    await page.selectOption("#m-model-select", "stub/two");
    await page.click("#m-start");
    await page.waitForFunction(() => document.querySelector("#m-sheet").hidden === true, null, { timeout: 5_000 });

    // The phone is on a brand-new conversation, in that workspace, ready to type.
    assert.match(await page.locator("#m-title").textContent(), /new session/i);
    assert.match(await page.locator("#m-sub").textContent(), /create-b/);
    assert.match(await page.locator("#m-sub").textContent(), /ready/);
    assert.equal(await page.isEnabled("#m-input"), true, "the composer is armed");
    assert.match(await page.locator("#m-model-chip").textContent(), /stub\/two/, "the chip names the chosen model");

    // The first message spawns pi there — no pre-spawn left behind by picking.
    await page.fill("#m-input", "SLOW new session hello");
    await page.click("#m-send");
    await page.waitForFunction(() => document.querySelector("#m-stop").hidden === false, null, { timeout: 10_000 });
    await page.waitForFunction(() => {
      const nodes = [...document.querySelectorAll("#m-transcript .m-live .m-text")];
      return nodes.length && nodes[nodes.length - 1].textContent === "alpha";
    }, null, { timeout: 15_000 });

    const { data } = await api("/chat/status");
    const run = (data.runs || []).find((r) => r.prompt === "SLOW new session hello");
    assert.ok(run, "the phone's prompt started a real chat run");
    assert.equal(run.cwd, wsB, "it runs in the workspace chosen in the sheet");
    assert.equal(run.model, "stub/two", "…with the model chosen in the sheet");

    await page.click("#m-stop");
    await page.waitForFunction(() => document.querySelector("#m-stop").hidden === true, null, { timeout: 20_000 });
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("a new session adopts its recorded row, then keeps chatting in the same pi session", async () => {
    const ws = mkws("adopt-ws");
    seedGlobalConfig({ workspaces: [ws], models: ["stub/one"], defaultModel: "stub/one" });
    await seedSession("adopt-seed", { cwd: tmpDir });

    const { page, errors } = await openMobile("adopt-seed");
    await page.waitForFunction(() => document.querySelector("#m-transcript")?.textContent?.includes("hi there"), null, { timeout: 15_000 });

    await openSheet(page, "#m-new");
    await page.waitForSelector(`#m-ws-list .m-opt[data-ws="${ws}"]`, { timeout: 15_000 });
    await page.click(`#m-ws-list .m-opt[data-ws="${ws}"]`);
    await page.click("#m-start");
    await page.waitForFunction(() => document.querySelector("#m-sheet").hidden === true, null, { timeout: 5_000 });

    // A long turn, so the recording is published while it still streams.
    await page.fill("#m-input", "SLOW adopt me");
    await page.click("#m-send");
    await page.waitForFunction(() => {
      const nodes = [...document.querySelectorAll("#m-transcript .m-live .m-text")];
      return nodes.length && nodes[nodes.length - 1].textContent === "alpha";
    }, null, { timeout: 15_000 });

    // pi (via the scope extension) records the conversation as it runs.
    const SID_NEW = "adopt-recorded";
    const FILE = path.join(ws, "pi-session.jsonl");
    const now = new Date().toISOString();
    const seeded = await api("/events", {
      method: "POST",
      body: JSON.stringify([
        { event_id: `${SID_NEW}-1`, session_id: SID_NEW, seq: 1, ts: now, type: "session_start", cwd: ws, agent_name: "orchestrator", session_file: FILE, payload: {} },
        { event_id: `${SID_NEW}-2`, session_id: SID_NEW, seq: 2, ts: now, type: "user_message", cwd: ws, agent_name: "orchestrator", session_file: FILE, payload: { text: "SLOW adopt me" } },
      ]),
    });
    assert.ok(seeded.res.ok);
    // The row names a REAL pi session file: a continuation whose target is gone
    // is refused by the server (it would otherwise recreate the path and answer
    // from no context — see chat-resume.e2e.test.mjs), so the fixture the resume
    // is tested against has to exist.
    fs.writeFileSync(FILE, `${JSON.stringify({ type: "session", version: 3, id: "adopt-1", timestamp: now, cwd: ws })}\n`);

    await page.waitForFunction(() => document.querySelector("#m-stop").hidden === true, null, { timeout: 25_000 });

    // The conversation is now the recorded row: the drawer marks it as open.
    await page.click("#m-menu");
    await page.waitForSelector("#m-drawer.open");
    await page.waitForSelector(`.m-sess.active[data-sid="${SID_NEW}"]`, { timeout: 15_000 });
    await page.click("#m-drawer-close");

    // …and the next message resumes that conversation's pi session file.
    await page.fill("#m-input", "SLOW follow up");
    await page.click("#m-send");
    await page.waitForFunction(() => {
      const nodes = [...document.querySelectorAll("#m-transcript .m-live .m-text")];
      return nodes.length && nodes[nodes.length - 1].textContent === "alpha";
    }, null, { timeout: 15_000 });

    const { data } = await api("/chat/status");
    const run = (data.runs || []).find((r) => r.prompt === "SLOW follow up");
    assert.ok(run, "the follow-up run is in flight");
    assert.equal(run.resumedFile, FILE, "the follow-up continues the recorded pi session");

    await page.click("#m-stop");
    await page.waitForFunction(() => document.querySelector("#m-stop").hidden === true, null, { timeout: 20_000 });
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("the model chip re-points the open chat at another model", async () => {
    const ws = mkws("model-ws");
    seedGlobalConfig({ workspaces: [ws], models: ["stub/one", "stub/two"], defaultModel: "stub/one" });
    await seedSession("model-seed", { cwd: ws, model: null });

    const { page, errors } = await openMobile("model-seed");
    await page.waitForFunction(() => document.querySelector("#m-transcript")?.textContent?.includes("hi there"), null, { timeout: 15_000 });
    assert.match(await page.locator("#m-model-chip").textContent(), /stub\/one/, "the chip shows the model this chat would run with");

    await openSheet(page, "#m-model-chip");
    // Only the model is on offer here — the workspace field belongs to a new session.
    assert.equal(await page.locator("#m-field-ws").isHidden(), true);
    assert.equal(await page.locator("#m-start").isHidden(), true);
    await page.waitForSelector('#m-model-select option[value="stub/two"]', { state: "attached", timeout: 15_000 });
    await page.selectOption("#m-model-select", "stub/two");
    await page.click("#m-apply-model");
    await page.waitForFunction(() => document.querySelector("#m-sheet").hidden === true, null, { timeout: 5_000 });
    assert.match(await page.locator("#m-model-chip").textContent(), /stub\/two/, "the chip follows the choice");

    // The next message runs with the new model.
    await page.fill("#m-input", "SLOW model switch");
    await page.click("#m-send");
    await page.waitForFunction(() => {
      const nodes = [...document.querySelectorAll("#m-transcript .m-live .m-text")];
      return nodes.length && nodes[nodes.length - 1].textContent === "alpha";
    }, null, { timeout: 15_000 });

    const { data } = await api("/chat/status");
    const run = (data.runs || []).find((r) => r.prompt === "SLOW model switch");
    assert.ok(run, "the run is in flight");
    assert.equal(run.model, "stub/two", "it runs with the newly chosen model");

    await page.click("#m-stop");
    await page.waitForFunction(() => document.querySelector("#m-stop").hidden === true, null, { timeout: 20_000 });
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("a workspace can be added by path from the phone", async () => {
    const ws = mkws("add-ws");
    const other = mkws("added-ws");
    seedGlobalConfig({ workspaces: [ws], models: ["stub/one"], defaultModel: "stub/one" });
    await seedSession("add-seed", { cwd: ws });

    const { page, errors } = await openMobile("add-seed");
    await page.waitForFunction(() => document.querySelector("#m-transcript")?.textContent?.includes("hi there"), null, { timeout: 15_000 });

    // The drawer's own "New session" action (only clickable once it is open).
    await page.click("#m-menu");
    await page.waitForSelector("#m-drawer.open");
    await page.click("#m-drawer-new");
    await page.waitForSelector("#m-sheet:not([hidden])", { timeout: 10_000 });
    await page.fill("#m-ws-input", other);
    await page.click("#m-ws-add");

    // The added directory joins the list and becomes the selected workspace.
    await page.waitForSelector(`#m-ws-list .m-opt[data-ws="${other}"]`, { timeout: 15_000 });
    assert.equal(await page.locator(`#m-ws-list .m-opt[data-ws="${other}"]`).getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("#m-ws-input").inputValue(), "", "the input is cleared");

    // It is persisted server-side, not just in this page's memory.
    const { data } = await api(`/agent-team?cwd=${enc(ws)}`);
    assert.ok((data.chatWorkspaces || []).includes(other), "the server stored the workspace");

    await page.click("#m-start");
    await page.waitForFunction(() => document.querySelector("#m-sheet").hidden === true, null, { timeout: 5_000 });
    await page.fill("#m-input", "SLOW added workspace");
    await page.click("#m-send");
    await page.waitForFunction(() => {
      const nodes = [...document.querySelectorAll("#m-transcript .m-live .m-text")];
      return nodes.length && nodes[nodes.length - 1].textContent === "alpha";
    }, null, { timeout: 15_000 });
    const status = await api("/chat/status");
    const run = (status.data.runs || []).find((r) => r.prompt === "SLOW added workspace");
    assert.ok(run, "the run started in the added workspace");
    assert.equal(run.cwd, other);

    await page.click("#m-stop");
    await page.waitForFunction(() => document.querySelector("#m-stop").hidden === true, null, { timeout: 20_000 });
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("the sheet picks the agent team and mode the new session boots with", async () => {
    const ws = mkws("team-ws");
    seedGlobalConfig({ workspaces: [ws], models: ["stub/one"], defaultModel: "stub/one", activeTeam: "alpha_team", mode: "standard" });
    seedTeams(["alpha_team", "beta_team"]);
    await seedSession("team-seed", { cwd: tmpDir, model: null });

    const { page, errors } = await openMobile("team-seed");
    await page.waitForFunction(() => document.querySelector("#m-transcript")?.textContent?.includes("hi there"), null, { timeout: 15_000 });

    await openSheet(page, "#m-new");
    await page.waitForSelector(`#m-ws-list .m-opt[data-ws="${ws}"]`, { timeout: 15_000 });
    await page.click(`#m-ws-list .m-opt[data-ws="${ws}"]`);

    // The sheet offers that workspace's teams and modes, with the current
    // values selected — leaving them alone changes nothing.
    await page.waitForSelector('#m-team-select option[value="beta_team"]', { state: "attached", timeout: 15_000 });
    assert.deepEqual(
      await page.locator("#m-team-select option").evaluateAll((os) => os.map((o) => o.value)),
      ["alpha_team", "beta_team"],
      "every team, in the configured order"
    );
    assert.equal(await page.locator("#m-team-select").inputValue(), "alpha_team", "the active team is preselected");
    assert.deepEqual(
      await page.locator("#m-mode-select option").evaluateAll((os) => os.map((o) => o.value)),
      ["standard", "creative"]
    );
    assert.equal(await page.locator("#m-mode-select").inputValue(), "standard", "the current mode is preselected");

    await page.selectOption("#m-team-select", "beta_team");
    await page.selectOption("#m-mode-select", "creative");

    // Switching the workspace refetches that project's team/mode; the picks the
    // user just made must not snap back when that snapshot lands.
    await page.click(`#m-ws-list .m-opt[data-ws="${tmpDir}"]`);
    await page.waitForTimeout(600);
    assert.equal(await page.locator("#m-team-select").inputValue(), "beta_team", "the picked team survives a refetch");
    assert.equal(await page.locator("#m-mode-select").inputValue(), "creative", "the picked mode survives a refetch");
    await page.click(`#m-ws-list .m-opt[data-ws="${ws}"]`);

    // Starting must persist them: pi reads exactly this config when the new
    // session's subprocess boots on the first message.
    await page.click("#m-start");
    await page.waitForFunction(() => document.querySelector("#m-sheet").hidden === true, null, { timeout: 10_000 });

    const stored = await api(`/agent-team?cwd=${enc(ws)}`);
    assert.equal(stored.data.activeTeam, "beta_team", "the chosen team is persisted for that project");
    assert.equal(stored.data.mode, "creative", "the chosen mode is persisted for that project");

    // …and the session itself still starts normally in that workspace.
    await page.fill("#m-input", "SLOW team session");
    await page.click("#m-send");
    await page.waitForFunction(() => {
      const nodes = [...document.querySelectorAll("#m-transcript .m-live .m-text")];
      return nodes.length && nodes[nodes.length - 1].textContent === "alpha";
    }, null, { timeout: 15_000 });
    const status = await api("/chat/status");
    const run = (status.data.runs || []).find((r) => r.prompt === "SLOW team session");
    assert.ok(run, "the run started");
    assert.equal(run.cwd, ws, "in the workspace chosen alongside the team/mode");

    await page.click("#m-stop");
    await page.waitForFunction(() => document.querySelector("#m-stop").hidden === true, null, { timeout: 20_000 });
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("the empty state offers a way to start a conversation", async () => {
    // A fresh phone with no saved session: the drawer is empty, but ＋ and the
    // empty-state button still open the sheet.
    seedGlobalConfig({ workspaces: [], models: ["stub/one"], defaultModel: "stub/one" });
    const { page, errors } = await phonePage();
    await page.goto(`${base}/m?token=${TOKEN}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#m-composer");

    await page.click("#m-transcript [data-new]");
    await page.waitForSelector("#m-sheet:not([hidden])", { timeout: 10_000 });
    assert.match(await page.locator("#m-sheet-title").textContent(), /new session/i);

    await page.click("#m-sheet-close");
    await page.waitForFunction(() => document.querySelector("#m-sheet").hidden === true, null, { timeout: 5_000 });
    assert.deepEqual(errors, []);
    await page.close();
  });
});

// ─── Deleting a session from the phone ──────────────────────────────────────
//
// The drawer's ✕ is the same destructive action the desktop rail offers
// (DELETE /sessions/:id plus a kill of the pi subprocess behind it). It is the
// one action on this screen that cannot be undone, so it is behind a confirm()
// and the tests cover both answers.

describe("deleting a session from the phone", () => {
  const wsDir = (name) => {
    const p = path.join(tmpDir, name);
    fs.mkdirSync(p, { recursive: true });
    return fs.realpathSync(p);
  };

  const serverHas = async (sid) => {
    const { data } = await api("/sessions?limit=200");
    return (data.sessions || []).some((s) => s.session_id === sid);
  };

  test("the drawer deletes a session, but only after the confirm", async () => {
    const ws = wsDir("del-ws");
    await seedSession("del-keep", { cwd: ws });
    await seedSession("del-gone", { cwd: ws, agent: "deleteme" });

    const { page, errors } = await openMobile("del-keep");
    await page.waitForFunction(() => document.querySelector("#m-transcript")?.textContent?.includes("hi there"), null, { timeout: 15_000 });
    await page.click("#m-menu");
    await page.waitForSelector("#m-drawer.open");
    await page.waitForSelector('.m-sess-del[data-del="del-gone"]', { timeout: 15_000 });

    // Dismissing the confirm is a no-op: nothing is deleted on the server.
    page.once("dialog", (d) => d.dismiss());
    await page.click('.m-sess-del[data-del="del-gone"]');
    await page.waitForTimeout(500);
    assert.equal(await serverHas("del-gone"), true, "dismissing the confirm keeps the session");
    assert.ok(await page.locator('.m-sess-del[data-del="del-gone"]').count(), "…and its row");

    // Accepting it deletes for real. The handler is registered first on
    // purpose: a JS dialog blocks the page until it is answered, so the click
    // cannot settle while one is open.
    let message = "";
    page.once("dialog", (d) => { message = d.message(); return d.accept(); });
    await page.click('.m-sess-del[data-del="del-gone"]');
    assert.match(message, /deleteme/, "the confirm names the session it will delete");

    await page.waitForFunction(() => !document.querySelector('.m-sess-del[data-del="del-gone"]'), null, { timeout: 15_000 });
    assert.equal(await serverHas("del-gone"), false, "the session and its events are gone from the server");
    assert.equal(await serverHas("del-keep"), true, "the other session is untouched");

    // The session that was on screen is still the one on screen.
    assert.match(await page.locator("#m-transcript").textContent(), /hi there — recording works/);
    assert.equal(await page.isEnabled("#m-input"), true);

    assert.deepEqual(errors, []);
    await page.close();
  });

  test("deleting a session kills the pi subprocess behind it", async () => {
    // A phone-started conversation is served by a subprocess keyed by a
    // GENERATED id (not the recorded session id), so deleting the row only
    // really deletes the conversation if that subprocess is killed with it —
    // otherwise pi keeps running and re-writes events for a session that no
    // longer exists.
    const ws = wsDir("del-live-ws");
    await seedSession("del-live-seed", { cwd: ws });

    const { page, errors } = await openMobile("del-live-seed");
    await page.waitForFunction(() => document.querySelector("#m-transcript")?.textContent?.includes("hi there"), null, { timeout: 15_000 });

    await page.click("#m-new");
    await page.waitForSelector("#m-sheet:not([hidden])", { timeout: 10_000 });
    await page.waitForSelector(`#m-ws-list .m-opt[data-ws="${ws}"]`, { timeout: 15_000 });
    await page.click(`#m-ws-list .m-opt[data-ws="${ws}"]`);
    await page.click("#m-start");
    await page.waitForFunction(() => document.querySelector("#m-sheet").hidden === true, null, { timeout: 10_000 });

    await page.fill("#m-input", "SLOW delete me");
    await page.click("#m-send");
    await page.waitForFunction(() => {
      const nodes = [...document.querySelectorAll("#m-transcript .m-live .m-text")];
      return nodes.length && nodes[nodes.length - 1].textContent === "alpha";
    }, null, { timeout: 15_000 });

    // pi records it while the turn runs, and the phone adopts that row.
    const SID_NEW = "del-live-recorded";
    const now = new Date().toISOString();
    await api("/events", {
      method: "POST",
      body: JSON.stringify([
        { event_id: `${SID_NEW}-1`, session_id: SID_NEW, seq: 1, ts: now, type: "session_start", cwd: ws, agent_name: "orchestrator", session_file: path.join(ws, "pi.jsonl"), payload: {} },
        { event_id: `${SID_NEW}-2`, session_id: SID_NEW, seq: 2, ts: now, type: "user_message", cwd: ws, agent_name: "orchestrator", session_file: path.join(ws, "pi.jsonl"), payload: { text: "SLOW delete me" } },
      ]),
    });
    await page.waitForFunction(() => document.querySelector("#m-stop").hidden === true, null, { timeout: 25_000 });

    const before = await api("/chat/status");
    const target = (before.data.runs || []).find((r) => r.cwd === ws && r.prompted);
    assert.ok(target, "the conversation's pi subprocess is still alive");
    assert.notEqual(target.sessionId, SID_NEW, "it is keyed by a generated id, not the recorded session id");

    await page.click("#m-menu");
    await page.waitForSelector("#m-drawer.open");
    await page.waitForSelector(`.m-sess-del[data-del="${SID_NEW}"]`, { timeout: 15_000 });
    page.once("dialog", (d) => d.accept());
    await page.click(`.m-sess-del[data-del="${SID_NEW}"]`);
    await page.waitForFunction(
      (sid) => !document.querySelector(`.m-sess-del[data-del="${sid}"]`),
      SID_NEW,
      { timeout: 15_000 }
    );

    const until = Date.now() + 10_000;
    for (;;) {
      const after = await api("/chat/status");
      if (!(after.data.runs || []).some((r) => r.sessionId === target.sessionId)) break;
      if (Date.now() > until) throw new Error("the pi subprocess was left running after the delete");
      await sleep(150);
    }

    assert.deepEqual(errors, []);
    await page.close();
  });

  test("deleting the open session empties the phone back to its start state", async () => {
    const ws = wsDir("del-open-ws");
    await seedSession("del-open", { cwd: ws });

    const { page, errors } = await openMobile("del-open");
    await page.waitForFunction(() => document.querySelector("#m-transcript")?.textContent?.includes("hi there"), null, { timeout: 15_000 });
    assert.equal(await page.isEnabled("#m-input"), true, "the composer is armed for the open session");

    await page.click("#m-menu");
    await page.waitForSelector("#m-drawer.open");
    await page.waitForSelector('.m-sess-del[data-del="del-open"]', { timeout: 15_000 });
    page.once("dialog", (d) => d.accept());
    await page.click('.m-sess-del[data-del="del-open"]');

    // No session is open any more: the shipped empty state is back (including
    // its "new session" button) and there is nothing to type into.
    await page.waitForFunction(
      () => document.querySelector("#m-transcript")?.textContent?.includes("Tap ☰ to pick a session"),
      null,
      { timeout: 15_000 }
    );
    assert.ok(await page.locator("#m-transcript [data-new]").count(), "the empty state offers a new session");
    assert.equal(await page.isEnabled("#m-input"), false, "the composer is disarmed");
    assert.equal(await page.locator("#m-model-chip").isHidden(), true);
    assert.equal(await page.locator("#m-sub").textContent(), "pick a session");
    assert.match(await page.locator("#m-hint").textContent(), /deleted/);
    assert.equal(await serverHas("del-open"), false);

    await page.click("#m-drawer-close");
    await page.waitForFunction(() => !document.querySelector("#m-drawer").classList.contains("open"));
    assert.deepEqual(errors, []);
    await page.close();
  });
});

describe("the pairing panel", () => {
  test("the QR URL points at the mobile layout and keeps the token", async () => {
    const { page } = await phonePage();
    await page.goto(`${base}/?token=${TOKEN}&ui=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof window.SCOPE?.mobileUrlFor === "function", null, { timeout: 15_000 });

    const url = await page.evaluate(() => window.SCOPE.mobileUrlFor("http://192.168.1.44:43190/?token=deadbeef"));
    const parsed = new URL(url);
    assert.equal(parsed.pathname, "/m", "the phone opens the mobile entry");
    assert.equal(parsed.searchParams.get("token"), "deadbeef", "the token rides along");
    assert.equal(parsed.searchParams.get("ui"), "mobile", "the layout is explicit, not sniffed");

    // The panel encodes that URL in the QR: stub /lan as a LAN-bound server
    // would answer (this test server binds loopback, so it advertises nothing).
    await page.route("**/lan*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          lan_exposed: true,
          port: 43190,
          bind_host: "0.0.0.0",
          ips: ["192.168.1.44"],
          urls: ["http://192.168.1.44:43190/?token=deadbeef"],
        }),
      }));
    await page.click("#btn-phone");
    await page.waitForSelector("#phone-modal", { state: "visible", timeout: 10_000 });
    await page.waitForSelector("#phone-url", { timeout: 10_000 });
    assert.equal(
      await page.locator("#phone-url").textContent(),
      "http://192.168.1.44:43190/m?token=deadbeef&ui=mobile",
      "the QR points at the mobile layout, with the token and the explicit ui hint"
    );
    assert.ok(await page.locator(".phone-qr-wrap svg").count(), "a QR was rendered for that URL");
    await page.close();
  });
});

test("/index.html stays the desktop document even on a phone UA", async () => {
  // The file name is explicit: a bookmark of the old URL can never be silently
  // swapped for the phone layout.
  const { page, errors } = await phonePage();
  await page.goto(`${base}/index.html?token=${TOKEN}#view=chat`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.SCOPE?.Plugins?.isSynced?.() === true, null, { timeout: 20_000 });
  assert.equal(await page.evaluate(() => window.SCOPE.Plugins.activeView()?.id), "chat");
  assert.ok(await page.locator("#chat-composer").count());
  assert.deepEqual(errors, []);
  await page.close();
});
