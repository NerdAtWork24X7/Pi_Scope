import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 43997;
const TOKEN = "tok";
const BASE = `http://127.0.0.1:${PORT}`;
const DB = "/home/alexa/wk/Pi_Scope/db/scope.db";
const repoRoot = "/home/alexa/wk/Pi_Scope";

const srv = spawn("node", ["server.ts"], {
  cwd: `${repoRoot}/apps/scope`,
  env: { ...process.env, SCOPE_PORT: String(PORT), SCOPE_HOST: "127.0.0.1", SCOPE_DB_PATH: DB, SCOPE_AUTH_TOKEN: TOKEN, SCOPE_FILE_ROOT: repoRoot },
  stdio: ["ignore", "pipe", "pipe"],
});
srv.stdout.on("data", () => {}); srv.stderr.on("data", () => {});
for (;;) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await sleep(250); }

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => { try { localStorage.setItem("scope-cwd", "/home/alexa/wk/WMS_System"); } catch {} });
const page = await context.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE-ERR", m.text()); });
page.on("response", (r) => { if (r.status() >= 400) console.log("HTTP", r.status(), r.url()); });
await page.goto(`${BASE}/?token=${TOKEN}#view=trajectory`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__SCOPE_STATE?.sessionsLoaded === true, null, { timeout: 15000 });
await sleep(3000);

console.log(JSON.stringify(await page.evaluate(() => ({
  label: document.getElementById("trajectory-label")?.textContent,
  stats: document.getElementById("trajectory-stats")?.textContent,
  agents: [...document.querySelectorAll(".traj-agent")].map((e) => e.dataset.sid.slice(0, 14)),
  agentHeads: [...document.querySelectorAll(".traj-agent-head")].map((e) => e.textContent.trim()),
  rows: document.querySelectorAll(".traj-row[data-index]").length,
  overviewBars: document.querySelectorAll(".tov-bar").length,
  cwd: window.__SCOPE_STATE.cwd,
  dispatchRows: [...document.querySelectorAll('.traj-row[data-index]')].filter((r) => /dispatch/i.test(r.textContent)).map((r) => r.textContent.replace(/\s+/g, " ").trim().slice(0, 140)),
  barClasses: [...new Set([...document.querySelectorAll(".tov-bar")].map((e) => e.className))],
  laneLabels: [...document.querySelectorAll(".tov-lane-label")].map((e) => e.textContent),
  tracks: document.querySelectorAll(".tov-track").length,
  dispatchLinks: document.querySelectorAll(".tov-link").length,
  dispatchBars: document.querySelectorAll(".tov-bar.tov-dispatch").length,
  legend: document.querySelector(".tov-legend")?.textContent,
  messageBarBg: getComputedStyle(document.querySelector(".tov-bar.tov-message")).backgroundColor,
  toolBarBg: getComputedStyle(document.querySelector(".tov-bar.tov-tool")).backgroundColor,
  overviewHeight: document.getElementById("trajectory-overview")?.getBoundingClientRect().height,
  kindCounts: [...document.querySelectorAll('.traj-row[data-index] .traj-col-kind')].reduce((a, e) => (a[e.textContent] = (a[e.textContent] || 0) + 1, a), {}),
  ledger: document.getElementById("trajectory-ledger")?.innerHTML.slice(0, 200),
  sessions: window.__SCOPE_STATE.sessions.map((s) => ({ id: s.session_id.slice(0, 14), agent: s.agent_name, parent: (s.parent_session_id || "").slice(0, 14), cwd: s.cwd })),
})), null, 2));

// Dispatch chip → expands + scrolls to the subagent section.
const chipInfo = await page.evaluate(() => {
  const chip = document.querySelector(".traj-disp-chip");
  if (!chip) return { found: false };
  const sid = chip.dataset.goto;
  const before = document.querySelector(`.traj-agent[data-sid="${sid}"]`)?.classList.contains("collapsed");
  chip.click();
  return { found: true, sid: sid.slice(0, 14), collapsedBefore: before };
});
await sleep(400);
const after = await page.evaluate((sid) => {
  const el = document.querySelector(`.traj-agent[data-sid="${sid}"]`);
  return { collapsedAfter: el?.classList.contains("collapsed"), flashed: el?.classList.contains("flash") };
}, chipInfo.sid);
console.log("chip nav:", JSON.stringify({ ...chipInfo, ...after }));

// Bars must stay inside their lane track.
const overflow = await page.evaluate(() => {
  let bad = 0;
  for (const track of document.querySelectorAll(".tov-track")) {
    const tr = track.getBoundingClientRect();
    for (const bar of track.querySelectorAll(".tov-bar")) {
      const br = bar.getBoundingClientRect();
      if (br.right > tr.right + 2 || br.left < tr.left - 2) bad++;
    }
  }
  return bad;
});
console.log("bars outside track:", overflow);

await browser.close();
srv.kill("SIGKILL");