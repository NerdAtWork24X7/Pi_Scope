/**
 * chat.js — Pi Scope "Chat" view (modern redesign, 2026).
 *
 * A polished, chat-style lens over the agent telemetry already ingested by Pi
 * Scope — and a real interactive channel to the pi coding agent running in a
 * workspace:
 *
 *   left rail   — Workspaces (unique working directories, grouped from sessions)
 *   center      — the conversation as rich chat messages (markdown, thinking,
 *                 tool activity, usage badges) + a composer that sends prompts
 *                 to the pi agent via POST /chat (SSE/NDJSON stream)
 *   right rail  — the Agent Team (agents/subagents that ran in the workspace)
 *
 * Conversation rendering is "stream-first, markdown-last": while pi streams a
 * turn we append raw deltas (text / thinking / tool chips) straight into the
 * live message DOM, and once the turn completes we re-render the history with
 * the full markdown formatter so the final message looks clean.
 *
 * IIFE-wrapped for scope isolation. Exposes window.__chatOnView / __chatOnSessions
 * which app.js calls on view change and session poll.
 */
(function () {
  const S = window.SCOPE;
  const state = window.__SCOPE_STATE;
  const $ = (s) => document.querySelector(s);
  const esc = S.escapeHtml;
  const fmtTs = (ts) => {
    try { return new Date(ts).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" }); }
    catch { return ""; }
  };

  // ─── Persisted UI state (workspace expansion + agent-team section collapse) ─
  function loadExpandedWs() {
    try { return JSON.parse(localStorage.getItem("scope-chat-ws-expanded") || "[]"); } catch { return []; }
  }
  function saveExpandedWs() {
    try { localStorage.setItem("scope-chat-ws-expanded", JSON.stringify([...CH.expandedWs])); } catch {}
  }
  function loadCollapsedSecs() {
    try { return JSON.parse(localStorage.getItem("scope-chat-team-collapsed") || "[]"); } catch { return []; }
  }
  function saveCollapsedSecs() {
    try { localStorage.setItem("scope-chat-team-collapsed", JSON.stringify([...CH.collapsedSecs])); } catch {}
  }

  // ─── Chat state ───────────────────────────────────────────────────────────
  const CH = {
    workspace: null,   // selected cwd
    agentId: null,     // selected session_id (legacy, kept for compat)
    model: "all",
    query: "",
    chatModel: null,   // model used for the live chat
    chatSessionId: null,
    resumeFile: null,  // pi session file to continue (set when a recorded session is opened)
    chatBusy: false,
    chatHistory: [],   // [{role:'user'|'assistant', text, thinking, tools, usage, model, ts, streaming}]
    adding: false,     // inline "add workspace" input is open
    events: [],
    sessions: [],
    teamData: null,    // /agent-team snapshot (teams.yaml + config.json)
    team: null,        // which team's subagents are shown in the right rail
    lastEventCount: -1,
    loadingSid: null,  // session whose events are being fetched into the window
    openSid: null,     // session_id whose transcript is currently shown (timeline target)
    lastOpenCount: null, // event_count of the open session at last load — refetch when it grows
    expandedWs: new Set(loadExpandedWs()),
    collapsedSecs: new Set(loadCollapsedSecs()),
  };

  const el = {};
  let restoreAttempted = false; // conversation snapshot restored once per page load

  function cache() {
    el.ws = $("#chat-workspaces");
    el.wsAdd = $("#chat-ws-add");
    el.agents = $("#chat-agents");
    el.msg = $("#chat-messages");
    el.canvas = document.querySelector(".chat-canvas");
    el.name = $("#chat-name");
    el.sub = $("#chat-sub");
    el.avatar = $("#chat-avatar");
    el.state = $("#chat-header-state");
    el.model = $("#chat-model");
    el.input = $("#chat-input");
    el.send = $("#chat-send");
    el.hint = $("#chat-composer-hint");
    el.composerStatus = $("#chat-composer-status");
    el.agentCount = $("#chat-agent-count");
    el.headerModel = $("#chat-header-model");
    el.liveDot = $("#chat-live-dot");
    el.scrollDown = $("#chat-scroll-down");
    el.btnNew = $("#chat-new");
    el.btnOpen = $("#chat-open-session");
    el.toggleLeft = $("#chat-toggle-left");
    el.toggleRight = $("#chat-toggle-right");
    el.composer = $("#chat-composer");
  }

  // ─── Selectors / data ─────────────────────────────────────────────────────
  function workspaces() {
    const map = {};
    for (const s of CH.sessions) {
      const cwd = s.cwd || "(unknown)";
      (map[cwd] = map[cwd] || []).push(s);
    }
    const custom = (CH.teamData?.chatWorkspaces || []);
    for (const cwd of custom) if (!map[cwd]) map[cwd] = [];
    const removed = new Set(CH.teamData?.chatWorkspacesRemoved || []);
    return Object.keys(map)
      .filter((cwd) => !removed.has(cwd))
      .sort((a, b) => (a === "(unknown)" ? 1 : b === "(unknown)" ? -1 : a.localeCompare(b)));
  }

  function wsSessions(cwd) {
    return CH.sessions.filter((s) => (s.cwd || "(unknown)") === cwd);
  }

  // ─── Public hooks (called from app.js) ────────────────────────────────────
  // Cheap signature of the session list + active team, used to skip full rail
  // rebuilds when the poll has nothing new to show.
  let railSig = null;
  function chatRailSig() {
    const ss = CH.sessions;
    let h = ss.length;
    for (let i = 0; i < ss.length; i++) {
      const s = ss[i];
      h = ((h * 31 + (s.event_count || 0)) | 0);
      h = ((h * 31 + (s.last_ts || 0)) | 0);
    }
    return h + ":" + (CH.teamData?.activeTeam || "");
  }

  function onSessions() {
    CH.sessions = state.sessions || [];
    loadAgentTeam();
    renderComposerModel();
    // Rebuild the workspace + agent rails only when their data actually changed
    // (new sessions, new events, team switch). The poll fires every few seconds
    // and full rail rebuilds are expensive DOM churn otherwise.
    const sig = chatRailSig();
    if (sig !== railSig) {
      railSig = sig;
      renderWorkspaces();
      renderAgents();
    }
    if (!CH.chatBusy) {
      // Header state + composer status depend on per-session stats that update
      // on polls; the message list itself only changes through explicit actions
      // (send / load session / new session), which re-render on their own.
      updateHeader();
      renderComposerStatus();
      updateScrollDown();
    }
    if (!CH.workspace) {
      const ws = workspaces();
      if (ws.length) selectWorkspace(preferredWorkspace(ws));
    }
    attemptRestore();
    refreshOpenSession();
  }

  function onView() {
    CH.sessions = state.sessions || [];
    loadAgentTeam();
    if (!CH.workspace) {
      const ws = workspaces();
      if (ws.length) selectWorkspace(preferredWorkspace(ws));
    }
    renderWorkspaces();
    renderAgents();
    renderComposerModel();
    renderChat();
    attemptRestore();
    refreshOpenSession();
  }

  // ─── Workspace rail (left) ────────────────────────────────────────────────
  // Human-readable pi status + colors for a subagent-status value.
  function piStatusMeta(st) {
    return st === "green"
      ? { word: "working", dot: "green", cls: "live" }
      : st === "orange"
        ? { word: "waiting", dot: "orange", cls: "warn" }
        : st === "red"
          ? { word: "stopped", dot: "red", cls: "off" }
          : { word: "idle", dot: "gray", cls: "off" };
  }

  // Aggregate status for a workspace: any live agent wins, then waiting,
  // then stopped; otherwise idle.
  function wsPiStatus(sessions) {
    const seen = new Set(sessions.map((s) => S.subagentStatus(s)));
    let st = "gray";
    if (seen.has("green")) st = "green";
    else if (seen.has("orange")) st = "orange";
    else if (seen.has("red")) st = "red";
    return piStatusMeta(st);
  }

  function renderWorkspaces() {
    if (!el.ws) return;
    const ws = workspaces();
    const canBrowse = typeof window.scopeNative?.pickDirectory === "function";
    let html = "";
    if (CH.adding) {
      html +=
        `<div class="chat-ws-add-row">` +
        `<div class="chat-ws-add-fields">` +
        `<input class="chat-ws-add-input" id="chat-ws-add-input" type="text" placeholder="/path/to/workspace" spellcheck="false" autocomplete="off" />` +
        (canBrowse
          ? `<button class="chat-ws-browse" id="chat-ws-browse" type="button" title="Browse for a directory">Browse…</button>`
          : "") +
        `</div>` +
        `<div class="chat-ws-add-err" id="chat-ws-add-err"></div>` +
        `</div>`;
    }
    if (!ws.length && !CH.adding) {
      el.ws.innerHTML =
        '<div class="chat-rail-empty">No workspaces yet.<br>Add a directory or run a pi agent to start streaming.</div>' +
        html;
      wireWorkspaces();
      return;
    }
    for (const cwd of ws) {
      const sessions = wsSessions(cwd);
      const name = cwd.split("/").filter(Boolean).pop() || cwd;
      const active = CH.workspace === cwd ? " active" : "";
      const pst = wsPiStatus(sessions);
      const hasErr = sessions.some((s) => (state.sessionStats?.[s.session_id]?.error_count || 0) > 0);
      const expanded = CH.expandedWs.has(cwd);
      const letter = esc((name.charAt(0) || "?").toUpperCase());
      const meta = [
        pst.word + (hasErr ? " · ⚠ review" : ""),
        sessions.length ? `${sessions.length} session${sessions.length === 1 ? "" : "s"}` : "no sessions",
      ].join(" · ");
      html +=
        `<div class="chat-ws${active}" data-cwd="${esc(cwd)}" title="${esc(cwd)}">` +
        `<span class="chat-ws-caret">${expanded ? "▾" : "▸"}</span>` +
        `<span class="chat-ws-icon">${letter}</span>` +
        `<div class="chat-ws-body">` +
        `<div class="chat-ws-name">${esc(name)}</div>` +
        `<div class="chat-ws-meta ${pst.cls}">${esc(meta)}</div>` +
        `</div>` +
        `<span class="chat-ws-dot ${pst.dot}" title="${esc(pst.word)}"></span>` +
        `<span class="chat-ws-remove" data-remove="${esc(cwd)}" title="Remove workspace">&times;</span>` +
        `</div>`;
      html +=
        `<div class="chat-ws-children"${expanded ? "" : ' style="display:none"'}>` +
        sessions.map((s) => renderWsSession(s)).join("") +
        `</div>`;
    }
    el.ws.innerHTML = html;
    wireWorkspaces();
  }

  // One session row under a workspace — clicking loads it in the chat window.
  // The row stays minimal (status dot + first message); the session message
  // and status live in the hover tooltip, and the model / token usage / time
  // are shown in the composer status line below the input.
  function renderWsSession(s) {
    const name = s.agent_name ?? s.cwd?.split("/").pop() ?? S.shortId(s.session_id);
    const st = S.subagentStatus(s);
    const stMeta = piStatusMeta(st);
    const stats = state.sessionStats[s.session_id];
    const hasErr = (stats?.error_count || 0) > 0;
    const row1 = s.first_msg ? S.trunc(s.first_msg, 46) : name;
    const statusText = stMeta.word + (hasErr ? " ⚠ needs review" : "");
    const tip = (s.first_msg ? s.first_msg : name) + (statusText ? " — " + statusText : "");
    return (
      `<div class="ws-sess" data-sid="${esc(s.session_id)}" title="${esc(tip)}">` +
      `<span class="status-dot ${st}"></span>` +
      `<div class="ws-sess-body">` +
      `<div class="ws-sess-name" title="${s.first_msg ? esc(s.first_msg) : esc(name)}">${esc(row1)}</div>` +
      `</div>` +
      `<span class="ws-sess-del" data-del="${esc(s.session_id)}" title="Delete this session">&times;</span>` +
      `</div>`
    );
  }

  function toggleWs(cwd) {
    if (CH.expandedWs.has(cwd)) CH.expandedWs.delete(cwd);
    else CH.expandedWs.add(cwd);
    saveExpandedWs();
    renderWorkspaces();
  }

  function wireWorkspaces() {
    el.ws.querySelectorAll(".chat-ws").forEach((n) =>
      n.addEventListener("click", (e) => {
        if (e.target.closest(".chat-ws-remove")) return; // handled by its own listener
        const cwd = n.dataset.cwd;
        if (CH.workspace !== cwd) selectWorkspace(cwd);
        else toggleWs(cwd);
      })
    );
    el.ws.querySelectorAll(".chat-ws-remove").forEach((n) =>
      n.addEventListener("click", (e) => {
        e.stopPropagation();
        removeWorkspace(n.dataset.remove);
      })
    );
    el.ws.querySelectorAll(".ws-sess").forEach((n) =>
      n.addEventListener("click", (e) => {
        e.stopPropagation();
        loadSessionChat(n.dataset.sid);
      })
    );
    el.ws.querySelectorAll(".ws-sess-del").forEach((n) =>
      n.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteChatSession(n.dataset.del);
      })
    );
    const input = document.getElementById("chat-ws-add-input");
    if (input) {
      input.focus();
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); submitAddWorkspace(); }
        else if (e.key === "Escape") { e.preventDefault(); CH.adding = false; renderWorkspaces(); }
      });
    }
    const browse = document.getElementById("chat-ws-browse");
    if (browse) {
      browse.addEventListener("click", async (e) => {
        e.preventDefault();
        if (typeof window.scopeNative?.pickDirectory !== "function") return;
        try {
          const dir = await window.scopeNative.pickDirectory();
          if (dir) submitAddWorkspace(dir);
        } catch { /* dialog failed — fall back to manual entry */ }
      });
    }
  }

  // Navigate to a session's timeline (single view) — mirrors the pi session
  // tree. selectSession is exposed by app.js; setView switches out of chat.
  function openSession(sid) {
    if (!sid) return;
    if (typeof window.SCOPE?.selectSession === "function") window.SCOPE.selectSession(sid);
    if (typeof window.setView === "function") window.setView("single");
  }

  // Delete a session from the workspace rail. Reuses the app's deleteSession
  // (confirm + DELETE + main-sidebar re-render); on success, clears any open
  // transcript and re-renders both chat rails immediately.
  function deleteChatSession(sid) {
    if (typeof window.SCOPE?.deleteSession !== "function") return;
    const p = window.SCOPE.deleteSession(sid);
    if (!p) return; // canceled by the user
    p.then(() => {
      if (CH.openSid === sid) {
        CH.openSid = null;
        CH.lastOpenCount = null;
        CH.chatHistory = [];
        CH.resumeFile = null;
        renderChat();
      }
      CH.sessions = state.sessions || [];
      railSig = chatRailSig();
      renderWorkspaces();
      renderAgents();
    });
  }

  async function submitAddWorkspace(picked) {
    const input = document.getElementById("chat-ws-add-input");
    const err = document.getElementById("chat-ws-add-err");
    const p = (picked ?? (input?.value || "")).trim();
    if (!p) { CH.adding = false; renderWorkspaces(); return; }
    try {
      const before = new Set(CH.teamData?.chatWorkspaces || []);
      const { res, data } = await window.SCOPE.api("/agent-team", {}, { action: "addWorkspace", path: p });
      if (res.ok && data) {
        CH.teamData = data;
        CH.adding = false;
        renderWorkspaces();
        const added = (data.chatWorkspaces || []).find((c) => !before.has(c));
        selectWorkspace(added || p);
      } else if (err) {
        err.textContent = data?.error || `HTTP ${res.status}`;
      }
    } catch (e) {
      if (err) err.textContent = String(e?.message || e);
    }
  }

  async function removeWorkspace(cwd) {
    try {
      const { res, data } = await window.SCOPE.api("/agent-team", {}, { action: "removeWorkspace", path: cwd });
      if (res.ok && data) CH.teamData = data;
    } catch { /* server unreachable — re-render from local state below */ }
    if (CH.workspace === cwd) {
      const ws = workspaces();
      CH.workspace = null;
      if (ws.length) { selectWorkspace(ws[0]); return; }
      resetChat();
      updateHeader();
    }
    renderWorkspaces();
    renderAgents();
  }

  // ─── Agent-team rail (right) ─────────────────────────────────────────────
  let teamFetchedAt = 0;
  async function loadAgentTeam() {
    // The /agent-team snapshot changes rarely; throttle the fetch so the 3s
    // session poll doesn't hammer the server and rebuild both rails every tick.
    const now = Date.now();
    if (teamFetchedAt && now - teamFetchedAt < 15000) {
      renderAgents();
      renderWorkspaces();
      return;
    }
    teamFetchedAt = now;
    const { res, data } = await window.SCOPE.api("/agent-team");
    if (res.ok && data) CH.teamData = data;
    renderAgents();
    renderWorkspaces();
  }

  // Persist a sidebar toggle via POST /agent-team, then reload the snapshot.
  async function postTeam(body) {
    try {
      const { res, data } = await window.SCOPE.api("/agent-team", {}, body);
      if (res.ok && data) CH.teamData = data;
    } catch { /* server unreachable — keep last snapshot */ }
    renderAgents();
  }

  function atSection(key, title, bodyHtml, opts) {
    opts = opts || {};
    const collapsed = CH.collapsedSecs.has(key);
    const caret = collapsed ? "▸" : "▾";
    return (
      `<div class="at-sec${collapsed ? " collapsed" : ""}" data-sec="${key}">` +
      `<div class="at-sec-head" data-sec="${key}" title="${opts.hint ? esc(opts.hint) : "Click to collapse"}">` +
      `<span class="at-caret">${caret}</span>` +
      `<span class="at-sec-title">${title}</span>` +
      (opts.count != null ? `<span class="at-sec-count">${opts.count}</span>` : "") +
      `</div>` +
      `<div class="at-sec-body"${collapsed ? ' style="display:none"' : ""}>${bodyHtml}</div>` +
      `</div>`
    );
  }

  function toggleSection(key) {
    if (CH.collapsedSecs.has(key)) CH.collapsedSecs.delete(key);
    else CH.collapsedSecs.add(key);
    saveCollapsedSecs();
    renderAgents();
  }

  function renderAgents() {
    if (!el.agents) return;
    const td = CH.teamData;
    if (!td || !td.teamsOrder || !td.teamsOrder.length) {
      renderAgentSessions();
      return;
    }

    const teams = td.teams || {};
    const teamNames = td.teamsOrder || Object.keys(teams);
    const activeTeam = td.activeTeam && teams[td.activeTeam] ? td.activeTeam : teamNames[0];
    const viewedTeam = CH.team && teams[CH.team] ? CH.team : activeTeam;
    const mode = td.mode || "standard";
    const memModel = td.memoryModel;
    const memActive = td.memoryActive;
    const disabled = new Set(td.disabledAgents || []);
    const wsSessionsArr = CH.workspace ? wsSessions(CH.workspace) : CH.sessions;
    const orch = wsSessionsArr.find((s) => (s.agent_name || "").toLowerCase() === "orchestrator") || wsSessionsArr[0];
    if (el.agentCount) el.agentCount.textContent = wsSessionsArr.length;

    let html = "";

    const orchSt = orch ? S.subagentStatus(orch) : "gray";
    html += atSection("orch", "Agent Team",
      `<div class="at-orch">` +
      `<span class="status-dot ${orchSt}"></span>` +
      `<span class="at-orch-name">Orchestrator</span></div>`
    );

    html += atSection("mode", "Mode & Memory",
      `<div class="at-rows">` +
      `<div class="at-row clickable" data-action="toggleMode" title="Click to toggle mode"><span class="at-k">Mode</span><span class="at-v">${mode === "creative" ? "◆ Creative" : "◇ Standard"}</span></div>` +
      `<div class="at-row clickable" data-action="toggleMemory" title="Click to toggle memory"><span class="at-k">Memory</span><span class="at-v">${memActive ? `● ${esc(memModel || "on")}` : "○ off"}</span></div>` +
      `</div>`
    );

    let teamBody = "";
    if (!teamNames.length) teamBody = `<div class="at-dim">No teams defined</div>`;
    else {
      for (const tn of teamNames) {
        const members = teams[tn] || [];
        const activeCount = members.filter((m) => m.active !== false && !disabled.has((m.name || "").toLowerCase())).length;
        const isActive = tn === activeTeam;
        const isViewed = tn === viewedTeam;
        teamBody +=
          `<div class="at-item${isViewed ? " active" : ""}" data-team="${esc(tn)}" title="${esc(tn)}">` +
          `<span class="at-item-mark">${isActive ? "●" : "○"}</span>` +
          `<span class="at-item-name">${esc(tn)}</span>` +
          `<span class="at-item-count">${activeCount}/${members.length}</span></div>`;
      }
    }
    html += atSection("teams", "Teams", teamBody, { count: teamNames.length });

    const members = teams[viewedTeam] || [];
    let subBody = "";
    if (!members.length) subBody = `<div class="at-dim">No agents loaded</div>`;
    else {
      for (const m of members) {
        const sess = wsSessionsArr.find((s) => (s.agent_name || "").toLowerCase() === (m.name || "").toLowerCase());
        const isDisabled = disabled.has((m.name || "").toLowerCase());
        const enabled = !isDisabled;
        const st = sess ? S.subagentStatus(sess) : "gray";
        const isActive = sess && CH.agentId === sess.session_id;
        subBody +=
          `<div class="at-item${isActive ? " active" : ""}${isDisabled ? " disabled" : " on"}" data-agent="${esc(m.name)}" title="${esc(m.name)}">` +
          `<span class="status-dot ${st}"></span>` +
          `<div class="at-item-body">` +
          `<div class="at-item-name">${esc(m.name)}${isDisabled ? ` <span class="at-off">off</span>` : ` <span class="at-on">on</span>`}</div>` +
          `</div></div>`;
      }
    }
    html += atSection("subagents", "Subagents", subBody, { count: members.length });

    const skills = td.skills || [];
    let skillBody = "";
    if (!skills.length) skillBody = `<div class="at-dim">no skills found</div>`;
    else {
      for (const sk of skills) {
        const on = sk.settingsEnabled;
        const sub = sk.subagent ? `<span class="at-sub">S</span>` : "";
        const orchTag = sk.orchestrator ? `<span class="at-sub">O</span>` : "";
        skillBody +=
          `<div class="at-item${on ? " on" : ""}" data-dir="${esc(sk.dir)}" title="${esc(sk.name)}${sk.description ? " — " + esc(sk.description) : ""}">` +
          `<span class="at-item-mark">${on ? "●" : "○"}</span>` +
          `<span class="at-item-name">${esc(sk.name)}</span>${orchTag}${sub}` +
          `</div>`;
      }
    }
    html += atSection("skills", "Skills", skillBody, { count: skills.length });

    const exts = td.extensions || [];
    let extBody = "";
    if (!exts.length) extBody = `<div class="at-dim">none enabled</div>`;
    else {
      for (const ex of exts) {
        extBody +=
          `<div class="at-item${ex.enabled ? " on" : ""}" data-path="${esc(ex.path)}" title="${esc(ex.path)}">` +
          `<span class="at-item-mark">${ex.enabled ? "●" : "○"}</span>` +
          `<span class="at-item-name">${esc(ex.name)}</span>` +
          `</div>`;
      }
    }
    html += atSection("extensions", "Extensions", extBody, { count: exts.length });

    el.agents.innerHTML = html;

    el.agents.querySelectorAll(".at-sec-head").forEach((n) =>
      n.addEventListener("click", () => toggleSection(n.dataset.sec))
    );
    el.agents.querySelectorAll(".at-item[data-team]").forEach((n) =>
      n.addEventListener("click", () => {
        const team = n.dataset.team;
        CH.team = team;
        postTeam({ action: "setTeam", team });
      })
    );
    el.agents.querySelectorAll(".at-row[data-action]").forEach((n) =>
      n.addEventListener("click", () => postTeam({ action: n.dataset.action }))
    );
    el.agents.querySelectorAll(".at-item[data-agent]").forEach((n) =>
      n.addEventListener("click", () => {
        const name = n.dataset.agent;
        postTeam({ action: "toggleAgent", agent: name, disabled: !disabled.has((name || "").toLowerCase()) });
      })
    );
    el.agents.querySelectorAll(".at-item[data-dir]").forEach((n) =>
      n.addEventListener("click", () => postTeam({ action: "toggleSkillSetting", dir: n.dataset.dir }))
    );
    el.agents.querySelectorAll(".at-item[data-path]").forEach((n) =>
      n.addEventListener("click", () => postTeam({ action: "toggleExtension", path: n.dataset.path }))
    );
  }

  // Fallback: plain session list for the workspace (no agent-team config).
  function renderAgentSessions() {
    let sessions = CH.workspace ? wsSessions(CH.workspace) : CH.sessions;
    sessions = sessions.slice().sort((a, b) => new Date(b.last_ts) - new Date(a.last_ts));
    if (el.agentCount) el.agentCount.textContent = sessions.length;
    if (!sessions.length) {
      el.agents.innerHTML = '<div class="chat-rail-empty">No agents in this workspace</div>';
      return;
    }
    let html = "";
    for (const s of sessions) {
      const active = CH.agentId === s.session_id ? " active" : "";
      const name = s.agent_name ?? s.cwd?.split("/").pop() ?? S.shortId(s.session_id);
      const st = S.subagentStatus(s);
      html +=
        `<div class="at-item${active}" data-sid="${s.session_id}" title="${esc(name)}">` +
        `<span class="status-dot ${st}"></span>` +
        `<div class="at-item-body">` +
        `<div class="at-item-name">${esc(name)}</div>` +
        `</div></div>`;
    }
    el.agents.innerHTML = html;
    el.agents.querySelectorAll(".at-item[data-sid]").forEach((n) =>
      n.addEventListener("click", () => loadSessionChat(n.dataset.sid))
    );
  }

  // ─── Selection ────────────────────────────────────────────────────────────
  async function selectWorkspace(cwd) {
    CH.workspace = cwd;
    CH.team = null;
    CH.expandedWs.add(cwd);
    saveExpandedWs();
    resetChat();
    renderWorkspaces();
    renderAgents();
    persistWorkspace();
    // NB: no clearSnapshot() here — attemptRestore() (called right after boot
    // auto-select) validates the stored snapshot's workspace and restores the
    // conversation, so wiping it here would defeat reload persistence.
  }

  function persistWorkspace() {
    try {
      if (CH.workspace) localStorage.setItem("scope-chat-workspace", CH.workspace);
      else localStorage.removeItem("scope-chat-workspace");
    } catch {}
  }

  function preferredWorkspace(list) {
    let saved = "";
    try { saved = localStorage.getItem("scope-chat-workspace") || ""; } catch {}
    if (saved && list.includes(saved)) return saved;
    return list[0];
  }

  // ─── Conversation persistence (last workspace + its chat thread) ─────────
  // The visible conversation — live replies or a session transcript — is kept
  // as a lightweight per-workspace snapshot, so a page reload brings it back
  // verbatim and ready to type in (never a read-only replay).
  const SNAP_KEY = "scope-chat-snapshot";
  const SNAP_MAX = 80;
  const SNAP_CAP = 8000;
  // In-memory cap for the live conversation. The visible thread is bounded so a
  // long-running chat can't accumulate every full message + thinking block in
  // RAM forever (the snapshot already caps at SNAP_MAX for reload).
  const CHAT_HISTORY_MAX = 300;
  // localStorage writes are synchronous and block the main thread; debounce the
  // snapshot so rapid consecutive turns don't each pay a multi-hundred-KB write.
  let persistTimer = null;
  function persistConversation() {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    if (!CH.workspace || !CH.chatHistory.length) { clearSnapshot(); return; }
    persistTimer = setTimeout(() => {
      persistTimer = null;
      try {
        const msgs = CH.chatHistory
          .slice(-SNAP_MAX)
          .filter((m) => !m.streaming)
          .map((m) => ({
            role: m.role,
            text: m.text ? String(m.text).slice(0, SNAP_CAP) : "",
            thinking: m.thinking ? String(m.thinking).slice(0, SNAP_CAP) : "",
            tools: (m.tools || []).map((t) => ({ name: t.name, state: t.state })),
            model: m.model || "",
            ts: m.ts,
          }));
        localStorage.setItem(SNAP_KEY, JSON.stringify({ cwd: CH.workspace, msgs, openSid: CH.openSid, resumeFile: CH.resumeFile || "" }));
      } catch {}
    }, 800);
  }
  function clearSnapshot() {
    try { localStorage.removeItem(SNAP_KEY); } catch {}
  }

  // After a reload, restore the conversation that was on screen for this
  // workspace as editable history.
  function attemptRestore() {
    if (restoreAttempted || CH.chatBusy || !CH.workspace) return;
    if (CH.chatHistory.length) { restoreAttempted = true; return; } // keep the live thread
    restoreAttempted = true;
    let snap = null;
    try { snap = JSON.parse(localStorage.getItem(SNAP_KEY) || "null"); } catch {}
    if (!snap || snap.cwd !== CH.workspace || !Array.isArray(snap.msgs) || !snap.msgs.length) {
      if (snap) clearSnapshot();
      return;
    }
    CH.chatHistory = snap.msgs;
    CH.openSid = snap.openSid || null;
    CH.resumeFile = snap.resumeFile || null;
    CH.loadingSid = null;
    // The snapshot is a point-in-time copy; force the next poll to re-fetch the
    // open session so messages recorded after the snapshot aren't missed.
    CH.lastOpenCount = null;
    persistConversation();
    renderChat();
    if (el.hint) setHint(`${CH.chatHistory.length} message${CH.chatHistory.length === 1 ? "" : "s"} restored — type to continue`, "");
    ensureChatSession();
  }

  // ─── Refreshing an open session transcript ────────────────────────────────
  // The poll calls onSessions every few seconds; if the session currently on
  // screen recorded new events since it was loaded, silently re-fetch it so the
  // transcript keeps up with an agent that's still working — and so a page
  // reload (which restores the stale snapshot) picks up the latest messages.
  function refreshOpenSession() {
    if (!CH.openSid || CH.chatBusy || CH.loadingSid) return;
    const s = CH.sessions.find((x) => x.session_id === CH.openSid);
    if (!s) return;
    const count = s.event_count ?? 0;
    if (CH.lastOpenCount != null && count <= CH.lastOpenCount) return;
    CH.lastOpenCount = count;
    void loadSessionChat(CH.openSid, true);
  }

  // ─── Interactive chat with the pi coding agent ────────────────────────────

  function currentWorkspaceName() {
    if (!CH.workspace) return "";
    return CH.workspace.split("/").filter(Boolean).pop() || CH.workspace;
  }

  // Build a provider-qualified model id (provider/model) that pi can resolve
  // unambiguously; some providers expose the same model name (e.g. deepseek).
  function qualifiedModel(s) {
    if (!s) return "";
    const m = s.model || "";
    if (!m) return "";
    const p = s.provider || "";
    // A model id is only provider-qualified when it ALREADY begins with the
    // provider's own prefix (e.g. "kilo/inclusionai/..."). A bare "/" is not a
    // provider separator: "inclusionai/ling-3.0-flash-fin:free" is a single
    // model whose org/name contains a slash. Passing it unqualified makes pi
    // reject it as ambiguous when several providers expose the same model, which
    // kills the subprocess and surfaces as "process closed".
    if (p && m.startsWith(p + "/")) return m;
    return p ? `${p}/${m}` : m;
  }

  function defaultChatModel() {
    const ws = wsSessions(CH.workspace);
    const orch = ws.find((s) => (s.agent_name || "").toLowerCase() === "orchestrator");
    const q = qualifiedModel(orch);
    if (q) return q;
    if (ws.length) { const q2 = qualifiedModel(ws[0]); if (q2) return q2; }
    const all = CH.teamData?.enabledModels || [];
    const d = CH.teamData?.defaultModel;
    if (d) {
      if (all.includes(d)) return d;
      const qd = all.find((m) => m.endsWith("/" + d));
      if (qd) return qd;
    }
    return all[0] || "google/gemini-2.5-flash-lite";
  }

  function resetChat() {
    CH.chatSessionId = null;
    CH.resumeFile = null;
    CH.chatBusy = false;
    CH.chatHistory = [];
    CH.loadingSid = null;
    CH.openSid = null;
    CH.chatModel = defaultChatModel();
    renderComposerModel();
    renderChat();
    ensureChatSession();
  }

  // Pre-start the pi session for the selected workspace (POST /chat/start) so
  // `pi --mode rpc` is already running before the first prompt is typed.
  async function ensureChatSession() {
    if (!CH.workspace || CH.chatSessionId || CH.chatBusy) return;
    try {
      const { res, data } = await window.SCOPE.api("/chat/start", {}, { cwd: CH.workspace, model: CH.chatModel || defaultChatModel() });
      if (res.ok && data?.sessionId) {
        CH.chatSessionId = data.sessionId;
        if (el.hint && !CH.chatHistory.length) setHint(`session ready · model ${CH.chatModel}`, "");
      } else if (el.hint && !CH.chatHistory.length) {
        setHint(`⚠ ${data?.error || `HTTP ${res.status}`}`, "err");
      }
    } catch {
      // server unreachable — first prompt will spawn instead
      if (el.hint && !CH.chatHistory.length) setHint("server offline — retry on your next message", "err");
    }
    updateHeader();
  }

  // ─── Rendering helpers: markdown-lite ─────────────────────────────────────

  // Inline formatting on ALREADY-ESCAPED text. Inline code / links / bold /
  // italic are pulled out in order so one formatter can't inject into another
  // (code and links are protected first).
  function fmtInline(text) {
    const prot = [];
    const stash = (html) => { prot.push(html); return "\x01" + (prot.length - 1) + "\x01"; };
    text = text.replace(/`([^`\n]+)`/g, (m, c) => stash(`<code>${c}</code>`));
    text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, l, u) => stash(`<a href="${u}" target="_blank" rel="noopener noreferrer">${l}</a>`));
    text = text.replace(/\*\*([^*\n]+)\*\*/g, (m, t) => stash(`<strong>${t}</strong>`));
    text = text.replace(/~~([^~\n]+)~~/g, (m, t) => stash(`<del>${t}</del>`));
    text = text.replace(/\*([^*\n]+)\*/g, (m, t) => stash(`<em>${t}</em>`));
    return text.replace(/\x01(\d+)\x01/g, (m, i) => prot[+i] || "");
  }

  // Full assistant-message formatter: fenced code blocks, then block structure
  // (headings / lists / quotes / paragraphs) with inline formatting inside.
  function fmtMarkdown(raw) {
    const fences = [];
    let text = String(raw || "").replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (m, lang, code) => {
      fences.push({ lang: (lang || "").trim(), code: code.replace(/\n\s*$/, "") });
      return "\x00F" + (fences.length - 1) + "\x00";
    });
    text = fmtInline(S.escapeHtml(text));

    const lines = text.split("\n");
    const blocks = [];
    let i = 0;
    const flush = (cur) => {
      if (cur) {
        if (cur.lines && cur.lines.join("").trim()) blocks.push(cur);
        else if (cur.type !== "p") blocks.push(cur);
      }
    };
    let cur = null;
    while (i < lines.length) {
      const ln = lines[i];
      const fm = ln.match(/^\x00F(\d+)\x00$/);
      if (fm) { flush(cur); cur = null; blocks.push({ type: "code", idx: +fm[1] }); i++; continue; }
      const hm = ln.match(/^(#{1,4})\s+(.*)$/);
      if (hm) { flush(cur); cur = null; blocks.push({ type: "head", level: hm[1].length, html: hm[2] }); i++; continue; }
      if (/^\s*(---|\*\*\*)\s*$/.test(ln)) { flush(cur); cur = null; blocks.push({ type: "hr" }); i++; continue; }
      if (!ln.trim()) { flush(cur); cur = null; i++; continue; }
      const lm = ln.match(/^\s*[-*•]\s+(.*)$/);
      if (lm) {
        flush(cur); cur = null;
        const items = [];
        while (i < lines.length) {
          const s = lines[i].trim();
          if (!s) break;
          const it = s.match(/^[-*•]\s+(.*)$/);
          if (!it) break;
          items.push(it[1]); i++;
        }
        blocks.push({ type: "ul", items });
        continue;
      }
      const om = ln.match(/^\s*\d+[.)]\s+(.*)$/);
      if (om) {
        flush(cur); cur = null;
        const items = [];
        while (i < lines.length) {
          const s = lines[i].trim();
          if (!s) break;
          const it = s.match(/^\d+[.)]\s+(.*)$/);
          if (!it) break;
          items.push(it[1]); i++;
        }
        blocks.push({ type: "ol", items });
        continue;
      }
      if (/^&gt;\s?/.test(ln)) {
        flush(cur); cur = null;
        const q = [];
        while (i < lines.length && /^&gt;\s?/.test(lines[i])) { q.push(lines[i].replace(/^&gt;\s?/, "")); i++; }
        blocks.push({ type: "quote", lines: q });
        continue;
      }
      if (!cur) cur = { type: "p", lines: [] };
      cur.lines.push(ln);
      i++;
    }
    flush(cur);

    const h = [];
    for (const b of blocks) {
      if (b.type === "code") {
        const f = fences[b.idx];
        if (!f) continue;
        h.push(
          `<div class="chat-code">` +
          `<div class="chat-code-head"><span class="chat-code-lang">${esc(f.lang || "code")}</span>` +
          `<button type="button" class="chat-copy-btn" data-copy="${esc(f.code)}" title="Copy code">${ico(ICON_COPY, 12)} Copy</button></div>` +
          `<pre><code>${esc(f.code)}</code></pre></div>`
        );
        continue;
      }
      if (b.type === "hr") { h.push("<hr>"); continue; }
      if (b.type === "head") { const tag = b.level <= 2 ? "h3" : "h4"; h.push(`<${tag}>${b.html}</${tag}>`); continue; }
      if (b.type === "ul") { h.push("<ul>" + b.items.map((x) => `<li>${x}</li>`).join("") + "</ul>"); continue; }
      if (b.type === "ol") { h.push("<ol>" + b.items.map((x) => `<li>${x}</li>`).join("") + "</ol>"); continue; }
      if (b.type === "quote") { h.push("<blockquote>" + b.lines.map((x) => `<p>${x}</p>`).join("") + "</blockquote>"); continue; }
      h.push("<p>" + b.lines.join("<br>") + "</p>");
    }
    return h.join("");
  }

  // Inline line icons (24px viewBox, stroke = currentColor) so every icon on
  // the chat canvas renders crisply in the theme and never falls back to a
  // platform font. `ico(paths, size, sw)` wraps a set of paths in an <svg>.
  function ico(paths, size, sw) {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${sw || 2}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  }
  const ICON_COPY =
    `<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>`;
  const ICON_THOUGHT =
    `<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/>`;
  const TOOL_ICONS = {
    file: `<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>`,
    edit: `<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>`,
    terminal: `<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>`,
    search: `<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>`,
    globe: `<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>`,
    branch: `<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>`,
    flask: `<path d="M10 2v7.5a1.5 1.5 0 0 1-.4 1L4.5 19.6A1 1 0 0 0 5.4 21h13.2a1 1 0 0 0 .9-1.4l-5.1-9.1a1.5 1.5 0 0 1-.4-1V2"/><line x1="8" y1="2" x2="16" y2="2"/><path d="M7 16h10"/>`,
    camera: `<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>`,
    clipboard: `<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>`,
    trash: `<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>`,
    sliders: `<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>`,
  };

  // Deterministic line icon for a tool name.
  function toolIcon(name) {
    const n = String(name || "").toLowerCase();
    let key = "sliders";
    if (/read|view|cat|head|tail|open|ls|find|locate/.test(n)) key = "file";
    else if (/write|edit|patch|append|create|mkdir|touch|apply|rename/.test(n)) key = "edit";
    else if (/bash|shell|exec|run|sh|zsh|command|terminal|python|node|npm|pip/.test(n)) key = "terminal";
    else if (/search|grep|ripgrep|ack|ag/.test(n)) key = "search";
    else if (/web|http|fetch|curl|request|api|browser|url/.test(n)) key = "globe";
    else if (/git|commit|branch|checkout|merge|rebase|stash|push|pull/.test(n)) key = "branch";
    else if (/test|assert|spec/.test(n)) key = "flask";
    else if (/screenshot|image|png|snapshot|screen/.test(n)) key = "camera";
    else if (/plan|todo|task|thinking|brainstorm|note/.test(n)) key = "clipboard";
    else if (/delete|remove|rm|kill|clear|discard/.test(n)) key = "trash";
    return ico(TOOL_ICONS[key], 12);
  }

  function copyText(text) {
    if (!text) return;
    const done = () => {};
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text));
    } else fallbackCopy(text);
  }
  function fallbackCopy(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    } catch { /* ignore */ }
  }

  // ─── Message rendering ────────────────────────────────────────────────────

  function renderChatMsg(m, i) {
    if (m.role === "user") {
      const copyAttr = esc(m.text || "");
      return (
        `<div class="chat-msg chat-user" data-i="${i}">` +
        `<div class="chat-msg-body">` +
        `<div class="chat-bubble chat-bubble-user"><div class="chat-bubble-text">${esc(m.text || "")}</div></div>` +
        `<div class="chat-msg-top">` +
        `<span class="chat-msg-name">you</span>` +
        `<span class="chat-msg-time">${esc(fmtTs(m.ts))}</span>` +
        `<span class="chat-msg-actions"><button type="button" class="chat-act" data-copy="${copyAttr}" title="Copy message">${ico(ICON_COPY, 13)}</button></span>` +
        `</div></div></div>`
      );
    }
    const badges = [];
    const usage = m.usage || {};
    const tokens = usage.totalTokens ?? usage.total_tokens;
    const cost = usage.cost?.total ?? usage.cost_total;
    if (tokens != null) badges.push(`<span class="chat-badge">${esc(S.fmtTokens(tokens))} tokens</span>`);
    if (cost != null) badges.push(`<span class="chat-badge cost">$${Number(cost).toFixed(5)}</span>`);
    const tools = (m.tools || []).length
      ? `<div class="chat-tools">` + (m.tools || []).map((t) =>
          `<span class="chat-tool ${t.state || ""}"><span class="chat-tool-icon">${toolIcon(t.name)}</span>` +
          `<span class="chat-tool-name">${esc(t.name)}</span><span class="chat-tool-dot"></span></span>`
        ).join("") + `</div>`
      : "";
    const thinking = m.thinking
      ? `<details class="chat-thinking"><summary><span class="chat-th-label">${ico(ICON_THOUGHT, 13)} Thought</span></summary><pre>${esc(m.thinking)}</pre></details>`
      : "";
    const body = m.text
      ? `<div class="chat-text">${fmtMarkdown(m.text)}</div>`
      : (!m.streaming && !m.thinking && !(m.tools || []).length
          ? `<div class="chat-msg-time">(no text response)</div>`
          : "");
    const errNote = m.errorNote ? `<div class="chat-error-note">${esc(m.errorNote)}</div>` : "";
    const copyAttr = esc((m.text || "") + (m.thinking ? "\n\n" + m.thinking : ""));
    return (
      `<div class="chat-msg chat-ai" data-i="${i}">` +
      `<div class="chat-msg-avatar">π</div>` +
      `<div class="chat-msg-body">` +
      `<div class="chat-msg-top">` +
      `<span class="chat-msg-name">pi</span>` +
      (m.model ? `<span class="chat-msg-model" title="${esc(m.model)}">${esc(m.model)}</span>` : "") +
      `<span class="chat-msg-time">${esc(fmtTs(m.ts))}</span>` +
      `<span class="chat-msg-actions"><button type="button" class="chat-act" data-copy="${copyAttr}" title="Copy message">${ico(ICON_COPY, 13)}</button></span>` +
      `</div>` +
      thinking +
      tools +
      body +
      (badges.length ? `<div class="chat-usage">${badges.join("")}</div>` : "") +
      errNote +
      `</div></div>`
    );
  }

  function renderChat() {
    if (!el.msg) return;
    updateHeader();
    setComposerEnabled(!!CH.workspace);
    renderComposerStatus();
    // Preserve the user's reading position across re-renders (session polls
    // call renderChat every few seconds). When pinned near the bottom we stay
    // stuck to the newest message; otherwise we keep the relative offset.
    const prevTop = el.msg.scrollTop;
    const prevHeight = el.msg.scrollHeight || 1;
    const stickBottom = nearBottom();
    if (!CH.workspace) {
      el.msg.innerHTML =
        `<div class="chat-hero">` +
        `<div class="chat-hero-orb"><img src="logo.png" alt="Pi Scope" /></div>` +
        `<div class="chat-hero-title">Chat with your coding agent</div>` +
        `<div class="chat-hero-sub">Pick a workspace on the left — or add a directory — then ask the pi agent working there anything: explain code, plan changes, fix bugs.</div>` +
        `<div class="chat-hero-cta"><button type="button" class="chat-chip" id="chat-hero-add">＋ Add a workspace</button></div>` +
        `</div>`;
      scrollToBottom(true);
      return;
    }
    // Fetching a session transcript into an empty window.
    if (CH.loadingSid && !CH.chatHistory.length) {
      el.msg.innerHTML =
        `<div class="chat-hero">` +
        `<div class="chat-hero-orb"><img src="logo.png" alt="Pi Scope" /></div>` +
        `<div class="chat-hero-title">Loading session…</div>` +
        `<div class="chat-hero-sub">Fetching the recorded conversation.</div>` +
        `<div class="chat-typing"><span></span><span></span><span></span></div></div>`;
      setHint("loading session…", "busy");
      scrollToBottom(true);
      updateScrollDown();
      return;
    }
    if (!CH.chatHistory.length) {
      const chips = [
        { icon: "⚡", text: "Build a new feature — plan it, then bring it to life" },
        { icon: "🚀", text: "Spin up a working prototype from a fresh idea" },
        { icon: "🐞", text: "Hunt down bugs in the latest changes and crush them" },
        { icon: "🛡", text: "Armor the codebase with tests and make them pass" },
      ];
      el.msg.innerHTML =
        `<div class="chat-hero">` +
        `<div class="chat-hero-orb"><img src="logo.png" alt="Pi Scope" /></div>` +
        `<div class="chat-hero-title">${esc(currentWorkspaceName())}</div>` +
        `<div class="chat-hero-sub">pi is online and the forge is hot — every idea you have is one prompt away from code. Tell me what you want to build, or fire up a starter below.</div>` +
        `<div class="chat-hero-chips">` +
        chips.map((c) => `<button type="button" class="chat-chip" data-prompt="${esc(c.text)}"><span class="chat-chip-icon" aria-hidden="true">${c.icon}</span><span>${esc(c.text)}</span></button>`).join("") +
        `</div>` +
        `</div>`;
      scrollToBottom(true);
      return;
    }
    let html = "";
    for (let idx = 0; idx < CH.chatHistory.length; idx++) html += renderChatMsg(CH.chatHistory[idx], idx);
    el.msg.innerHTML = html;
    if (stickBottom) scrollToBottom(true);
    else if (prevHeight > 1) el.msg.scrollTop = Math.round((prevTop / prevHeight) * el.msg.scrollHeight);
    updateScrollDown();
  }

  function renderChatMsgLivePlaceholder(m) {
    // Empty assistant row that streaming events fill in-place.
    const copyAttr = esc(m.text || "");
    return (
      `<div class="chat-msg chat-ai chat-ai-live" data-i="${CH.chatHistory.length - 1}">` +
      `<div class="chat-msg-avatar">π</div>` +
      `<div class="chat-msg-body">` +
      `<div class="chat-msg-top">` +
      `<span class="chat-msg-name">pi</span>` +
      (m.model ? `<span class="chat-msg-model" title="${esc(m.model)}">${esc(m.model)}</span>` : "") +
      `<span class="chat-msg-time">${esc(fmtTs(m.ts))}</span>` +
      `<span class="chat-msg-actions"><button type="button" class="chat-act" data-copy="${copyAttr}" title="Copy message">${ico(ICON_COPY, 13)}</button></span>` +
      `</div>` +
      `<div class="chat-typing"><span></span><span></span><span></span></div>` +
      `</div></div>`
    );
  }

  // ─── Live streaming into the active assistant message ─────────────────────
  let live = null; // { body, m }

  function clearLiveTyping() {
    if (!live) return;
    const t = live.body.querySelector(".chat-typing");
    if (t) t.remove();
  }

  function livePrependTextNode(body, node, beforeSelector) {
    const ref = beforeSelector ? body.querySelector(beforeSelector) : null;
    if (ref) body.insertBefore(node, ref);
    else body.appendChild(node);
  }

  function streamThinking(body, m, delta) {
    m.thinking = (m.thinking || "") + delta;
    clearLiveTyping();
    let det = body.querySelector("details.chat-thinking");
    if (!det) {
      det = document.createElement("details");
      det.className = "chat-thinking";
      det.open = true;
      det.innerHTML = `<summary><span class="chat-th-label">${ico(ICON_THOUGHT, 13)} Thought</span></summary><pre></pre>`;
      livePrependTextNode(body, det, ".chat-tools, .chat-text, .chat-usage");
    }
    det.querySelector("pre").textContent = m.thinking;
    det.scrollTop = det.scrollHeight;
  }

  function streamText(body, m, delta) {
    m.text = (m.text || "") + delta;
    clearLiveTyping();
    let t = body.querySelector(".chat-text.chat-stream-text");
    if (!t) {
      t = document.createElement("div");
      t.className = "chat-text chat-stream-text";
      livePrependTextNode(body, t, null);
    }
    // Keep a trailing caret while streaming.
    t.textContent = m.text;
  }

  function toolChip(body, name) {
    return body.querySelector(`.chat-tool[data-name="${CSS.escape(name)}"]`);
  }

  function streamToolStart(body, m, name, args) {
    m.tools = m.tools || [];
    clearLiveTyping();
    let toolsEl = body.querySelector(".chat-tools");
    if (!toolsEl) {
      toolsEl = document.createElement("div");
      toolsEl.className = "chat-tools";
      livePrependTextNode(body, toolsEl, ".chat-text, .chat-usage");
    }
    const chip = document.createElement("span");
    chip.className = "chat-tool live";
    chip.dataset.name = name;
    chip.innerHTML =
      `<span class="chat-tool-icon">${toolIcon(name)}</span>` +
      `<span class="chat-tool-name">${esc(name)}</span>` +
      `<span class="chat-tool-dot"></span>`;
    toolsEl.appendChild(chip);
    m.tools.push({ name, args, state: "live" });
  }

  function streamToolEnd(body, m, name) {
    const t = m.tools?.find((x) => x.name === name && x.state === "live");
    if (t) t.state = "ok";
    const chip = toolChip(body, name);
    if (chip) { chip.classList.remove("live"); chip.classList.add("ok"); }
  }

  function streamError(body, m, msg) {
    m.errorNote = msg;
    const n = document.createElement("div");
    n.className = "chat-error-note";
    n.textContent = "⚠ " + msg;
    body.appendChild(n);
    clearLiveTyping();
  }

  // Append one live event into the in-flight assistant message DOM. Always
  // target live.m: after a msg_start the in-flight message is a NEW bubble, not
  // the aiMsg captured when the prompt was sent.
  function handleChatEvent(ev) {
    if (!live) return;
    const body = live.body;
    const m = live.m;
    switch (ev.type) {
      case "msg_start": {
        // A run can contain several assistant messages (one per LLM call in a
        // tool loop). The first fills the placeholder; each later one becomes
        // its own bubble so a per-message `final` snapshot can't overwrite the
        // text streamed so far — mirroring how session transcripts render.
        if (!live) break;
        if (live.isFirst) { live.isFirst = false; break; }
        live.m.streaming = false;
        const m2 = {
          role: "assistant", text: "", thinking: "", tools: [], usage: null,
          model: live.m.model || CH.chatModel, ts: Date.now(), streaming: true,
        };
        CH.chatHistory.push(m2);
        const wrap = document.createElement("div");
        wrap.innerHTML = renderChatMsgLivePlaceholder(m2);
        const node = wrap.firstElementChild;
        if (node && el.msg) el.msg.appendChild(node);
        live = { body: node.querySelector(".chat-msg-body"), m: m2, isFirst: false };
        if (nearBottom()) scrollToBottom();
        break;
      }
      case "text":
        streamText(body, m, ev.delta || "");
        break;
      case "thinking":
        streamThinking(body, m, ev.delta || "");
        break;
      case "tool_start":
        streamToolStart(body, m, ev.name || "", ev.args || "");
        break;
      case "tool_end":
        streamToolEnd(body, m, ev.name || "");
        break;
      case "usage":
        m.usage = ev.usage || m.usage;
        break;
      case "final": {
        // Authoritative snapshot (some providers only deliver it on message_end).
        if (ev.text !== undefined) {
          m.text = ev.text || "";
          const t = body.querySelector(".chat-text.chat-stream-text");
          if (t) t.textContent = m.text;
        }
        if (ev.thinking !== undefined) {
          m.thinking = ev.thinking || "";
          const det = body.querySelector("details.chat-thinking");
          if (det) {
            det.querySelector("pre").textContent = m.thinking;
            if (!m.thinking) det.remove();
          }
        }
        break;
      }
      case "error":
        streamError(body, m, ev.message || "error");
        break;
      default:
        break;
    }
    if (nearBottom()) scrollToBottom();
  }

  function setHint(text, kind) {
    if (!el.hint) return;
    el.hint.textContent = text || "";
    el.hint.classList.toggle("busy", kind === "busy");
    el.hint.classList.toggle("err", kind === "err");
  }

  function setComposerEnabled(on) {
    if (!el.input || !el.send || !el.model) return;
    el.input.disabled = !on;
    el.model.disabled = !on;
    el.send.disabled = !on || CH.chatBusy;
    if (el.input) el.input.placeholder = "Message the pi coding agent…";
  }

  function updateHeader() {
    if (!el.name) return;
    const base = currentWorkspaceName();
    if (!CH.workspace) {
      el.name.textContent = "Select a workspace";
      el.sub.textContent = "";
      el.headerModel.textContent = "";
      if (el.state) el.state.hidden = true;
      if (el.liveDot) { el.liveDot.className = "chat-live-dot"; el.liveDot.title = ""; }
      if (el.btnNew) el.btnNew.disabled = true;
      if (el.btnOpen) el.btnOpen.disabled = true;
      return;
    }
    el.name.textContent = base;
    el.sub.textContent = CH.workspace;
    el.headerModel.textContent = CH.chatModel || "";
    el.headerModel.title = CH.chatModel || "";
    const orch = wsSessions(CH.workspace).find((s) => (s.agent_name || "").toLowerCase() === "orchestrator");
    const st = orch ? S.activityStatus(orch) : "gray";
    const busy = CH.chatBusy;
    const stateTxt = busy ? "working" : (CH.chatSessionId ? "ready" : (st === "green" ? "active" : "idle"));
    const stateCls = busy ? "busy" : (CH.chatSessionId ? "" : "off");
    if (el.state) {
      el.state.hidden = false;
      el.state.textContent = stateTxt;
      el.state.className = "chat-header-state " + stateCls;
    }
    if (el.liveDot) {
      el.liveDot.className = "chat-live-dot " + (busy ? "green" : st);
      el.liveDot.title = busy ? "pi is working…" : st === "green" ? "agent running" : "idle";
    }
    if (el.btnNew) {
      el.btnNew.disabled = busy || (!CH.chatHistory.length && !CH.loadingSid);
      el.btnNew.title = "Start a new session";
    }
    if (el.btnOpen) {
      el.btnOpen.disabled = !wsSessions(CH.workspace).length;
      el.btnOpen.title = "Open this agent's full timeline (Single view)";
    }
  }

  // ─── Composer / model chooser ─────────────────────────────────────────────
  // Status line under the input: the model, token usage and time that used to
  // sit on the session rows now live here, describing the conversation that's
  // on screen (an opened session transcript, or the live chat thread).
  function renderComposerStatus() {
    if (!el.composerStatus) return;
    const parts = [];
    if (CH.openSid) {
      const s = CH.sessions.find((x) => x.session_id === CH.openSid);
      if (s) {
        const stats = state.sessionStats?.[s.session_id];
        if (s.model) parts.push(s.model);
        if (stats?.total_tokens != null) parts.push(S.fmtTokens(stats.total_tokens) + " tokens");
        if (s.last_ts) parts.push(S.fmtRel(s.last_ts));
      }
    } else if (CH.chatHistory.length) {
      let tokens = 0;
      let lastTs = 0;
      for (const m of CH.chatHistory) {
        if (m.role === "assistant") {
          const u = m.usage || {};
          const t = u.totalTokens ?? u.total_tokens;
          if (t != null) tokens += t;
        }
        if (m.ts) lastTs = Math.max(lastTs, m.ts);
      }
      if (CH.chatModel) parts.push(CH.chatModel);
      if (tokens) parts.push(S.fmtTokens(tokens) + " tokens");
      if (lastTs) parts.push(S.fmtRel(lastTs));
    } else if (CH.chatModel) {
      parts.push(CH.chatModel);
    }
    const txt = parts.join(" · ");
    el.composerStatus.textContent = txt;
    el.composerStatus.title = txt;
  }

  function renderComposerModel() {
    if (!el.model) return;
    const enabled = CH.teamData?.enabledModels || [];
    const used = new Set();
    for (const s of wsSessions(CH.workspace)) { const q = qualifiedModel(s); if (q) used.add(q); }
    if (CH.chatModel) used.add(CH.chatModel);
    const ordered = enabled.slice();
    for (const m of Array.from(used).sort()) if (!ordered.includes(m)) ordered.push(m);

    if (!ordered.length) ordered.push(CH.chatModel || "google/gemini-2.5-flash-lite");
    let html = "";
    for (const m of ordered) {
      const fromSettings = enabled.includes(m);
      const label = fromSettings ? m : `${m} · (session)`;
      html += `<option value="${esc(m)}"${m === CH.chatModel ? " selected" : ""} title="${fromSettings ? "enabled in pi settings" : "seen in this workspace's sessions"}">${esc(label)}</option>`;
    }
    el.model.innerHTML = html;
  }

  function autoGrow(textarea) {
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = Math.min(200, textarea.scrollHeight) + "px";
  }

  // ─── Sending ──────────────────────────────────────────────────────────────
  function nearBottom() {
    if (!el.msg) return true;
    return el.msg.scrollHeight - el.msg.scrollTop - el.msg.clientHeight < 150;
  }

  function scrollToBottom(force) {
    if (!el.msg) return;
    if (force || nearBottom()) {
      el.msg.scrollTop = el.msg.scrollHeight;
    }
  }

  function updateScrollDown() {
    if (el.scrollDown) el.scrollDown.classList.toggle("show", !nearBottom());
  }

  function newSession() {
    if (CH.chatBusy) return;
    // Start a brand-new conversation for the workspace: wipe the on-screen
    // thread (and any resumed session target) and re-arm a fresh pi session.
    CH.chatHistory = [];
    CH.openSid = null;
    CH.resumeFile = null;
    CH.loadingSid = null;
    clearSnapshot();
    renderChat();
    ensureChatSession();
    setHint(`model ${CH.chatModel || ""}`.trim(), "");
    el.input?.focus();
  }

  function openCurrentSessionTimeline() {
    // While a session transcript is on screen, its timeline button opens that
    // session; otherwise fall back to the workspace's main agent.
    if (CH.openSid) { openSession(CH.openSid); return; }
    const arr = CH.workspace ? wsSessions(CH.workspace) : CH.sessions;
    const orch = arr.find((s) => (s.agent_name || "").toLowerCase() === "orchestrator") || arr[0];
    if (orch) openSession(orch.session_id);
  }

  async function sendPrompt() {
    const text = el.input.value.trim();
    if (!text || CH.chatBusy) return;
    if (!CH.workspace) { el.input.focus(); return; }

    // Sending turns the canvas into a live conversation (not a session replay).
    CH.openSid = null;

    const model = CH.chatModel || defaultChatModel();
    CH.chatBusy = true;
    setComposerEnabled(true);
    if (el.send) el.send.disabled = true;
    setHint("pi is thinking…", "busy");

    const userMsg = { role: "user", text, ts: Date.now() };
    const aiMsg = { role: "assistant", text: "", thinking: "", tools: [], usage: null, model, ts: Date.now(), streaming: true };
    CH.chatHistory.push(userMsg);
    CH.chatHistory.push(aiMsg);
    // Bound the in-memory thread: drop the oldest messages from a very long
    // conversation while keeping the newest (including the one streaming).
    if (CH.chatHistory.length > CHAT_HISTORY_MAX) {
      CH.chatHistory.splice(0, CH.chatHistory.length - CHAT_HISTORY_MAX);
    }

    el.msg.innerHTML = CH.chatHistory.slice(0, -1).map((m, i) => renderChatMsg(m, i)).join("") +
      renderChatMsgLivePlaceholder(aiMsg);
    live = {
      body: el.msg.querySelector(".chat-msg.chat-ai-live .chat-msg-body"),
      m: aiMsg,
      isFirst: true, // the placeholder already stands in for the first assistant message
    };
    updateHeader();
    scrollToBottom(true);

    el.input.value = "";
    autoGrow(el.input);

    try {
      const res = await fetch(window.apiUrl("/chat"), {
        method: "POST",
        headers: { ...window.authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ cwd: CH.workspace, model, prompt: text, sessionId: CH.chatSessionId, sessionFile: CH.resumeFile || "" }),
      });
      if (!res.ok || !res.body) {
        let detail = "";
        try { detail = (await res.json())?.error || ""; } catch { /* non-JSON body */ }
        streamError(live.body, aiMsg, `HTTP ${res.status}${detail ? ": " + detail : ""}`);
      } else {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx);
            buf = buf.slice(idx + 1);
            if (!line.trim()) continue;
            let ev; try { ev = JSON.parse(line); } catch { continue; }
            if (ev.type === "done") {
              if (live?.m) live.m.streaming = false;
              if (ev.sessionId) CH.chatSessionId = ev.sessionId;
              if (ev.error) {
                const tgt = live?.m || aiMsg;
                tgt.errorNote = ev.error === "process closed"
                  ? "pi session ended unexpectedly (process closed)"
                  : ev.error;
              }
            } else {
              handleChatEvent(ev);
            }
          }
        }
      }
    } catch (err) {
      streamError(live.body, aiMsg, (err && err.message) || String(err));
    }

    CH.chatBusy = false;
    live = null;
    CH.chatHistory = CH.chatHistory.map((m) => ({ ...m, streaming: false }));
    persistConversation();
    setHint(`model ${model}`, "");
    setComposerEnabled(true);
    updateHeader();
    renderChat();
    el.input?.focus();
  }

  // Start a conversation from a hero suggestion chip.
  function promptFromChip(text) {
    if (!CH.workspace || CH.chatBusy) return;
    if (el.input) { el.input.value = text; autoGrow(el.input); }
    sendPrompt();
  }

  function addWorkspaceRow() {
    CH.adding = true;
    renderWorkspaces();
    const input = document.getElementById("chat-ws-add-input");
    if (input) input.focus();
  }

  // ─── Loading a session transcript into the chat window ───────────────────
  // Clicking a session row (under a workspace, or in the fallback agent list)
  // shows that session's captured conversation here with the composer enabled:
  // the next message continues as a live pi chat in this workspace.
  async function loadSessionChat(sid, silent) {
    if (!sid || CH.chatBusy || CH.loadingSid === sid) return;
    // Re-clicking a session that's already on screen re-fetches it (no early
    // return) so messages recorded since the last load are picked up.
    const s = CH.sessions.find((x) => x.session_id === sid) || null;
    CH.openSid = sid;
    CH.loadingSid = sid;
    if (!silent) renderChat(); // show the loading hero on first open only
    try {
      const { res, data } = await window.SCOPE.api(`/sessions/${encodeURIComponent(sid)}/events`, { limit: 1000 });
      if (CH.loadingSid !== sid) return; // user moved on while we were fetching
      const msgs = res.ok && Array.isArray(data?.events) ? buildSessionMsgs(data.events, s) : [];
      CH.chatHistory = msgs.slice(-CHAT_HISTORY_MAX);
      // Continuing in this session means resuming pi's own session file, so the
      // agent picks up the full conversation context on the next prompt.
      CH.resumeFile = s?.session_file || null;
      CH.loadingSid = null;
      CH.lastOpenCount = s?.event_count ?? CH.chatHistory.length;
      persistConversation();
      renderChat();
      if (el.hint) {
        setHint(
          msgs.length
            ? `${msgs.length} message${msgs.length === 1 ? "" : "s"} from session — type to continue`
            : "no readable conversation in this session — type to start fresh",
          ""
        );
      }
      if (el.input && !silent) el.input.focus();
    } catch (e) {
      if (CH.loadingSid !== sid) return;
      CH.loadingSid = null;
      if (!silent) {
        CH.openSid = null;
        renderChat();
        if (el.hint) setHint(`⚠ failed to load session: ${e?.message || e}`, "err");
      }
    }
  }

  // Fold a session's raw events into chat bubbles: user messages, assistant
  // replies (with markdown text, thinking and usage), and tool calls rendered
  // as chips attached to the reply they belong to.
  function buildSessionMsgs(events, s) {
    const msgs = [];
    let pendingTools = [];
    let pendingThinking = "";
    const model = s?.model || "";
    for (const ev of events) {
      const p = ev.payload || {};
      if (ev.type === "user_message") {
        const text = p.text || "";
        if (text) msgs.push({ role: "user", text, ts: ev.ts, recorded: true });
      } else if (ev.type === "assistant_message") {
        const thinking = p.thinking || pendingThinking || "";
        pendingThinking = "";
        const tools = pendingTools;
        pendingTools = [];
        const text = p.text || p.content || "";
        msgs.push({ role: "assistant", text, thinking, tools, usage: p.usage, model: p.model || model, ts: ev.ts, recorded: true });
      } else if (ev.type === "thinking") {
        // Thinking arrives as a series of events. Some producers send chunked
        // deltas, others send a growing snapshot of the full thought — so
        // accumulate rather than keeping only the first chunk, and dedupe the
        // two shapes so nothing is duplicated or truncated.
        const t = p.text || "";
        if (t) {
          if (pendingThinking.includes(t) || pendingThinking.endsWith(t)) {
            // exact duplicate chunk or already-contained snapshot
          } else if (t.startsWith(pendingThinking)) {
            pendingThinking = t; // growing snapshot → take the newest full text
          } else {
            const sep = pendingThinking && !/\s$/.test(pendingThinking) && !/^[\s.,;:!?)]/.test(t) ? " " : "";
            pendingThinking += sep + t;
          }
        }
      } else if (ev.type === "tool_call") {
        pendingTools.push({ name: p.tool_name || "tool", state: "ok" });
      } else if (ev.type === "tool_result") {
        const last = pendingTools[pendingTools.length - 1];
        if (last && last.name === (p.tool_name || last.name) && S.isToolResultError(p)) last.state = "err";
      }
    }
    // Flush anything still pending at the end of the event list.
    if (pendingTools.length || pendingThinking) {
      const last = msgs[msgs.length - 1];
      if (last && last.role === "assistant") {
        if (pendingTools.length) last.tools = (last.tools || []).concat(pendingTools);
        if (pendingThinking && !last.thinking) last.thinking = pendingThinking;
      } else if (pendingThinking || pendingTools.length) {
        msgs.push({ role: "assistant", text: "", thinking: pendingThinking || "", tools: pendingTools, model, ts: null, recorded: true });
      }
    }
    return msgs;
  }

  function railEls(side) {
    const left = side !== "right";
    return {
      rail: document.getElementById(left ? "chat-workspace-rail" : "chat-agent-rail"),
      resizer: document.getElementById(left ? "chat-resizer-l" : "chat-resizer-r"),
      btn: document.getElementById(left ? "chat-toggle-left" : "chat-toggle-right"),
    };
  }

  function setRailVisible(side, open) {
    const { rail, resizer, btn } = railEls(side);
    if (!rail) return;
    rail.classList.toggle("folded", !open);
    if (resizer) resizer.style.display = open ? "" : "none";
    if (btn) {
      btn.classList.toggle("on", open);
      btn.setAttribute("aria-pressed", open ? "true" : "false");
      btn.title = open
        ? (side === "left" ? "Collapse the workspaces sidebar" : "Collapse the agent team sidebar")
        : (side === "left" ? "Show the workspaces sidebar" : "Show the agent team sidebar");
    }
    rail.title = open ? "" : (side === "left" ? "Show the workspaces sidebar" : "Show the agent team sidebar");
    try { localStorage.setItem("scope-chat-rail-" + side, open ? "open" : "folded"); } catch {}
  }

  function toggleRail(side) {
    const { rail } = railEls(side);
    if (rail) setRailVisible(side, rail.classList.contains("folded"));
  }

  // ─── Rail resizers ────────────────────────────────────────────────────────
  function makeRailResizer(resizerEl, railEl, dir, min, max, key) {
    if (!resizerEl || !railEl) return;
    resizerEl.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = railEl.getBoundingClientRect().width;
      resizerEl.classList.add("dragging");
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      const onMove = (ev) => {
        const delta = ev.clientX - startX;
        const w = dir === "left" ? startW + delta : startW - delta;
        railEl.style.width = Math.round(Math.min(max, Math.max(min, w))) + "px";
      };
      const onUp = () => {
        resizerEl.classList.remove("dragging");
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        try { localStorage.setItem(key, Math.round(railEl.getBoundingClientRect().width)); } catch {}
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  // ─── Init ─────────────────────────────────────────────────────────────────
  function init() {
    cache();

    const lw = parseInt(localStorage.getItem("scope-chat-ws-width") || "250", 10);
    const rw = parseInt(localStorage.getItem("scope-chat-agent-width") || "290", 10);
    const wsRail = document.getElementById("chat-workspace-rail");
    const agentRail = document.getElementById("chat-agent-rail");
    if (wsRail) wsRail.style.width = Math.min(420, Math.max(190, lw)) + "px";
    if (agentRail) agentRail.style.width = Math.min(440, Math.max(190, rw)) + "px";
    makeRailResizer(document.getElementById("chat-resizer-l"), wsRail, "left", 190, 420, "scope-chat-ws-width");
    makeRailResizer(document.getElementById("chat-resizer-r"), agentRail, "right", 190, 440, "scope-chat-agent-width");

    // Sidebars are folded (hidden) by default; restore the user's last choice
    // when they previously opened one.
    const storedRail = (k) => { try { return localStorage.getItem(k) === "open"; } catch { return false; } };
    setRailVisible("left", storedRail("scope-chat-rail-left"));
    setRailVisible("right", storedRail("scope-chat-rail-right"));
    if (el.toggleLeft) el.toggleLeft.addEventListener("click", () => toggleRail("left"));
    if (el.toggleRight) el.toggleRight.addEventListener("click", () => toggleRail("right"));
    // The folded strip keeps a "show" button at its top — clicking it re-opens
    // the sidebar (the strip itself also re-opens on click as a fallback).
    const showL = document.getElementById("chat-show-left");
    const showR = document.getElementById("chat-show-right");
    if (showL) showL.addEventListener("click", () => setRailVisible("left", true));
    if (showR) showR.addEventListener("click", () => setRailVisible("right", true));
    // Clicking a folded strip re-opens that sidebar. Ignore clicks that came
    // from the rail-head toggle button — its own listener already collapsed the
    // rail, and the bubbled click would otherwise immediately re-open it.
    [wsRail, agentRail].forEach((rail, i) => {
      if (!rail) return;
      const side = i === 0 ? "left" : "right";
      rail.addEventListener("click", (e) => {
        if (e.target.closest?.(".rail-toggle")) return;
        if (rail.classList.contains("folded")) setRailVisible(side, true);
      });
    });

    // Delegated clicks: copy buttons (message + code), hero suggestion chips,
    // hero add-workspace CTA.
    document.addEventListener("click", (e) => {
      const copyBtn = e.target.closest("[data-copy]");
      if (copyBtn) {
        e.preventDefault();
        copyText(copyBtn.dataset.copy);
        return;
      }
      const chip = e.target.closest(".chat-chip[data-prompt]");
      if (chip) {
        promptFromChip(chip.dataset.prompt);
        return;
      }
      if (e.target.closest("#chat-hero-add")) {
        addWorkspaceRow();
        return;
      }
    });

    if (el.msg) {
      el.msg.addEventListener("scroll", updateScrollDown);
    }
    if (el.scrollDown) {
      el.scrollDown.addEventListener("click", () => scrollToBottom(true));
    }
    if (el.btnNew) el.btnNew.addEventListener("click", newSession);
    if (el.btnOpen) el.btnOpen.addEventListener("click", openCurrentSessionTimeline);

    if (el.wsAdd) {
      el.wsAdd.addEventListener("click", async () => {
        if (typeof window.scopeNative?.pickDirectory === "function") {
          try {
            const dir = await window.scopeNative.pickDirectory();
            if (dir) submitAddWorkspace(dir);
            else addWorkspaceRow();
            return;
          } catch { /* fall through to manual entry */ }
        }
        addWorkspaceRow();
      });
    }
    if (el.model) {
      el.model.addEventListener("change", () => {
        CH.chatModel = el.model.value;
        updateHeader();
        // Model applies to a freshly spawned session; re-pre-spawn when no
        // conversation exists yet so the new model is actually used.
        if (!CH.chatHistory.length && CH.workspace) {
          CH.chatSessionId = null;
          ensureChatSession();
        }
        setHint(CH.chatModel ? `model ${CH.chatModel}` : "", "");
      });
    }
    if (el.send) {
      el.send.addEventListener("click", sendPrompt);
    }
    if (el.input) {
      el.input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          sendPrompt();
        }
      });
      el.input.addEventListener("input", () => autoGrow(el.input));
    }

    CH.sessions = state.sessions || [];
    loadAgentTeam();
    renderWorkspaces();
    renderAgents();
    renderComposerModel();
    renderChat();
    attemptRestore();
  }

  // Expose hooks for app.js
  window.__chatOnView = onView;
  window.__chatOnSessions = onSessions;

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
