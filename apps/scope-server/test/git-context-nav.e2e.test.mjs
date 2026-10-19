// End-to-end tests for the Git view's working-directory context menu and the
// cross-view navigation it wires up:
//
//   • right-click a file → "Open in Review diff" lands in Review with that file
//   • right-click a file → "Add to .gitignore" posts /git/ignore
//   • Review's ⤴ Git button returns to Git with the same file selected
//
// The real public/ assets run against the mock backend, with /git/status,
// /git/ignore and /files/* scripted here.
//
//   node --test apps/scope-server/test/git-context-nav.e2e.test.mjs

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

import { startMockBackend } from "./mock-backend.mjs";
import { launchBrowser, sleep } from "./harness.mjs";

const CWD = "/tmp/pi-scope-e2e/context-nav";
const FILE = "src/app.js";
const CONTENT = "alpha\nbeta";

let browser;
let mock;
let context = null;
let page = null;
let pageErrors = [];
let ignored = [];

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
  ignored = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (/Failed to load resource/.test(m.text())) return;
    pageErrors.push(m.text());
  });

  const status = {
    git: true, cwd: CWD, branch: "main", head: "abc1234", detached: false,
    upstream: null, ahead: 0, behind: 0, remotes: [],
    files: [
      { path: FILE, section: "unstaged", status: "modified" },
      { path: "notes.txt", section: "untracked", status: "untracked" },
    ],
  };
  await page.route("**/git/status**", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify(status),
  }));
  await page.route("**/git/log**", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, commits: [] }),
  }));
  await page.route("**/git/diff**", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ cwd: CWD, file: FILE, cached: false, untracked: false, diff: "" }),
  }));
  await page.route("**/git/ignore**", (route) => {
    const body = route.request().postDataJSON();
    ignored.push(body);
    route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ ok: true, added: body.paths || [] }),
    });
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
    body: JSON.stringify({ cwd: CWD, file: FILE, binary: false, old: CONTENT, new: CONTENT }),
  }));
  await page.route("**/files/graph**", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({
      cwd: CWD, git: true, modules: [], edges: [], fileNodes: [], fileEdges: [],
      changed: [], head: null, stats: { files: 0, modules: 0, changedFiles: 0, add: 0, del: 0 },
    }),
  }));

  await page.goto(`${mock.base}/?token=test-token#view=git`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(`.git-file[data-path="${FILE}"]`);
  await sleep(120);
  return page;
}

async function openRowMenu(path) {
  await page.click(`.git-file[data-path="${path}"]`, { button: "right" });
  await page.waitForSelector(".git-menu");
}

describe("git working-directory context menu", () => {
  test("offers Review diff and .gitignore, and both navigate or act", async () => {
    await boot();
    await openRowMenu(FILE);
    const labels = await page.evaluate(() =>
      [...document.querySelectorAll(".git-menu .git-menu-item")].map((b) => b.textContent));
    assert.ok(labels.includes("Open in Review diff"), labels.join(" | "));
    assert.ok(labels.includes("Add to .gitignore"), labels.join(" | "));

    // Add to .gitignore posts the right path and closes the menu.
    const ignoreResp = page.waitForResponse((r) => r.url().includes("/git/ignore"));
    await page.click(".git-menu .git-menu-item:has-text('Add to .gitignore')");
    await ignoreResp;
    assert.equal(ignored.length, 1);
    assert.deepEqual(ignored[0].paths, [FILE]);
    assert.equal(await page.locator(".git-menu").count(), 0);

    // Open in Review diff switches views and opens the same file's diff.
    await openRowMenu(FILE);
    await page.click(".git-menu .git-menu-item:has-text('Open in Review diff')");
    await page.waitForFunction(() => window.__SCOPE_STATE?.view === "files");
    await page.waitForFunction(() => document.getElementById("diff-filename").textContent === "src/app.js");
    assert.equal(await page.isVisible("#files-pane"), true);
    assert.equal(await page.isVisible("#files-diff"), true);

    // ⤴ Git returns to the Git view with the same file selected in Changes.
    await page.click("#btn-diff-git");
    await page.waitForFunction(() => window.__SCOPE_STATE?.view === "git");
    await page.waitForFunction(() => document.getElementById("git-diff-header").textContent.includes("src/app.js"));
    assert.equal(await page.isVisible("#git-pane"), true);
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });
});
