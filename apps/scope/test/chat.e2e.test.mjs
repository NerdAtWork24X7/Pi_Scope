// End-to-end tests for the Chat view, run in headless Chromium against the
// mock backend in ./mock-backend.mjs (which serves the real public/ assets).
//
//   node --test apps/scope/test/chat.e2e.test.mjs
//
// Focus: workspace selection / restore / add / remove / nesting edge cases, and
// the streaming + click flows the page depends on.

import { test, before, after, beforeEach, afterEach, describe } from "node:test";
import assert from "node:assert/strict";

import { startMockBackend, defaultTeam, makeSession } from "./mock-backend.mjs";
import {
  launchBrowser, openChat, applySessions, send, reply,
  wsRow, sessRow, sessDel, foldRow, sleep,
} from "./harness.mjs";

const WS_A = "/tmp/pi-scope-e2e/alpha";
const WS_B = "/tmp/pi-scope-e2e/beta";

const SESS_A = { session_id: "sess-a", cwd: WS_A, agent_name: "orchestrator", first_msg: "alpha work" };
const SESS_B = { session_id: "sess-b", cwd: WS_B, agent_name: "orchestrator", first_msg: "beta work" };

let browser;
let mock;
let context = null;
let page = null;
let env = null;

before(async () => {
  mock = await startMockBackend();
  browser = await launchBrowser();
});
after(async () => {
  if (browser) await browser.close();
  if (mock) await mock.close();
});
beforeEach(() => { mock.reset(); });
afterEach(async () => {
  if (context) await context.close();
  context = null;
  page = null;
});

/** Seed fixtures + load the page. */
async function boot({ sessions = [], events = {}, team, seed = {}, query = "" } = {}) {
  mock.setSessions(sessions);
  mock.setTeam(team || defaultTeam());
  for (const [sid, evs] of Object.entries(events)) mock.setEvents(sid, evs);
  env = await openChat(browser, mock, { seed, query });
  context = env.context;
  page = env.page;
  return env;
}

const canvas = () => page.textContent("#chat-messages");
const hint = () => page.textContent("#chat-composer-hint");

// ─── Workspaces ────────────────────────────────────────────────────────────

describe("chat workspaces", () => {
  test("boots with no workspace selected: hero shown, composer hidden", async () => {
    await boot({ sessions: [makeSession(SESS_A)] });
    await page.waitForSelector(`.chat-ws[data-cwd="${WS_A}"]`);
    assert.equal(await page.locator(".chat-ws.active").count(), 0);
    assert.match(await canvas(), /Chat with your coding agent/);
    assert.equal(await page.locator("#chat-composer").isVisible(), false);
  });

  test("a session-less custom workspace renders and can be selected", async () => {
    const CUSTOM = "/tmp/pi-scope-e2e/custom";
    await boot({ team: defaultTeam({ chatWorkspaces: [CUSTOM] }) });
    const row = await page.waitForSelector(`.chat-ws[data-cwd="${CUSTOM}"]`);
    assert.ok(row, "custom workspace row rendered");
    assert.match(await row.textContent(), /no sessions/);
    await wsRow(page, CUSTOM).click();
    await page.waitForSelector(`.chat-ws.active[data-cwd="${CUSTOM}"]`);
    assert.match(await canvas(), /custom/);
    assert.equal(await page.locator("#chat-composer").isVisible(), true);
  });

  test("clicking a workspace selects it, expands it and shows its own conversation", async () => {
    await boot({ sessions: [makeSession(SESS_A)] });
    await wsRow(page, WS_A).click();
    await page.waitForSelector(`.chat-ws.active[data-cwd="${WS_A}"]`);
    assert.equal(await page.locator("#chat-composer").isVisible(), true);
    // its own session list is revealed on selection
    assert.equal(await sessRow(page, "sess-a").isVisible(), true);
    // the canvas is the workspace's own (empty) conversation, not a transcript
    assert.ok(!/from session/.test(await hint()));
  });

  test("REGRESSION: selecting a workspace focuses the composer so typing works without an extra click", async () => {
    // Reported flow: clear/leave a session in the Single view, switch to Chat,
    // click a workspace, then type. The rail row is a plain div (not focusable),
    // so without an explicit focus the caret stayed on the now-hidden Single
    // view and keystrokes went nowhere — the composer looked normal but ignored
    // input.
    await boot({ sessions: [makeSession(SESS_A), makeSession(SESS_B)] });
    await page.evaluate(() => window.setView("single"));
    await page.evaluate(() => window.setView("chat"));
    await wsRow(page, WS_B).click();
    await page.waitForFunction(() => document.activeElement?.id === "chat-input", undefined, { timeout: 4000 });
    await page.keyboard.type("typed without clicking");
    assert.equal(await page.inputValue("#chat-input"), "typed without clicking", "keyboard reaches the composer");
  });

  test("REGRESSION: the Chat button hard-reloads with a cache-bust marker", async () => {
    // Clicking Chat must not run a renderer-cached copy of the chat JS/CSS: it
    // navigates to the chat view with ?_=<ts> so the server tags the page's
    // local assets with the same marker and they are fetched fresh.
    await boot({ sessions: [makeSession(SESS_A)] });
    await page.evaluate(() => window.setView("single"));
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.click("#btn-chat"),
    ]);
    const u = new URL(page.url());
    assert.equal(u.searchParams.get("view"), "chat", "Chat button targets the chat view");
    assert.ok(u.searchParams.get("_"), "a cache-bust marker is present");
    assert.equal(u.hash, "#view=chat", "the reloaded app lands on Chat");
    await page.waitForSelector("#chat-workspaces");
  });

  test("REGRESSION: a native dialog leaves the composer caret desynced — regaining focus forces a real caret cycle", async () => {
    // Reported flow: delete a workspace/session (confirm() dialog), return to
    // Chat — the box glows but no blinking caret shows; the caret only came back
    // after adding a workspace. Electron/Chromium can return from confirm() with
    // the composer still the activeElement but its caret desynced, and focus()
    // on the already-active element is a no-op. The window-focus handler must
    // therefore force a real blur→focus cycle. Count focus events: a second one
    // (while already active) proves the cycle ran and the caret is repainted.
    await boot({ sessions: [makeSession(SESS_A)] });
    await wsRow(page, WS_A).click();
    await page.waitForFunction(() => document.activeElement?.id === "chat-input", undefined, { timeout: 4000 });

    await page.evaluate(() => {
      window.__composerFocuses = 0;
      document.getElementById("chat-input").addEventListener("focus", () => { window.__composerFocuses++; });
    });
    // Simulate the window regaining focus after the native dialog while the
    // composer is still the activeElement (the desynced case).
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForFunction(() => window.__composerFocuses >= 1, undefined, { timeout: 2000 });
    assert.equal(await page.evaluate(() => document.activeElement?.id), "chat-input", "composer stays focused");
  });

  test("REGRESSION: clicking an empty workspace re-arms a pi session without a New-session click", async () => {
    // Reported flow: delete a workspace's session in the Single page, return to
    // Chat. The workspace is still the active one, so re-clicking it goes
    // through showFreeConversation (not selectWorkspace) — which used to skip
    // ensureChatSession. The box appeared but no session was armed behind it, so
    // nothing happened until the user clicked "New session".
    const starts = () => mock.requestsFor("/chat/start", "POST").length;
    const waitForStart = async (above, ms = 4000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (starts() > above) return;
        await sleep(50);
      }
      throw new Error(`no /chat/start after re-clicking the empty workspace (still ${starts()})`);
    };

    await boot({ sessions: [], team: defaultTeam({ chatWorkspaces: [WS_A] }) });
    await wsRow(page, WS_A).click();
    await waitForStart(0);

    // Chat a turn; pi records it as sess-a and the workspace thread adopts it
    // (the same thread is then keyed under both free:<cwd> and sess-a).
    const turn = await send(page, mock, "hello");
    await reply(turn, "hi", { sessionId: "sess-a" });
    // Wait for the turn to finalize: adoption (below) refuses a still-busy
    // thread, so the alias must exist before we delete its row.
    await page.waitForFunction(() => !document.getElementById("chat-stop").classList.contains("show"));
    await applySessions(page, mock, [makeSession({ session_id: "sess-a", cwd: WS_A, agent_name: "orchestrator", first_msg: "hello" })]);
    await page.waitForSelector('.ws-sess[data-sid="sess-a"]', { state: "visible" });

    page.on("dialog", (d) => d.accept());
    await page.evaluate(() => window.setView("single"));
    await page.evaluate(() => window.SCOPE.deleteSession("sess-a"));
    await page.waitForFunction(() => window.__SCOPE_STATE.sessions.length === 0);
    await page.evaluate(() => window.setView("chat"));

    // Re-click the now-empty workspace (still the active row). Deleting the
    // adopted session dropped the thread's key, so it must arm a fresh session
    // on its own instead of leaving the box inert until "New session" is hit.
    const before = starts();
    await wsRow(page, WS_A).click();
    await waitForStart(before);

    // And the composer works immediately — no "New session" detour.
    await page.click("#chat-input");
    await page.keyboard.type("ready to type");
    assert.equal(await page.inputValue("#chat-input"), "ready to type");
  });

  test("the caret expands/collapses a workspace's sessions and persists the choice", async () => {
    await boot({ sessions: [makeSession(SESS_A)] });
    await page.waitForSelector(`.chat-ws[data-cwd="${WS_A}"]`);
    assert.equal(await sessRow(page, "sess-a").isVisible(), false, "collapsed by default");
    await wsRow(page, WS_A).locator(".chat-ws-caret").click();
    await page.waitForSelector(`.ws-sess[data-sid="sess-a"]`, { state: "visible" });
    const stored = await page.evaluate(() => localStorage.getItem("scope-chat-ws-expanded") || "");
    assert.ok(stored.includes(WS_A), "expansion persisted");
    // collapsing again hides them
    await wsRow(page, WS_A).locator(".chat-ws-caret").click();
    await page.waitForFunction((cwd) => {
      const kids = document.querySelector(`.chat-ws[data-cwd="${cwd}"] + .chat-ws-children`);
      return kids && kids.style.display === "none";
    }, WS_A);
  });

  test("clicking a session row opens its transcript", async () => {
    await boot({
      sessions: [makeSession(SESS_B)],
      events: {
        "sess-b": [
          { type: "user_message", ts: 1, payload: { text: "beta work" } },
          { type: "assistant_message", ts: 2, payload: { text: "RECORDED-ANSWER" } },
        ],
      },
      seed: { "scope-chat-ws-expanded": JSON.stringify([WS_B]) },
    });
    await wsRow(page, WS_B).click();
    await sessRow(page, "sess-b").click();
    await page.waitForFunction(() => document.getElementById("chat-messages").textContent.includes("RECORDED-ANSWER"));
    assert.match(await hint(), /from session/);
  });

  test("REGRESSION: a workspace click never opens a recorded session", async () => {
    // B has a live free conversation whose first prompt matches its recorded
    // session's first message (so the rail aliases the two onto one thread).
    const first = "beta work";
    await boot({
      sessions: [makeSession(SESS_A), makeSession(SESS_B)],
      events: {
        "sess-b": [
          { type: "user_message", ts: 1, payload: { text: first } },
          { type: "assistant_message", ts: 2, payload: { text: "SESSION-ONLY-CONTENT" } },
        ],
      },
      seed: { "scope-chat-ws-expanded": JSON.stringify([WS_A, WS_B]) },
    });

    // Start a conversation in B, then open B's recorded session row.
    await wsRow(page, WS_B).click();
    const turn = await send(page, mock, first);
    await reply(turn, "beta free reply");
    await page.waitForSelector(".chat-msg.chat-ai:not(.chat-ai-live)");
    await sessRow(page, "sess-b").click();
    await sleep(50);

    // Leave and come back by clicking the WORKSPACE row.
    await wsRow(page, WS_A).click();
    await wsRow(page, WS_B).click();
    await page.waitForFunction((cwd) => document.querySelector(".chat-ws.active")?.dataset.cwd === cwd, WS_B);

    const text = await canvas();
    assert.ok(!text.includes("SESSION-ONLY-CONTENT"), "workspace click must not show a session transcript");
    assert.ok(text.includes("beta free reply"), "workspace shows its own conversation");
    assert.ok(!/from session/.test(await hint()), "hint describes the workspace conversation");
  });

  test("subagent sessions fold under their parent; orphans stay visible", async () => {
    const parent = makeSession({ session_id: "p1", cwd: WS_A, first_msg: "parent" });
    const child = makeSession({ session_id: "c1", cwd: WS_A, first_msg: "child", parent_session_id: "p1", agent_name: "builder" });
    await boot({ sessions: [parent, child], seed: { "scope-chat-ws-expanded": JSON.stringify([WS_A]) } });

    assert.equal(await foldRow(page, "p1").count(), 1);
    assert.match(await foldRow(page, "p1").textContent(), /1 sub-session/);
    assert.equal(await sessRow(page, "c1").isVisible(), false, "folded by default");

    await foldRow(page, "p1").click();
    await page.waitForSelector(`.ws-sess[data-sid="c1"]`, { state: "visible" });
    assert.ok((await page.evaluate(() => localStorage.getItem("scope-chat-sub-open") || "")).includes("p1"));

    // A child whose parent isn't in the same workspace list renders as a root.
    const orphan = makeSession({ session_id: "o1", cwd: WS_A, first_msg: "orphan", parent_session_id: "nope" });
    await applySessions(page, mock, [parent, child, orphan]);
    assert.equal(await sessRow(page, "o1").count(), 1);
    assert.equal(await foldRow(page, "o1").count(), 0);
  });

  test("REGRESSION: a main session keeps running status while its subagent is live", async () => {
    // The moment a main session dispatches work its own last_ts goes stale, so
    // the row used to flip to "waiting" while the subagent was still running.
    const parent = makeSession({
      session_id: "p1", cwd: WS_A, first_msg: "dispatch",
      last_ts: new Date(Date.now() - 60_000).toISOString(),
    });
    const child = makeSession({ session_id: "c1", cwd: WS_A, first_msg: "child", parent_session_id: "p1", agent_name: "builder" });
    await boot({ sessions: [parent, child], seed: { "scope-chat-ws-expanded": JSON.stringify([WS_A]) } });
    await page.waitForSelector('.ws-sess[data-sid="p1"]');

    assert.equal(
      await page.getAttribute('.ws-sess[data-sid="p1"] .status-dot', "class"),
      "status-dot green",
      "main session shows running while a descendant is green"
    );
    assert.match(await page.getAttribute('.ws-sess[data-sid="p1"]', "title"), /working/);

    // Once the subagent is stale too, the main session returns to "waiting".
    const stale = makeSession({
      session_id: "c1", cwd: WS_A, first_msg: "child", parent_session_id: "p1", agent_name: "builder",
      last_ts: new Date(Date.now() - 60_000).toISOString(),
    });
    await applySessions(page, mock, [parent, stale]);
    await page.waitForFunction(() =>
      document.querySelector('.ws-sess[data-sid="p1"] .status-dot')?.className === "status-dot orange");
    assert.match(await page.getAttribute('.ws-sess[data-sid="p1"]', "title"), /waiting/);
  });

  test("REGRESSION: a stopped main session is never masked by a live subagent", async () => {
    const parent = makeSession({
      session_id: "p1", cwd: WS_A, first_msg: "dispatch", has_shutdown: true,
      last_ts: new Date(Date.now() - 60_000).toISOString(),
    });
    const child = makeSession({ session_id: "c1", cwd: WS_A, first_msg: "child", parent_session_id: "p1", agent_name: "builder" });
    await boot({ sessions: [parent, child], seed: { "scope-chat-ws-expanded": JSON.stringify([WS_A]) } });
    await page.waitForSelector('.ws-sess[data-sid="p1"]');

    assert.equal(await page.getAttribute('.ws-sess[data-sid="p1"] .status-dot', "class"), "status-dot red");
    assert.match(await page.getAttribute('.ws-sess[data-sid="p1"]', "title"), /stopped/);
  });

  test("REGRESSION: a session runs from turn_start until turn_end, not on a recency window", async () => {
    // A stale last_ts must NOT flip an open turn to "waiting": a long tool call
    // or a wait on a dispatched subagent keeps the turn open.
    const running = makeSession({
      session_id: "r1", cwd: WS_A, first_msg: "long tool call",
      last_ts: new Date(Date.now() - 3_600_000).toISOString(),
      last_turn_event: "turn_start",
    });
    // A closed turn is "waiting" for the next prompt even though it just spoke.
    const waiting = makeSession({ session_id: "w1", cwd: WS_A, first_msg: "answered", last_turn_event: "turn_end" });
    await boot({ sessions: [running, waiting], seed: { "scope-chat-ws-expanded": JSON.stringify([WS_A]) } });
    await page.waitForSelector('.ws-sess[data-sid="r1"]');

    assert.equal(await page.getAttribute('.ws-sess[data-sid="r1"] .status-dot', "class"), "status-dot green");
    assert.match(await page.getAttribute('.ws-sess[data-sid="r1"]', "title"), /working/);
    assert.equal(await page.getAttribute('.ws-sess[data-sid="w1"] .status-dot', "class"), "status-dot orange");
    assert.match(await page.getAttribute('.ws-sess[data-sid="w1"]', "title"), /waiting/);

    // A session with no captured turn events still falls back to recency.
    const legacy = makeSession({ session_id: "l1", cwd: WS_A, first_msg: "legacy", last_ts: new Date(Date.now() - 3_600_000).toISOString() });
    await applySessions(page, mock, [running, waiting, legacy]);
    await page.waitForFunction(() =>
      document.querySelector('.ws-sess[data-sid="l1"] .status-dot')?.className === "status-dot orange"
    );
    assert.equal(await page.getAttribute('.ws-sess[data-sid="r1"] .status-dot', "class"), "status-dot green");
  });

  test("REGRESSION: a live turn_start SSE flips a session from waiting to running", async () => {
    const s = makeSession({
      session_id: "s1", cwd: WS_A, first_msg: "resumed after a long wait",
      last_ts: new Date(Date.now() - 3_600_000).toISOString(),
      last_turn_event: "turn_end",
    });
    await boot({ sessions: [s], seed: { "scope-chat-ws-expanded": JSON.stringify([WS_A]) } });
    await page.waitForSelector('.ws-sess[data-sid="s1"]');
    assert.equal(await page.getAttribute('.ws-sess[data-sid="s1"] .status-dot', "class"), "status-dot orange");

    mock.broadcastSSE({ event_id: "e-start", session_id: "s1", seq: 999, ts: new Date().toISOString(), type: "turn_start" });
    await page.waitForFunction(() => {
      const sess = window.__SCOPE_STATE.sessions.find((x) => x.session_id === "s1");
      return sess?.last_turn_event === "turn_start" && window.SCOPE.subagentStatus(sess) === "green";
    });
  });

  test("a subagent neither vanishes nor duplicates when it shares an agent name with a sibling", async () => {
    // Reproduces a real workspace: two `searcher` and two `file_reader` sessions
    // dispatched by one orchestrator.
    const orch = makeSession({ session_id: "orch", cwd: WS_A, first_msg: "dispatch" });
    const pairs = [
      makeSession({ session_id: "s1", cwd: WS_A, agent_name: "searcher", first_msg: "a", parent_session_id: "orch" }),
      makeSession({ session_id: "s2", cwd: WS_A, agent_name: "searcher", first_msg: "b", parent_session_id: "orch" }),
      makeSession({ session_id: "f1", cwd: WS_A, agent_name: "file_reader", first_msg: "c", parent_session_id: "orch" }),
      makeSession({ session_id: "f2", cwd: WS_A, agent_name: "file_reader", first_msg: "d", parent_session_id: "orch" }),
    ];
    await boot({
      sessions: [orch, ...pairs],
      seed: { "scope-chat-ws-expanded": JSON.stringify([WS_A]) },
    });
    await page.waitForSelector(`.ws-sess[data-sid="orch"]`);
    await foldRow(page, "orch").click();
    for (const id of ["s1", "s2", "f1", "f2"]) {
      await page.waitForSelector(`.ws-sess[data-sid="${id}"]`, { state: "visible", timeout: 4000 });
    }
  });

  test("REGRESSION: a nested subagent chain renders every level", async () => {
    const p1 = makeSession({ session_id: "p1", cwd: WS_A, first_msg: "root" });
    const c1 = makeSession({ session_id: "c1", cwd: WS_A, first_msg: "child", parent_session_id: "p1", agent_name: "searcher" });
    const g1 = makeSession({ session_id: "g1", cwd: WS_A, first_msg: "grandchild", parent_session_id: "c1", agent_name: "file_reader" });
    await boot({ sessions: [p1, c1, g1], seed: { "scope-chat-ws-expanded": JSON.stringify([WS_A]) } });
    await foldRow(page, "p1").click();
    await foldRow(page, "c1").click();
    await page.waitForSelector(`.ws-sess[data-sid="g1"]`, { state: "visible", timeout: 4000 });
    assert.equal(await page.evaluate(() => {
      const g = document.querySelector('.ws-sess[data-sid="g1"]');
      return !!(g && g.closest(".ws-sess-subs"));
    }), true, "grandchild is nested, not a root");
  });

  test("REGRESSION: self-parented and cyclic links still render every session", async () => {
    const self = makeSession({ session_id: "w1", cwd: WS_A, first_msg: "self", parent_session_id: "w1" });
    const a = makeSession({ session_id: "a1", cwd: WS_A, first_msg: "a", parent_session_id: "b1" });
    const b = makeSession({ session_id: "b1", cwd: WS_A, first_msg: "b", parent_session_id: "a1" });
    await boot({ sessions: [self, a, b], seed: { "scope-chat-ws-expanded": JSON.stringify([WS_A]) } });
    await page.waitForSelector(`.ws-sess[data-sid="w1"]`, { timeout: 4000 });
    assert.equal(await page.locator(".ws-sess[data-sid]").count(), 3, "every session is rendered");
  });

  test("REGRESSION: a subagent with repeated live sessions highlights the one that is open", async () => {
    const team = defaultTeam({
      teamsOrder: ["dev"],
      teams: { dev: [{ name: "orchestrator" }, { name: "searcher" }] },
    });
    const s1 = makeSession({ session_id: "s-old", cwd: WS_A, agent_name: "searcher", first_msg: "old", last_ts: new Date(Date.now() - 60000).toISOString() });
    const s2 = makeSession({ session_id: "s-new", cwd: WS_A, agent_name: "searcher", first_msg: "new" });
    await boot({
      sessions: [makeSession({ session_id: "orch", cwd: WS_A, first_msg: "dispatch" }), s1, s2],
      team,
      events: { "s-new": [{ type: "assistant_message", ts: 2, payload: { text: "new" } }] },
      seed: { "scope-chat-ws-expanded": JSON.stringify([WS_A]) },
    });
    await wsRow(page, WS_A).click();
    await page.waitForSelector('.at-chip.sub[data-agent="searcher"]');
    await sessRow(page, "s-new").click();
    await page.waitForFunction(
      () => document.querySelector('.at-chip.sub[data-agent="searcher"]')?.classList.contains("active"),
      undefined, { timeout: 4000 }
    );
  });

  test("adding a workspace via the inline input selects it and survives a rail re-render", async () => {
    const NEW = "/tmp/pi-scope-e2e/gamma";
    await boot({ sessions: [makeSession(SESS_A)] });

    await page.click("#chat-ws-add");
    await page.fill("#chat-ws-add-input", NEW);
    // A background session update re-renders the rail — the typed path must survive.
    await applySessions(page, mock, [makeSession(SESS_A), makeSession({ session_id: "sess-a2", cwd: WS_A, first_msg: "more" })]);
    assert.equal(await page.inputValue("#chat-ws-add-input"), NEW);

    await page.press("#chat-ws-add-input", "Enter");
    await page.waitForSelector(`.chat-ws[data-cwd="${NEW}"]`);
    await page.waitForSelector(`.chat-ws.active[data-cwd="${NEW}"]`);
    const posted = mock.requestsFor("/agent-team", "POST");
    assert.ok(posted.some((r) => r.body.action === "addWorkspace" && r.body.path === NEW), "addWorkspace posted");
  });

  test("removing the active workspace force-reloads the app and clears the canvas", async () => {
    await boot({ sessions: [makeSession(SESS_A)] });
    page.on("dialog", (d) => d.accept());
    await wsRow(page, WS_A).click();
    await page.waitForSelector(".chat-ws.active");

    // Removing a workspace rewrites per-project config read at boot, so the app
    // reloads itself. Wait for that navigation, then assert the reloaded app.
    const reloaded = page.waitForEvent("load", { timeout: 5000 });
    await wsRow(page, WS_A).locator(".chat-ws-remove").click();
    await reloaded;
    await page.waitForFunction(() => window.__SCOPE_STATE?.sessionsLoaded === true);
    await page.waitForFunction((cwd) => !document.querySelector(`.chat-ws[data-cwd="${cwd}"]`), WS_A);
    assert.match(await canvas(), /Chat with your coding agent/);
    assert.equal(await page.locator("#chat-composer").isVisible(), false);
  });

  test("REGRESSION: removing a workspace from Settings force-reloads the app", async () => {
    await boot({ sessions: [], team: defaultTeam({ chatWorkspaces: [WS_A, WS_B] }) });
    page.on("dialog", (d) => d.accept());
    await page.evaluate(() => window.setView("settings"));
    await page.waitForSelector('.settings-nav-item[data-sec="workspaces"]');
    await page.click('.settings-nav-item[data-sec="workspaces"]');
    await page.waitForSelector(`[data-remove-ws="${WS_A}"]`);

    const reloaded = page.waitForEvent("load", { timeout: 5000 });
    await page.click(`[data-remove-ws="${WS_A}"]`);
    await reloaded;
    await page.waitForFunction(() => window.__SCOPE_STATE?.sessionsLoaded === true);
    // After the reload the removed workspace is gone from the config.
    await page.waitForSelector('.settings-nav-item[data-sec="workspaces"]');
    await page.click('.settings-nav-item[data-sec="workspaces"]');
    await page.waitForSelector(`[data-remove-ws="${WS_B}"]`);
    assert.equal(await page.locator(`[data-remove-ws="${WS_A}"]`).count(), 0, "removed workspace stays gone");
  });

  test("REGRESSION: a removed workspace stays removed after a reload even if another project lists it", async () => {
    // The rail is a union of every project's chatWorkspaces, but a removal is
    // written only to the ACTIVE project's config — so another project may still
    // list the workspace. The union merge must not resurrect it (reported: the
    // removed workspace shows again after the automatic reload).
    await boot({
      sessions: [],
      team: defaultTeam({ chatWorkspaces: [WS_A] }),
      seed: { "scope-chat-custom-ws": JSON.stringify({ list: [], removed: [WS_A] }) },
    });
    await page.waitForSelector("#chat-workspaces");
    assert.equal(await wsRow(page, WS_A).count(), 0, "another project's listing does not resurrect a removed workspace");
  });

  test("deleting a session row removes it from the rail", async () => {
    await boot({ sessions: [makeSession(SESS_A)], seed: { "scope-chat-ws-expanded": JSON.stringify([WS_A]) } });
    page.on("dialog", (d) => d.accept());
    await page.waitForSelector(`.ws-sess[data-sid="sess-a"]`);
    // The delete affordance only appears on row hover (CSS :hover → display).
    await sessRow(page, "sess-a").hover();
    await sessDel(page, "sess-a").click();
    await page.waitForFunction(() => !document.querySelector('.ws-sess[data-sid="sess-a"]'));
    assert.ok(mock.requests.some((r) => r.method === "DELETE" && r.path === "/sessions/sess-a"), "DELETE issued");
  });

  test("opening a session from another workspace follows that project", async () => {
    await boot({ sessions: [makeSession(SESS_A), makeSession(SESS_B)], seed: { "scope-chat-ws-expanded": JSON.stringify([WS_A]) } });
    await wsRow(page, WS_A).click();
    // Expand B without selecting it, then open its session.
    await wsRow(page, WS_B).locator(".chat-ws-caret").click();
    await sessRow(page, "sess-b").click();
    await page.waitForSelector(`.chat-ws.active[data-cwd="${WS_B}"]`);
    const cwd = await page.evaluate(() => window.__SCOPE_STATE.cwd);
    assert.equal(cwd, WS_B, "shared cwd follows the session's project");
  });

  test("a workspace's own conversation is restored after a reload", async () => {
    await boot({ sessions: [makeSession(SESS_A)] });
    await wsRow(page, WS_A).click();
    const turn = await send(page, mock, "remember me");
    await reply(turn, "stored reply");
    await page.waitForSelector(".chat-msg.chat-ai:not(.chat-ai-live)");
    await sleep(1100); // persist debounce is 800ms

    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("scope-chat-snapshot") || "null"));
    assert.ok(stored, "snapshot written");
    assert.equal(stored.v, 2);
    assert.equal(stored.openSid, "", "own-conversation snapshot has no session view");
    assert.equal(stored.cwd, WS_A);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof window.__chatOnView === "function" && window.__SCOPE_STATE?.sessionsLoaded === true);
    await wsRow(page, WS_A).click();
    await page.waitForFunction(() => document.getElementById("chat-messages").textContent.includes("stored reply"));
  });

  test("REGRESSION: a snapshot taken while a session was shown is not restored as the chat", async () => {
    const snap = {
      v: 2, cwd: WS_A, resumeFile: "", threadId: `free:${WS_A}`, openSid: "sess-a",
      msgs: [{ role: "assistant", text: "SHOULD-NOT-RESTORE", ts: 1 }],
    };
    await boot({ sessions: [makeSession(SESS_A)], seed: { "scope-chat-snapshot": JSON.stringify(snap) } });
    await wsRow(page, WS_A).click();
    await sleep(80);
    assert.ok(!(await canvas()).includes("SHOULD-NOT-RESTORE"), "session-view snapshot ignored");
  });

  test("a legacy (unversioned) snapshot is ignored", async () => {
    const snap = {
      cwd: WS_A, resumeFile: "", threadId: `free:${WS_A}`,
      msgs: [{ role: "assistant", text: "LEGACY-SHOULD-NOT-RESTORE", ts: 1 }],
    };
    await boot({ sessions: [makeSession(SESS_A)], seed: { "scope-chat-snapshot": JSON.stringify(snap) } });
    await wsRow(page, WS_A).click();
    await sleep(80);
    assert.ok(!(await canvas()).includes("LEGACY-SHOULD-NOT-RESTORE"), "legacy snapshot ignored");
  });

  test("empty rail state is explained when there is nothing to show", async () => {
    await boot({});
    await page.waitForSelector(".chat-rail-empty");
    assert.match(await page.textContent(".chat-rail-empty"), /No workspaces yet/);
  });
});

// ─── Streaming + click flows ───────────────────────────────────────────────

describe("chat streaming", () => {
  /** Select a workspace and open its composer. */
  async function selectA(sessions = [makeSession(SESS_A)]) {
    await boot({ sessions });
    await wsRow(page, WS_A).click();
    await page.waitForSelector(".chat-ws.active");
  }

  test("a prompt streams deltas, then finalizes with rendered markdown", async () => {
    await selectA();
    const turn = await send(page, mock, "hello");
    turn.send({ type: "session", sessionId: "live-1" });
    turn.send({ type: "msg_start" });
    turn.send({ type: "text", delta: "**bold** answer" });
    await page.waitForFunction(() => {
      const t = document.querySelector(".chat-text.chat-stream-text");
      return t && t.textContent.includes("bold");
    });
    turn.send({ type: "final", text: "**bold** answer" });
    turn.send({ type: "done", sessionId: "live-1" });
    turn.end();
    await page.waitForSelector(".chat-ai:not(.chat-ai-live) .chat-text strong");
    assert.match(await page.textContent(".chat-ai:not(.chat-ai-live) .chat-text"), /bold answer/);
    assert.equal(await page.locator(".chat-msg.chat-user").count(), 1);
  });

  test("REGRESSION: stop button shows while busy and hides when the turn ends", async () => {
    await selectA();
    assert.equal(await page.locator("#chat-stop").isVisible(), false);
    const turn = await send(page, mock, "long task");
    await page.waitForSelector("#chat-stop.show", { state: "visible" });
    turn.send({ type: "session", sessionId: "live-2" });
    turn.send({ type: "msg_start" });
    turn.send({ type: "text", delta: "working" });
    await page.waitForFunction(() => !!document.querySelector(".chat-text.chat-stream-text"));
    turn.send({ type: "done", sessionId: "live-2" });
    turn.end();
    await page.waitForFunction(() => !document.getElementById("chat-stop").classList.contains("show"));
  });

  test("REGRESSION: opening a streaming conversation's own session row keeps the live turn and Stop", async () => {
    // Reported flow: a chat turn is streaming; switching to the session row pi
    // recorded for that same conversation showed a fresh, idle transcript with
    // no Stop button, so the run could not be aborted. The busy free thread must
    // be aliased to its OWN row (never an older same-prompt one).
    await boot({ sessions: [], team: defaultTeam({ chatWorkspaces: [WS_A] }) });
    await wsRow(page, WS_A).click();
    const turn = await send(page, mock, "hello");
    turn.send({ type: "msg_start" });
    turn.send({ type: "text", delta: "LIVE-STREAM-TEXT" });
    await page.waitForFunction(() => document.getElementById("chat-messages").textContent.includes("LIVE-STREAM-TEXT"));

    // pi records this conversation's own row while the turn is still running.
    const now = new Date().toISOString();
    await applySessions(page, mock, [
      makeSession({ session_id: "s-own", cwd: WS_A, first_msg: "hello", first_ts: now, last_ts: now }),
    ]);
    await page.waitForSelector('.ws-sess[data-sid="s-own"]', { state: "visible", timeout: 4000 });
    await sessRow(page, "s-own").click();
    await sleep(150);

    assert.ok((await canvas()).includes("LIVE-STREAM-TEXT"), "the live turn stays on screen");
    assert.equal(await page.locator("#chat-stop").isVisible(), true, "Stop is available for the streaming session");
    await page.click("#chat-stop");
    const stop = mock.requestsFor("/chat/stop", "POST").at(-1);
    assert.ok(stop && stop.body.sessionId, "Stop targets the live session's subprocess");

    turn.send({ type: "done", sessionId: "pre-1" });
    turn.end();
  });

  test("REGRESSION: clearing sessions from the Single page resets a stuck chat and re-arms a session", async () => {
    // Reported flow: a chat turn was streaming, then the user cleared all
    // sessions from the Single page. Chat kept the thread's stuck "busy" flag
    // and its orphaned subprocess key, so Stop stayed on, New stayed disabled
    // and every message queued to a conversation that no longer existed — only
    // removing and re-adding the workspace recovered.
    await boot({ sessions: [makeSession(SESS_A)], team: defaultTeam({ chatWorkspaces: [WS_A] }) });
    await wsRow(page, WS_A).click();
    const turn = await send(page, mock, "long task");
    turn.send({ type: "msg_start" });
    turn.send({ type: "text", delta: "working" });
    await page.waitForFunction(() => !!document.querySelector(".chat-text.chat-stream-text"));
    assert.equal(await page.locator("#chat-stop").isVisible(), true);

    page.on("dialog", (d) => d.accept());
    await page.evaluate(() => window.setView("single"));
    await page.evaluate(() => document.getElementById("btn-clear-all").click());
    await page.waitForFunction(() => window.__SCOPE_STATE.sessions.length === 0);
    await page.evaluate(() => window.setView("chat"));
    // Landing on Chat after the clear must place the caret in the composer.
    await page.waitForFunction(() => document.activeElement?.id === "chat-input", undefined, { timeout: 4000 });
    await wsRow(page, WS_A).click();
    await page.waitForFunction(() => document.activeElement?.id === "chat-input", undefined, { timeout: 4000 });

    await page.waitForFunction(() => !document.getElementById("chat-stop").classList.contains("show"));
    assert.equal(await page.locator("#chat-new").isDisabled(), false, "New session button is enabled");
    assert.equal(await page.locator("#chat-composer").isVisible(), true, "composer is usable");
    assert.equal(await page.locator(".chat-msg").count(), 0, "the dead stream was dropped");
    assert.ok(mock.requestsFor("/chat/start", "POST").length >= 2, "a fresh pi session was auto-created");

    // A new prompt opens a real turn again.
    const turn2 = await send(page, mock, "fresh start");
    await reply(turn2, "ok");
    await page.waitForSelector(".chat-ai:not(.chat-ai-live)");
    turn.end();
  });

  test("REGRESSION: a mid-stream view switch preserves text and keeps streaming", async () => {
    await selectA();
    const turn = await send(page, mock, "stream test");
    turn.send({ type: "session", sessionId: "live-3" });
    turn.send({ type: "msg_start" });
    turn.send({ type: "text", delta: "part-one " });
    await page.waitForFunction(() => document.querySelector(".chat-text.chat-stream-text")?.textContent.includes("part-one"));

    await page.evaluate(() => window.setView("files"));
    await page.evaluate(() => window.setView("chat"));
    await page.waitForFunction(() => document.querySelector(".chat-text.chat-stream-text")?.textContent.includes("part-one"));

    turn.send({ type: "text", delta: "part-two" });
    await page.waitForFunction(() => document.querySelector(".chat-text.chat-stream-text")?.textContent.includes("part-two"));
    turn.send({ type: "done", sessionId: "live-3" });
    turn.end();
  });

  test("REGRESSION: an empty final snapshot does not wipe streamed text", async () => {
    await selectA();
    const turn = await send(page, mock, "keep it");
    turn.send({ type: "session", sessionId: "live-4" });
    turn.send({ type: "msg_start" });
    turn.send({ type: "text", delta: "kept text" });
    await page.waitForFunction(() => document.querySelector(".chat-text.chat-stream-text")?.textContent.includes("kept text"));
    turn.send({ type: "final", text: "", thinking: "" });
    await sleep(60);
    assert.match(await page.textContent(".chat-text.chat-stream-text"), /kept text/);
    turn.send({ type: "done", sessionId: "live-4" });
    turn.end();
  });

  test("thinking, tool calls and usage render in the live turn", async () => {
    await selectA();
    const turn = await send(page, mock, "do work");
    turn.send({ type: "session", sessionId: "live-5" });
    turn.send({ type: "msg_start" });
    turn.send({ type: "thinking", delta: "pondering" });
    await page.waitForFunction(() => document.querySelector(".chat-thinking pre")?.textContent.includes("pondering"));
    turn.send({ type: "tool_start", name: "read_file", args: { path: "a.txt" } });
    await page.waitForSelector('.chat-tool[data-name="read_file"]');
    turn.send({ type: "tool_end", name: "read_file" });
    await page.waitForFunction(() => {
      const c = document.querySelector('.chat-tool[data-name="read_file"]');
      return c && !c.classList.contains("live");
    });
    turn.send({ type: "usage", usage: { input: 1000, output: 200, cost_total: 0.001 } });
    await page.waitForFunction(() => document.getElementById("chat-composer-footer").textContent.includes("1.0k"));
    turn.send({ type: "done", sessionId: "live-5" });
    turn.end();
  });

  test("a message sent mid-run is queued after the live reply and then answered", async () => {
    await selectA();
    const turn = await send(page, mock, "first");
    turn.send({ type: "session", sessionId: "live-6" });
    turn.send({ type: "msg_start" });
    turn.send({ type: "text", delta: "answer-one" });
    await page.waitForFunction(() => document.querySelector(".chat-text.chat-stream-text")?.textContent.includes("answer-one"));

    await page.fill("#chat-input", "second");
    await page.click("#chat-send");
    await page.waitForFunction(() => document.querySelectorAll(".chat-msg.chat-user").length === 2);
    const posted = mock.requestsFor("/chat", "POST");
    assert.ok(posted.some((r) => r.body.streamingBehavior === "followUp"), "second prompt sent as a follow-up");
    assert.match(await hint(), /queued|steering/);

    // pi picks the queued message up in a new run.
    turn.send({ type: "run_start" });
    turn.send({ type: "msg_start" });
    turn.send({ type: "text", delta: "answer-two" });
    await page.waitForFunction(() => document.getElementById("chat-messages").textContent.includes("answer-two"));
    turn.send({ type: "done", sessionId: "live-6" });
    turn.end();
  });

  test("an extension dialog renders an answerable card and posts the raw option", async () => {
    await selectA();
    const turn = await send(page, mock, "ask me");
    turn.send({ type: "session", sessionId: "live-7" });
    turn.send({ type: "msg_start" });
    turn.send({
      type: "ui_select", id: "d1", title: "Pick one",
      options: ["1. First — alpha", "2. Second — beta", "3. Type something."],
    });
    await page.waitForSelector(".chat-ask");
    assert.match(await page.textContent(".chat-ask"), /Pick one/);
    await page.click('.chat-ask-opt[data-i="0"]');
    await page.waitForFunction(() => !!document.querySelector(".chat-ask.answered"));
    const ui = mock.requestsFor("/chat/ui", "POST");
    assert.equal(ui.length, 1);
    assert.equal(ui[0].body.value, "1. First — alpha");
    assert.notEqual(ui[0].body.cancelled, true, "an answered dialog is not a cancellation");
    turn.send({ type: "done", sessionId: "live-7" });
    turn.end();
  });

  test("an error event surfaces a note", async () => {
    await selectA();
    const turn = await send(page, mock, "boom please");
    turn.send({ type: "session", sessionId: "live-8" });
    turn.send({ type: "msg_start" });
    turn.send({ type: "error", message: "boom" });
    await page.waitForSelector(".chat-error-note");
    assert.match(await page.textContent(".chat-error-note"), /boom/);
    turn.send({ type: "done", sessionId: "live-8" });
    turn.end();
  });

  test("a turn keeps running across a workspace switch and resumes on return", async () => {
    await boot({ sessions: [makeSession(SESS_A), makeSession(SESS_B)] });
    await wsRow(page, WS_A).click();
    const turn = await send(page, mock, "bg work");
    turn.send({ type: "session", sessionId: "live-9" });
    turn.send({ type: "msg_start" });
    turn.send({ type: "text", delta: "background-part" });
    await page.waitForFunction(() => document.querySelector(".chat-text.chat-stream-text")?.textContent.includes("background-part"));

    await wsRow(page, WS_B).click();
    await page.waitForFunction((cwd) => document.querySelector(".chat-ws.active")?.dataset.cwd === cwd, WS_B);
    assert.ok(!(await canvas()).includes("background-part"), "other workspace does not show the stream");

    turn.send({ type: "text", delta: "-more" });
    await wsRow(page, WS_A).click();
    await page.waitForFunction(() => document.getElementById("chat-messages").textContent.includes("background-part-more"));
    turn.send({ type: "done", sessionId: "live-9" });
    turn.end();
  });

  test("page stays free of uncaught errors through a full workspace + streaming flow", async () => {
    await boot({ sessions: [makeSession(SESS_A), makeSession(SESS_B)] });
    await wsRow(page, WS_A).click();
    const turn = await send(page, mock, "smoke");
    await reply(turn, "all good");
    await page.waitForSelector(".chat-ai:not(.chat-ai-live)");
    await wsRow(page, WS_B).click();
    await wsRow(page, WS_A).click();
    await page.waitForSelector(".chat-ai:not(.chat-ai-live)");
    assert.deepEqual(env.pageErrors, [], "no uncaught page errors");
  });
});

// ─── Resuming recorded sessions ────────────────────────────────────────────

describe("session resume", () => {
  const S1 = { session_id: "s1", cwd: WS_A, agent_name: "orchestrator", first_msg: "hello" };
  const S1_EVENTS = [
    { type: "user_message", ts: 1, payload: { text: "hello" } },
    { type: "assistant_message", ts: 2, payload: { text: "RECORDED-FROM-S1" } },
  ];

  /** Start a conversation, let pi record it as s1, then start a NEW one — the
   *  state in which a stale free-thread alias used to survive. */
  async function startNewAfterRecorded() {
    await boot({ sessions: [makeSession(S1)], events: { s1: S1_EVENTS } });
    await wsRow(page, WS_A).click();
    const t1 = await send(page, mock, "hello");
    await reply(t1, "first reply");
    await sleep(30);
    // pi records this conversation under s1; the poll adopts the free thread.
    await applySessions(page, mock, [makeSession(S1)]);
    await page.click("#chat-new");
    const t2 = await send(page, mock, "different topic");
    await reply(t2, "second reply");
    await page.waitForFunction(() => document.getElementById("chat-messages").textContent.includes("second reply"));
  }

  test("REGRESSION: a new conversation detaches from the session it was adopted into", async () => {
    await startNewAfterRecorded();
    await sessRow(page, "s1").click();
    await page.waitForFunction(
      () => document.getElementById("chat-messages").textContent.includes("RECORDED-FROM-S1"),
      undefined, { timeout: 4000 }
    );
    assert.ok(!(await canvas()).includes("second reply"), "resuming s1 must not show the new conversation");
  });

  test("REGRESSION: a resumed session sends to its own session, not the workspace conversation", async () => {
    await startNewAfterRecorded();
    await sessRow(page, "s1").click();
    await page.waitForFunction(
      () => document.getElementById("chat-messages").textContent.includes("RECORDED-FROM-S1"),
      undefined, { timeout: 4000 }
    );

    const turnP = mock.nextTurn();
    await page.fill("#chat-input", "continue here");
    await page.click("#chat-send");
    const turn = await turnP;
    const post = mock.requestsFor("/chat", "POST").at(-1);
    assert.equal(post.body.sessionId, "s1", "prompt targets the resumed session");
    assert.equal(post.body.sessionFile, "/tmp/s1.jsonl", "and resumes its pi session file");
    turn.send({ type: "session", sessionId: "s1" });
    turn.send({ type: "msg_start" });
    turn.send({ type: "text", delta: "ok" });
    turn.send({ type: "done", sessionId: "s1" });
    turn.end();
  });

  test("adoption binds the session that started right after the live conversation, not another same-prompt one", async () => {
    await boot({ sessions: [], events: {}, team: defaultTeam({ chatWorkspaces: [WS_A] }) });
    await wsRow(page, WS_A).click();
    const t = await send(page, mock, "hello");
    await reply(t, "live reply");
    // Two recorded sessions open with the SAME prompt; only the one that began
    // moments after the live conversation is its recording. The ancient one
    // merely shares the opening line.
    const now = new Date(Date.now() + 500).toISOString();
    const ancient = makeSession({ session_id: "same-ancient", cwd: WS_A, first_msg: "hello", first_ts: "2026-01-01T00:00:00.000Z", last_ts: "2026-01-01T00:01:00.000Z" });
    const recent = makeSession({ session_id: "same-recent", cwd: WS_A, first_msg: "hello", first_ts: now, last_ts: now });
    mock.setEvents("same-ancient", [
      { type: "user_message", ts: 1, payload: { text: "hello" } },
      { type: "assistant_message", ts: 2, payload: { text: "ANCIENT-TRANSCRIPT" } },
    ]);
    mock.setEvents("same-recent", [
      { type: "user_message", ts: 1, payload: { text: "hello" } },
      { type: "assistant_message", ts: 2, payload: { text: "RECENT-TRANSCRIPT" } },
    ]);
    await applySessions(page, mock, [ancient, recent]);

    // Opening the ancient row must fetch ITS transcript, not rebind the live
    // conversation that was mistakenly adopted to it. The workspace is already
    // expanded by its selection, so the row is directly clickable.
    await page.waitForSelector('.ws-sess[data-sid="same-ancient"]', { state: "visible", timeout: 4000 });
    await sessRow(page, "same-ancient").click();
    await page.waitForFunction(
      () => document.getElementById("chat-messages").textContent.includes("ANCIENT-TRANSCRIPT"),
      undefined, { timeout: 4000 }
    );
    assert.ok(!(await canvas()).includes("live reply"), "the live conversation is not shown as same-ancient");
  });

  test("REGRESSION: a transcript never renders events belonging to another session", async () => {
    await boot({
      sessions: [makeSession(S1)],
      events: {
        s1: [
          { session_id: "s1", type: "user_message", payload: { text: "hello" } },
          // A mis-keyed / merged event: the server says s1, the event says s2.
          { session_id: "s2", type: "assistant_message", payload: { text: "LEAKED-FROM-S2" } },
          { session_id: "s1", type: "assistant_message", payload: { text: "RECORDED-FROM-S1" } },
        ],
      },
    });
    await wsRow(page, WS_A).click();
    await sessRow(page, "s1").click();
    await page.waitForFunction(
      () => document.getElementById("chat-messages").textContent.includes("RECORDED-FROM-S1"),
      undefined, { timeout: 4000 }
    );
    assert.ok(!(await canvas()).includes("LEAKED-FROM-S2"), "another session's event is filtered out");
    assert.ok((await canvas()).includes("RECORDED-FROM-S1"), "the session's own events render");
  });

  test("REGRESSION: switching to a same-prompt session while a turn streams never shows the live turn", async () => {
    // An unrelated, older session that merely shares the opening line.
    const other = makeSession({
      session_id: "s-other", cwd: WS_A, first_msg: "hello",
      first_ts: new Date(Date.now() - 60_000).toISOString(),
      last_ts: new Date(Date.now() - 59_000).toISOString(),
    });
    await boot({
      sessions: [other],
      events: {
        "s-other": [
          { type: "user_message", payload: { text: "hello" } },
          { type: "assistant_message", payload: { text: "OTHER-TRANSCRIPT" } },
        ],
      },
      team: defaultTeam({ chatWorkspaces: [WS_A] }),
    });
    await wsRow(page, WS_A).click();
    const turn = await send(page, mock, "hello");
    turn.send({ type: "session", sessionId: "live-x" });
    turn.send({ type: "msg_start" });
    turn.send({ type: "text", delta: "LIVE-STREAM-TEXT" });
    await page.waitForFunction(() => document.getElementById("chat-messages").textContent.includes("LIVE-STREAM-TEXT"));

    // The streaming conversation's own row has not been polled in yet; the poll
    // only carries the older same-prompt session.
    await applySessions(page, mock, [other]);
    await sessRow(page, "s-other").click();
    await page.waitForFunction(
      () => document.getElementById("chat-messages").textContent.includes("OTHER-TRANSCRIPT"),
      undefined, { timeout: 4000 }
    );
    assert.ok(!(await canvas()).includes("LIVE-STREAM-TEXT"), "the live turn does not leak into another session");

    // The stream still belongs to its own thread and completes there.
    turn.send({ type: "text", delta: "-more" });
    await wsRow(page, WS_A).click();
    await page.waitForFunction(() => document.getElementById("chat-messages").textContent.includes("LIVE-STREAM-TEXT-more"));
    turn.send({ type: "done", sessionId: "live-x" });
    turn.end();
  });

  test("REGRESSION: an ancient same-prompt session is never adopted by a fresh conversation", async () => {
    const ancient = makeSession({
      session_id: "ancient-same", cwd: WS_A, first_msg: "hello",
      first_ts: "2026-01-01T00:00:00.000Z", last_ts: "2026-01-01T00:01:00.000Z",
    });
    await boot({
      sessions: [],
      events: {
        "ancient-same": [
          { type: "user_message", payload: { text: "hello" } },
          { type: "assistant_message", payload: { text: "ANCIENT-ONLY" } },
        ],
      },
      team: defaultTeam({ chatWorkspaces: [WS_A] }),
    });
    await wsRow(page, WS_A).click();
    const t = await send(page, mock, "hello");
    await reply(t, "fresh live reply");
    await applySessions(page, mock, [ancient]);
    await sessRow(page, "ancient-same").click();
    await page.waitForFunction(
      () => document.getElementById("chat-messages").textContent.includes("ANCIENT-ONLY"),
      undefined, { timeout: 4000 }
    );
    assert.ok(!(await canvas()).includes("fresh live reply"), "the ancient transcript is shown, not the live conversation");
  });
});

// ─── Thread aliasing (free conversation ↔ recorded session row) ─────────────

describe("thread aliasing", () => {
  const S1 = { session_id: "s1", cwd: WS_A, agent_name: "orchestrator", first_msg: "hello" };
  const S1_EVENTS = [
    { type: "user_message", ts: 1, payload: { text: "hello" } },
    { type: "assistant_message", ts: 2, payload: { text: "RECORDED-HELLO" } },
  ];

  test("REGRESSION: a restored workspace conversation re-adopts its recorded session", async () => {
    await boot({ sessions: [], events: { s1: S1_EVENTS }, team: defaultTeam({ chatWorkspaces: [WS_A] }) });
    await wsRow(page, WS_A).click();
    const t = await send(page, mock, "hello");
    await reply(t, "stored reply");
    await page.waitForFunction(() => document.getElementById("chat-messages").textContent.includes("stored reply"));
    await sleep(1100); // snapshot debounce is 800ms
    await applySessions(page, mock, [makeSession(S1)]);

    // Reload: the workspace conversation comes back from the snapshot only (the
    // thread itself is gone), then the poll runs again with the row present.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof window.__chatOnView === "function" && window.__SCOPE_STATE?.sessionsLoaded === true);
    await wsRow(page, WS_A).click();
    await page.waitForFunction(() => document.getElementById("chat-messages").textContent.includes("stored reply"));
    await applySessions(page, mock, [makeSession(S1)]);

    // Opening s1 must continue the SAME restored conversation. Creating a fresh
    // session thread here would spawn a second pi on the same session file.
    await page.waitForSelector('.ws-sess[data-sid="s1"]', { state: "visible" });
    await sessRow(page, "s1").click();
    await sleep(150);
    assert.ok((await canvas()).includes("stored reply"), "restored conversation kept");
    assert.match(await hint(), /in this conversation/, "still the workspace's own thread");
  });

  test("REGRESSION: deleting an adopted session unbinds the workspace conversation", async () => {
    const s2Events = [
      { type: "user_message", ts: 1, payload: { text: "hello" } },
      { type: "assistant_message", ts: 2, payload: { text: "RECORDED-TWO" } },
    ];
    await boot({ sessions: [], events: { s1: S1_EVENTS, s2: s2Events }, team: defaultTeam({ chatWorkspaces: [WS_A] }) });
    await wsRow(page, WS_A).click();
    const t = await send(page, mock, "hello");
    await reply(t, "live reply");
    await applySessions(page, mock, [makeSession(S1)]);

    // Delete the row the live conversation was adopted into.
    page.on("dialog", (d) => d.accept());
    await page.waitForSelector('.ws-sess[data-sid="s1"]', { state: "visible" });
    await sessRow(page, "s1").hover();
    await sessDel(page, "s1").click();
    await page.waitForFunction(() => !document.querySelector('.ws-sess[data-sid="s1"]'));

    // pi records a new row for the same conversation (same opening prompt). It
    // must re-bind to the workspace thread, not spawn a second one that shows a
    // freshly fetched transcript.
    const now = new Date().toISOString();
    await applySessions(page, mock, [makeSession({ session_id: "s2", cwd: WS_A, first_msg: "hello", first_ts: now, last_ts: now })]);
    await page.waitForSelector('.ws-sess[data-sid="s2"]', { state: "visible" });
    await sessRow(page, "s2").click();
    await sleep(150);
    assert.ok((await canvas()).includes("live reply"), "workspace conversation re-bound");
    assert.ok(!(await canvas()).includes("RECORDED-TWO"), "s2's transcript is not fetched as a new thread");
  });

  test("prompts sent in two sessions never share a thread", async () => {
    await boot({
      sessions: [],
      events: {
        s1: S1_EVENTS,
        s2: [{ type: "user_message", ts: 1, payload: { text: "two" } },
             { type: "assistant_message", ts: 2, payload: { text: "TWO" } }],
      },
      team: defaultTeam({ chatWorkspaces: [WS_A] }),
    });
    await wsRow(page, WS_A).click();
    const rec = [makeSession(S1), makeSession({ session_id: "s2", cwd: WS_A, agent_name: "orchestrator", first_msg: "two" })];
    await applySessions(page, mock, rec);

    await sessRow(page, "s1").click();
    await page.waitForFunction(() => document.getElementById("chat-messages").textContent.includes("RECORDED-HELLO"));
    const turn1 = mock.nextTurn();
    await page.fill("#chat-input", "in one");
    await page.click("#chat-send");
    const t1 = await turn1;
    t1.send({ type: "msg_start" });
    t1.send({ type: "text", delta: "ONE-REPLY" });
    t1.send({ type: "done", sessionId: "s1" });
    t1.end();

    await sessRow(page, "s2").click();
    await page.waitForFunction(() => document.getElementById("chat-messages").textContent.includes("TWO"));
    assert.equal(mock.requestsFor("/chat", "POST").at(-1).body.sessionId, "s1", "the second session was never prompted yet");
    assert.ok(!(await canvas()).includes("ONE-REPLY"), "s1's live reply does not leak into s2");
  });

  test("REGRESSION: a prompt in one resumed session never leaks into another", async () => {
    const s2Events = [
      { type: "user_message", ts: 1, payload: { text: "two" } },
      { type: "assistant_message", ts: 2, payload: { text: "RECORDED-TWO" } },
    ];
    await boot({ sessions: [], events: { s1: S1_EVENTS, s2: s2Events }, team: defaultTeam({ chatWorkspaces: [WS_A] }) });
    await wsRow(page, WS_A).click();
    await applySessions(page, mock, [
      makeSession(S1),
      makeSession({ session_id: "s2", cwd: WS_A, agent_name: "orchestrator", first_msg: "two" }),
    ]);

    // Resume s1 and send a message.
    await sessRow(page, "s1").click();
    await page.waitForFunction(() => document.getElementById("chat-messages").textContent.includes("RECORDED-HELLO"));
    let turnP = mock.nextTurn();
    await page.fill("#chat-input", "ALPHA");
    await page.click("#chat-send");
    let turn = await turnP;
    turn.send({ type: "msg_start" });
    turn.send({ type: "text", delta: "ALPHA-REPLY" });
    turn.send({ type: "done", sessionId: "s1" });
    turn.end();
    await page.waitForFunction(() => document.getElementById("chat-messages").textContent.includes("ALPHA-REPLY"));

    // Resume s2 — nothing from s1 may appear here.
    await sessRow(page, "s2").click();
    await page.waitForFunction(() => document.getElementById("chat-messages").textContent.includes("RECORDED-TWO"));
    assert.ok(!(await canvas()).includes("ALPHA"), "s2 does not show s1's prompt or reply");

    turnP = mock.nextTurn();
    await page.fill("#chat-input", "BETA");
    await page.click("#chat-send");
    turn = await turnP;
    assert.equal(mock.requestsFor("/chat", "POST").at(-1).body.sessionId, "s2", "prompt targets s2");
    turn.send({ type: "msg_start" });
    turn.send({ type: "text", delta: "BETA-REPLY" });
    turn.send({ type: "done", sessionId: "s2" });
    turn.end();
    await page.waitForFunction(() => document.getElementById("chat-messages").textContent.includes("BETA-REPLY"));

    // Back to s1 — nothing from s2 may appear.
    await sessRow(page, "s1").click();
    await page.waitForFunction(() => document.getElementById("chat-messages").textContent.length > 0);
    await sleep(150);
    assert.ok(!(await canvas()).includes("BETA"), "s1 does not show s2's prompt or reply");
  });

  test("REGRESSION: a prompt in a normal session never leaks into the adopted workspace thread", async () => {
    const s2Events = [
      { type: "user_message", ts: 1, payload: { text: "two" } },
      { type: "assistant_message", ts: 2, payload: { text: "RECORDED-TWO" } },
    ];
    await boot({ sessions: [], events: { s1: S1_EVENTS, s2: s2Events }, team: defaultTeam({ chatWorkspaces: [WS_A] }) });
    await wsRow(page, WS_A).click();
    // A workspace conversation that pi records as s1 (the rail aliases them).
    const t = await send(page, mock, "hello");
    await reply(t, "free-reply");
    await page.waitForFunction(() => document.getElementById("chat-messages").textContent.includes("free-reply"));
    const now = new Date().toISOString();
    await applySessions(page, mock, [
      makeSession({ ...S1, first_ts: now, last_ts: now }),
      makeSession({ session_id: "s2", cwd: WS_A, agent_name: "orchestrator", first_msg: "two" }),
    ]);

    // Send in the unrelated session s2.
    await sessRow(page, "s2").click();
    await page.waitForFunction(() => document.getElementById("chat-messages").textContent.includes("RECORDED-TWO"));
    const turnP = mock.nextTurn();
    await page.fill("#chat-input", "BETA");
    await page.click("#chat-send");
    const turn = await turnP;
    assert.equal(mock.requestsFor("/chat", "POST").at(-1).body.sessionId, "s2", "prompt targets s2");
    turn.send({ type: "msg_start" });
    turn.send({ type: "text", delta: "BETA-REPLY" });
    turn.send({ type: "done", sessionId: "s2" });
    turn.end();
    await page.waitForFunction(() => document.getElementById("chat-messages").textContent.includes("BETA-REPLY"));

    // s1 (the adopted workspace conversation) and the workspace row must not
    // show s2's turn.
    await sessRow(page, "s1").click();
    await page.waitForFunction(() => document.getElementById("chat-messages").textContent.includes("free-reply"));
    await sleep(150);
    assert.ok(!(await canvas()).includes("BETA"), "adopted s1 thread is untouched by s2");
    await wsRow(page, WS_A).click();
    await sleep(150);
    assert.ok(!(await canvas()).includes("BETA"), "workspace conversation is untouched by s2");
    assert.ok((await canvas()).includes("free-reply"), "workspace conversation still intact");
  });

  test("REGRESSION: switching away while a session is loading does not strand it", async () => {
    const s2Events = [
      { type: "user_message", ts: 1, payload: { text: "two" } },
      { type: "assistant_message", ts: 2, payload: { text: "RECORDED-TWO" } },
    ];
    await boot({ sessions: [], events: { s1: S1_EVENTS, s2: s2Events }, team: defaultTeam({ chatWorkspaces: [WS_A] }) });
    await wsRow(page, WS_A).click();
    await applySessions(page, mock, [
      makeSession(S1),
      makeSession({ session_id: "s2", cwd: WS_A, agent_name: "orchestrator", first_msg: "two" }),
    ]);

    // Hold s1's transcript request open, switch to s2, then come back.
    let release;
    const gate = new Promise((r) => { release = r; });
    await page.route("**/sessions/s1/events*", async (route) => {
      await gate;
      await route.continue();
    });
    await sessRow(page, "s1").click();
    await sessRow(page, "s2").click();
    await page.waitForFunction(() => document.getElementById("chat-messages").textContent.includes("RECORDED-TWO"));
    release();
    await sleep(200); // let the abandoned s1 fetch settle
    await page.unroute("**/sessions/s1/events*");

    // Re-opening s1 must actually fetch its transcript, not think a request is
    // still in flight and show the loading hero forever.
    await sessRow(page, "s1").click();
    await page.waitForFunction(
      () => document.getElementById("chat-messages").textContent.includes("RECORDED-HELLO"),
      undefined, { timeout: 4000 }
    );
  });
});
