#!/usr/bin/env node
/**
 * capture-shots.mjs — regenerate the README/site screenshots from the app.
 *
 *   node docs/capture-shots.mjs                 # every view, both themes
 *   node docs/capture-shots.mjs chat git        # only those views
 *
 * Boots the real scope server on a throwaway DB, seeds the demo sessions
 * (docs/seed-demo.mjs) from inside a scratch project, and drives the actual UI
 * with Playwright to capture each view at 1600×900 @2x — the same geometry as
 * the shots in docs/shots/.
 *
 * The seeded demo is run from tmp/demo/model-selector, a small git repo with a
 * branch, a staged file and unstaged edits. Because a workspace *is* the shared
 * working directory, that makes Review / Checkpoints / Git / Terminal open on a
 * self-contained demo project instead of on whatever the agent is editing in
 * this checkout. Two workspaces (model-selector, model_selector) mirror the
 * README's "two projects" story.
 *
 * Each view is loaded fresh: the shared workspaces rail is populated at boot
 * for a non-chat view, not when the view changes in place.
 *
 * Office needs a seeded agent team, so it is captured against the test mock
 * backend (apps/scope-server/test/mock-backend.mjs) — the same way the office
 * e2e tests drive it.
 *
 * Every PNG this run writes is then decoded with zlib and checked: exact
 * dimensions, real colour variety, and not a blank panel. Failures are
 * reported, never hidden.
 */
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startMockBackend, defaultTeam, makeSession } from "../apps/scope-server/test/mock-backend.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "docs", "shots");
const DEMO_ROOT = path.join(ROOT, "tmp", "demo");
/** The scratch project every workspace-scoped view opens on. */
const PROJECT = path.join(DEMO_ROOT, "model-selector");
/** seed-demo's second project, so the rail shows two workspaces. */
const SIBLING = path.join(DEMO_ROOT, "model_selector");
const DB = path.join(ROOT, "tmp", "shots.db");
const BASE = "http://127.0.0.1:43190";
const VW = 1600, VH = 900, DSF = 2;
/** The hero demo session: the coder adding dark mode (see docs/seed-demo.mjs). */
const HERO = "sess-darkmode-9f3a2b";

const wanted = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const want = (name) => !wanted.length || wanted.includes(name);

const log = (...a) => console.log("[shots]", ...a);
const hold = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
/** Every PNG this run wrote — only those get verified. */
const written = new Set();

function fail(what, detail) {
  failures.push(`${what}: ${detail}`);
  console.error(`[shots] FAIL ${what} — ${detail}`);
}

// ─── Scratch projects (Review / Checkpoints / Git / Terminal) ───────────────
function setupDemoProjects() {
  rmSync(DEMO_ROOT, { recursive: true, force: true });
  mkdirSync(PROJECT, { recursive: true });
  mkdirSync(SIBLING, { recursive: true });

  const w = (dir, name, text) => writeFileSync(path.join(dir, name), text);
  const git = (args) => execSync(`git ${args}`, { cwd: PROJECT, stdio: "pipe" });

  w(PROJECT, "README.md", "# Model Selector\n\nA tiny API that returns a paginated list of models.\n\n## Endpoints\n\n- `GET /models`\n");
  w(PROJECT, "api.py",
    'from fastapi import APIRouter\n\nrouter = APIRouter()\n\n\n@router.get("/models")\nasync def get_models():\n    return {"models": list_models()}\n');
  w(PROJECT, "store.py",
    'MODELS = [\n    {"id": "gpt-5"},\n    {"id": "claude-sonnet-4"},\n]\n\n\ndef list_models():\n    return MODELS\n');
  git("init -q -b main");
  git('config user.email "demo@pi-scope.local"');
  git('config user.name "Demo Bot"');
  git("add -A");
  git('commit -qm "Initial commit: model selector API"');

  // Second commit — the shape of a real agent change.
  w(PROJECT, "api.py",
    'from fastapi import APIRouter, Query\nfrom store import list_models\n\nrouter = APIRouter()\n\n\n@router.get("/models")\nasync def get_models(limit: int = Query(20, ge=1, le=100), offset: int = Query(0, ge=0)):\n    all_models = list_models()\n    return {"models": all_models[offset:offset + limit], "total": len(all_models)}\n');
  git("add -A");
  git('commit -qm "Add pagination: limit/offset params + total count"');
  git("checkout -qb feature/dark-mode");
  git("checkout -q main");

  // Working tree: one staged file, two unstaged — so Git shows both sections
  // and Review has a real diff to open.
  w(PROJECT, "store.py",
    'MODELS = [\n    {"id": "gpt-5"},\n    {"id": "claude-sonnet-4"},\n    {"id": "gemini-3.5-flash"},\n]\n\n\ndef list_models():\n    return sorted(MODELS, key=lambda m: m["id"])\n');
  git("add store.py");
  w(PROJECT, "README.md",
    "# Model Selector\n\nA tiny API that returns a paginated list of models.\n\n## Endpoints\n\n- `GET /models`\n\n## Usage\n\n```bash\ncurl \"http://localhost:8000/models?limit=5&offset=10\"\n```\n\n## Development\n\n```bash\nuvicorn app:app --reload\n```\n");
  w(PROJECT, "tests.log",
    "============================= test session starts =============================\ncollected 12 items\n\ntests/test_store.py ............                                         [100%]\n\n============================== 12 passed in 0.42s ==============================\n");

  // The second project in the rail (seed-demo derives it as a sibling).
  w(SIBLING, "README.md", "# Model Selector (worker)\n\nBatch jobs that refresh the model catalog nightly.\n");
  w(SIBLING, "refresh.py", "from store import list_models\n\n\ndef refresh() -> int:\n    return len(list_models())\n");
  log("scratch projects ready:", PROJECT);
}

/**
 * Seed a readable Subagent Workflow graph for the Workflow view, through the
 * plugin's own API — the same actions its canvas sends (see
 * plugins/subagent-workflow/server.ts). Only harnesses this machine can really
 * run are offered, so the shot never advertises a CLI that is not installed.
 */
async function seedWorkflow(token) {
  const call = async (path, init) => {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
    if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
    return res.json();
  };
  const enc = encodeURIComponent(PROJECT);
  const act = (body) => call("/subagent-workflow", { method: "POST", body: JSON.stringify({ cwd: PROJECT, ...body }) });

  const { harnesses } = await call("/subagent-workflow/harnesses");
  const usable = harnesses.filter((h) => h.available);
  const runner = usable.find((h) => h.id === "pi") ?? usable[0];
  const model = (runner?.models ?? [])[0] ?? "";
  log("workflow: harness", runner?.id, model ? `model ${model}` : "(no model catalogue)");

  await act({ action: "setWorkflowName", name: "Model Selector CI" });

  const snap = await call(`/subagent-workflow?cwd=${enc}`);
  const start = snap.nodes.find((n) => n.type === "start");
  const end = snap.nodes.find((n) => n.type === "end");
  const planner = snap.nodes.find((n) => n.type === "agent");
  start.defaultTask ??= "Add pagination to the model selector API";

  const agent = (name, prompt) => ({ harness: runner.id, model, prompt });
  await act({ action: "updateNode", id: planner.id, name: "planner", config: agent("planner", "Read the task and write a short implementation plan.") });
  await act({ action: "moveNode", id: planner.id, x: 380, y: 210 });

  const builder = (await act({ action: "addNode", type: "agent", x: 700, y: 90 })).nodes.at(-1);
  await act({ action: "updateNode", id: builder.id, name: "builder", config: agent("builder", "Implement the plan: limit/offset plus a total count.") });
  const tester = (await act({ action: "addNode", type: "agent", x: 700, y: 330 })).nodes.at(-1);
  await act({ action: "updateNode", id: tester.id, name: "tester", config: agent("tester", "Cover the new endpoint and report failures.") });

  const gate = (await act({ action: "addNode", type: "approval", x: 990, y: 210 })).nodes.at(-1);
  await act({ action: "updateNode", id: gate.id, name: "review", config: { description: "Human gate", message: "Review the plan and the diff before it is committed." } });

  for (const e of snap.edges) await act({ action: "removeEdge", id: e.id });
  for (const [from, to] of [
    [start.id, planner.id], [planner.id, builder.id], [planner.id, tester.id],
    [builder.id, gate.id], [tester.id, gate.id], [gate.id, end.id],
  ]) await act({ action: "addEdge", from, to });

  const after = await call(`/subagent-workflow?cwd=${enc}`);
  log(`workflow: ${after.nodes.length} nodes, ${after.edges.length} edges, run "${after.name}"`);
}

// ─── Real server + seeded demo ──────────────────────────────────────────────
async function startServer() {
  for (const f of [DB, `${DB}-shm`, `${DB}-wal`]) rmSync(f, { force: true });
  const server = spawn("node", ["apps/scope-server/server.ts"], {
    cwd: ROOT,
    env: { ...process.env, SCOPE_DB_PATH: DB },
    stdio: "ignore",
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) { up = true; break; }
    } catch { /* not up yet */ }
    await hold(250);
  }
  if (!up) throw new Error("scope server never became healthy on " + BASE);

  // seed-demo derives the project from its cwd, so run it inside the scratch repo.
  await new Promise((resolve, reject) =>
    spawn("node", [path.join(ROOT, "docs", "seed-demo.mjs")], {
      cwd: PROJECT,
      env: { ...process.env, SCOPE_URL: BASE },
      stdio: "ignore",
    }).on("exit", (c) => (c === 0 ? resolve() : reject(new Error("seed-demo exited " + c))))
  );
  const tokenFile = path.join(ROOT, "tmp", "scope_token");
  const token = existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "";
  if (!token) throw new Error("no auth token at tmp/scope_token");
  log("server up, seeded demo, token", token.slice(0, 8) + "…");
  return { server, token };
}

// ─── Capture ────────────────────────────────────────────────────────────────
async function captureRealViews(token) {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const context = await browser.newContext({
    viewport: { width: VW, height: VH },
    deviceScaleFactor: DSF,
    colorScheme: "dark",
  });
  await context.addInitScript(() => {
    try {
      localStorage.setItem("scope-theme", "dark");
      localStorage.setItem("scope-chat-rail-left", "open");
      localStorage.setItem("scope-chat-rail-right", "open");
    } catch { /* ignore */ }
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => fail("page error", e.message));

  /** On a content timeout, print what the view actually shows — we cannot eyeball it. */
  const diagnose = async (label) => {
    const state = await page.evaluate(() => {
      const rail = document.querySelector("#sidebar-rail, #chat-workspace-rail");
      return {
        hash: location.hash,
        ws: [...(rail?.querySelectorAll(".chat-ws") ?? [])].map((e) =>
          (e.dataset.cwd || "").split("/").pop() + (e.querySelector(".chat-ws-children")?.style.display === "none" ? ":folded" : ":open")),
        sess: [...(rail?.querySelectorAll(".ws-sess") ?? [])].map((e) => e.dataset.sid + (e.offsetParent ? ":vis" : ":off")),
        // View-specific state: which cwd a pane thinks it is on, and what it shows.
        filesCwd: document.querySelector("#files-cwd-label")?.textContent?.trim(),
        filesList: (document.querySelector("#files-list")?.innerText || "").replace(/\s+/g, " ").slice(0, 90),
        filesDiagram: !document.querySelector("#files-diagram")?.classList.contains("hidden"),
        gitCwd: document.querySelector("#git-cwd-label")?.textContent?.trim(),
        trajRows: document.querySelectorAll(".traj-row").length,
        events: document.querySelectorAll(".evt-row").length,
      };
    }).catch(() => null);
    if (state) console.error(`[shots]   ${label} state:`, JSON.stringify(state));
  };
  const waitFor = async (sel, ms = 15000, label = "") => {
    try { await page.waitForSelector(sel, { timeout: ms }); return true; }
    catch { if (label) await diagnose(label); return false; }
  };
  const clickIf = async (sel, ms = 4000) => {
    try { await page.locator(sel).first().click({ timeout: ms }); return true; } catch { return false; }
  };

  /**
   * Each view gets a real document load: the non-chat rail only renders at boot,
   * and navigating to the same URL with a different hash is a same-document
   * navigation the app does not re-route (it would keep showing the old view).
   * The throwaway query param forces the reload.
   */
  const openView = async (view, railSel = "#sidebar-rail") => {
    await page.goto(`${BASE}/?token=${encodeURIComponent(token)}&v=${view}#view=${view}`, { waitUntil: "domcontentloaded" });
    // Settings is a full-screen panel with no workspaces rail; pass null there.
    if (railSel && !(await waitFor(`${railSel} .chat-ws`, 25000))) fail(view, "the workspaces rail never populated");
    await hold(800);
    return railSel;
  };

  /** A workspace row is the shared working directory for every pane. */
  const selectWorkspace = async (view, railSel = "#sidebar-rail", cwd = PROJECT) => {
    if (await clickIf(`${railSel} .chat-ws[data-cwd="${cwd}"]`)) { await hold(900); return true; }
    if (await clickIf(`${railSel} [data-cwd="${cwd}"]`)) { await hold(900); return true; }
    fail(view, `workspace ${cwd} is not in the rail`);
    return false;
  };

  /** Session rows are nested inside their (folded) workspace group. */
  const selectSession = async (view, railSel = "#sidebar-rail", sid = HERO) => {
    const row = page.locator(`${railSel} .ws-sess[data-sid="${sid}"]`);
    if ((await row.count()) && (await row.first().isVisible())) {
      await row.first().click().catch(() => {});
      return true;
    }
    const any = page.locator(`${railSel} .ws-sess:visible`);
    if (await any.count()) {
      fail(view, `session ${sid} hidden in the rail; used another row`);
      await any.first().click().catch(() => {});
      return true;
    }
    fail(view, "no session rows visible in the rail");
    return false;
  };

  /**
   * Dark then light from one live session — the header toggle is enough.
   * `readySel` is the selector for the content that makes the shot worth
   * taking: it is re-checked after the theme flip, because several panes
   * re-render on a theme change and a bare screenshot would catch them blank.
   */
  const shotBoth = async (name, readySel) => {
    if (readySel && !(await waitFor(readySel, 12000, name))) fail(name, `content never appeared (${readySel})`);
    await hold(600);
    const dark = path.join(OUT, `${name}-dark.png`);
    await page.screenshot({ path: dark });
    written.add(dark);
    await clickIf("#btn-theme", 3000);
    if (readySel && !(await waitFor(readySel, 12000, `${name} light`))) fail(name, "content vanished after the theme flip");
    await hold(900);
    const light = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: light });
    written.add(light);
    await clickIf("#btn-theme", 3000);
    await hold(400);
    log("wrote", `${name}.png`, "+", `${name}-dark.png`);
  };

  // ── Chat ────────────────────────────────────────────────────────────────
  if (want("chat")) {
    const rail = await openView("chat", "#chat-workspace-rail");
    await selectWorkspace("chat", rail);
    if (!(await selectSession("chat", rail))) fail("chat", "no session to open");
    await hold(1400);
    await shotBoth("chat", "#chat-messages .chat-msg");
  }

  // ── Single ──────────────────────────────────────────────────────────────
  if (want("single")) {
    await openView("single");
    await selectWorkspace("single");
    await selectSession("single");
    if (!(await waitFor("#event-view .evt-row", 15000, "single"))) fail("single", "no event rows");
    await page.locator("#event-view .evt-row", { hasText: "tool call" }).first().click().catch(() => {});
    await hold(700);
    await page.locator("#event-view .evt-row", { hasText: "assistant" }).first().click().catch(() => {});
    await hold(1000);
    await shotBoth("single", "#event-view .evt-row");
  }

  // ── Trajectory ──────────────────────────────────────────────────────────
  if (want("trajectory")) {
    await openView("trajectory");
    await selectWorkspace("trajectory");
    await selectSession("trajectory");
    if (!(await waitFor("#trajectory-ledger .traj-row", 15000, "trajectory"))) fail("trajectory", "no ledger rows");
    await hold(1000);
    await shotBoth("trajectory", "#trajectory-ledger .traj-row");
  }

  // ── Terminal ────────────────────────────────────────────────────────────
  if (want("terminal")) {
    await openView("terminal");
    await selectWorkspace("terminal");
    if (!(await clickIf("#btn-bash", 6000))) fail("terminal", "no bash button");
    if (!(await waitFor(".xterm", 15000, "terminal"))) fail("terminal", "xterm never opened");
    await hold(1800);
    await page.locator(".xterm").first().click({ position: { x: 300, y: 120 } }).catch(() => {});
    // Selecting a workspace does not cd the shell, so cd explicitly.
    for (const cmd of [`cd ${PROJECT}`, "clear", "git log --oneline -3", "git status -s", "ls -1"]) {
      await page.keyboard.type(cmd);
      await hold(220);
      await page.keyboard.press("Enter");
      await hold(1000);
    }
    await hold(800);
    // The terminal DOM-renders its rows, so the output is checkable as text.
    const termText = await page.evaluate(() => document.querySelector(".xterm-rows")?.innerText || "");
    if (!/Add pagination/.test(termText)) {
      fail("terminal", `output does not show the demo repo (saw: ${termText.replace(/\s+/g, " ").slice(0, 70)})`);
    }
    await shotBoth("terminal", ".xterm-rows");
  }

  // ── Review (Files) ──────────────────────────────────────────────────────
  if (want("review")) {
    await openView("files");
    await selectWorkspace("review");
    /*
     * The pane opens on the module diagram, with the changed-file list folded
     * away and the diff pane set to display:none. Review is the list + the
     * side-by-side diff, so put it back into that layout first.
     */
    const filesState = await page.evaluate(() => ({
      listHidden: document.getElementById("files-list")?.classList.contains("hidden") ?? false,
      diffHidden: getComputedStyle(document.getElementById("files-diff")).display === "none",
    }));
    if (filesState.listHidden) await clickIf("#btn-files-toggle", 5000);
    if (filesState.diffHidden) await clickIf("#btn-files-diagram", 5000);
    await hold(900);
    if (!(await waitFor("#files-list .file-item", 15000, "review"))) fail("review", "no changed files listed");
    await page.locator("#files-list .file-item", { hasText: "README.md" }).first().click().catch(() => {});
    if (!(await waitFor("#diff-old-lines .dline, #diff-new-lines .dline", 15000, "review"))) fail("review", "no diff lines");
    await hold(1200);
    await shotBoth("review", "#files-list .file-item");
  }

  // ── Git: history, changes, branches ─────────────────────────────────────
  if (want("git")) {
    await openView("git");
    await selectWorkspace("git");
    if (!(await waitFor(".git-tab"))) fail("git", "no tabs");

    await clickIf('.git-tab[data-tab="history"]');
    if (!(await waitFor(".git-commit-row", 15000, "git"))) fail("git", "no commit rows");
    await page.locator(".git-commit-row").first().click().catch(() => {});
    await hold(1600);
    await shotBoth("git", ".git-commit-row");

    await clickIf('.git-tab[data-tab="changes"]');
    await hold(1800);
    await shotBoth("git-changes", "#git-tab-changes:not([hidden])");

    await clickIf('.git-tab[data-tab="branches"]');
    await hold(1800);
    await shotBoth("git-branches", "#git-tab-branches:not([hidden])");
  }

  // ── Checkpoints (last: creating one commits the scratch repo's working
  //    tree, which would empty the Review and Git changes shots) ───────────
  if (want("checkpoints")) {
    await openView("checkpoints");
    await selectWorkspace("checkpoints");
    await waitFor("#checkpoints-list", 10000);
    const existing = await page.$$eval("#checkpoints-list .checkpoint-item", (e) => e.length).catch(() => 0);
    if (!existing) {
      await page.locator("#checkpoints-label").fill("before the pagination refactor").catch(() => {});
      await clickIf("#btn-checkpoints-create", 5000);
      await hold(2500);
    }
    if (!(await waitFor("#checkpoints-list .checkpoint-item", 12000, "checkpoints"))) fail("checkpoints", "no checkpoint rows");
    await hold(900);
    await shotBoth("checkpoints", "#checkpoints-list .checkpoint-item");
  }

  // ── Workflow ────────────────────────────────────────────────────────────
  if (want("workflow")) {
    await openView("subagent-workflow");
    await selectWorkspace("workflow");
    if (!(await waitFor("#sw-canvas .sw-node", 15000, "workflow"))) fail("workflow", "no nodes on the canvas");
    const nodes = await page.$$eval("#sw-canvas .sw-node", (e) => e.length);
    if (nodes < 6) fail("workflow", `expected the seeded graph, saw ${nodes} nodes`);
    await hold(1200);
    await shotBoth("workflow", "#sw-canvas .sw-node");
  }

  // ── Settings ────────────────────────────────────────────────────────────
  if (want("settings")) {
    await openView("settings", null);
    if (!(await clickIf("#btn-settings", 6000))) fail("settings", "no settings button");
    if (!(await waitFor(".settings-panel, .settings-group", 15000, "settings"))) fail("settings", "settings never rendered");
    await hold(1400);
    await shotBoth("settings", ".settings-panel, .settings-group");
  }

  await context.close();
  await browser.close();
}

// ─── Office (mock backend: it needs a seeded agent team) ────────────────────
async function captureOffice() {
  const WS = "/tmp/pi-scope-shots/model-selector";
  const mock = await startMockBackend();
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    mock.setTeam(defaultTeam({
      activeTeam: "dev",
      teamsOrder: ["dev", "review"],
      teams: {
        dev: [
          { name: "orchestrator", active: true },
          { name: "builder", displayName: "Bob", model: "deepseek/deepseek-v4-flash" },
          { name: "critic", model: "google/gemini-2.5-flash-lite" },
        ],
        review: [{ name: "writer", model: "anthropic/claude-sonnet-4", active: false }],
      },
      disabledAgents: ["writer"],
      library: [
        { id: "lib_1", path: `${WS}/docs/arch.md`, note: "the API map", target: "builder" },
        { id: "lib_2", path: `${WS}/docs/`, note: "workspace notes", target: "orchestrator" },
      ],
      tasks: [
        { id: "task_1", title: "draft the API surface", status: "todo", createdAt: 1, note: "settings + sessions first" },
        { id: "task_2", title: "document the board", status: "todo", createdAt: 2 },
        { id: "task_4", title: "polish the README", status: "todo", createdAt: 5, note: "screenshots + the board" },
        { id: "task_3", title: "set up the workspace", status: "done", createdAt: 3, finishedAt: 4 },
      ],
      defaultModel: "google/gemini-2.5-flash-lite",
    }));
    mock.setSessions([
      makeSession({ session_id: "s1", cwd: WS, agent_name: "orchestrator", last_turn_event: "turn_start", model: "google/gemini-2.5-flash-lite" }),
      makeSession({ session_id: "s2", cwd: WS, agent_name: "builder", last_turn_event: "turn_start", model: "deepseek/deepseek-v4-flash" }),
      makeSession({ session_id: "s3", cwd: WS, agent_name: "critic", last_turn_event: "turn_end", model: "google/gemini-2.5-flash-lite" }),
      makeSession({ session_id: "s4", cwd: WS, agent_name: "writer", last_turn_event: "turn_end", model: "anthropic/claude-sonnet-4" }),
    ]);
    mock.setStats("s1", { total_tokens: 88_400, total_cost: 1.2031 });
    mock.setStats("s2", { total_tokens: 12_345, total_cost: 0.042 });
    mock.setStats("s3", { total_tokens: 4_500, total_cost: 0.008 });
    mock.setStats("s4", { total_tokens: 31_200, total_cost: 0.611 });
    mock.setOffice({
      officeName: "Model Selector",
      runnerPaused: true,
      tasks: [
        { id: "t1", title: "draft the API surface", status: "planned", createdAt: 1, plannedAt: 2 },
        { id: "t2", title: "document the board", status: "todo", createdAt: 3 },
        { id: "t3", title: "set up the workspace", status: "done", createdAt: 4, finishedAt: 5 },
      ],
    });
    mock.broadcastSSE({
      event_id: "e1", session_id: "s2", seq: 9, ts: new Date().toISOString(),
      type: "tool_call", agent_name: "builder", pool: "chat",
      payload: { tool_name: "bash", args: { command: "pytest -q" } },
    });

    const context = await browser.newContext({
      viewport: { width: VW, height: VH },
      deviceScaleFactor: DSF,
      colorScheme: "dark",
    });
    await context.addInitScript(() => { try { localStorage.setItem("scope-theme", "dark"); } catch { /* ignore */ } });
    const page = await context.newPage();
    page.on("pageerror", (e) => fail("office page error", e.message));

    const shot = async (file) => {
      const f = path.join(OUT, file);
      await page.screenshot({ path: f });
      written.add(f);
      log("wrote", file);
    };
    const clickAndSettle = async (clickSel, waitSel) => {
      try { await page.locator(clickSel).first().click({ timeout: 6000 }); } catch { return false; }
      try { await page.waitForSelector(waitSel, { timeout: 8000 }); } catch { return false; }
      await hold(600);
      return true;
    };

    await page.goto(`${mock.base}/?token=test-token#view=office`, { waitUntil: "domcontentloaded" });
    if (!(await page.waitForSelector("#office-pane .office-pod", { timeout: 25000 }).catch(() => null))) {
      fail("office", "no desks rendered");
    }
    await hold(2000);
    await shot("office-dark.png");

    if (await clickAndSettle("#office-board-open", "#office-board-backdrop .office-task")) {
      await shot("office-kanban-dark.png");
      await page.keyboard.press("Escape");
      await hold(600);
    } else fail("office", "kanban board did not open");

    if (await clickAndSettle("#office-library-open", "#office-lib-backdrop .office-lib-row")) {
      await shot("office-library-dark.png");
      await page.keyboard.press("Escape");
      await hold(600);
    } else fail("office", "library panel did not open");

    // Hire lives in the orchestrator's settings popup: its desk gear → hire.
    if (!(await clickAndSettle("#office-orch-settings", ".office-set-hire"))) fail("office", "orchestrator settings did not open");
    if (!(await clickAndSettle(".office-set-hire", ".office-dialog #office-hire-name"))) fail("office", "hire form did not open");
    await page.fill("#office-hire-name", "tester").catch(() => {});
    await page.fill("#office-hire-display", "Dana").catch(() => {});
    await hold(700);
    await shot("office-hire-dark.png");

    await context.close();
  } finally {
    await browser.close();
    await mock.close();
  }
}

// ─── Verify the pixels we just wrote (we cannot eyeball these) ──────────────
function pngStats(file) {
  const buf = readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
  const bitDepth = buf[24], colorType = buf[25];
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    return { width, height, unsupported: `bitDepth ${bitDepth} colorType ${colorType}` };
  }
  const bpp = colorType === 6 ? 4 : 3;
  const parts = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    if (type === "IDAT") parts.push(buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * bpp;
  const prev = Buffer.alloc(stride);
  const line = Buffer.alloc(stride);
  const colors = new Map();
  let sampled = 0;
  for (let y = 0, p = 0; y < height; y++) {
    const filter = raw[p++];
    raw.copy(line, 0, p, p + stride);
    p += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = v & 0xff;
    }
    line.copy(prev);
    if (y % 4 === 0) {
      for (let x = 0; x < width; x += 4) {
        const i = x * bpp;
        const key = ((line[i] >> 4) << 8) | ((line[i + 1] >> 4) << 4) | (line[i + 2] >> 4);
        colors.set(key, (colors.get(key) || 0) + 1);
        sampled++;
      }
    }
  }
  const top = Math.max(...colors.values());
  return { width, height, sampled, colors: colors.size, dominant: top / sampled };
}

/**
 * Views whose whole surface is a flat DOM panel rather than a pixel-art canvas
 * or a dense list. They legitimately use a handful of tones: the previously
 * committed office overlays measured 69 and 74 colours, so the bar for "this
 * is not a blank page" sits lower for them.
 */
const FLAT_PANELS = new Set(["office-kanban-dark.png", "office-library-dark.png", "office-hire-dark.png"]);

function verifyShots() {
  const files = [...written].sort();
  console.log("\n[shots] verifying", files.length, "fresh PNGs");
  for (const f of files) {
    const name = path.basename(f);
    let s;
    try { s = pngStats(f); } catch (e) { fail(name, "decode: " + e.message); continue; }
    if (s.unsupported) { fail(name, s.unsupported); continue; }
    const kb = Math.round(statSync(f).size / 1024);
    /*
     * The pixel check is a backstop for "we screenshotted a blank page", not a
     * measure of how busy a view looks: a light theme is a large uniform field
     * with sparse chrome, so several honest views sit near 95% one colour. The
     * real proof that a view rendered is its DOM assertion above (a ledger row,
     * a checkpoint row, the terminal's own output). A genuinely empty page is
     * one tone with a handful of colours.
     */
    const minColors = FLAT_PANELS.has(name) ? 40 : 150;
    const ok = s.width === VW * DSF && s.height === VH * DSF && s.colors >= minColors && s.dominant <= 0.985;
    console.log(`  ${ok ? "ok  " : "BAD "} ${name.padEnd(24)} ${s.width}x${s.height}  ${String(s.colors).padStart(5)} colours  dominant ${(s.dominant * 100).toFixed(1)}%  ${kb}KB`);
    if (!ok) fail(name, `${s.width}x${s.height}, ${s.colors} colours, dominant ${(s.dominant * 100).toFixed(1)}%`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true });
setupDemoProjects();
const { server, token } = await startServer();
try {
  const realViews = ["chat", "single", "trajectory", "terminal", "review", "checkpoints", "git", "workflow", "settings"];
  if (want("workflow")) await seedWorkflow(token);
  if (realViews.some(want)) await captureRealViews(token);
  if (want("office")) await captureOffice();
} finally {
  try { server.kill("SIGTERM"); } catch { /* already gone */ }
  await hold(600);
  for (const f of [DB, `${DB}-shm`, `${DB}-wal`]) rmSync(f, { force: true });
}

verifyShots();
console.log(failures.length ? `\n[shots] ${failures.length} problem(s):\n - ${failures.join("\n - ")}` : "\n[shots] all screenshots captured and verified");
process.exitCode = failures.length ? 1 : 0;
