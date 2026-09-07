#!/usr/bin/env node
/**
 * make-showcase-video.mjs — Record a feature-tour video of Pi Scope.
 *
 * Spawns the scope server on a fresh DB, seeds the demo sessions, drives the
 * real UI through every view (with caption overlays), records with Playwright,
 * and transcodes the capture to an X-ready H.264 MP4.
 *
 *   node docs/make-showcase-video.mjs
 *
 * Output: docs/video/Pi-Scope-showcase.mp4  (raw capture kept in tmp/video/)
 *
 * Requires: Node 24+, playwright browsers installed (`npx playwright install
 * chromium`), and a bundled playwright ffmpeg (installed alongside browsers).
 */
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 43190;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(ROOT, "tmp", "video-demo.db");
const SCRATCH = path.join(ROOT, "tmp", "video-demo");
const TOKEN_FILE = path.join(ROOT, "tmp", "scope_token");
const OUT_DIR = path.join(ROOT, "tmp", "video");
const OUT_MP4 = path.join(ROOT, "docs", "video", "Pi-Scope-showcase.mp4");
const VW = 1600, VH = 900;

const log = (...a) => console.log(`[video]`, ...a);
const hold = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── 1. Scratch git repo (Files / Checkpoints / Git scenes) ────────────────
function setupScratchRepo() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(path.join(SCRATCH, "README.md"),
    "# Model Selector\n\nA tiny API that returns a paginated list of models.\n\n## Endpoints\n\n- GET /models\n");
  writeFileSync(path.join(SCRATCH, "api.py"),
    'from fastapi import APIRouter, Query\n\nrouter = APIRouter()\n\n@router.get("/models")\nasync def get_models():\n    return {"models": list_models()}\n');
  const git = (args) => execSync(`git ${args}`, { cwd: SCRATCH, stdio: "pipe" });
  git("init -q -b main");
  git('config user.email "demo@pi-scope.local"');
  git('config user.name "Demo Bot"');
  git('add -A && git commit -qm "Initial commit: model selector API"');
  writeFileSync(path.join(SCRATCH, "api.py"),
    'from fastapi import APIRouter, Query\nfrom .store import list_models\n\nrouter = APIRouter()\n\n@router.get("/models")\nasync def get_models(limit: int = Query(20, ge=1, le=100), offset: int = Query(0, ge=0)):\n    all_models = list_models()\n    return {"models": all_models[offset:offset + limit], "total": len(all_models)}\n');
  git('add -A && git commit -qm "Add pagination: limit/offset params + total count"');
  writeFileSync(path.join(SCRATCH, "tests.log"), "ALL TESTS PASSED\n");
  writeFileSync(path.join(SCRATCH, "README.md"),
    "# Model Selector\n\nA tiny API that returns a paginated list of models.\n\n## Endpoints\n\n- GET /models\n\n## Usage\n\ncurl \"http://localhost:8000/models?limit=5&offset=10\"\n");
  git("checkout -qb feature/dark-mode");
  log("scratch repo ready:", SCRATCH);
}

// ─── 2. Server + seed ───────────────────────────────────────────────────────
async function startServer() {
  try { execSync("pkill -f 'apps/scope/server.ts' || true"); } catch {}
  rmSync(DB_PATH, { force: true });
  const server = spawn("node", ["apps/scope/server.ts"], {
    cwd: ROOT,
    env: { ...process.env, SCOPE_DB_PATH: DB_PATH },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) break;
    } catch {}
    await hold(250);
  }
  execSync("node docs/seed-demo.mjs", { cwd: ROOT, stdio: "inherit" });
  const token = existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, "utf8").trim() : "";
  log("server up, token:", token.slice(0, 8) + "…");
  return { server, token };
}

// ─── 3. Caption overlay (injected before page scripts) ─────────────────────
const CAPTION_SCRIPT = `(() => {
  // Boot prefs: dark theme + chat rails open + chat view (fresh profile default
  // is light theme with both rails folded, which looks bare on camera).
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

  const caption = (t) => page.evaluate((x) => window.__setCaption(x), t);
  const wait = (sel, ms = 12000) => page.waitForSelector(sel, { timeout: ms });
  const click = async (sel, ms = 8000) => { await wait(sel, ms); await page.locator(sel).first().click(); };
  const clickIf = async (sel, ms = 2500) => {
    try { await wait(sel, ms); await page.locator(sel).first().click(); return true; } catch { return false; }
  };
  const scroll = (sel, top) =>
    page.evaluate(([s, t]) => { const el = document.querySelector(s); if (el) el.scrollTo({ top: t, behavior: "smooth" }); }, [sel, top]);

  log("opening dashboard…");
  await page.goto(`${BASE}/?token=${encodeURIComponent(token)}`, { waitUntil: "domcontentloaded" });

  // Boot: wait for the seeded sessions to land in the Chat view.
  await wait("#chat-workspaces .chat-ws", 20000);
  await wait("#chat-workspaces .ws-sess", 20000);
  caption("Watch your AI coding agent think, type & act");
  await hold(4500);

  // ── Scene 1 · Chat ──────────────────────────────────────────────────────
  caption("Chat — talk to your agent like a teammate");
  await hold(1800);
  // Open the Pi_Scope workspace, then its "coder" session.
  await page.locator(".chat-ws", { hasText: "Pi_Scope" }).first().click({ timeout: 6000 }).catch(() => {});
  await page.locator('.chat-ws[data-cwd*="Pi_Scope"] .chat-ws-caret').first().click({ timeout: 3000 }).catch(() => {});
  await click('#chat-workspaces .ws-sess[data-sid="sess-darkmode-9f3a2b"]', 6000).catch(() => {});
  await wait("#chat-messages .chat-msg", 8000).catch(() => {});
  await hold(2500);
  scroll("#chat-messages", 400);
  await hold(2000);

  // ── Scene 2 · Single timeline ────────────────────────────────────────────
  caption("Single — every message, tool call & command, live");
  await click("#btn-single");
  // Session groups start collapsed — open the Pi_Scope group first.
  await wait(".session-group-head");
  await page.locator(".session-group-head", { hasText: "Pi_Scope" }).first().click({ timeout: 4000 }).catch(() => {});
  await wait('#session-list .session-item[data-sid="sess-darkmode-9f3a2b"]');
  await click('#session-list .session-item[data-sid="sess-darkmode-9f3a2b"]');
  await wait("#event-view .evt-row");
  await hold(1500);
  await wait("#session-subnav .snav-stats", 8000).catch(() => {});
  scroll("#event-view", 0);
  await hold(1800);
  // Expand a tool call, then a thinking row.
  await page.locator("#event-view .evt-row", { hasText: "tool call" }).first().click().catch(() => {});
  await hold(1200);
  await page.locator("#event-view .evt-row", { hasText: "thinking" }).first().click().catch(() => {});
  await hold(1500);
  // System prompt overlay — the exact request sent to the model.
  caption("Exact LLM request — system prompt, tools, thinking budget");
  await click("#btn-sysprompt", 4000);
  await wait("#sp-overlay.show", 5000).catch(() => {});
  await hold(2600);
  scroll("#sp-body", 500);
  await hold(1600);
  await click("#sp-close", 3000).catch(() => {});
  await hold(800);
  caption("Single — every message, tool call & command, live");
  await hold(1200);

  // ── Scene 3 · Trajectory ─────────────────────────────────────────────────
  caption("Trajectory — where did the time go?");
  await click("#btn-trajectory");
  await wait("#trajectory-ledger .traj-row");
  await hold(2000);
  await page.locator("#trajectory-ledger .traj-row:not(.traj-colhead)").first().click().catch(() => {});
  await wait("#trajectory-inspector:not([aria-hidden='true'])", 5000).catch(() => {});
  await hold(3200);
  await page.locator("#trajectory-inspector-close").click().catch(() => {});
  await hold(800);

  // ── Scene 4 · Terminal ───────────────────────────────────────────────────
  caption("Terminal — a real shell, in your browser");
  await click("#btn-terminal");
  await click("#btn-bash", 5000);
  await wait(".xterm", 12000);
  await hold(2200);
  await page.locator(".xterm").first().click({ position: { x: 300, y: 120 } }).catch(() => {});
  await page.keyboard.type("cd tmp/video-demo && ls");
  await hold(400);
  await page.keyboard.press("Enter");
  await hold(2600);
  await page.keyboard.type("git log --oneline");
  await hold(400);
  await page.keyboard.press("Enter");
  await hold(2600);
  caption("The shell's cwd drives the Files, Checkpoints & Git panes");
  await hold(2200);

  // ── Scene 5 · Review (Files) ─────────────────────────────────────────────
  caption("Review — read & fix every change");
  await click("#btn-files");
  await wait(".file-item", 10000);
  await hold(1800);
  await page.locator(".file-item", { hasText: "README.md" }).first().click().catch(() => {});
  await hold(2600);
  scroll("#files-diff", 600).catch(() => {});
  await hold(2600);

  // ── Scene 6 · Checkpoints ────────────────────────────────────────────────
  caption("Checkpoints — a save button for your agent");
  await click("#btn-checkpoints");
  await wait("#btn-checkpoints-create", 10000);
  await hold(1500);
  await page.locator("#checkpoints-label").fill("before dark-mode refactor");
  await click("#btn-checkpoints-create");
  await page.waitForFunction(() => /created/.test(document.querySelector("#checkpoints-status")?.textContent || ""), null, { timeout: 8000 }).catch(() => {});
  await wait("#checkpoints-list .chk-item, #checkpoints-list [class*='chk']", 5000).catch(() => {});
  await hold(3400);

  // ── Scene 7 · Git ────────────────────────────────────────────────────────
  caption("Git — a full client, no terminal needed");
  await click("#btn-git");
  await wait(".git-tab[data-tab='history']");
  await click(".git-tab[data-tab='history']");
  await wait(".git-commit-row", 10000);
  await hold(1800);
  await page.locator(".git-commit-row").first().click().catch(() => {});
  await wait(".git-detail-row", 5000).catch(() => {});
  await hold(3200);
  await click(".git-tab[data-tab='branches']");
  await wait(".git-branch-item", 6000).catch(() => {});
  await hold(2600);

  // ── Scene 8 · Settings ───────────────────────────────────────────────────
  caption("Settings — the whole agent, configured from the browser");
  await click("#btn-settings");
  await wait(".settings-panel, .settings-group", 10000);
  await hold(1600);
  await page.evaluate(() => {
    const el = document.querySelector("#settings-pane") || document.scrollingElement;
    el.scrollTo({ top: 700, behavior: "smooth" });
  }).catch(() => {});
  await hold(2800);
  await page.evaluate(() => {
    const el = document.querySelector("#settings-pane") || document.scrollingElement;
    el.scrollTo({ top: 0, behavior: "smooth" });
  }).catch(() => {});
  await hold(1200);

  // ── Outro ────────────────────────────────────────────────────────────────
  await click("#btn-chat");
  await wait("#chat-workspaces .chat-ws", 8000).catch(() => {});
  await hold(800);
  caption("Private by default — no account. Nothing leaves your machine.");
  await hold(3600);
  caption("github.com/NerdAtWork24X7/Pi_Scope");
  await hold(4400);
  caption("");

  await hold(600);
  await context.close();
  await browser.close();
}

// ─── 5. Transcode webm → mp4 with the playwright-bundled ffmpeg ────────────
async function transcode() {
  // Prefer ffmpeg-static (full build with libx264); fall back to the minimal
  // playwright-bundled ffmpeg if ffmpeg-static is unavailable.
  let ffmpeg = "";
  try { ffmpeg = execSync(`node -p "require('ffmpeg-static')"`).toString().trim(); } catch {}
  if (!ffmpeg) {
    const browsersDir = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), ".cache", "ms-playwright");
    ffmpeg = execSync(`find "${browsersDir}" -maxdepth 2 -name 'ffmpeg-linux' 2>/dev/null | head -1`)
      .toString().trim();
  }
  if (!ffmpeg) throw new Error("no usable ffmpeg found (install with: npm i -D ffmpeg-static)");
  const webm = execSync(`find "${OUT_DIR}" -name '*.webm' -printf '%T@ %p\\n' | sort -rn | head -1 | cut -d' ' -f2-`).toString().trim();
  if (!webm) throw new Error("no webm capture found under " + OUT_DIR);
  log("transcoding", path.basename(webm), "→", path.basename(OUT_MP4));
  mkdirSync(path.dirname(OUT_MP4), { recursive: true });
  const encoders = execSync(`"${ffmpeg}" -hide_banner -encoders 2>&1 | grep -i 'libx264' || true`).toString();
  const vcodec = encoders.includes("libx264") ? "libx264" : "mpeg4";
  const preset = vcodec === "libx264" ? "-preset medium -crf 19" : "-q:v 3";
  execSync(`"${ffmpeg}" -y -hide_banner -loglevel error -i "${webm}" -c:v ${vcodec} ${preset} -pix_fmt yuv420p -an -movflags +faststart "${OUT_MP4}"`);
  const size = (await import("node:fs/promises")).stat(OUT_MP4).then((s) => (s.size / 1024 / 1024).toFixed(1));
  log("done →", OUT_MP4, `(${await size} MB)`);
}

// ─── Main ───────────────────────────────────────────────────────────────────
const { server, token } = await startServer();
try {
  setupScratchRepo();
  await record(token);
  await transcode();
} finally {
  try { server.kill("SIGTERM"); } catch {}
  await hold(800);
  rmSync(DB_PATH, { force: true });
}