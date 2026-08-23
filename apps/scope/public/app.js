/**
 * app.js — Pi Scope UI: state, single-mode, SSE, keyboard nav.
 * IIFE-wrapped for scope isolation.
 */
(function() {


// ─── State ──────────────────────────────────────────────────────────────────

const STATE = {
  // V3 regression fix: token must come from ?token=… query param. The hash is
  // for shareable view-state only; we don't want the token in shared URLs.
  token: new URLSearchParams(location.search).get("token") ?? "",
  view: "single", search: "",
  typeFilter: new Set(), autoScroll: true,
  selectedSessionId: null, cwd: "", sessions: [], events: [], sessionsLoaded: false,
  sidebarCollapsed: loadSidebarCollapsed(),
  theme: loadTheme(),
  focusedIdx: -1, lastEventTs: null,
  sseReconnectDelay: 1000, maxReconnectDelay: 10_000,
  renderDirty: true, seenIds: new Set(),
  sessionStats: {}, // sid → {total_cost,total_tokens,error_count,models:[]}
  ackd: new Set(),
  expandedGroups: new Set(), // cwd keys of currently-expanded session groups
  sessionsSig: "",
};

window.__SCOPE_STATE = STATE;

// Per-session request navigation for the system prompt overlay.
// SP._requests[] holds all llm_request events for the selected session;
// SP._reqIdx is the currently viewed position in that array.
const SP = { _requests: [], _reqIdx: -1 };

// ─── URL state ──────────────────────────────────────────────────────────────

function loadURLState() {
  const h = location.hash.replace(/^#/, "");
  if (!h) return;
  const p = new URLSearchParams(h);
  if (p.has("view")) STATE.view = p.get("view");
  if (!["single", "trajectory", "terminal", "files", "checkpoints", "git"].includes(STATE.view)) STATE.view = "single";
  if (p.has("sid")) { STATE.selectedSessionId = p.get("sid"); STATE.ackd.add(STATE.selectedSessionId); }
}

function saveURLState() {
  const p = new URLSearchParams();
  p.set("view", STATE.view);
  if ((STATE.view === "single" || STATE.view === "trajectory") && STATE.selectedSessionId) p.set("sid", STATE.selectedSessionId);
  const newHash = "#" + p.toString();
  if (location.hash !== newHash) history.replaceState(null, "", newHash);
}

// ─── DOM refs ───────────────────────────────────────────────────────────────

const $ = s => document.querySelector(s);
const sessionSubnav = document.querySelector("#session-subnav");
const sessionList = $("#session-list");
const eventView = $("#event-view");
const paneLabel = $("#pane-label");
const liveDot = $("#live-dot");
const liveLabel = $("#live-label");
const searchBox = $("#search-box");
const filterChips = $("#filter-chips");
const singlePane = $("#single-pane");
const filesPane = $("#files-pane");
const checkpointsPane = document.getElementById("checkpoints-pane");
const headerBreadcrumb = $("#header-breadcrumb");
const btnExpandAll = $("#btn-expand-all");
const btnCollapseAll = $("#btn-collapse-all");
const pauseToastSingle = $("#pause-toast-single");
const helpOverlay = $("#help-overlay");
const sysPromptBtn = $("#btn-sysprompt");
const spOverlay = $("#sp-overlay");
const spBody = $("#sp-body");
const spCopyBtn = $("#sp-copy");
const spCloseBtn = $("#sp-close");

// ─── Rich rendering helpers ─────────────────────────────────────────────────
// Shared implementations live in helpers.js (window.SCOPE). Keep local aliases
// so the rest of app.js can call them without the window.SCOPE prefix.

const CHIP_TYPES = ["user_message","assistant_message","tool_call","tool_result","thinking","model_change","compaction","branch_nav","error"];
const { summaryFor, summaryClass, turnFinalResponse, renderDetailHTML } = window.SCOPE;
if (typeof summaryFor !== "function" || typeof summaryClass !== "function" || typeof turnFinalResponse !== "function" || typeof renderDetailHTML !== "function") {
  throw new Error("Rendering helpers missing from window.SCOPE; check helpers.js exports.");
}

// ─── API helpers ────────────────────────────────────────────────────────────

function authHeaders() {
  return STATE.token ? { "Authorization": `Bearer ${STATE.token}` } : {};
}
function apiUrl(path, params = {}) {
  const u = new URL(path, location.origin);
  Object.entries(params).forEach(([k, v]) => { if (v != null && v !== "") u.searchParams.set(k, String(v)); });
  return u.toString();
}
window.apiUrl = apiUrl;
window.authHeaders = authHeaders;

// Shared fetch helper used by the Files / Checkpoints / Git views (and any
// future view). Combines auth headers + JSON body handling and returns
// { res, data } so callers can branch on res.ok / data.ok. `body` implies a
// JSON POST. The token travels via the Authorization header only — there is no
// need to repeat it in the query string (the server accepts either).
window.SCOPE.api = async function (path, params = {}, body) {
  const headers = authHeaders();
  const opts = { headers };
  if (body !== undefined) {
    opts.method = "POST";
    headers["content-type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(apiUrl(path, params), opts);
  let data = {};
  try { data = await res.json(); } catch {}
  return { res, data };
};

// Shared cwd access + label fallback (Files / Checkpoints / Git all render the
// same "no directory set" message into their own label element).
window.SCOPE.currentCwd = function () { return STATE.cwd || ""; };
window.SCOPE.cwdLabel = function (el) {
  if (el) el.textContent = STATE.cwd ? STATE.cwd : "no directory set — choose one in the Terminal pane";
};

// ─── Agent info computation ─────────────────────────────────────
function computeAgentInfo(sid) {
  const s = STATE.sessions.find(x => x.session_id === sid);
  if (!s) return null;
  const events = STATE.events.filter(e => e.session_id === sid);
  const stats = STATE.sessionStats[sid] || {};

  // Prefer server stats (new fields) when present; fall back to client compute.
  let inputTokens = stats.input_tokens ?? 0;
  let outputTokens = stats.output_tokens ?? 0;
  if (!stats.input_tokens && !stats.output_tokens) {
    for (const e of events) {
      if (e.type !== "assistant_message") continue;
      const u = e.payload?.usage;
      if (!u) continue;
      inputTokens += u.input ?? 0;
      outputTokens += u.output ?? 0;
    }
  }

  // Also accumulate cache_read / cache_write while we're at it (always client-side
  // for now — not in server stats endpoint).
  let cacheRead = 0, cacheWrite = 0;
  for (const e of events) {
    if (e.type !== "assistant_message") continue;
    const u = e.payload?.usage;
    if (!u) continue;
    cacheRead  += u.cache_read  ?? 0;
    cacheWrite += u.cache_write ?? 0;
  }

  // Latest assistant_message: context-used + perf metrics for the last turn.
  //
  // "Context used" = usage.input + usage.cache_read + usage.cache_write — the
  // full prefix sent to the model on the most recent turn. This matches pi's
  // terminal context bar across cached providers. For uncached providers
  // (e.g. deepseek) cache_read/cache_write are 0 so the sum collapses to
  // input. Cache volume stays separately visible on the cache r / cache w
  // pills for cost-attribution analysis. See apps/scope/db.ts getSessionContext
  // for the empirical verification (gemini-3.5-flash + deepseek-v4-flash).
  let latestInput = stats.latest_input ?? null;
  let latestPrefillMs = null, latestOutputTps = null, latestGenMs = null, latestLatencyMs = null;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type !== "assistant_message") continue;
    const p = events[i].payload;
    const u = p?.usage;
    if (latestInput == null && u && (u.input || u.cache_read || u.cache_write)) {
      latestInput = (u.input ?? 0) + (u.cache_read ?? 0) + (u.cache_write ?? 0);
    }
    if (latestPrefillMs == null && p?.prefill_ms != null) latestPrefillMs = p.prefill_ms;
    if (latestOutputTps == null && p?.output_tps != null) latestOutputTps = p.output_tps;
    if (latestGenMs == null && p?.generation_ms != null) latestGenMs = p.generation_ms;
    if (latestLatencyMs == null && p?.latency_ms != null) latestLatencyMs = p.latency_ms;
    if (latestInput != null && latestPrefillMs != null && latestOutputTps != null) break;
  }

  const contextTotal = window.SCOPE.getContextWindow(s.model);
  const contextUsed = latestInput || 0;
  const contextRemaining = Math.max(0, contextTotal - contextUsed);
  const contextRemainingPct = contextTotal ? Math.round((contextRemaining / contextTotal) * 100) : 0;

  const start = new Date(s.first_ts).getTime();
  const end = new Date(s.last_ts).getTime();
  const durationMs = Math.max(0, end - start);

  // Per-model token usage from server stats (falls back to client-side compute).
  let modelTokens = stats.models ?? [];
  if (!modelTokens.length && (inputTokens + outputTokens > 0)) {
    modelTokens = [{ model: s.model || "unknown", total_tokens: inputTokens + outputTokens, input_tokens: inputTokens, output_tokens: outputTokens }];
  }

  return {
    name: s.agent_name ?? s.cwd?.split("/").pop() ?? window.SCOPE.shortId(sid),
    sid, shortSid: window.SCOPE.shortId(sid),
    model: s.model || "", provider: s.provider || "",
    tags: s.tags || [], pool: s.pool || "default",
    eventCount: s.event_count ?? events.length,
    durationMs, cost: stats.total_cost ?? 0,
    inputTokens, outputTokens, cacheRead, cacheWrite,
    totalTokens: stats.total_tokens ?? (inputTokens + outputTokens),
    contextUsed, contextTotal, contextRemaining, contextRemainingPct,
    latestPrefillMs, latestOutputTps, latestGenMs, latestLatencyMs,
    modelTokens,
  };
}

// Debounce helper: coalesce bursts (e.g. a rapid run of SSE events, or the
// boot fan-out of per-session stats) into a single trailing call so the agent
// subnav and sidebar aren't rebuilt once per event. A pending call is dropped
// when another arrives during the wait window.
function debounce(fn, wait = 200) {
  let t = null;
  const wrapped = function (...args) {
    if (t) return;
    t = setTimeout(() => { t = null; fn.apply(null, args); }, wait);
  };
  wrapped.cancel = function () { if (t) { clearTimeout(t); t = null; } };
  return wrapped;
}

// Live-stream hot paths: recompute the subnav and sidebar at most once per
// wait period instead of on every appended event / stats response.
const scheduleAgentSubnav = debounce(renderAgentSubnav, 200);

function renderAgentSubnav() {
  if (!sessionSubnav) return;
  if (!STATE.selectedSessionId || STATE.view !== "single") {
    sessionSubnav.style.display = "none";
    return;
  }
  const info = computeAgentInfo(STATE.selectedSessionId);
  if (!info) { sessionSubnav.style.display = "none"; return; }
  sessionSubnav.style.display = "flex";
  const tagsHtml = info.tags.length
    ? info.tags.map(t => `<span class="snav-tag">${window.SCOPE.escapeHtml(t)}</span>`).join("")
    : `<span class="snav-tag dim">no tags</span>`;
  const ctxPctUsed = info.contextTotal ? Math.round((info.contextUsed / info.contextTotal) * 100) : 0;
  const ctxBarColor = ctxPctUsed > 90 ? "var(--red)" : ctxPctUsed > 70 ? "var(--orange)" : "var(--green)";
  const modelsHtml = info.modelTokens.length
    ? `<div class="snav-group snav-models" title="token usage per model used in this session">${info.modelTokens.map(m => `<div class="snav-stat snav-model-pill"><span class="snav-label">${window.SCOPE.escapeHtml(m.model)}</span><span class="snav-value">${window.SCOPE.fmtTokens(m.total_tokens)} tk</span></div>`).join("")}</div>`
    : "";

  sessionSubnav.innerHTML = `
    <div class="snav-group snav-identity">
      <div class="snav-name" title="${window.SCOPE.escapeHtml(info.sid)}">${window.SCOPE.escapeHtml(info.name)}</div>
      <div class="snav-sid"><code>${info.shortSid}</code>${info.model ? `<span class="snav-model">${window.SCOPE.escapeHtml(info.model)}</span>` : ""}</div>
      <div class="snav-tags"><span class="snav-pool">${window.SCOPE.escapeHtml(info.pool)}</span>${tagsHtml}</div>
    </div>
    <div class="snav-group snav-stats">
      <div class="snav-stat"><span class="snav-label">events</span><span class="snav-value">${info.eventCount}</span></div>
      <div class="snav-stat"><span class="snav-label">duration</span><span class="snav-value">${window.SCOPE.fmtDuration(info.durationMs)}</span></div>
      <div class="snav-stat snav-cost-pill"><span class="snav-label">cost</span><span class="snav-value snav-cost">$${info.cost.toFixed(4)}</span></div>
      <div class="snav-stat"><span class="snav-label">in</span><span class="snav-value">${window.SCOPE.fmtTokens(info.inputTokens)}</span></div>
      <div class="snav-stat"><span class="snav-label">out</span><span class="snav-value">${window.SCOPE.fmtTokens(info.outputTokens)}</span></div>
      <!-- Form mode: dual cache pills (per obv-flash). Function mode: single combined pill (CSS hides .snav-cache-r/.snav-cache-w and shows .snav-cache-combined). -->
      <div class="snav-stat snav-cache-r" title="cumulative input tokens served from cache"><span class="snav-label">cache r</span><span class="snav-value">${window.SCOPE.fmtTokens(info.cacheRead)}</span></div>
      <div class="snav-stat snav-cache-w" title="cumulative tokens written to cache this session"><span class="snav-label">cache w</span><span class="snav-value">${window.SCOPE.fmtTokens(info.cacheWrite)}</span></div>
      <div class="snav-stat snav-cache-combined" title="cache read / write tokens (cumulative)"><span class="snav-label">cache</span><span class="snav-value">${window.SCOPE.fmtTokens(info.cacheRead)}/${window.SCOPE.fmtTokens(info.cacheWrite)}</span></div>
      <!-- Latest-turn perf (TPS + prefill). em-dash when undefined (non-streaming turn or no assistant_message yet). -->
      <div class="snav-stat snav-perf" title="estimated output tokens/sec on the most recent assistant turn (post-prefill). Approximated from streaming delta timing — accurate within a single-batch arrival window; turns with gen_ms &lt; 50ms are suppressed to avoid measurement noise."><span class="snav-label">~TPS</span><span class="snav-value">${info.latestOutputTps != null ? info.latestOutputTps : "—"}</span></div>
      <div class="snav-stat snav-perf" title="prefill (time-to-first-token) on the most recent assistant turn"><span class="snav-label">prefill</span><span class="snav-value">${info.latestPrefillMs != null ? info.latestPrefillMs + "ms" : "—"}</span></div>
    </div>
    ${modelsHtml}
    <div class="snav-group snav-context">
      <div class="snav-context-top">
        <span class="snav-label">context</span>
        <span class="snav-context-fig">${window.SCOPE.fmtTokens(info.contextUsed)} / ${window.SCOPE.fmtTokens(info.contextTotal)}</span>
        <span class="snav-context-pct">${info.contextRemainingPct}% remaining</span>
      </div>
      <div class="snav-context-bar"><div class="snav-context-bar-fill" style="width:${ctxPctUsed}%;background:${ctxBarColor}"></div></div>
    </div>
  `;
}

function setSingleSessionControlsVisible(visible) {
  const display = visible ? "inline-block" : "none";
  if (sessionSubnav) sessionSubnav.style.display = visible ? "" : "none";
  searchBox.style.display = display;
  btnExpandAll.style.display = display;
  btnCollapseAll.style.display = display;
  if (visible) buildFilterChips();
  else filterChips.innerHTML = "";
  if (sysPromptBtn) sysPromptBtn.style.display = display;
}

// ─── View toggle ────────────────────────────────────────────────────────────

// Apply light/dark theme: body attribute + persistence + terminal re-theme.
// DeepSeek light is the default; dark swaps in the deepseek-harness dark tokens.
window.setTheme = function(theme) {
  if (theme !== "light" && theme !== "dark") theme = "light";
  STATE.theme = theme;
  if (theme === "dark") document.body.setAttribute("data-ds-dark-theme", "");
  else document.body.removeAttribute("data-ds-dark-theme");
  document.documentElement.style.colorScheme = theme === "dark" ? "dark" : "light";
  const btnTheme = $("#btn-theme");
  if (btnTheme) btnTheme.textContent = theme === "dark" ? "🌙" : "☀";
  try { localStorage.setItem("scope-theme", theme); } catch {}
  window.__terminalSetTheme?.();
  // Tool-name pills and other per-row tints are theme-dependent — re-render
  // the visible surfaces so their colors follow the new theme.
  renderSessions();
  if (STATE.view === "single" && STATE.selectedSessionId) {
    renderAllEvents();
    renderAgentSubnav();
  }
  if (STATE.view === "trajectory") window.__trajectoryOnView?.();
};

window.toggleTheme = function() {
  setTheme(STATE.theme === "dark" ? "light" : "dark");
};

window.setView = function(mode) {
  if (!["single", "trajectory", "terminal", "files", "checkpoints", "git"].includes(mode)) mode = "single";
  STATE.view = mode;
  localStorage.setItem("scope-view", mode);
  $("#btn-single").classList.toggle("active", mode === "single");
  $("#btn-trajectory")?.classList.toggle("active", mode === "trajectory");
  $("#btn-terminal")?.classList.toggle("active", mode === "terminal");
  singlePane.style.display = mode === "single" ? "" : "none";
  const trajectoryPane = document.getElementById("trajectory-pane");
  if (trajectoryPane) trajectoryPane.style.display = mode === "trajectory" ? "flex" : "none";
  const terminalPane = document.getElementById("terminal-pane");
  if (terminalPane) terminalPane.style.display = mode === "terminal" ? "" : "none";
  $("#btn-files")?.classList.toggle("active", mode === "files");
  if (filesPane) filesPane.style.display = mode === "files" ? "" : "none";
  if (mode === "files") window.__filesOnView?.();
  $("#btn-checkpoints")?.classList.toggle("active", mode === "checkpoints");
  if (checkpointsPane) checkpointsPane.style.display = mode === "checkpoints" ? "flex" : "none";
  if (mode === "checkpoints") window.__checkpointsOnView?.();
  $("#btn-git")?.classList.toggle("active", mode === "git");
  const gitPane = document.getElementById("git-pane");
  if (gitPane) gitPane.style.display = mode === "git" ? "flex" : "none";
  if (mode === "git") window.__gitOnView?.();
  if (mode === "trajectory") window.__trajectoryOnView?.();
  if (sessionSubnav) sessionSubnav.style.display = (mode === "single" && STATE.selectedSessionId) ? "flex" : "none";
  renderSessions();
  if (mode === "single" && STATE.selectedSessionId) {
    setSingleSessionControlsVisible(true);
    loadSession(STATE.selectedSessionId);
  } else if (mode === "single") {
    setSingleSessionControlsVisible(false);
  }
  if (mode === "terminal") window.__terminalOnShow?.();
  else window.__terminalOnHide?.();
  saveURLState();
};

// ─── Sessions ───────────────────────────────────────────────────────────────

async function fetchSessions() {
  try {
    const url = apiUrl("/sessions", { limit: 100 });
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    const sessions = data.sessions ?? [];
    STATE.sessions = sessions;
    STATE.sessionsLoaded = true;
    // Skip the full sidebar DOM rebuild when the session list is unchanged
    // (avoids a needless teardown/re-create on every 3s poll).
    const sig = sessions.map((s) => [s.session_id, s.event_count, s.last_ts, s.agent_name, s.model, s.cwd].join(":")).join("|");
    if (sig !== STATE.sessionsSig) { STATE.sessionsSig = sig; renderSessions(); }
    if (STATE.view === "files") window.__filesOnSessions?.();
    if (STATE.view === "checkpoints") window.__checkpointsOnSessions?.();
    if (STATE.view === "git") window.__gitOnSessions?.();
    if (STATE.view === "trajectory") window.__trajectoryOnSessions?.();
    // Batch-fetch stats for all visible sessions (one request, not N)
    var newSids = sessions.map(function(s){return s.session_id}).filter(function(id){return !STATE.sessionStats[id]});
    if (newSids.length) {
      fetchBatchSessionStats(newSids);
    }
  } catch { /* poll retries */ }
}


// Batch fetch stats for multiple sessions in one HTTP request (avoids N requests).
async function fetchBatchSessionStats(sids) {
  if (!sids || !sids.length) return;
  try {
    var url = apiUrl("/sessions/stats", { ids: sids.join(",") });
    var res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) return;
    var data = await res.json();
    var stats = data.stats || {};
    for (var sid in stats) {
      STATE.sessionStats[sid] = stats[sid];
      patchSessionStats(sid);
      if (STATE.view === "trajectory") window.__trajectoryStatsUpdate?.(sid, stats[sid]);
      if (sid === STATE.selectedSessionId) scheduleAgentSubnav();
    }
  } catch { /* ignore */ }
}

async function fetchSessionStats(sid) {
  try {
    const url = apiUrl(`/sessions/${sid}/stats`);
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) return;
    const stats = await res.json();
    STATE.sessionStats[sid] = stats;
    // Patch just this session's row in place. The boot fan-out fetches stats
    // for every session, so a full rebuild here would tear down and recreate the
    // sidebar dozens of times; a tiny text/dot update is effectively free.
    patchSessionStats(sid);
    if (STATE.view === "trajectory") window.__trajectoryStatsUpdate?.(sid, stats);
    if (sid === STATE.selectedSessionId) scheduleAgentSubnav();
  } catch { /* ignore */ }
}

function visibleSessions() {
  return [...STATE.sessions];
}

// Permanently delete every session and its events from the DB. Destructive —
// gated behind a confirm() so a stray click can't wipe the store.
function clearAllSessions() {
  if (!confirm("Permanently delete ALL agents and their events from the database? This cannot be undone.")) return;
  fetch(apiUrl("/sessions"), { method: "DELETE", headers: authHeaders() })
    .then(r => r.json())
    .then(data => {
      if (data && data.ok) {
        STATE.sessions = [];
        STATE.sessionStats = {};
        STATE.expandedGroups.clear();
        clearSelectedSession();
        renderSessions();
      } else {
        alert("Failed to clear agents: " + (data?.error ?? "unknown error"));
      }
    })
    .catch(err => alert("Failed to clear agents: " + err));
}

// Permanently delete a single session and its events from the DB.
function deleteSession(sid) {
  if (!confirm(`Delete this session and all its events?\n\n${sid.slice(0, 8)}…`)) return;
  fetch(apiUrl(`/sessions/${sid}`), { method: "DELETE", headers: authHeaders() })
    .then(r => r.json())
    .then(data => {
      if (data && data.ok) {
        // Remove from in-memory state
        STATE.sessions = STATE.sessions.filter(s => s.session_id !== sid);
        delete STATE.sessionStats[sid];
        if (STATE.selectedSessionId === sid) clearSelectedSession();
        renderSessions();
      } else {
        alert("Failed to delete session: " + (data?.error ?? "unknown error"));
      }
    })
    .catch(err => alert("Failed to delete session: " + err));
}

function clearSelectedSession() {
  STATE.selectedSessionId = null;
  STATE.events = [];
  STATE.focusedIdx = -1;
  STATE.renderDirty = true;
  STATE.seenIds = new Set();
  STATE.lastEventTs = null;
  paneLabel.textContent = "Select a session";
  eventView.innerHTML = '<div class="empty-state"><span class="icon">◈</span>Select a session from the sidebar</div>';
  window.__trajectoryClear?.();
  setSingleSessionControlsVisible(false);
  renderSessions();
  updateSSEFilter();
  saveURLState();
}

function renderSessions() {
  sessionList.innerHTML = "";
  const filtered = visibleSessions();
  if (STATE.sessionsLoaded && STATE.view === "single" && STATE.selectedSessionId && !filtered.some(s => s.session_id === STATE.selectedSessionId)) {
    clearSelectedSession();
    return;
  }
  if (!filtered.length) {
    if (!STATE.sidebarCollapsed) {
      sessionList.innerHTML = '<div style="padding:10px;color:var(--muted);font-size:11px">no sessions</div>';
    }
    return;
  }
  if (STATE.sidebarCollapsed) {
    for (const s of filtered) sessionList.appendChild(buildMiniSessionItem(s));
    return;
  }
  for (const group of groupSessionsByCwd(filtered)) {
    sessionList.appendChild(buildSessionGroup(group));
  }
}

// Group sessions by working directory. Each group is one "session" (the shared
// cwd) whose "subagents" are the individual agent sessions that ran there.
function groupSessionsByCwd(sessions) {
  const groups = new Map();
  for (const s of sessions) {
    const cwd = (s.cwd || "").trim();
    if (!groups.has(cwd)) groups.set(cwd, []);
    groups.get(cwd).push(s);
  }
  // Preserve the server's last_ts DESC ordering for both groups and members.
  return [...groups.entries()].map(([cwd, subagents]) => ({ cwd, subagents }));
}

function buildSessionGroup(group) {
  const wrap = document.createElement("div");
  wrap.className = "session-group";

  const expanded = STATE.expandedGroups.has(group.cwd);

  const head = document.createElement("div");
  head.className = "session-group-head" + (expanded ? "" : " collapsed");

  const caret = document.createElement("span");
  caret.className = "session-group-caret";
  caret.textContent = expanded ? "▾" : "▸";

  const title = document.createElement("span");
  title.className = "session-group-title";
  title.textContent = sessionGroupName(group.cwd);
  title.title = group.cwd;

  const count = document.createElement("span");
  count.className = "session-group-count";
  count.textContent = `${group.subagents.length} subagent${group.subagents.length === 1 ? "" : "s"}`;

  head.append(caret, title, count);

  const children = document.createElement("div");
  children.className = "session-group-children";
  children.style.display = expanded ? "" : "none";
  for (const s of group.subagents) children.appendChild(buildSessionItem(s));

  head.addEventListener("click", () => {
    const collapsed = head.classList.toggle("collapsed");
    caret.textContent = collapsed ? "▸" : "▾";
    children.style.display = collapsed ? "none" : "";
    if (collapsed) STATE.expandedGroups.delete(group.cwd);
    else STATE.expandedGroups.add(group.cwd);
  });

  wrap.appendChild(head);
  wrap.appendChild(children);
  return wrap;
}

function sessionGroupName(cwd) {
  if (!cwd) return "unknown cwd";
  const parts = cwd.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : cwd;
}

function buildSessionItem(s) {
  const el = document.createElement("div");
  const isSel = (STATE.view === "single" || STATE.view === "trajectory")
    ? s.session_id === STATE.selectedSessionId
    : false;
  el.className = "session-item" + (isSel ? " selected" : "");
  el.dataset.sid = s.session_id;
  const shortId = s.session_id.slice(0, 8);
  const name = s.agent_name ?? s.cwd?.split("/").pop() ?? shortId;

  const modelHtml = s.model ? ` <span class="name-model">- ${window.SCOPE.escapeHtml(s.model)}</span>` : "";
  const info = document.createElement("div");
  info.className = "info";
  info.innerHTML = `<div class="name"><span class="status-dot ${window.SCOPE.subagentStatus(s)}"></span><span class="name-text">${window.SCOPE.escapeHtml(name)}</span>${modelHtml}<span class="err-dot">●</span></div>`;

  const cost = document.createElement("div");
  cost.className = "cost";
  info.appendChild(cost);

  applySessionStatsToItem(el, STATE.sessionStats[s.session_id], s);

  if (STATE.view === "single" || STATE.view === "trajectory") {
    el.addEventListener("click", () => selectSession(s.session_id));
  }

  // Per-session delete cross icon
  const delBtn = document.createElement("span");
  delBtn.className = "sess-delete";
  delBtn.textContent = "✕";
  delBtn.title = `Delete this session (${shortId}…)`;
  delBtn.addEventListener("click", (e) => { e.stopPropagation(); deleteSession(s.session_id); });
  el.appendChild(delBtn);

  el.appendChild(info);

  return el;
}

// Set a session item's cost text and error-dot state from its stats. Shared by
// the initial build and the boot fan-out patch so both use one code path.
function applySessionStatsToItem(el, stats, s) {
  const cost = el.querySelector(".cost");
  if (cost) {
    cost.textContent = stats
      ? `${window.SCOPE.fmtTokens(stats.total_tokens)} tk · $${stats.total_cost.toFixed(4)}`
      : "";
  }
  const dot = el.querySelector(".err-dot");
  if (dot) {
    const hasErr = stats && stats.error_count > 0;
    dot.classList.toggle("noerr", !hasErr);
    dot.classList.toggle("ackd", STATE.ackd.has(s.session_id));
  }
}

// In-place update for one session after its stats arrive, avoiding a full
// sidebar rebuild. Mirrors the cost into the collapsed mini-item tooltip too.
function patchSessionStats(sid) {
  const s = STATE.sessions.find(x => x.session_id === sid);
  const stats = STATE.sessionStats[sid];
  if (!s || !stats) return;
  const item = sessionList.querySelector(`.session-item[data-sid="${CSS.escape(sid)}"]`);
  if (item) applySessionStatsToItem(item, stats, s);
  const mini = sessionList.querySelector(`.session-mini[data-sid="${CSS.escape(sid)}"]`);
  if (mini) {
    const name = s.agent_name ?? s.cwd?.split("/").pop() ?? s.session_id;
    mini.title = `${name}\n${sid.slice(0, 8)} · ${s.event_count} events · ${window.SCOPE.fmtRel(s.last_ts)} · $${stats.total_cost.toFixed(4)}`;
  }
}

function buildMiniSessionItem(s) {
  const el = document.createElement("div");
  const isSel = (STATE.view === "single" || STATE.view === "trajectory")
    ? s.session_id === STATE.selectedSessionId
    : false;
  el.className = "session-mini" + (isSel ? " selected" : "");
  el.dataset.sid = s.session_id;
  const name = s.agent_name ?? s.cwd?.split("/").pop() ?? s.session_id;
  const stats = STATE.sessionStats[s.session_id];
  const costStr = stats ? ` · $${stats.total_cost.toFixed(4)}` : "";
  el.title = `${name}\n${s.session_id.slice(0, 8)} · ${s.event_count} events · ${window.SCOPE.fmtRel(s.last_ts)}${costStr}`;
  el.textContent = window.SCOPE.agentLetter(s);
  const dot = document.createElement("span");
  dot.className = "mini-dot " + window.SCOPE.activityStatus(s);
  el.appendChild(dot);
  if (STATE.view === "single" || STATE.view === "trajectory") {
    el.addEventListener("click", () => selectSession(s.session_id));
  }

  // Right-click (or long-press) to delete in collapsed mode
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    deleteSession(s.session_id);
  });

  return el;
}

// 2 s tick to refresh the activity-window dot color without re-rendering the
// entire sidebar. Cheap DOM patch — only touches the dot's class list.
setInterval(() => {
  if (!STATE.sidebarCollapsed) return;
  document.querySelectorAll(".session-mini").forEach(el => {
    const sid = el.dataset.sid;
    const s = STATE.sessions.find(x => x.session_id === sid);
    if (!s) return;
    const dot = el.querySelector(".mini-dot");
    if (dot) dot.className = "mini-dot " + window.SCOPE.activityStatus(s);
  });
}, 500);

// 500 ms tick to refresh subagent status dots in the expanded session list.
// Same pattern as mini-dots — cheap DOM patch without full re-render.
setInterval(() => {
  if (STATE.sidebarCollapsed) return;
  document.querySelectorAll(".session-item .status-dot").forEach(el => {
    const sid = el.closest(".session-item")?.dataset.sid;
    if (!sid) return;
    const s = STATE.sessions.find(x => x.session_id === sid);
    if (!s) return;
    el.className = "status-dot " + window.SCOPE.subagentStatus(s);
  });
}, 500);

function selectSession(sid) {
  STATE.ackd.add(sid);
  if (STATE.selectedSessionId === sid) {
    clearSelectedSession();
    return;
  }
  STATE.selectedSessionId = sid;
  STATE.events = [];
  STATE.focusedIdx = -1;
  STATE.renderDirty = true;
  STATE.seenIds = new Set();

  // Reset auto-scroll and hide pause toast on agent switch
  STATE.autoScroll = true;
  if (pauseToastSingle) pauseToastSingle.classList.remove("show");

  if (STATE.view === "trajectory") {
    window.__trajectoryOnView?.();
    updateSSEFilter();
    saveURLState();
    return;
  }

  setSingleSessionControlsVisible(true);
  loadSession(sid);
  updateSSEFilter();
  saveURLState();
}

async function loadSession(sid) {
  const s = STATE.sessions.find(x => x.session_id === sid);
  paneLabel.textContent = s ? (s.agent_name ?? s.cwd?.split("/").pop() ?? window.SCOPE.shortId(sid)) : window.SCOPE.shortId(sid);
  const events = await fetchSessionEvents(sid);
  if (STATE.selectedSessionId !== sid) return;
  STATE.events = events || [];
  STATE.renderDirty = true;
  for (const e of STATE.events) STATE.seenIds.add(e.event_id);
  renderAllEvents();
  if (s?.last_ts) STATE.lastEventTs = s.last_ts;
  fetchSessionStats(sid);
  renderAgentSubnav();
}

async function fetchSessionEvents(sid, sinceSeq) {
  try {
    const params = { limit: 1000 };
    if (sinceSeq !== undefined) params.since_seq = sinceSeq;
    const url = apiUrl(`/sessions/${sid}/events`, params);
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) return [];
    const data = await res.json();
    return data.events ?? [];
  } catch { return []; }
}

// ─── Event rendering (single mode, append-only) ────────────────────────────

// A failed tool call is recorded as a `tool_result` with payload.is_error
// or a non-zero details_summary.exit_code.
function evtTypeInFilter(e) {
  if (STATE.typeFilter.has(e.type)) return true;
  if (STATE.typeFilter.has("error") && e.type === "tool_result" && window.SCOPE.isToolResultError(e.payload)) return true;
  return false;
}

function getFilteredEvents() {
  let evts = STATE.events;
  if (STATE.search) {
    const q = STATE.search.toLowerCase();
    evts = evts.filter(e => (summaryFor(e) + JSON.stringify(e.payload ?? {})).toLowerCase().includes(q));
  }
  if (STATE.typeFilter.size > 0) evts = evts.filter(evtTypeInFilter);
  return evts;
}

function renderAllEvents() {
  const evts = getFilteredEvents();
  if (!evts.length) {
    eventView.innerHTML = '<div class="empty-state" style="font-size:12px">no matching events</div>';
    return;
  }

  // Build into a fragment for a SINGLE DOM append (avoids repeated reflows)

  let currentTurnIdx = null;
  let turnCost = 0;
  let turnTokens = 0;
  let rowIdx = 0;
  let inSetup = true;
  let _sawAgentEnd = false;   // true after agent_end — next agent_start opens a new turn
  let _cycleFromAgent = false; // true when this turn header was opened by agent_start
  let _lastHeader = null; // last header element (for cost retro-fit)

  var frag = document.createDocumentFragment();

  // Collect first llm_request per turn for header embedding
  const turnPrompts = {};
  const turnRequests = {}; // ti -> { model, msgs, preview }
  for (const e of evts) {
    const ti = e.payload?.turn_index;
    if (ti == null) continue;
    if (e.type === "user_message") {
      turnPrompts[ti] = e.payload.text || "";
    } else if (e.type === "llm_request" && !turnRequests[ti]) {
      turnRequests[ti] = {
        model: e.payload.model || "",
        msgs: e.payload.message_count != null ? `${e.payload.message_count} msgs` : "",
        preview: e.payload.user_msg_preview || "",
      };
    }
  }

  function finishTurnHeader() {
    if (!_lastHeader) return;
    if (turnCost > 0 || turnTokens > 0) {
      var span = _lastHeader.querySelector(".turn-cost");
      if (span) span.textContent = " · $" + turnCost.toFixed(5) + " · " + window.SCOPE.fmtTokens(turnTokens);
    }
  }

  function openTurnHeader(ti, prompt) {
    finishTurnHeader();
    currentTurnIdx = ti;
    turnCost = 0;
    turnTokens = 0;
    var hdr = document.createElement("div");
    hdr.className = "turn-header";
    hdr.dataset.turn = ti;
    var req = turnRequests[ti] || {};
    var reqStr = req.model || req.msgs
      ? " · 🛅 " + [req.model, req.msgs].filter(Boolean).join(" · ") + (req.preview ? " · " + window.SCOPE.trunc(req.preview, 80) : "")
      : "";
    hdr.innerHTML = '<span class="turn-label">Turn #' + ti + '</span><span class="turn-cost"></span><span class="turn-request"></span>';
    // Set dynamic parts
    if (reqStr) hdr.querySelector(".turn-request").textContent = reqStr;
    if (prompt && !req.model && !req.msgs) {
      var tp = document.createElement("span");
      tp.className = "turn-prompt";
      tp.textContent = prompt.slice(0, 120);
      hdr.appendChild(tp);
    }
    _lastHeader = hdr;
    frag.appendChild(hdr);
  }

  for (var i = 0; i < evts.length; i++) {
    var evt = evts[i];
    var ti = evt.payload?.turn_index;

    // Fold turn_start and llm_request into the turn header.
    if (evt.type === "turn_start") {
      if (_cycleFromAgent) {
        // agent_start already opened the header for this cycle —
        // don't create another, just clear the flag.
        _cycleFromAgent = false;
      } else if (ti != null && ti !== currentTurnIdx) {
        openTurnHeader(ti, turnPrompts[ti] || "");
        inSetup = false;
      }
      _sawAgentEnd = false;
      continue;
    }
    if (evt.type === "llm_request") continue;

    // agent_start after agent_end is a cycle boundary — open a new turn even
    // if turn_index hasn't changed (pi may reuse the same index across cycles).
    if (evt.type === "agent_start" && _sawAgentEnd) {
      var prompt = evt.payload?.text || evt.payload?.prompt || turnPrompts[ti] || "";
      var nextTi = (typeof currentTurnIdx === "number" && currentTurnIdx != null) ? currentTurnIdx + 1 : (ti || 0);
      openTurnHeader(nextTi, prompt);
      inSetup = false;
      _sawAgentEnd = false;
      _cycleFromAgent = true;
    }

    // agent_end marks that we're at the end of a cycle.
    if (evt.type === "agent_end") {
      _sawAgentEnd = true;
    }

    // Any event with a new turn_index opens a turn header (fallback).
    if (ti != null && ti !== currentTurnIdx) {
      openTurnHeader(ti, turnPrompts[ti] || "");
      inSetup = false;
    } else if (inSetup && currentTurnIdx == null) {
      currentTurnIdx = "setup";
      var hdr = document.createElement("div");
      hdr.className = "turn-header";
      hdr.dataset.turn = "setup";
      hdr.innerHTML = '<span class="turn-label">Setup</span><span class="turn-cost"></span>';
      _lastHeader = hdr;
    frag.appendChild(hdr);
    }

    if (evt.type === "assistant_message") {
      var u = evt.payload?.usage || {};
      if (u.cost_total) turnCost += u.cost_total;
      if (u.total_tokens) turnTokens += u.total_tokens;
    }

    frag.appendChild(buildEventRow(evt, rowIdx++));
  }

  finishTurnHeader();

  // Single append of the full fragment
  eventView.innerHTML = "";
  eventView.appendChild(frag);

  if (STATE.autoScroll) scrollEventViewToBottom();
  STATE.renderDirty = false;
}
const MAX_EVENTS_IN_MEMORY = 6000;
const MAX_SEEN_IDS = MAX_EVENTS_IN_MEMORY * 2;
function appendEventSingle(evt) {
  if (!STATE.selectedSessionId || evt.session_id !== STATE.selectedSessionId) return;
  if (STATE.seenIds.has(evt.event_id)) return;
  STATE.seenIds.add(evt.event_id);
  STATE.events.push(evt);
  if (STATE.events.length > MAX_EVENTS_IN_MEMORY) {
    const dropped = STATE.events.splice(0, STATE.events.length - MAX_EVENTS_IN_MEMORY);
    for (const d of dropped) STATE.seenIds.delete(d.event_id);
  }
  // seenIds can grow when events are filtered out before reaching STATE.events.
  // Rebuild it from the in-memory event list to keep memory bounded.
  if (STATE.seenIds.size > MAX_SEEN_IDS) {
    STATE.seenIds = new Set(STATE.events.map(e => e.event_id));
  }
  if (evt.ts) STATE.lastEventTs = evt.ts;

  // Keep the session's last_ts live so status dots reflect real-time activity
  // instead of lagging behind by up to 10s (the fetchSessions poll interval).
  const session = STATE.sessions.find(s => s.session_id === evt.session_id);
  if (session && evt.ts) session.last_ts = evt.ts;

  if (STATE.renderDirty || !matchesFilters(evt)) {
    // Filters active or dirty — rebuild
    renderAllEvents();
  } else {
    const idx = STATE.events.length - 1;
    eventView.appendChild(buildEventRow(evt, idx, true));
    if (STATE.autoScroll) scrollEventViewToBottom();
  }
  scheduleAgentSubnav();
}

function matchesFilters(evt) {
  if (STATE.search) {
    const q = STATE.search.toLowerCase();
    if (!(summaryFor(evt) + JSON.stringify(evt.payload ?? {})).toLowerCase().includes(q)) return false;
  }
  if (STATE.typeFilter.size > 0 && !evtTypeInFilter(evt)) return false;
  return true;
}

function buildEventRow(evt, idx, isLive = false) {
  const frag = document.createDocumentFragment();
  const typeStr = String(evt.type ?? "");

  // ── agent_end: prominent highlighted bar, collapsible ───────────────────
  if (typeStr === "agent_end") {
    const p = evt.payload ?? {};
    const fr = p.final_response || window.SCOPE.agentFinalResponse(evt, window.__SCOPE_STATE?.events);
    const row = document.createElement("div");
    row.className = "evt-row evt-agent-end" + (idx === STATE.focusedIdx ? " focused" : "");
    row.dataset.idx = idx;
    row.innerHTML = `<span class="evt-ts">${window.SCOPE.fmtTs(evt.ts)}</span><span class="evt-type"><span class="pill agent_end">agent end</span></span><span class="evt-summary">${p.message_count ?? "?"} messages · ${fr ? window.SCOPE.escapeHtml(fr.slice(0, 160)) : "no final response"}</span>`;
    const detail = document.createElement("div");
    detail.className = "evt-detail";
    detail.innerHTML = fr
      ? `<pre style="white-space:pre-wrap;margin:0;font-size:13px;line-height:1.5">${window.SCOPE.escapeHtml(fr)}</pre>`
      : `<div class="llm-empty">no final response captured</div>`;
    row.addEventListener("click", () => { detail.classList.toggle("open"); STATE.focusedIdx = idx; refreshFocus(); });
    frag.appendChild(row);
    frag.appendChild(detail);
    return frag;
  }

  // ── Every row is collapsible (click to toggle detail) ───────────────────

  const row = document.createElement("div");
  row.className = "evt-row" + (idx === STATE.focusedIdx ? " focused" : "");
  row.dataset.idx = idx;
  // evt.type is producer-controlled (POST /events is unauthenticated), so it's
  // escaped for display and the class token is restricted to a safe charset.
  const typeLabel = window.SCOPE.escapeHtml(typeStr.replace(/_/g, " "));
  const typeClass = /^[a-z0-9_-]+$/.test(typeStr) ? typeStr : "custom";
  const pillClass = typeStr === "tool_result" && window.SCOPE.isToolResultError(evt.payload) ? "error" : typeClass;
  row.innerHTML = `<span class="evt-ts">${window.SCOPE.fmtTs(evt.ts)}</span><span class="evt-type"><span class="pill ${pillClass}">${typeLabel}</span>${window.SCOPE.toolNamePillHTML(evt)}</span><span class="evt-summary ${summaryClass(evt)}">${window.SCOPE.escapeHtml(summaryFor(evt))}</span>`;

  if (isLive && typeof window.__pulseColorFor === "function") {
    row.style.setProperty("--pulse-color", evt.type === "tool_result" && window.SCOPE.isToolResultError(evt.payload) ? "rgba(239,68,68,0.22)" : window.__pulseColorFor(evt.type));
    row.classList.add("evt-new");
    setTimeout(() => row.classList.remove("evt-new"), 1300);
  }

  const detail = document.createElement("div");
  detail.className = "evt-detail";
  detail.dataset.eventId = evt.event_id;
  detail.innerHTML = renderDetailHTML(evt);

  row.addEventListener("click", () => {
    detail.classList.toggle("open");
    STATE.focusedIdx = idx;
    refreshFocus();
  });

  frag.appendChild(row);
  frag.appendChild(detail);
  return frag;
}

function refreshFocus() {
  eventView.querySelectorAll(".evt-row").forEach((r, i) => {
    r.classList.toggle("focused", i === STATE.focusedIdx);
  });
}

function applyFilters() {
  STATE.renderDirty = true;
  renderAllEvents();
}

function scrollEventViewToBottom() {
  if (!eventView) return;
  const go = () => { eventView.scrollTop = eventView.scrollHeight; };
  go();
  requestAnimationFrame(go);
}

// Auto-scroll + pause toast
eventView.addEventListener("scroll", () => {
  if (STATE.view !== "single") return;
  const atBottom = eventView.scrollHeight - eventView.scrollTop - eventView.clientHeight < 40;
  if (!atBottom && STATE.autoScroll) {
    STATE.autoScroll = false;
    pauseToastSingle.classList.add("show");
  } else if (atBottom && !STATE.autoScroll) {
    STATE.autoScroll = true;
    pauseToastSingle.classList.remove("show");
  }
});

window.resumeSingleScroll = function() {
  STATE.autoScroll = true;
  scrollEventViewToBottom();
  pauseToastSingle.classList.remove("show");
};

// ─── Filter chips ──────────────────────────────────────────────────────────

function buildFilterChips() {
  filterChips.innerHTML = "";
  // Quick-toggle buttons
  const quickBtns = [
    { label: "errors", type: "error", title: "Only show errors & failed tools" },
    { label: "lifecycle", types: ["session_start","session_shutdown","turn_end","agent_start","agent_end","model_change","branch_nav"], title: "Show/hide lifecycle events" },
  ];
  for (const btn of quickBtns) {
    const chip = document.createElement("span");
    const types = btn.types || [btn.type];
    const on = types.some(t => STATE.typeFilter.has(t));
    chip.className = "fchip qbtn" + (on ? " on" : "");
    chip.textContent = btn.label;
    chip.title = btn.title;
    chip.addEventListener("click", () => {
      if (on) types.forEach(t => STATE.typeFilter.delete(t));
      else types.forEach(t => STATE.typeFilter.add(t));
      buildFilterChips();
      applyFilters();
    });
    filterChips.appendChild(chip);
  }
  const sep = document.createElement("span");
  sep.textContent = "|";
  sep.style.cssText = "color:var(--muted);margin:0 2px";
  filterChips.appendChild(sep);
  // Standard type chips
  for (const t of CHIP_TYPES) {
    const chip = document.createElement("span");
    chip.className = "fchip" + (STATE.typeFilter.has(t) ? " on" : "");
    chip.textContent = t.replace(/_/g, " ");
    chip.addEventListener("click", () => {
      STATE.typeFilter.has(t) ? STATE.typeFilter.delete(t) : STATE.typeFilter.add(t);
      buildFilterChips();
      applyFilters();
    });
    filterChips.appendChild(chip);
  }
}

searchBox.addEventListener("input", () => {
  STATE.search = searchBox.value.trim().toLowerCase();
  applyFilters();
});

// ─── Expand/collapse all ───────────────────────────────────────────────────

btnExpandAll.addEventListener("click", () => {
  eventView.querySelectorAll(".evt-detail").forEach(d => d.classList.add("open"));
});
btnCollapseAll.addEventListener("click", () => {
  eventView.querySelectorAll(".evt-detail.open").forEach(d => d.classList.remove("open"));
});

// ─── Keyboard nav ──────────────────────────────────────────────────────────

document.addEventListener("keydown", (e) => {
  if (STATE.view === "terminal") return;
  if (spOverlay && spOverlay.classList.contains("show")) {
    if (e.key === "Escape") { e.preventDefault(); toggleSysPrompt(false); }
    return;
  }
  if (e.key === "?") { e.preventDefault(); toggleHelp(); return; }
  if (e.key === "/" && STATE.view === "single" && STATE.selectedSessionId) {
    e.preventDefault(); searchBox.focus(); return;
  }
  if (STATE.view !== "single" || !STATE.selectedSessionId) return;
  // While a form control (e.g. the search box opened with "/") holds focus,
  // Space/j/k must not navigate. Escape blurs it so keyboard nav resumes —
  // otherwise Space silently stops working until the field loses focus.
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") {
    if (e.key === "Escape") e.target.blur();
    return;
  }

  const evts = getFilteredEvents();
  switch (e.key) {
    case "j": case "ArrowDown": e.preventDefault();
      STATE.focusedIdx = Math.min(STATE.focusedIdx + 1, evts.length - 1);
      refreshFocus(); scrollToFocused(); break;
    case "k": case "ArrowUp": e.preventDefault();
      STATE.focusedIdx = Math.max(STATE.focusedIdx - 1, 0);
      refreshFocus(); scrollToFocused(); break;
    case "Enter": case " ": e.preventDefault(); toggleFocusedDetail(); break;
    case "Escape": e.preventDefault(); collapseAll(); break;
    case "g": e.preventDefault(); STATE.focusedIdx = 0; refreshFocus(); scrollToFocused(); break;
    case "G": e.preventDefault(); STATE.focusedIdx = evts.length - 1; refreshFocus(); scrollToFocused(); break;
  }
});

function scrollToFocused() {
  const row = eventView.querySelector(`.evt-row[data-idx="${STATE.focusedIdx}"]`);
  if (row) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
function toggleFocusedDetail() {
  const details = eventView.querySelectorAll(".evt-detail");
  if (STATE.focusedIdx >= 0 && STATE.focusedIdx < details.length) {
    details[STATE.focusedIdx].classList.toggle("open");
  }
}
function collapseAll() {
  eventView.querySelectorAll(".evt-detail.open").forEach(d => d.classList.remove("open"));
}

// ─── System prompt modal (single view) ───────────────────────────────────

function openSysPrompt() {
  if (!STATE.selectedSessionId) return;
  const sid = STATE.selectedSessionId;
  // Collect all llm_request events for this session in seq order.
  SP._requests = STATE.events
    .filter(e => e.session_id === sid && e.type === "llm_request")
    .sort((a, b) => a.seq - b.seq);
  SP._reqIdx = SP._requests.length > 0 ? SP._requests.length - 1 : -1; // start at latest
  showCurrentRequest();
  spOverlay.classList.add("show");
}

function showCurrentRequest() {
  const total = SP._requests?.length ?? 0;
  if (!total) {
    spBody.innerHTML = `<div class="llm-empty">No LLM requests captured for this session.</div>`;
    document.getElementById("sp-nav").style.display = "none";
    return;
  }
  const idx = SP._reqIdx;
  const snap = SP._requests[idx];
  const payload = snap ? snap.payload : null;
  // renderLLMRequestHTML lives in helpers.js (window.SCOPE).
  const nav = document.getElementById("sp-nav");
  if (nav) {
    nav.style.display = "flex";
    nav.innerHTML =
      `<button id="sp-prev" ${idx <= 0 ? "disabled" : ""}>◀</button>` +
      `<span style="flex:1;text-align:center;font-size:12px;color:var(--muted)">Request ${idx + 1} of ${total}</span>` +
      `<button id="sp-next" ${idx >= total - 1 ? "disabled" : ""}>▶</button>`;
    document.getElementById("sp-prev")?.addEventListener("click", () => {
      if (SP._reqIdx > 0) { SP._reqIdx--; showCurrentRequest(); }
    });
    document.getElementById("sp-next")?.addEventListener("click", () => {
      if (SP._reqIdx < total - 1) { SP._reqIdx++; showCurrentRequest(); }
    });
  }
  const html = (typeof window.SCOPE.renderLLMRequestHTML === "function")
    ? window.SCOPE.renderLLMRequestHTML(payload)
    : `<div class="llm-empty">render helper unavailable</div>`;
  spBody.innerHTML = html;
}

window.toggleSysPrompt = function(force) {
  const show = typeof force === "boolean" ? force : !spOverlay.classList.contains("show");
  spOverlay.classList.toggle("show", show);
};

spCopyBtn?.addEventListener("click", () => {
  const req = SP._requests?.[SP._reqIdx];
  const text = req?.payload?.system_prompt || "";
  if (text) navigator.clipboard.writeText(text).catch(() => {});
});
spCloseBtn?.addEventListener("click", () => toggleSysPrompt(false));
sysPromptBtn?.addEventListener("click", openSysPrompt);


// ─── Help overlay ──────────────────────────────────────────────────────────

window.toggleHelp = function() {
  helpOverlay.classList.toggle("show");
};

// ─── Sidebar collapse (mini icon mode) ─────────────────────────────────────
// Collapses the left sidebar to a strip of single-letter agent chips with a
// status dot. Hides filters/search/sort/hide-after entirely. Works the same
// in single / trajectory views — only the click handler differs.
window.toggleSidebar = function() {
  STATE.sidebarCollapsed = !STATE.sidebarCollapsed;
  localStorage.setItem("scope-sidebar-collapsed", STATE.sidebarCollapsed ? "1" : "0");
  applySidebarCollapsed();
  renderSessions();
};

function applySidebarCollapsed() {
  document.body.classList.toggle("sidebar-collapsed", STATE.sidebarCollapsed);
  const btn = document.getElementById("sidebar-toggle");
  if (btn) {
    btn.textContent = STATE.sidebarCollapsed ? "»" : "«";
    btn.title = STATE.sidebarCollapsed
      ? "Expand sidebar"
      : "Collapse sidebar (more room for the main view)";
  }
}

// ─── Resizable sidebar ─────────────────────────────────────────────────────
// Drag the thin strip on the aside's right edge to resize. The width is stored
// in the --sidebar-w CSS variable so the collapsed 52/56px rules still win by
// specificity instead of being overridden by an inline width.
(function initSidebarResizer() {
  const aside = document.querySelector("aside");
  const resizer = document.getElementById("sidebar-resizer");
  if (!aside || !resizer) return;

  const MIN = 180, MAX = 720, KEY = "scope-sidebar-width";

  function setWidth(w) {
    aside.style.setProperty("--sidebar-w", Math.round(w) + "px");
  }

  try {
    const saved = parseInt(localStorage.getItem(KEY), 10);
    if (saved >= MIN && saved <= MAX) setWidth(saved);
  } catch {}

  resizer.addEventListener("mousedown", (e) => {
    if (STATE.sidebarCollapsed) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = aside.getBoundingClientRect().width;
    resizer.classList.add("dragging");
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    const onMove = (ev) => {
      setWidth(Math.min(MAX, Math.max(MIN, startW + (ev.clientX - startX))));
    };
    const onUp = () => {
      resizer.classList.remove("dragging");
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      try { localStorage.setItem(KEY, Math.round(aside.getBoundingClientRect().width)); } catch {}
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
})();

// ─── Copy JSON ─────────────────────────────────────────────────────────────

window.SCOPE = window.SCOPE || {};
window.SCOPE.copyEvent = function(eventId) {
  const evt = STATE.events.find(e => e.event_id === eventId);
  if (!evt) return;
  navigator.clipboard.writeText(JSON.stringify(evt.payload, null, 2)).catch(() => {});
};

// Delegated handler for the copy buttons rendered inside event details. Uses a
// data attribute (set in helpers.js) instead of an inline onclick so a
// producer-supplied event_id can never inject script.
eventView.addEventListener("click", (e) => {
  const t = e.target;
  if (!(t instanceof Element)) return;
  const btn = t.closest("[data-copy-event]");
  if (!btn) return;
  e.stopPropagation();
  window.SCOPE.copyEvent(btn.dataset.copyEvent);
});


// ─── SSE ────────────────────────────────────────────────────────────────────

let es = null;

function updateSSEFilter() {
  disconnectSSE();
  connectSSE();
}

function connectSSE() {
  const params = {};
  if ((STATE.view === "single" || STATE.view === "trajectory") && STATE.selectedSessionId) params.session_id = STATE.selectedSessionId;
  if (STATE.token) params.token = STATE.token;
  const url = apiUrl("/events/stream", params);

  es = new EventSource(url);
  es.addEventListener("hello", () => {
    setLive(true);
    STATE.sseReconnectDelay = 1000;
    if (STATE.view === "trajectory") window.__trajectoryOnReconnect?.();
  });
  es.addEventListener("event", (msg) => {
    try {
      const evt = JSON.parse(msg.data);
      if (!evt?.event_id) return;
      // Terminal-spawned agents report their working directory on session_start;
      // mirror it into the shared cwd so Files/Checkpoints follow the agent.
      if (evt.type === "session_start" && evt.pool === "terminal-agent" && evt.cwd) {
        setCwd(evt.cwd);
      }
      // Keep session list live: patch last_ts (and has_shutdown on lifecycle
      // events) so the sidebar status dots reflect real-time activity.
      patchSessionFromSSE(evt);
      if (STATE.view === "single") appendEventSingle(evt);
      else if (STATE.view === "trajectory") window.__trajectoryOnEvent?.(evt);
    } catch { /* ignore */ }
  });
  es.onerror = () => {
    setLive(false); es.close();
    setTimeout(connectSSE, STATE.sseReconnectDelay);
    STATE.sseReconnectDelay = Math.min(STATE.sseReconnectDelay * 2, STATE.maxReconnectDelay);
  };
}

function disconnectSSE() { if (es) { es.close(); es = null; } setLive(false); }
function setLive(on) { liveDot.className = on ? "green" : "red"; liveLabel.textContent = on ? "live" : "off"; }

// Immediately patch STATE.sessions with live SSE data so the sidebar status
// dots (green→orange→red) and the 2 s ticker reflect real-time activity
// instead of lagging behind the 10 s fetchSessions poll.
function patchSessionFromSSE(evt) {
  if (!evt?.session_id) return;
  let session = STATE.sessions.find(s => s.session_id === evt.session_id);
  // New session (session_start from an agent we haven't polled yet) —
  // create a minimal placeholder so the sidebar doesn't miss it entirely.
  if (!session && evt.type === "session_start") {
    session = {
      session_id: evt.session_id,
      cwd: evt.cwd || "",
      agent_name: evt.agent_name || null,
      model: evt.model || null,
      last_ts: evt.ts || new Date().toISOString(),
      first_ts: evt.ts || new Date().toISOString(),
      has_shutdown: false,
      event_count: 1,
      tags: [],
    };
    STATE.sessions.unshift(session);
    STATE.sessionsSig = ""; // force sidebar rebuild
    debounce(renderSessions, 200)();
  }
  if (!session) return;
  // Lifecycle events update has_shutdown.
  if (evt.type === "session_start") session.has_shutdown = false;
  if (evt.type === "session_shutdown") session.has_shutdown = true;
  // Advance last_ts so the subagentStatus() green window stays current.
  if (evt.ts) session.last_ts = evt.ts;
}

// ─── Clear all ──────────────────────────────────────────────────────────────

document.getElementById("btn-clear-all")?.addEventListener("click", clearAllSessions);

// ─── Helpers ────────────────────────────────────────────────────────────────

function loadSidebarCollapsed() {
  return localStorage.getItem("scope-sidebar-collapsed") === "1";
}

function loadTheme() {
  return localStorage.getItem("scope-theme") === "dark" ? "dark" : "light";
}

// ─── Exports to window.SCOPE ──────────────────────────────────────────────────

Object.assign(window.SCOPE, {
  getState: () => STATE,
  fetchSessionEvents, renderSessions, apiUrl, authHeaders,
  saveURLState,
  computeAgentInfo,
});

// ─── Boot ───────────────────────────────────────────────────────────────────

loadURLState();
setTheme(STATE.theme);
// Restore a user-overridden working directory; else fall back to the server cwd.
STATE.cwd = localStorage.getItem("scope-cwd") || "";
setView(STATE.view);
applySidebarCollapsed();
fetchSessions();
connectSSE();
setInterval(() => { fetchSessions(); }, 10000);
initCwd();

const cwdInput = document.getElementById("terminal-cwd");
if (cwdInput) cwdInput.addEventListener("change", () => setCwd(cwdInput.value.trim()));

function setCwd(cwd) {
  STATE.cwd = cwd || "";
  try { localStorage.setItem("scope-cwd", STATE.cwd); } catch {}
  const inp = document.getElementById("terminal-cwd");
  if (inp && inp.value !== STATE.cwd) inp.value = STATE.cwd;
  if (STATE.view === "files") window.__filesOnView?.();
  else if (STATE.view === "checkpoints") window.__checkpointsOnView?.();
  else if (STATE.view === "git") window.__gitOnView?.();
}
// Called by the terminal bridge when the live shell cwd changes, so the
// shared session directory follows the terminal automatically.
window.__setCwd = function (cwd) {
  const inp = document.getElementById("terminal-cwd");
  if (inp && document.activeElement === inp) return; // don't fight live typing
  setCwd(cwd);
};
async function initCwd() {
  const inp = document.getElementById("terminal-cwd");
  if (inp && !inp.value) inp.value = STATE.cwd;
  if (STATE.cwd) return; // user override already in place
  try {
    const res = await fetch(window.apiUrl("/health", {}), { headers: window.authHeaders() });
    const data = await res.json();
    if (data.cwd) {
      STATE.cwd = data.cwd;
      if (inp) inp.value = STATE.cwd;
      if (STATE.view === "files") window.__filesOnView?.();
      else if (STATE.view === "checkpoints") window.__checkpointsOnView?.();
      else if (STATE.view === "git") window.__gitOnView?.();
    }
  } catch {}
}

})();
