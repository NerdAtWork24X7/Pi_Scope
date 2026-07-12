/**
 * race.js — Pi Scope Race mode.
 * Horizontal per-agent tracks grouped by concrete turn_start → turn_end chunks.
 * IIFE-wrapped. Uses window.SCOPE helpers from app.js.
 */
(function() {

const STATE = window.__SCOPE_STATE;
const O = window.SCOPE;
const {
  summaryFor, summaryClass, turnFinalResponse, renderDetailHTML, fmtTs, trunc, shortId,
  fetchSessionEvents, renderSessions, apiUrl, authHeaders, fmtRel, fmtTokens,
  saveURLState, escapeHtml, toolNamePillHTML
} = O;

const TRACKS = new Map();
let autoAddRaceTracks = true;
let raceSSEResynced = false;
let openEventId = null;

const raceContainer = document.getElementById("race-container");
const raceEmpty = document.getElementById("race-empty");
const inspector = document.getElementById("race-inspector");
const inspectorTitle = document.getElementById("race-inspector-title");
const inspectorBody = document.getElementById("race-inspector-body");
const inspectorClose = document.getElementById("race-inspector-close");
const inspectorCopy = document.getElementById("race-inspector-copy");
const inspectorWrap = document.getElementById("race-inspector-wrap");
const raceRollup = document.getElementById("race-rollup");
let stickToRight = true;
let currentInspectorEvent = null;

if (raceContainer) {
  raceContainer.addEventListener("scroll", () => {
    const rightGap = raceContainer.scrollWidth - raceContainer.scrollLeft - raceContainer.clientWidth;
    stickToRight = rightGap < 80;
  });
}
if (inspectorClose) inspectorClose.addEventListener("click", closeInspector);
if (inspectorCopy) inspectorCopy.addEventListener("click", () => {
  if (!currentInspectorEvent) return;
  navigator.clipboard?.writeText(JSON.stringify(currentInspectorEvent.payload, null, 2)).catch(() => {});
});
if (inspectorWrap) inspectorWrap.addEventListener("click", () => {
  const activePanel = inspectorBody?.querySelector(".race-inspector-tabpanel:not([hidden])")
    || inspectorBody?.querySelector(".race-inspector-detail:not(.race-inspector-detail-tabbed)");
  const pre = activePanel?.querySelector("pre");
  if (!pre) return;
  pre.style.whiteSpace = pre.style.whiteSpace === "pre-wrap" ? "pre" : "pre-wrap";
  inspectorWrap.textContent = pre.style.whiteSpace === "pre-wrap" ? "→" : "↩";
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && inspector?.classList.contains("open")) closeInspector();
});

// ─── Hooks called from app.js ────────────────────────────────────────────────

window.__raceOnView = function() {
  for (const [sid, track] of TRACKS) {
    const sess = STATE.sessions.find(s => s.session_id === sid);
    if (sess) track.session = sess;
  }
  renderAllTracks();
};

window.__raceOnSessions = function() {
  for (const s of STATE.sessions) {
    if (TRACKS.has(s.session_id)) TRACKS.get(s.session_id).session = s;
  }
  renderAllTracks();
  renderSessions();
};

window.__raceOnReconnect = function() {
  raceSSEResynced = false;
  resyncAllTracks().then(() => { raceSSEResynced = true; });
};

window.__raceOnEvent = function(evt) { routeSSEEvent(evt); };

window.__raceIsSelected = sid => TRACKS.has(sid);

window.__raceToggle = function(sid) {
  if (TRACKS.has(sid)) destroyTrack(sid);
  else {
    createTrack(sid);
    window.__SCOPE_STATE?.ackd?.add(sid);
  }
  renderSessions();
  renderAllTracks();
  saveURLState();
};

window.__raceEnsureLane = function(sid) {
  if (!sid || TRACKS.has(sid)) return;
  createTrack(sid);
  renderSessions();
  renderAllTracks();
  saveURLState();
};

window.__raceGetLanes = () => Array.from(TRACKS.keys());
window.__raceGetAll = () => TRACKS;
window.__raceGetOpenEventId = () => openEventId;
window.__raceAutoAddChange = function(val) { autoAddRaceTracks = val; };

window.__raceStatsUpdate = function(sid, stats) {
  const track = TRACKS.get(sid);
  if (!track) return;
  track.costStr = `$${stats.total_cost.toFixed(4)} · ${fmtTokens(stats.total_tokens)} tk`;
  renderTrack(sid);
};

window.__raceCloseInspector = closeInspector;
// Shared with app.js (Single view system-prompt modal) so the same boot-snapshot
// LLM-request rendering is reused rather than duplicated.
window.renderLLMRequestHTML = renderLLMRequestHTML;

// ─── Track lifecycle ────────────────────────────────────────────────────────

function createTrack(sid) {
  if (TRACKS.has(sid) || !raceContainer) return;
  const sess = STATE.sessions.find(s => s.session_id === sid);
  const el = document.createElement("div");
  el.className = "race-track";
  el.dataset.sid = sid;
  raceContainer.appendChild(el);

  const stats = STATE.sessionStats[sid];
  const costStr = stats ? `$${stats.total_cost.toFixed(4)} · ${fmtTokens(stats.total_tokens)} tk` : "";
  TRACKS.set(sid, { session: sess, events: [], lastSeq: -1, el, costStr, activeGroupKey: null });
  updateEmpty();
  loadTrackEvents(sid);
}

function destroyTrack(sid) {
  const track = TRACKS.get(sid);
  if (!track) return;
  track.el?.remove?.();
  TRACKS.delete(sid);
  updateRaceRollup();
  updateEmpty();
  if (TRACKS.size === 0) closeInspector();
}

async function loadTrackEvents(sid) {
  const track = TRACKS.get(sid);
  if (!track) return;
  const events = await fetchSessionEvents(sid);
  if (!TRACKS.has(sid)) return;
  track.events = events || [];
  track.lastSeq = track.events.length ? track.events[track.events.length - 1].seq : -1;
  renderTrack(sid);
  maybeRestoreInspector(track);
}

async function resyncAllTracks() {
  const ps = [];
  for (const [sid, track] of TRACKS) {
    if (track.lastSeq >= 0) {
      ps.push(fetchSessionEvents(sid, track.lastSeq).then(events => {
        if (!events?.length) return;
        for (const evt of events) {
          if (evt.seq > track.lastSeq) {
            track.events.push(evt);
            track.lastSeq = evt.seq;
          }
        }
        renderTrack(sid);
        maybeRestoreInspector(track);
      }));
    } else ps.push(loadTrackEvents(sid));
  }
  await Promise.allSettled(ps);
}

function routeSSEEvent(evt) {
  if (!TRACKS.has(evt.session_id)) {
    if (autoAddRaceTracks) createTrack(evt.session_id);
    else return;
  }
  const track = TRACKS.get(evt.session_id);
  if (!track || evt.seq <= track.lastSeq) return;
  track.events.push(evt);
  track.lastSeq = evt.seq;
  renderTrack(evt.session_id);
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function renderAllTracks() {
  for (const [sid] of TRACKS) renderTrack(sid);
  updateRaceRollup();
  updateEmpty();
  if (stickToRight) scrollRaceToRight();
}

function renderTrack(sid) {
  const track = TRACKS.get(sid);
  if (!track?.el) return;
  const sess = STATE.sessions.find(s => s.session_id === sid) || track.session;
  if (sess) track.session = sess;
  const name = sess?.agent_name ?? sess?.cwd?.split("/").pop() ?? shortId(sid);
  const groups = buildTurnGroups(track.events);
  const latest = track.events[track.events.length - 1];
  const model = sess?.model ? ` · ${escapeHtml(sess.model)}` : "";

  track.el.innerHTML = "";

  const agent = document.createElement("div");
  agent.className = "race-agent-card";
  agent.innerHTML = `
    <div class="race-agent-name" title="${escapeHtml(sid)}">${escapeHtml(name)}</div>
    <div class="race-agent-meta"><code>${escapeHtml(shortId(sid))}</code>${model}</div>
    <div class="race-agent-meta">${track.events.length} events${latest ? ` · ${fmtRel(latest.ts)}` : ""}</div>
    ${track.costStr ? `<div class="race-agent-cost">${escapeHtml(track.costStr)}</div>` : ""}
  `;

  const turns = document.createElement("div");
  turns.className = "race-turns";
  if (!groups.length) {
    turns.innerHTML = '<div class="race-empty-track">loading events…</div>';
  } else {
    let activeIdx = track.activeGroupKey ? groups.findIndex(g => g.key === track.activeGroupKey) : -1;
    if (activeIdx < 0) activeIdx = groups.length - 1;
    track.activeGroupKey = groups[activeIdx]?.key ?? null;
    groups.forEach((group, idx) => turns.appendChild(buildTurnGroup(track, group, idx === activeIdx)));
  }

  track.el.appendChild(agent);
  track.el.appendChild(turns);
  updateRaceRollup();
  if (stickToRight) scrollRaceToRight();
}

function buildTurnGroup(track, group, active) {
  const wrap = document.createElement("div");
  wrap.className = "race-turn-group" + (active ? " active" : " collapsed");
  const label = group.setup ? "setup" : `turn ${group.turnIndex ?? group.ordinal}`;
  const prompt = group.prompt ? trunc(group.prompt, active ? 92 : 30) : `${group.events.length} events`;

  if (!active) {
    const last = group.events[group.events.length - 1];
    wrap.title = `${label} · ${group.events.length} events${prompt ? ` · ${prompt}` : ""}`;
    const teCollapsed = group.events.find(e => e.type === "turn_end");
    const frCollapsed = teCollapsed ? turnFinalResponse(teCollapsed, group.events) : "";
    wrap.innerHTML = `
      <div class="race-turn-collapsed">
        <span class="race-turn-label">${escapeHtml(label)}</span>
        <span class="race-turn-collapsed-count">${group.events.length} events</span>
        <span class="race-turn-collapsed-prompt">${escapeHtml(prompt)}</span>
        ${frCollapsed ? `<span class="race-turn-collapsed-final">${escapeHtml(trunc(frCollapsed, 120))}</span>` : ""}
      </div>
    `;
    wrap.addEventListener("click", () => {
      track.activeGroupKey = group.key;
      renderTrack(group.sid);
      saveURLState();
    });
    return wrap;
  }

  const head = document.createElement("div");
  head.className = "race-turn-head";
  head.innerHTML = `<span class="race-turn-label">${escapeHtml(label)}</span><span class="race-turn-prompt" title="${escapeHtml(prompt)}">${escapeHtml(prompt)}</span>`;

  const events = document.createElement("div");
  events.className = "race-events";
  for (const evt of group.events) events.appendChild(buildRaceEvent(track, evt));

  const te = group.events.find(e => e.type === "turn_end");
  const fr = te ? turnFinalResponse(te, group.events) : "";
  const finalBlock = fr
    ? `<div class="race-turn-final"><div class="race-turn-final-label">final response</div><pre>${escapeHtml(fr)}</pre></div>`
    : `<div class="race-turn-final empty"><div class="race-turn-final-label">final response</div><div class="race-llm-empty">no final response captured</div></div>`;

  wrap.appendChild(head);
  wrap.appendChild(events);
  wrap.insertAdjacentHTML("beforeend", finalBlock);
  return wrap;
}

function buildRaceEvent(track, evt) {
  const node = document.createElement("div");
  node.className = `race-event ${evt.type}`;
  node.title = summaryFor(evt);
  node.innerHTML = `
    <div class="race-event-top"><span class="pill ${evt.type}">${evt.type.replace(/_/g," ")}</span>${toolNamePillHTML(evt)}</div>
    <div class="race-event-summary ${summaryClass(evt, track.events)}">${escapeHtml(summaryFor(evt, track.events))}</div>
    <div class="race-event-time">${fmtTs(evt.ts)} · #${evt.seq}</div>
  `;
  node.addEventListener("click", () => openInspector(track, evt));
  return node;
}

function buildTurnGroups(events) {
  const groups = [];
  let current = null;
  let ordinal = 0;

  function makeGroup(evt, setup = false) {
    const g = {
      ordinal: setup ? "setup" : ++ordinal,
      setup,
      turnIndex: evt?.payload?.turn_index ?? null,
      prompt: "",
      sid: evt?.session_id ?? "",
      key: "",
      events: [],
      turnStarted: false,
      closed: false,
    };
    groups.push(g);
    return g;
  }

  for (const evt of [...events].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) {
    if (evt.type === "user_message") {
      if (current && current.events.length && !current.closed && current.turnStarted) current.closed = true;
      current = makeGroup(evt);
      current.prompt = evt.payload?.text ?? "user prompt";
      current.events.push(evt);
      continue;
    }

    if (evt.type === "turn_start") {
      if (!current || current.closed || current.turnStarted || current.setup) current = makeGroup(evt);
      current.turnStarted = true;
      current.turnIndex = evt.payload?.turn_index ?? current.turnIndex;
      current.events.push(evt);
      continue;
    }

    if (!current) current = makeGroup(evt, true);
    current.events.push(evt);

    if (evt.payload?.turn_index != null && current.turnIndex == null) current.turnIndex = evt.payload.turn_index;
    if (evt.type === "turn_end") {
      current.turnIndex = evt.payload?.turn_index ?? current.turnIndex;
      current.closed = true;
    }
  }
  const filtered = groups.filter(g => g.events.length);
  for (const g of filtered) {
    const firstSeq = g.events[0]?.seq ?? "x";
    const turnPart = g.setup ? "setup" : (g.turnIndex ?? g.ordinal);
    g.key = `${g.events[0]?.session_id ?? g.sid}:turn:${turnPart}:first:${firstSeq}`;
  }
  return filtered;
}

// ─── Inspector ──────────────────────────────────────────────────────────────

function openInspector(track, evt) {
  if (!inspector || !inspectorTitle || !inspectorBody) return;
  openEventId = evt.event_id;
  currentInspectorEvent = evt;
  if (inspectorWrap) inspectorWrap.textContent = "↩";
  const sess = track.session || STATE.sessions.find(s => s.session_id === evt.session_id);
  const name = sess?.agent_name ?? sess?.cwd?.split("/").pop() ?? shortId(evt.session_id);
  inspectorTitle.textContent = evt.type.replace(/_/g, " ");

  const metaHTML = `
    <div class="race-inspector-meta">
      <span>agent</span><span title="${escapeHtml(evt.session_id)}">${escapeHtml(name)} · ${escapeHtml(shortId(evt.session_id))}</span>
      <span>time</span><span>${escapeHtml(fmtTs(evt.ts))}</span>
      <span>seq</span><span>${evt.seq}</span>
      <span>type</span><span><span class="pill ${evt.type}">${evt.type.replace(/_/g," ")}</span>${toolNamePillHTML(evt)}</span>
    </div>
    <div class="race-inspector-summary">${escapeHtml(summaryFor(evt))}</div>
  `;

  // user_message fires the LLM request that costs tokens; surface the boot
  // snapshot (system prompt + tools + other system-prompt options) captured on
  // the first agent_start of the session in a dedicated tab.
  if (evt.type === "user_message") {
    const snap = findBootSnapshot(track, evt);
    inspectorBody.innerHTML = `
      ${metaHTML}
      <div class="race-inspector-detail race-inspector-detail-tabbed">
        <div class="race-inspector-tabs">
          <button class="race-inspector-tab active" data-tab="payload">payload</button>
          <button class="race-inspector-tab" data-tab="llm">llm request</button>
        </div>
        <div class="race-inspector-tabpanel" data-panel="payload"><pre class="race-llm-json">${escapeHtml(JSON.stringify(evt.payload, null, 2))}</pre></div>
        <div class="race-inspector-tabpanel" data-panel="llm" hidden>${renderLLMRequestHTML(snap ? snap.payload : null)}</div>
      </div>
    `;
    wireInspectorTabs();
  } else {
    inspectorBody.innerHTML = `
      ${metaHTML}
      <div class="race-inspector-detail"><pre>${escapeHtml(JSON.stringify(evt.payload, null, 2))}</pre></div>
    `;
  }
  inspector.classList.add("open");
  raceContainer?.classList.add("inspecting");
  inspector.setAttribute("aria-hidden", "false");
  saveURLState();
}

// Prefer the FINAL system prompt captured from the real LLM request
// (before_provider_request → llm_request event). The system prompt AND its
// options digest now come solely from llm_request — agent_start no longer carries
// any system-prompt data. findBootSnapshot therefore degrades to finalReq.
function findBootSnapshot(track, evt) {
  let finalReq = null, finalSeq = -1;
  for (const e of (track?.events || [])) {
    if (e.seq > evt.seq) continue;
    if (e.type === "llm_request" && e.payload?.system_prompt) {
      if (e.seq >= finalSeq) { finalReq = e; finalSeq = e.seq; }
    }
  }
  return finalReq;
}

function wireInspectorTabs() {
  if (!inspectorBody) return;
  const tabs = inspectorBody.querySelectorAll(".race-inspector-tab");
  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      const which = tab.dataset.tab;
      inspectorBody.querySelectorAll(".race-inspector-tab").forEach(t => t.classList.toggle("active", t === tab));
      inspectorBody.querySelectorAll(".race-inspector-tabpanel").forEach(p => {
        p.hidden = p.dataset.panel !== which;
      });
    });
  });
}

function renderLLMRequestHTML(payload) {
  if (!payload) {
    return `<div class="race-llm-empty">No system prompt captured. It is recorded from the final LLM request (before_provider_request → llm_request) only.</div>`;
  }
  const parts = [];
  parts.push(`
    <section class="race-llm-section">
      <h4>System prompt</h4>
      ${payload.system_prompt ? `<pre class="race-llm-pre">${escapeHtml(payload.system_prompt)}</pre>` : `<div class="race-llm-empty">not captured</div>`}
    </section>
  `);

  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  const toolsHTML = tools.length
    ? `<ul class="race-llm-tools">` + tools.map(t => `<li><code>${escapeHtml(t)}</code></li>`).join("") + `</ul>`
    : `<div class="race-llm-empty">no tools captured</div>`;
  parts.push(`<section class="race-llm-section"><h4>Tools (${tools.length}) sent to LLM</h4>${toolsHTML}</section>`);

  if (payload.model) parts.push(`<section class="race-llm-section"><h4>Model</h4><div class="race-llm-empty">${escapeHtml(payload.model)}</div></section>`);
  if (payload.message_count != null) parts.push(`<section class="race-llm-section"><h4>Messages</h4><div class="race-llm-empty">${payload.message_count}</div></section>`);

  return parts.join("");
}

function maybeRestoreInspector(track) {
  const eid = window.__restoreRaceEventId;
  if (!eid || openEventId) return;
  const evt = track.events.find(e => e.event_id === eid);
  if (!evt) return;
  window.__restoreRaceEventId = null;
  openInspector(track, evt);
}

function closeInspector() {
  if (!inspector) return;
  openEventId = null;
  currentInspectorEvent = null;
  inspector.classList.remove("open");
  raceContainer?.classList.remove("inspecting");
  inspector.setAttribute("aria-hidden", "true");
  saveURLState();
}

function updateRaceRollup() {
  if (!raceRollup) return;
  let cost = 0, tokens = 0;
  for (const [sid, track] of TRACKS) {
    const stats = STATE.sessionStats[sid];
    if (stats) {
      cost += stats.total_cost ?? 0;
      tokens += stats.total_tokens ?? 0;
      continue;
    }
    for (const evt of track.events) {
      if (evt.type !== "assistant_message") continue;
      const u = evt.payload?.usage;
      if (!u) continue;
      cost += u.cost_total ?? 0;
      tokens += u.total_tokens ?? 0;
    }
  }
  raceRollup.textContent = `$${cost.toFixed(4)} · ${fmtTokens(tokens)} tk`;
}

function scrollRaceToRight() {
  if (!raceContainer) return;
  const go = () => { raceContainer.scrollLeft = raceContainer.scrollWidth; };
  go();
  requestAnimationFrame(go);
}

function updateEmpty() {
  if (raceEmpty) raceEmpty.style.display = TRACKS.size ? "none" : "flex";
}

// 250ms periodic re-anchor to the right for Race mode (pin unless scrolled left)
setInterval(() => {
  if (STATE.view === "race" && stickToRight) {
    scrollRaceToRight();
  }
}, 250);

})();
