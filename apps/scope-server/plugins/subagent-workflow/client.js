/**
 * client.js — the "Subagent Workflow" view.
 *
 * A canvas for wiring **coding-agent harnesses** into a fan-out DAG. Each agent
 * node runs one harness — Claude Code, Codex CLI, Gemini CLI, opencode, Aider,
 * Cursor Agent, the app's own Pi runner, or a custom shell command — configured
 * in a popup opened from the **gear on the node itself**. Drag from a node's output port onto another
 * node's input port to connect them; a run walks the graph from the **start**
 * node to the **end** node, server-side and in the background, streaming every
 * node's output into the run panel while the canvas badges each node
 * pending → running → done/error.
 *
 * Beside the canvas sits the **messages sidebar** — what each agent actually
 * said. It opens only while a node is selected: clicking a card (or a section
 * in the sidebar) shows that node's own context, with the message it was handed
 * above its words. A waiting **approval** gate shows its card there too — the
 * one place a gate is decided — with what each node wired into it produced in a
 * section of its final result; an **end** node does the same for its branch's
 * final output, one section per incoming agent followed by the joined result.
 * With nothing selected the sidebar stays folded away, so several independently
 * managed workflows can share one canvas without mixing their messages. It reads
 * only — a node's settings are a popup, never a column.
 *
 * A **group** is a named frame around a set of nodes. Shift-click, or a
 * Shift-drag across the canvas, picks several cards and Group gathers them into
 * one; the frame's header drags the whole workflow at once, and folding it
 * hides the member cards and their wiring behind a single chip — which still
 * reports the run's progress. Dragging one card out of the frame ungroups just
 * that node. That is how one canvas holds several workflows without every node
 * being on screen at once.
 *
 * A node is configured with exactly three things — its **provider** (the harness
 * it spawns), its **model**, and the **user message** it is given — and each
 * agent node wears its provider's mark on the canvas. A Pi node's Model field
 * offers every model this app can run, grouped by provider and valued
 * `<provider>/<id>` (what pi resolves); each **end** node shows its own branch's
 * final output once a run reaches it, and each **start** node carries the task
 * and triggers that start its workflows. An agent node can also carry **reference
 * files and folders** — paths the user types or picks from a browser of the
 * workspace's own tree, each with a description — which ride in its user
 * message: the query in a `<user query>` tag, then this material in a
 * `<reference files/folder>` tag, so a step is pointed at what it needs instead
 * of having it pasted into the message. Connections decide the
 * order of a run: everything wired in parallel off one node runs in parallel,
 * and a chain runs one node after another. Nodes can be cloned and the graph
 * exported/imported as JSON. An **approval** node pauses the run for a person:
 * the waiting gate shows up in the messages sidebar with its message, a note box
 * and Approve / Reject (there is no separate approval banner). The run panel also lists **past runs** (reopen one to
 * replay its log and node badges). Each **start node** owns its triggers — a
 * schedule and an event watch that start a run from that entry point — edited
 * in the start node's settings, so several start / end pairs can share a canvas
 * and be managed separately. The settings popup is a panel 80% of the window wide and
 * full height, because a node's references, the model catalogue and an end
 * node's final output all need the room while the canvas they belong to stays
 * visible around it: a node, a connection and a start node's triggers are all edited in
 * that one modal, over the canvas. A node's own output is read there too, with a
 * **Markdown / Raw** switch — the agent's prose rendered, or the bytes exactly as
 * they streamed (the end node's final output offers the same switch).
 *
 * A **standalone plugin**: this bundle, its stylesheet (client.css) and its
 * server half (server.ts) all live in apps/scope-server/plugins/subagent-workflow/,
 * and the host loads the bundle from its manifest. It registers itself below.
 */
(function () {
  const S = window.SCOPE;
  if (!S || !S.Plugins) return;
  // The bundle is injected as a classic <script>, so its own URL is readable
  // while it runs. Captured here because `document.currentScript` is null later —
  // e.g. when the Settings popup loads the stylesheet on its own, with the
  // Workflow view never having been opened.
  const SELF_SRC = (document.currentScript && document.currentScript.src) || "";
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
  let canvasEl = null, nodesEl = null, groupsEl = null, handlesEl = null, svgEl = null, edgePathsEl = null, tmpPathEl = null, edgeBtnsEl = null;
  let canvasScrollEl = null;   // the scroller holding the canvas (zoom + grid owner)
  let canvasSizeObs = null;    // re-measures the pane when the view gets wider/taller
  let dlgEl = null, modalEl = null, statusEl = null, nameInput = null;
  let runStatusEl = null, runLogEl = null, runSummaryEl = null, runBtn = null;
  let historyEl = null, historySig = "";

  let wf = null;
  let run = null;
  /** Run history: the summaries the server keeps, and the record being viewed. */
  let historyList = [];
  let historyRun = null;
  /** This workspace's triggers (schedule + event watch), as the server sees them. */
  let triggers = null;
  let harnesses = [];
  /**
   * What a provider's own CLI reported for its models (`opencode models`), by
   * harness id, plus the ids being asked right now. A node's Model dropdown
   * offers these after the list the harness declares: the tool installed on this
   * machine knows the models the user signed it up for, which no list baked into
   * this bundle can.
   */
  const cliModels = new Map();
  const cliPending = new Set();
  /** Bumped whenever the Model block asks its provider, so a late answer only
   *  repaints a form that is still showing that provider. */
  let modelAsk = 0;
  /** The server's OS (`"win32"` on Windows), as `/harnesses` reports it. It
   *  decides only presentation: a custom command's variables are `%SW_PROMPT%`
   *  there and `$SW_PROMPT` everywhere else (see customVar). */
  let serverPlatform = "";
  let cwd = "";
  let selected = null;
  /** Nodes picked for **grouping** with Shift/Ctrl-click, in addition to the one
   *  in `selected`. A plain click resets it to that one node. */
  let groupSel = new Set();
  /**
   * How an agent's output is read in its settings popup: `"markdown"` renders the
   * prose it wrote (the default), `"raw"` shows the bytes exactly as they
   * streamed. One preference covers every output panel — a node's own result and
   * the end node's final output — and is remembered per browser, like the app's
   * other panel toggles.
   */
  const OUT_VIEW_KEY = "scope-sw-out-view";
  let outView = "markdown";
  try { if (localStorage.getItem(OUT_VIEW_KEY) === "raw") outView = "raw"; } catch { /* private mode */ }
  /**
   * The settings popup: what it is open on — `{ kind: "node", id }`,
   * `{ kind: "edge", id }` or `{ kind: "triggers" }` — or null while closed.
   * Node settings used to live in a sidebar next to the canvas; they are a modal
   * now, opened from the gear on the node itself.
   */
  let dlg = null;
  let drag = null;
  let groupDrag = null;
  let groupResize = null;
  let marquee = null;
  let marqueeEl = null;
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
  const groups = () => (wf && Array.isArray(wf.groups) ? wf.groups : []);
  const nodeById = (id) => nodes().find((n) => n.id === id) || null;
  const groupById = (id) => groups().find((g) => g.id === id) || null;
  /** The group a node belongs to, or null. */
  const groupOfNode = (id) => groups().find((g) => (g.nodeIds || []).includes(id)) || null;
  /** Nodes inside a folded group: their cards (and incident edges) are hidden. */
  function foldedNodeIds() {
    const out = new Set();
    for (const g of groups()) if (g.collapsed) for (const id of g.nodeIds || []) out.add(id);
    return out;
  }
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
    const previousNodes = run && run.nodes ? run.nodes : null;
    run = next || null;
    // An incremental poll carries no per-node output tail (only a full read
    // sends it), so the last known one is carried over rather than dropped:
    // otherwise an agent's output would vanish from the messages sidebar while
    // the run is still streaming.
    if (!full && previousNodes && run?.nodes) {
      for (const [id, s] of Object.entries(run.nodes)) {
        const prev = previousNodes[id];
        if (prev && typeof prev.outputTail === "string" && typeof s.outputTail !== "string") {
          s.outputTail = prev.outputTail;
        }
      }
    }
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
   * Refresh the harness list. The list only feeds the settings popup's dropdown,
   * so this re-renders the popup rather than repainting the canvas — repainting
   * on every harness fetch made opening the view (and the ↻ button) paint the
   * whole node + edge DOM twice.
   */
  /** Fetch the harness list without touching the canvas. */
  async function fetchHarnesses() {
    try {
      const data = await getJson("/subagent-workflow/harnesses");
      harnesses = data.harnesses || [];
      serverPlatform = data.platform || "";
    } catch { harnesses = []; }
  }
  /** Fetch + re-render the node dialog's provider dropdown. */
  async function loadHarnesses() {
    await fetchHarnesses();
    renderDialog();
  }

  // ─── Settings → Plugins → Workflow: harness binaries + custom harnesses ───
  //
  // The host renders this popup on the plugin's row in Settings → Plugins (see
  // plugins/README.md). Two things live here, both global to the machine:
  //
  //   • Detected harnesses — re-point a built-in CLI when Pi Scope cannot find it
  //     (an nvm or npm-global install, a custom prefix).
  //   • Custom harnesses — name any CLI Pi Scope does not ship, give it a binary,
  //     and it appears in every node's Provider list like a built-in.
  //
  // The server owns the store and every rule; this half paints the rows, posts a
  // change, and reflects what the server resolved. Styled as a small engineering
  // console (superdesign-alpha: mono readouts, hairline dividers, one rationed
  // accent) and it never repaints the Workflow canvas — the popup lives in
  // Settings, not that view.

  /** The popup shell; both sections are filled once the harness list is known. */
  function settingsHTML() {
    return `<div class="sw-set">` +
      `<p class="sw-set-lead">Point Pi Scope at the coding-agent CLIs on this machine. ` +
      `Re-point a detected harness that lives where a desktop launch does not search, or add any ` +
      `CLI of your own — it then appears in every node’s <b>Provider</b> list.</p>` +
      `<section class="sw-set-sec"><div class="sw-set-eyebrow">Detected harnesses</div>` +
      `<div class="sw-set-grid" id="sw-bin-rows"><div class="sw-set-path">Loading…</div></div></section>` +
      `<section class="sw-set-sec"><div class="sw-set-eyebrow">Custom harnesses</div>` +
      `<div class="sw-set-grid" id="sw-user-rows"></div>` +
      `<div class="sw-set-new">` +
      `<input class="sw-set-input" id="sw-new-name" spellcheck="false" autocomplete="off" placeholder="Name — e.g. DeepSeek">` +
      `<input class="sw-set-input" id="sw-new-bin" spellcheck="false" autocomplete="off" placeholder="Binary — /usr/local/bin/deepseek, or a command on PATH">` +
      `<input class="sw-set-input" id="sw-new-args" spellcheck="false" autocomplete="off" placeholder="Arguments (optional) — {prompt} is replaced by the node’s message">` +
      `<input class="sw-set-input" id="sw-new-models" spellcheck="false" autocomplete="off" placeholder="Models (optional) — comma-separated; each shows in the node’s Model list">` +
      `<input class="sw-set-input" id="sw-new-flag" spellcheck="false" autocomplete="off" placeholder="Model flag (optional) — the flag a chosen model is passed with; defaults to --model">` +
      `<div class="sw-set-actions"><button class="sw-set-btn" id="sw-new-add" type="button">Add harness</button></div>` +
      `</div></section></div>`;
  }

  /** A mono status readout — `found`/`not found` with a status dot. */
  function swStatus(ok, text) {
    return `<span class="sw-set-status ${ok ? "ok" : "warn"}"><i class="dot"></i>${esc(text)}</span>`;
  }

  /** One row per *built-in* harness that runs a binary. */
  function binRowsHTML() {
    const list = harnesses.filter((h) => h.bin && !h.user);
    if (!list.length) return `<div class="sw-set-path">Harness list unavailable — reopen this popup in a moment.</div>`;
    return list.map((h) => {
      const state = h.resolved ? "found" : h.override ? "not executable" : "not found";
      return `<div class="sw-set-row"><div class="sw-set-rowhead">` +
        `<span class="sw-set-name">${esc(h.label || h.id)}</span>` + swStatus(!!h.resolved, state) +
        `</div>` +
        `<input class="sw-set-input" type="text" spellcheck="false" autocomplete="off" ` +
        `data-sw-bin="${escAttr(h.id)}" data-sw-saved="${escAttr(h.override || "")}" ` +
        `placeholder="${escAttr(h.bin)}" value="${escAttr(h.override || "")}" ` +
        `aria-label="${escAttr((h.label || h.id) + " binary")}">` +
        (h.resolved ? `<div class="sw-set-path">→ ${esc(h.resolved)}</div>` : "") +
        `</div>`;
    }).join("");
  }

  /** One editable row per *user-defined* harness. */
  function userRowsHTML() {
    const list = harnesses.filter((h) => h.user);
    if (!list.length) return `<div class="sw-set-path">None yet — name a CLI below.</div>`;
    return list.map((h) =>
      `<div class="sw-set-row" data-sw-uid="${escAttr(h.id)}">` +
      `<div class="sw-set-rowhead">` +
      `<input class="sw-set-input sw-set-input-name" type="text" spellcheck="false" autocomplete="off" ` +
      `data-sw-uname placeholder="Name" value="${escAttr(h.label || h.id)}" aria-label="Harness name">` +
      swStatus(!!h.resolved, h.resolved ? "found" : "not found") +
      `<button class="sw-set-btn ghost" type="button" data-sw-uremove title="Remove this harness">Remove</button>` +
      `</div>` +
      `<input class="sw-set-input" type="text" spellcheck="false" autocomplete="off" ` +
      `data-sw-ubin placeholder="Binary" value="${escAttr(h.bin || "")}" aria-label="Harness binary">` +
      `<input class="sw-set-input" type="text" spellcheck="false" autocomplete="off" ` +
      `data-sw-uargs placeholder="Arguments — {prompt} is replaced by the node’s message" ` +
      `value="${escAttr(h.argsTemplate || "")}" aria-label="Harness arguments">` +
      `<input class="sw-set-input" type="text" spellcheck="false" autocomplete="off" ` +
      `data-sw-umodels placeholder="Models — comma-separated; each shows in the node’s Model list" ` +
      `value="${escAttr((h.models || []).join(", "))}" aria-label="Harness models">` +
      `<input class="sw-set-input" type="text" spellcheck="false" autocomplete="off" ` +
      `data-sw-uflag placeholder="Model flag — the flag a chosen model is passed with (default --model)" ` +
      `value="${escAttr(h.modelFlag || "")}" aria-label="Harness model flag">` +
      (h.resolved ? `<div class="sw-set-path">→ ${esc(h.resolved)}</div>` : "") +
      `</div>`).join("");
  }

  /** Post a harness change; adopt the server's refreshed list; toast + return it. */
  async function harnessPost(path, payload, okMsg) {
    const { res, data } = await S.api(path, {}, payload);
    if (!res.ok || data?.error) throw new Error(data?.error || `HTTP ${res.status}`);
    harnesses = data.harnesses || harnesses;
    if (okMsg) S.toast?.(okMsg);
    return data;
  }

  /**
   * Paint both sections and bind them. `repaint()` re-reads the (fresh) harness
   * list, so an id a save may have changed, a new status and a new row all land
   * together. Re-wiring after every paint keeps the handlers on current DOM.
   */
  function wireSettings(panel) {
    const binRows = panel.querySelector("#sw-bin-rows");
    const userRows = panel.querySelector("#sw-user-rows");
    if (!binRows || !userRows) return;
    const repaint = () => {
      binRows.innerHTML = binRowsHTML();
      userRows.innerHTML = userRowsHTML();
      wireSettings(panel);
    };

    // Detected harnesses: save the override on change (blur).
    binRows.querySelectorAll("input[data-sw-bin]").forEach((input) => {
      input.addEventListener("change", async () => {
        const id = input.dataset.swBin;
        const value = input.value.trim();
        if (value === (input.dataset.swSaved || "")) return;
        try {
          await harnessPost("/subagent-workflow/harness-paths", { harness: id, path: value },
            value ? `Saved the ${id} binary` : `Cleared the ${id} binary`);
          repaint();
        } catch (err) {
          input.value = input.dataset.swSaved || ""; // keep showing the saved value
          S.toast?.(String(err.message || err), "err");
        }
      });
    });

    // Custom harnesses: edit in place, or remove.
    userRows.querySelectorAll("[data-sw-uid]").forEach((row) => {
      const id = row.dataset.swUid;
      const nameEl = row.querySelector("[data-sw-uname]");
      const binEl = row.querySelector("[data-sw-ubin]");
      const argsEl = row.querySelector("[data-sw-uargs]");
      const modelsEl = row.querySelector("[data-sw-umodels]");
      const flagEl = row.querySelector("[data-sw-uflag]");
      const saved = { name: nameEl.value, bin: binEl.value, args: argsEl.value, models: modelsEl.value, flag: flagEl.value };
      const save = async () => {
        const next = {
          id,
          name: nameEl.value.trim(),
          bin: binEl.value.trim(),
          args: argsEl.value.trim(),
          models: modelsEl.value.trim(),
          modelFlag: flagEl.value.trim(),
        };
        if (!next.name) { S.toast?.("A harness needs a name", "err"); nameEl.focus(); return; }
        if (!next.bin) { S.toast?.("A harness needs a binary", "err"); binEl.focus(); return; }
        if (next.name === saved.name && next.bin === saved.bin && next.args === saved.args
          && next.models === saved.models && next.modelFlag === saved.flag) return;
        try {
          await harnessPost("/subagent-workflow/user-harnesses", Object.assign({ action: "save" }, next), `Saved ${next.name}`);
          repaint();
        } catch (err) {
          nameEl.value = saved.name; binEl.value = saved.bin; argsEl.value = saved.args;
          modelsEl.value = saved.models; flagEl.value = saved.flag;
          S.toast?.(String(err.message || err), "err");
        }
      };
      for (const el of [nameEl, binEl, argsEl, modelsEl, flagEl]) el.addEventListener("change", save);
      row.querySelector("[data-sw-uremove]").addEventListener("click", async () => {
        try {
          await harnessPost("/subagent-workflow/user-harnesses", { action: "remove", id }, `Removed ${id}`);
          repaint();
        } catch (err) { S.toast?.(String(err.message || err), "err"); }
      });
    });

    // Add a new harness.
    const nn = panel.querySelector("#sw-new-name");
    const nb = panel.querySelector("#sw-new-bin");
    const na = panel.querySelector("#sw-new-args");
    const nm = panel.querySelector("#sw-new-models");
    const nf = panel.querySelector("#sw-new-flag");
    panel.querySelector("#sw-new-add").addEventListener("click", async () => {
      const name = nn.value.trim();
      const bin = nb.value.trim();
      const args = na.value.trim();
      const models = nm.value.trim();
      const modelFlag = nf.value.trim();
      if (!name) { S.toast?.("Give the harness a name", "err"); nn.focus(); return; }
      if (!bin) { S.toast?.("Give the harness a binary", "err"); nb.focus(); return; }
      try {
        await harnessPost("/subagent-workflow/user-harnesses",
          { action: "save", name, bin, args, models, modelFlag }, `Added ${name}`);
        nn.value = ""; nb.value = ""; na.value = ""; nm.value = ""; nf.value = "";
        repaint();
      } catch (err) { S.toast?.(String(err.message || err), "err"); }
    });
  }

  /** A node variable as this server's shell spells it: `%SW_PROMPT%` on Windows,
   *  `$SW_PROMPT` elsewhere. */
  const customVar = (name) => (serverPlatform === "win32" ? `%${name}%` : `$${name}`);

  /** Does one start node's trigger config arm it? */
  function startTriggerArmed(t) {
    return !!t && (t.schedule?.mode === "interval" || t.schedule?.mode === "daily" || t.event?.enabled === true);
  }

  /** Does any entry point on this canvas have a trigger armed? */
  function anyStartTriggerArmed() {
    return nodes().some((n) => n.type === "start" && startTriggerArmed(n.config?.triggers));
  }

  function syncPolling() {
    const running = run && run.status === "running";
    if (running && !pollTimer) pollTimer = setInterval(refreshRun, POLL_MS);
    else if (!running && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    // With any start node triggered, a run can start without this page asking.
    const watching = !running && anyStartTriggerArmed();
    if (watching && !watchTimer) watchTimer = setInterval(refreshRun, TRIGGER_POLL_MS);
    else if (!watching && watchTimer) { clearInterval(watchTimer); watchTimer = null; }
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
  }

  /** Forget the routed-edge elements and drop their DOM, so the canvas can be
   *  rebuilt from scratch (a reload, or `build()` replacing the pane). Without
   *  dropping the old paths too, `layoutEdges` would create a second set of
   *  elements for the same edges and the wiring would double up. */
  function resetCanvasState() {
    for (const item of edgeEls.values()) { item.path.remove(); item.btn.remove(); }
    edgeEls.clear();
    boxCache.clear();
    canvasW = 0; canvasH = 0;
    groupSel = new Set();
    groupDrag = null;
    groupResize = null;
    marquee = null;
    if (marqueeEl) { marqueeEl.hidden = true; marqueeEl.style.width = "0px"; marqueeEl.style.height = "0px"; }
    if (groupsEl) groupsEl.innerHTML = "";
    if (handlesEl) handlesEl.innerHTML = "";
    historySig = "";    // the history picker is about to be rebuilt
    msgSig = "";        // …and so is the messages sidebar
    historyRun = null;  // a rebuilt pane starts on the live run
  }

  // ─── Painting ─────────────────────────────────────────────────────────────

  function paint() {
    if (!pane) return;
    if (drag || groupDrag || groupResize || marquee || link) { dirty = true; return; }
    dirty = false;
    if (nameInput && document.activeElement !== nameInput) nameInput.value = wf?.name || "";
    renderStatus();
    renderGroups();
    renderNodes();
    layoutGroups();
    resizeCanvas();
    applyPendingView();
    renderEdges();
    renderDialog();
    syncFinalOutput();
    syncNodeOutput();
    renderRun();
  }

  /**
   * A live-run tick repaints only what a run changes: each node's status badge
   * and the run panel. It deliberately does NOT rebuild the node DOM, the edge
   * SVG or the open popup — that would churn every poll and drop any settings
   * the user is mid-edit on.
   */
  function paintRun() {
    if (!pane) return;
    if (drag || groupDrag || groupResize || marquee || link) { dirty = true; return; }
    applyRunStatuses();
    syncGroupStatuses();
    layoutGroups();
    syncFinalOutput();
    syncNodeOutput();
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
    if (anyStartTriggerArmed()) bits.push("⚡ trigger armed");
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
    // A folded chip — or a frame enlarged by hand — may extend past the cards it
    // holds; the scrollable canvas has to include it.
    for (const g of groups()) {
      const b = groupBox(g);
      maxX = Math.max(maxX, b.x + b.w + 120);
      maxY = Math.max(maxY, b.y + b.h + 120);
    }
    // Even a two-node workflow must be draggable in both axes. Without room
    // beyond the viewport, a canvas that fits the pane has no vertical (or
    // horizontal) scroll range at all, so one drag direction does nothing.
    const viewW = canvasScrollEl?.clientWidth || 0;
    const viewH = canvasScrollEl?.clientHeight || 0;
    if (viewW) maxX = Math.max(maxX, viewW + CANVAS_PAN_ROOM_X);
    if (viewH) maxY = Math.max(maxY, viewH + CANVAS_PAN_ROOM_Y);
    if (maxX === canvasW && maxY === canvasH) return;
    canvasW = maxX; canvasH = maxY;
    canvasEl.style.width = `${maxX}px`;
    canvasEl.style.height = `${maxY}px`;
    svgEl.setAttribute("width", String(maxX));
    svgEl.setAttribute("height", String(maxY));
  }

  // ── Zoom ──────────────────────────────────────────────────────────────────
  //
  // One `scale()` on `.sw-canvas` scales the nodes, the edges, the ports and the
  // edge buttons together — they all share the canvas's coordinate space, so the
  // wiring can never drift from the cards at any zoom. Three places do their own
  // arithmetic in canvas px and so have to divide by the scale: pointer → canvas
  // (`canvasPoint`), a drag's screen deltas (`applyDrag`), and a new node's
  // placement from the scroll offsets (`addNode`). The grid is painted by the
  // *scroller*, so it is re-sized alongside instead of sliding under the cards.

  // Blank room kept beyond the viewport so the canvas can always be panned in
  // both directions, even when the whole graph would fit on one screen.
  const CANVAS_PAN_ROOM_X = 1200, CANVAS_PAN_ROOM_Y = 900;
  const ZOOM_MIN = 0.4, ZOOM_MAX = 2, ZOOM_STEP = 1.2;
  /** Each workspace remembers its own view (zoom + scroll), so several graphs
   *  reopened from the same browser come back where the user left them. */
  const VIEW_KEY_PREFIX = "scope-sw-view:";
  let zoom = 1;
  let zoomPctEl = null;
  let viewRestore = false;
  let pendingView = null;
  let viewSaveTimer = null;
  let viewSuppress = false;
  /** The scroller's grid pitch (from `--grid-size`), read once so the graph
   *  paper scales with the canvas instead of sliding under it. */
  let gridBase = 26;

  const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

  /** Write the current zoom onto the canvas, the scroller's grid and the label. */
  function applyZoom() {
    if (!canvasEl || !canvasScrollEl) return;
    canvasEl.style.transformOrigin = "0 0";
    canvasEl.style.transform = zoom === 1 ? "" : `scale(${zoom})`;
    // The graph paper is painted by the scroller, so its pitch has to be scaled
    // by the same factor or the grid would slide against the cards.
    canvasScrollEl.style.backgroundSize = zoom === 1 ? "" : `${gridBase * zoom}px ${gridBase * zoom}px`;
    if (zoomPctEl) zoomPctEl.textContent = `${Math.round(zoom * 100)}%`;
  }

  // ── Per-workspace view memory ─────────────────────────────────────────────

  const viewKey = () => `${VIEW_KEY_PREFIX}${cwd || "default"}`;

  function readSavedView() {
    try {
      const raw = JSON.parse(localStorage.getItem(viewKey()) || "null");
      if (!raw || typeof raw !== "object") return null;
      const saved = {};
      if (Number.isFinite(Number(raw.zoom))) saved.zoom = clampZoom(Number(raw.zoom));
      if (Number.isFinite(Number(raw.x))) saved.x = Math.max(0, Math.round(Number(raw.x)));
      if (Number.isFinite(Number(raw.y))) saved.y = Math.max(0, Math.round(Number(raw.y)));
      return saved;
    } catch { return null; } // private mode / corrupt value
  }

  function saveViewNow() {
    if (viewSuppress || !cwd || !canvasScrollEl || !wf) return;
    if (viewSaveTimer) { clearTimeout(viewSaveTimer); viewSaveTimer = null; }
    try {
      localStorage.setItem(viewKey(), JSON.stringify({
        zoom,
        x: Math.round(canvasScrollEl.scrollLeft),
        y: Math.round(canvasScrollEl.scrollTop),
      }));
    } catch { /* private mode */ }
  }

  /** Coalesce the writes a pan or zoom gesture would otherwise make. */
  function saveViewSoon() {
    if (viewSuppress || !cwd || !canvasScrollEl) return;
    if (viewSaveTimer) clearTimeout(viewSaveTimer);
    viewSaveTimer = setTimeout(saveViewNow, 180);
  }

  /** Read the incoming workspace's saved view; it is applied once the canvas
   *  has been laid out (see `applyPendingView`). */
  function requestViewRestore() {
    viewRestore = true;
    pendingView = readSavedView();
  }

  function applyPendingView() {
    if (!viewRestore || !canvasScrollEl) return;
    viewRestore = false;
    const saved = pendingView;
    pendingView = null;
    viewSuppress = true;
    zoom = saved && Number.isFinite(saved.zoom) ? clampZoom(saved.zoom) : 1;
    applyZoom();
    canvasScrollEl.scrollLeft = saved && Number.isFinite(saved.x) ? saved.x : 0;
    canvasScrollEl.scrollTop = saved && Number.isFinite(saved.y) ? saved.y : 0;
    // A programmatic scroll fires a scroll event; keep it from writing the view
    // back while the page is still settling.
    setTimeout(() => { viewSuppress = false; }, 180);
  }

  /** Zoom about a point in the scroller's viewport (the centre, by default), so
   *  what the user is looking at stays put. */
  function setZoom(next, anchor) {
    if (!canvasScrollEl) return;
    const a = anchor || { x: canvasScrollEl.clientWidth / 2, y: canvasScrollEl.clientHeight / 2 };
    const before = {
      x: (canvasScrollEl.scrollLeft + a.x) / zoom,
      y: (canvasScrollEl.scrollTop + a.y) / zoom,
    };
    zoom = clampZoom(next);
    applyZoom();
    canvasScrollEl.scrollLeft = before.x * zoom - a.x;
    canvasScrollEl.scrollTop = before.y * zoom - a.y;
    saveViewSoon();
  }

  /** Frame the whole graph: the zoom that fits every node, then centred. */
  function fitCanvas() {
    if (!canvasScrollEl) return;
    const ns = nodes();
    const pad = 48;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of ns) {
      minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + NODE_W); maxY = Math.max(maxY, n.y + 170);
    }
    // A folded chip, or a frame the user enlarged, can reach past every card.
    for (const g of groups()) {
      const b = groupBox(g);
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
    }
    if (!Number.isFinite(minX)) { setZoom(1); return; }
    const vw = canvasScrollEl.clientWidth - pad * 2;
    const vh = canvasScrollEl.clientHeight - pad * 2;
    const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
    // Never zoom *in* past 1:1 — "fit" is about getting the whole graph on
    // screen, not about blowing up a two-node workflow.
    const z = clampZoom(Math.min(1, vw / w, vh / h));
    zoom = z;
    applyZoom();
    canvasScrollEl.scrollLeft = (minX + w / 2) * z - canvasScrollEl.clientWidth / 2;
    canvasScrollEl.scrollTop = (minY + h / 2) * z - canvasScrollEl.clientHeight / 2;
    saveViewSoon();
  }

  /** Wire the zoom cluster, the ctrl/⌘+wheel shortcut and the keyboard keys. */
  function initCanvasZoom() {
    const cluster = pane?.querySelector("#sw-zoom");
    zoomPctEl = pane?.querySelector("#sw-zoom-pct") || null;
    if (cluster) {
      cluster.querySelector("#sw-zoom-out").addEventListener("click", () => setZoom(zoom / ZOOM_STEP));
      cluster.querySelector("#sw-zoom-in").addEventListener("click", () => setZoom(zoom * ZOOM_STEP));
      // The percentage doubles as "reset to 100%".
      zoomPctEl?.addEventListener("click", () => setZoom(1));
      cluster.querySelector("#sw-zoom-fit").addEventListener("click", fitCanvas);
    }
    // The grid pitch comes from the theme, not a hardcoded 26px.
    const pitch = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--grid-size"));
    if (Number.isFinite(pitch) && pitch > 0) gridBase = pitch;
    applyZoom();
    canvasScrollEl?.addEventListener("scroll", saveViewSoon, { passive: true });
    // Ctrl/⌘ + wheel is the gesture every canvas editor uses; a plain wheel
    // still scrolls, which is what the rest of the app expects.
    canvasScrollEl?.addEventListener("wheel", (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = canvasScrollEl.getBoundingClientRect();
      setZoom(zoom * Math.exp(-e.deltaY * 0.002), { x: e.clientX - rect.left, y: e.clientY - rect.top });
    }, { passive: false });
    pane?.addEventListener("keydown", (e) => {
      if (e.target?.closest?.("input, textarea, select")) return;
      if (e.key === "+" || e.key === "=") { e.preventDefault(); setZoom(zoom * ZOOM_STEP); }
      else if (e.key === "-" || e.key === "_") { e.preventDefault(); setZoom(zoom / ZOOM_STEP); }
      else if (e.key === "0") { e.preventDefault(); setZoom(1); }
    });
  }

  /** The provider's display name, whether or not the machine reported it. */
  function providerLabel(id) {
    const meta = harnessMeta(id);
    return (meta && (meta.label || meta.id)) || id || "agent";
  }

  /**
   * One end node's **final output**: what the run's end node received from the
   * branches wired into it. The end node is a sentinel — it spawns nothing — so
   * its own output *is* the answer its branch produced, and the server keeps
   * that output's tail on the run record (a live run and a reopened one alike).
   * A canvas may hold several end nodes, each managed separately; `nodeId` picks
   * the one to read, defaulting to the first. Empty until a run reached it.
   */
  function finalOutput(nodeId) {
    const ends = nodes().filter((n) => n.type === "end");
    const end = nodeId ? ends.find((n) => n.id === nodeId) : ends[0];
    if (!end) return { nodeId: "", text: "" };
    const tail = runNode(end.id)?.outputTail;
    return { nodeId: end.id, text: typeof tail === "string" ? tail : "" };
  }

  /** One line of the final output, for the end node's card on the canvas. */
  function finalPreview(text, max = 140) {
    const flat = String(text || "").replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  }

  // ─── Markdown-lite: an agent's output rendered as prose ───────────────────
  //
  // Agents write markdown — headings, lists, fenced code, bold and links — so a
  // node's output reads far better rendered than as plain text. There is no
  // markdown library in this bundle (the plugin is self-contained), and the
  // constructs an agent actually emits are few, so a compact formatter lives
  // here. It mirrors the Chat view's own markdown-lite (public/chat.js) under
  // this view's class names, so both renderings of the same text agree.

  // Inline formatting on ALREADY-ESCAPED text. Code and links are stashed first
  // so one formatter's markers can never be reprocessed by another.
  function mdInline(text) {
    const prot = [];
    const stash = (html) => { prot.push(html); return "\u0001" + (prot.length - 1) + "\u0001"; };
    text = text.replace(/`([^`\n]+)`/g, (m, c) => stash(`<code>${c}</code>`));
    text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, l, u) => stash(`<a href="${u}" target="_blank" rel="noopener noreferrer">${l}</a>`));
    text = text.replace(/\*\*([^*\n]+)\*\*/g, (m, t) => stash(`<strong>${t}</strong>`));
    text = text.replace(/~~([^~\n]+)~~/g, (m, t) => stash(`<del>${t}</del>`));
    text = text.replace(/\*([^*\n]+)\*/g, (m, t) => stash(`<em>${t}</em>`));
    return text.replace(/\u0001(\d+)\u0001/g, (m, i) => prot[+i] || "");
  }

  // The full formatter: fenced code pulled out first, then block structure
  // (headings / lists / quotes / rules / paragraphs) with inline formatting
  // inside. Returns HTML — every piece of the raw text was escaped on the way in.
  function mdFormat(raw) {
    const fences = [];
    let text = String(raw || "").replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (m, lang, code) => {
      fences.push({ lang: (lang || "").trim(), code: code.replace(/\n\s*$/, "") });
      return "\u0000F" + (fences.length - 1) + "\u0000";
    });
    text = mdInline(esc(text));

    const lines = text.split("\n");
    const blocks = [];
    let i = 0;
    const flush = (cur) => {
      if (!cur) return;
      if (cur.lines && cur.lines.join("").trim()) blocks.push(cur);
      else if (cur.type !== "p") blocks.push(cur);
    };
    let cur = null;
    while (i < lines.length) {
      const ln = lines[i];
      const fm = ln.match(/^\u0000F(\d+)\u0000$/);
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
          const it = lines[i].trim().match(/^[-*•]\s+(.*)$/);
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
          const it = lines[i].trim().match(/^\d+[.)]\s+(.*)$/);
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
          `<div class="sw-md-code">` +
          `<div class="sw-md-code-head"><span class="sw-md-code-lang">${esc(f.lang || "code")}</span>` +
          `<button type="button" class="sw-md-copy" data-md-copy="${escAttr(f.code)}" title="Copy code">Copy</button></div>` +
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

  // A bounded memo: a live run repaints a node's output every poll, and the
  // text below the newest line is unchanged, so the same parse is reused until
  // the output actually moves. Dropped wholesale once it gets large.
  const MD_CACHE_MAX = 64;
  const mdCache = new Map();
  function markdownHtml(raw) {
    const src = String(raw == null ? "" : raw);
    const hit = mdCache.get(src);
    if (hit !== undefined) return hit;
    const html = mdFormat(src);
    if (mdCache.size >= MD_CACHE_MAX) mdCache.clear();
    mdCache.set(src, html);
    return html;
  }

  /** The Markdown / Raw switch shown on every output panel's head. */
  function outViewToggle() {
    const btn = (v, label) =>
      `<button type="button" class="sw-view-btn${outView === v ? " on" : ""}" ` +
      `data-out-view="${v}" aria-pressed="${outView === v ? "true" : "false"}">${label}</button>`;
    return `<span class="sw-view-toggle" role="group" aria-label="Output view">` +
      btn("markdown", "Markdown") + btn("raw", "Raw") + `</span>`;
  }

  /** An output panel's body in the current view: rendered prose, or raw text. */
  function outBodyHtml(text, preClass, mdClass) {
    if (outView === "raw") return `<pre class="${preClass}">${esc(text)}</pre>`;
    return `<div class="${mdClass} sw-md">${markdownHtml(text)}</div>`;
  }

  /**
   * Switch every open output panel between rendered markdown and raw text, and
   * remember the choice. The panels are repainted in place (their change
   * signature is cleared first) so the switch takes effect without waiting for
   * the next live tick.
   */
  function setOutView(view) {
    if (view !== "markdown" && view !== "raw") return;
    outView = view;
    try { localStorage.setItem(OUT_VIEW_KEY, view); } catch { /* private mode */ }
    const outBox = dlgEl?.querySelector("#sw-node-out");
    if (outBox) outBox.dataset.sig = "";
    const finalBox = dlgEl?.querySelector("#sw-final-body");
    if (finalBox) finalBox.dataset.text = "";
    syncNodeOutput();
    syncFinalOutput();
  }

  /**
   * The end node's panel body: the workflow's final output, whole (the server
   * keeps the last 4000 characters), with what it belongs to and a Copy button.
   */
  function finalOutputHtml(n) {
    const { text } = finalOutput(n?.id);
    if (!text) {
      return `<p class="sw-muted">Every branch that reaches this node has settled when the run finishes here.</p>` +
        `<p class="sw-hint">Run the workflow and this node shows what it produced — the joined output of the connections wired into it.</p>`;
    }
    const lines = text.split("\n").length;
    const status = viewRun()?.status || "";
    return `<div class="sw-final-head">` +
        `<span class="sw-final-title">Final output</span>` +
        `<span class="sw-final-meta">${lines} line${lines === 1 ? "" : "s"} · ${text.length} chars</span>` +
        outViewToggle() +
        `<button class="btn-sm" id="sw-final-copy" type="button" title="Copy the final output">Copy</button></div>` +
      outBodyHtml(text, "sw-final-pre", "sw-final-md") +
      `<div class="sw-hint">The joined output of this node's incoming connections${status ? `, from the ${esc(status)} run` : ""}.</div>`;
  }

  /**
   * A node's own **output** in its settings popup: what its agent has streamed
   * (a live run) or what it produced in the run being read. The messages sidebar
   * is where the whole stream is read; this is the node's result beside the
   * message that asked for it, so the two can be compared without leaving the
   * popup.
   */
  function nodeOutputHtml(n) {
    const text = nodeOutputText(n.id).trim();
    const rs = runNode(n.id);
    const status = rs?.status || "";
    if (!text) {
      return `<p class="sw-muted">${status === "running" ? "Running — nothing printed yet."
          : status === "error" ? `Nothing captured — ${esc(rs?.error || "the run failed")}.`
          : "No output yet."}</p>` +
        `<p class="sw-hint">Run the workflow and this node's output lands here, as its agent writes it.</p>`;
    }
    const lines = text.split("\n").length;
    return `<div class="sw-out-head">` +
        `<span class="sw-out-title">Output</span>` +
        statusPill(n.id) +
        `<span class="sw-out-meta">${lines} line${lines === 1 ? "" : "s"} · ${text.length} chars</span>` +
        outViewToggle() +
        `<button class="btn-sm" id="sw-out-copy" type="button" title="Copy this node's output">Copy</button></div>` +
      outBodyHtml(text, "sw-out-pre", "sw-out-md") +
      `<div class="sw-hint">${status === "running" ? "Live — the agent is still writing." : "What this node produced in the run being read."}</div>`;
  }

  /**
   * Refresh the node output panel while the popup is open — a live run grows it
   * with each poll. Left alone when nothing changed, so a selection the user is
   * making survives the tick.
   */
  function syncNodeOutput() {
    const box = dlgEl?.querySelector("#sw-node-out");
    if (!box || dlg?.kind !== "node") return;
    const n = nodeById(dlg.id);
    if (!n || n.type !== "agent") return;
    const rs = runNode(n.id);
    const text = nodeOutputText(n.id);
    const sig = `${rs?.status || ""}\u0000${rs?.error || ""}\u0000${text}`;
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.innerHTML = nodeOutputHtml(n);
  }

  /**
   * Refresh the two live views of the final output: the end node's card and the
   * settings popup when it is open on that node. Runs on every paint and every
   * live tick, because the output only appears once the run has settled there —
   * and the popup's copy is left alone when nothing changed, so a selection the
   * user is making mid-run survives the next tick.
   */
  function syncFinalOutput() {
    // Each end node shows its own branch's answer.
    for (const end of nodes().filter((n) => n.type === "end")) {
      const { text } = finalOutput(end.id);
      const card = nodesEl.querySelector(`.sw-node[data-id="${CSS.escape(end.id)}"] .sw-node-final`);
      if (!card) continue;
      const preview = finalPreview(text);
      card.classList.toggle("has-output", !!preview);
      card.textContent = preview || "Workflow exit";
      card.title = text ? text.slice(0, 600) : "";
    }
    const box = dlgEl?.querySelector("#sw-final-body");
    if (!box || dlg?.kind !== "node") return;
    const n = nodeById(dlg.id);
    if (!n || n.type !== "end") return;
    const { text } = finalOutput(n.id);
    if (box.dataset.text === text) return;
    box.dataset.text = text;
    box.innerHTML = finalOutputHtml(n);
  }

  /** The mark a non-agent node wears on the canvas and in its settings head. */
  function nodeGlyph(type) {
    return type === "start" ? "▶" : type === "end" ? "■" : type === "loop" ? "🔁" : "✋";
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
    if (n.type === "loop") {
      const off = n.config?.enabled === false ? ' <span class="sw-off-tag">off</span>' : "";
      const count = Math.max(1, Math.round(Number(n.config?.count) || 1));
      const rs = runNode(n.id);
      // While it runs, the pass it is on is the useful number — "2/5" beside the
      // configured count, so the canvas shows progress through the loop.
      const live = rs?.iterations > 0 ? ` <span class="sw-loop-pass">${rs.iteration || 1}/${rs.iterations}</span>` : "";
      // Whether the Repeat output is wired decides what the loop *does*, so the
      // card says which of the two it is.
      const feedback = edges().some((e) => e.from === n.id && e.port === "repeat");
      return `<div class="sw-node-model">Repeat ×${count}${live}${off}</div>` +
        `<div class="sw-node-desc">${esc(n.config?.description || (feedback ? "Refines the step wired to its Repeat output" : "Repeats the section it feeds"))}</div>`;
    }
    if (n.type === "start") {
      // This entry point's trigger and task. A canvas may hold several starts,
      // each with its own schedule / event watch, so the card says which one.
      const t = n.config?.triggers || {};
      const bits = [];
      if (t.schedule?.mode === "interval") bits.push(`every ${t.schedule.everySeconds}s`);
      if (t.schedule?.mode === "daily") bits.push(`daily ${t.schedule.at}`);
      if (t.event?.enabled) bits.push(t.event.types?.length ? `on ${t.event.types.join(", ")}` : "on events");
      return `<div class="sw-node-model">${bits.length ? `⚡ ${esc(bits.join(" · "))}` : "Manual start"}</div>` +
        `<div class="sw-node-desc">${esc(n.config?.defaultTask || n.config?.description || "Workflow entry point")}</div>`;
    }
    if (n.type === "end") {
      // This end's branch answer. Filled in by syncFinalOutput once a run reaches it.
      const out = finalPreview(finalOutput(n.id).text);
      return `<div class="sw-node-final${out ? " has-output" : ""}" title="${escAttr(out.slice(0, 200))}">` +
        `${esc(out || n.config?.description || "Workflow exit")}</div>`;
    }
    return `<div class="sw-node-desc">${esc(n.config?.description || (n.type === "start" ? "Workflow entry point" : "Workflow exit"))}</div>`;
  }

  // ── Groups ────────────────────────────────────────────────────────────────
  //
  // A group is a named frame around a set of nodes — one workflow on a canvas
  // that may hold several. Its members move with it, and folding it hides their
  // cards (and their wiring) behind a single chip, so a large canvas reads as a
  // few named workflows rather than every node at once. The frame is measured
  // from its members, so it always wraps what it holds.

  const GROUP_PAD = 16;
  const GROUP_HEAD = 44;
  const GROUP_FOLDED_W = 248, GROUP_FOLDED_H = 40;
  const GROUP_MIN_W = 200, GROUP_MIN_H = 120;
  const CANVAS_LIMIT = 6000; // mirrors the server's CANVAS_MAX
  const GROUP_HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

  function renderGroups() {
    if (!groupsEl) return;
    groupsEl.innerHTML = groups().map((g) => {
      const folded = !!g.collapsed;
      const count = (g.nodeIds || []).length;
      const noun = `${count} node${count === 1 ? "" : "s"}`;
      // A folded workflow hides its cards, so its header carries what the run is
      // doing: progress (`2/4`), with waiting/running/error/done in its ink.
      const st = folded ? groupRunStatus(g) : null;
      const statusChip = st
        ? `<span class="sw-group-status sw-gs-${st.state}" data-group-status="${escAttr(g.id)}" ` +
            `title="${escAttr(st.title)}">${esc(st.text)}</span>`
        : "";
      const resizable = g.resizable !== false;
      return `<section class="sw-group${folded ? " collapsed" : ""}" data-group="${escAttr(g.id)}">` +
          `<div class="sw-group-head" data-group-drag="${escAttr(g.id)}" ` +
            `title="Drag to move this group">` +
            `<button class="sw-group-fold" data-group-fold="${escAttr(g.id)}" type="button" ` +
              `title="${folded ? "Unfold" : "Fold"} this group" aria-label="${folded ? "Unfold" : "Fold"} group">${folded ? "▸" : "▾"}</button>` +
            `<input class="sw-group-name" data-group-name="${escAttr(g.id)}" value="${escAttr(g.name)}" ` +
              `maxlength="60" aria-label="Group name">` +
            statusChip +
            `<span class="sw-group-count">${esc(noun)}</span>` +
            `<button class="sw-group-resize-toggle${resizable ? "" : " off"}" data-group-resizable="${escAttr(g.id)}" ` +
              `type="button" aria-pressed="${resizable}" ` +
              `title="${resizable ? "Resizing on — click to lock this frame" : "Resizing locked — click to allow resizing"}" ` +
              `aria-label="${resizable ? "Disable resizing" : "Enable resizing"}">${resizable ? "🔓" : "🔒"}</button>` +
            `<button class="sw-group-remove" data-group-remove="${escAttr(g.id)}" type="button" ` +
              `title="Ungroup — keep the nodes on the canvas" aria-label="Ungroup ${escAttr(g.name)}">⤫</button>` +
          `</div>` +
        `</section>`;
    }).join("");
    // Resize handles live in their own layer above the cards, so a frame edge
    // that a card overlaps is still grabbable. A folded or locked frame has none.
    if (handlesEl) {
      handlesEl.innerHTML = groups().filter((g) => !g.collapsed && g.resizable !== false).map((g) =>
        GROUP_HANDLES.map((dir) =>
          `<span class="sw-group-handle sw-gh-${dir}" data-group-resize="${escAttr(g.id)}" ` +
            `data-dir="${dir}" title="Resize ${escAttr(g.name)}"></span>`).join("")).join("");
    }
  }

  /** The box an expanded group wraps: its members plus the header and padding. */
  function groupBox(g) {
    if (g.collapsed) return { x: g.x, y: g.y, w: GROUP_FOLDED_W, h: GROUP_FOLDED_H };
    const members = (g.nodeIds || []).map(nodeById).filter(Boolean);
    const manual = Number.isFinite(g.w) && g.w > 0 && Number.isFinite(g.h) && g.h > 0;
    if (!members.length) {
      return manual ? { x: g.x, y: g.y, w: g.w, h: g.h } : { x: g.x, y: g.y, w: 300, h: 180 };
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of members) {
      const b = boxCache.get(n.id) || { x: n.x, y: n.y, w: NODE_W, h: 120 };
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
    }
    const auto = {
      x: Math.max(0, minX - GROUP_PAD),
      y: Math.max(0, minY - GROUP_HEAD),
      w: Math.max(240, maxX - minX + GROUP_PAD * 2),
      h: Math.max(120, maxY - minY + GROUP_HEAD + GROUP_PAD),
    };
    // A hand-resized frame keeps its room, but always grows to hold a member
    // that was moved or dropped outside it — the frame never loses a node.
    if (!manual) return auto;
    const left = Math.min(g.x, auto.x), top = Math.min(g.y, auto.y);
    const right = Math.max(g.x + g.w, auto.x + auto.w);
    const bottom = Math.max(g.y + g.h, auto.y + auto.h);
    return { x: left, y: top, w: right - left, h: bottom - top };
  }

  /**
   * A folded group's run summary: what its members are doing in the run the
   * canvas is showing (`viewRun`), as a short chip label. A folded workflow is
   * otherwise invisible, so this is how a run started elsewhere tells the user
   * that this group is waiting, running, done or failed.
   */
  function groupRunStatus(g) {
    const ids = g.nodeIds || [];
    const total = ids.length;
    const states = ids.map((id) => runNode(id)).filter(Boolean);
    if (!states.length) return { state: "idle", text: "not run", title: "No run has reached this group yet" };
    const count = (st) => states.filter((s) => s.status === st).length;
    const done = count("done");
    const running = count("running");
    const waiting = count("waiting");
    const errors = count("error");
    const stopped = count("stopped");
    const skipped = count("skipped");
    let state = "idle", text = `${done}/${total}`;
    if (errors) { state = "error"; text = `✖ ${done}/${total}`; }
    else if (waiting) { state = "waiting"; text = `⏸ ${done}/${total}`; }
    else if (running) { state = "running"; text = `◌ ${done}/${total}`; }
    else if (stopped) { state = "stopped"; text = `■ ${done}/${total}`; }
    else if (total && done === total) { state = "done"; text = `✔ ${done}/${total}`; }
    else if (total && skipped === total) { state = "skipped"; text = `– ${total}/${total}`; }
    else if (done) { state = "partial"; text = `${done}/${total}`; }
    const bits = [`${done}/${total} done`];
    if (running) bits.push(`${running} running`);
    if (waiting) bits.push(`${waiting} waiting`);
    if (errors) bits.push(`${errors} failed`);
    return { state, text, title: bits.join(" · ") };
  }

  /** Refresh chip summaries in place for a live-run tick (no DOM rebuild). */
  function syncGroupStatuses() {
    if (!groupsEl) return;
    for (const el of groupsEl.querySelectorAll(".sw-group.collapsed")) {
      const g = groupById(el.dataset.group);
      const chip = el.querySelector("[data-group-status]");
      if (!g || !chip) continue;
      const st = groupRunStatus(g);
      chip.className = `sw-group-status sw-gs-${st.state}`;
      chip.textContent = st.text;
      chip.title = st.title;
    }
  }

  /** Write one group's frame box — and its resize handles — onto the canvas. */
  function placeGroup(g) {
    const el = groupsEl?.querySelector(`.sw-group[data-group="${CSS.escape(g.id)}"]`);
    if (!el) return;
    const b = groupBox(g);
    el.style.left = `${b.x}px`;
    el.style.top = `${b.y}px`;
    el.style.width = `${b.w}px`;
    el.style.height = `${b.h}px`;
    const half = 6;
    const at = {
      nw: [b.x, b.y], n: [b.x + b.w / 2, b.y], ne: [b.x + b.w, b.y],
      e: [b.x + b.w, b.y + b.h / 2], se: [b.x + b.w, b.y + b.h],
      s: [b.x + b.w / 2, b.y + b.h], sw: [b.x, b.y + b.h], w: [b.x, b.y + b.h / 2],
    };
    for (const handle of handlesEl?.querySelectorAll(`.sw-group-handle[data-group-resize="${CSS.escape(g.id)}"]`) || []) {
      const p = at[handle.dataset.dir];
      if (!p) continue;
      handle.style.left = `${p[0] - half}px`;
      handle.style.top = `${p[1] - half}px`;
    }
  }

  /** Place every frame over the cards it holds (one measure, then all writes). */
  function layoutGroups() {
    if (!groupsEl) return;
    measureBoxes();
    for (const g of groups()) placeGroup(g);
  }

  function renderNodes() {
    const sel = selected && selected.kind === "node" ? selected.id : null;
    const folded = foldedNodeIds();
    nodesEl.innerHTML = nodes().filter((n) => !folded.has(n.id)).map((n) => {
      const rs = runNode(n.id);
      const st = rs?.status || "";
      const off = n.type === "agent" && n.config?.enabled === false;
      const picked = n.id === sel || groupSel.has(n.id);
      const cls = `sw-node sw-t-${n.type}${picked ? " sel" : ""}${st ? ` sw-run-${st}` : ""}${off ? " sw-off" : ""}`;
      const badge = st ? `<span class="sw-badge sw-b-${st}" title="${escAttr(rs?.bypassed ? "bypassed" : st)}">${badgeGlyph(st, rs?.bypassed)}</span>` : "";
      // A loop has three ports, laid out for a feedback edge: the **input**
      // arrives on the right (with the exit), and the **Repeat** output leaves on
      // the LEFT, back towards the step the loop re-runs. Every other node keeps
      // the usual input-left / output-right pair.
      const loopNode = n.type === "loop";
      const inPort = n.type === "start" ? ""
        : loopNode
          ? `<span class="sw-port sw-port-in" data-port="in" title="Input — what the previous step produced"></span>`
          : `<span class="sw-port sw-port-in" data-port="in" title="Input"></span>`;
      const outPort = n.type === "end" ? ""
        : loopNode
          ? `<span class="sw-port sw-port-out sw-port-repeat" data-port="repeat" ` +
              `title="Repeat — drag to the step this loop re-runs each pass"></span>` +
            `<span class="sw-port sw-port-out sw-port-next" data-port="next" ` +
              `title="Exit — the finished loop's output"></span>` +
            `<span class="sw-port-cap sw-port-cap-repeat" aria-hidden="true">repeat</span>` +
            `<span class="sw-port-cap sw-port-cap-next" aria-hidden="true">exit</span>`
          : `<span class="sw-port sw-port-out" data-port="next" title="Drag to connect to another node"></span>`;
      // The head shows the provider the node runs — the mark of the harness it
      // spawns — so a canvas of mixed agents is readable without opening the
      // node's settings. The mark carries the provider's name as its tooltip.
      const glyph = n.type === "agent"
        ? harnessIcon(n.config?.harness, providerLabel(n.config?.harness))
        : `<span class="sw-node-glyph">${nodeGlyph(n.type)}</span>`;
      // The gear is how a node is configured: there is no settings sidebar, so a
      // node's settings open over the canvas from its own head (or on a
      // double-click of the card).
      const gear = `<button class="sw-node-config" data-config="${escAttr(n.id)}" type="button" ` +
        `title="Settings for ${escAttr(n.name)}" aria-label="Settings for ${escAttr(n.name)}">⚙</button>`;
      return `<div class="${cls}" data-id="${escAttr(n.id)}" style="left:${n.x}px;top:${n.y}px">` +
        `<div class="sw-node-head">` +
          glyph +
          `<span class="sw-node-name" title="${escAttr(n.name)}">${esc(n.name)}</span>` +
          badge +
          gear +
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
      boxCache.set(id, {
        x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight,
        // A loop's two out ports sit above/below the middle; the flag saves a
        // node lookup per edge while routing.
        loop: el.classList.contains("sw-t-loop"),
      });
    }
  }

  /** Where a port sits, in canvas coordinates. A loop is the one node whose
   *  ports are not the default pair: its input and its Exit share the right edge
   *  (input above, exit below) while Repeat leaves the left edge. The fractions
   *  are the same ones the stylesheet positions `.sw-port-*` with, so the wiring
   *  always meets the port it was drawn from. */
  const PORT_Y = { in: 0.30, repeat: 0.30, next: 0.74 };

  function portPos(id, which, port) {
    let b = boxCache.get(id);
    if (!b) {
      // Not measured yet (e.g. a link drag before the first paint): measure just
      // this node, and remember it.
      const el = nodesEl.querySelector(`.sw-node[data-id="${CSS.escape(id)}"]`);
      if (!el) return null;
      b = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight, loop: el.classList.contains("sw-t-loop") };
      boxCache.set(id, b);
    }
    if (which === "in") {
      return b.loop
        ? { x: b.x + b.w, y: b.y + b.h * PORT_Y.in }
        : { x: b.x, y: b.y + b.h / 2 };
    }
    if (b.loop) {
      return port === "repeat"
        ? { x: b.x, y: b.y + b.h * PORT_Y.repeat }
        : { x: b.x + b.w, y: b.y + b.h * PORT_Y.next };
    }
    return { x: b.x + b.w, y: b.y + b.h / 2 };
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
      const p1 = portPos(e.from, "out", e.port), p2 = portPos(e.to, "in");
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
      // A loop's feedback edge is drawn dashed in the loop's own colour, so a
      // cycle on the canvas never reads as an accident.
      item.path.classList.toggle("sw-edge-repeat", e.port === "repeat");
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
    // A folded group's nodes are off the canvas, so their wiring goes with them
    // — showing an edge that ends in nothing would read as a broken graph.
    const folded = foldedNodeIds();
    layoutEdges(edges().filter((e) => !folded.has(e.from) && !folded.has(e.to)), true);
  }
  function showTmpPath(fromId, port, toX, toY) {
    const p1 = portPos(fromId, "out", port);
    if (!p1) return;
    tmpPathEl.setAttribute("d", edgePath(p1, { x: toX, y: toY }));
    tmpPathEl.style.display = "";
  }
  function hideTmpPath() { tmpPathEl.style.display = "none"; }

  // ─── The settings popup ───────────────────────────────────────────────────
  //
  // One modal carries all three settings surfaces: a node (opened from the gear
  // on its card, or with a double-click), a connection, and the workflow-level
  // triggers (from the toolbar). The canvas keeps the full width, and the popup
  // is the only place a setting is edited.

  /** The popup's close control. Every popup has exactly one. */
  function closeXHtml() {
    return `<button class="sw-dlg-x" id="sw-close-x" type="button" title="Close" aria-label="Close">✕</button>`;
  }

  /**
   * The frame every popup shares: head, scrolling body, actions row.
   *
   * The close control lives in the head, at the panel's top-right corner and
   * outside whatever the head holds — a node's name field included — so it never
   * competes with a field for space. The actions row carries the surface's own
   * actions only: closing is the ✕ (or Esc, or the scrim).
   */
  function dialogHtml(head, body, actions) {
    return `<div class="sw-dlg-head">${head}${closeXHtml()}</div>` +
      `<div class="sw-dlg-body">${body}</div>` +
      `<div class="sw-dlg-actions">${actions}</div>`;
  }

  /** Open the popup on `{ kind, id }`, or close it with nothing. */
  function openDialog(next) {
    dlg = next || null;
    if (!modalEl || !dlgEl) return;
    modalEl.hidden = !dlg;
    document.removeEventListener("keydown", dialogKeys);
    if (!dlg) { dlgEl.innerHTML = ""; return; }
    document.addEventListener("keydown", dialogKeys);
    renderDialog();
  }
  function closeDialog() { openDialog(null); }
  /** Escape closes the popup, like every other overlay in the app. */
  function dialogKeys(e) { if (e.key === "Escape") closeDialog(); }

  /** (Re)build the open popup. A closed popup costs nothing. */
  function renderDialog() {
    if (!dlgEl || !dlg) return;
    // What is open decides how the panel lays itself out: a node's settings use
    // the whole panel (see client.css → Node settings popup), while a connection
    // or the trigger form stays one readable column. The class is reset on every
    // render so opening another surface never inherits the last one's layout.
    dlgEl.className = "sw-modal";
    if (dlg.kind === "edge") { dlgEl.classList.add("sw-dlg-edge"); return renderEdgeDialog(); }
    if (dlg.kind === "triggers") { dlgEl.classList.add("sw-dlg-triggers"); return renderTriggersDialog(); }
    const n = nodeById(dlg.id);
    if (!n) return closeDialog();
    dlgEl.classList.add("sw-dlg-node", `sw-dlg-${n.type}`);
    return renderNodeDialog(n);
  }

  // ─── Triggers (workflow-level) ────────────────────────────────────────────

  function triggerSummary(t) {
    const armed = t && (typeof t.armed === "boolean" ? t.armed
      : t.schedule?.mode === "interval" || t.schedule?.mode === "daily" || t.event?.enabled === true);
    if (!t || !armed) return "No trigger armed — runs start when you press ▶ Run.";
    const bits = [];
    if (t.schedule?.mode === "interval") bits.push(`every ${t.schedule.everySeconds}s`);
    if (t.schedule?.mode === "daily") bits.push(`daily at ${t.schedule.at}`);
    if (t.event?.enabled) bits.push(t.event.types.length ? `on ${t.event.types.join(", ")}` : "on any event");
    const next = t.nextRunAt ? ` Next scheduled run ${new Date(t.nextRunAt).toLocaleString()}.` : "";
    return `Armed — ${bits.join(", ")}.${next} A run only starts while this workflow is idle.`;
  }

  function renderTriggersDialog() {
    dlgEl.innerHTML = dialogHtml(
      `<span class="sw-dlg-glyph">⏱</span><span class="sw-dlg-title">Workflow triggers</span>`,
      triggersFormHtml(triggers || {}),
      `<button class="btn-sm sw-primary" id="sw-tr-save" type="button">Save triggers</button>`,
    );
    wireTriggersForm();
  }

  /** The trigger fields — schedule and event watch — as they sit inside a start
   *  node's settings. The start node's own user message is the run's task, so a
   *  trigger does not repeat it here. */
  function triggersFormHtml(t, opts) {
    const o = opts || {};
    const cfg = t || {};
    const sch = cfg.schedule || { mode: "off", everySeconds: 300, at: "09:00" };
    const ev = cfg.event || { enabled: false, types: [] };
    return `<div class="sw-triggers${o.compact ? " sw-triggers-compact" : ""}">` +
      `<p class="sw-muted sw-tr-lead">${o.lead || "Start this workflow on a schedule or when an event arrives, not only from ▶ Run."}</p>` +
      `<label class="sw-field sw-tr-schedule"><span>Schedule</span>` +
        `<select class="set-select" id="sw-tr-mode">` +
          `<option value="off"${sch.mode === "off" ? " selected" : ""}>off — manual runs only</option>` +
          `<option value="interval"${sch.mode === "interval" ? " selected" : ""}>every N seconds</option>` +
          `<option value="daily"${sch.mode === "daily" ? " selected" : ""}>every day at…</option>` +
        `</select></label>` +
      `<label class="sw-field sw-tr-timing" id="sw-tr-interval" style="display:${sch.mode === "interval" ? "" : "none"}"><span>Every (seconds)</span>` +
        `<input class="set-input" id="sw-tr-every" type="number" min="5" max="86400" step="5" value="${escAttr(sch.everySeconds || 300)}">` +
        `<div class="sw-hint">60 = every minute, 3600 = hourly.</div></label>` +
      `<label class="sw-field sw-tr-timing" id="sw-tr-daily" style="display:${sch.mode === "daily" ? "" : "none"}"><span>At (local time)</span>` +
        `<input class="set-input" id="sw-tr-at" value="${escAttr(sch.at || "09:00")}" placeholder="09:00"></label>` +
      // The event watch is one idea, so it is one block: the switch that arms it
      // and the types that narrow it.
      `<div class="sw-tr-eventbox">` +
        `<label class="sw-check sw-check-line"><input type="checkbox" id="sw-tr-event"${ev.enabled ? " checked" : ""}> start on observed events</label>` +
        `<label class="sw-field"><span>Event types</span>` +
          `<input class="set-input" id="sw-tr-types" value="${escAttr((ev.types || []).join(", "))}" placeholder="tool_call, file_edit">` +
          `<div class="sw-hint">Comma-separated event types. Empty = any event from this workspace.</div></label>` +
      `</div>` +
      `<div class="sw-hint sw-tr-summary">${esc(triggerSummary(cfg))}</div>` +
    `</div>`;
  }

  /** Read the trigger fields currently in the open start-node popup. */
  function readTriggersForm() {
    const types = (dlgEl.querySelector("#sw-tr-types")?.value || "")
      .split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    return {
      schedule: {
        mode: dlgEl.querySelector("#sw-tr-mode")?.value || "off",
        everySeconds: Number(dlgEl.querySelector("#sw-tr-every")?.value || 0) || 300,
        at: dlgEl.querySelector("#sw-tr-at")?.value.trim() || "09:00",
      },
      event: { enabled: !!dlgEl.querySelector("#sw-tr-event")?.checked, types },
      // The start node's own message is the task; a trigger never overrides it.
      task: "",
    };
  }

  function wireTriggerFields() {
    const mode = dlgEl.querySelector("#sw-tr-mode");
    if (!mode) return;
    const sync = () => {
      const interval = dlgEl.querySelector("#sw-tr-interval");
      const daily = dlgEl.querySelector("#sw-tr-daily");
      if (interval) interval.style.display = mode.value === "interval" ? "" : "none";
      if (daily) daily.style.display = mode.value === "daily" ? "" : "none";
    };
    mode.addEventListener("change", sync);
    sync();
  }

  function wireTriggersForm() {
    wireTriggerFields();
    dlgEl.querySelector("#sw-tr-save")?.addEventListener("click", saveTriggers);
  }

  async function saveTriggers() {
    const payload = readTriggersForm();
    try {
      const { res, data } = await S.api("/subagent-workflow/triggers", {}, Object.assign({ cwd }, payload));
      if (!res.ok || data?.error) throw new Error(data?.error || `HTTP ${res.status}`);
      triggers = data.triggers;
      renderTriggersDialog();
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
    const opts = list.map((h) => {
      const unavailable = h.available === false;
      return `<option value="${escAttr(h.id)}"${h.id === current ? " selected" : ""}>${esc(h.label || h.id)}${unavailable ? " (not installed)" : ""}</option>`;
    }).join("");
    // A harness this installation no longer knows (a custom one that was removed)
    // stays selected and visible rather than silently snapping to the first row.
    return current && !list.some((h) => h.id === current)
      ? opts + `<option value="${escAttr(current)}" selected>${esc(current)} (unavailable)</option>`
      : opts;
  }

  /** The models a provider offers: Pi's are the app's whole model catalogue
   *  (`<provider>/<id>`, served with the harness list), a CLI's start from the
   *  curated suggestions on its registry entry — then whatever its own CLI
   *  reported, deduped and after the declared ones, so a live answer only ever
   *  adds to the list. */
  function harnessModels(hid) {
    const meta = harnessMeta(hid);
    const declared = meta && Array.isArray(meta.models) ? meta.models : [];
    const reported = cliModels.get(hid) || [];
    if (!reported.length) return declared;
    const seen = new Set(declared);
    return declared.concat(reported.filter((m) => !seen.has(m)));
  }
  /** The command a provider can be asked for its own model list, as the field's
   *  hint spells it — `opencode models` — or "" when it has none. */
  function modelsCommandOf(hid) {
    const meta = harnessMeta(hid);
    if (!meta || !Array.isArray(meta.modelsArgs) || !meta.modelsArgs.length) return "";
    return `${meta.bin || hid} ${meta.modelsArgs.join(" ")}`.trim();
  }
  /** A list whose every entry is `provider/id`: the provider half is part of the
   *  value, so its options group by it (the shape a Pi node's catalogue gets).
   *  A thousand opencode models in one flat run of options cannot be read. */
  function providerKeyed(list) {
    return list.length > 1 && list.every((k) => /^[^/\s]+\/.+$/.test(String(k)));
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
    // Group the options by provider whenever the entries are `provider/id` keys —
    // always for Pi, and for a harness whose CLI reports its own catalogue (one
    // optgroup per provider keeps a thousand opencode ids navigable).
    const grouped = pi || providerKeyed(list);
    // What the select shows as chosen: for Pi the catalogue key the stored value
    // resolves to, otherwise the stored value itself when the list knows it.
    const resolved = pi ? resolveModelKey(list, value) : (list.includes(value) ? value : "");
    const known = !!resolved;
    const opts = [`<option value=""${value ? "" : " selected"}>${pi ? "— agent default —" : "— harness default —"}</option>`]
      .concat(grouped
        ? modelOptionGroups(list, resolved)
        : list.map((m) => `<option value="${escAttr(m)}"${m === resolved ? " selected" : ""}>${esc(m)}</option>`))
      .concat([`<option value="${MODEL_CUSTOM}"${known || !value ? "" : " selected"}>Custom…</option>`])
      .join("");
    const meta = harnessMeta(hid) || {};
    // What the provider's own CLI answered (or is still answering): the list is
    // the tool's, not this bundle's, so say where it came from.
    const reported = cliModels.get(hid) || [];
    const cmd = modelsCommandOf(hid);
    const cliNote = !cmd ? ""
      : cliPending.has(hid) ? ` Asking <code>${esc(cmd)}</code> for its list…`
      : reported.length ? ` ${reported.length} of them reported by <code>${esc(cmd)}</code>.`
      : "";
    const hint = pi
      ? `Every model this app can run, grouped by provider — pi is given <code>provider/model</code>, so two providers offering the same name never clash. <b>Custom…</b> takes anything else.`
      : reported.length
        ? `The models <code>${esc(cmd)}</code> reports for this provider. <b>Custom…</b> takes a model of your own — it is kept with this node.`
        : list.length
          ? `Models this harness documents — or <b>Custom…</b> for a model of your own, kept with this node.${cliNote}`
          : `No model list known for this harness — use <b>Custom…</b>.${cliNote}`;
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

  /** The model the form is showing: the select's value, or the free-text
   *  box when the provider has no list / "Custom…" is chosen. */
  function readModelField() {
    const el = dlgEl.querySelector("#sw-f-model");
    if (!el) return "";
    if (el.tagName !== "SELECT") return el.value.trim();
    if (el.value !== MODEL_CUSTOM) return el.value;
    return dlgEl.querySelector("#sw-f-model-custom")?.value.trim() || "";
  }
  /**
   * Ask the selected provider's own CLI for its model list and fold the answer
   * into the Model dropdown. Only the Model block is rewritten when it arrives:
   * the rest of the form may hold edits the user has not saved yet.
   *
   * The server caches the command's answer for a few minutes, so opening node
   * after node does not spawn a CLI each time — the round trip still happens, so a
   * model added to the CLI shows up the next time a node is opened.
   */
  async function askCliModels(n) {
    const hid = dlgEl.querySelector("#sw-f-harness")?.value || n.config?.harness || "";
    const cmd = modelsCommandOf(hid);
    if (!cmd) return;
    const token = ++modelAsk;
    // A first answer for this provider shows the wait; a list already in hand
    // stays put until the fresh one replaces it.
    if (!cliModels.has(hid)) { cliPending.add(hid); repaintModelField(); }
    let models = [];
    try {
      const data = await getJson("/subagent-workflow/models", { harness: hid });
      models = Array.isArray(data.models) ? data.models : [];
    } catch { models = []; }
    cliPending.delete(hid);
    if (models.length) cliModels.set(hid, models); else cliModels.delete(hid);
    if (token !== modelAsk) return;                        // a newer open owns the form
    if ((dlgEl.querySelector("#sw-f-harness")?.value || "") !== hid) return;
    if (!dlgEl.querySelector("#sw-f-model")) return;       // the provider changed field kind
    repaintModelField();
  }

  /** Rewrite just the Model block of an open form, keeping what it is showing. */
  function repaintModelField() {
    const wrap = dlgEl.querySelector("#sw-model-wrap");
    const sel = dlgEl.querySelector("#sw-f-harness");
    if (!wrap || !sel) return;
    const current = readModelField();
    wrap.innerHTML = modelFieldHtml(sel.value, current);
    bindModelField();
  }

  /** Wire "Custom…" on the model select to its free-text box. */
  function bindModelField() {
    const sel = dlgEl.querySelector("#sw-f-model");
    if (!sel || sel.tagName !== "SELECT") return;
    const custom = dlgEl.querySelector("#sw-f-model-custom");
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
      const dir = String(r.path || "").endsWith("/");
      return `<div class="sw-ref-row" data-ref="${escAttr(r.id)}">` +
        `<span class="sw-ref-icon" title="${dir ? "folder" : "file"}">${dir ? "📁" : "📄"}</span>` +
        `<span class="sw-ref-path" title="${escAttr(r.path)}">${esc(shown)}</span>` +
        `<input class="set-input sw-ref-note" value="${escAttr(r.note || "")}" spellcheck="false" ` +
          `placeholder="description sent with the path" aria-label="Description of ${escAttr(shown)}">` +
        `<button class="sw-ref-del" type="button" data-ref-del="${escAttr(r.id)}" ` +
          `title="Remove ${escAttr(shown)}">×</button></div>`;
    }).join("");
    return `<div class="sw-field sw-fld-refs sw-refs" id="sw-refs">` +
        `<span>Reference files &amp; folders <em>(optional)</em></span>` +
        (refs.length ? `<div class="sw-ref-list">${rows}</div>`
                     : `<div class="sw-ref-empty" id="sw-refs-empty">` +
                         `<span class="sw-ref-empty-glyph" aria-hidden="true">📎</span>` +
                         `<span class="sw-ref-empty-title">No references yet</span>` +
                         `<span class="sw-ref-empty-hint">Add a file or folder below — it is sent with this node's message so its agent can read it.</span>` +
                       `</div>`) +
        `<div class="sw-ref-add">` +
          `<input class="set-input" id="sw-ref-path" spellcheck="false" autocomplete="off" ` +
            `placeholder="docs/architecture.md or src/ — relative to the workspace">` +
          `<input class="set-input" id="sw-ref-note" spellcheck="false" autocomplete="off" ` +
            `placeholder="What it is (sent with the path)">` +
          `<button class="btn-sm" id="sw-ref-add-btn" type="button" title="Add this file or folder as a reference of this node">Add</button>` +
          `<button class="btn-sm" id="sw-ref-browse" type="button" title="Pick a file or folder from the workspace">Browse…</button>` +
        `</div>` +
        // The browser renders into this box: the workspace's own folders and
        // files, so a path is picked rather than remembered.
        `<div class="sw-ref-picker" id="sw-ref-picker" hidden></div>` +
        `<div class="sw-hint">Each reference — a file, or a whole folder — is injected into this node's message with its description. Leave the description empty and the file's own first heading is used (a folder reads as “folder”).</div>` +
      `</div>`;
  }

  /**
   * Add a reference by path, whatever produced the path: the Add button under a
   * typed one, or a row of the browser. The server resolves and canonicalises it
   * either way, so what is stored is what the agent will be given.
   */
  async function addRefPath(n, p) {
    if (!p) { S.toast?.("Give the reference a path", "err"); return; }
    const note = dlgEl.querySelector("#sw-ref-note")?.value.trim() || "";
    await run_(() => post("addRef", { nodeId: n.id, path: p, note }), "Reference added");
  }

  /**
   * The reference browser: one workspace folder at a time, folders first. A file
   * is added by clicking it, a folder by its own button — the browser shows both,
   * because a reference can be either. Navigation stays inside the workspace: the
   * server refuses anything above the root.
   */
  async function openRefPicker(n, rel) {
    const box = dlgEl.querySelector("#sw-ref-picker");
    if (!box) return;
    box.hidden = false;
    box.innerHTML = `<div class="sw-hint">Reading the workspace…</div>`;
    let data;
    try { data = await getJson("/subagent-workflow/entries", { path: rel || "" }); }
    catch (err) {
      box.innerHTML = `<div class="sw-hint sw-warn">⚠ ${esc(String(err.message || err))}</div>`;
      return;
    }
    const here = data.rel || "";
    const up = here ? here.split("/").slice(0, -1).join("/") : "";
    const entries = Array.isArray(data.entries) ? data.entries : [];
    const rows = entries.map((e) => {
      const use = `<button class="btn-sm sw-pick-use" data-pick-add="${escAttr(e.dir ? `${e.rel}/` : e.rel)}" type="button" ` +
        `title="Add this ${e.dir ? "folder" : "file"} as a reference">Use</button>`;
      return `<div class="sw-pick-row${e.dir ? " dir" : ""}" data-pick-${e.dir ? "nav" : "file"}="${escAttr(e.rel)}">` +
        `<span class="sw-pick-icon">${e.dir ? "📁" : "📄"}</span>` +
        `<span class="sw-pick-name" title="${escAttr(e.rel)}">${esc(e.name)}</span>` + use + `</div>`;
    }).join("");
    box.innerHTML =
      `<div class="sw-pick-bar">` +
        `<button class="sw-pick-btn" data-pick-nav="${escAttr(up)}" type="button" title="Up one level"${here ? "" : " disabled"}>↑</button>` +
        `<span class="sw-pick-dir" title="${escAttr(data.path || "")}">${esc(here || "workspace root")}</span>` +
        `<button class="btn-sm" data-pick-add="${escAttr(here ? `${here}/` : ".")}" type="button" title="Add this folder as a reference">Use this folder</button>` +
        `<button class="sw-pick-btn" data-pick-close="1" type="button" title="Close the browser">✕</button>` +
      `</div>` +
      `<div class="sw-pick-list">${rows || `<div class="sw-msg-none">This folder is empty.</div>`}</div>`;
    box.querySelectorAll("[data-pick-add]").forEach((btn) => btn.addEventListener("click", (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      void addRefPath(n, btn.dataset.pickAdd || ".");
    }));
    box.querySelectorAll("[data-pick-nav]").forEach((row) => row.addEventListener("click", (ev) => {
      ev.preventDefault();
      void openRefPicker(n, row.dataset.pickNav);
    }));
    box.querySelectorAll("[data-pick-file]").forEach((row) => row.addEventListener("click", (ev) => {
      ev.preventDefault();
      void addRefPath(n, row.dataset.pickFile);
    }));
    box.querySelector("[data-pick-close]")?.addEventListener("click", (ev) => { ev.preventDefault(); box.hidden = true; box.innerHTML = ""; });
  }

  /** Wire the reference list: add, describe, remove. */
  function wireRefs(n) {
    const wrap = dlgEl.querySelector("#sw-refs");
    if (!wrap) return;
    const pathEl = wrap.querySelector("#sw-ref-path");
    const noteEl = wrap.querySelector("#sw-ref-note");
    const add = () => {
      const p = pathEl.value.trim();
      if (!p) { S.toast?.("Give the reference a path", "err"); pathEl.focus(); return; }
      addRefPath(n, p);
    };
    wrap.querySelector("#sw-ref-add-btn").addEventListener("click", add);
    wrap.querySelector("#sw-ref-browse").addEventListener("click", () => openRefPicker(n, ""));
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

  function renderNodeDialog(n) {
    const title = n.type === "agent" ? "Agent node"
      : n.type === "approval" ? "Approval node"
      : n.type === "loop" ? "Loop node"
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
        `<label class="sw-field sw-fld-provider"><span class="sw-field-label">Provider <span id="sw-harness-icon">${harnessIcon(c.harness, providerLabel(c.harness))}</span></span>` +
          `<select class="set-select" id="sw-f-harness">${harnessOptions(c.harness)}</select>` +
          `<div class="sw-hint" id="sw-harness-hint"></div></label>` +
        `<div class="sw-fld-model" id="sw-model-wrap">${modelFieldHtml(c.harness, c.model)}</div>` +
        `<label class="sw-field sw-fld-prompt"><span>User message</span>` +
          `<textarea class="set-input sw-textarea" id="sw-f-prompt" rows="5" spellcheck="false" placeholder="{input}">${esc(c.prompt || "")}</textarea>` +
          `<div class="sw-hint"><code>{input}</code> = what the nodes before this one produced, <code>{task}</code> = the run task.</div></label>` +
        `<label class="sw-field sw-fld-command sw-only-custom" id="sw-custom-wrap"><span>Command</span>` +
          `<input class="set-input" id="sw-f-command" value="${escAttr(c.command || "")}" placeholder="my-agent -p &quot;${customVar("SW_PROMPT")}&quot;">` +
          `<div class="sw-hint">What this provider runs. <code>${esc(customVar("SW_PROMPT"))}</code>, <code>${esc(customVar("SW_TASK"))}</code>, <code>${esc(customVar("SW_NODE"))}</code> and <code>${esc(customVar("SW_REFS"))}</code> are set for it.` +
            (serverPlatform === "win32" ? ` Run through <code>cmd.exe</code>.` : ` Run through your shell.`) + `</div></label>` +
        refsFieldHtml(n) +
        // The node's result, beside the message that produced it: the wide
        // panel's right column, and under the references on a narrow one.
        `<div class="sw-field sw-fld-out" id="sw-node-out">${nodeOutputHtml(n)}</div>`;
    } else if (n.type === "approval") {
      const c = n.config || {};
      fields =
        `<label class="sw-field sw-fld-prompt"><span>User message</span>` +
          `<textarea class="set-input sw-textarea" id="sw-f-message" rows="5" spellcheck="false" placeholder="Approve the plan above before it is implemented.">${esc(c.message || "")}</textarea>` +
          `<div class="sw-hint">Shown on the gate's card in the messages sidebar while the run waits. <code>{input}</code> = the final output of the nodes wired in, <code>{task}</code> = the run task.</div></label>`;
    } else if (n.type === "loop") {
      const c = n.config || {};
      const count = Math.max(1, Math.round(Number(c.count) || 1));
      const feedback = edges().filter((e) => e.from === n.id && e.port === "repeat")
        .map((e) => nodeById(e.to)?.name).filter(Boolean);
      fields =
        `<label class="sw-field"><span>Passes</span>` +
          `<input class="set-input sw-count-input" id="sw-f-count" type="number" min="1" max="100" step="1" value="${count}">` +
          `<div class="sw-hint">How many times this loop runs. Drag the <b>repeat</b> output (the cyan port on the <b>left</b> of the node) ` +
          `back to an agent to make it a refinement loop: each pass re-runs that agent with the previous pass's result ` +
          `as its <code>{input}</code>, so the output improves; the <b>exit</b> output (bottom-right) carries the finished loop on. ` +
          `With no repeat connection the loop repeats every step only it reaches.</div></label>` +
        `<div class="sw-hint">${feedback.length
          ? `Repeating: ${feedback.map((x) => esc(x)).join(", ")} — the pass's result feeds the next.`
          : `Nothing is wired to the repeat output yet, so this loop repeats the section it feeds.`}</div>` +
        `<label class="sw-field"><span>Note <em>(canvas label)</em></span>` +
          `<input class="set-input" id="sw-f-desc" value="${escAttr(c.description || "")}" maxlength="300" placeholder="Repeats the section it feeds">` +
          `<div class="sw-hint">Shown on the node. A node inside the loop can use <code>{iteration}</code>, ` +
          `<code>{iterations}</code> and <code>{loop}</code> in its message (and <code>$SW_ITERATION</code> in a command).</div></label>`;
    } else if (n.type === "start") {
      fields =
        `<label class="sw-field sw-fld-prompt"><span>User message <em>(run task)</em></span>` +
          `<textarea class="set-input sw-textarea" id="sw-f-task" rows="4" spellcheck="false" placeholder="What should this workflow do?">${esc(n.config?.defaultTask || "")}</textarea>` +
          `<div class="sw-hint">The run's task: every node can read it as <code>{task}</code> (and a command as <code>${esc(customVar("SW_TASK"))}</code>). Every node wired off this start runs in parallel.</div></label>` +
        `<div class="sw-field sw-start-triggers"><span>Triggers</span>` +
          triggersFormHtml(n.config?.triggers || {}, {
            compact: true,
            lead: "Start this entry point on a schedule or when an event arrives, not only from ▶ Run.",
          }) +
        `</div>` +
        `<div class="sw-hint">Each start node owns its own triggers and task, so several workflows can share this canvas and run independently.</div>`;
    } else {
      // The end node shows the workflow's final output (see finalOutputHtml).
      fields = `<div class="sw-fld-final" id="sw-final-body">${finalOutputHtml(n)}</div>`;
    }

    dlgEl.innerHTML = dialogHtml(
      // The node's identity, in one field-shaped box: its provider's mark, the
      // name (the label it wears on the canvas), its kind and the popup's close
      // control. The box *is* the head, so the head and the body share one
      // column (--sw-col-x) and the name field lands on exactly the same left
      // and right edges as the settings below it.
      `<span class="sw-dlg-name-wrap">` +
        (n.type === "agent"
          ? harnessIcon(n.config?.harness, providerLabel(n.config?.harness))
          : `<span class="sw-dlg-glyph sw-t-${n.type}">${nodeGlyph(n.type)}</span>`) +
        `<input class="sw-dlg-name" id="sw-f-name" value="${escAttr(n.name)}" maxlength="60" aria-label="Node name" placeholder="node name">` +
        `<span class="sw-dlg-kind">${title.replace(" node", "")}</span>` +
      `</span>`,
      fields,
      `<button class="btn-sm sw-danger" id="sw-delete" type="button">Delete</button>` +
      (n.type !== "start" && n.type !== "end" ? `<button class="btn-sm" id="sw-duplicate" type="button" title="Clone this node, keeping its settings">Duplicate</button>` : "") +
      `<button class="btn-sm sw-primary" id="sw-save" type="button">Save node</button>`,
    );

    dlgEl.querySelector("#sw-save").addEventListener("click", () => saveNode(n));
    dlgEl.querySelector("#sw-delete").addEventListener("click", () => removeNode(n.id));
    dlgEl.querySelector("#sw-duplicate")?.addEventListener("click", () => duplicateNode(n.id));
    bindModelField();
    wireRefs(n);
    if (n.type === "start") wireTriggerFields();
    const harnessSel = dlgEl.querySelector("#sw-f-harness");
    if (harnessSel) {
      const syncCustom = () => {
        const custom = harnessSel.value === "custom";
        // `display: none` is the stylesheet default, so showing it has to name
        // the display the field uses (a column).
        dlgEl.querySelector("#sw-custom-wrap").style.display = custom ? "flex" : "none";
        const meta = harnessMeta(harnessSel.value);
        const hint = dlgEl.querySelector("#sw-harness-hint");
        hint.textContent = meta && meta.available === false
          ? `⚠ ${meta.bin || meta.label} was not found on PATH — the node will fail until it is installed.`
          : meta ? `Runs: ${meta.bin ? `${meta.bin}` : "the app's Pi runner"}` : "";
        hint.className = meta && meta.available === false ? "sw-hint sw-warn" : "sw-hint";
        // The head + the field label show the provider's mark, so switching
        // harness updates both without re-rendering the form.
        setHarnessIcon(dlgEl.querySelector("#sw-harness-icon"), harnessSel.value, providerLabel(harnessSel.value));
        setHarnessIcon(dlgEl.querySelector(".sw-dlg-head .sw-hicon"), harnessSel.value, providerLabel(harnessSel.value));
      };
      // The model list belongs to the provider, so switching it rewrites just
      // that block — carrying over what the user has typed but not saved —
      // instead of the whole form, which would throw away an unsaved message.
      harnessSel.addEventListener("change", () => {
        const model = readModelField();
        dlgEl.querySelector("#sw-model-wrap").innerHTML = modelFieldHtml(harnessSel.value, model);
        bindModelField();
        syncCustom();
        // The new provider's list may be its CLI's to report — ask it (the field
        // already offers what the harness declares while the answer is on its way).
        void askCliModels(n);
      });
      syncCustom();
      void askCliModels(n);
    }
  }

  function renderEdgeDialog() {
    const e = edges().find((x) => x.id === dlg.id);
    if (!e) { selected = null; return closeDialog(); }
    const from = nodeById(e.from), to = nodeById(e.to);
    const repeat = e.port === "repeat";
    const kindOf = (n) => !n ? "unknown"
      : n.type === "approval" ? "approval gate"
      : n.type === "agent" ? (providerLabel(n.config?.harness) || "agent")
      : n.type;
    const endHtml = (side, n, id) =>
      `<div class="sw-conn-end">` +
        `<span class="sw-conn-eyebrow">${side}</span>` +
        `<span class="sw-conn-name">${esc(n?.name || id)}</span>` +
        `<span class="sw-conn-kind">${esc(kindOf(n))}</span>` +
      `</div>`;
    dlgEl.innerHTML = dialogHtml(
      `<span class="sw-dlg-glyph">${repeat ? "🔁" : "⇢"}</span><span class="sw-dlg-title">${repeat ? "Repeat connection" : "Connection"}</span>`,
      // The connection reads left to right: the two endpoints either side of the
      // port it leaves, then what that means as a note and a mono readout. On a
      // narrow panel the flow stacks; on a wide one it spans the panel.
      `<div class="sw-conn-flow">` +
        endHtml("From", from, e.from) +
        `<div class="sw-conn-link" aria-hidden="true">` +
          `<span class="sw-conn-arrow">→</span>` +
          `<span class="sw-conn-port">${repeat ? "repeat" : "next"}</span>` +
        `</div>` +
        endHtml("To", to, e.to) +
      `</div>` +
      `<div class="sw-conn-notes">` +
        `<p class="sw-muted">` +
          (repeat
            ? `Feedback: each pass of <b>${esc(from?.name || e.from)}</b> re-runs ` +
              `<b>${esc(to?.name || e.to)}</b> with the previous pass's result as its <code>{input}</code>.`
            : `The source node's output is passed to the target as <code>{input}</code>.`) +
        `</p>` +
        `<div class="sw-conn-readout">` +
          `<div class="sw-conn-readout-row"><span>port</span><code>${esc(e.port || "next")}</code></div>` +
          `<div class="sw-conn-readout-row"><span>input</span><code>{input}</code></div>` +
        `</div>` +
      `</div>`,
      `<button class="btn-sm sw-danger" id="sw-del-edge" type="button">Delete connection</button>`,
    );
    dlgEl.querySelector("#sw-del-edge").addEventListener("click", () => removeEdge(e.id));
  }

  /**
   * Save the node's name and its three settings. The config is merged over what
   * is stored rather than rebuilt from the form, so every key this panel no
   * longer edits survives an edit instead of being silently dropped.
   */
  async function saveNode(n) {
    const name = dlgEl.querySelector("#sw-f-name")?.value.trim() || "";
    if (!name) { S.toast?.("A node needs a name", "err"); return; }
    const stored = nodeById(n.id)?.config || {};
    const read = (sel, fallback) => {
      const el = dlgEl.querySelector(sel);
      return el ? el.value : fallback;
    };
    let config;
    if (n.type === "agent") {
      config = {
        ...stored,
        harness: dlgEl.querySelector("#sw-f-harness")?.value || "claude",
        model: readModelField(),
        prompt: read("#sw-f-prompt", stored.prompt || ""),
        // Only rendered while the provider is a custom command; otherwise the
        // stored one is kept untouched.
        command: read("#sw-f-command", stored.command || ""),
      };
    } else if (n.type === "approval") {
      config = { ...stored, message: read("#sw-f-message", stored.message || "") };
    } else if (n.type === "loop") {
      const raw = parseFloat(read("#sw-f-count", String(stored.count ?? 2)));
      config = {
        ...stored,
        count: Number.isFinite(raw) ? Math.min(100, Math.max(1, Math.round(raw))) : 2,
        description: read("#sw-f-desc", stored.description || ""),
      };
    } else {
      config = { ...stored };
      if (n.type === "start") {
        config.defaultTask = read("#sw-f-task", stored.defaultTask || "");
        // Triggers live on the start node now, so saving its settings saves the
        // schedule / event watch that starts a run from this entry point.
        config.triggers = readTriggersForm();
      }
    }
    await run_(() => post("updateNode", { id: n.id, name, config }), "Node saved");
  }

  async function addNode(type) {
    // The scroll offsets are screen px, so a new node lands where the user is
    // looking at any zoom.
    const x = Math.round((canvasScrollEl?.scrollLeft || 0) / zoom + 260 + Math.random() * 80);
    const y = Math.round((canvasScrollEl?.scrollTop || 0) / zoom + 180 + Math.random() * 80);
    const what = type === "agent" ? "Agent added" : type === "approval" ? "Approval gate added"
      : type === "loop" ? "Loop added" : `${type} node added`;
    await run_(() => post("addNode", { type, x, y }), what);
  }
  async function duplicateNode(id) {
    await run_(() => post("duplicateNode", { id }), "Node duplicated");
  }
  async function removeNode(id) {
    await run_(() => post("removeNode", { id }), "Node deleted");
    groupSel.delete(id);
    if (selected && selected.id === id) selected = null;
  }
  async function removeEdge(id) {
    await run_(() => post("removeEdge", { id }), "Connection deleted");
    if (selected && selected.id === id) selected = null;
  }

  async function run_(fn, okMsg) {
    try {
      wf = await fn();
      paint();
      // A node save can arm (or disarm) one start node's trigger, so the idle
      // watcher has to follow the graph that just came back.
      syncPolling();
      if (okMsg) S.toast?.(okMsg);
    } catch (err) { S.toast?.(String(err.message || err), "err"); }
  }

  // ─── Portable workflows ───────────────────────────────────────────────────

  /** The graph as a shareable file: name, nodes and edges — no run state, no
   *  absolute paths beyond whatever a node's own config carries. */
  function workflowFile() {
    return { name: wf?.name || "My Workflow", nodes: nodes(), edges: edges(), groups: groups() };
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
    groupSel = new Set();
    await run_(() => post("importWorkflow", { data }), "Workflow imported");
  }

  // ─── Dragging + connecting ────────────────────────────────────────────────

  function canvasPoint(cx, cy) {
    const rect = canvasEl.getBoundingClientRect();
    // The canvas is scaled, so a screen offset is `zoom` canvas px per screen px.
    return { x: (cx - rect.left) / zoom, y: (cy - rect.top) / zoom };
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
    // The frame a node came from, measured before the drag. The frame follows
    // its dragged member (so it keeps wrapping it), which means the drop test
    // has to compare against where the frame *was* to tell “moved within the
    // group” from “dragged out of it”.
    const owner = groupOfNode(n.id);
    const ownerEl = owner ? groupsEl?.querySelector(`.sw-group[data-group="${CSS.escape(owner.id)}"]`) : null;
    drag = {
      id: n.id, el: nodeEl, sx: e.clientX, sy: e.clientY, px: e.clientX, py: e.clientY,
      x: n.x, y: n.y, moved: false,
      ownerId: owner?.id || null,
      ownerRect: ownerEl ? ownerEl.getBoundingClientRect() : null,
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
    // Pointer deltas are screen px; node positions are canvas px.
    const dx = (drag.px - drag.sx) / zoom, dy = (drag.py - drag.sy) / zoom;
    const nx = Math.max(0, Math.round(drag.x + dx)), ny = Math.max(0, Math.round(drag.y + dy));
    drag.el.style.left = `${nx}px`; drag.el.style.top = `${ny}px`;
    const n = nodeById(drag.id);
    if (n) { n.x = nx; n.y = ny; }
    const b = boxCache.get(drag.id);
    if (b) { b.x = nx; b.y = ny; }
    // The frame stays put while a card is dragged. Re-measuring it on every
    // pointer move made it stretch to follow the card out of its group — it
    // looked like the frame was resizing instead of the node leaving. The drop
    // re-measures once: removed from the group, or grown to hold a new position.
    const owner = groupOfNode(drag.id);
    // Show which frame the card would join (a folded chip counts too: dropping
    // on it adds the node and unfolds the group around it).
    const target = groupAtPoint(drag.px, drag.py, owner?.id);
    for (const el of groupsEl?.children || []) {
      el.classList.toggle("drop-target", el.dataset.group === target?.id);
    }
    layoutEdges(drag.edges, false);
  }
  function onDragMove(e) {
    if (!drag) return;
    drag.px = e.clientX; drag.py = e.clientY;
    if (Math.abs(drag.px - drag.sx) + Math.abs(drag.py - drag.sy) > 3) drag.moved = true;
    onFrame(applyDrag);
  }
  /** The expanded group under a screen point, if any (the smallest wins when
   *  frames overlap). Folded groups are headers only and take no members. */
  function groupAtPoint(cx, cy, exceptId) {
    let best = null, bestArea = Infinity;
    for (const el of groupsEl?.children || []) {
      const g = groupById(el.dataset.group);
      if (!g || g.id === exceptId) continue;
      const r = el.getBoundingClientRect();
      if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) continue;
      const area = r.width * r.height;
      if (area < bestArea) { best = g; bestArea = area; }
    }
    return best;
  }

  function onDragUp(e) {
    document.removeEventListener("mousemove", onDragMove);
    document.removeEventListener("mouseup", onDragUp);
    if (!drag) return;
    const d = drag;
    applyDrag(); // flush the last pointer position before committing
    drag = null;
    if (d.moved) {
      // Dropping a card inside a frame joins that workflow; dropping it inside
      // the frame it already belongs to just moves it; dropping it outside every
      // frame leaves the one it came from.
      const owner = groupOfNode(d.id);
      const target = groupAtPoint(e.clientX, e.clientY, owner?.id);
      const r = d.ownerRect;
      const leftOwner = !!owner && !!r &&
        (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom);
      const pos = { id: d.id, x: nodeById(d.id)?.x ?? d.x, y: nodeById(d.id)?.y ?? d.y };
      if (target && target.id !== owner?.id) {
        run_(async () => {
          await post("moveNode", pos);
          // Dropping onto a folded chip unfolds the group so the new member is
          // visible inside the frame that just grew around it.
          return post("updateGroup", {
            id: target.id,
            nodeIds: [...(target.nodeIds || []), d.id],
            ...(target.collapsed ? { collapsed: false } : {}),
          });
        }, `Moved into ${target.name}`);
      } else if (!target && owner && leftOwner) {
        run_(async () => {
          await post("moveNode", pos);
          return post("updateGroup", {
            id: owner.id,
            nodeIds: (owner.nodeIds || []).filter((id) => id !== d.id),
          });
        }, `Removed from ${owner.name}`);
      } else {
        run_(() => post("moveNode", pos));
      }
    } else renderDialog();
    for (const el of groupsEl?.children || []) el.classList.remove("drop-target");
    if (dirty) paint();
  }
  function startLink(fromId, port) {
    link = { fromId, port: port || "next" };
    document.addEventListener("mousemove", onLinkMove);
    document.addEventListener("mouseup", onLinkUp);
  }
  function onLinkMove(e) {
    if (!link) return;
    link.px = e.clientX; link.py = e.clientY;
    onFrame(() => {
      if (!link) return;
      const p = canvasPoint(link.px, link.py);
      showTmpPath(link.fromId, link.port, p.x, p.y);
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
    // The port the drag left decides what the connection *means*: a loop's
    // Repeat output is a feedback edge, its Exit output (and every other node's
    // single out port) is an ordinary one.
    run_(() => post("addEdge", { from: l.fromId, to: nodeEl.dataset.id, port: l.port }), "Connected");
  }

  // ─── Panning ──────────────────────────────────────────────────────────────
  //
  // Dragging the empty canvas (or dragging with the middle button anywhere)
  // moves the view, like every canvas editor. A press that does not move is
  // still a click: it clears the selection, which is what the background used
  // to do on its own.

  let pan = null;

  function startPan(e) {
    if (!canvasScrollEl) return;
    e.preventDefault();
    pan = { x: e.clientX, y: e.clientY, sl: canvasScrollEl.scrollLeft, st: canvasScrollEl.scrollTop, moved: false, button: e.button };
    canvasScrollEl.classList.add("panning");
    document.addEventListener("mousemove", onPanMove);
    document.addEventListener("mouseup", onPanUp);
  }
  function onPanMove(e) {
    if (!pan) return;
    const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
    if (!pan.moved && Math.abs(dx) + Math.abs(dy) > 3) pan.moved = true;
    canvasScrollEl.scrollLeft = pan.sl - dx;
    canvasScrollEl.scrollTop = pan.st - dy;
  }
  function onPanUp() {
    document.removeEventListener("mousemove", onPanMove);
    document.removeEventListener("mouseup", onPanUp);
    canvasScrollEl?.classList.remove("panning");
    const p = pan;
    pan = null;
    saveViewSoon();
    // A drag moved the view; a plain left click still clears the selection (a
    // middle-click never does — it is a view gesture, not a click on the canvas).
    if (p && !p.moved && p.button === 0 && (selected || groupSel.size)) {
      selected = null; groupSel = new Set(); renderNodes(); selectionChanged();
    }
  }

  // ─── Marquee selection ────────────────────────────────────────────────────
  //
  // Shift-drag on the empty canvas draws a box and picks every card it touches,
  // so a whole workflow can be gathered for Group without clicking each node.
  // A plain left-drag still pans: selection is the modifier gesture, the view
  // stays the default one.

  function marqueeRect(m) {
    return {
      left: Math.min(m.x0, m.x1), top: Math.min(m.y0, m.y1),
      right: Math.max(m.x0, m.x1), bottom: Math.max(m.y0, m.y1),
    };
  }
  function drawMarquee(m) {
    if (!marqueeEl) return;
    const r = marqueeRect(m);
    marqueeEl.style.left = `${r.left}px`;
    marqueeEl.style.top = `${r.top}px`;
    marqueeEl.style.width = `${Math.max(0, r.right - r.left)}px`;
    marqueeEl.style.height = `${Math.max(0, r.bottom - r.top)}px`;
  }
  function startMarquee(e) {
    if (!marqueeEl) return;
    e.preventDefault();
    measureBoxes(); // the hit test at drop uses these boxes
    const p = canvasPoint(e.clientX, e.clientY);
    marquee = {
      x0: p.x, y0: p.y, x1: p.x, y1: p.y, moved: false,
      // Shift picks *more*; the other modifiers start a fresh selection.
      base: e.shiftKey ? new Set(groupSel) : new Set(),
    };
    marqueeEl.hidden = false;
    drawMarquee(marquee);
    document.addEventListener("mousemove", onMarqueeMove);
    document.addEventListener("mouseup", onMarqueeUp);
  }
  function onMarqueeMove(e) {
    if (!marquee) return;
    const p = canvasPoint(e.clientX, e.clientY);
    marquee.x1 = p.x; marquee.y1 = p.y;
    if (Math.abs(p.x - marquee.x0) + Math.abs(p.y - marquee.y0) > 3) marquee.moved = true;
    drawMarquee(marquee);
  }
  function onMarqueeUp() {
    document.removeEventListener("mousemove", onMarqueeMove);
    document.removeEventListener("mouseup", onMarqueeUp);
    const m = marquee;
    marquee = null;
    if (marqueeEl) marqueeEl.hidden = true;
    if (!m || !m.moved) return;
    measureBoxes();
    const r = marqueeRect(m);
    const folded = foldedNodeIds();
    const hits = nodes().filter((n) => {
      if (folded.has(n.id)) return false;
      const b = boxCache.get(n.id);
      return !!b && b.x < r.right && b.x + b.w > r.left && b.y < r.bottom && b.y + b.h > r.top;
    });
    groupSel = new Set([...m.base, ...hits.map((n) => n.id)]);
    if (hits.length) selected = { kind: "node", id: hits[hits.length - 1].id };
    else if (!m.base.size) selected = null;
    renderNodes();
    selectionChanged();
    if (dirty) paint();
  }

  // ─── Group interactions ───────────────────────────────────────────────────

  /** Group the picked nodes (Shift-click or Shift-drag picks several), or drop
   *  an empty frame where the view is looking when nothing is picked. */
  async function addGroup() {
    const ids = [...groupSel];
    if (selected?.kind === "node" && !ids.includes(selected.id) && nodeById(selected.id)) ids.push(selected.id);
    const payload = { nodeIds: ids };
    if (!ids.length) {
      payload.x = Math.round((canvasScrollEl?.scrollLeft || 0) / zoom + 80);
      payload.y = Math.round((canvasScrollEl?.scrollTop || 0) / zoom + 80);
    }
    await run_(() => post("addGroup", payload), ids.length ? `Grouped ${ids.length} node${ids.length === 1 ? "" : "s"}` : "Group added");
    groupSel = new Set();
    if (pane) renderNodes();
  }

  /** Lock or unlock a frame's manual resize handles. The stored box (if any)
   *  stays put — this only controls whether the user can drag its edges. */
  async function toggleGroupResizable(id) {
    const g = groupById(id);
    if (!g) return;
    const resizable = g.resizable === false;
    await run_(() => post("updateGroup", { id, resizable }),
      resizable ? "Group resizing enabled" : "Group resizing locked");
  }

  async function toggleGroupFold(id) {
    const g = groupById(id);
    if (!g) return;
    // Folding hides the members, so a focused node inside is no longer on the
    // canvas: let it go rather than leave the sidebar reading a hidden card.
    if (!g.collapsed && selected?.kind === "node" && (g.nodeIds || []).includes(selected.id)) {
      selected = null; groupSel = new Set(); selectionChanged();
    }
    await run_(() => post("updateGroup", { id, collapsed: !g.collapsed }),
      g.collapsed ? "Group unfolded" : "Group folded");
  }

  async function renameGroup(id, raw) {
    const g = groupById(id);
    if (!g) return;
    const name = String(raw || "").trim().slice(0, 60);
    if (!name || name === g.name) return;
    await run_(() => post("updateGroup", { id, name }), "Group renamed");
  }

  async function ungroup(id) {
    await run_(() => post("removeGroup", { id }), "Group removed — nodes kept");
  }

  function startGroupDrag(head, e) {
    const id = head.dataset.groupDrag;
    const g = groupById(id);
    if (!g) return;
    e.preventDefault();
    const members = (g.nodeIds || []).map(nodeById).filter(Boolean);
    groupDrag = {
      id, el: head.closest(".sw-group"), g,
      sx: e.clientX, sy: e.clientY, px: e.clientX, py: e.clientY,
      moved: false, dx: 0, dy: 0,
      x: g.x, y: g.y,
      members: members.map((n) => ({
        id: n.id, x: n.x, y: n.y,
        el: nodesEl.querySelector(`.sw-node[data-id="${CSS.escape(n.id)}"]`),
      })),
      edges: edges().filter((ed) => (g.nodeIds || []).includes(ed.from) || (g.nodeIds || []).includes(ed.to)),
    };
    document.addEventListener("mousemove", onGroupDragMove);
    document.addEventListener("mouseup", onGroupDragUp);
  }

  /** Move every member and the frame together, at most once per frame. */
  function applyGroupDrag() {
    if (!groupDrag) return;
    const dx = (groupDrag.px - groupDrag.sx) / zoom, dy = (groupDrag.py - groupDrag.sy) / zoom;
    groupDrag.dx = Math.round(dx); groupDrag.dy = Math.round(dy);
    for (const m of groupDrag.members) {
      const nx = Math.max(0, Math.round(m.x + dx)), ny = Math.max(0, Math.round(m.y + dy));
      const n = nodeById(m.id);
      if (n) { n.x = nx; n.y = ny; }
      if (m.el) { m.el.style.left = `${nx}px`; m.el.style.top = `${ny}px`; }
      const b = boxCache.get(m.id);
      if (b) { b.x = nx; b.y = ny; }
    }
    // The frame follows its members (or, folded, its own stored chip position).
    const g = groupDrag.g;
    g.x = Math.max(0, Math.round(groupDrag.x + dx));
    g.y = Math.max(0, Math.round(groupDrag.y + dy));
    placeGroup(g);
    layoutEdges(groupDrag.edges, false);
  }
  function onGroupDragMove(e) {
    if (!groupDrag) return;
    groupDrag.px = e.clientX; groupDrag.py = e.clientY;
    if (Math.abs(e.clientX - groupDrag.sx) + Math.abs(e.clientY - groupDrag.sy) > 3) groupDrag.moved = true;
    onFrame(applyGroupDrag);
  }
  function onGroupDragUp() {
    document.removeEventListener("mousemove", onGroupDragMove);
    document.removeEventListener("mouseup", onGroupDragUp);
    const d = groupDrag;
    if (!d) return;
    applyGroupDrag(); // flush the last pointer position before committing
    groupDrag = null;
    if (d.moved) run_(() => post("moveGroup", { id: d.id, dx: d.dx, dy: d.dy }));
    else if (dirty) paint();
  }

  // ─── Resizing a group frame ───────────────────────────────────────────────
  //
  // The eight handles set the frame's own box. The frame may grow freely, but
  // never shrinks past the cards it holds: a group is a container, and dragging
  // an edge should not leave a member outside it. The manual box is persisted
  // with the group; without one the frame stays measured from its members.

  /** The tightest box that still contains every member (the shrink limit). */
  function groupResizeLimits(g) {
    const members = (g.nodeIds || []).map(nodeById).filter(Boolean);
    if (!members.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of members) {
      const b = boxCache.get(n.id) || { x: n.x, y: n.y, w: NODE_W, h: 120 };
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
    }
    return {
      left: Math.max(0, minX - GROUP_PAD),
      top: Math.max(0, minY - GROUP_HEAD),
      right: Math.min(CANVAS_LIMIT, maxX + GROUP_PAD),
      bottom: Math.min(CANVAS_LIMIT, maxY + GROUP_PAD),
    };
  }

  /** Which part of a frame's box a pointer is on, if any: `n`, `se`, … */
  function groupEdgeDir(rect, cx, cy, pad = 10) {
    const left = cx - rect.left <= pad, right = rect.right - cx <= pad;
    const top = cy - rect.top <= pad, bottom = rect.bottom - cy <= pad;
    if (!left && !right && !top && !bottom) return null;
    return `${top ? "n" : bottom ? "s" : ""}${left ? "w" : right ? "e" : ""}` || null;
  }

  function startGroupResize(id, dir, e) {
    const g = groupById(id);
    if (!g || g.collapsed || g.resizable === false) return;
    e.preventDefault();
    measureBoxes();
    groupResize = {
      id, g, dir: dir || "se",
      sx: e.clientX, sy: e.clientY, px: e.clientX, py: e.clientY, moved: false,
      box: groupBox(g),
      limits: groupResizeLimits(g),
    };
    for (const el of groupsEl?.children || []) el.classList.remove("drop-target");
    document.addEventListener("mousemove", onGroupResizeMove);
    document.addEventListener("mouseup", onGroupResizeUp);
  }

  function applyGroupResize() {
    if (!groupResize) return;
    const r = groupResize;
    const dx = (r.px - r.sx) / zoom, dy = (r.py - r.sy) / zoom;
    if (Math.abs(r.px - r.sx) + Math.abs(r.py - r.sy) > 3) r.moved = true;
    let left = r.box.x, right = r.box.x + r.box.w;
    let top = r.box.y, bottom = r.box.y + r.box.h;
    if (r.dir.includes("w")) left += dx;
    if (r.dir.includes("e")) right += dx;
    if (r.dir.includes("n")) top += dy;
    if (r.dir.includes("s")) bottom += dy;
    if (r.limits) {
      // Clamp only the dragged edges: the opposite side is fixed, and the
      // content limit is what stops a shrink before it would cut a card off.
      if (r.dir.includes("w")) left = Math.max(0, Math.min(left, r.limits.left));
      if (r.dir.includes("e")) right = Math.min(CANVAS_LIMIT, Math.max(right, r.limits.right));
      if (r.dir.includes("n")) top = Math.max(0, Math.min(top, r.limits.top));
      if (r.dir.includes("s")) bottom = Math.min(CANVAS_LIMIT, Math.max(bottom, r.limits.bottom));
    }
    // A minimum readable frame, even when the group is empty.
    if (right - left < GROUP_MIN_W) {
      if (r.dir.includes("w")) left = right - GROUP_MIN_W;
      else right = left + GROUP_MIN_W;
    }
    if (bottom - top < GROUP_MIN_H) {
      if (r.dir.includes("n")) top = bottom - GROUP_MIN_H;
      else bottom = top + GROUP_MIN_H;
    }
    r.g.x = Math.round(Math.max(0, left));
    r.g.y = Math.round(Math.max(0, top));
    r.g.w = Math.round(Math.min(CANVAS_LIMIT, right) - r.g.x);
    r.g.h = Math.round(Math.min(CANVAS_LIMIT, bottom) - r.g.y);
    placeGroup(r.g);
  }

  function onGroupResizeMove(e) {
    if (!groupResize) return;
    groupResize.px = e.clientX; groupResize.py = e.clientY;
    onFrame(applyGroupResize);
  }
  function onGroupResizeUp() {
    document.removeEventListener("mousemove", onGroupResizeMove);
    document.removeEventListener("mouseup", onGroupResizeUp);
    const r = groupResize;
    if (!r) return;
    applyGroupResize();
    groupResize = null;
    if (r.moved) {
      run_(() => post("updateGroup", { id: r.id, x: r.g.x, y: r.g.y, w: r.g.w, h: r.g.h }), "Group resized");
    } else if (dirty) paint();
  }

  // ─── Run bar + log ────────────────────────────────────────────────────────

  function renderRun() {
    const shown = viewRun();
    const live = run;
    const status = shown?.status || "idle";
    // A gate only ever holds the *live* run; a past run is read-only.
    const waiting = !historyRun && live?.status === "running" ? waitingNodes() : [];
    if (runBtn) {
      // One button, two jobs: it starts a workflow and, while that workflow is
      // live, becomes the stop control. A past run never changes it — only the
      // live run can be running.
      const running = live?.status === "running";
      runBtn.textContent = running ? "■ Stop" : "▶ Run";
      runBtn.title = running ? "Stop the running workflow" : "Run this workflow";
      runBtn.setAttribute("aria-label", running ? "Stop workflow" : "Run workflow");
      runBtn.classList.toggle("sw-danger", running);
      runBtn.classList.toggle("sw-primary", !running);
    }
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
    renderMessages();
    // Rewrite the log only when it changed, so the panel does not flicker.
    if (runLogEl) {
      const entries = historyRun ? (historyRun.log || []) : logBuffer;
      const sig = `${historyRun ? historyRun.id : "live"}:${entries.length}:${entries[entries.length - 1]?.seq || 0}`;
      if (sig !== logSig) {
        logSig = sig;
        runLogEl.innerHTML = entries.length
          ? entries.map((l) => {
              const name = l.nodeId ? (nodeById(l.nodeId)?.name || "node") : "run";
              const rep = l.repeat > 1 ? ` <span class="sw-log-repeat">×${l.repeat}</span>` : "";
              return `<div class="sw-log-line sw-log-${escAttr(l.stream)}">` +
                `<span class="sw-log-node">${esc(name)}</span>` +
                `<span class="sw-log-text">${esc(l.text)}${rep}</span></div>`;
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

  // ─── Messages sidebar ─────────────────────────────────────────────────────
  //
  // What each agent actually said, beside the canvas. With nothing selected it
  // lists every agent in its own section; clicking an agent's card — or its
  // section — focuses it on that one agent's messages. A human gate carries its
  // Approve / Reject buttons — the only place a gate is decided — with what each
  // of its input nodes produced in a section of its own (a node's *final*
  // result, never an intermediate pass), and the end node shows every agent
  // wired into it the same way, one section per agent. It is a reading surface
  // only: a node's settings stay in their own popup.

  let msgSideEl = null, msgBodyEl = null, msgTitleEl = null, msgSubEl = null, msgSig = "";
  /** How many of one agent's lines a section shows (the newest ones). */
  const MSG_LINES_MAX = 60;

  /** The log lines the sidebar reads: the live run's buffer, or a reopened
   *  run's stored log. */
  function logEntries() { return historyRun ? (historyRun.log || []) : logBuffer; }

  /** Every line one node produced, in order. */
  function messagesFor(nodeId) {
    const out = [];
    for (const l of logEntries()) if (l.nodeId === nodeId) out.push(l);
    return out;
  }

  /**
   * The lines an agent actually *said*: its own words, not the harness's banner,
   * tool calls or progress chatter. Every harness writes its answer to stdout —
   * opencode puts `> build · model` and its `◈` / `%` tool rows on stderr, and
   * the Pi runner logs each text delta as stdout while a tool start is `tool` —
   * so the sidebar reads stdout alone. The run log keeps everything else, which
   * is where a harness's chatter stays available.
   */
  function assistantLinesFor(nodeId) {
    return messagesFor(nodeId).filter((l) => l.stream === "stdout" && String(l.text || "").trim());
  }

  /**
   * What a node produced, as text: the run's own output tail when the server
   * kept one, otherwise the lines it said joined — so the same agent reads the
   * same way whether the run is live or reopened, and never as a harness's
   * status stream.
   */
  function nodeOutputText(id) {
    const tail = runNode(id)?.outputTail;
    if (typeof tail === "string" && tail.trim()) return tail;
    return assistantLinesFor(id).map((l) => l.text).join("\n");
  }

  /** The agents wired straight into a node — who fed it. */
  function inputAgentsOf(nodeId) {
    const seen = new Set();
    const out = [];
    for (const e of edges()) {
      if (e.to !== nodeId) continue;
      const n = nodeById(e.from);
      if (!n || n.type !== "agent" || seen.has(n.id)) continue;
      seen.add(n.id);
      out.push(n);
    }
    return out;
  }

  /**
   * Every node wired straight into `nodeId`, whatever its kind. A gate is fed by
   * an agent or by a **loop's Exit** — and in both cases what the gate reviews is
   * that node's *final result*, so the input list must not skip a loop just
   * because it is not an agent.
   */
  function inputNodesOf(nodeId) {
    const seen = new Set();
    const out = [];
    for (const e of edges()) {
      if (e.to !== nodeId) continue;
      const n = nodeById(e.from);
      if (!n || n.type === "start" || seen.has(n.id)) continue;
      seen.add(n.id);
      out.push(n);
    }
    return out;
  }

  /** A node's **final result** — the output the server kept for it — never the
   *  stream it passed through on the way (that is the node's own section). */
  function nodeFinalText(id) {
    const tail = runNode(id)?.outputTail;
    return typeof tail === "string" ? tail.trim() : "";
  }

  /** The status badge a node wears on the canvas, repeated in the sidebar. */
  function statusPill(nodeId) {
    const rs = runNode(nodeId);
    if (!rs?.status) return "";
    const what = rs.bypassed ? "bypassed" : rs.status;
    return `<span class="sw-badge sw-b-${escAttr(rs.status)}" title="${escAttr(what)}">${badgeGlyph(rs.status, rs.bypassed)}</span>`;
  }

  /** One line an agent sent, in the run-log's own ink. */
  function msgLineHtml(l) {
    const kind = l.stream === "stderr" ? "stderr" : l.stream === "status" ? "status" : "stdout";
    const t = l.ts ? new Date(l.ts).toLocaleTimeString([], { hour12: false }) : "";
    // One row can stand for a status line the harness repainted several times:
    // the count says so without repeating the line.
    const rep = l.repeat > 1 ? `<span class="sw-msg-repeat">×${l.repeat}</span>` : "";
    return `<div class="sw-msg-line sw-msg-${kind}">` +
      (t ? `<span class="sw-msg-time">${esc(t)}</span>` : "") +
      `<span class="sw-msg-text">${esc(l.text)}</span>${rep}</div>`;
  }

  /** The user message a node was handed, ahead of its own words. */
  function promptHtml(n) {
    const p = String(n.config?.prompt || "").trim();
    if (!p) return "";
    return `<div class="sw-msg-sent"><span class="sw-msg-sent-tag">sent</span><pre>${esc(p)}</pre></div>`;
  }

  /**
   * One agent's section: its mark, its name, and what it streamed. `opts.prompt`
   * adds the message it was handed, so a focused agent reads as a conversation
   * — what it was asked, then what it said.
   */
  function agentSectionHtml(n, opts) {
    const o = opts || {};
    // Only what the agent said: the harness's banner, tool calls and status
    // chatter belong to the run log, not to this conversation.
    const msgs = assistantLinesFor(n.id);
    const shown = msgs.length > MSG_LINES_MAX ? msgs.slice(-MSG_LINES_MAX) : msgs;
    const more = msgs.length - shown.length;
    let body;
    if (shown.length) {
      body = (more ? `<div class="sw-msg-more">… ${more} earlier line${more === 1 ? "" : "s"}</div>` : "") +
        shown.map(msgLineHtml).join("");
    } else {
      const out = nodeOutputText(n.id);
      const rs = runNode(n.id);
      const st = rs?.status;
      body = out ? `<pre class="sw-msg-pre">${esc(out)}</pre>`
        : st === "error" ? `<div class="sw-msg-none">Nothing captured — ${esc(rs?.error || "the run failed")}.</div>`
        : st ? `<div class="sw-msg-none">No message — the harness wrote only status lines. The run log has them.</div>`
        : `<div class="sw-msg-none">Nothing from this agent yet.</div>`;
    }
    return `<div class="sw-msg-section" data-node="${escAttr(n.id)}" title="Focus ${escAttr(n.name)}">` +
        `<div class="sw-msg-sec-head">` +
          harnessIcon(n.config?.harness, providerLabel(n.config?.harness)) +
          `<span class="sw-msg-sec-name">${esc(n.name)}</span>` +
          `<span class="sw-msg-sec-tag">${esc(n.config?.model || providerLabel(n.config?.harness))}</span>` +
          statusPill(n.id) +
        `</div>` +
        (o.prompt ? promptHtml(n) : "") +
        `<div class="sw-msg-lines">${body}</div>` +
      `</div>`;
  }

  /**
   * What one agent produced, as a section keyed to it. This is the shape an
   * approval gate and the end node read their input in: one section per agent,
   * never a single undifferentiated blob.
   */
  function agentOutputHtml(n) {
    const out = nodeOutputText(n.id);
    return `<div class="sw-msg-section sw-msg-input" data-input="${escAttr(n.id)}">` +
        `<div class="sw-msg-sec-head">` +
          harnessIcon(n.config?.harness, providerLabel(n.config?.harness)) +
          `<span class="sw-msg-sec-name">${esc(n.name)}</span>` +
          `<span class="sw-msg-sec-tag">input agent</span>` +
          statusPill(n.id) +
        `</div>` +
        (out ? `<pre class="sw-msg-pre">${esc(out)}</pre>`
             : `<div class="sw-msg-none">Nothing from ${esc(n.name)} yet.</div>`) +
      `</div>`;
  }

  /**
   * What an approval gate reads from one node wired into it: the message an
   * agent was handed, then its **final result** — the two things a review needs,
   * and nothing of the stream in between (that is the node's own section). A
   * loop wired in shows the finished loop (its last pass), which is what the
   * gate's `{input}` is too, so the reviewer reads exactly what will be approved.
   */
  function inputBriefHtml(n) {
    const out = nodeFinalText(n.id);
    const st = runNode(n.id)?.status;
    const icon = n.type === "agent"
      ? harnessIcon(n.config?.harness, providerLabel(n.config?.harness))
      : `<span class="sw-node-glyph">${nodeGlyph(n.type)}</span>`;
    const tag = n.type === "agent" ? "input agent" : `input ${n.type}`;
    return `<div class="sw-msg-section sw-msg-input" data-input="${escAttr(n.id)}">` +
        `<div class="sw-msg-sec-head">` + icon +
          `<span class="sw-msg-sec-name">${esc(n.name)}</span>` +
          `<span class="sw-msg-sec-tag">${esc(tag)}</span>` +
          statusPill(n.id) +
        `</div>` +
        (n.type === "agent" ? promptHtml(n) : "") +
        `<div class="sw-msg-group">Final result</div>` +
        (out ? `<pre class="sw-msg-pre">${esc(out)}</pre>`
             : `<div class="sw-msg-none">${st ? `Nothing captured — ${esc(st)}.` : "Nothing from this node yet."}</div>`) +
      `</div>`;
  }

  /**
   * A human gate's card: the message the reviewer is asked to read, what its
   * input nodes produced (wired in below it by the caller), and — while the
   * gate is the one holding the run — the note box and the two buttons. This is
   * the single place a gate is decided.
   */
  function gateCardHtml(n, waiting) {
    const rs = runNode(n.id);
    // The message the reviewer read while the gate waited, kept after the
    // decision (`decision.message` is the rendered text, so an approved gate
    // still shows what was reviewed instead of the raw `{input}` template).
    const msg = rs?.approval?.message || rs?.decision?.message || n.config?.message || n.config?.description || "";
    const d = rs?.decision;
    return `<div class="sw-msg-gate${waiting ? " waiting" : ""}" data-gate="${escAttr(n.id)}" title="Focus ${escAttr(n.name)}">` +
        `<div class="sw-msg-gate-head">` +
          `<span class="sw-approval-glyph">✋</span>` +
          `<span class="sw-msg-gate-name">${esc(n.name)}</span>` +
          (waiting ? `<span class="sw-msg-gate-tag">needs a decision</span>` : statusPill(n.id)) +
        `</div>` +
        (msg ? `<pre class="sw-msg-gate-msg">${esc(msg)}</pre>` : `<div class="sw-msg-none">This gate has no message.</div>`) +
        (waiting
          ? `<div class="sw-msg-gate-actions">` +
              `<input class="set-input sw-msg-note" placeholder="Optional note for the run log…" aria-label="Approval note">` +
              `<button class="btn-sm sw-primary" data-approve="${escAttr(n.id)}" type="button">✓ Approve</button>` +
              `<button class="btn-sm sw-danger" data-reject="${escAttr(n.id)}" type="button">✕ Reject</button>` +
            `</div>`
          : d ? `<div class="sw-msg-gate-tag">${d.approve ? "✓ approved" : "✖ rejected"}${d.note ? ` — ${esc(d.note)}` : ""}</div>` : "") +
      `</div>`;
  }

  /**
   * The end node's answer, split into a section per agent wired into it, then
   * the joined output those sections add up to.
   */
  function endOutputHtml(end) {
    const inputs = inputAgentsOf(end.id);
    const joined = nodeOutputText(end.id).trim();
    return `<div class="sw-msg-section sw-msg-final" data-node="${escAttr(end.id)}" title="Focus ${escAttr(end.name)}">` +
        `<div class="sw-msg-sec-head"><span class="sw-node-glyph">■</span>` +
          `<span class="sw-msg-sec-name">${esc(end.name)}</span>` +
          `<span class="sw-msg-sec-tag">final output</span>` +
          statusPill(end.id) +
        `</div>` +
        (inputs.length
          ? inputs.map(agentOutputHtml).join("")
          : `<div class="sw-msg-none">Wire an agent into this node and what it produces lands here.</div>`) +
        `<div class="sw-msg-group">Joined output</div>` +
        `<pre class="sw-msg-pre">${esc(joined || "—")}</pre>` +
      `</div>`;
  }

  /** The sidebar with one node in focus: exactly what that node is about. */
  function focusedHtml(n, waiting) {
    if (n.type === "agent") {
      const err = runNode(n.id)?.error;
      return agentSectionHtml(n, { prompt: true }) + (err ? `<div class="sw-msg-err">${esc(err)}</div>` : "");
    }
    if (n.type === "approval") {
      const inputs = inputNodesOf(n.id);
      return gateCardHtml(n, waiting.includes(n.id)) +
        `<div class="sw-msg-group">Input from</div>` +
        (inputs.length ? inputs.map(inputBriefHtml).join("")
                       : `<div class="sw-msg-none">Nothing is wired into this gate.</div>`);
    }
    if (n.type === "end") return endOutputHtml(n);
    // This start's own task when the run being read came from it; otherwise the
    // task it would use, so a sibling workflow's run is never shown here as this
    // entry point's material.
    const shown = viewRun()?.startId === n.id ? viewRun()?.task : (n.config?.defaultTask || viewRun()?.task);
    return `<div class="sw-msg-section">` +
        `<div class="sw-msg-sec-head"><span class="sw-node-glyph">▶</span>` +
          `<span class="sw-msg-sec-name">${esc(n.name)}</span>` +
          `<span class="sw-msg-sec-tag">start</span></div>` +
        `<pre class="sw-msg-pre">${esc(shown || "—")}</pre></div>`;
  }

  /** The sidebar with nothing in focus: every agent, then any gate, then the end. */
  function allMessagesHtml(waiting) {
    const parts = [];
    const agents = nodes().filter((n) => n.type === "agent");
    if (!agents.length) parts.push(`<div class="sw-msg-none">Add an agent node — every message it sends shows up here.</div>`);
    for (const n of agents) parts.push(agentSectionHtml(n));
    for (const g of nodes().filter((n) => n.type === "approval")) {
      // A waiting gate (or one that has been decided) gets a card — wrapped in a
      // section so that clicking it focuses the gate, exactly like an agent.
      // Under it, each agent wired in reads as a brief: the message it was handed
      // and its final result, never its raw stream (the agent has a section of
      // its own above for that).
      if (waiting.includes(g.id) || runNode(g.id)?.decision) {
        const inputs = inputNodesOf(g.id);
        parts.push(`<div class="sw-msg-section sw-msg-gate-wrap" data-node="${escAttr(g.id)}" ` +
          `title="Focus ${escAttr(g.name)}">${gateCardHtml(g, waiting.includes(g.id))}` +
          `${inputs.map(inputBriefHtml).join("")}</div>`);
      }
    }
    const end = nodes().find((n) => n.type === "end");
    if (end) parts.push(endOutputHtml(end));
    return parts.join("");
  }

  /** The node the messages sidebar is showing, or null while none is selected. */
  function focusedNode() {
    return selected && selected.kind === "node" ? nodeById(selected.id) : null;
  }

  /**
   * The sidebar is a node's own context, not a feed for the whole canvas: it is
   * shown only while a node is selected (clicking an edge or the empty canvas
   * folds it away again).
   */
  function syncMessagesVisibility() {
    const main = msgSideEl?.closest(".sw-main") || pane?.querySelector(".sw-main");
    const focus = focusedNode();
    main?.classList.toggle("no-focus", !focus);
    msgSideEl?.classList.toggle("has-focus", !!focus);
    if (!focus && msgBodyEl && msgBodyEl.innerHTML) msgBodyEl.innerHTML = "";
  }

  /**
   * Repaint the sidebar for the selected node. Rebuilt only when the reading
   * really changed (a new line, a new focus, a gate that started or stopped
   * waiting), so a live tick never churns it — and a note typed into a gate card
   * is carried over. With nothing selected there is nothing to show.
   */
  function renderMessages() {
    if (!msgBodyEl || !msgTitleEl) return;
    syncMessagesVisibility();
    const focus = focusedNode();
    if (!focus) {
      msgSig = "";
      msgTitleEl.textContent = "Messages";
      if (msgSubEl) msgSubEl.textContent = "click a node to see its messages";
      return;
    }
    const waiting = !historyRun && run?.status === "running" ? waitingNodes().map((n) => n.id) : [];
    const entries = logEntries();
    const last = entries.length ? entries[entries.length - 1].seq : 0;
    const sig = `${historyRun ? historyRun.id : "live"}|${focus.id}|${entries.length}|${last}|${waiting.join(",")}`;
    if (sig === msgSig) return;
    msgSig = sig;
    const notes = new Map();
    for (const card of msgBodyEl.querySelectorAll(".sw-msg-gate")) {
      notes.set(card.dataset.gate, card.querySelector(".sw-msg-note")?.value ?? "");
    }
    msgTitleEl.textContent = focus.name;
    msgSubEl.textContent = `${focus.type === "agent" ? providerLabel(focus.config?.harness) : focus.type} · messages`;
    msgBodyEl.innerHTML = focusedHtml(focus, waiting);
    for (const card of msgBodyEl.querySelectorAll(".sw-msg-gate")) {
      const note = notes.get(card.dataset.gate);
      const box = card.querySelector(".sw-msg-note");
      if (note && box) box.value = note;
    }
  }

  /** The selection moved: repaint the canvas highlights and the sidebar. */
  function selectionChanged() {
    msgSig = "";
    renderMessages();
  }

  /**
   * The drag handle between the canvas and the messages sidebar. It grows the
   * sidebar as it is dragged LEFT (the sidebar sits on the right), remembers the
   * chosen width per browser, and keeps the user's intent while clamping the
   * shown width to 75% of the viewport as the window shrinks. Keyboard: ←/→
   * nudge (Shift for a bigger step), Home/Delete — or a double-click — restore
   * the default. Mirrors the Git view's commit-box resizer.
   */
  function initMsgSideResizer(mainEl, sideEl, handle) {
    if (!mainEl || !sideEl || !handle) return;
    const MIN = 240, KEY = "scope-sw-msg-width";
    let desired = null; // preferred sidebar width in px (kept unclamped)
    const maxWidth = () => Math.max(MIN, Math.round(window.innerWidth * 0.75));

    function render() {
      if (desired == null) {
        sideEl.style.width = "";
        handle.removeAttribute("aria-valuenow");
        return;
      }
      const shown = Math.min(maxWidth(), Math.max(MIN, desired));
      sideEl.style.width = shown + "px";
      handle.setAttribute("aria-valuemin", String(MIN));
      handle.setAttribute("aria-valuemax", String(maxWidth()));
      handle.setAttribute("aria-valuenow", String(shown));
    }

    function set(w, persist) {
      desired = Math.max(MIN, Math.round(w));
      render();
      if (persist) { try { localStorage.setItem(KEY, desired); } catch { /* private mode */ } }
    }

    function reset() {
      desired = null;
      render();
      try { localStorage.removeItem(KEY); } catch { /* private mode */ }
    }

    try {
      const saved = parseInt(localStorage.getItem(KEY), 10);
      if (saved >= MIN) { desired = saved; render(); }
    } catch { /* private mode */ }

    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = desired ?? sideEl.getBoundingClientRect().width;
      handle.classList.add("dragging");
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";

      const onMove = (ev) => set(startW + (startX - ev.clientX), false);
      const onUp = () => {
        handle.classList.remove("dragging");
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        if (desired != null) {
          try { localStorage.setItem(KEY, Math.round(sideEl.getBoundingClientRect().width)); } catch { /* private mode */ }
        }
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    handle.addEventListener("dblclick", reset);

    handle.addEventListener("keydown", (e) => {
      const cur = desired ?? sideEl.getBoundingClientRect().width;
      const step = e.shiftKey ? 40 : 12;
      if (e.key === "ArrowLeft") { e.preventDefault(); set(cur + step, true); }
      else if (e.key === "ArrowRight") { e.preventDefault(); set(cur - step, true); }
      else if (e.key === "Home" || e.key === "Delete") { e.preventDefault(); reset(); }
    });

    // Keep the sidebar in the viewport when it shrinks (the intent is preserved).
    window.addEventListener("resize", () => { if (desired != null) render(); });
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
   * The ↻ button: re-read the workflow from the server and rebuild the canvas
   * from it — the nodes, and every connection re-routed between them. Resetting
   * the canvas state first is what guarantees a rewire: the routed-edge elements
   * are dropped so `layoutEdges` redraws each connection against the reloaded
   * boxes instead of leaving a stale path behind.
   */
  function reloadWorkflow() {
    resetCanvasState();
    refresh();
    loadHarnesses();
  }

  async function decideApproval(card, nodeId, approve) {
    // A gate is decided from its card in the messages sidebar (there is no
    // separate banner any more), so the note box there is the one that answers.
    const note = card?.querySelector(".sw-msg-note")?.value ?? "";
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
    // There is no run-level task box: each node carries its own message, and the
    // run's task is the selected start node's default task. With several start
    // nodes on one canvas, selecting one and pressing ▶ Run is how that entry
    // point is run on its own; with none selected the server uses the first.
    const sel = focusedNode();
    const startId = sel?.type === "start" ? sel.id : undefined;
    try {
      const data = await postRun("start", startId ? { startId } : {});
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
          `<button class="btn-sm" id="sw-add-loop" type="button" title="Add a loop node — wire its repeat output back to a step to refine it">+ Loop</button>` +
          `<button class="btn-sm" id="sw-add-start" type="button" title="Add a start node — each start is its own entry point with its own triggers">+ Start</button>` +
          `<button class="btn-sm" id="sw-add-end" type="button" title="Add an end node — each end reports its own branch's final output">+ End</button>` +
          `<button class="btn-sm" id="sw-add-group" type="button" title="Group the selected nodes — Shift-click or Shift-drag to pick several, or click with nothing selected for an empty group">▣ Group</button>` +
          `<button class="btn-sm" id="sw-export" type="button" title="Download this workflow as JSON">⬇ Export</button>` +
          `<button class="btn-sm" id="sw-import" type="button" title="Load a workflow JSON file">⬆ Import</button>` +
          `<input type="file" id="sw-import-file" accept="application/json,.json" style="display:none">` +
          `<button class="btn-sm" id="sw-refresh" type="button" title="Reload the workflow">↻</button>` +
        `</div>` +
      `</div>` +
      `<div class="sw-runbar">` +
        `<button class="btn-sm sw-primary sw-run-btn" id="sw-run" type="button" ` +
          `title="Run this workflow" aria-label="Run workflow">▶ Run</button>` +
        `<span class="sw-run-status" id="sw-run-status"></span>` +
      `</div>` +
      `<div class="sw-body">` +
        `<div class="sw-main no-focus">` +
          `<div class="sw-canvas-scroll">` +
            `<div class="sw-canvas" id="sw-canvas">` +
              `<svg class="sw-edges" xmlns="http://www.w3.org/2000/svg" width="1000" height="700">` +
                `<g id="sw-edge-paths"></g><path id="sw-tmp" class="sw-tmp" style="display:none"></path></svg>` +
              `<div class="sw-groups" id="sw-groups"></div>` +
              `<div class="sw-nodes" id="sw-nodes"></div>` +
              `<div class="sw-group-handles" id="sw-group-handles"></div>` +
              `<div class="sw-edge-btns" id="sw-edge-btns"></div>` +
              `<div class="sw-marquee" id="sw-marquee" hidden></div>` +
            `</div>` +
          `</div>` +
          // Zoom controls for the canvas: a floating cluster at the canvas's
          // bottom-left, outside the scroller so it never scrolls away.
          `<div class="sw-zoom" id="sw-zoom" role="group" aria-label="Canvas zoom">` +
            `<button class="btn-sm sw-zoom-btn" id="sw-zoom-out" type="button" title="Zoom out (−)" aria-label="Zoom out">−</button>` +
            `<button class="btn-sm sw-zoom-pct" id="sw-zoom-pct" type="button" title="Reset the zoom to 100% (0)">100%</button>` +
            `<button class="btn-sm sw-zoom-btn" id="sw-zoom-in" type="button" title="Zoom in (+)" aria-label="Zoom in">+</button>` +
            `<button class="btn-sm sw-zoom-btn" id="sw-zoom-fit" type="button" title="Fit the whole workflow on screen" aria-label="Fit to screen">⤢</button>` +
          `</div>` +
          // The drag handle that resizes the sidebar (see initMsgSideResizer).
          `<div class="sw-msg-resizer" id="sw-msg-resizer" role="separator" aria-orientation="vertical" ` +
            `tabindex="0" aria-label="Resize the messages sidebar" ` +
            `title="Drag to resize the messages sidebar · double-click to reset"></div>` +
          // What each agent actually said, beside the canvas. Reading, not
          // configuring: a node's settings stay in their own popup.
          `<aside class="sw-msg-side" id="sw-msg-side" aria-label="Agent messages">` +
            `<div class="sw-msg-head">` +
              `<span class="sw-msg-title" id="sw-msg-title">Messages</span>` +
              `<span class="sw-msg-sub" id="sw-msg-sub"></span>` +
              `<button class="btn-sm sw-msg-close" id="sw-msg-close" type="button" title="Close messages and clear the selection">✕</button>` +
            `</div>` +
            `<div class="sw-msg-body" id="sw-msg-body"></div>` +
          `</aside>` +
        `</div>` +
        `<section class="sw-run-panel">` +
          `<div class="sw-run-head"><span class="sw-run-title">Run log</span>` +
            `<select class="set-select sw-history-select" id="sw-history" title="Reopen a past run"><option value="">Latest run</option></select>` +
            `<span class="sw-run-summary" id="sw-run-summary"></span>` +
            `<button class="sw-run-toggle" id="sw-run-toggle" type="button">▾</button></div>` +
          `<div class="sw-run-log" id="sw-run-log"></div>` +
        `</section>` +
      `</div>` +
      // The settings popup: a node's settings, a connection, or the workflow's
      // triggers. Fixed-positioned, so it covers the pane (and the canvas) whole.
      `<div class="sw-modal-backdrop" id="sw-modal-backdrop" hidden>` +
        `<div class="sw-modal" id="sw-modal" role="dialog" aria-modal="true" aria-label="Node settings"></div>` +
      `</div>`;

    nameInput = pane.querySelector("#sw-name");
    statusEl = pane.querySelector("#sw-status");
    runStatusEl = pane.querySelector("#sw-run-status");
    runLogEl = pane.querySelector("#sw-run-log");
    runSummaryEl = pane.querySelector("#sw-run-summary");
    historyEl = pane.querySelector("#sw-history");
    runBtn = pane.querySelector("#sw-run");
    canvasEl = pane.querySelector("#sw-canvas");
    canvasScrollEl = pane.querySelector(".sw-canvas-scroll");
    // The canvas keeps pan room measured from the pane, so a resize has to
    // re-measure it. Changing the canvas's own size does not resize the pane,
    // so this cannot feed itself.
    canvasSizeObs?.disconnect();
    if (typeof ResizeObserver === "function" && canvasScrollEl) {
      canvasSizeObs = new ResizeObserver(() => { canvasW = 0; canvasH = 0; resizeCanvas(); });
      canvasSizeObs.observe(canvasScrollEl);
    }
    nodesEl = pane.querySelector("#sw-nodes");
    groupsEl = pane.querySelector("#sw-groups");
    handlesEl = pane.querySelector("#sw-group-handles");
    marqueeEl = pane.querySelector("#sw-marquee");
    svgEl = pane.querySelector("svg.sw-edges");
    edgePathsEl = pane.querySelector("#sw-edge-paths");
    tmpPathEl = pane.querySelector("#sw-tmp");
    edgeBtnsEl = pane.querySelector("#sw-edge-btns");
    modalEl = pane.querySelector("#sw-modal-backdrop");
    dlgEl = pane.querySelector("#sw-modal");
    msgSideEl = pane.querySelector("#sw-msg-side");
    msgBodyEl = pane.querySelector("#sw-msg-body");
    msgTitleEl = pane.querySelector("#sw-msg-title");
    msgSubEl = pane.querySelector("#sw-msg-sub");

    // The messages sidebar belongs to the selected node: nothing is selected on
    // open, so it stays folded away until a node is clicked. Each workflow on
    // the canvas is then managed in its own context rather than one mixed feed.
    const mainEl = pane.querySelector(".sw-main");
    pane.querySelector("#sw-msg-close").addEventListener("click", () => {
      selected = null;
      groupSel = new Set();
      renderNodes();
      selectionChanged();
    });
    initMsgSideResizer(mainEl, msgSideEl, pane.querySelector("#sw-msg-resizer"));
    initCanvasZoom();
    // Clicks inside the sidebar: the gate's own approve/reject, and focusing an
    // agent by clicking its section (the same as clicking its card).
    msgBodyEl.addEventListener("click", (e) => {
      const ap = e.target.closest?.("[data-approve]");
      if (ap) { e.preventDefault(); decideApproval(ap.closest(".sw-msg-gate"), ap.dataset.approve, true); return; }
      const rj = e.target.closest?.("[data-reject]");
      if (rj) { e.preventDefault(); decideApproval(rj.closest(".sw-msg-gate"), rj.dataset.reject, false); return; }
      const sec = e.target.closest?.(".sw-msg-section[data-node]");
      if (!sec) return;
      selected = { kind: "node", id: sec.dataset.node };
      groupSel = new Set([sec.dataset.node]);
      renderNodes();
      nodesEl.querySelector(`.sw-node[data-id="${CSS.escape(sec.dataset.node)}"]`)
        ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      selectionChanged();
    });

    nameInput.addEventListener("change", () => run_(() => post("setWorkflowName", { name: nameInput.value.trim() || "My Workflow" }), "Renamed"));
    pane.querySelector("#sw-add-agent").addEventListener("click", () => addNode("agent"));
    pane.querySelector("#sw-add-approval").addEventListener("click", () => addNode("approval"));
    pane.querySelector("#sw-add-loop").addEventListener("click", () => addNode("loop"));
    pane.querySelector("#sw-add-start").addEventListener("click", () => addNode("start"));
    pane.querySelector("#sw-add-end").addEventListener("click", () => addNode("end"));
    pane.querySelector("#sw-add-group").addEventListener("click", addGroup);
    pane.querySelector("#sw-export").addEventListener("click", exportWorkflow);
    const importFile = pane.querySelector("#sw-import-file");
    pane.querySelector("#sw-import").addEventListener("click", () => importFile.click());
    importFile.addEventListener("change", importWorkflow);
    pane.querySelector("#sw-refresh").addEventListener("click", reloadWorkflow);
    runBtn.addEventListener("click", () => {
      if (run?.status === "running") void stopRun();
      else void startRun();
    });
    historyEl.addEventListener("change", () => selectHistory(historyEl.value));
    pane.querySelector("#sw-run-toggle").addEventListener("click", (e) => {
      const panel = pane.querySelector(".sw-run-panel");
      const collapsed = panel.classList.toggle("collapsed");
      e.currentTarget.textContent = collapsed ? "▴" : "▾";
    });

    canvasEl.addEventListener("click", (e) => {
      const toggle = e.target.closest?.("[data-group-resizable]");
      if (!toggle) return;
      e.preventDefault(); e.stopPropagation();
      void toggleGroupResizable(toggle.dataset.groupResizable);
    });

    canvasEl.addEventListener("mousedown", (e) => {
      // Middle-button drag pans the view from anywhere, including over a node —
      // but never off a control (a port, the gear, a delete button), which keeps
      // its own click behaviour whatever button was used.
      const onControl = e.target.closest?.(".sw-port-out, .sw-node-del, .sw-node-config, .sw-edge-del, " +
        ".sw-group-fold, .sw-group-remove, .sw-group-resize-toggle, .sw-group-name, .sw-group-handle");
      if (e.button === 1 && !onControl) { startPan(e); return; }
      // Group controls are canvas chrome, not card actions: a click folds the
      // workflow or drops its frame, a drag on the header moves the whole group,
      // and a handle drag sets the frame's own size.
      const resizeHandle = e.target.closest?.("[data-group-resize]");
      if (resizeHandle && e.button === 0) {
        e.preventDefault(); e.stopPropagation();
        startGroupResize(resizeHandle.dataset.groupResize, resizeHandle.dataset.dir, e);
        return;
      }
      const fold = e.target.closest?.("[data-group-fold]");
      if (fold && e.button === 0) { e.preventDefault(); e.stopPropagation(); void toggleGroupFold(fold.dataset.groupFold); return; }
      const resizeToggle = e.target.closest?.("[data-group-resizable]");
      if (resizeToggle && e.button === 0) {
        // The action runs on `click`, so the same button works from the keyboard;
        // this only keeps the header from starting a group drag underneath it.
        e.preventDefault(); e.stopPropagation();
        return;
      }
      const ungroupBtn = e.target.closest?.("[data-group-remove]");
      if (ungroupBtn && e.button === 0) { e.preventDefault(); e.stopPropagation(); void ungroup(ungroupBtn.dataset.groupRemove); return; }
      if (e.target.closest?.("[data-group-name]")) return; // the input edits the name itself
      const gHead = e.target.closest?.("[data-group-drag]");
      if (gHead && e.button === 0) {
        // The top edge of the header is also the frame's north resize edge.
        const gEl = gHead.closest(".sw-group");
        const g = groupById(gEl?.dataset.group);
        const dir = g && !g.collapsed && g.resizable !== false
          ? groupEdgeDir(gEl.getBoundingClientRect(), e.clientX, e.clientY, 8) : null;
        if (dir) { startGroupResize(g.id, dir, e); return; }
        startGroupDrag(gHead, e);
        return;
      }
      const port = e.target.closest?.(".sw-port-out");
      if (port) {
        e.preventDefault(); e.stopPropagation();
        startLink(port.closest(".sw-node").dataset.id, port.dataset.port || "next");
        return;
      }
      const del = e.target.closest?.(".sw-node-del");
      if (del) { e.preventDefault(); e.stopPropagation(); removeNode(del.dataset.del); return; }
      // The gear on a node's card is how its settings are reached — the only
      // way in now that there is no sidebar. Selecting the node first keeps the
      // canvas highlight in step with the popup.
      const gear = e.target.closest?.(".sw-node-config");
      if (gear) {
        e.preventDefault(); e.stopPropagation();
        selected = { kind: "node", id: gear.dataset.config };
        groupSel = new Set([gear.dataset.config]);
        renderNodes();
        selectionChanged();
        openDialog({ kind: "node", id: gear.dataset.config });
        return;
      }
      const edgeDel = e.target.closest?.(".sw-edge-del");
      if (edgeDel) { e.preventDefault(); e.stopPropagation(); removeEdge(edgeDel.dataset.edge); return; }
      const nodeEl = e.target.closest?.(".sw-node");
      if (nodeEl) {
        e.preventDefault();
        const id = nodeEl.dataset.id;
        // Shift/Ctrl/⌘-click picks several nodes for the Group button without
        // changing which node's messages the sidebar is reading.
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
          if (groupSel.has(id)) groupSel.delete(id); else groupSel.add(id);
          if (groupSel.has(id)) selected = { kind: "node", id };
          else if (selected?.kind === "node" && selected.id === id) selected = null;
          renderNodes();
          selectionChanged();
          return;
        }
        // Rebuild the node DOM only when the selection really changed. A
        // rebuild detaches the element the pointer is on, which would leave a
        // double-click (the second way into a node's settings) with no element
        // to bubble from — and it is wasted work on every click.
        if (selected?.kind !== "node" || selected.id !== id || groupSel.size !== 1 || !groupSel.has(id)) {
          selected = { kind: "node", id };
          groupSel = new Set([id]);
          renderNodes();
          // Clicking an agent is how its messages are asked for.
          selectionChanged();
        }
        // If that rebuild did happen, the element this event came from is now
        // detached: a drag writing to it would move nothing on screen while the
        // model (and therefore the edge routing) moved underneath. Hand the drag
        // the node that is actually rendered.
        startDrag(nodesEl.querySelector(`.sw-node[data-id="${CSS.escape(id)}"]`) || nodeEl, e);
        return;
      }
      // Inside an expanded group's frame (but not on a card): its edges resize
      // the frame, and its body is still empty canvas to pan or marquee from.
      const groupEl = e.target.closest?.(".sw-group");
      if (groupEl && e.button === 0) {
        const g = groupById(groupEl.dataset.group);
        if (g && !g.collapsed) {
          const dir = groupEdgeDir(groupEl.getBoundingClientRect(), e.clientX, e.clientY);
          if (dir) { startGroupResize(g.id, dir, e); return; }
        }
        if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) startMarquee(e);
        else startPan(e);
        return;
      }
      // Nothing above matched: the pointer is on empty canvas. Shift-drag (or
      // Ctrl/⌘/Alt-drag) draws a selection box; anything else pans the view, and
      // a click that does not move still clears the selection.
      if (e.button === 0) {
        if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) startMarquee(e);
        else startPan(e);
      } else if (selected || groupSel.size) { selected = null; groupSel = new Set(); renderNodes(); selectionChanged(); }
    });

    // A group's name is an inline field on its header.
    canvasEl.addEventListener("change", (e) => {
      const nameEl = e.target.closest?.("[data-group-name]");
      if (nameEl) void renameGroup(nameEl.dataset.groupName, nameEl.value);
    });

    // The canvas can be smaller than the viewport (a short workflow), leaving
    // blank scroller around it. That blank area pans too, so the background is
    // one continuous surface rather than a grab cursor that only works over the
    // canvas's own rectangle.
    canvasScrollEl.addEventListener("mousedown", (e) => {
      if (e.target !== canvasScrollEl) return;
      if (e.button === 0 || e.button === 1) startPan(e);
      else if (selected || groupSel.size) { selected = null; groupSel = new Set(); renderNodes(); selectionChanged(); }
    });

    // Double-clicking a node is the same as pressing its gear.
    canvasEl.addEventListener("dblclick", (e) => {
      const nodeEl = e.target.closest?.(".sw-node");
      if (!nodeEl) return;
      selected = { kind: "node", id: nodeEl.dataset.id };
      groupSel = new Set([nodeEl.dataset.id]);
      renderNodes();
      selectionChanged();
      openDialog({ kind: "node", id: nodeEl.dataset.id });
    });

    // Closing or copying from inside the popup: delegated, because its contents
    // are rewritten as the output grows (and for a reopened past run).
    dlgEl.addEventListener("click", (e) => {
      if (e.target.closest?.("#sw-close-x")) { e.preventDefault(); closeDialog(); return; }
      const viewBtn = e.target.closest?.("[data-out-view]");
      if (viewBtn) { e.preventDefault(); setOutView(viewBtn.dataset.outView); return; }
      const mdCopy = e.target.closest?.("[data-md-copy]");
      if (mdCopy) {
        e.preventDefault();
        Promise.resolve(navigator.clipboard?.writeText(mdCopy.dataset.mdCopy || ""))
          .then(() => S.toast?.("Code copied"))
          .catch(() => S.toast?.("Could not copy the code", "err"));
        return;
      }
      if (e.target.closest?.("#sw-out-copy")) {
        const n = dlg?.kind === "node" ? nodeById(dlg.id) : null;
        const text = n ? nodeOutputText(n.id) : "";
        if (!text) return;
        Promise.resolve(navigator.clipboard?.writeText(text))
          .then(() => S.toast?.("Node output copied"))
          .catch(() => S.toast?.("Could not copy the node output", "err"));
        return;
      }
      if (!e.target.closest?.("#sw-final-copy")) return;
      const endNode = dlg?.kind === "node" ? nodeById(dlg.id) : null;
      const text = endNode?.type === "end" ? finalOutput(endNode.id).text : finalOutput().text;
      if (!text) return;
      Promise.resolve(navigator.clipboard?.writeText(text))
        .then(() => S.toast?.("Final output copied"))
        .catch(() => S.toast?.("Could not copy the final output", "err"));
    });
    // A click on the scrim (never on the popup itself) closes it.
    modalEl.addEventListener("mousedown", (e) => { if (e.target === modalEl) closeDialog(); });

    edgePathsEl.addEventListener("click", (e) => {
      const path = e.target.closest?.(".sw-edge");
      if (!path) return;
      selected = { kind: "edge", id: path.dataset.edge };
      groupSel = new Set();
      renderNodes();
      renderEdges();
      selectionChanged();
      openDialog({ kind: "edge", id: path.dataset.edge });
    });

    canvasEl.addEventListener("keydown", (e) => {
      if (e.key !== "Delete" && e.key !== "Backspace" || !selected) return;
      e.preventDefault();
      if (selected.kind === "node") removeNode(selected.id);
      else removeEdge(selected.id);
    });
  }

  function loadStyles() {
    const src = SELF_SRC || (document.currentScript && document.currentScript.src) || "";
    if (!src) return;
    const href = src.replace(/client\.js(\?|$)/, "client.css$1");
    if (!href || href === src || document.querySelector(`link[href="${href}"]`)) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.appendChild(link);
  }

  // A reload is the common way this view is left; flush the view before the
  // document goes away rather than losing the debounced write.
  window.addEventListener("beforeunload", saveViewNow);

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
        requestViewRestore();
        // `refresh()` paints when the graph arrives; the harness list only feeds
        // the settings popup, so it does not trigger a second canvas paint.
        void loadHarnesses();
        refresh();
      },
      onHide: () => { saveViewNow(); stopPolling(); },
      onCwd: () => {
        saveViewNow(); // the workspace being left keeps its own view
        cwd = S.currentCwd?.() || "";
        historyRun = null;
        historySig = "";
        requestViewRestore();
        refresh();
      },
      onReconnect: () => refresh(),
    },
    pluginSettings: {
      render: () => settingsHTML(),
      onMount(panel) {
        // The popup is reachable without ever opening the Workflow view, so load
        // this bundle's stylesheet here too (loadStyles is idempotent).
        loadStyles();
        wireSettings(panel);
        // Paint from the embedded list first, then refresh from the server and
        // paint again — no renderDialog(): we are in Settings, not that view.
        void fetchHarnesses().then(() => {
          const binRows = panel.querySelector("#sw-bin-rows");
          const userRows = panel.querySelector("#sw-user-rows");
          if (binRows) binRows.innerHTML = binRowsHTML();
          if (userRows) userRows.innerHTML = userRowsHTML();
          wireSettings(panel);
        });
      },
    },
  });
})();
