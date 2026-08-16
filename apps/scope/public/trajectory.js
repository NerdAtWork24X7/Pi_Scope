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
  let stickToBottom = true;
  let session = null; // session summary object
  let costStr = "";
  let selectedIndex = null; // cell.index of the record open in the inspector

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
      case "compacted": return "Compacted";
      case "context": return "Context";
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
        if (current && current.events.length && !current.closed && current.turnStarted) current.closed = true;
        current = newBucket(evt);
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
          push({
            absTime: tsMs(evt),
            cell: {
              index: ++ctx.index, kind: "system",
              text: ctx.systemCount === 0 ? "Initial System Prompt" : "System Prompt Updated",
              preview: p.system_prompt || "", inputDetail: p.system_prompt || "",
              timeSeconds: 0, startedAt: tsMs(evt), sourceEvt: evt,
            },
          }, "Message");
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
          if (prior) {
            prior.cell.resultEvt = evt;
            prior.cell.isError = !!p.is_error;
            prior.cell.outputDetail = p.content_text || "";
            prior.cell.resultPreview = p.is_error ? "✗ error" : trunc(p.content_text || "", 160);
            prior.cell.timeSeconds =
              callTs != null && tsMs(evt) != null ? Math.max(0, (tsMs(evt) - callTs) / 1000) : null;
          } else {
            // Orphan result (no matching tool_call captured) still gets a row.
            push({
              absTime: tsMs(evt), toolName: p.tool_name, callId,
              cell: {
                index: ++ctx.index, kind: "tool", text: p.tool_name || "tool",
                preview: p.is_error ? "✗ error" : trunc(p.content_text || "", 160),
                outputDetail: p.content_text || "", resultEvt: evt,
                timeSeconds: null, startedAt: tsMs(evt),
                callId, toolName: p.tool_name, isError: !!p.is_error,
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
        // cell — turn boundaries drive grouping, agent_start/agent_end duplicate
        // user_message/assistant_message, and thinking is folded into the
        // assistant_message cell above.
        case "turn_start":
        case "turn_end":
        case "agent_start":
        case "agent_end":
        case "thinking":
          break;
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
        const t = trunc(cell.preview || cell.text, 240);
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
      case "system":
      case "compacted":
      case "context":
      default: {
        const t = trunc(cell.text || "", 240);
        return t ? escapeHtml(t) : "";
      }
    }
  }

  function timeCell(cell) {
    if (cell.kind === "message" || cell.kind === "tool") return fmtOwn(cell.timeSeconds);
    return "";
  }

  function buildRow(cell) {
    const row = document.createElement("div");
    row.className = "traj-row traj-" + cell.kind
      + (cell.isError ? " is-error" : "")
      + (cell.index === selectedIndex ? " selected" : "");
    row.dataset.index = cell.index;
    row.innerHTML = `
      <span class="traj-col-idx">#${cell.index}</span>
      <span class="traj-col-kind">${escapeHtml(kindLabel(cell.kind))}</span>
      <span class="traj-col-content" title="${escapeHtml(trunc(cell.preview || cell.text || "", 400))}">${cellContent(cell)}</span>
      <span class="traj-col-time">${timeCell(cell)}</span>
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
    const name = session?.agent_name ?? session?.cwd?.split("/").pop() ?? (selectedSid ? shortId(selectedSid) : "");
    label.textContent = name ? name + " · trajectory" : "trajectory";
    label.title = selectedSid ?? "";
  }

  function render() {
    if (!ledger) return;
    const layout = deriveTrajectoryLayout(evts);
    const allCells = layout.flatMap((t) => t.groups.flatMap((g) => g.cells));
    buildOverview(allCells);

    const q = search.trim().toLowerCase();
    let visible = 0;
    let total = allCells.length;

    const frag = document.createDocumentFragment();
    frag.appendChild(buildColumnHeader());
    for (const turn of layout) {
      const matchingGroups = turn.groups
        .map((g) => ({ group: g, cells: g.cells.filter((c) => matchesSearch(c, q)) }))
        .filter((x) => x.cells.length);
      if (!matchingGroups.length) continue;
      frag.appendChild(buildTurnHead(turn));
      for (const { group, cells } of matchingGroups) {
        frag.appendChild(buildGroupHead(group));
        for (const cell of cells) {
          visible++;
          frag.appendChild(buildRow(cell));
        }
      }
    }

    ledger.innerHTML = "";
    ledger.appendChild(frag);
    refreshInspector(allCells);

    if (statsEl) {
      const records = q ? `${visible} / ${total} records` : `${total} records`;
      statsEl.textContent = costStr ? `${costStr} · ${records}` : records;
    }
    updateLabel();
    if (stickToBottom) scrollToBottom();
    updateEmpty();
  }

  // ─── Timeline overview ────────────────────────────────────────────────────

  function buildOverview(cells) {
    if (!overview) return;
    const timed = cells.filter((c) => c.startedAt != null && Number.isFinite(c.startedAt));
    if (!timed.length) { overview.innerHTML = ""; overview.style.display = "none"; return; }
    overview.style.display = "";

    let minT = Infinity, maxT = -Infinity;
    for (const c of timed) {
      const start = c.startedAt;
      const dur = c.timeSeconds != null ? c.timeSeconds * 1000 : 0;
      minT = Math.min(minT, start);
      maxT = Math.max(maxT, start + dur);
    }
    if (!Number.isFinite(minT) || !Number.isFinite(maxT) || maxT <= minT) { maxT = minT + 1; }
    const span = maxT - minT;
    const H = 44;

    const canvas = document.createElement("div");
    canvas.className = "tov-canvas";
    canvas.style.height = H + "px";

    for (const c of timed) {
      const dur = c.timeSeconds != null ? c.timeSeconds * 1000 : 0;
      const left = ((c.startedAt - minT) / span) * 100;
      const width = Math.max(((dur || 1) / span) * 100, 0.12);
      const bar = document.createElement("div");
      bar.className = "tov-bar tov-" + c.kind;
      bar.style.left = left.toFixed(4) + "%";
      bar.style.width = width.toFixed(4) + "%";
      bar.style.top = (6 + (c.kind === "message" ? 0 : c.kind === "tool" ? 14 : 28)) + "px";
      bar.style.height = (c.kind === "message" ? 12 : c.kind === "tool" ? 12 : 4) + "px";
      bar.dataset.index = c.index;

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
      canvas.appendChild(bar);
    }

    overview.innerHTML = "";
    overview.appendChild(canvas);
  }

  function updateEmpty() {
    if (!ledger) return;
    const empty = ledger.querySelector(".traj-empty");
    if (!evts.length && !empty) {
      ledger.innerHTML = '<div class="empty-state traj-empty"><span class="icon">⛓</span>Select a session from the sidebar</div>';
      if (statsEl) statsEl.textContent = "";
      if (overview) overview.style.display = "none";
      if (label) label.textContent = "trajectory";
    }
  }

  // ─── Data loading / SSE ───────────────────────────────────────────────────

  async function select(sid) {
    selectedSid = sid;
    evts = [];
    lastSeq = -1;
    search = "";
    closeInspector();
    if (searchBox) searchBox.value = "";
    session = STATE.sessions.find((s) => s.session_id === sid) ?? null;
    const stats = STATE.sessionStats[sid];
    costStr = stats ? `$${stats.total_cost.toFixed(4)} · ${fmtTokens(stats.total_tokens)} tk` : "";
    render();

    const events = await fetchSessionEvents(sid);
    if (selectedSid !== sid) return;
    evts = events || [];
    lastSeq = evts.length ? evts[evts.length - 1].seq : -1;
    prune();
    render();
  }

  function prune() {
    if (evts.length <= MAX_EVENTS) return;
    evts.splice(0, evts.length - MAX_EVENTS);
  }

  async function resync() {
    if (selectedSid == null) return;
    if (lastSeq < 0) { await select(selectedSid); return; }
    const newer = await fetchSessionEvents(selectedSid, lastSeq);
    if (!newer?.length) return;
    for (const e of newer) {
      if (e.seq > lastSeq) { evts.push(e); lastSeq = e.seq; }
    }
    prune();
    render();
  }

  // ─── Hooks called from app.js ─────────────────────────────────────────────

  window.__trajectoryOnView = function () {
    const sid = STATE.selectedSessionId;
    if (sid && sid !== selectedSid) select(sid);
    else if (!sid) { selectedSid = null; evts = []; lastSeq = -1; render(); }
    else {
      session = STATE.sessions.find((s) => s.session_id === sid) ?? session;
      render();
    }
  };

  window.__trajectoryOnSessions = function () {
    if (selectedSid) {
      session = STATE.sessions.find((s) => s.session_id === selectedSid) ?? session;
      updateLabel();
    }
  };

  window.__trajectoryOnEvent = function (evt) {
    if (!selectedSid || evt.session_id !== selectedSid) return;
    if (evt.seq <= lastSeq) return;
    evts.push(evt);
    lastSeq = evt.seq;
    prune();
    render();
  };

  window.__trajectoryOnReconnect = function () { resync(); };

  window.__trajectoryStatsUpdate = function (sid, stats) {
    if (sid !== selectedSid) return;
    costStr = `$${stats.total_cost.toFixed(4)} · ${fmtTokens(stats.total_tokens)} tk`;
  };

  window.__trajectoryClear = function () {
    selectedSid = null;
    evts = [];
    lastSeq = -1;
    session = null;
    costStr = "";
    if (searchBox) searchBox.value = "";
    search = "";
    closeInspector();
    render();
  };

  window.__trajectoryIsSelected = (sid) => sid === selectedSid;

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
