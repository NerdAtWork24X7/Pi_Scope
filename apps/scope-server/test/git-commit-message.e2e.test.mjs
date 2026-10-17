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
let adoptRepoDir;
let argvLog;
let runsLog;
let sleepFile;

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
  adoptRepoDir = path.join(tmpDir, "adopt-repo");
  fs.mkdirSync(path.join(tmpDir, "plugins"), { recursive: true });
  makeRepo(repoDir, { dirty: true });
  makeRepo(cleanRepoDir, { dirty: false });
  // Its own repo for the adoption tests: draft jobs are keyed by repo, so a
  // shared fixture would leave the earlier tests' job in the registry.
  makeRepo(adoptRepoDir, { dirty: true });

  // Stub pi: prints a fixed commit message, and records the argv it was given.
  // STUB_SLEEP_FILE makes it slow (for the "draft outlives the page" tests) and
  // STUB_RUNS_LOG counts invocations (one line per run).
  argvLog = path.join(tmpDir, "argv.log");
  runsLog = path.join(tmpDir, "runs.log");
  sleepFile = path.join(tmpDir, "slow");
  const stub = path.join(tmpDir, "fake-pi");
  fs.writeFileSync(
    stub,
    `#!/bin/sh\n` +
      `if [ -n "$STUB_RUNS_LOG" ]; then printf 'run\\n' >> "$STUB_RUNS_LOG"; fi\n` +
      `if [ -n "$STUB_SLEEP_FILE" ] && [ -f "$STUB_SLEEP_FILE" ]; then sleep 4; fi\n` +
      `if [ -n "$STUB_ARGV_LOG" ]; then printf '%s\\n' "$@" > "$STUB_ARGV_LOG"; fi\n` +
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
      SCOPE_FILE_ROOT: `${repoDir},${cleanRepoDir},${adoptRepoDir}`,
      // The background model-catalog refresh also runs SCOPE_PI_BIN, which would
      // land in STUB_RUNS_LOG and break the "exactly one pi ran" accounting the
      // draft job tests do. Disable it (as the other suites do) so the stub is
      // only ever invoked by the feature under test.
      SCOPE_MODEL_CATALOG: "off",
      SCOPE_PI_BIN: stub,
      STUB_ARGV_LOG: argvLog,
      STUB_RUNS_LOG: runsLog,
      STUB_SLEEP_FILE: sleepFile,
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

  test("the template is exposed, defaults to a paths template, and persists", async () => {
    const before = await api("/settings");
    assert.equal(before.data.gitCommitTemplate, "");
    assert.match(before.data.gitCommitTemplateDefault, /\{\{files\}\}/);
    assert.doesNotMatch(before.data.gitCommitTemplateDefault, /\{\{diff\}\}/,
      "the default hands the model the paths, not the diff");

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
    // The run must not inherit pi's default (coding-assistant / orchestrator)
    // system prompt: the whole answer lands verbatim in the commit box, so the
    // prompt is replaced with one that asks for a commit message and nothing
    // else — replaced, not appended to.
    const spAt = argv.indexOf("--system-prompt");
    assert.ok(spAt >= 0, "the default system prompt is replaced");
    const systemPrompt = argv[spAt + 1] ?? "";
    assert.match(systemPrompt, /commit message/i, "a commit-message system prompt is sent");
    assert.ok(!/coding assistant/i.test(systemPrompt), "pi's coding-assistant prompt is not sent");
    assert.ok(!argv.includes("--append-system-prompt"), "the default prompt is replaced, not extended");
    // The orchestrator's rules also arrive as discovered instruction files
    // (AGENTS.md/CLAUDE.md, including the agent dir's global one), so the run
    // has to opt out of those too — otherwise they steer the message even with
    // the default system prompt gone.
    assert.ok(argv.includes("--no-context-files"), "AGENTS.md instructions are not injected");
    assert.ok(argv.includes("test/stub-model"), "used the configured model");
    assert.ok(argv.some((a) => a.includes("feature.js")), "prompt carried the changed path");
    // The custom template from Settings was substituted (marker + {{branch}}).
    const prompt = argv.find((a) => a.includes("TEMPLATE-MARKER")) || "";
    assert.ok(prompt, "prompt used the configured template");
    assert.ok(!prompt.includes("{{branch}}"), "{{branch}} was substituted");
    assert.ok(!prompt.includes("{{diff}}"), "{{diff}} was substituted");
  });

  test("the default template sends the changed paths and lets the model inspect the files", async () => {
    // Clear the custom template (Settings → Plugins → Git) so the built-in
    // default is used: it must hand over the paths only — no diff, no hunks —
    // and tell the model to go and look for itself.
    const clear = await api("/settings", {
      method: "POST", body: JSON.stringify({ action: "setGitCommitTemplate", value: "" }),
    });
    assert.ok(clear.res.ok, `clear failed: ${JSON.stringify(clear.data)}`);

    if (fs.existsSync(argvLog)) fs.rmSync(argvLog);
    const { res, data } = await api("/git/commit-message", {
      method: "POST", body: JSON.stringify({ cwd: repoDir }),
    });
    assert.ok(res.ok, `expected 200, got ${res.status}: ${JSON.stringify(data)}`);
    assert.equal(data.source, "staged");

    const prompt = fs.readFileSync(argvLog, "utf8");
    assert.ok(prompt.includes("feature.js"), "the changed path is sent");
    assert.ok(!prompt.includes("@@"), "no diff hunk is sent");
    assert.ok(!prompt.includes("diff --git"), "no diff header is sent");
    assert.ok(!prompt.includes("+export const answer"), "no added line is sent");
    assert.match(prompt, /git diff/, "the model is told to inspect the files itself");
    assert.ok(!prompt.includes("{{files}}"), "{{files}} was substituted");

    // Restore the custom template the rest of the suite reads back.
    await api("/settings", {
      method: "POST", body: JSON.stringify({ action: "setGitCommitTemplate", value: CUSTOM_TEMPLATE }),
    });
  });

  test("describes only the staged change, ignoring unstaged worktree edits", async () => {
    // Unstage everything, leave a TRACKED worktree edit (a plain `git diff`
    // would see it), and stage a different file. The draft must describe the
    // index — the commit that would actually be made — not the worktree.
    git(repoDir, ["reset", "-q", "HEAD"]);
    fs.appendFileSync(path.join(repoDir, "README.md"), "\nworking tree change\n");
    fs.writeFileSync(path.join(repoDir, "staged.js"), "export const staged = true;\n");
    git(repoDir, ["add", "staged.js"]);

    if (fs.existsSync(argvLog)) fs.rmSync(argvLog);
    const { res, data } = await api("/git/commit-message", {
      method: "POST", body: JSON.stringify({ cwd: repoDir }),
    });
    assert.ok(res.ok, `expected 200, got ${res.status}: ${JSON.stringify(data)}`);
    assert.equal(data.source, "staged");
    const prompt = fs.readFileSync(argvLog, "utf8");
    assert.ok(prompt.includes("staged.js"), "the staged path is sent");
    assert.ok(!prompt.includes("README.md"), "the unstaged worktree edit is not sent");

    // Restore: drop the worktree edit and the extra file, stage feature.js again.
    git(repoDir, ["checkout", "--", "README.md"]);
    git(repoDir, ["reset", "-q", "HEAD"]);
    fs.rmSync(path.join(repoDir, "staged.js"), { force: true });
    git(repoDir, ["add", "feature.js"]);
  });

  test("returns 400 when nothing is staged", async () => {
    // A worktree edit alone is not enough: a commit would contain nothing.
    git(repoDir, ["reset", "-q", "HEAD"]);
    fs.appendFileSync(path.join(repoDir, "README.md"), "\nworktree only\n");
    const { res, data } = await api("/git/commit-message", {
      method: "POST", body: JSON.stringify({ cwd: repoDir }),
    });
    assert.equal(res.status, 400);
    assert.match(data.error, /nothing staged/i);
    git(repoDir, ["checkout", "--", "README.md"]);
    git(repoDir, ["add", "feature.js"]);
  });

  test("returns 400 when there is nothing to describe", async () => {
    const { res, data } = await api("/git/commit-message", {
      method: "POST", body: JSON.stringify({ cwd: cleanRepoDir }),
    });
    assert.equal(res.status, 400);
    assert.match(data.error, /nothing staged/i);
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

  test("the commit box can be grown by dragging its handle", async () => {
    const page = await browser.newPage();
    await page.addInitScript((cwd) => {
      try { localStorage.setItem("scope-cwd", cwd); } catch { /* private mode */ }
    }, repoDir);
    await page.goto(`${base}/?token=${TOKEN}#view=git`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#git-commit-resizer");
    await page.waitForFunction((cwd) => window.__SCOPE_STATE?.cwd === cwd, repoDir);

    const barH = () => page.$eval(".git-commitbar", (el) => el.getBoundingClientRect().height);
    const start = await barH();
    assert.ok(start > 0, "commit bar is laid out");

    // Drag the handle upward — the bar (and the textarea inside it) grows.
    const box = await page.locator("#git-commit-resizer").boundingBox();
    const cx = box.x + box.width / 2;
    await page.mouse.move(cx, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(cx, box.y + box.height / 2 - 180, { steps: 8 });
    await page.mouse.up();

    const grown = await barH();
    assert.ok(grown > start + 100, `bar grew with the drag (${start} → ${grown})`);
    const taH = await page.$eval("#git-commit-msg", (el) => el.getBoundingClientRect().height);
    assert.ok(taH > start, `textarea stretched to fill the bar (${taH})`);

    // The chosen height survives a reload.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#git-commit-resizer");
    await page.waitForFunction(
      (h) => Math.abs(document.querySelector(".git-commitbar").getBoundingClientRect().height - h) < 4,
      grown
    );

    // Double-clicking the handle restores the default height.
    await page.dblclick("#git-commit-resizer");
    await page.waitForFunction(
      (h) => Math.abs(document.querySelector(".git-commitbar").getBoundingClientRect().height - h) < 4,
      start
    );
    await page.close();
  });
});

// The draft is produced by a server-side job, so leaving the Git view — or
// reloading the document, which the Chat nav does — no longer throws the answer
// away while `pi` keeps working. These tests pin that contract end to end.
describe("git commit message job (the draft outlives the page)", () => {
  const jobUrl = (cwd) => `/git/commit-message?cwd=${encodeURIComponent(cwd)}`;

  const runs = () => (fs.existsSync(runsLog) ? fs.readFileSync(runsLog, "utf8").trim().split("\n").filter(Boolean).length : 0);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const startJob = (cwd) => api("/git/commit-message", { method: "POST", body: JSON.stringify({ cwd }) });

  async function waitForStatus(cwd, status, timeoutMs = 15_000) {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < timeoutMs) {
      last = (await api(jobUrl(cwd))).data;
      if (last?.status === status) return last;
      await sleep(150);
    }
    throw new Error(`job for ${cwd} never reached "${status}" (last: ${JSON.stringify(last)})`);
  }

  test("a repo with no draft reports idle, and a finished draft is readable", async () => {
    const idle = await api(jobUrl(adoptRepoDir));
    assert.ok(idle.res.ok);
    assert.deepEqual({ ok: idle.data.ok, status: idle.data.status }, { ok: true, status: "idle" });

    const before = runs();
    const started = await startJob(adoptRepoDir);
    assert.ok(started.res.ok, `start failed: ${JSON.stringify(started.data)}`);
    assert.equal(started.data.message, STUB_MESSAGE);
    assert.equal(runs(), before + 1);

    // The snapshot the view adopts on its next show: same job, terminal state,
    // message plus the model/source the draft was made with.
    const done = (await api(jobUrl(adoptRepoDir))).data;
    assert.equal(done.status, "done");
    assert.equal(done.job, started.data.job, "GET reports the job the POST ran");
    assert.equal(done.message, STUB_MESSAGE);
    assert.equal(done.model, started.data.model);
    assert.equal(done.source, "staged");
    assert.ok(done.finishedAt >= done.startedAt);
  });

  test("a second request joins the run in flight instead of spawning another pi", async () => {
    fs.writeFileSync(sleepFile, "1");
    try {
      const before = runs();
      const first = startJob(adoptRepoDir);
      const running = await waitForStatus(adoptRepoDir, "running");
      assert.equal(running.message, "", "a running job has no message yet");
      assert.equal(runs(), before + 1, "exactly one pi is running");

      const second = startJob(adoptRepoDir);
      const [a, b] = await Promise.all([first, second]);
      assert.ok(a.res.ok && b.res.ok, `joins failed: ${JSON.stringify([a.data, b.data])}`);
      assert.equal(a.data.message, STUB_MESSAGE);
      assert.equal(b.data.message, STUB_MESSAGE, "the joined request is answered, not rejected");
      assert.equal(a.data.job, b.data.job, "both requests report the same job");
      assert.equal(runs(), before + 1, "the second request did not spawn a second pi");
      assert.equal((await api(jobUrl(adoptRepoDir))).data.status, "done");
    } finally {
      fs.rmSync(sleepFile, { force: true });
    }
  });

  test("committing consumes the draft, so it is never adopted afterwards", async () => {
    const started = await startJob(adoptRepoDir);
    assert.ok(started.res.ok, `start failed: ${JSON.stringify(started.data)}`);
    assert.equal((await api(jobUrl(adoptRepoDir))).data.status, "done");

    const committed = await api("/git/commit", {
      method: "POST", body: JSON.stringify({ cwd: adoptRepoDir, message: "chore: adopt fixture" }),
    });
    assert.ok(committed.res.ok, `commit failed: ${JSON.stringify(committed.data)}`);
    assert.equal((await api(jobUrl(adoptRepoDir))).data.status, "idle");

    // …and the repo is clean, so a new draft has nothing to describe.
    const again = await startJob(adoptRepoDir);
    assert.equal(again.res.status, 400);
  });

  test("the view restores a running draft after a document reload (the reported bug)", async () => {
    // Fresh changes to describe (the previous test committed the fixture).
    fs.writeFileSync(path.join(adoptRepoDir, "reload.js"), "export const reload = true;\n");
    git(adoptRepoDir, ["add", "reload.js"]);

    fs.writeFileSync(sleepFile, "1");
    const page = await browser.newPage();
    try {
      await page.addInitScript((cwd) => {
        try { localStorage.setItem("scope-cwd", cwd); } catch { /* private mode */ }
      }, adoptRepoDir);
      await page.goto(`${base}/?token=${TOKEN}#view=git`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction((cwd) => window.__SCOPE_STATE?.cwd === cwd, adoptRepoDir);

      const before = runs();
      await page.click("#btn-git-gen-msg");
      await page.waitForFunction(() => document.getElementById("btn-git-gen-msg").disabled === true);

      // Leave the page mid-generation. The request dies with the document.
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector("#btn-git-gen-msg");
      await page.waitForFunction((cwd) => window.__SCOPE_STATE?.cwd === cwd, adoptRepoDir);

      // The new document finds the job still running (busy button restored)…
      await page.waitForFunction(() => document.getElementById("btn-git-gen-msg").disabled === true, null, { timeout: 5000 });
      // …and adopts the message once it lands, releasing the button.
      await page.waitForFunction(
        (msg) => document.getElementById("git-commit-msg").value.includes(msg),
        "stub commit message",
        { timeout: 20_000 }
      );
      await page.waitForFunction(() => document.getElementById("btn-git-gen-msg").disabled === false);
      assert.equal(runs(), before + 1, "the reload did not re-run pi");
      assert.equal((await api(jobUrl(adoptRepoDir))).data.status, "done");
    } finally {
      fs.rmSync(sleepFile, { force: true });
      await page.close();
    }
  });

  test("the view adopts a draft finished while it was hidden", async () => {
    fs.writeFileSync(path.join(adoptRepoDir, "hidden.js"), "export const hidden = true;\n");
    git(adoptRepoDir, ["add", "hidden.js"]);

    fs.writeFileSync(sleepFile, "1");
    const page = await browser.newPage();
    try {
      await page.addInitScript((cwd) => {
        try { localStorage.setItem("scope-cwd", cwd); } catch { /* private mode */ }
      }, adoptRepoDir);
      await page.goto(`${base}?token=${TOKEN}#view=git`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction((cwd) => window.__SCOPE_STATE?.cwd === cwd, adoptRepoDir);

      await page.click("#btn-git-gen-msg");
      await page.waitForFunction(() => document.getElementById("btn-git-gen-msg").disabled === true);
      // Switch views while the model works: the poll stops with the view, and
      // the draft is adopted when the view comes back.
      await page.evaluate(() => window.setView("files"));
      await page.waitForFunction(
        () => (document.querySelector("#git-pane")?.style.display || "") === "none"
      );
      await sleep(4500); // the draft finishes off-screen
      await page.evaluate(() => window.setView("git"));
      await page.waitForFunction(
        (msg) => document.getElementById("git-commit-msg").value.includes(msg),
        "stub commit message",
        { timeout: 10_000 }
      );
      await page.waitForFunction(() => document.getElementById("btn-git-gen-msg").disabled === false);
    } finally {
      fs.rmSync(sleepFile, { force: true });
      await page.close();
    }
  });
});
