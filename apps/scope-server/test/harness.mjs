// Shared Playwright helpers for the Chat-view end-to-end tests.

import { chromium } from "playwright";

export async function launchBrowser() {
  return chromium.launch({ headless: true });
}

/** Both rails start folded unless localStorage says otherwise, so every test
 *  opens them (the workspace rail is what we mostly click). */
const RAILS_OPEN = { "scope-chat-rail-left": "open", "scope-chat-rail-right": "open" };

/**
 * Load the real Chat page against the mock backend. `seed` becomes the
 * localStorage contents for the page (plus both rails open), which is how
 * tests control the restored snapshot / expanded workspaces.
 */
export async function openChat(browser, mock, { seed = {}, query = "" } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const init = { ...RAILS_OPEN, ...seed };
  // NOTE: this runs on every navigation, so it must NOT clear storage — a test
  // that reloads the page (restore-after-reload) needs the snapshot written by
  // the previous load to survive. Each test gets a fresh context anyway, so
  // there is nothing stale to clear.
  await context.addInitScript((kv) => {
    try {
      for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v);
    } catch { /* private mode */ }
  }, init);

  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e && e.message ? e.message : e)));
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

  await page.goto(`${mock.base}/?token=test-token&view=chat${query}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chat-workspaces");
  // chat.js boots on DOMContentLoaded; state.sessionsLoaded flips after the
  // first /sessions fetch (which also triggers __chatOnSessions).
  await page.waitForFunction(() =>
    typeof window.__chatOnView === "function" && window.__SCOPE_STATE && window.__SCOPE_STATE.sessionsLoaded === true
  );
  await page.waitForFunction(() => {
    const m = document.getElementById("chat-messages");
    return !!m && m.innerHTML.length > 0;
  });
  return { context, page, pageErrors, consoleErrors };
}

/** Locator for one workspace row. */
export const wsRow = (page, cwd) => page.locator(`.chat-ws[data-cwd="${cwd}"]`);
/** Locator for one session row (works in both rails). */
export const sessRow = (page, sid) => page.locator(`.ws-sess[data-sid="${sid}"]`);
/** Locator for a session row's delete affordance. */
export const sessDel = (page, sid) => page.locator(`.ws-sess-del[data-del="${sid}"]`);
/** Locator for a session row's sub-session fold row. */
export const foldRow = (page, sid) => page.locator(`.ws-sess-fold[data-fold="${sid}"]`);

/** Push a new session list into the page's state + chat hook, without waiting
 *  for the 10s poll. */
export async function applySessions(page, mock, list) {
  mock.setSessions(list);
  await page.evaluate((sessions) => {
    window.__SCOPE_STATE.sessions = sessions;
    window.__chatOnSessions && window.__chatOnSessions();
  }, mock.state.sessions);
}

/** Send a composer message and return the scripted chat Turn the client opens. */
export async function send(page, mock, text) {
  const turnP = mock.nextTurn();
  await page.fill("#chat-input", text);
  await page.click("#chat-send");
  return turnP;
}

/** Drive a Turn to completion as a simple text reply. */
export async function reply(turn, text, { sessionId } = {}) {
  if (sessionId) turn.send({ type: "session", sessionId });
  turn.send({ type: "msg_start" });
  turn.send({ type: "text", delta: text });
  turn.send({ type: "final", text });
  turn.send({ type: "done", sessionId: sessionId || turn.sessionId });
  turn.end();
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
