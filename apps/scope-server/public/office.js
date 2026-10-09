/**
 * office.js — the "Office" view.
 *
 * A top-down office floor. The orchestrator runs the floor from its own corner
 * office at the top, with the **meeting room** to its right; beneath them the
 * **team rooms** sit in two columns either side of a center pathway (two rooms
 * left, two right, wrapping down the floor), plus an ad-hoc desk room for
 * agents that ran without a team. Every team in the roster keeps a room whether
 * or not it is the active one; **+ team** in the header creates a new one.
 * Every room is labelled at its top-left with its controls at its top-right:
 * the active team is badged, the others carry **activate** (which switches the
 * roster over to them), and each team has **+ hire** — it adds a subagent to
 * that team, with a display name, a model, and a fresh `agents/<name>.md` to
 * grow from. A subagent's own cubicle
 * carries its name at the top-left, and beneath it **off duty / on duty**
 * (enable or disable the subagent), **fire** (drop them from this team), **md**
 * (its whole `agents/*.md` definition — frontmatter and prompt — in a
 * full-screen editor) and **name** (its display name: the desk then reads "Bob"
 * with `file_reader` beside it). The **meeting room** holds the workspace's
 * reference library: files and folders the user added, injected as a reference
 * block at the start of every new conversation. Every agent gets its own cubicle —
 * partition walls on three sides, a desk with a screen, a chair — and sits in it
 * seen from above. Working agents have their screen scrolling code and their
 * arms typing; a chair pushed back is "waiting"; a cubicle whose agent is
 * switched off in the team roster is **Off duty** (empty desk, greyed out).
 *
 * Hovering a cubicle (or tabbing to it) opens a popup with that agent's recent
 * messages — the tool calls, results and assistant text it produced, newest
 * last, the way they would scroll past in a terminal. Live lines arrive from the
 * SSE stream the host fans out to the active view; the back-history comes from
 * `GET /sessions/<sid>/events` for the agent's own session.
 *
 * Data comes from the same sources the rest of the app uses:
 *   • `window.__SCOPE_STATE.sessions` — the session list, kept live by app.js's
 *     poll and its SSE patching (`last_turn_event`, `last_ts`, `has_shutdown`).
 *   • `GET /agent-team` — the roster and its teams, so agents that have not run
 *     yet still get a desk (and disabled ones still get a cubicle).
 *   • the live SSE events handed to the active view (`onEvent`) for instant
 *     labels and for the hover popup.
 *
 * Working / waiting / stopped uses the shared `SCOPE.subagentStatus()` rule —
 * the same green/orange/red the rails and status dots use — so the office can
 * never disagree with the rest of the UI.
 *
 * Registered as a built-in plugin from plugins-builtin.js; its manifest lives in
 * apps/scope-server/plugins/office/plugin.json.
 */
(function () {
  const S = window.SCOPE;
  if (!S) return;
  const esc = S.escapeHtml;
  const escAttr = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const lower = (s) => String(s || "").toLowerCase();

  /** How long a live "doing X" label stays on a desk without fresh activity. */
  const ACTIVITY_TTL_MS = 25_000;
  /** Status recompute cadence — the statuses themselves are time-based. */
  const TICK_MS = 1000;
  /** How long the walk-in animation runs before a pod settles. */
  const ARRIVE_MS = 900;
  /** Live message lines kept per agent (the popup shows the newest few). */
  const LOG_MAX = 40;
  /** Lines shown in the hover popup. */
  const POP_LINES = 7;
  /** Re-fetch an agent's session events at most this often. */
  const LOG_TTL_MS = 15_000;
  /** Re-fetch per-agent token/cost totals at most this often. */
  const STATS_TTL_MS = 10_000;

  let pane = null;
  let sceneEl = null;
  let planEl = null;
  let popEl = null;
  let countsEl = null;
  let emptyEl = null;
  let ticker = null;
  let team = null;          // latest /agent-team snapshot
  let teamCwd = null;       // cwd it was fetched for
  let teamAt = 0;
  let lastActivitySeen = 0;
  let renderSig = "";
  let popKey = null;        // agent whose popup is open
  let popAnchor = null;     // the cubicle the popup is anchored to
  let activating = null;    // team currently being switched active
  let pendingAgent = null;  // subagent whose roster change (fire/duty) is in flight
  const firedKeys = new Set(); // subagents fired this session — see floorPlan()
  let pendingTeam = null;   // team whose creation/removal is in flight
  let runnerPausedLocal = null; // optimistic Run/Pause state while its write is in flight
  let defByAgent = null;    // agent key -> agents/*.md definition (from /settings)
  let defsAt = 0;           // when the definitions were fetched
  let modelsMeta = null;    // provider registry (modelsMeta) from /settings
  let defaultModel = "";    // the app's default model = the orchestrator's own
  const activity = new Map(); // agent key -> { text, at }
  const logs = new Map();     // agent key -> [{ kind, text, at }]   (live, newest last)
  const fetched = new Map();  // agent key -> { sid, at, lines }     (from /events)
  const pods = new Map();     // agent key -> [elements] (a key can hold desks in several team rooms)
  const byKey = new Map();    // agent key -> agent (current render)
  const lastStatus = new Map();

  function state() { return window.__SCOPE_STATE || {}; }

  // ─── Roster ───────────────────────────────────────────────────────────────

  function sessions() {
    const list = state().sessions;
    return Array.isArray(list) ? list : [];
  }

  /** Most recently active session for an agent (undefined when none). */
  function sessionFor(key) {
    let best = null;
    let bestTs = -Infinity;
    for (const s of sessions()) {
      if (lower(s.agent_name) !== key) continue;
      const ts = Date.parse(s.last_ts) || 0;
      if (ts >= bestTs) { bestTs = ts; best = s; }
    }
    return best || undefined;
  }

  /**
   * The floor plan. The orchestrator always gets its own office at the top of
   * the plan (never a seat inside a team's room); the team rooms then follow in
   * the configured order (active team marked), laid out two-left / two-right of
   * the center pathway by CSS grid. Anything that ran without a team gets an
   * ad-hoc room. Every agent keeps a cubicle even before it runs — and even
   * when it is switched off, where it sits "on leave".
   */
  function floorPlan() {
    const td = team || {};
    const teams = td.teams || {};
    const order = Array.isArray(td.teamsOrder) && td.teamsOrder.length ? td.teamsOrder : Object.keys(teams);
    const disabled = new Set((td.disabledAgents || []).map(lower));
    const activeName = td.activeTeam && teams[td.activeTeam] ? td.activeTeam : order[0];
    const out = [];
    const inTeams = new Set(); // every agent that holds a team desk

    const agentFor = (name, model, displayName) => {
      const key = lower(name);
      if (!key || key === "memory-summarizer") return null;
      const session = sessionFor(key);
      return {
        key,
        name: String(name),
        // The label the desk shows — "file_reader is Bob". Optional and
        // per-team (it lives beside `model` in teams.yaml).
        displayName: String(displayName || ""),
        model: model || (session && session.model) || "",
        isOrch: key === "orchestrator",
        disabled: disabled.has(key),
        session,
      };
    };

    // The orchestrator runs the floor, so it never lands in a team room — it
    // gets the corner office above them instead.
    const orch = agentFor("orchestrator", "");

    // Every team in the roster keeps its room, active or not: a team whose
    // members all also sit in an earlier team's room still shows its own desks,
    // because an agent can hold a seat on more than one team.
    for (const t of order) {
      const members = teams[t];
      // An empty team still gets a room ("+ team" just created it); only a
      // roster entry that is not a member list at all is skipped.
      if (!Array.isArray(members)) continue;
      const room = {
        id: `team:${t}`,
        team: String(t),
        label: String(t),
        kind: "team",
        active: t === activeName,
        agents: [],
      };
      for (const m of members) {
        const a = agentFor(m && m.name, m && m.model, m && m.displayName);
        if (!a || a.isOrch) continue;
        inTeams.add(a.key);
        if (!room.agents.some((x) => x.key === a.key)) room.agents.push(a);
      }
      // A team with no subagents still gets its room: the header's "+ team"
      // creates an empty team, and the user needs to see it land on the floor.
      out.push(room);
    }

    // Anything else that has run (ad-hoc dispatches, projects without teams).
    // A subagent fired while this view is open stays off the floor: its past
    // sessions are still in the list, and without this filter the desk would
    // pop straight back up under "Ad-hoc desks" the moment it was fired.
    const loose = [];
    const seenLoose = new Set();
    const byAge = sessions().slice().sort((a, b) => (Date.parse(a.last_ts) || 0) - (Date.parse(b.last_ts) || 0));
    for (const s of byAge) {
      const a = agentFor(s.agent_name, s.model);
      if (!a || a.isOrch || inTeams.has(a.key) || seenLoose.has(a.key) || firedKeys.has(a.key)) continue;
      seenLoose.add(a.key);
      loose.push(a);
    }
    if (loose.length) {
      out.push({
        id: out.length ? "adhoc" : "main",
        label: out.length ? "Ad-hoc desks" : "Main floor",
        kind: "adhoc",
        active: out.length === 0,
        agents: loose,
      });
    }
    return { orch, rooms: out };
  }

  /** The project's reference library (Office → meeting room). */
  function libraryOf() {
    return team && Array.isArray(team.library) ? team.library : [];
  }

  /** A path as the library lists it: relative to the workspace when it is inside
   *  it, absolute otherwise (the injected block always uses the full path). */
  function shortPath(p) {
    const cwd = (state().cwd || "").replace(/\/+$/, "");
    return cwd && p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p;
  }

  /** A cheap signature of the plan, so a re-render only rebuilds on real change. */
  function sigOf(plan) {
    const orch = plan && plan.orch ? `orch:${plan.orch.key}` : "orch:-";
    // `!` marks an agent on leave, so hiring/firing a subagent rebuilds the plan
    // (its desk swaps the fire control for a hire one).
    const rooms = ((plan && plan.rooms) || [])
      .map((r) => `${r.id}:${r.active ? "1" : "0"}:${r.agents.map((a) => `${a.key}${a.disabled ? "!" : ""}${a.displayName ? `~${a.displayName}` : ""}`).join(",")}`).join("|");
    // The meeting room's library is drawn from the roster snapshot too, so it
    // has to be part of the signature for adds/removes to repaint.
    const lib = libraryOf().map((e) => `${e.id}:${e.path}:${e.note || ""}`).join(",");
    // The office's name and its board are drawn from the same snapshot, so a
    // rename or a moved task has to show up in the signature too.
    const tasks = tasksOf().map((t) => `${t.id}:${t.status}:${t.title}`).join(",");
    return `${orch}|${rooms}|lib:${lib}|name:${officeName()}|tasks:${tasks}`;
  }

  // ─── Status ───────────────────────────────────────────────────────────────

  function statusOf(agent) {
    if (agent.disabled) return "gray";
    const s = agent.session;
    if (!s) return "gray";
    return S.subagentStatus ? S.subagentStatus(s) : "gray";
  }

  const POD_CLASS = { green: "working", orange: "waiting", red: "stopped", gray: "idle" };

  /** The pod's state class — "leave" for an agent switched off in the roster. */
  function podClass(agent) {
    return agent.disabled ? "leave" : (POD_CLASS[statusOf(agent)] || "idle");
  }

  function statusLabel(agent) {
    if (agent.disabled) return "Off duty";
    switch (statusOf(agent)) {
      case "green": return "Working";
      case "orange": return "Waiting";
      case "red": return "Stopped";
      default: return "Idle";
    }
  }

  function activityOf(agent) {
    const live = activity.get(agent.key);
    if (live && Date.now() - live.at < ACTIVITY_TTL_MS) return live.text;
    if (agent.disabled) return "off duty";
    switch (statusOf(agent)) {
      case "green": return "working…";
      case "orange": return "waiting";
      case "red": return "offline";
      default: return "idle";
    }
  }

  // ─── Message lines (the cmdline view of an agent) ─────────────────────────

  /** Collapse to a single trimmed line, capped. */
  function oneLine(s, max = 150) {
    const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return t.length > max ? t.slice(0, max - 1) + "…" : t;
  }

  /** The most useful argument of a tool call, for the `$ tool <arg>` line. */
  const ARG_KEYS = ["command", "cmd", "path", "file_path", "file", "pattern", "query", "url", "prompt", "agent", "name", "message"];
  function argPreview(args) {
    if (!args || typeof args !== "object") return "";
    for (const k of ARG_KEYS) {
      const v = args[k];
      if (typeof v === "string" && v.trim()) return oneLine(v, 90);
      if (v != null && typeof v !== "object") return oneLine(String(v), 90);
    }
    const keys = Object.keys(args);
    if (!keys.length) return "";
    try { return oneLine(JSON.stringify(args), 90); } catch { return ""; }
  }

  /**
   * One cmdline-ish line for an event — the shape of what the agent saw or said,
   * or null for events with nothing to show (turn markers, timing, …).
   */
  function eventLine(evt) {
    const p = (evt && evt.payload) || {};
    switch (evt && evt.type) {
      case "tool_call": {
        const a = argPreview(p.args);
        return { kind: "cmd", text: `$ ${p.tool_name || "tool"}${a ? ` ${a}` : ""}` };
      }
      case "tool_result": {
        const bad = S.isToolResultError ? S.isToolResultError(p) : p.is_error === true;
        const out = oneLine(p.content_text, 110);
        return { kind: bad ? "err" : "ok", text: `${bad ? "✗" : "✓"} ${p.tool_name || "tool"}${out ? `  ${out}` : ""}` };
      }
      case "assistant_message": {
        const t = oneLine(p.text);
        return t ? { kind: "say", text: t } : null;
      }
      case "agent_end": {
        const t = oneLine(p.final_response);
        return t ? { kind: "say", text: t } : null;
      }
      case "user_message": {
        const t = oneLine(p.text);
        return t ? { kind: "user", text: t } : null;
      }
      case "thinking": {
        const t = oneLine(p.thinking || p.text);
        return t ? { kind: "think", text: t } : null;
      }
      default: return null;
    }
  }

  /** Short label for the tool an event belongs to. */
  function eventText(evt) {
    const p = evt && evt.payload ? evt.payload : {};
    switch (evt && evt.type) {
      case "tool_call": return p.tool_name ? `→ ${p.tool_name}` : "using a tool";
      case "tool_result": return p.tool_name ? `✓ ${p.tool_name}` : "tool done";
      case "thinking": return "thinking…";
      case "assistant_message": return "writing…";
      case "user_message": return "reading a prompt";
      case "llm_request": return "calling the model";
      case "turn_start": return "working…";
      case "turn_end": return "waiting";
      case "agent_start": return "on it";
      case "agent_end": return "done";
      case "session_shutdown": return "offline";
      default: return evt && evt.type ? String(evt.type).replace(/_/g, " ") : "";
    }
  }

  function noteActivity(evt) {
    const key = lower(evt && evt.agent_name);
    if (!key) return;
    const text = eventText(evt);
    if (!text) return;
    activity.set(key, { text, at: Date.now() });
    lastActivitySeen = Date.now();

    const line = eventLine(evt);
    if (line) {
      const arr = logs.get(key) || [];
      const prev = arr[arr.length - 1];
      if (!prev || prev.text !== line.text) arr.push({ kind: line.kind, text: line.text, at: evt.ts || new Date().toISOString() });
      if (arr.length > LOG_MAX) arr.splice(0, arr.length - LOG_MAX);
      logs.set(key, arr);
    }
  }

  /** Newest POP_LINES lines for an agent: fetched history plus live lines. */
  function popLinesFor(key) {
    const out = [];
    const push = (l) => {
      if (!l || !l.text) return;
      const prev = out[out.length - 1];
      if (prev && prev.text === l.text) return;
      out.push(l);
    };
    for (const l of ((fetched.get(key) || {}).lines || [])) push(l);
    for (const l of (logs.get(key) || [])) push(l);
    return out.slice(-POP_LINES);
  }

  /** Back-history for one hover: the agent's own session events. */
  async function loadMessages(agent) {
    const key = agent.key;
    const sid = agent.session && agent.session.session_id;
    if (!sid) {
      if (!fetched.has(key)) fetched.set(key, { sid: "", at: Date.now(), lines: [] });
      return;
    }
    const cur = fetched.get(key);
    if (cur && cur.sid === sid && Date.now() - cur.at < LOG_TTL_MS) return;
    try {
      const { res, data } = await S.api(`/sessions/${encodeURIComponent(sid)}/events`, { limit: 60 });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const lines = (data && Array.isArray(data.events) ? data.events : []).map(eventLine).filter(Boolean);
      fetched.set(key, { sid, at: Date.now(), lines: lines.slice(-LOG_MAX) });
    } catch {
      // Keep the live lines we have and let the next hover retry.
      if (!cur) fetched.set(key, { sid, at: 0, lines: [] });
    }
  }

  // ─── Popup ────────────────────────────────────────────────────────────────

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(v, hi)); }

  function renderPop() {
    if (!popEl || !popKey) return;
    const agent = byKey.get(popKey);
    if (!agent) { hidePop(); return; }
    const lines = popLinesFor(popKey);
    const dot = agent.disabled ? "gray" : statusOf(agent);
    popEl.innerHTML =
      `<div class="office-pop-head">` +
        `<span class="status-dot ${dot}"></span>` +
        `<span class="office-pop-name">${esc(agent.name)}</span>` +
        `<span class="office-pop-role">${agent.isOrch ? "orchestrator" : "subagent"}</span>` +
      `</div>` +
      `<div class="office-pop-meta">${esc(statusLabel(agent))}${agent.model ? ` · ${esc(agent.model)}` : ""}` +
        (agent.session ? ` · ${esc(String(agent.session.event_count ?? 0))} events` : " · no session yet") +
      `</div>` +
      (lines.length
        ? `<div class="office-pop-log">` + lines.map((l) =>
            `<div class="office-pop-line ${escAttr(l.kind)}">` +
              `<span class="office-pop-time">${esc(S.fmtRel ? S.fmtRel(l.at) : "")}</span>` +
              `<span class="office-pop-text">${esc(l.text)}</span>` +
            `</div>`).join("") + `</div>`
        : `<div class="office-pop-empty">${agent.disabled ? "Off duty — no activity." : "No messages yet."}</div>`);
  }

  function placePop() {
    const list = popKey ? pods.get(popKey) : null;
    const pod = (popAnchor && popAnchor.isConnected ? popAnchor : list && list[0]) || null;
    if (!pod || !popEl || !sceneEl || popEl.hidden) return;
    const pb = pod.getBoundingClientRect();
    const sb = sceneEl.getBoundingClientRect();
    const w = popEl.offsetWidth;
    const h = popEl.offsetHeight;
    // `popEl` is absolutely positioned inside the scrolling scene, so convert
    // the pod's viewport rect back into the scene's content coordinates.
    const relX = pb.left - sb.left + sceneEl.scrollLeft;
    const relY = pb.top - sb.top + sceneEl.scrollTop;
    const left = clamp(relX + pb.width / 2 - w / 2, 8, Math.max(8, sceneEl.scrollWidth - w - 8));
    let top = relY + pb.height + 8;
    const visibleBottom = sceneEl.scrollTop + sceneEl.clientHeight - 8;
    if (top + h > visibleBottom) {
      const above = relY - h - 6;
      top = above >= sceneEl.scrollTop + 6 ? above : Math.max(sceneEl.scrollTop + 6, visibleBottom - h);
    }
    popEl.style.left = `${Math.round(left)}px`;
    popEl.style.top = `${Math.round(Math.max(6, top))}px`;
  }

  function showPop(key, anchor) {
    if (!popEl || !key || !byKey.has(key)) return;
    popKey = key;
    popAnchor = anchor || (pods.get(key) || [])[0] || null;
    popEl.hidden = false;
    renderPop();
    placePop();
    const agent = byKey.get(key);
    void loadMessages(agent).then(() => {
      if (popKey === key) { renderPop(); placePop(); }
    });
  }

  function hidePop() {
    popKey = null;
    popAnchor = null;
    if (popEl) { popEl.hidden = true; popEl.innerHTML = ""; }
  }

  // ─── Rendering ────────────────────────────────────────────────────────────

  /** Deterministic shirt hue per agent so desks read apart at a glance. */
  function hueFor(key) {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
    return Math.abs(h) % 360;
  }

  /**
   * The agent seen from above: shoulders, a head, and two arms reaching onto
   * the keyboard. `--office-hue` gives each agent a stable shirt colour.
   */
  function personHtml(agent) {
    return (
      `<div class="office-person" style="--office-hue:${hueFor(agent.key)}" aria-hidden="true">` +
        `<span class="office-shoulders"></span>` +
        `<span class="office-head"></span>` +
        `<span class="office-arm office-arm-l"></span>` +
        `<span class="office-arm office-arm-r"></span>` +
      `</div>`
    );
  }

  /**
   * One cubicle, viewed from above: partition walls on three sides (open toward
   * the corridor below), a desk with a screen and a keyboard along it, a chair,
   * and the agent seated in the middle of it. The screen holds the code lines
   * that animate while the agent works.
   */
  function podHtml(agent, room) {
    const st = statusOf(agent);
    const cls = podClass(agent);
    const role = agent.isOrch ? "Orchestrator" : "Subagent";
    const shown = agent.displayName || agent.name;
    // Only a team member can be fired / renamed; the orchestrator's office and
    // the ad-hoc desks have no roster row behind them.
    const team = room && room.kind === "team" ? room.team : "";
    const title = `${shown} · ${role}${agent.model ? ` · ${agent.model}` : ""} — ${activityOf(agent)}`;
    return (
      `<div class="office-pod ${cls}${agent.isOrch ? " orch" : ""}" data-key="${escAttr(agent.key)}"` +
        (team ? ` data-team="${escAttr(team)}"` : "") +
        ` tabindex="0" role="group" aria-label="${escAttr(`${shown}, ${role}, ${statusLabel(agent)}`)}" title="${escAttr(title)}">` +
        // The cubicle's header: the name at its top-left, then the desk's own
        // controls (off duty / fire / md) directly beneath it.
        `<div class="office-pod-head">` +
          `<div class="office-plate">` +
            `<span class="status-dot ${st}"></span>` +
            `<span class="office-name">${esc(shown)}</span>` +
            (agent.displayName ? `<span class="office-realname" title="real name">${esc(agent.name)}</span>` : "") +
            `<span class="office-crown" title="Orchestrator">★</span>` +
            `<span class="office-leave-tag">Off duty</span>` +
          `</div>` +
          (team ? podActionsHtml(agent, team) : "") +
          `<div class="office-bubble"></div>` +
          `<div class="office-stats"></div>` +
          // The orchestrator runs the floor, so it owns its model: a picker on
          // its desk rather than a name in a team file.
          (agent.isOrch ? orchModelHtml() : "") +
        `</div>` +
        `<div class="office-station">` +
          `<div class="office-chair"></div>` +
          `<div class="office-desk">` +
            `<span class="office-monitor">` +
              `<span class="office-code"><i></i><i></i><i></i></span>` +
            `</span>` +
            `<span class="office-keyboard"></span>` +
            `<span class="office-mug"></span>` +
          `</div>` +
          personHtml(agent) +
        `</div>` +
      `</div>`
    );
  }

  /**
   * A team desk's controls, at the top-left of the cubicle under its name:
   * **off duty / on duty** (enable or disable the subagent), **fire** (drop them
   * from this team), **name** (its display name) and **md** (its `agents/*.md`
   * definition).
   */
  function podActionsHtml(agent, team) {
    const shown = escAttr(agent.displayName || agent.name);
    const dutyTitle = agent.disabled
      ? `Bring ${shown} on duty — enable this subagent`
      : `Take ${shown} off duty — disable this subagent`;
    return (
      `<div class="office-pod-actions">` +
        `<button class="office-act duty${agent.disabled ? " off" : ""}" type="button" data-act="duty" ` +
          `data-agent="${escAttr(agent.key)}" title="${dutyTitle}">${agent.disabled ? "on duty" : "off duty"}</button>` +
        `<button class="office-act office-fire" type="button" data-act="fire" data-agent="${escAttr(agent.key)}" ` +
          `data-team="${escAttr(team)}" title="Fire ${shown} — remove them from ${escAttr(team)}">fire</button>` +
        `<button class="office-act md" type="button" data-act="md" data-agent="${escAttr(agent.key)}" ` +
          `title="Edit ${shown}'s markdown definition (agents/*.md)">md</button>` +
        `<button class="office-act rename" type="button" data-act="rename" data-agent="${escAttr(agent.key)}" ` +
          `data-team="${escAttr(team)}" title="Set ${shown}'s display name">name</button>` +
      `</div>`
    );
  }

  /**
   * One team (or ad-hoc) room. Every team in the roster is drawn whether or not
   * it is active; an inactive team gets an Activate control that switches the
   * roster over to it (the active one is badged instead).
   */
  function roomHtml(room) {
    const isTeam = room.kind === "team" && !!room.team;
    const busy = activating === room.team;
    // The room's header row: the team's name at its top-left, the team actions
    // (activate / hire) at its top-right.
    const control = !isTeam ? ""
      : room.active
        ? `<span class="office-room-active" title="${escAttr(room.label)} is the active team">✓ active</span>`
        : `<button class="office-room-pick" type="button" data-team="${escAttr(room.team)}"` +
          (busy ? ` disabled` : ``) +
          ` title="Make ${escAttr(room.label)} the active team">${busy ? "activating…" : "activate"}</button>`;
    // Hiring is a room-level action: it adds a member to *this* team (with an
    // optional agents/<name>.md and model).
    const hire = !isTeam ? ""
      : `<button class="office-hire" type="button" data-team="${escAttr(room.team)}" ` +
        `title="Hire a subagent into ${escAttr(room.label)}">+ hire</button>`;
    return (
      `<section class="office-room${room.active ? " active" : ""}" data-room="${escAttr(room.id)}">` +
        `<div class="office-room-head">` +
          `<span class="office-room-name">${esc(room.label)}</span>` +
          `<span class="office-room-meta">${room.agents.length} desk${room.agents.length === 1 ? "" : "s"}</span>` +
          `<span class="office-room-spacer"></span>` +
          control +
          hire +
        `</div>` +
        `<div class="office-room-floor">${room.agents.map((a) => podHtml(a, room)).join("")}</div>` +
      `</section>`
    );
  }

  /**
   * The orchestrator's own office: a single desk at the top-left of the plan,
   * styled as the corner office rather than a team room.
   */
  function orchRoomHtml(agent) {
    if (!agent) return "";
    return (
      `<section class="office-room orch-room" data-room="orchestrator">` +
        `<div class="office-room-head">` +
          `<span class="office-room-name">Orchestrator</span>` +
          `<span class="office-room-meta">runs the floor</span>` +
          `<span class="office-room-spacer"></span>` +
          // Team management lives with the orchestrator: it runs the floor, so
          // adding and removing teams is its own control here.
          `<button class="office-teams-btn" id="office-teams-open" type="button" ` +
            `title="Add or remove teams on this floor">teams</button>` +
        `</div>` +
        `<div class="office-room-floor">${podHtml(agent)}</div>` +
      `</section>`
    );
  }

  // ─── The office's name, and its task board ────────────────────────────────

  /** What the office is called ("Office" until the user names it). */
  function officeName() {
    const name = team && team.officeName ? String(team.officeName).trim() : "";
    return name || "Office";
  }

  /** The office's tasks. */
  function tasksOf() {
    return team && Array.isArray(team.tasks) ? team.tasks.slice() : [];
  }

  const TASK_COLUMNS = [
    { id: "todo", label: "Todo" },
    { id: "planned", label: "Planned" },
    { id: "in_progress", label: "In Progress" },
    { id: "done", label: "Done" },
  ];

  /** Is the queue runner paused? Paused is the default — a task waits in Planned
   *  until the user presses Run. An absent field on an older config reads paused. */
  function runnerPaused() {
    if (runnerPausedLocal !== null) return runnerPausedLocal;
    return !(team && team.runnerPaused === false);
  }

  /** Tasks in one column, in queue order (Planned is worked FIFO). */
  function tasksIn(status) {
    return tasksOf()
      .filter((t) => (t.status || "todo") === status)
      .sort((a, b) => (status === "planned"
        ? (a.plannedAt || a.createdAt || 0) - (b.plannedAt || b.createdAt || 0)
        : (a.createdAt || 0) - (b.createdAt || 0)));
  }

  /** The task the orchestrator is on right now, if any. */
  function currentTask() {
    return tasksIn("in_progress")[0] || null;
  }

  // ─── The orchestrator's model ─────────────────────────────────────────────
  // The orchestrator is the app's own agent: the model it runs on is the
  // settings.json default model (the same one a new chat session starts on, and
  // the one Settings calls "Default model"). The floor shows it as a picker on
  // the corner office, and hands it to every task the queue dispatches.

  /** The model the orchestrator runs on — the freshest value we have. */
  function orchModel() {
    return String(defaultModel || (team && team.defaultModel) || "");
  }

  /** Remember the default model from any roster / settings payload that carries
   *  one, so the picker never lags behind a write. */
  function noteDefaults(data) {
    if (data && typeof data.defaultModel === "string") defaultModel = data.defaultModel;
  }

  /**
   * The orchestrator's model picker. Every model the app knows, grouped one
   * `<optgroup>` per provider — the same list the subagent pickers use (see
   * modelOptionsHtml) — with the current default selected.
   */
  function orchModelHtml() {
    return (
      `<label class="office-model-row" title="The model the orchestrator runs on — the app's default model (Settings → Default model)">` +
        `<span class="office-model-label">model</span>` +
        `<select class="office-orch-model" id="office-orch-model" aria-label="The orchestrator's model">` +
          modelOptionsHtml(orchModel()) +
        `</select>` +
      `</label>`
    );
  }

  let modelBusy = false;

  /** Set the orchestrator's model (settings.json `defaultModel`). */
  async function setOrchestratorModel(model) {
    if (!model || modelBusy) return;
    modelBusy = true;
    try {
      const { res, data } = await S.api("/settings", {}, { action: "setDefaultModel", value: model, cwd: state().cwd || "" });
      if (!res.ok || !data) throw new Error(data && data.error ? data.error : `HTTP ${res.status}`);
      noteDefaults(data);
      defaultModel = model;   // the write is the truth from here on
      if (S.toast) S.toast(`The orchestrator now runs on ${model}`);
      void refreshTeam(true); // resync the roster (it carries the default model)
    } catch (err) {
      if (S.toast) S.toast(`Could not set the model: ${errMsg(err)}`, "err");
      render();               // put the picker back where the settings are
    } finally {
      modelBusy = false;
    }
  }

  /** The wall's compact board: a column per status with its count, and what the
   *  orchestrator is on. Clicking it opens the full-screen board. */
  function kanbanMiniHtml() {
    const running = currentTask();
    const queued = tasksIn("planned").length;
    return (
      `<button class="office-kanban-mini" id="office-board-open" type="button" ` +
        `title="Open the task board — Todo → Planned → In Progress → Done" aria-label="Open the task board">` +
        `<span class="office-kanban-head">Kanban</span>` +
        `<span class="office-kanban-state ${runnerPaused() ? "paused" : "running"}">${runnerPaused() ? "⏸ paused" : "▶ running"}</span>` +
        `<span class="office-kanban-cols">` +
          TASK_COLUMNS.map((c) =>
            `<span class="office-kmini-col ${c.id}">${esc(c.label)}<b>${tasksIn(c.id).length}</b></span>`).join("") +
        `</span>` +
        `<span class="office-kanban-now">${running ? esc(oneLine(running.title, 34)) : queued ? "queue ready" : "idle"}</span>` +
      `</button>`
    );
  }

  /** One task row on the full-screen board: its text, and what can happen next. */
  function kanbanRowHtml(task, status) {
    const idx = TASK_COLUMNS.findIndex((c) => c.id === status);
    const back = idx > 0 ? TASK_COLUMNS[idx - 1] : null;
    const fwd = idx < TASK_COLUMNS.length - 1 ? TASK_COLUMNS[idx + 1] : null;
    return (
      `<div class="office-task" data-id="${escAttr(task.id)}">` +
        `<span class="office-task-title" title="${escAttr(task.title)}">${esc(task.title)}</span>` +
        (task.note ? `<span class="office-task-note" title="${escAttr(task.note)}">${esc(task.note)}</span>` : "") +
        `<span class="office-task-acts">` +
          (back ? `<button class="office-task-move" type="button" data-move="${escAttr(back.id)}" data-id="${escAttr(task.id)}" ` +
            `title="Move back to ${escAttr(back.label)}">‹</button>` : "") +
          (fwd ? `<button class="office-task-move" type="button" data-move="${escAttr(fwd.id)}" data-id="${escAttr(task.id)}" ` +
            `title="Move to ${escAttr(fwd.label)}">›</button>` : "") +
          `<button class="office-task-del" type="button" data-del="${escAttr(task.id)}" title="Delete this task">×</button>` +
        `</span>` +
      `</div>`
    );
  }

  /** The board's four columns. Todo carries the New-task button; the task
   *  itself is written in the roomy popup editor (openTaskDialog). */
  function kanbanColumnsHtml() {
    return TASK_COLUMNS.map((c) => {
      const list = tasksIn(c.id);
      return (
        `<div class="office-kcol ${c.id}">` +
          `<div class="office-kcol-head"><span>${esc(c.label)}</span><b>${list.length}</b></div>` +
          `<div class="office-kcol-body">` +
            (list.length ? list.map((t) => kanbanRowHtml(t, c.id)).join("") : `<div class="office-kcol-empty">—</div>`) +
          `</div>` +
          (c.id === "todo"
            ? `<div class="office-kadd">` +
                `<button class="btn-sm office-task-new" id="office-task-new" type="button" ` +
                  `title="Write a new task">＋ New task</button>` +
              `</div>`
            : "") +
        `</div>`
      );
    }).join("");
  }

  /**
   * The New-task popup: a roomy editor for the task's title and the brief the
   * orchestrator works from. The board's tiny inline form was replaced by this,
   * so a task is written where there is room to write it.
   */
  function openTaskDialog() {
    openDialog({
      title: "New task",
      hint: "lands in Todo — move it to Planned when it is ready to run",
      wide: true,
      body:
        dialogField("Task", "what should be done",
          `<input class="office-input" id="office-task-title" type="text" maxlength="200" spellcheck="false" ` +
          `autocomplete="off" placeholder="e.g. Draft the migration plan">`) +
        dialogField("Brief", "the details the orchestrator works from (optional)",
          `<textarea class="office-textarea office-task-brief" id="office-task-note" spellcheck="false" ` +
          `placeholder="Context, constraints, acceptance criteria…"></textarea>`),
      submitLabel: "Add task",
      onSubmit: async (root) => {
        const titleEl = root.querySelector("#office-task-title");
        const title = String((titleEl && titleEl.value) || "").trim();
        const note = String((root.querySelector("#office-task-note") || {}).value || "").trim();
        if (!title) {
          if (titleEl) titleEl.focus();
          if (S.toast) S.toast("Give the task a title", "warn");
          return false;
        }
        try {
          await teamPost({ action: "addTask", title, note }, `Task added: ${title}`);
          return true;
        } catch (err) {
          if (S.toast) S.toast(`Could not add the task: ${errMsg(err)}`, "err");
          return false;
        }
      },
    });
  }

  /**
   * The meeting room's reference library, drawn as a shelf of books. It is one
   * button: clicking it opens the full-screen manager where references are
   * added, assigned to an agent, renamed or removed.
   */
  function libraryHtml() {
    const n = libraryOf().length;
    return (
      `<button class="office-library" id="office-library-open" type="button" ` +
        `title="Reference library — ${n} reference${n === 1 ? "" : "s"}" aria-label="Open the reference library">` +
        `<svg class="office-lib-svg" viewBox="0 0 120 92" role="img" aria-hidden="true" focusable="false">` +
          `<rect class="lib-case" x="3" y="4" width="114" height="84" rx="6"/>` +
          `<rect class="lib-inner" x="9" y="10" width="102" height="72" rx="3"/>` +
          `<rect class="lib-board" x="9" y="44" width="102" height="4"/>` +
          `<rect class="lib-board" x="9" y="74" width="102" height="4"/>` +
          `<rect class="lib-book b1" x="16" y="14" width="9" height="30" rx="1.5"/>` +
          `<rect class="lib-book b2" x="27" y="18" width="12" height="26" rx="1.5"/>` +
          `<rect class="lib-book b3" x="41" y="14" width="8" height="30" rx="1.5"/>` +
          `<rect class="lib-book b4" x="51" y="20" width="11" height="24" rx="1.5"/>` +
          `<rect class="lib-book b5" x="79" y="16" width="9" height="28" rx="1.5"/>` +
          `<rect class="lib-book b2" x="90" y="22" width="12" height="22" rx="1.5"/>` +
          `<rect class="lib-book b3" x="16" y="50" width="11" height="24" rx="1.5"/>` +
          `<rect class="lib-book b5" x="29" y="52" width="8" height="22" rx="1.5"/>` +
          `<rect class="lib-book b1" x="39" y="50" width="12" height="24" rx="1.5"/>` +
          `<rect class="lib-book b4" x="53" y="56" width="9" height="18" rx="1.5"/>` +
          `<rect class="lib-book b1" x="79" y="52" width="10" height="22" rx="1.5"/>` +
          `<rect class="lib-book b5" x="91" y="50" width="11" height="24" rx="1.5"/>` +
        `</svg>` +
        `<span class="office-library-badge">${n}</span>` +
        `<span class="office-library-label">Library</span>` +
      `</button>`
    );
  }

  /** The meeting room: a round table with four seats, and the reference library. */
  function meetingRoomHtml() {
    return (
      `<section class="office-room meeting" data-room="meeting">` +
        `<div class="office-room-head">` +
          `<span class="office-room-name">Meeting</span>` +
          `<span class="office-room-meta">all hands</span>` +
        `</div>` +
        `<div class="office-room-floor office-meeting-floor">` +
          `<div class="office-meeting-set">` +
            `<span class="office-plant office-meeting-plant" aria-hidden="true"></span>` +
            `<div class="office-roundtable" aria-hidden="true">` +
              `<span class="office-seat n"></span><span class="office-seat s"></span>` +
              `<span class="office-seat e"></span><span class="office-seat w"></span>` +
            `</div>` +
          `</div>` +
          libraryHtml() +
        `</div>` +
      `</section>`
    );
  }

  function buildPlan(plan, agents) {
    if (!planEl) return;
    // Order matters: the orchestrator's office is the top-left cell and the
    // meeting room the cell beside it, so the team rooms auto-flow beneath them
    // two-per-row, either side of the center pathway (see styles.css).
    planEl.innerHTML = [orchRoomHtml(plan.orch), meetingRoomHtml(), ...plan.rooms.map(roomHtml)].join("");
    pods.clear();
    // An agent can hold a desk in more than one team room, so collect every pod
    // per key; status and label updates then fan out to all of them.
    for (const el of planEl.querySelectorAll(".office-pod")) {
      const arr = pods.get(el.dataset.key);
      if (arr) arr.push(el); else pods.set(el.dataset.key, [el]);
    }
    renderSig = sigOf(plan);
    lastStatus.clear();
    for (const a of agents) lastStatus.set(a.key, statusOf(a));
  }

  function updatePod(agent) {
    const els = pods.get(agent.key);
    if (!els || !els.length) return;
    const st = statusOf(agent);
    const cls = podClass(agent);
    const prev = lastStatus.get(agent.key);
    lastStatus.set(agent.key, st);
    const role = agent.isOrch ? "Orchestrator" : "Subagent";
    const text = activityOf(agent);
    // The desk is labelled with the display name; the real name still rides in
    // the tooltip beside it, so "file_reader is Bob" stays discoverable.
    const shown = agent.displayName || agent.name;
    const title = `${shown}${agent.displayName ? ` (${agent.name})` : ""} · ${role}${agent.model ? ` · ${agent.model}` : ""} — ${text}`;

    // The same agent can hold desks in several team rooms; keep them all in sync.
    for (const el of els) {
      el.classList.remove("working", "waiting", "stopped", "idle", "leave");
      el.classList.add(cls);
      if (prev && prev !== "green" && st === "green" && !agent.disabled) {
        // Just got to work — play the walk-in once, then let it settle.
        el.classList.add("arriving");
        setTimeout(() => el.classList.remove("arriving"), ARRIVE_MS);
      }

      const dot = el.querySelector(".status-dot");
      if (dot) dot.className = `status-dot ${st}`;
      const bubble = el.querySelector(".office-bubble");
      if (bubble && bubble.textContent !== text) bubble.textContent = text;
      const statsEl = el.querySelector(".office-stats");
      if (statsEl) {
        const line = statsLine(agent.session);
        if (statsEl.textContent !== line) {
          statsEl.textContent = line;
          statsEl.hidden = !line;
        }
      }
      // The orchestrator's picker follows the settings: rebuild its options when
      // the registry or the default changes, and snap the selection back if a
      // write did not land.
      const pick = el.querySelector(".office-orch-model");
      if (pick) {
        const opts = modelOptionsHtml(orchModel());
        if (pick.dataset.options !== opts) { pick.innerHTML = opts; pick.dataset.options = opts; }
        const now = orchModel();
        if (pick.value !== now && [...pick.options].some((o) => o.value === now)) pick.value = now;
      }
      if (el.getAttribute("title") !== title) el.setAttribute("title", title);
    }
  }

  function renderCounts(agents) {
    if (!countsEl) return;
    const live = agents.filter((a) => !a.disabled);
    const of = (s) => live.filter((a) => statusOf(a) === s).length;
    const leave = agents.length - live.length;
    countsEl.innerHTML =
      `<span class="office-count working"><span class="status-dot green"></span>${of("green")} working</span>` +
      `<span class="office-count"><span class="status-dot orange"></span>${of("orange")} waiting</span>` +
      `<span class="office-count"><span class="status-dot red"></span>${of("red")} stopped</span>` +
      `<span class="office-count"><span class="status-dot gray"></span>${of("gray")} idle</span>` +
      (leave ? `<span class="office-count leave"><span class="status-dot gray"></span>${leave} off duty</span>` : "");
  }

  function render() {
    if (!pane || !planEl) return;
    let plan = { orch: null, rooms: [] };
    try { plan = floorPlan(); } catch { plan = { orch: null, rooms: [] }; }
    const agents = [];
    if (plan.orch) agents.push(plan.orch);
    for (const r of plan.rooms) for (const a of r.agents) agents.push(a);
    // An agent can hold desks in several team rooms — count and refresh it once.
    const unique = new Map();
    for (const a of agents) if (!unique.has(a.key)) unique.set(a.key, a);
    byKey.clear();
    for (const [k, a] of unique) byKey.set(k, a);

    const sig = sigOf(plan);
    if (sig !== renderSig) buildPlan(plan, agents);

    const live = [...unique.values()];
    for (const a of live) updatePod(a);
    renderCounts(live);

    // The header's title follows the roster snapshot.
    const nameEl = pane.querySelector("#office-name");
    if (nameEl && nameEl.textContent !== officeName()) nameEl.textContent = officeName();

    // So does the wall's sign, whose counts are the board's own. The click is
    // delegated on the pane, so replacing the button keeps it working.
    const signHost = pane.querySelector("#office-board-host");
    if (signHost) {
      const html = kanbanMiniHtml();
      if (signHost.innerHTML !== html) signHost.innerHTML = html;
    }

    // Keep the desks' token/cost totals fresh, and keep the queue moving: a task
    // in Planned belongs to the orchestrator, and nothing else picks it up.
    void refreshStats(false);
    void pumpTasks();

    if (emptyEl) emptyEl.hidden = live.some((a) => a.session) || live.length > 1;

    // Keep an open popup in sync with the live stream (and let go of a desk
    // that left the roster).
    if (popKey) {
      if (byKey.has(popKey)) { renderPop(); placePop(); }
      else hidePop();
    }
  }

  // ─── Data ─────────────────────────────────────────────────────────────────

  /**
   * Switch the active team to `name` — the same POST /agent-team the Agent-Team
   * rail and Settings use — then re-render so the highlight and the Activate
   * controls move over to the new team.
   */
  async function activateTeam(name, btn) {
    if (!name || activating) return;
    activating = name;
    if (btn) { btn.disabled = true; btn.textContent = "activating…"; }
    let ok = false;
    try {
      const { res, data } = await S.api("/agent-team", {}, { action: "setTeam", team: name, cwd: state().cwd || "" });
      if (res.ok && data) { team = data; teamCwd = state().cwd || ""; teamAt = Date.now(); ok = true; }
      else throw new Error(data && data.error ? data.error : `HTTP ${res.status}`);
    } catch (err) {
      if (S.toast) S.toast(`Could not activate ${name}: ${err && err.message ? err.message : err}`, "err");
    } finally {
      activating = null;
      if (ok) render(); // the active flag changed, so the plan rebuilds
      else if (btn) { btn.disabled = false; btn.textContent = "activate"; }
    }
  }

  function errMsg(err) { return err && err.message ? err.message : String(err); }

  /** What a desk calls an agent: its display name, else its real name. */
  function shownName(key, fallback) {
    const agent = byKey.get(key);
    if (!agent) return fallback || key;
    return agent.displayName || agent.name;
  }

  /** Put a subagent on or off duty (enable / disable) — toggleAgent. */
  async function setAgentActive(name, disabled, btn) {
    if (!name || pendingAgent) return;
    const shown = shownName(name);
    pendingAgent = name;
    if (btn) btn.disabled = true;
    let ok = false;
    try {
      const { res, data } = await S.api("/agent-team", {}, { action: "toggleAgent", agent: name, disabled, cwd: state().cwd || "" });
      if (res.ok && data) { team = data; teamCwd = state().cwd || ""; teamAt = Date.now(); ok = true; }
      else throw new Error(data && data.error ? data.error : `HTTP ${res.status}`);
    } catch (err) {
      if (S.toast) S.toast(`Could not take ${shown} ${disabled ? "off" : "on"} duty: ${errMsg(err)}`, "err");
    } finally {
      pendingAgent = null;
      if (ok) {
        if (S.toast) S.toast(`${shown} is ${disabled ? "off" : "on"} duty`);
        render(); // the roster changed, so the desk swaps its on/off-duty control
      } else if (btn) {
        btn.disabled = false;
      }
    }
  }

  /** The on/off-duty control just flips the subagent's current state. */
  function toggleDuty(name, btn) {
    const agent = byKey.get(name);
    if (agent) void setAgentActive(name, !agent.disabled, btn);
  }

  /**
   * Fire a subagent: drop them from this team. The agent definition and the
   * enable/disable flag are left alone — hiring them back is one click.
   */
  async function fireMember(teamName, name, btn) {
    if (!teamName || !name || pendingAgent) return;
    const shown = shownName(name);
    pendingAgent = name;
    if (btn) btn.disabled = true;
    try {
      const { res, data } = await S.api("/agent-team", {}, { action: "removeMember", team: teamName, name, cwd: state().cwd || "" });
      if (!res.ok || !data) throw new Error(data && data.error ? data.error : `HTTP ${res.status}`);
      team = data; teamCwd = state().cwd || ""; teamAt = Date.now();
      firedKeys.add(lower(name));
      if (S.toast) S.toast(`${shown} fired from ${teamName}`);
      hidePop();
      render();
    } catch (err) {
      if (S.toast) S.toast(`Could not fire ${shown}: ${errMsg(err)}`, "err");
      if (btn) btn.disabled = false;
    } finally {
      pendingAgent = null;
    }
  }

  /**
   * Hire: add a subagent to a team, optionally giving it a display name, a
   * model, and a fresh `agents/<name>.md` definition to grow from.
   */
  async function hireMember(teamName) {
    if (!teamName) return;
    // The model registry (if it is not cached yet) so the picker can offer every
    // provider's models, not just the ones enabled in pi settings.
    await refreshDefs(false);
    openDialog({
      title: `Hire into ${teamName}`,
      hint: "add a subagent to this team · its agents/<name>.md gets a Reference files template",
      // The hire form carries four fields plus the definition's body, so it gets
      // the roomy layout — short fields two to a row, the body full width.
      wide: true,
      body:
        `<div class="office-hire-grid">` +
          dialogField("Name", "the real id, e.g. file_reader",
            `<input class="office-input" id="office-hire-name" maxlength="64" placeholder="file_reader" ` +
            `spellcheck="false" autocomplete="off">`) +
          dialogField("Display name", "optional — what the desk shows",
            `<input class="office-input" id="office-hire-display" maxlength="64" placeholder="Bob" ` +
            `spellcheck="false" autocomplete="off">`) +
          dialogField("Model", "optional — every provider's models",
            `<select class="office-input" id="office-hire-model">` +
              `<option value="">team default</option>` +
              modelOptionsHtml("") +
            `</select>`) +
          `<label class="office-check office-hire-md">` +
            `<input type="checkbox" id="office-hire-md" checked> create <code>agents/&lt;name&gt;.md</code>` +
          `</label>` +
        `</div>` +
        dialogField("Definition", "becomes the prompt body of agents/<name>.md",
          `<textarea class="office-textarea" id="office-hire-prompt" rows="7" spellcheck="false" ` +
            `placeholder="What this subagent is for — the prompt it starts from."></textarea>`),
      submitLabel: "Hire",
      // The Definition field starts from the template and follows the name while
      // it is untouched, so the common case needs no typing at all.
      onMount: (root) => {
        const ta = root.querySelector("#office-hire-prompt");
        const nameEl = root.querySelector("#office-hire-name");
        const displayEl = root.querySelector("#office-hire-display");
        let auto = agentPromptTemplate("", "");
        ta.value = auto;
        const sync = () => {
          const next = agentPromptTemplate(nameEl.value, displayEl.value);
          if (ta.value === auto) ta.value = next;
          auto = next;
        };
        nameEl.addEventListener("input", sync);
        displayEl.addEventListener("input", sync);
      },
      onSubmit: async (root) => {
        const q = (sel) => root.querySelector(sel);
        const name = String((q("#office-hire-name") || {}).value || "").trim();
        const displayName = String((q("#office-hire-display") || {}).value || "").trim();
        const model = String((q("#office-hire-model") || {}).value || "").trim();
        const createMd = !!(q("#office-hire-md") || {}).checked;
        // An untouched Definition still becomes the file's body — it just means
        // "start from the template".
        const prompt = String((q("#office-hire-prompt") || {}).value || "");
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
          if (S.toast) S.toast("Subagent names may use letters, digits, '.', '-' and '_'", "err");
          return false;
        }
        const already = ((team && team.teams && team.teams[teamName]) || [])
          .some((m) => lower(m && m.name) === lower(name));
        if (already) {
          if (S.toast) S.toast(`${name} is already on ${teamName}`, "warn");
          return false;
        }
        const cwd = state().cwd || "";
        try {
          const added = await S.api("/agent-team", {}, { action: "addMember", team: teamName, name, model: model || undefined, cwd });
          if (!added.res.ok || !added.data) throw new Error(added.data && added.data.error ? added.data.error : `HTTP ${added.res.status}`);
          team = added.data; teamCwd = cwd; teamAt = Date.now();
          // Hired back onto a team, so they are no longer "fired" for the floor.
          firedKeys.delete(lower(name));
          if (displayName) {
            const named = await S.api("/agent-team", {}, { action: "setMemberDisplayName", team: teamName, agent: name, displayName, cwd });
            if (named.res.ok && named.data) team = named.data;
          }
          let warn = "";
          if (createMd) {
            const content = agentDefTemplate({ name, displayName, model, prompt });
            const def = await S.api("/settings", {}, { action: "createAgentDefFile", value: { file: `${name}.md`, content }, cwd });
            if (!def.res.ok) warn = def.data && def.data.error ? String(def.data.error) : `HTTP ${def.res.status}`;
            else await refreshDefs(true);
          }
          if (S.toast) S.toast(warn ? `${name} hired — but ${warn}` : `${name} hired into ${teamName}`, warn ? "warn" : undefined);
          render();
          return true;
        } catch (err) {
          if (S.toast) S.toast(`Could not hire ${name}: ${errMsg(err)}`, "err");
          return false;
        }
      },
    });
  }

  /** Set (or clear) the label a desk shows for a subagent — setMemberDisplayName. */
  function renameMember(teamName, name, btn) {
    const agent = byKey.get(name);
    if (!teamName || !agent) return;
    openDialog({
      title: `Name for ${agent.name}`,
      hint: `shown on the ${teamName} desk`,
      body: dialogField("Display name", "e.g. Bob — empty uses the real name",
        `<input class="office-input" id="office-dlg-input" maxlength="64" spellcheck="false" autocomplete="off" ` +
        `placeholder="${escAttr(agent.name)}" value="${escAttr(agent.displayName || "")}">`),
      submitLabel: "Save",
      onSubmit: async (root) => {
        const displayName = String((root.querySelector("#office-dlg-input") || {}).value || "").trim();
        try {
          const { res, data } = await S.api("/agent-team", {}, {
            action: "setMemberDisplayName", team: teamName, agent: name, displayName, cwd: state().cwd || "",
          });
          if (!res.ok || !data) throw new Error(data && data.error ? data.error : `HTTP ${res.status}`);
          team = data; teamCwd = state().cwd || ""; teamAt = Date.now();
          if (S.toast) S.toast(displayName ? `${agent.name} is now "${displayName}"` : `${agent.name} uses its real name`);
          render();
          return true;
        } catch (err) {
          if (S.toast) S.toast(`Could not rename ${agent.name}: ${errMsg(err)}`, "err");
          return false;
        }
      },
    });
  }

  /**
   * The default body the hire form's **Definition** field starts from, so a new
   * subagent definition is never a blank page. It follows the name as it is
   * typed, and stops following it the moment the user writes their own words.
   */
  function agentPromptTemplate(name, displayName) {
    const who = String(displayName || name || "").trim();
    return [
      who ? `You are ${who}, a subagent on this team.` : "You are a subagent on this team.",
      "",
      "## Job",
      "- What this subagent owns: the work it should pick up.",
      "",
      "## How to work",
      "- Read the reference files assigned to you before you start.",
      "- Say what you changed, and why.",
      "",
      "## Boundaries",
      "- Ask before changing anything outside this task.",
    ].join("\n");
  }

  /**
   * The markdown a freshly hired subagent's agents/<name>.md starts from: the
   * frontmatter, the prompt body, and a **reference template** — the workspace
   * library entries assigned to this subagent, or a commented skeleton to fill
   * in when it has none yet.
   */
  function agentDefTemplate({ name, displayName, model, prompt }) {
    const lines = ["---", `name: ${name}`, `description: ${displayName || name}`];
    if (model) lines.push(`model: ${model}`);
    lines.push("---", "", (prompt || `You are ${displayName || name}, a subagent on this team.`).trim(), "");
    lines.push("## Reference files", "");
    const mine = libraryOf().filter((e) => lower(e.target) === lower(name));
    if (mine.length) {
      lines.push("Read these before you start:", "");
      for (const e of mine) lines.push(`- \`${shortPath(String(e.path || ""))}\`${e.note ? ` — ${e.note}` : ""}`);
      lines.push(
        "",
        "> The Office's meeting room holds the whole library, and assigns each reference to an agent. Whatever is assigned to you is also injected at the start of every new conversation.",
        "",
      );
    } else {
      lines.push(
        "This workspace keeps a reference library (Office → meeting room). References assigned to you are injected at the start of every new conversation; list the paths your prompt relies on here:",
        "",
        "<!-- For example:",
        "- `src/app.ts` — the HTTP surface",
        "- `docs/` — design notes",
        "-->",
        "",
      );
    }
    return lines.join("\n");
  }

  /** One labelled control inside an office dialog. */
  function dialogField(label, hint, control) {
    return (
      `<label class="office-field">` +
        `<span class="office-field-label">${esc(label)}` +
          (hint ? `<span class="office-field-hint">${esc(hint)}</span>` : "") +
        `</span>` +
        control +
      `</label>`
    );
  }

  /**
   * A small modal form. It reuses the full-screen editor's backdrop but keeps
   * its own id, so the two can never close each other. `onSubmit(root)` gets the
   * overlay and returns whether the dialog may close.
   */
  function openDialog({ title, hint, body, submitLabel, onSubmit, onMount, wide }) {
    closeDialog();
    const overlay = document.createElement("div");
    overlay.className = "def-editor-backdrop";
    overlay.id = "office-dlg-backdrop";
    overlay.innerHTML =
      `<form class="office-dialog${wide ? " office-dialog-wide" : ""}" role="dialog" aria-modal="true" aria-label="${escAttr(title)}">` +
        `<div class="office-dialog-head">` +
          `<span class="office-dialog-title">${esc(title)}</span>` +
          (hint ? `<span class="office-dialog-hint">${esc(hint)}</span>` : "") +
        `</div>` +
        `<div class="office-dialog-body">${body}</div>` +
        `<div class="office-dialog-foot">` +
          `<button type="button" class="btn-sm office-dialog-cancel">Cancel</button>` +
          `<button type="submit" class="btn-sm office-dialog-ok">${esc(submitLabel || "Save")}</button>` +
        `</div>` +
      `</form>`;
    document.body.appendChild(overlay);

    const form = overlay.querySelector(".office-dialog");
    const ok = overlay.querySelector(".office-dialog-ok");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (ok.disabled) return;
      ok.disabled = true;
      void Promise.resolve(onSubmit(overlay))
        .then((done) => { if (done) closeDialog(); })
        .finally(() => { if (ok.isConnected) ok.disabled = false; });
    });
    overlay.querySelector(".office-dialog-cancel").addEventListener("click", closeDialog);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeDialog(); });
    document.addEventListener("keydown", dialogKeys);
    // Let the caller wire anything the static markup cannot (the hire form's
    // default Definition body, which tracks the name field).
    if (onMount) { try { onMount(overlay); } catch { /* the form still works */ } }
    const first = overlay.querySelector("input, select, textarea");
    if (first) first.focus();
  }

  function closeDialog() {
    const overlay = document.getElementById("office-dlg-backdrop");
    if (overlay) overlay.remove();
    document.removeEventListener("keydown", dialogKeys);
  }

  function dialogKeys(e) { if (e.key === "Escape") closeDialog(); }

  // ─── Reference library (Office → meeting room) ────────────────────────────

  let pendingLibrary = false;
  let pendingTask = false;   // a board write is in flight
  const stats = new Map();   // session id -> { total_tokens, total_cost, error_count }
  let statsAt = 0;           // when the stats map was last refreshed
  let statsBusy = false;

  /**
   * Every model the app knows, as `<optgroup>`s — one per provider, exactly like
   * the Settings page's pickers (see settings.js modelOptionGroups): the model
   * registry plus whatever the user enabled in pi, so nothing is hidden.
   */
  function modelOptionsHtml(selected) {
    const meta = modelsMeta || {};
    const sel = String(selected || "");
    const ids = new Set([...Object.keys(meta), ...((team && team.enabledModels) || [])].filter(Boolean));
    if (sel) ids.add(sel);
    const groups = new Map(); // provider -> Set<model key>
    for (const id of ids) {
      const provider = (meta[id] && meta[id].provider) || String(id).split("/")[0] || "other";
      if (!groups.has(provider)) groups.set(provider, new Set());
      groups.get(provider).add(String(id));
    }
    return [...groups.keys()].sort((a, b) => a.localeCompare(b)).map((provider) => {
      const keys = [...groups.get(provider)].sort((a, b) => a.localeCompare(b));
      return (
        `<optgroup label="${escAttr(provider)}">` +
        keys.map((key) =>
          `<option value="${escAttr(key)}"${key === sel ? " selected" : ""}>${esc(key.split("/").slice(1).join("/") || key)}</option>`
        ).join("") +
        `</optgroup>`
      );
    }).join("");
  }

  // ─── Token usage and cost ─────────────────────────────────────────────────

  /** A compact price: cents keep their precision, dollars do not. */
  function fmtCost(usd) {
    const v = Number(usd) || 0;
    if (!v) return "$0";
    if (v < 0.01) return `$${v.toFixed(4)}`;
    if (v < 1) return `$${v.toFixed(3)}`;
    return `$${v.toFixed(2)}`;
  }

  /** "12.3k tok · $0.042" for a session, or "" when nothing is known yet. */
  function statsLine(session) {
    const sid = session && session.session_id;
    const s = sid ? stats.get(sid) : null;
    if (!s) return "";
    const tokens = Number(s.total_tokens) || 0;
    const cost = Number(s.total_cost) || 0;
    if (!tokens && !cost) return "";
    return `${S.fmtTokens ? S.fmtTokens(tokens) : tokens} tok · ${fmtCost(cost)}`;
  }

  /**
   * Batch-fetch token/cost totals for the desks on the floor. Batch stats only
   * cover sessions we have not asked about before, so the office refreshes its
   * own copy on a slow timer to keep the numbers moving while an agent works.
   */
  async function refreshStats(force) {
    if (statsBusy) return;
    if (!force && statsAt && Date.now() - statsAt < STATS_TTL_MS) return;
    const ids = [...byKey.values()]
      .map((a) => a.session && a.session.session_id)
      .filter(Boolean);
    if (!ids.length) {
      // Nobody on the floor has a session yet: take whatever the app already
      // knows (it batches on its own) and leave the timer unset, so the next
      // tick asks again the moment an agent clocks in.
      for (const [sid, s] of Object.entries(state().sessionStats || {})) stats.set(sid, s);
      return;
    }
    statsBusy = true;
    statsAt = Date.now();
    try {
      const { res, data } = await S.api("/sessions/stats", { ids: ids.join(",") });
      if (res.ok && data && data.stats) {
        for (const [sid, s] of Object.entries(data.stats)) stats.set(sid, s);
      }
    } catch { /* keep the last numbers */ } finally {
      statsBusy = false;
    }
    render();
  }

  /** Every agent a reference can be assigned to: the orchestrator first, then
   *  each subagent on the roster. Empty (the "whole team" option) is implicit. */
  function libraryTargets() {
    const seen = new Map();
    for (const members of Object.values((team && team.teams) || {})) {
      if (!Array.isArray(members)) continue;
      for (const m of members) {
        const v = String((m && m.name) || "").trim();
        if (!v || lower(v) === "memory-summarizer") continue;
        if (!seen.has(lower(v))) seen.set(lower(v), v);
      }
    }
    if (!seen.has("orchestrator")) seen.set("orchestrator", "orchestrator");
    return [...seen.values()].sort((a, b) =>
      (lower(a) === "orchestrator" ? 0 : 1) - (lower(b) === "orchestrator" ? 0 : 1) || a.localeCompare(b));
  }

  /** A target picker: the whole team, then every agent on the roster (keeping a
   *  target that is no longer on it, so a stale entry is never silently moved). */
  function targetOptions(selected) {
    const cur = String(selected || "");
    const names = libraryTargets();
    if (cur && !names.some((n) => lower(n) === lower(cur))) names.push(cur);
    const opts = [`<option value=""${cur ? "" : " selected"}>whole team</option>`];
    for (const n of names) {
      opts.push(`<option value="${escAttr(n)}"${lower(cur) === lower(n) ? " selected" : ""}>${esc(n)}</option>`);
    }
    return opts.join("");
  }

  /** The manager's rows: one reference each, with its note, its agent and a ✕. */
  function libraryRowsHtml() {
    const rank = (e) => (!e.target ? 0 : lower(e.target) === "orchestrator" ? 1 : 2);
    const list = libraryOf().slice().sort((a, b) =>
      rank(a) - rank(b) || String(a.target || "").localeCompare(String(b.target || "")) || String(a.path).localeCompare(String(b.path)));
    if (!list.length) {
      return `<div class="office-lib-none">No references yet. Add a file or folder below — it is injected at the start of every new conversation, under the agent you assign it to.</div>`;
    }
    return list.map((e) => {
      const full = String(e.path || "");
      const shown = shortPath(full);
      return (
        `<div class="office-lib-row" data-id="${escAttr(e.id)}">` +
          `<span class="office-lib-path" title="${escAttr(full)}">${esc(shown)}</span>` +
          `<input class="office-input office-lib-note" type="text" spellcheck="false" autocomplete="off" ` +
            `maxlength="200" placeholder="note (optional)" value="${escAttr(e.note || "")}" ` +
            `aria-label="Note for ${escAttr(shown)}">` +
          `<select class="office-input office-lib-target" aria-label="Who ${escAttr(shown)} is for">${targetOptions(e.target)}</select>` +
          `<button class="office-lib-del" type="button" data-lib="${escAttr(e.id)}" ` +
            `title="Remove ${escAttr(shown)} from the library">×</button>` +
        `</div>`
      );
    }).join("");
  }

  /** One roster write: keeps the snapshot, the floor and any open full-screen
   *  surface (library, board) in step with whatever the server stored. */
  async function teamPost(body, okMsg) {
    const { res, data } = await S.api("/agent-team", {}, { ...body, cwd: state().cwd || "" });
    if (!res.ok || !data) throw new Error(data && data.error ? data.error : `HTTP ${res.status}`);
    team = data; teamCwd = state().cwd || ""; teamAt = Date.now();
    noteDefaults(data);
    render();                // the floor, the shelf, the wall's board
    renderLibraryOverlay();  // and whichever manager is open
    renderKanbanOverlay();
    renderTeamsOverlay();
    if (okMsg && S.toast) S.toast(okMsg);
  }

  /**
   * Add a file or folder to the workspace's library, for the agent the picker
   * names. The server resolves the path (relative ones against the workspace)
   * and rejects anything it cannot find, so a typo never reaches the block.
   */
  async function addLibraryEntry(form) {
    if (!form || pendingLibrary) return;
    const pathEl = form.querySelector("#office-lib-path");
    const path = String((pathEl && pathEl.value) || "").trim();
    const note = String((form.querySelector("#office-lib-note") || {}).value || "").trim();
    const target = String((form.querySelector("#office-lib-target") || {}).value || "");
    if (!path) {
      if (pathEl) pathEl.focus();
      if (S.toast) S.toast("Give a file or folder path to add", "warn");
      return;
    }
    pendingLibrary = true;
    try {
      await teamPost({ action: "addLibraryEntry", path, note, target }, `${path} added to the library`);
      if (pathEl) pathEl.value = "";
      const noteEl = form.querySelector("#office-lib-note");
      if (noteEl) noteEl.value = "";
    } catch (err) {
      if (S.toast) S.toast(`Could not add ${path}: ${errMsg(err)}`, "err");
    } finally {
      pendingLibrary = false;
    }
  }

  /** Reassign a reference (or rewrite its note) from the manager. */
  async function saveLibraryEntry(id, target, note) {
    if (!id || pendingLibrary) return;
    pendingLibrary = true;
    try {
      await teamPost({ action: "setLibraryEntry", id, target, note });
    } catch (err) {
      if (S.toast) S.toast(`Could not update that reference: ${errMsg(err)}`, "err");
    } finally {
      pendingLibrary = false;
    }
  }

  /** Take one entry out of the library. */
  async function removeLibraryEntry(id, btn) {
    if (!id || pendingLibrary) return;
    pendingLibrary = true;
    if (btn) btn.disabled = true;
    try {
      await teamPost({ action: "removeLibraryEntry", id }, "Removed from the library");
    } catch (err) {
      if (S.toast) S.toast(`Could not remove that reference: ${errMsg(err)}`, "err");
      if (btn) btn.disabled = false;
    } finally {
      pendingLibrary = false;
    }
  }

  // ─── The full-screen reference-library manager ────────────────────────────

  /** Repaint the manager's rows (and the add form's picker) from the roster. */
  function renderLibraryOverlay() {
    const overlay = document.getElementById("office-lib-backdrop");
    if (!overlay) return;
    const list = overlay.querySelector("#office-lib-list");
    if (list) list.innerHTML = libraryRowsHtml();
    const picker = overlay.querySelector("#office-lib-target");
    if (picker) picker.innerHTML = targetOptions(picker.value);
  }

  /**
   * Open the reference library full-screen: every file and folder the workspace
   * carries, the agent each one is for, and the form that adds the next one.
   */
  function openLibrary() {
    closeLibrary();
    const overlay = document.createElement("div");
    overlay.className = "office-lib-backdrop";
    overlay.id = "office-lib-backdrop";
    overlay.innerHTML =
      `<div class="office-lib-panel" role="dialog" aria-modal="true" aria-label="Reference library">` +
        `<div class="office-lib-head">` +
          `<span class="office-lib-hd-title">Reference library</span>` +
          `<span class="office-lib-hd-sub">Files and folders for this workspace — injected at the start of every new conversation, grouped by the agent they are for.</span>` +
          `<span class="office-lib-hd-spacer"></span>` +
          `<button class="btn-sm office-lib-close" type="button">Close</button>` +
        `</div>` +
        `<div class="office-lib-rows" id="office-lib-list"></div>` +
        `<form class="office-lib-add" id="office-lib-form">` +
          `<input class="office-input" id="office-lib-path" type="text" spellcheck="false" autocomplete="off" ` +
            `placeholder="src/app.ts, or a folder like docs/" aria-label="File or folder path">` +
          `<input class="office-input" id="office-lib-note" type="text" spellcheck="false" autocomplete="off" ` +
            `maxlength="200" placeholder="note (optional)" aria-label="Note">` +
          `<select class="office-input" id="office-lib-target" aria-label="Who this reference is for">${targetOptions("")}</select>` +
          `<button class="btn-sm office-lib-add-btn" type="submit">add reference</button>` +
        `</form>` +
      `</div>`;
    document.body.appendChild(overlay);
    renderLibraryOverlay();

    overlay.querySelector(".office-lib-close").addEventListener("click", closeLibrary);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeLibrary(); });
    overlay.querySelector("#office-lib-form").addEventListener("submit", (e) => {
      e.preventDefault();
      void addLibraryEntry(e.target);
    });

    const rows = overlay.querySelector("#office-lib-list");
    // A row edit saves on the spot: the target on change, the note once it is
    // committed (blur or Enter).
    rows.addEventListener("change", (e) => {
      const row = e.target.closest && e.target.closest(".office-lib-row");
      if (!row) return;
      const noteEl = row.querySelector(".office-lib-note");
      const targetEl = row.querySelector(".office-lib-target");
      if (e.target === targetEl) void saveLibraryEntry(row.dataset.id, targetEl.value, noteEl.value);
      else if (e.target === noteEl) void saveLibraryEntry(row.dataset.id, targetEl.value, noteEl.value);
    });
    rows.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.classList && e.target.classList.contains("office-lib-note")) {
        e.preventDefault();
        e.target.blur();
      }
    });
    rows.addEventListener("click", (e) => {
      const del = e.target.closest && e.target.closest(".office-lib-del");
      if (del) void removeLibraryEntry(del.dataset.lib, del);
    });

    document.addEventListener("keydown", libraryKeys);
    const first = overlay.querySelector("#office-lib-path");
    if (first) first.focus();
  }

  function closeLibrary() {
    const overlay = document.getElementById("office-lib-backdrop");
    if (overlay) overlay.remove();
    document.removeEventListener("keydown", libraryKeys);
  }

  function libraryKeys(e) { if (e.key === "Escape") closeLibrary(); }

  // ─── The office's name ────────────────────────────────────────────────────

  /** Name the office (the header's title). Empty restores the default label. */
  function renameOffice() {
    openDialog({
      title: "Name this office",
      hint: "shown at the top of the view",
      body: dialogField("Office name", "e.g. Night Shift HQ — empty uses \"Office\"",
        `<input class="office-input" id="office-name-input" maxlength="60" spellcheck="false" autocomplete="off" ` +
        `placeholder="Office" value="${escAttr(team && team.officeName ? team.officeName : "")}">`),
      submitLabel: "Save",
      onSubmit: async (root) => {
        const name = String((root.querySelector("#office-name-input") || {}).value || "").trim();
        try {
          await teamPost({ action: "setOfficeName", name }, name ? `This office is now “${name}”` : "Office name cleared");
          return true;
        } catch (err) {
          if (S.toast) S.toast(`Could not rename the office: ${errMsg(err)}`, "err");
          return false;
        }
      },
    });
  }

  // ─── The Kanban board and its runner ──────────────────────────────────────

  let pumping = false;   // the queue runner is mid-dispatch
  let runAbort = null;   // AbortController for the run in flight (Pause aborts it)
  const inFlight = new Set(); // task ids this page dispatched and has not settled
  const parked = new Set();   // ids whose run failed — never retried on their own

  /** Repaint the open board from the roster snapshot. */
  function renderKanbanOverlay() {
    const overlay = document.getElementById("office-board-backdrop");
    if (!overlay) return;
    const cols = overlay.querySelector("#office-board-cols");
    if (cols) cols.innerHTML = kanbanColumnsHtml();
    const paused = runnerPaused();
    const run = overlay.querySelector("#office-run-toggle");
    if (run) {
      run.textContent = paused ? "▶ Run" : "⏸ Pause";
      run.classList.toggle("running", !paused);
      run.title = paused
        ? "Start handing planned tasks to the orchestrator"
        : "Stop: the task in progress returns to Planned and the queue waits";
    }
    const now = overlay.querySelector("#office-board-now");
    if (now) {
      const running = currentTask();
      now.textContent = paused
        ? (tasksIn("planned").length || running
          ? "Paused — press ▶ Run to work the queue."
          : "The queue is empty — add a task, then move it to Planned.")
        : running
          ? `The orchestrator is on “${running.title}” — the next planned task starts when it finishes.`
          : tasksIn("planned").length
            ? "A planned task is waiting; it starts as soon as the orchestrator is free."
            : "The queue is empty — add a task, then move it to Planned.";
    }
  }

  /**
   * Open the task board full-screen: four columns (Todo, Planned, In Progress,
   * Done), the add form under Todo, and one move control per task. Moving a task
   * to Planned hands it to the queue; the runner below hands the queue to the
   * orchestrator one task at a time.
   */
  function openKanban() {
    closeKanban();
    const overlay = document.createElement("div");
    overlay.className = "office-lib-backdrop office-board-backdrop";
    overlay.id = "office-board-backdrop";
    overlay.innerHTML =
      `<div class="office-lib-panel office-board-panel" role="dialog" aria-modal="true" aria-label="Task board">` +
        `<div class="office-lib-head">` +
          `<span class="office-lib-hd-title">Task board</span>` +
          `<span class="office-lib-hd-sub">Todo → Planned → In Progress → Done. Planned tasks are handed to the orchestrator one at a time when the runner is running, and land in Done when the run finishes.</span>` +
          `<span class="office-lib-hd-spacer"></span>` +
          // The runner starts paused; this is where the queue is started or held.
          `<button class="btn-sm office-run-toggle" id="office-run-toggle" type="button"></button>` +
          `<button class="btn-sm office-lib-close" type="button">Close</button>` +
        `</div>` +
        `<div class="office-board-cols" id="office-board-cols"></div>` +
        `<div class="office-board-now" id="office-board-now"></div>` +
      `</div>`;
    document.body.appendChild(overlay);
    renderKanbanOverlay();

    overlay.querySelector(".office-lib-close").addEventListener("click", closeKanban);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeKanban(); });
    overlay.querySelector("#office-run-toggle").addEventListener("click", () => void setRunnerPaused(!runnerPaused()));
    overlay.querySelector("#office-board-cols").addEventListener("click", (e) => {
      const add = e.target.closest && e.target.closest(".office-task-new");
      if (add) { openTaskDialog(); return; }
      const move = e.target.closest && e.target.closest(".office-task-move");
      if (move) {
        // A move the user makes themselves unpark the task: they are asking for
        // another run, even if the last one failed.
        parked.delete(move.dataset.id);
        void moveTask(move.dataset.id, move.dataset.move);
        return;
      }
      const del = e.target.closest && e.target.closest(".office-task-del");
      if (del) void deleteTask(del.dataset.del);
    });
    document.addEventListener("keydown", kanbanKeys);
  }

  function closeKanban() {
    const overlay = document.getElementById("office-board-backdrop");
    if (overlay) overlay.remove();
    document.removeEventListener("keydown", kanbanKeys);
  }

  function kanbanKeys(e) {
    if (e.key !== "Escape") return;
    // The New-task popup sits above the board: Escape closes it, not the board.
    if (document.getElementById("office-dlg-backdrop")) return;
    closeKanban();
  }

  /** Start or hold the queue runner (POST setRunnerPaused). Pausing aborts the
   *  run in flight, so its task returns to Planned rather than carrying on. */
  async function setRunnerPaused(paused) {
    if (runnerPaused() === paused) return;
    runnerPausedLocal = paused; // hold the UI steady until the write settles
    if (paused) abortRun();
    try {
      await teamPost({ action: "setRunnerPaused", paused }, paused ? "Runner paused" : "Runner running");
    } catch (err) {
      if (S.toast) S.toast(`Could not ${paused ? "pause" : "start"} the runner: ${errMsg(err)}`, "err");
      render();
    } finally {
      runnerPausedLocal = null;
    }
    if (!paused) void pumpTasks();
  }

  /** Abort the run in flight, if any — the runner moves its task back to Planned. */
  function abortRun() {
    if (runAbort) { try { runAbort.abort(); } catch { /* already settled */ } }
  }

  /** Move one task to another column (server write, then the runner reacts). */
  async function moveTask(id, status, quiet) {
    if (!id || !status || pendingTask) return false;
    pendingTask = true;
    try {
      await teamPost({ action: "moveTask", id, status }, quiet ? undefined : `Moved to ${status.replace("_", " ")}`);
      // Landing in Planned is the handover: the runner picks it up.
      if (status === "planned") void pumpTasks();
      return true;
    } catch (err) {
      if (S.toast) S.toast(`Could not move that task: ${errMsg(err)}`, "err");
      return false;
    } finally {
      pendingTask = false;
    }
  }

  /** Drop a task from the board. */
  async function deleteTask(id) {
    if (!id || pendingTask) return;
    pendingTask = true;
    try {
      await teamPost({ action: "removeTask", id }, "Task deleted");
    } catch (err) {
      if (S.toast) S.toast(`Could not delete that task: ${errMsg(err)}`, "err");
    } finally {
      pendingTask = false;
    }
  }

  /**
   * Hand one planned task to the orchestrator and wait for the run to settle.
   * The task is dispatched as a normal chat turn in its own session, so the
   * conversation the user is having in the Chat view is never disturbed; the
   * office simply owns the response stream and watches for `done`.
   */
  async function runTask(task) {
    const prompt = task.note ? `${task.title}\n\n${task.note}` : String(task.title);
    const ctrl = new AbortController();
    runAbort = ctrl;
    let res;
    try {
      res = await fetch(window.apiUrl("/chat", {}), {
        method: "POST",
        headers: { ...window.authHeaders(), "content-type": "application/json" },
        // The model the user picked on the orchestrator's desk rides with every
        // dispatch, so the floor runs the agent they chose it to be.
        body: JSON.stringify({ cwd: state().cwd || "", prompt, model: orchModel() || undefined }),
        signal: ctrl.signal,
      });
    } catch {
      return ctrl.signal.aborted ? "aborted" : "failed";
    }
    if (!res.ok || !res.body) return ctrl.signal.aborted ? "aborted" : "failed";
    // Read the NDJSON stream to its end: `done` means pi settled the turn.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let settled = false;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let evt = null;
          try { evt = JSON.parse(line); } catch { continue; }
          if (evt && evt.type === "done") settled = !evt.error;
        }
      }
    } catch {
      return ctrl.signal.aborted ? "aborted" : "failed";
    }
    return settled ? "done" : "failed";
  }

  /**
   * The queue runner: while the orchestrator is free and Planned holds tasks,
   * move the FIRST planned task into In Progress, dispatch it, and on completion
   * move it to Done and pick up the next one. One task at a time, in order.
   */
  async function pumpTasks() {
    if (pumping) return;
    if (runnerPaused()) return;         // the runner waits for the user to press Run
    const running = currentTask();
    if (running) {
      // A task left In Progress by someone else — an earlier page load, another
      // tab — is not being worked on here: put it back at the head of the queue
      // rather than stalling the board for good. Marking it in flight first
      // keeps the repeated renders during the write from scheduling it twice.
      if (!inFlight.has(running.id)) {
        inFlight.add(running.id);
        void moveTask(running.id, "planned", true).then((moved) => {
          inFlight.delete(running.id);
          if (moved && !runnerPaused()) void pumpTasks();
        });
      }
      return;                           // the orchestrator is already on a task
    }
    // Skip anything whose run already failed (it waits for the user to move it
    // again), and anything already in flight (being relocated or dispatched), so
    // a broken run — or a write in progress — can never spin.
    const next = tasksIn("planned").find((t) => !parked.has(t.id) && !inFlight.has(t.id));
    if (!next) return;
    pumping = true;
    inFlight.add(next.id);
    let advanced = false;               // the run finished — look for the next
    try {
      if (!(await moveTask(next.id, "in_progress", true))) return;
      if (S.toast) S.toast(`Handing “${next.title}” to the orchestrator`);
      const outcome = await runTask(next);
      if (outcome === "done") {
        await moveTask(next.id, "done", true);
        if (S.toast) S.toast(`Done: ${next.title}`);
        advanced = true;
      } else if (outcome === "aborted") {
        // The user pressed Pause: hand the task back to the queue without
        // parking it, so pressing Run picks it straight up again.
        await moveTask(next.id, "planned", true);
        if (S.toast) S.toast(`Paused — “${next.title}” is back in Planned`);
      } else {
        // The run did not settle: put the task back in the queue rather than
        // losing it, and park it so the runner never spins on a failure.
        parked.add(next.id);
        await moveTask(next.id, "planned", true);
        if (S.toast) S.toast(`“${next.title}” could not run — it is back in Planned`, "err");
      }
    } finally {
      pumping = false;
      inFlight.delete(next.id);
      runAbort = null;
    }
    // Step 6: with a task finished, take the next one from the queue.
    if (advanced && !runnerPaused()) void pumpTasks();
  }

  /** Create a team and make it the active one — POST /agent-team addTeam. */
  async function addTeam(rawName) {
    const name = String(rawName || "").trim();
    if (!name || pendingTeam) return false;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
      if (S.toast) S.toast("Team names may use letters, digits, '-' and '_'", "err");
      return false;
    }
    if (team && team.teams && team.teams[name]) {
      if (S.toast) S.toast(`Team ${name} already exists`, "warn");
      return false;
    }
    pendingTeam = name;
    try {
      await teamPost({ action: "addTeam", team: name }, `Team ${name} added — hire subagents onto it`);
      return true;
    } catch (err) {
      if (S.toast) S.toast(`Could not add ${name}: ${errMsg(err)}`, "err");
      return false;
    } finally {
      pendingTeam = null;
    }
  }

  /**
   * Drop a team from the roster — POST /agent-team removeTeam. The team's desks
   * leave the floor with it; the agents themselves (and their definitions) are
   * untouched, and the server never leaves activeTeam pointing at a dead team.
   */
  async function removeTeam(name) {
    const teamName = String(name || "").trim();
    if (!teamName || pendingTeam) return false;
    if (!(team && team.teams && team.teams[teamName])) return false;
    pendingTeam = teamName;
    try {
      await teamPost({ action: "removeTeam", team: teamName }, `Team ${teamName} removed`);
      return true;
    } catch (err) {
      if (S.toast) S.toast(`Could not remove ${teamName}: ${errMsg(err)}`, "err");
      return false;
    } finally {
      pendingTeam = null;
    }
  }

  // ─── The Teams manager (orchestrator → teams) ─────────────────────────────

  /** Every team in roster order, with its members, for the manager. */
  function teamsOf() {
    const t = (team && team.teams) || {};
    const order = team && Array.isArray(team.teamsOrder) && team.teamsOrder.length
      ? team.teamsOrder
      : Object.keys(t);
    const seen = new Set();
    const out = [];
    for (const name of order) {
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push({ name, members: Array.isArray(t[name]) ? t[name] : [] });
    }
    for (const name of Object.keys(t)) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, members: Array.isArray(t[name]) ? t[name] : [] });
    }
    return out;
  }

  /** The manager's rows: one team each, with its desk count and a ✕. */
  function teamRowsHtml() {
    const rows = teamsOf();
    if (!rows.length) {
      return `<div class="office-lib-none">No teams yet. Add one below, then hire subagents onto it.</div>`;
    }
    return rows.map(({ name, members }) => {
      const active = team && team.activeTeam === name;
      return (
        `<div class="office-team-row" data-team="${escAttr(name)}">` +
          `<span class="office-team-name">${esc(name)}</span>` +
          (active ? `<span class="office-room-active">✓ active</span>` : "") +
          `<span class="office-team-count">${members.length} desk${members.length === 1 ? "" : "s"}</span>` +
          `<span class="office-task-acts">` +
            `<button class="office-task-del office-team-del" type="button" data-team="${escAttr(name)}" ` +
              `title="Remove ${escAttr(name)} from the floor">×</button>` +
          `</span>` +
        `</div>`
      );
    }).join("");
  }

  /** Repaint the manager's rows from the roster snapshot. */
  function renderTeamsOverlay() {
    const overlay = document.getElementById("office-teams-backdrop");
    if (!overlay) return;
    const list = overlay.querySelector("#office-teams-list");
    if (list) list.innerHTML = teamRowsHtml();
  }

  /**
   * The Teams manager, opened from the orchestrator's office: every team on the
   * floor with its desk count, a remove control per team, and the form that
   * adds the next one (which becomes the active team).
   */
  function openTeamsManager() {
    closeTeamsManager();
    const overlay = document.createElement("div");
    overlay.className = "office-lib-backdrop";
    overlay.id = "office-teams-backdrop";
    overlay.innerHTML =
      `<div class="office-lib-panel office-teams-panel" role="dialog" aria-modal="true" aria-label="Teams">` +
        `<div class="office-lib-head">` +
          `<span class="office-lib-hd-title">Teams</span>` +
          `<span class="office-lib-hd-sub">Every team on this workspace's floor. Add one, hire subagents onto it, or remove a team you no longer need.</span>` +
          `<span class="office-lib-hd-spacer"></span>` +
          `<button class="btn-sm office-lib-close" type="button">Close</button>` +
        `</div>` +
        `<div class="office-teams-list" id="office-teams-list"></div>` +
        `<form class="office-lib-add" id="office-teams-form">` +
          `<input class="office-input" id="office-team-new" type="text" maxlength="64" spellcheck="false" ` +
            `autocomplete="off" placeholder="new team name" aria-label="New team name">` +
          `<button class="btn-sm office-lib-add-btn" type="submit">add team</button>` +
        `</form>` +
      `</div>`;
    document.body.appendChild(overlay);
    renderTeamsOverlay();

    overlay.querySelector(".office-lib-close").addEventListener("click", closeTeamsManager);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeTeamsManager(); });
    overlay.querySelector("#office-teams-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const input = e.target.querySelector("#office-team-new");
      void addTeam(input && input.value).then((ok) => { if (ok && input) input.value = ""; });
    });
    overlay.querySelector("#office-teams-list").addEventListener("click", (e) => {
      const del = e.target.closest && e.target.closest(".office-team-del");
      if (del) void removeTeam(del.dataset.team);
    });
    document.addEventListener("keydown", teamsKeys);
    const first = overlay.querySelector("#office-team-new");
    if (first) first.focus();
  }

  function closeTeamsManager() {
    const overlay = document.getElementById("office-teams-backdrop");
    if (overlay) overlay.remove();
    document.removeEventListener("keydown", teamsKeys);
  }

  function teamsKeys(e) { if (e.key === "Escape") closeTeamsManager(); }

  /**
   * The subagent definitions (agents/*.md) ride along with the settings
   * snapshot; the office needs them so a desk's **md** control can open the
   * agent's whole markdown. Cached briefly — they change rarely.
   */
  async function refreshDefs(force) {
    if (!force && defByAgent && Date.now() - defsAt < 30_000) return;
    const cwd = state().cwd || "";
    try {
      const { res, data } = await S.api("/settings", cwd ? { cwd } : {});
      if (!res.ok || !data) return;
      // The model registry rides along with the same request, so the hire picker
      // can list every known model grouped by provider (like Settings does), and
      // so does the default model the orchestrator runs on.
      if (data.modelsMeta) modelsMeta = data.modelsMeta;
      noteDefaults(data);
      if (!Array.isArray(data.agentDefs)) return;
      const map = new Map();
      for (const d of data.agentDefs) {
        if (!d || !d.file) continue;
        map.set(lower(d.name || String(d.file).replace(/\.md$/i, "")), d);
      }
      defByAgent = map;
      defsAt = Date.now();
    } catch { /* keep whatever we had — the md control retries on the next open */ }
  }

  /** Open a subagent's agents/*.md (frontmatter + prompt) in the full-screen editor. */
  async function editAgentMarkdown(name, btn) {
    if (btn) btn.disabled = true;
    try { await refreshDefs(false); } finally { if (btn) btn.disabled = false; }
    const def = defByAgent && defByAgent.get(lower(name));
    if (!def) {
      if (S.toast) S.toast(`No agents/${name}.md definition to edit`, "warn");
      return;
    }
    openMarkdownEditor({
      title: `agents/${def.file}`,
      hint: `${name} · frontmatter + prompt`,
      content: def.content || "",
      save: async (content) => {
        try {
          const { res, data } = await S.api("/settings", {}, {
            action: "saveAgentDefFile",
            value: { file: def.file, content },
            cwd: state().cwd || "",
          });
          if (!res.ok || !data) throw new Error(data && data.error ? data.error : `HTTP ${res.status}`);
          def.content = content; // keep the cache in step with what we just wrote
          if (S.toast) S.toast(`${def.file} saved`);
          return true;
        } catch (err) {
          if (S.toast) S.toast(`Could not save ${def.file}: ${err && err.message ? err.message : err}`, "err");
          return false;
        }
      },
    });
  }

  // The full-screen markdown editor. It reuses the Settings page's `.def-editor*`
  // styles but keeps its own overlay id, so the two editors can never tear each
  // other down.
  function openMarkdownEditor({ title, hint, content, save }) {
    closeMarkdownEditor();
    const overlay = document.createElement("div");
    overlay.className = "def-editor-backdrop";
    overlay.id = "office-md-backdrop";
    overlay.innerHTML =
      `<div class="def-editor" role="dialog" aria-modal="true" aria-label="Edit ${escAttr(title)}">` +
        `<div class="def-editor-head">` +
          `<span class="def-editor-title">${esc(title)}</span>` +
          `<span class="def-editor-hint">${esc(hint)}</span>` +
          `<span class="def-editor-spacer"></span>` +
          `<button type="button" class="btn-sm def-editor-save">Save</button>` +
          `<button type="button" class="btn-sm def-editor-close">Close</button>` +
        `</div>` +
        `<textarea class="def-editor-text" spellcheck="false" wrap="off"></textarea>` +
      `</div>`;
    document.body.appendChild(overlay);

    const ta = overlay.querySelector(".def-editor-text");
    ta.value = content || "";
    ta.focus();

    overlay.querySelector(".def-editor-save").addEventListener("click", () => {
      void save(ta.value).then((ok) => { if (ok) closeMarkdownEditor(); });
    });
    overlay.querySelector(".def-editor-close").addEventListener("click", closeMarkdownEditor);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeMarkdownEditor(); });
    document.addEventListener("keydown", mdEditorKeys);
  }

  function closeMarkdownEditor() {
    const overlay = document.getElementById("office-md-backdrop");
    if (overlay) overlay.remove();
    document.removeEventListener("keydown", mdEditorKeys);
  }

  function mdEditorKeys(e) {
    // Ctrl/Cmd+S saves without leaving the editor; Esc closes it.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      const btn = document.querySelector("#office-md-backdrop .def-editor-save");
      if (btn) { e.preventDefault(); btn.click(); }
      return;
    }
    if (e.key === "Escape") closeMarkdownEditor();
  }

  async function refreshTeam(force) {
    const cwd = state().cwd || "";
    if (!force && team && cwd === teamCwd && Date.now() - teamAt < 15_000) return;
    try {
      const { res, data } = await S.api("/agent-team", cwd ? { cwd } : {});
      if (res.ok && data) { team = data; teamCwd = cwd; teamAt = Date.now(); noteDefaults(data); }
    } catch { /* keep the last roster — the office still animates from sessions */ }
    render();
  }

  // ─── Lifecycle (called by the plugin spec) ────────────────────────────────

  function build(paneEl) {
    pane = paneEl;
    pane.innerHTML =
      `<div class="pane-header office-header">` +
        `<span class="office-counts" id="office-counts"></span>` +
        `<button class="btn-sm" id="office-refresh" type="button" ` +
          `title="Refetch the agent roster">↻ refresh</button>` +
      `</div>` +
      `<div class="office-scene">` +
        `<div class="office-building">` +
          `<div class="office-wall">` +
            `<span class="office-plant"></span>` +
            `<span class="office-window"></span>` +
            // The office's own name, hung on the wall between the window and
            // the clock — the top of the building, beside the Kanban sign.
            `<button class="office-title office-wall-name" id="office-name" type="button" ` +
              `title="Rename this office">${esc(officeName())}</button>` +
            `<span class="office-clock"><span class="office-hand h"></span><span class="office-hand m"></span></span>` +
            `<span class="office-wall-slot" id="office-board-host">${kanbanMiniHtml()}</span>` +
          `</div>` +
          `<div class="office-plan" id="office-plan"></div>` +
          `<div class="office-empty" id="office-empty" hidden>` +
            `<div class="settings-empty-title">The office is quiet</div>` +
            `<div class="settings-empty-sub">Start a Chat turn and your subagents will clock in here.</div>` +
          `</div>` +
          `<div class="office-wall office-wall-south" aria-hidden="true">` +
            `<span class="office-plant tall"></span>` +
            `<span class="office-armchair"></span>` +
            `<span class="office-armchair"></span>` +
            `<span class="office-plant"></span>` +
          `</div>` +
        `</div>` +
        `<div class="office-pop" id="office-pop" role="tooltip" hidden></div>` +
      `</div>`;

    sceneEl = pane.querySelector(".office-scene");
    planEl = pane.querySelector("#office-plan");
    countsEl = pane.querySelector("#office-counts");
    emptyEl = pane.querySelector("#office-empty");
    popEl = pane.querySelector("#office-pop");

    pane.querySelector("#office-refresh").addEventListener("click", () => {
      team = null;
      void refreshTeam(true);
    });

    // The office's name (on the wall) is edited in a dialog; empty restores "Office".
    pane.querySelector("#office-name").addEventListener("click", renameOffice);
    // The wall's board opens the full-screen Kanban manager.
    pane.addEventListener("click", (e) => {
      const board = e.target.closest && e.target.closest("#office-board-open");
      if (board) openKanban();
    });

    // Hover (and keyboard focus) opens the agent's message popup. The popup
    // itself is pointer-events:none, so moving onto it leaves the cubicle and
    // closes it, and it can never trap the pointer mid-animation.
    planEl.addEventListener("mouseover", (e) => {
      const pod = e.target.closest && e.target.closest(".office-pod");
      if (pod && pod.dataset.key !== popKey) showPop(pod.dataset.key, pod);
    });
    planEl.addEventListener("mouseout", (e) => {
      const from = e.target.closest && e.target.closest(".office-pod");
      if (!from) return;
      const to = e.relatedTarget && e.relatedTarget.closest ? e.relatedTarget.closest(".office-pod") : null;
      if (to !== from) hidePop();
    });
    planEl.addEventListener("focusin", (e) => {
      const pod = e.target.closest && e.target.closest(".office-pod");
      if (pod) showPop(pod.dataset.key, pod);
    });
    planEl.addEventListener("focusout", hidePop);
    // An inactive team room offers an Activate control that switches the roster
    // over to that team (the same POST /agent-team the Agent-Team rail uses).
    planEl.addEventListener("click", (e) => {
      const t = e.target;
      const hire = t.closest && t.closest(".office-hire");
      if (hire && !hire.disabled) { void hireMember(hire.dataset.team); return; }
      const pick = t.closest && t.closest(".office-room-pick");
      if (pick && !pick.disabled) { void activateTeam(pick.dataset.team, pick); return; }
      const lib = t.closest && t.closest("#office-library-open");
      if (lib) { openLibrary(); return; }
      const teamsBtn = t.closest && t.closest("#office-teams-open");
      if (teamsBtn) { openTeamsManager(); return; }
      const act = t.closest && t.closest(".office-act, .office-fire");
      if (!act || act.disabled) return;
      if (act.dataset.act === "fire") void fireMember(act.dataset.team, act.dataset.agent, act);
      else if (act.dataset.act === "duty") toggleDuty(act.dataset.agent, act);
      else if (act.dataset.act === "rename") renameMember(act.dataset.team, act.dataset.agent, act);
      else if (act.dataset.act === "md") void editAgentMarkdown(act.dataset.agent, act);
    });
    // The orchestrator's model picker: a change is a settings write.
    planEl.addEventListener("change", (e) => {
      const pick = e.target;
      if (pick && pick.id === "office-orch-model") void setOrchestratorModel(pick.value);
    });
    // Opening the shelf from the keyboard behaves like clicking it.
    planEl.addEventListener("keydown", (e) => {
      const t = e.target;
      if (e.key === "Enter" && t && t.id === "office-library-open") {
        e.preventDefault();
        openLibrary();
      }
    });
    // The popup is anchored to a cubicle: scrolling would leave it behind.
    sceneEl.addEventListener("scroll", hidePop, { passive: true });
  }

  function startTicker() {
    if (ticker) return;
    ticker = setInterval(() => {
      // Time-based statuses (the 10s activity window) and expiring labels.
      render();
      if (lastActivitySeen && Date.now() - lastActivitySeen > ACTIVITY_TTL_MS) lastActivitySeen = 0;
    }, TICK_MS);
  }
  function stopTicker() { if (ticker) { clearInterval(ticker); ticker = null; } }

  window.__officeOnView = function () {
    const el = document.getElementById("office-pane");
    if (!el) return;
    if (!pane || pane !== el) build(el);
    void refreshTeam(false);
    void refreshDefs(false);
    render();
    startTicker();
  };

  window.__officeOnHide = function () {
    stopTicker();
    hidePop();
    // The full-screen surfaces are chrome; leaving the view takes them with it.
    closeLibrary();
    closeKanban();
    closeTeamsManager();
  };

  window.__officeOnSessions = function () { render(); };

  window.__officeOnCwd = function () {
    // A different project gets a fresh floor: yesterday's firing does not carry.
    firedKeys.clear();
    void refreshTeam(true);
  };

  window.__officeOnReconnect = function () { void refreshTeam(true); void refreshDefs(true); };

  window.__officeOnEvent = function (evt) {
    noteActivity(evt);
    render();
  };

  // app.js restores the initial view with setView(STATE.view) while it executes,
  // which is BEFORE this file is parsed — so that onShow call was a no-op and a
  // boot that lands directly on Office would sit on an empty pane. Re-issue the
  // notification now that the hook exists.
  if (state().view === "office") window.__officeOnView();
})();
