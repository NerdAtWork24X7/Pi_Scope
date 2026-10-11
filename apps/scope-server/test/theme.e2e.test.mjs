// End-to-end tests for the core theme palette, run in headless Chromium against
// the mock backend (which serves the real public/ assets).
//
//   node --test apps/scope-server/test/theme.e2e.test.mjs
//
// These exist because the shell's palette is split across files: `styles.css`
// holds it, and a feature plugin (the Office) ships its own stylesheet that is
// loaded later. A stray edit to either can drop a *core* token — the page then
// silently falls back to the other theme's value (which is exactly how the dark
// `--bg-gradient` went missing once) or to a browser default. So the tokens the
// shell paints with are asserted here per theme, through the browser, not by
// grepping the stylesheet.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

import { startMockBackend } from "./mock-backend.mjs";
import { launchBrowser, sleep } from "./harness.mjs";

const DARK_STOP = "#121212";
const LIGHT_STOP = "#fcfcfb";

let browser;
let mock;

before(async () => {
  mock = await startMockBackend();
  browser = await launchBrowser();
});
after(async () => {
  if (browser) await browser.close();
  if (mock) await mock.close();
});

/** Open the app with one theme selected (index.html reads this at boot). */
async function open(theme) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript((t) => {
    try { localStorage.setItem("scope-theme", t); } catch { /* private mode */ }
  }, theme);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e?.message ?? e)));
  await page.goto(`${mock.base}/?token=test-token#view=chat`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!document.getElementById("view-toggle") && !!window.SCOPE?.toast);
  return { context, page, errors };
}

/** The resolved value of a CSS custom property on the body. */
const token = (page, name) =>
  page.evaluate((n) => getComputedStyle(document.body).getPropertyValue(n).trim(), name);

describe("theme palette", () => {
  test("dark mode paints the dark background gradient, not the light one", async () => {
    const { context, page, errors } = await open("dark");
    assert.equal(await page.getAttribute("body", "data-ds-dark-theme"), "", "the dark attribute is on");

    const dark = await token(page, "--bg-gradient");
    assert.match(dark, new RegExp(DARK_STOP), `dark --bg-gradient is the dark one (${dark || "missing"})`);

    // …and it is what the page actually paints with. (The computed value has the
    // colours resolved, so #1c2334 reads back as rgb(28, 35, 52).)
    const painted = await page.evaluate(() => getComputedStyle(document.body).backgroundImage);
    assert.match(painted, /rgb\(18, 18, 18\)/, `body paints the dark gradient (${painted})`);
    assert.doesNotMatch(painted, /rgb\(252, 252, 251\)/, "and not the light theme's first stop");
    // The light token still exists in the sheet for the light theme.
    assert.match(await token(page, "--bg"), /^#/, "the dark text surface token resolves");
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("light mode paints the light background gradient", async () => {
    const { context, page } = await open("light");
    assert.equal(await page.getAttribute("body", "data-ds-dark-theme"), null, "no dark attribute");

    const light = await token(page, "--bg-gradient");
    assert.match(light, new RegExp(LIGHT_STOP), `light --bg-gradient is the light one (${light || "missing"})`);
    assert.doesNotMatch(light, new RegExp(DARK_STOP), "and is not the dark theme's");
    const painted = await page.evaluate(() => getComputedStyle(document.body).backgroundImage);
    assert.match(painted, /rgb\(252, 252, 251\)/, `body paints the light gradient (${painted})`);
    await context.close();
  });

  test("the superdesign-alpha palette resolves to the exact per-theme values", async () => {
    // The whole UI is painted from these tokens; assert the values (not just
    // that a token exists) so a stray edit to the palette cannot ship silently.
    const { context, page } = await open("dark");
    const dark = {
      "--bg": "#0a0a0a",
      "--surface": "#121212",
      "--accent": "#f5c400",
      "--border": "#2a2a2a",
      "--text": "#ffffff",
      "--muted": "#71717a",
      "--text-subtle": "#a1a1aa",
      "--r-control": "6px",
      "--r-btn": "8px",
      "--r-card": "12px",
      "--r-panel": "16px",
      "--r-pill": "9999px",
    };
    for (const [name, want] of Object.entries(dark)) {
      assert.equal(await token(page, name), want, `dark ${name}`);
    }
    await context.close();

    const { context: lc, page: lp } = await open("light");
    const light = {
      "--bg": "#f7f7f5",
      "--surface": "#ffffff",
      "--accent": "#b45309",
      "--border": "#e4e4e7",
      "--text": "#0a0a0a",
    };
    for (const [name, want] of Object.entries(light)) {
      assert.equal(await token(lp, name), want, `light ${name}`);
    }
    await lc.close();
  });

  test("toasts keep their accent bar per kind", async () => {
    const { context, page } = await open("light");

    // The shell's own toast helper builds the element lazily.
    await page.evaluate(() => window.SCOPE.toast("boom", "err"));
    await sleep(60);
    const err = await page.evaluate(() => {
      const el = document.getElementById("scope-toast");
      return {
        kind: el.className,
        bar: getComputedStyle(el, "::before").backgroundColor,
        text: el.textContent,
      };
    });
    assert.match(err.kind, /\berr\b/, "the toast is marked as an error");
    assert.equal(err.text, "boom");
    // --red in the light palette.
    assert.equal(err.bar, "rgb(220, 38, 38)", "the error toast's bar is red");

    await page.evaluate(() => window.SCOPE.toast("heads up", "warn"));
    await sleep(60);
    const warn = await page.evaluate(() => {
      const el = document.getElementById("scope-toast");
      return { kind: el.className, bar: getComputedStyle(el, "::before").backgroundColor };
    });
    assert.match(warn.kind, /\bwarn\b/);
    // --orange in the light palette.
    assert.equal(warn.bar, "rgb(234, 88, 12)", "the warn toast's bar is orange");
    assert.notEqual(warn.bar, err.bar, "the two kinds are distinguishable");
    await context.close();
  });
});
