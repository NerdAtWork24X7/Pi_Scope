// End-to-end test for the Chat view's harness picker: choosing Claude Code must
// repaint the model pill with that CLI's models, persist the choice, and send it
// with the next prompt (with pi-only fields left out).
//
//   node --test apps/scope-server/test/chat-harness.e2e.test.mjs

import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { startMockBackend, defaultTeam, makeSession } from "./mock-backend.mjs";
import { launchBrowser, openChat, send, reply, wsRow } from "./harness.mjs";

const WS = "/tmp/pi-scope-e2e/harness";
const SESS = { session_id: "sess-h", cwd: WS, agent_name: "orchestrator", first_msg: "harness work" };

let browser;
let mock;
let context = null;
let page = null;

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

async function boot(seed = {}) {
  mock.setSessions([makeSession(SESS)]);
  mock.setTeam(defaultTeam());
  const env = await openChat(browser, mock, { seed });
  context = env.context;
  page = env.page;
  await page.waitForSelector(`.chat-ws[data-cwd="${WS}"]`);
  await wsRow(page, WS).click();
  await page.waitForSelector(`.chat-ws.active[data-cwd="${WS}"]`);
  await page.waitForFunction(() => document.querySelectorAll("#chat-harness option").length >= 4);
  return env;
}

test("the harness picker lists installed and missing CLIs", async () => {
  await boot();
  const options = await page.$$eval("#chat-harness option", (els) =>
    els.map((el) => ({ value: el.value, text: el.textContent || "" })));
  assert.equal(options[0].value, "pi", "Pi is the default");
  assert.ok(options.some((o) => o.value === "claude" && o.text === "Claude Code"));
  const codex = options.find((o) => o.value === "codex");
  assert.ok(codex, "an uninstalled harness is still offered");
  assert.match(codex.text, /not installed/);
});

test("choosing a harness repaints the model pill and persists the choice", async () => {
  await boot();
  // Pi's model pill starts from the app catalogue.
  assert.ok((await page.inputValue("#chat-model")).length > 0);

  await page.selectOption("#chat-harness", "claude");
  await page.waitForFunction(() => document.getElementById("chat-header-model").textContent.includes("Claude Code"));
  assert.equal(await page.inputValue("#chat-model"), "", "default: let the CLI use its configured model");
  const models = await page.$$eval("#chat-model option", (els) => els.map((el) => el.value));
  assert.deepEqual(models, ["", "sonnet", "opus", "haiku"]);
  assert.equal(await page.evaluate(() => localStorage.getItem("scope-chat-harness")), "claude");
  // Thinking levels are a pi concept; the control is disabled for a CLI.
  assert.equal(await page.locator("#chat-thinking").isDisabled(), true);
});

test("the model pill shows the models the harness's own CLI reports", async () => {
  await boot();
  await page.selectOption("#chat-harness", "opencode");
  // The mock's `opencode models` answer, not the catalog's single curated id.
  await page.waitForFunction(() =>
    [...document.querySelectorAll("#chat-model option")].some((o) => o.value === "acme/discovered-coder"));
  const models = await page.$$eval("#chat-model option", (els) => els.map((el) => el.value));
  assert.deepEqual(models, ["", "acme/discovered-coder", "acme/discovered-fast", "openai/gpt-5"]);
  assert.equal(await page.inputValue("#chat-model"), "", "default stays selected");
  const asked = mock.requestsFor("/chat/harness-models", "GET").at(-1);
  assert.equal(asked.query.harness, "opencode", "the CLI was asked for its own list");
});

test("a prompt carries the selected harness and omits pi-only fields", async () => {
  const env = await boot();
  await page.selectOption("#chat-harness", "opencode");
  await page.waitForFunction(() =>
    [...document.querySelectorAll("#chat-model option")].some((o) => o.value === "acme/discovered-fast"));
  await page.selectOption("#chat-model", "acme/discovered-fast");

  const turn = await send(page, mock, "review this change");
  const posted = mock.requestsFor("/chat", "POST").at(-1);
  assert.equal(posted.body.harness, "opencode");
  assert.equal(posted.body.model, "acme/discovered-fast", "a model discovered from the CLI is sent");
  assert.equal(posted.body.thinkingLevel, "", "no thinking level for an external CLI");
  assert.equal(posted.body.sessionFile, "", "no pi session file to resume");

  await reply(turn, "looks good to me", { sessionId: "h-1" });
  await page.waitForFunction(() =>
    document.getElementById("chat-messages").textContent.includes("looks good to me"));
  assert.equal(env.pageErrors.length, 0, `no page errors: ${env.pageErrors.join("; ")}`);
});

test("a harness saved by an earlier visit is selected on boot with its model", async () => {
  await boot({ "scope-chat-harness": "claude" });
  assert.equal(await page.inputValue("#chat-harness"), "claude");
  assert.equal(await page.inputValue("#chat-model"), "", "the CLI keeps its configured default");
  assert.match(await page.textContent("#chat-header-model"), /Claude Code · default/);
});

test("switching back to Pi restores its model catalogue", async () => {
  await boot();
  await page.selectOption("#chat-harness", "claude");
  await page.waitForFunction(() => document.getElementById("chat-header-model").textContent.includes("Claude Code"));
  await page.selectOption("#chat-harness", "pi");
  await page.waitForFunction(() => {
    const v = document.getElementById("chat-model").value;
    return v.length > 0 && v !== "sonnet";
  });
  assert.match(await page.textContent("#chat-header-model"), /gemini|deepseek|anthropic/);
});

// The model pill is per harness: a model picked for one CLI must never be
// carried into another's list (it would be appended to keep a stale selection
// and read as a Pi model sitting in Claude Code's picker).
test("a model picked for one harness never leaks into another's list", async () => {
  await boot();
  await page.selectOption("#chat-model", "google/gemini-2.5-flash-lite");

  await page.selectOption("#chat-harness", "claude");
  await page.waitForFunction(() => document.getElementById("chat-header-model").textContent.includes("Claude Code"));
  let models = await page.$$eval("#chat-model option", (els) => els.map((el) => el.value));
  assert.deepEqual(models, ["", "sonnet", "opus", "haiku"], "only Claude Code's own models");
  assert.equal(await page.inputValue("#chat-model"), "", "back to the harness default");

  await page.selectOption("#chat-model", "haiku");
  await page.selectOption("#chat-harness", "opencode");
  await page.waitForFunction(() =>
    [...document.querySelectorAll("#chat-model option")].some((o) => o.value === "acme/discovered-coder"));
  models = await page.$$eval("#chat-model option", (els) => els.map((el) => el.value));
  assert.deepEqual(models, ["", "acme/discovered-coder", "acme/discovered-fast", "openai/gpt-5"], "only opencode's list");
  assert.ok(!models.includes("haiku"), "the Claude model was dropped");

  await page.selectOption("#chat-harness", "pi");
  models = await page.$$eval("#chat-model option", (els) => els.map((el) => el.value));
  assert.deepEqual(models, ["google/gemini-2.5-flash-lite", "deepseek/deepseek-v4-flash"], "the Pi catalogue is back");
});
