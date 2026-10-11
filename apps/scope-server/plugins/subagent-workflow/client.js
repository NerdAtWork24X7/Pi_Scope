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

  /** Model ids offered as <datalist> suggestions; any string is allowed. */
  const NODE_W = 220;
  const POLL_MS = 900;

  let pane = null;
  let canvasEl = null, nodesEl = null, svgEl = null, edgePathsEl = null, tmpPathEl = null, edgeBtnsEl = null;
  let inspectorEl = null, statusEl = null, nameInput = null, taskInput = null;
  let runStatusEl = null, runLogEl = null, runSummaryEl = null, runBtn = null, stopBtn = null;

  let wf = null;
  let run = null;
  let harnesses = [];
  /** What this machine actually offers: the app's skill / tool / extension
   *  catalogue (`GET /settings`) plus its real Pi model list (`GET /models`). */
  let catalog = { skills: [], tools: [], toolSources: {}, extensions: [] };
  let piModels = [];
  let cwd = "";
  let selected = null;
  let drag = null;
  let link = null;
  let loadError = null;
  let dirty = false;
  let pollTimer = null;
  // Log lines accumulated client-side across incremental polls, plus the last
  // run seq we have seen (so a poll fetches only what is new).
  let logBuffer = [];
  let logSig = "";
  let runSince = 0;

  const nodes = () => (wf && Array.isArray(wf.nodes) ? wf.nodes : []);
  const edges = () => (wf && Array.isArray(wf.edges) ? wf.edges : []);
  const nodeById = (id) => nodes().find((n) => n.id === id) || null;
  const runNode = (id) => (run && run.nodes ? run.nodes[id] : null) || null;
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
      if (next && run && next.seq === run.seq && next.status === run.status) { syncPolling(); return; }
      adoptRun(next, false);
      paintRun();
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

  /**
   * Load the machine's skill / tool / extension catalogue and Pi's real model
   * list, so a node picks from what is installed here instead of a guess. Both
   * halves are independent: whichever fails leaves the other (and the graph)
   * alone. Only the inspector depends on them, so this never repaints the canvas.
   */
  async function loadCatalog() {
    const [settings, models] = await Promise.all([
      getJson("/settings").catch(() => null),
      getJson("/models").catch(() => null),
    ]);
    if (settings) {
      catalog = {
        skills: Array.isArray(settings.skills) ? settings.skills : [],
        tools: Array.isArray(settings.tools) ? settings.tools : [],
        toolSources: settings.toolSources && typeof settings.toolSources === "object" ? settings.toolSources : {},
        extensions: Array.isArray(settings.extensions) ? settings.extensions : [],
      };
    }
    if (models) piModels = Array.isArray(models.models) ? models.models : [];
    renderInspector();
  }

  function syncPolling() {
    const running = run && run.status === "running";
    if (running && !pollTimer) pollTimer = setInterval(refreshRun, POLL_MS);
    else if (!running && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  /** Forget the routed-edge elements: the pane's DOM is being rebuilt. */
  function resetCanvasState() {
    edgeEls.clear();
    boxCache.clear();
    canvasW = 0; canvasH = 0;
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
    renderRun();
  }

  /** Toggle the per-node run classes and badges in place. */
  function applyRunStatuses() {
    const statuses = run?.nodes || {};
    for (const el of nodesEl.querySelectorAll(".sw-node")) {
      const st = statuses[el.dataset.id]?.status || "";
      for (const cls of [...el.classList]) if (cls.startsWith("sw-run-")) el.classList.remove(cls);
      if (st) el.classList.add(`sw-run-${st}`);
      let badge = el.querySelector(".sw-badge");
      if (!st) { if (badge) badge.remove(); continue; }
      if (!badge) {
        badge = document.createElement("span");
        el.querySelector(".sw-node-head")?.insertBefore(badge, el.querySelector(".sw-node-del"));
      }
      badge.className = `sw-badge sw-b-${st}`;
      badge.textContent = badgeGlyph(st);
      badge.title = st;
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

  function nodeSummary(n) {
    if (n.type === "agent") {
      const h = harnessMeta(n.config?.harness);
      const label = h ? h.label : (n.config?.harness || "agent");
      const model = n.config?.model ? ` · ${n.config.model}` : "";
      return `<div class="sw-node-model">${esc(label)}${esc(model)}</div>` +
        `<div class="sw-node-desc">${esc(n.config?.prompt?.trim() || "{input}")}</div>`;
    }
    return `<div class="sw-node-desc">${esc(n.config?.description || (n.type === "start" ? "Workflow entry point" : "Workflow exit"))}</div>`;
  }

  function renderNodes() {
    const sel = selected && selected.kind === "node" ? selected.id : null;
    nodesEl.innerHTML = nodes().map((n) => {
      const st = runNode(n.id)?.status || "";
      const cls = `sw-node sw-t-${n.type}${n.id === sel ? " sel" : ""}${st ? ` sw-run-${st}` : ""}`;
      const badge = st ? `<span class="sw-badge sw-b-${st}" title="${escAttr(st)}">${badgeGlyph(st)}</span>` : "";
      const inPort = n.type !== "start" ? `<span class="sw-port sw-port-in" data-port="in" title="Input"></span>` : "";
      const outPort = n.type !== "end" ? `<span class="sw-port sw-port-out" data-port="out" title="Drag to connect to another node"></span>` : "";
      return `<div class="${cls}" data-id="${escAttr(n.id)}" style="left:${n.x}px;top:${n.y}px">` +
        `<div class="sw-node-head">` +
          `<span class="sw-node-glyph">${n.type === "start" ? "▶" : n.type === "end" ? "■" : "⬡"}</span>` +
          `<span class="sw-node-name" title="${escAttr(n.name)}">${esc(n.name)}</span>` +
          badge +
          `<button class="sw-node-del" data-del="${escAttr(n.id)}" title="Delete node" type="button">✕</button>` +
        `</div>` +
        `<div class="sw-node-body">${nodeSummary(n)}</div>` +
        inPort + outPort +
      `</div>`;
    }).join("");
  }

  function badgeGlyph(st) {
    return st === "running" ? "◌" : st === "done" ? "✔" : st === "error" ? "✖" : st === "skipped" ? "–" : st === "stopped" ? "■" : "·";
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
      `</div>`;
    inspectorEl.querySelector("#sw-retry")?.addEventListener("click", refresh);
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

  /** The models a harness offers: Pi's come from the app's live catalogue, a
   *  CLI's are the curated suggestions on its registry entry. */
  function harnessModels(hid) {
    if (hid === "pi") return piModels;
    const meta = harnessMeta(hid);
    return meta && Array.isArray(meta.models) ? meta.models : [];
  }
  const MODEL_CUSTOM = "__custom__";

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
    const list = harnessModels(hid);
    const known = !!value && list.includes(value);
    const opts = [`<option value=""${value ? "" : " selected"}>— harness default —</option>`]
      .concat(list.map((m) => `<option value="${escAttr(m)}"${m === value ? " selected" : ""}>${esc(m)}</option>`))
      .concat([`<option value="${MODEL_CUSTOM}"${known || !value ? "" : " selected"}>Custom…</option>`])
      .join("");
    const meta = harnessMeta(hid) || {};
    const hint = hid === "pi"
      ? "The app's Pi model catalogue."
      : list.length
        ? `Models this harness documents — or <b>Custom…</b> for anything else.`
        : "No model list known for this harness — use <b>Custom…</b>.";
    return `<label class="sw-field"><span>Model <em>(optional)</em></span>` +
      `<select class="set-select" id="sw-f-model">${opts}</select>` +
      `<input class="set-input sw-model-custom" id="sw-f-model-custom" value="${escAttr(known ? "" : value)}" ` +
        `placeholder="provider/model" style="display:${known || !value ? "none" : ""}">` +
      `<div class="sw-hint">${hint}${meta.modelFlag ? ` Passed as <code>${esc(meta.modelFlag)}</code>.` : ""}</div></label>`;
  }

  /**
   * The node's access to the machine's skills, tools and extensions: one
   * checkbox row per catalogue entry, grouped, each group labelled with the flag
   * the chosen harness will use — or with why it cannot be used, so a toggle is
   * never a silent no-op.
   */
  function capsHtml(hid, sel) {
    const caps = (harnessMeta(hid) || {}).capabilities || {};
    const groups = [
      {
        kind: "skills", label: "Skills", cap: caps.skills,
        entries: catalog.skills.map((s) => ({ value: s.dir, label: s.name || s.dir, note: s.description })),
      },
      {
        kind: "tools", label: "Tools", cap: caps.tools,
        entries: catalog.tools.map((t) => ({ value: t, label: t, note: (catalog.toolSources[String(t).toLowerCase()] || []).join(", ") })),
      },
      {
        kind: "extensions", label: "Extensions", cap: caps.extensions,
        entries: catalog.extensions.map((e) => ({ value: e.path, label: e.name || e.path, note: e.enabled ? "" : "disabled in Settings" })),
      },
    ];
    const body = groups.map((g) => {
      const chosen = new Set(sel[g.kind] || []);
      const entries = g.entries.slice();
      // A selection the machine no longer offers stays visible, so saving a node
      // never silently drops it.
      for (const v of chosen) if (!entries.some((e) => e.value === v)) entries.push({ value: v, label: v, note: "not found on this machine" });
      const rows = entries.map((e) =>
        `<label class="sw-cap${g.cap ? "" : " off"}"${g.cap ? "" : ` title="${escAttr(`${g.label} cannot be set for this harness`)}"`}>` +
          `<input type="checkbox" data-cap="${g.kind}" value="${escAttr(e.value)}"${chosen.has(e.value) ? " checked" : ""}${g.cap ? "" : " disabled"}>` +
          `<span class="sw-cap-name">${esc(e.label)}</span>` +
          (e.note ? `<span class="sw-cap-note">${esc(e.note)}</span>` : "") +
        `</label>`).join("");
      const hint = g.cap
        ? `→ <code>${esc(g.cap.flag)}</code>`
        : `no flag on this harness — exported as <code>SW_${g.kind.toUpperCase()}</code>`;
      return `<div class="sw-caps"><div class="sw-caps-head"><span>${esc(g.label)}</span><em>${hint}</em></div>` +
        (entries.length ? rows : `<div class="sw-muted">none found on this machine</div>`) + `</div>`;
    }).join("");
    return `<div class="sw-field sw-caps-wrap"><span>Agent access</span>${body}</div>`;
  }

  /** The model the inspector is showing: the select's value, or the free-text
   *  box when the harness has no list / "Custom…" is chosen. */
  function readModelField() {
    const el = inspectorEl.querySelector("#sw-f-model");
    if (!el) return "";
    if (el.tagName !== "SELECT") return el.value.trim();
    if (el.value !== MODEL_CUSTOM) return el.value;
    return inspectorEl.querySelector("#sw-f-model-custom")?.value.trim() || "";
  }
  /** The capability checkboxes as they stand (saved or not). */
  function collectCaps() {
    const out = { skills: [], tools: [], extensions: [] };
    for (const box of inspectorEl.querySelectorAll("[data-cap]")) {
      if (box.checked && out[box.dataset.cap]) out[box.dataset.cap].push(box.value);
    }
    return out;
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

  function renderNodeInspector(n) {
    const title = n.type === "agent" ? "Agent node" : n.type === "start" ? "Start node" : "End node";
    let fields = `<label class="sw-field"><span>Name</span><input class="set-input" id="sw-f-name" value="${escAttr(n.name)}" maxlength="60"></label>`;

    if (n.type === "agent") {
      const c = n.config || {};
      fields +=
        `<label class="sw-field"><span>Harness</span>` +
          `<select class="set-select" id="sw-f-harness">${harnessOptions(c.harness)}</select>` +
          `<div class="sw-hint" id="sw-harness-hint"></div></label>` +
        `<div id="sw-model-wrap">${modelFieldHtml(c.harness, c.model)}</div>` +
        `<div id="sw-caps-wrap">${capsHtml(c.harness, { skills: c.skills || [], tools: c.tools || [], extensions: c.extensions || [] })}</div>` +
        `<label class="sw-field"><span>Prompt template</span>` +
          `<textarea class="set-input sw-textarea" id="sw-f-prompt" rows="4" spellcheck="false" placeholder="{input}">${esc(c.prompt || "")}</textarea>` +
          `<div class="sw-hint"><code>{input}</code> = upstream output, <code>{task}</code> = the run task.</div></label>` +
        `<label class="sw-field sw-only-custom" id="sw-custom-wrap"><span>Custom command</span>` +
          `<input class="set-input" id="sw-f-command" value="${escAttr(c.command || "")}" placeholder="my-agent -p &quot;$SW_PROMPT&quot;">` +
          `<div class="sw-hint">Runs in a shell. <code>$SW_PROMPT</code>, <code>$SW_TASK</code>, <code>$SW_NODE</code> are set; <code>{prompt}</code> is substituted too.</div></label>` +
        `<label class="sw-field"><span>Extra args</span>` +
          `<input class="set-input" id="sw-f-extra" value="${escAttr(c.extraArgs || "")}" placeholder="--yolo --verbose"></label>` +
        `<label class="sw-field"><span>Working dir <em>(optional)</em></span>` +
          `<input class="set-input" id="sw-f-cwd" value="${escAttr(c.cwd || "")}" placeholder="workspace default"></label>` +
        `<div class="sw-row">` +
          `<label class="sw-field"><span>Fan-out</span><select class="set-select" id="sw-f-fanout">` +
            `<option value="parallel"${c.fanout !== "serial" ? " selected" : ""}>parallel</option>` +
            `<option value="serial"${c.fanout === "serial" ? " selected" : ""}>serial</option></select></label>` +
          `<label class="sw-field"><span>Join</span><select class="set-select" id="sw-f-join">` +
            `<option value="all"${c.join !== "first" ? " selected" : ""}>all parents</option>` +
            `<option value="first"${c.join === "first" ? " selected" : ""}>first parent</option></select></label>` +
        `</div>` +
        `<div class="sw-row">` +
          `<label class="sw-field"><span>Timeout (s)</span><input class="set-input" id="sw-f-timeout" type="number" min="0" max="3600" value="${c.timeoutSec || ""}"></label>` +
          `<label class="sw-check sw-check-line"><input type="checkbox" id="sw-f-continue"${c.continueOnError ? " checked" : ""}> continue on error</label>` +
        `</div>`;
    } else {
      fields +=
        `<label class="sw-field"><span>Note</span><input class="set-input" id="sw-f-desc" value="${escAttr(n.config?.description || "")}" maxlength="300"></label>` +
        (n.type === "start"
          ? `<label class="sw-field"><span>Default task</span><textarea class="set-input sw-textarea" id="sw-f-task" rows="3" spellcheck="false">${esc(n.config?.defaultTask || "")}</textarea>` +
            `<div class="sw-hint">Prefills the run bar. The start node's connection picks the first agent(s).</div></label>`
          : `<p class="sw-hint">Agents that connect here finish the workflow.</p>`);
    }

    inspectorEl.innerHTML =
      `<div class="sw-insp-head"><span class="sw-insp-glyph sw-t-${n.type}">${n.type === "start" ? "▶" : n.type === "end" ? "■" : "⬡"}</span>` +
        `<span class="sw-insp-title">${title}</span></div>` +
      `<div class="sw-insp-body">${fields}</div>` +
      `<div class="sw-insp-actions">` +
        `<button class="btn-sm sw-primary" id="sw-save" type="button">Save node</button>` +
        `<button class="btn-sm sw-danger" id="sw-delete" type="button">Delete</button>` +
      `</div>`;

    inspectorEl.querySelector("#sw-save").addEventListener("click", () => saveNode(n));
    inspectorEl.querySelector("#sw-delete").addEventListener("click", () => removeNode(n.id));
    bindModelField();
    const harnessSel = inspectorEl.querySelector("#sw-f-harness");
    if (harnessSel) {
      const syncCustom = () => {
        const custom = harnessSel.value === "custom";
        inspectorEl.querySelector("#sw-custom-wrap").style.display = custom ? "" : "none";
        const meta = harnessMeta(harnessSel.value);
        const hint = inspectorEl.querySelector("#sw-harness-hint");
        hint.textContent = meta && meta.available === false
          ? `⚠ ${meta.bin || meta.label} was not found on PATH — the node will fail until it is installed.`
          : meta ? `Runs: ${meta.bin ? `${meta.bin}` : "the app's Pi runner"}` : "";
        hint.className = meta && meta.available === false ? "sw-hint sw-warn" : "sw-hint";
      };
      // The model list and the capability flags are per-harness, so switching
      // harness rewrites just those two blocks — carrying over what the user has
      // typed/checked but not saved — instead of the whole form, which would
      // throw away an unsaved name or prompt.
      harnessSel.addEventListener("change", () => {
        const model = readModelField();
        const caps = collectCaps();
        inspectorEl.querySelector("#sw-model-wrap").innerHTML = modelFieldHtml(harnessSel.value, model);
        inspectorEl.querySelector("#sw-caps-wrap").innerHTML = capsHtml(harnessSel.value, caps);
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

  async function saveNode(n) {
    const name = inspectorEl.querySelector("#sw-f-name")?.value.trim() || "";
    if (!name) { S.toast?.("A node needs a name", "err"); return; }
    let config;
    if (n.type === "agent") {
      const harness = inspectorEl.querySelector("#sw-f-harness")?.value || "claude";
      const timeout = Number(inspectorEl.querySelector("#sw-f-timeout")?.value || 0);
      const caps = collectCaps();
      config = {
        harness,
        model: readModelField(),
        // What this node's agent may use; the run maps them onto the harness's
        // own flags (and exports them as SW_* for shell commands).
        skills: caps.skills,
        tools: caps.tools,
        extensions: caps.extensions,
        prompt: inspectorEl.querySelector("#sw-f-prompt")?.value ?? "",
        command: inspectorEl.querySelector("#sw-f-command")?.value ?? "",
        extraArgs: inspectorEl.querySelector("#sw-f-extra")?.value ?? "",
        cwd: inspectorEl.querySelector("#sw-f-cwd")?.value.trim() || "",
        fanout: inspectorEl.querySelector("#sw-f-fanout")?.value || "parallel",
        join: inspectorEl.querySelector("#sw-f-join")?.value || "all",
        continueOnError: !!inspectorEl.querySelector("#sw-f-continue")?.checked,
        timeoutSec: Number.isFinite(timeout) ? timeout : 0,
      };
    } else {
      config = { description: inspectorEl.querySelector("#sw-f-desc")?.value.trim() || "" };
      if (n.type === "start") config.defaultTask = inspectorEl.querySelector("#sw-f-task")?.value ?? "";
    }
    await run_(() => post("updateNode", { id: n.id, name, config }), "Node saved");
  }

  async function addNode(type) {
    const scroll = pane.querySelector(".sw-canvas-scroll");
    const x = Math.round((scroll?.scrollLeft || 0) + 260 + Math.random() * 80);
    const y = Math.round((scroll?.scrollTop || 0) + 180 + Math.random() * 80);
    await run_(() => post("addNode", { type, x, y }), type === "agent" ? "Agent added" : `${type} node added`);
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
    const status = run?.status || "idle";
    if (runBtn) runBtn.disabled = status === "running";
    if (stopBtn) stopBtn.disabled = status !== "running";
    if (runStatusEl) {
      runStatusEl.className = `sw-run-status sw-rs-${status}`;
      if (!run) runStatusEl.textContent = "no run yet";
      else {
        const ids = nodes().map((n) => n.id).filter((id) => nodeById(id)?.type !== "start");
        const done = ids.filter((id) => runNode(id)?.status === "done").length;
        const secs = Math.max(0, Math.round(((run.finishedAt || Date.now()) - run.startedAt) / 1000));
        runStatusEl.textContent = `${status === "running" ? "running" : status} · ${done}/${ids.length} nodes · ${secs}s`;
      }
    }
    if (runSummaryEl) {
      runSummaryEl.textContent = run ? `${run.log?.length || 0} log lines` : "";
    }
    // Rewrite the log only when it changed, so the panel does not flicker.
    if (runLogEl) {
      const entries = logBuffer;
      const sig = `${entries.length}:${entries[entries.length - 1]?.seq || 0}`;
      if (sig !== logSig) {
        logSig = sig;
        runLogEl.innerHTML = entries.length
          ? entries.map((l) => {
              const name = l.nodeId ? (nodeById(l.nodeId)?.name || "node") : "run";
              return `<div class="sw-log-line sw-log-${escAttr(l.stream)}">` +
                `<span class="sw-log-node">${esc(name)}</span>` +
                `<span class="sw-log-text">${esc(l.text)}</span></div>`;
            }).join("")
          : `<div class="sw-log-empty">Run the workflow to see each node's output stream here.</div>`;
        runLogEl.scrollTop = runLogEl.scrollHeight;
      }
    }
  }

  async function startRun() {
    const task = taskInput?.value ?? "";
    try {
      const data = await postRun("start", { task });
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
          `<button class="btn-sm" id="sw-add-start" type="button" title="Add the start node">+ Start</button>` +
          `<button class="btn-sm" id="sw-add-end" type="button" title="Add the end node">+ End</button>` +
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
          `<div class="sw-run-head"><span class="sw-run-title">Run log</span><span class="sw-run-summary" id="sw-run-summary"></span>` +
            `<button class="sw-run-toggle" id="sw-run-toggle" type="button">▾</button></div>` +
          `<div class="sw-run-log" id="sw-run-log"></div>` +
        `</section>` +
      `</div>`;

    nameInput = pane.querySelector("#sw-name");
    statusEl = pane.querySelector("#sw-status");
    taskInput = pane.querySelector("#sw-task");
    runStatusEl = pane.querySelector("#sw-run-status");
    runLogEl = pane.querySelector("#sw-run-log");
    runSummaryEl = pane.querySelector("#sw-run-summary");
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
    pane.querySelector("#sw-add-start").addEventListener("click", () => addNode("start"));
    pane.querySelector("#sw-add-end").addEventListener("click", () => addNode("end"));
    pane.querySelector("#sw-refresh").addEventListener("click", () => { refresh(); loadHarnesses(); loadCatalog(); });
    runBtn.addEventListener("click", startRun);
    stopBtn.addEventListener("click", stopRun);
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
        selected = { kind: "node", id: nodeEl.dataset.id };
        renderNodes(); renderInspector();
        startDrag(nodeEl, e);
        return;
      }
      if (selected) { selected = null; renderNodes(); renderInspector(); }
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
    nav: { label: "Workflow", order: 70, group: "timeline", title: "Design and run a multi-harness workflow" },
    view: {
      pane: "#subagent-workflow-pane",
      display: "flex",
      session: "none",
      render: (paneEl) => { loadStyles(); build(paneEl); },
      onShow: () => {
        const el = document.getElementById("subagent-workflow-pane");
        if (!el) return;
        if (!pane || pane !== el) build(el);
        cwd = S.currentCwd?.() || "";
        // `refresh()` paints when the graph arrives; the harness list and the
        // catalogue only need the inspector, so neither triggers a second
        // canvas paint.
        void loadHarnesses();
        void loadCatalog();
        refresh();
      },
      onHide: stopPolling,
      onCwd: () => { cwd = S.currentCwd?.() || ""; void loadCatalog(); refresh(); },
      onReconnect: () => refresh(),
    },
  });
})();
