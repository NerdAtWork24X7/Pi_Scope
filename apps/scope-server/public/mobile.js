// mobile.js — the phone layout client.
//
// Served with mobile.html for phone entries (see wantsMobileDocument in
// server.ts). It is a small, purpose-built companion to the desktop app: a
// sessions drawer, the selected session's transcript (recorded + live), and a
// composer that talks to pi through the SAME `/chat` NDJSON protocol the
// desktop Chat view consumes — so a turn started here is just a normal chat run
// (the desktop, or another phone, can attach to it). The same drawer starts a
// new session (workspace, model, agent team, mode) and deletes one, both
// through the same routes the desktop uses.
//
// Why a separate client instead of a responsive shell: the phone is for
// watching, steering and starting ONE agent, not for the terminal/git/files/
// office surfaces, and the desktop bundle is ~26k lines of script + 9.6k lines
// of CSS.
// Shipping all of it to a phone to then hide most of it is the "full app mirror"
// this replaces — the phone downloads helpers.js, this file and one stylesheet.
//
// IIFE-wrapped: it shares `window.SCOPE` (helpers.js) but owns its own DOM.

(function () {
  "use strict";

  const H = window.SCOPE || {};
  const $ = (s) => document.querySelector(s);
  const esc = (s) => (typeof H.escapeHtml === "function" ? H.escapeHtml(s) : String(s ?? ""));
  const trunc = (s, n) => (typeof H.trunc === "function" ? H.trunc(s, n) : String(s ?? ""));
  const shortId = (id) => (typeof H.shortId === "function" ? H.shortId(id) : String(id || "?").slice(0, 8));
  // The shared markdown parser (helpers.js); degrade to escaped text if an old
  // cached helpers.js is in play. A local path pi printed ("saved to tmp/x.png")
  // is resolved to a served URL by localMediaSrc, below.
  const md = (raw, opts) => (typeof H.markdownHtml === "function" ? H.markdownHtml(raw, { resolve: localMediaSrc, ...(opts || {}) }) : esc(raw));
  // Any picture or video a tool result carries, drawn under its text by the same
  // shared extractor the desktop uses.
  const resultMedia = (raw) => (typeof H.resultMediaHtml === "function" ? H.resultMediaHtml(raw, { resolve: localMediaSrc }) : "");
  // The assistant's OWN reply: markdown images and URL pictures are drawn inline
  // by the prose (see msgTextHTML), so only a bare local path — which the prose
  // cannot resolve — gets a table row here. Without this the same picture would
  // render twice.
  const replyMedia = (raw) => (typeof H.resultMediaHtml === "function" ? H.resultMediaHtml(raw, { resolve: localMediaSrc, localOnly: true }) : "");
  // Assistant-text render mode — the same Markdown / Raw switch the desktop
  // Chat view offers, remembered per browser under the same key.
  const VIEWS = ["markdown", "raw"];
  const VIEW_KEY = "scope-chat-view";
  function loadView() {
    try { const v = localStorage.getItem(VIEW_KEY); if (VIEWS.includes(v)) return v; } catch { /* private mode */ }
    return "markdown";
  }

  // Light / dark theme — the same choice the desktop header toggle makes, under
  // the same localStorage key and honoured by the inline bootstrap in
  // mobile.html. A phone has no desktop chrome to carry that toggle, so the
  // header keeps one of its own.
  const THEME_KEY = "scope-theme";
  function setTheme(theme) {
    // The phone layout keeps its own dark-first "Amber Terminal Noir" skin; the
    // desktop shell is the one that defaults to the warm light theme.
    const dark = theme !== "light";
    if (dark) document.body.setAttribute("data-ds-dark-theme", "");
    else document.body.removeAttribute("data-ds-dark-theme");
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
    try { localStorage.setItem(THEME_KEY, dark ? "dark" : "light"); } catch { /* private mode */ }
    syncThemeButton();
  }
  // The glyph mirrors the CURRENT theme (moon = dark, like the desktop's 🌙); the
  // label announces the action so a screen reader hears "Switch to light theme".
  function syncThemeButton() {
    const btn = el.theme;
    if (!btn) return;
    const dark = document.body.hasAttribute("data-ds-dark-theme");
    const next = dark ? "light" : "dark";
    btn.setAttribute("aria-label", `Switch to ${next} theme`);
    btn.setAttribute("title", `Switch to ${next} theme`);
    // toggleAttribute, not `.hidden`: an inline <svg> is not an HTMLElement, so
    // the `hidden` IDL property would only set an expando and never the
    // attribute the stylesheet keys on.
    const moon = btn.querySelector(".m-ic-moon");
    const sun = btn.querySelector(".m-ic-sun");
    if (moon) moon.toggleAttribute("hidden", !dark);
    if (sun) sun.toggleAttribute("hidden", dark);
  }

  // ─── Credentials + API ────────────────────────────────────────────────────
  // The QR carries only the address. The phone has to be given the short-lived
  // code that is printed beside it, trades that for a credential pair once
  // (POST /pair): a JWT access token that expires in half an hour, and a rotating
  // refresh token that keeps the phone paired for weeks. The server's own master
  // token is never handed out, so a lost phone is not a standing key to every
  // file the server can reach.
  //
  // Both live in localStorage so a bookmark, a reload or a re-open from history
  // still works, and the access token is renewed in the background before it
  // lapses. `?token=` stays supported for links that already carry one. There is
  // deliberately no `?pair=` shortcut: pairing silently on scan made a photograph
  // of the QR as good as the code.
  const qp = new URLSearchParams(location.search);
  const STORE = { access: "scope-access-token", refresh: "scope-refresh-token", expires: "scope-access-expires" };
  // The legacy key a pre-JWT build stored the master token in. Read once so an
  // already-paired phone keeps working until that server restarts.
  const LEGACY_STORE = "scope-token";
  let TOKEN = "";     // the access token in use (a JWT, or a legacy ?token= link)
  let EXPIRES_AT = 0; // ms epoch when TOKEN lapses; 0 when we were not told
  let REFRESH = "";   // the rotating refresh token
  let refreshing = null; // in-flight refresh, so a burst of 401s rotates once
  let refreshTimer = 0;

  function loadCredentials() {
    try {
      const fromUrl = qp.get("token") || "";
      TOKEN = fromUrl || localStorage.getItem(STORE.access) || localStorage.getItem(LEGACY_STORE) || "";
      REFRESH = localStorage.getItem(STORE.refresh) || "";
      EXPIRES_AT = Number(localStorage.getItem(STORE.expires)) || 0;
      // A ?token= link is an access token we were not told the expiry of; the
      // 401 path covers it if it turns out to be stale. It is kept for the next
      // visit, the way the old single token was, so stripping the query from a
      // bookmark does not lose it.
      if (fromUrl) {
        EXPIRES_AT = 0;
        localStorage.setItem(STORE.access, fromUrl);
      }
    } catch {
      // Private mode: the URL token still works, nothing survives a reload.
      TOKEN = qp.get("token") || "";
    }
  }

  function storeCredentials(data) {
    TOKEN = data.access_token || "";
    EXPIRES_AT = Date.now() + (Number(data.expires_in) || 0) * 1000;
    REFRESH = data.refresh_token || "";
    try {
      localStorage.setItem(STORE.access, TOKEN);
      localStorage.setItem(STORE.refresh, REFRESH);
      localStorage.setItem(STORE.expires, String(EXPIRES_AT));
      localStorage.removeItem(LEGACY_STORE);
    } catch { /* private mode */ }
  }

  function clearCredentials() {
    TOKEN = "";
    REFRESH = "";
    EXPIRES_AT = 0;
    clearTimeout(refreshTimer);
    try {
      localStorage.removeItem(STORE.access);
      localStorage.removeItem(STORE.refresh);
      localStorage.removeItem(STORE.expires);
      localStorage.removeItem(LEGACY_STORE);
    } catch { /* private mode */ }
  }

  /** True when the access token is known to lapse within `margin` ms. An unknown
   *  expiry (a `?token=` link) is never "expired" — there is nothing to renew
   *  against until a refresh token exists. */
  function expiresSoon(margin = 0) {
    return EXPIRES_AT > 0 && Date.now() >= EXPIRES_AT - margin;
  }

  /**
   * Trade the refresh token for a fresh pair. Single-flight: a screenful of
   * parallel 401s must not rotate twice — the second rotation would spend the
   * token the first one just received.
   *
   * A refusal (the server restarted, or this phone was revoked) ends the
   * pairing and clears storage; a network failure does not, because the phone
   * being out of Wi-Fi for a minute is not a reason to make the user type a new
   * code.
   */
  function refreshAccess() {
    if (!REFRESH) return Promise.resolve(false);
    if (refreshing) return refreshing;
    refreshing = (async () => {
      let res;
      try {
        res = await fetch(apiUrl("/pair/refresh"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refresh_token: REFRESH }),
        });
      } catch {
        return false; // offline — keep the pair, try again on the next 401
      }
      let data = {};
      try { data = await res.json(); } catch { /* non-JSON */ }
      if (!res.ok || !data.access_token) {
        clearCredentials();
        return false;
      }
      storeCredentials(data);
      scheduleRefresh();
      return true;
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  /** Renew shortly before the access token lapses. The event stream cannot
   *  change its URL, so it is reopened with the new token — otherwise it would
   *  reconnect with a dead one every four seconds and never recover. */
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    if (!REFRESH || !EXPIRES_AT) return;
    const untilExpiry = EXPIRES_AT - Date.now();
    // Five minutes of lead time, or half the remaining life for a token issued
    // with less than that left (a test server, a clock that jumped).
    const delay = Math.max(0, untilExpiry - Math.min(5 * 60_000, untilExpiry / 2));
    refreshTimer = setTimeout(async () => {
      const ok = await refreshAccess();
      if (ok && S.sid) connectLive(S.sid);
    }, delay);
  }

  /**
   * Trade a pairing code for a credential pair. The code is short-lived and
   * single-purpose; only the tokens it returns are stored, so the code itself
   * never has to survive a reload.
   */
  async function exchangePairCode(code) {
    let res;
    try {
      res = await fetch(apiUrl("/pair"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
    } catch {
      setPairHint("Could not reach the server — check the Wi-Fi and the address.", true);
      return false;
    }
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (res.ok && data.access_token) {
      storeCredentials(data);
      scheduleRefresh();
      return true;
    }
    setPairHint(
      res.status === 429
        ? "Too many attempts — wait a minute, then try again."
        : data.error === "used"
          ? "That code was already used by another phone — the panel shows the next one."
          : data.error === "expired"
            ? "That code expired — the phone panel shows the current one."
            : "That code is not right — check the phone panel and try again.",
      true
    );
    return false;
  }

  // ─── Pairing gate ─────────────────────────────────────────────────────────

  function setPairHint(msg, isError) {
    if (!el.pairHint) return;
    el.pairHint.textContent = msg || "";
    el.pairHint.hidden = !msg;
    el.pairHint.style.color = isError ? "var(--danger)" : "";
  }

  function showPairGate(message) {
    if (!el.pair) return;
    const alreadyOpen = !el.pair.hidden;
    // The live stream was authorised by the token we are replacing; stop it
    // rather than letting it retry a credential the server has forgotten.
    if (es) { es.close(); es = null; }
    setLive(false);
    el.pair.hidden = false;
    if (message) setPairHint(message, true);
    // Only focus on the transition: the session poll keeps calling this while the
    // gate is up, and stealing focus every 15s would fight the typing.
    if (!alreadyOpen) setTimeout(() => { try { el.pairCode.focus(); } catch { /* not focusable */ } }, 60);
  }

  function hidePairGate() {
    if (el.pair) el.pair.hidden = true;
  }

  function authHeaders() {
    return TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
  }

  function apiUrl(path, query) {
    const u = new URL(path, location.origin);
    for (const [k, v] of Object.entries(query || {})) {
      if (v != null && v !== "") u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  // A local path pi printed ("saved to tmp/chart.png") is not under public/, so
  // the browser cannot load it on its own. The server serves it from the same
  // sandbox as the Files view (GET /media), keyed by the open session's cwd; the
  // token rides in the query because an <img> cannot send an Authorization header.
  // Only media extensions become URLs — anything else stays plain text.
  const LOCAL_MEDIA_EXT_RE = /\.(png|jpe?g|gif|webp|avif|bmp|svg|mp4|webm|ogv|ogg|mov|m4v)$/i;
  function localMediaSrc(p) {
    const rel = String(p == null ? "" : p).trim();
    if (!rel) return "";
    if (/^[a-z][a-z0-9+.-]*:/i.test(rel)) return ""; // a URL, not a filesystem path
    if (!LOCAL_MEDIA_EXT_RE.test(rel.split(/[?#]/)[0])) return "";
    const cwd = (S.session && S.session.cwd) || (S.draft && S.draft.cwd) || S.ws || "";
    if (!cwd) return "";
    const q = new URLSearchParams({ cwd, path: rel });
    if (TOKEN) q.set("token", TOKEN);
    return `/media?${q.toString()}`;
  }

  /** fetch that renews once on a 401 and replays the request. Centralised
   *  because a phone sits idle past the access token's life all the time, and
   *  every call site would otherwise need its own refresh-then-retry dance.
   *  Replaying is safe here: every body this passes is a string we still hold. */
  async function authedFetch(url, opts = {}) {
    const res = await fetch(url, opts);
    if (res.status !== 401 || !REFRESH) return res;
    if (!(await refreshAccess())) return res;
    return fetch(url, { ...opts, headers: { ...(opts.headers || {}), ...authHeaders() } });
  }

  /** fetch + JSON, the same contract as window.SCOPE.api in app.js. A 4th
   *  `method` argument overrides the verb (used for DELETE); with no body the
   *  request is a GET. */
  async function api(path, query = {}, body, method) {
    const headers = authHeaders();
    const opts = { headers };
    if (body !== undefined) {
      opts.method = "POST";
      headers["content-type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    if (method) opts.method = method;
    const res = await authedFetch(apiUrl(path, query), opts);
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON (empty/stream) */ }
    return { res, data };
  }

  // ─── State + DOM ──────────────────────────────────────────────────────────

  const S = {
    sessions: [],
    sid: null,
    session: null,
    draft: null,      // { cwd, model, at, prompt } while composing a NEW conversation
    runKey: null,     // the pi subprocess key the server announced for our run
    resumeFile: null, // pi session file to continue (a recorded session)
    model: "",        // model chosen for the CURRENT chat (overrides the row's)
    events: [],
    lastSeq: 0,       // dedupe guard: the live SSE mirror overlaps a refetch
    streaming: false, // our own POST /chat stream owns the turn right now
    follow: true,     // auto-scroll to the newest row
    live: false,      // SSE connection state (the header dot)
    asks: new Set(),  // question-card ids already on screen
    temp: [],         // nodes appended for an adopted run (dropped on fallback)
    models: [],       // /agent-team: the user's enabled models
    defaultModel: "", // /agent-team: the configured default model
    teams: [],        // /agent-team: team names, in the configured order
    activeTeam: "",   // /agent-team: the project's active team
    mode: "",         // /agent-team: "creative" | "standard" | "" (unset)
    ws: "",           // workspace chosen in the new-session sheet
    teamPick: "",     // team the user picked in the sheet (survives a refetch)
    modePick: "",     // mode the user picked in the sheet (survives a refetch)
    teamAt: 0,        // when /agent-team was last fetched (throttle)
    sheet: null,      // open sheet mode: "new" | "model" | null
    runKeys: new Map(), // session id → pi subprocess key this phone has driven
    view: loadView(), // assistant-text render mode: "markdown" | "raw"
    attachments: [],  // composer attachments: [{ id, name, path, kind }] — path is what pi receives
    attachSeq: 0,     // id source for attachment chips
  };
  let LIVE = null;   // the in-flight assistant bubble being written to
  let es = null;     // EventSource for the selected session
  let wsCache = loadWsCache(); // union of every workspace this phone has seen
  let EMPTY_TRANSCRIPT = ""; // restored when the open session is deleted

  const el = {};
  function cache() {
    el.menu = $("#m-menu");
    el.title = $("#m-title");
    el.sub = $("#m-sub");
    el.live = $("#m-live");
    el.theme = $("#m-theme");
    el.desktop = $("#m-desktop");
    el.scrim = $("#m-scrim");
    el.drawer = $("#m-drawer");
    el.drawerClose = $("#m-drawer-close");
    el.sessions = $("#m-sessions");
    el.drawerCount = $("#m-drawer-count");
    el.transcript = $("#m-transcript");
    el.composer = $("#m-composer");
    el.jump = $("#m-jump");
    el.hint = $("#m-hint");
    el.input = $("#m-input");
    el.send = $("#m-send");
    el.stop = $("#m-stop");
    el.attach = $("#m-attach");
    el.attachInput = $("#m-attach-input");
    el.attachments = $("#m-attachments");
    el.modelChip = $("#m-model-chip");
    el.viewToggle = $("#m-view-toggle");
    el.new = $("#m-new");
    el.drawerNew = $("#m-drawer-new");
    el.sheet = $("#m-sheet");
    el.sheetTitle = $("#m-sheet-title");
    el.sheetClose = $("#m-sheet-close");
    el.fieldWs = $("#m-field-ws");
    el.wsList = $("#m-ws-list");
    el.wsInput = $("#m-ws-input");
    el.wsAdd = $("#m-ws-add");
    el.modelSel = $("#m-model-select");
    el.fieldTeam = $("#m-field-team");
    el.teamSel = $("#m-team-select");
    el.fieldMode = $("#m-field-mode");
    el.modeSel = $("#m-mode-select");
    el.applyModel = $("#m-apply-model");
    el.start = $("#m-start");
    el.pair = $("#m-pair");
    el.pairCode = $("#m-pair-code");
    el.pairHint = $("#m-pair-hint");
    el.pairGo = $("#m-pair-go");
    // The no-session empty state, captured before any render so a cleared
    // transcript (deleted session) can restore exactly the shipped markup.
    EMPTY_TRANSCRIPT = el.transcript.innerHTML;
  }

  // ─── Small helpers ────────────────────────────────────────────────────────

  /** The last two path segments — a workspace header has no room for `/home/…`. */
  function tailPath(p) {
    const parts = String(p || "").replace(/\/+$/, "").split("/").filter(Boolean);
    if (!parts.length) return p || "";
    return parts.length <= 2 ? parts.join("/") : "…/" + parts.slice(-2).join("/");
  }

  function statusLabel(s) {
    const st = typeof H.subagentStatus === "function" ? H.subagentStatus(s) : "orange";
    return st === "green" ? "running" : st === "red" ? "stopped" : "waiting";
  }

  function statusDot(s) {
    return typeof H.subagentStatus === "function" ? H.subagentStatus(s) : "orange";
  }

  /** A session the user's terminal is working right now: the server learned its
   *  pid from the events its extension posts, and this phone is not driving a
   *  stream of its own (that one has the normal Stop behaviour). */
  function externalRunLive() {
    const s = S.session;
    return !!(s && !S.streaming && s.pid && statusDot(s) === "green");
  }

  /** The session id Stop should signal: the stream's own subprocess while we are
   *  sending, else the pid-backed terminal run. "" when there is nothing. */
  function stopTarget() {
    if (S.streaming) return S.runKey || S.sid || "";
    return externalRunLive() ? (S.sid || "") : "";
  }

  /** Settle the row after a terminal kill: the process is gone and the server
   *  recorded a closing turn_end, so drop the dangling pid and flip the turn —
   *  the header and the Stop button update now instead of after the next poll. */
  function patchStoppedExternalRow(sid) {
    const ts = new Date().toISOString();
    for (const s of S.sessions) {
      if (s.session_id !== sid) continue;
      s.pid = undefined;
      s.turn_live = false;
      s.last_turn_event = "turn_end";
      s.last_ts = ts;
    }
    renderSessions();
    renderHeader();
    refreshComposer();
  }

  /** provider/model, qualified only when the model is not already prefixed.
   *  Mirrors chat.js's qualifiedModel: a bare "/" is not a provider separator. */
  function qualifiedModel(s) {
    const m = (s && s.model) || "";
    if (!m) return "";
    const p = (s && s.provider) || "";
    return p && !m.startsWith(p + "/") ? `${p}/${m}` : m;
  }

  function isChatSession(s) {
    return (s.agent_name || "").toLowerCase() !== "memory-summarizer";
  }

  /** First line of a question title, stripped of markdown noise. */
  function cleanTitle(t) {
    return String(t || "")
      .replace(/^\s*#+\s*/, "")
      .split("\n").find((l) => l.trim()) || "pi is asking a question";
  }

  // ─── Header / composer chrome ─────────────────────────────────────────────

  function renderHeader() {
    const s = S.session;
    if (!s) {
      el.title.textContent = "Pi Scope";
      el.sub.textContent = "pick a session";
      return;
    }
    el.title.textContent = s.agent_name || `session ${shortId(S.sid)}`;
    const ws = tailPath(s.cwd);
    // A draft has no turn history to read a status from — it is simply ready.
    const state = S.streaming ? "working" : (S.draft ? "ready" : statusLabel(s));
    el.sub.textContent = (ws ? ws + " · " : "") + state;
  }

  function setLive(on) {
    S.live = on;
    if (el.live) el.live.className = "m-dot " + (on ? "green" : "red");
  }

  function hint(msg, kind) {
    if (!el.hint) return;
    el.hint.textContent = msg || "";
    el.hint.hidden = !msg;
    // `kind` maps straight onto the state class: "" (muted readout), "err"
    // (danger) or "warn" (the coral accent).
    el.hint.className = "m-hint" + (kind ? " " + kind : "");
    if (msg && kind !== "err") {
      clearTimeout(hint._t);
      hint._t = setTimeout(() => { el.hint.hidden = true; }, 3500);
    }
  }

  function refreshComposer() {
    const ready = !!S.session;
    el.input.disabled = !ready;
    el.input.placeholder = ready ? "Message pi…" : "Pick a session first";
    el.send.disabled = !ready || S.streaming || (!el.input.value.trim() && !pendingAttachmentPaths().length);
    el.stop.hidden = !S.streaming && !externalRunLive();
    el.stop.title = S.streaming ? "Stop the agent" : "Stop the agent running in your terminal";
    el.stop.setAttribute("aria-label", el.stop.title);
    if (el.attach) el.attach.disabled = !ready;
    markComposerHeight();
    if (el.modelChip) {
      // The chip names what the next message runs with and opens the sheet to
      // change it — on a phone it is the only place the model is visible.
      const parts = [];
      const m = ready ? currentModel() : "";
      if (m) parts.push(m);
      if (ready && S.session.cwd) parts.push(tailPath(S.session.cwd));
      el.modelChip.textContent = parts.join(" · ");
      el.modelChip.hidden = !ready;
      el.modelChip.title = ready
        ? "Change the model, or start a session in another workspace"
        : "";
    }
  }

  // ─── Composer attachments ─────────────────────────────────────────────────
  // Files, images and documents attached on the phone are uploaded into the
  // workspace's `tmp/attachments/` (POST /chat/attach) — a phone has no real
  // path to hand over — and only the returned PATH is sent to pi: the bytes
  // never enter the prompt. The block format is the shared one
  // (H.attachmentsBlock), so a conversation started here reads the same
  // everywhere and a file stays usable by reference afterwards.
  const ATTACH_IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico|heic|heif|tiff?)$/i;
  const ATTACH_ICON_IMAGE =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>';
  const ATTACH_ICON_FILE =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';
  const ATTACH_BLOCK_HEAD = "Attached files (read each from its path):";

  function attachKind(name) { return ATTACH_IMAGE_RE.test(String(name || "")) ? "image" : "file"; }
  function attachIcon(kind) { return kind === "image" ? ATTACH_ICON_IMAGE : ATTACH_ICON_FILE; }
  function attachBasename(p) {
    const parts = String(p == null ? "" : p).replace(/\\/g, "/").split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : String(p == null ? "" : p);
  }

  /** Split a prompt pi was handed back into the typed text + attached paths, so
   *  a recorded or reconnected turn shows the same chips the composer staged. */
  function splitAttachments(text) {
    const t = String(text == null ? "" : text);
    const i = t.indexOf(ATTACH_BLOCK_HEAD);
    if (i < 0) return { text: t, paths: [] };
    const body = t.slice(0, i).replace(/\s+$/, "");
    const paths = t.slice(i).split("\n").slice(1)
      .map((l) => l.replace(/^\s*-\s*/, "").trim())
      .filter(Boolean);
    return { text: body, paths };
  }

  function attachChipsRow(paths) {
    const row = document.createElement("div");
    row.className = "m-msg-atts";
    for (const p of paths) {
      const chip = document.createElement("span");
      chip.className = "m-msg-att";
      chip.title = String(p);

      const icon = document.createElement("span");
      icon.textContent = attachIcon(attachKind(p));

      const name = document.createElement("span");
      name.className = "m-msg-att-name";
      name.textContent = attachBasename(p);

      chip.appendChild(icon);
      chip.appendChild(name);
      row.appendChild(chip);
    }
    return row;
  }

  function renderAttachments() {
    if (!el.attachments) return;
    const list = S.attachments;
    if (!list.length) { el.attachments.hidden = true; el.attachments.textContent = ""; return; }
    el.attachments.hidden = false;
    el.attachments.textContent = "";
    for (const a of list) {
      const chip = document.createElement("span");
      chip.className = "m-attach-chip" + (a.uploading ? " uploading" : "") + (a.err ? " err" : "");
      chip.title = a.err || a.path || a.name || "";
      const label = a.uploading ? `${a.name} — uploading…` : (a.err || a.name);
      chip.innerHTML = attachIcon(a.kind) + `<span class="m-attach-name">${esc(label)}</span>`;
      const x = document.createElement("button");
      x.type = "button";
      x.className = "m-attach-x";
      x.setAttribute("aria-label", "Remove attachment");
      x.textContent = "✕";
      x.addEventListener("click", () => removeAttachment(a.id));
      chip.appendChild(x);
      el.attachments.appendChild(chip);
    }
  }

  function removeAttachment(id) {
    const i = S.attachments.findIndex((a) => a.id === id);
    if (i >= 0) { S.attachments.splice(i, 1); renderAttachments(); refreshComposer(); }
  }

  function clearAttachments() {
    if (!S.attachments.length) return;
    S.attachments = [];
    renderAttachments();
  }

  // The paths to send: everything settled (a failed upload is dropped rather
  // than sent as a broken reference).
  function pendingAttachmentPaths() {
    return S.attachments.filter((a) => !a.uploading && !a.err && a.path).map((a) => a.path);
  }
  function attachmentsUploading() { return S.attachments.some((a) => a.uploading); }

  function withAttachmentBlock(text, paths) {
    const block = typeof H.attachmentsBlock === "function" ? H.attachmentsBlock(paths) : "";
    const t = String(text == null ? "" : text).trim();
    if (!block) return t;
    return t ? `${t}\n\n${block}` : block;
  }

  function readFileBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || "").replace(/^data:[^;]*;base64,/, ""));
      r.onerror = () => reject(r.error || new Error("could not read file"));
      r.readAsDataURL(file);
    });
  }

  // Upload each picked file into the workspace and keep the returned relative
  // path. The chip appears the moment it is queued, so a large photo is
  // visibly in flight rather than the tap appearing to do nothing.
  async function addAttachmentFiles(files) {
    const list = [...(files || [])];
    if (!list.length) return;
    const cwd = (S.session && S.session.cwd) || (S.draft && S.draft.cwd) || S.ws || "";
    if (!cwd) { hint("Pick a session first", "err"); return; }
    for (const file of list) {
      const id = ++S.attachSeq;
      S.attachments.push({ id, name: file.name, kind: attachKind(file.name), uploading: true });
      renderAttachments();
      refreshComposer();
      try {
        const data = await readFileBase64(file);
        const { res, data: out } = await api("/chat/attach", {}, { cwd, name: file.name, data });
        const chip = S.attachments.find((a) => a.id === id);
        if (!chip) continue; // removed while the upload was in flight
        if (!res.ok || !out || !out.ok) throw new Error((out && out.error) || `HTTP ${res.status}`);
        chip.uploading = false;
        chip.path = out.path;
        chip.name = out.name || file.name;
      } catch (err) {
        const chip = S.attachments.find((a) => a.id === id);
        if (chip) { chip.uploading = false; chip.err = `failed — ${(err && err.message) || err}`; }
      }
      renderAttachments();
      refreshComposer();
    }
  }

  function pickAttachments() {
    if (!S.session) { hint("Pick a session first", "err"); return; }
    if (el.attachInput) el.attachInput.click();
  }

  /** How tall the textarea may grow. The share shrinks with the screen: 40% of a
   *  480px-tall phone left the transcript with barely half the screen while a
   *  long draft was open, which is the one moment the transcript matters most. */
  function inputCap() {
    const h = window.innerHeight;
    const share = h <= 560 ? 0.2 : h <= 720 ? 0.26 : 0.4;
    return Math.round(h * share);
  }

  /** Visual rows in the draft, measured rather than counted: a wrapped line and
   *  a typed newline both take a row, and only the field knows which. */
  function inputRows() {
    const style = getComputedStyle(el.input);
    const line = parseFloat(style.lineHeight) || 22;
    const pad = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    return Math.round((el.input.scrollHeight - pad) / line);
  }

  /** Flag a draft that has grown past two rows, so a short screen can give the
   *  words the space the foot row was using (see #m-composer[data-tall]). */
  function markComposerHeight() {
    if (!el.composer || !el.input) return;
    el.composer.toggleAttribute("data-tall", inputRows() >= 3 || S.attachments.length > 0);
  }

  function autoGrow() {
    // An empty field is one row. The placeholder is not content, but Chromium
    // still counts its wrapped lines in scrollHeight — and "Pick a session
    // first" wraps on a 320px phone, which silently made the composer two rows
    // taller (and moved the jump pill with it).
    if (!el.input.value) { el.input.style.height = ""; markComposerHeight(); return; }
    el.input.style.height = "auto";
    el.input.style.height = Math.min(el.input.scrollHeight, inputCap()) + "px";
    markComposerHeight();
  }

  // ─── Scrolling ────────────────────────────────────────────────────────────

  function nearBottom() {
    const t = el.transcript;
    return t.scrollHeight - t.scrollTop - t.clientHeight < 80;
  }

  function scrollToBottom(force) {
    if (!force && !S.follow) return;
    el.transcript.scrollTop = el.transcript.scrollHeight;
    S.follow = true;
    el.jump.hidden = true;
  }

  /** After an append: stick to the bottom only while the user is already there. */
  function follow() {
    if (nearBottom()) scrollToBottom(true);
    else { el.jump.hidden = false; }
  }

  // ─── Rendering: transcript rows ───────────────────────────────────────────

  /** Token/cost chips for a message — [] when the provider reported nothing. */
  function chipSpans(usage) {
    const u = usage || {};
    const chips = [];
    if (u.total_tokens) chips.push(`${u.total_tokens} tk`);
    if (u.cost_total) chips.push(`$${Number(u.cost_total).toFixed(4)}`);
    if (u.input != null) chips.push(`${u.input} in / ${u.output ?? "?"} out`);
    return chips.map((c) => `<span class="m-chip">${esc(c)}</span>`).join("");
  }

  function usageChips(usage) {
    const inner = chipSpans(usage);
    return inner ? `<div class="m-chips">${inner}</div>` : "";
  }

  // Every row carries a mono lead label ("you" / "pi") — the design system's
  // eyebrow — and the prose itself stays in the body face.
  function userRow(text) {
    // The prompt pi was handed can carry two things that are not what the user
    // typed: the attachment block (a recorded turn, or a run reconnected
    // mid-flight) and — when this session's own pi file is gone — the seeded
    // transcript the server prepended so the conversation could continue at all.
    // Show the prose and the files, and neither block.
    const own = typeof H.stripSessionSeed === "function" ? H.stripSessionSeed(text) : text;
    const { text: body, paths } = splitAttachments(own);
    const msg = document.createElement("div");
    msg.className = "m-msg m-user";

    const bubble = document.createElement("div");
    bubble.className = "m-bubble";

    const head = document.createElement("div");
    head.className = "m-ai-head m-user-head";
    head.textContent = "you";

    bubble.appendChild(head);
    if (body) {
      const pre = document.createElement("pre");
      pre.className = "m-text";
      pre.textContent = body;
      bubble.appendChild(pre);
    }
    if (paths.length) bubble.appendChild(attachChipsRow(paths));
    msg.appendChild(bubble);
    return msg;
  }

  // Fenced code inside a Markdown reply (see the shared parser in helpers.js).
  function mobileCodeBlock(lang, code) {
    return `<div class="m-code">` +
      `<div class="m-code-head"><span class="m-code-lang">${esc(lang || "code")}</span>` +
      `<button type="button" class="m-code-copy" data-copy="${esc(code)}">Copy</button></div>` +
      `<pre><code>${esc(code)}</code></pre></div>`;
  }

  // The assistant's reply drawn in the current view: rendered markdown
  // (Markdown) or plain text (Raw). `data-raw` keeps the source so a later
  // view switch can redraw every row in place.
  function msgTextHTML(text) {
    const raw = text || "";
    const attr = esc(raw);
    if (S.view === "markdown") {
      // Pictures stay IN the prose here (no dropImages): on a phone an inline
      // image is what a reply expects, and it is what the Markdown/Raw switch
      // has to add and remove. Tool results still draw their media in a table.
      return `<div class="m-text m-md" data-raw="${attr}">${md(raw, { codeBlock: mobileCodeBlock })}</div>`;
    }
    return `<pre class="m-text" data-raw="${attr}">${esc(raw)}</pre>`;
  }

  function copyText(text) {
    if (!text) return;
    if (navigator.clipboard?.writeText) { navigator.clipboard.writeText(text).catch(() => {}); return; }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    } catch { /* ignore */ }
  }

  // Redraw every rendered assistant body in place (recorded rows and a finished
  // live bubble) from its stored source, without a server round-trip.
  function applyViewInPlace() {
    for (const node of el.transcript.querySelectorAll("[data-raw]")) {
      const wrap = document.createElement("div");
      wrap.innerHTML = msgTextHTML(node.dataset.raw);
      node.replaceWith(wrap.firstElementChild);
    }
    if (typeof H.hydrateMediaTables === "function") H.hydrateMediaTables(el.transcript);
  }

  function updateViewToggle() {
    const box = el.viewToggle;
    if (!box) return;
    box.querySelectorAll("[data-view]").forEach((b) => {
      const on = b.dataset.view === S.view;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  function setView(view) {
    if (!VIEWS.includes(view) || view === S.view) return;
    S.view = view;
    try { localStorage.setItem(VIEW_KEY, view); } catch { /* private mode */ }
    updateViewToggle();
    if (S.streaming) return; // the live bubble adopts the mode when it seals
    applyViewInPlace();
  }

  function assistantRow(p) {
    const head = `<div class="m-ai-head">pi</div>`;
    const text = p.text ? msgTextHTML(p.text) : "";
    // A bare local path in the reply ("saved to tmp/chart.png") has no inline
    // form, so it is listed in a dimension table underneath, largest first.
    const pics = p.text ? replyMedia(p.text) : "";
    const think = p.thinking
      ? `<details class="m-think"><summary>thinking</summary><pre>${esc(p.thinking)}</pre></details>`
      : "";
    const empty = !p.text && !p.thinking ? `<div class="m-note">tool call only</div>` : "";
    return `<div class="m-msg m-ai"><div class="m-bubble">${head}${text}${pics}${think}${empty}${usageChips(p.usage)}</div></div>`;
  }

  function toolRow(evt) {
    const p = evt.payload || {};
    const name = p.tool_name || "tool";
    const result = evt.type === "tool_result";
    const failed = result && typeof H.isToolResultError === "function" && H.isToolResultError(p);
    const body = result
      ? (p.content_text || "")
      : (p.args != null ? (typeof p.args === "string" ? p.args : JSON.stringify(p.args, null, 2)) : "");
    const exit = result && p.details_summary ? p.details_summary.exit_code : null;
    return `<details class="m-row m-tool${failed ? " err" : ""}">
      <summary><span class="m-tool-name">${result ? "←" : "→"} ${esc(name)}</span>
      ${failed ? '<span class="m-badge err">error</span>' : exit ? `<span class="m-badge">exit ${esc(exit)}</span>` : ""}</summary>
      <pre>${esc(trunc(body, 6000))}</pre>
      ${result ? resultMedia(body) : ""}
    </details>`;
  }

  /** Wrap an HTML fragment in a single element node (null for empty markup). */
  function htmlNode(html) {
    if (!html) return null;
    const wrap = document.createElement("div");
    wrap.innerHTML = html;
    return wrap.firstElementChild;
  }

  /** One recorded event → its transcript row node (null for noise we don't
   *  show). User rows are built as DOM (untrusted text never re-enters HTML);
   *  the agent's own markup is escaped markup. */
  function renderEventNode(evt) {
    const p = evt.payload || {};
    switch (evt.type) {
      case "user_message": return userRow(p.text);
      case "assistant_message": return htmlNode(assistantRow(p));
      case "tool_call":
      case "tool_result": return htmlNode(toolRow(evt));
      case "error": return htmlNode(`<div class="m-note err">✗ ${esc(p.message || "error")}</div>`);
      default: return null;
    }
  }

  function renderTranscript() {
    el.transcript.textContent = "";
    let any = false;
    for (const evt of S.events) {
      const row = renderEventNode(evt);
      if (row) { el.transcript.appendChild(row); any = true; }
    }
    if (!any) el.transcript.innerHTML = `<div class="m-empty">No messages recorded yet</div>`;
    if (typeof H.hydrateMediaTables === "function") H.hydrateMediaTables(el.transcript);
    scrollToBottom(true);
  }

  // ─── Sessions drawer ──────────────────────────────────────────────────────

  /** The drawer row's label: the conversation's opening prompt, exactly like
   *  the desktop Chat rail's session rows — not the agent's (subagent) name.
   *  Falls back to the agent name for a session that has not recorded an opening
   *  message yet. A seeded session's first text IS the seed block, so it is
   *  stripped first (the shared helper the desktop rail uses). */
  function sessionLabel(s) {
    const raw = s.first_msg ? String(s.first_msg) : "";
    const first = typeof H.stripSessionSeed === "function" ? H.stripSessionSeed(raw) : raw;
    const oneLine = String(first || "").replace(/\s+/g, " ").trim();
    if (oneLine) return trunc(oneLine, 64);
    // Same fallbacks as the desktop rail's session row.
    return s.agent_name || (s.cwd ? s.cwd.split("/").filter(Boolean).pop() : "") || `session ${shortId(s.session_id)}`;
  }

  function sessionRowHTML(s) {
    const name = sessionLabel(s);
    // The delete affordance is a SIBLING of the row button (a button cannot
    // contain one) and always visible: touch has no hover to reveal it.
    return `<div class="m-sess-row">
      <button class="m-sess${s.session_id === S.sid ? " active" : ""}" type="button" data-sid="${esc(s.session_id)}" title="${esc(name)}">
        <span class="m-dot ${statusDot(s)}"></span>
        <span class="m-sess-main">
          <span class="m-sess-name">${esc(name)}</span>
          <span class="m-sess-meta">${esc(H.fmtRel ? H.fmtRel(s.last_ts) : "")} · ${esc(s.event_count ?? "?")} events</span>
        </span>
        ${s.model ? `<span class="m-sess-model">${esc(s.model)}</span>` : ""}
      </button>
      <button class="m-sess-del" type="button" data-del="${esc(s.session_id)}" aria-label="Delete ${esc(name)}" title="Delete this session">&times;</button>
    </div>`;
  }

  function renderSessions() {
    const wrap = el.sessions;
    if (!wrap) return;
    // The drawer's status readout (mono, uppercase via CSS).
    if (el.drawerCount) {
      el.drawerCount.textContent = S.sessions.length
        ? `${S.sessions.length} ${S.sessions.length === 1 ? "session" : "sessions"}`
        : "";
    }
    if (!S.sessions.length) {
      wrap.innerHTML = `<div class="m-note">No sessions yet — tap ＋ above to start one.</div>`;
      return;
    }
    const groups = new Map();
    for (const s of S.sessions) {
      const cwd = s.cwd || "(unknown)";
      if (!groups.has(cwd)) groups.set(cwd, []);
      groups.get(cwd).push(s);
    }
    wrap.innerHTML = [...groups.entries()].map(([cwd, list]) =>
      `<div class="m-ws">
        <div class="m-ws-name" title="${esc(cwd)}">${esc(tailPath(cwd) || cwd)}</div>
        ${list.map(sessionRowHTML).join("")}
      </div>`).join("");
  }

  async function fetchSessions() {
    if (document.hidden) return;
    // Nothing to fetch before the phone has a token; the gate owns the screen.
    if (el.pair && !el.pair.hidden) return;
    const { res, data } = await api("/sessions", { limit: 100 });
    if (!res.ok) {
      if (res.status === 401) {
        // api() already tried a refresh, so a 401 that survives it means this
        // pairing is over: the server restarted (its signing key is per boot)
        // or the phone was disconnected from the desktop panel. Drop the
        // credentials and ask for a code rather than leaving an empty list
        // behind a wall of 401s.
        clearCredentials();
        showPairGate("This server reissued its credentials — enter the code from the phone panel.");
        return;
      }
      hint(`Could not load sessions (HTTP ${res.status}).`, "err");
      return;
    }
    S.sessions = (Array.isArray(data.sessions) ? data.sessions : []).filter(isChatSession);
    for (const s of S.sessions) rememberWs(s.cwd);
    if (S.sid) S.session = S.sessions.find((s) => s.session_id === S.sid) || S.session;
    tryAdoptDraft();
    renderSessions();
    renderHeader();
    refreshComposer();
    renderEmptyStats();
  }

  /** The hero's stat readouts — only on screen when no session is open, so this
   *  is a no-op the rest of the time (and it fills the state restored after a
   *  session is deleted, which comes back from the shipped markup). */
  function renderEmptyStats() {
    const wrap = $("#m-empty-stats");
    if (!wrap) return;
    const workspaces = new Set(S.sessions.map((s) => s.cwd || "(unknown)"));
    const live = S.sessions.filter((s) => statusDot(s) === "green").length;
    const stats = [
      { k: "sessions", v: S.sessions.length },
      { k: "workspaces", v: workspaces.size },
      // Rationed amber marks the one value that is a live signal.
      { k: "live", v: live, hot: live > 0 },
    ];
    wrap.innerHTML = stats
      .map((s) => `<span class="m-stat"><span class="m-stat-k">${esc(s.k)}</span>` +
        `<span class="m-stat-v${s.hot ? " hot" : ""}">${esc(String(s.v))}</span></span>`)
      .join("");
  }

  // ─── Drawer ───────────────────────────────────────────────────────────────

  // Set while a closed drawer is sliding out; the box is taken out of flow when
  // it lands so the hidden panel is not laid out (see the #m-drawer rule).
  let drawerHideTimer = null;

  function openDrawer() {
    clearTimeout(drawerHideTimer);
    // Render off-screen first so adding `.open` on the next frame still animates
    // the slide-in (a `display:none` → `.open` change would land in one frame).
    el.drawer.style.display = "flex";
    el.drawer.setAttribute("aria-hidden", "false");
    el.menu.setAttribute("aria-expanded", "true");
    el.scrim.hidden = false;
    requestAnimationFrame(() => {
      el.drawer.classList.add("open");
      el.scrim.classList.add("shown");
    });
  }

  function closeDrawer() {
    el.drawer.classList.remove("open");
    el.drawer.setAttribute("aria-hidden", "true");
    el.menu.setAttribute("aria-expanded", "false");
    el.scrim.classList.remove("shown");
    // 300ms slide + a little slack, matching the reduced-motion path where the
    // transition is off and this timer is the only thing that hides the box.
    clearTimeout(drawerHideTimer);
    drawerHideTimer = setTimeout(() => {
      if (el.drawer.classList.contains("open")) return;
      el.drawer.style.display = "none";
      el.scrim.hidden = true;
    }, 320);
  }

  /** Drop a deleted session from this phone: forget the row, and if it was the
   *  one on screen, empty the transcript back to the shipped start state. */
  function forgetSession(sid) {
    S.sessions = S.sessions.filter((s) => s.session_id !== sid);
    S.runKeys.delete(sid);
    if (S.sid === sid) {
      closeLive();
      S.draft = null;
      S.sid = null;
      S.session = null;
      S.model = "";
      S.runKey = null;
      S.resumeFile = null;
      S.events = [];
      S.lastSeq = 0;
      S.streaming = false;
      S.asks = new Set();
      S.temp = [];
      LIVE = null;
      el.transcript.innerHTML = EMPTY_TRANSCRIPT;
      el.transcript.scrollTop = 0;
    }
    renderSessions();
    renderHeader();
    refreshComposer();
    renderEmptyStats();
  }

  /** Delete a session and its recorded events (the drawer's ×). Confirmed
   *  first: the server's delete is permanent. The pi subprocess behind it is
   *  killed BEFORE the delete, or a live agent would keep writing events for a
   *  session that no longer exists (and re-create its row). */
  async function deleteSession(sid) {
    if (!sid) return;
    const s = S.sessions.find((x) => x.session_id === sid);
    const name = (s && s.agent_name) || `session ${shortId(sid)}`;
    if (!window.confirm(`Delete "${name}" and all its recorded events?\n\nThis cannot be undone.`)) return;
    hint("deleting…", "");
    const key = S.runKeys.get(sid) || sid;
    try { await api("/chat/kill", {}, { sessionId: key }); } catch { /* subprocess already gone */ }
    let res, data;
    try {
      ({ res, data } = await api(`/sessions/${encodeURIComponent(sid)}`, {}, undefined, "DELETE"));
    } catch (err) {
      hint((err && err.message) || String(err), "err");
      return;
    }
    if (!res.ok || !data || !data.ok) {
      hint((data && data.error) || `could not delete the session (HTTP ${res.status})`, "err");
      return;
    }
    forgetSession(sid);
    void fetchSessions();
    hint("session deleted", "");
  }

  // ─── Live feed (SSE) for the selected session ─────────────────────────────

  function closeLive() {
    if (es) { es.close(); es = null; }
    setLive(false);
  }

  function connectLive(sid) {
    closeLive();
    const url = apiUrl("/events/stream", { session_id: sid, token: TOKEN });
    es = new EventSource(url);
    es.addEventListener("hello", () => setLive(true));
    es.addEventListener("event", (msg) => {
      if (S.sid !== sid) return;
      let evt;
      try { evt = JSON.parse(msg.data); } catch { return; }
      if (!evt || evt.session_id !== sid) return;
      onFeedEvent(evt);
    });
    es.onerror = () => {
      setLive(false);
      if (es) { es.close(); es = null; }
      setTimeout(async () => {
        if (S.sid !== sid || S.streaming) return;
        // A stream authorised by a lapsed token 401s on every retry, so renew
        // before reconnecting — the loop would otherwise never end.
        if (expiresSoon(30_000)) {
          const ok = await refreshAccess();
          if (!ok && !TOKEN) {
            showPairGate("This server reissued its credentials — enter the code from the phone panel.");
            return;
          }
        }
        if (S.sid === sid && !S.streaming) connectLive(sid);
      }, 4000);
    };
  }

  /** A recorded event for the OPEN session, arriving while we are only watching
   *  (the turn is being driven by the desktop, another phone, or pi itself). */
  function onFeedEvent(evt) {
    if (typeof evt.seq === "number") {
      if (evt.seq <= S.lastSeq) return; // already in the transcript (refetch overlap)
      S.lastSeq = evt.seq;
    }
    if (S.streaming) return; // our own run renders its deltas; the mirror would duplicate them
    const row = renderEventNode(evt);
    if (!row) {
      if (evt.type === "turn_start" || evt.type === "turn_end" || evt.type === "session_shutdown") {
        const prev = S.session;
        if (prev) {
          prev.last_turn_event = evt.type === "turn_start" ? "turn_start" : evt.type === "turn_end" ? "turn_end" : prev.last_turn_event;
          if (evt.type === "session_shutdown") prev.has_shutdown = true;
          // Keep the row's pid handle fresh: the extension stamps every event
          // with it, so a terminal run can be stopped the moment it starts
          // working, without waiting for the 15s /sessions poll.
          if (typeof evt.pid === "number") prev.pid = evt.pid;
          renderHeader();
          refreshComposer();
          // A terminal run with no pid yet (an older extension): fetch the
          // session list, where the server resolves it from the session file,
          // so Stop appears without the user waiting out the 15s poll.
          if (evt.type === "turn_start" && !prev.pid) void fetchSessions();
        }
      }
      return;
    }
    el.transcript.appendChild(row);
    follow();
  }

  // ─── The in-flight assistant bubble ───────────────────────────────────────

  function beginLiveTurn() {
    const node = document.createElement("div");
    node.className = "m-msg m-ai m-live";
    node.innerHTML = `<div class="m-bubble">
      <div class="m-ai-head">pi<span class="m-caret"></span></div>
      <pre class="m-text"></pre>
      <details class="m-think" hidden><summary>thinking</summary><pre></pre></details>
      <div class="m-tools"></div>
      <div class="m-chips" hidden></div>
      <div class="m-note err" hidden></div>
    </div>`;
    el.transcript.appendChild(node);
    const textEl = node.querySelector(".m-text");
    LIVE = {
      node,
      textEl,
      textNode: document.createTextNode(""),
      text: "",
      think: node.querySelector(".m-think"),
      thinkPre: node.querySelector(".m-think pre"),
      tools: node.querySelector(".m-tools"),
      byName: new Map(),
      chips: node.querySelector(".m-chips"),
      err: node.querySelector(".m-note.err"),
      first: true,
      done: false,
    };
    textEl.appendChild(LIVE.textNode);
    S.streaming = true;
    S.temp.push(node);
    renderHeader();
    refreshComposer();
    scrollToBottom(true);
    return LIVE;
  }

  /** Seal the current bubble: drop the working caret and surface any error. */
  function finishLiveBubble(error) {
    if (!LIVE) return;
    LIVE.done = true;
    const caret = LIVE.node.querySelector(".m-caret");
    if (caret) caret.remove();
    if (error && LIVE.err) {
      LIVE.err.hidden = false;
      LIVE.err.textContent = error;
    }
    // The deltas streamed as plain text; redraw the sealed bubble in the chosen
    // view now the message is whole (Markdown parses it, Raw shows the source).
    if (LIVE.text && LIVE.textEl) {
      const wrap = document.createElement("div");
      wrap.innerHTML = msgTextHTML(LIVE.text);
      LIVE.textEl.replaceWith(wrap.firstElementChild);
      if (typeof H.hydrateMediaTables === "function") H.hydrateMediaTables(LIVE.node);
    }
    LIVE = null;
  }

  /** Drop every node appended for an adopted run (used when the run settled
   *  before the attach landed and the recorded transcript is loaded instead). */
  function dropTemp() {
    for (const n of S.temp) n.remove();
    S.temp = [];
  }

  function liveToolStart(name, args) {
    if (!LIVE) return;
    const row = document.createElement("details");
    row.className = "m-row m-tool";
    const arg = typeof args === "string" ? args : (args != null ? JSON.stringify(args) : "");
    row.innerHTML = `<summary><span class="m-tool-name">→ ${esc(name || "tool")}</span><span class="m-badge">running</span></summary>
      <pre>${esc(trunc(arg, 4000))}</pre>`;
    LIVE.tools.appendChild(row);
    if (name) LIVE.byName.set(name, row);
  }

  function liveToolEnd(name) {
    if (!LIVE) return;
    const row = LIVE.byName.get(name);
    if (!row) return;
    const badge = row.querySelector(".m-badge");
    if (badge) badge.textContent = "done";
  }

  // ─── Question pi is blocked on ────────────────────────────────────────────

  async function answerAsk(card, id, payload, label) {
    card.classList.add("answered");
    card.querySelectorAll("button, input").forEach((n) => { n.disabled = true; });
    if (label != null) {
      const note = document.createElement("div");
      note.className = "m-note";
      note.textContent = "You: " + label;
      card.appendChild(note);
    }
    const { res, data } = await api("/chat/ui", {}, { sessionId: S.sid, id, ...payload });
    if (!res.ok) hint((data && data.error) || `Could not answer (HTTP ${res.status})`, "err");
  }

  /** Render an answerable card for ui_select / ui_input. pi stays blocked until
   *  it is answered (or dismissed), so this is not optional chrome. */
  function askCard(ev) {
    if (!ev || !ev.id || S.asks.has(ev.id)) return;
    S.asks.add(ev.id);
    const isInput = ev.type === "ui_input";
    const options = Array.isArray(ev.options) ? ev.options : [];
    const card = document.createElement("div");
    card.className = "m-ask";
    card.dataset.id = ev.id;
    card.innerHTML =
      `<div class="m-ask-title">${esc(cleanTitle(ev.title))}</div>` +
      (isInput
        ? `<input class="m-ask-input" type="text" placeholder="${esc(ev.placeholder || "Type your answer…")}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">`
        : options.length
          ? `<div class="m-ask-opts">${options.map((o, i) => `<button class="m-ask-opt" type="button" data-i="${i}">${esc(o)}</button>`).join("")}</div>`
          : "") +
      `<div class="m-ask-foot">` +
      (isInput ? `<button class="m-btn m-ask-send" type="button">Send</button>` : "") +
      `<button class="m-btn m-ask-cancel" type="button">Dismiss</button></div>`;

    card.querySelectorAll(".m-ask-opt").forEach((btn) => {
      btn.addEventListener("click", () => {
        const raw = options[Number(btn.dataset.i)];
        if (raw == null) return;
        void answerAsk(card, ev.id, { value: raw }, raw);
      });
    });
    const input = card.querySelector(".m-ask-input");
    const submit = () => {
      const value = (input.value || "").trim();
      if (!value) { input.focus(); return; }
      void answerAsk(card, ev.id, { value }, value);
    };
    if (input) {
      card.querySelector(".m-ask-send").addEventListener("click", submit);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); submit(); }
      });
    }
    card.querySelector(".m-ask-cancel").addEventListener("click", () => {
      void answerAsk(card, ev.id, { cancelled: true }, "dismissed");
    });

    el.transcript.appendChild(card);
    scrollToBottom(true);
  }

  // ─── The NDJSON chat stream (POST /chat and GET /chat/attach) ─────────────

  function onStreamEvent(ev) {
    switch (ev.type) {
      case "session":
        // The server announces the subprocess key at stream start. Keep it: it
        // is what Stop targets and what later messages reuse while this page
        // stays open. A brand-new conversation keeps S.sid null until pi
        // records it — see tryAdoptDraft.
        if (ev.sessionId) {
          S.runKey = ev.sessionId;
          if (S.sid) S.runKeys.set(S.sid, ev.sessionId);
          renderHeader();
        }
        break;

      case "msg_start":
        if (!LIVE) break;
        // The first message fills the placeholder; a later one is another LLM
        // call in a tool loop and gets its own bubble.
        if (LIVE.first) { LIVE.first = false; break; }
        finishLiveBubble();
        beginLiveTurn();
        break;

      case "text":
        if (!LIVE) break;
        LIVE.text += ev.delta || "";
        LIVE.textNode.data = LIVE.text;
        follow();
        break;

      case "thinking":
        if (!LIVE) break;
        LIVE.think.hidden = false;
        LIVE.thinkPre.textContent += ev.delta || "";
        follow();
        break;

      case "tool_start": liveToolStart(ev.name, ev.args); follow(); break;
      case "tool_end": liveToolEnd(ev.name); break;

      case "usage":
        if (LIVE) {
          // Write into the existing node: replacing its outerHTML would leave
          // LIVE pointing at a detached element and drop later updates.
          const inner = chipSpans(ev.usage);
          LIVE.chips.innerHTML = inner;
          LIVE.chips.hidden = !inner;
        }
        break;

      case "final":
        // Authoritative snapshot — but only a non-empty one: providers that end
        // with an empty content array must not wipe the text already streamed.
        if (LIVE && typeof ev.text === "string" && ev.text) {
          LIVE.text = ev.text;
          LIVE.textNode.data = ev.text;
        }
        break;

      case "ui_open": {
        // A page that attached to a run in flight gets the question it is blocked on.
        const dlg = ev.dlg || {};
        askCard({ ...dlg, type: dlg.type || "ui_select" });
        break;
      }
      case "ui_select":
      case "ui_input":
        askCard(ev);
        break;

      case "ui_notify":
        if (ev.kind && ev.kind !== "info") {
          hint("ℹ " + (ev.message || ""), ev.kind === "error" ? "err" : ev.kind === "warning" ? "warn" : "");
        }
        break;

      case "error":
        // A mid-run error does NOT end the stream — the turn carries on and the
        // reply still arrives. Put it on the live bubble so the phone is told
        // instead of answering in silence: a continuation the server could not
        // resume (its pi session file is gone) reaches the client exactly here.
        if (LIVE && LIVE.err) {
          LIVE.err.hidden = false;
          LIVE.err.textContent = ev.message || "error";
        } else {
          hint(ev.message || "error", "err");
        }
        follow();
        break;

      case "done":
        onRunDone(ev);
        break;

      default:
        break;
    }
  }

  function onRunDone(ev) {
    if (ev && ev.sessionId) S.runKey = ev.sessionId;
    finishLiveBubble(ev && ev.error ? ev.error : "");
    S.streaming = false;
    refreshComposer();
    renderHeader();
    if (ev && ev.aborted) hint("stopped", "");
    else if (ev && ev.error) hint(ev.error, "err");
    // A brand-new conversation becomes a session row on the next poll; refresh
    // now so it appears immediately (and so tryAdoptDraft can bind it).
    void fetchSessions();
  }

  async function consumeStream(res) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        onStreamEvent(ev);
      }
    }
    // The server always closes a run with `done`. If the connection just went
    // away (server restart, network drop) the composer must still be released,
    // or the phone would look permanently "working".
    if (S.streaming) onRunDone({ error: "the connection to pi closed" });
  }

  // ─── Opening a session ────────────────────────────────────────────────────

  async function liveRunFor(sid) {
    const { res, data } = await api("/chat/status");
    if (!res.ok) return null;
    const runs = Array.isArray(data.runs) ? data.runs : [];
    return runs.find((r) => r.sessionId === sid && r.active) || null;
  }

  async function loadTranscript(sid) {
    const { res, data } = await api(`/sessions/${encodeURIComponent(sid)}/events`, { limit: 300 });
    if (S.sid !== sid) return; // a newer selection superseded this load
    if (!res.ok) {
      el.transcript.innerHTML = `<div class="m-note err">Could not load the session (HTTP ${res.status}).</div>`;
      return;
    }
    S.events = Array.isArray(data.events) ? data.events : [];
    S.lastSeq = S.events.reduce((max, e) => (typeof e.seq === "number" && e.seq > max ? e.seq : max), 0);
    renderTranscript();
  }

  /** A run for this session is already in flight: replay it instead of fetching
   *  the transcript, which is partial while pi works and would show the turn
   *  twice once the stream delivered it again. */
  async function attachStream(sid) {
    try {
      const res = await authedFetch(apiUrl("/chat/attach", { sessionId: sid }), { headers: authHeaders() });
      const ct = res.headers.get("content-type") || "";
      if (res.ok && ct.includes("ndjson")) {
        await consumeStream(res);
        return;
      }
      // The run settled between the status snapshot and the attach: show what
      // was recorded instead of waiting on a stream that will produce nothing.
      if (S.sid !== sid) return;
      dropTemp();
      LIVE = null;
      S.streaming = false;
      refreshComposer();
      hint("that turn finished just now", "");
      await loadTranscript(sid);
    } catch (err) {
      hint((err && err.message) || String(err), "err");
    }
  }

  async function openSession(sid) {
    const session = S.sessions.find((s) => s.session_id === sid);
    if (!session) return;
    closeDrawer();
    if (sid === S.sid && S.streaming) return; // already watching this run
    // Browsing into a recorded session drops the draft: this chat is now that
    // session, with its own model and its own pi session file.
    S.draft = null;
    S.sid = sid;
    S.session = session;
    S.model = "";
    S.runKey = null;
    S.resumeFile = session.session_file || null;
    S.events = [];
    S.lastSeq = 0;
    S.streaming = false;
    S.asks = new Set();
    S.temp = [];
    clearAttachments(); // staged files belonged to the previous conversation
    LIVE = null;
    closeLive();
    renderSessions();
    renderHeader();
    refreshComposer();
    el.transcript.innerHTML = `<div class="m-loading">loading…</div>`;
    scrollToBottom(true);

    const run = await liveRunFor(sid);
    if (S.sid !== sid) return;
    if (run) {
      hint("reconnected to the running turn", "");
      if (run.prompt) {
        const userNode = userRow(run.prompt);
        el.transcript.appendChild(userNode);
        S.temp.push(userNode);
      }
      beginLiveTurn();
      await attachStream(sid);
      return;
    }
    await loadTranscript(sid);
    connectLive(sid);
  }

  // ─── Sending ──────────────────────────────────────────────────────────────

  async function sendPrompt() {
    const text = el.input.value.trim();
    if (S.streaming) return;
    if (!S.session || !S.session.cwd) { hint("Pick a session first", "err"); return; }
    if (attachmentsUploading()) { hint("finishing attachment upload…", "warn"); return; }
    // Attachments alone are a valid message: the paths ARE the ask.
    const attPaths = pendingAttachmentPaths();
    if (!text && !attPaths.length) return;
    const prompt = withAttachmentBlock(text, attPaths);

    el.input.value = "";
    autoGrow();
    clearAttachments();
    refreshComposer();
    hint("", "");

    // The draft's row is matched by this opening line (pi records it as
    // first_msg) and by when the recording started, which is now.
    if (S.draft) { S.draft.prompt = S.draft.prompt || prompt; S.draft.at = Date.now(); }

    const userNode = userRow(prompt);
    el.transcript.appendChild(userNode);
    S.temp.push(userNode);
    beginLiveTurn();

    try {
      const res = await authedFetch(apiUrl("/chat"), {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          cwd: S.session.cwd,
          model: currentModel(),
          prompt,
          // No sessionId/sessionFile ⇒ the server spawns a fresh pi session,
          // which IS "new conversation". An open chat reuses the subprocess it
          // already owns, or resumes the recorded session's own file.
          sessionId: S.runKey || S.sid || "",
          sessionFile: S.resumeFile || S.session.session_file || "",
        }),
      });
      const ct = res.headers.get("content-type") || "";
      if (!res.ok || !res.body || !ct.includes("ndjson")) {
        let detail = "";
        try { detail = (await res.json())?.error || ""; } catch { /* non-JSON */ }
        const msg = res.status === 409
          ? "pi is still working this session — try again in a moment"
          : `HTTP ${res.status}${detail ? ": " + detail : ""}`;
        finishLiveBubble(msg);
        S.streaming = false;
        refreshComposer();
        renderHeader();
        hint(msg, "err");
        return;
      }
      await consumeStream(res);
    } catch (err) {
      const msg = (err && err.message) || String(err);
      finishLiveBubble(msg);
      S.streaming = false;
      refreshComposer();
      renderHeader();
      hint(msg, "err");
    }
  }

  async function stopRun() {
    // Stop targets the subprocess this stream owns, or — when the phone is only
    // WATCHING a pi running in the user's terminal — that pi's pid, which the
    // server tracked from the session's recorded events.
    const externalSid = !S.streaming && externalRunLive() ? (S.sid || "") : "";
    const key = stopTarget();
    if (!key) return;
    hint(externalSid ? "stopping the agent running in your terminal…" : "stopping…", "");
    const { res, data } = await api("/chat/stop", {}, { sessionId: key });
    if (!res.ok || !data || !data.ok) {
      hint((data && (data.reason || data.error)) || "could not stop the agent", "err");
      return;
    }
    if (externalSid) {
      patchStoppedExternalRow(externalSid);
      hint("stopped the agent running in your terminal", "");
    }
  }

  // ─── Workspaces, models and the session sheet ─────────────────────────────
  //
  // The phone is not watch-only: it can START a conversation. Pick a workspace
  // and a model and the first message spawns pi there — the exact same
  // contract the desktop uses (POST /chat with no sessionId and no sessionFile,
  // so the server creates a fresh pi session). Nothing is spawned by picking:
  // "new session" only takes effect when the first prompt is sent, so a change
  // of mind leaves no stray subprocess behind.

  // Workspaces are stored per project (each one's own agent-team-config.json),
  // so a phone that has only opened one project would forget the rest. Keep the
  // union of every list seen, the way the desktop sidebar does.
  const WS_KEY = "scope-mobile-ws";

  function loadWsCache() {
    try {
      const v = JSON.parse(localStorage.getItem(WS_KEY) || "[]");
      if (Array.isArray(v)) return v.filter((x) => typeof x === "string" && x);
    } catch { /* private mode / corrupt value */ }
    return [];
  }

  function saveWsCache() {
    try { localStorage.setItem(WS_KEY, JSON.stringify(wsCache)); } catch { /* ignore */ }
  }

  function rememberWs(p) {
    const v = String(p || "").trim();
    if (!v || wsCache.includes(v)) return;
    wsCache.push(v);
    saveWsCache();
  }

  /** Every workspace this phone knows: the open chat's, the sheet's choice, the
   *  ones sessions report, and the cache of lists seen before. */
  function workspaceList() {
    const out = [];
    const seen = new Set();
    const push = (p) => {
      const v = String(p || "").trim();
      if (v && !seen.has(v)) { seen.add(v); out.push(v); }
    };
    push(S.session && S.session.cwd);
    push(S.ws);
    for (const s of S.sessions) push(s.cwd);
    for (const w of wsCache) push(w);
    return out;
  }

  /** Modes pi can boot in. Labels match the desktop's (Settings → Mode). */
  const MODES = [
    { value: "standard", label: "Standard" },
    { value: "creative", label: "Creative" },
  ];

  /** Team names in the configured order, falling back to the map's keys. */
  function teamNames(data) {
    const teams = (data && data.teams) || {};
    const out = (Array.isArray(data && data.teamsOrder) ? data.teamsOrder : [])
      .filter((t) => typeof t === "string" && t && teams[t]);
    for (const t of Object.keys(teams)) if (!out.includes(t)) out.push(t);
    return out;
  }

  /** /agent-team supplies the enabled model list, the workspace lists and the
   *  project's team/mode. It changes rarely, so it is throttled (the desktop
   *  rails do the same). */
  async function fetchTeam(force) {
    const now = Date.now();
    if (!force && S.teamAt && now - S.teamAt < 15000) return;
    S.teamAt = now;
    // While the sheet is choosing a NEW session, the chosen workspace is the
    // project whose team/mode we are about to show — the open chat's workspace
    // is irrelevant there. Otherwise the open chat wins.
    const cwd = (S.sheet === "new" ? S.ws : "") || (S.session && S.session.cwd) || S.ws || "";
    const { res, data } = await api("/agent-team", cwd ? { cwd } : {});
    if (!res.ok || !data) return;
    S.models = Array.isArray(data.enabledModels) ? data.enabledModels.filter((m) => typeof m === "string" && m) : [];
    S.defaultModel = typeof data.defaultModel === "string" ? data.defaultModel : "";
    S.teams = teamNames(data);
    S.activeTeam = typeof data.activeTeam === "string" ? data.activeTeam : "";
    S.mode = data.mode === "creative" || data.mode === "standard" ? data.mode : "";
    for (const w of data.chatWorkspaces || []) rememberWs(w);
    if (S.sheet) renderSheet();
  }

  /** Persist the team + mode a NEW session boots with.
   *
   *  Both are project settings (each workspace has its own agent-team config)
   *  and both are read by pi at agent start — so they are written BEFORE the
   *  first prompt spawns the subprocess; an already-running agent keeps the
   *  harness it booted with. Writing the values the sheet shows (rather than
   *  diffing against a possibly stale snapshot) keeps what the user sees and
   *  what runs in agreement. Returns `{ error }` when a write failed. */
  async function applyTeamMode(cwd, team, mode) {
    let snap = null;
    for (const body of [
      team ? { action: "setTeam", team } : null,
      mode ? { action: "setMode", mode } : null,
    ]) {
      if (!body) continue;
      let res, data;
      try {
        ({ res, data } = await api("/agent-team", {}, { ...body, cwd }));
      } catch (err) {
        return { error: (err && err.message) || String(err) };
      }
      if (!res.ok || !data || data.error) {
        return { error: (data && data.error) || `could not apply ${body.action} (HTTP ${res.status})` };
      }
      snap = data;
    }
    if (snap) {
      S.teams = teamNames(snap);
      if (typeof snap.activeTeam === "string") S.activeTeam = snap.activeTeam;
      if (snap.mode === "creative" || snap.mode === "standard") S.mode = snap.mode;
    }
    return {};
  }

  /** Enabled models first, then any model a known session actually ran with —
   *  the desktop marks those "(session)". */
  function modelList() {
    const out = S.models.slice();
    const seen = new Set(out);
    const used = new Set();
    for (const s of S.sessions) {
      const q = qualifiedModel(s);
      if (q && !seen.has(q)) used.add(q);
    }
    if (S.model && !seen.has(S.model)) used.add(S.model);
    for (const m of [...used].sort()) out.push(m);
    return out;
  }

  /** The model the next message will run with. */
  function currentModel() {
    if (S.model) return S.model;
    if (S.draft) return S.draft.model || S.defaultModel || S.models[0] || "";
    return qualifiedModel(S.session) || S.defaultModel || S.models[0] || "";
  }

  function openSheet(mode) {
    S.sheet = mode;
    // A fresh sheet starts from the open chat's workspace and that project's
    // own team/mode — not from whatever was picked last time.
    S.teamPick = "";
    S.modePick = "";
    if (mode === "new") S.ws = (S.session && S.session.cwd) || S.ws || workspaceList()[0] || "";
    renderSheet();
    el.sheet.hidden = false;
    el.sheet.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => el.sheet.classList.add("open"));
    void fetchTeam(true);
  }

  function closeSheet() {
    S.sheet = null;
    if (!el.sheet) return;
    el.sheet.classList.remove("open");
    el.sheet.setAttribute("aria-hidden", "true");
    setTimeout(() => { if (!S.sheet) el.sheet.hidden = true; }, 180);
  }

  function renderSheet() {
    if (!S.sheet) return;
    const isNew = S.sheet === "new";
    el.sheetTitle.textContent = isNew ? "New session" : "Model for this chat";
    el.fieldWs.hidden = !isNew;
    el.fieldTeam.hidden = !isNew;
    el.fieldMode.hidden = !isNew;
    el.start.hidden = !isNew;
    el.applyModel.hidden = isNew;

    if (isNew) {
      const list = workspaceList();
      const sel = S.ws || "";
      el.wsList.textContent = "";
      if (list.length) {
        for (const w of list) {
          const on = w === sel;
          const btn = document.createElement("button");
          btn.className = `m-opt${on ? " on" : ""}`;
          btn.type = "button";
          btn.dataset.ws = w;
          btn.setAttribute("aria-pressed", String(on));

          const tick = document.createElement("span");
          tick.className = "m-opt-tick";
          tick.textContent = on ? "✓" : "";

          const main = document.createElement("span");
          main.className = "m-opt-main";

          const name = document.createElement("span");
          name.className = "m-opt-name";
          name.textContent = tailPath(w);

          const path = document.createElement("span");
          path.className = "m-opt-path";
          path.textContent = w;

          main.appendChild(name);
          main.appendChild(path);
          btn.appendChild(tick);
          btn.appendChild(main);
          el.wsList.appendChild(btn);
        }
      } else {
        const note = document.createElement("div");
        note.className = "m-note";
        note.textContent = "No workspaces yet — type a path below to add one.";
        el.wsList.appendChild(note);
      }
    }

    if (isNew) {
      // The harness the new agent boots in. Both selects default to this
      // project's current values, so leaving them alone is a no-op in effect.
      // A pick the user made wins over the snapshot, so a snapshot that lands
      // after they chose (the per-workspace refetch) cannot snap the select
      // back under them.
      const team = (S.teams.includes(S.teamPick) ? S.teamPick : "") || S.activeTeam || S.teams[0] || "";
      el.teamSel.innerHTML = S.teams.length
        ? S.teams.map((t) => `<option value="${esc(t)}"${t === team ? " selected" : ""}>${esc(t)}</option>`).join("")
        : `<option value="">no teams configured</option>`;
      el.teamSel.disabled = !S.teams.length;
      const mode = S.modePick || S.mode || "standard";
      el.modeSel.innerHTML = MODES
        .map((m) => `<option value="${m.value}"${m.value === mode ? " selected" : ""}>${m.label}</option>`)
        .join("");
    }

    const chosen = currentModel();
    const opts = modelList();
    if (chosen && !opts.includes(chosen)) opts.unshift(chosen);
    el.modelSel.replaceChildren();
    if (opts.length) {
      for (const m of opts) {
        const opt = document.createElement("option");
        opt.value = String(m ?? "");
        opt.selected = (m === chosen);
        opt.textContent = S.models.includes(m) ? m : m + " · (session)";
        el.modelSel.appendChild(opt);
      }
    } else {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "no models enabled";
      el.modelSel.appendChild(opt);
    }
    el.modelSel.disabled = !opts.length;
  }

  /** Add a workspace by path — the same POST the desktop sidebar makes. */
  async function addWorkspaceFromSheet() {
    const p = (el.wsInput.value || "").trim();
    if (!p) { el.wsInput.focus(); return; }
    const before = new Set(wsCache);
    const cwd = (S.session && S.session.cwd) || S.ws || "";
    const { res, data } = await api("/agent-team", {}, { action: "addWorkspace", path: p, cwd });
    if (!res.ok || !data) {
      hint((data && data.error) || `could not add that workspace (HTTP ${res.status})`, "err");
      return;
    }
    const list = data.chatWorkspaces || [];
    for (const w of list) rememberWs(w);
    // The server stores the realpath it resolved, so select the entry that was
    // not in the cache a moment ago rather than the raw text that was typed.
    S.ws = list.find((w) => !before.has(w)) || (list.includes(p) ? p : p);
    el.wsInput.value = "";
    hint("workspace added", "");
    renderSheet();
  }

  /** Begin a brand-new conversation in the chosen workspace with the chosen
   *  model, team and mode. Nothing is sent (and nothing is spawned) until the
   *  first message; the team/mode writes must be on disk first, because pi reads
   *  them when the subprocess boots — which the first message triggers. */
  async function startNewSession() {
    const cwd = (S.ws || (S.session && S.session.cwd) || "").trim();
    if (!cwd) { hint("Pick a workspace first", "err"); return; }
    const model = (el.modelSel.value || S.defaultModel || "").trim();
    const team = (el.teamSel.value || "").trim();
    const mode = (el.modeSel.value || "").trim();
    el.start.disabled = true;
    const applied = await applyTeamMode(cwd, team, mode);
    el.start.disabled = false;
    // The harness could not be written, so this session would NOT run the way
    // the sheet says. Report it and stay on the sheet rather than starting an
    // agent under settings the user did not choose.
    if (applied.error) { hint(applied.error, "err"); return; }
    closeSheet();
    closeLive();
    S.sid = null;
    S.runKey = null;
    S.resumeFile = null;
    S.model = model;
    S.draft = { cwd, model, at: Date.now(), prompt: "" };
    S.session = { session_id: null, cwd, model, agent_name: "new session" };
    S.events = [];
    S.lastSeq = 0;
    S.streaming = false;
    S.asks = new Set();
    S.temp = [];
    clearAttachments(); // a new conversation starts with a clean composer
    LIVE = null;
    rememberWs(cwd);
    renderSessions();
    renderHeader();
    refreshComposer();
    el.transcript.textContent = "";
    const empty = document.createElement("div");
    empty.className = "m-empty";

    const ic = document.createElement("span");
    ic.className = "m-empty-ic";
    ic.setAttribute("aria-hidden", "true");
    ic.textContent = "◈";

    const title = document.createElement("div");
    title.className = "m-hero-title";
    title.append("New ");
    const amber = document.createElement("span");
    amber.className = "m-hero-amber";
    amber.textContent = "session";
    title.appendChild(amber);

    const stats = document.createElement("div");
    stats.className = "m-stats";
    const stat = document.createElement("span");
    stat.className = "m-stat";
    const statK = document.createElement("span");
    statK.className = "m-stat-k";
    statK.textContent = "workspace";
    const statV = document.createElement("span");
    statV.className = "m-stat-v";
    statV.textContent = tailPath(cwd);
    stat.appendChild(statK);
    stat.appendChild(statV);
    stats.appendChild(stat);

    const body = document.createElement("p");
    body.className = "m-hero-body";
    body.textContent = "Send a message to start it in that workspace.";

    empty.appendChild(ic);
    empty.appendChild(title);
    empty.appendChild(stats);
    empty.appendChild(body);
    el.transcript.appendChild(empty);
    scrollToBottom(true);
    hint("new session · " + [model || "default model", S.activeTeam, S.mode].filter(Boolean).join(" · "), "");
    el.input.focus();
  }

  /** Re-point the open chat at another model. A live (or pre-spawned)
   *  subprocess is updated in place via /chat/prefs; otherwise the choice just
   *  rides on the next POST /chat. */
  async function applyModel(model) {
    const m = (model || "").trim();
    if (!m) return;
    S.model = m;
    if (S.draft) S.draft.model = m;
    refreshComposer();
    closeSheet();
    const key = S.runKey || S.sid || "";
    if (!key) { hint("model · " + m + " (applies to your next message)", ""); return; }
    const { res, data } = await api("/chat/prefs", {}, { sessionId: key, model: m });
    // `ok:false` just means there is no subprocess to push to yet — the next
    // message still runs with the chosen model, so this is not an error.
    hint(res.ok && data && data.ok
      ? "model · " + m
      : "model · " + m + " (applies to your next message)", "");
  }

  /** pi writes the conversation's row a moment after its first turn. Bind the
   *  phone to it then, so the drawer shows the conversation and reopening it
   *  resumes the same pi session instead of starting a second one. */
  function tryAdoptDraft() {
    const d = S.draft;
    if (!d || !d.prompt) return;
    const want = String(d.prompt).slice(0, 200).trim();
    let best = null;
    let bestDt = Infinity;
    for (const s of S.sessions) {
      if (s.parent_session_id) continue;
      if (String(s.cwd || "") !== d.cwd) continue;
      if (String(s.first_msg || "").slice(0, 200).trim() !== want) continue;
      const ft = Date.parse(s.first_ts || "") || 0;
      // A row that started well before this send belongs to another
      // conversation that merely opened with the same words.
      if (!ft || ft < d.at - 5000) continue;
      const dt = Math.abs(ft - d.at);
      if (dt < bestDt) { best = s; bestDt = dt; }
    }
    if (!best) return;
    S.draft = null;
    S.sid = best.session_id;
    S.session = best;
    S.resumeFile = best.session_file || S.resumeFile;
    // Remember which subprocess serves this session, so deleting it can kill
    // that specific pi (it is keyed by a generated id, not the recorded one).
    if (S.runKey) S.runKeys.set(best.session_id, S.runKey);
    renderSessions();
    renderHeader();
    refreshComposer();
  }

  // ─── Wiring ───────────────────────────────────────────────────────────────

  function wire() {
    el.menu.addEventListener("click", () => {
      if (el.drawer.classList.contains("open")) closeDrawer();
      else { openDrawer(); void fetchSessions(); }
    });
    el.drawerClose.addEventListener("click", closeDrawer);
    el.scrim.addEventListener("click", closeDrawer);

    // Starting a conversation: the header ＋, the drawer action and the
    // empty-state button all open the same sheet.
    el.new.addEventListener("click", () => openSheet("new"));
    el.drawerNew.addEventListener("click", () => { closeDrawer(); openSheet("new"); });
    el.transcript.addEventListener("click", (e) => {
      const copy = e.target.closest("[data-copy]");
      if (copy) { copyText(copy.dataset.copy); return; }
      if (e.target.closest("[data-new]")) openSheet("new");
    });

    // Light / dark theme, remembered across visits (see setTheme).
    if (el.theme) el.theme.addEventListener("click", () => {
      setTheme(document.body.hasAttribute("data-ds-dark-theme") ? "light" : "dark");
    });

    // The model chip re-points the open chat at another model.
    el.modelChip.addEventListener("click", () => openSheet("model"));

    // The Markdown / Raw switch for assistant replies.
    if (el.viewToggle) el.viewToggle.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-view]");
      if (btn) setView(btn.dataset.view);
    });

    // Sheet interactions. The workspace list is re-rendered on every pick, so
    // its options are handled by delegation.
    el.sheetClose.addEventListener("click", closeSheet);
    el.sheet.addEventListener("click", (e) => { if (e.target === el.sheet) closeSheet(); });
    el.wsList.addEventListener("click", (e) => {
      const opt = e.target.closest(".m-opt");
      if (!opt || !opt.dataset.ws) return;
      S.ws = opt.dataset.ws;
      renderSheet();
      // Team/mode are per project: show the newly chosen workspace's own.
      void fetchTeam(true);
    });
    el.wsAdd.addEventListener("click", () => void addWorkspaceFromSheet());
    el.wsInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); void addWorkspaceFromSheet(); }
    });
    // Remember what the user picked, so a snapshot that arrives afterwards
    // cannot re-render the select back to the project's stored value.
    el.teamSel.addEventListener("change", () => { S.teamPick = el.teamSel.value; });
    el.modeSel.addEventListener("change", () => { S.modePick = el.modeSel.value; });
    el.start.addEventListener("click", () => void startNewSession());
    el.applyModel.addEventListener("click", () => void applyModel(el.modelSel.value));

    el.sessions.addEventListener("click", (e) => {
      // Delete first: its button is a sibling of the row, and the row handler
      // would otherwise swallow nothing today but could after a re-layout.
      const del = e.target.closest(".m-sess-del");
      if (del && del.dataset.del) { void deleteSession(del.dataset.del); return; }
      const row = e.target.closest(".m-sess");
      if (row && row.dataset.sid) void openSession(row.dataset.sid);
    });

    // Back to the desktop UI, explicitly — the same URL, with `ui=desktop` so
    // the server does not send the phone layout again. The access token rides
    // along because the desktop bundle has no refresh of its own: the borrowed
    // layout lives as long as that token does (half an hour), and the phone
    // layout picks up where it left off afterwards. The master token is never in
    // the phone's hands to pass on.
    el.desktop.addEventListener("click", () => {
      const p = new URLSearchParams();
      if (TOKEN) p.set("token", TOKEN);
      p.set("ui", "desktop");
      p.set("view", "chat");
      const path = location.pathname === "/m" || location.pathname === "/mobile" ? "/" : location.pathname;
      location.href = `${path}?${p.toString()}`;
    });

    el.input.addEventListener("input", () => { autoGrow(); refreshComposer(); });
    el.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void sendPrompt();
      }
    });
    el.send.addEventListener("click", () => void sendPrompt());
    el.stop.addEventListener("click", () => void stopRun());
    el.attach.addEventListener("click", () => pickAttachments());
    // Snapshot the FileList BEFORE clearing the input value: `files` is live, so
    // resetting value would empty it out from under us.
    el.attachInput.addEventListener("change", () => {
      const files = [...(el.attachInput.files || [])];
      el.attachInput.value = ""; // let the same file be picked again
      void addAttachmentFiles(files);
    });
    el.jump.addEventListener("click", () => scrollToBottom(true));

    el.transcript.addEventListener("scroll", () => {
      S.follow = nearBottom();
      el.jump.hidden = S.follow;
    });

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (S.sheet) closeSheet();
      else closeDrawer();
    });

    // The jump pill floats just above the composer, which grows with the
    // textarea, the staged attachments and the safe-area inset. Publish its
    // height so the CSS can anchor to it instead of guessing a constant.
    const trackComposer = () => {
      document.documentElement.style.setProperty("--composer-h", `${el.composer.offsetHeight}px`);
    };
    trackComposer();
    if (typeof ResizeObserver === "function") new ResizeObserver(trackComposer).observe(el.composer);
    else window.addEventListener("resize", trackComposer);

    // The composer must not sit under the keyboard: iOS shrinks the visual
    // viewport, so re-measure and re-stick to the newest row when it changes.
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", () => {
        autoGrow();
        if (S.follow) scrollToBottom(true);
      });
    }

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      void fetchSessions();
      if (S.sid && !es) connectLive(S.sid);
    });
    window.addEventListener("online", () => {
      void fetchSessions();
      if (S.sid && !es && !S.streaming) connectLive(S.sid);
    });

    // The pairing gate's only way out: a code, exchanged for a token pair.
    if (el.pairGo) {
      el.pairGo.addEventListener("click", async () => {
        const code = (el.pairCode.value || "").trim();
        if (!code) {
          setPairHint("Type the code shown in the phone panel.", true);
          el.pairCode.focus();
          return;
        }
        el.pairGo.disabled = true;
        setPairHint("Pairing…", false);
        const paired = await exchangePairCode(code);
        el.pairGo.disabled = false;
        if (!paired) return;
        el.pairCode.value = "";
        hidePairGate();
        await resumeAfterPair();
      });
      el.pairCode.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); el.pairGo.click(); }
      });
      // A complete code (six digits, separators optional) submits itself: on a
      // phone keyboard there is nothing else to do after the last digit.
      el.pairCode.addEventListener("input", () => {
        if (el.pairCode.value.replace(/\D/g, "").length === 6) el.pairGo.click();
      });
    }
  }

  /**
   * Register the worker that makes this page installable (see sw.js). It does
   * nothing but answer a failed launch with the offline card — the API and the
   * event stream are left to the browser — and it is scoped to `/m` so the
   * desktop app at `/` is never under it.
   */
  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/m" }).catch(() => {
      /* http:// on the LAN, or a browser without workers: the page still runs */
    });
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────
  // Two phases: `boot` decides whether this phone may proceed (stored
  // credentials, renewed first if the access token has lapsed), and `start` does
  // the first paint + polling. They are separate because the gate can be reached
  // later, when a pairing ends — re-pairing then resumes the app without
  // re-wiring its listeners.
  let started = false;

  async function start() {
    if (started) return;
    started = true;
    await fetchSessions();
    // Enabled models + the workspace lists the sheet offers.
    await fetchTeam(true);

    // A deep link (`?sid=…`, or the desktop's `#view=chat&sid=…` shape) opens
    // that session straight away.
    const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
    const sid = qp.get("sid") || hash.get("sid");
    if (sid && S.sessions.some((s) => s.session_id === sid)) void openSession(sid);

    setInterval(() => { void fetchSessions(); }, 15000);
  }

  /** After a successful pairing: pick the app back up where it was left. */
  async function resumeAfterPair() {
    if (started) {
      await fetchSessions();
      if (S.sid && !es && !S.streaming) connectLive(S.sid);
      return;
    }
    await start();
  }

  async function boot() {
    cache();
    loadCredentials();
    wire();
    registerServiceWorker();
    // The inline bootstrap already applied the stored theme; sync the button's
    // glyph/label to whatever it chose.
    syncThemeButton();
    updateViewToggle();
    refreshComposer();
    renderHeader();

    // No credential means no app: the gate owns the screen until the code from
    // the desktop's phone panel is typed in.
    if (!TOKEN && !REFRESH) { showPairGate(); return; }

    // A phone that sat overnight renews before the first paint, so the gate does
    // not flash on a pairing that is perfectly fine.
    if (REFRESH && (!TOKEN || expiresSoon(30_000))) {
      const ok = await refreshAccess();
      if (!ok && !TOKEN) {
        showPairGate("This server reissued its credentials — enter the code from the phone panel.");
        return;
      }
    }
    scheduleRefresh();

    await start();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
