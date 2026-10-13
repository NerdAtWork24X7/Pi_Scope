/**
 * client.js — the "Subagent Workflow" view.
 *
 * A canvas for wiring **coding-agent harnesses** into a fan-out DAG. Each agent
 * node runs one harness — Claude Code, Codex CLI, Gemini CLI, opencode, Aider,
 * Cursor Agent, the app's own Pi runner, or a custom shell command — configured
 * in the inspector on the right. Drag from a node's output port onto another
 * node's input port to connect them; a run walks the graph from the **start**
 * node to the **end** node, server-side and in the background, streaming every
 * node's output into the run panel while the canvas badges each node
 * pending → running → done/error.
 *
 * A node is configured with exactly three things — its **provider** (the harness
 * it spawns), its **model**, and the **user message** it is given — and each
 * agent node wears its provider's mark on the canvas. A Pi node's Model field
 * offers every model this app can run, grouped by provider and valued
 * `<provider>/<id>` (what pi resolves); the **end** node shows the workflow's
 * final output once a run reaches it. An agent node can also carry **reference
 * files** — paths the user adds, each with a description — which are injected
 * ahead of its user message, so a step is pointed at the material it needs
 * instead of having it pasted into the message. Connections decide the
 * order of a run: everything wired in parallel off one node runs in parallel,
 * and a chain runs one node after another. Nodes can be cloned and the graph
 * exported/imported as JSON. An **approval** node pauses the run for a person: the banner above the
 * run log lists every gate that is waiting, with the gate's message, a note box
 * and Approve / Reject. The run panel also lists **past runs** (reopen one to
 * replay its log and node badges) and, with nothing selected, the inspector
 * holds the **triggers** — a schedule and an event watch that start runs on
 * their own.
 *
 * A **standalone plugin**: this bundle, its stylesheet (client.css) and its
 * server half (server.ts) all live in apps/scope-server/plugins/subagent-workflow/,
 * and the host loads the bundle from its manifest. It registers itself below.
 */
(function () {
  const S = window.SCOPE;
  if (!S || !S.Plugins) return;
  const esc = S.escapeHtml;
  const escAttr = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  /**
   * A mark for each harness, so an agent node shows *which* provider it runs at
   * a glance instead of a generic shape. These are simple geometric glyphs drawn
   * in `currentColor` — not the vendors' trademarked logos — so they inherit the
   * theme's accent and stay legible in light, dark and the DeepSeek palette.
   */
  const svg16 = (body) => `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">${body}</svg>`;
  const HARNESS_ICONS = {
    claude: svg16('<g fill="currentColor">' +
      '<rect x="7.25" y="1.2" width="1.5" height="13.6" rx=".75"/>' +
      '<rect x="7.25" y="1.2" width="1.5" height="13.6" rx=".75" transform="rotate(45 8 8)"/>' +
      '<rect x="7.25" y="1.2" width="1.5" height="13.6" rx=".75" transform="rotate(90 8 8)"/>' +
      '<rect x="7.25" y="1.2" width="1.5" height="13.6" rx=".75" transform="rotate(135 8 8)"/></g>'),
    codex: svg16('<path fill="none" stroke="currentColor" stroke-width="1.3" d="M8 1.7 13.5 4.85v6.3L8 14.3 2.5 11.15v-6.3z"/>' +
      '<circle cx="8" cy="8" r="1.9" fill="currentColor"/>'),
    gemini: svg16('<path fill="currentColor" d="M8 1c.5 3.5 1.7 4.7 5.2 5.2C9.7 6.7 8.5 7.9 8 11.4 7.5 7.9 6.3 6.7 2.8 6.2 6.3 5.7 7.5 4.5 8 1Z"/>' +
      '<path fill="currentColor" d="M12.4 10.4c.25 1.7.8 2.25 2.5 2.5-1.7.25-2.25.8-2.5 2.5-.25-1.7-.8-2.25-2.5-2.5 1.7-.25 2.25-.8 2.5-2.5Z"/>'),
    opencode: svg16('<path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M3 4.5 6 8l-3 3.5M8.5 11.5h4.5"/>'),
    aider: svg16('<path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M5.5 3 2 8l3.5 5M10.5 3 14 8l-3.5 5"/>'),
    cursor: svg16('<path fill="currentColor" d="M3.4 2.1 12.6 8.7l-4.1.5 2 4.2-1.7.8-2-4.2L3.4 12.4z"/>'),
    pi: svg16('<text x="8" y="12.6" text-anchor="middle" font-size="12.5" font-family="Georgia, serif" fill="currentColor">\u03c0</text>'),
    custom: svg16('<path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M5.6 3 3.1 8l2.5 5M10.4 3l2.5 5-2.5 5M9.2 3.4 6.8 12.6"/>'),
  };
  const iconKey = (id) => (HARNESS_ICONS[String(id)] ? String(id) : "custom");
  /** The inline SVG mark for a harness id (falls back to the custom-command one). */
  const harnessSvg = (id) => HARNESS_ICONS[iconKey(id)];
  /** That mark wrapped in its themed span, with the harness id on it. */
  function harnessIcon(id, label) {
    const title = label ? ` title="${escAttr(label)}"` : "";
    return `<span class="sw-hicon" data-harness="${escAttr(iconKey(id))}"${title}>${harnessSvg(id)}</span>`;
  }
  /** Repaint an existing icon span in place (used when the harness changes). */
  function setHarnessIcon(el, id, label) {
    if (!el) return;
    el.dataset.harness = iconKey(id);
    el.innerHTML = harnessSvg(id);
    if (label) el.title = label;
  }

  const NODE_W = 220;
  const POLL_MS = 900;
  /** While a trigger is armed a run can start on its own, so idle-poll slowly
   *  to notice it (the live run poll above is much faster). */
  const TRIGGER_POLL_MS = 8000;

  let pane = null;
  let canvasEl = null, nodesEl = null, svgEl = null, edgePathsEl = null, tmpPathEl = null, edgeBtnsEl = null;
  let inspectorEl = null, statusEl = null, nameInput = null, taskInput = null;
  let runStatusEl = null, runLogEl = null, runSummaryEl = null, runBtn = null, stopBtn = null;
  let approvalsEl = null, approvalSig = "";
  let historyEl = null, historySig = "";

  let wf = null;
  let run = null;
  /** Run history: the summaries the server keeps, and the record being viewed. */
  let historyList = [];
  let historyRun = null;
  /** This workspace's triggers (schedule + event watch), as the server sees them. */
  let triggers = null;
  let harnesses = [];
  let cwd = "";
  let selected = null;
  let drag = null;
  let link = null;
  let loadError = null;
  let dirty = false;
  let pollTimer = null;
  let watchTimer = null;
  // Log lines accumulated client-side across incremental polls, plus the last
  // run seq we have seen (so a poll fetches only what is new).
  let logBuffer = [];
  let logSig = "";
  let runSince = 0;

  const nodes = () => (wf && Array.isArray(wf.nodes) ? wf.nodes : []);
  const edges = () => (wf && Array.isArray(wf.edges) ? wf.edges : []);
  const nodeById = (id) => nodes().find((n) => n.id === id) || null;
  /** The run the canvas is showing: a reopened past run when one is selected,
   *  otherwise the live one. Everything that paints run state reads this. */
  const viewRun = () => historyRun || run;
  const runNode = (id) => (viewRun()?.nodes ? viewRun().nodes[id] : null) || null;
  const harnessMeta = (id) => harnesses.find((h) => h.id === id) || null;
  const params = (extra) => Object.assign(cwd ? { cwd } : {}, extra || {});

  async function getJson(path, extra) {
    const { res, data } = await S.api(path, params(extra));
    if (!res.ok || data?.error) throw new Error(data?.error || `HTTP ${res.status}`);
    return data;
  }
  async function post(action, payload) {
    const { res, data } = await S.api("/subagent-workflow", {}, Object.assign({ action, cwd }, payload || {}));
    if (!res.ok || data?.error) throw new Error(data?.error || `HTTP ${res.status}`);
    return data;
  }
  async function postRun(action, payload) {
    const { res, data } = await S.api("/subagent-workflow/run", {}, Object.assign({ action, cwd }, payload || {}));
    if (!res.ok || data?.error) throw new Error(data?.error || `HTTP ${res.status}`);
    return data;
  }

  function adoptRun(next, full) {
    run = next || null;
    if (full) {
      logBuffer = next?.log ? [...next.log] : [];
      logSig = "";
    } else if (next?.log?.length) {
      logBuffer = logBuffer.concat(next.log).slice(-400);
    }
    runSince = next?.seq || 0;
  }

  async function refresh() {
    try {
      const data = await getJson("/subagent-workflow");
      wf = data;
      adoptRun(data.run, true);
      historyList = Array.isArray(data.history) ? data.history : [];
      triggers = data.triggers || null;
      loadError = null;
    } catch (err) {
      loadError = String(err.message || err);
    }
    paint();
    syncPolling();
  }

  async function refreshRun() {
    try {
      const data = await getJson("/subagent-workflow/run", runSince ? { since: runSince } : undefined);
      const next = data.run || null;
      // Nothing new since the last poll: do no work at all.
      if (next && run && next.id === run.id && next.seq === run.seq && next.status === run.status) { syncPolling(); return; }
      const wasRunning = run?.status === "running";
      // A trigger starting a run replaces the one on screen, so adopt that
      // wholesale (and leave a reopened past run) rather than appending its log.
      const isNewRun = !!next && next.id !== run?.id;
      if (isNewRun) historyRun = null;
      adoptRun(next, isNewRun);
      if (isNewRun) paint(); else paintRun();
      if (wasRunning && next && next.status !== "running") {
        // The run has just settled. It is now a history entry — and a settled
        // run's per-node *output tails* (the end node's final output among them)
        // only arrive on a full read: the incremental polls that streamed it
        // carried none. Re-read once so the canvas shows what the workflow
        // produced without a reload.
        void refreshHistory();
        void refresh();
      } else if (isNewRun) {
        void refreshHistory();
      }
    } catch { /* keep the last run */ }
    syncPolling();
  }

  /**
   * Refresh the harness list. The list only feeds the inspector's dropdown, so
   * this re-renders the inspector rather than repainting the canvas — repainting
   * on every harness fetch made opening the view (and the ↻ button) paint the
   * whole node + edge DOM twice.
   */
  async function loadHarnesses() {
    try { harnesses = (await getJson("/subagent-workflow/harnesses")).harnesses || []; }
    catch { harnesses = []; }
    renderInspector();
  }

  function syncPolling() {
    const running = run && run.status === "running";
    if (running && !pollTimer) pollTimer = setInterval(refreshRun, POLL_MS);
    else if (!running && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    // With a trigger armed, a run can start without this page asking for it.
    const watching = !running && !!triggers?.armed;
    if (watching && !watchTimer) watchTimer = setInterval(refreshRun, TRIGGER_POLL_MS);
    else if (!watching && watchTimer) { clearInterval(watchTimer); watchTimer = null; }
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
  }

  /** Forget the routed-edge elements: the pane's DOM is being rebuilt. */
  function resetCanvasState() {
    edgeEls.clear();
    boxCache.clear();
    canvasW = 0; canvasH = 0;
    approvalSig = "";  // the approval banner is about to be rebuilt too
    historySig = "";    // …and so is the history picker
    historyRun = null;  // a rebuilt pane starts on the live run
  }

  // ─── Painting ─────────────────────────────────────────────────────────────

  function paint() {
    if (!pane) return;
    if (drag || link) { dirty = true; return; }
    dirty = false;
    if (nameInput && document.activeElement !== nameInput) nameInput.value = wf?.name || "";
    renderStatus();
    renderNodes();
    resizeCanvas();
    renderEdges();
    renderInspector();
    syncFinalOutput();
    renderRun();
  }

  /**
   * A live-run tick repaints only what a run changes: each node's status badge
   * and the run panel. It deliberately does NOT rebuild the node DOM, the edge
   * SVG or the inspector — that would churn every poll and drop any settings
   * the user is mid-edit on.
   */
  function paintRun() {
    if (!pane) return;
    if (drag || link) { dirty = true; return; }
    applyRunStatuses();
    syncFinalOutput();
    renderRun();
  }

  /** Toggle the per-node run classes and badges in place. */
  function applyRunStatuses() {
    const statuses = viewRun()?.nodes || {};
    for (const el of nodesEl.querySelectorAll(".sw-node")) {
      const rs = statuses[el.dataset.id];
      const st = rs?.status || "";
      for (const cls of [...el.classList]) if (cls.startsWith("sw-run-")) el.classList.remove(cls);
      if (st) el.classList.add(`sw-run-${st}`);
      let badge = el.querySelector(".sw-badge");
      if (!st) { if (badge) badge.remove(); continue; }
      if (!badge) {
        badge = document.createElement("span");
        el.querySelector(".sw-node-head")?.insertBefore(badge, el.querySelector(".sw-node-del"));
      }
      badge.className = `sw-badge sw-b-${st}`;
      badge.textContent = badgeGlyph(st, rs?.bypassed);
      badge.title = rs?.bypassed ? "bypassed" : st;
    }
  }

  function renderStatus() {
    if (!statusEl) return;
    if (loadError) { statusEl.className = "sw-status err"; statusEl.textContent = `⚠ ${loadError}`; return; }
    const n = nodes().length;
    const e = edges().length;
    const hasStart = nodes().some((x) => x.type === "start");
    const hasEnd = nodes().some((x) => x.type === "end");
    const bits = [`${n} node${n === 1 ? "" : "s"}`, `${e} connection${e === 1 ? "" : "s"}`];
    if (triggers?.armed) bits.push("⚡ trigger armed");
    statusEl.className = "sw-status";
    if (!hasStart) { bits.push("no start node"); statusEl.classList.add("warn"); }
    if (!hasEnd) { bits.push("no end node"); statusEl.classList.add("warn"); }
    statusEl.textContent = bits.join(" · ");
  }

  // Last canvas size written, so a repaint that does not change it writes
  // nothing — assigning the same width/height still costs a style recalculation
  // and can invalidate the raster of a canvas that can be thousands of px wide.
  let canvasW = 0, canvasH = 0;
  function resizeCanvas() {
    let maxX = 1000, maxY = 700;
    for (const n of nodes()) { maxX = Math.max(maxX, n.x + NODE_W + 120); maxY = Math.max(maxY, n.y + 200); }
    if (maxX === canvasW && maxY === canvasH) return;
    canvasW = maxX; canvasH = maxY;
    canvasEl.style.width = `${maxX}px`;
    canvasEl.style.height = `${maxY}px`;
    svgEl.setAttribute("width", String(maxX));
    svgEl.setAttribute("height", String(maxY));
  }

  /** The provider's display name, whether or not the machine reported it. */
  function providerLabel(id) {
    const meta = harnessMeta(id);
    return (meta && (meta.label || meta.id)) || id || "agent";
  }

  /**
   * The workflow's **final output**: what the run's end node received from the
   * branches wired into it. The end node is a sentinel — it spawns nothing — so
   * its own output *is* the answer the graph produced, and the server keeps that
   * output's tail on the run record (a live run and a reopened one alike).
   * Empty until a run has reached the end node.
   */
  function finalOutput() {
    const end = nodes().find((n) => n.type === "end");
    if (!end) return { nodeId: "", text: "" };
    const tail = runNode(end.id)?.outputTail;
    return { nodeId: end.id, text: typeof tail === "string" ? tail : "" };
  }

  /** One line of the final output, for the end node's card on the canvas. */
  function finalPreview(text, max = 140) {
    const flat = String(text || "").replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  }

  /**
   * The end node's panel body: the workflow's final output, whole (the server
   * keeps the last 4000 characters), with what it belongs to and a Copy button.
   */
  function finalOutputHtml() {
    const { text } = finalOutput();
    if (!text) {
      return `<p class="sw-muted">Every branch that reaches this node has settled when the run finishes here.</p>` +
        `<p class="sw-hint">Run the workflow and this node shows what it produced — the joined output of the connections wired into it.</p>`;
    }
    const lines = text.split("\n").length;
    const status = viewRun()?.status || "";
    return `<div class="sw-final-head">` +
        `<span class="sw-final-title">Final output</span>` +
        `<span class="sw-final-meta">${lines} line${lines === 1 ? "" : "s"} · ${text.length} chars</span>` +
        `<button class="btn-sm" id="sw-final-copy" type="button" title="Copy the final output">Copy</button></div>` +
      `<pre class="sw-final-pre">${esc(text)}</pre>` +
      `<div class="sw-hint">The joined output of this node's incoming connections${status ? `, from the ${esc(status)} run` : ""}.</div>`;
  }

  /**
   * Refresh the two live views of the final output: the end node's card and the
   * inspector when it is open on that node. Runs on every paint and every live
   * tick, because the output only appears once the run has settled there — and
   * the inspector's copy is left alone when nothing changed, so a selection the
   * user is making mid-run survives the next tick.
   */
  function syncFinalOutput() {
    const { nodeId, text } = finalOutput();
    const card = nodeId
      ? nodesEl.querySelector(`.sw-node[data-id="${CSS.escape(nodeId)}"] .sw-node-final`)
      : null;
    if (card) {
      const preview = finalPreview(text);
      card.classList.toggle("has-output", !!preview);
      card.textContent = preview || "Workflow exit";
      card.title = text ? text.slice(0, 600) : "";
    }
    const box = inspectorEl.querySelector("#sw-final-body");
    if (!box || selected?.kind !== "node" || selected.id !== nodeId) return;
    if (box.dataset.text === text) return;
    box.dataset.text = text;
    box.innerHTML = finalOutputHtml();
  }

  function nodeSummary(n) {
    if (n.type === "agent") {
      const h = harnessMeta(n.config?.harness);
      const label = h ? h.label : (n.config?.harness || "agent");
      const model = n.config?.model ? ` · ${n.config.model}` : "";
      const off = n.config?.enabled === false ? ' <span class="sw-off-tag">off</span>' : "";
      const refs = Array.isArray(n.config?.refs) ? n.config.refs.length : 0;
      const refTag = refs
        ? ` <span class="sw-ref-tag" title="${refs} reference file${refs === 1 ? "" : "s"} injected with this node's message">📎 ${refs}</span>`
        : "";
      return `<div class="sw-node-model">${esc(label)}${esc(model)}${off}${refTag}</div>` +
        `<div class="sw-node-desc">${esc(n.config?.prompt?.trim() || "{input}")}</div>`;
    }
    if (n.type === "approval") {
      const off = n.config?.enabled === false ? ' <span class="sw-off-tag">off</span>' : "";
      return `<div class="sw-node-model">Human approval${off}</div>` +
        `<div class="sw-node-desc">${esc(n.config?.description || "Pauses the run for a review")}</div>`;
    }
    if (n.type === "end") {
      // The graph's answer. Filled in by syncFinalOutput once a run reaches it.
      const out = finalPreview(finalOutput().text);
      return `<div class="sw-node-final${out ? " has-output" : ""}" title="${escAttr(out.slice(0, 200))}">` +
        `${esc(out || n.config?.description || "Workflow exit")}</div>`;
    }
    return `<div class="sw-node-desc">${esc(n.config?.description || (n.type === "start" ? "Workflow entry point" : "Workflow exit"))}</div>`;
  }

  function renderNodes() {
    const sel = selected && selected.kind === "node" ? selected.id : null;
    nodesEl.innerHTML = nodes().map((n) => {
      const rs = runNode(n.id);
      const st = rs?.status || "";
      const off = n.type === "agent" && n.config?.enabled === false;
      const cls = `sw-node sw-t-${n.type}${n.id === sel ? " sel" : ""}${st ? ` sw-run-${st}` : ""}${off ? " sw-off" : ""}`;
      const badge = st ? `<span class="sw-badge sw-b-${st}" title="${escAttr(rs?.bypassed ? "bypassed" : st)}">${badgeGlyph(st, rs?.bypassed)}</span>` : "";
      const inPort = n.type !== "start" ? `<span class="sw-port sw-port-in" data-port="in" title="Input"></span>` : "";
      const outPort = n.type !== "end" ? `<span class="sw-port sw-port-out" data-port="out" title="Drag to connect to another node"></span>` : "";
      // The head shows the provider the node runs — the mark of the harness it
      // spawns — so a canvas of mixed agents is readable without opening the
      // inspector. The mark carries the provider's name as its tooltip.
      const glyph = n.type === "agent"
        ? harnessIcon(n.config?.harness, providerLabel(n.config?.harness))
        : `<span class="sw-node-glyph">${n.type === "start" ? "▶" : n.type === "end" ? "■" : "✋"}</span>`;
      return `<div class="${cls}" data-id="${escAttr(n.id)}" style="left:${n.x}px;top:${n.y}px">` +
        `<div class="sw-node-head">` +
          glyph +
          `<span class="sw-node-name" title="${escAttr(n.name)}">${esc(n.name)}</span>` +
          badge +
          `<button class="sw-node-del" data-del="${escAttr(n.id)}" title="Delete node" type="button">✕</button>` +
        `</div>` +
        `<div class="sw-node-body">${nodeSummary(n)}</div>` +
        inPort + outPort +
      `</div>`;
    }).join("");
  }

  /** A node's run glyph; a pass-through node gets the skip-ahead mark. */
  function badgeGlyph(st, bypassed) {
    if (bypassed) return "⏭";
    return st === "running" ? "◌" : st === "done" ? "✔" : st === "error" ? "✖"
      : st === "waiting" ? "⏸" : st === "skipped" ? "–" : st === "stopped" ? "■" : "·";
  }

  /**
   * Node boxes measured once per routing pass, keyed by node id.
   *
   * Port geometry needs the node's rendered box, so routing used to read
   * `offsetLeft/Top/Width/Height` per *edge* — and because a drag writes
   * `style.left` first, every one of those reads forced a synchronous reflow
   * between the writes (O(edges) reflows per animation frame, measured at 360
   * per frame on a 45-edge graph). Measuring every node up front keeps all the
   * reads before any write, so one frame costs one layout, not one per edge.
   */
  const boxCache = new Map();

  function measureBoxes() {
    boxCache.clear();
    for (const el of nodesEl.children) {
      const id = el.dataset && el.dataset.id;
      if (!id) continue;
      boxCache.set(id, { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
    }
  }

  function portPos(id, which) {
    let b = boxCache.get(id);
    if (!b) {
      // Not measured yet (e.g. a link drag before the first paint): measure just
      // this node, and remember it.
      const el = nodesEl.querySelector(`.sw-node[data-id="${CSS.escape(id)}"]`);
      if (!el) return null;
      b = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
      boxCache.set(id, b);
    }
    return which === "out" ? { x: b.x + b.w, y: b.y + b.h / 2 } : { x: b.x, y: b.y + b.h / 2 };
  }
  function edgePath(p1, p2) {
    const dx = Math.max(44, Math.abs(p2.x - p1.x) * 0.5);
    return `M ${p1.x} ${p1.y} C ${p1.x + dx} ${p1.y}, ${p2.x - dx} ${p2.y}, ${p2.x} ${p2.y}`;
  }

  const SVG_NS = "http://www.w3.org/2000/svg";
  /** One `<path>` + delete button per edge id, reused across repaints. */
  const edgeEls = new Map();

  /**
   * Route edges using the current boxes. Elements are created once and then only
   * updated in place, so a drag re-routes just the dragged node's edges instead
   * of tearing down and rebuilding the whole SVG.
   *
   * `full` says `list` is the whole graph: only then may an edge element whose
   * edge is gone be removed. A subset (a drag) leaves every other edge alone.
   */
  function layoutEdges(list, full) {
    const sel = selected && selected.kind === "edge" ? selected.id : null;
    const live = new Set();
    const routed = new Set();
    for (const e of list) {
      routed.add(e.id);
      const p1 = portPos(e.from, "out"), p2 = portPos(e.to, "in");
      if (!p1 || !p2) continue;
      live.add(e.id);
      let item = edgeEls.get(e.id);
      if (!item) {
        const path = document.createElementNS(SVG_NS, "path");
        path.setAttribute("class", "sw-edge");
        path.dataset.edge = e.id;
        edgePathsEl.appendChild(path);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "sw-edge-del";
        btn.dataset.edge = e.id;
        btn.title = "Delete connection";
        btn.textContent = "✕";
        edgeBtnsEl.appendChild(btn);
        item = { path, btn };
        edgeEls.set(e.id, item);
      }
      item.path.setAttribute("d", edgePath(p1, p2));
      item.path.classList.toggle("sel", e.id === sel);
      item.btn.style.left = `${(p1.x + p2.x) / 2 - 9}px`;
      item.btn.style.top = `${(p1.y + p2.y) / 2 - 9}px`;
    }
    // Every edge the graph no longer has (a full render), or that this pass
    // tried and could not route; never one the pass did not look at, so a drag
    // leaves the rest of the SVG alone.
    for (const id of [...edgeEls.keys()]) {
      if (live.has(id)) continue;
      if (!full && !routed.has(id)) continue;
      const item = edgeEls.get(id);
      item.path.remove();
      item.btn.remove();
      edgeEls.delete(id);
    }
  }

  function renderEdges() {
    measureBoxes();
    layoutEdges(edges(), true);
  }
  function showTmpPath(fromId, toX, toY) {
    const p1 = portPos(fromId, "out");
    if (!p1) return;
    tmpPathEl.setAttribute("d", edgePath(p1, { x: toX, y: toY }));
    tmpPathEl.style.display = "";
  }
  function hideTmpPath() { tmpPathEl.style.display = "none"; }

  // ─── Inspector (node settings) ────────────────────────────────────────────

  function renderInspector() {
    if (!inspectorEl) return;
    if (selected && selected.kind === "edge") return renderEdgeInspector();
    if (selected && selected.kind === "node") {
      const n = nodeById(selected.id);
      if (n) return renderNodeInspector(n);
    }
    inspectorEl.innerHTML =
      `<div class="sw-insp-empty">` +
        `<div class="sw-insp-title">Node settings</div>` +
        `<p>Select a node to configure the coding harness it runs.</p>` +
        `<p class="sw-muted">Drag from a node's <b>right port</b> onto another node's left port to wire the workflow.</p>` +
        (loadError ? `<button class="btn-sm" id="sw-retry" type="button">↻ Retry</button>` : "") +
        renderTriggersForm() +
      `</div>`;
    inspectorEl.querySelector("#sw-retry")?.addEventListener("click", refresh);
    wireTriggersForm();
  }

  // ─── Triggers (workflow-level, shown when nothing is selected) ────────────

  function triggerSummary(t) {
    if (!t || !t.armed) return "No trigger armed — runs start when you press ▶ Run.";
    const bits = [];
    if (t.schedule?.mode === "interval") bits.push(`every ${t.schedule.everySeconds}s`);
    if (t.schedule?.mode === "daily") bits.push(`daily at ${t.schedule.at}`);
    if (t.event?.enabled) bits.push(t.event.types.length ? `on ${t.event.types.join(", ")}` : "on any event");
    const next = t.nextRunAt ? ` Next scheduled run ${new Date(t.nextRunAt).toLocaleString()}.` : "";
    return `Armed — ${bits.join(", ")}.${next} A run only starts while this workflow is idle.`;
  }

  function renderTriggersForm() {
    const t = triggers || {};
    const sch = t.schedule || { mode: "off", everySeconds: 300, at: "09:00" };
    const ev = t.event || { enabled: false, types: [] };
    return `<div class="sw-triggers">` +
      `<div class="sw-insp-title">Workflow triggers</div>` +
      `<p class="sw-muted">Start this workflow on a schedule or when an event arrives, not only from ▶ Run.</p>` +
      `<label class="sw-field"><span>Schedule</span>` +
        `<select class="set-select" id="sw-tr-mode">` +
          `<option value="off"${sch.mode === "off" ? " selected" : ""}>off — manual runs only</option>` +
          `<option value="interval"${sch.mode === "interval" ? " selected" : ""}>every N seconds</option>` +
          `<option value="daily"${sch.mode === "daily" ? " selected" : ""}>every day at…</option>` +
        `</select></label>` +
      `<label class="sw-field" id="sw-tr-interval" style="display:${sch.mode === "interval" ? "" : "none"}"><span>Every (seconds)</span>` +
        `<input class="set-input" id="sw-tr-every" type="number" min="5" max="86400" step="5" value="${escAttr(sch.everySeconds || 300)}">` +
        `<div class="sw-hint">60 = every minute, 3600 = hourly.</div></label>` +
      `<label class="sw-field" id="sw-tr-daily" style="display:${sch.mode === "daily" ? "" : "none"}"><span>At (local time)</span>` +
        `<input class="set-input" id="sw-tr-at" value="${escAttr(sch.at || "09:00")}" placeholder="09:00"></label>` +
      `<label class="sw-check sw-check-line"><input type="checkbox" id="sw-tr-event"${ev.enabled ? " checked" : ""}> start on observed events</label>` +
      `<label class="sw-field"><span>Event types</span>` +
        `<input class="set-input" id="sw-tr-types" value="${escAttr((ev.types || []).join(", "))}" placeholder="tool_call, file_edit">` +
        `<div class="sw-hint">Comma-separated event types. Empty = any event from this workspace.</div></label>` +
      `<label class="sw-field"><span>Task <em>(optional)</em></span>` +
        `<input class="set-input" id="sw-tr-task" value="${escAttr(t.task || "")}" placeholder="the start node's default task">` +
        `<div class="sw-hint">${esc(triggerSummary(t))}</div></label>` +
      `<div class="sw-insp-actions"><button class="btn-sm sw-primary" id="sw-tr-save" type="button">Save triggers</button></div>` +
    `</div>`;
  }

  function wireTriggersForm() {
    const mode = inspectorEl.querySelector("#sw-tr-mode");
    if (!mode) return;
    const sync = () => {
      inspectorEl.querySelector("#sw-tr-interval").style.display = mode.value === "interval" ? "" : "none";
      inspectorEl.querySelector("#sw-tr-daily").style.display = mode.value === "daily" ? "" : "none";
    };
    mode.addEventListener("change", sync);
    sync();
    inspectorEl.querySelector("#sw-tr-save").addEventListener("click", saveTriggers);
  }

  async function saveTriggers() {
    const types = (inspectorEl.querySelector("#sw-tr-types")?.value || "")
      .split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    const payload = {
      schedule: {
        mode: inspectorEl.querySelector("#sw-tr-mode")?.value || "off",
        everySeconds: Number(inspectorEl.querySelector("#sw-tr-every")?.value || 0) || 300,
        at: inspectorEl.querySelector("#sw-tr-at")?.value.trim() || "09:00",
      },
      event: { enabled: !!inspectorEl.querySelector("#sw-tr-event")?.checked, types },
      task: inspectorEl.querySelector("#sw-tr-task")?.value ?? "",
    };
    try {
      const { res, data } = await S.api("/subagent-workflow/triggers", {}, Object.assign({ cwd }, payload));
      if (!res.ok || data?.error) throw new Error(data?.error || `HTTP ${res.status}`);
      triggers = data.triggers;
      paint();
      syncPolling();
      S.toast?.(data.triggers?.armed ? "Triggers armed" : "Triggers saved");
    } catch (err) {
      S.toast?.(String(err.message || err), "err");
    }
  }

  function harnessOptions(current) {
    const list = harnesses.length ? harnesses : [{ id: "claude", label: "Claude Code" }, { id: "codex", label: "Codex CLI" },
      { id: "gemini", label: "Gemini CLI" }, { id: "opencode", label: "opencode" }, { id: "aider", label: "Aider" },
      { id: "cursor", label: "Cursor Agent" }, { id: "pi", label: "Pi (built-in)" }, { id: "custom", label: "Custom command" }];
    return list.map((h) => {
      const unavailable = h.available === false;
      return `<option value="${escAttr(h.id)}"${h.id === current ? " selected" : ""}>${esc(h.label || h.id)}${unavailable ? " (not installed)" : ""}</option>`;
    }).join("");
  }

  /** The models a harness offers: Pi's are the app's whole model catalogue
   *  (`<provider>/<id>`, served with the harness list), a CLI's are the curated
   *  suggestions on its registry entry. */
  function harnessModels(hid) {
    const meta = harnessMeta(hid);
    return meta && Array.isArray(meta.models) ? meta.models : [];
  }
  const MODEL_CUSTOM = "__custom__";
  const modelId = (key) => String(key).split("/").slice(1).join("/");

  /**
   * `<optgroup>`s, one per provider, for catalogue keys. The group is what makes
   * the *provider* part of the choice: the value pi is handed is the whole
   * `<provider>/<id>` key, so two providers shipping the same model name can
   * never be confused — the ambiguity that fails a run with "Model … is ambiguous
   * across providers". (The same shape Settings' and the Office's model pickers
   * use.)
   */
  function modelOptionGroups(keys, selected) {
    const byProvider = new Map();
    for (const key of keys) {
      const provider = String(key).split("/")[0] || "other";
      if (!byProvider.has(provider)) byProvider.set(provider, []);
      byProvider.get(provider).push(key);
    }
    return [...byProvider.keys()].sort((a, b) => a.localeCompare(b)).map((provider) => {
      const group = byProvider.get(provider).sort((a, b) => a.localeCompare(b));
      return `<optgroup label="${escAttr(provider)}">` +
        group.map((key) => `<option value="${escAttr(key)}"${key === selected ? " selected" : ""}>${esc(key)}</option>`).join("") +
        `</optgroup>`;
    }).join("");
  }

  /**
   * The catalogue key a stored model means. A graph saved before the picker
   * carried providers holds a bare id; when exactly one provider offers it, that
   * key is what pi resolves, so the panel shows (and re-saves) the qualified id.
   * Two providers offering it is precisely the ambiguity pi refuses to guess at,
   * so nothing is picked here and the value is preserved through "Custom…".
   */
  function resolveModelKey(list, value) {
    const v = String(value || "");
    if (!v) return "";
    if (list.includes(v)) return v;
    const matches = list.filter((key) => modelId(key) === v);
    return matches.length === 1 ? matches[0] : "";
  }

  /**
   * The Model control for `hid`, with `current` selected. A value the harness's
   * list does not contain — an older id, or one typed as "Custom…" — is kept and
   * shown in the free-text box rather than being dropped on the next save.
   */
  function modelFieldHtml(hid, current) {
    const value = current || "";
    if (hid === "custom") {
      return `<label class="sw-field"><span>Model <em>(optional)</em></span>` +
        `<input class="set-input" id="sw-f-model" value="${escAttr(value)}" placeholder="passed to the command as $SW_MODEL"></label>`;
    }
    const pi = hid === "pi";
    const list = harnessModels(hid);
    // What the select shows as chosen: for Pi the catalogue key the stored value
    // resolves to, otherwise the stored value itself when the list knows it.
    const resolved = pi ? resolveModelKey(list, value) : (list.includes(value) ? value : "");
    const known = !!resolved;
    const opts = [`<option value=""${value ? "" : " selected"}>${pi ? "— agent default —" : "— harness default —"}</option>`]
      .concat(pi
        ? modelOptionGroups(list, resolved)
        : list.map((m) => `<option value="${escAttr(m)}"${m === resolved ? " selected" : ""}>${esc(m)}</option>`))
      .concat([`<option value="${MODEL_CUSTOM}"${known || !value ? "" : " selected"}>Custom…</option>`])
      .join("");
    const meta = harnessMeta(hid) || {};
    const hint = pi
      ? `Every model this app can run, grouped by provider — pi is given <code>provider/model</code>, so two providers offering the same name never clash. <b>Custom…</b> takes anything else.`
      : list.length
        ? `Models this harness documents — or <b>Custom…</b> for anything else.`
        : "No model list known for this harness — use <b>Custom…</b>.";
    // A stored model the catalogue cannot pin down (unknown, or offered by
    // several providers) stays exactly as it is, and says why.
    const bare = pi && value && !known ? list.filter((key) => modelId(key) === value) : [];
    const warn = !value || known ? ""
      : bare.length > 1
        ? `<div class="sw-hint sw-warn">⚠ <code>${esc(value)}</code> is offered by ${bare.length} providers (${esc(bare.join(", "))}) — pick one above: pi resolves <code>provider/model</code>.</div>`
        : pi ? `<div class="sw-hint">Stored as typed — it is not in this app's catalogue.</div>` : "";
    return `<label class="sw-field"><span>Model <em>(optional)</em></span>` +
      `<select class="set-select" id="sw-f-model">${opts}</select>` +
      `<input class="set-input sw-model-custom" id="sw-f-model-custom" value="${escAttr(known ? "" : value)}" ` +
        `placeholder="provider/model" style="display:${known || !value ? "none" : ""}">` +
      `<div class="sw-hint">${hint}${meta.modelFlag ? ` Passed as <code>${esc(meta.modelFlag)}</code>.` : ""}</div>` + warn + `</label>`;
  }

  /** The model the inspector is showing: the select's value, or the free-text
   *  box when the provider has no list / "Custom…" is chosen. */
  function readModelField() {
    const el = inspectorEl.querySelector("#sw-f-model");
    if (!el) return "";
    if (el.tagName !== "SELECT") return el.value.trim();
    if (el.value !== MODEL_CUSTOM) return el.value;
    return inspectorEl.querySelector("#sw-f-model-custom")?.value.trim() || "";
  }
  /** Wire "Custom…" on the model select to its free-text box. */
  function bindModelField() {
    const sel = inspectorEl.querySelector("#sw-f-model");
    if (!sel || sel.tagName !== "SELECT") return;
    const custom = inspectorEl.querySelector("#sw-f-model-custom");
    if (!custom) return;
    sel.addEventListener("change", () => {
      custom.style.display = sel.value === MODEL_CUSTOM ? "" : "none";
      if (sel.value === MODEL_CUSTOM) custom.focus();
    });
  }

  /** A path as the panel lists it: relative to the workspace when it is inside
   *  it, absolute otherwise. What is stored — and what the agent is given — is
   *  always the absolute path. */
  function refDisplayPath(p) {
    const full = String(p || "");
    const root = `${cwd || ""}/`;
    return cwd && full.startsWith(root) ? full.slice(root.length) : full;
  }

  /**
   * The node's **reference files**: the paths handed to its agent along with the
   * user message, each with a description. Adding, describing and removing are
   * their own server calls rather than part of the panel's save, because the
   * path has to be resolved and checked where the file actually is — and a path
   * the user typed is only canonical once the server has realpath'd it.
   */
  function refsFieldHtml(n) {
    const refs = Array.isArray(n.config?.refs) ? n.config.refs : [];
    const rows = refs.map((r) => {
      const shown = refDisplayPath(r.path);
      return `<div class="sw-ref-row" data-ref="${escAttr(r.id)}">` +
        `<span class="sw-ref-path" title="${escAttr(r.path)}">${esc(shown)}</span>` +
        `<input class="set-input sw-ref-note" value="${escAttr(r.note || "")}" spellcheck="false" ` +
          `placeholder="description sent with the path" aria-label="Description of ${escAttr(shown)}">` +
        `<button class="sw-ref-del" type="button" data-ref-del="${escAttr(r.id)}" ` +
          `title="Remove ${escAttr(shown)}">×</button></div>`;
    }).join("");
    return `<div class="sw-field sw-refs" id="sw-refs">` +
        `<span>Reference files <em>(optional)</em></span>` +
        (refs.length ? `<div class="sw-ref-list">${rows}</div>`
                     : `<div class="sw-hint" id="sw-refs-empty">No reference files yet.</div>`) +
        `<div class="sw-ref-add">` +
          `<input class="set-input" id="sw-ref-path" spellcheck="false" autocomplete="off" ` +
            `placeholder="docs/architecture.md — relative to the workspace">` +
          `<input class="set-input" id="sw-ref-note" spellcheck="false" autocomplete="off" ` +
            `placeholder="What it is (sent with the path)">` +
          `<button class="btn-sm" id="sw-ref-add-btn" type="button" title="Add this file as a reference of this node">Add</button>` +
        `</div>` +
        `<div class="sw-hint">Each path is injected into this node's message with its description. Leave the description empty and the file's own first heading is used.</div>` +
      `</div>`;
  }

  /** Wire the reference list: add, describe, remove. */
  function wireRefs(n) {
    const wrap = inspectorEl.querySelector("#sw-refs");
    if (!wrap) return;
    const pathEl = wrap.querySelector("#sw-ref-path");
    const noteEl = wrap.querySelector("#sw-ref-note");
    const add = () => {
      const p = pathEl.value.trim();
      if (!p) { S.toast?.("Give the reference a path", "err"); pathEl.focus(); return; }
      run_(() => post("addRef", { nodeId: n.id, path: p, note: noteEl.value.trim() }), "Reference added");
    };
    wrap.querySelector("#sw-ref-add-btn").addEventListener("click", add);
    for (const el of [pathEl, noteEl]) {
      el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
    }
    // A description saves on its own (silently on success — a toast per blur
    // would be noise) and a failed save says so.
    for (const el of wrap.querySelectorAll(".sw-ref-note")) {
      el.addEventListener("change", () => {
        const refId = el.closest(".sw-ref-row")?.dataset.ref;
        if (refId) run_(() => post("updateRef", { nodeId: n.id, refId, note: el.value.trim() }));
      });
    }
    for (const btn of wrap.querySelectorAll("[data-ref-del]")) {
      btn.addEventListener("click", () => run_(() => post("removeRef", { nodeId: n.id, refId: btn.dataset.refDel }), "Reference removed"));
    }
  }

  function renderNodeInspector(n) {
    const title = n.type === "agent" ? "Agent node"
      : n.type === "approval" ? "Approval node"
      : n.type === "start" ? "Start node" : "End node";
    // A node's settings are three things, deliberately: which provider runs it,
    // which model it uses, and the message it is handed. Everything else a node
    // can carry — access allowlists, extra args, working dir, fan-out, join,
    // timeout, retries, the data gate, the off switch — stays in its stored
    // config and is still honoured by the run engine, it is just not edited here.
    let fields = "";
    if (n.type === "agent") {
      const c = n.config || {};
      fields =
        `<label class="sw-field"><span class="sw-field-label">Provider <span id="sw-harness-icon">${harnessIcon(c.harness, providerLabel(c.harness))}</span></span>` +
          `<select class="set-select" id="sw-f-harness">${harnessOptions(c.harness)}</select>` +
          `<div class="sw-hint" id="sw-harness-hint"></div></label>` +
        `<div id="sw-model-wrap">${modelFieldHtml(c.harness, c.model)}</div>` +
        `<label class="sw-field"><span>User message</span>` +
          `<textarea class="set-input sw-textarea" id="sw-f-prompt" rows="5" spellcheck="false" placeholder="{input}">${esc(c.prompt || "")}</textarea>` +
          `<div class="sw-hint"><code>{input}</code> = what the nodes before this one produced, <code>{task}</code> = the run task.</div></label>` +
        `<label class="sw-field sw-only-custom" id="sw-custom-wrap"><span>Command</span>` +
          `<input class="set-input" id="sw-f-command" value="${escAttr(c.command || "")}" placeholder="my-agent -p &quot;$SW_PROMPT&quot;">` +
          `<div class="sw-hint">What this provider runs. <code>$SW_PROMPT</code>, <code>$SW_TASK</code>, <code>$SW_NODE</code> and <code>$SW_REFS</code> are set for it.</div></label>` +
        refsFieldHtml(n);
    } else if (n.type === "approval") {
      const c = n.config || {};
      fields =
        `<label class="sw-field"><span>User message</span>` +
          `<textarea class="set-input sw-textarea" id="sw-f-message" rows="5" spellcheck="false" placeholder="Approve the plan above before it is implemented.">${esc(c.message || "")}</textarea>` +
          `<div class="sw-hint">Shown in the approval banner while the run is paused. <code>{input}</code> = upstream output, <code>{task}</code> = the run task.</div></label>`;
    } else if (n.type === "start") {
      fields =
        `<label class="sw-field"><span>User message <em>(default task)</em></span>` +
          `<textarea class="set-input sw-textarea" id="sw-f-task" rows="4" spellcheck="false" placeholder="What should this workflow do?">${esc(n.config?.defaultTask || "")}</textarea>` +
          `<div class="sw-hint">Prefills the run bar. Every node wired off the start runs in parallel.</div></label>`;
    } else {
      // The end node shows the workflow's final output (see finalOutputHtml).
      fields = `<div id="sw-final-body">${finalOutputHtml()}</div>`;
    }

    inspectorEl.innerHTML =
      `<div class="sw-insp-head">` +
        (n.type === "agent"
          ? harnessIcon(n.config?.harness, providerLabel(n.config?.harness))
          : `<span class="sw-insp-glyph sw-t-${n.type}">${n.type === "start" ? "▶" : n.type === "end" ? "■" : "✋"}</span>`) +
        // The name is the node's label on the canvas, so it stays editable — it
        // is not one of the node's three settings, just what it is called.
        `<input class="set-input sw-insp-name" id="sw-f-name" value="${escAttr(n.name)}" maxlength="60" aria-label="Node name" placeholder="node name">` +
        `<span class="sw-insp-kind">${title.replace(" node", "")}</span></div>` +
      `<div class="sw-insp-body">${fields}</div>` +
      `<div class="sw-insp-actions">` +
        `<button class="btn-sm sw-primary" id="sw-save" type="button">Save node</button>` +
        (n.type !== "start" && n.type !== "end" ? `<button class="btn-sm" id="sw-duplicate" type="button" title="Clone this node, keeping its settings">Duplicate</button>` : "") +
        `<button class="btn-sm sw-danger" id="sw-delete" type="button">Delete</button>` +
      `</div>`;

    inspectorEl.querySelector("#sw-save").addEventListener("click", () => saveNode(n));
    inspectorEl.querySelector("#sw-delete").addEventListener("click", () => removeNode(n.id));
    inspectorEl.querySelector("#sw-duplicate")?.addEventListener("click", () => duplicateNode(n.id));
    bindModelField();
    wireRefs(n);
    const harnessSel = inspectorEl.querySelector("#sw-f-harness");
    if (harnessSel) {
      const syncCustom = () => {
        const custom = harnessSel.value === "custom";
        // `display: none` is the stylesheet default, so showing it has to name
        // the display the field uses (a column).
        inspectorEl.querySelector("#sw-custom-wrap").style.display = custom ? "flex" : "none";
        const meta = harnessMeta(harnessSel.value);
        const hint = inspectorEl.querySelector("#sw-harness-hint");
        hint.textContent = meta && meta.available === false
          ? `⚠ ${meta.bin || meta.label} was not found on PATH — the node will fail until it is installed.`
          : meta ? `Runs: ${meta.bin ? `${meta.bin}` : "the app's Pi runner"}` : "";
        hint.className = meta && meta.available === false ? "sw-hint sw-warn" : "sw-hint";
        // The head + the field label show the provider's mark, so switching
        // harness updates both without re-rendering the form.
        setHarnessIcon(inspectorEl.querySelector("#sw-harness-icon"), harnessSel.value, providerLabel(harnessSel.value));
        setHarnessIcon(inspectorEl.querySelector(".sw-insp-head .sw-hicon"), harnessSel.value, providerLabel(harnessSel.value));
      };
      // The model list belongs to the provider, so switching it rewrites just
      // that block — carrying over what the user has typed but not saved —
      // instead of the whole form, which would throw away an unsaved message.
      harnessSel.addEventListener("change", () => {
        const model = readModelField();
        inspectorEl.querySelector("#sw-model-wrap").innerHTML = modelFieldHtml(harnessSel.value, model);
        bindModelField();
        syncCustom();
      });
      syncCustom();
    }
  }

  function renderEdgeInspector() {
    const e = edges().find((x) => x.id === selected.id);
    if (!e) { selected = null; return renderInspector(); }
    const from = nodeById(e.from), to = nodeById(e.to);
    inspectorEl.innerHTML =
      `<div class="sw-insp-head"><span class="sw-insp-glyph">⇢</span><span class="sw-insp-title">Connection</span></div>` +
      `<div class="sw-insp-body"><p class="sw-conn-label"><b>${esc(from?.name || e.from)}</b> → <b>${esc(to?.name || e.to)}</b></p>` +
        `<p class="sw-muted">The source node's output is passed to the target as <code>{input}</code>.</p></div>` +
      `<div class="sw-insp-actions"><button class="btn-sm sw-danger" id="sw-del-edge" type="button">Delete connection</button></div>`;
    inspectorEl.querySelector("#sw-del-edge").addEventListener("click", () => removeEdge(e.id));
  }

  /**
   * Save the node's name and its three settings. The config is merged over what
   * is stored rather than rebuilt from the form, so every key this panel no
   * longer edits survives an edit instead of being silently dropped.
   */
  async function saveNode(n) {
    const name = inspectorEl.querySelector("#sw-f-name")?.value.trim() || "";
    if (!name) { S.toast?.("A node needs a name", "err"); return; }
    const stored = nodeById(n.id)?.config || {};
    const read = (sel, fallback) => {
      const el = inspectorEl.querySelector(sel);
      return el ? el.value : fallback;
    };
    let config;
    if (n.type === "agent") {
      config = {
        ...stored,
        harness: inspectorEl.querySelector("#sw-f-harness")?.value || "claude",
        model: readModelField(),
        prompt: read("#sw-f-prompt", stored.prompt || ""),
        // Only rendered while the provider is a custom command; otherwise the
        // stored one is kept untouched.
        command: read("#sw-f-command", stored.command || ""),
      };
    } else if (n.type === "approval") {
      config = { ...stored, message: read("#sw-f-message", stored.message || "") };
    } else {
      config = { ...stored };
      if (n.type === "start") config.defaultTask = read("#sw-f-task", stored.defaultTask || "");
    }
    await run_(() => post("updateNode", { id: n.id, name, config }), "Node saved");
  }

  async function addNode(type) {
    const scroll = pane.querySelector(".sw-canvas-scroll");
    const x = Math.round((scroll?.scrollLeft || 0) + 260 + Math.random() * 80);
    const y = Math.round((scroll?.scrollTop || 0) + 180 + Math.random() * 80);
    const what = type === "agent" ? "Agent added" : type === "approval" ? "Approval gate added" : `${type} node added`;
    await run_(() => post("addNode", { type, x, y }), what);
  }
  async function duplicateNode(id) {
    await run_(() => post("duplicateNode", { id }), "Node duplicated");
  }
  async function removeNode(id) {
    await run_(() => post("removeNode", { id }), "Node deleted");
    if (selected && selected.id === id) selected = null;
  }
  async function removeEdge(id) {
    await run_(() => post("removeEdge", { id }), "Connection deleted");
    if (selected && selected.id === id) selected = null;
  }

  async function run_(fn, okMsg) {
    try { wf = await fn(); paint(); if (okMsg) S.toast?.(okMsg); }
    catch (err) { S.toast?.(String(err.message || err), "err"); }
  }

  // ─── Portable workflows ───────────────────────────────────────────────────

  /** The graph as a shareable file: name, nodes and edges — no run state, no
   *  absolute paths beyond whatever a node's own config carries. */
  function workflowFile() {
    return { name: wf?.name || "My Workflow", nodes: nodes(), edges: edges() };
  }

  function exportWorkflow() {
    if (!wf) return;
    const blob = new Blob([JSON.stringify(workflowFile(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const slug = String(wf.name || "workflow").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
    a.href = url;
    a.download = `${slug || "workflow"}.workflow.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    S.toast?.("Workflow exported");
  }

  /** Replace the graph with a file the user picked. The server re-validates it
   *  (ids, node kinds, edge shape, cycles) before it is stored, so an imported
   *  file is exactly as safe as a hand-built one. */
  async function importWorkflow(e) {
    const input = e.target;
    const file = input.files && input.files[0];
    input.value = ""; // so re-picking the same file fires `change` again
    if (!file) return;
    let data;
    try { data = JSON.parse(await file.text()); }
    catch { S.toast?.("That file is not valid JSON", "err"); return; }
    if (!window.confirm?.(`Replace the current workflow with “${data?.name || file.name}”?`)) return;
    selected = null;
    await run_(() => post("importWorkflow", { data }), "Workflow imported");
  }

  // ─── Dragging + connecting ────────────────────────────────────────────────

  function canvasPoint(cx, cy) {
    const rect = canvasEl.getBoundingClientRect();
    return { x: cx - rect.left, y: cy - rect.top };
  }
  /** Coalesce high-frequency pointer work to one animation frame. */
  let frameQueued = false;
  function onFrame(fn) {
    if (frameQueued) return;
    frameQueued = true;
    requestAnimationFrame(() => { frameQueued = false; fn(); });
  }

  function startDrag(nodeEl, e) {
    const n = nodeById(nodeEl.dataset.id);
    if (!n) return;
    drag = {
      id: n.id, el: nodeEl, sx: e.clientX, sy: e.clientY, px: e.clientX, py: e.clientY,
      x: n.x, y: n.y, moved: false,
      // Only this node's edges move while it is dragged — fixed for the drag.
      edges: edges().filter((ed) => ed.from === n.id || ed.to === n.id),
    };
    document.addEventListener("mousemove", onDragMove);
    document.addEventListener("mouseup", onDragUp);
  }
  /** Apply the drag at most once per frame: reposition the node and re-route its
   *  own edges. The node's position is known from the model, so this reads no
   *  layout at all, and the canvas size is left alone until the drop. */
  function applyDrag() {
    if (!drag) return;
    const dx = drag.px - drag.sx, dy = drag.py - drag.sy;
    const nx = Math.max(0, Math.round(drag.x + dx)), ny = Math.max(0, Math.round(drag.y + dy));
    drag.el.style.left = `${nx}px`; drag.el.style.top = `${ny}px`;
    const n = nodeById(drag.id);
    if (n) { n.x = nx; n.y = ny; }
    const b = boxCache.get(drag.id);
    if (b) { b.x = nx; b.y = ny; }
    layoutEdges(drag.edges, false);
  }
  function onDragMove(e) {
    if (!drag) return;
    drag.px = e.clientX; drag.py = e.clientY;
    if (Math.abs(drag.px - drag.sx) + Math.abs(drag.py - drag.sy) > 3) drag.moved = true;
    onFrame(applyDrag);
  }
  function onDragUp() {
    document.removeEventListener("mousemove", onDragMove);
    document.removeEventListener("mouseup", onDragUp);
    if (!drag) return;
    const d = drag;
    applyDrag(); // flush the last pointer position before committing
    drag = null;
    if (d.moved) run_(() => post("moveNode", { id: d.id, x: nodeById(d.id)?.x ?? d.x, y: nodeById(d.id)?.y ?? d.y }));
    else renderInspector();
    if (dirty) paint();
  }
  function startLink(fromId) {
    link = { fromId };
    document.addEventListener("mousemove", onLinkMove);
    document.addEventListener("mouseup", onLinkUp);
  }
  function onLinkMove(e) {
    if (!link) return;
    link.px = e.clientX; link.py = e.clientY;
    onFrame(() => {
      if (!link) return;
      const p = canvasPoint(link.px, link.py);
      showTmpPath(link.fromId, p.x, p.y);
    });
  }
  function onLinkUp(e) {
    document.removeEventListener("mousemove", onLinkMove);
    document.removeEventListener("mouseup", onLinkUp);
    const l = link;
    link = null;
    hideTmpPath();
    if (dirty) paint();
    if (!l) return;
    const nodeEl = document.elementsFromPoint(e.clientX, e.clientY)
      .map((el) => el.closest?.(".sw-node")).find(Boolean);
    if (!nodeEl || nodeEl.dataset.id === l.fromId) return;
    const to = nodeById(nodeEl.dataset.id);
    if (!to || to.type === "start") { S.toast?.("The start node cannot receive connections", "err"); return; }
    run_(() => post("addEdge", { from: l.fromId, to: nodeEl.dataset.id }), "Connected");
  }

  // ─── Run bar + log ────────────────────────────────────────────────────────

  function renderRun() {
    const shown = viewRun();
    const live = run;
    const status = shown?.status || "idle";
    // A gate only ever holds the *live* run; a past run is read-only.
    const waiting = !historyRun && live?.status === "running" ? waitingNodes() : [];
    if (runBtn) runBtn.disabled = live?.status === "running";
    if (stopBtn) stopBtn.disabled = live?.status !== "running";
    if (runStatusEl) {
      runStatusEl.className = `sw-run-status sw-rs-${waiting.length ? "waiting" : status}`;
      if (!shown) runStatusEl.textContent = "no run yet";
      else {
        const ids = nodes().map((n) => n.id).filter((id) => nodeById(id)?.type !== "start");
        const done = ids.filter((id) => runNode(id)?.status === "done").length;
        const secs = Math.max(0, Math.round(((shown.finishedAt || Date.now()) - shown.startedAt) / 1000));
        const label = historyRun ? `${status} · past run`
          : status !== "running" ? status
          : waiting.length ? `waiting for approval (${waiting.length})` : "running";
        runStatusEl.textContent = `${label} · ${done}/${ids.length} nodes · ${secs}s`;
      }
    }
    if (runSummaryEl) {
      runSummaryEl.textContent = shown ? `${shown.log?.length || 0} log lines` : "";
    }
    renderHistory();
    renderApprovals();
    // Rewrite the log only when it changed, so the panel does not flicker.
    if (runLogEl) {
      const entries = historyRun ? (historyRun.log || []) : logBuffer;
      const sig = `${historyRun ? historyRun.id : "live"}:${entries.length}:${entries[entries.length - 1]?.seq || 0}`;
      if (sig !== logSig) {
        logSig = sig;
        runLogEl.innerHTML = entries.length
          ? entries.map((l) => {
              const name = l.nodeId ? (nodeById(l.nodeId)?.name || "node") : "run";
              return `<div class="sw-log-line sw-log-${escAttr(l.stream)}">` +
                `<span class="sw-log-node">${esc(name)}</span>` +
                `<span class="sw-log-text">${esc(l.text)}</span></div>`;
            }).join("")
          : `<div class="sw-log-empty">${historyRun ? "This run logged nothing." : "Run the workflow to see each node's output stream here."}</div>`;
        runLogEl.scrollTop = runLogEl.scrollHeight;
      }
    }
  }

  /** The approval gates currently holding the LIVE run, in graph order. */
  function waitingNodes() {
    return nodes().filter((n) => n.type === "approval" && run?.nodes?.[n.id]?.status === "waiting");
  }

  // ─── Run history ──────────────────────────────────────────────────────────

  function historyLabel(h) {
    const when = h.finishedAt || h.startedAt;
    const stamp = when ? (S.fmtRel ? S.fmtRel(when) : new Date(when).toLocaleString()) : "";
    const task = h.task ? ` — ${S.trunc ? S.trunc(h.task, 36) : h.task}` : "";
    return `${stamp}${stamp ? " · " : ""}${h.status}${task}`;
  }

  /**
   * The history picker. Rebuilt only when the list changes, and restored to the
   * run being viewed, so a poll tick never resets the user's selection.
   */
  function renderHistory() {
    if (!historyEl) return;
    // The live run is what the graph shows by default, so it is not a history
    // entry — everything else in the list is a run you can reopen.
    const items = historyList.filter((h) => h.id !== run?.id);
    const sig = `${items.map((h) => `${h.id}:${h.status}`).join(",")}|${historyRun?.id || ""}`;
    if (sig === historySig) return;
    historySig = sig;
    historyEl.innerHTML = `<option value="">Live run</option>` +
      items.map((h) => `<option value="${escAttr(h.id)}">${esc(historyLabel(h))}</option>`).join("");
    historyEl.value = historyRun && items.some((h) => h.id === historyRun.id) ? historyRun.id : "";
    historyEl.disabled = items.length === 0;
  }

  /** Show a past run on the canvas and in the log, or go back to the live one. */
  async function selectHistory(id) {
    if (!id) { historyRun = null; historySig = ""; paint(); return; }
    try {
      const { res, data } = await S.api("/subagent-workflow/history", params({ id }));
      if (!res.ok || !data?.run) throw new Error(data?.error || `HTTP ${res.status}`);
      historyRun = data.run;
      paint();
    } catch (err) {
      S.toast?.(String(err.message || err), "err");
      historySig = "";
      renderHistory();
    }
  }

  async function refreshHistory() {
    try { historyList = (await getJson("/subagent-workflow/history")).history || []; }
    catch { /* keep what we have */ }
    renderHistory();
  }

  /**
   * The approval banner. Rebuilt only when the set of waiting gates changes, so a
   * poll tick never steals focus from a note the reviewer is typing.
   */
  function renderApprovals() {
    if (!approvalsEl) return;
    // A past run has nothing to decide; hide the banner while it is on screen.
    if (historyRun) {
      if (approvalSig !== "") { approvalSig = ""; approvalsEl.classList.remove("show"); approvalsEl.innerHTML = ""; }
      return;
    }
    const waiting = waitingNodes();
    const sig = waiting.map((n) => `${n.id}:${runNode(n.id)?.approval?.requestedAt || 0}`).join(",");
    if (sig === approvalSig) return;
    approvalSig = sig;
    if (!waiting.length) {
      approvalsEl.classList.remove("show");
      approvalsEl.innerHTML = "";
      return;
    }
    approvalsEl.classList.add("show");
    approvalsEl.innerHTML = waiting.map((n) => {
      const msg = runNode(n.id)?.approval?.message || n.config?.message || n.config?.description || "";
      return `<div class="sw-approval" data-node="${escAttr(n.id)}">` +
        `<div class="sw-approval-head"><span class="sw-approval-glyph">✋</span>` +
          `<span class="sw-approval-title">${esc(n.name)} needs a decision</span></div>` +
        (msg ? `<pre class="sw-approval-msg">${esc(msg)}</pre>`
             : `<div class="sw-muted">This gate has no message.</div>`) +
        `<div class="sw-approval-actions">` +
          `<input class="set-input sw-approval-note" placeholder="Optional note for the run log…">` +
          `<button class="btn-sm sw-primary" data-approve="${escAttr(n.id)}" type="button">✓ Approve</button>` +
          `<button class="btn-sm sw-danger" data-reject="${escAttr(n.id)}" type="button">✕ Reject</button>` +
        `</div></div>`;
    }).join("");
    for (const btn of approvalsEl.querySelectorAll("[data-approve]")) {
      btn.addEventListener("click", () => decideApproval(btn.closest(".sw-approval"), btn.dataset.approve, true));
    }
    for (const btn of approvalsEl.querySelectorAll("[data-reject]")) {
      btn.addEventListener("click", () => decideApproval(btn.closest(".sw-approval"), btn.dataset.reject, false));
    }
  }

  async function decideApproval(card, nodeId, approve) {
    const note = card?.querySelector(".sw-approval-note")?.value ?? "";
    try {
      // The response is a full run, so replace the accumulated buffer rather
      // than concatenating it onto itself.
      const data = await postRun(approve ? "approve" : "reject", { nodeId, note });
      adoptRun(data.run, true);
      paintRun();
      syncPolling();
      if (data.run?.status !== "running") void refreshHistory();
      S.toast?.(approve ? "Approved" : "Rejected");
    } catch (err) {
      S.toast?.(String(err.message || err), "err");
    }
  }

  async function startRun() {
    const task = taskInput?.value ?? "";
    try {
      const data = await postRun("start", { task });
      historyRun = null; // a new run takes the canvas back to the live view
      historySig = "";
      adoptRun(data.run, true);
      paint();
      syncPolling();
      S.toast?.("Workflow run started");
    } catch (err) {
      S.toast?.(String(err.message || err), "err");
    }
  }
  async function stopRun() {
    try {
      const data = await postRun("stop");
      adoptRun(data.run, true);
      paint();
      syncPolling();
      void refreshHistory();
    } catch (err) {
      S.toast?.(String(err.message || err), "err");
    }
  }

  // ─── Build ────────────────────────────────────────────────────────────────

  function build(paneEl) {
    pane = paneEl;
    resetCanvasState(); // the canvas DOM is about to be replaced
    pane.innerHTML =
      `<div class="pane-header sw-header">` +
        `<input class="sw-name-input" id="sw-name" value="" maxlength="60" title="Workflow name" aria-label="Workflow name">` +
        `<span class="sw-status" id="sw-status"></span>` +
        `<div class="sw-toolbar">` +
          `<button class="btn-sm sw-primary" id="sw-add-agent" type="button" title="Add an agent node">+ Agent</button>` +
          `<button class="btn-sm" id="sw-add-approval" type="button" title="Add a human approval gate">+ Approval</button>` +
          `<button class="btn-sm" id="sw-add-start" type="button" title="Add the start node">+ Start</button>` +
          `<button class="btn-sm" id="sw-add-end" type="button" title="Add the end node">+ End</button>` +
          `<button class="btn-sm" id="sw-export" type="button" title="Download this workflow as JSON">⬇ Export</button>` +
          `<button class="btn-sm" id="sw-import" type="button" title="Load a workflow JSON file">⬆ Import</button>` +
          `<input type="file" id="sw-import-file" accept="application/json,.json" style="display:none">` +
          `<button class="btn-sm" id="sw-refresh" type="button" title="Reload the workflow">↻</button>` +
        `</div>` +
      `</div>` +
      `<div class="sw-runbar">` +
        `<input class="set-input sw-task" id="sw-task" placeholder="Task / initial prompt for this run…" aria-label="Run task">` +
        `<button class="btn-sm sw-primary" id="sw-run" type="button">▶ Run</button>` +
        `<button class="btn-sm sw-danger" id="sw-stop" type="button" disabled>■ Stop</button>` +
        `<span class="sw-run-status" id="sw-run-status"></span>` +
      `</div>` +
      `<div class="sw-body">` +
        `<div class="sw-main">` +
          `<div class="sw-canvas-scroll">` +
            `<div class="sw-canvas" id="sw-canvas">` +
              `<svg class="sw-edges" xmlns="http://www.w3.org/2000/svg" width="1000" height="700">` +
                `<g id="sw-edge-paths"></g><path id="sw-tmp" class="sw-tmp" style="display:none"></path></svg>` +
              `<div class="sw-nodes" id="sw-nodes"></div>` +
              `<div class="sw-edge-btns" id="sw-edge-btns"></div>` +
            `</div>` +
          `</div>` +
          `<aside class="sw-inspector" id="sw-inspector"></aside>` +
        `</div>` +
        `<section class="sw-run-panel">` +
          `<div class="sw-run-head"><span class="sw-run-title">Run log</span>` +
            `<select class="set-select sw-history-select" id="sw-history" title="Reopen a past run"><option value="">Latest run</option></select>` +
            `<span class="sw-run-summary" id="sw-run-summary"></span>` +
            `<button class="sw-run-toggle" id="sw-run-toggle" type="button">▾</button></div>` +
          `<div class="sw-approvals" id="sw-approvals"></div>` +
          `<div class="sw-run-log" id="sw-run-log"></div>` +
        `</section>` +
      `</div>`;

    nameInput = pane.querySelector("#sw-name");
    statusEl = pane.querySelector("#sw-status");
    taskInput = pane.querySelector("#sw-task");
    runStatusEl = pane.querySelector("#sw-run-status");
    runLogEl = pane.querySelector("#sw-run-log");
    runSummaryEl = pane.querySelector("#sw-run-summary");
    historyEl = pane.querySelector("#sw-history");
    approvalsEl = pane.querySelector("#sw-approvals");
    runBtn = pane.querySelector("#sw-run");
    stopBtn = pane.querySelector("#sw-stop");
    canvasEl = pane.querySelector("#sw-canvas");
    nodesEl = pane.querySelector("#sw-nodes");
    svgEl = pane.querySelector("svg.sw-edges");
    edgePathsEl = pane.querySelector("#sw-edge-paths");
    tmpPathEl = pane.querySelector("#sw-tmp");
    edgeBtnsEl = pane.querySelector("#sw-edge-btns");
    inspectorEl = pane.querySelector("#sw-inspector");

    nameInput.addEventListener("change", () => run_(() => post("setWorkflowName", { name: nameInput.value.trim() || "My Workflow" }), "Renamed"));
    pane.querySelector("#sw-add-agent").addEventListener("click", () => addNode("agent"));
    pane.querySelector("#sw-add-approval").addEventListener("click", () => addNode("approval"));
    pane.querySelector("#sw-add-start").addEventListener("click", () => addNode("start"));
    pane.querySelector("#sw-add-end").addEventListener("click", () => addNode("end"));
    pane.querySelector("#sw-export").addEventListener("click", exportWorkflow);
    const importFile = pane.querySelector("#sw-import-file");
    pane.querySelector("#sw-import").addEventListener("click", () => importFile.click());
    importFile.addEventListener("change", importWorkflow);
    pane.querySelector("#sw-refresh").addEventListener("click", () => { refresh(); loadHarnesses(); });
    runBtn.addEventListener("click", startRun);
    stopBtn.addEventListener("click", stopRun);
    historyEl.addEventListener("change", () => selectHistory(historyEl.value));
    taskInput.addEventListener("keydown", (e) => { if (e.key === "Enter") startRun(); });
    pane.querySelector("#sw-run-toggle").addEventListener("click", (e) => {
      const panel = pane.querySelector(".sw-run-panel");
      const collapsed = panel.classList.toggle("collapsed");
      e.currentTarget.textContent = collapsed ? "▴" : "▾";
    });

    canvasEl.addEventListener("mousedown", (e) => {
      const port = e.target.closest?.(".sw-port-out");
      if (port) { e.preventDefault(); e.stopPropagation(); startLink(port.closest(".sw-node").dataset.id); return; }
      const del = e.target.closest?.(".sw-node-del");
      if (del) { e.preventDefault(); e.stopPropagation(); removeNode(del.dataset.del); return; }
      const edgeDel = e.target.closest?.(".sw-edge-del");
      if (edgeDel) { e.preventDefault(); e.stopPropagation(); removeEdge(edgeDel.dataset.edge); return; }
      const nodeEl = e.target.closest?.(".sw-node");
      if (nodeEl) {
        e.preventDefault();
        const id = nodeEl.dataset.id;
        selected = { kind: "node", id };
        renderNodes(); renderInspector();
        // renderNodes() rebuilds `nodesEl.innerHTML`, so the element this event
        // came from is now detached: a drag that kept writing to it would move
        // nothing on screen while the model (and therefore the edge routing)
        // moved underneath. Hand the drag the node that is actually rendered.
        startDrag(nodesEl.querySelector(`.sw-node[data-id="${CSS.escape(id)}"]`) || nodeEl, e);
        return;
      }
      if (selected) { selected = null; renderNodes(); renderInspector(); }
    });

    // Copying the workflow's final output: delegated, because the block is
    // rewritten as the output grows (and for a reopened past run).
    inspectorEl.addEventListener("click", (e) => {
      if (!e.target.closest?.("#sw-final-copy")) return;
      const text = finalOutput().text;
      if (!text) return;
      Promise.resolve(navigator.clipboard?.writeText(text))
        .then(() => S.toast?.("Final output copied"))
        .catch(() => S.toast?.("Could not copy the final output", "err"));
    });

    edgePathsEl.addEventListener("click", (e) => {
      const path = e.target.closest?.(".sw-edge");
      if (!path) return;
      selected = { kind: "edge", id: path.dataset.edge };
      renderEdges(); renderInspector();
    });

    canvasEl.addEventListener("keydown", (e) => {
      if (e.key !== "Delete" && e.key !== "Backspace" || !selected) return;
      e.preventDefault();
      if (selected.kind === "node") removeNode(selected.id);
      else removeEdge(selected.id);
    });
  }

  function loadStyles() {
    const src = document.currentScript && document.currentScript.src;
    if (!src) return;
    const href = src.replace(/client\.js(\?|$)/, "client.css$1");
    if (!href || href === src || document.querySelector(`link[href="${href}"]`)) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.appendChild(link);
  }

  S.Plugins.register({
    id: "subagent-workflow",
    name: "Subagent Workflow",
    description:
      "Wire coding-agent harnesses (Claude Code, Codex CLI, Gemini CLI, opencode, Aider, Cursor, Pi, or a custom command) into a fan-out workflow and run it server-side, watching each node stream its output.",
    nav: { label: "Workflow", order: 75, group: "timeline", title: "Design and run a multi-harness workflow" },
    view: {
      pane: "#subagent-workflow-pane",
      display: "flex",
      session: "none",
      render: (paneEl) => { loadStyles(); build(paneEl); },
      onShow: () => {
        const el = document.getElementById("subagent-workflow-pane");
        if (!el) return;
        if (!pane || pane !== el) build(el);
        // Opening the view shows the live run, not whatever was last reopened.
        historyRun = null;
        historySig = "";
        cwd = S.currentCwd?.() || "";
        // `refresh()` paints when the graph arrives; the harness list only feeds
        // the inspector, so it does not trigger a second canvas paint.
        void loadHarnesses();
        refresh();
      },
      onHide: stopPolling,
      onCwd: () => { cwd = S.currentCwd?.() || ""; historyRun = null; historySig = ""; refresh(); },
      onReconnect: () => refresh(),
    },
  });
})();
