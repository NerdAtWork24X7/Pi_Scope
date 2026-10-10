/**
 * plugins-builtin.js — the built-in feature plugins.
 *
 * Each entry here turns one of Pi Scope's shipped features into a plugin spec:
 * the header button it owns, the pane it lives in, the page-aware hooks it
 * answers (session click, workspace click, live events, session refresh) and
 * whether the shared Workspaces rail renders beside it.
 *
 * They register synchronously before app.js boots, so `setView("<id>")` and the
 * nav are complete from the first frame. Their *server* side is declared in
 * `apps/scope-server/plugins/<id>/plugin.json` (route prefixes + metadata),
 * which is what makes them individually switchable from Settings → Plugins.
 *
 * A user plugin does not need to touch this file — it ships its own client
 * bundle and calls `SCOPE.Plugins.register(...)`. See plugins/README.md.
 */
(function () {
  const P = window.SCOPE.Plugins;
  if (!P) {
    console.error("[plugins] host missing — plugins.js must load first");
    return;
  }

  const def = (id, spec) => P.register(Object.assign({ id, source: "builtin", enabled: true }, spec));

  // Gear glyph for the Settings nav button (below). Inline SVG so it needs no
  // asset load and inherits the button colour via `currentColor`.
  const SETTINGS_ICON =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="3"/>' +
    '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>' +
    '</svg>';

  // The hook helpers below are exposed by the feature scripts (terminal.js,
  // files.js, …). They are referenced lazily so load order does not matter.

  def("chat", {
    name: "Chat",
    description: "Talk to your agent, manage workspaces and the agent team, and stream turns live.",
    layout: "chat",
    sidebar: false,
    nav: {
      label: "Chat",
      order: 10,
      group: "session",
      title: "Reload the chat page (refetches the latest chat code)",
      onClick: () => window.reloadChat?.(),
    },
    view: {
      pane: "#chat-pane",
      display: "flex",
      session: "chat",
      onShow: () => window.__chatOnView?.(),
      onSessions: () => window.__chatOnSessions?.(),
    },
  });

  def("terminal", {
    name: "Terminal",
    description: "A real shell on the agent host, embedded in the browser over WebSocket.",
    nav: { label: "Terminal", order: 20, group: "session" },
    view: {
      pane: "#terminal-pane",
      display: "",
      session: "workspace",
      // Selecting a workspace on this view cds the live shell.
      cdOnCwd: true,
      onShow: () => window.__terminalOnShow?.(),
      onHide: () => window.__terminalOnHide?.(),
    },
  });

  def("files", {
    name: "Review",
    description: "Scan the working tree, diff any file side by side, and edit it in place.",
    nav: { label: "Review", order: 30, group: "session" },
    view: {
      pane: "#files-pane",
      display: "",
      session: "workspace",
      onShow: () => window.__filesOnView?.(),
      onSessions: () => window.__filesOnSessions?.(),
      onCwd: () => window.__filesOnView?.(),
    },
  });

  def("checkpoints", {
    name: "Checkpoints",
    description: "Git-backed save points: label a moment and restore it with one click.",
    nav: { label: "Checkpoints", order: 40, group: "session" },
    view: {
      pane: "#checkpoints-pane",
      display: "flex",
      session: "workspace",
      onShow: () => window.__checkpointsOnView?.(),
      onSessions: () => window.__checkpointsOnSessions?.(),
      onCwd: () => window.__checkpointsOnView?.(),
    },
  });

  def("git", {
    name: "Git",
    description: "A full git client — stage, commit, history graph, branches, stashes, remotes.",
    nav: { label: "Git", order: 50, group: "session" },
    view: {
      pane: "#git-pane",
      display: "flex",
      session: "workspace",
      onShow: () => window.__gitOnView?.(),
      onSessions: () => window.__gitOnSessions?.(),
      onCwd: () => window.__gitOnView?.(),
    },
    // Settings → Plugins → Git → ⚙ Settings: the commit-message model and
    // prompt template behind the Git view's "✨ generate" button. Opening the
    // popup is the host's job (settings.js openPluginSettings); the fields just
    // carry `data-act`, so they persist through the shared /settings writers.
    pluginSettings: {
      render(ctx) {
        const sr = ctx.settings || {};
        const current = sr.gitCommitModel || "";
        const fallback = (sr.settingsRaw && sr.settingsRaw.defaultModel) || "";
        // Offer the enabled-models roster — the same "available" list the Chat
        // composer uses — so the picked model is one pi can actually resolve.
        // The full modelsMeta catalogue also carries provider caches (e.g. the
        // kilo catalogue) that pi can't run, and picking one made `pi --model`
        // silently fall back to the default. Only fall back to the full
        // catalogue when the roster is empty.
        const enabled = Array.isArray(sr.enabledModels) ? sr.enabledModels.map(String).filter(Boolean) : [];
        const catalogue = Object.keys(sr.modelsMeta || {}).sort();
        const list = [...new Set(enabled.length ? enabled : catalogue)];
        const modelOptions = [
          { value: "", label: fallback ? `(agent default — ${fallback})` : "(agent default)" },
          ...list.map((m) => ({ value: m, label: m })),
        ];
        // A configured model that is no longer offered stays selectable, so the
        // control never silently drops the current value.
        if (current && !list.includes(current)) modelOptions.push({ value: current, label: current });
        return (
          ctx.field("Commit message model", "used by Git → ✨ generate",
            ctx.selectControl(modelOptions, current, 'data-act="setGitCommitModel"')) +
          ctx.field("Commit message template", "how the generated message should look",
            `<textarea class="set-input" rows="7" data-act="setGitCommitTemplate" spellcheck="false" ` +
            `style="width:100%;min-height:120px;resize:vertical" ` +
            `placeholder="${ctx.esc(sr.gitCommitTemplateDefault || "")}">${ctx.esc(sr.gitCommitTemplate || "")}</textarea>`) +
          `<div class="set-field-hint">Placeholders: <code>{{branch}}</code> ` +
          `<code>{{source}}</code> <code>{{files}}</code> <code>{{diff}}</code>. ` +
          `Leave empty to use the default template (shown as the placeholder).</div>`
        );
      },
      onMount(panel, ctx) { ctx.wire(panel); },
    },
  });

  def("single", {
    name: "Single",
    description: "The complete forensic event timeline for a session, live over SSE.",
    nav: { label: "Single", order: 60, group: "timeline" },
    view: {
      pane: "#single-pane",
      display: "",
      session: "select",
      sseSession: true,
      onShow: () => window.__singleOnShow?.(),
      onEvent: (evt) => window.__singleOnEvent?.(evt),
    },
  });

  def("trajectory", {
    name: "Trajectory",
    description: "Fold events into turns with per-record time, cost and token columns.",
    nav: { label: "Trajectory", order: 70, group: "timeline" },
    view: {
      pane: "#trajectory-pane",
      display: "flex",
      session: "select",
      sseSession: true,
      onShow: () => window.__trajectoryOnView?.(),
      onSessions: () => window.__trajectoryOnSessions?.(),
      onEvent: (evt) => window.__trajectoryOnEvent?.(evt),
      onStats: (sid, stats) => window.__trajectoryStatsUpdate?.(sid, stats),
      onReconnect: () => window.__trajectoryOnReconnect?.(),
    },
  });

  // NOTE: the Office view is not here. It is a *standalone* plugin — its client
  // bundle, stylesheet and server module all live in
  // apps/scope-server/plugins/office/, and the host loads the bundle from its
  // manifest (plugins/office/plugin.json) exactly like a third-party plugin's.

  // Settings is core: it hosts the Plugins manager, so it can never be turned
  // off from inside itself. Its nav button is a gear in a circular box parked in
  // the header's top-right cluster next to the live status (`slot: "right"`),
  // not in the centre view toggle.
  def("settings", {
    name: "Settings",
    description: "Configure the agent, teams, models, skills, API keys and plugins.",
    core: true,
    layout: "settings",
    sidebar: false,
    nav: { label: "Settings", order: 80, group: "system", slot: "right", icon: SETTINGS_ICON },
    view: {
      pane: "#settings-pane",
      display: "flex",
      session: "none",
      onShow: () => window.__settingsOnView?.(),
    },
  });
})();
