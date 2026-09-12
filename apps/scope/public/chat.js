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
  function loadBool(key, dflt) {
    try { const v = localStorage.getItem(key); return v === null ? dflt : v === "1"; } catch { return dflt; }
  }
  function saveCollapsedSecs() {
    try { localStorage.setItem("scope-chat-team-collapsed", JSON.stringify([...CH.collapsedSecs])); } catch {}
  }
  // Main sessions whose spawned-subagent rows are currently EXPANDED. Defaults
  // to everything collapsed — subagents sit folded under their parent session.
  function loadSubOpen() {
    try { return JSON.parse(localStorage.getItem("scope-chat-sub-open") || "[]"); } catch { return []; }
  }
  function saveSubOpen() {
    try { localStorage.setItem("scope-chat-sub-open", JSON.stringify([...CH.subOpen])); } catch {}
  }

  // ─── Custom-workspace union (sidebar display cache) ──────────────────────
  // chatWorkspaces is stored PER PROJECT (each workspace's own
  // .pi/settings/agent-team-config.json). The sidebar must stay stable as the
  // user clicks between workspaces — otherwise opening a workspace whose own
  // config doesn't list itself (e.g. one added before self-registration, or
  // listed only in another project's config) would make its row vanish. So we
  // keep a union of every project's workspace list we have SEEN, persisted in
  // localStorage; removal is tracked the same way. The server still stores the
  // list per-project; this is purely a display cache.
  const CUSTOM_WS_KEY = "scope-chat-custom-ws";
  function loadCustomWs() {
    try {
      const v = JSON.parse(localStorage.getItem(CUSTOM_WS_KEY) || "null");
      if (v && Array.isArray(v.list)) return { list: v.list, removed: Array.isArray(v.removed) ? v.removed : [] };
    } catch {}
    return { list: [], removed: [] };
  }
  function saveCustomWs() {
    try { localStorage.setItem(CUSTOM_WS_KEY, JSON.stringify(CH.customWs)); } catch {}
  }
  // Fold a project's config snapshot into the union (no-op when already known).
  // chatWorkspaces / chatWorkspacesRemoved are stored PER PROJECT, but the
  // sidebar is a UNION of every project's list we have seen. A removal must
  // therefore be authoritative across the union: if a listing from any project
  // could clear it, a workspace the user removed reappears on the next reload
  // as soon as another project still lists it (reported: the removed workspace
  // comes back after the reload that follows removing it). Only an explicit
  // re-add clears a removal (addWorkspace / submitAddWorkspace), so a listing
  // adds a workspace only while it is not marked removed.
  function mergeCustomWs(data) {
    if (!data) return;
    let changed = false;
    for (const w of data.chatWorkspaces || []) {
      if (CH.customWs.removed.includes(w)) continue; // an explicit removal wins
      if (!CH.customWs.list.includes(w)) { CH.customWs.list.push(w); changed = true; }
    }
    for (const w of data.chatWorkspacesRemoved || []) {
      if (!CH.customWs.list.includes(w) && !CH.customWs.removed.includes(w)) {
        CH.customWs.removed.push(w);
        changed = true;
      }
    }
    if (changed) saveCustomWs();
  }

  // ─── Chat state ───────────────────────────────────────────────────────────
  const CH = {
    workspace: null,   // selected cwd
    chatModel: null,   // model used for the live chat
    chatSessionId: null,
    resumeFile: null,  // pi session file to continue (set when a recorded session is opened)
    chatBusy: false,
    suppressLive: false, // live preview frozen because the user browsed away mid-run
    chatHistory: [],   // [{role:'user'|'assistant', text, thinking, tools, usage, model, ts, streaming}]
    adding: false,     // inline "add workspace" input is open
    sessions: [],
    teamData: null,    // /agent-team snapshot (teams.yaml + config.json)
    team: null,        // which team's subagents are shown in the right rail
    loadingSid: null,  // session whose events are being fetched into the window
    openSid: null,     // session_id whose transcript is currently shown (timeline target)
    lastOpenCount: null, // event_count of the open session at last load — refetch when it grows
    expandedWs: new Set(loadExpandedWs()),
    collapsedSecs: new Set(loadCollapsedSecs()),
    subOpen: new Set(loadSubOpen()), // expanded subagent groups (default: collapsed)
    footer: null,          // /chat/footer snapshot { branch, thinking, modelMeta, goUsage }
    footerFetchedAt: 0,
    thinkingLevel: null,   // selected thinking level (defaults to footer.thinking)
    showThinking: loadBool("scope-chat-show-thinking", false), // global fold/unfold of thought blocks
    expandTools: loadBool("scope-chat-expand-tools", false),   // fold chips vs. show tool calls with results
    steer: loadBool("scope-chat-steer", false), // send next message mid-run (steer) vs queue until done
    listening: false,   // dictation (speech to text) is recording on the host
    sttInFlight: false, // a stop/transcribe request is pending
    sttTimer: null,     // interval id driving the recording clock
    sttStartedAt: 0,    // ms epoch the current recording began
    sttMaxSeconds: 120, // server clip cap — the client auto-stops just after it
    sttInfo: null,      // /chat/stt/status snapshot (hasApiKey, recorderAvailable…)
    sttInfoCwd: null,   // workspace that snapshot was fetched for
    sttFetching: false,
    listenBase: "",     // composer text before the dictated span
    listenTail: "",     // composer text after the dictated span
    customWs: loadCustomWs(), // union of chat workspaces seen across projects (sidebar display cache)
    threads: new Map(),   // thread id → thread (one per chat conversation, keyed by session id or "free:<cwd>")
    curId: null,          // id of the thread currently shown in the canvas
  };

  // ─── Per-session threads ──────────────────────────────────────────────────
  // Every conversation the user can chat in is an independent THREAD with its
  // own pi subprocess on the server (keyed by its session id) and its own
  // message list, busy state and live stream. One thread is visible at a time
  // (the canvas); the others keep RUNNING in the background — their streams
  // still arrive and update their messages, they just don't touch the DOM
  // until you switch back, at which point live streaming resumes. Typing in a
  // busy thread queues the message within that thread; typing in an idle
  // thread starts a fresh turn there. Nothing waits on another session.
  function makeThread(id, kind, sid) {
    return {
      id,                // map key: the session id, or "free:" + workspace
      kind,              // "free" (new conversation) | "session" (recorded session)
      sid: sid || null,  // recorded session id (free threads adopt one once recorded)
      workspace: CH.workspace,
      key: null,         // server subprocess key (the session id for session threads)
      resumeFile: null,  // pi session file to continue
      firstPrompt: null, // first user prompt text (free thread — matches its recorded row)
      adopted: false,    // free thread already matched to its recorded session row
      history: [],       // [{role, text, thinking, tools, usage, model, ts, streaming}]
      busy: false,       // a turn is streaming on this thread
      gen: 0,            // turn generation guard (a newer turn supersedes an older finalize)
      live: null,        // { m, isFirst, queue, after } while busy
      suppressed: false, // busy but not visible — events update the model only
      dialogs: new Map(),// open extension_ui dialogs for this thread
      pendingCustom: null,
      openSid: null,     // recorded session shown (== sid for session threads)
      lastOpenCount: null,
      loadingSid: null,
      loadGen: 0,        // transcript-load generation (a newer load supersedes an older response)
    };
  }
  function curThread() {
    return CH.threads.get(CH.curId) || null;
  }
  function freeThreadId() {
    return "free:" + (CH.workspace || "");
  }
  // Get or create the workspace's "new conversation" thread.
  function freeThread(ws) {
    const id = "free:" + (ws || "");
    let t = CH.threads.get(id);
    if (!t) {
      t = makeThread(id, "free", null);
      t.workspace = ws || null;
      CH.threads.set(id, t);
    }
    return t;
  }
  // Get or create a recorded-session thread.
  function sessionThread(sid, resumeFile, workspace) {
    let t = CH.threads.get(sid);
    if (!t) {
      t = makeThread(sid, "session", sid);
      t.workspace = workspace || CH.workspace;
      t.resumeFile = resumeFile || null;
      t.openSid = sid;
      CH.threads.set(sid, t);
    }
    return t;
  }
  // Bind the visible canvas to a thread: mirror its state into the singleton
  // CH fields the rest of the UI reads, so rendering/persistence keep working
  // unchanged on the current thread.
  function bindThread(t) {
    if (!t) return;
    CH.curId = t.id;
    CH.chatHistory = t.history;
    CH.chatSessionId = t.key;
    CH.resumeFile = t.resumeFile;
    CH.chatBusy = t.busy;
    CH.suppressLive = t.suppressed;
    CH.openSid = t.openSid;
    CH.loadingSid = t.loadingSid;
    CH.lastOpenCount = t.lastOpenCount;
  }
  // Keep the singleton mirrors in sync after a thread's state changed in place.
  function syncCurThread() {
    const t = curThread();
    if (!t) return;
    CH.chatHistory = t.history;
    CH.chatSessionId = t.key;
    CH.chatBusy = t.busy;
    CH.suppressLive = t.suppressed;
    CH.openSid = t.openSid;
    CH.loadingSid = t.loadingSid;
    CH.lastOpenCount = t.lastOpenCount;
  }
  // How far a recorded session's start may sit from a live conversation's first
  // message for it to still count as that conversation's recording. A session
  // that began much earlier cannot be the one a prompt typed just now belongs
  // to, even if it shares the opening line.
  const ADOPT_FRESH_MS = 60 * 60 * 1000;
  // While a turn is still streaming, its row must be the conversation's OWN
  // recording — and that row is created by the conversation's first prompt, so
  // its first event can never sit meaningfully before the send. A small
  // tolerance absorbs event/clock jitter; an older same-prompt session is
  // rejected. Idle adoption keeps the looser ADOPT_FRESH_MS window because a
  // restored conversation's in-memory start can sit well before its row.
  const ADOPT_NOT_OLDER_MS = 5000;
  // The opening prompt of a free thread (the text pi records as first_msg).
  function threadFirstPrompt(t) {
    return (t.history.find((m) => m.role === "user")?.text || t.firstPrompt || "")
      .slice(0, 200).trim();
  }
  // The recorded row that IS a free thread's conversation: same workspace, not
  // a subagent, same opening prompt — and when several sessions share that
  // prompt, whichever STARTED closest to when this conversation was sent.
  // Matching by list order alone could adopt an unrelated same-prompt session,
  // which then showed the live conversation as that session's transcript (and
  // sent its prompts to the wrong session file).
  //
  // `requireNotOlder` is the streaming-turn mode: a live thread may only bind a
  // row that did not start before the conversation (see ADOPT_NOT_OLDER_MS),
  // which is exactly its own recording. Without it, a streaming turn could be
  // aliased to an older same-prompt session because the real row had not been
  // polled in yet.
  function matchRecordedRow(t, requireNotOlder = false) {
    const want = threadFirstPrompt(t);
    if (!want) return null;
    const started = t.history[0]?.ts || 0;
    let best = null;
    let bestScore = Infinity;
    for (const s of CH.sessions) {
      if (s.cwd !== t.workspace || s.parent_session_id) continue;
      if (String(s.first_msg || "").slice(0, 200).trim() !== want) continue;
      // A row already serving another thread is taken.
      const claimed = CH.threads.get(s.session_id);
      if (claimed && claimed !== t) continue;
      const ft = Date.parse(s.first_ts || "") || 0;
      if (requireNotOlder) {
        // No timestamps means we cannot prove this row belongs to the live
        // conversation, so it is left to a dedicated session thread.
        if (!started || !ft || ft < started - ADOPT_NOT_OLDER_MS) continue;
      } else if (started && ft && Math.abs(ft - started) > ADOPT_FRESH_MS) {
        // A session that clearly predates this conversation cannot be its
        // recording, even when it opens with the same prompt.
        continue;
      }
      const score = started && ft ? Math.abs(ft - started) : 0;
      if (score < bestScore) { best = s; bestScore = score; }
    }
    return best;
  }
  // Find the thread serving a recorded session: an existing session thread, or
  // a free thread whose conversation got recorded under that id. Only aliases
  // when THIS row is genuinely the recording of that conversation (see
  // matchRecordedRow) — otherwise the caller builds a dedicated session thread.
  function threadForSid(sid) {
    if (!sid) return null;
    if (CH.threads.has(sid)) return CH.threads.get(sid);
    const row = CH.sessions.find((s) => s.session_id === sid);
    if (!row) return null;
    // A subagent session is never a free thread's own conversation — the
    // match below is by first prompt, and a subagent can share it. Return null
    // so the caller creates a dedicated session thread instead of aliasing
    // (and overwriting) a workspace conversation.
    if (row.parent_session_id) return null;
    if (!String(row.first_msg || "").trim()) return null;
    for (const t of CH.threads.values()) {
      // A streaming thread may still be aliased to the row pi just recorded for
      // it — but ONLY that row. This is what keeps the Stop button (and the live
      // turn) attached when the user opens the streaming session's row: the
      // thread's own row sits at/after its first prompt, while an older
      // same-prompt session is rejected (see matchRecordedRow).
      if (t.kind !== "free" || t.adopted) continue;
      if (t.workspace !== row.cwd) continue;
      if (matchRecordedRow(t, t.busy)?.session_id !== sid) continue;
      t.adopted = true;
      t.sid = sid;
      t.resumeFile = row.session_file || t.resumeFile;
      CH.threads.set(sid, t);
      return t;
    }
    return null;
  }
  // Called on every poll: match un-adopted free threads to the session row pi
  // recorded for them, so opening that row continues the SAME thread/subprocess
  // instead of spawning a second pi on the same session file. A busy thread is
  // matched strictly (its own row only) so its live stream and Stop button stay
  // reachable from the row while the turn is still running.
  function adoptFreeThreads() {
    const seen = new Set();
    for (const t of CH.threads.values()) {
      if (seen.has(t)) continue;
      seen.add(t);
      if (t.kind !== "free" || t.adopted) continue;
      const row = matchRecordedRow(t, t.busy);
      if (!row) continue;
      if (CH.threads.has(row.session_id)) continue;
      t.adopted = true;
      t.sid = row.session_id;
      t.resumeFile = row.session_file || t.resumeFile;
      CH.threads.set(row.session_id, t);
    }
  }
  // Drop the session-id aliases a free thread picked up (see threadForSid /
  // adoptFreeThreads). pi records a free conversation under a session id and
  // the rail maps BOTH keys to this ONE thread, so once the thread is reset to a
  // brand-new conversation the stale session key still points at it: reopening
  // that session row showed the new conversation, and prompts sent to either
  // appeared in both. The session row then rebuilds as its own thread.
  function dropThreadAliases(t) {
    if (!t) return;
    for (const [key, val] of [...CH.threads]) {
      if (val === t && key !== t.id) CH.threads.delete(key);
    }
  }
  // (Re)resolve the live DOM pointers of an attached busy thread after the
  // canvas was rendered: children[i] ↔ history[i] by index parity.
  function attachLiveDom(t) {
    if (!t || !t.live || !el.msg) return;
    const mIdx = t.history.indexOf(t.live.m);
    const row = mIdx >= 0 ? el.msg.children[mIdx] : null;
    t.live.body = row ? row.querySelector(".chat-msg-body") : null;
    for (const q of t.live.queue || []) {
      const qi = t.history.indexOf(q.msg);
      q.node = qi >= 0 ? el.msg.children[qi] : null;
    }
    if (t.live.after) {
      const ai = t.history.indexOf(t.live.after.msg);
      t.live.after.node = ai >= 0 ? el.msg.children[ai] : null;
    }
  }
  // Leave a busy thread: freeze its DOM preview, decline any on-screen
  // question (pi must not hang on an invisible card) and keep updating its
  // model in the background.
  function detachThread(t) {
    if (!t || !t.busy) return;
    t.suppressed = true;
    for (const dlg of [...t.dialogs.values()]) {
      if (dlg && dlg.id) void postUiAnswer(dlg.id, { cancelled: true }, t);
    }
    t.dialogs.clear();
    t.pendingCustom = null;
    if (t.live) t.live.body = null;
  }
  // Return to a busy thread (via a workspace or session click): resume live
  // DOM streaming. Mirrors detachThread — clears the freeze so handleChatEvent
  // treats the thread as attached again. Call after renderChat() so the DOM
  // pointers resolve against the freshly rendered rows.
  function attachThread(t) {
    if (!t) return;
    t.suppressed = false;
    if (t.busy && t.live) attachLiveDom(t);
  }

  const el = {};
  // Workspaces whose saved conversation has already been considered for
  // restore. A fresh page load starts with NO workspace selected (the user
  // picks one from the rail), so the snapshot is restored when they pick the
  // workspace it belongs to — never for a different one.
  const restoreTried = new Set();

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
    el.agentCount = $("#chat-agent-count");
    el.headerModel = $("#chat-header-model");
    el.liveDot = $("#chat-live-dot");
    el.scrollDown = $("#chat-scroll-down");
    el.btnNew = $("#chat-new");
    el.btnOpen = $("#chat-open-session");
    el.toggleLeft = $("#chat-toggle-left");
    el.toggleRight = $("#chat-toggle-right");
    el.composer = $("#chat-composer");
    el.footer = $("#chat-composer-footer");
    el.thinking = $("#chat-thinking");
    el.steer = $("#chat-steer");
    el.stop = $("#chat-stop");
    el.listen = $("#chat-listen");
  }

  // ─── Selectors / data ─────────────────────────────────────────────────────
  // pi's background memory summarizer spawns a fresh session for every
  // orchestrator turn; it isn't a user conversation, so keep it out of the
  // workspace session list and agent rails.
  function isChatSession(s) {
    return (s.agent_name || "").toLowerCase() !== "memory-summarizer";
  }

  function workspaces() {
    const map = {};
    for (const s of CH.sessions) {
      const cwd = s.cwd || "(unknown)";
      (map[cwd] = map[cwd] || []).push(s);
    }
    // Custom (session-less) workspaces: the union of every project's list we've
    // seen, minus removals — stable across workspace switches and reloads.
    const custom = (CH.customWs?.list || []).filter((cwd) => !(CH.customWs?.removed || []).includes(cwd));
    for (const cwd of custom) if (!map[cwd]) map[cwd] = [];
    return Object.keys(map)
      .sort((a, b) => (a === "(unknown)" ? 1 : b === "(unknown)" ? -1 : a.localeCompare(b)));
  }

  function wsSessions(cwd) {
    return CH.sessions.filter((s) => (s.cwd || "(unknown)") === cwd);
  }

  // ─── Public hooks (called from app.js) ────────────────────────────────────
  // Cheap signature of the session list + active team, used to skip full rail
  // rebuilds when the poll has nothing new to show.
  let railSig = null;
  // Last markup written to each rail — a re-render that produces identical HTML
  // is skipped entirely (an innerHTML swap re-creates every node for nothing).
  let wsRailHtml = null;
  let agentsRailHtml = null;
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
    CH.sessions = (state.sessions || []).filter(isChatSession);
    // A free conversation's recorded row may have just appeared — match it to
    // the free thread so opening it continues the same subprocess.
    adoptFreeThreads();
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
    // Header state reflects the CURRENT thread's busy flag (background threads
    // don't affect the visible one). The message list itself only changes
    // through explicit actions / streams, which re-render on their own.
    updateHeader();
    updateScrollDown();
    attemptRestore();
    refreshOpenSession();
  }

  function onView() {
    CH.sessions = (state.sessions || []).filter(isChatSession);
    adoptFreeThreads();
    loadAgentTeam();
    renderWorkspaces();
    renderAgents();
    renderComposerModel();
    renderChat();
    attemptRestore();
    refreshOpenSession();
    // Returning to the Chat view should land ready to type: the view switch is
    // an explicit user action, and the composer is the primary surface here.
    if (CH.workspace) focusComposer();
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
      const empty =
        '<div class="chat-rail-empty">No workspaces yet.<br>Add a directory or run a pi agent to start streaming.</div>' +
        html;
      if (wsRailHtml === empty) return;
      wsRailHtml = empty;
      el.ws.innerHTML = empty;
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
      // Build the parent/child tree straight from the workspace's sessions.
      // No pre-nesting pass: ordering children after a parent that sorts
      // earlier in the poll (active subagents have newer last_ts than the
      // orchestrator) used to emit each child TWICE — once in its own right
      // and again under the parent — doubling the fold rows while a run
      // streamed. buildWsSessionTree groups by parent id itself.
      const tree = buildWsSessionTree(sessions);
      html += `<div class="chat-ws-children"${expanded ? "" : ' style="display:none"'}>` + renderWsSessionTree(tree) + `</div>`;
    }
    // Skip the write when the markup is identical (the poll re-renders the
    // rail every 10s): an innerHTML swap would throw away every node — and
    // with it the focus ring on the inline add-row input — for nothing.
    if (wsRailHtml === html) return;
    // The add-row's typed value lives only in the DOM (not in the markup), so
    // carry it across the swap — a background session event changing the rail
    // while the user types a path used to wipe what they had entered.
    const prevAdd = CH.adding ? document.getElementById("chat-ws-add-input")?.value : null;
    wsRailHtml = html;
    el.ws.innerHTML = html;
    if (CH.adding) {
      const inp = document.getElementById("chat-ws-add-input");
      if (inp) {
        if (prevAdd) inp.value = prevAdd;
        inp.focus();
      }
    }
  }

  // One session row under a workspace — clicking loads it in the chat window.
  // The row stays minimal (status dot + first message); the session message
  // and status live in the hover tooltip, and the model / token usage / time
  // are shown in the composer status line below the input.
  // `groupActive` is true when one of this session's descendant subagents is
  // still running: the moment a main session hands work to a subagent it stops
  // emitting its own events, so `last_ts` goes stale and the row would flip to
  // "waiting" while the tree is in fact still working. Keep reporting
  // "running" then — but never for a stopped (red) session, which a lingering
  // child must not mask.
  function renderWsSession(s, isNested, groupActive) {
    const name = s.agent_name ?? s.cwd?.split("/").pop() ?? S.shortId(s.session_id);
    const own = S.subagentStatus(s);
    const st = groupActive && own !== "red" ? "green" : own;
    const stMeta = piStatusMeta(st);
    const stats = state.sessionStats[s.session_id];
    const hasErr = (stats?.error_count || 0) > 0;
    const row1 = s.first_msg ? S.trunc(s.first_msg, 46) : name;
    const statusText = stMeta.word + (hasErr ? " ⚠ needs review" : "");
    const tip = (s.first_msg ? s.first_msg : name) + (statusText ? " — " + statusText : "") +
      (isNested && s.parent_session_id ? " — spawned by session " + S.shortId(s.parent_session_id) : "");
    return (
      `<div class="ws-sess${isNested ? " ws-sess-sub" : ""}" data-sid="${esc(s.session_id)}" title="${esc(tip)}">` +
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

  // Split a workspace's session list into { roots, subs }: main sessions plus
  // the subagent sessions each spawned (children keep the poll order, so they
  // render newest-first within their group). A session whose parent isn't in
  // the same workspace list is a root, so orphans never vanish.
  function buildWsSessionTree(sessions) {
    const byId = new Map(sessions.map((s) => [s.session_id, s]));
    const subs = new Map(); // parent session_id → child sessions
    const parentOf = new Map(); // session_id → parent session_id
    const roots = [];
    for (const s of sessions) {
      const p = s.parent_session_id;
      // A parent link is only an edge when the parent is present here and isn't
      // the session itself (a self-parented row is a root, not its own child).
      if (p && p !== s.session_id && byId.has(p)) {
        if (!subs.has(p)) subs.set(p, []);
        subs.get(p).push(s);
        parentOf.set(s.session_id, p);
      } else {
        roots.push(s);
      }
    }
    // Nothing reaches a session trapped in a parent cycle (a→b→a, or a chain
    // hanging off one) — it used to be dropped from the rail entirely. Promote
    // the first unreachable session to a root and cut its back-edge, repeating
    // until every session is reachable, so cycles render without looping.
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

  // Render a workspace's sessions as a tree: each main (root) session row is
  // followed by a fold row that expands/collapses its spawned subagent rows.
  // Groups default to collapsed — subagents fold under their main session and
  // are revealed on demand instead of always cluttering the rail.
  function renderWsSessionTree({ roots, subs }) {
    const rendered = new Set();
    // A group counts as running when any DESCENDANT subagent is — a nested
    // chain must not hide that activity behind a collapsed parent.
    const runningUnder = (sid) => {
      for (const k of subs.get(sid) || []) {
        if (S.subagentStatus(k) === "green" || runningUnder(k.session_id)) return true;
      }
      return false;
    };
    // Recursive: a subagent that spawned its own subagents renders its rows and
    // then its own fold group, so arbitrarily deep chains appear in full.
    const level = (s, nested) => {
      if (rendered.has(s.session_id)) return ""; // cycle guard (defensive)
      rendered.add(s.session_id);
      // Computed once and shared by the row dot and the fold indicator: a
      // parent keeps its "running" status while any descendant is live.
      const running = runningUnder(s.session_id);
      const rows = renderWsSession(s, nested, running);
      const kids = subs.get(s.session_id) || [];
      if (!kids.length) return rows;
      const open = CH.subOpen.has(s.session_id);
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

  // Expand/collapse a main session's subagent group (default: collapsed).
  function toggleSubs(sid) {
    if (!sid) return;
    if (CH.subOpen.has(sid)) CH.subOpen.delete(sid);
    else CH.subOpen.add(sid);
    saveSubOpen();
    renderWorkspaces();
  }

  // Drop a thread's recorded-session view so the canvas shows that thread's own
  // conversation instead of a transcript. pi records a free conversation under a
  // session id, and the rail aliases both keys to this ONE thread — so a
  // workspace click could rebind a thread still sitting in "viewing session S"
  // mode and reopen that transcript, which is exactly what selecting a
  // workspace must never do. The messages and the resume file are kept: an
  // adopted free thread IS the recorded conversation, and the next prompt has to
  // keep continuing it rather than fork a second pi on the same session file.
  // Returns whether a session view was actually dropped.
  function clearSessionView(t) {
    if (!t || t.openSid == null) return false;
    t.openSid = null;
    t.loadingSid = null;
    t.lastOpenCount = null;
    return true;
  }

  // Replace a hint left over from a transcript ("N messages from session")
  // with one that describes the conversation now on screen.
  function setConversationHint(t) {
    if (!el.hint) return;
    const n = t.history.length;
    setHint(n ? `${n} message${n === 1 ? "" : "s"} in this conversation — type to continue` : "", "");
  }

  // Return the canvas to a workspace's own conversation (its free thread) —
  // e.g. after browsing a recorded session, clicking the active workspace row
  // brings you back to the chat you were having there, resuming its live
  // stream if it's still running.
  function showFreeConversation(cwd) {
    const prev = curThread();
    const t = freeThread(cwd);
    if (prev && prev !== t) detachThread(prev);
    const wasSessionView = clearSessionView(t);
    bindThread(t);
    renderAgents(); // the open-session highlight follows the canvas
    updateHeader();
    renderChat();
    attachThread(t); // resume live streaming if this thread is still running
    if (wasSessionView) setConversationHint(t);
    // Clicking a workspace is a request to chat there — including when it is
    // already the active row. Make sure a pi session is armed: the workspace's
    // session may have been dropped (e.g. its recorded session was deleted from
    // the Single view), and without this the box showed with nothing behind it
    // until the user clicked "New session". Idempotent while one is live.
    ensureChatSession();
    focusComposer();
  }

  // Ask the host file manager for a directory (Electron only).
  async function browseForWorkspace() {
    if (typeof window.scopeNative?.pickDirectory !== "function") return;
    try {
      const dir = await window.scopeNative.pickDirectory();
      if (dir) submitAddWorkspace(dir);
    } catch { /* dialog failed — fall back to manual entry */ }
  }

  // ─── Rail interaction (event delegation) ──────────────────────────────────
  // Both rails are rebuilt whenever their data changes. Wiring per-node
  // listeners on every rebuild allocated a closure per row and ran a
  // querySelector pass per selector, and had to be re-run on each write; one
  // delegated listener per rail container does the same dispatch and is
  // attached exactly once, so a rail render is a single innerHTML write.
  // Most specific target first — session rows and the fold row sit inside the
  // children container, and the remove/caret affordances inside the workspace
  // row (previously guarded with stopPropagation).
  function wireRailDelegation() {
    if (el.ws) {
      el.ws.addEventListener("click", (e) => {
        const del = e.target.closest(".ws-sess-del");
        if (del) { deleteChatSession(del.dataset.del); return; }
        const sess = e.target.closest(".ws-sess");
        if (sess) { loadSessionChat(sess.dataset.sid); return; }
        const fold = e.target.closest(".ws-sess-fold");
        if (fold) { toggleSubs(fold.dataset.fold); return; }
        const remove = e.target.closest(".chat-ws-remove");
        if (remove) { removeWorkspace(remove.dataset.remove); return; }
        const caret = e.target.closest(".chat-ws-caret");
        if (caret) { toggleWs(caret.closest(".chat-ws")?.dataset.cwd); return; }
        if (e.target.closest("#chat-ws-browse")) { void browseForWorkspace(); return; }
        const row = e.target.closest(".chat-ws");
        if (!row) return;
        const cwd = row.dataset.cwd;
        if (CH.workspace !== cwd) selectWorkspace(cwd);
        else showFreeConversation(cwd);
      });
      el.ws.addEventListener("keydown", (e) => {
        if (!e.target.closest("#chat-ws-add-input")) return;
        if (e.key === "Enter") { e.preventDefault(); submitAddWorkspace(); }
        else if (e.key === "Escape") { e.preventDefault(); CH.adding = false; renderWorkspaces(); }
      });
    }
    if (el.agents) {
      el.agents.addEventListener("click", (e) => {
        const head = e.target.closest(".at-sec-head");
        if (head) { toggleSection(head.dataset.sec); return; }
        const team = e.target.closest(".at-chip[data-team]");
        if (team) { CH.team = team.dataset.team; postTeam({ action: "setTeam", team: team.dataset.team }); return; }
        // The card wraps a decorative toggle button; either hit toggles it.
        const card = e.target.closest(".at-card[data-action]");
        if (card) { postTeam({ action: card.dataset.action }); return; }
        const tool = e.target.closest(".at-chip[data-tool]");
        if (tool) { postTeam({ action: "toggleTool", tool: tool.dataset.tool }, { liveConfig: true }); return; }
        const skill = e.target.closest(".at-chip[data-dir]");
        if (skill) { postTeam({ action: "toggleSkill", group: skill.dataset.group, dir: skill.dataset.dir }); return; }
        const ext = e.target.closest(".at-chip[data-path]");
        if (ext) { postTeam({ action: "toggleExtension", path: ext.dataset.path }); return; }
        const sub = e.target.closest(".at-chip.sub[data-agent]");
        if (sub) {
          const name = sub.dataset.agent || "";
          const off = new Set(CH.teamData?.disabledAgents || []).has(name.toLowerCase());
          postTeam({ action: "toggleAgent", agent: name, disabled: !off });
          return;
        }
        const sidChip = e.target.closest(".at-chip[data-sid]");
        if (sidChip) loadSessionChat(sidChip.dataset.sid);
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

  // Delete a session from the workspace rail. The actual delete (confirm +
  // DELETE + main-sidebar re-render) lives in the app; on success the app calls
  // __chatOnSessionDeleted, which runs forgetChatSession below.
  function deleteChatSession(sid) {
    if (typeof window.SCOPE?.deleteSession !== "function") return;
    void window.SCOPE.deleteSession(sid);
  }

  // Forget a recorded session that was deleted anywhere in the UI (the rail
  // here, or the Single view's sidebar). Idempotent — safe to run twice.
  // Clears any open transcript, kills the session's pi subprocess and drops its
  // thread so a deleted conversation can't keep streaming into the UI.
  function forgetChatSession(sid) {
    if (!sid) return;
    const cur = curThread();
    const visible = !!cur && cur.openSid === sid;
    const dead = CH.threads.get(sid);
    killChatKey(dead?.key);
    CH.threads.delete(sid);
    // A workspace conversation can be aliased to this row (pi recorded it under
    // this id). Unbind it instead of leaving it stuck on a session that no
    // longer exists: it is the workspace's own conversation again, with no
    // subprocess and no resume target, so it can re-adopt to the next row pi
    // records for it rather than forking a second pi on the same file.
    if (dead && dead.kind === "free") {
      dead.sid = null;
      dead.adopted = false;
      dead.key = null;
      dead.resumeFile = null;
      if (curThread() === dead) syncCurThread();
    }
    if (visible) {
      // The deleted session was on screen: drop the canvas back to the
      // workspace's blank conversation and re-arm a fresh pi session so the
      // composer is immediately usable instead of pointed at a dead key.
      killChatKey(cur.key);
      CH.threads.delete(cur.id);
      bindThread(freeThread(CH.workspace));
      renderChat();
      updateHeader();
      ensureChatSession();
    }
    CH.sessions = (state.sessions || []).filter(isChatSession);
    railSig = chatRailSig();
    renderWorkspaces();
    renderAgents();
  }

  // Every recorded session was just wiped from the store (the Single view's
  // "Clear all agents"). Chat holds its own thread/subprocess state, so the
  // streaming turn's stuck "busy" flag and its now-orphaned subprocess key used
  // to keep the composer hostage — New disabled and every message queued to a
  // conversation that no longer existed. Kill the subprocesses, forget every
  // thread and re-arm the open workspace's own fresh conversation.
  function forgetAllChatSessions() {
    for (const t of new Set(CH.threads.values())) killChatKey(t.key);
    CH.threads.clear();
    clearSnapshot();
    if (CH.workspace) {
      const t = freeThread(CH.workspace);
      bindThread(t);
      ensureChatSession();
      renderChat();
      updateHeader();
      renderChatFooter();
      focusComposer();
    } else {
      CH.curId = null;
      CH.chatHistory = [];
      CH.chatSessionId = null;
      CH.resumeFile = null;
      CH.chatBusy = false;
      CH.suppressLive = false;
      CH.openSid = null;
      CH.loadingSid = null;
      CH.lastOpenCount = null;
      renderChat();
      updateHeader();
    }
    CH.sessions = (state.sessions || []).filter(isChatSession);
    railSig = chatRailSig();
    renderWorkspaces();
    renderAgents();
  }

  async function submitAddWorkspace(picked) {
    const input = document.getElementById("chat-ws-add-input");
    const err = document.getElementById("chat-ws-add-err");
    const p = (picked ?? (input?.value || "")).trim();
    if (!p) { CH.adding = false; renderWorkspaces(); return; }
    try {
      const before = new Set(CH.customWs?.list || []);
      const { res, data } = await window.SCOPE.api("/agent-team", {}, { action: "addWorkspace", path: p, cwd: CH.workspace || "" });
      if (res.ok && data) {
        CH.teamData = data;
        // Re-adding un-hides the workspace in the local union (the server also
        // clears chatWorkspacesRemoved in the project configs it writes).
        CH.customWs.removed = (CH.customWs.removed || []).filter((w) => w !== p);
        if (!CH.customWs.list.includes(p)) CH.customWs.list.push(p);
        saveCustomWs();
        mergeCustomWs(data);
        CH.adding = false;
        renderWorkspaces();
        // Prefer the exact path the user typed when the server echoed it back
        // (the config stores the canonical resolved path, so a relative/symlink
        // input falls back to the first workspace in the response we hadn't
        // seen before, then the typed path). This avoids selecting a random
        // pre-existing workspace that merely sorts first in the response.
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
    // Removing a workspace also deletes its sessions + events from the store
    // (the server does it in the same request), so confirm the destructive part
    // once up front.
    if (sessions.length && !confirm(
      `Remove "${name}"?\n\n` +
      `This permanently deletes its ${sessions.length} recorded session${sessions.length === 1 ? "" : "s"} ` +
      `and events from the database. This cannot be undone.`
    )) return;
    try {
      const { res, data } = await window.SCOPE.api("/agent-team", {}, { action: "removeWorkspace", path: cwd, cwd: CH.workspace || "" });
      if (res.ok && data) {
        CH.teamData = data;
        mergeCustomWs(data);
      }
      // Drop the removed workspace from the local union regardless of the
      // server response so the sidebar hides it immediately and forever.
      CH.customWs.list = (CH.customWs.list || []).filter((w) => w !== cwd);
      if (!CH.customWs.removed.includes(cwd)) CH.customWs.removed.push(cwd);
      saveCustomWs();
    } catch { /* server unreachable — re-render from local state below */ }
    // Stop any pi subprocesses that were running here and forget their threads,
    // so a session that was just deleted can't keep streaming into the UI.
    for (const s of sessions) {
      killChatKey(CH.threads.get(s.session_id)?.key);
      CH.threads.delete(s.session_id);
    }
    killChatKey(CH.threads.get("free:" + cwd)?.key);
    CH.threads.delete("free:" + cwd);
    // The workspace's sessions are gone from the DB — drop them from the local
    // snapshot and forget a saved conversation that belonged to this cwd.
    CH.sessions = CH.sessions.filter((s) => (s.cwd || "(unknown)") !== cwd);
    try {
      const snap = JSON.parse(localStorage.getItem(SNAP_KEY) || "null");
      if (snap && snap.cwd === cwd) clearSnapshot();
    } catch {}
    if (CH.workspace === cwd) {
      // Back to the "Select a workspace" state — the user picks the next one
      // rather than having one loaded for them.
      CH.workspace = null;
      CH.curId = null;
      CH.chatHistory = [];
      CH.chatSessionId = null;
      CH.resumeFile = null;
      CH.chatBusy = false;
      CH.suppressLive = false;
      CH.openSid = null;
      CH.loadingSid = null;
      CH.lastOpenCount = null;
      persistWorkspace();
      updateHeader();
      renderChat();
    }
    renderWorkspaces();
    renderAgents();
    // Deleting a workspace rewrites per-project config the whole app reads at
    // boot (Agent Team, the shared cwd used by Files/Git/Terminal, and the saved
    // workspace list), so reload instead of sitting on a half-updated state. A
    // plain reload is enough to pick up fresh JS too: static assets are served
    // cache-control: no-cache with an ETag, so the browser revalidates them.
    location.reload();
  }

  // ─── Agent-team rail (right) ─────────────────────────────────────────────
  let teamFetchedAt = 0;
  // The team snapshot object the rails were last rendered from. Comparing the
  // reference is O(1); this used to JSON.stringify the whole snapshot on every
  // poll just to detect a replacement that the assignment sites already know
  // about.
  let teamDataRef = null;
  async function loadAgentTeam() {
    // The /agent-team snapshot changes rarely; throttle the fetch so the poll
    // doesn't hammer the server.
    const now = Date.now();
    if (teamFetchedAt && now - teamFetchedAt < 15000) {
      // A writer replaced the snapshot since the last render (add/remove
      // workspace, a team toggle) — refresh the rails without re-fetching.
      if (CH.teamData && CH.teamData !== teamDataRef) {
        teamDataRef = CH.teamData;
        renderAgents();
        renderWorkspaces();
      }
      return;
    }
    teamFetchedAt = now;
    // agent-team config is per project: fetch the currently open chat
    // workspace's .pi/settings (the server falls back to the last project
    // when no workspace is selected yet).
    const params = CH.workspace ? { cwd: CH.workspace } : {};
    const { res, data } = await window.SCOPE.api("/agent-team", params);
    if (res.ok && data) {
      CH.teamData = data;
      mergeCustomWs(data);
    }
    teamDataRef = CH.teamData || null;
    renderAgents();
    renderWorkspaces();
  }

  // Persist a sidebar toggle via POST /agent-team, then reload the snapshot.
  // Toggles write the CURRENT chat workspace's project config (cwd) — pi's
  // agent-team config is per project now.
  async function postTeam(body, opts) {
    let ok = false;
    try {
      const { res, data } = await window.SCOPE.api("/agent-team", {}, { ...body, cwd: CH.workspace || "" });
      if (res.ok && data) {
        CH.teamData = data;
        mergeCustomWs(data);
        ok = true;
      }
    } catch { /* server unreachable — keep last snapshot */ }
    renderAgents();
    if (ok) rearmChatAfterConfigChange(opts);
  }

  // Team/mode/memory/skills toggles only affect a pi subprocess that boots
  // AFTER the change — a running `pi --mode rpc` read the agent-team config at
  // startup and never re-reads it. So a successful toggle re-arms the chat
  // session the same way the model dropdown does:
  //   • idle pre-spawn (no conversation yet): kill it and re-pre-spawn so the
  //     very next prompt runs under the freshly written config;
  //   • live conversation in progress: push the current model/thinking into the
  //     running subprocess via RPC (set_model / set_thinking_level) so those
  //     settings apply in place without killing the thread — harness-level
  //     settings (mode/memory/team) that pi only reads at boot still land on
  //     the next new session, which we surface in the hint.
  // Tool toggles are the exception: the agent-team extension inside the running
  // pi subprocess watches agent-team-config.json and re-applies its active tool
  // allowlist when skipOrchestratorTools changes (opts.liveConfig), so they
  // apply in place on the next turn — no respawn, no new session.
  function rearmChatAfterConfigChange(opts) {
    opts = opts || {};
    if (!CH.workspace) return;
    if (CH.chatBusy || CH.chatHistory.length) {
      if (CH.chatSessionId) {
        if (opts.liveConfig) {
          // Tools are re-applied by the extension inside the running
          // subprocess; nothing to push or restart.
          if (el.hint) setHint("⚙ tools updated — applies on the next turn", "");
        } else {
          // Refresh the composer footer first (it re-reads settings.json's new
          // default model/thinking), so the push reflects the freshly written
          // default when the user hasn't overridden it in the composer.
          void (async () => {
            await fetchChatFooter(true);
            renderComposerThinking();
            await pushLivePrefs(CH.chatModel, CH.thinkingLevel);
          })();
          if (el.hint) setHint("⚙ model/thinking applied to this chat; mode/team settings land on a new session", "");
        }
      } else if (el.hint) {
        setHint("⚙ team settings apply to a new chat session", "");
      }
      return;
    }
    if (!CH.chatSessionId) return; // nothing pre-spawned — next send spawns fresh anyway
    if (opts.liveConfig) return; // idle pre-spawn picks the change up live too — no respawn needed
    void (async () => {
      await killCurrentChatSession();
      ensureChatSession();
    })();
  }

  // Push the composer's model + thinking into the running pi subprocess so a
  // Settings change takes effect on the live agent (no respawn, context intact).
  // Falls back to the composer's current selection when either is unset so the
  // live session never gets a blank pref.
  async function pushLivePrefs(model, thinkingLevel) {
    const sid = CH.chatSessionId;
    if (!sid) return;
    const effModel = model || CH.chatModel || "";
    const effLevel = thinkingLevel || CH.thinkingLevel || CH.footer?.thinking || "";
    try {
      await fetch(window.apiUrl("/chat/prefs"), {
        method: "POST",
        headers: { ...window.authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: sid,
          model: effModel,
          thinkingLevel: effLevel,
        }),
      });
    } catch { /* server unreachable — prefs re-push on the next prompt anyway */ }
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

  // The whole agent-team view (orchestrator, teams, subagents, mode & memory)
  // is driven by pi's agent-team extension. It only shows when that extension
  // is available (its file exists on disk) AND enabled in settings.json, and
  // the harness "agent team enabled" master switch (agent-team-config.json
  // `enabled`, default on) is on. Anything less and the sidebar falls back to
  // the plain session list instead of showing team UI that isn't running.
  function teamHarnessOn(td) {
    if (!td) return true; // snapshot not loaded yet — keep the default until we know
    if (td.enabled === false) return false;
    return (td.extensions || []).some((ex) =>
      ex.available && ex.enabled && (ex.name === "agent-team" || /agent-team/.test(ex.path || ""))
    );
  }

  // The right rail's header chrome is agent-team specific — the "Agent Team"
  // label and its collapse toggle. When the team harness is off the rail just
  // lists sessions, so drop the toggle and retitle it.
  function applyRailHeader(teamsOn) {
    if (el.toggleRight) el.toggleRight.style.display = teamsOn ? "" : "none";
    const title = document.querySelector("#chat-agent-rail .chat-rail-title");
    if (title) title.textContent = teamsOn ? "Agent Team" : "Agents";
  }

  function renderAgents() {
    if (!el.agents) return;
    const td = CH.teamData;
    const teamsOn = teamHarnessOn(td);
    applyRailHeader(teamsOn);
    // The dictation mic is gated on the speech-to-text extension's enable
    // state, which lives in this same snapshot.
    renderSttButton();
    if (!td || !teamsOn || !td.teamsOrder || !td.teamsOrder.length) {
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

    // Skills are divided into orchestrator vs subagent groups; membership is
    // persisted in agent-team-config.json (orchestratorSkills / subagentSkills).
    // Each group section lists all discovered skills with per-group on/off, so
    // a skill can be enabled for the orchestrator, subagents, both, or neither.
    const skills = td.skills || [];
    const skillItem = (sk, group, on) =>
      `<div class="at-chip${on ? " on" : ""}" data-dir="${esc(sk.dir)}" data-group="${group}" title="${esc(sk.name)}${sk.description ? " — " + esc(sk.description) : ""}">` +
      `<span class="at-chip-dot"></span>` +
      `<span class="at-chip-name">${esc(sk.name)}</span>` +
      `</div>`;
    // Skills preceded by a single "skills" separator row (label + rule + count).
    const skillGroupsBody = (group) => {
      if (!skills.length) return "";
      const isOn = (sk) => (group === "orchestrator" ? !!sk.orchestrator : !!sk.subagent);
      const onCount = skills.filter(isOn).length;
      return (
        `<div class="at-group-label"><span>skills</span><span class="at-group-line"></span><span class="at-group-n">${onCount}/${skills.length}</span></div>` +
        skills.map((sk) => skillItem(sk, group, isOn(sk))).join("")
      );
    };

    html += atSection("orch", "Agent Team",
      `<div class="at-orch">` +
      `<span class="at-orch-icon"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a4 4 0 0 1 4 4c0 1.1-.45 2.1-1.17 2.83A4 4 0 0 1 18 12.5V14H6v-1.5a4 4 0 0 1 3.17-3.67A3.99 3.99 0 0 1 8 6a4 4 0 0 1 4-4z"/><path d="M6 14v3a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-3"/></svg></span>` +
      `<span class="at-orch-meta"><span class="at-orch-name">Orchestrator</span>` +
      `<span class="at-orch-status status-dot ${orchSt}"></span></span></div>` +
      (skills.length ? `<div class="at-chips">` + skillGroupsBody("orchestrator") + `</div>` : "")
    );

    // Orchestrator tools (what the orchestrator may call), mirroring the pi
    // sidebar's Tools section. Each chip toggles membership in the
    // skipOrchestratorTools denylist (agent-team-config.json); the list itself
    // is rebuilt server-side from captured llm_request tool lists + the denylist.
    const skipTools = new Set((td.skipOrchestratorTools || []).map((t) => String(t).toLowerCase()));
    const tools = td.tools || [];
    const toolItem = (name) => {
      const on = !skipTools.has(String(name).toLowerCase());
      return (
        `<div class="at-chip${on ? " on" : ""}" data-tool="${esc(name)}" title="${esc(name)} — ${on ? "enabled for orchestrator" : "skipped by orchestrator"}">` +
        `<span class="at-chip-dot"></span>` +
        `<span class="at-chip-name">${esc(name)}</span>` +
        `</div>`
      );
    };
    const toolsBody = tools.length
      ? `<div class="at-chips">` + tools.map(toolItem).join("") + `</div>`
      : `<div class="at-dim">No tools observed yet — run a chat to build the list</div>`;
    html += atSection("tools", "Tools", toolsBody, {
      count: tools.length,
      hint: "Tools the orchestrator may call. Click to toggle on/off.",
    });

    html += atSection("mode", "Mode & Memory",
      `<div class="at-mm">` +
      `<div class="at-card mode" data-action="toggleMode" title="Click to toggle mode" role="button" tabindex="0">` +
      `<span class="at-card-ava">${mode === "creative" ? "◆" : "◇"}</span>` +
      `<span class="at-card-body"><span class="at-card-name">Mode</span>` +
      `<span class="at-card-sub">${mode === "creative" ? "Creative" : "Standard"}</span></span>` +
      `<button class="at-toggle${mode === "creative" ? " on" : ""}" type="button" data-mode-toggle title="Toggle mode" aria-pressed="${mode === "creative"}"><span class="at-toggle-knob"></span></button>` +
      `</div>` +
      `<div class="at-card mode" data-action="toggleMemory" title="Click to toggle memory" role="button" tabindex="0">` +
      `<span class="at-card-ava${memActive ? " mem-on" : ""}">⌾</span>` +
      `<span class="at-card-body"><span class="at-card-name">Memory</span>` +
      `<span class="at-card-sub">${memActive ? esc(memModel || "on") : "off"}</span></span>` +
      `<button class="at-toggle${memActive ? " on" : ""}" type="button" data-memory-toggle title="Toggle memory" aria-pressed="${memActive}"><span class="at-toggle-knob"></span></button>` +
      `</div>` +
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
          `<div class="at-chip team${isViewed ? " on" : ""}" data-team="${esc(tn)}" title="${esc(tn)} — ${activeCount}/${members.length} active">` +
          `<span class="at-chip-dot"></span>` +
          `<span class="at-chip-name">${esc(tn)}</span>` +
          `<span class="at-chip-count">${activeCount}/${members.length}</span>` +
          `${isActive ? `<span class="at-card-pill">active</span>` : ""}` +
          `</div>`;
      }
    }
    html += atSection("teams", "Teams", teamBody, { count: teamNames.length });

    const members = teams[viewedTeam] || [];
    let subBody = "";
    if (!members.length) subBody = `<div class="at-dim">No agents loaded</div>`;
    else {
      for (const m of members) {
        const lname = (m.name || "").toLowerCase();
        // A role can own several sessions (repeated dispatches). The chip speaks
        // for the most recently active one, and is highlighted when ANY of them
        // is the transcript on screen — binding to the first name match used to
        // miss the open session whenever an older same-role session sorted
        // first in the poll.
        const roleSessions = wsSessionsArr.filter((s) => (s.agent_name || "").toLowerCase() === lname);
        const sess = roleSessions
          .slice()
          .sort((a, b) => (Date.parse(b.last_ts) || 0) - (Date.parse(a.last_ts) || 0))[0];
        const isDisabled = disabled.has(lname);
        const enabled = !isDisabled;
        const st = sess ? S.subagentStatus(sess) : "gray";
        // The subagent whose transcript is on screen. (This used to read
        // CH.agentId, which was never assigned — so it never highlighted.)
        const isActive = roleSessions.some((s) => CH.openSid === s.session_id);
        const statusLabel = st === "green" ? "running" : st === "orange" ? "waiting" : st === "red" ? "stopped" : "idle";
        subBody +=
          `<div class="at-chip sub${enabled ? " on" : ""}${isActive ? " active" : ""}" data-agent="${esc(m.name)}" title="${esc(m.name)} — ${statusLabel}${enabled ? "" : " (disabled)"}">` +
          `<span class="status-dot ${st}"></span>` +
          `<span class="at-chip-name">${esc(m.name)}</span>` +
          (isDisabled ? `<span class="at-off">off</span>` : `<span class="at-on">on</span>`) +
          `</div>`;
      }
    }
    // Subagent skills follow the members, separated by a thin divider (mirrors
    // the pi agent-team sidebar layout).
    if (skills.length) subBody += `<div class="at-sep"></div><div class="at-chips">` + skillGroupsBody("subagent") + `</div>`;
    // Wrap member chips in the flex-wrap container so several share a row.
    subBody = `<div class="at-chips">` + subBody + `</div>`;
    html += atSection("subagents", "Subagents", subBody, { count: members.length });

    // Only show extensions that are both active and actually available on disk
    // (the server marks entries whose file exists); disabled or missing-file
    // extensions stay in the Settings page, where they can be re-enabled.
    const exts = (td.extensions || []).filter((ex) => ex.enabled && ex.available);
    let extBody = "";
    if (!exts.length) extBody = `<div class="at-dim">none enabled</div>`;
    else {
      for (const ex of exts) {
        extBody +=
          `<div class="at-chip on" data-path="${esc(ex.path)}" title="${esc(ex.path)}">` +
          `<span class="at-chip-dot"></span>` +
          `<span class="at-chip-name">${esc(ex.name)}</span>` +
          `</div>`;
      }
    }
    html += atSection("extensions", "Extensions", `<div class="at-chips">` + extBody + `</div>`, { count: exts.length });

    if (agentsRailHtml === html) return; // same markup — keep the live DOM
    agentsRailHtml = html;
    el.agents.innerHTML = html;
  }

  // Fallback: plain session list for the workspace (no agent-team config).
  function renderAgentSessions() {
    let sessions = CH.workspace ? wsSessions(CH.workspace) : CH.sessions;
    sessions = sessions.slice().sort((a, b) => new Date(b.last_ts) - new Date(a.last_ts));
    if (el.agentCount) el.agentCount.textContent = sessions.length;
    if (!sessions.length) {
      const empty = '<div class="chat-rail-empty">No agents in this workspace</div>';
      if (agentsRailHtml === empty) return;
      agentsRailHtml = empty;
      el.agents.innerHTML = empty;
      return;
    }
    let html = "";
    for (const s of sessions) {
      // Highlight the session whose transcript is open in the canvas.
      const active = CH.openSid === s.session_id ? " on active" : "";
      const name = s.agent_name ?? s.cwd?.split("/").pop() ?? S.shortId(s.session_id);
      const st = S.subagentStatus(s);
      const statusLabel = st === "green" ? "running" : st === "orange" ? "waiting" : st === "red" ? "stopped" : "idle";
      html +=
        `<div class="at-chip sub${active}" data-sid="${s.session_id}" title="${esc(name)} — ${statusLabel}">` +
        `<span class="status-dot ${st}"></span>` +
        `<span class="at-chip-name">${esc(name)}</span>` +
        `</div>`;
    }
    const full = `<div class="at-chips">` + html + `</div>`;
    if (agentsRailHtml === full) return;
    agentsRailHtml = full;
    el.agents.innerHTML = full;
  }

  // ─── Selection ────────────────────────────────────────────────────────────
  async function selectWorkspace(cwd) {
    CH.workspace = cwd;
    CH.team = null;
    CH.expandedWs.add(cwd);
    saveExpandedWs();
    // Switching workspaces never kills or resets other sessions' threads — it
    // just shows this workspace's own conversation (its free thread), which
    // keeps running in the background when you're elsewhere. Recorded sessions
    // keep running too; their transcripts reopen only from their own row.
    const prev = curThread();
    const t = freeThread(cwd);
    t.workspace = cwd;
    // Selecting a workspace always lands on the workspace's OWN conversation —
    // never on a recorded session (see clearSessionView: the rail aliases a
    // recorded session onto this same thread, so the old code could reopen that
    // transcript here).
    const wasSessionView = clearSessionView(t);
    if (prev && prev !== t) detachThread(prev); // freeze the old preview, decline its open questions
    bindThread(t);
    renderWorkspaces();
    renderAgents();
    // Agent-team config (teams, workspaces, skills) is PER PROJECT now — force
    // a reload so the rails immediately reflect the newly selected workspace's
    // own .pi/settings instead of the previous project's (stale for ≤15s).
    teamFetchedAt = 0;
    void loadAgentTeam();
    persistWorkspace();
    // The chat workspace is the project you're working on — mirror it into the
    // shared session directory (STATE.cwd) so Files / Git / Checkpoints /
    // Terminal (and Settings, which already reads the chat workspace key) all
    // follow the switch instead of keeping a stale directory.
    if (typeof window.__setCwd === "function" && cwd) window.__setCwd(cwd);
    CH.footer = null;
    CH.footerFetchedAt = 0;
    CH.footerGoRetry = false;
    fetchChatFooter(true);
    // Give the composer a sensible model the first time a workspace is opened
    // (nothing is auto-selected, so this can't happen before a click).
    if (!CH.chatModel) CH.chatModel = defaultChatModel();
    renderComposerModel();
    renderChat();
    attachThread(t); // re-attach this workspace's thread if it's still streaming
    if (wasSessionView) setConversationHint(t);
    // The user picked this workspace from the rail — bring back the workspace's
    // OWN conversation (never a recorded session: transcripts open only when
    // their session row is clicked). Nothing is restored before a selection.
    attemptRestore();
    ensureChatSession();
    // Selecting a workspace is a request to type here: put the caret in the
    // composer so the keyboard works immediately, without an extra click. The
    // click target is a plain div (not focusable), so without this focus stays
    // wherever it was before the view switch — e.g. a now-hidden Single-view
    // button — and keystrokes go nowhere.
    focusComposer();
    // NB: no clearSnapshot() here — attemptRestore() validates the stored
    // snapshot's workspace and restores the conversation, so wiping it here
    // would defeat reload persistence.
  }

  function persistWorkspace() {
    try {
      if (CH.workspace) localStorage.setItem("scope-chat-workspace", CH.workspace);
      else localStorage.removeItem("scope-chat-workspace");
    } catch {}
  }

  // ─── Conversation persistence (last workspace + its chat thread) ─────────
  // The visible conversation — live replies or a session transcript — is kept
  // as a lightweight per-workspace snapshot, so a page reload brings it back
  // verbatim and ready to type in (never a read-only replay).
  const SNAP_KEY = "scope-chat-snapshot";
  // Bumped when the snapshot shape changes. A snapshot written by an older
  // build can't be trusted to describe the workspace's own live conversation
  // (before v2 it carried no "was a session on screen" flag), so it is ignored
  // once rather than risk reopening a recorded session on a workspace click.
  const SNAP_VERSION = 2;
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
            asks: (m.asks || []).slice(-16),
            model: m.model || "",
            ts: m.ts,
          }));
        // Store the workspace, its messages, the thread they belong to, the pi
        // session file to continue, and — crucially — whether a recorded
        // session was on screen when this was written. attemptRestore() refuses
        // any snapshot that isn't the workspace's OWN live conversation, so a
        // snapshot taken while browsing a session transcript is never restored
        // as if it were the workspace's chat (see attemptRestore).
        localStorage.setItem(SNAP_KEY, JSON.stringify({
          v: SNAP_VERSION,
          cwd: CH.workspace,
          msgs,
          resumeFile: CH.resumeFile || "",
          threadId: CH.curId || "",
          openSid: CH.openSid || "",
        }));
      } catch {}
    }, 800);
  }
  function clearSnapshot() {
    try { localStorage.removeItem(SNAP_KEY); } catch {}
  }

  // Restore the workspace's own conversation as editable history. Runs when the
  // workspace is selected (nothing is auto-selected on a fresh page load), and
  // is attempted at most once per workspace. A snapshot that was written while
  // a recorded session was on screen belongs to that SESSION, not to the
  // workspace, and is deliberately not restored — selecting a workspace shows
  // the workspace's own conversation until the user clicks a session row.
  function attemptRestore() {
    if (CH.chatBusy || !CH.workspace || restoreTried.has(CH.workspace)) return;
    if (CH.chatHistory.length) { restoreTried.add(CH.workspace); return; } // keep the live thread
    restoreTried.add(CH.workspace);
    let snap = null;
    try { snap = JSON.parse(localStorage.getItem(SNAP_KEY) || "null"); } catch {}
    // A legacy (unversioned) snapshot can't be trusted to be the workspace's
    // own conversation, and the snapshot belongs to ONE workspace — selecting a
    // different workspace must neither restore it nor discard it, so both
    // mismatches just bail.
    if (!snap || snap.v !== SNAP_VERSION || snap.cwd !== CH.workspace ||
        !Array.isArray(snap.msgs) || !snap.msgs.length) {
      return;
    }
    // Only the workspace's free thread qualifies. Two checks guard against
    // re-opening a session on a plain workspace click:
    //   • snap.openSid — the snapshot was written while a session transcript
    //     was on screen (the thread was in session view), so its messages and
    //     resume file belong to that session, not to the workspace's chat.
    //     This is the case that slipped through before: pi records a free
    //     conversation under a session id and the rail aliases both keys onto
    //     ONE thread, so threadId could equal freeThreadId() even while a
    //     transcript was visible.
    //   • snap.threadId must be this workspace's free thread — a snapshot
    //     carrying a recorded-session thread id was taken elsewhere.
    // Clicking a workspace therefore leaves the canvas on the workspace's own
    // conversation; the transcript comes back only via its own session row
    // (loadSessionChat, which refetches it from the server).
    if (snap.openSid) return;
    if (snap.threadId !== freeThreadId()) return;
    const t = CH.threads.get(snap.threadId) || freeThread(CH.workspace);
    t.history = snap.msgs;
    t.openSid = null; // a free conversation never has a recorded session on screen
    t.resumeFile = snap.resumeFile || t.resumeFile || null;
    t.loadingSid = null;
    t.lastOpenCount = null; // point-in-time copy — refetch on next poll
    bindThread(t);
    persistConversation();
    renderChat();
    if (el.hint) setHint(`${t.history.length} message${t.history.length === 1 ? "" : "s"} restored — type to continue`, "");
    ensureChatSession();
  }

  // ─── Refreshing an open session transcript ────────────────────────────────
  // The poll calls onSessions every few seconds; if the session currently on
  // screen recorded new events since it was loaded, silently re-fetch it so the
  // transcript keeps up with an agent that's still working — and so a page
  // reload (which restores the stale snapshot) picks up the latest messages.
  function refreshOpenSession() {
    const t = curThread();
    if (!t || !t.openSid || t.busy || t.loadingSid) return;
    // A free thread shows its OWN live conversation, not a transcript (see
    // loadSessionChat), so refetching its recorded events every poll would be a
    // discarded round-trip.
    if (t.kind === "free") return;
    const s = CH.sessions.find((x) => x.session_id === t.openSid);
    if (!s) return;
    const count = s.event_count ?? 0;
    if (t.lastOpenCount != null && count <= t.lastOpenCount) return;
    t.lastOpenCount = count;
    void loadSessionChat(t.openSid, true);
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

  // Reset the CURRENT workspace's free conversation to a brand-new chat: kill
  // its pi subprocess (context is gone anyway), wipe the thread and re-arm a
  // fresh pre-spawn. Other sessions' threads are untouched and keep running.
  async function resetChat() {
    const t = freeThread(CH.workspace);
    // Forget any recorded-session alias this thread was adopted into: the reset
    // makes it a NEW conversation, and keeping the alias would leave the old
    // session row bound to it (showing the new chat, and sharing prompts).
    dropThreadAliases(t);
    if (t.key) {
      try {
        await fetch(window.apiUrl("/chat/kill"), {
          method: "POST",
          headers: { ...window.authHeaders(), "content-type": "application/json" },
          body: JSON.stringify({ sessionId: t.key }),
        });
      } catch { /* server unreachable — fine */ }
    }
    t.key = null;
    t.resumeFile = null;
    t.busy = false;
    t.suppressed = false;
    t.gen = 0;
    t.live = null;
    t.dialogs.clear();
    t.pendingCustom = null;
    t.history = [];
    t.openSid = null;
    t.lastOpenCount = null;
    t.loadingSid = null;
    t.firstPrompt = null;
    t.adopted = false;
    t.sid = null;
    CH.chatModel = defaultChatModel();
    bindThread(t);
    renderComposerModel();
    renderChat();
    ensureChatSession();
  }

  // Pre-start the workspace's free pi session (POST /chat/start) so
  // `pi --mode rpc` is already running before the first prompt is typed.
  async function ensureChatSession() {
    if (!CH.workspace) return;
    const t = freeThread(CH.workspace);
    if (t.key || t.busy) return;
    try {
      const { res, data } = await window.SCOPE.api("/chat/start", {}, { cwd: CH.workspace, model: CH.chatModel || defaultChatModel() });
      if (res.ok && data?.sessionId) {
        t.key = data.sessionId;
        syncCurThread();
        if (el.hint && !t.history.length) setHint("session ready", "");
      } else if (el.hint && !t.history.length) {
        setHint(`⚠ ${data?.error || `HTTP ${res.status}`}`, "err");
      }
    } catch {
      // server unreachable — first prompt will spawn instead
      if (el.hint && !t.history.length) setHint("server offline — retry on your next message", "err");
    }
    updateHeader();
    renderChatFooter();
    // The spawn/response settled after the workspace click; re-assert focus so
    // the caret is painted even if the pane only finished laying out meanwhile.
    // Only when nothing else has deliberately taken focus (don't yank the user
    // out of another field if they moved on during the round-trip).
    if (document.body.classList.contains("layout-chat")) {
      const ae = document.activeElement;
      if (!ae || ae === document.body || ae === el.input) focusComposer();
    }
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

  // Bounded memo for fmtMarkdown. The canvas re-renders the WHOLE transcript on
  // a workspace switch, on every session re-fetch (the poll refetches a viewed
  // session as it grows), and on each turn's finalize — without this, every
  // unchanged message pays the full regex + block-parse cost again. Keyed by
  // the raw text, which is all the formatter reads; the map is dropped
  // wholesale once it gets large, so memory stays bounded with no bookkeeping.
  const MD_CACHE_MAX = 512;
  const mdCache = new Map();
  function markdownHtml(raw) {
    const src = String(raw == null ? "" : raw);
    const hit = mdCache.get(src);
    if (hit !== undefined) return hit;
    const html = fmtMarkdown(src);
    if (mdCache.size >= MD_CACHE_MAX) mdCache.clear();
    mdCache.set(src, html);
    return html;
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

  // Format a tool-call's arguments for display. Tool payloads arrive as either
  // a JSON object or a string; normalize to a readable block.
  function fmtArgs(args) {
    if (args == null || args === "") return "";
    if (typeof args === "object") {
      try { return JSON.stringify(args, null, 2); } catch { return String(args); }
    }
    return String(args);
  }

  function toolStateMeta(state) {
    if (state === "live") return { cls: "live", word: "running" };
    if (state === "err") return { cls: "err", word: "error" };
    return { cls: "ok", word: "done" };
  }

  // One tool call as an expandable block (used in "show tool calls with result").
  function toolCallHtml(t) {
    const st = toolStateMeta(t.state);
    const args = fmtArgs(t.args);
    const hasResult = t.result != null && t.result !== "";
    const resultCls = st.cls === "err" ? "err" : "ok";
    const body =
      `<div class="chat-tool-call-body">` +
      (args ? `<div class="chat-tool-call-args"><div class="chat-tool-call-k">Args</div><pre>${esc(args)}</pre></div>` : "") +
      (hasResult
        ? `<div class="chat-tool-call-result ${resultCls}"><div class="chat-tool-call-k">Result</div><pre>${esc(t.result)}</pre></div>`
        : (st.cls === "live" ? `<div class="chat-tool-call-live"><span class="chat-tool-call-k">Running…</span></div>` : "")) +
      `</div>`;
    return (
      `<details class="chat-tool-call ${st.cls}" data-name="${esc(t.name)}" open>` +
      `<summary>` +
      `<span class="chat-tool-icon">${toolIcon(t.name)}</span>` +
      `<span class="chat-tool-name">${esc(t.name)}</span>` +
      `<span class="chat-tool-dot"></span>` +
      `<span class="chat-tool-call-state">${st.word}</span>` +
      `</summary>` +
      body +
      `</details>`
    );
  }

  // Render a message's tool activity in the current display mode. Folded mode
  // shows compact chips; expanded mode shows each call with its args + result.
  function renderToolsHtml(tools) {
    if (!tools || !tools.length) return "";
    if (!CH.expandTools) {
      // data-name lets the live stream resolve a chip after a mid-run re-render
      // (streamToolEnd looks it up by name) — without it, a chip already drawn
      // from history stayed "running" for the rest of the turn.
      return `<div class="chat-tools">` + tools.map((t) =>
        `<span class="chat-tool ${esc(t.state || "")}" data-name="${esc(t.name)}"><span class="chat-tool-icon">${toolIcon(t.name)}</span>` +
        `<span class="chat-tool-name">${esc(t.name)}</span><span class="chat-tool-dot"></span></span>`
      ).join("") + `</div>`;
    }
    return `<div class="chat-tools chat-tools-expanded">` + tools.map(toolCallHtml).join("") + `</div>`;
  }

  // ─── View toggles: fold/unfold thinking, show/fold tool calls ─────────────
  function updateToggleButtons() {
    const t = document.getElementById("chat-toggle-thinking");
    const tl = document.getElementById("chat-toggle-tools");
    if (t) {
      t.classList.toggle("on", CH.showThinking);
      t.setAttribute("aria-pressed", CH.showThinking ? "true" : "false");
      t.title = CH.showThinking ? "Fold thinking" : "Show thinking";
    }
    if (tl) {
      tl.classList.toggle("on", CH.expandTools);
      tl.setAttribute("aria-pressed", CH.expandTools ? "true" : "false");
      tl.title = CH.expandTools ? "Fold tool calls" : "Show tool call results";
    }
  }

  function updateSteerToggle() {
    if (!el.steer) return;
    el.steer.classList.toggle("on", CH.steer);
    el.steer.setAttribute("aria-pressed", CH.steer ? "true" : "false");
    el.steer.title = CH.steer
      ? "Steer is on — your next message reaches pi immediately, mid-run"
      : "Steer is off — your next message is queued until pi finishes the current turn";
  }

  // "⏹ stopped" chip appended to a live assistant message body when the user
  // aborts the agent mid-run. Kept in sync across the final re-render via m.stopped.
  function addStoppedNote(body, m) {
    m.stopped = true;
    if (!body) return;
    let n = body.querySelector(".chat-stopped-note");
    if (!n) {
      n = document.createElement("div");
      n.className = "chat-stopped-note";
      n.textContent = "⏹ stopped by you";
      body.appendChild(n);
    }
  }

  // A queued steer/follow-up that was cleared by the stop action gets a small
  // "cancelled" chip so the user knows their message won't be answered.
  function addCancelledNote(node, m) {
    m.cancelled = true;
    if (!node) return;
    let n = node.querySelector(".chat-msg-cancelled");
    if (!n) {
      n = document.createElement("div");
      n.className = "chat-msg-cancelled";
      n.textContent = "cancelled";
      node.querySelector(".chat-bubble-user")?.appendChild(n);
    }
  }

  function applyThinkingState() {
    if (!el.msg) return;
    el.msg.querySelectorAll("details.chat-thinking").forEach((d) => { d.open = CH.showThinking; });
    updateToggleButtons();
  }

  function toggleThinking() {
    CH.showThinking = !CH.showThinking;
    try { localStorage.setItem("scope-chat-show-thinking", CH.showThinking ? "1" : "0"); } catch {}
    applyThinkingState();
  }

  // Re-render each message's tool activity in the current display mode without
  // rebuilding the whole list (which would disrupt an in-flight stream).
  function refreshToolDisplay() {
    if (!el.msg) return;
    el.msg.querySelectorAll(".chat-msg").forEach((node) => {
      const i = node.dataset.i;
      const m = CH.chatHistory[Number(i)];
      if (!m || m.role !== "assistant") return;
      const body = node.querySelector(".chat-msg-body");
      if (!body) return;
      body.querySelectorAll(".chat-tools").forEach((t) => t.remove());
      const toolsHtml = renderToolsHtml(m.tools || []);
      if (toolsHtml) {
        const wrap = document.createElement("div");
        wrap.innerHTML = toolsHtml;
        const toolsEl = wrap.firstElementChild;
        const ref = body.querySelector(".chat-text, .chat-usage");
        if (ref) body.insertBefore(toolsEl, ref);
        else body.appendChild(toolsEl);
      }
    });
    updateToggleButtons();
  }

  function toggleTools() {
    CH.expandTools = !CH.expandTools;
    try { localStorage.setItem("scope-chat-expand-tools", CH.expandTools ? "1" : "0"); } catch {}
    refreshToolDisplay();
  }

  function renderChatMsg(m, i) {
    if (m.role === "user") {
      const copyAttr = esc(m.text || "");
      return (
        `<div class="chat-msg chat-user" data-i="${i}">` +
        `<div class="chat-msg-body">` +
        `<div class="chat-bubble chat-bubble-user"><div class="chat-bubble-text">${esc(m.text || "")}</div>` +
        (m.cancelled ? `<div class="chat-msg-cancelled">cancelled</div>` : "") +
        `</div>` +
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
    const tools = renderToolsHtml(m.tools || []);
    const thinking = m.thinking
      ? `<details class="chat-thinking"${CH.showThinking ? " open" : ""}><summary><span class="chat-th-label">${ico(ICON_THOUGHT, 13)} Thought</span></summary><pre>${esc(m.thinking)}</pre></details>`
      : "";
    const body = m.text
      ? `<div class="chat-text">${markdownHtml(m.text)}</div>`
      : (!m.streaming && !m.thinking && !(m.tools || []).length
          ? `<div class="chat-msg-time">(no text response)</div>`
          : "");
    // Answered questions (ask_user_question cards answered live in this bubble)
    // survive the stream as a compact Q&A recap in the final transcript.
    const asksHtml = (m.asks && m.asks.length)
      ? `<div class="chat-asks">` +
        m.asks.map((a) => {
          const declined = a.a === "declined";
          return `<div class="chat-asks-i${declined ? " declined" : ""}">` +
            `<span class="chat-asks-q">${esc(a.q || "")}</span>` +
            `<span class="chat-asks-a">${declined ? esc("declined") : esc(a.a || "")}</span>` +
            `</div>`;
        }).join("") +
        `</div>`
      : "";
    const errNote = m.errorNote ? `<div class="chat-error-note">${esc(m.errorNote)}</div>` : "";
    const stoppedNote = m.stopped ? `<div class="chat-stopped-note">⏹ stopped by you</div>` : "";
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
      asksHtml +
      errNote +
      stoppedNote +
      `</div></div>`
    );
  }

  function renderChat() {
    if (!el.msg) return;
    updateHeader();
    // The composer is free whenever a workspace is selected: a prompt always
    // targets the CURRENT thread (queuing within it when it's busy), so other
    // sessions streaming in the background never lock the input. With no
    // workspace there is nowhere to send a prompt, so the box is hidden
    // entirely (the canvas hero tells the user to pick one).
    setComposerEnabled(!!CH.workspace);
    if (el.composer) el.composer.style.display = CH.workspace ? "" : "none";
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
    const curT = curThread();
    const showLive = !!(curT && curT.busy && curT.live);
    for (let idx = 0; idx < CH.chatHistory.length; idx++) {
      const m = CH.chatHistory[idx];
      // A busy thread's in-flight assistant message renders as the live
      // placeholder so incoming deltas stream into it (also after switching
      // back to a session that is still running).
      if (showLive && m === curT.live.m) html += renderChatMsgLivePlaceholder(m, idx);
      else html += renderChatMsg(m, idx);
    }
    el.msg.innerHTML = html;
    if (stickBottom) scrollToBottom(true);
    else if (prevHeight > 1) el.msg.scrollTop = Math.round((prevTop / prevHeight) * el.msg.scrollHeight);
    // Rebuilding the canvas detaches every node the live stream was writing
    // into. Re-resolve the body pointer so deltas keep landing in the new DOM
    // (previously the stream kept writing into removed nodes — invisible until
    // the turn finalized — e.g. after switching away from and back to Chat).
    if (showLive) attachLiveDom(curT);
    updateScrollDown();
  }

  function renderChatMsgLivePlaceholder(m, idx) {
    // The in-flight assistant bubble that streaming events fill in-place. It
    // renders whatever has already arrived (thinking / tools / text) as well as
    // the typing dots, because the canvas is rebuilt from history on re-render
    // (view switch, workspace toggle). Without this, a mid-run re-render drew an
    // empty bubble and the text streamed so far vanished until the turn ended.
    // The shapes match what the streaming helpers look for, so they extend
    // these nodes rather than creating duplicates.
    const dataIdx = idx != null ? idx : CH.chatHistory.length - 1;
    const copyAttr = esc(m.text || "");
    const thinking = m.thinking
      ? `<details class="chat-thinking"${CH.showThinking ? " open" : ""}><summary><span class="chat-th-label">${ico(ICON_THOUGHT, 13)} Thought</span></summary><pre>${esc(m.thinking)}</pre></details>`
      : "";
    const tools = renderToolsHtml(m.tools || []);
    const text = m.text ? `<div class="chat-text chat-stream-text">${esc(m.text)}</div>` : "";
    return (
      `<div class="chat-msg chat-ai chat-ai-live" data-i="${dataIdx}">` +
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
      text +
      `<div class="chat-typing"><span></span><span></span><span></span></div>` +
      `</div></div>`
    );
  }

  // ─── Live streaming into the active assistant message ─────────────────────
  // Live-stream state lives on the THREAD (t.live = { m, isFirst, queue, after }
  // plus the resolved DOM body while attached). Streaming helpers take the DOM
  // body as a parameter: when the thread is not visible (running in the
  // background) the body is null and only the message model is updated.

  // Coalesce footer re-renders to one per animation frame. The composer footer
  // (token/cost chips + context gauge) is re-derived from the live usage stream,
  // and pi can emit many `usage` events per turn. Rebuilding el.footer.innerHTML
  // for each one stamps the DOM and makes the context bar blink on/off; rAF
  // batching keeps it to a single paint per frame.
  let footerRenderFrame = 0;
  function scheduleFooterRender() {
    if (footerRenderFrame) return;
    footerRenderFrame = requestAnimationFrame(() => {
      footerRenderFrame = 0;
      renderChatFooter();
    });
  }

  // Same coalescing for the follow-the-bottom pin. A turn emits hundreds of
  // deltas and `nearBottom()` reads scrollHeight (a forced layout), so pinning
  // on every event thrashed layout + paint for no visible gain: one frame of
  // latency is imperceptible, a per-token reflow is not.
  let scrollFrame = 0;
  function scheduleScrollToBottom() {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      if (nearBottom()) scrollToBottom(true);
    });
  }

  function clearLiveTyping(body) {
    if (!body) return;
    const t = body.querySelector(".chat-typing");
    if (t) t.remove();
  }

  function livePrependTextNode(body, node, beforeSelector) {
    const ref = beforeSelector ? body.querySelector(beforeSelector) : null;
    if (ref) body.insertBefore(node, ref);
    else body.appendChild(node);
  }

  function streamThinking(body, m, delta) {
    m.thinking = (m.thinking || "") + delta;
    if (!body) return; // background thread — model only
    clearLiveTyping(body);
    let det = body.querySelector("details.chat-thinking");
    if (!det) {
      det = document.createElement("details");
      det.className = "chat-thinking";
      det.open = CH.showThinking;
      det.innerHTML = `<summary><span class="chat-th-label">${ico(ICON_THOUGHT, 13)} Thought</span></summary><pre></pre>`;
      livePrependTextNode(body, det, ".chat-tools, .chat-text, .chat-usage");
    }
    det.querySelector("pre").textContent = m.thinking;
    det.scrollTop = det.scrollHeight;
  }

  function streamText(body, m, delta) {
    m.text = (m.text || "") + delta;
    if (!body) return; // background thread — model only
    clearLiveTyping(body);
    let t = body.querySelector(".chat-text.chat-stream-text");
    if (!t) {
      t = document.createElement("div");
      t.className = "chat-text chat-stream-text";
      livePrependTextNode(body, t, null);
    }
    // Append the delta to ONE text node instead of re-assigning textContent:
    // re-copying the whole message on every token is O(n²) over a long reply
    // (and re-created the node, dropping the caret position mid-stream).
    let tn = t.firstChild;
    if (!tn || tn.nodeType !== 3) tn = t.appendChild(document.createTextNode(""));
    tn.appendData(delta);
  }

  function toolChip(body, name) {
    if (!body) return null;
    return body.querySelector(`.chat-tool[data-name="${CSS.escape(name)}"]`);
  }

  function streamToolStart(body, m, name, args) {
    m.tools = m.tools || [];
    // Recorded ONCE: this used to push a second time after the DOM branch, so
    // every attached tool call was duplicated — the final re-render drew the
    // chip twice and the extra copy stayed "live" forever (tool_end only
    // resolves the first match).
    m.tools.push({ name, args, state: "live" });
    if (!body) return; // background thread — model only
    clearLiveTyping(body);
    let toolsEl = body.querySelector(".chat-tools");
    if (!toolsEl) {
      toolsEl = document.createElement("div");
      toolsEl.className = CH.expandTools ? "chat-tools chat-tools-expanded" : "chat-tools";
      livePrependTextNode(body, toolsEl, ".chat-text, .chat-usage");
    }
    if (CH.expandTools) {
      const det = document.createElement("details");
      det.className = "chat-tool-call live";
      det.dataset.name = name;
      det.open = true;
      det.innerHTML =
        `<summary>` +
        `<span class="chat-tool-icon">${toolIcon(name)}</span>` +
        `<span class="chat-tool-name">${esc(name)}</span>` +
        `<span class="chat-tool-dot"></span>` +
        `<span class="chat-tool-call-state">running</span>` +
        `</summary>` +
        `<div class="chat-tool-call-body">` +
        (args ? `<div class="chat-tool-call-args"><div class="chat-tool-call-k">Args</div><pre>${esc(fmtArgs(args))}</pre></div>` : "") +
        `<div class="chat-tool-call-live"><span class="chat-tool-call-k">Running…</span></div>` +
        `</div>`;
      toolsEl.appendChild(det);
    } else {
      const chip = document.createElement("span");
      chip.className = "chat-tool live";
      chip.dataset.name = name;
      chip.innerHTML =
        `<span class="chat-tool-icon">${toolIcon(name)}</span>` +
        `<span class="chat-tool-name">${esc(name)}</span>` +
        `<span class="chat-tool-dot"></span>`;
      toolsEl.appendChild(chip);
    }
  }

  function streamToolEnd(body, m, name) {
    const t = m.tools?.find((x) => x.name === name && x.state === "live");
    if (t) t.state = "ok";
    if (!body) return; // background thread — model only
    const chip = toolChip(body, name);
    if (chip) { chip.classList.remove("live"); chip.classList.add("ok"); }
    const det = body.querySelector(`.chat-tool-call[data-name="${CSS.escape(name)}"]`);
    if (det) {
      det.classList.remove("live");
      det.classList.add("ok");
      const state = det.querySelector(".chat-tool-call-state");
      if (state) state.textContent = "done";
      det.querySelector(".chat-tool-call-live")?.remove();
    }
  }

  function streamError(body, m, msg) {
    m.errorNote = msg;
    if (!body) return; // background thread — model only
    const n = document.createElement("div");
    n.className = "chat-error-note";
    n.textContent = "⚠ " + msg;
    body.appendChild(n);
    clearLiveTyping(body);
  }

  // ─── Interactive host dialogs (ask_user_question & friends) ───────────────
  // pi's RPC dialog sub-protocol: an extension (e.g. ask_user_question) calls
  // ui.select()/ui.input(), and pi streams the dialog as an extension_ui_request
  // that the HOST must render and answer. If we did nothing the tool would hang
  // invisibly — instead we show an answerable card in the live bubble and POST
  // the reply (extension_ui_response) via /chat/ui so pi's tool resolves and the
  // agent keeps going. Dialogs are sequential (pi waits for each answer), so one
  // card is on screen at a time; answered cards are summarized into m.asks so
  // the final transcript still shows the Q&A.
  const ICON_ASK = `<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>`;
  // Dialogs live on the THREAD (t.dialogs / t.pendingCustom) so each session's
  // question cards are tracked independently and get declined when the user
  // switches away mid-question.

  function cleanUiTitle(title) {
    return String(title || "").replace(/\s+/g, " ").trim();
  }

  // An option line from a ui.select request is "1. Label — description". The ask
  // questionnaire maps a picked option back to the original list by its leading
  // number, so the raw line is what must be sent back when the user picks it.
  function parseOptionLine(line) {
    const raw = String(line == null ? "" : line);
    const m = raw.match(/^\s*(\d+)\.\s+(.*)$/);
    if (!m) return { num: "", label: raw.trim(), desc: "", raw };
    const dm = m[2].match(/^(.*?)(?:\s+—\s+(.*))?$/);
    return { num: m[1], label: (dm ? dm[1] : m[2]).trim(), desc: dm && dm[2] ? dm[2].trim() : "", raw };
  }

  // The questionnaire appends a "N. Type something." sentinel row that switches
  // to free text; it must never be answered as a regular option.
  function isSentinelLine(line) {
    return /type something/i.test(String(line || ""));
  }

  function recordAsk(m, title, answer) {
    if (!m) return;
    m.asks = m.asks || [];
    m.asks.push({
      q: cleanUiTitle(title).slice(0, 400),
      a: String(answer || "").slice(0, 400),
      ts: Date.now(),
    });
    if (m.asks.length > 24) m.asks.splice(0, m.asks.length - 24);
  }

  async function postUiAnswer(dialogId, payload, t) {
    const sid = (t && t.key) || CH.chatSessionId || "";
    if (!sid) return { ok: false, error: "no live chat session" };
    try {
      const { res, data } = await window.SCOPE.api("/chat/ui", {}, { sessionId: sid, id: dialogId, ...payload });
      return res.ok ? { ok: true } : { ok: false, error: (data && data.error) || `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  }

  function askNote(card, text) {
    if (!card) return;
    let note = card.querySelector(".chat-ask-note");
    if (!note) {
      note = document.createElement("div");
      note.className = "chat-ask-note";
      card.appendChild(note);
    }
    note.textContent = text;
  }

  function setAskStatus(card, text, isErr) {
    if (!card) return;
    let st = card.querySelector(".chat-ask-status");
    if (!st) {
      st = document.createElement("div");
      st.className = "chat-ask-status";
      card.appendChild(st);
    }
    st.hidden = false;
    st.className = "chat-ask-status" + (isErr ? " err" : "");
    st.textContent = text;
  }

  // Disable a question card once it has been answered / declined.
  function markAskAnswered(card, label, declined) {
    if (!card) return;
    card.classList.add("answered");
    card.querySelectorAll(".chat-ask-opt").forEach((b) => { b.disabled = true; });
    const row = card.querySelector(".chat-ask-custom-row");
    if (row) row.remove();
    const x = card.querySelector(".chat-ask-x");
    if (x) x.remove();
    const note = card.querySelector(".chat-ask-note");
    if (note) note.remove();
    if (label != null) setAskStatus(card, declined ? "declined" : "✓ " + label, declined);
  }

  // ui.select: an option list. The sentinel row opens an inline "type your own
  // answer" box instead of answering.
  function showUiSelect(body, m, ev, t) {
    const opts = Array.isArray(ev.options) ? ev.options : [];
    let sentinelIdx = -1;
    opts.forEach((raw, i) => { if (isSentinelLine(parseOptionLine(raw).label)) sentinelIdx = i; });
    const dlg = { mode: "select", id: ev.id, opts, sentinelIdx, m, title: cleanUiTitle(ev.title), t };
    if (t) t.dialogs.set(ev.id, dlg);

    const card = document.createElement("div");
    card.className = "chat-ask";
    card.dataset.id = ev.id;
    let optHtml = "";
    opts.forEach((raw, i) => {
      if (isSentinelLine(parseOptionLine(raw).label)) {
        optHtml +=
          `<button type="button" class="chat-ask-opt chat-ask-opt-other" data-i="${i}">` +
          `<span class="chat-ask-opt-l">✏️ Type your own answer</span>` +
          `<span class="chat-ask-opt-d">Answer in your own words instead of the options</span></button>`;
      } else {
        const p = parseOptionLine(raw);
        optHtml +=
          `<button type="button" class="chat-ask-opt" data-i="${i}">` +
          (p.num ? `<span class="chat-ask-opt-num">${esc(p.num)}</span>` : "") +
          `<span class="chat-ask-opt-b"><span class="chat-ask-opt-l">${esc(p.label)}</span>` +
          (p.desc ? `<span class="chat-ask-opt-d">${esc(p.desc)}</span>` : "") +
          `</span></button>`;
      }
    });
    card.innerHTML =
      `<div class="chat-ask-head"><span class="chat-ask-ic">${ico(ICON_ASK, 13)}</span>` +
      `<div class="chat-ask-q">${esc(dlg.title)}</div>` +
      `<button type="button" class="chat-ask-x" title="Decline — pi is told you dismissed the question">&times;</button></div>` +
      (opts.length ? `<div class="chat-ask-opts">${optHtml}</div>` : "") +
      `<div class="chat-ask-custom-row" hidden>` +
      `<input class="chat-ask-input" type="text" placeholder="Type your own answer…" autocomplete="off" spellcheck="false" />` +
      `<button type="button" class="chat-ask-send">Send</button></div>` +
      `<div class="chat-ask-note">pi is waiting for your answer</div>`;
    body.appendChild(card);

    card.querySelector(".chat-ask-x").addEventListener("click", (e) => {
      e.preventDefault();
      void declineUi(dlg, card);
    });
    card.querySelectorAll(".chat-ask-opt").forEach((b) =>
      b.addEventListener("click", () => {
        const raw = dlg.opts[Number(b.dataset.i)];
        if (raw == null) return;
        if (isSentinelLine(parseOptionLine(raw).label)) revealCustom(card);
        else void answerSelect(dlg, card, raw);
      })
    );
    const send = () => submitCustom(dlg, card, card.querySelector(".chat-ask-input").value);
    const sendBtn = card.querySelector(".chat-ask-send");
    const inp = card.querySelector(".chat-ask-input");
    if (sendBtn) sendBtn.addEventListener("click", send);
    if (inp) inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); send(); } });
    if (nearBottom()) scrollToBottom();
  }

  function revealCustom(card) {
    const row = card.querySelector(".chat-ask-custom-row");
    if (!row) return;
    row.hidden = false;
    card.classList.add("custom");
    const inp = card.querySelector(".chat-ask-input");
    if (inp) inp.focus();
    askNote(card, "type your answer and press Enter — or pick one of the options above");
  }

  async function answerSelect(dlg, card, raw) {
    askNote(card, "sending your answer…");
    const r = await postUiAnswer(dlg.id, { value: raw }, dlg.t);
    if (!r.ok) { setAskStatus(card, "⚠ " + (r.error || "could not reach pi"), true); return; }
    const p = parseOptionLine(raw);
    recordAsk(dlg.m, dlg.title, p.label);
    markAskAnswered(card, p.label, false);
  }

  // "Type your own answer" on a select card: answer the select with the sentinel
  // row (so pi opens its free-text follow-up), then auto-answer that input with
  // the text the user typed — they answer once, pi sees one custom answer.
  function submitCustom(dlg, card, value) {
    const typed = String(value || "").trim();
    if (!typed) return;
    askNote(card, "sending your answer…");
    const sentinelRaw = dlg.sentinelIdx >= 0 ? dlg.opts[dlg.sentinelIdx] : "";
    if (sentinelRaw) {
      if (dlg.t) dlg.t.pendingCustom = { value: typed, title: dlg.title };
      void postUiAnswer(dlg.id, { value: sentinelRaw }, dlg.t).then((r) => {
        if (!r.ok) {
          if (dlg.t) dlg.t.pendingCustom = null;
          setAskStatus(card, "⚠ " + (r.error || "could not reach pi"), true);
        }
      });
    } else {
      void postUiAnswer(dlg.id, { value: typed }, dlg.t);
      recordAsk(dlg.m, dlg.title, typed);
    }
    markAskAnswered(card, typed, false);
  }

  // ui.input: a free-text dialog. Multi-select questionnaires arrive here too
  // (numbered list in the title, answers as "1,3" or plain custom text).
  function showUiInput(body, m, ev, t) {
    const title = cleanUiTitle(ev.title);
    // Free-text dialog that pi opened for a "type something" answer we already
    // collected — deliver it without making the user type it twice.
    if (t && t.pendingCustom) {
      const pending = t.pendingCustom;
      t.pendingCustom = null;
      void postUiAnswer(ev.id, { value: pending.value }, t);
      recordAsk(m, pending.title || title, pending.value);
      const note = document.createElement("div");
      note.className = "chat-ask chat-ask-auto";
      note.innerHTML =
        `<div class="chat-ask-head"><span class="chat-ask-ic">${ico(ICON_ASK, 13)}</span>` +
        `<div class="chat-ask-q">${esc(title)}</div></div>` +
        `<div class="chat-ask-note">✓ your answer was sent</div>`;
      body.appendChild(note);
      if (nearBottom()) scrollToBottom();
      return;
    }
    const dlg = { mode: "input", id: ev.id, m, title, placeholder: ev.placeholder || "", t };
    if (t) t.dialogs.set(ev.id, dlg);
    const card = document.createElement("div");
    card.className = "chat-ask";
    card.dataset.id = ev.id;
    card.innerHTML =
      `<div class="chat-ask-head"><span class="chat-ask-ic">${ico(ICON_ASK, 13)}</span>` +
      `<div class="chat-ask-q">${esc(title)}</div>` +
      `<button type="button" class="chat-ask-x" title="Decline — pi is told you dismissed the question">&times;</button></div>` +
      `<div class="chat-ask-input-row">` +
      `<textarea class="chat-ask-input" rows="2" placeholder="${esc(dlg.placeholder || "Type your answer…")}" spellcheck="false"></textarea>` +
      `<button type="button" class="chat-ask-send">Send</button></div>` +
      `<div class="chat-ask-note">pi is waiting for your answer</div>`;
    body.appendChild(card);

    const submit = () => submitInput(dlg, card, card.querySelector(".chat-ask-input").value);
    card.querySelector(".chat-ask-x").addEventListener("click", (e) => {
      e.preventDefault();
      void declineUi(dlg, card);
    });
    const sendBtn = card.querySelector(".chat-ask-send");
    const ta = card.querySelector(".chat-ask-input");
    if (sendBtn) sendBtn.addEventListener("click", submit);
    if (ta) {
      ta.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
      });
      ta.focus();
    }
    if (nearBottom()) scrollToBottom();
  }

  async function submitInput(dlg, card, value) {
    const typed = String(value || "").trim();
    if (!typed) return;
    askNote(card, "sending your answer…");
    const r = await postUiAnswer(dlg.id, { value: typed }, dlg.t);
    if (!r.ok) { setAskStatus(card, "⚠ " + (r.error || "could not reach pi"), true); return; }
    recordAsk(dlg.m, dlg.title, typed);
    markAskAnswered(card, typed, false);
  }

  async function declineUi(dlg, card) {
    if (!dlg) return;
    askNote(card, "declining…");
    const r = await postUiAnswer(dlg.id, { cancelled: true }, dlg.t);
    if (!r.ok) { setAskStatus(card, "⚠ " + (r.error || "could not reach pi"), true); return; }
    recordAsk(dlg.m, dlg.title, "declined");
    markAskAnswered(card, "", true);
  }

  // Append one live event into the in-flight assistant message of a thread.
  // Model updates ALWAYS happen (background threads keep their conversation
  // current); DOM streaming only runs when the thread is the visible one and
  // its live body is resolved. Always target t.live.m: after a msg_start the
  // in-flight message is a NEW bubble, not the aiMsg captured when the prompt
  // was sent.
  function handleChatEvent(ev, t) {
    if (!t || !t.busy || !t.live) return;
    const attached = t === curThread() && !t.suppressed;
    const body = attached ? t.live.body : null;
    const m = t.live.m;
    switch (ev.type) {
      case "msg_start": {
        // A run can contain several assistant messages (one per LLM call in a
        // tool loop). The first fills the placeholder; each later one becomes
        // its own bubble so a per-message `final` snapshot can't overwrite the
        // text streamed so far — mirroring how session transcripts render.
        if (t.live.isFirst) { t.live.isFirst = false; break; }
        t.live.m.streaming = false;
        const m2 = {
          role: "assistant", text: "", thinking: "", tools: [], usage: null,
          model: m.model || CH.chatModel, ts: Date.now(), streaming: true,
        };
        // Place the new bubble relative to any queued steer/follow-up bubbles so
        // an earlier run's leftover tool-loop messages land before the queued
        // user message, and the queued run's own messages land right after it.
        let mIdx = t.history.length;
        if (t.live.queue.length) {
          const qi = t.history.indexOf(t.live.queue[0].msg);
          if (qi >= 0) mIdx = qi;
        } else if (t.live.after) {
          const ai = t.history.indexOf(t.live.after.msg);
          if (ai >= 0) mIdx = ai + 1;
        }
        t.history.splice(mIdx, 0, m2);
        if (body && el.msg) {
          const wrap = document.createElement("div");
          wrap.innerHTML = renderChatMsgLivePlaceholder(m2, mIdx);
          const node = wrap.firstElementChild;
          if (node) el.msg.insertBefore(node, el.msg.children[mIdx] || null);
        }
        // Keep the DOM row ↔ history index parity intact for the new live msg.
        const newBody = (body && el.msg && el.msg.children[mIdx])
          ? el.msg.children[mIdx].querySelector(".chat-msg-body")
          : null;
        t.live = { body: newBody || t.live.body, m: m2, isFirst: false, queue: t.live.queue, after: t.live.after };
        if (attached) scheduleScrollToBottom();
        break;
      }
      case "run_start": {
        // A new low-level agent run began. If the user queued a steer/follow-up
        // message, that run is now being processed — adopt its user bubble as
        // the anchor so the assistant response streams in right after it. This
        // is the moment the "waiting for its turn" status is dropped: pi has
        // moved on from queueing and is actually working the message now.
        if (t.live.queue.length) {
          t.live.after = t.live.queue.shift();
          if (attached) setHint("pi is responding to your message…", "busy");
        }
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
      case "session":
        // The server announces the real subprocess session id at stream start
        // (it generates one when the request didn't carry one), so answers to
        // extension dialogs can target the right session.
        if (ev.sessionId) t.key = ev.sessionId;
        if (t === curThread()) syncCurThread();
        break;
      case "ui_select":
        // Attached: render an answerable card. Background thread: decline so
        // pi never hangs on an invisible question.
        if (body) showUiSelect(body, m, ev, t);
        else if (t.key) void postUiAnswer(ev.id, { cancelled: true }, t);
        break;
      case "ui_input":
        if (body) showUiInput(body, m, ev, t);
        else if (t.key) void postUiAnswer(ev.id, { cancelled: true }, t);
        break;
      case "ui_notify":
        // Surface non-info notifications (warnings/errors) as a composer hint.
        if (attached && ev.kind && ev.kind !== "info" && el.hint) setHint("ℹ " + (ev.message || ""), ev.kind === "error" ? "err" : "busy");
        break;
      case "usage":
        m.usage = ev.usage || m.usage;
        break;
      case "final": {
        // Authoritative snapshot (some providers only deliver it on message_end).
        // Only a NON-EMPTY snapshot is applied: message_end for a provider whose
        // content array is empty arrives as text:"" and used to wipe the text
        // that already streamed into this bubble.
        if (typeof ev.text === "string" && ev.text) {
          m.text = ev.text;
          if (body) {
            const elt = body.querySelector(".chat-text.chat-stream-text");
            if (elt) elt.textContent = m.text;
          }
        }
        if (typeof ev.thinking === "string" && ev.thinking) {
          m.thinking = ev.thinking;
          if (body) {
            const det = body.querySelector("details.chat-thinking");
            if (det) det.querySelector("pre").textContent = m.thinking;
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
    if (attached) scheduleScrollToBottom();
    // Keep the composer footer in lockstep with the VISIBLE live turn — the
    // usage / final snapshots are exactly what its token + cost numbers are
    // derived from. Coalesced to one render per frame so a burst of usage
    // events doesn't stampede the DOM and make the context gauge blink.
    if (attached && (ev.type === "usage" || ev.type === "final")) scheduleFooterRender();
  }

  function setHint(text, kind) {
    if (!el.hint) return;
    el.hint.textContent = text || "";
    el.hint.classList.toggle("busy", kind === "busy");
    el.hint.classList.toggle("err", kind === "err");
  }

  // True while an IME composition is in flight in the composer. focusComposer()
  // must not blur the field then — blur would commit/abort the composition.
  let inputComposing = false;

  // Focus the message box and put the caret at the end. The extra passes matter
  // after a view switch / session clear: the composer becomes visible in the
  // same task the focus is requested, and some engines only paint the blinking
  // caret once the newly-shown pane has laid out. Without the retry the box
  // looked normal but had no text cursor until the user clicked it (or reloaded).
  function focusComposer() {
    let cycled = false;
    const apply = () => {
      if (!el.input || el.input.disabled) return;
      // A native confirm()/alert() (the delete / clear dialogs) can hand the
      // window back with the composer STILL the activeElement but its blinking
      // caret desynced: the box shows its focus ring yet no caret, and a second
      // focus() is a no-op. Blur first (a no-op when it isn't focused) so the
      // following focus() is always a real focus transition that repaints the
      // caret. Skipped mid-IME composition (blur() would abort it).
      if (!cycled && !inputComposing) {
        cycled = true;
        try { el.input.blur(); } catch { /* ignore */ }
      }
      try { el.input.focus({ preventScroll: true }); } catch { try { el.input.focus(); } catch {} }
      try {
        const n = el.input.value.length;
        el.input.setSelectionRange(n, n);
      } catch { /* setSelectionRange unsupported — focus alone is enough */ }
    };
    apply();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(apply);
  }

  function setComposerEnabled(on) {
    if (!el.input || !el.send || !el.model) return;
    el.input.disabled = !on;
    el.model.disabled = !on;
    if (el.thinking) el.thinking.disabled = !on;
    if (el.steer) el.steer.disabled = !on;
    // Keep Send enabled while a turn streams so the user can steer / queue a
    // follow-up; the stop button appears in its place of action.
    el.send.disabled = !on;
    // Losing the composer (workspace cleared) must not leave the host mic open.
    if (!on && CH.listening) void finishListening();
    updateListenButton();
    if (el.stop) el.stop.classList.toggle("show", CH.chatBusy);
    if (el.input) el.input.placeholder = "Message the pi coding agent…";
  }

  function updateHeader() {
    // The Stop button is shown while the VISIBLE thread is streaming. It used
    // to be toggled only inside setComposerEnabled, which sendPrompt calls
    // before CH.chatBusy is synced — so the button never appeared during the
    // first turn (nothing else re-ran it mid-stream). Keep it in lockstep here;
    // updateHeader runs at turn start and on every poll.
    if (el.stop) el.stop.classList.toggle("show", CH.chatBusy);
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
      // "Start a new session" is available whenever a workspace is open and no
      // turn is running. It used to also require existing history, which left
      // the button dead on an empty/freshly-cleared conversation exactly when
      // the user needed it to (re)arm a session.
      el.btnNew.disabled = busy;
      el.btnNew.title = "Start a new session";
    }
    if (el.btnOpen) {
      el.btnOpen.disabled = !wsSessions(CH.workspace).length;
      el.btnOpen.title = "Open this agent's full timeline (Single view)";
    }
  }

  // ─── Composer / model chooser ─────────────────────────────────────────────
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
      // Full model ids are shown verbatim; the closed select is sized
      // dynamically to its selected option (fitComposerSelects), so the pill
      // grows to fit the text instead of clipping it.
      const label = fromSettings ? m : `${m} · (session)`;
      html += `<option value="${esc(m)}"${m === CH.chatModel ? " selected" : ""} title="${esc(m)}">${esc(label)}</option>`;
    }
    // Avoid rewriting the <select> every poll — an innerHTML swap resets the
    // element and would drop an open dropdown. Only patch when the options
    // actually changed.
    if (el.model.innerHTML !== html) el.model.innerHTML = html;
    fitComposerSelects();
    renderComposerThinking();
  }

  // Size the model/thinking pills to the text currently selected rather than
  // letting the native <select> balloon to its widest option (or clip). Text is
  // measured exactly (hidden probe in the select's own font) and the pill
  // reserves room for the native dropdown chevron, so nothing is ever cut off
  // at the right edge. The bar wraps instead of overflowing when a full model
  // id is unusually long.
  let fitProbe = null; // reused hidden span used for text measurement
  function fitComposerSelects() {
    if (!el.model || !el.thinking) return;
    const box = el.composer ? el.composer.querySelector(".chat-composer-box") : null;
    const maxW = box ? Math.max(150, box.clientWidth - 32) : 560;
    for (const sel of [el.model, el.thinking]) {
      if (!sel) continue;
      const o = sel.options[sel.selectedIndex];
      if (!o) { sel.style.width = ""; continue; }
      const cs = getComputedStyle(sel);
      // Measuring the label forces layout, and renderComposerModel() runs on
      // every poll — so skip the measurement + style write when the label, its
      // font and the available width are all unchanged (the common case).
      const fitKey = `${maxW}|${o.text}|${cs.fontFamily}|${cs.fontSize}|${cs.fontWeight}|${cs.letterSpacing}`;
      if (sel.dataset.fitKey === fitKey) continue;
      sel.dataset.fitKey = fitKey;
      if (!fitProbe) {
        fitProbe = document.createElement("span");
        fitProbe.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;pointer-events:none;left:-9999px;top:0";
        document.body.appendChild(fitProbe);
      }
      fitProbe.style.fontFamily = cs.fontFamily;
      fitProbe.style.fontSize = cs.fontSize;
      fitProbe.style.fontWeight = cs.fontWeight;
      fitProbe.style.letterSpacing = cs.letterSpacing;
      fitProbe.textContent = o.text;
      const textW = fitProbe.getBoundingClientRect().width;
      const padL = parseFloat(cs.paddingLeft) || 10;
      const padR = parseFloat(cs.paddingRight) || 10;
      // Native selects draw their chevron inside the right padding area; keep
      // that space explicit plus a small breather so the label never kisses
      // the pill's rounded right edge.
      const want = Math.ceil(textW + padL + padR + 6);
      sel.style.width = Math.min(maxW, want) + "px";
    }
  }

  // Populate the thinking-level dropdown next to the model. Options come from
  // the current model's supported levels (thinkingLevelMap in the model store)
  // with the default set as fallback; the currently selected level is always
  // present. Persisting the choice (POST /agent-team setThinkingLevel) is wired
  // in the change handler; pi resolves the level at agent start, so the re-arm
  // after the toggle makes it take effect on the next prompt.
  function renderComposerThinking() {
    if (!el.thinking) return;
    const meta = CH.chatModel ? footerModelMeta(CH.chatModel) : null;
    const current = CH.thinkingLevel || CH.footer?.thinking || "high";
    const opts = (meta?.thinkingLevels && meta.thinkingLevels.length ? meta.thinkingLevels : ["off", "low", "medium", "high"]).slice();
    if (!opts.includes(current)) opts.push(current);
    let html = "";
    for (const lvl of opts) {
      html += `<option value="${esc(lvl)}"${lvl === current ? " selected" : ""}>${esc(lvl)}</option>`;
    }
    // Same guard as the model select below: this runs on every poll, and an
    // unconditional innerHTML swap resets the element — closing an open
    // dropdown and dropping focus mid-interaction.
    if (el.thinking.innerHTML !== html) el.thinking.innerHTML = html;
  }

  // ─── Composer footer (pi custom-footer port) ────────────────────────────
  // Two status lines under the input mirroring the pi terminal's custom-footer
  // extension: model/thinking, token stats, cost, context bar, elapsed, cwd,
  // git branch (line 1); provider pricing + opencode-go rolling $ usage (line
  // 2). Model metadata (context window, max tokens, $/M) and branch/thinking
  // come from the server's /chat/footer endpoint; token/cost/context numbers
  // from the visible session's /stats.
  function cfFmt(n) {
    n = Number(n) || 0;
    if (n < 1000) return `${n}`;
    if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
    return `${(n / 1_000_000).toFixed(1)}M`;
  }

  function cfElapsed(firstTs) {
    if (!firstTs) return "";
    const t = typeof firstTs === "number" ? firstTs : Date.parse(firstTs);
    if (Number.isNaN(t)) return "";
    const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rs = s % 60;
    if (m < 60) return `${m}m${rs ? rs + "s" : ""}`;
    const h = Math.floor(m / 60);
    return `${h}h${m % 60 ? (m % 60) + "m" : ""}`;
  }

  function cfReset(sec) {
    const s = Math.max(0, Math.floor(sec));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d > 0) return h > 0 ? `${d}d${h}h` : `${d}d`;
    if (h > 0) return m > 0 ? `${h}h${m}m` : `${h}h`;
    if (m > 0) return `${m}m`;
    return `${s}s`;
  }

  function footerModelMeta(model) {
    return CH.footer?.modelMeta?.[model] || null;
  }

  // Fetch the static footer data (branch, thinking, model metadata, go usage).
  // Throttled to once per 30s; `force` skips the throttle (workspace switch).
  async function fetchChatFooter(force) {
    if (!CH.workspace || document.hidden) return;
    const now = Date.now();
    if (!force && CH.footerFetchedAt && now - CH.footerFetchedAt < 30000) return;
    CH.footerFetchedAt = now;
    try {
      const { res, data } = await window.SCOPE.api("/chat/footer", { cwd: CH.workspace });
      if (res.ok && data) {
        CH.footer = data;
        renderComposerThinking();
        renderChatFooter();
        // The server's live go-usage fetch lands ~2s after the first request;
        // the first response carries DB fallback values (resetSec -1). Re-fetch
        // once shortly after so the real rolling percentages show up quickly.
        if (!CH.footerGoRetry && CH.footer?.goUsage && goUsageIsStale(CH.footer.goUsage)) {
          CH.footerGoRetry = true;
          setTimeout(() => { CH.footerGoRetry = false; fetchChatFooter(true); }, 5000);
        }
      }
    } catch { /* server unreachable — keep last snapshot */ }
  }

  // True while none of the windows carries a live reset boundary yet (the
  // server falls back to local $ sums until its API refresh completes).
  function goUsageIsStale(go) {
    return ["h5", "wk", "mo"].every((k) => !go[k] || (go[k].resetSec ?? -1) < 0);
  }

  // Aggregate the usage carried by the assistant messages currently on screen
  // (the same snapshots that feed each bubble's badges). Deriving the footer
  // numbers from the visible thread — instead of a server /stats round-trip —
  // means they always match what the user is looking at: they can't lag the DB
  // flush, point at the wrong session, or show stray zeros while a recorded
  // session is still being written to.
  function convUsage() {
    const agg = { input: 0, output: 0, cost: 0, count: 0, ctx: 0, model: "", firstTs: 0 };
    for (const m of CH.chatHistory) {
      const u = m.usage;
      if (m.role !== "assistant" || !u) continue;
      const n = (a, b) => Number(a ?? b ?? 0) || 0;
      agg.input += n(u.input);
      agg.output += n(u.output);
      agg.cost += n(u.cost_total, u.cost?.total);
      agg.count++;
      if (m.model) agg.model = m.model;
      if (!agg.firstTs) agg.firstTs = m.ts || 0;
      // Last-message context ≈ the full prefix sent this turn — input plus any
      // cache reads/writes — mirroring pi's terminal context bar.
      if (u.input != null || u.cache_read != null || u.cacheRead != null) {
        agg.ctx = n(u.input) + n(u.cache_read, u.cacheRead) + n(u.cache_write, u.cacheWrite);
      }
    }
    return agg;
  }

  // Footer line icons — inline stroke SVGs from the same lucide-style family
  // used across the chat canvas, so they render crisply on every platform
  // instead of fallback unicode glyphs.
  const CF_ICON = {
    up: `<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>`,
    down: `<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>`,
    clock: `<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>`,
    folder: `<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>`,
    branch: `<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>`,
    dollar: `<line x1="12" y1="2" x2="12" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>`,
    gauge: `<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>`,
    wallet: `<path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/>`,
    repeat: `<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>`,
    activity: `<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>`,
  };
  function cfIco(name, size) {
    return `<svg viewBox="0 0 24 24" width="${size || 11}" height="${size || 11}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${CF_ICON[name] || ""}</svg>`;
  }

  // Slim rounded gauge bar used for the context window and the rolling usage
  // windows. Fill colour shifts green → amber → red as utilization climbs.
  function cfBar(pct, size) {
    const w = Math.max(0, Math.min(100, Number(pct) || 0));
    const cls = w > 90 ? "cf-err" : w > 70 ? "cf-warn" : "cf-success";
    return `<span class="cf-bar cf-bar-${size || "md"}"><span class="cf-fill ${cls}" style="width:${w.toFixed(2)}%"></span></span>`;
  }

  // Cost with precision that survives sub-cent spends (footer rounds up only
  // once the total is meaningful, instead of snapping tiny amounts to $0.00).
  function cfCost(n) {
    n = Number(n) || 0;
    if (n === 0) return "$0";
    if (n >= 0.01) return `$${n.toFixed(2)}`;
    return `$${n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
  }

  let footerHtml = null; // last markup written to the composer footer
  function renderChatFooter() {
    if (!el.footer) return;
    if (!CH.workspace) {
      if (footerHtml === "") return;
      footerHtml = "";
      el.footer.innerHTML = "";
      return;
    }
    const sep = `<span class="cf-sep">·</span>`;
    const sid = CH.openSid || CH.chatSessionId;
    const s = CH.sessions.find((x) => x.session_id === sid);
    const conv = convUsage();

    // Two model scopes drive the footer:
    //  • the model that produced the visible thread (when a conversation is on
    //    screen) sets the context-window denominator — tokens can only be
    //    gauged against the window they actually ran in;
    //  • the composer-selected model drives the provider/pricing row, so
    //    changing the Model dropdown updates that UI immediately.
    const chatModel = CH.chatModel || "";
    const threadModel = conv.model || (s ? qualifiedModel(s) : "") || "";
    const winModel = threadModel || chatModel;
    const winMeta = winModel ? footerModelMeta(winModel) : null;
    const ctxWin = winMeta?.contextWindow || 0;
    const selModel = chatModel || threadModel;
    const selMeta = selModel ? footerModelMeta(selModel) : null;
    const provider = selMeta?.provider || (selModel ? selModel.split("/")[0] : "");

    // ── Row 1: conversation telemetry chips · right-aligned session meta ──
    // Cost and the context gauge are ALWAYS visible once a workspace is open:
    // cost reads $0 before any spend, and the context gauge reads 0% / window
    // before any tokens — so the spend + context readout never disappears. The
    // token in/out chips appear once a thread exists and stay mounted for the
    // whole thread (the live usage stream can briefly deliver all-zero input,
    // which previously dropped the count to 0 and made chips blink on/off).
    const hasThread = CH.chatHistory.some((m) => m.role === "assistant");
    const chips = [];
    // Cost chip — always present. The dollar glyph is already the chip's icon,
    // so the amount itself renders without a second currency symbol.
    chips.push(`<span class="cf-chip cf-cost" title="Total spent on this conversation">${cfIco("dollar", 10)}<span>${esc(cfCost(conv.cost).replace(/^\$/, ""))}</span></span>`);
    // Token in/out chips — shown once a thread exists, kept mounted for it.
    if (hasThread) {
      chips.push(
        `<span class="cf-chip" title="${esc(`${cfFmt(conv.input)} input tokens · ${cfFmt(conv.output)} output tokens across the conversation shown`)}">` +
        `<span class="cf-in">${cfIco("up", 9)}${cfFmt(conv.input)}</span>` +
        `<span class="cf-out">${cfIco("down", 9)}${cfFmt(conv.output)}</span>` +
        `</span>`
      );
    }
    // Context gauge — always shown once a workspace is open, so the context
    // readout never disappears. When the window is known it reads
    // `N% / window`; when a model has no declared window (rare) it still
    // renders the used-context figure with a neutral denominator.
    if (ctxWin > 0) {
      const pct = Math.min(100, (conv.ctx / ctxWin) * 100);
      chips.push(
        `<span class="cf-ctx" title="${esc(`context ${pct.toFixed(1)}% of the ${cfFmt(ctxWin)} window${winMeta?.maxTokens ? ` (max output ${cfFmt(winMeta.maxTokens)})` : ""}`)}">` +
        cfIco("gauge", 10) +
        `<span class="cf-ctx-l">ctx</span>` +
        cfBar(pct, "ctx") +
        `<span class="cf-ctx-p">${pct.toFixed(0)}%</span>` +
        `<span class="cf-ctx-cap">/${cfFmt(ctxWin)}</span>` +
        `</span>`
      );
    } else {
      // No declared context window — still surface the used tokens so the
      // indicator is permanently visible rather than blinking out.
      chips.push(
        `<span class="cf-ctx cf-ctx-unknown" title="Context window not known for the selected model; showing tokens used">` +
        cfIco("gauge", 10) +
        `<span class="cf-ctx-l">ctx</span>` +
        `<span class="cf-ctx-p">${cfFmt(conv.ctx)}</span>` +
        `<span class="cf-ctx-cap">tk</span>` +
        `</span>`
      );
    }

    const metaParts = [];
    const startTs = (s && s.first_ts) || conv.firstTs || 0;
    const elapsed = startTs ? cfElapsed(startTs) : "";
    if (elapsed) metaParts.push(`<span class="cf-meta-it cf-dim">${cfIco("clock", 10)}${esc(elapsed)}</span>`);
    const cwdShort = CH.workspace.split("/").filter(Boolean).slice(-2).join("/") || CH.workspace;
    metaParts.push(`<span class="cf-meta-it cf-muted">${cfIco("folder", 10)}${esc(cwdShort)}</span>`);
    if (CH.footer?.branch) metaParts.push(`<span class="cf-meta-it cf-accent">${cfIco("branch", 10)}${esc(CH.footer.branch)}</span>`);

    // ── Row 2: provider pricing · rolling go usage ──
    const sub = [];
    if (provider) {
      const mCost = selMeta?.cost || {};
      const hasPrice = mCost.input != null || mCost.output != null;
      const px = (v) => (Number(v) === 0 ? "free" : v == null ? null : `$${Number(v).toFixed(2)}/M`);
      let s2 = `${cfIco("wallet", 10)}<b>${esc(provider)}</b>`;
      if (hasPrice) {
        const pi = px(mCost.input);
        const po = px(mCost.output);
        if (pi != null) s2 += `<span class="cf-sub-dim">in ${pi}</span>`;
        if (po != null) s2 += `<span class="cf-sub-text">out ${po}</span>`;
        if (mCost.cacheRead) s2 += `<span class="cf-sub-cache">${cfIco("repeat", 9)}$${Number(mCost.cacheRead).toFixed(2)}/M read</span>`;
      }
      sub.push(`<span class="cf-pay">${s2}</span>`);
    }
    if (provider === "opencode-go" && CH.footer?.goUsage) {
      const go = CH.footer.goUsage;
      const win = (label, key) => {
        const w = go[key] || {};
        const pct = Number(w.pct) || 0;
        let h =
          `<span class="cf-go" title="${esc(`go ${label} window — ${pct.toFixed(0)}% of the rolling limit`)}">` +
          `<span class="cf-go-l">${label}</span>` +
          cfBar(pct, "go") +
          `<span class="cf-go-p cf-${pct > 75 ? "err" : pct > 50 ? "warn" : "success"}">${pct.toFixed(0)}%</span></span>`;
        if (w.resetSec != null && w.resetSec >= 0) {
          h += `<span class="cf-reset" title="resets in ${esc(cfReset(w.resetSec))}">${cfIco("clock", 9)}${esc(cfReset(w.resetSec))}</span>`;
        }
        return h;
      };
      sub.push(
        `<span class="cf-go-all">` +
        `<span class="cf-go-title">${cfIco("activity", 10)}go usage</span>` +
        win("5h", "h5") + win("wk", "wk") + win("mo", "mo") +
        `</span>`
      );
    }

    const html =
      `<div class="cf-row cf-main">` +
      `<span class="cf-chips">${chips.join("")}</span>` +
      (metaParts.length ? `<span class="cf-meta">${metaParts.join(sep)}</span>` : "") +
      `</div>` +
      (sub.length ? `<div class="cf-row cf-sub">${sub.join(sep)}</div>` : "");
    // The footer is rebuilt once per frame while a turn streams and on a 30s
    // tick otherwise; skip the DOM write when the rendered values are the same
    // (a usage event that doesn't move the formatted chips, an idle tick).
    if (footerHtml === html) return;
    footerHtml = html;
    el.footer.innerHTML = html;
  }

  function autoGrow(textarea) {
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = Math.min(200, textarea.scrollHeight) + "px";
  }

  // ─── Dictation (speech to text) ───────────────────────────────────────────
  // Dictation mirrors the pi `speech-to-text` extension: the SCOPE server
  // records the host microphone (sox/arecord/ffmpeg) and transcribes the clip
  // with Groq Whisper. The browser never speaks to a speech service itself, so
  // this needs no Web-Speech/Google connection. The mic is only shown while
  // that extension is enabled in the pi settings, since it is the pipeline the
  // button drives (`GROQ_API_KEY` + speech-to-text.json).
  function sttExtensionOn() {
    const exts = CH.teamData?.extensions || [];
    return exts.some((ex) =>
      ex.enabled && ex.available && /speech-to-text|stt/i.test(ex.name || ex.path || "")
    );
  }

  function updateListenButton() {
    if (!el.listen) return;
    const on = sttExtensionOn();
    el.listen.style.display = on ? "" : "none";
    el.listen.classList.toggle("on", CH.listening);
    el.listen.setAttribute("aria-pressed", CH.listening ? "true" : "false");
    if (CH.listening) {
      el.listen.disabled = false;
      el.listen.title = "Stop dictation and insert the transcript";
      return;
    }
    if (CH.sttInFlight) {
      el.listen.disabled = true;
      el.listen.title = "Transcribing…";
      return;
    }
    const info = CH.sttInfo;
    const noKey = !!info && !info.hasApiKey;
    const noRec = !!info && !info.recorderAvailable;
    el.listen.disabled = !on || !CH.workspace || noKey || noRec;
    el.listen.title = noKey
      ? "Speech to text needs GROQ_API_KEY — export it in your shell profile (~/.bashrc, ~/.zshrc) or add \"apiKey\" to speech-to-text.json"
      : noRec
        ? "No audio recorder found (install sox, alsa-utils or ffmpeg)"
        : "Dictate a message (speech to text)";
  }

  // Ask the server whether the host can record and transcribe. Cached per
  // workspace — the config it reads (<project>/.pi/speech-to-text.json) is
  // per project, so switching workspaces re-checks.
  async function refreshSttStatus() {
    const cwd = CH.workspace;
    if (!cwd || CH.sttFetching) return;
    CH.sttFetching = true;
    try {
      const { res, data } = await window.SCOPE.api("/chat/stt/status", { cwd });
      if (res.ok && cwd === CH.workspace) { CH.sttInfo = data; CH.sttInfoCwd = cwd; }
    } catch { /* server unreachable — leave the mic disabled */ }
    CH.sttFetching = false;
    updateListenButton();
  }

  // Re-evaluate the mic whenever the team snapshot changes (enable/disable the
  // speech-to-text extension, switch workspace).
  function renderSttButton() {
    if (sttExtensionOn() && CH.workspace && CH.sttInfoCwd !== CH.workspace && !CH.sttFetching) {
      void refreshSttStatus();
    }
    updateListenButton();
  }

  // Level-meter cadence and the quiet period after which we prompt "no signal?"
  // (mirrors the pi extension's footer meter).
  const STT_LEVEL_MS = 150;
  const STT_NO_SIGNAL_MS = 2500;
  const STT_METER_SEGMENTS = 8;

  function stopSttTicker() {
    if (CH.sttTimer) { clearTimeout(CH.sttTimer); CH.sttTimer = null; }
  }

  function sttLevelBar(level) {
    const filled = Math.max(0, Math.min(STT_METER_SEGMENTS, Math.round((level || 0) * STT_METER_SEGMENTS)));
    return "█".repeat(filled) + "░".repeat(STT_METER_SEGMENTS - filled);
  }

  // The recording hint carries a level bar, which only lines up in a monospace
  // font — so it is written as HTML (setHint sets text and would not style the
  // bar). Same busy/err classes as setHint so the states stay consistent.
  function setSttHint(bar, clock, note) {
    if (!el.hint) return;
    el.hint.innerHTML =
      `<span class="chat-stt-bar">${esc(bar)}</span>` +
      `<span class="chat-stt-clock">${esc(clock)}</span>` +
      (note ? `<span class="chat-stt-note">${esc(note)}</span>` : "");
    el.hint.classList.add("busy");
    el.hint.classList.remove("err");
  }

  // Recording clock + live level meter. Each tick asks the server for the RMS
  // level of the audio it is capturing (the browser can't see the host's mic)
  // and redraws the hint as `████░░░░ 0:05`. Self-scheduling, so a slow reply
  // just skips a frame instead of stacking requests. The server caps a clip at
  // maxDurationSeconds and auto-transcribes; the client finishes at the same
  // mark so a transcript still lands if the user walked away.
  function startSttTicker() {
    stopSttTicker();
    let level = 0;
    let silentMs = 0;
    const paint = (transcribing) => {
      const secs = Math.floor((Date.now() - CH.sttStartedAt) / 1000);
      const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
      if (transcribing) {
        setSttHint(sttLevelBar(0), clock, "transcribing…");
        return;
      }
      setSttHint(
        sttLevelBar(level),
        clock,
        silentMs > STT_NO_SIGNAL_MS ? "no signal? — click the mic to stop" : "click the mic to stop"
      );
    };
    const step = async () => {
      if (!CH.listening) return;
      const secs = Math.floor((Date.now() - CH.sttStartedAt) / 1000);
      if (secs > CH.sttMaxSeconds) { void finishListening(); return; }
      let status = null;
      try {
        status = (await window.SCOPE.api("/chat/stt/status", { cwd: CH.workspace })).data;
      } catch { /* server unreachable — keep the last level */ }
      if (!CH.listening) return; // the user stopped while the request was in flight
      // The server auto-stopped (clip cap) and has the transcript ready.
      if (status && status.recording === false) { void finishListening(); return; }
      if (status) { level = status.level || 0; silentMs = status.silentMs || 0; }
      paint(secs >= CH.sttMaxSeconds);
      CH.sttTimer = setTimeout(() => { void step(); }, STT_LEVEL_MS);
    };
    CH.sttTimer = setTimeout(() => { void step(); }, 0);
  }

  // Splice the transcript into the composer at the caret it was recorded from,
  // preserving whatever the user typed before and after the recording started.
  function insertDictation(text) {
    if (!el.input || !text) return;
    let spoken = text.trim();
    if (!spoken) return;
    const base = CH.listenBase || "";
    const tail = CH.listenTail || "";
    if (base && !/\s$/.test(base)) spoken = " " + spoken;
    if (tail && !/^\s/.test(tail)) spoken += " ";
    el.input.value = base + spoken + tail;
    const caret = (base + spoken).length;
    try { el.input.setSelectionRange(caret, caret); } catch { /* not focusable */ }
    autoGrow(el.input);
  }

  async function startListening() {
    if (CH.listening || CH.sttInFlight || !CH.workspace || !sttExtensionOn()) return;
    const input = el.input;
    const selStart = input ? input.selectionStart : 0;
    const selEnd = input ? input.selectionEnd : selStart;
    CH.listenBase = input ? input.value.slice(0, selStart) : "";
    CH.listenTail = input ? input.value.slice(selEnd) : "";
    try {
      const { res, data } = await window.SCOPE.api("/chat/stt/start", {}, { cwd: CH.workspace });
      if (!res.ok || !data?.ok) {
        setHint(data?.error || `could not start recording (HTTP ${res.status})`, "err");
        return;
      }
      CH.listening = true;
      CH.sttStartedAt = Date.now();
      CH.sttMaxSeconds = data.maxDurationSeconds || 120;
      updateListenButton();
      startSttTicker();
    } catch (e) {
      setHint(String(e?.message || e), "err");
    }
  }

  // Stop the host recording and insert its transcript. The ticker's auto-finish
  // and a manual mic click can't double-insert: the first call clears
  // CH.listening, and the server returns a finished clip only once.
  async function finishListening() {
    if (!CH.listening) return;
    CH.listening = false;
    stopSttTicker();
    CH.sttInFlight = true;
    updateListenButton();
    setHint("transcribing…", "busy");
    let data = null;
    try {
      data = (await window.SCOPE.api("/chat/stt/stop", {}, {})).data;
    } catch (e) {
      data = { error: String(e?.message || e) };
    }
    CH.sttInFlight = false;
    updateListenButton();
    if (data?.ok && data.text) {
      insertDictation(data.text);
      setHint("", "");
      el.input?.focus();
    } else {
      setHint(data?.error || "transcription failed", "err");
    }
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

  // Fire-and-forget kill of a server-side pi subprocess by chat key. Used by
  // the cleanup paths (deleting a session / removing a workspace) that have
  // already dropped the local thread and only want the process gone.
  function killChatKey(key) {
    if (!key) return;
    fetch(window.apiUrl("/chat/kill"), {
      method: "POST",
      headers: { ...window.authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ sessionId: key }),
    }).catch(() => { /* server unreachable — nothing more we can do */ });
  }

  // Kill the CURRENT thread's pi subprocess (if any) so a fresh one can be
  // spawned with no memory of earlier chats. Best-effort: the server drops the
  // session map entry, so the next /chat/start (or prompt) spawns a fresh `pi`.
  // Callers that need ordering — e.g. re-pre-spawning after a config change —
  // await it before issuing the new /chat/start.
  async function killCurrentChatSession() {
    const t = curThread();
    const sid = t?.key;
    if (!sid) return;
    t.key = null;
    syncCurThread();
    try {
      await fetch(window.apiUrl("/chat/kill"), {
        method: "POST",
        headers: { ...window.authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ sessionId: sid }),
      });
    } catch { /* server unreachable — fine */ }
  }

  function newSession() {
    if (CH.chatBusy) return;
    // Start a brand-new conversation for the workspace: wipe the free thread
    // (and any resumed session target) and re-arm a fresh pi session.
    clearSnapshot();
    void resetChat();
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

  // Read an NDJSON stream from POST /chat into the active `live` message. Shared
  // by sendPrompt (a fresh turn) and sendWhileBusy's race path (the agent settled
  // between the click and the request landing, so pi treated it as a new prompt).
  async function consumeChatStream(res, t) {
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
          if (t.live?.m) t.live.m.streaming = false;
          if (ev.sessionId) t.key = ev.sessionId;
          if (ev.error) {
            const tgt = t.live?.m;
            if (tgt) tgt.errorNote = ev.error === "process closed"
              ? "pi session ended unexpectedly (process closed)"
              : ev.error;
          }
          if (ev.aborted) {
            // The user stopped the agent: mark any queued steer/follow-up as
            // cancelled (clear_queue dropped them) and stamp the live message.
            for (const q of t.live?.queue || []) addCancelledNote(q.node, q.msg);
            if (t.live) addStoppedNote(t.live.body, t.live.m);
            else addStoppedNote(null, t.history[t.history.length - 1]);
          }
          syncCurThread();
        } else {
          handleChatEvent(ev, t);
        }
      }
    }
  }

  // Finalize a chat turn on a thread: clear its busy flag, stop the live
  // stream, persist and re-render the visible thread with full markdown.
  // Guarded by `gen` so a newer turn (e.g. a steer that raced the agent
  // settling and became a fresh prompt) can supersede an older turn's finalize
  // without clobbering its live state. Background threads just update their
  // model — the canvas only re-renders for the visible one.
  function finalizeChatTurn(t, gen) {
    if (!t || gen !== t.gen) return;
    t.busy = false;
    t.suppressed = false;
    t.live = null;
    t.dialogs.clear();
    t.pendingCustom = null;
    t.history = t.history.map((m) => ({ ...m, streaming: false }));
    if (t !== curThread()) { syncCurThread(); return; }
    syncCurThread();
    persistConversation();
    setHint("reply complete", "");
    setComposerEnabled(true);
    updateHeader();
    renderChat();
    el.input?.focus();
    renderChatFooter();
  }

  // Queue a message to the CURRENT thread's pi session when it is already
  // streaming. With the Steer toggle on, the message is delivered mid-run
  // (after the current tool turn); off, it waits until the agent settles. The
  // in-flight stream keeps pushing events to the same live message, so we only
  // append the user bubble and record it in t.live.queue — the assistant
  // response arrives on a later run_start.
  async function sendWhileBusy(text) {
    const t = curThread();
    if (!t) return;
    const model = CH.chatModel || defaultChatModel();
    const streamingBehavior = CH.steer ? "steer" : "followUp";
    const userMsg = { role: "user", text, ts: Date.now() };
    t.history.push(userMsg);
    // Same bound as a fresh turn so a long steer-heavy conversation can't grow
    // without limit in RAM.
    if (t.history.length > CHAT_HISTORY_MAX) {
      t.history.splice(0, t.history.length - CHAT_HISTORY_MAX);
    }
    syncCurThread();
    el.input.value = "";
    autoGrow(el.input);
    try {
      const res = await fetch(window.apiUrl("/chat"), {
        method: "POST",
        headers: { ...window.authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ cwd: CH.workspace, model, thinkingLevel: CH.thinkingLevel || "", prompt: text, sessionId: t.key || (t.kind === "session" ? t.sid : "") || "", sessionFile: t.resumeFile || "", streamingBehavior }),
      });
      const ct = res.headers.get("content-type") || "";
      if (res.ok && ct.includes("ndjson")) {
        // Race: the agent settled while the request was in flight, so pi treated
        // this as a fresh prompt — render the new turn and consume the stream.
        const gen = ++t.gen;
        t.busy = true;
        t.suppressed = false;
        const aiMsg = { role: "assistant", text: "", thinking: "", tools: [], usage: null, model, ts: Date.now(), streaming: true };
        t.history.push(aiMsg);
        syncCurThread();
        el.msg.innerHTML = t.history.slice(0, -1).map((m, i) => renderChatMsg(m, i)).join("") +
          renderChatMsgLivePlaceholder(aiMsg);
        t.live = {
          body: el.msg.querySelector(".chat-msg.chat-ai-live .chat-msg-body"),
          m: aiMsg,
          isFirst: true,
          queue: [],
          after: null,
        };
        setHint("pi is thinking…", "busy");
        updateHeader();
        scrollToBottom(true);
        await consumeChatStream(res, t);
        finalizeChatTurn(t, gen);
      } else {
        // Queued steer/follow-up. Append the user bubble and record it in
        // t.live.queue so the in-flight stream places the response after it.
        let node = null;
        if (el.msg) {
          const wrap = document.createElement("div");
          wrap.innerHTML = renderChatMsg(userMsg, t.history.length - 1);
          node = wrap.firstElementChild;
          if (node) el.msg.appendChild(node);
          scrollToBottom(true);
        }
        if (!res.ok) {
          let detail = "";
          try { detail = (await res.json())?.error || ""; } catch { /* non-JSON body */ }
          if (t.live) streamError(t.live.body, t.live.m, `queued message failed: HTTP ${res.status}${detail ? ": " + detail : ""}`);
          setHint("could not queue that message", "err");
        } else {
          if (t.live && node) t.live.queue.push({ msg: userMsg, node });
          setHint(
            CH.steer
              ? "steering pi — it will pivot after this tool turn"
              : "queued — pi will continue once this turn settles",
            "busy"
          );
        }
      }
    } catch (err) {
      if (t.live) streamError(t.live.body, t.live.m, (err && err.message) || String(err));
    }
    el.input?.focus();
  }

  async function sendPrompt() {
    const text = el.input.value.trim();
    // Enter while dictating stops the recording and inserts the transcript
    // instead of sending a half-spoken message. Checked before the empty-value
    // guard so Enter always ends an in-progress recording.
    if (CH.listening) { void finishListening(); return; }
    if (!text) return;
    if (!CH.workspace) { el.input.focus(); return; }
    let t = curThread();
    if (!t) {
      t = freeThread(CH.workspace);
      bindThread(t);
    }
    // A turn is already streaming on THIS thread: send as a steer/follow-up
    // instead of a fresh prompt, and let the in-flight stream carry the
    // response (queued within this session only).
    if (t.busy) {
      await sendWhileBusy(text);
      return;
    }

    // Sending turns the canvas into a live conversation (not a session replay).
    t.openSid = null;

    const model = CH.chatModel || defaultChatModel();
    const gen = ++t.gen;
    t.busy = true;
    t.suppressed = false;
    setComposerEnabled(true);
    setHint("pi is thinking…", "busy");

    const userMsg = { role: "user", text, ts: Date.now() };
    const aiMsg = { role: "assistant", text: "", thinking: "", tools: [], usage: null, model, ts: Date.now(), streaming: true };
    t.history.push(userMsg);
    t.history.push(aiMsg);
    if (t.kind === "free" && !t.firstPrompt) t.firstPrompt = text;
    // Bound the in-memory thread: drop the oldest messages from a very long
    // conversation while keeping the newest (including the one streaming).
    if (t.history.length > CHAT_HISTORY_MAX) {
      t.history.splice(0, t.history.length - CHAT_HISTORY_MAX);
    }
    syncCurThread();

    el.msg.innerHTML = t.history.slice(0, -1).map((m, i) => renderChatMsg(m, i)).join("") +
      renderChatMsgLivePlaceholder(aiMsg);
    t.live = {
      body: el.msg.querySelector(".chat-msg.chat-ai-live .chat-msg-body"),
      m: aiMsg,
      isFirst: true, // the placeholder already stands in for the first assistant message
      queue: [], // queued steer/follow-up user bubbles awaiting their run
      after: null, // the user bubble the current assistant run's messages follow
    };
    updateHeader();
    scrollToBottom(true);

    el.input.value = "";
    autoGrow(el.input);

    try {
      const res = await fetch(window.apiUrl("/chat"), {
        method: "POST",
        headers: { ...window.authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          cwd: CH.workspace,
          model,
          thinkingLevel: CH.thinkingLevel || "",
          prompt: text,
          // A recorded-session thread resumes its own pi session file: the
          // server keys a subprocess per session id and switch_session onto the
          // file. A free thread uses its pre-spawn key (or lets the server
          // allocate one on first prompt).
          sessionId: t.key || (t.kind === "session" ? t.sid : "") || "",
          sessionFile: t.resumeFile || "",
        }),
      });
      if (!res.ok || !res.body) {
        let detail = "";
        try { detail = (await res.json())?.error || ""; } catch { /* non-JSON body */ }
        streamError(t.live.body, aiMsg, `HTTP ${res.status}${detail ? ": " + detail : ""}`);
      } else {
        await consumeChatStream(res, t);
      }
    } catch (err) {
      streamError(t.live.body, aiMsg, (err && err.message) || String(err));
    }

    finalizeChatTurn(t, gen);
  }

  // Start a conversation from a hero suggestion chip.
  function promptFromChip(text) {
    if (!CH.workspace) return;
    if (el.input) { el.input.value = text; autoGrow(el.input); }
    sendPrompt();
  }

  function addWorkspaceRow() {
    CH.adding = true;
    renderWorkspaces();
    const input = document.getElementById("chat-ws-add-input");
    if (input) input.focus();
  }

  // Open the "add workspace" flow. When the native directory picker is
  // available (Electron) open the file manager directly and submit the chosen
  // path; otherwise fall back to the inline manual-entry row in the sidebar.
  async function openAddWorkspace() {
    if (typeof window.scopeNative?.pickDirectory === "function") {
      try {
        const dir = await window.scopeNative.pickDirectory();
        if (dir) { submitAddWorkspace(dir); return; }
        // cancelled — fall back to manual entry
      } catch { /* dialog failed — fall back to manual entry */ }
    }
    addWorkspaceRow();
  }

  // ─── Loading a session transcript into the chat window ───────────────────
  // Clicking a session row (under a workspace, or in the fallback agent list)
  // shows that session's conversation here with the composer enabled. Sessions
  // are INDEPENDENT: a running session you open keeps streaming live; other
  // running sessions keep working in the background while you view this one.
  async function loadSessionChat(sid, silent) {
    if (!sid) return;
    const row = CH.sessions.find((x) => x.session_id === sid) || null;
    // Chatting in a session means resuming pi's own session file in THAT
    // project — follow the session's workspace, with the same side effects as a
    // workspace click (shared cwd for Files/Git/Terminal, per-project team
    // config, footer). Without these, opening a session from another workspace
    // left the rails on the old project and the footer showing the old branch.
    if (row && row.cwd && row.cwd !== CH.workspace) {
      CH.workspace = row.cwd;
      CH.team = null;
      persistWorkspace();
      if (typeof window.__setCwd === "function") window.__setCwd(row.cwd);
      teamFetchedAt = 0;
      void loadAgentTeam();
      CH.footer = null;
      CH.footerFetchedAt = 0;
      CH.footerGoRetry = false;
      fetchChatFooter(true);
      renderWorkspaces();
    }
    let t = threadForSid(sid);
    if (!t) {
      t = sessionThread(sid, row?.session_file || null, row?.cwd || CH.workspace);
      t.workspace = row?.cwd || CH.workspace;
    }
    // Browsing away from a busy thread freezes its preview but its run keeps
    // going in the background (model updates only).
    const prev = curThread();
    if (prev && prev !== t) detachThread(prev);
    bindThread(t);
    renderAgents(); // highlight the subagent role that owns the open session
    if (t.loadingSid === sid) {
      // A transcript fetch for this thread is already in flight — bind to it
      // and show the current state; the in-flight fetch renders when done.
      if (t.busy && t.live) {
        t.suppressed = false;
        renderChat();
        attachLiveDom(t);
        return;
      }
      if (!silent && el.hint) setHint("loading session…", "busy");
      renderChat();
      return;
    }
    // A running session: show its current state and resume live streaming.
    if (t.busy && t.live) {
      t.suppressed = false;
      t.loadingSid = null;
      renderChat(); // renders history + the live placeholder tail
      attachLiveDom(t);
      updateHeader();
      if (!silent && el.hint) setHint("session is still working — streaming live", "busy");
      if (el.input && !silent) el.input.focus();
      return;
    }
    // Idle: (re)load the recorded transcript into the thread. Re-clicking a
    // session already on screen re-fetches so messages recorded since the last
    // load are picked up.
    t.openSid = sid;
    t.loadingSid = sid;
    t.lastOpenCount = null;
    // Generation token for THIS thread's transcript loads. A newer load (or a
    // re-click that supersedes it) owns the thread's state; a late response
    // therefore can neither apply stale content nor — as it used to — leave the
    // thread permanently "loading" after the user browsed away mid-fetch.
    const loadGen = ++t.loadGen;
    renderAgents();
    if (!silent) renderChat(); // show the loading hero on first open only
    try {
      const { res, data } = await window.SCOPE.api(`/sessions/${encodeURIComponent(sid)}/events`, { limit: 1000 });
      if (t.loadGen !== loadGen) return; // a newer load on this thread superseded us
      // This response is still the latest for the thread, so the thread is no
      // longer "loading" — clear the flag BEFORE the visibility check. Doing it
      // after (and only when the thread is on screen) is what stranded a
      // session: browsing away mid-fetch left loadingSid set forever, so
      // reopening it showed "Loading…" and never fetched its own events.
      t.loadingSid = null;
      // A free thread's history IS the workspace's own live conversation, and
      // the rail aliases a recorded session onto that same thread (pi records a
      // free conversation under a session id). Replacing its history with the
      // fetched transcript would leave session content sitting in the
      // workspace's thread — so a later workspace click would show a transcript
      // even though no session row was clicked. Adopt the resume target and
      // keep the conversation the thread already owns.
      if (t.kind !== "free") {
        t.history = (res.ok && Array.isArray(data?.events) ? buildSessionMsgs(data.events, row, sid) : [])
          .slice(-CHAT_HISTORY_MAX);
      }
      // Continuing in this session means resuming pi's own session file, so the
      // agent picks up the full conversation context on the next prompt.
      t.resumeFile = row?.session_file || t.resumeFile;
      t.lastOpenCount = row?.event_count ?? t.history.length;
      syncCurThread();
      if (curThread() !== t) return; // applied to the model, not the visible thread
      persistConversation();
      renderChat();
      renderChatFooter();
      if (el.hint) {
        const n = t.history.length;
        setHint(
          n
            ? `${n} message${n === 1 ? "" : "s"}${t.kind === "free" ? " in this conversation" : " from session"} — type to continue`
            : "no readable conversation in this session — type to start fresh",
          ""
        );
      }
      if (el.input && !silent) el.input.focus();
    } catch (e) {
      if (t.loadGen !== loadGen) return; // a newer load owns the state now
      t.loadingSid = null;
      if (curThread() !== t) return; // user moved on — nothing to show here
      if (!silent) {
        t.openSid = null;
        syncCurThread();
        renderChat();
        if (el.hint) setHint(`⚠ failed to load session: ${e?.message || e}`, "err");
      }
    }
  }

  // Fold a session's raw events into chat bubbles: user messages, assistant
  // replies (with markdown text, thinking and usage), and tool calls rendered
  // as chips attached to the reply they belong to.
  //
  // `sid` is the session whose transcript is being built. Only events that
  // carry that session id are folded in — each session's window shows its own
  // messages and nothing else. The server already filters by session_id; this
  // is the client-side guarantee against a mis-keyed row or a resumed
  // subprocess whose events were attributed to another session. Events with no
  // session id (older recordings, fixtures) pass through unchanged.
  function buildSessionMsgs(events, s, sid) {
    const msgs = [];
    let pendingTools = [];
    let pendingThinking = "";
    const model = s?.model || "";
    for (const ev of events) {
      if (sid && ev.session_id && ev.session_id !== sid) continue;
      const p = ev.payload || {};
      const evSid = sid || ev.session_id || null;
      if (ev.type === "user_message") {
        const text = p.text || "";
        if (text) msgs.push({ role: "user", text, ts: ev.ts, recorded: true, sid: evSid });
      } else if (ev.type === "assistant_message") {
        const thinking = p.thinking || pendingThinking || "";
        pendingThinking = "";
        const tools = pendingTools;
        pendingTools = [];
        const text = p.text || p.content || "";
        msgs.push({ role: "assistant", text, thinking, tools, usage: p.usage, model: p.model || model, ts: ev.ts, recorded: true, sid: evSid });
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
        pendingTools.push({
          name: p.tool_name || "tool",
          state: "ok",
          args: p.args,
          callId: p.tool_call_id,
          result: undefined,
          isError: false,
        });
      } else if (ev.type === "tool_result") {
        const isErr = S.isToolResultError(p);
        const byCall = pendingTools.find((t) => t.callId && t.callId === p.tool_call_id);
        const target = byCall || pendingTools[pendingTools.length - 1];
        if (target && (target.name === (p.tool_name || target.name))) {
          if (isErr) target.state = "err";
          target.isError = isErr;
          target.result = p.content_text || "";
        }
      }
    }
    // Flush anything still pending at the end of the event list.
    if (pendingTools.length || pendingThinking) {
      const last = msgs[msgs.length - 1];
      if (last && last.role === "assistant") {
        if (pendingTools.length) last.tools = (last.tools || []).concat(pendingTools);
        if (pendingThinking && !last.thinking) last.thinking = pendingThinking;
      } else if (pendingThinking || pendingTools.length) {
        msgs.push({ role: "assistant", text: "", thinking: pendingThinking || "", tools: pendingTools, model, ts: null, recorded: true, sid: sid || null });
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
    // Row/chip interactions for both rails — attached once, survives renders.
    wireRailDelegation();

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
        openAddWorkspace();
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

    const tThink = document.getElementById("chat-toggle-thinking");
    if (tThink) tThink.addEventListener("click", toggleThinking);
    const tTools = document.getElementById("chat-toggle-tools");
    if (tTools) tTools.addEventListener("click", toggleTools);

    if (el.wsAdd) {
      el.wsAdd.addEventListener("click", openAddWorkspace);
    }
    if (el.model) {
      el.model.addEventListener("change", () => {
        CH.chatModel = el.model.value;
        updateHeader();
        renderChatFooter();
        renderComposerThinking();
        fitComposerSelects(); // re-hug the pill to the newly selected label
        // The server respawns the idle pi subprocess when the requested model
        // differs, and pi honors --model when switch_session resumes a recorded
        // file — so the new model applies to this conversation from the next
        // message on, whether or not a session is open.
        if (!CH.chatHistory.length && CH.workspace) {
          const ft = freeThread(CH.workspace);
          ft.key = null;
          if (ft === curThread()) syncCurThread();
          ensureChatSession();
        }
        setHint(`next message uses ${CH.chatModel}`, "");
      });
    }
    if (el.thinking) {
      // The level is persisted (settings.json defaultThinkingLevel) for future
      // sessions and sent with every prompt (server pushes it to the running pi
      // subprocess via RPC set_thinking_level), so it applies from the next
      // message without respawning.
      el.thinking.addEventListener("change", () => {
        const level = el.thinking.value;
        CH.thinkingLevel = level;
        if (CH.footer) CH.footer.thinking = level;
        renderChatFooter();
        postTeam({ action: "setThinkingLevel", level });
        fitComposerSelects();
      });
    }
    // Keep the model pill hugging its text when the window resizes.
    window.addEventListener("resize", () => fitComposerSelects());
    if (el.send) {
      el.send.addEventListener("click", sendPrompt);
    }
    if (el.listen) {
      el.listen.addEventListener("click", () => (CH.listening ? void finishListening() : void startListening()));
      renderSttButton();
    }
    if (el.steer) {
      el.steer.addEventListener("click", () => {
        CH.steer = !CH.steer;
        try { localStorage.setItem("scope-chat-steer", CH.steer ? "1" : "0"); } catch {}
        updateSteerToggle();
        setHint(CH.steer ? "Steer on — next message reaches pi mid-run" : "Steer off — next message queues until pi finishes", "");
      });
    }
    if (el.stop) {
      el.stop.addEventListener("click", () => {
        if (!CH.chatSessionId) return;
        setHint("stopping pi…", "busy");
        fetch(window.apiUrl("/chat/stop"), {
          method: "POST",
          headers: { ...window.authHeaders(), "content-type": "application/json" },
          body: JSON.stringify({ sessionId: CH.chatSessionId }),
        }).catch(() => { /* server unreachable — the stream will still settle */ });
      });
    }
    if (el.input) {
      el.input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          sendPrompt();
        }
      });
      el.input.addEventListener("input", () => autoGrow(el.input));
      el.input.addEventListener("compositionstart", () => { inputComposing = true; });
      el.input.addEventListener("compositionend", () => { inputComposing = false; });
    }
    // A native dialog (the delete/clear confirm) can drop focus onto <body>, or
    // return it to the composer with the caret desynced. When the window regains
    // focus on the Chat view, put the caret back in the composer so the user can
    // type immediately instead of clicking the box.
    window.addEventListener("focus", () => {
      if (!document.body.classList.contains("layout-chat") || !CH.workspace) return;
      const ae = document.activeElement;
      if (!ae || ae === document.body || ae === el.input) focusComposer();
    });

    CH.sessions = (state.sessions || []).filter(isChatSession);
    loadAgentTeam();
    renderWorkspaces();
    renderAgents();
    renderComposerModel();
    renderChat();
    updateToggleButtons();
    updateSteerToggle();
    attemptRestore();
    fetchChatFooter(true);
    // Elapsed / branch / go-usage keep ticking: re-render + refresh every 30s.
    // Skip both while the tab is hidden — nothing is visible to update.
    setInterval(() => {
      if (document.hidden) return;
      renderChatFooter();
      fetchChatFooter();
    }, 30000);
  }

  // Expose hooks for app.js
  window.__chatOnView = onView;
  window.__chatOnSessions = onSessions;
  // The app deletes sessions from outside Chat (Single view's Clear-all button
  // and per-row ✕); these let it hand the change to Chat for thread/subprocess
  // cleanup instead of leaving stale, streaming threads behind.
  window.__chatOnSessionDeleted = forgetChatSession;
  window.__chatOnSessionsCleared = forgetAllChatSessions;
  // TEMP DEBUG (removed before completion): inspect thread identity/aliasing.
  window.__chatDebug = () => ({
    curId: CH.curId,
    openSid: CH.openSid,
    chatSessionId: CH.chatSessionId,
    threads: [...CH.threads].map(([k, t]) => ({
      k,
      id: t.id,
      kind: t.kind,
      sid: t.sid,
      key: t.key,
      resumeFile: t.resumeFile,
      openSid: t.openSid,
      adopted: t.adopted,
      busy: t.busy,
      n: t.history.length,
      texts: t.history.map((m) => (m.text || "").slice(0, 20)),
    })),
  });
  // Exposed so the Settings page can re-arm the running pi chat session after a
  // team-setting change (settings toggles only affect a subprocess that boots
  // after the write, so an idle pre-spawn is killed and re-pre-spawned).
  window.__chatConfigChanged = rearmChatAfterConfigChange;

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
