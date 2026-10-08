/**
 * settings.js — Pi Scope "Settings" view.
 *
 * A consolidated, full-page settings surface for the pi coding agent and its
 * agent team. It reads the same normalized snapshot the Chat agent-team rail
 * uses (`GET /settings`) and writes back through the same per-action writers:
 *
 *   POST /settings     — scalar pi settings.json + agent-team-config.json fields
 *                        that the rail does not surface (model, provider,
 *                        thinking, theme, parallelism, tools, debug level, …)
 *   POST /settings     — nested terminal.showTerminalProgress / compaction.enabled
 *   POST /settings     — enabledModels list management
 *   POST /settings     — memory model (teams.yaml memory_model)
 *   POST /agent-team   — team / mode / memory / agent / skill / extension /
 *                        workspace toggles (SHARED with the rail — single writer)
 *
 * The page is a two-column layout: a left nav of sections + a content panel.
 * Controls persist immediately (no save button); a transient confirmation toast
 * reports the write. Changes re-arm the running pi chat session the same way the
 * rail does so they take effect on the next prompt.
 *
 * IIFE-wrapped for scope isolation. Exposes window.__settingsOnView, which
 * app.js calls on view change, so the snapshot is only fetched when the page is
 * shown.
 */
(function () {
  const S = window.SCOPE;
  const state = window.__SCOPE_STATE;
  const $ = (s) => document.querySelector(s);
  const esc = S.escapeHtml;
  const fmtTokens = S.fmtTokens || ((n) => n);

  // ─── Persistent view state ───────────────────────────────────────────────
  let activeSec = "agent";
  let editingTeam = null;  // team name being renamed inline in the Teams section
  // Team names whose details (members, per-agent models, add row) are expanded in
  // the SubAgent → agent teams list. Empty by default, so every team renders as
  // just its name until the user opens it.
  const expandedTeams = new Set();
  let SET = null;          // latest /settings snapshot
  let loaded = false;      // first/only fetch done
  let fetching = false;
  let toastTimer = null;
  // Model-cost (mirrors the pi /modelcost selector): provider filter + search.
  let costProvider = "all"; // "all" | "free" | provider key
  let costQuery = "";

  // Model-cost resizable columns. Widths are keyed by column and persisted in
  // localStorage. `model: null` means the flexible minmax(150px, 1fr) track
  // (fills the panel); once the user drags it, it becomes a fixed pixel width.
  const COST_COLS_KEY = "pi-scope-cost-cols";
  const COST_COL_DEFAULTS = { def: 44, model: null, provider: 112, in: 66, out: 66, cache: 100, context: 62, en: 48 };
  const COST_COL_LIMITS = { def: [28, 80], model: [120, 640], provider: [60, 320], in: [40, 160], out: [40, 160], cache: [60, 240], context: [40, 200], en: [28, 80] };
  let costCols = { ...COST_COL_DEFAULTS };
  try {
    const saved = JSON.parse(localStorage.getItem(COST_COLS_KEY) || "null");
    if (saved && typeof saved === "object" && !Array.isArray(saved)) costCols = { ...COST_COL_DEFAULTS, ...saved };
  } catch { /* corrupt / unavailable — use defaults */ }

  const el = {};

  // Agent-team config (teams.yaml + agent-team-config.json) is PER PROJECT —
  // pi's agent-team extension stores it under <cwd>/.pi/settings. Scope targets
  // the chat workspace last opened in the Chat view (same localStorage key the
  // chat rail persists); with none chosen, the server falls back to its own
  // default project directory.
  function projectCwd() {
    try { return localStorage.getItem("scope-chat-workspace") || ""; } catch { return ""; }
  }

  function cache() {
    el.nav = $("#settings-nav");
    el.content = $("#settings-content");
  }

  // ─── Fallback text helpers ────────────────────────────────────────────────
  function fText(v, dflt) {
    return typeof v === "string" && v ? v : dflt;
  }
  function fBool(v, dflt) {
    return typeof v === "boolean" ? v : dflt;
  }
  function fNum(v, dflt) {
    return typeof v === "number" && Number.isFinite(v) ? v : dflt;
  }
  function strList(v) {
    return Array.isArray(v) ? v : [];
  }

  // ─── Model-cost catalog (mirrors the pi /modelcost extension) ─────────────
  // Per-million-token price formatting — identical to pi's /modelcost selector.
  function costPrice(v) {
    if (v == null || v === 0) return "free";
    if (v < 0.01) return `${v.toFixed(4)}`;
    if (v < 1) return `${v.toFixed(3)}`;
    if (v < 100) return `${v.toFixed(2)}`;
    return `${v.toFixed(0)}`;
  }
  function costCtx(n) {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
    return `${n}`;
  }

  // Build the grid-template-columns value from the (possibly resized) widths.
  // `model: null` stays a flexible minmax track so it fills the panel.
  function costGridTemplate(hasCache) {
    const cols = [
      `${costCols.def}px`,
      costCols.model != null ? `${Math.round(costCols.model)}px` : "minmax(150px, 1fr)",
      `${costCols.provider}px`,
      `${costCols.in}px`,
      `${costCols.out}px`,
    ];
    if (hasCache) cols.push(`${costCols.cache}px`);
    cols.push(`${costCols.context}px`, `${costCols.en}px`);
    return cols.join(" ");
  }
  function clampColWidth(col, px) {
    const lim = COST_COL_LIMITS[col] || [40, 300];
    return Math.min(lim[1], Math.max(lim[0], px));
  }
  function persistCostCols() {
    try { localStorage.setItem(COST_COLS_KEY, JSON.stringify(costCols)); } catch { /* ignore */ }
  }
  function resetCostCols() {
    costCols = { ...COST_COL_DEFAULTS };
    persistCostCols();
  }

  // Flatten registry metadata into a cost-sorted list (cheapest first).
  // Some store entries carry a negative sentinel (e.g. openrouter auto "-1000000")
  // instead of a real price; treat those as "unknown" and rank them last.
  function costModels() {
    const meta = (SET && SET.modelsMeta) || {};
    const arr = Object.keys(meta).map((key) => {
      const m = meta[key] || {};
      const c = m.cost || {};
      const input = c.input ?? 0;
      const output = c.output ?? 0;
      const unknown = input < 0 || output < 0;
      return {
        key,
        id: key.split("/").slice(1).join("/") || key,
        provider: m.provider || key.split("/")[0] || "?",
        ctx: m.contextWindow || 0,
        input: unknown ? 0 : input,
        output: unknown ? 0 : output,
        cacheRead: c.cacheRead ?? 0,
        cacheWrite: c.cacheWrite ?? 0,
        unknown,
      };
    });
    arr.sort((a, b) => {
      if (a.unknown !== b.unknown) return a.unknown ? 1 : -1;
      return (a.input + a.output) - (b.input + b.output);
    });
    return arr;
  }

  function costProviders(models) {
    return [...new Set(models.map((m) => m.provider))].sort();
  }

  // Loose in-order subsequence match on id + provider (pi /modelcost fuzzy).
  function costMatch(query, m) {
    if (!query) return true;
    const q = query.toLowerCase();
    const hay = `${m.id} ${m.provider}`.toLowerCase();
    let i = 0;
    for (const ch of q) {
      i = hay.indexOf(ch, i);
      if (i === -1) return false;
      i++;
    }
    return true;
  }

  // Apply active provider filter + query to the model list.
  function filteredCostModels() {
    let list = costModels();
    if (costProvider === "free") {
      list = list.filter((m) => !m.unknown && m.input === 0 && m.output === 0);
    } else if (costProvider !== "all") {
      list = list.filter((m) => m.provider === costProvider);
    }
    return list.filter((m) => costMatch(costQuery, m));
  }

  // Is this model the current default? The stored defaultModel may be a bare id,
  // a provider-relative id (e.g. "inclusionai/ling-3.0-flash-fin:free"), or fully
  // provider-qualified ("provider/id"), with or without a defaultProvider.
  // Matching is strictly provider-aware: a "kilo/<id>" default never matches an
  // identically-named model under another provider (e.g. openrouter).
  function isDefaultModel(m) {
    const sr = SET.settingsRaw || {};
    const dm = sr.defaultModel || "";
    const dp = sr.defaultProvider || "";
    if (!dm) return false;
    if (dp) return m.provider === dp && m.id === dm;
    if (dm.indexOf("/") >= 0) return m.key === dm || m.id === dm;
    return m.id === dm;
  }

  // Rows (only) for the cost table — re-rendered in place on filter/search.
  function costRowsHtml() {
    const models = costModels();
    if (!models.length) return `<div class="set-cost-empty">No pricing data in the model store.</div>`;
    const hasCache = models.some((m) => m.cacheRead || m.cacheWrite);
    const enabled = new Set(strList(SET.enabledModels));
    const filtered = filteredCostModels();
    if (!filtered.length) return `<div class="set-cost-empty">No models match this filter.</div>`;
    return filtered.map((m) => {
      const isFree = !m.unknown && m.input === 0 && m.output === 0;
      const isEnabled = enabled.has(m.key);
      const isDefault = isDefaultModel(m);
      const inLabel = m.unknown ? "—" : costPrice(m.input);
      const outLabel = m.unknown ? "—" : costPrice(m.output);
      const cacheLabel = m.cacheRead || m.cacheWrite
        ? `${m.cacheRead < 0 ? "—" : costPrice(m.cacheRead)} / ${m.cacheWrite < 0 ? "—" : costPrice(m.cacheWrite)}`
        : costPrice(0);
      const cls = ["set-cost-row", isFree ? "free" : "", m.unknown ? "unknown" : "", isDefault ? "default" : ""]
        .filter(Boolean).join(" ");
      return (
        `<div class="${cls}" data-cost-key="${esc(m.key)}" data-cost-provider="${esc(m.provider)}" data-cost-id="${esc(m.id)}" tabindex="0" aria-label="Set ${esc(m.key)} as default model" title="Set ${esc(m.key)} as the default model">` +
        `<span class="set-cost-def">${isDefault
          ? `<span class="star-ok" title="default model">★</span>`
          : `<span class="star-off" title="set as default">☆</span>`}</span>` +
        `<span class="set-cost-name" title="${esc(m.key)}">${esc(m.id)}</span>` +
        `<span class="set-cost-prov">${esc(m.provider)}</span>` +
        `<span class="set-cost-in">${inLabel}</span>` +
        `<span class="set-cost-out">${outLabel}</span>` +
        (hasCache
          ? `<span class="set-cost-cache">${cacheLabel}</span>`
          : "") +
        `<span class="set-cost-ctx">${costCtx(m.ctx)}</span>` +
        `<button type="button" class="set-cost-en${isEnabled ? " on" : ""}" data-toggle-enabled="${esc(m.key)}" title="${isEnabled ? "Enabled — click to disable" : "Disabled — click to enable"}">${isEnabled ? "✓" : "·"}</button>` +
        `</div>`
      );
    }).join("");
  }

  // ─── Data load ────────────────────────────────────────────────────────────
  async function load() {
    if (fetching) return;
    fetching = true;
    try {
      const { res, data } = await S.api("/settings", projectCwd() ? { cwd: projectCwd() } : {});
      if (res.ok && data) {
        SET = data;
        setSection(activeSec, true);
      } else {
        renderError(data?.error || `HTTP ${res.status}`);
      }
    } catch (e) {
      renderError(String(e?.message || e));
    } finally {
      fetching = false;
    }
  }

  function renderError(msg) {
    if (!el.content) return;
    el.content.innerHTML =
      `<div class="settings-empty"><div class="settings-error-ico">!</div>` +
      `<div class="settings-empty-title">Could not load settings</div>` +
      `<div class="settings-empty-sub">${esc(msg)}</div>` +
      `<button type="button" class="btn-sm" onclick="window.__settingsRetry()">Retry</button></div>`;
  }

  // ─── Persist helpers ──────────────────────────────────────────────────────
  async function postSettings(action, value, message) {
    const scroll = el.content ? el.content.scrollTop : 0;
    try {
      const { res, data } = await S.api("/settings", {}, { action, value, cwd: projectCwd() });
      if (res.ok && data) {
        SET = data;
        setSection(activeSec, true);
        if (el.content) el.content.scrollTop = scroll;
        toast(message || "Saved");
        rearmChat();
        return true;
      }
      toast(data?.error || "Failed to save", true);
      return false;
    } catch (e) {
      toast(String(e?.message || e), true);
      return false;
    }
  }

  async function postTeam(action, body) {
    try {
      const { res, data } = await S.api("/agent-team", {}, { ...body, action, cwd: projectCwd() });
      if (res.ok && data) {
        SET = { ...SET, ...data };
        mergeTeamIntoSnapshot(data);
        setSection(activeSec, true);
        toast("Saved");
        rearmChat();
        return true;
      }
      toast(data?.error || "Failed to save", true);
      return false;
    } catch (e) {
      toast(String(e?.message || e), true);
      return false;
    }
  }

  // The /agent-team response shape overlaps /settings; merge just the team-relevant
  // fields so the Settings page stays current without a full refetch.
  function mergeTeamIntoSnapshot(data) {
    if (!SET) return;
    for (const k of ["teams", "teamsOrder", "activeTeam", "mode", "memoryModel",
      "memoryActive", "disabledAgents", "skills", "extensions", "chatWorkspaces",
      "chatWorkspacesRemoved", "enabledModels", "defaultModel", "orchestratorSkills",
      "subagentSkills"]) {
      if (k in data) SET[k] = data[k];
    }
  }

  function rearmChat() {
    // A running pi --mode rpc subprocess read the agent-team config at startup.
    // Mirror chat.js: if there's no live conversation we kill + re-pre-spawn so
    // the next prompt runs under the freshly written config.
    try { if (window.__chatConfigChanged) window.__chatConfigChanged(); } catch {}
  }

  // ─── Section nav ──────────────────────────────────────────────────────────
  function setSection(sec, force) {
    activeSec = sec;
    if (el.nav) el.nav.querySelectorAll(".settings-nav-item").forEach((b) =>
      b.classList.toggle("active", b.dataset.sec === sec));
    if (force || SET) renderSection(sec);
  }

  const SECTIONS = {
    // Teams is not a separate tab any more: the agent-team roster lives inside
    // the SubAgent tab, so both render as one panel.
    agent: () => renderAgent() + renderTeams(),
    models: () => renderModels(),
    skills: () => renderSkills(),
    extensions: () => renderExtensions(),
    keys: () => renderKeys(),
    pi: () => renderPi(),
    plugins: () => renderPlugins(),
  };

  /**
   * A plugin may contribute its own Settings section by declaring
   * `view.settings = { label, render }` on its spec. Those sections are
   * registered here rather than in index.html, so a user plugin adds one
   * without editing any of the app's markup.
   */
  function pluginSettingsSections() {
    const list = window.SCOPE.Plugins?.all?.() || [];
    return list.filter((p) => p.view?.settings?.label && p.enabled !== false);
  }

  function mountPluginSettingsNav() {
    if (!el.nav) return;
    el.nav.querySelectorAll("[data-plugin-sec]").forEach((n) => n.remove());
    for (const p of pluginSettingsSections()) {
      const btn = document.createElement("button");
      btn.className = "settings-nav-item";
      btn.type = "button";
      btn.dataset.sec = `plugin:${p.id}`;
      btn.dataset.pluginSec = p.id;
      btn.textContent = p.view.settings.label;
      btn.addEventListener("click", () => setSection(btn.dataset.sec));
      el.nav.appendChild(btn);
    }
  }

  function renderSection(sec) {
    if (!SET) { showLoading(); return; }
    if (sec.startsWith("plugin:")) {
      const p = window.SCOPE.Plugins?.get?.(sec.slice(7));
      const render = p?.view?.settings?.render;
      if (!p || typeof render !== "function") { renderError("Unknown section"); return; }
      el.content.innerHTML = `<div class="settings-panel">${render()}</div>`;
      return;
    }
    const fn = SECTIONS[sec];
    if (!fn) { renderError("Unknown section"); return; }
    el.content.innerHTML = `<div class="settings-panel">${fn()}</div>`;
    wireSection(sec);
  }

  function showLoading() {
    if (!el.content) return;
    el.content.innerHTML = `<div class="settings-empty">Loading settings…</div>`;
  }

  // ─── Shared form helpers ──────────────────────────────────────────────────
  function field(label, sub, control, hint) {
    return (
      `<div class="set-field">` +
      `<div class="set-field-label">${label}` +
      (sub ? `<span class="set-field-sub">${sub}</span>` : "") +
      `</div>` +
      `<div class="set-field-control">${control}</div>` +
      (hint ? `<div class="set-field-hint">${hint}</div>` : "") +
      `</div>`
    );
  }

  // Scope badge shown next to section titles: "Project" means the control
  // persists in the current workspace's .pi/settings (agent-team-config.json /
  // agents/teams.yaml), "Global" means it lives in the shared pi
  // settings.json (~/.pi-scope/agent/settings.json). Mirrors where each section's
  // writes actually land — see the per-action writers in server.ts.
  function scopeBadge(scope) {
    const project = scope === "project";
    return (
      `<span class="set-scope set-scope-${project ? "project" : "global"}" ` +
      `title="${project
        ? "Saved in this workspace's .pi/settings (agent-team-config.json / teams.yaml)"
        : "Saved in Pi Scope's own agent dir (settings.json)"}">` +
      `${project ? "Project" : "Global"}</span>`
    );
  }

  function toggleControl(on, attrs, labelOn, labelOff) {
    return (
      `<label class="set-toggle" ${attrs || ""}><input type="checkbox"${on ? " checked" : ""}>` +
      `<span class="set-toggle-track"><span class="set-toggle-knob"></span></span>` +
      `<span class="set-toggle-label">${on ? esc(labelOn || "On") : esc(labelOff || "Off")}</span></label>`
    );
  }

  /** Compact labelled toggle for dense rows — same markup as toggleControl but
   *  with the small track. `attrs` land on the label (like toggleControl) and
   *  `inputAttrs` on the checkbox, for a caller binding its own change handler. */
  function miniToggle(on, attrs, label, inputAttrs) {
    return (
      `<label class="set-toggle" ${attrs || ""}><input type="checkbox"${inputAttrs ? " " + inputAttrs : ""}${on ? " checked" : ""}>` +
      `<span class="set-toggle-track sm"><span class="set-toggle-knob"></span></span>` +
      `<span class="set-toggle-label">${esc(label)}</span></label>`
    );
  }

  function selectControl(opts, value, attrs) {
    let html = `<select class="set-select" ${attrs || ""}>`;
    let found = false;
    for (const o of opts) {
      const sel = o.value === value;
      if (sel) found = true;
      html += `<option value="${esc(String(o.value))}"${sel ? " selected" : ""}>${esc(o.label)}</option>`;
    }
    if (!found && value !== undefined && value !== null && value !== "") {
      html += `<option value="${esc(String(value))}" selected>${esc(String(value))}</option>`;
    }
    html += `</select>`;
    return html;
  }

  // ─── Model pickers ────────────────────────────────────────────────────────
  // Every model dropdown in Settings is built from the model registry
  // (SET.modelsMeta) plus the composer's enabled models, de-duplicated and
  // grouped into one <optgroup> per provider — the same list the team member
  // pickers use. A value that is neither enabled nor in the catalogue is kept
  // as its own option so it always round-trips.

  /** Registry key (provider/id) for a stored model value. Configs may hold the
   *  key, a bare id, or an id relative to `defaultProvider`; pi resolves all
   *  three, so the dropdown has to as well or the current model would look
   *  unset. Returns "" when nothing matches. */
  function resolveModelKey(value) {
    const sel = String(value || "");
    if (!sel) return "";
    const meta = SET.modelsMeta || {};
    if (meta[sel]) return sel;
    const dp = fText((SET.settingsRaw || {}).defaultProvider, "");
    if (dp && meta[`${dp}/${sel}`]) return `${dp}/${sel}`;
    return Object.keys(meta).find((k) => k.split("/").slice(1).join("/") === sel) || "";
  }

  /** `<optgroup>` markup, one group per provider, with `current` selected. */
  function modelOptionGroups(current) {
    const meta = SET.modelsMeta || {};
    const sel = String(current || "");
    const ids = new Set([...Object.keys(meta), ...strList(SET.enabledModels)].filter(Boolean));
    if (sel) ids.add(sel);
    const groups = new Map(); // provider -> Set<model key>
    for (const id of ids) {
      const provider = (meta[id] && meta[id].provider) || id.split("/")[0] || "other";
      if (!groups.has(provider)) groups.set(provider, new Set());
      groups.get(provider).add(id);
    }
    return [...groups.keys()].sort((a, b) => a.localeCompare(b)).map((provider) => {
      const keys = [...groups.get(provider)].sort((a, b) => a.localeCompare(b));
      return (
        `<optgroup label="${esc(provider)}">` +
        keys.map((key) =>
          `<option value="${esc(key)}"${key === sel ? " selected" : ""}>${esc(key.split("/").slice(1).join("/") || key)}</option>`
        ).join("") +
        `</optgroup>`
      );
    }).join("");
  }

  /** Provider-grouped model dropdown. `emptyLabel` (when given) adds a leading
   *  option with the empty value — "(default)" for inheriting, "(none)" for
   *  unset. `cls` adds a section-specific modifier class. */
  function modelSelect(current, attrs, emptyLabel, cls) {
    const sel = String(current || "");
    return (
      `<select class="set-input set-select${cls ? " " + cls : ""}" ${attrs || ""}>` +
      (emptyLabel == null
        ? ""
        : `<option value=""${sel ? "" : " selected"}>${esc(emptyLabel)}</option>`) +
      modelOptionGroups(sel) +
      `</select>`
    );
  }

  /** Model dropdown for a team member: "(default)" inherits the session model. */
  function memberModelSelect(name, team, current) {
    const sel = String(current || "");
    return modelSelect(
      sel,
      `data-member-model="${esc(name)}" data-member-team="${esc(team)}" ` +
      `aria-label="Model for ${esc(name)}" title="${esc(sel || "(default)")}"`,
      "(default)",
      "set-member-model"
    );
  }

  // ─── Agent section ────────────────────────────────────────────────────────
  function renderAgent() {
    const sr = SET.settingsRaw || {};
    const cr = SET.agentConfigRaw || {};
    const mode = SET.mode || "standard";
    const memModel = SET.memoryModel;
    const memActive = SET.memoryActive;
    const teamEnabled = fBool(cr.enabled, true);

    const thinkingOpts = strList(SET.thinkingLevels)
      .map((l) => ({ value: l, label: l.charAt(0).toUpperCase() + l.slice(1) }));

    return (
      `<div class="settings-group">` +
      `<div class="settings-group-kicker">Agent behavior</div>` +
      `<h2 class="settings-group-title">SubAgent ${scopeBadge("project")}</h2>` +
      field("Mode", "creative vs standard", selectControl(
        [{ value: "standard", label: "Standard" }, { value: "creative", label: "Creative" }],
        mode, 'data-act="setMode"'
      )) +
      field("Agent team enabled", "master switch for the team harness",
        toggleControl(teamEnabled, 'data-act="setTeamEnabled"', "Enabled", "Disabled")) +
      field("Memory", "persistent cross-session context",
        toggleControl(memActive, 'data-act="toggleMemory"', "On", "Off"),
        memModel ? `Memory model: ${esc(memModel)}` : "No memory model configured") +
      `<div class="settings-group-div"></div>` +
      `<div class="settings-group-kicker">Concurrency & parity</div>` +
      field("Parallel dispatch", "run subagents concurrently",
        toggleControl(fBool(cr.parallelDispatch, false), 'data-act="setParallelDispatch"')) +
      field("Max parallel", "cap on concurrent subagents",
        `<input type="number" min="1" max="16" class="set-input" value="${fNum(cr.maxParallel, 1)}" data-act="setMaxParallel">`) +
      field("Grid columns", "team layout grid width",
        `<input type="number" min="1" max="4" class="set-input" value="${fNum(cr.gridCols, 1)}" data-act="setGridCols">`) +
      field("Debug level", "verbosity 0–3",
        `<input type="number" min="0" max="3" class="set-input" value="${fNum(cr.debugLevel, 0)}" data-act="setDebugLevel">`) +
      `</div>`
    );
  }

  // ─── Teams section ────────────────────────────────────────────────────────
  function renderTeams() {
    const teams = SET.teams || {};
    const order = strList(SET.teamsOrder).length ? SET.teamsOrder : Object.keys(teams);
    const activeTeam = SET.activeTeam && teams[SET.activeTeam] ? SET.activeTeam : order[0];
    const disabled = new Set(strList(SET.disabledAgents));
    const cr = SET.agentConfigRaw || {};
    const defs = strList(SET.agentDefs);

    let teamHtml = "";
    if (!order.length) {
      teamHtml = `<div class="settings-empty-sub">No teams defined in teams.yaml.</div>`;
    } else {
      for (const tn of order) {
        const members = teams[tn] || [];
        const isActive = tn === activeTeam;
        const activeCount = members.filter((m) => m.active !== false && !disabled.has((m.name || "").toLowerCase())).length;
        // Collapsed by default: a team shows as just a chevron + its name.
        // Expanding reveals Edit/Remove/Activate and the member list. Renaming
        // happens inline: the name swaps for an input and the rest of the head
        // is replaced by Save/Cancel so the row can't be misclicked.
        const open = expandedTeams.has(tn);
        const toggle =
          `<button type="button" class="set-team-toggle" data-team-toggle="${esc(tn)}" ` +
          `aria-expanded="${open ? "true" : "false"}" title="${open ? "Collapse" : "Expand"} ${esc(tn)}">` +
          `${open ? "▾" : "▸"}</button>`;
        const head = editingTeam === tn
          ? `<div class="set-team-head">` +
            toggle +
            `<input type="text" class="set-input set-team-rename" value="${esc(tn)}" data-team-rename="${esc(tn)}" ` +
            `aria-label="New name for ${esc(tn)}" spellcheck="false">` +
            `<button type="button" class="btn-sm" data-team-rename-save="${esc(tn)}">Save</button>` +
            `<button type="button" class="btn-sm" data-team-rename-cancel="1">Cancel</button>` +
            `</div>`
          : `<div class="set-team-head">` +
            toggle +
            `<span class="set-team-name">${esc(tn)}</span>` +
            (open
              ? `<button type="button" class="btn-sm set-team-edit" data-team-edit="${esc(tn)}" title="Rename this team">Edit</button>` +
                `<button type="button" class="btn-sm set-team-del" data-team-del="${esc(tn)}" title="Delete this team">Remove</button>` +
                `<span class="set-team-actions">` +
                `<span class="set-team-count">${activeCount}/${members.length} active</span>` +
                (isActive
                  ? `<span class="set-team-pill">active</span>`
                  : `<button type="button" class="btn-sm set-team-select" data-select="${esc(tn)}">Activate</button>`) +
                `</span>`
              : "") +
            `</div>`;
        teamHtml +=
          `<div class="set-team${isActive ? " active" : ""}${open ? "" : " collapsed"}" data-team="${esc(tn)}">` +
          head +
          (open
            ? `<div class="set-members">` +
              members.map((m) => {
                const name = m.name || "";
                const off = disabled.has(name.toLowerCase()) || m.active === false;
                const model = m.model || "";
                return (
                  `<div class="set-member">` +
                  `<label class="set-member-toggle"><input type="checkbox" data-agent="${esc(name)}" data-disabled="${off}"${off ? "" : " checked"}>` +
                  `<span class="set-toggle-track sm"><span class="set-toggle-knob"></span></span></label>` +
                  `<span class="set-member-name">${esc(name)}</span>` +
                  memberModelSelect(name, tn, model) +
                  `<button type="button" class="set-member-x" data-member-del="${esc(name)}" data-member-team="${esc(tn)}" ` +
                  `title="Remove ${esc(name)} from ${esc(tn)}" aria-label="Remove ${esc(name)}">&times;</button>` +
                  `</div>`
                );
              }).join("") +
              `<div class="set-member-add">` +
              `<input type="text" class="set-input" placeholder="add a subagent (e.g. web_fetch)" data-member-add="${esc(tn)}" ` +
              `spellcheck="false" aria-label="Add a subagent to ${esc(tn)}">` +
              `<button type="button" class="btn-sm" data-member-add-btn="${esc(tn)}">Add</button>` +
              `</div>` +
              `</div>`
            : "") +
          `</div>`;
      }
    }

    return (
      `<div class="settings-group">` +
      `<div class="settings-group-kicker">Teams</div>` +
      `<h2 class="settings-group-title">agent teams ${scopeBadge("project")}</h2>` +
      `<div class="settings-intro">Teams live in this workspace's ` +
      `<code>.pi/settings/agents/teams.yaml</code>. Create, rename and delete teams, add or remove their subagents, ` +
      `activate one, and set a per-agent model. Members without an explicit ` +
      `<code>active: false</code> are on.</div>` +
      teamHtml +
      `<div class="settings-group-div"></div>` +
      field("New team", "starts empty — add subagents to it above",
        `<span class="set-input-wrap">` +
        `<input type="text" class="set-input" id="set-add-team" placeholder="my-team" spellcheck="false" autocomplete="off">` +
        `<button type="button" class="btn-sm" id="set-add-team-btn">Add team</button>` +
        `</span>`) +
      `<div class="settings-group-div"></div>` +
      `<div class="settings-group-kicker">Tool policy</div>` +
      `<div class="settings-intro">Tools the agent team may not invoke (left) and tools the orchestrator skips before dispatching to subagents (right). One comma-separated list each.</div>` +
      field("Destructive tools", "blocked by name",
        `<input type="text" class="set-input" value="${esc(strList(cr.destructiveTools).join(", "))}" data-act="setDestructiveTools">`) +
      field("Skip orchestrator tools", "not run by the orchestrator",
        `<input type="text" class="set-input" value="${esc(strList(cr.skipOrchestratorTools).join(", "))}" data-act="setSkipOrchestratorTools">`) +
      `<div class="settings-group-div"></div>` +
      `<div class="settings-group-kicker">Subagent definitions</div>` +
      `<div class="settings-intro">One row per <code>agents/*.md</code>. <b>Edit</b> opens the whole file (frontmatter + prompt) in a full-screen editor.</div>` +
      `<div class="set-defs">` +
      defs.map((d) =>
        `<div class="set-def-row">` +
        `<span class="set-def-name">${esc(d.name)}</span>` +
        `<span class="set-def-file">agents/${esc(d.file)}</span>` +
        `<button type="button" class="btn-sm" data-agentdef-edit="${esc(d.file)}">Edit</button>` +
        `</div>`
      ).join("") +
      (defs.length ? "" : `<div class="settings-empty-sub">No subagent definitions found in <code>agents/</code>.</div>`) +
      `</div>` +
      `</div>`
    );
  }

  // ─── Full-screen text editor ──────────────────────────────────────────────
  // One overlay, shared by subagent definitions (agents/<file>.md) and the
  // global instruction files, so a whole file is read and edited at once
  // instead of through an inline textarea. The overlay is appended to <body>,
  // not the settings panel, so postSettings' re-render doesn't tear it down.
  // Save (button or Ctrl/Cmd+S), Close, Esc and a backdrop click all work.
  function openFullscreenEditor({ title, hint, content, save }) {
    closeFullscreenEditor();

    const overlay = document.createElement("div");
    overlay.className = "def-editor-backdrop";
    overlay.id = "def-editor-backdrop";
    overlay.innerHTML =
      `<div class="def-editor" role="dialog" aria-modal="true" aria-label="Edit ${esc(title)}">` +
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
      save(ta.value).then((ok) => { if (ok) closeFullscreenEditor(); });
    });
    overlay.querySelector(".def-editor-close").addEventListener("click", closeFullscreenEditor);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeFullscreenEditor(); });
    document.addEventListener("keydown", defEditorEsc);
  }

  function closeFullscreenEditor() {
    document.getElementById("def-editor-backdrop")?.remove();
    document.removeEventListener("keydown", defEditorEsc);
  }

  function defEditorEsc(e) {
    // Ctrl/Cmd+S saves without leaving the editor.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      const btn = document.querySelector("#def-editor-backdrop .def-editor-save");
      if (btn) { e.preventDefault(); btn.click(); }
      return;
    }
    if (e.key === "Escape") closeFullscreenEditor();
  }

  // Opens agents/<file>.md (frontmatter + prompt) whole, so advanced edits
  // (tools, thinking, the prompt body) are possible — the inline Model/Description
  // rows only covered two frontmatter keys.
  function openAgentDefEditor(file) {
    const def = strList(SET.agentDefs).find((d) => d.file === file);
    if (!def) { toast("Unknown subagent definition", true); return; }
    openFullscreenEditor({
      title: `agents/${file}`,
      hint: "frontmatter + prompt",
      content: def.content || "",
      save: (content) => postSettings("saveAgentDefFile", { file, content }, `${file} saved`),
    });
  }

  // Opens one of the agent dir's global instruction files (AGENTS.md,
  // SYSTEM.md, …). An empty save deletes the file on the server.
  function openInstructionEditor(file) {
    const ins = strList(SET.instructions).find((i) => i.file === file);
    if (!ins) { toast("Unknown instruction file", true); return; }
    openFullscreenEditor({
      title: file,
      hint: ins.exists ? `agent dir · ${ins.bytes} B` : "agent dir · not created yet",
      content: ins.content || "",
      save: (content) => postSettings(
        "setInstructionFile", { file, content },
        content.trim() ? `${file} saved` : `${file} removed`
      ),
    });
  }

  // ─── Models section ───────────────────────────────────────────────────────
  function renderModels() {
    const sr = SET.settingsRaw || {};
    const enabled = strList(SET.enabledModels);
    const defaultModel = fText(sr.defaultModel, "");
    const defaultProvider = fText(sr.defaultProvider, "");
    const thinking = fText(sr.defaultThinkingLevel, "high");
    const meta = SET.modelsMeta || {};

    // Provider keys as presentable options for the default-provider field.
    const known = Object.keys(meta).sort();
    const providerOptions = [...new Set(known.map((m) => (meta[m] && meta[m].provider) || m.split("/")[0]))]
      .filter(Boolean).sort();

    // The stored default model may be a registry key, a bare id, or an id
    // relative to defaultProvider; fall back to the raw value so an unknown
    // model is never silently blanked (it becomes its own option).
    const defaultKey = defaultModel ? resolveModelKey(defaultModel) || defaultModel : "";
    const memoryKey = SET.memoryModel ? resolveModelKey(SET.memoryModel) || SET.memoryModel : "";

    const thinks = strList(SET.thinkingLevels).map((l) => ({ value: l, label: l }));

    return (
      `<div class="settings-group">` +
      `<div class="settings-group-kicker">Defaults</div>` +
      `<h2 class="settings-group-title">models & inference ${scopeBadge("global")}</h2>` +
      field("Default model", "used when no session model matches",
        modelSelect(defaultKey, 'data-act="setDefaultModel"', "(none)")) +
      field("Default provider", "preferred provider key",
        `<input type="text" class="set-input" value="${esc(defaultProvider)}" list="set-prov-list" data-act="setDefaultProvider">`) +
      `<datalist id="set-prov-list">${providerOptions.map((p) => `<option value="${esc(p)}">`).join("")}</datalist>` +
      field("Thinking level", "resolved at agent start", selectControl(thinks, thinking, 'data-act="setDefaultThinkingLevel"')) +
      // Git's commit-message model + template live with the Git plugin now — see
      // its `pluginSettings` popup in Settings → Plugins.
      `<div class="settings-group-div"></div>` +
      `<div class="settings-group-kicker">Enabled models</div>` +
      `<div class="settings-intro">Models the composer dropdown offers. Add a model id (provider/model) to enable it; remove to disable.</div>` +
      `<div class="set-model-list">` +
      enabled.map((m) =>
        `<div class="set-model-chip" data-model="${esc(m)}"><span class="set-model-chip-name">${esc(m)}</span>` +
        `<button type="button" class="set-model-chip-x" data-remove-model="${esc(m)}" aria-label="Remove ${esc(m)}">×</button></div>`
      ).join("") +
      (enabled.length ? "" : `<div class="settings-empty-sub">No enabled models.</div>`) +
      `</div>` +
      field("Add model", "pick a model to offer in the composer",
        `<span class="set-input-wrap">` +
        modelSelect("", 'id="set-add-model" aria-label="Model to enable"', "(choose a model)") +
        `<button type="button" class="btn-sm" id="set-add-model-btn">Add</button>` +
        `</span>`) +
      `<div class="settings-group-div"></div>` +
      `<div class="settings-group-kicker">Memory</div>` +
      field("Memory model", "powers the memory summarizer; (default) falls back to the settings default model when memory is enabled",
        modelSelect(memoryKey, 'data-act="setMemoryModel"', "(default)")) +
      renderModelCost() +
      `</div>`
    );
  }

  // ─── Model cost (registry pricing catalog) ───────────────────────────────
  function renderModelCost() {
    const models = costModels();
    if (!models.length) {
      return (
        `<div class="settings-group-div"></div>` +
        `<div class="settings-group-kicker">Model cost</div>` +
        `<div class="settings-intro">Per-million-token pricing for every model in the registry. No pricing data was found in the model store.</div>`
      );
    }
    const hasCache = models.some((m) => m.cacheRead || m.cacheWrite);
    const chip = (key, label) =>
      `<button type="button" class="set-cost-chip${costProvider === key ? " active" : ""}" data-cost-prov="${esc(key)}">${esc(label)}</button>`;

    let provChips = chip("all", "All");
    if (models.some((m) => !m.unknown && m.input === 0 && m.output === 0)) provChips += chip("free", "Free");
    provChips += costProviders(models).map((p) => chip(p, p)).join("");

    const header =
      `<div class="set-cost-row set-cost-head">` +
      `<span class="set-cost-def" title="default model">def</span>` +
      `<span class="set-cost-name" title="model id">model</span>` +
      `<span class="set-cost-prov" title="provider">provider</span>` +
      `<span class="set-cost-in" title="input price per million tokens">in /M</span>` +
      `<span class="set-cost-out" title="output price per million tokens">out /M</span>` +
      (hasCache ? `<span class="set-cost-cache" title="cache read / write per million tokens">cache</span>` : "") +
      `<span class="set-cost-ctx" title="context window">context</span>` +
      `<span class="set-cost-en" title="enabled in model roster">en</span>` +
      `</div>`;

    const filteredCount = filteredCostModels().length;

    return (
      `<div class="settings-group-div"></div>` +
      `<div class="settings-group-kicker">Model cost</div>` +
      `<div class="settings-intro">Per-million-token pricing, cheapest first. Filter by provider or search by id. Click a row to set it as the default model; click <span class="set-cost-enhint">en</span> to toggle it in the roster. Drag a column edge to resize it.</div>` +
      `<div class="set-cost-toolbar">` +
      `<div class="set-cost-providers">${provChips}</div>` +
      `<input type="search" class="set-input set-cost-search" id="set-cost-search" placeholder="Filter models…" value="${esc(costQuery)}">` +
      `<span class="set-cost-count" id="set-cost-count" data-total="${models.length}" aria-live="polite">${filteredCount} of ${models.length}</span>` +
      `<button type="button" class="set-cost-reset" id="set-cost-reset" title="Reset column widths">↺ columns</button>` +
      `</div>` +
      `<div class="set-cost-table${hasCache ? " has-cache" : ""}" style="--cost-cols: ${costGridTemplate(hasCache)}">${header}<div id="set-cost-rows">${costRowsHtml()}</div><div class="set-cost-resizers" aria-hidden="true"></div></div>`
    );
  }

  // ─── Skills ───────────────────────────────────────────────────────────────
  function renderSkills() {
    const skills = strList(SET.skills);
    if (!skills.length) {
      return `<div class="settings-group"><div class="settings-group-kicker">Skills</div><h2 class="settings-group-title">skills ${scopeBadge("project")}</h2>` +
        `<div class="settings-empty-sub">No skills discovered in Pi Scope's agent dir (<code>skills/</code>).</div></div>`;
    }
    const group = (g, label) => {
      const isOn = (sk) => (g === "orchestrator" ? !!sk.orchestrator : !!sk.subagent);
      const on = skills.filter(isOn).length;
      return (
        `<div class="set-skill-group">` +
        `<div class="set-skill-head"><span>${label}</span><span class="set-skill-count">${on}/${skills.length}</span></div>` +
        `<div class="set-chips">` +
        skills.map((sk) =>
          `<button type="button" class="set-chip${isOn(sk) ? " on" : ""}" data-dir="${esc(sk.dir)}" data-group="${g}" title="${esc(sk.name)}${sk.description ? " — " + esc(sk.description) : ""}">` +
          `<span class="set-chip-dot"></span><span class="set-chip-name">${esc(sk.name)}</span></button>`
        ).join("") +
        `</div></div>`
      );
    };
    // Third axis: the default pi skills — whether pi loads the skill at all
    // (settings.json `skills` +/- entries). Distinct from the
    // orchestrator/subagent membership above, which is agent-team-config.json
    // state.
    const loadGroup = () => {
      const isOn = (sk) => sk.settingsEnabled !== false;
      const on = skills.filter(isOn).length;
      return (
        `<div class="set-skill-group">` +
        `<div class="set-skill-head"><span>Default pi skills</span><span class="set-skill-count">${on}/${skills.length}</span></div>` +
        `<div class="set-chips">` +
        skills.map((sk) =>
          `<button type="button" class="set-chip${isOn(sk) ? " on" : ""}" data-skill-load="${esc(sk.dir)}" title="Load ${esc(sk.name)} in pi sessions (settings.json skills)">` +
          `<span class="set-chip-dot"></span><span class="set-chip-name">${esc(sk.name)}</span></button>`
        ).join("") +
        `</div></div>`
      );
    };
    return (
      `<div class="settings-group">` +
      `<div class="settings-group-kicker">Skills</div>` +
      `<h2 class="settings-group-title">capabilities ${scopeBadge("project")}</h2>` +
      `<div class="settings-intro">Three independent axes: whether pi <b>loads</b> a skill at all (<code>settings.json</code>), and whether its tools are offered to the <b>orchestrator</b> / <b>subagents</b> (<code>agent-team-config.json</code>).</div>` +
      loadGroup() +
      group("orchestrator", "Orchestrator") +
      group("subagent", "Subagents") +
      `</div>`
    );
  }

  // ─── Extensions ───────────────────────────────────────────────────────────
  function renderExtensions() {
    const exts = strList(SET.extensions);
    if (!exts.length) {
      return `<div class="settings-group"><div class="settings-group-kicker">Extensions</div><h2 class="settings-group-title">extensions ${scopeBadge("global")}</h2>` +
        `<div class="settings-empty-sub">No extensions configured.</div></div>`;
    }
    // Enablement flags live in extensions/extensions.json, keyed by the
    // extension's name (directory name, or file stem for a single-file
    // extension). Only extensions pi can actually load are worth configuring.
    // This is the only control that decides whether each extension loads, so the
    // previously separate settings.json "loaded extensions" chip list was folded
    // into it.
    const flags = SET.extensionFlags || {};
    const named = exts.filter((ex) => ex.available !== false);
    const flagRows = named.map((ex) => {
      const f = flags[ex.name] || {};
      return (
        `<div class="set-extflag">` +
        `<span class="set-extflag-name">${esc(ex.name)}</span>` +
        miniToggle(f.orchestrator !== false, "", "orchestrator", `data-ext-flag="${esc(ex.name)}" data-ext-which="orchestrator"`) +
        miniToggle(f.subagent !== false, "", "subagent", `data-ext-flag="${esc(ex.name)}" data-ext-which="subagent"`) +
        `</div>`
      );
    }).join("");
    return (
      `<div class="settings-group">` +
      `<div class="settings-group-kicker">Extensions</div>` +
      `<h2 class="settings-group-title">extensions ${scopeBadge("global")}</h2>` +
      `<div class="settings-intro">Whether each extension loads for the <b>orchestrator</b> and for spawned <b>subagents</b> (<code>extensions/extensions.json</code>).</div>` +
      `<div class="set-extflags">` + flagRows +
      (named.length ? "" : `<div class="settings-empty-sub">No loadable extensions to configure.</div>`) +
      `</div></div>`
    );
  }

  // ─── API keys ─────────────────────────────────────────────────────────────
  // Keys for app features (Groq speech-to-text) and for pi extensions that read
  // process.env. They are stored in ~/.pi-scope/agent/api-keys.json (mode 0600) and
  // injected into the environment of every pi chat the server launches, so a
  // key no longer has to be exported in the shell the server was started from —
  // a desktop/GUI launch never sources the shell profile, which is exactly why
  // env-only keys were invisible. Secrets are never sent to the browser: rows
  // show a masked preview plus where the effective value comes from.
  function renderKeys() {
    const keys = strList(SET.apiKeys);
    const sourceBadge = (source) =>
      source === "settings"
        ? `<span class="set-scope set-scope-project" title="Stored in api-keys.json — overrides the environment">Settings</span>`
        : source === "env"
          ? `<span class="set-scope set-scope-global" title="Inherited from the server's environment">Environment</span>`
          : source === "shell"
            ? `<span class="set-scope set-scope-global" title="Found in your shell profile (~/.bashrc, ~/.zshrc)">Shell profile</span>`
            : source === "config"
              ? `<span class="set-scope set-scope-project" title="From the speech-to-text extension's speech-to-text.json">Extension config</span>`
              : `<span class="set-scope set-scope-none" title="No value found for this key">Not set</span>`;

    const row = (k) => {
      const desc = esc(k.description) +
        (k.url ? ` <a href="${esc(k.url)}" target="_blank" rel="noopener">Get a key</a>` : "");
      const control =
        `<span class="set-input-wrap">` +
        `<input type="password" class="set-input" data-key="${esc(k.name)}" autocomplete="off" spellcheck="false" ` +
        `aria-label="${esc(k.name)}" placeholder="${k.masked ? esc(k.masked) : "paste " + esc(k.name)}">` +
        `<button type="button" class="btn-sm" data-key-save="${esc(k.name)}">Save</button>` +
        (k.source === "settings"
          ? `<button type="button" class="btn-sm" data-key-clear="${esc(k.name)}" ` +
            `title="Remove the stored value (falls back to the environment, if any)">Clear</button>`
          : "") +
        `</span>`;
      return field(
        esc(k.label) + " " + sourceBadge(k.source),
        `<code>${esc(k.name)}</code> — ${desc}`,
        control
      );
    };

    const known = keys.filter((k) => k.known);
    const custom = keys.filter((k) => !k.known);
    // No defaults are seeded, so the panel can legitimately be empty: only keys
    // that actually have a value (Settings, environment, shell profile or an
    // extension config) are listed. The known names stay reachable through the
    // datalist on the Add field below.
    const knownNames = strList(SET.knownApiKeys);

    return (
      `<div class="settings-group">` +
      `<div class="settings-group-kicker">Credentials</div>` +
      `<h2 class="settings-group-title">API keys ${scopeBadge("global")}</h2>` +
      `<div class="settings-intro">Saved to <code>~/.pi-scope/agent/api-keys.json</code> (owner-only) and injected ` +
      `into the environment of every pi chat the server launches — those chats run under your interactive shell ` +
      `(which sources <code>~/.bashrc</code> / <code>~/.zshrc</code>), so keys exported there reach them too. A saved key overrides the ` +
      `launcher's environment; Clear falls back to it.</div>` +
      (keys.length ? "" : `<div class="settings-empty-sub">No keys saved.</div>`) +
      known.map(row).join("") +
      (custom.length
        ? `<div class="settings-group-div"></div>` +
          `<div class="settings-group-kicker">Custom</div>` +
          custom.map(row).join("")
        : "") +
      `<div class="settings-group-div"></div>` +
      field("Add a key", "any environment variable the app or a pi extension reads",
        `<span class="set-input-wrap">` +
        `<input type="text" class="set-input key-name" id="set-key-name" list="set-known-keys" placeholder="MY_API_KEY" spellcheck="false" autocomplete="off">` +
        `<input type="password" class="set-input" id="set-key-value" placeholder="value" autocomplete="off" aria-label="key value">` +
        `<button type="button" class="btn-sm" id="set-key-add-btn">Add</button>` +
        `</span>` +
        (knownNames.length
          ? `<datalist id="set-known-keys">${knownNames.map((n) => `<option value="${esc(n)}">`).join("")}</datalist>`
          : ""),
        "Stored keys are handed to pi by name, so the name must be a valid environment variable (A-Z, 0-9, _).") +
      `</div>`
    );
  }

  // ─── Workspaces ───────────────────────────────────────────────────────────
  // No Settings section: workspaces are added and removed from the Chat view's
  // own rail (see chat.js / rail.js), which owns the same addWorkspace and
  // removeWorkspace actions. Keeping a second editor here only duplicated that
  // surface.

  // ─── pi section ───────────────────────────────────────────────────────────
  function renderPi() {
    const sr = SET.settingsRaw || {};
    const term = sr.terminal || {};
    const comp = sr.compaction || {};
    const themes = strList(SET.themes);
    const pkgs = strList(SET.packages);
    const trusted = strList(SET.trustedProjects);
    const providers = strList(SET.providers);
    const instr = strList(SET.instructions);

    const listRow = (value, removeAttr) =>
      `<div class="set-ws"><span class="set-ws-path">${esc(value)}</span>` +
      `<button type="button" class="set-ws-x" ${removeAttr} aria-label="Remove ${esc(value)}">&times;</button></div>`;

    return (
      `<div class="settings-group">` +
      `<div class="settings-group-kicker">pi settings.json</div>` +
      `<h2 class="settings-group-title">pi coding agent ${scopeBadge("global")}</h2>` +
      field("Theme", "pi terminal theme",
        `<input type="text" class="set-input" value="${esc(fText(sr.theme, "cyberpunk"))}" list="set-theme-list" data-act="setTheme">` +
        `<datalist id="set-theme-list">${themes.map((t) => `<option value="${esc(t)}"></option>`).join("")}</datalist>`) +
      field("Quiet startup", "suppress verbose boot banner",
        toggleControl(fBool(sr.quietStartup, false), 'data-act="setQuietStartup"')) +
      field("Hide thinking block", "collapse reasoning in the transcript",
        toggleControl(fBool(sr.hideThinkingBlock, false), 'data-act="setHideThinkingBlock"')) +
      field("Double-escape action", "tree | page | none", selectControl(
        [{ value: "tree", label: "tree" }, { value: "page", label: "page" }, { value: "none", label: "none" }],
        fText(sr.doubleEscapeAction, "tree"), 'data-act="setDoubleEscapeAction"')) +
      field("Editor padding X", "horizontal editor inset",
        `<input type="number" min="0" max="20" class="set-input" value="${fNum(sr.editorPaddingX, 0)}" data-act="setEditorPaddingX">`) +
      field("Terminal progress", "show progress in terminal output",
        toggleControl(fBool(term.showTerminalProgress, true), 'data-act="setTerminalShowProgress"')) +
      field("Compaction", "auto-compact long sessions",
        toggleControl(fBool(comp.enabled, true), 'data-act="setCompactionEnabled"')) +

      `<div class="settings-group-div"></div>` +
      `<div class="settings-group-kicker">Packages</div>` +
      `<div class="settings-intro">pi packages from <code>settings.json</code> <code>packages</code> (npm:, git:, github:, …). Remove to uninstall; add a source to install on the next pi start.</div>` +
      `<div class="set-ws-list">` +
      pkgs.map((p) => listRow(p.source, `data-pkg-remove="${esc(p.source)}"`)).join("") +
      (pkgs.length ? "" : `<div class="settings-empty-sub">No packages installed.</div>`) +
      `</div>` +
      field("Add package", "npm:name, git:url, github:owner/repo",
        `<span class="set-input-wrap"><input type="text" class="set-input" id="set-add-pkg" placeholder="npm:@scope/tool" spellcheck="false"><button type="button" class="btn-sm" id="set-add-pkg-btn">Add</button></span>`) +

      `<div class="settings-group-div"></div>` +
      `<div class="settings-group-kicker">Trusted projects</div>` +
      `<div class="settings-intro">Directories pi trusts to load project-local <code>.pi</code> config from (<code>trust.json</code>). Revoke to make pi ask again.</div>` +
      `<div class="set-ws-list">` +
      trusted.map((p) => listRow(p, `data-trust-revoke="${esc(p)}"`)).join("") +
      (trusted.length ? "" : `<div class="settings-empty-sub">No trusted projects.</div>`) +
      `</div>` +

      `<div class="settings-group-div"></div>` +
      `<div class="settings-group-kicker">Provider sign-in</div>` +
      `<div class="settings-intro">Providers with stored credentials in <code>auth.json</code>. Sign in by running <code>pi</code> in a terminal. Secrets are never shown here.</div>` +
      `<div class="set-chips">` +
      providers.map((p) => `<span class="set-chip on" title="${esc(p.type || "credential")}"><span class="set-chip-dot"></span><span class="set-chip-name">${esc(p.name)}</span></span>`).join("") +
      (providers.length ? "" : `<div class="settings-empty-sub">No providers signed in.</div>`) +
      `</div>` +

      `<div class="settings-group-div"></div>` +
      `<div class="settings-group-kicker">Global instructions</div>` +
      `<div class="settings-intro">Files every pi session loads from the agent dir. <b>Edit</b> opens the file in a full-screen editor; saving it empty removes the file. <code>AGENTS.md</code> is context; <code>SYSTEM.md</code> replaces the system prompt and <code>APPEND_SYSTEM.md</code> appends to it.</div>` +
      `<div class="set-defs">` +
      instr.map((i) =>
        `<div class="set-def-row">` +
        `<span class="set-def-name">${esc(i.file)}</span>` +
        `<span class="set-def-file">${i.exists ? `${i.bytes} B` : "not created"}</span>` +
        `<button type="button" class="btn-sm" data-instr-edit="${esc(i.file)}">Edit</button>` +
        `</div>`
      ).join("") +
      (instr.length ? "" : `<div class="settings-empty-sub">No instruction files.</div>`) +
      `</div>`
    );
  }

  // ─── Wiring ───────────────────────────────────────────────────────────────
  // API-key rows: Save (button, or Enter in the field), Clear, and the custom
  // add row. Saving an empty value is rejected here rather than silently
  // clearing the key — Clear is the explicit way to do that.
  function wireKeys(panel) {
    const saveByName = (name) => {
      const input = panel.querySelector(`input[data-key="${name}"]`);
      const value = input ? input.value.trim() : "";
      if (!value) { toast("Paste a key first", true); return; }
      postSettings("setApiKey", { name, value }, `${name} saved`);
    };
    panel.querySelectorAll("input[data-key]").forEach((node) =>
      node.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); saveByName(node.dataset.key); }
      })
    );
    panel.querySelectorAll("[data-key-save]").forEach((b) =>
      b.addEventListener("click", () => saveByName(b.dataset.keySave))
    );
    panel.querySelectorAll("[data-key-clear]").forEach((b) =>
      b.addEventListener("click", () => postSettings("clearApiKey", { name: b.dataset.keyClear }, `${b.dataset.keyClear} cleared`))
    );
    const addBtn = panel.querySelector("#set-key-add-btn");
    if (addBtn) {
      addBtn.addEventListener("click", () => {
        const name = (panel.querySelector("#set-key-name")?.value || "").trim();
        const value = (panel.querySelector("#set-key-value")?.value || "").trim();
        if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) { toast("Name must look like MY_API_KEY", true); return; }
        if (!value) { toast("Paste a key first", true); return; }
        postSettings("setApiKey", { name, value }, `${name} saved`);
      });
    }
  }

  // Teams editor: inline rename, delete, per-team member add/remove, and the
  // new-team row. Every write goes through POST /agent-team (the single writer
  // shared with the Chat rail) and the section re-renders from the snapshot it
  // returns, so the UI always reflects what actually landed on disk.
  function wireTeams(panel) {
    const rerender = () => setSection(activeSec, true);

    // Collapse/expand a team. Teams render collapsed by default, so this is the
    // only way a team's member list is revealed.
    panel.querySelectorAll("[data-team-toggle]").forEach((b) =>
      b.addEventListener("click", () => {
        const tn = b.dataset.teamToggle;
        if (expandedTeams.has(tn)) expandedTeams.delete(tn); else expandedTeams.add(tn);
        rerender();
      })
    );

    panel.querySelectorAll("[data-team-edit]").forEach((b) =>
      b.addEventListener("click", () => { editingTeam = b.dataset.teamEdit; rerender(); })
    );
    panel.querySelectorAll("[data-team-rename-cancel]").forEach((b) =>
      b.addEventListener("click", () => { editingTeam = null; rerender(); })
    );
    const renameInput = panel.querySelector("input[data-team-rename]");
    if (renameInput) {
      renameInput.focus();
      renameInput.select();
      const commit = async () => {
        const from = renameInput.dataset.teamRename;
        const to = renameInput.value.trim();
        editingTeam = null;
        // Unchanged/empty just leaves edit mode; the server validates the name
        // and its error toast is the single source of truth for collisions.
        if (!to || to === from) { rerender(); return; }
        // Keep a rename from collapsing the team the user had open.
        if (expandedTeams.has(from)) { expandedTeams.delete(from); expandedTeams.add(to); }
        await postTeam("renameTeam", { team: from, to });
      };
      renameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); void commit(); }
        else if (e.key === "Escape") { e.preventDefault(); editingTeam = null; rerender(); }
      });
      panel.querySelectorAll("[data-team-rename-save]").forEach((b) =>
        b.addEventListener("click", () => void commit())
      );
    }

    panel.querySelectorAll("[data-team-del]").forEach((b) =>
      b.addEventListener("click", () => {
        const tn = b.dataset.teamDel;
        if (!confirm(`Delete team "${tn}"?\n\nIts subagent list is removed from teams.yaml. Members stay available in other teams.`)) return;
        expandedTeams.delete(tn);
        postTeam("removeTeam", { team: tn });
      })
    );

    const addMember = (team) => {
      const input = panel.querySelector(`input[data-member-add="${team}"]`);
      const name = input ? input.value.trim() : "";
      if (!name) { toast("Type a subagent name first", true); return; }
      postTeam("addMember", { team, name });
    };
    panel.querySelectorAll("input[data-member-add]").forEach((node) =>
      node.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); addMember(node.dataset.memberAdd); }
      })
    );
    panel.querySelectorAll("[data-member-add-btn]").forEach((b) =>
      b.addEventListener("click", () => addMember(b.dataset.memberAddBtn))
    );
    // Removing a subagent only drops it from this team — a member may (and
    // usually does) belong to several teams.
    panel.querySelectorAll("[data-member-del]").forEach((b) =>
      b.addEventListener("click", () => postTeam("removeMember", { team: b.dataset.memberTeam, name: b.dataset.memberDel }))
    );

    const addTeamBtn = panel.querySelector("#set-add-team-btn");
    const teamInput = panel.querySelector("#set-add-team");
    if (addTeamBtn) {
      const add = () => {
        const name = (teamInput ? teamInput.value : "").trim();
        if (!name) { toast("Type a team name first", true); return; }
        postTeam("addTeam", { team: name });
      };
      addTeamBtn.addEventListener("click", add);
      if (teamInput) teamInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); add(); }
      });
    }
  }

  /**
   * Wire the shared `[data-act]` controls (selects, number/text inputs and
   * textareas) inside `root` to POST /settings.
   *
   * Extracted from wireSection so a plugin's settings popup persists through the
   * exact same writers as the built-in sections — a plugin only has to emit
   * markup carrying `data-act`.
   */
  function wireDataActs(root) {
    // Selects and number inputs commit on change.
    root.querySelectorAll("select[data-act]").forEach((node) =>
      node.addEventListener("change", () => {
        const act = node.dataset.act;
        if (act === "setMode") {
          postTeam("setMode", { mode: node.value });
        } else {
          postSettings(act, node.value);
        }
      })
    );

    root.querySelectorAll('input[type="number"][data-act]').forEach((node) =>
      node.addEventListener("change", () => postSettings(node.dataset.act, Number(node.value)))
    );

    // Multi-line templates commit on blur (change), like the text inputs.
    root.querySelectorAll("textarea[data-act]").forEach((node) =>
      node.addEventListener("change", () => postSettings(node.dataset.act, node.value))
    );

    // Text inputs. `setDestructiveTools` / `setSkipOrchestratorTools` are
    // comma-separated lists rendered as text, so split their value into an
    // array before posting (the server expects an array, not a string).
    const LIST_ACTS = new Set(["setDestructiveTools", "setSkipOrchestratorTools"]);
    root.querySelectorAll('input[type="text"][data-act]').forEach((node) => {
      node.addEventListener("change", () => {
        const act = node.dataset.act;
        const raw = node.value.trim();
        const value = LIST_ACTS.has(act)
          ? raw.split(",").map((s) => s.trim()).filter(Boolean)
          : raw;
        postSettings(act, value);
      });
      node.addEventListener("keydown", (e) => {
        // Enter saves immediately; blur so the single `change` handler fires
        // (prevents a double submit from keydown + change on blur).
        if (e.key === "Enter") { e.preventDefault(); node.blur(); }
      });
    });
  }

  function wireSection(sec) {
    const panel = el.content.querySelector(".settings-panel");
    if (!panel) return;

    if (sec === "keys") wireKeys(panel);
    if (sec === "agent") wireTeams(panel);
    if (sec === "plugins") wirePlugins(panel);

    wireDataActs(panel);

    panel.querySelectorAll("label.set-toggle").forEach((label) => {
      const input = label.querySelector("input[type=checkbox]");
      if (!input) return;
      // data-act lives on the label (from toggleControl); read it from there so
      // the input alone is a plain checkbox and the change handler still binds.
      const act = label.dataset.act || input.dataset.act;
      if (!act) return;
      input.addEventListener("change", () => {
        const on = input.checked;
        const lbl = label.querySelector(".set-toggle-label");
        if (act === "toggleMemory") { postTeam("toggleMemory", {}); return; }
        if (lbl) lbl.textContent = on ? "On" : "Off";
        postSettings(act, on);
      });
    });

    // Team select buttons.
    panel.querySelectorAll("[data-select]").forEach((b) =>
      b.addEventListener("click", () => postTeam("setTeam", { team: b.dataset.select }))
    );

    // Member toggles (agent on/off) and per-member model edits.
    panel.querySelectorAll('input[data-agent]').forEach((node) =>
      node.addEventListener("change", () => {
        const name = node.dataset.agent;
        const nowDisabled = !node.checked;
        postTeam("toggleAgent", { agent: name, disabled: nowDisabled });
      })
    );
    panel.querySelectorAll('select[data-member-model]').forEach((node) =>
      node.addEventListener("change", () => {
        // Per-member model writes to teams.yaml. Populate a team+member-aware
        // action through the shared writer (which supports it implicitly via
        // teams.yaml mutation), then reload to reflect the save.
        const name = node.dataset.memberModel;
        const team = node.dataset.memberTeam;
        const model = node.value.trim();
        postMemberModel(name, team, model);
      })
    );

    // Skill chips: orchestrator/subagent membership (data-dir/data-group) and
    // the separate "default pi skills" settings.json toggle (data-skill-load).
    panel.querySelectorAll(".set-chip[data-dir]").forEach((chip) =>
      chip.addEventListener("click", () => postTeam("toggleSkill", { group: chip.dataset.group, dir: chip.dataset.dir }))
    );
    panel.querySelectorAll(".set-chip[data-skill-load]").forEach((chip) =>
      chip.addEventListener("click", () => postTeam("toggleSkillSetting", { dir: chip.dataset.skillLoad }))
    );

    // Per-extension orchestrator/subagent enablement (extensions/extensions.json).
    panel.querySelectorAll("input[data-ext-flag]").forEach((node) =>
      node.addEventListener("change", () =>
        postSettings("setExtensionFlag", {
          name: node.dataset.extFlag,
          flag: node.dataset.extWhich,
          enabled: node.checked,
        })
      )
    );

    // pi packages (settings.json `packages`): remove buttons + add row.
    panel.querySelectorAll("[data-pkg-remove]").forEach((b) =>
      b.addEventListener("click", () => postSettings("removePiPackage", b.dataset.pkgRemove, "Package removed"))
    );
    const addPkgInput = $("#set-add-pkg");
    const addPkgBtn = $("#set-add-pkg-btn");
    if (addPkgInput && addPkgBtn) {
      const addPkg = () => {
        const src = addPkgInput.value.trim();
        if (!src) { toast("Type a package source first", true); return; }
        postSettings("addPiPackage", src, "Package added").then((ok) => { if (ok) addPkgInput.value = ""; });
      };
      addPkgBtn.addEventListener("click", addPkg);
      addPkgInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addPkg(); } });
    }

    // Project trust (trust.json): revoke a trusted path.
    panel.querySelectorAll("[data-trust-revoke]").forEach((b) =>
      b.addEventListener("click", () => postSettings("revokeTrust", b.dataset.trustRevoke, "Trust revoked"))
    );

    // Global instruction files: one row each; Edit opens the full-screen editor
    // for the whole file (an empty save removes it).
    panel.querySelectorAll("[data-instr-edit]").forEach((b) =>
      b.addEventListener("click", () => openInstructionEditor(b.dataset.instrEdit))
    );

    // Subagent definitions: one row each; Edit opens the full-screen markdown
    // editor for the whole agents/<file>.md.
    panel.querySelectorAll("[data-agentdef-edit]").forEach((b) =>
      b.addEventListener("click", () => openAgentDefEditor(b.dataset.agentdefEdit))
    );

    // Model chips remove + add.
    panel.querySelectorAll("[data-remove-model]").forEach((b) =>
      b.addEventListener("click", () => {
        const model = b.dataset.removeModel;
        postSettings("setEnabledModels", strList(SET.enabledModels).filter((m) => m !== model));
      })
    );
    const addModelInput = $("#set-add-model");
    const addModelBtn = $("#set-add-model-btn");
    if (addModelInput && addModelBtn) {
      const addModel = () => {
        const m = addModelInput.value.trim();
        if (!m) { toast("Pick a model first", true); return; }
        const next = [...strList(SET.enabledModels)];
        if (!next.includes(m)) next.push(m);
        postSettings("setEnabledModels", next).then(() => { if (addModelInput) addModelInput.value = ""; });
      };
      addModelBtn.addEventListener("click", addModel);
    }

    // Model-cost provider chips + search. Re-render only the row list on
    // change (not the whole section) so the search input keeps focus.
    panel.querySelectorAll(".set-cost-chip").forEach((c) =>
      c.addEventListener("click", () => {
        costProvider = c.dataset.costProv || "all";
        updateCostView();
      })
    );
    const costSearch = $("#set-cost-search");
    if (costSearch) {
      costSearch.addEventListener("input", () => {
        costQuery = costSearch.value;
        updateCostView();
      });
    }

    // Model-cost interactions, DELEGATED on the rows container. Filtering
    // (provider chip / search) re-renders the rows in place via updateCostView;
    // per-row listeners attached here would be lost with the swapped innerHTML,
    // leaving filtered rows dead. The container itself persists, so one
    // delegation keeps working across every re-filter.
    //   • click a row        → set it as the default model
    //   • click the en cell  → toggle roster membership (owns its own action)
    const costRowsEl = document.getElementById("set-cost-rows");
    if (costRowsEl) {
      const setDefault = (row) => {
        const provider = row.dataset.costProvider;
        const id = row.dataset.costId;
        const key = row.dataset.costKey;
        if (row.classList.contains("default")) {
          toast("Already the default model");
          return;
        }
        postSettings("setDefaultModelProvider", { provider, model: id }, "Default model set")
          .then(() => {
            const again = document.querySelector(`.set-cost-row[data-cost-key="${CSS.escape(key)}"]`);
            if (again) again.focus();
          });
      };
      const toggleEnabled = (btn) => {
        const key = btn.dataset.toggleEnabled;
        const list = strList(SET.enabledModels);
        const idx = list.indexOf(key);
        postSettings("setEnabledModels", idx >= 0 ? list.filter((x) => x !== key) : [...list, key],
          idx >= 0 ? "Model disabled" : "Model enabled")
          .then(() => {
            const again = document.querySelector(`.set-cost-en[data-toggle-enabled="${CSS.escape(key)}"]`);
            if (again) again.focus();
          });
      };
      costRowsEl.addEventListener("click", (e) => {
        const enBtn = e.target.closest(".set-cost-en[data-toggle-enabled]");
        if (enBtn) { toggleEnabled(enBtn); return; }
        const row = e.target.closest(".set-cost-row[data-cost-key]:not(.set-cost-head)");
        if (row) setDefault(row);
      });
      costRowsEl.addEventListener("keydown", (e) => {
        // Rows are keyboard-focusable (tabindex 0). Enter/Space on the en
        // <button> fires its native click, so only handle row-level keys.
        if (e.key !== "Enter" && e.key !== " ") return;
        if (e.target.closest(".set-cost-en")) return;
        const row = e.target.closest(".set-cost-row[data-cost-key]:not(.set-cost-head)");
        if (row) { e.preventDefault(); setDefault(row); }
      });
    }

    // Model-cost resizable columns + reset.
    initCostResize();
    const resetBtn = $("#set-cost-reset");
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        resetCostCols();
        setSection(activeSec, true);
        toast("Column widths reset");
      });
    }
  }

  // Draggable column edges for the cost table. Each handle sits on the right
  // edge of a header cell (except the last column) and, when dragged, updates
  // the table's `--cost-cols` grid template live. The widths are clamped and
  // persisted on release.
  function initCostResize() {
    const table = document.querySelector("#settings-content .set-cost-table");
    if (!table) return;
    const header = table.querySelector(".set-cost-head");
    if (!header) return;
    const hasCache = table.classList.contains("has-cache");
    const colNames = ["def", "model", "provider", "in", "out"]
      .concat(hasCache ? ["cache"] : []).concat(["context", "en"]);
    const overlay = table.querySelector(".set-cost-resizers") || Object.assign(document.createElement("div"), { className: "set-cost-resizers", "aria-hidden": "true" });
    overlay.innerHTML = "";
    if (!overlay.parentNode) table.appendChild(overlay);

    const cells = Array.from(header.children);
    const headerH = header.offsetHeight;
    const handles = [];
    for (let i = 0; i < colNames.length - 1; i++) {
      const el = document.createElement("div");
      el.className = "set-cost-resize";
      el.dataset.col = colNames[i];
      el.style.height = headerH + "px";
      overlay.appendChild(el);
      handles.push({ col: colNames[i], cell: cells[i], el });
    }

    const position = () => {
      for (const h of handles) h.el.style.left = (h.cell.offsetLeft + h.cell.offsetWidth - 3) + "px";
    };

    for (const h of handles) {
      h.el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startW = h.cell.offsetWidth;
        h.el.classList.add("active");
        document.body.classList.add("set-cost-resizing");
        const onMove = (ev) => {
          costCols[h.col] = clampColWidth(h.col, startW + (ev.clientX - startX));
          table.style.setProperty("--cost-cols", costGridTemplate(hasCache));
          position();
        };
        const onUp = () => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          document.body.classList.remove("set-cost-resizing");
          h.el.classList.remove("active");
          persistCostCols();
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
    }
    position();
  }

  // Re-render the model-cost rows, refresh the active provider chip, and keep
  // the live "N of M" count in step with the filter.
  function updateCostView() {
    const rows = document.getElementById("set-cost-rows");
    if (rows) rows.innerHTML = costRowsHtml();
    document.querySelectorAll("#settings-content .set-cost-chip").forEach((c) =>
      c.classList.toggle("active", c.dataset.costProv === costProvider)
    );
    const count = document.getElementById("set-cost-count");
    if (count) {
      const total = Number(count.dataset.total) || costModels().length;
      count.textContent = `${filteredCostModels().length} of ${total}`;
    }
  }

  // Per-member model: routes through /agent-team with a dedicated writer so the
  // change lands in teams.yaml and the rail/snapshot stay in sync. The server
  // handles a "setMemberModel" action that writes the member's model.
  async function postMemberModel(name, team, model) {
    try {
      const { res, data } = await S.api("/agent-team", {}, { action: "setMemberModel", agent: name, team, model, cwd: projectCwd() });
      if (res.ok && data) {
        SET = { ...SET, ...data };
        mergeTeamIntoSnapshot(data);
        setSection(activeSec, true);
        toast("Saved");
      } else {
        toast(data?.error || "Failed to save member model", true);
      }
    } catch (e) {
      toast(String(e?.message || e), true);
    }
  }

  // ─── Plugins ──────────────────────────────────────────────────────────────
  // Pi Scope's features (Chat, Terminal, Review, Checkpoints, Git, Single,
  // Trajectory) are plugins, and so is anything you write. This section is the
  // registry's control surface: every plugin is listed with an enable/disable
  // switch. Disabling one hides its header view and, server-side, refuses the
  // routes that plugin owns (see apps/scope-server/plugins.ts).
  function renderPlugins() {
    const snap = SET.plugins;
    const plugins = Array.isArray(snap?.plugins) ? snap.plugins : [];
    const dir = snap?.pluginsDir || "~/.pi-scope/plugins";

    const row = (p) => {
      const badges =
        `<span class="set-scope set-scope-${p.source === "builtin" ? "global" : "project"}" ` +
        `title="${esc(p.source === "builtin" ? "Bundled with Pi Scope" : "Installed by you")}">${esc(p.source)}</span>` +
        (p.core ? `<span class="set-scope set-scope-none" title="Core plugin — cannot be disabled">core</span>` : "") +
        `<span class="set-scope set-scope-none">v${esc(p.version || "0")}</span>` +
        (p.hasServer ? `<span class="set-scope set-scope-none" title="Ships a server module">server</span>` : "") +
        (p.hasClient ? `<span class="set-scope set-scope-none" title="Ships a client bundle">client</span>` : "");
      const toggle = p.core
        ? `<span class="set-chip on" title="Always enabled — hosts the plugin manager">always on</span>`
        : `<label class="set-toggle" data-plugin-toggle="${esc(p.id)}"><input type="checkbox"${p.enabled ? " checked" : ""}>` +
          `<span class="set-toggle-track"><span class="set-toggle-knob"></span></span>` +
          `<span class="set-toggle-label">${p.enabled ? "On" : "Off"}</span></label>`;
      // A plugin whose client spec declares `pluginSettings` gets a gear on its
      // row; clicking it opens a popup with the plugin's own options.
      const hasOpts = typeof window.SCOPE.Plugins?.get?.(p.id)?.pluginSettings?.render === "function";
      const gear = hasOpts
        ? `<button type="button" class="btn-sm set-plugin-cfg" data-plugin-config="${esc(p.id)}" ` +
          `title="Settings for ${esc(p.name || p.id)}">⚙ Settings</button>`
        : "";
      const control = `<span class="set-plugin-controls">${toggle}${gear}</span>`;
      const err = p.error
        ? `<div class="set-field-hint" style="color:var(--red)">load error: ${esc(p.error)}</div>`
        : "";
      return field(
        esc(p.name || p.id) + " " + badges,
        esc(p.description || "") + (p.dir ? ` <code>${esc(p.dir)}</code>` : ""),
        control
      ) + err;
    };

    const body = plugins.length
      ? plugins.map(row).join("")
      : `<div class="settings-empty-sub">No plugins found. Add one under <code>${esc(dir)}</code>.</div>`;

    return (
      `<div class="settings-group">` +
      `<div class="settings-group-kicker">Plugins</div>` +
      `<h2 class="settings-group-title">features ${scopeBadge("global")}</h2>` +
      `<div class="settings-intro">Every Pi Scope feature is a plugin. Toggle one off to remove its view and refuse its server routes. ` +
      `Drop your own plugin under <code>${esc(dir)}</code> — a folder with <code>plugin.json</code> plus an optional ` +
      `<code>server.js</code> and <code>client.js</code> — and it shows up here. See <code>plugins/README.md</code>.</div>` +
      `<div style="margin-bottom:10px"><button type="button" class="btn-sm" data-plugin-reload="1" ` +
      `title="Re-scan the plugin directories and re-activate server modules">⟳ Reload plugins</button></div>` +
      body +
      `</div>`
    );
  }

  function wirePlugins(panel) {
    panel.querySelectorAll("label[data-plugin-toggle]").forEach((label) => {
      const input = label.querySelector("input[type=checkbox]");
      if (!input) return;
      input.addEventListener("change", async () => {
        const id = label.dataset.pluginToggle;
        const on = input.checked;
        const lbl = label.querySelector(".set-toggle-label");
        if (lbl) lbl.textContent = on ? "On" : "Off";
        const { res, data } = await S.api("/plugins", {}, { action: on ? "enable" : "disable", id });
        if (!res.ok || !data) {
          toast(data?.error || "Failed to update plugin", true);
          input.checked = !on;
          if (lbl) lbl.textContent = !on ? "On" : "Off";
          return;
        }
        SET.plugins = data;
        toast(on ? "Plugin enabled" : "Plugin disabled");
        // The header nav is rendered from the client registry — resync it so a
        // disabled view's button disappears immediately.
        try { await window.SCOPE.Plugins?.sync?.(); } catch { /* nav stays put */ }
      });
    });
    panel.querySelectorAll("[data-plugin-reload]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const { res, data } = await S.api("/plugins", {}, { action: "reload" });
        if (!res.ok || !data) { toast(data?.error || "Reload failed", true); return; }
        SET.plugins = data;
        try { await window.SCOPE.Plugins?.sync?.(); } catch { /* nav stays put */ }
        setSection(activeSec, true);
        toast("Plugins reloaded");
      })
    );
    panel.querySelectorAll("[data-plugin-config]").forEach((btn) =>
      btn.addEventListener("click", () => openPluginSettings(btn.dataset.pluginConfig))
    );
  }

  // ─── Plugin settings popup ────────────────────────────────────────────────
  /**
   * A plugin may declare `pluginSettings = { render, onMount }` on its client
   * spec. Its row in Settings → Plugins then shows a gear that opens this popup.
   * `render(ctx)` returns the markup and `onMount(panel, ctx)` wires it; `ctx`
   * hands the plugin the settings snapshot, the shared `field()` helper, `esc`
   * and `wire()` — so its controls persist through the same POST /settings
   * writers every built-in section uses. Distinct from `view.settings`, which
   * contributes a whole left-nav section instead.
   */
  function pluginSettingsCtx() {
    return { settings: SET, field, esc, selectControl, wire: wireDataActs, toast, postSettings };
  }

  function openPluginSettings(id) {
    const p = window.SCOPE.Plugins?.get?.(id);
    const render = p?.pluginSettings?.render;
    if (!p || typeof render !== "function") { toast("This plugin has no settings", true); return; }
    closePluginSettings();

    const ctx = pluginSettingsCtx();
    let markup = "";
    try { markup = render(ctx) || ""; }
    catch (e) {
      console.error("[settings] plugin settings render failed", e);
      toast("Could not open plugin settings", true);
      return;
    }

    const backdrop = document.createElement("div");
    backdrop.className = "plugin-settings-backdrop";
    backdrop.id = "plugin-settings-backdrop";
    backdrop.innerHTML =
      `<div class="plugin-settings-modal" role="dialog" aria-modal="true" ` +
        `aria-label="${esc(p.name || p.id)} settings">` +
        `<div class="plugin-settings-head">` +
          `<span class="plugin-settings-title">${esc(p.name || p.id)} ` +
            `<span class="plugin-settings-sub">settings</span></span>` +
          `<button type="button" class="plugin-settings-close" aria-label="Close">×</button>` +
        `</div>` +
        `<div class="plugin-settings-body">${markup}</div>` +
      `</div>`;
    document.body.appendChild(backdrop);

    // Backdrop click (outside the modal) and Escape close it.
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closePluginSettings(); });
    backdrop.querySelector(".plugin-settings-close")?.addEventListener("click", closePluginSettings);
    document.addEventListener("keydown", pluginSettingsEsc);

    try { p.pluginSettings.onMount?.(backdrop.querySelector(".plugin-settings-body"), ctx); }
    catch (e) { console.error("[settings] plugin settings onMount failed", e); }
  }

  function closePluginSettings() {
    document.getElementById("plugin-settings-backdrop")?.remove();
    document.removeEventListener("keydown", pluginSettingsEsc);
  }

  function pluginSettingsEsc(e) {
    if (e.key === "Escape") closePluginSettings();
  }

  // ─── Toast ────────────────────────────────────────────────────────────────
  function toast(msg, isError) {
    let t = $("#settings-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "settings-toast";
      t.className = "settings-toast";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.toggle("err", !!isError);
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────
  function init() {
    cache();
    if (el.nav) el.nav.querySelectorAll(".settings-nav-item").forEach((b) =>
      b.addEventListener("click", () => setSection(b.dataset.sec))
    );
    // Plugin-contributed sections appear once the client registry has synced
    // with the server's plugin config.
    mountPluginSettingsNav();
    window.addEventListener("scope:plugins-ready", () => {
      mountPluginSettingsNav();
      // A user plugin's options appear only once its client bundle has loaded —
      // refresh the list so a late plugin gets its gear too.
      if (activeSec === "plugins" && SET) setSection("plugins", true);
    });
  }

  function onView() {
    if (!el.nav || !el.content) cache();
    if (!loaded) { loaded = true; showLoading(); }
    load();
  }

  window.__settingsOnView = onView;
  window.__settingsRetry = function () { loaded = false; onView(); };

  // app.js restores the initial view with setView(STATE.view) while it executes,
  // which is BEFORE this file is parsed — so its __settingsOnView call was a
  // no-op and a boot that lands directly on Settings sat on "Loading settings…"
  // forever. Re-issue that notification now that the hook exists (this matters
  // for the automatic reload after removing a workspace from Settings).
  if (state?.view === "settings") onView();

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
