/**
 * trajectory.js — Pi Scope Trajectory view.
 *
 * A turn-aware event ledger ported from @deepseek-ai/dsh-client-ui-trajectory,
 * adapted to Pi Scope's vanilla-JS stack and its `ObsEvent` shapes. It folds a
 * session's raw events into turns (from `turn_start`/`turn_end`/`user_message`
 * boundaries), groups ("Message" / "Step N"), and cells (User / Message / Tool /
 * System / Compacted / Context). Message rows carry Input/Output token columns
 * and an own-duration Time; Tool rows pair `tool_call` + `tool_result` by
 * `tool_call_id` and show call→result wall time. A fixed overview strip above
 * the ledger projects each record's start/duration, and clicking a row opens an
 * inline inspector with Input / Output / Thinking / Timing plus raw JSON.
 *
 * IIFE-wrapped for scope isolation. Uses window.SCOPE + window.__SCOPE_STATE.
 */
(function () {
  "use strict";

  const STATE = window.__SCOPE_STATE;
  const O = window.SCOPE;
  const {
    escapeHtml, fmtTokens, trunc, shortId, fmtTs, summaryFor,
    fetchSessionEvents, apiUrl, authHeaders, saveURLState,
  } = O;

  const MAX_EVENTS = 6000;

  // ─── DOM refs ─────────────────────────────────────────────────────────────
  const pane = document.getElementById("trajectory-pane");
  const ledger = document.getElementById("trajectory-ledger");
  const overview = document.getElementById("trajectory-overview");
  const label = document.getElementById("trajectory-label");
  const searchBox = document.getElementById("trajectory-search");
  const filterChips = document.getElementById("trajectory-filters");
  const statsEl = document.getElementById("trajectory-stats");
  const pauseToast = document.getElementById("trajectory-pause-toast");
  const inspector = document.getElementById("trajectory-inspector");
  const inspectorTitle = document.getElementById("trajectory-inspector-title");
  const inspectorBody = document.getElementById("trajectory-inspector-body");
  const inspectorCopy = document.getElementById("trajectory-inspector-copy");
  const inspectorWrap = document.getElementById("trajectory-inspector-wrap");
  const inspectorClose = document.getElementById("trajectory-inspector-close");
  const resizer = document.getElementById("trajectory-resizer");

  // ─── Module state ─────────────────────────────────────────────────────────
  let evts = [];
  let lastSeq = -1;
  let selectedSid = null;
  let search = "";
  let hideKinds = new Set(); // kinds to hide: "request", "context", "system"
  let stickToBottom = true;
  let session = null; // session summary object
  let costStr = "";
  let selectedIndex = null; // cell.index of the record open in the inspector
  let loading = false;      // a family load is in flight

  // ─── Agent-family state ───────────────────────────────────────────────────
  // The view follows the workspace the user is in (the terminal cwd) and shows
  // the newest session there WITH everything it spawned, so subagents no longer
  // have to be selected one by one.
  let familyRoot = null;       // root session whose whole tree is shown
  let familyMeta = [];         // [{ sid, session, depth }] root first, then descendants
  let familySids = new Set();  // every sid in the shown family (root + subagents)
  let subEvents = new Map();   // sid -> events[] for subagent sessions
  let loadToken = 0;           // guards out-of-order family loads
  let renderQueued = false;    // rAF-batched live re-render

  // Subagent sections the user collapsed (persisted; expanded by default).
  const collapsedAgents = loadCollapsedAgents();
  function loadCollapsedAgents() {
    try { return new Set(JSON.parse(localStorage.getItem("scope-trajectory-collapsed-agents") || "[]")); }
    catch { return new Set(); }
  }
  function saveCollapsedAgents() {
    try { localStorage.setItem("scope-trajectory-collapsed-agents", JSON.stringify([...collapsedAgents])); }
    catch { /* storage unavailable — collapse state is best-effort */ }
  }

  // ─── Small helpers ────────────────────────────────────────────────────────

  function tsMs(evt) {
    if (!evt?.ts) return null;
    const t = new Date(evt.ts).getTime();
    return Number.isFinite(t) ? t : null;
  }

  function safeJson(v) {
    try { return JSON.stringify(v, null, 2); } catch { return String(v); }
  }

  /** Own-duration label for the Time column: `+1.2s`, `+900ms`, or `—`. */
  function fmtOwn(seconds) {
    if (seconds == null || !Number.isFinite(seconds)) return "—";
    if (seconds < 1) return "+" + Math.round(seconds * 1000) + "ms";
    return "+" + (seconds >= 10 ? seconds.toFixed(0) : seconds.toFixed(1)) + "s";
  }

  function fmtMs(ms) {
    if (ms == null || !Number.isFinite(ms)) return "—";
    return Math.round(ms).toLocaleString("en-US") + " ms";
  }

  function kindLabel(kind) {
    switch (kind) {
      case "user": return "User";
      case "message": return "Message";
      case "tool": return "Tool";
      case "system": return "System";
      case "request": return "Request";
      case "compacted": return "Compacted";
      case "context": return "Context";
      case "dispatch": return "Dispatch";
      default: return kind;
    }
  }

  // ─── Layout fold ──────────────────────────────────────────────────────────

  /**
   * Bucket a session's events into turns. A `user_message` opens the next
   * turn, `turn_start` fixes its index, and `turn_end` closes it. Events
   * before the first user message form a "setup" bucket (rendered as
   * "Between turns").
   */
  function buildTurnBuckets(events) {
    const buckets = [];
    let current = null;
    const newBucket = (evt, setup = false) => {
      const b = {
        turnIndex: null,
        setup,
        events: [],
        sid: evt?.session_id ?? "",
        turnEndUsage: null,
        turnEndTs: null,
      };
      buckets.push(b);
      return b;
    };

    for (const evt of events) {
      if (evt.type === "user_message") {
        // Append to the existing turn_start bucket instead of closing it
        // and creating a new one. The previous logic split turn_start
        // into its own bucket (dropped — zero visible cells) from
        // its content (lost the turnIndex), breaking turn boundaries.
        if (!current || current.closed) current = newBucket(evt);
        current.events.push(evt);
        continue;
      }
      if (evt.type === "turn_start") {
        if (!current || current.closed || current.turnStarted || current.setup) current = newBucket(evt);
        current.turnStarted = true;
        current.turnIndex = evt.payload?.turn_index ?? current.turnIndex;
        current.events.push(evt);
        continue;
      }
      if (!current) current = newBucket(evt, true);
      current.events.push(evt);
      if (evt.payload?.turn_index != null && current.turnIndex == null) current.turnIndex = evt.payload.turn_index;
      if (evt.type === "turn_end") {
        current.turnIndex = evt.payload?.turn_index ?? current.turnIndex;
        current.turnEndUsage = evt.payload?.usage ?? null;
        current.turnEndTs = tsMs(evt);
        current.closed = true;
      }
    }
    return buckets.filter((b) => b.events.length);
  }

  /**
   * Fold one turn bucket's raw events into Message/Step groups of cells.
   * @param bucket - turn bucket from buildTurnBuckets.
   * @param ctx - { index, systemCount, resultByCall } shared fold state.
   */
  function foldBucket(bucket, ctx) {
    const groups = []; // { title, laid: [] }
    let curTitle = "Message";
    let step = 0;
    const pendingTools = new Map(); // call_id -> laid tool cell

    const ensureGroup = (title) => {
      let g = groups.find((x) => x.title === title);
      if (!g) { g = { title, laid: [] }; groups.push(g); }
      return g;
    };

    const push = (laid, groupTitle) => {
      ensureGroup(groupTitle).laid.push(laid);
    };

    for (const evt of bucket.events) {
      const p = evt.payload ?? {};
      switch (evt.type) {
        case "user_message": {
          const text = p.text || "";
          push({
            absTime: tsMs(evt),
            cell: {
              index: ++ctx.index, kind: "user", text: trunc(text, 200), preview: text,
              inputDetail: text, timeSeconds: 0, startedAt: tsMs(evt), sourceEvt: evt, opensTurn: true,
            },
          }, "Message");
          break;
        }
        case "llm_request": {
          const turnLabel = p.turn_index != null ? `turn #${p.turn_index}` : "";
          const modelStr = p.model || "";
          const msgPreview = p.user_msg_preview ? trunc(p.user_msg_preview, 60) : "";
          const parts = [modelStr, turnLabel, msgPreview].filter(Boolean);
          push({
            absTime: tsMs(evt),
            cell: {
              index: ++ctx.index, kind: "request",
              text: parts.join(" · ") || p.system_prompt?.slice(0, 80) || "",
              preview: "", inputDetail: p.system_prompt || "",
              timeSeconds: 0, startedAt: tsMs(evt), sourceEvt: evt,
            },
          }, "Context");
          ctx.systemCount++;
          break;
        }
        case "assistant_message": {
          step++;
          curTitle = step === 1 ? "Message" : "Step " + step;
          const u = p.usage ?? {};
          const latency = p.latency_ms != null ? p.latency_ms : null;
          const startedAt = tsMs(evt) != null && latency != null ? tsMs(evt) - latency : tsMs(evt);
          push({
            absTime: startedAt,
            cell: {
              index: ++ctx.index, kind: "message",
              text: trunc(p.text || "", 240) || "tool call only",
              preview: p.text || "", thinking: p.thinking || "",
              timeSeconds: latency != null ? latency / 1000 : null,
              startedAt,
              prefillMs: p.prefill_ms ?? null,
              generationMs: p.generation_ms ?? null,
              input: u.input ?? null, output: u.output ?? null,
              cacheRead: u.cache_read ?? null, cacheWrite: u.cache_write ?? null,
              sourceEvt: evt,
            },
          }, curTitle);
          break;
        }
        case "tool_call": {
          const callId = p.tool_call_id;
          const laid = {
            absTime: tsMs(evt), toolName: p.tool_name, callId,
            cell: {
              index: ++ctx.index, kind: "tool", text: p.tool_name || "tool",
              preview: p.args != null ? trunc(safeJson(p.args), 200) : "",
              inputDetail: p.args != null ? safeJson(p.args) : "",
              timeSeconds: null, startedAt: tsMs(evt),
              callId, toolName: p.tool_name, isError: false,
              sourceEvt: evt, resultEvt: null,
            },
          };
          push(laid, curTitle);
          if (callId) pendingTools.set(callId, laid);
          break;
        }
        case "tool_result": {
          const callId = p.tool_call_id;
          const prior = callId ? pendingTools.get(callId) : undefined;
          const callTs = prior ? prior.cell.startedAt : null;
          const isErr = window.SCOPE.isToolResultError ? window.SCOPE.isToolResultError(p) : (!!p.is_error || (p.details_summary?.exit_code != null && p.details_summary.exit_code !== 0));
          if (prior) {
            prior.cell.resultEvt = evt;
            prior.cell.isError = isErr;
            prior.cell.outputDetail = p.content_text || "";
            prior.cell.resultPreview = isErr ? "✗ error" : trunc(p.content_text || "", 160);
            prior.cell.timeSeconds =
              callTs != null && tsMs(evt) != null ? Math.max(0, (tsMs(evt) - callTs) / 1000) : null;
          } else {
            // Orphan result (no matching tool_call captured) still gets a row.
            push({
              absTime: tsMs(evt), toolName: p.tool_name, callId,
              cell: {
                index: ++ctx.index, kind: "tool", text: p.tool_name || "tool",
                preview: isErr ? "✗ error" : trunc(p.content_text || "", 160),
                outputDetail: p.content_text || "", resultEvt: evt,
                timeSeconds: null, startedAt: tsMs(evt),
                callId, toolName: p.tool_name, isError: isErr,
                sourceEvt: evt,
              },
            }, curTitle);
          }
          break;
        }
        case "compaction": {
          push({
            absTime: tsMs(evt),
            cell: {
              index: ++ctx.index, kind: "compacted", text: "Context compacted",
              preview: p.summary_preview || "",
              inputDetail: p.summary_preview || "",
              detail: `reason: ${p.reason ?? "?"} · before: ${p.tokens_before ?? "?"} tk`,
              timeSeconds: 0, startedAt: tsMs(evt), sourceEvt: evt,
            },
          }, curTitle);
          break;
        }
        // Boundary / lifecycle markers and standalone thinking events render no
        // cell — turn boundaries drive grouping, and thinking is folded into the
        // assistant_message cell above.  agent_end is included only when it
        // carries a final_response that the assistant_message cells missed
        // (common for subagents whose last assistant message has no text, only
        // tool-call blocks).  agent_start is fully redundant with user_message.
        case "turn_start":
        case "turn_end":
        case "agent_start":
        case "thinking":
          break;
        case "agent_end": {
          if (!p.final_response) break; // nothing to add
          step++;
          curTitle = step === 1 ? "Message" : "Step " + step;
          push({
            absTime: tsMs(evt),
            cell: {
              index: ++ctx.index, kind: "message",
              text: trunc(p.final_response || "", 240),
              preview: p.final_response || "",
              timeSeconds: null, startedAt: tsMs(evt), sourceEvt: evt,
            },
          }, curTitle);
          break;
        }
        default: {
          // session_start / session_shutdown / model_change / branch_nav /
          // error / custom — rendered as dim Context cells so nothing is lost.
          push({
            absTime: tsMs(evt),
            cell: {
              index: ++ctx.index, kind: "context", text: summaryFor(evt),
              preview: "", timeSeconds: 0, startedAt: tsMs(evt), sourceEvt: evt,
            },
          }, curTitle);
          break;
        }
      }
    }

    return groups
      .map((g) => ({
        title: g.title,
        description: groupDescription(g.laid),
        cells: g.laid.map((l) => l.cell),
      }))
      .filter((g) => g.cells.length);
  }

  /** Wall-span duration + tool histogram, e.g. `1.5s bash×6`. */
  function groupDescription(laid) {
    const parts = [];
    const times = [];
    for (const l of laid) {
      if (l.absTime != null && Number.isFinite(l.absTime)) {
        times.push(l.absTime);
        if (l.cell.timeSeconds != null) times.push(l.absTime + l.cell.timeSeconds * 1000);
      }
    }
    if (times.length >= 2) {
      parts.push(fmtOwn((Math.max(...times) - Math.min(...times)) / 1000));
    } else if (times.length === 1) {
      const own = laid.find((l) => l.absTime === times[0])?.cell.timeSeconds;
      if (own != null) parts.push(fmtOwn(own));
    }
    const tools = new Map();
    for (const l of laid) {
      if (l.toolName) tools.set(l.toolName, (tools.get(l.toolName) ?? 0) + 1);
    }
    for (const [n, c] of tools) parts.push(c > 1 ? `${n}×${c}` : n);
    return parts.length ? parts.join(" · ") : "";
  }

  /**
   * Fold a full event list into turn → group → cell models. Returns turns
   * ordered by first appearance; turn === null marks "Between turns".
   */
  function deriveTrajectoryLayout(events) {
    const sorted = [...events].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    const ctx = { index: 0, systemCount: 0 };
    const buckets = buildTurnBuckets(sorted);
    const turns = [];

    for (const bucket of buckets) {
      const groups = foldBucket(bucket, ctx);
      if (!groups.length) continue;
      const turnIndex = bucket.turnIndex;
      turns.push({ turn: turnIndex, groups, setup: bucket.setup, turnEndUsage: bucket.turnEndUsage, turnEndTs: bucket.turnEndTs });
    }

    return turns;
  }

  // ─── Rendering ────────────────────────────────────────────────────────────

  function buildColumnHeader() {
    const row = document.createElement("div");
    row.className = "traj-row traj-colhead";
    row.innerHTML = `
      <span class="traj-col-idx">#</span>
      <span class="traj-col-kind">kind</span>
      <span class="traj-col-content">event</span>
      <span class="traj-col-time">time</span>
      <span class="traj-col-cost">cost</span>
      <span class="traj-col-in">in</span>
      <span class="traj-col-out">out</span>
    `;
    return row;
  }

  function turnWallSpan(turn) {
    const times = [];
    for (const g of turn.groups) {
      for (const c of g.cells) {
        if (c.startedAt != null && Number.isFinite(c.startedAt)) {
          times.push(c.startedAt);
          if (c.timeSeconds != null) times.push(c.startedAt + c.timeSeconds * 1000);
        }
      }
    }
    if (times.length === 0) return "";
    return fmtOwn((Math.max(...times) - Math.min(...times)) / 1000);
  }

  function buildTurnHead(turn) {
    const head = document.createElement("div");
    head.className = "traj-turn-head";
    const wall = turnWallSpan(turn);
    const usage = turn.turnEndUsage;
    const label = turn.turn != null ? "Turn " + turn.turn : "Between turns";
    const extra = [];
    if (wall) extra.push(wall);
    if (usage) {
      if (usage.input != null) extra.push(fmtTokens(usage.input) + " in");
      if (usage.output != null) extra.push(fmtTokens(usage.output) + " out");
    }
    head.innerHTML = `<span>${escapeHtml(label)}</span><span class="traj-turn-extra">${extra.map(escapeHtml).join(" · ")}</span>`;
    return head;
  }

  function buildGroupHead(group) {
    const head = document.createElement("div");
    head.className = "traj-group-head";
    head.innerHTML = `<span class="traj-group-title">${escapeHtml(group.title)}</span><span class="traj-group-desc">${escapeHtml(group.description || "")}</span>`;
    return head;
  }

  function cellContent(cell) {
    switch (cell.kind) {
      case "user": {
        const t = trunc(cell.preview || cell.text, 240);
        return escapeHtml(t || "");
      }
      case "message": {
        const t = trunc(cell.preview || cell.text, 500);
        return t ? escapeHtml(t) : `<span class="dim">tool call only</span>`;
      }
      case "tool": {
        const args = cell.preview && cell.preview !== cell.text ? trunc(cell.preview, 140) : "";
        const name = `<span class="traj-tool-name">${escapeHtml(cell.toolName || cell.text || "tool")}</span>`;
        const argSpan = args ? ` <span class="dim">${escapeHtml(args)}</span>` : "";
        const err = cell.isError ? ` <span class="traj-err">✗</span>` : "";
        const result = cell.resultPreview && !cell.isError ? ` <span class="dim">← ${escapeHtml(trunc(cell.resultPreview, 120))}</span>` : "";
        return name + argSpan + err + result;
      }
      case "request": {
        const t = trunc(cell.text || "", 160);
        return t ? `<span class="dim">🡅 ${escapeHtml(t)}</span>` : "";
      }
      case "system":
      case "compacted":
      case "context":
      default: {
        const t = trunc(cell.text || "", 240);
        return t ? `<span class="dim">${escapeHtml(t)}</span>` : "";
      }
    }
  }

  function timeCell(cell) {
    if (cell.kind === "message" || cell.kind === "tool") return fmtOwn(cell.timeSeconds);
    return "";
  }

  function cellRowClass(cell) {
    const cls = ["traj-row", "traj-" + cell.kind];
    if (cell.isError) cls.push("is-error");
    if (cell.kind === "request") cls.push("dim");
    if (cell.index === selectedIndex) cls.push("selected");
    return cls.join(" ");
  }

  /** A dispatch_agent(s) call renders as a row of chips — one per subagent it
   *  spawned — that jump straight to that subagent's section below. */
  function buildDispatchRow(cell) {
    const row = document.createElement("div");
    row.className = "traj-row traj-dispatch";
    row.dataset.index = cell.index;
    const chips = cell.subs.map((s) =>
      `<button type="button" class="traj-disp-chip" data-goto="${escapeHtml(s.sid)}"`
      + ` title="${escapeHtml(s.task || s.sid)}">↳ ${escapeHtml(s.name)}</button>`
    ).join("");
    row.innerHTML = `
      <span class="traj-col-idx">#${cell.index}</span>
      <span class="traj-col-kind">Dispatch</span>
      <span class="traj-col-content traj-disp-list">${chips}</span>
      <span class="traj-col-time"></span>
      <span class="traj-col-cost"></span>
      <span class="traj-col-in"></span>
      <span class="traj-col-out"></span>
    `;
    row.querySelectorAll(".traj-disp-chip").forEach((btn) => {
      btn.addEventListener("click", (e) => { e.stopPropagation(); gotoAgent(btn.dataset.goto); });
    });
    return row;
  }

  /** Scroll to a subagent's section (expanding it first) and flash it. */
  function gotoAgent(sid) {
    const el = ledger.querySelector(`.traj-agent[data-sid="${sid}"]`);
    if (!el) return;
    if (el.classList.contains("collapsed")) el.querySelector(".traj-agent-head")?.click();
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 1200);
  }

  function buildRow(cell) {
    if (cell.kind === "dispatch") return buildDispatchRow(cell);
    let cost = "";
    if (cell.kind === "message" && cell.sourceEvt?.payload?.usage?.cost_total != null) {
      cost = "$" + cell.sourceEvt.payload.usage.cost_total.toFixed(5);
    }
    const row = document.createElement("div");
    row.className = cellRowClass(cell);
    row.dataset.index = cell.index;
    const title = escapeHtml(trunc(cell.preview || cell.text || "", 400));
    row.innerHTML = `
      <span class="traj-col-idx">#${cell.index}</span>
      <span class="traj-col-kind">${escapeHtml(kindLabel(cell.kind))}</span>
      <span class="traj-col-content" title="${title}">${cellContent(cell)}</span>
      <span class="traj-col-time">${timeCell(cell)}</span>
      <span class="traj-col-cost">${escapeHtml(cost)}</span>
      <span class="traj-col-in">${cell.kind === "message" && cell.input != null ? fmtTokens(cell.input) : ""}</span>
      <span class="traj-col-out">${cell.kind === "message" && cell.output != null ? fmtTokens(cell.output) : ""}</span>
    `;
    row.addEventListener("click", () => openInspector(cell));
    return row;
  }

  function renderInspectorBody(cell) {
    const evt = cell.sourceEvt;
    const metaRows = [];
    metaRows.push(`<span>kind</span><span>${escapeHtml(kindLabel(cell.kind))}</span>`);
    if (cell.startedAt != null) metaRows.push(`<span>start</span><span>${escapeHtml(fmtTs(new Date(cell.startedAt).toISOString()))}</span>`);
    metaRows.push(`<span>time</span><span>${cell.kind === "message" || cell.kind === "tool" ? fmtOwn(cell.timeSeconds) : "—"}</span>`);
    if (evt) metaRows.push(`<span>seq</span><span>#${evt.seq}</span>`);
    if (cell.kind === "message") {
      metaRows.push(`<span>in</span><span>${cell.input != null ? fmtTokens(cell.input) : "—"}${cell.cacheRead != null ? ` · ${fmtTokens(cell.cacheRead)} cache r` : ""}${cell.cacheWrite != null ? ` · ${fmtTokens(cell.cacheWrite)} cache w` : ""}</span>`);
      metaRows.push(`<span>out</span><span>${cell.output != null ? fmtTokens(cell.output) : "—"}</span>`);
      if (cell.prefillMs != null || cell.generationMs != null) {
        metaRows.push(`<span>timing</span><span>prefill ${fmtMs(cell.prefillMs)} · gen ${fmtMs(cell.generationMs)}</span>`);
      }
    }
    if (cell.detail) metaRows.push(`<span>meta</span><span>${escapeHtml(cell.detail)}</span>`);

    const secBtn = (id, label) => `<button class="traj-sec-copy" type="button" data-target="${id}" title="Copy ${label}">📋</button>`;
    // Content sections are collapsed by default; clicking a header expands it.
    const sec = (id, label, body) =>
      `<section class="traj-detail-section traj-sec-collapsed" data-sec="${id}"><h4 class="traj-sec-head" role="button" tabindex="0" aria-expanded="false"><span class="traj-sec-caret">▸</span>${label} ${secBtn(id, label.toLowerCase())}</h4><pre id="${id}" hidden>${body}</pre></section>`;

    const sections = [];
    if (cell.inputDetail) sections.push(sec("traj-input", "Input", escapeHtml(cell.inputDetail)));
    if (cell.thinking) sections.push(sec("traj-thinking", "Thinking", escapeHtml(cell.thinking)));
    if (cell.outputDetail) sections.push(sec("traj-output", "Output", escapeHtml(cell.outputDetail)));
    else if (cell.kind === "message" && cell.preview) sections.push(sec("traj-output", "Output", escapeHtml(cell.preview)));

    const raw = [];
    if (evt) raw.push(evt);
    if (cell.resultEvt && cell.resultEvt !== evt) raw.push(cell.resultEvt);
    const rawJson = raw.length ? safeJson(raw.length === 1 ? raw[0].payload : raw.map((e) => ({ type: e.type, ts: e.ts, seq: e.seq, payload: e.payload }))) : "{}";

    return `
      <div class="traj-detail-meta">${metaRows.join("")}</div>
      ${sections.join("")}
      ${sec("traj-raw", "Raw", escapeHtml(rawJson))}
    `;
  }

  function toggleSection(section) {
    if (!section) return;
    const collapsed = section.classList.toggle("traj-sec-collapsed");
    const pre = section.querySelector("pre");
    const caret = section.querySelector(".traj-sec-caret");
    const head = section.querySelector(".traj-sec-head");
    if (pre) pre.hidden = collapsed;
    if (caret) caret.textContent = collapsed ? "▸" : "▾";
    if (head) head.setAttribute("aria-expanded", String(!collapsed));
  }

  function wireInspectorInteractions() {
    if (!inspectorBody) return;
    inspectorBody.querySelectorAll(".traj-sec-copy").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const pre = inspectorBody.querySelector("#" + btn.dataset.target);
        if (pre) navigator.clipboard?.writeText(pre.textContent).catch(() => {});
      });
    });
    inspectorBody.querySelectorAll(".traj-sec-head").forEach((head) => {
      const section = head.parentElement;
      head.addEventListener("click", () => toggleSection(section));
      head.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleSection(section); }
      });
    });
  }

  function showInspector(cell) {
    if (!inspector || !inspectorTitle || !inspectorBody) return;
    inspectorTitle.textContent = `#${cell.index} · ${kindLabel(cell.kind)}${cell.toolName ? " · " + cell.toolName : ""}`;
    inspectorBody.innerHTML = renderInspectorBody(cell);
    wireInspectorInteractions();
    inspector.setAttribute("aria-hidden", "false");
  }

  function openInspector(cell) {
    selectedIndex = cell.index;
    ledger.querySelectorAll(".traj-row").forEach((r) => {
      r.classList.toggle("selected", r.dataset.index === String(cell.index));
    });
    if (inspectorWrap) inspectorWrap.textContent = "↩";
    showInspector(cell);
  }

  function refreshInspector(cells) {
    if (selectedIndex == null) return;
    const cell = cells.find((c) => c.index === selectedIndex);
    if (!cell) { closeInspector(); return; }
    showInspector(cell);
  }

  function closeInspector() {
    selectedIndex = null;
    ledger.querySelectorAll(".traj-row.selected").forEach((r) => r.classList.remove("selected"));
    if (!inspector || !inspectorTitle || !inspectorBody) return;
    inspectorTitle.textContent = "Select a record";
    inspectorBody.innerHTML = '<div class="traj-inspector-empty">Click a record in the ledger to inspect its tokens, duration, Input, Output, and Timing.</div>';
    inspector.setAttribute("aria-hidden", "true");
  }

  function scrollToBottom() {
    if (!ledger) return;
    const go = () => { ledger.scrollTop = ledger.scrollHeight; };
    go();
    requestAnimationFrame(go);
  }

  function matchesSearch(cell, q) {
    if (!q) return true;
    const hay = [
      cell.text, cell.preview, cell.thinking, cell.outputDetail, cell.inputDetail,
      cell.toolName, cell.kind, cell.resultPreview,
    ].filter(Boolean).join("\n").toLowerCase();
    return hay.includes(q);
  }

  function updateLabel() {
    if (!label) return;
    const ws = session?.cwd || currentWorkspace();
    const base = ws ? (ws.split("/").filter(Boolean).pop() || ws) : "trajectory";
    const n = familyMeta.length;
    label.textContent = n > 1 ? `${base} · ${n} agents` : `${base} · trajectory`;
    label.title = familyRoot
      ? familyRoot + (n > 1 ? ` (+${n - 1} subagent${n - 1 === 1 ? "" : "s"})` : "")
      : "";
  }

  /** Re-index one session's cells with globally unique numbers (root + subs
   *  share one inspector, so `#N` must stay unique across the whole family). */
  function indexLayout(layout, sid, agentName, counter) {
    for (const turn of layout) {
      for (const g of turn.groups) {
        for (const c of g.cells) {
          c.index = ++counter.n;
          c.agentSid = sid;
          c.agentName = agentName;
        }
      }
    }
    return layout;
  }

  function layoutCells(layout) {
    return layout.flatMap((t) => t.groups.flatMap((g) => g.cells));
  }

  /** Append a layout's turn/group/row rows, honouring search + kind filters. */
  function appendLayoutRows(container, layout, q) {
    let visible = 0;
    for (const turn of layout) {
      const matchingGroups = turn.groups
        .map((g) => ({ group: g, cells: g.cells.filter((c) => matchesSearch(c, q) && !hideKinds.has(c.kind)) }))
        .filter((x) => x.cells.length);
      if (!matchingGroups.length) continue;
      container.appendChild(buildTurnHead(turn));
      for (const { group, cells } of matchingGroups) {
        container.appendChild(buildGroupHead(group));
        for (const cell of cells) { visible++; container.appendChild(buildRow(cell)); }
      }
    }
    return visible;
  }

  /** One collapsible subagent section: header (agent · model · counts) + its
   *  own turn/step ledger, rendered inline under the parent session. */
  function buildAgentSection(meta, layout, q, counts) {
    const s = meta.session;
    const cells = layoutCells(layout);
    const shown = cells.filter((c) => matchesSearch(c, q) && !hideKinds.has(c.kind)).length;
    if (!shown && (q || hideKinds.size)) return null; // filtered out entirely

    const wrapper = document.createElement("div");
    wrapper.className = "traj-agent";
    wrapper.dataset.sid = meta.sid;
    if (meta.depth > 1) wrapper.style.marginLeft = Math.min(meta.depth - 1, 4) * 16 + "px";
    const collapsed = collapsedAgents.has(meta.sid);
    wrapper.classList.toggle("collapsed", collapsed);

    const times = cells.filter((c) => c.startedAt != null && Number.isFinite(c.startedAt)).map((c) => c.startedAt);
    const dur = times.length >= 2 ? fmtOwn((Math.max(...times) - Math.min(...times)) / 1000) : "";
    const stats = STATE.sessionStats?.[meta.sid];
    const metaParts = [
      s?.model || "",
      shown + (shown !== cells.length ? ` / ${cells.length}` : "") + " records",
      stats ? fmtTokens(stats.total_tokens) + " tk" : "",
      dur,
    ].filter(Boolean);

    const head = document.createElement("div");
    head.className = "traj-agent-head " + (O.subagentStatus ? O.subagentStatus(s) : "gray");
    head.setAttribute("role", "button");
    head.setAttribute("tabindex", "0");
    head.setAttribute("aria-expanded", String(!collapsed));
    head.title = meta.sid;
    head.innerHTML =
      `<span class="traj-agent-caret">${collapsed ? "▸" : "▾"}</span>` +
      `<span class="traj-agent-name">${escapeHtml(agentLabel(s, meta.sid))}</span>` +
      `<span class="traj-agent-tag">subagent${meta.depth > 1 ? " · depth " + meta.depth : ""}</span>` +
      `<span class="traj-agent-meta">${escapeHtml(metaParts.join(" · "))}</span>`;
    head.addEventListener("click", () => {
      const now = wrapper.classList.toggle("collapsed");
      head.setAttribute("aria-expanded", String(!now));
      const caret = head.querySelector(".traj-agent-caret");
      if (caret) caret.textContent = now ? "▸" : "▾";
      if (now) collapsedAgents.add(meta.sid); else collapsedAgents.delete(meta.sid);
      saveCollapsedAgents();
    });
    head.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); head.click(); }
    });

    const body = document.createElement("div");
    body.className = "traj-agent-body";
    counts.visible += appendLayoutRows(body, layout, q);

    wrapper.appendChild(head);
    wrapper.appendChild(body);
    return wrapper;
  }

  function render() {
    if (!ledger) return;
    linkDispatches();
    const counter = { n: 0 };
    const rootLayout = indexLayout(injectDispatchRows(deriveTrajectoryLayout(evts)), familyRoot, agentLabel(session, familyRoot), counter);
    const agentLayouts = [];
    for (const m of familyMeta) {
      if (m.sid === familyRoot) continue;
      const sub = subEvents.get(m.sid) || [];
      if (!sub.length) continue;
      agentLayouts.push({ meta: m, layout: indexLayout(deriveTrajectoryLayout(sub), m.sid, agentLabel(m.session, m.sid), counter) });
    }
    const allCells = layoutCells(rootLayout).concat(agentLayouts.flatMap((a) => layoutCells(a.layout)));
    buildTimeline(allCells);

    const q = search.trim().toLowerCase();
    const counts = { visible: 0, total: allCells.length };

    const frag = document.createDocumentFragment();
    frag.appendChild(buildColumnHeader());
    counts.visible += appendLayoutRows(frag, rootLayout, q);
    for (const a of agentLayouts) {
      const sec = buildAgentSection(a.meta, a.layout, q, counts);
      if (sec) frag.appendChild(sec);
    }

    ledger.innerHTML = "";
    ledger.appendChild(frag);
    refreshInspector(allCells);

    if (statsEl) {
      const records = q ? `${counts.visible} / ${counts.total} records` : `${counts.total} records`;
      const agents = familyMeta.length > 1 ? ` · ${familyMeta.length} agents` : "";
      statsEl.textContent = (costStr ? costStr + " · " : "") + records + agents;
    }
    updateLabel();
    if (stickToBottom) scrollToBottom();
    updateEmpty();
  }

  // ─── Timeline (one lane per agent) ────────────────────────────────────────
  // The orchestrator and every subagent get their own horizontal lane on a
  // shared time axis, so it is immediately clear who was working when and how
  // long each agent ran. Bars are colour-coded by record kind and a dispatch
  // call draws a line down to the lane of each subagent it spawned.

  const LANE_H = 20;
  const LANE_LABEL_W = 108;
  const TL_PAD = 6;

  function buildTimeline(cells) {
    if (!overview) return;
    const timed = cells.filter((c) => c.startedAt != null && Number.isFinite(c.startedAt));
    if (!timed.length) { overview.innerHTML = ""; overview.style.display = "none"; return; }
    overview.style.display = "";

    // Lane order: orchestrator (root) first, then subagents in family order.
    const order = [];
    const seen = new Set();
    for (const sid of [familyRoot, ...familyMeta.map((m) => m.sid)]) {
      if (sid && !seen.has(sid)) { seen.add(sid); order.push(sid); }
    }
    const lanes = new Map();
    for (const sid of order) lanes.set(sid, []);
    for (const c of timed) {
      const sid = c.agentSid || familyRoot;
      if (!lanes.has(sid)) { lanes.set(sid, []); order.push(sid); }
      lanes.get(sid).push(c);
    }
    const used = order.filter((sid) => (lanes.get(sid) || []).length);

    let minT = Infinity, maxT = -Infinity;
    for (const c of timed) {
      const dur = c.timeSeconds != null ? c.timeSeconds * 1000 : 0;
      minT = Math.min(minT, c.startedAt);
      maxT = Math.max(maxT, c.startedAt + dur);
    }
    if (!Number.isFinite(minT) || !Number.isFinite(maxT) || maxT <= minT) maxT = minT + 1;
    const span = maxT - minT;

    const canvas = document.createElement("div");
    canvas.className = "tov-canvas";
    canvas.style.height = (TL_PAD * 2 + used.length * LANE_H) + "px";

    // Each lane is a full-width track offset past the label gutter, so bar
    // left/width are plain percentages of the shared time axis.
    const laneY = new Map();
    const trackFor = new Map();
    used.forEach((sid, i) => {
      const y = TL_PAD + i * LANE_H;
      laneY.set(sid, y);
      const lab = document.createElement("div");
      lab.className = "tov-lane-label";
      const meta = familyMeta.find((m) => m.sid === sid);
      lab.textContent = agentLabel(meta?.session || session, sid);
      lab.title = sid;
      lab.style.top = y + "px";
      lab.style.height = LANE_H + "px";
      lab.style.lineHeight = LANE_H + "px";
      lab.style.width = LANE_LABEL_W + "px";
      canvas.appendChild(lab);
      const track = document.createElement("div");
      track.className = "tov-track";
      track.style.top = y + "px";
      track.style.height = LANE_H + "px";
      track.style.left = LANE_LABEL_W + "px";
      canvas.appendChild(track);
      trackFor.set(sid, track);
    });

    const leftPct = (t) => (t - minT) / span;

    // Dispatch connectors first, so bars paint over them.
    for (const c of timed) {
      if (c.kind !== "dispatch" || !c.subs) continue;
      const fromY = (laneY.get(c.agentSid || familyRoot) ?? 0) + LANE_H - 3;
      const x = leftPct(c.startedAt) * 100;
      for (const s of c.subs) {
        const y = laneY.get(s.sid);
        if (y == null) continue;
        const toY = y + 4;
        const el = document.createElement("div");
        el.className = "tov-link";
        el.style.left = `calc(${LANE_LABEL_W}px + ${x.toFixed(4)}%)`;
        el.style.top = Math.min(fromY, toY) + "px";
        el.style.height = Math.abs(toY - fromY) + "px";
        el.title = `dispatch → ${s.name}`;
        canvas.appendChild(el);
      }
    }

    for (const sid of used) {
      const track = trackFor.get(sid);
      const y = laneY.get(sid);
      for (const c of lanes.get(sid)) {
        const dur = c.timeSeconds != null ? c.timeSeconds * 1000 : 0;
        const bar = document.createElement("div");
        bar.className = "tov-bar tov-" + c.kind;
        bar.style.left = (leftPct(c.startedAt) * 100).toFixed(4) + "%";
        bar.style.width = "max(3px, " + (dur / span * 100).toFixed(4) + "%)";
        bar.style.top = (c.kind === "message" ? 2 : 8) + "px";
        bar.style.height = (c.kind === "message" ? 9 : 5) + "px";
        bar.dataset.index = c.index;
        void y;

        if (c.kind === "message" && c.prefillMs != null && dur > 0) {
          const seg = document.createElement("span");
          seg.className = "tov-seg";
          seg.style.width = Math.min(100, (c.prefillMs / dur) * 100).toFixed(2) + "%";
          bar.appendChild(seg);
        }

        bar.title = `#${c.index} ${kindLabel(c.kind)} · ${fmtTs(new Date(c.startedAt).toISOString())} · ${fmtOwn(c.timeSeconds)}`;
        bar.addEventListener("click", () => {
          const row = ledger.querySelector(`.traj-row[data-index="${c.index}"]`);
          if (row) row.scrollIntoView({ block: "center", behavior: "smooth" });
        });
        track.appendChild(bar);
      }
    }

    const legend = document.createElement("div");
    legend.className = "tov-legend";
    legend.innerHTML =
      `<span><span class="tov-sw message"></span>message</span>`
      + `<span><span class="tov-sw tool"></span>tool</span>`
      + `<span><span class="tov-sw dispatch"></span>dispatch</span>`
      + `<span><span class="tov-sw other"></span>context</span>`
      + `<span style="margin-left:auto">${used.length} agent lane${used.length === 1 ? "" : "s"} · shared time axis</span>`;

    overview.innerHTML = "";
    overview.appendChild(canvas);
    overview.appendChild(legend);
  }

  function updateEmpty() {
    if (!ledger) return;
    const empty = ledger.querySelector(".traj-empty");
    if (evts.length || empty) return;
    const msg = loading
      ? "Loading session…"
      : familyRoot
        ? "No events recorded for this session yet"
        : `No sessions in ${escapeHtml(currentWorkspace() || "this workspace")} yet`;
    ledger.innerHTML = `<div class="empty-state traj-empty"><span class="icon">⛓</span>${msg}</div>`;
    if (statsEl) statsEl.textContent = "";
    if (overview) overview.style.display = "none";
    if (label && !familyRoot) label.textContent = "trajectory";
  }

  /** No session exists for the current workspace — show that instead of a
   *  stale tree from another workspace. */
  function showWorkspaceEmpty() {
    familyRoot = null;
    selectedSid = null;
    familyMeta = [];
    familySids = new Set();
    subEvents = new Map();
    evts = [];
    lastSeq = -1;
    loading = false;
    session = null;
    costStr = "";
    closeInspector();
    if (overview) overview.style.display = "none";
    if (statsEl) statsEl.textContent = "";
    if (label) {
      const ws = currentWorkspace();
      label.textContent = ws ? (ws.split("/").filter(Boolean).pop() || ws) + " · trajectory" : "trajectory";
      label.title = ws;
    }
    if (ledger) {
      ledger.innerHTML = `<div class="empty-state traj-empty"><span class="icon">⛓</span>`
        + `No sessions in ${escapeHtml(currentWorkspace() || "this workspace")} yet</div>`;
    }
  }

  // ─── Workspace-scoped agent families ──────────────────────────────────────

  function isMemorySummarizer(s) {
    return (s?.agent_name || "").toLowerCase() === "memory-summarizer";
  }

  function recency(s) {
    const t = Date.parse(s?.last_ts || s?.first_ts || "");
    return Number.isFinite(t) ? t : 0;
  }

  /** The workspace the user is in: the terminal cwd, or the newest session's. */
  function currentWorkspace() {
    if (STATE.cwd) return STATE.cwd;
    let best = null;
    for (const s of (STATE.sessions || [])) if (!best || recency(s) > recency(best)) best = s;
    return best?.cwd || "";
  }

  function workspaceSessions(ws) {
    const want = ws || "";
    return (STATE.sessions || []).filter((s) => (s.cwd || "") === want && !isMemorySummarizer(s));
  }

  function agentLabel(s, sid) {
    return s?.agent_name || (s?.cwd ? s.cwd.split("/").filter(Boolean).pop() : "") || (sid ? shortId(sid) : "agent");
  }

  /** Newest top-level session in `ws` (falls back to any session there). */
  function latestRootSession(ws) {
    const all = workspaceSessions(ws);
    if (!all.length) return null;
    const roots = all.filter((s) => !s.parent_session_id);
    return (roots.length ? roots : all).slice().sort((a, b) => recency(b) - recency(a))[0];
  }

  /** Depth-first list of a session's descendants (subagents), chronological. */
  function descendantsOf(rootSid) {
    const byParent = new Map();
    for (const s of (STATE.sessions || [])) {
      if (!s.parent_session_id) continue;
      const arr = byParent.get(s.parent_session_id);
      if (arr) arr.push(s); else byParent.set(s.parent_session_id, [s]);
    }
    const out = [];
    const seen = new Set([rootSid]);
    const walk = (pid, depth) => {
      const kids = (byParent.get(pid) || []).slice().sort((a, b) => recency(a) - recency(b));
      for (const k of kids) {
        if (seen.has(k.session_id)) continue;
        seen.add(k.session_id);
        out.push({ sid: k.session_id, session: k, depth });
        walk(k.session_id, depth + 1);
      }
    };
    walk(rootSid, 1);
    return out;
  }

  function familyFor(rootSid) {
    const root = (STATE.sessions || []).find((s) => s.session_id === rootSid) || null;
    return [{ sid: rootSid, session: root, depth: 0 }].concat(descendantsOf(rootSid));
  }

  // ─── Dispatch linkage ─────────────────────────────────────────────────────
  // A dispatch_agent(s) call names its targets in args.tasks[].agent, and the
  // spawned session is a child of the calling session whose agent_name matches.
  // Pair them by agent name (skipping children already claimed by an earlier
  // call of the same name) so each dispatch row can link to its subagents.

  const DISPATCH_TOOL_RE = /dispatch|spawn|task|subagent/i;
  let dispatchByCall = new Map(); // tool_call_id -> [{ sid, name, task }]
  let dispatchBySid = new Map();  // sid -> { sid, name, task }

  function isDispatchTool(name) {
    return !!name && DISPATCH_TOOL_RE.test(name);
  }

  function dispatchTargets(payload) {
    const args = payload?.args;
    if (!args) return [];
    const list = Array.isArray(args.tasks) ? args.tasks
      : Array.isArray(args.agents) ? args.agents
      : args.agent ? [args] : [];
    return list.map((t) => ({
      name: String(t?.agent ?? t?.agent_name ?? t?.name ?? ""),
      task: String(t?.task ?? t?.prompt ?? t?.message ?? ""),
    })).filter((t) => t.name);
  }

  /** Recompute the call_id → subagents map for the loaded family. */
  function linkDispatches() {
    dispatchByCall = new Map();
    dispatchBySid = new Map();
    const children = familyMeta.filter((m) => m.sid !== familyRoot);
    const used = new Set();
    // Walk root events in order so a later call of the same agent name takes
    // the next unconsumed child (dispatch order ≈ spawn order).
    const calls = evts.filter((e) => e.type === "tool_call" && isDispatchTool(e.payload?.tool_name));
    for (const call of calls) {
      const callId = call.payload?.tool_call_id;
      if (!callId) continue;
      const targets = dispatchTargets(call.payload);
      if (!targets.length) continue;
      const links = [];
      for (const t of targets) {
        const child = children.find((m) => !used.has(m.sid)
          && (m.session?.agent_name || "").toLowerCase() === t.name.toLowerCase());
        if (child) {
          used.add(child.sid);
          const link = { sid: child.sid, name: t.name, task: t.task };
          links.push(link);
          dispatchBySid.set(child.sid, link);
        } else {
          links.push({ sid: null, name: t.name, task: t.task });
        }
      }
      dispatchByCall.set(callId, links);
    }
  }

  /** Insert a synthetic dispatch cell right after each dispatch tool cell, so
   *  the call renders as a row of links to the subagents it spawned. */
  function injectDispatchRows(layout) {
    for (const turn of layout) {
      for (const g of turn.groups) {
        const out = [];
        for (const c of g.cells) {
          out.push(c);
          if (c.kind !== "tool" || !isDispatchTool(c.toolName) || !c.callId) continue;
          const subs = dispatchByCall.get(c.callId);
          if (!subs || !subs.length) continue;
          out.push({
            index: 0, kind: "dispatch", subs,
            startedAt: c.startedAt, timeSeconds: c.timeSeconds,
            sourceEvt: c.sourceEvt, agentSid: c.agentSid, agentName: c.agentName,
          });
        }
        g.cells = out;
      }
    }
    return layout;
  }

  // ─── Data loading / SSE ───────────────────────────────────────────────────

  const MAX_FAMILY = 80; // sessions loaded for one family (root + subagents)

  /** Load a root session plus every subagent spawned under it, then render. */
  async function selectGroup(rootSid) {
    const token = ++loadToken;
    familyRoot = rootSid;
    selectedSid = rootSid;
    familyMeta = familyFor(rootSid).slice(0, MAX_FAMILY);
    familySids = new Set(familyMeta.map((m) => m.sid));
    subEvents = new Map();
    evts = [];
    lastSeq = -1;
    search = "";
    closeInspector();
    if (searchBox) searchBox.value = "";
    session = familyMeta[0]?.session ?? null;
    const stats = STATE.sessionStats[rootSid];
    costStr = stats ? `$${stats.total_cost.toFixed(4)} · ${fmtTokens(stats.total_tokens)} tk` : "";
    loading = true;
    render();

    const results = await Promise.all(familyMeta.map(async (m) => {
      try { return [m.sid, await fetchSessionEvents(m.sid)]; }
      catch { return [m.sid, []]; }
    }));
    if (loadToken !== token) return; // a newer selection superseded this load
    for (const [sid, events] of results) {
      const list = events || [];
      if (sid === rootSid) {
        evts = list;
        lastSeq = list.length ? list[list.length - 1].seq : -1;
      } else {
        subEvents.set(sid, list);
      }
    }
    loading = false;
    prune();
    render();
  }

  function prune() {
    if (evts.length <= MAX_EVENTS) return;
    evts.splice(0, evts.length - MAX_EVENTS);
  }

  /** Pick up subagents that appeared since the family was loaded. */
  async function refreshFamily() {
    if (!familyRoot) return false;
    const next = familyFor(familyRoot).slice(0, MAX_FAMILY);
    const changed = next.length !== familyMeta.length || next.some((m, i) => familyMeta[i]?.sid !== m.sid);
    const missing = next.filter((m) => m.sid !== familyRoot && !subEvents.has(m.sid));
    familyMeta = next;
    familySids = new Set(next.map((m) => m.sid));
    session = next[0]?.session ?? session;
    if (!missing.length) return changed;
    const results = await Promise.all(missing.map(async (m) => {
      try { return [m.sid, await fetchSessionEvents(m.sid)]; } catch { return [m.sid, []]; }
    }));
    for (const [sid, list] of results) subEvents.set(sid, list || []);
    return true;
  }

  async function resync() {
    if (!familyRoot) return;
    const token = loadToken;
    if (lastSeq >= 0) {
      const newer = await fetchSessionEvents(familyRoot, lastSeq);
      if (loadToken !== token) return;
      for (const e of (newer || [])) if (e.seq > lastSeq) { evts.push(e); lastSeq = e.seq; }
    }
    for (const m of familyMeta) {
      if (m.sid === familyRoot) continue;
      const arr = subEvents.get(m.sid) || [];
      const seq = arr.length ? arr[arr.length - 1].seq : -1;
      const newer = await fetchSessionEvents(m.sid, seq);
      if (loadToken !== token) return;
      if (newer?.length) subEvents.set(m.sid, arr.concat(newer.filter((e) => e.seq > seq)));
    }
    prune();
    render();
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  // ─── Hooks called from app.js ─────────────────────────────────────────────

  // Opening the view follows the workspace automatically. A session explicitly
  // picked in the sidebar still wins, but with nothing selected we show the
  // newest session in the current cwd together with its whole agent tree.
  window.__trajectoryOnView = function () {
    const manual = STATE.selectedSessionId;
    if (manual) {
      if (manual !== familyRoot) selectGroup(manual);
      else refreshFamily().then((changed) => { if (changed) render(); });
      return;
    }
    const latest = latestRootSession(currentWorkspace());
    if (!latest) { showWorkspaceEmpty(); return; }
    if (latest.session_id !== familyRoot) selectGroup(latest.session_id);
    else refreshFamily().then((changed) => { if (changed) render(); });
  };

  window.__trajectoryOnSessions = function () {
    // Nothing shown yet (e.g. the view was opened before the first /sessions
    // response landed, so the boot hook found no session): adopt the newest
    // session in the workspace now that the list exists.
    if (!familyRoot) { window.__trajectoryOnView(); return; }
    session = (STATE.sessions || []).find((s) => s.session_id === familyRoot) ?? session;
    // Auto mode (no explicit sidebar pick): keep following the newest session
    // in the workspace, and pull in any subagents that have appeared since.
    if (!STATE.selectedSessionId) {
      const latest = latestRootSession(currentWorkspace());
      if (latest && latest.session_id !== familyRoot) { selectGroup(latest.session_id); return; }
    }
    refreshFamily().then((changed) => { if (changed) render(); else updateLabel(); });
  };

  window.__trajectoryOnEvent = function (evt) {
    if (!familySids.has(evt.session_id)) return;
    if (evt.session_id === familyRoot) {
      if (evt.seq <= lastSeq) return;
      evts.push(evt);
      lastSeq = evt.seq;
      prune();
    } else {
      const arr = subEvents.get(evt.session_id) || [];
      if (arr.length && evt.seq <= arr[arr.length - 1].seq) return;
      arr.push(evt);
      subEvents.set(evt.session_id, arr);
    }
    scheduleRender();
  };

  window.__trajectoryOnReconnect = function () { resync(); };

  window.__trajectoryStatsUpdate = function (sid, stats) {
    if (sid === familyRoot) {
      costStr = `$${stats.total_cost.toFixed(4)} · ${fmtTokens(stats.total_tokens)} tk`;
    }
    if (familySids.has(sid)) scheduleRender();
  };

  window.__trajectoryClear = function () {
    familyRoot = null;
    selectedSid = null;
    familyMeta = [];
    familySids = new Set();
    subEvents = new Map();
    evts = [];
    lastSeq = -1;
    session = null;
    loading = false;
    costStr = "";
    if (searchBox) searchBox.value = "";
    search = "";
    closeInspector();
    render();
  };

  window.__trajectoryIsSelected = (sid) => familySids.has(sid);

  // ─── Boot ─────────────────────────────────────────────────────────────────
  // app.js runs setView() and the first /sessions fetch before this script
  // loads, so neither hook fires for the initial URL-hash view. Adopt the
  // workspace's newest session as soon as the session list is available —
  // otherwise the pane sits empty until the next 10s sessions poll.
  if (STATE.view === "trajectory") {
    let tries = 0;
    const boot = () => {
      if (STATE.sessionsLoaded || tries++ > 100) { window.__trajectoryOnView(); return; }
      setTimeout(boot, 100);
    };
    boot();
  }

  // ─── Local event wiring ───────────────────────────────────────────────────

  if (ledger) {
    ledger.addEventListener("scroll", () => {
      const atBottom = ledger.scrollHeight - ledger.scrollTop - ledger.clientHeight < 40;
      if (!atBottom && stickToBottom) {
        stickToBottom = false;
        if (pauseToast) pauseToast.classList.add("show");
      } else if (atBottom && !stickToBottom) {
        stickToBottom = true;
        if (pauseToast) pauseToast.classList.remove("show");
      }
    });
  }

  window.resumeTrajectoryScroll = function () {
    stickToBottom = true;
    scrollToBottom();
    if (pauseToast) pauseToast.classList.remove("show");
  };

  if (searchBox) {
    searchBox.addEventListener("input", () => {
      search = searchBox.value.trim();
      render();
    });
    document.addEventListener("keydown", (e) => {
      if (STATE.view === "trajectory" && e.key === "/" && document.activeElement !== searchBox) {
        e.preventDefault();
        searchBox.focus();
      }
    });
  }

  function buildTrajectoryFilterChips() {
    if (!filterChips) return;
    filterChips.innerHTML = "";
    const kinds = [
      { label: "requests", kind: "request", title: "Hide LLM request rows" },
      { label: "context", kind: "context", title: "Hide context/lifecycle rows" },
      { label: "system", kind: "system", title: "Hide system/compaction rows" },
    ];
    for (const k of kinds) {
      const chip = document.createElement("span");
      const on = hideKinds.has(k.kind);
      chip.className = "fchip" + (on ? " on" : "");
      chip.textContent = on ? "no " + k.label : k.label;
      chip.title = k.title;
      chip.addEventListener("click", () => {
        if (on) hideKinds.delete(k.kind); else hideKinds.add(k.kind);
        buildTrajectoryFilterChips();
        render();
      });
      filterChips.appendChild(chip);
    }
  }
  buildTrajectoryFilterChips();

  if (inspectorClose) inspectorClose.addEventListener("click", closeInspector);

  // Resizable right inspector: drag the gutter to resize, persisted locally.
  if (resizer && inspector) {
    try {
      const saved = localStorage.getItem("scope-trajectory-inspector-width");
      if (saved && /^\d+px$/.test(saved)) inspector.style.width = saved;
    } catch { /* ignore */ }

    let dragging = false;
    resizer.addEventListener("mousedown", (e) => {
      dragging = true;
      e.preventDefault();
      resizer.classList.add("dragging");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const body = document.querySelector(".traj-body");
      if (!body) return;
      const rect = body.getBoundingClientRect();
      const maxW = Math.max(240, rect.width - 280); // keep at least 280px for the ledger
      const width = Math.round(rect.right - e.clientX);
      inspector.style.width = Math.max(240, Math.min(maxW, width)) + "px";
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      resizer.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try { localStorage.setItem("scope-trajectory-inspector-width", inspector.style.width); } catch { /* ignore */ }
    });
  }
  if (inspectorCopy) inspectorCopy.addEventListener("click", () => {
    const pre = inspectorBody?.querySelector("#traj-raw");
    if (pre) navigator.clipboard?.writeText(pre.textContent).catch(() => {});
  });
  if (inspectorWrap) inspectorWrap.addEventListener("click", () => {
    const pre = inspectorBody?.querySelectorAll("pre");
    if (!pre) return;
    const wrap = inspectorWrap.textContent === "↩";
    pre.forEach((p) => { p.style.whiteSpace = wrap ? "pre" : "pre-wrap"; });
    inspectorWrap.textContent = wrap ? "→" : "↩";
  });
})();
