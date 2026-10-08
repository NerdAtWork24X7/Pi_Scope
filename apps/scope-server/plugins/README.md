# Pi Scope plugins

Everything you see in the header — **Chat, Terminal, Review, Checkpoints, Git,
Single, Trajectory, Settings** — is a plugin, and so is anything you write. A
plugin can

* own a **view** (a nav button plus the pane it renders in),
* add **HTTP routes** to the server,
* **observe every event** the server ingests,
* keep its own **persistent JSON state**, and
* contribute **options** (a gear popup on its row, or a whole Settings section).

Plugins are enabled and disabled from **Settings → Plugins**. Disabling a
feature hides its view and, on the server, refuses the routes that feature owns.

This document is written for an agent (or a human) about to write one. Every
snippet below is copy-paste runnable; the recipe at the top has been executed
end to end against the real server.

---

## Quick start

**1. Create the directory and three files**

```bash
mkdir -p ~/.pi-scope/plugins/my-plugin && cd ~/.pi-scope/plugins/my-plugin
```

`plugin.json`

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "description": "Counts ingested events by type and shows them in its own view.",
  "version": "1.0.0",
  "author": "you",
  "server": "server.js",
  "client": "client.js",
  "serverRoutes": ["/my-plugin"],
  "nav": { "label": "My Plugin", "order": 75, "group": "timeline" }
}
```

`server.js`

```js
export function activate(api) {
  api.log("activated");

  // Every event ingested through POST /events (and /capture/*) arrives here.
  api.onEvent((evt) => {
    const counts = api.store.get("byType", {});
    counts[evt.type] = (counts[evt.type] || 0) + 1;
    api.store.set("byType", counts); // one small JSON write per event
  });

  // `api.route` compiles to an anchored regex: ":name" is one path segment, a
  // lone "*" segment is a wildcard. Return a value → 200 JSON.
  api.route("GET", "/my-plugin/stats", () => {
    const counts = api.store.get("byType", {});
    const byType = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => ({ type, count }));
    return { ok: true, total: byType.reduce((n, r) => n + r.count, 0), byType };
  });
}
```

`client.js`

```js
(function () {
  const P = window.SCOPE.Plugins;
  const esc = (s) => window.SCOPE.escapeHtml(s);

  P.register({
    id: "my-plugin",
    name: "My Plugin",
    description: "Counts ingested events by type.",
    nav: { label: "My Plugin", order: 75, group: "timeline" },
    view: {
      pane: "#my-plugin-pane", // created under <main> for you if absent
      display: "flex",
      session: "none",        // rail click does nothing for this view
      render(pane) {
        pane.innerHTML =
          '<div class="pane-header"><span style="font-weight:500">My Plugin</span>' +
          '<span id="mp-status" style="color:var(--muted);font-size:13.5px"></span>' +
          '<button class="btn-sm" id="mp-refresh" type="button" style="margin-left:auto">↻ refresh</button></div>' +
          '<div id="mp-body" style="padding:14px;overflow:auto"><div class="empty-state">Loading…</div></div>';

        const status = pane.querySelector("#mp-status");
        const body = pane.querySelector("#mp-body");

        async function refresh() {
          status.textContent = "loading…";
          try {
            const { res, data } = await window.SCOPE.api("/my-plugin/stats");
            if (!res.ok || !data?.ok) throw new Error(data?.error || `HTTP ${res.status}`);
            status.textContent = `${data.total} events ingested`;
            body.innerHTML = data.byType.length
              ? '<table style="border-collapse:collapse;font-size:13px">' + data.byType.map((r) =>
                  `<tr><td style="padding:2px 14px 2px 0">${esc(r.type)}</td>` +
                  `<td style="padding:2px 0;color:var(--muted)">${r.count}</td></tr>`).join("") + "</table>"
              : '<div class="empty-state">No events yet — POST one to /events.</div>';
          } catch (err) {
            status.textContent = "";
            body.innerHTML = `<div class="empty-state"><span class="icon">⚠</span>${esc(err.message || err)}</div>`;
          }
        }

        pane.querySelector("#mp-refresh").addEventListener("click", refresh);
        pane.__refresh = refresh; // onShow calls this
      },
      onShow() {
        document.getElementById("my-plugin-pane")?.__refresh?.();
      },
    },
  });
})();
```

**2. Reload the host** — Settings → Plugins → **⟳ Reload plugins**
(`POST /plugins { action: "reload" }`). The nav button appears immediately; the
server logs `[plugins] activated my-plugin (user)`.

**3. Feed it an event and check the route**

```bash
curl -s -X POST localhost:43190/events -H 'content-type: application/json' \
  -d '{"event_id":"e1","session_id":"s1","seq":0,"ts":"2026-10-06T00:00:00Z","type":"tool_call","payload":{"name":"bash"}}'
curl -s "localhost:43190/my-plugin/stats?token=$SCOPE_TOKEN"
```

Read routes are token-gated; `?token=` works, an `Authorization: Bearer` header
is better. (The `POST /events` path is exempt while the server is bound to
loopback.)

Done: header button → view → own HTTP route → own persistent counters.

---

## Where plugins live

| Root | Purpose |
|---|---|
| `apps/scope-server/plugins/<id>/` | Built-in feature plugins shipped with the app (`plugin.json` + their route handler in `server.ts`; the client specs live in `public/plugins-builtin.js`). |
| `~/.pi-scope/plugins/<id>/` | **Your plugins.** Override the location with `SCOPE_PLUGINS_DIR` (**must be an absolute path** — see [Gotchas](#gotchas-and-hard-rules)). |

Enable/disable state is persisted to `~/.pi-scope/plugins/plugins.json`. Per
plugin state written through `api.store` lands in `~/.pi-scope/plugins/.data/`.

A user plugin with the same `id` as a built-in **overrides** it — that is how you
swap out a shipped feature without patching the app.

Built-ins keep their server half beside the manifest: the Files, Git and
Checkpoints routes live in `plugins/files/server.ts`, `plugins/git/server.ts` and
`plugins/checkpoints/server.ts`. Those modules are ordinary plugins — they just
receive a few extra host primitives through `api.kit` (below) instead of
re-importing `server.ts`.

The server discovers both roots at boot and re-scans on **Settings → Plugins →
Reload plugins**.

---

## Anatomy of a plugin

```
~/.pi-scope/plugins/my-plugin/
├── plugin.json      # manifest (required)
├── server.js        # optional server module (ESM)
└── client.js        # optional client bundle (plain browser script)
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
  "core": false,
  "server": "server.js",
  "client": "client.js",
  "serverRoutes": ["/my-plugin"],
  "nav": { "label": "My Plugin", "order": 75, "group": "timeline" },
  "ui": { "icon": "▤" }
}
```

* `id` — must match `/^[a-z0-9][a-z0-9._-]*$/i`, unique; also the view name for
  `setView("<id>")`. An invalid id makes the host **skip the plugin silently**
  apart from a `[plugins] invalid plugin id` line in the server log.
* `server` / `client` — entry files relative to the plugin directory. The server
  entry must resolve **inside** the plugin directory (no `../`). User plugins are
  plain `.js`: ESM `export` works because Node ≥ 22 detects module syntax; name
  the file `server.mjs` if you want to be explicit.
* `serverRoutes` — URL prefixes the plugin owns. While the plugin is **disabled**
  the server returns `403 { error: "plugin disabled: <id>", plugin: "<id>" }` for
  those prefixes, so disabling a feature really turns it off rather than just
  hiding its button. User plugins get the same gate (verified), on top of their
  own `api.route` handlers simply not matching while disabled.
* `nav` — `label` / `order` / `group` for the server-side snapshot (Settings list
  ordering). The client spec's `nav` is what actually renders the button; keep
  the two in sync. Built-in groups: `session` (10–50), `timeline` (60–75),
  `settings` (80). A new group gets a separator in the nav.
* `defaultEnabled: false` — ship a plugin off by default.
* `core: true` — cannot be disabled (used by Settings itself). The API rejects
  `action: "disable"` with an error.
* `ui` — free-form; echoed to the client as `serverMeta.ui`.

### `server.js`

`activate(api)` is the only required export (a default export works too). The API:

| Member | Description |
|---|---|
| `api.id` · `api.dir` · `api.source` | identity (`"builtin"` / `"user"`) and on-disk location |
| `api.kit` | shared host primitives — see below. Currently populated for *every* plugin (the host passes one kit to all of them), but it is an internal contract: feature-detect, never assume |
| `api.validateCwd(cwd)` | validate a caller-supplied cwd against the server's allowed roots |
| `api.log(...args)` | namespaced logging (`[plugin:<id>] …`) |
| `api.route(method, path, handler)` | register an HTTP route; `handler(ctx)` may return a value (JSON) or a `Response` |
| `api.onEvent(handler)` | called for every ingested event |
| `api.store.get(key, fallback)` / `.set(key, value)` / `.all()` | JSON state persisted to `<pluginsDir>/.data/<id>.json` (mode `0600`) |

A route handler's `ctx` is
`{ url, method, params, req, readBody, json, cwd }`:

* `url` — the parsed `URL` (use `ctx.url.searchParams`).
* `params` — `:name` captures, already `decodeURIComponent`-ed.
* `readBody(req)` → `Promise<string>`; `json(body, status?)` → `Response`.
* `cwd` — the raw `?cwd=` query value (`string | null`), **not** validated. Pass it
  through `api.validateCwd` before touching the filesystem.

Route semantics (compiled by `compileRoute` in `plugins.ts`):

* The pattern is **anchored**: `/a/b` matches only `/a/b`, never `/a/b/c`. Use a
  trailing lone segment `*` (`/a/b/*`) for a prefix match — `*` is only a
  wildcard as a whole segment, and it lands in `params.wildcard`.
* `:name` matches exactly one segment (`([^/]+)`).
* Plugin routes are matched **after every core route**, so a plugin can never
  shadow one — pick your own namespace (`/my-plugin/…`).
* First match wins; routes of a disabled plugin are skipped.
* Return value → `ctx.json(result ?? { ok: true })` (200). Return a `Response`
  to control status/headers. A thrown error is caught, logged, and returned as
  `500 { error: "<message>" }` — it never takes the server down.

```js
api.route("POST", "/my-plugin/items/:id", async (ctx) => {
  const body = JSON.parse(await ctx.readBody(ctx.req) || "{}");
  const id = ctx.params.id;
  if (!id) return ctx.json({ error: "id required" }, 400);
  return { ok: true, id, body };
});
```

#### Events — `api.onEvent(handler)`

The handler receives a normalized `ObsEvent`
(`shared/types.ts`): `{ event_id, session_id, seq, ts, type, pool, tags, cwd?, payload, provider?, model?, agent_name?, session_file?, parent_session_id? }`.
Fired for everything ingested via `POST /events` and the `/capture/*` routes,
whether or not a browser is connected. A throwing hook is caught and logged; it
cannot break ingestion or other plugins.

#### State — `api.store`

* Cached in memory per process; `set` rewrites the whole JSON file synchronously.
  **Do not call it per event in a hot loop** — batch (e.g. flush on a timer or
  every N events) or keep counters in memory and persist on a debounce.
* `get(key, fallback)` returns the fallback only when the key is absent.
* The file survives server restarts and plugin disable/enable cycles (verified).

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
**`api.kit` is an internal contract**, not a public plugin API: it exists because
the built-ins need it, and it changes with the host. Treat every member as
optional and feature-detect (`api.kit?.gitTry`). If you need something it does
not expose, `import` it from `node:*`, or add it to the `pluginKit` object in
`server.ts`.

### `client.js`

The host serves your bundle at `/plugins/file/<id>/<client>` and injects it as a
`<script>` (with `?token=`) once the plugin is enabled and its spec is not
already registered. All it has to do is call `SCOPE.Plugins.register(spec)`.

```js
(function () {
  window.SCOPE.Plugins.register({
    id: "my-plugin",
    name: "My Plugin",
    description: "What it does, one line.",
    nav: { label: "My Plugin", order: 75, group: "timeline" },
    view: {
      pane: "#my-plugin-pane",   // created for you inside <main> if absent
      display: "flex",
      session: "none",
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
| `enabled` | default `true`; the server's config wins after `sync()` |
| `core` | `true` → cannot be disabled (used by Settings itself) |
| `layout` | `"chat"` / `"settings"` — the body class the view needs |
| `sidebar` | `false` → the shared Workspaces rail does not render beside this view |
| `nav` | `{ label, order, group, title, onClick, slot, icon }` — omit to add no button. `slot: "right"` renders an icon button in the header's top-right cluster (beside the live status) instead of the centre view toggle; `icon` is trusted markup (inline SVG) shown in place of the label |
| `view` | `{ pane, display, session, sseSession, cdOnCwd, render, onShow, onHide, onSessions, onEvent, onStats, onReconnect, onCwd, settings }` |
| `pluginSettings` | `{ render(ctx), onMount(panel, ctx) }` — a **⚙** button on this plugin's row in **Settings → Plugins**, opening a popup with `render(ctx)`'s markup |

View hooks:

* `render(pane)` — build your DOM **once**; the pane is created under `<main>` if
  the selector does not exist in `index.html`. Stash refresh functions on the
  pane (`pane.__refresh`) so `onShow` can call them.
* `onShow` / `onHide` — view entered / left. `onShow` is the only one guaranteed
  to run at start, since the view may boot already active.
* `onSessions` — a fresh session list arrived while this view is active.
* `onEvent(evt)` — a live SSE event arrived while this view is active (set
  `sseSession: true` to receive only the selected session's events).
* `onStats(sid, stats)` — per-session token/cost stats arrived.
* `onReconnect()` — the SSE stream reconnected; re-sync your data.
* `onCwd(cwd)` — the shared working directory changed.
* `session` — what a session click in the Workspaces rail does:
  `"none"` (ignore), `"select"` (select the session, Single/Trajectory style),
  `"chat"` (resume it in the Chat view), anything else / omitted → point the
  shared `cwd` at the session's workspace (`"workspace"` behaviour).
* `cdOnCwd: true` — when the shared cwd changes, `cd` your own shell
  (`window.__terminalCd` is what Terminal implements).
* `settings = { label, render }` — contribute a whole **section** to the Settings
  left nav. `render()` takes no args and returns markup.

#### `pluginSettings` — a popup on the plugin's row

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
`ctx.field(label, sub, control, hint)` helper, `ctx.esc`, `ctx.selectControl(options, value, attrs)`
(a `<select class="set-select">` that commits on change, like the built-in
sections), `ctx.toast`, `ctx.postSettings(action, value)` — and `ctx.wire(panel)`,
which binds every
`[data-act]` control to the same `POST /settings` writers the built-in sections
use, so persistence is free (`data-act` **is** the settings key; text/number
inputs commit on `change`, Enter blurs to save). `onMount` is optional; call
`ctx.wire` from it if you render controls. Use `pluginSettings` for a few
options, `view.settings` for a full section.

#### Client helpers available to your bundle

| Helper | Description |
|---|---|
| `window.SCOPE.api(path, params?, body?)` | `fetch` with the auth header + JSON handling → `{ res, data }`; a `body` implies `POST` |
| `window.SCOPE.escapeHtml(s)` | HTML-escape **every** interpolation of server or event data |
| `window.SCOPE.toast(msg, "err"\|"warn")` | transient bottom-centent notification |
| `window.SCOPE.fmtTs` `fmtRel` `fmtTokens` `fmtDuration` `trunc` `shortId` `hashString` `toolNamePillHTML` `summaryFor` `renderDetailHTML` | the same formatters the built-in views use |
| `window.setView(id)` | switch views (used by your `nav.onClick`) |
| `window.__SCOPE_STATE` | `{ view, token, selectedSessionId, … }` — read-only-ish |
| `scope:plugins-ready` event | fires after every `Plugins.sync()`; `detail` is the merged snapshot |

---

## Integration lifecycle

1. **Boot** — the server discovers and activates every enabled plugin with a
   server entry, then serves the UI. `public/plugins.js` registers the built-in
   specs synchronously, then `sync()` reconciles against `GET /plugins`: hides
   disabled views, dynamically loads user `client.js` bundles (sequentially, in
   Settings-list order), re-renders the nav, and finally fires
   `scope:plugins-ready`.
2. **Deep links** — `#view=my-plugin` works for a user plugin: the host captures
   the requested id before `app.js` rewrites the hash and applies it once the
   bundle has registered.
3. **Enable / disable** — Settings → Plugins toggles `POST /plugins
   { action: "enable"|"disable", id }`. Disabling tears down the plugin's routes
   and event hooks and persists to `plugins.json`; enabling re-activates it.
   Disabling the view you are on moves you to a neighbour (`chat` if present).
4. **Reload** — `POST /plugins { action: "reload" }` re-scans both roots,
   deactivates everything and re-activates.

### The edit loop (what needs what)

| You changed | Do this |
|---|---|
| `plugin.json` | Settings → **⟳ Reload plugins** |
| `server.js` — **any** edit | **Restart the server.** `reload` re-runs `activate(api)`, but Node's ESM cache hands back the already-imported module, so the re-registered routes are still the old functions (verified: an edited route body keeps answering with the old payload after a reload) |
| `client.js` | Hard-reload the **browser**. `sync()` skips bundles whose id is already registered |

---

## Styling your view

Reuse the app's own classes so a plugin looks native in both themes
(`public/styles.css`): `.pane-header` (sticky view header) · `.btn-sm` ·
`.empty-state` (+ `.empty-state .icon` for the glyph) · `.set-field`,
`.set-input`, `.set-select`, `.set-toggle` (Settings forms) · `.pill` /
`.tool-name-pill` · `.view-btn`, `.header-icon-btn` (nav) · `.exit-chip`,
`.evt-*` row classes for timelines. Colours must come from CSS variables —
`--text`, `--muted`, `--accent`, `--accent-soft`, `--green`, `--red`, `--orange`,
`--border`, `--surface`, `--surface-2` — never hard-coded hex, so light/dark and
the DeepSeek palette both work. Keep `overflow:auto` on the scrolling body and put the header outside it,
or long content will push the header off-screen. Design three states: loading,
empty, and error (see `refresh()` above).

---

## Gotchas and hard rules

* **`SCOPE_PLUGINS_DIR` must be absolute.** With a relative path, `record.dir`
  is relative while entry paths are resolved to absolute, so activation fails
  with `server entry escapes the plugin directory` and `/plugins/file/<id>/…`
  404s — the plugin is listed but silently dead. Same trap applies to any
  relative path you pass for a plugin root.
* **No `../` in the server entry path** (same check) and **no path escape** in
  `/plugins/file/` (resolved and rejected server-side).
* **Namespaces are yours.** Core routes win every match; a plugin route named
  `/sessions/...` is dead code.
* **Route patterns are anchored.** `/x` ≠ prefix; write `/x/*`.
* **Auth is on.** Every read route is token-gated. In the browser always go
  through `SCOPE.api` (or append `?token=` for a `<script>`/`<img>` src).
* **Disable ≠ hide only.** With `serverRoutes` declared, disabled means `403`
  from the server; that is the intended way to ship a capability switch.
* **`api.kit` is internal** — it is handed to every plugin, but feature-detect
  every member (`api.kit?.gitTry`) rather than depending on it.
* **ESM cache**: a server entry is imported once per process, so Reload never
  picks up `server.js` edits. Restart the server (see the edit loop above).
* **Storage is a whole-file synchronous write.** Debounce it.
* **One spec per id.** `register()` merges into an existing spec rather than
  replacing it, and the host loads a bundle at most once per id.
* **`view.render` runs once**, at registration — not on every `setView`. Refresh
  in `onShow`, not in `render`.
* **Escape everything.** `renderDetailHTML`-style helpers already escape; raw
  `innerHTML` with event/session text does not.

---

## Verify your plugin

**Server side** (from the plugin host's point of view):

```bash
curl -s "localhost:43190/plugins?token=$TOKEN" | jq '.plugins[] | select(.id=="my-plugin")'
# → source, enabled, hasServer, hasClient, clientUrl, error, serverRoutes, dir
```

* `error` is non-null → activation threw. The message is in the server log too
  (`[plugins] failed to activate my-plugin: …`).
* `hasClient:false` → the `client` path in `plugin.json` does not exist.
* Missing from the list → no/invalid `plugin.json`, or a bad `id`.

**End to end** — the repo ships an e2e harness that installs a plugin into a temp
`SCOPE_PLUGINS_DIR`, boots the real server and drives a real browser
(`apps/scope-server/test/plugins.e2e.test.mjs`, run with
`node --test apps/scope-server/test/plugins.e2e.test.mjs`). Point `EXAMPLE_PLUGIN`
at your directory to reuse it as a template.

**In the browser**: `#btn-<id>` in the header, `window.setView("<id>")` switches
to it, the view renders, and the console shows no errors. `SCOPE.Plugins.snapshot()`
lists everything the client registry knows.

### Troubleshooting

| Symptom | Cause |
|---|---|
| `error: "server entry escapes the plugin directory"` | relative `SCOPE_PLUGINS_DIR`, or an entry path with `../` |
| `error: "server entry has no activate() export"` | missing `export function activate` / `export default` |
| Button never appears | `client` missing in the manifest, `id` mismatch between manifest and spec, plugin disabled, or the browser was not hard-reloaded |
| Route returns 404 while enabled | anchored pattern (needs `/x/*`), wrong method, or a core route of the same path |
| Route returns 403 `plugin disabled` | plugin is off in Settings → Plugins, or persisted as disabled in `plugins.json` |
| Bundle 401/404 in devtools | token missing from the URL, or path escaping the plugin dir |
| Server edits have no effect | restart the server (ESM cache) |
| `SCOPE.Plugins.sync()` logs nothing new | the id is already registered; hard-reload the page |

---

## The shipped example

`examples/plugins/hello-insights/` is the same three-file shape (a server route
that counts events by type plus a view that renders the table). It is also what
the e2e test installs, so it is the fastest starting point:

```bash
mkdir -p ~/.pi-scope/plugins
cp -r examples/plugins/hello-insights ~/.pi-scope/plugins/
```

Then Settings → Plugins → **⟳ Reload plugins**. The **Insights** button appears
in the header.

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
* `apps/scope-server/public/settings.js` — Settings → Plugins list, the gear
  popup host and `ctx.field` / `ctx.wire`.