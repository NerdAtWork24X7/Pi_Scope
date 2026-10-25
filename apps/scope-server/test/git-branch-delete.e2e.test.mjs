// End-to-end tests for deleting a local branch from the Git view:
//
//   • right-click a history commit → "Delete branch…" offers the branch that
//     points at it (never the checked-out one) and posts /git/branch
//   • the Branches tab has a delete button on each non-current branch
//
// The real public/ assets run against the mock backend, with the /git routes
// scripted here.
//
//   node --test apps/scope-server/test/git-branch-delete.e2e.test.mjs

import { test, before, after, afterEach, describe } from "node:test";
import assert from "node:assert/strict";

import { startMockBackend } from "./mock-backend.mjs";
import { launchBrowser, sleep } from "./harness.mjs";

const CWD = "/tmp/pi-scope-e2e/branch-delete";
const SHA = "1111111111111111111111111111111111111111";

let browser;
let mock;
let context = null;
let page = null;
let pageErrors = [];
let posts = [];

before(async () => {
  mock = await startMockBackend();
  browser = await launchBrowser();
});
after(async () => {
  if (browser) await browser.close();
  if (mock) await mock.close();
});
afterEach(async () => {
  if (context) await context.close();
  context = null;
  page = null;
});

function branchList() {
  return {
    ok: true,
    current: "main",
    branches: [
      { name: "main", sha: SHA.slice(0, 7), upstream: "origin/main", date: "1 day ago" },
      { name: "feature", sha: SHA.slice(0, 7), upstream: "", date: "2 days ago" },
    ],
    remoteBranches: [
      { name: "origin/main", remote: "origin", short: "main", sha: SHA.slice(0, 7), date: "1 day ago" },
      { name: "origin/feature", remote: "origin", short: "feature", sha: SHA.slice(0, 7), date: "2 days ago" },
    ],
  };
}

async function boot() {
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript((cwd) => localStorage.setItem("scope-cwd", cwd), CWD);
  page = await context.newPage();
  pageErrors = [];
  posts = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (/Failed to load resource/.test(m.text())) return;
    pageErrors.push(m.text());
  });
  // The branch-tab delete button goes through the native confirm().
  page.on("dialog", (d) => d.accept());

  await page.route("**/git/status**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      git: true, cwd: CWD, branch: "main", head: SHA.slice(0, 7), detached: false,
      upstream: "origin/main", ahead: 0, behind: 0, remotes: [{ name: "origin" }], files: [],
    }),
  }));
  await page.route("**/git/log**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      ok: true,
      commits: [{
        sha: SHA,
        short: SHA.slice(0, 7),
        subject: "init",
        author: "Tester",
        date: "2026-01-01T00:00:00Z",
        parents: [],
        refs: "HEAD -> main, origin/main, origin/feature, feature",
      }],
    }),
  }));
  await page.route("**/git/branches**", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify(branchList()),
  }));
  await page.route("**/git/branch", (route) => {
    posts.push(route.request().postDataJSON());
    route.fulfill({
      status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, out: "" }),
    });
  });
  await page.route("**/git/commit-message**", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, status: "idle" }),
  }));

  await page.goto(`${mock.base}/?token=test-token#view=git`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".git-commit-row");
  await sleep(150);
  return page;
}

async function menuLabels() {
  return page.evaluate(() =>
    [...document.querySelectorAll(".git-menu .git-menu-item")].map((b) => b.textContent));
}

describe("git branch delete", () => {
  test("history context menu deletes a local branch pointing at the commit", async () => {
    await boot();
    await page.click(".git-commit-row", { button: "right" });
    await page.waitForSelector(".git-menu");
    const labels = await menuLabels();
    assert.ok(labels.includes("Delete branch…"), labels.join(" | "));

    await page.click(".git-menu .git-menu-item:has-text('Delete branch…')");
    await page.waitForSelector(".git-modal-box");
    const message = await page.textContent(".git-modal-box .git-modal-msg");
    assert.match(message, /feature/, "the branch at the commit is offered");
    assert.doesNotMatch(message, /main/, "the checked-out branch is never offered");
    assert.equal(await page.locator(".git-modal-input").count(), 0,
      "a single branch at the commit needs no picker");

    const posted = page.waitForRequest((r) => r.url().includes("/git/branch") && r.method() === "POST");
    await page.click(".git-modal-btn.danger");
    const req = await posted;
    assert.deepEqual(req.postDataJSON(), { cwd: CWD, action: "delete", name: "feature" });
    assert.deepEqual(posts, [{ cwd: CWD, action: "delete", name: "feature" }]);
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("branches tab offers delete on other branches, but not on the current one", async () => {
    await boot();
    await page.click('.git-tab[data-tab="branches"]');
    await page.waitForSelector(".git-branch-item");

    const mainRow = page.locator(".git-branch-item", { hasText: "main" }).first();
    assert.equal(await mainRow.locator("button", { hasText: "delete" }).count(), 0,
      "the checked-out branch has no delete button");

    const featureRow = page.locator(".git-branch-item", { hasText: "feature" }).first();
    const del = featureRow.locator("button", { hasText: "delete" });
    assert.equal(await del.count(), 1, "other branches have a delete button");
    assert.equal(await del.getAttribute("title"), "Delete branch feature");

    const posted = page.waitForRequest((r) => r.url().includes("/git/branch") && r.method() === "POST");
    await del.click();
    const req = await posted;
    assert.deepEqual(req.postDataJSON(), { cwd: CWD, action: "delete", name: "feature" });
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("branches tab deletes a remote-tracking branch on the remote", async () => {
    await boot();
    await page.click('.git-tab[data-tab="branches"]');
    await page.waitForSelector(".git-branch-item.remote");

    const row = page.locator('.git-branch-item.remote', { hasText: "origin/feature" }).first();
    const del = row.locator("button", { hasText: "delete" });
    assert.equal(await del.count(), 1, "remote-tracking branches get a delete button");
    assert.equal(await del.getAttribute("title"), "Delete remote branch origin/feature");

    await del.click();
    await page.waitForSelector(".git-modal-box");
    const message = await page.textContent(".git-modal-box .git-modal-msg");
    assert.match(message, /origin\/feature/);
    assert.match(message, /everyone using that remote/, "the confirmation spells out the shared effect");

    const posted = page.waitForRequest((r) => r.url().includes("/git/branch") && r.method() === "POST");
    await page.click(".git-modal-btn.danger");
    const req = await posted;
    assert.deepEqual(req.postDataJSON(), { cwd: CWD, action: "delete-remote", name: "origin/feature" });
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("right-clicking a history branch badge deletes that branch directly", async () => {
    await boot();

    // Local branch badge.
    await page.click('.git-ref-badge[data-ref="feature"]', { button: "right" });
    await page.waitForSelector(".git-menu");
    let labels = await menuLabels();
    assert.ok(labels.some((l) => l.startsWith("Delete branch")), labels.join(" | "));
    await page.click('.git-menu .git-menu-item:has-text("Delete branch")');
    await page.waitForSelector(".git-modal-box");
    assert.match(await page.textContent(".git-modal-box .git-modal-msg"), /feature/);
    let posted = page.waitForRequest((r) => r.url().includes("/git/branch") && r.method() === "POST");
    await page.click(".git-modal-btn.danger");
    let req = await posted;
    assert.deepEqual(req.postDataJSON(), { cwd: CWD, action: "delete", name: "feature" });

    // Remote-tracking branch badge.
    await sleep(200);
    await page.click('.git-ref-badge[data-ref="origin/feature"]', { button: "right" });
    await page.waitForSelector(".git-menu");
    labels = await menuLabels();
    assert.ok(labels.some((l) => l.startsWith("Delete remote branch")), labels.join(" | "));
    await page.click('.git-menu .git-menu-item:has-text("Delete remote branch")');
    await page.waitForSelector(".git-modal-box");
    assert.match(await page.textContent(".git-modal-box .git-modal-msg"), /origin\/feature/);
    posted = page.waitForRequest((r) => r.url().includes("/git/branch") && r.method() === "POST");
    await page.click(".git-modal-btn.danger");
    req = await posted;
    assert.deepEqual(req.postDataJSON(), { cwd: CWD, action: "delete-remote", name: "origin/feature" });

    // The checked-out branch offers no delete action.
    await sleep(200);
    await page.click('.git-ref-badge[data-ref="main"]', { button: "right" });
    await page.waitForSelector(".git-menu");
    const current = page.locator('.git-menu .git-menu-item:has-text("current branch")');
    assert.equal(await current.count(), 1);
    assert.equal(await current.isDisabled(), true, "the checked-out branch cannot be deleted");
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });
});
