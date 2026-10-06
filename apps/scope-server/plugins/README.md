# Pi Scope plugins

Everything you see in the header — **Chat, Terminal, Review, Checkpoints, Git,
Single, Trajectory, Settings** — is a plugin, and so is anything you write. A
plugin can

* own a **view** (a nav button plus the pane it renders in),
* add **HTTP routes** to the server,
* **observe every event** the server ingests,
* keep its own **persistent JSON state**, and
* contribute a **Settings section**.

Plugins are enabled and disabled from **Settings → Plugins**. Disabling a feature
hides its view and, on the server, refuses the routes that feature owns.

---

## Where plugins live

| Root | Purpose |
|---|---|
| `apps/scope-server/plugins/<id>/` | Built-in feature plugins shipped with the app (`plugin.json` + their route handler in `server.ts`; the client specs live in `public/plugins-builtin.js`). |
| `~/.pi/scope/plugins/<id>/` | **Your plugins.** Override the location with `SCOPE_PLUGINS_DIR`. |

Enable/disable state is persisted to `~/.pi/scope/plugins/plugins.json`. Per
plugin state written through `api.store` lands in `~/.pi/scope/plugins/.data/`.

A user plugin with the same `id` as a built-in **overrides** it — that is how you
swap out a shipped feature without patching the app.

Built-ins keep their server half beside the manifest: the Files, Git and
Checkpoints routes live in `plugins/files/server.ts`, `plugins/git/server.ts` and
`plugins/checkpoints/server.ts`. Those modules are ordinary plugins — they just
receive a few extra host primitives through `api.kit` (below) instead of
re-importing `server.ts`.

The server discovers both roots at boot and re-scans on **Settings → Plugins →
Reload plugins** (`POST /plugins { action: "reload" }`).

---

## Anatomy of a plugin

```
~/.pi/scope/plugins/my-plugin/
├── plugin.json      # manifest (required)
├── server.js        # optional server module
└── client.js        # optional client bundle
```

### `plugin.json`

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "description": "What it does, one line.",
  "version": "1.0.0",
  "author": "you",
  "defaultEnabled": true,
  "server": "server.js",
  "client": "client.js",
  "serverRoutes": ["/my-plugin"],
  "nav": { "label": "My Plugin", "order": 75, "group": "timeline" }
}
```

* `id` — `[a-z0-9._-]`, unique; also the view name for `setView("<id>")`.
* `server` / `client` — entry files relative to the plugin directory. Built-ins
  point `server` at their sibling `server.ts`; user plugins are plain `.js`.
* `serverRoutes` — URL prefixes the plugin owns. While the plugin is **disabled**
  the server returns `403` for those prefixes, so disabling a feature really
  turns it off rather than just hiding its button.
* `defaultEnabled: false` — ship a plugin off by default.

### `server.js`

```js
export function activate(api) {
  api.log("hello from my-plugin");

  // Observe every event ingested through POST /events.
  api.onEvent((evt) => {
    const n = api.store.get("count", 0);
    api.store.set("count", n + 1);
  });

  // Add an HTTP route. `:name` becomes ctx.params.name.
  api.route("GET", "/my-plugin/stats", (ctx) => {
    return { ok: true, count: api.store.get("count", 0) };
  });
}
```

`activate(api)` is the only required export (a default export works too). The API:

| Member | Description |
|---|---|
| `api.id` · `api.dir` · `api.source` | identity and on-disk location |
| `api.kit` | shared host primitives (built-ins only — see below); treat as optional |
| `api.log(...args)` | namespaced logging |
| `api.route(method, path, handler)` | register an HTTP route; `handler(ctx)` may return a value (JSON) or a `Response` |
| `api.onEvent(handler)` | called for every ingested event |
| `api.store.get(key, fallback)` / `.set(key, value)` / `.all()` | JSON state persisted to `<pluginsDir>/.data/<id>.json` |

A route handler's `ctx` is `{ url, method, params, req, readBody, json, cwd }`.
Routes are checked **after** the built-in routes, so a plugin cannot shadow a
core route. A route path may end in `*` to match a prefix.

#### `api.kit` — shared host primitives

Built-in plugins need the same helpers the core server uses: `git`/`gitTry`, the
JSON/text responders, `validateCwd`, the settings reader, the commit-message
generator, and so on. They cannot `import` them from `server.ts`, because that
module is still evaluating while plugins activate — the import would hand back a
half-initialised module. The host therefore passes a `kit` object on `api` and
the plugin destructures what it needs:

```js
export function activate(api) {
  const { gitTry, jsonResponse, validateCwd } = api.kit;
  api.route("GET", "/my-plugin/status", (ctx) => {
    const cwd = validateCwd(ctx.url.searchParams.get("cwd") ?? "");
    if (!cwd) return jsonResponse({ error: "invalid cwd" }, 400);
    return jsonResponse({ ok: gitTry(cwd, ["status", "--short"]).out });
  });
}
```

The kit exposes `fs`, `path`, `jsonResponse`, `textResponse`, `readBody`,
`intParam`, `intOrNull`, `validateCwd`, `readSettingsJson`,
`DEFAULT_COMMIT_TEMPLATE`, `generateCommitMessage`, `git`, `gitTry`,
`gitConfigArgs`, `ensureGitRepo`, `resolveWithinCwd`, `cleanPaths`,
`rejectOptionLike`, `parsePorcelainLine`, `porcelainStatus`, `buildRepoGraph`.
`api.kit` is `undefined` for user plugins — always guard or treat it as optional.

### `client.js`

```js
(function () {
  window.SCOPE.Plugins.register({
    id: "my-plugin",
    name: "My Plugin",
    description: "What it does, one line.",
    // `slot: "right"` + `icon` → a circular icon button in the header's top-right
    // cluster (next to the live status) rather than a text button in the nav.
    nav: { label: "My Plugin", order: 75, group: "timeline" },
    view: {
      pane: "#my-plugin-pane",   // created for you inside <main> if absent
      display: "flex",
      session: "none",           // "none" | "select" | "chat" | "workspace"
      render(pane) { pane.innerHTML = "<div class='empty-state'>Hello</div>"; },
      onShow() { /* refresh when the view opens */ },
    },
  });
})();
```

`SCOPE.Plugins.register(spec)` fields:

| Field | Description |
|---|---|
| `id` · `name` · `description` | identity, shown in the nav tooltip and Settings |
| `enabled` | default `true`; the server's config wins |
| `core` | `true` → cannot be disabled (used by Settings itself) |
| `layout` | `"chat"` / `"settings"` — the body class the view needs |
| `sidebar` | `false` → the shared Workspaces rail does not render beside this view |
| `nav` | `{ label, order, group, title, onClick, slot, icon }` — omit to add no button. `slot: "right"` renders an icon button in the header's top-right cluster (beside the live status) instead of the centre view toggle; `icon` is markup (e.g. inline SVG) shown in place of the label |
| `view` | `{ pane, display, session, sseSession, cdOnCwd, render, onShow, onHide, onSessions, onEvent, onStats, onReconnect, onCwd, settings }` |
| `pluginSettings` | `{ render(ctx), onMount(panel, ctx) }` — adds a **⚙ Settings** button to this plugin's row in **Settings → Plugins** that opens a popup with `render(ctx)`'s markup. `ctx` is `{ settings, field, esc, wire, toast, postSettings }`. Distinct from `view.settings`, which contributes a whole section to the Settings left nav |

View hooks:

* `render(pane)` — build your DOM once; the pane is created under `<main>` if the
  selector does not exist in `index.html`.
* `onShow` / `onHide` — called on view enter/leave.
* `onSessions` — a fresh session list arrived while this view is active.
* `onEvent(evt)` — a live SSE event arrived while this view is active.
* `onCwd(cwd)` — the shared working directory changed.
* `settings = { label, render }` — contribute a **section** to the Settings left nav.

### `pluginSettings` — a popup on the plugin's row

A plugin with its own options can add them to the **Settings → Plugins** list
instead of taking a whole nav section:

```js
pluginSettings: {
  render(ctx) {
    return ctx.field("My option", "a hint",
      `<input type="text" class="set-input" data-act="setMyOption" ` +
      `value="${ctx.esc(ctx.settings.myOption || "")}">`);
  },
  onMount(panel, ctx) { ctx.wire(panel); },
}
```

The host renders a gear on the plugin's row; clicking it opens a modal with
`render(ctx)`. `ctx` gives you the settings snapshot (`ctx.settings`), the shared
`ctx.field(label, sub, control, hint)` helper, `ctx.esc`, `ctx.toast` — and
`ctx.wire(panel)`, which binds every `[data-act]` control to the same
`POST /settings` writers the built-in sections use, so persistence is free.
`onMount` is optional; call `ctx.wire` from it if you render controls.

Fetch with the shared helper: `window.SCOPE.api(path, params, body)` returns
`{ res, data }` and already carries the auth token.

---

## Install the example

`examples/plugins/hello-insights/` is a complete, working plugin (a server route
that counts events by type plus a view that renders the table).

```bash
mkdir -p ~/.pi/scope/plugins
cp -r examples/plugins/hello-insights ~/.pi/scope/plugins/
```

Then open **Settings → Plugins**, click **Reload plugins**, and enable
**Insights** if it is off. The **Insights** button appears in the header.

---

## How the pieces fit

```
plugin.json ─┬─► server (plugins.ts)  ── routes · event hooks · storage · config
             │
             └─► client (plugins.js)   ── nav · view panes · hooks
                                 └─► app.js setView() is registry-driven
                                       rail.js page-aware clicks read the registry
```

* `apps/scope-server/plugins.ts` — server plugin host (discovery, activation,
  route registry, gating, storage).
* `apps/scope-server/public/plugins.js` — client plugin host / registry.
* `apps/scope-server/public/plugins-builtin.js` — the built-in feature specs.
