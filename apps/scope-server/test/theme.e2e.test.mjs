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

const DARK_STOP = "#1c1c1b";
const LIGHT_STOP = "#fffbee";

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
async function open(theme, view = "chat") {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript((t) => {
    try { localStorage.setItem("scope-theme", t); } catch { /* private mode */ }
  }, theme);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e?.message ?? e)));
  await page.goto(`${mock.base}/?token=test-token#view=${view}`, { waitUntil: "domcontentloaded" });
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
    // colours resolved, so #1c1c1b reads back as rgb(28, 28, 27).)
    const painted = await page.evaluate(() => getComputedStyle(document.body).backgroundImage);
    assert.match(painted, /rgb\(28, 28, 27\)/, `body paints the dark gradient (${painted})`);
    assert.doesNotMatch(painted, /rgb\(255, 251, 238\)/, "and not the light theme's first stop");
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
    assert.match(painted, /rgb\(255, 251, 238\)/, `body paints the light gradient (${painted})`);
    await context.close();
  });

  test("the warm-workspace palette resolves to the exact per-theme values", async () => {
    // The whole UI is painted from these tokens; assert the values (not just
    // that a token exists) so a stray edit to the palette cannot ship silently.
    const { context, page } = await open("dark");
    const dark = {
      "--bg": "#1c1c1b",
      "--surface": "#222220",
      "--surface-2": "#232321",
      "--accent": "#ffd43b",
      "--accent-ink": "#f3d778",
      "--on-accent": "#29230e",
      "--border": "#3b3b36",
      "--text": "#f3f1e9",
      "--muted": "#b1b0a7",
      "--text-subtle": "#a09f95",
      "--r-control": "4px",
      "--r-btn": "4px",
      "--r-card": "6px",
      "--r-panel": "6px",
      "--r-pill": "9999px",
    };
    for (const [name, want] of Object.entries(dark)) {
      assert.equal(await token(page, name), want, `dark ${name}`);
    }
    await context.close();

    const { context: lc, page: lp } = await open("light");
    const light = {
      "--bg": "#ffffff",
      "--surface": "#fbfbfa",
      "--surface-2": "#f5f5f3",
      "--accent": "#ffd43b",
      "--accent-ink": "#554400",
      "--on-accent": "#242423",
      "--border": "#e3e3df",
      "--text": "#242423",
      "--muted": "#656560",
      "--text-subtle": "#71716c",
    };
    for (const [name, want] of Object.entries(light)) {
      assert.equal(await token(lp, name), want, `light ${name}`);
    }
    await lc.close();
  });

  test("dropdown menus wear the app's menu chrome, not the browser's blue", async (t) => {
    // The list a <select> opens is browser-painted, so it used to ignore the
    // palette: Chrome's popup surface plus a system-blue checked row. The
    // stylesheet opts into customizable select and dresses the picker with the
    // same tokens as every other anchored menu. Assert that through the DOM the
    // user actually opens — the picker and one of its rows, per theme.
    for (const theme of ["light", "dark"]) {
      const { context, page, errors } = await open(theme, "settings");
      await page.waitForSelector(".set-select:visible");
      if (!(await page.evaluate(() => CSS.supports("appearance", "base-select")))) {
        await context.close();
        t.skip("this browser has no customizable select");
        return;
      }

      // The tokens the picker must consume, read off a probe (computed values).
      const want = await page.evaluate(() => {
        const probe = document.createElement("div");
        probe.style.cssText = "position:fixed;left:-9999px;background:var(--glass-bg-strong);" +
          "border:1px solid var(--border);border-radius:var(--r-card);box-shadow:var(--shadow-panel)" +
          ";color:var(--accent-ink);";
        document.body.appendChild(probe);
        const cs = getComputedStyle(probe);
        const wash = document.createElement("div");
        wash.style.cssText = "position:fixed;left:-9999px;background:var(--accent-soft)";
        document.body.appendChild(wash);
        const out = {
          bg: cs.backgroundColor,
          border: cs.borderTopColor,
          radius: cs.borderRadius,
          shadow: cs.boxShadow,
          checkedBg: getComputedStyle(wash).backgroundColor,
          checkedInk: cs.color,
        };
        wash.remove();
        probe.remove();
        return out;
      });

      await page.locator(".set-select:visible").first().click();
      await page.waitForFunction(() => [...document.querySelectorAll(".set-select")].some((s) => s.matches(":open")));
      const got = await page.evaluate(() => {
        const sel = [...document.querySelectorAll(".set-select")].find((s) => s.matches(":open"));
        const picker = getComputedStyle(sel, "::picker(select)");
        const checked = sel.options[sel.selectedIndex];
        return {
          pickerAppearance: picker.appearance,
          bg: picker.backgroundColor,
          border: picker.borderTopColor,
          radius: picker.borderRadius,
          shadow: picker.boxShadow,
          checkedBg: getComputedStyle(checked).backgroundColor,
          checkedInk: getComputedStyle(checked).color,
          checkedIsSelected: checked.selected,
        };
      });

      // The panel chrome below is only painted when the picker itself opts into
      // base-select; without it Chrome keeps its native list (computed styles
      // still resolve, so the appearance is the assertion that proves it).
      assert.equal(got.pickerAppearance, "base-select", `${theme}: the picker opts into the styled list`);
      assert.equal(got.bg, want.bg, `${theme}: the picker uses the anchored-menu surface`);
      assert.equal(got.border, want.border, `${theme}: the picker uses the hairline`);
      assert.equal(got.radius, want.radius, `${theme}: the picker uses the menu radius`);
      assert.equal(got.shadow, want.shadow, `${theme}: the picker uses the menu shadow`);
      assert.equal(got.checkedIsSelected, true);
      assert.equal(got.checkedBg, want.checkedBg, `${theme}: the checked row wears the accent wash, not system blue`);
      assert.equal(got.checkedInk, want.checkedInk, `${theme}: the checked row's ink is the accent ink`);
      assert.deepEqual(errors, []);
      await context.close();
    }
  });

  test("with no stored choice the app boots in the warm light theme", async () => {
    // PandaCode's default is light; a first visit must not inherit the old
    // dark-first boot. (The inline bootstrap in index.html decides before paint.)
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(`${mock.base}/?token=test-token#view=chat`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.SCOPE?.toast);
    assert.equal(await page.getAttribute("body", "data-ds-dark-theme"), null, "no dark attribute");
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).colorScheme), "light");
    assert.equal(await token(page, "--bg"), "#ffffff", "the light field is painted");
    await context.close();
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
    assert.equal(err.bar, "rgb(176, 53, 53)", "the error toast's bar is red");

    await page.evaluate(() => window.SCOPE.toast("heads up", "warn"));
    await sleep(60);
    const warn = await page.evaluate(() => {
      const el = document.getElementById("scope-toast");
      return { kind: el.className, bar: getComputedStyle(el, "::before").backgroundColor };
    });
    assert.match(warn.kind, /\bwarn\b/);
    // --orange in the light palette.
    assert.equal(warn.bar, "rgb(168, 112, 10)", "the warn toast's bar is orange");
    assert.notEqual(warn.bar, err.bar, "the two kinds are distinguishable");
    await context.close();
  });
});

// A 1×1 PNG — the smallest thing the picker will accept, so the encode path
// (image → canvas → JPEG data URL) is exercised without a fixture file.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** The painted wallpaper layer (body::before) and the stored record. */
const wallpaperLayer = (page) =>
  page.evaluate(() => ({
    has: document.body.classList.contains("has-wallpaper"),
    image: getComputedStyle(document.body, "::before").backgroundImage,
    filter: getComputedStyle(document.body, "::before").filter,
    // The visible reading scrim over the picture (the chat view's column).
    scrim: getComputedStyle(document.querySelector(".chat-main")).backgroundColor,
    stored: localStorage.getItem("scope-wallpaper"),
    button: document.getElementById("btn-wallpaper")?.classList.contains("active"),
  }));

describe("wallpaper", () => {
  test("a picked image becomes the painted background and survives a reload", async () => {
    const { context, page, errors } = await open("light");

    await page.click("#btn-wallpaper");
    assert.equal(await page.locator("#wallpaper-panel").isVisible(), true, "the picker opens under the header icon");
    assert.equal(await page.getAttribute("#btn-wallpaper", "aria-expanded"), "true");

    await page.setInputFiles("#wp-file", { name: "desk.png", mimeType: "image/png", buffer: TINY_PNG });
    await page.waitForFunction(() => document.body.classList.contains("has-wallpaper"));

    const picked = await wallpaperLayer(page);
    assert.equal(picked.has, true, "the wallpaper class is on");
    // Pictures are re-encoded before they are stored: a camera JPEG would blow
    // the origin's storage quota.
    const stored = JSON.parse(picked.stored);
    assert.equal(stored.kind, "image");
    assert.match(stored.value, /^data:image\/jpeg;base64,/, "the picture is stored as a JPEG data URL");
    assert.match(picked.image, /url\("data:image\/jpeg/, "body::before paints the picture");
    assert.match(picked.scrim, /0\.76\)/, `the reading surface is a translucent scrim over it (${picked.scrim})`);
    assert.equal(picked.button, true, "the header icon marks the active background");

    // Cards carry the picture too: the surface tokens go translucent so panels,
    // bubbles and chips are tinted by the wallpaper instead of punching opaque
    // blocks out of it (the accent primary action stays solid on purpose).
    const cards = await page.evaluate(() => {
      const alpha = (sel) => {
        const c = getComputedStyle(document.querySelector(sel)).backgroundColor;
        const m = c.match(/\/\s*([\d.]+)\s*\)$/);
        return m ? Number(m[1]) : 1;
      };
      return {
        composer: alpha(".chat-composer-box"),
        railCard: alpha(".at-sec"),
        surfaceToken: getComputedStyle(document.body).getPropertyValue("--surface").trim(),
        surface2Token: getComputedStyle(document.body).getPropertyValue("--surface-2").trim(),
        primary: alpha("#chat-new-rail"),
      };
    });
    assert.match(cards.surfaceToken, /^color-mix\(in srgb, #[0-9a-f]{6} 50%, transparent\)$/i,
      `cards use a translucent surface token (${cards.surfaceToken})`);
    assert.match(cards.surface2Token, /^color-mix\(in srgb, #[0-9a-f]{6} 38%, transparent\)$/i,
      `sunken surfaces are even more open (${cards.surface2Token})`);
    assert.ok(cards.composer > 0.2 && cards.composer < 0.9, `the composer card is translucent (${cards.composer})`);
    assert.ok(cards.railCard > 0.2 && cards.railCard < 0.9, `rail cards are translucent (${cards.railCard})`);
    assert.equal(cards.primary, 1, "the accent primary action stays solid");

    // Escape closes the picker without clearing the background.
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#wallpaper-panel").isVisible(), false);
    assert.equal((await wallpaperLayer(page)).has, true);

    // Reload: the inline bootstrap in index.html re-applies it before paint.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.__wallpaperState);
    const reloaded = await wallpaperLayer(page);
    assert.equal(reloaded.has, true, "the choice is remembered");
    assert.match(reloaded.image, /^linear-gradient\(rgba\(255, 255, 255/, "the light theme veils it with white");

    // The veil follows the theme, not the stored value.
    await page.click("#btn-theme");
    await sleep(80);
    const dark = await wallpaperLayer(page);
    assert.match(dark.image, /^linear-gradient\(rgba\(0, 0, 0/, "dark veils the same picture with black");

    // Remove clears both the record and the painted layer.
    await page.click("#btn-wallpaper");
    await page.click("#wp-remove");
    await page.waitForFunction(() => !document.body.classList.contains("has-wallpaper"));
    const cleared = await wallpaperLayer(page);
    assert.equal(cleared.stored, null, "the record is deleted");
    assert.equal(cleared.image, "none", "nothing is painted");
    assert.equal(cleared.button, false);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("presets, dim/blur and URL entry all drive the same layer", async () => {
    const { context, page } = await open("light");
    await page.click("#btn-wallpaper");

    await page.click('.wp-swatch[data-preset="bamboo"]');
    await page.waitForFunction(() => document.body.classList.contains("has-wallpaper"));
    let layer = await wallpaperLayer(page);
    assert.match(JSON.parse(layer.stored).value, /^linear-gradient/, "a preset stores a CSS gradient");
    assert.match(layer.image, /^linear-gradient\(rgba\(255, 255, 255/, "and paints directly, without a URL fetch");

    // Dim + blur write through to the painted layer.
    await page.locator("#wp-dim").fill("40");
    await page.locator("#wp-blur").fill("8");
    await page.waitForFunction(() => getComputedStyle(document.body, "::before").filter === "blur(8px)");
    layer = await wallpaperLayer(page);
    assert.match(layer.image, /rgba\(255, 255, 255, 0\.4\)/, `the veil carries the dim level (${layer.image.slice(0, 60)})`);

    // A pasted URL replaces it.
    await page.fill("#wp-url", "https://example.com/paper.jpg");
    await page.click("#wp-url-apply");
    await page.waitForFunction(() => localStorage.getItem("scope-wallpaper")?.includes("example.com"));
    layer = await wallpaperLayer(page);
    assert.equal(JSON.parse(layer.stored).kind, "image");
    assert.match(layer.image, /url\("https:\/\/example\.com\/paper\.jpg"\)/);
    assert.equal(await page.inputValue("#wp-url"), "https://example.com/paper.jpg", "the panel echoes an image URL");

    // Outside click closes the panel.
    await page.mouse.click(600, 700);
    assert.equal(await page.locator("#wallpaper-panel").isVisible(), false);
    await context.close();
  });
});
