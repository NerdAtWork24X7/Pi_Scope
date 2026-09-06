/**
 * chat.js — Pi Scope "Chat" view.
 *
 * A clean, chat-style lens over the agent telemetry already ingested by Pi
 * Scope. It is read-only (Pi Scope observes, it does not drive the LLM), but it
 * presents the conversation as a familiar chat surface:
 *
 *   left rail   — Workspaces (unique working directories, grouped from sessions)
 *   center      — the selected agent's conversation as chat bubbles
 *   right rail  — the Agent Team (the agents/subagents that ran in the workspace)
 *   bottom bar  — composer + model chooser (filters the conversation)
 *
 * The bottom composer + model selector filter/highlight the conversation rather
 * than sending to an LLM — typing a query narrows the visible messages, and the
 * model dropdown focuses a single model's turns. This keeps the surface useful
 * for observability while feeling like a chat app.
 *
 * IIFE-wrapped for scope isolation. Exposes window.__chatOnView / __chatOnSessions
 * which app.js calls on view change and session poll.
 */
(function () {
  const S = window.SCOPE;
  const state = window.__SCOPE_STATE;
  const $ = (s) => document.querySelector(s);
  const esc = S.escapeHtml;

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
    agentId: null,     // selected session_id (unused in interactive mode; kept for compat)
    model: "all",      // model filter (legacy, unused now that composer sends to pi)
    query: "",         // legacy composer search (unused)
    chatModel: null,   // model used for the live chat
    chatSessionId: null,
    chatBusy: false,
    chatHistory: [],   // [{role:'user'|'assistant', text, thinking, usage, model, streaming}]
    adding: false,     // inline "add workspace" input is open
    events: [],
    sessions: [],
    teamData: null,    // /agent-team snapshot (teams.yaml + config.json)
    team: null,        // which team's subagents are shown in the right rail
    lastEventCount: -1,
    // cwd keys of the workspace groups that are expanded in the left rail.
    expandedWs: new Set(loadExpandedWs()),
    // agent-team section keys (orch/mode/teams/subagents/skills/extensions)
    // that are collapsed in the right rail.
    collapsedSecs: new Set(loadCollapsedSecs()),
  };

  const el = {};

  function cache() {
    el.ws = $("#chat-workspaces");
    el.wsAdd = $("#chat-ws-add");
    el.agents = $("#chat-agents");
    el.msg = $("#chat-messages");
    el.name = $("#chat-name");
    el.sub = $("#chat-sub");
    el.avatar = $("#chat-avatar");
    el.model = $("#chat-model");
    el.input = $("#chat-input");
    el.send = $("#chat-send");
    el.hint = $("#chat-composer-hint");
    el.agentCount = $("#chat-agent-count");
    el.headerModel = $("#chat-header-model");
    el.liveDot = $("#chat-live-dot");
  }

  // ─── Selectors / data ─────────────────────────────────────────────────────
  function workspaces() {
    const map = {};
    for (const s of CH.sessions) {
      const cwd = s.cwd || "(unknown)";
      (map[cwd] = map[cwd] || []).push(s);
    }
    // Merge directories the user added explicitly, then drop removed ones
    // (persisted in agent-team-config.json via /agent-team).
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
  function onSessions() {
    CH.sessions = state.sessions || [];
    loadAgentTeam();
    renderWorkspaces();
    renderAgents();
    renderComposerModel();
    if (!CH.chatBusy) renderChat();
    if (!CH.workspace) {
      const ws = workspaces();
      if (ws.length) selectWorkspace(ws[0]);
    }
  }

  function onView() {
    // Sync sessions from the shared state so the workspace tree reflects the
    // latest data immediately on entering the chat view (not just on the next
    // session poll).
    CH.sessions = state.sessions || [];
    loadAgentTeam();
    if (!CH.workspace) {
      const ws = workspaces();
      if (ws.length) selectWorkspace(ws[0]);
    }
    renderWorkspaces();
    renderAgents();
    renderComposerModel();
    renderChat();
  }

  // ─── Workspace rail (left) ────────────────────────────────────────────────
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
        '<div class="chat-rail-empty">No workspaces yet — add a directory or run a pi agent to start streaming.</div>' +
        html;
      wireWorkspaces();
      return;
    }
    for (const cwd of ws) {
      const sessions = wsSessions(cwd);
      const name = cwd.split("/").filter(Boolean).pop() || cwd;
      const active = CH.workspace === cwd ? " active" : "";
      const running = sessions.some((s) => S.subagentStatus(s) === "green");
      const expanded = CH.expandedWs.has(cwd);
      html +=
        `<div class="chat-ws${active}" data-cwd="${esc(cwd)}" title="${esc(cwd)}">` +
        `<span class="chat-ws-caret">${expanded ? "▾" : "▸"}</span>` +
        `<span class="chat-ws-dot ${running ? "green" : "gray"}"></span>` +
        `<span class="chat-ws-name">${esc(name)}</span>` +
        (sessions.length ? `<span class="chat-ws-count">${sessions.length}</span>` : "") +
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

  // One session row under a workspace — the chat-page analogue of the pi
  // session-tree's per-agent entries. Clicking it opens that session's timeline.
  // Row 1 shows only a 50-char preview of the first message sent to the LLM in
  // that session; the subagent name (plus its time/token/cost meta) moves to row 2.
  function renderWsSession(s) {
    const name = s.agent_name ?? s.cwd?.split("/").pop() ?? S.shortId(s.session_id);
    const st = S.subagentStatus(s);
    const hasMsg = !!s.first_msg;
    const stats = state.sessionStats[s.session_id];
    const meta = [
      S.fmtRel(s.last_ts),
      stats ? S.fmtTokens(stats.total_tokens) + "tk" : "",
      stats ? `${stats.total_cost.toFixed(4)}` : "",
    ].filter(Boolean).join(" · ");
    // Row 1: the first message (falls back to the name if none captured).
    const firstRow = hasMsg ? esc(S.trunc(s.first_msg, 50)) : esc(name);
    // Row 2: subagent name + meta (name omitted from row 2 when it's already
    // shown alone on row 1, to avoid duplication).
    const secondRow = [hasMsg ? esc(name) : "", meta].filter(Boolean).join(" · ");
    return (
      `<div class="ws-sess" data-sid="${esc(s.session_id)}" title="${esc(name)}">` +
      `<span class="status-dot ${st}"></span>` +
      `<div class="ws-sess-body">` +
      `<div class="ws-sess-name" title="${s.first_msg ? esc(s.first_msg) : esc(name)}">${firstRow}</div>` +
      `<div class="ws-sess-meta">${esc(secondRow)}</div>` +
      `</div></div>`
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
        openSession(n.dataset.sid);
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

  // Add a workspace directory: server resolves + validates the path, then
  // persists it to agent-team-config.json (chatWorkspaces). Accepts an optional
  // pre-picked path (from the native directory picker) so callers don't have to
  // read the inline input.
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
        // The server returns the realpath-resolved directory; prefer the newly
        // added entry so a symlinked/relative input still selects correctly.
        const added = (data.chatWorkspaces || []).find((c) => !before.has(c));
        selectWorkspace(added || p);
      } else if (err) {
        err.textContent = data?.error || `HTTP ${res.status}`;
      }
    } catch (e) {
      if (err) err.textContent = String(e?.message || e);
    }
  }

  // Remove a workspace from the rail (persists the removal so the session
  // poll doesn't re-add it). Selecting the next workspace if it was active.
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
  // Mirrors the agent-team sidebar (mono-pi-extension .../agent-team/sidebar.ts):
  // Orchestrator, Mode, Memory, Teams, Subagents, Skills. Live status / models /
  // tokens are merged in from the scope session telemetry. When no agent-team
  // config is present we fall back to a plain session list for the workspace.
  async function loadAgentTeam() {
    const { res, data } = await window.SCOPE.api("/agent-team");
    if (res.ok && data) CH.teamData = data;
    renderAgents();
    // Custom chat workspaces live in the team snapshot; re-render the rail so
    // they appear on load even before any session poll returns.
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

  // Build one collapsible agent-team section. Every section shares the same
  // header (caret + title) and body wrapper so the rail is visually consistent.
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

    // Orchestrator
    const orchModel = orch?.model || "";
    const orchSt = orch ? S.subagentStatus(orch) : "gray";
    html += atSection("orch", "Agent Team",
      `<div class="at-orch">` +
      `<span class="status-dot ${orchSt}"></span>` +
      `<span class="at-orch-name">Orchestrator${orchModel ? ` <span class="at-model">${esc(orchModel)}</span>` : ""}</span></div>`
    );

    // Mode + Memory (clickable toggles)
    html += atSection("mode", "Mode & Memory",
      `<div class="at-rows">` +
      `<div class="at-row clickable" data-action="toggleMode" title="Click to toggle mode"><span class="at-k">Mode</span><span class="at-v">${mode === "creative" ? "◆ Creative" : "◇ Standard"}</span></div>` +
      `<div class="at-row clickable" data-action="toggleMemory" title="Click to toggle memory"><span class="at-k">Memory</span><span class="at-v">${memActive ? `● ${esc(memModel || "on")}` : "○ off"}</span></div>` +
      `</div>`
    );

    // Teams (click to switch viewed team)
    let teamBody = "";
    if (!teamNames.length) teamBody = `<div class="at-dim">No teams defined</div>`;
    else {
      for (const tn of teamNames) {
        const members = teams[tn] || [];
        const activeCount = members.filter((m) => m.active !== false && !disabled.has((m.name||"").toLowerCase())).length;
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

    // Subagents (click to toggle enabled/disabled)
    const members = teams[viewedTeam] || [];
    let subBody = "";
    if (!members.length) subBody = `<div class="at-dim">No agents loaded</div>`;
    else {
      for (const m of members) {
        const sess = wsSessionsArr.find((s) => (s.agent_name || "").toLowerCase() === (m.name || "").toLowerCase());
        const isDisabled = disabled.has((m.name||"").toLowerCase());
        const enabled = !isDisabled;
        const st = sess ? S.subagentStatus(sess) : "gray";
        const isActive = sess && CH.agentId === sess.session_id;
        const model = m.model || sess?.model || "";
        const stats = sess ? state.sessionStats[sess.session_id] : null;
        const meta = [model, stats ? S.fmtTokens(stats.total_tokens) + "tk" : "", stats ? `${stats.total_cost.toFixed(4)}` : ""].filter(Boolean).join(" · ");
        subBody +=
          `<div class="at-item${isActive ? " active" : ""}${isDisabled ? " disabled" : " on"}" data-agent="${esc(m.name)}" title="${esc(m.name)}">` +
          `<span class="status-dot ${st}"></span>` +
          `<div class="at-item-body">` +
          `<div class="at-item-name">${esc(m.name)}${isDisabled ? ` <span class="at-off">[off]</span>` : ` <span class="at-on">[on]</span>`}</div>` +
          `<div class="at-item-meta">${esc(meta || "idle")}</div>` +
          `</div></div>`;
      }
    }
    html += atSection("subagents", "Subagents", subBody, { count: members.length });

    // Skills (click to toggle enabled/disabled at the settings level)
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

    // Extensions (click to toggle enabled/disabled)
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

    // Wire interactions
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
        postTeam({ action: "toggleAgent", agent: name, disabled: !disabled.has((name||"").toLowerCase()) });
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
      const stats = state.sessionStats[s.session_id];
      const active = CH.agentId === s.session_id ? " active" : "";
      const name = s.agent_name ?? s.cwd?.split("/").pop() ?? S.shortId(s.session_id);
      const st = S.subagentStatus(s);
      const meta = [s.model, stats ? S.fmtTokens(stats.total_tokens) + "tk" : "", stats ? `${stats.total_cost.toFixed(4)}` : ""].filter(Boolean).join(" · ");
      html +=
        `<div class="at-item${active}" data-sid="${s.session_id}" title="${esc(name)}">` +
        `<span class="status-dot ${st}"></span>` +
        `<div class="at-item-body">` +
        `<div class="at-item-name">${esc(name)}</div>` +
        `<div class="at-item-meta">${esc(meta)}</div>` +
        `</div></div>`;
    }
    el.agents.innerHTML = html;
    el.agents.querySelectorAll(".at-item[data-sid]").forEach((n) =>
      n.addEventListener("click", () => openSession(n.dataset.sid))
    );
  }

  // ─── Selection ────────────────────────────────────────────────────────────
  async function selectWorkspace(cwd) {
    CH.workspace = cwd;
    CH.team = null;
    CH.expandedWs.add(cwd); // selecting a workspace reveals its session tree
    saveExpandedWs();
    resetChat();
    renderWorkspaces();
    renderAgents();
  }

  // ─── Build conversation blocks from raw events ────────────────────────────
  // ─── Interactive chat with the pi coding agent ────────────────────────────
  let activeBubble = null; // the assistant bubble element being streamed into

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
    // Fall back to the user's pi settings (defaultModel / enabledModels)
    // before resorting to the hardcoded default.
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
    CH.chatBusy = false;
    CH.chatHistory = [];
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
        if (el.hint && !CH.chatHistory.length) el.hint.textContent = `session ready · model: ${CH.chatModel}`;
      } else if (el.hint && !CH.chatHistory.length) {
        el.hint.textContent = `⚠ ${data?.error || `HTTP ${res.status}`}`;
      }
    } catch { /* server unreachable — first prompt will spawn instead */ }
  }

  function renderChat() {
    if (!el.msg) return;
    updateHeader();
    if (!CH.workspace) {
      el.msg.innerHTML = '<div class="empty-state"><span class="icon">💬</span>Pick a workspace, then message the pi coding agent below.</div>';
      if (el.hint) el.hint.textContent = "";
      return;
    }
    if (!CH.chatHistory.length) {
      el.msg.innerHTML =
        '<div class="empty-state"><span class="icon">▶</span>Start a conversation with the pi coding agent.' +
        '<br><span class="chat-empty-sub">Type a prompt below — pi runs in this workspace with its tools.</span></div>';
      if (el.hint) el.hint.textContent = CH.chatModel ? `model: ${CH.chatModel}` : "";
      return;
    }
    let html = "";
    for (const m of CH.chatHistory) html += renderChatMsg(m);
    el.msg.innerHTML = html;
    if (!CH.chatBusy) el.msg.scrollTop = el.msg.scrollHeight;
  }

  function renderChatMsg(m) {
    if (m.role === "user") {
      return `<div class="chat-row chat-user"><div class="chat-bubble chat-bubble-user"><div class="chat-bubble-text">${esc(m.text)}</div></div></div>`;
    }
    const thinking = m.thinking
      ? `<details class="chat-thinking"><summary>💭 thinking</summary><pre>${esc(m.thinking)}</pre></details>`
      : "";
    const badges = [];
    if (m.model) badges.push(`<span class="chat-badge chat-badge-model">${esc(m.model)}</span>`);
    const usage = m.usage || {};
    const tokens = usage.totalTokens ?? usage.total_tokens;
    const cost = usage.cost?.total ?? usage.cost_total;
    if (tokens != null) badges.push(`<span class="chat-badge">${S.fmtTokens(tokens)} tk</span>`);
    if (cost != null) badges.push(`<span class="chat-badge">${cost.toFixed(5)}</span>`);
    const caret = m.streaming ? '<span class="chat-caret">▍</span>' : "";
    return (
      `<div class="chat-row chat-ai"><div class="chat-avatar chat-avatar-ai">pi</div>` +
      `<div class="chat-bubble chat-bubble-ai">${thinking}` +
      (m.text ? `<div class="chat-bubble-text">${esc(m.text)}${caret}</div>` : (m.streaming ? `<div class="chat-bubble-text">${caret}</div>` : "")) +
      (badges.length ? `<div class="chat-badges">${badges.join("")}</div>` : "") +
      `</div></div>`
    );
  }

  function updateHeader() {
    if (!el.name) return;
    if (!CH.workspace) {
      el.avatar.textContent = "?";
      el.name.textContent = "Select a workspace";
      el.sub.textContent = "";
      el.headerModel.textContent = "";
      el.liveDot.className = "chat-live-dot";
      el.liveDot.title = "";
      return;
    }
    el.avatar.textContent = (currentWorkspaceName().charAt(0) || "?").toUpperCase();
    el.name.textContent = "pi coding agent";
    el.sub.textContent = `${currentWorkspaceName()} · ${CH.workspace}`;
    el.headerModel.textContent = CH.chatModel || "";
    const orch = wsSessions(CH.workspace).find((s) => (s.agent_name || "").toLowerCase() === "orchestrator");
    const st = orch ? S.activityStatus(orch) : "gray";
    el.liveDot.className = "chat-live-dot " + st;
    el.liveDot.title = st === "green" ? "running" : st === "orange" ? "waiting" : "idle";
  }

  // ─── Composer / model chooser ─────────────────────────────────────────────
  function renderComposerModel() {
    if (!el.model) return;
    // Authoritative list: models enabled in pi settings (~/.pi/agent/
    // settings.json `enabledModels`), merged with models seen in this
    // workspace's sessions and the currently selected one.
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
    textarea.style.height = Math.min(160, textarea.scrollHeight) + "px";
  }

  // Append a streaming delta directly into the active assistant bubble (avoids
  // re-rendering the whole history on every token).
  function appendDelta(kind, delta) {
    if (!activeBubble || !delta) return;
    if (kind === "text") {
      let t = activeBubble.querySelector(".chat-bubble-text");
      if (!t) {
        t = document.createElement("div");
        t.className = "chat-bubble-text";
        activeBubble.appendChild(t);
      }
      // Insert before the trailing streaming caret so it stays at the end.
      const caret = t.querySelector(".chat-caret");
      if (caret) t.insertBefore(document.createTextNode(delta), caret);
      else t.appendChild(document.createTextNode(delta));
    } else if (kind === "thinking") {
      let det = activeBubble.querySelector("details.chat-thinking");
      if (!det) {
        det = document.createElement("details");
        det.className = "chat-thinking";
        det.innerHTML = "<summary>💭 thinking</summary><pre></pre>";
        activeBubble.insertBefore(det, activeBubble.firstChild);
      }
      det.querySelector("pre").textContent += delta;
    }
  }

  function handleChatEvent(ev, aiIdx) {
    const m = CH.chatHistory[aiIdx];
    if (ev.type === "text") { m.text += ev.delta || ""; appendDelta("text", ev.delta || ""); }
    else if (ev.type === "thinking") { m.thinking += ev.delta || ""; appendDelta("thinking", ev.delta || ""); }
    else if (ev.type === "final") {
      // Replace delta-accumulated text/thinking with the authoritative snapshot.
      m.text = ev.text || "";
      m.thinking = ev.thinking || "";
      if (activeBubble) {
        activeBubble.querySelectorAll(".chat-bubble-text").forEach((n) => n.remove());
        activeBubble.querySelectorAll("details.chat-thinking").forEach((n) => n.remove());
        if (m.text) {
          const t = document.createElement("div");
          t.className = "chat-bubble-text";
          t.textContent = m.text;
          activeBubble.appendChild(t);
        }
        if (m.thinking) {
          const det = document.createElement("details");
          det.className = "chat-thinking";
          det.innerHTML = "<summary>💭 thinking</summary><pre></pre>";
          det.querySelector("pre").textContent = m.thinking;
          activeBubble.insertBefore(det, activeBubble.firstChild);
        }
      }
    }
    else if (ev.type === "usage") { m.usage = ev.usage; }
    else if (ev.type === "done") {
      CH.chatSessionId = ev.sessionId || CH.chatSessionId;
      m.streaming = false;
      // A dead subprocess (e.g. pi binary not found) ends the stream with no
      // text — surface the reason instead of showing an empty reply.
      if (ev.error) {
        const t = "\n⚠ " + (ev.error === "process closed" ? "pi session ended unexpectedly (process closed)" : ev.error);
        m.text += t;
        appendDelta("text", t);
      }
    }
    else if (ev.type === "error") { const t = "\n⚠ " + (ev.message || "error"); m.text += t; appendDelta("text", t); }
    else if (ev.type === "tool_start") { const t = "\n⚙ " + (ev.name || ""); m.text += t; appendDelta("text", t); }
    if (el.msg) el.msg.scrollTop = el.msg.scrollHeight;
  }

  async function sendPrompt() {
    const text = el.input.value.trim();
    if (!text || CH.chatBusy) return;
    if (!CH.workspace) { el.input.focus(); return; }

    const model = CH.chatModel || defaultChatModel();
    CH.chatBusy = true;
    CH.chatHistory.push({ role: "user", text });
    const aiIdx = CH.chatHistory.push({ role: "assistant", text: "", thinking: "", usage: null, model, streaming: true }) - 1;
    renderChat();

    // Capture the just-created assistant bubble for incremental streaming.
    const rows = el.msg.querySelectorAll(".chat-row.chat-ai");
    activeBubble = rows.length ? rows[rows.length - 1].querySelector(".chat-bubble-ai") : null;

    el.input.value = "";
    autoGrow(el.input);
    if (el.hint) el.hint.textContent = "pi is thinking…";
    if (el.send) el.send.disabled = true;

    try {
      const res = await fetch(window.apiUrl("/chat"), {
        method: "POST",
        headers: { ...window.authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ cwd: CH.workspace, model, prompt: text, sessionId: CH.chatSessionId }),
      });
      if (!res.ok || !res.body) {
        // Surface the server's error message (e.g. "invalid or disallowed
        // cwd") instead of a bare HTTP status, so failures are actionable.
        let detail = "";
        try { detail = (await res.json())?.error || ""; } catch { /* non-JSON body */ }
        const t = "\n⚠ HTTP " + res.status + (detail ? `: ${detail}` : "");
        CH.chatHistory[aiIdx].text += t;
        appendDelta("text", t);
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
            handleChatEvent(ev, aiIdx);
          }
        }
      }
    } catch (err) {
      const t = "\n⚠ " + (err.message || err);
      CH.chatHistory[aiIdx].text += t;
      appendDelta("text", t);
    }

    CH.chatHistory[aiIdx].streaming = false;
    CH.chatBusy = false;
    activeBubble = null;
    if (el.send) el.send.disabled = false;
    if (el.hint) el.hint.textContent = CH.chatModel ? `model: ${CH.chatModel}` : "";
    renderChat();
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

    // Persisted rail widths
    const lw = parseInt(localStorage.getItem("scope-chat-ws-width") || "240", 10);
    const rw = parseInt(localStorage.getItem("scope-chat-agent-width") || "260", 10);
    const wsRail = document.getElementById("chat-workspace-rail");
    const agentRail = document.getElementById("chat-agent-rail");
    if (wsRail) wsRail.style.width = Math.min(420, Math.max(180, lw)) + "px";
    if (agentRail) agentRail.style.width = Math.min(440, Math.max(180, rw)) + "px";
    makeRailResizer(document.getElementById("chat-resizer-l"), wsRail, "left", 180, 420, "scope-chat-ws-width");
    makeRailResizer(document.getElementById("chat-resizer-r"), agentRail, "right", 180, 440, "scope-chat-agent-width");

    if (el.wsAdd) {
      el.wsAdd.addEventListener("click", async () => {
        // With a native picker available, "+ Add" opens the file manager
        // directly instead of asking for a manual path. On cancel we fall back
        // to the inline input (which still offers a Browse button).
        if (typeof window.scopeNative?.pickDirectory === "function") {
          try {
            const dir = await window.scopeNative.pickDirectory();
            if (dir) submitAddWorkspace(dir);
            else { CH.adding = true; renderWorkspaces(); }
            return;
          } catch { /* fall through to manual entry */ }
        }
        CH.adding = true;
        renderWorkspaces();
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
        if (el.hint) el.hint.textContent = CH.chatModel ? `model: ${CH.chatModel}` : "";
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
  }

  // Expose hooks for app.js
  window.__chatOnView = onView;
  window.__chatOnSessions = onSessions;

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
