/**
 * rail.js — the shared "Workspaces rail".
 *
 * The Chat view owns an in-layout copy of this rail (chat.js) because selecting
 * a workspace there binds a live chat thread. Every OTHER view — Single,
 * Trajectory, Terminal, Review (Files), Checkpoints and Git — shows the same
 * rail in the global <aside>, wired to app-level actions:
 *
 *   workspace click   → set the shared working directory (Files/Git/Checkpoints
 *                       re-scan it; Terminal cds its shell)
 *   caret / fold      → expand workspaces and subagent groups
 *   session row click → open that session (Single / Trajectory)
 *   delete / remove   → the same server calls the Chat rail uses
 *   ＋ Add            → add a workspace directory
 *
 * The markup, status model and expansion persistence are shared with chat.js
 * through `SCOPE.WorkspaceRail.*`, so the two rails can never drift visually or
 * in which subagents they fold.
 *
 * IIFE-wrapped for scope isolation. `mount()` is called by app.js once
 * `window.__SCOPE_STATE` exists; until then nothing is rendered.
 */
(function () {
  const S = window.SCOPE;
  const esc = S.escapeHtml;

  // Persistence keys shared with chat.js so both rails fold identically.
  const EXPAND_KEY = "scope-chat-ws-expanded";
  const SUB_KEY = "scope-chat-sub-open";
  const CUSTOM_KEY = "scope-chat-custom-ws";
  const CHAT_WS_KEY = "scope-chat-workspace";

  function loadJSON(key) {
    try { const v = JSON.parse(localStorage.getItem(key) || "[]"); return Array.isArray(v) ? v : []; }
    catch { return []; }
  }
  function saveJSON(key, v) {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch {}
  }
  function state() { return window.__SCOPE_STATE || {}; }

  // pi's background memory summarizer spawns a fresh session per orchestrator
  // turn — it is not a user conversation, so it never appears in the rail.
  function isChatSession(s) {
    return (s.agent_name || "").toLowerCase() !== "memory-summarizer";
  }

  // ─── Shared, view-agnostic rendering (also used by chat.js) ────────────────

  // Human-readable pi status + the dot class it maps to.
  function piStatusMeta(st) {
    return st === "green"
      ? { word: "working", dot: "green", cls: "live" }
      : st === "orange"
        ? { word: "waiting", dot: "orange", cls: "warn" }
        : st === "red"
          ? { word: "stopped", dot: "red", cls: "off" }
          : { word: "idle", dot: "gray", cls: "off" };
  }

  // Aggregate status for a workspace: any live agent wins, then waiting, then
  // stopped; otherwise idle.
  function wsPiStatus(sessions) {
    const seen = new Set(sessions.map((s) => S.subagentStatus(s)));
    let st = "gray";
    if (seen.has("green")) st = "green";
    else if (seen.has("orange")) st = "orange";
    else if (seen.has("red")) st = "red";
    return piStatusMeta(st);
  }

  // Split a workspace's session list into { roots, subs }: main sessions plus
  // the subagent sessions each spawned. A session whose parent isn't in the same
  // list is a root, so orphans never vanish. Parent cycles are broken by
  // promoting the first unreachable session to a root, so cycles render without
  // looping and nothing is silently dropped.
  function buildSessionTree(sessions) {
    const byId = new Map(sessions.map((s) => [s.session_id, s]));
    const subs = new Map(); // parent session_id → child sessions
    const parentOf = new Map();
    const roots = [];
    for (const s of sessions) {
      const p = s.parent_session_id;
      if (p && p !== s.session_id && byId.has(p)) {
        if (!subs.has(p)) subs.set(p, []);
        subs.get(p).push(s);
        parentOf.set(s.session_id, p);
      } else {
        roots.push(s);
      }
    }
    const reachable = new Set();
    const mark = (s) => {
      if (reachable.has(s.session_id)) return;
      reachable.add(s.session_id);
      for (const k of subs.get(s.session_id) || []) mark(k);
    };
    for (const r of roots) mark(r);
    if (reachable.size < sessions.length) {
      for (const s of sessions) {
        if (reachable.has(s.session_id)) continue;
        const p = parentOf.get(s.session_id);
        if (p) {
          const arr = subs.get(p);
          if (arr) {
            const i = arr.indexOf(s);
            if (i >= 0) arr.splice(i, 1);
            if (!arr.length) subs.delete(p);
          }
          parentOf.delete(s.session_id);
        }
        roots.push(s);
        mark(s);
      }
    }
    return { roots, subs };
  }

  // One session row under a workspace. `selectedSid` is only used by the global
  // sidebar (chat opens sessions in the canvas instead of highlighting them).
  function renderSessionRow(s, opts) {
    const o = opts || {};
    const nested = !!o.nested;
    const name = s.agent_name ?? s.cwd?.split("/").pop() ?? S.shortId(s.session_id);
    const own = S.subagentStatus(s);
    const st = o.groupActive && own !== "red" ? "green" : own;
    const stMeta = piStatusMeta(st);
    const stats = (state().sessionStats || {})[s.session_id];
    const hasErr = (stats?.error_count || 0) > 0;
    const row1 = s.first_msg ? S.trunc(s.first_msg, 46) : name;
    const statusText = stMeta.word + (hasErr ? " ⚠ needs review" : "");
    const tip = (s.first_msg ? s.first_msg : name) + (statusText ? " — " + statusText : "") +
      (nested && s.parent_session_id ? " — spawned by session " + S.shortId(s.parent_session_id) : "");
    const selected = o.selectedSid === s.session_id ? " selected" : "";
    return (
      `<div class="ws-sess${nested ? " ws-sess-sub" : ""}${selected}" data-sid="${esc(s.session_id)}" title="${esc(tip)}">` +
      `<span class="status-dot ${st}"></span>` +
      `<div class="ws-sess-body">` +
      `<div class="ws-sess-name" title="${s.first_msg ? esc(s.first_msg) : esc(name)}">${esc(row1)}</div>` +
      `</div>` +
      `<span class="ws-sess-del" data-del="${esc(s.session_id)}" title="Delete this session">&times;</span>` +
      `</div>`
    );
  }

  // Render a workspace's sessions as a tree: each root session row followed by a
  // fold row that expands/collapses its spawned subagents. Groups default to
  // collapsed. `runningUnder` makes a parent report "running" while any
  // descendant is live — never for a stopped (red) session a lingering child
  // must not mask.
  function renderSessionTree(tree, opts) {
    const o = opts || {};
    const subOpen = o.subOpen || new Set();
    const { roots, subs } = tree;
    const rendered = new Set();
    const runningUnder = (sid) => {
      for (const k of subs.get(sid) || []) {
        if (S.subagentStatus(k) === "green" || runningUnder(k.session_id)) return true;
      }
      return false;
    };
    const level = (s, nested) => {
      if (rendered.has(s.session_id)) return ""; // cycle guard (defensive)
      rendered.add(s.session_id);
      const running = runningUnder(s.session_id);
      const rows = renderSessionRow(s, { nested, groupActive: running, selectedSid: o.selectedSid });
      const kids = subs.get(s.session_id) || [];
      if (!kids.length) return rows;
      const open = subOpen.has(s.session_id);
      const label = `${kids.length} sub-session${kids.length === 1 ? "" : "s"}`;
      return (
        rows +
        `<div class="ws-sess-fold ws-sess-sub${open ? " open" : ""}" data-fold="${esc(s.session_id)}"` +
        ` title="${esc(running ? "a subagent is still running" : "click to expand or collapse the sub-sessions")}">` +
        `<span class="ws-sess-fold-caret">${open ? "▾" : "▸"}</span>` +
        `<span class="ws-sess-fold-label">${esc(label)}</span>` +
        (running ? `<span class="ws-sess-fold-dot green" title="a subagent is running"></span>` : "") +
        `</div>` +
        `<div class="ws-sess-subs"${open ? "" : ' style="display:none"'}>` +
        kids.map((k) => level(k, true)).join("") +
        `</div>`
      );
    };
    return roots.map((r) => level(r, false)).join("");
  }

  // One workspace header row. Identical markup in both rails.
  function renderWorkspaceRow(o) {
    const { cwd, sessions, active, expanded } = o;
    const stats = state().sessionStats || {};
    const name = cwd.split("/").filter(Boolean).pop() || cwd;
    const pst = wsPiStatus(sessions);
    const hasErr = sessions.some((s) => (stats[s.session_id]?.error_count || 0) > 0);
    const letter = esc((name.charAt(0) || "?").toUpperCase());
    const meta = [
      pst.word + (hasErr ? " · ⚠ review" : ""),
      sessions.length ? `${sessions.length} session${sessions.length === 1 ? "" : "s"}` : "no sessions",
    ].join(" · ");
    return (
      `<div class="chat-ws${active ? " active" : ""}" data-cwd="${esc(cwd)}" title="${esc(cwd)}">` +
      `<span class="chat-ws-caret">${expanded ? "▾" : "▸"}</span>` +
      `<span class="chat-ws-icon">${letter}</span>` +
      `<div class="chat-ws-body">` +
      `<div class="chat-ws-name">${esc(name)}</div>` +
      `<div class="chat-ws-meta ${pst.cls}">${esc(meta)}</div>` +
      `</div>` +
      `<span class="chat-ws-dot ${pst.dot}" title="${esc(pst.word)}"></span>` +
      `<span class="chat-ws-remove" data-remove="${esc(cwd)}" title="Remove workspace">&times;</span>` +
      `</div>`
    );
  }

  // Inline "add workspace" row. `prefix` namespaces the input/err ids so the two
  // rails (chat + sidebar) can coexist in the DOM without duplicate ids.
  function renderAddRow(prefix, canBrowse) {
    return (
      `<div class="chat-ws-add-row">` +
      `<div class="chat-ws-add-fields">` +
      `<input class="chat-ws-add-input" id="${prefix}-ws-add-input" type="text" placeholder="/path/to/workspace" spellcheck="false" autocorrect="off" autocapitalize="off" autocomplete="off" />` +
      (canBrowse
        ? `<button class="chat-ws-browse" id="${prefix}-ws-browse" type="button" title="Browse for a directory">Browse…</button>`
        : "") +
      `</div>` +
      `<div class="chat-ws-add-err" id="${prefix}-ws-add-err"></div>` +
      `</div>`
    );
  }

  // ─── Sidebar controller ────────────────────────────────────────────────────
  const R = {
    root: null,       // scroll container the rail renders into (#session-list)
    addBtn: null,     // "＋ Add" button in the aside header
    adding: false,
    expandedWs: new Set(loadJSON(EXPAND_KEY)),
    subOpen: new Set(loadJSON(SUB_KEY)),
    customWs: loadCustomWs(),
    lastHtml: null,
    lastMiniHtml: null,
    wired: false,
    teamFetchedAt: 0,
  };

  function loadCustomWs() {
    try {
      const v = JSON.parse(localStorage.getItem(CUSTOM_KEY) || "null");
      if (v && Array.isArray(v.list)) return { list: v.list, removed: Array.isArray(v.removed) ? v.removed : [] };
    } catch {}
    return { list: [], removed: [] };
  }
  function saveCustomWs() {
    try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(R.customWs)); } catch {}
  }
  // Fold a server snapshot into the union exactly like chat.js: an explicit
  // removal stays authoritative until a re-add, so a workspace removed here
  // cannot be resurrected by another project still listing it.
  function mergeCustomWs(data) {
    if (!data) return;
    let changed = false;
    for (const w of data.chatWorkspaces || []) {
      if (R.customWs.removed.includes(w)) continue;
      if (!R.customWs.list.includes(w)) { R.customWs.list.push(w); changed = true; }
    }
    for (const w of data.chatWorkspacesRemoved || []) {
      if (!R.customWs.list.includes(w) && !R.customWs.removed.includes(w)) {
        R.customWs.removed.push(w);
        changed = true;
      }
    }
    if (changed) saveCustomWs();
  }

  // Union of session-derived workspaces + explicitly added ones (minus removals),
  // sorted with the unknown bucket last.
  function workspaces() {
    const map = Object.create(null);
    for (const s of state().sessions || []) {
      if (!isChatSession(s)) continue;
      const cwd = s.cwd || "(unknown)";
      (map[cwd] = map[cwd] || []).push(s);
    }
    const custom = (R.customWs.list || []).filter((c) => !(R.customWs.removed || []).includes(c));
    for (const cwd of custom) if (!map[cwd]) map[cwd] = [];
    return Object.keys(map).sort((a, b) =>
      a === "(unknown)" ? 1 : b === "(unknown)" ? -1 : a.localeCompare(b));
  }
  function wsSessions(cwd) {
    return (state().sessions || []).filter((s) => isChatSession(s) && (s.cwd || "(unknown)") === cwd);
  }

  function canBrowse() {
    return typeof window.scopeNative?.pickDirectory === "function";
  }

  function render() {
    if (!R.root) return;
    const st = state();
    // The aside is hidden on Chat and Settings (the Chat view owns its own copy
    // of this rail). Clear the sidebar's rows there so the visible chat rail is
    // the only source of .chat-ws / .ws-sess in the DOM — a hidden duplicate
    // breaks strict selectors and doubles every render.
    if (st.view === "chat" || st.view === "settings") {
      if (R.lastHtml !== "") { R.lastHtml = ""; R.lastMiniHtml = null; R.root.innerHTML = ""; }
      return;
    }
    const ws = workspaces();
    if (st.sidebarCollapsed) { renderMini(ws); return; }
    if (!ws.length && !R.adding) {
      const empty = '<div class="chat-rail-empty">No workspaces yet.<br>Add a directory or run a pi agent to start streaming.</div>';
      if (R.lastHtml === empty) return;
      R.lastHtml = empty; R.lastMiniHtml = null;
      R.root.innerHTML = empty;
      return;
    }
    let html = R.adding ? renderAddRow("sidebar", canBrowse()) : "";
    const activeCwd = st.cwd || "";
    for (const cwd of ws) {
      const sessions = wsSessions(cwd);
      const expanded = R.expandedWs.has(cwd);
      html += renderWorkspaceRow({ cwd, sessions, active: activeCwd === cwd, expanded });
      html += `<div class="chat-ws-children"${expanded ? "" : ' style="display:none"'}>` +
        renderSessionTree(buildSessionTree(sessions), { subOpen: R.subOpen, selectedSid: st.selectedSessionId }) +
        `</div>`;
    }
    if (R.lastHtml === html) return;
    const prevAdd = R.adding ? R.root.querySelector("#sidebar-ws-add-input")?.value : null;
    R.lastHtml = html; R.lastMiniHtml = null;
    R.root.innerHTML = html;
    if (R.adding) {
      const inp = R.root.querySelector("#sidebar-ws-add-input");
      if (inp) { if (prevAdd) inp.value = prevAdd; inp.focus(); }
    }
  }

  // Collapsed aside: one initial chip per workspace (mirrors the old session
  // mini chips), click selects the workspace.
  function renderMini(ws) {
    const st = state();
    const activeCwd = st.cwd || "";
    let html = "";
    for (const cwd of ws) {
      const name = cwd.split("/").filter(Boolean).pop() || cwd;
      const letter = esc((name.charAt(0) || "?").toUpperCase());
      const pst = wsPiStatus(wsSessions(cwd));
      html += `<div class="ws-mini${activeCwd === cwd ? " active" : ""}" data-cwd="${esc(cwd)}" title="${esc(cwd)}">` +
        `${letter}<span class="mini-dot ${pst.dot}"></span></div>`;
    }
    if (R.lastMiniHtml === html) return;
    R.lastMiniHtml = html; R.lastHtml = null;
    R.root.innerHTML = html;
  }

  // Selecting a workspace sets the shared working directory every other view
  // reads (Files/Git/Checkpoints re-scan; Terminal cds its shell), expands it,
  // remembers it as the Chat workspace, and re-renders the rail.
  function selectWorkspace(cwd) {
    if (!cwd) return;
    window.__setCwd?.(cwd);
    try { localStorage.setItem(CHAT_WS_KEY, cwd); } catch {}
    if (!R.expandedWs.has(cwd)) { R.expandedWs.add(cwd); saveJSON(EXPAND_KEY, [...R.expandedWs]); }
    if (state().view === "terminal") window.__terminalCd?.(cwd);
    R.lastHtml = null; R.lastMiniHtml = null;
    render();
  }

  function toggleWs(cwd) {
    if (!cwd) return;
    if (R.expandedWs.has(cwd)) R.expandedWs.delete(cwd);
    else R.expandedWs.add(cwd);
    saveJSON(EXPAND_KEY, [...R.expandedWs]);
    R.lastHtml = null;
    render();
  }

  function toggleSubs(sid) {
    if (!sid) return;
    if (R.subOpen.has(sid)) R.subOpen.delete(sid);
    else R.subOpen.add(sid);
    saveJSON(SUB_KEY, [...R.subOpen]);
    R.lastHtml = null;
    render();
  }

  // Open a recorded session — the action depends on the ACTIVE page, never a
  // blind jump to Single:
  //   Single / Trajectory → select the session (that pane renders timelines)
  //   Chat                → resume the session as a chat transcript
  //   Terminal / Review / Checkpoints / Git → switch the shared workspace to the
  //                         session's cwd (Terminal cds its shell, the others
  //                         re-scan it); those panes have no per-session view.
  function activateSession(sid) {
    if (!sid) return;
    const st = state();
    const s = (st.sessions || []).find((x) => x.session_id === sid);
    if (st.view === "chat") {
      window.__chatOpenSession?.(sid);
      return;
    }
    if (st.view === "single" || st.view === "trajectory") {
      if (s?.cwd) selectWorkspace(s.cwd);
      if (state().selectedSessionId !== sid) S.selectSession?.(sid);
      return;
    }
    if (s?.cwd) selectWorkspace(s.cwd);
  }

  function deleteSession(sid) {
    if (typeof S.deleteSession === "function") void S.deleteSession(sid);
  }

  async function browseForWorkspace() {
    if (typeof window.scopeNative?.pickDirectory !== "function") return;
    try {
      const dir = await window.scopeNative.pickDirectory();
      if (dir) void submitAdd(dir);
    } catch { /* dialog failed — fall back to manual entry */ }
  }

  async function submitAdd(picked) {
    const input = R.root.querySelector("#sidebar-ws-add-input");
    const err = R.root.querySelector("#sidebar-ws-add-err");
    const p = (picked ?? (input?.value || "")).trim();
    if (!p) { R.adding = false; render(); return; }
    try {
      const before = new Set(R.customWs.list || []);
      const { res, data } = await window.SCOPE.api("/agent-team", {}, { action: "addWorkspace", path: p, cwd: state().cwd || "" });
      if (res.ok && data) {
        R.customWs.removed = (R.customWs.removed || []).filter((w) => w !== p);
        if (!R.customWs.list.includes(p)) R.customWs.list.push(p);
        saveCustomWs();
        mergeCustomWs(data);
        R.adding = false;
        // Prefer the exact typed path when the server echoed it; else the first
        // workspace in the response we had not seen before.
        const added = (data.chatWorkspaces || []).find((c) => !before.has(c));
        selectWorkspace((data.chatWorkspaces || []).includes(p) ? p : (added || p));
      } else if (err) {
        err.textContent = data?.error || `HTTP ${res.status}`;
      }
    } catch (e) {
      if (err) err.textContent = String(e?.message || e);
    }
  }

  async function removeWorkspace(cwd) {
    const sessions = wsSessions(cwd);
    const name = (cwd || "").split("/").filter(Boolean).pop() || cwd;
    if (sessions.length && !confirm(
      `Remove "${name}"?\n\n` +
      `This permanently deletes its ${sessions.length} recorded session${sessions.length === 1 ? "" : "s"} ` +
      `and events from the database. This cannot be undone.`
    )) return;
    try {
      const { res, data } = await window.SCOPE.api("/agent-team", {}, { action: "removeWorkspace", path: cwd, cwd: state().cwd || "" });
      if (res.ok && data) mergeCustomWs(data);
    } catch { /* server unreachable — re-render from local state below */ }
    R.customWs.list = (R.customWs.list || []).filter((w) => w !== cwd);
    if (!R.customWs.removed.includes(cwd)) R.customWs.removed.push(cwd);
    saveCustomWs();
    // Drop the workspace's sessions from local state so a deleted session can't
    // keep streaming into any view, then reload: removal rewrites per-project
    // config the whole app reads at boot (agent team, shared cwd, workspace list).
    state().sessions = (state().sessions || []).filter((s) => (s.cwd || "(unknown)") !== cwd);
    try { if (localStorage.getItem(CHAT_WS_KEY) === cwd) localStorage.removeItem(CHAT_WS_KEY); } catch {}
    location.reload();
  }

  // One delegated listener on the scroll container. Most specific target first:
  // session rows and folds sit inside the children container, and the
  // remove/caret affordances inside the workspace row.
  function onRootClick(e) {
    const del = e.target.closest(".ws-sess-del");
    if (del) { deleteSession(del.dataset.del); return; }
    const sess = e.target.closest(".ws-sess");
    if (sess) { activateSession(sess.dataset.sid); return; }
    const fold = e.target.closest(".ws-sess-fold");
    if (fold) { toggleSubs(fold.dataset.fold); return; }
    const remove = e.target.closest(".chat-ws-remove");
    if (remove) { void removeWorkspace(remove.dataset.remove); return; }
    const caret = e.target.closest(".chat-ws-caret");
    if (caret) { toggleWs(caret.closest(".chat-ws")?.dataset.cwd); return; }
    if (e.target.closest(".chat-ws-browse")) { void browseForWorkspace(); return; }
    const mini = e.target.closest(".ws-mini");
    if (mini) { selectWorkspace(mini.dataset.cwd); return; }
    const row = e.target.closest(".chat-ws");
    if (row) selectWorkspace(row.dataset.cwd);
  }

  function onRootKeydown(e) {
    if (!e.target.closest("#sidebar-ws-add-input")) return;
    if (e.key === "Enter") { e.preventDefault(); void submitAdd(); }
    else if (e.key === "Escape") { e.preventDefault(); R.adding = false; render(); }
  }

  function openAddWorkspace() {
    R.adding = true;
    render();
  }

  // Pull the project's chat workspace list so session-less workspaces the user
  // added in Chat/Settings still show here. Throttled; the union in
  // localStorage keeps the rail stable between fetches.
  async function loadAgentTeam() {
    const now = Date.now();
    if (R.teamFetchedAt && now - R.teamFetchedAt < 15000) return;
    R.teamFetchedAt = now;
    const params = state().cwd ? { cwd: state().cwd } : {};
    try {
      const { res, data } = await window.SCOPE.api("/agent-team", params);
      if (res.ok && data) { mergeCustomWs(data); R.lastHtml = null; render(); }
    } catch { /* server unreachable — keep the local union */ }
  }

  function mount(opts) {
    const o = opts || {};
    R.root = document.getElementById(o.containerId || "session-list");
    R.addBtn = document.getElementById(o.addButtonId || "sidebar-ws-add");
    if (!R.root) return;
    if (!R.wired) {
      R.wired = true;
      R.root.addEventListener("click", onRootClick);
      R.root.addEventListener("keydown", onRootKeydown);
      if (R.addBtn) R.addBtn.addEventListener("click", openAddWorkspace);
    }
    void loadAgentTeam();
    render();
  }

  window.SCOPE.WorkspaceRail = {
    // shared with chat.js
    isChatSession,
    piStatusMeta,
    wsPiStatus,
    buildSessionTree,
    renderSessionRow,
    renderSessionTree,
    renderWorkspaceRow,
    renderAddRow,
    // sidebar controller
    mount,
    render,
  };
})();
