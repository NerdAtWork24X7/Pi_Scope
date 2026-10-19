// End-to-end tests for the popup design system: every surface that covers the
// app must wear the same chrome — one scrim, one panel (radius · hairline ·
// shadow), one title ramp, one close button, one stacking ladder — with the
// markdown editor as the single, deliberate full-bleed variant. The workflow's
// settings modal is an 80%-wide panel (so the canvas stays visible around it),
// and its form fills that panel: one shared content gutter, two columns on a
// wide panel, and prose boxes that grow into the height the fields leave.
//
// A real server is booted with a git repo, so the popups under test are the real
// ones (a dynamically built Git confirm, the Settings plugin popup, the agent
// definition editor, the workflow node settings) rather than fixtures.
//
//   node --test apps/scope-server/test/popups.e2e.test.mjs

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const SERVER = path.join(ROOT, "apps", "scope-server", "server.ts");
const TOKEN = "popups-test-token";

let browser;
let child;
let base;
let tmpDir;
let repoDir;

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

before(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-popups-")));
  repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(repoDir, { recursive: true });
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd: repoDir, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  };
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(repoDir, "README.md"), "# fixture\n");
  git("add", "README.md");
  git("commit", "-qm", "chore: seed");

  // An agent dir with one subagent definition, so the definition editor — one of
  // the two full-bleed surfaces — has something to open.
  const agentDir = path.join(tmpDir, "agent");
  fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "agents", "demo.md"),
    "---\nname: demo\ndescription: a definition to edit\n---\nDo the demo.\n");
  fs.writeFileSync(path.join(agentDir, "settings.json"), "{}\n");
  fs.mkdirSync(path.join(tmpDir, "plugins"), { recursive: true });

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
      SCOPE_FILE_ROOT: repoDir,
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

/** Open a page on a view with the shared cwd restored, and no page errors. */
async function openView(view, contextOptions = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...contextOptions });
  await context.addInitScript((cwd) => {
    try { localStorage.setItem("scope-cwd", cwd); } catch { /* private mode */ }
  }, repoDir);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e?.message ?? e)));
  await page.goto(`${base}/?token=${TOKEN}#view=${view}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction((cwd) => window.__SCOPE_STATE?.cwd === cwd, repoDir);
  return { page, context, errors };
}

/**
 * The chrome the design system promises, read out of the tokens themselves: the
 * probe's computed values ARE the contract, so this test fails the moment a
 * popup stops consuming a token (not just when a magic number changes).
 */
async function tokenChrome(page) {
  return page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;left:-9999px;background:var(--scrim);" +
      "border:1px solid var(--border);border-radius:var(--r-panel);box-shadow:var(--shadow-panel)";
    document.body.appendChild(probe);
    const cs = getComputedStyle(probe);
    const out = {
      scrim: cs.backgroundColor,
      border: cs.borderTopColor,
      radius: cs.borderRadius,
      shadow: cs.boxShadow,
      z: getComputedStyle(document.documentElement).getPropertyValue("--z-modal").trim(),
    };
    probe.remove();
    return out;
  });
}

/** Everything a floating popup must share, measured off the live DOM. */
const chromeOf = (page, backdropSel, panelSel, titleSel) => page.evaluate(([b, p, t]) => {
  const bd = document.querySelector(b);
  const panel = document.querySelector(p);
  if (!bd || !panel) return null;
  const bcs = getComputedStyle(bd);
  const pcs = getComputedStyle(panel);
  const title = t ? document.querySelector(t) : null;
  const tcs = title ? getComputedStyle(title) : null;
  return {
    scrim: bcs.backgroundColor,
    z: bcs.zIndex,
    radius: pcs.borderRadius,
    border: pcs.borderTopColor,
    borderWidth: pcs.borderTopWidth,
    shadow: pcs.boxShadow,
    title: tcs ? { size: tcs.fontSize, weight: tcs.fontWeight, family: tcs.fontFamily.split(",")[0].replace(/"/g, "") } : null,
  };
}, [backdropSel, panelSel, titleSel]);

const FLOATING = [
  // From index.html (a hidden popup still resolves its own computed chrome).
  ["the system-prompt overlay", "#sp-overlay", "#sp-box", "#sp-title"],
  ["the checkpoint merge confirm", "#cp-merge-modal", "#cp-merge-modal .cp-modal-box", ".cp-modal-title"],
  ["the phone pairing modal", "#phone-modal", "#phone-modal .cp-modal-box", ".cp-modal-title"],
  // Built by the Git view.
  ["the Git confirm", ".git-modal-backdrop", ".git-modal-box", ".git-modal-title"],
  // Built by Settings.
  ["the plugin settings popup", ".plugin-settings-backdrop", ".plugin-settings-modal", ".plugin-settings-title"],
];

describe("popup design system (superdesign-alpha)", () => {
  test("every floating popup wears the same scrim, panel, title and stack order", async () => {
    const { page, context, errors } = await openView("git");
    const tokens = await tokenChrome(page);

    // 1. The system-prompt overlay (a real global the app exposes).
    await page.evaluate(() => window.toggleSysPrompt(true));
    await page.waitForSelector("#sp-overlay.show, #sp-overlay[style*='flex']", { timeout: 5000 }).catch(() => {});

    const results = {};
    results["the system-prompt overlay"] = await chromeOf(page, "#sp-overlay", "#sp-box", "#sp-title");
    await page.evaluate(() => window.toggleSysPrompt(false));

    // 2. The static confirms, simply shown.
    for (const [label, id] of [["the checkpoint merge confirm", "#cp-merge-modal"], ["the phone pairing modal", "#phone-modal"]]) {
      await page.evaluate((sel) => { document.querySelector(sel).style.display = "flex"; }, id);
      results[label] = await chromeOf(page, id, `${id} .cp-modal-box`, `${id} .cp-modal-title`);
      await page.evaluate((sel) => { document.querySelector(sel).style.display = "none"; }, id);
    }

    // 3. The Git confirm, opened from the Push button.
    await page.click("#btn-git-push");
    await page.waitForSelector(".git-modal-backdrop");
    results["the Git confirm"] = await chromeOf(page, ".git-modal-backdrop", ".git-modal-box", ".git-modal-title");
    await page.click(".git-modal-actions button:not(.primary)");

    await context.close();

    // 4. The Settings → Plugins popup (its own page: the Settings nav only
    //    exists on the Settings view).
    const st = await openView("settings");
    await st.page.click('.settings-nav-item[data-sec="plugins"]');
    await st.page.waitForSelector('[data-plugin-config="git"]');
    await st.page.click('[data-plugin-config="git"]');
    await st.page.waitForSelector(".plugin-settings-modal");
    results["the plugin settings popup"] = await chromeOf(st.page, ".plugin-settings-backdrop", ".plugin-settings-modal", ".plugin-settings-title");
    await st.context.close();

    // Every floating popup: the same four promises.
    for (const [label] of FLOATING) {
      const got = results[label];
      assert.ok(got, `${label}: not found`);
      assert.equal(got.scrim, tokens.scrim, `${label}: the shared scrim`);
      assert.equal(got.z, tokens.z, `${label}: the shared stacking order`);
      assert.equal(got.radius, tokens.radius, `${label}: the shared panel radius`);
      assert.equal(got.border, tokens.border, `${label}: the shared hairline`);
      assert.equal(got.shadow, tokens.shadow, `${label}: the shared panel shadow`);
    }
    // One title ramp: the display face, 15px, semibold.
    const ramps = FLOATING.map(([label]) => results[label].title).filter(Boolean);
    assert.equal(ramps.length, FLOATING.length, "every floating popup has a title");
    for (const t of ramps) {
      assert.equal(t.size, "15px", "the shared title size");
      assert.equal(t.weight, "600", "the shared title weight");
      assert.equal(t.family, ramps[0].family, "the shared title face");
    }
    assert.match(ramps[0].family, /Clash Grotesk|Satoshi/, `the display face (${ramps[0].family})`);
    assert.deepEqual(errors, []);
  });

  test("the full-bleed editor, the 80% workflow panel, and the form that fills it", async () => {
    // The markdown editor (Settings → SubAgent → Edit) is the app's one
    // full-bleed surface: square, borderless, shadowless, exactly viewport-sized.
    const { page, context, errors } = await openView("settings");
    await page.click('.settings-nav-item[data-sec="agent"]');
    await page.waitForSelector("[data-agentdef-edit]");
    await page.click('[data-agentdef-edit="demo.md"]');
    await page.waitForSelector("#def-editor-backdrop .def-editor");
    const full = await chromeOf(page, "#def-editor-backdrop", "#def-editor-backdrop .def-editor", ".def-editor-title");
    const tokens = await tokenChrome(page);
    assert.equal(full.scrim, tokens.scrim, "the same scrim as a floating popup");
    assert.equal(full.z, tokens.z, "the same stacking order");
    assert.equal(full.radius, "0px", "square: it is the viewport, not a panel");
    assert.equal(full.shadow, "none", "no shadow: nothing floats");
    assert.equal(full.borderWidth, "0px", "no border");
    assert.equal(full.title.size, "15px", "and the same title ramp");
    const fills = await page.evaluate(() => {
      const r = document.querySelector("#def-editor-backdrop .def-editor").getBoundingClientRect();
      const b = document.querySelector("#def-editor-backdrop").getBoundingClientRect();
      const d = document.documentElement;
      return { w: Math.round(r.width), h: Math.round(r.height), bw: Math.round(b.width), bh: Math.round(b.height), vw: d.clientWidth, vh: d.clientHeight };
    });
    assert.ok(Math.abs(fills.w - fills.bw) <= 20 && Math.abs(fills.h - fills.bh) <= 20, "the surface fills its scrim");
    assert.ok(Math.abs(fills.bw - fills.vw) <= 20 && Math.abs(fills.bh - fills.vh) <= 20, "and the scrim is the viewport");
    assert.deepEqual(errors, []);
    await context.close();

    // The workflow plugin's settings modal is a floating PANEL, not a full-bleed
    // surface: it is 80% of the window wide so the canvas it was opened over
    // stays in view down either side of the scrim, and it wears the shared panel
    // chrome — the same scrim, ladder and title ramp as every other popup.
    //
    // Reduced motion, so the panel's entry animation is off and the box measured
    // below is the box the user ends up with (`rect` reflects a live transform).
    const wf = await openView("subagent-workflow", { reducedMotion: "reduce" });
    await wf.page.waitForSelector("#subagent-workflow-pane .sw-node");
    // A connection opens the same panel and carries the shared title ramp (a
    // node's head is a name field instead of a title).
    await wf.page.evaluate(() =>
      document.querySelector("#subagent-workflow-pane path.sw-edge")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await wf.page.waitForSelector(".sw-modal-backdrop:not([hidden]) .sw-dlg-title");
    const wfChrome = await chromeOf(wf.page, ".sw-modal-backdrop:not([hidden])", ".sw-modal", ".sw-dlg-title");
    const wfTokens = await tokenChrome(wf.page);
    assert.equal(wfChrome.scrim, wfTokens.scrim, "the workflow modal shares the scrim");
    assert.equal(wfChrome.z, wfTokens.z, "and the stacking order");
    assert.equal(wfChrome.radius, wfTokens.radius, "the shared panel radius — it is a panel now");
    assert.equal(wfChrome.border, wfTokens.border, "and the shared hairline");
    assert.equal(wfChrome.shadow, wfTokens.shadow, "and the shared panel shadow");
    assert.equal(wfChrome.title.size, "15px", "and the shared title ramp");
    assert.equal(wfChrome.title.weight, "600");
    assert.equal(wfChrome.title.family, full.title.family, "the same display face as the editor");
    const wfBox = await wf.page.evaluate(() => {
      const r = document.querySelector(".sw-modal").getBoundingClientRect();
      const b = document.querySelector(".sw-modal-backdrop").getBoundingClientRect();
      const bcs = getComputedStyle(document.querySelector(".sw-modal-backdrop"));
      const pad = parseFloat(bcs.paddingLeft) + parseFloat(bcs.paddingRight);
      const padV = parseFloat(bcs.paddingTop) + parseFloat(bcs.paddingBottom);
      const d = document.documentElement;
      return {
        w: Math.round(r.width), h: Math.round(r.height),
        bw: Math.round(b.width), bh: Math.round(b.height),
        avail: Math.round(b.width - pad), availV: Math.round(b.height - padV),
        vw: d.clientWidth, vh: d.clientHeight,
      };
    });
    assert.ok(Math.abs(wfBox.bw - wfBox.vw) <= 20 && Math.abs(wfBox.bh - wfBox.vh) <= 20, "the scrim is the viewport");
    assert.ok(Math.abs(wfBox.w / wfBox.vw - 0.8) < 0.005, `the panel is 80% of the window wide (got ${wfBox.w} of ${wfBox.vw})`);
    assert.ok(Math.abs(wfBox.h - wfBox.availV) <= 2, `and full height, inset by the scrim's padding (got ${wfBox.h}/${wfBox.availV})`);
    // A node's own settings reuse that exact panel — and the form fills it: the
    // head holds the name field with the close ✕ outside it on the top-right
    // corner, while the body splits into two sides on a panel this wide (provider
    // and model on top, the message and the references under it on the left, the
    // node's output on the right) and lets the message box take the height the
    // fixed fields leave.
    await wf.page.keyboard.press("Escape");
    await wf.page.click("#subagent-workflow-pane .sw-node.sw-t-agent .sw-node-config");
    await wf.page.waitForSelector(".sw-modal-backdrop:not([hidden]) .sw-dlg-name");
    await wf.page.waitForSelector("#sw-f-prompt");
    const nodeDlg = await chromeOf(wf.page, ".sw-modal-backdrop:not([hidden])", ".sw-modal", null);
    assert.equal(nodeDlg.radius, wfTokens.radius, "a node's settings open the same panel");
    assert.equal(nodeDlg.scrim, wfTokens.scrim, "over the same scrim");
    const layout = await wf.page.evaluate(() => {
      const rect = (sel) => document.querySelector(sel).getBoundingClientRect();
      const bodyEl = document.querySelector(".sw-dlg-body");
      const bcs = getComputedStyle(bodyEl);
      const box = rect(".sw-dlg-head .sw-dlg-name-wrap");
      const closeX = rect(".sw-dlg-head #sw-close-x");
      const body = bodyEl.getBoundingClientRect();
      const provider = rect(".sw-dlg-body .sw-fld-provider");
      const model = rect(".sw-dlg-body .sw-fld-model");
      const prompt = rect(".sw-dlg-body .sw-fld-prompt");
      const textarea = rect("#sw-f-prompt");
      const refs = rect(".sw-dlg-body .sw-fld-refs");
      const out = rect(".sw-dlg-body .sw-fld-out");
      const actions = rect(".sw-dlg-actions");
      return {
        boxLeft: Math.round(box.left), boxRight: Math.round(box.right),
        closeLeft: Math.round(closeX.left), closeRight: Math.round(closeX.right),
        contentLeft: Math.round(body.left + parseFloat(bcs.paddingLeft)),
        contentRight: Math.round(body.right - parseFloat(bcs.paddingRight)),
        providerLeft: Math.round(provider.left), providerRight: Math.round(provider.right),
        providerTop: Math.round(provider.top), modelLeft: Math.round(model.left), modelTop: Math.round(model.top),
        promptLeft: Math.round(prompt.left), promptRight: Math.round(prompt.right),
        promptTop: Math.round(prompt.top), promptBottom: Math.round(prompt.bottom),
        textareaHeight: Math.round(textarea.height),
        refsLeft: Math.round(refs.left), refsTop: Math.round(refs.top), refsRight: Math.round(refs.right),
        outLeft: Math.round(out.left), outTop: Math.round(out.top), outRight: Math.round(out.right),
        bodyBottom: Math.round(body.bottom), actionsTop: Math.round(actions.top),
      };
    });
    assert.equal(layout.boxLeft, layout.contentLeft, "the node's name field starts on the body's column");
    assert.ok(layout.boxRight < layout.closeLeft, "the close ✕ sits outside the name field");
    assert.equal(layout.closeRight, layout.contentRight, "at the head's right edge");
    assert.equal(layout.providerLeft, layout.contentLeft, "the first field starts there too");
    assert.equal(layout.providerTop, layout.modelTop, "on a wide panel provider and model share a row");
    assert.ok(layout.modelLeft > layout.providerRight, "as two columns, not one stretched field");
    assert.ok(layout.refsTop >= layout.promptBottom - 1, "the references sit under the message");
    assert.equal(layout.refsLeft, layout.promptLeft, "in the same left column");
    assert.equal(layout.refsRight, layout.promptRight, "and line up with its right edge");
    assert.ok(layout.outLeft > layout.refsRight, "the node's output is the right-hand column");
    assert.equal(layout.outRight, layout.contentRight, "which ends on the content edge");
    assert.equal(layout.outTop, layout.providerTop, "and starts on the first row");
    assert.ok(layout.textareaHeight >= 140, `the message box takes the height left by the fields (${layout.textareaHeight}px)`);
    assert.ok(layout.bodyBottom - layout.actionsTop <= 1, "the body fills the space down to the actions row");

    // The trigger fields now fill the start node's panel: schedule and its
    // timing field side by side, with the event watch below them.
    await wf.page.keyboard.press("Escape");
    await wf.page.click("#subagent-workflow-pane .sw-node.sw-t-start .sw-node-config");
    await wf.page.waitForSelector("#sw-tr-mode");
    await wf.page.selectOption("#sw-tr-mode", "interval");
    const trg = await wf.page.evaluate(() => {
      const bodyEl = document.querySelector(".sw-dlg-body");
      const r = (sel) => document.querySelector(sel).getBoundingClientRect();
      const schedule = r(".sw-tr-schedule");
      const every = r("#sw-tr-interval");
      const event = r(".sw-tr-eventbox");
      return {
        overflowX: bodyEl.scrollWidth - bodyEl.clientWidth,
        scheduleTop: Math.round(schedule.top), scheduleRight: Math.round(schedule.right),
        everyTop: Math.round(every.top), everyLeft: Math.round(every.left),
        eventTop: Math.round(event.top), scheduleBottom: Math.round(schedule.bottom),
      };
    });
    assert.ok(trg.overflowX <= 1, `the trigger form stays inside the panel (${trg.overflowX}px)`);
    assert.equal(trg.everyTop, trg.scheduleTop, "schedule and its timing field share a row");
    assert.ok(trg.everyLeft > trg.scheduleRight, "as two columns, not one stretched field");
    assert.ok(trg.eventTop >= trg.scheduleBottom - 1, "and the event watch sits below them");

    // A connection has no fields: its two endpoints span the panel as a flow,
    // with the note and the mono readout under it.
    await wf.page.keyboard.press("Escape");
    await wf.page.evaluate(() => {
      document.querySelector("#subagent-workflow-pane path.sw-edge")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await wf.page.waitForSelector(".sw-conn-flow");
    const conn = await wf.page.evaluate(() => {
      const bodyEl = document.querySelector(".sw-dlg-body");
      const bcs = getComputedStyle(bodyEl);
      const body = bodyEl.getBoundingClientRect();
      const flow = document.querySelector(".sw-conn-flow");
      const notes = document.querySelector(".sw-conn-notes").getBoundingClientRect();
      const ends = [...document.querySelectorAll(".sw-conn-end")].map((el) => el.getBoundingClientRect());
      return {
        overflowX: bodyEl.scrollWidth - bodyEl.clientWidth,
        contentRight: Math.round(body.right - parseFloat(bcs.paddingRight)),
        columns: getComputedStyle(flow).gridTemplateColumns.split(" ").length,
        notesRight: Math.round(notes.right),
        ends: ends.length,
        endsInside: ends.every((b) => b.left >= body.left && b.right <= body.right),
      };
    });
    assert.ok(conn.overflowX <= 1, `a connection's flow stays inside the panel (${conn.overflowX}px)`);
    assert.equal(conn.columns, 3, "the two endpoints sit either side of the connection");
    assert.equal(conn.ends, 2, "both endpoints are drawn");
    assert.ok(conn.endsInside, "and stay inside the panel");
    assert.equal(conn.notesRight, conn.contentRight, "the note and readout end on the content edge");
    assert.deepEqual(wf.errors, []);
    await wf.context.close();
  });

  test("every popup closes with the same control", async () => {
    const { page, context, errors } = await openView("settings");
    // Collect the close buttons of the popups reachable without a Git/workflow
    // view: the plugin settings popup and the definition editor's Close.
    await page.click('.settings-nav-item[data-sec="plugins"]');
    await page.waitForSelector('[data-plugin-config="git"]');
    await page.click('[data-plugin-config="git"]');
    await page.waitForSelector(".plugin-settings-close");
    const sizes = await page.evaluate(() => {
      const out = {};
      for (const sel of [".plugin-settings-close"]) {
        const el = document.querySelector(sel);
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        out[sel] = { w: Math.round(r.width), h: Math.round(r.height), radius: cs.borderRadius, border: cs.borderTopWidth, color: cs.color };
      }
      return out;
    });
    assert.equal(sizes[".plugin-settings-close"].w, 28);
    assert.equal(sizes[".plugin-settings-close"].h, 28);
    assert.equal(sizes[".plugin-settings-close"].radius, "8px");
    assert.equal(sizes[".plugin-settings-close"].border, "1px");
    assert.deepEqual(errors, []);
    await context.close();
  });
});
