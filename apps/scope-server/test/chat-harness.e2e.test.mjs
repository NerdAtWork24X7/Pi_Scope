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

test("the model pill is searchable, and the picked model rides on the next prompt", async () => {
  await boot();
  const pill = page.locator("#chat-model");
  await pill.waitFor();
  const all = await pill.locator("option").count();
  await pill.click();
  await page.waitForSelector(".scope-sel-pop:not([hidden])");
  assert.equal(await page.locator(".scope-sel-opt").count(), all, "the whole catalogue is offered");
  await page.keyboard.type("gemini");
  const rows = await page.locator(".scope-sel-opt .scope-sel-name").allInnerTexts();
  assert.ok(rows.length > 0 && rows.length < all, `typing narrows the list (${rows})`);
  assert.ok(rows.every((t) => /gemini/i.test(t)), "only matching models remain");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".scope-sel-pop")?.hidden === true);
  const chosen = await pill.inputValue();
  assert.match(chosen, /gemini/i, "Enter picked the first match");

  await send(page, mock, "use the picked model");
  assert.equal(mock.requestsFor("/chat", "POST").at(-1).body.model, chosen);
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

test("an external harness hides the pi-only Agent Team rail", async () => {
  await boot();
  assert.equal(await page.locator("#chat-agent-rail").isVisible(), true, "Pi shows its agent team");
  assert.equal(await page.locator("#chat-resizer-r").isVisible(), true);

  await page.selectOption("#chat-harness", "claude");
  await page.waitForFunction(() => document.body.classList.contains("chat-external-harness"));
  assert.equal(await page.locator("#chat-agent-rail").isVisible(), false, "a CLI has no Pi agent team");
  assert.equal(await page.locator("#chat-resizer-r").isVisible(), false, "its drag handle goes with it");

  await page.selectOption("#chat-harness", "pi");
  await page.waitForFunction(() => !document.body.classList.contains("chat-external-harness"));
  assert.equal(await page.locator("#chat-agent-rail").isVisible(), true, "selecting Pi brings the rail back");
});

test("typing / offers the commands the selected harness itself advertises", async () => {
  await boot();
  await page.selectOption("#chat-harness", "claude");
  await page.waitForFunction(() => document.body.classList.contains("chat-external-harness"));

  await page.fill("#chat-input", "/");
  await page.waitForSelector("#chat-slash:not([hidden]) .chat-slash-item");
  let cmds = await page.$$eval("#chat-slash .chat-slash-cmd", (els) => els.map((e) => e.textContent));
  assert.deepEqual(cmds, ["/compact", "/model", "/status"], "what Claude Code answered");
  assert.match(await page.textContent("#chat-slash .chat-slash-head"), /Claude Code/);

  // The list comes from the harness, scoped to this workspace — never from a
  // table shipped in this repo.
  const asked = mock.requestsFor("/chat/harness-commands", "GET").at(-1);
  assert.equal(asked.query.harness, "claude");
  assert.equal(asked.query.cwd, WS, "project commands/skills are directory scoped");

  // Arrows move the highlighted row.
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.textContent("#chat-slash .chat-slash-item.active .chat-slash-cmd"), "/model");

  // The query filters by command name.
  await page.fill("#chat-input", "/mo");
  await page.waitForFunction(() =>
    document.querySelectorAll("#chat-slash .chat-slash-cmd").length === 1);
  assert.equal(await page.textContent("#chat-slash .chat-slash-cmd"), "/model");

  // Enter inserts the command instead of sending it.
  await page.keyboard.press("Enter");
  assert.equal(await page.inputValue("#chat-input"), "/model ", "command inserted with room for arguments");
  await page.waitForFunction(() => document.getElementById("chat-slash").hidden === true);
  assert.equal(await page.locator("#chat-slash").isVisible(), false, "the menu closes after inserting");
  assert.equal(mock.requestsFor("/chat", "POST").length, 0, "nothing was sent yet");

  // A harness that publishes no command interface opens no menu at all.
  await page.selectOption("#chat-harness", "aider");
  await page.fill("#chat-input", "/");
  assert.equal(await page.locator("#chat-slash").isVisible(), false);
  assert.equal(mock.requestsFor("/chat/harness-commands", "GET")
    .some((r) => r.query.harness === "aider"), false, "no CLI was started for a harness without one");

  // A harness with an interface but no commands says so instead of showing a
  // guessed list.
  await page.selectOption("#chat-harness", "pi");
  await page.fill("#chat-input", "/");
  await page.waitForSelector("#chat-slash:not([hidden]) .chat-slash-status");
  assert.match(await page.textContent("#chat-slash .chat-slash-status"), /did not advertise any commands/);
  assert.equal(await page.locator("#chat-slash .chat-slash-item").count(), 0);
});

test("a harness that cannot answer explains why the menu is empty", async () => {
  await boot();
  mock.setHarnessCommands("opencode", { error: "opencode: the harness exited before answering" });
  await page.selectOption("#chat-harness", "opencode");
  await page.fill("#chat-input", "/");
  await page.waitForSelector("#chat-slash:not([hidden]) .chat-slash-status.err");
  assert.match(await page.textContent("#chat-slash .chat-slash-status"), /exited before answering/);

  // The refresh control asks again (the server re-runs discovery).
  const before = mock.requestsFor("/chat/harness-commands", "GET").length;
  await page.locator("#chat-slash [data-slash-refresh]").dispatchEvent("mousedown");
  await page.waitForTimeout(150);
  assert.ok(mock.requestsFor("/chat/harness-commands", "GET").length > before, "refresh re-asks the harness");
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
