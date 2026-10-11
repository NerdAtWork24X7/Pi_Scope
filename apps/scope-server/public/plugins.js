/**
 * plugins.js — Pi Scope client-side plugin host.
 *
 * Everything the header can show is described by a *plugin spec*. Built-in
 * feature plugins register themselves synchronously in `plugins-builtin.js`
 * (which loads before this file has finished its DOM work), so the app boots
 * with a full nav even when the server has no plugin host — that keeps the UI
 * working against an older server or a test fixture. After boot this file
 * reconciles against `GET /plugins`:
 *
 *   • a built-in plugin the server reports as disabled is hidden from the nav;
 *   • a plugin declared in a manifest with a `clientUrl` is loaded dynamically
 *     and may register its own view / settings section.
 *
 * Exposed as `window.SCOPE.Plugins`. The API is intentionally tiny so a plugin
 * author can read it in one sitting — see plugins/README.md.
 */
(function () {
  const SPECS = new Map();
  const ORDER = [];

  /** Where the user's own nav order lives (a list of plugin ids). */
  const NAV_ORDER_KEY = "scope-nav-order";

  function escHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escAttr(s) {
    return escHtml(s).replace(/"/g, "&quot;");
  }

  /**
   * Register (or merge into) a plugin spec.
   *
   * @param {object} spec
   *   id           unique id, also the view name for `setView(id)`
   *   name         display name
   *   description  one-line summary shown in Settings → Plugins
   *   enabled      default true; overridden by the server's plugin config
   *   core         true → cannot be disabled (e.g. Settings itself)
   *   layout       "chat" | "settings" → body class the view needs
   *   sidebar      whether the shared Workspaces rail renders in <aside>
   *   nav          { label, order, group, title, onClick, slot, icon }
   *                  slot:"right" → icon button in the header's action cluster
   *   view         { pane, display, session, onShow, onHide, onSessions,
   *                  onEvent, onCwd, settings }
   *   pluginSettings  { render(ctx), onMount(panel, ctx) } → a gear on this
   *                  plugin's row in Settings → Plugins opening a settings popup
   */
  /**
   * A plugin may declare its own view pane by selector (`view.pane`) that does
   * not exist in index.html yet — create it inside <main>, then hand it to the
   * plugin's `view.render(pane)` once so the plugin can build its DOM. Built-in
   * plugins point at panes that already exist, so this is a no-op for them.
   */
  function ensurePane(spec) {
    const sel = spec?.view?.pane;
    if (!sel || sel.charAt(0) !== "#") return null;
    let pane = document.querySelector(sel);
    if (!pane) {
      const main = document.querySelector("main");
      if (!main) return null;
      pane = document.createElement("section");
      pane.id = sel.slice(1);
      pane.className = "plugin-pane";
      pane.style.cssText = "display:none;flex-direction:column;flex:1;overflow:hidden";
      main.appendChild(pane);
    }
    if (typeof spec.view.render === "function" && !spec.__rendered) {
      spec.__rendered = true;
      try { spec.view.render(pane); }
      catch (err) { console.error(`[plugins] render() failed for ${spec.id}`, err); }
    }
    return pane;
  }

  function register(spec) {
    if (!spec || !spec.id) {
      console.warn("[plugins] register() needs a spec with an id", spec);
      return null;
    }
    const existing = SPECS.get(spec.id);
    if (existing) {
      Object.assign(existing, spec);
      ensurePane(existing);
      renderNav();
      return existing;
    }
    const normalized = Object.assign({ enabled: true, source: "user" }, spec);
    SPECS.set(normalized.id, normalized);
    ORDER.push(normalized.id);
    ensurePane(normalized);
    renderNav();
    return normalized;
  }

  const get = (id) => SPECS.get(id) || null;
  const all = () => ORDER.map((id) => SPECS.get(id)).filter(Boolean);
  const views = () => all().filter((p) => p.view && p.enabled !== false);
  const currentViewId = () => window.__SCOPE_STATE?.view ?? null;
  const activeView = () => get(currentViewId());

  /** The user's saved nav order (a list of plugin ids), or [] when they have
   *  never rearranged the tabs. */
  function savedNavOrder() {
    try {
      const v = JSON.parse(localStorage.getItem(NAV_ORDER_KEY) || "null");
      return Array.isArray(v) ? v : [];
    } catch { return []; }
  }

  /** Persist the user's nav order (the drawn tab ids, left to right). */
  function saveNavOrder(ids) {
    try { localStorage.setItem(NAV_ORDER_KEY, JSON.stringify(ids)); } catch { /* private mode */ }
  }

  function visibleNav() {
    const items = all().filter((p) => p.nav && p.enabled !== false);
    const saved = savedNavOrder();
    // No custom order yet: the declared `nav.order` is the whole story.
    if (!saved.length) return items.sort((a, b) => (a.nav.order ?? 1000) - (b.nav.order ?? 1000));
    // The user's order wins; ids it does not know (a plugin added since) keep
    // their declared order and land at the end.
    const rank = new Map(saved.map((id, i) => [id, i]));
    const known = items.filter((p) => rank.has(p.id)).sort((a, b) => rank.get(a.id) - rank.get(b.id));
    const rest = items.filter((p) => !rank.has(p.id)).sort((a, b) => (a.nav.order ?? 1000) - (b.nav.order ?? 1000));
    return known.concat(rest);
  }

  // ─── Nav rendering ────────────────────────────────────────────────────────

  function renderNav() {
    const host = document.getElementById("view-toggle");
    if (!host) return;
    const items = visibleNav();
    const cur = currentViewId();

    // A nav item may ask for `slot: "right"` — it then renders as an icon button
    // in the header's top-right action cluster (#header-actions) instead of the
    // centre view toggle. Settings uses this to sit beside the live status. When
    // no such slot exists (older markup) those items fall back to the nav.
    const rightHost = document.getElementById("header-actions");
    const rightItems = rightHost ? items.filter((p) => p.nav.slot === "right") : [];
    const navItems = rightItems.length ? items.filter((p) => !rightItems.includes(p)) : items;

    let html = "";
    let lastGroup = null;
    for (const p of navItems) {
      const group = p.nav.group || "main";
      if (lastGroup !== null && group !== lastGroup) {
        html += '<span class="view-toggle-sep" aria-hidden="true"></span>';
      }
      lastGroup = group;
      const cls = "view-btn" + (p.id === cur ? " active" : "");
      const title = p.nav.title || p.description || p.name || p.id;
      html += `<button id="btn-${escAttr(p.id)}" class="${cls}" data-plugin="${escAttr(p.id)}" ` +
        `type="button" draggable="true" title="${escAttr(title)}">${escHtml(p.nav.label || p.name || p.id)}</button>`;
    }
    host.innerHTML = html;

    if (rightHost) {
      let rhtml = "";
      for (const p of rightItems) {
        const title = p.nav.title || p.description || p.name || p.id;
        const cls = "header-icon-btn" + (p.id === cur ? " active" : "");
        // Icon-only button: `nav.icon` is trusted markup from the plugin spec (a
        // user plugin already runs arbitrary code); the label becomes its a11y
        // name when no icon is supplied.
        const inner = p.nav.icon || escHtml(p.nav.label || p.name || p.id);
        rhtml += `<button id="btn-${escAttr(p.id)}" class="${cls}" data-plugin="${escAttr(p.id)}" ` +
          `type="button" title="${escAttr(title)}" aria-label="${escAttr(p.nav.label || p.name || p.id)}">${inner}</button>`;
      }
      rightHost.innerHTML = rhtml;
    }

    for (const p of items) {
      const btn = document.getElementById(`btn-${p.id}`);
      if (!btn) continue;
      btn.addEventListener("click", () => {
        if (typeof p.nav.onClick === "function") p.nav.onClick();
        else if (typeof window.setView === "function") window.setView(p.id);
      });
    }

    enableNavReorder(host);
  }

  /**
   * Make the centre view tabs reorderable by drag and drop. A drop writes the
   * new order to localStorage (see saveNavOrder) and repaints; visibleNav()
   * then serves that order to every caller. Bound once per host element, since
   * renderNav() rebuilds the buttons but not the container.
   */
  function enableNavReorder(host) {
    if (host.dataset.reorder === "1") return;
    host.dataset.reorder = "1";
    let dragId = null;

    const buttons = () => [...host.querySelectorAll(".view-btn[data-plugin]")];
    const clearMarks = () => {
      for (const b of buttons()) b.classList.remove("nav-dragging", "nav-drop-before", "nav-drop-after");
    };
    // The button a drop at (x, y) would land before, or null to append at the
    // end. Reading order, so it holds whether the tabs sit in one row or wrap.
    const dropBefore = (x, y) => {
      for (const b of buttons()) {
        if (b.dataset.plugin === dragId) continue;
        const r = b.getBoundingClientRect();
        if (y < r.top) return b;
        if (y <= r.bottom && x < r.left + r.width / 2) return b;
      }
      return null;
    };

    host.addEventListener("dragstart", (e) => {
      const btn = e.target.closest && e.target.closest(".view-btn[data-plugin]");
      if (!btn || btn.dataset.plugin == null) return;
      dragId = btn.dataset.plugin;
      btn.classList.add("nav-dragging");
      try { e.dataTransfer.setData("text/plain", dragId); e.dataTransfer.effectAllowed = "move"; }
      catch { /* older engines */ }
    });

    host.addEventListener("dragover", (e) => {
      if (!dragId) return;
      e.preventDefault();
      const target = dropBefore(e.clientX, e.clientY);
      const movable = buttons().filter((b) => b.dataset.plugin !== dragId);
      const last = movable[movable.length - 1] || null;
      for (const b of buttons()) {
        b.classList.toggle("nav-drop-before", b === target);
        b.classList.toggle("nav-drop-after", !target && b === last);
      }
      try { e.dataTransfer.dropEffect = "move"; } catch { /* ignore */ }
    });

    host.addEventListener("drop", (e) => {
      if (!dragId) return;
      e.preventDefault();
      const target = dropBefore(e.clientX, e.clientY);
      const ids = buttons().map((b) => b.dataset.plugin).filter((id) => id && id !== dragId);
      const at = target ? ids.indexOf(target.dataset.plugin) : ids.length;
      ids.splice(at < 0 ? ids.length : at, 0, dragId);
      dragId = null;
      clearMarks();
      saveNavOrder(ids);
      renderNav();
    });

    host.addEventListener("dragend", () => { dragId = null; clearMarks(); });
  }

  /** Re-tint the nav buttons for the current view without rebuilding the DOM. */
  function markActive() {
    const cur = currentViewId();
    for (const p of all()) {
      const btn = document.getElementById(`btn-${p.id}`);
      if (btn) btn.classList.toggle("active", p.id === cur);
    }
  }

  // ─── Server reconciliation ────────────────────────────────────────────────

  function authHeaders() {
    return typeof window.authHeaders === "function" ? window.authHeaders() : {};
  }

  function fallbackView() {
    const enabled = visibleNav();
    if (!enabled.length) return null;
    const chat = enabled.find((p) => p.id === "chat");
    return (chat || enabled[0]).id;
  }

  /** If the view we're on was just disabled, move to a sensible neighbour. */
  function enforceActiveView() {
    const cur = currentViewId();
    if (!cur) return;
    const spec = get(cur);
    if (spec && spec.enabled !== false) return;
    const next = fallbackView();
    if (next && typeof window.setView === "function") window.setView(next);
  }

  function loadClientBundle(plugin) {
    return new Promise((resolve) => {
      if (!plugin.clientUrl) return resolve(false);
      const url = new URL(plugin.clientUrl, location.origin);
      const token = window.__SCOPE_STATE?.token;
      if (token) url.searchParams.set("token", token);
      const script = document.createElement("script");
      script.src = url.toString();
      script.dataset.plugin = plugin.id;
      script.onload = () => resolve(true);
      script.onerror = () => {
        console.warn(`[plugins] failed to load client bundle for ${plugin.id}`);
        resolve(false);
      };
      document.head.appendChild(script);
    });
  }

  // A deep link to a *user* plugin's view (e.g. `#view=my-plugin`) cannot be
  // resolved by app.js at boot — the client bundle has not loaded yet, so the
  // view is not in the registry and the app falls back to the default. Capture
  // the requested id now (before app.js rewrites the hash) and apply it once
  // `sync()` has loaded the bundles.
  const initialHashView = (() => {
    const m = /(?:^#|&)view=([^&]+)/.exec(location.hash || "");
    return m ? decodeURIComponent(m[1]) : null;
  })();

  let synced = false;

  async function sync() {
    let snap = null;
    try {
      const res = await fetch(window.apiUrl("/plugins", {}), { headers: authHeaders() });
      if (res.ok) snap = await res.json();
    } catch { /* server unreachable or no plugin host — keep built-in defaults */ }
    if (!snap || !Array.isArray(snap.plugins)) return;

    const byId = new Map(snap.plugins.map((p) => [p.id, p]));
    for (const spec of all()) {
      const srv = byId.get(spec.id);
      if (srv) {
        if (!spec.core) spec.enabled = srv.enabled !== false;
        spec.serverMeta = srv;
        if (srv.name) spec.name = spec.name || srv.name;
        if (srv.description) spec.description = spec.description || srv.description;
      } else if (spec.source === "builtin") {
        // Not present on the server → the feature is not installed/known.
        if (!spec.core) spec.enabled = false;
      }
    }

    const pending = snap.plugins.filter((p) => p.clientUrl && p.enabled && !get(p.id));
    for (const p of pending) await loadClientBundle(p);

    const firstSync = !synced;
    renderNav();
    enforceActiveView();
    // Only on the first reconcile: app.js may have discarded a deep link to a
    // plugin whose bundle had not loaded yet. Later syncs (e.g. after a toggle
    // in Settings) must NOT drag the user back to the original hash view.
    if (firstSync) {
      const wanted = initialHashView && get(initialHashView);
      if (wanted && wanted.enabled !== false && currentViewId() !== initialHashView) {
        window.setView?.(initialHashView);
      }
    }
    synced = true;
    window.__pluginsReady?.();
    window.dispatchEvent(new CustomEvent("scope:plugins-ready", { detail: snapshot() }));
  }

  /** Best-effort local snapshot (server metadata merged with client specs). */
  function snapshot() {
    return {
      plugins: all().map((p) => ({
        id: p.id,
        name: p.name || p.id,
        description: p.description || "",
        source: p.source || "user",
        core: !!p.core,
        enabled: p.enabled !== false,
        hasView: !!p.view,
        hasSettings: !!p.view?.settings,
        serverMeta: p.serverMeta || null,
        dir: p.serverMeta?.dir || null,
      })),
    };
  }

  window.SCOPE = window.SCOPE || {};
  window.SCOPE.Plugins = {
    register, get, all, views, currentViewId, activeView,
    renderNav, markActive, sync, snapshot,
    isEnabled: (id) => get(id)?.enabled !== false,
    isSynced: () => synced,
  };
})();
