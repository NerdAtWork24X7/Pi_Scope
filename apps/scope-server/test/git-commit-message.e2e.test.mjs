// End-to-end tests for Git → "✨ generate": the AI-drafted commit message and
// the configurable model behind it.
//
// The server is run for real, but `SCOPE_PI_BIN` points at a stub "pi" that
// prints a canned message (and records its argv), so the pipeline is exercised
// deterministically without any model provider or network.
//
//   node --test apps/scope-server/test/git-commit-message.e2e.test.mjs

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

const TOKEN = "git-msg-test-token";

const STUB_MESSAGE = "feat(git): stub commit message\n\nStubbed body line.";
const CUSTOM_TEMPLATE = "TEMPLATE-MARKER for {{branch}}\nFiles:\n{{files}}\nDiff:\n{{diff}}";

let browser;
let child;
let base;
let tmpDir;
let repoDir;
let cleanRepoDir;
let argvLog;

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

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

async function waitForHealth(timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not become healthy");
}

async function api(pathname, init = {}) {
  const res = await fetch(`${base}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers || {}) },
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { res, data };
}

function makeRepo(dir, { dirty }) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-qm", "chore: seed"]);
  if (dirty) {
    fs.writeFileSync(path.join(dir, "feature.js"), "export const answer = 42;\n");
    git(dir, ["add", "feature.js"]);
  }
}

before(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-git-msg-")));
  repoDir = path.join(tmpDir, "repo");
  cleanRepoDir = path.join(tmpDir, "clean-repo");
  fs.mkdirSync(path.join(tmpDir, "plugins"), { recursive: true });
  makeRepo(repoDir, { dirty: true });
  makeRepo(cleanRepoDir, { dirty: false });

  // Stub pi: prints a fixed commit message, and records the argv it was given.
  argvLog = path.join(tmpDir, "argv.log");
  const stub = path.join(tmpDir, "fake-pi");
  fs.writeFileSync(
    stub,
    `#!/bin/sh\nif [ -n "$STUB_ARGV_LOG" ]; then printf '%s\\n' "$@" > "$STUB_ARGV_LOG"; fi\n` +
      `printf '%s\\n' '${STUB_MESSAGE}'\n`,
  );
  fs.chmodSync(stub, 0o755);

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
      // Isolate the settings/api-key files: without these the server would read
      // and write the developer's real agent dir, and this test's
      // setGitCommitModel write would leak into their config.
      SCOPE_AGENT_DIR: path.join(tmpDir, "agent"),
      SCOPE_SETTINGS_JSON: path.join(tmpDir, "agent", "settings.json"),
      SCOPE_FILE_ROOT: `${repoDir},${cleanRepoDir}`,
      SCOPE_PI_BIN: stub,
      STUB_ARGV_LOG: argvLog,
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

describe("git commit message settings", () => {
  test("the model is exposed in the settings snapshot and persists", async () => {
    const before = await api("/settings");
    assert.ok(before.res.ok);
    assert.equal(before.data.gitCommitModel, "");

    const set = await api("/settings", {
      method: "POST", body: JSON.stringify({ action: "setGitCommitModel", value: "test/stub-model" }),
    });
    assert.ok(set.res.ok, `set failed: ${JSON.stringify(set.data)}`);
    assert.equal(set.data.gitCommitModel, "test/stub-model");

    const after = await api("/settings");
    assert.equal(after.data.gitCommitModel, "test/stub-model");
  });

  test("the template is exposed, defaults to a {{diff}} template, and persists", async () => {
    const before = await api("/settings");
    assert.equal(before.data.gitCommitTemplate, "");
    assert.match(before.data.gitCommitTemplateDefault, /\{\{diff\}\}/);

    const set = await api("/settings", {
      method: "POST", body: JSON.stringify({ action: "setGitCommitTemplate", value: CUSTOM_TEMPLATE }),
    });
    assert.ok(set.res.ok, `set failed: ${JSON.stringify(set.data)}`);
    assert.equal(set.data.gitCommitTemplate, CUSTOM_TEMPLATE);

    const after = await api("/settings");
    assert.equal(after.data.gitCommitTemplate, CUSTOM_TEMPLATE);
  });
});

describe("git commit message generation", () => {
  test("drafts a message from the staged diff with the configured model", async () => {
    if (fs.existsSync(argvLog)) fs.rmSync(argvLog);
    const { res, data } = await api("/git/commit-message", {
      method: "POST", body: JSON.stringify({ cwd: repoDir }),
    });
    assert.ok(res.ok, `expected 200, got ${res.status}: ${JSON.stringify(data)}`);
    assert.equal(data.ok, true);
    assert.equal(data.message, STUB_MESSAGE);
    assert.equal(data.model, "test/stub-model");
    assert.equal(data.source, "staged");

    // The stub received a one-shot print-mode invocation with the chosen model.
    const argv = fs.readFileSync(argvLog, "utf8").split("\n");
    assert.ok(argv.includes("--print"), "ran pi non-interactively");
    assert.ok(argv.includes("--no-session"), "kept out of the session store");
    assert.ok(argv.includes("test/stub-model"), "used the configured model");
    assert.ok(argv.some((a) => a.includes("feature.js")), "prompt carried the diff");
    // The custom template from Settings was substituted (marker + {{branch}}).
    const prompt = argv.find((a) => a.includes("TEMPLATE-MARKER")) || "";
    assert.ok(prompt, "prompt used the configured template");
    assert.ok(!prompt.includes("{{branch}}"), "{{branch}} was substituted");
    assert.ok(!prompt.includes("{{diff}}"), "{{diff}} was substituted");
  });

  test("falls back to the working tree when nothing is staged", async () => {
    // Unstage everything, then modify a TRACKED file so `git diff` sees it
    // (untracked files never appear in a plain diff).
    git(repoDir, ["reset", "-q", "HEAD"]);
    fs.appendFileSync(path.join(repoDir, "README.md"), "\nworking tree change\n");
    const { res, data } = await api("/git/commit-message", {
      method: "POST", body: JSON.stringify({ cwd: repoDir }),
    });
    assert.ok(res.ok, `expected 200, got ${res.status}: ${JSON.stringify(data)}`);
    assert.equal(data.source, "working tree");
    // Restore: drop the worktree edit and stage the new file again for the UI test.
    git(repoDir, ["checkout", "--", "README.md"]);
    git(repoDir, ["add", "feature.js"]);
  });

  test("returns 400 when there is nothing to describe", async () => {
    const { res, data } = await api("/git/commit-message", {
      method: "POST", body: JSON.stringify({ cwd: cleanRepoDir }),
    });
    assert.equal(res.status, 400);
    assert.match(data.error, /nothing to describe/i);
  });

  test("rejects a cwd outside the allowed roots", async () => {
    const { res } = await api("/git/commit-message", {
      method: "POST", body: JSON.stringify({ cwd: "/etc" }),
    });
    assert.equal(res.status, 400);
  });
});

describe("git view", () => {
  test("Settings → Plugins → Git offers the enabled-model roster for the commit message", async () => {
    // The dropdown is sourced from the enabled-models roster — the same
    // "available" list the Chat composer uses — not the whole model catalogue
    // (which also carries provider caches pi can't resolve, so a pick from there
    // silently fell back to the default model).
    const roster = ["test/alpha", "test/beta"];
    const setRoster = await api("/settings", {
      method: "POST", body: JSON.stringify({ action: "setEnabledModels", value: roster }),
    });
    assert.ok(setRoster.res.ok, `setEnabledModels failed: ${JSON.stringify(setRoster.data)}`);

    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e?.message ?? e)));
    await page.goto(`${base}/?token=${TOKEN}#view=settings`, { waitUntil: "domcontentloaded" });

    // The gear sits on the Git row in Settings → Plugins.
    await page.click('.settings-nav-item[data-sec="plugins"]');
    await page.waitForSelector('[data-plugin-config="git"]');
    await page.click('[data-plugin-config="git"]');
    const modelSel = '#plugin-settings-backdrop select[data-act="setGitCommitModel"]';
    await page.waitForSelector(modelSel);

    // "(agent default)" first, then every roster model, then the configured value
    // (not in the roster) so it is never silently dropped.
    const opts = await page.$$eval(`${modelSel} option`, (els) => els.map((e) => e.value));
    assert.equal(opts[0], "", "first option is the agent default");
    assert.deepEqual(opts.slice(1, 1 + roster.length), roster, "roster models are offered");
    assert.equal(await page.inputValue(modelSel), "test/stub-model");
    assert.ok(opts.includes("test/stub-model"), "current model kept as an option");
    const outside = Object.keys((await api("/settings")).data.modelsMeta || {})
      .find((k) => !roster.includes(k));
    if (outside) assert.ok(!opts.includes(outside), `catalogue-only model ${outside} is not offered`);
    assert.equal(
      await page.inputValue('#plugin-settings-backdrop textarea[data-act="setGitCommitTemplate"]'),
      CUSTOM_TEMPLATE
    );

    // Selecting a roster model persists AND is the model the generator then
    // invokes pi with — the end-to-end guarantee that was broken before.
    await page.selectOption(modelSel, "test/alpha");
    let saved = null;
    for (let i = 0; i < 50 && saved !== "test/alpha"; i++) {
      saved = (await api("/settings")).data.gitCommitModel;
      if (saved !== "test/alpha") await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(saved, "test/alpha", "popup selection persisted");

    if (fs.existsSync(argvLog)) fs.rmSync(argvLog);
    const gen = await api("/git/commit-message", { method: "POST", body: JSON.stringify({ cwd: repoDir }) });
    assert.ok(gen.res.ok, `expected 200, got ${gen.res.status}: ${JSON.stringify(gen.data)}`);
    assert.equal(gen.data.model, "test/alpha", "generation used the model selected in the dropdown");
    assert.ok(fs.readFileSync(argvLog, "utf8").split("\n").includes("test/alpha"), "pi was invoked with the selected model");

    // Escape closes it, and the fields are gone from the Models section.
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.getElementById("plugin-settings-backdrop"));
    await page.click('.settings-nav-item[data-sec="models"]');
    await page.waitForSelector(".settings-panel");
    assert.equal(await page.locator('[data-act="setGitCommitModel"]').count(), 0, "no longer in Models");
    assert.deepEqual(errors, []);

    // Restore the model the rest of the suite expects.
    await api("/settings", {
      method: "POST", body: JSON.stringify({ action: "setGitCommitModel", value: "test/stub-model" }),
    });
    await page.close();
  });

  test("the generate button drafts into the commit textarea", async () => {
    const page = await browser.newPage();
    await page.addInitScript((cwd) => {
      try { localStorage.setItem("scope-cwd", cwd); } catch { /* private mode */ }
    }, repoDir);
    await page.goto(`${base}/?token=${TOKEN}#view=git`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#btn-git-gen-msg");
    // The shared cwd is restored from localStorage before the view boots.
    await page.waitForFunction((cwd) => window.__SCOPE_STATE?.cwd === cwd, repoDir);

    await page.fill("#git-commit-msg", "");
    await page.click("#btn-git-gen-msg");
    await page.waitForFunction(() =>
      document.getElementById("git-commit-msg").value.includes("stub commit message")
    );
    assert.match(await page.inputValue("#git-commit-msg"), /feat\(git\): stub commit message/);
    // The button returns to its resting label after the call.
    await page.waitForFunction(() => document.getElementById("btn-git-gen-msg").disabled === false);
    await page.close();
  });
});
