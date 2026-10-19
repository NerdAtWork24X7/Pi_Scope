// End-to-end tests for the Review view's editable working-tree pane.
//
// The mock backend does not model a repo, so /files/modified, /files/diff and
// /files/save are fulfilled through `page.route`. The real public/ assets still
// run, which is what these tests exercise: a click on any working-tree line
// starts editing, Enter splits a line, Backspace joins it back, and Save sends
// the whole multi-line buffer to /files/save.
//
//   node --test apps/scope-server/test/files-editor.e2e.test.mjs

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

import { startMockBackend } from "./mock-backend.mjs";
import { launchBrowser, sleep } from "./harness.mjs";

const CWD = "/tmp/pi-scope-e2e/editor";
const FILE = "src/app.js";
const ORIGINAL = "alpha\nbeta\ngamma";

let browser;
let mock;
let context = null;
let page = null;
let pageErrors = [];
let saves = [];

before(async () => {
  mock = await startMockBackend();
  browser = await launchBrowser();
});
after(async () => {
  if (browser) await browser.close();
  if (mock) await mock.close();
});

async function boot() {
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript((cwd) => localStorage.setItem("scope-cwd", cwd), CWD);
  page = await context.newPage();
  pageErrors = [];
  saves = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (/Failed to load resource/.test(m.text())) return;
    pageErrors.push(m.text());
  });
  await page.route("**/files/modified**", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({
      cwd: CWD, git: true,
      files: [{ path: FILE, status: "modified", staged: false }],
    }),
  }));
  await page.route("**/files/diff**", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ cwd: CWD, file: FILE, binary: false, old: ORIGINAL, new: ORIGINAL }),
  }));
  await page.route("**/files/save**", (route) => {
    const body = route.request().postDataJSON();
    saves.push(body);
    route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ ok: true, file: FILE, bytes: body.content.length }),
    });
  });
  await page.goto(`${mock.base}/?token=test-token#view=files`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.SCOPE.openReviewFile === "function");
  // Cross-view navigation opens the file and switches Review to its diff view.
  await page.evaluate((file) => window.SCOPE.openReviewFile(file), FILE);
  await page.waitForSelector('#diff-new-lines .tx[data-line="0"]');
  await sleep(150);
  return page;
}

const lines = () => page.evaluate(() => [...document.querySelectorAll("#diff-new-lines .tx[data-line]")]
  .map((el) => ({ line: Number(el.dataset.line), text: el.textContent })));

describe("review file editor", () => {
  test("the working-tree side accepts multi-line edits and saves them whole", async () => {
    await boot();
    assert.deepEqual((await lines()).map((l) => l.text), ["alpha", "beta", "gamma"]);

    // Click the last line, go to its end, press Enter and type a new line. The
    // old code swallowed Enter, so the editor was stuck at three lines.
    await page.click('#diff-new-lines .tx[data-line="2"]');
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("delta");
    await sleep(100);
    const afterEnter = await lines();
    assert.deepEqual(afterEnter.map((l) => l.text), ["alpha", "beta", "gamma", "delta"]);
    assert.equal(afterEnter[3].line, 3, "the new line gets the next working-tree line number");

    // Backspace at the start of a line joins it to the previous one, like a
    // normal editor.
    await page.keyboard.press("Home");
    await page.keyboard.press("Backspace");
    await sleep(100);
    const afterJoin = await lines();
    assert.deepEqual(afterJoin.map((l) => l.text), ["alpha", "beta", "gammadelta"]);
    assert.equal(afterJoin.length, 3);

    // Save sends every line, not just the edited one.
    await page.click("#btn-diff-save");
    await page.waitForFunction(() => document.getElementById("diff-stats").textContent.includes("saved"));
    assert.equal(saves.length, 1);
    assert.equal(saves[0].file, FILE);
    assert.equal(saves[0].content, "alpha\nbeta\ngammadelta");
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("the working-tree pane is one editing host, so selection spans lines", async () => {
    await boot();
    await page.click('#diff-new-lines .tx[data-line="1"]');
    await page.keyboard.press("Control+A");
    const selected = await page.evaluate(() => getSelection().toString());
    assert.equal(selected.replace(/\r/g, "").replace(/\n+/g, "|"), "alpha|beta|gamma",
      "one selection covers the whole file, not just the clicked line");

    // Typing over that selection replaces the whole selection in one edit.
    await page.keyboard.type("zeta");
    await sleep(100);
    assert.deepEqual((await lines()).map((l) => l.text), ["zeta"]);
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("undo and redo cover typing and structural edits", async () => {
    await boot();
    assert.equal(await page.isDisabled("#btn-diff-undo"), true, "nothing to undo yet");

    await page.click('#diff-new-lines .tx[data-line="0"]');
    await page.keyboard.press("End");
    await page.keyboard.type("X");
    await sleep(80);
    assert.deepEqual((await lines())[0].text, "alphaX");
    assert.equal(await page.isDisabled("#btn-diff-undo"), false);

    await page.keyboard.press("Control+z");
    await sleep(80);
    assert.deepEqual((await lines())[0].text, "alpha", "Ctrl+Z restores the typing run");
    assert.equal(await page.isDisabled("#btn-diff-redo"), false);

    await page.keyboard.press("Control+Shift+z");
    await sleep(80);
    assert.deepEqual((await lines())[0].text, "alphaX", "Ctrl+Shift+Z re-applies it");

    // A structural edit is its own step: Enter, undo removes the new line, and
    // the toolbar button redoes it.
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await sleep(80);
    assert.equal((await lines()).length, 4);
    await page.keyboard.press("Control+z");
    await sleep(80);
    assert.equal((await lines()).length, 3, "undo removes the inserted line");
    await page.click("#btn-diff-redo");
    await sleep(80);
    assert.equal((await lines()).length, 4, "the redo button re-inserts it");
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("pasting several lines inserts all of them at the caret", async () => {
    await boot();
    await page.click('#diff-new-lines .tx[data-line="0"]');
    await page.keyboard.press("Home");
    await page.evaluate(() => {
      const el = document.querySelector('#diff-new-lines .tx[data-line="0"]');
      const dt = new DataTransfer();
      dt.setData("text/plain", "one\ntwo\nthree\n");
      el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: dt }));
    });
    await sleep(120);
    assert.deepEqual((await lines()).map((l) => l.text),
      ["one", "two", "three", "alpha", "beta", "gamma"]);
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });
});
