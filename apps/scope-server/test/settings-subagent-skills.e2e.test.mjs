// End-to-end test for per-subagent allowlists in the Settings page: the
// SubAgent tab lists every definition (`agents/*.md`) with its OWN skill AND
// tool chips, backed by the definition's frontmatter `skills:` / `tools:` keys
// — the two keys the agent-team extension reads when it spawns that subagent.
//
// The server is run for real against a temporary SCOPE_AGENT_DIR and a temporary
// chat workspace, and the page is driven in headless Chromium — so this covers
// the whole path the user takes: chip click → POST /settings → frontmatter write
// → re-render, plus the reload that proves the file is the source of truth.
//
//   node --test apps/scope-server/test/settings-subagent-skills.e2e.test.mjs

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import { sleep } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const SERVER = path.join(ROOT, "apps", "scope-server", "server.ts");
const TOKEN = "settings-subagent-skills-token";

const CODER = "---\nname: coder\ndescription: Writes code.\ntools: read, bash\n---\n\nYou are a coder.\n";
// The tool catalogue: pi's own built-in tools (always offered, captured events
// or not) plus the names the seeded agent-team denylist contributes — this
// fixture has no extensions, and a fresh temp DB has no captures. Sorted
// case-insensitively.
const TOOLS = ["bash", "edit", "find", "grep", "ls", "powershell", "read", "write"];

let browser;
let child;
let base;
let tmpDir;
let agentDir;
let coderPath;

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

const readCoder = () => fs.readFileSync(coderPath, "utf8");

/** Poll until the definition file satisfies `pred` (the write is an HTTP round
 *  trip, so the DOM and the file settle at slightly different times). */
async function waitForFile(pred, what) {
  const start = Date.now();
  while (Date.now() - start < 8000) {
    let raw = "";
    try { raw = readCoder(); } catch { /* not written yet */ }
    if (pred(raw)) return raw;
    await sleep(80);
  }
  assert.fail(`timed out waiting for ${what}; file is:\n${readCoder()}`);
}

before(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-subagent-skills-")));
  agentDir = path.join(tmpDir, "agent");
  fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "plugins"), { recursive: true });
  for (const dir of ["flet", "graphify", "video-creator"]) {
    fs.mkdirSync(path.join(agentDir, "skills", dir), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "skills", dir, "SKILL.md"), `---\nname: ${dir}\ndescription: ${dir} skill.\n---\n`);
  }
  // The agent-team config carries no subagent skills any more: a subagent's
  // skills come from its own agents/*.md `skills:` key (the single source of
  // truth). The skip denylist doubles as the tool catalogue here — the server
  // rebuilds `tools` from the observed llm_request allowlist AND this list, and
  // a fresh temp DB has no captures.
  fs.mkdirSync(path.join(tmpDir, ".pi", "settings"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, ".pi", "settings", "agent-team-config.json"),
    JSON.stringify({ skipOrchestratorTools: ["bash", "read", "grep"] }, null, 2) + "\n",
  );
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultModel: "p/m" }, null, 2));
  coderPath = path.join(agentDir, "agents", "coder.md");
  fs.writeFileSync(coderPath, CODER);

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
      // Isolate the agent dir and the file root: nothing here may touch the
      // developer's real ~/.pi-scope.
      SCOPE_AGENT_DIR: agentDir,
      SCOPE_FILE_ROOT: tmpDir,
      SCOPE_PI_BIN: "/bin/true",
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

/** Expand a definition card — they start collapsed, so its chips/inputs are
 *  only clickable once the chevron has been pressed. Idempotent. */
async function expandDef(page, file) {
  await page.evaluate((f) => {
    const btn = document.querySelector(`.set-def-toggle[data-def-toggle="${f}"]`);
    if (btn && btn.getAttribute("aria-expanded") !== "true") btn.click();
  }, file);
}

/** Open the app straight on the Settings view, with `tmpDir` as the chat
 *  workspace so the agent-team config read/written is this test's own. */
async function openSettings() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript((ws) => {
    try { localStorage.setItem("scope-chat-workspace", ws); } catch { /* private mode */ }
  }, tmpDir);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e?.message ?? e)));
  await page.goto(`${base}/?token=${TOKEN}#view=settings`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".set-def-row");
  await expandDef(page, "coder.md");
  await page.waitForSelector('.set-def-row [data-def-dir="flet"]');
  return { context, page, errors };
}

/** The coder definition's rendered row: its state label, which skill chips are
 *  on, whether the None button is the active state, and how many buttons the row
 *  carries (the retired "All/inherit" control must not come back). */
const rowState = (page) =>
  page.evaluate(() => {
    const row = [...document.querySelectorAll(".set-def-row")].find((r) =>
      (r.querySelector(".set-def-file")?.textContent || "").includes("agents/coder.md"));
    if (!row) return null;
    return {
      label: (row.querySelector(".set-def-group-state")?.textContent || "").trim(),
      on: [...row.querySelectorAll("[data-def-dir]")]
        .filter((c) => c.classList.contains("on"))
        .map((c) => c.dataset.defDir)
        .sort(),
      noneOn: !!row.querySelector("[data-def-skills-none]")?.classList.contains("on"),
      hasAll: !!row.querySelector("[data-def-skills-all]"),
    };
  });

/** Poll the rendered row until it satisfies `pred`. The write is an HTTP round
 *  trip and the panel only re-renders from the response, so waiting on the DOM
 *  (not the file, which lands first) is what makes these steps deterministic. */
async function waitForRow(page, pred, what) {
  const start = Date.now();
  while (Date.now() - start < 8000) {
    const s = await rowState(page);
    if (s && pred(s)) return s;
    await sleep(80);
  }
  assert.fail(`timed out waiting for ${what}; row is ${JSON.stringify(await rowState(page))}`);
}

/** Click a chip/button in the coder row and wait for the re-rendered row. */
async function clickAndWait(page, selector, pred, what) {
  await page.locator(`.set-def-row ${selector}`).click();
  return waitForRow(page, pred, what);
}

describe("per-subagent skills in Settings", () => {
  test("a definition with no skills: key gets no skills — the file is the only source", async () => {
    fs.writeFileSync(coderPath, CODER);
    const { context, page, errors } = await openSettings();

    const s = await rowState(page);
    assert.deepEqual(s.on, [], "nothing is granted by a shared default: there is none");
    assert.equal(s.noneOn, true, "an empty list is the definition's own state");
    assert.equal(s.hasAll, false, "the inherit control is gone");
    assert.match(s.label, /^0\/3 pinned$/, `the state labels the pinned list (${s.label})`);
    assert.equal(readCoder(), CODER, "rendering writes nothing");
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("toggling a chip pins that definition's list, and None empties it", async () => {
    fs.writeFileSync(coderPath, CODER);
    const { context, page, errors } = await openSettings();

    let s = await clickAndWait(
      page,
      '[data-def-dir="graphify"]',
      (x) => x.on.includes("graphify"),
      "the graphify chip to turn on",
    );
    assert.deepEqual(s.on, ["graphify"], "the list is born from what the file pinned, not from a default");
    assert.match(s.label, /^1\/3 pinned$/, `state pinned (${s.label})`);
    await waitForFile((raw) => /^skills: graphify$/m.test(raw), "the pinned list on disk");
    assert.equal(readCoder(), CODER.replace("tools: read, bash\n", "tools: read, bash\nskills: graphify\n"));

    // A second chip appends.
    s = await clickAndWait(page, '[data-def-dir="flet"]', (x) => x.on.includes("flet"), "flet to turn on");
    assert.deepEqual(s.on, ["flet", "graphify"]);
    assert.match(s.label, /^2\/3 pinned$/);
    await waitForFile((raw) => /^skills: graphify, flet$/m.test(raw), "the extended list");

    // …and turning one off narrows it.
    s = await clickAndWait(page, '[data-def-dir="graphify"]', (x) => !x.on.includes("graphify"), "graphify to turn off");
    assert.deepEqual(s.on, ["flet"]);
    await waitForFile((raw) => /^skills: flet$/m.test(raw), "the narrower list");

    // None writes an EMPTY key: pi reads that as "no skills".
    s = await clickAndWait(page, "[data-def-skills-none]", (x) => x.noneOn, "the None state");
    assert.deepEqual(s.on, []);
    assert.match(s.label, /^0\/3 pinned$/);
    await waitForFile((raw) => /^skills:$/m.test(raw), "an empty skills: key");

    // Emptying the list does not bring anything back: with no shared subagent
    // set, a chip click from here pins exactly that one skill.
    s = await clickAndWait(page, '[data-def-dir="flet"]', (x) => x.on.includes("flet"), "flet after None");
    assert.deepEqual(s.on, ["flet"], "nothing is inherited back into the list");

    assert.deepEqual(errors, []);
    await context.close();
  });

  test("a pinned list survives a reload — the file is the source of truth", async () => {
    fs.writeFileSync(coderPath, CODER);
    const { context, page, errors } = await openSettings();

    await clickAndWait(page, '[data-def-dir="video-creator"]', (x) => x.on.includes("video-creator"), "a pin");
    await waitForFile((raw) => /^skills: video-creator$/m.test(raw), "the pinned list");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".set-def-row");
    await expandDef(page, "coder.md");
    await page.waitForSelector('.set-def-row [data-def-dir="flet"]');

    const s = await rowState(page);
    assert.deepEqual(s.on, ["video-creator"], "the saved list is what renders");
    assert.match(s.label, /^1\/3 pinned$/);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("a skill can be added by name into the definition's skills: key", async () => {
    fs.writeFileSync(coderPath, CODER);
    const { context, page, errors } = await openSettings();
    // Whatever the previous test left pinned; the point is that adding appends.
    const start = (readCoder().match(/^skills:\s*(.*)$/m)?.[1] || "")
      .split(",").map((s) => s.trim()).filter(Boolean);

    await page.fill('.set-def-row [data-def-skills-input]', "graphify");
    await page.click('[data-def-skills-add]');
    const s = await waitForRow(page, (x) => x.on.includes("graphify"), "the added skill to render");
    assert.deepEqual(s.on, [...start, "graphify"].sort(), "the list is the old one plus the added skill");
    await waitForFile((raw) => raw.includes(`skills: ${[...start, "graphify"].join(", ")}`), "the appended skill on disk");

    // A name with no skills/<dir> is written too — pi loads nothing for it and
    // logs it as unknown — and shows as a ghost chip so it stays visible (and
    // removable) instead of silently doing nothing.
    await page.fill('.set-def-row [data-def-skills-input]', "not-installed");
    await page.keyboard.press("Enter");
    const s2 = await waitForRow(page, (x) => x.on.includes("not-installed"), "the unknown name to render");
    assert.deepEqual(s2.on, [...start, "graphify", "not-installed"].sort());
    await waitForFile((raw) => raw.includes("not-installed"), "the unknown name on disk");
    const ghosts = await page.evaluate(() =>
      [...document.querySelectorAll(".set-def-row .set-chip.ghost")].map((c) => c.dataset.defDir));
    assert.deepEqual(ghosts, ["not-installed"], "the unknown name is flagged, not hidden");

    // Adding it twice is refused rather than duplicated in the file. The
    // Settings view reports its own writes through `#settings-toast` (the
    // global `#scope-toast` belongs to the Chat view).
    await page.fill('.set-def-row [data-def-skills-input]', "not-installed");
    await page.click('[data-def-skills-add]');
    let toastText = "";
    for (let i = 0; i < 80; i++) {
      toastText = await page.evaluate(() => document.getElementById("settings-toast")?.textContent || "");
      if (toastText.includes("already on")) break;
      await sleep(50);
    }
    assert.match(toastText, /already on/, `the second add is refused (toast was "${toastText}")`);
    assert.equal((readCoder().match(/not-installed/g) || []).length, 1, "no duplicate");
    assert.deepEqual(errors, []);
    await context.close();
  });
});

/** The coder definition's **Tools** row: which chips are on, the pinned/default
 *  state, and which of the row's buttons is active. */
const toolsRowState = (page) =>
  page.evaluate(() => {
    const row = [...document.querySelectorAll(".set-def-row")].find((r) =>
      (r.querySelector(".set-def-file")?.textContent || "").includes("agents/coder.md"));
    const tools = row && row.querySelector(".set-def-tools");
    if (!tools) return null;
    return {
      label: (tools.querySelector(".set-def-group-state")?.textContent || "").trim(),
      on: [...tools.querySelectorAll("[data-def-tool]")]
        .filter((c) => c.classList.contains("on") && !c.classList.contains("ghost"))
        .map((c) => c.dataset.defToolName)
        .sort(),
      ghosts: [...tools.querySelectorAll("[data-def-tool].ghost")]
        .map((c) => c.dataset.defToolName).sort(),
      defaultOn: !!tools.querySelector("[data-def-tools-default]")?.classList.contains("on"),
      hasNone: !!tools.querySelector("[data-def-tools-none]"),
      chips: [...tools.querySelectorAll("[data-def-tool]")].length,
    };
  });

/** Poll the rendered Tools row until it satisfies `pred` (the write is an HTTP
 *  round trip, so the DOM settles slightly after the file does). */
async function waitForTools(page, pred, what) {
  const start = Date.now();
  while (Date.now() - start < 8000) {
    const s = await toolsRowState(page);
    if (s && pred(s)) return s;
    await sleep(80);
  }
  assert.fail(`timed out waiting for ${what}; tools row is ${JSON.stringify(await toolsRowState(page))}`);
}

// The same tab renders the other allowlist the agent-team extension reads off
// agents/*.md: `tools:`, handed to the spawned child as `--tools`. There is no
// "None" state to write — the extension falls back to its built-in default list
// for an absent OR empty key — so the row offers Default (drop the key) instead,
// and its chips offer pi's built-in tools plus anything the extensions
// (or captured events) register.
describe("per-subagent tools in Settings", () => {
  test("the row pins, narrows and defaults the definition's tools: key", async () => {
    const { context, page, errors } = await openSettings();
    const before = readCoder();

    // coder.md carries `tools: read, bash`: both are pinned on, nothing inherits.
    let s = await toolsRowState(page);
    assert.equal(s.chips, TOOLS.length, "one chip per catalogue tool");
    assert.deepEqual(s.on, ["bash", "read"]);
    assert.deepEqual(s.ghosts, []);
    assert.equal(s.label, `2/${TOOLS.length} pinned`, `the pinned list is counted (${s.label})`);
    assert.equal(s.defaultOn, false);
    assert.equal(s.hasNone, false, "tools have no \"none\" state");
    assert.equal(readCoder(), before, "rendering writes nothing");

    // Turning a catalogue tool on appends it to the pinned list.
    await page.locator('.set-def-row [data-def-tool-name="grep"]').click();
    s = await waitForTools(page, (x) => x.on.includes("grep"), "the grep chip to turn on");
    assert.deepEqual(s.on, ["bash", "grep", "read"]);
    assert.equal(s.label, `3/${TOOLS.length} pinned`);
    await waitForFile((raw) => /^tools: read, bash, grep$/m.test(raw), "the extended tools list");

    // …and off again narrows it.
    await page.locator('.set-def-row [data-def-tool-name="read"]').click();
    s = await waitForTools(page, (x) => !x.on.includes("read"), "read to turn off");
    assert.deepEqual(s.on, ["bash", "grep"]);
    await waitForFile((raw) => /^tools: bash, grep$/m.test(raw), "the narrowed list");

    // Default drops the key: the built-in list is what the subagent is then
    // launched with, so read and grep come back on (alongside find and ls,
    // which the catalogue now carries as pi built-ins).
    await page.locator('.set-def-row [data-def-tools-default]').click();
    s = await waitForTools(page, (x) => x.defaultOn, "the Default state");
    assert.deepEqual(s.on, ["find", "grep", "ls", "read"]);
    assert.deepEqual(s.ghosts, []);
    assert.equal(s.label, `default · 4/${TOOLS.length}`);
    await waitForFile((raw) => !/^tools:/m.test(raw), "the tools: key to be removed");

    // Adding by name pins the inherited list first, so nothing is silently lost.
    await page.fill('.set-def-row [data-def-tools-input]', "web_fetch");
    await page.click('[data-def-tools-add]');
    s = await waitForTools(page, (x) => x.ghosts.includes("web_fetch"), "the added tool to render");
    assert.deepEqual(s.on, ["find", "grep", "ls", "read"], "the inherited default list survived the pin");
    await waitForFile((raw) => /^tools: read, grep, find, ls, web_fetch$/m.test(raw), "the appended tool");

    assert.deepEqual(errors, []);
    await context.close();
  });

  test("a pinned tools list survives a reload — the file is the source of truth", async () => {
    const { context, page, errors } = await openSettings();

    // Whatever the previous test left behind, Default returns the definition to
    // the built-in list; one chip click then pins a list that includes `bash`.
    await page.locator('.set-def-row [data-def-tools-default]').click();
    await waitForTools(page, (x) => x.defaultOn, "the Default state");
    await page.locator('.set-def-row [data-def-tool-name="bash"]').click();
    await waitForTools(page, (x) => x.on.includes("bash"), "the bash chip to turn on");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".set-def-row");
    await expandDef(page, "coder.md");
    await page.waitForSelector('.set-def-row [data-def-dir="flet"]');

    const s = await toolsRowState(page);
    assert.deepEqual(s.on, ["bash", "find", "grep", "ls", "read"], "the saved list is what renders");
    assert.deepEqual(s.ghosts, []);
    assert.equal(s.defaultOn, false);
    assert.equal(s.label, `5/${TOOLS.length} pinned`);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("a bare tools: key reads as the default list, never as no tools", async () => {
    // An empty key is not a third state: the extension parses `fm.tools ||
    // DEFAULT`, so `tools:` and a missing key both mean the built-in list. The
    // row has to agree, or it would show a subagent with no tools while pi
    // launches it with all four.
    fs.writeFileSync(coderPath, CODER.replace("tools: read, bash\n", "tools:\n"));
    const { context, page, errors } = await openSettings();

    const s = await toolsRowState(page);
    assert.deepEqual(s.on, ["find", "grep", "ls", "read"], "the default list is what the subagent is launched with");
    assert.deepEqual(s.ghosts, [], "every default-list name is in the catalogue");
    assert.equal(s.label, `default · 4/${TOOLS.length}`, "and it reads as Default, not as 0 pinned");
    assert.equal(s.defaultOn, true);
    assert.equal(s.hasNone, false);
    assert.deepEqual(errors, []);
    await context.close();
  });
});

// The Orchestrator card: the main agent's own Skills (agent-team-config.json
// `orchestratorSkills`) and Tools (the `skipOrchestratorTools` denylist). It is
// the only place these are edited now — the bulk "Subagents" / "Subagent tools"
// union groups were removed because each definition configures its own keys.
describe("the Orchestrator card", () => {
  const ORCH_KEY = path.join(tmpDir, ".pi", "settings", "agent-team-config.json");
  const readConfig = () => JSON.parse(fs.readFileSync(ORCH_KEY, "utf8"));

  async function waitForConfig(pred, what) {
    const start = Date.now();
    while (Date.now() - start < 8000) {
      try { if (pred(readConfig())) return; } catch { /* not written yet */ }
      await sleep(80);
    }
    assert.fail(`timed out waiting for ${what}: ${JSON.stringify(readConfig())}`);
  }

  test("skills chips toggle orchestratorSkills; tools chips toggle the skip denylist", async () => {
    fs.writeFileSync(coderPath, CODER);
    const { context, page, errors } = await openSettings();

    // The card self-labels with the orchestrator's name and starts collapsed.
    await page.waitForSelector('[data-def-toggle="__orchestrator__"]');
    const head = await page.evaluate(() => {
      const r = [...document.querySelectorAll(".set-def-row")]
        .find((x) => (x.querySelector(".set-def-file")?.textContent || "") === "main agent");
      return r ? { name: r.querySelector(".set-def-name")?.textContent, collapsed: r.classList.contains("collapsed") } : null;
    });
    assert.deepEqual(head, { name: "Orchestrator", collapsed: true });
    await expandDef(page, "__orchestrator__");
    await page.waitForSelector("[data-orch-tool]");

    // No bulk union groups survive anywhere on the tab.
    assert.equal(await page.locator("[data-def-list]").count(), 0, "the bulk union groups are gone");

    // Skills: none offered to start — the fixture seeds no orchestratorSkills.
    const onSkills = () => page.evaluate(() =>
      [...document.querySelectorAll('.set-chip[data-group="orchestrator"]')]
        .filter((c) => c.classList.contains("on")).map((c) => c.dataset.dir));
    assert.deepEqual(await onSkills(), [], "nothing is offered by default");
    await page.locator('.set-chip[data-group="orchestrator"][data-dir="flet"]').click();
    await waitForConfig((c) => (c.orchestratorSkills || []).includes("flet"), "flet offered to the orchestrator");
    await page.waitForFunction(() =>
      document.querySelector('.set-chip[data-group="orchestrator"][data-dir="flet"]')?.classList.contains("on"));

    // Tools: the fixture seeds skipOrchestratorTools [bash, read, grep], so those
    // read off (skipped) and everything else on (offered).
    const onTools = () => page.evaluate(() =>
      [...document.querySelectorAll("[data-orch-tool]")]
        .filter((c) => c.classList.contains("on")).map((c) => c.dataset.orchTool));
    const before = await onTools();
    assert.ok(!before.includes("bash"), "bash is skipped by the seeded denylist");
    assert.ok(before.includes("write"), "a tool outside the denylist is offered");

    await page.locator('[data-orch-tool="bash"]').click();
    await waitForConfig((c) => !(c.skipOrchestratorTools || []).map((t) => String(t).toLowerCase()).includes("bash"),
      "bash offered again");
    // The chip must reflect the click without a reload: the /agent-team response
    // is folded into the snapshot the card re-renders from.
    await page.waitForFunction(() => document.querySelector('[data-orch-tool="bash"]')?.classList.contains("on"));
    assert.ok((await onTools()).includes("bash"), "the offered tool turns on in the UI");

    await page.locator('[data-orch-tool="write"]').click();
    await waitForConfig((c) => (c.skipOrchestratorTools || []).map((t) => String(t).toLowerCase()).includes("write"),
      "write skipped");
    await page.waitForFunction(() => !document.querySelector('[data-orch-tool="write"]')?.classList.contains("on"));
    assert.ok(!(await onTools()).includes("write"), "the skipped tool turns off in the UI");

    assert.deepEqual(errors, []);
    await context.close();
  });
});
