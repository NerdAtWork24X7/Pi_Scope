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
    agent: () => renderAgent(),
    teams: () => renderTeams(),
    models: () => renderModels(),
    skills: () => renderSkills(),
    extensions: () => renderExtensions(),
    workspaces: () => renderWorkspaces(),
    pi: () => renderPi(),
  };

  function renderSection(sec) {
    if (!SET) { showLoading(); return; }
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
  // settings.json (~/.pi/agent/settings.json). Mirrors where each section's
  // writes actually land — see the per-action writers in server.ts.
  function scopeBadge(scope) {
    const project = scope === "project";
    return (
      `<span class="set-scope set-scope-${project ? "project" : "global"}" ` +
      `title="${project
        ? "Saved in this workspace's .pi/settings (agent-team-config.json / teams.yaml)"
        : "Saved in the global ~/.pi/agent/settings.json"}">` +
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
      `<h2 class="settings-group-title">pi agent ${scopeBadge("project")}</h2>` +
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

    let teamHtml = "";
    if (!order.length) {
      teamHtml = `<div class="settings-empty-sub">No teams defined in teams.yaml.</div>`;
    } else {
      for (const tn of order) {
        const members = teams[tn] || [];
        const isActive = tn === activeTeam;
        const activeCount = members.filter((m) => m.active !== false && !disabled.has((m.name || "").toLowerCase())).length;
        teamHtml +=
          `<div class="set-team${isActive ? " active" : ""}" data-team="${esc(tn)}">` +
          `<div class="set-team-head"><span class="set-team-name">${esc(tn)}</span>` +
          `<span class="set-team-count">${activeCount}/${members.length} active</span>` +
          (isActive ? `<span class="set-team-pill">active</span>` : `<button type="button" class="btn-sm set-team-select" data-select="${esc(tn)}">Activate</button>`) +
          `</div>` +
          `<div class="set-members">` +
          members.map((m) => {
            const name = m.name || "";
            const off = disabled.has(name.toLowerCase()) || m.active === false;
            const model = m.model || "";
            return (
              `<div class="set-member">` +
              `<label class="set-member-toggle"><input type="checkbox" data-agent="${esc(name)}" data-disabled="${off}"${off ? "" : " checked"}>` +
              `<span class="set-toggle-track sm"><span class="set-toggle-knob"></span></span></label>` +
              `<span class="set-member-name">${esc(name)}</span>` +
              `<input type="text" class="set-input set-member-model" value="${esc(model)}" placeholder="model (e.g. provider/model)" data-member-model="${esc(name)}">` +
              `</div>`
            );
          }).join("") +
          `</div></div>`;
      }
    }

    return (
      `<div class="settings-group">` +
      `<div class="settings-group-kicker">Teams</div>` +
      `<h2 class="settings-group-title">agent teams ${scopeBadge("project")}</h2>` +
      `<div class="settings-intro">Teams come from <code>~/.pi/agent/agents/teams.yaml</code>. Activate a team, toggle which subagents are enabled, and set a per-agent model. Members without an explicit <code>active: false</code> are on.</div>` +
      teamHtml +
      `<div class="settings-group-div"></div>` +
      `<div class="settings-group-kicker">Tool policy</div>` +
      `<div class="settings-intro">Tools the agent team may not invoke (left) and tools the orchestrator skips before dispatching to subagents (right). One comma-separated list each.</div>` +
      field("Destructive tools", "blocked by name",
        `<input type="text" class="set-input" value="${esc(strList(cr.destructiveTools).join(", "))}" data-act="setDestructiveTools">`) +
      field("Skip orchestrator tools", "not run by the orchestrator",
        `<input type="text" class="set-input" value="${esc(strList(cr.skipOrchestratorTools).join(", "))}" data-act="setSkipOrchestratorTools">`) +
      `</div>`
    );
  }

  // ─── Models section ───────────────────────────────────────────────────────
  function renderModels() {
    const sr = SET.settingsRaw || {};
    const enabled = strList(SET.enabledModels);
    const defaultModel = fText(sr.defaultModel, "");
    const defaultProvider = fText(sr.defaultProvider, "");
    const thinking = fText(sr.defaultThinkingLevel, "high");
    const meta = SET.modelsMeta || {};

    // Known model ids as presentable options (provider-qualified).
    const known = Object.keys(meta).sort();
    const providerOptions = [...new Set(known.map((m) => (meta[m] && meta[m].provider) || m.split("/")[0]))]
      .filter(Boolean).sort();

    const thinks = strList(SET.thinkingLevels).map((l) => ({ value: l, label: l }));

    return (
      `<div class="settings-group">` +
      `<div class="settings-group-kicker">Defaults</div>` +
      `<h2 class="settings-group-title">models & inference ${scopeBadge("global")}</h2>` +
      field("Default model", "used when no session model matches",
        `<input type="text" class="set-input" value="${esc(defaultModel)}" list="set-model-list" data-act="setDefaultModel">`) +
      `<datalist id="set-model-list">${known.map((m) => `<option value="${esc(m)}">`).join("")}</datalist>` +
      field("Default provider", "preferred provider key",
        `<input type="text" class="set-input" value="${esc(defaultProvider)}" list="set-prov-list" data-act="setDefaultProvider">`) +
      `<datalist id="set-prov-list">${providerOptions.map((p) => `<option value="${esc(p)}">`).join("")}</datalist>` +
      field("Thinking level", "resolved at agent start", selectControl(thinks, thinking, 'data-act="setDefaultThinkingLevel"')) +
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
      field("Add model", "provider/model id",
        `<span class="set-input-wrap"><input type="text" class="set-input" id="set-add-model" list="set-model-list" placeholder="provider/model"><button type="button" class="btn-sm" id="set-add-model-btn">Add</button></span>`) +
      `<div class="settings-group-div"></div>` +
      `<div class="settings-group-kicker">Memory</div>` +
      field("Memory model", "powers the memory summarizer; (default) falls back to the settings default model when memory is enabled",
        selectControl(
          [{ value: "", label: "(default)" }, ...enabled.map((m) => ({ value: m, label: m }))],
          SET.memoryModel || "",
          'data-act="setMemoryModel"'
        )) +
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
        `<div class="settings-empty-sub">No skills discovered in <code>~/.pi/agent/skills</code>.</div></div>`;
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
    return (
      `<div class="settings-group">` +
      `<div class="settings-group-kicker">Skills</div>` +
      `<h2 class="settings-group-title">capabilities ${scopeBadge("project")}</h2>` +
      `<div class="settings-intro">Toggle a skill on for the orchestrator, subagents, both, or neither. Membership persists in <code>agent-team-config.json</code>.</div>` +
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
    return (
      `<div class="settings-group">` +
      `<div class="settings-group-kicker">Extensions</div>` +
      `<h2 class="settings-group-title">loaded extensions ${scopeBadge("global")}</h2>` +
      `<div class="settings-intro">Extensions listed in <code>settings.json</code>. Toggle one to enable or disable it; <code>+</code> enables, <code>-</code> disables.</div>` +
      `<div class="set-chips">` +
      exts.map((ex) =>
        `<button type="button" class="set-chip${ex.enabled ? " on" : ""}" data-path="${esc(ex.path)}">` +
        `<span class="set-chip-dot"></span><span class="set-chip-name">${esc(ex.name)}</span></button>`
      ).join("") +
      `</div></div>`
    );
  }

  // ─── Workspaces ───────────────────────────────────────────────────────────
  function renderWorkspaces() {
    const ws = strList(SET.chatWorkspaces);
    const addErr = `<div class="settings-empty-sub" id="set-ws-err"></div>`;
    return (
      `<div class="settings-group">` +
      `<div class="settings-group-kicker">Workspaces</div>` +
      `<h2 class="settings-group-title">chat workspaces ${scopeBadge("project")}</h2>` +
      `<div class="settings-intro">Directories available in the Chat view's workspace rail. Session-derived workspaces you remove are remembered in <code>chatWorkspacesRemoved</code>.</div>` +
      `<div class="set-ws-list">` +
      ws.map((w) =>
        `<div class="set-ws"><span class="set-ws-path">${esc(w)}</span>` +
        `<button type="button" class="set-ws-x" data-remove-ws="${esc(w)}" aria-label="Remove ${esc(w)}">×</button></div>`
      ).join("") +
      (ws.length ? "" : `<div class="settings-empty-sub">No workspaces added.</div>`) +
      `</div>` +
      field("Add workspace", "must exist on disk",
        `<span class="set-input-wrap"><input type="text" class="set-input" id="set-add-ws" placeholder="/absolute/path"><button type="button" class="btn-sm" id="set-add-ws-btn">Add</button></span>`, addErr) +
      `</div>`
    );
  }

  // ─── pi section ───────────────────────────────────────────────────────────
  function renderPi() {
    const sr = SET.settingsRaw || {};
    const term = sr.terminal || {};
    const comp = sr.compaction || {};
    return (
      `<div class="settings-group">` +
      `<div class="settings-group-kicker">pi settings.json</div>` +
      `<h2 class="settings-group-title">pi coding agent ${scopeBadge("global")}</h2>` +
      field("Theme", "pi terminal theme", `<input type="text" class="set-input" value="${esc(fText(sr.theme, "cyberpunk"))}" data-act="setTheme">`) +
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
      `</div>`
    );
  }

  // ─── Wiring ───────────────────────────────────────────────────────────────
  function wireSection(sec) {
    const panel = el.content.querySelector(".settings-panel");
    if (!panel) return;

    // Selects and number inputs commit on change.
    panel.querySelectorAll("select[data-act]").forEach((node) =>
      node.addEventListener("change", () => {
        const act = node.dataset.act;
        if (act === "setMode") {
          postTeam("setMode", { mode: node.value });
        } else {
          postSettings(act, node.value);
        }
      })
    );

    panel.querySelectorAll('input[type="number"][data-act]').forEach((node) =>
      node.addEventListener("change", () => postSettings(node.dataset.act, Number(node.value)))
    );

    // Text inputs. `setDestructiveTools` / `setSkipOrchestratorTools` are
    // comma-separated lists rendered as text, so split their value into an
    // array before posting (the server expects an array, not a string).
    const LIST_ACTS = new Set(["setDestructiveTools", "setSkipOrchestratorTools"]);
    panel.querySelectorAll('input[type="text"][data-act]').forEach((node) => {
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
    panel.querySelectorAll('input[data-member-model]').forEach((node) =>
      node.addEventListener("change", () => {
        // Per-member model writes to teams.yaml. Populate a team+member-aware
        // action through the shared writer (which supports it implicitly via
        // teams.yaml mutation), then reload to reflect the save.
        const name = node.dataset.memberModel;
        const model = node.value.trim();
        postMemberModel(name, model);
      })
    );

    // Skill chips.
    panel.querySelectorAll(".set-chip[data-dir]").forEach((chip) =>
      chip.addEventListener("click", () => postTeam("toggleSkill", { group: chip.dataset.group, dir: chip.dataset.dir }))
    );

    // Extension chips.
    panel.querySelectorAll(".set-chip[data-path]").forEach((chip) =>
      chip.addEventListener("click", () => postTeam("toggleExtension", { path: chip.dataset.path }))
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
        if (!m) return;
        const next = [...strList(SET.enabledModels)];
        if (!next.includes(m)) next.push(m);
        postSettings("setEnabledModels", next).then(() => { if (addModelInput) addModelInput.value = ""; });
      };
      addModelBtn.addEventListener("click", addModel);
      addModelInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addModel(); } });
    }

    // Workspace remove + add.
    panel.querySelectorAll("[data-remove-ws]").forEach((b) =>
      b.addEventListener("click", () => postTeam("removeWorkspace", { path: b.dataset.removeWs }))
    );
    const addWsInput = $("#set-add-ws");
    const addWsBtn = $("#set-add-ws-btn");
    if (addWsInput && addWsBtn) {
      const addWs = async () => {
        const p = addWsInput.value.trim();
        if (!p) return;
        const { res, data } = await S.api("/agent-team", {}, { action: "addWorkspace", path: p, cwd: projectCwd() });
        if (res.ok && data) {
          SET = { ...SET, ...data };
          mergeTeamIntoSnapshot(data);
          setSection(activeSec, true);
          toast("Workspace added");
          if (addWsInput) addWsInput.value = "";
        } else {
          const err = $("#set-ws-err");
          if (err) err.textContent = data?.error || `HTTP ${res.status}`;
        }
      };
      addWsBtn.addEventListener("click", addWs);
      addWsInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addWs(); } });
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
  async function postMemberModel(name, model) {
    try {
      const { res, data } = await S.api("/agent-team", {}, { action: "setMemberModel", agent: name, model, cwd: projectCwd() });
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
  }

  function onView() {
    if (!el.nav || !el.content) cache();
    if (!loaded) { loaded = true; showLoading(); }
    load();
  }

  window.__settingsOnView = onView;
  window.__settingsRetry = function () { loaded = false; onView(); };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
