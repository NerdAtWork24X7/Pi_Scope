#!/usr/bin/env node
/**
 * make-showcase-video.mjs — Record a feature-tour video of Pi Scope.
 *
 *   node docs/make-showcase-video.mjs
 *
 * Spawns the scope server on a fresh DB, seeds the demo (docs/seed-demo.mjs)
 * from inside a scratch project, drives the real UI through every view with
 * caption overlays, records with Playwright, and transcodes the capture to an
 * H.264 MP4.
 *
 * Output: docs/video/Pi-Scope-showcase.mp4   (raw capture kept in tmp/video/)
 *
 * ── Why the scenes navigate by URL ──────────────────────────────────────────
 * Every pane is a plugin, and the shared workspaces rail only renders at boot
 * for a non-chat view. Switching view in place (clicking a nav button) leaves
 * the rail — and so the working directory the panes read — on whatever loaded
 * first, and Single's session list stays empty. Each scene therefore gets a real
 * document load of the view it is about, then selects the scratch workspace in
 * the rail, exactly as `docs/capture-shots.mjs` does.
 *
 * ── It fails loudly ────────────────────────────────────────────────────────
 * A tour is exactly the kind of artifact that can look fine while showing
 * nothing: every scene asserts the content it is about to film (message rows,
 * a diff, terminal output, checkpoint rows) and aborts the recording when it is
 * missing. After the transcode, one frame is sampled from the middle of every
 * scene and decoded — a blank or single-tone frame fails the run.
 *
 * Requires: Node 24+, playwright browsers installed (`npx playwright install
 * chromium`), and a usable ffmpeg (ffmpeg-static, or the one bundled with the
 * playwright browsers).
 */
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 43190;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(ROOT, "tmp", "video-demo.db");
/** Two projects, so the rail looks like a real desk (seed-demo derives the second). */
const DEMO_ROOT = path.join(ROOT, "tmp", "video-demo");
const PROJECT = path.join(DEMO_ROOT, "model-selector");
const SIBLING = path.join(DEMO_ROOT, "model_selector");
const TOKEN_FILE = path.join(ROOT, "tmp", "scope_token");
const OUT_DIR = path.join(ROOT, "tmp", "video");
const FRAME_DIR = path.join(ROOT, "tmp", "video-frames");
const OUT_MP4 = path.join(ROOT, "docs", "video", "Pi-Scope-showcase.mp4");
const VW = 1600, VH = 900;
/** The hero demo session: the coder adding dark mode (see docs/seed-demo.mjs). */
const HERO = "sess-darkmode-9f3a2b";

const log = (...a) => console.log(`[video]`, ...a);
const hold = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── 1. Scratch projects (Files / Checkpoints / Git / Terminal scenes) ──────
function setupScratchRepo() {
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

  // Working tree: one staged file, two unstaged — Git shows both sections and
  // Review has a real diff to open.
  w(PROJECT, "store.py",
    'MODELS = [\n    {"id": "gpt-5"},\n    {"id": "claude-sonnet-4"},\n    {"id": "gemini-3.5-flash"},\n]\n\n\ndef list_models():\n    return sorted(MODELS, key=lambda m: m["id"])\n');
  git("add store.py");
  w(PROJECT, "README.md",
    "# Model Selector\n\nA tiny API that returns a paginated list of models.\n\n## Endpoints\n\n- `GET /models`\n\n## Usage\n\n```bash\ncurl \"http://localhost:8000/models?limit=5&offset=10\"\n```\n");
  w(PROJECT, "tests.log",
    "============================= test session starts =============================\ncollected 12 items\n\ntests/test_store.py ............                                         [100%]\n\n============================== 12 passed in 0.42s ==============================\n");
  w(SIBLING, "README.md", "# Model Selector (worker)\n\nBatch jobs that refresh the model catalog nightly.\n");
  w(SIBLING, "refresh.py", "from store import list_models\n\n\ndef refresh() -> int:\n    return len(list_models())\n");
  log("scratch projects ready:", PROJECT);
}

// ─── 2. Server + seed ───────────────────────────────────────────────────────
async function startServer() {
  for (const f of [DB_PATH, `${DB_PATH}-shm`, `${DB_PATH}-wal`]) rmSync(f, { force: true });
  const server = spawn("node", ["apps/scope-server/server.ts"], {
    cwd: ROOT,
    env: { ...process.env, SCOPE_DB_PATH: DB_PATH },
    stdio: "ignore",
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) { up = true; break; } } catch { /* not up yet */ }
    await hold(250);
  }
  if (!up) throw new Error(`scope server never became healthy on ${BASE}`);
  // seed-demo derives the project from its cwd, so run it inside the scratch repo.
  await new Promise((resolve, reject) =>
    spawn("node", [path.join(ROOT, "docs", "seed-demo.mjs")], {
      cwd: PROJECT, env: { ...process.env, SCOPE_URL: BASE }, stdio: "ignore",
    }).on("exit", (c) => (c === 0 ? resolve() : reject(new Error("seed-demo exited " + c))))
  );
  const token = existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, "utf8").trim() : "";
  if (!token) throw new Error("no auth token at tmp/scope_token");
  log("server up, seeded demo, token", token.slice(0, 8) + "…");
  return { server, token };
}

/** Authenticated JSON call against the running server. */
const call = async (p, init) => {
  const res = await fetch(`${BASE}${p}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
  });
  if (!res.ok) throw new Error(`${p} → HTTP ${res.status}`);
  return res.json();
};
let TOKEN = "";

/**
 * Seed a readable Workflow graph through the plugin's own API — the same
 * actions its canvas sends (see plugins/subagent-workflow/server.ts). Only a
 * harness this machine can actually run is offered, so the video never
 * advertises a CLI that is not installed.
 */
async function seedWorkflow() {
  const enc = encodeURIComponent(PROJECT);
  const act = (body) => call("/subagent-workflow", { method: "POST", body: JSON.stringify({ cwd: PROJECT, ...body }) });

  const { harnesses } = await call("/subagent-workflow/harnesses");
  const usable = harnesses.filter((h) => h.available);
  const runner = usable.find((h) => h.id === "pi") ?? usable[0];
  if (!runner) throw new Error("no available harness to seed the workflow with");
  const model = (runner.models ?? [])[0] ?? "";
  log(`workflow: harness ${runner.id}${model ? `, model ${model}` : ""}`);

  await act({ action: "setWorkflowName", name: "Model Selector CI" });
  const snap = await call(`/subagent-workflow?cwd=${enc}`);
  const start = snap.nodes.find((n) => n.type === "start");
  const end = snap.nodes.find((n) => n.type === "end");
  const planner = snap.nodes.find((n) => n.type === "agent");
  if (!start || !end || !planner) throw new Error("the workflow seed graph is not the expected start/agent/end");

  const agent = (prompt) => ({ harness: runner.id, model, prompt });
  await act({ action: "updateNode", id: planner.id, name: "planner", config: agent("Read the task and write a short implementation plan.") });
  await act({ action: "moveNode", id: planner.id, x: 380, y: 210 });

  const builder = (await act({ action: "addNode", type: "agent", x: 700, y: 90 })).nodes.at(-1);
  await act({ action: "updateNode", id: builder.id, name: "builder", config: agent("Implement the plan: limit/offset plus a total count.") });
  const tester = (await act({ action: "addNode", type: "agent", x: 700, y: 330 })).nodes.at(-1);
  await act({ action: "updateNode", id: tester.id, name: "tester", config: agent("Cover the new endpoint and report failures.") });

  const gate = (await act({ action: "addNode", type: "approval", x: 990, y: 210 })).nodes.at(-1);
  await act({ action: "updateNode", id: gate.id, name: "review", config: { description: "Human gate", message: "Review the plan and the diff before it is committed." } });

  for (const e of snap.edges) await act({ action: "removeEdge", id: e.id });
  for (const [from, to] of [
    [start.id, planner.id], [planner.id, builder.id], [planner.id, tester.id],
    [builder.id, gate.id], [tester.id, gate.id], [gate.id, end.id],
  ]) await act({ action: "addEdge", from, to });

  const after = await call(`/subagent-workflow?cwd=${enc}`);
  log(`workflow: ${after.nodes.length} nodes, ${after.edges.length} connections, "${after.name}"`);
}

// ─── 3. Caption overlay (injected before page scripts) ──────────────────────
const CAPTION_SCRIPT = `(() => {
  // Boot prefs: dark theme + chat rails open + chat view (a fresh profile
  // defaults to light with both rails folded, which looks bare on camera).
  try {
    localStorage.setItem("scope-theme", "dark");
    localStorage.setItem("scope-chat-rail-left", "open");
    localStorage.setItem("scope-chat-rail-right", "open");
    localStorage.setItem("scope-view", "chat");
  } catch {}
  const boot = () => {
    const style = document.createElement("style");
    style.textContent = \`
      #vid-caption{position:fixed;left:26px;bottom:26px;z-index:2147483647;display:flex;flex-direction:column;gap:3px;
        background:rgba(8,11,18,.78);border:1px solid rgba(56,189,248,.35);border-radius:12px;padding:10px 16px;
        backdrop-filter:blur(10px);opacity:0;transform:translateY(8px);transition:opacity .35s ease,transform .35s ease;
        font-family:'MesloLGS NFM',ui-monospace,monospace;pointer-events:none;max-width:70vw}
      #vid-caption.show{opacity:1;transform:translateY(0)}
      #vid-caption .vid-kicker{font-size:10px;letter-spacing:.22em;color:#38bdf8;text-transform:uppercase}
      #vid-caption .vid-text{font-size:21px;color:#f8fafc;line-height:1.25}
    \`;
    document.documentElement.appendChild(style);
    const cap = document.createElement("div");
    cap.id = "vid-caption";
    cap.innerHTML = '<span class="vid-kicker">Pi&nbsp;Scope</span><span class="vid-text"></span>';
    document.documentElement.appendChild(cap);
    window.__setCaption = (t) => {
      const el = document.getElementById("vid-caption");
      if (!el) return;
      el.querySelector(".vid-text").textContent = t || "";
      el.classList.toggle("show", !!t);
    };
  };
  // addInitScript can fire before the document tree exists — wait for it.
  if (document.readyState !== "loading") boot();
  else document.addEventListener("DOMContentLoaded", boot, { once: true });
})();`;

// ─── 4. Recording walkthrough ───────────────────────────────────────────────
/** Scene marks: what was on screen when, so a frame can be sampled per scene. */
const scenes = [];

async function record(token) {
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const context = await browser.newContext({
    viewport: { width: VW, height: VH },
    colorScheme: "dark",
    recordVideo: { dir: OUT_DIR, size: { width: VW, height: VH } },
  });
  await context.addInitScript(CAPTION_SCRIPT);
  const page = await context.newPage();
  const t0 = Date.now();

  /** A scene window, for the post-record frame check. */
  const scene = (label) => {
    scenes.push({ label, start: Date.now() - t0, end: null });
    log(`  scene ${String(scenes.length).padStart(2)} · ${label} (t+${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  };
  const endScene = () => { if (scenes.length) scenes.at(-1).end = Date.now() - t0; };

  /** Parked on the app after an error: say what was actually on screen. */
  const diagnose = async () => {
    const state = await page.evaluate(() => ({
      hash: location.hash,
      view: document.querySelector(".view-btn.active, .header-icon-btn.active")?.id || "?",
      ws: [...document.querySelectorAll("#sidebar-rail .chat-ws, #chat-workspace-rail .chat-ws")].map((e) => (e.dataset.cwd || "").split("/").pop()),
      sess: [...document.querySelectorAll(".ws-sess")].map((e) => e.dataset.sid),
      rows: { events: document.querySelectorAll(".evt-row").length, traj: document.querySelectorAll(".traj-row").length, files: document.querySelectorAll(".file-item").length, commits: document.querySelectorAll(".git-commit-row").length, nodes: document.querySelectorAll("#sw-canvas .sw-node").length },
      text: (document.querySelector(".pane:not([style*='display: none'])")?.innerText || "").replace(/\s+/g, " ").slice(0, 120),
    })).catch(() => null);
    if (state) console.error("[video]   state:", JSON.stringify(state));
  };
  /** Assert a selector is present; abort the take if the pane is not rendering. */
  const need = async (what, sel, ms = 20000) => {
    try { await page.waitForSelector(sel, { timeout: ms }); }
    catch {
      await diagnose();
      throw new Error(`${what}: never appeared (${sel})`);
    }
  };
  const clickIf = async (sel, ms = 4000) => {
    try { await page.locator(sel).first().click({ timeout: ms }); return true; } catch { return false; }
  };
  const caption = async (t) => {
    await page.waitForFunction(() => typeof window.__setCaption === "function", null, { timeout: 10000 }).catch(() => {});
    await page.evaluate((x) => window.__setCaption(x), t).catch(() => {});
  };
  /**
   * Each view gets a real document load: the workspaces rail only renders at
   * boot for a non-chat view, and a hash-only navigation is a same-document
   * navigation the app does not re-route. The query param forces the reload.
   */
  const openView = async (view, railSel = "#sidebar-rail") => {
    await page.goto(`${BASE}/?token=${encodeURIComponent(token)}&v=${view}#view=${view}`, { waitUntil: "domcontentloaded" });
    if (railSel) await need(view, `${railSel} .chat-ws`, 30000).then(() => {}, () => {});
    await hold(600);
    return railSel;
  };
  const selectWorkspace = async (view, railSel = "#sidebar-rail") => {
    if (await clickIf(`${railSel} .chat-ws[data-cwd="${PROJECT}"]`, 5000)) { await hold(700); return; }
    if (await clickIf(`${railSel} [data-cwd="${PROJECT}"]`, 5000)) { await hold(700); return; }
    throw new Error(`${view}: the scratch workspace is not in the rail`);
  };
  /**
   * The panes carry the working directory they are scanning. Filming this
   * checkout instead of the scratch project would look identical on camera, so
   * the panes that show it are asserted: the tour must be about the demo.
   */
  const assertCwd = async (view, sel) => {
    await need(view, sel, 20000);
    const shown = (await page.locator(sel).first().textContent() || "").trim();
    if (shown !== PROJECT) {
      throw new Error(`${view}: pane is on "${shown}", not the scratch project (${PROJECT})`);
    }
  };
  const selectSession = async (view, railSel = "#sidebar-rail") => {
    const row = page.locator(`${railSel} .ws-sess[data-sid="${HERO}"]`);
    if (await row.count() && await row.first().isVisible()) { await row.first().click().catch(() => {}); return; }
    const any = page.locator(`${railSel} .ws-sess:visible`);
    if (await any.count()) { await any.first().click().catch(() => {}); return; }
    throw new Error(`${view}: no session rows in the rail`);
  };
  const scroll = (sel, top) =>
    page.evaluate(([s, t]) => { const el = document.querySelector(s); if (el) el.scrollTo({ top: t, behavior: "smooth" }); }, [sel, top]);

  // ── Scene 1 · Chat (the opening caption plays over this view too) ────────
  scene("chat");
  log("opening the dashboard…");
  await page.goto(`${BASE}/?token=${encodeURIComponent(token)}`, { waitUntil: "domcontentloaded" });
  const chatRail = "#chat-workspace-rail";
  await need("chat", `${chatRail} .chat-ws`, 30000);
  await selectWorkspace("chat", chatRail);
  await selectSession("chat", chatRail);
  await need("chat", "#chat-messages .chat-msg", 20000);
  await caption("Watch your AI coding agent think, type & act");
  await hold(4500);
  await caption("Chat — talk to your agent like a teammate");
  await hold(1600);
  await scroll("#chat-messages", 500);
  await hold(2200);
  await scroll("#chat-messages", 0);
  await hold(1200);
  endScene();

  // ── Scene 2 · Single timeline ───────────────────────────────────────────
  scene("single");
  await caption("Single — every message, tool call & command, live");
  await openView("single");
  await selectWorkspace("single");
  await selectSession("single");
  await need("single", "#event-view .evt-row", 25000);
  await hold(1600);
  await page.locator("#event-view .evt-row", { hasText: "tool call" }).first().click().catch(() => {});
  await hold(1200);
  await page.locator("#event-view .evt-row", { hasText: "assistant" }).first().click().catch(() => {});
  await need("single stats", "#session-subnav .snav-stats", 20000).catch(() => {});
  await hold(2000);
  await caption("Exact LLM request — system prompt, tools, thinking budget");
  await clickIf("#btn-sysprompt", 5000);
  await need("system prompt", "#sp-overlay.show", 12000);
  await hold(2200);
  await scroll("#sp-body", 500);
  await hold(1800);
  await clickIf("#sp-close", 5000);
  await hold(900);
  endScene();

  // ── Scene 3 · Trajectory ────────────────────────────────────────────────
  scene("trajectory");
  await caption("Trajectory — where did the time go?");
  await openView("trajectory");
  await selectWorkspace("trajectory");
  await need("trajectory", "#trajectory-ledger .traj-row", 25000);
  await hold(2200);
  await page.locator("#trajectory-ledger .traj-row:not(.traj-colhead)").first().click().catch(() => {});
  await need("trajectory inspector", "#trajectory-inspector:not([aria-hidden='true'])", 12000);
  await hold(3000);
  await clickIf("#trajectory-inspector-close", 5000);
  await hold(900);
  endScene();

  // ── Scene 4 · Terminal ──────────────────────────────────────────────────
  scene("terminal");
  await caption("Terminal — a real shell, in your browser");
  await openView("terminal");
  await selectWorkspace("terminal");
  await clickIf("#btn-bash", 8000);
  await need("terminal", ".xterm", 25000);
  await hold(2000);
  await page.locator(".xterm").first().click({ position: { x: 300, y: 120 } }).catch(() => {});
  // Selecting a workspace does not cd the shell, so cd explicitly.
  for (const cmd of [`cd ${PROJECT}`, "clear", "git log --oneline -3", "git status -s", "ls -1"]) {
    await page.keyboard.type(cmd);
    await hold(260);
    await page.keyboard.press("Enter");
    await hold(1100);
  }
  await caption("The shell's cwd drives the Files, Checkpoints & Git panes");
  await hold(2400);
  const termText = await page.evaluate(() => document.querySelector(".xterm-rows")?.innerText || "");
  if (!/Add pagination/.test(termText)) {
    throw new Error(`terminal: output does not show the demo repo (saw: ${termText.replace(/\s+/g, " ").slice(0, 80)})`);
  }
  endScene();

  // ── Scene 5 · Review (Files) ────────────────────────────────────────────
  scene("review");
  await caption("Review — read & fix every change");
  await openView("files");
  await selectWorkspace("files");
  await assertCwd("review", "#files-cwd-label");
  /*
   * The pane opens on the module diagram, with the changed-file list folded
   * away and the diff pane display:none. Review is the list plus the diff, so
   * put it back into that layout first.
   */
  const filesState = await page.evaluate(() => ({
    listHidden: document.getElementById("files-list")?.classList.contains("hidden") ?? false,
    diffHidden: getComputedStyle(document.getElementById("files-diff")).display === "none",
  }));
  if (filesState.listHidden) await clickIf("#btn-files-toggle", 6000);
  if (filesState.diffHidden) await clickIf("#btn-files-diagram", 6000);
  await hold(900);
  await need("review", "#files-list .file-item", 25000);
  await hold(1200);
  await page.locator("#files-list .file-item", { hasText: "README.md" }).first().click().catch(() => {});
  await need("review diff", "#diff-old-lines .dline, #diff-new-lines .dline", 20000);
  await hold(2000);
  await scroll("#files-diff", 700);
  await hold(2600);
  endScene();

  // ── Scene 6 · Git ───────────────────────────────────────────────────────
  scene("git");
  await caption("Git — a full client, no terminal needed");
  await openView("git");
  await selectWorkspace("git");
  await assertCwd("git", "#git-cwd-label");
  await need("git", ".git-tab[data-tab='history']", 25000);
  await clickIf(".git-tab[data-tab='history']");
  await need("git history", ".git-commit-row", 20000);
  await hold(1600);
  await page.locator(".git-commit-row").first().click().catch(() => {});
  await need("git commit detail", ".git-detail-row", 12000);
  await hold(3000);
  await clickIf(".git-tab[data-tab='changes']");
  await need("git changes", "#git-tab-changes:not([hidden])", 12000);
  await hold(2600);
  await clickIf(".git-tab[data-tab='branches']");
  await need("git branches", ".git-branch-item", 15000);
  await hold(2400);
  endScene();

  // ── Scene 7 · Workflow ──────────────────────────────────────────────────
  scene("workflow");
  await caption("Workflow — wire a team of agents into one DAG");
  await openView("subagent-workflow");
  await selectWorkspace("subagent-workflow");
  await need("workflow", "#sw-canvas .sw-node", 25000);
  const nodeCount = await page.locator("#sw-canvas .sw-node").count();
  if (nodeCount < 6) throw new Error(`workflow: expected the seeded graph, saw ${nodeCount} nodes`);
  await hold(2000);
  await page.locator("#sw-canvas .sw-node", { hasText: "planner" }).first().click().catch(() => {});
  await hold(1800);
  await caption("Fan out to builder & tester · a human gate before the end");
  await page.locator("#sw-canvas .sw-node", { hasText: "review" }).first().click().catch(() => {});
  await hold(2600);
  await caption("Every node picks its own harness, model, prompt & reference files");
  await clickIf("#sw-history", 5000);
  await hold(2400);
  endScene();

  // ── Scene 8 · Checkpoints (before Settings; creating one commits the tree) ─
  scene("checkpoints");
  await caption("Checkpoints — a save button for your agent");
  await openView("checkpoints");
  await selectWorkspace("checkpoints");
  await assertCwd("checkpoints", "#checkpoints-cwd-label");
  await need("checkpoints", "#btn-checkpoints-create", 25000);
  await hold(1400);
  await page.locator("#checkpoints-label").fill("before the pagination refactor").catch(() => {});
  await hold(900);
  await clickIf("#btn-checkpoints-create", 6000);
  await page.waitForFunction(
    () => /created|checkpoint/i.test(document.querySelector("#checkpoints-status")?.textContent || ""),
    null, { timeout: 15000 },
  ).catch(() => {});
  await need("checkpoints list", "#checkpoints-list .checkpoint-item, #checkpoints-list [class*='chk']", 20000);
  await hold(3200);
  endScene();

  // ── Scene 9 · Settings ──────────────────────────────────────────────────
  scene("settings");
  await caption("Settings — the whole agent, configured from the browser");
  await openView("settings", null);
  await need("settings", ".settings-group", 30000);
  await hold(1600);
  await page.evaluate(() => {
    const el = document.querySelector("#settings-pane") || document.scrollingElement;
    el.scrollTo({ top: 700, behavior: "smooth" });
  }).catch(() => {});
  await hold(2600);
  await page.evaluate(() => {
    const el = document.querySelector("#settings-pane") || document.scrollingElement;
    el.scrollTo({ top: 0, behavior: "smooth" });
  }).catch(() => {});
  await hold(1400);
  endScene();

  // ── Outro ───────────────────────────────────────────────────────────────
  scene("outro");
  await openView("chat", chatRail);
  await need("outro", `${chatRail} .chat-ws`, 20000);
  await selectWorkspace("chat", chatRail);
  await hold(1500);
  await caption("Private by default — no account. Nothing leaves your machine.");
  await hold(3600);
  await caption("github.com/NerdAtWork24X7/Pi_Scope");
  await hold(4400);
  await caption("");
  await hold(600);
  endScene();

  await context.close();
  await browser.close();
  log(`recorded ${scenes.length} scenes, ${((Date.now() - t0) / 1000).toFixed(0)}s of footage`);
}

// ─── 5. Transcode webm → mp4 with the playwright-bundled ffmpeg ────────────
function findFfmpeg() {
  // Prefer ffmpeg-static (a full build with libx264); fall back to the minimal
  // playwright-bundled ffmpeg if ffmpeg-static is unavailable.
  try {
    const p = execSync(`node -p "require('ffmpeg-static')"`).toString().trim();
    if (p && existsSync(p)) return p;
  } catch { /* not installed */ }
  const browsersDir = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), ".cache", "ms-playwright");
  const found = execSync(`find "${browsersDir}" -maxdepth 2 -name 'ffmpeg-linux*' 2>/dev/null | head -1`).toString().trim();
  return found || "";
}

function transcode(ffmpeg) {
  const webm = execSync(`find "${OUT_DIR}" -name '*.webm' -printf '%T@ %p\\n' | sort -rn | head -1 | cut -d' ' -f2-`).toString().trim();
  if (!webm) throw new Error("no webm capture found under " + OUT_DIR);
  log("transcoding", path.basename(webm), "→", path.basename(OUT_MP4));
  mkdirSync(path.dirname(OUT_MP4), { recursive: true });
  const encoders = execSync(`"${ffmpeg}" -hide_banner -encoders 2>&1 | grep -i 'libx264' || true`).toString();
  const vcodec = encoders.includes("libx264") ? "libx264" : "mpeg4";
  const preset = vcodec === "libx264" ? "-preset medium -crf 19" : "-q:v 3";
  execSync(`"${ffmpeg}" -y -hide_banner -loglevel error -i "${webm}" -c:v ${vcodec} ${preset} -pix_fmt yuv420p -an -movflags +faststart "${OUT_MP4}"`);
  log("wrote", OUT_MP4, `(${(statSync(OUT_MP4).size / 1024 / 1024).toFixed(1)} MB)`);
}

// ─── 6. Verify the MP4: decode it whole, then a frame per scene ────────────
/** Colour-variety stats for a PNG (zlib only — no image deps). */
function pngStats(file) {
  const buf = readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
  const bitDepth = buf[24], colorType = buf[25];
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) throw new Error(`bitDepth ${bitDepth} colorType ${colorType}`);
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
  let sampled = 0, lum = 0;
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
        lum += line[i] * 0.299 + line[i + 1] * 0.587 + line[i + 2] * 0.114;
        sampled++;
      }
    }
  }
  const top = Math.max(...colors.values());
  return { width, height, sampled, colors: colors.size, dominant: top / sampled, meanLum: lum / sampled };
}

function verifyVideo(ffmpeg) {
  const problems = [];
  log("\nverifying", path.basename(OUT_MP4));
  // 1. Decode the whole file: a truncated or corrupt stream fails here.
  const probe = execSync(`"${ffmpeg}" -hide_banner -i "${OUT_MP4}" 2>&1 || true`).toString();
  const dur = probe.match(/Duration: (\d+):(\d\d):(\d\d)\.(\d+)/);
  const seconds = dur ? (+dur[1]) * 3600 + (+dur[2]) * 60 + (+dur[3]) + (+dur[4]) / 100 : 0;
  const stream = (probe.match(/Stream #\d+:\d+.*/) || [""])[0].trim();
  console.log(`  duration ${seconds.toFixed(1)}s   ${stream.replace(/\s+/g, " ").slice(0, 110)}`);
  if (!/Video: h264/.test(stream)) problems.push(`video stream is not H.264: ${stream}`);
  if (!/1600x900/.test(stream)) problems.push(`video is not 1600x900: ${stream}`);
  if (seconds < 60) problems.push(`only ${seconds.toFixed(1)}s of footage — the tour should be longer`);
  try {
    execSync(`"${ffmpeg}" -v error -i "${OUT_MP4}" -f null -`);
  } catch (e) {
    problems.push("the MP4 does not decode cleanly: " + String(e.stderr || e.message).slice(0, 200));
  }

  // 2. One frame from the middle of every scene: no scene may be blank.
  rmSync(FRAME_DIR, { recursive: true, force: true });
  mkdirSync(FRAME_DIR, { recursive: true });
  const total = (scenes.at(-1)?.end ?? 0) / 1000;
  for (const s of scenes) {
    const end = s.end ?? total * 1000;
    const mid = ((s.start + end) / 2) / 1000;
    // The recording's clock starts a little after the page does; clamp inside.
    const at = Math.max(0.2, Math.min(mid * (seconds / Math.max(total, 1)), seconds - 0.2));
    const png = path.join(FRAME_DIR, `${s.label}.png`);
    execSync(`"${ffmpeg}" -y -v error -ss ${at.toFixed(2)} -i "${OUT_MP4}" -frames:v 1 "${png}"`);
    const st = pngStats(png);
    const kb = Math.round(statSync(png).size / 1024);
    const blank = st.colors < 150 || st.dominant > 0.985 || st.meanLum < 6;
    console.log(`  ${blank ? "BLANK" : "ok   "} ${s.label.padEnd(12)} @${at.toFixed(1)}s  ${st.colors} colours  dominant ${(st.dominant * 100).toFixed(1)}%  lum ${st.meanLum.toFixed(1)}  ${kb}KB`);
    if (blank) problems.push(`scene ${s.label} is a blank frame at ${at.toFixed(1)}s`);
  }
  return problems;
}

// ─── Main ───────────────────────────────────────────────────────────────────
const ffmpeg = findFfmpeg();
if (!ffmpeg) throw new Error("no usable ffmpeg found (install with: npm i -D ffmpeg-static)");
setupScratchRepo();
const { server, token } = await startServer();
TOKEN = token;
try {
  await seedWorkflow();
  await record(token);
  transcode(ffmpeg);
} finally {
  try { server.kill("SIGTERM"); } catch { /* already gone */ }
  await hold(800);
  for (const f of [DB_PATH, `${DB_PATH}-shm`, `${DB_PATH}-wal`]) rmSync(f, { force: true });
}

const problems = verifyVideo(ffmpeg);
if (problems.length) {
  console.error(`\n[video] ${problems.length} problem(s):\n - ${problems.join("\n - ")}`);
  process.exit(1);
}
console.log("\n[video] recorded and verified →", path.relative(ROOT, OUT_MP4));
