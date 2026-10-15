#!/usr/bin/env python3
"""Persistent batch web-fetch runner for the pi `web-fetch` tool.

ONE headless Chromium (via Playwright) is started once and reused across
batches, so the multi-second Python + Playwright + Chromium startup is paid
once per session instead of once per tool call. The TS side keeps this
process alive between tool calls (idle-timeout / session end closes stdin,
which shuts us down gracefully).

The browser runs on a PERSISTENT profile directory (user-data-dir, from
WEB_FETCH_PROFILE_DIR, default ~/.pi/web-fetch-profile), so cookies, logins
and site state survive process restarts (idle kill, crash, session end) —
the same session is reused across all tool calls, and after a respawn.
All pages share that one context: a cookie/login set on one page is visible
to every later page, in the same batch or a later tool call.

Protocol (newline-delimited JSON) — unchanged from the previous runner.
----------------------------------------------------------------------
stdin : one request per line:
        {"batch": int, "concurrency": int, "timeout_ms": int,
         "page_delay_s": float, "scan_full_page": bool,
         "jobs": [{"key": int, "url": str, "raw": bool, "light": bool,
                   "max": int, "extract": "serp"|absent}, ...]}
        stdin EOF -> graceful shutdown.
stdout: one result per completed job:
        {"batch": int, "key": int, "url": str, "ok": true,  "text": str,
         "status": int|null, "title": str}
        {"batch": int, "key": int, "url": str, "ok": false, "error": str}
        For `extract: "serp"` jobs, `text` is "" and the payload is instead:
        {"batch": int, "key": int, "url": str, "ok": bool,
         "results": [{"url": str, "title": str, "snippet": str}],
         "blocked": bool, "status": int|null, "error": str}
        Page jobs whose extraction yields nothing report WHY in `error`
        (bot check, HTTP status, empty shell) instead of returning a blank page.
        then a batch terminator: {"batch": int, "done": true}
exit  : 0 on EOF, 1 on fatal/browser error (TS respawns lazily on next batch).
"""
import asyncio
import json
import os
import random
import re
import sys
import traceback
from html import unescape as html_unescape

from playwright.async_api import async_playwright
from html_to_markdown import convert, ConversionOptions

# A real, recent desktop Chrome UA (Playwright's default advertises
# HeadlessChrome). Keep the version in sync with CH_UA below.
CHROME_VERSION = "133"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/%s.0.0.0 Safari/537.36" % CHROME_VERSION
)
# Client-hint headers Chromium would send for that UA. Headless builds brand
# themselves "HeadlessChrome" — every anti-bot stack checks this first.
CH_UA = '"Chromium";v="%s", "Google Chrome";v="%s", "Not-A.Brand";v="99"' % (CHROME_VERSION, CHROME_VERSION)

# Realistic viewport/screen combos seen on desktop Chrome.
VIEWPORTS = [
    {"width": 1920, "height": 1080},
    {"width": 1536, "height": 864},
    {"width": 1440, "height": 900},
    {"width": 1366, "height": 768},
    {"width": 1280, "height": 800},
]

# Remove cookie/consent dialogs & overlays before extracting the page.
JS_CODE = (
    "const s='[role=\"dialog\"]|[aria-modal=\"true\"]|.cookie-consent|.consent-popup"
    "|#cookieChoiceInfo|.govuk-cookie-banner';"
    "s.split('|').forEach(x=>{document.querySelectorAll(x).forEach(y=>y.remove())})"
)

# Kill non-content visuals: base64-URI images (huge token waste) and inline
# SVGs that carry no text/label (icons). SVGs with <text>/<title>/aria-label
# are kept — those are usually real diagrams.
CLEANUP_JS = (
    "document.querySelectorAll('img[src^=\"data:\"]').forEach(i=>i.remove());"
    "document.querySelectorAll('svg').forEach(s=>{"
    "const t=(s.querySelector('title')||{}).textContent;"
    "if(!s.querySelector('text') && !(t||'').trim() && !s.getAttribute('aria-label')) s.remove();"
    "});"
)

# Focus the extraction on the page's content container. Among candidate
# containers with substantial text, pick the one with the highest text
# density (chars per DOM node): pure prose (README/article bodies) beats
# link-table chrome, even when the chrome wraps it (GitHub's <article>
# nested in <main>). Falls back to the whole body when no container
# dominates, so forum/table layouts and SPAs lose nothing.
# `bl>1200` guard: on thin pages (SPA shells, interstitials, bot-check pages)
# the "densest container" is usually the interstitial itself, and replacing
# body with it is how a page that HAD text came back empty. Below the guard
# the whole body is kept — noise costs less than a silently blank fetch.
MAIN_CONTENT_JS = (
    "let best=null,bestScore=0;"
    "const bl=(document.body.innerText||'').length;"
    "if(bl>1200){"
    "for(const c of document.querySelectorAll('main,article,[role=\"main\"]')){"
    "const l=(c.innerText||'').length;"
    "if(l>500 && l>=bl*0.25){const s=l/(1+c.querySelectorAll('*').length);"
    "if(s>bestScore){best=c;bestScore=s;}}}}"
    "if(best){"
    "const t=document.createElement('template');"
    "t.content.appendChild(best.cloneNode(true));"
    "document.body.replaceChildren(t.content);"
    "}"
)

# ── SERP extraction ──────────────────────────────────────────────────────
# Structured search-result extraction, run in the page instead of regexing
# URLs out of rendered markdown. Returns [{url,title,snippet,ad}].
#
# Why: markdown-regex extraction has no notion of a result record — it picks
# up ad links, sidebar/related-search links and bare URLs inside snippets, and
# throws away titles/snippets (the only relevance signal a SERP actually has).
# Reading the DOM gives title + snippet per result, lets us drop ad slots, and
# lets us unwrap DuckDuckGo's click-tracking redirect to the real URL.
#
# Selectors: DuckDuckGo's result containers first (html + lite endpoints), then
# a generic block heuristic, so a markup change degrades to slightly noisier
# results instead of none.
SERP_JS = r"""
(ctx) => {
  ctx = ctx || {};
  const base = ctx.base || location.href;
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  // Engine-owned hosts are chrome, never sources.
  const ENGINE_HOSTS = ["duckduckgo.com", "google.com", "bing.com", "googleadservices.com", "doubleclick.net"];
  const isEngineHost = (h) => ENGINE_HOSTS.some((d) => h === d || h.endsWith("." + d));
  // Unwrap DuckDuckGo's click-tracking redirect (//duckduckgo.com/l/?uddg=REAL).
  const unwrap = (raw) => {
    let u;
    try { u = new URL(raw, base); } catch (e) { return null; }
    const uddg = u.searchParams.get("uddg");
    if (uddg) { try { u = new URL(uddg); } catch (e) { return null; } }
    return u.href;
  };
  const CONTAINERS = [".result:not(.result--ad)", "tr:has(a.result-link)", ".web-result"];
  const TITLE_SEL = ".title, h1, h2, h3, h4";
  const SNIPPET_SEL = ".result__snippet, .result-snippet, .snippet-description, .content";
  const AD_SEL = ".result--ad,[data-ad],.ads-ad,.ad";
  const AD_HREF = /(\/y\.js|ad_provider=|ad_domain=)/i;
  const NAV_TEXT = /^(images?|videos?|news|maps?|shopping|more|settings|sign in|log ?in|help|feedback|privacy|terms|about|cookies?|preferences|next|previous|all|web|search)$/i;

  const titleOf = (a) => {
    const h = a.querySelector(TITLE_SEL) || a.closest(TITLE_SEL);
    const ht = h ? norm(h.textContent) : "";
    return (ht.length >= 8 && ht.length <= 300) ? ht : norm(a.textContent).slice(0, 300);
  };
  const snippetOf = (node, title) => {
    let s = "";
    for (const el of node.querySelectorAll(SNIPPET_SEL)) {
      const t = norm(el.textContent);
      if (t.length > s.length && !t.includes(title)) s = t;
      if (s.length > 400) break;
    }
    if (!s) {
      s = norm(node.textContent);
      if (s.startsWith(title)) s = s.slice(title.length);
    }
    return s.replace(/\s+/g, " ").trim().slice(0, 500);
  };

  let nodes = [];
  for (const sel of CONTAINERS) {
    try { nodes = Array.from(document.querySelectorAll(sel)); } catch (e) { nodes = []; }
    if (nodes.length) break;
  }
  if (!nodes.length) {
    // Fallback: outermost blocks holding a plausible result link + text, so a
    // SERP redesign degrades to slightly noisier results instead of none.
    const all = Array.from(document.querySelectorAll("main li,main div,#links li,#links div,li,div"));
    nodes = all.filter((n) => {
      const len = norm(n.textContent).length;
      if (len < 40 || len > 4000) return false;
      const a = n.querySelector("a[href]");
      if (!a) return false;
      const raw = a.getAttribute("href") || "";
      return /^(https?:)?\/\//i.test(raw) || /^\/(l|url)[?/]/i.test(raw);
    });
    nodes = nodes.filter((n) => !nodes.some((o) => o !== n && o.contains(n)));
  }

  const out = [];
  const seen = new Set();
  for (const n of nodes) {
    // The title link is the one in a heading — not the favicon/site-name link
    // sitting next to it.
    let best = null, bestScore = -1;
    for (const a of n.querySelectorAll("a[href]")) {
      const raw = a.getAttribute("href") || "";
      if (!/^(https?:)?\/\//i.test(raw) && !/^\/(l|url)[?/]/i.test(raw)) continue;
      const t = norm(a.textContent);
      if (t.length < 8 || t.length > 400 || NAV_TEXT.test(t)) continue;
      const inHeading = !!(a.closest("h1,h2,h3,h4") || a.querySelector("h1,h2,h3,h4"));
      const score = t.length + (inHeading ? 500 : 0);
      if (score > bestScore) { bestScore = score; best = a; }
    }
    if (!best) continue;
    const url = unwrap(best.getAttribute("href"));
    if (!url) continue;
    let u; try { u = new URL(url); } catch (e) { continue; }
    if (isEngineHost(u.hostname.toLowerCase())) continue;
    const key = u.hostname.toLowerCase().replace(/^www\./, "") + u.pathname.replace(/\/$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    const title = titleOf(best);
    out.push({
      url: u.href,
      title: title,
      snippet: snippetOf(n, title),
      ad: !!n.closest(AD_SEL) || AD_HREF.test(best.getAttribute("href") || ""),
    });
    if (out.length >= 30) break;
  }
  return out;
}
"""

# Visible-text markers of bot checks / rate limits. Used to tell "this engine
# blocked us" apart from "this engine genuinely had no results", so the caller
# can fall back to another engine instead of reporting an empty SERP.
BLOCK_RE = re.compile(
    r"(bots use duckduckgo|select all squares|unusual traffic|verify you are human|are you a robot|"
    r"complete the following challenge|checking your browser|enable javascript and cookies to continue|"
    r"please verify you are a human|access to this page has been denied|too many requests|"
    r"if this persists, please email us|automated queries)",
    re.I,
)

# Below this many extracted chars a page is treated as empty (shell / blocked /
# paywall) instead of being passed off to the caller as content. Kept low so
# genuinely short pages (e.g. example.com, ~170 chars) still count as content.
MIN_PAGE_CHARS = 80

# Used by the extraction ladder in extract_text().
SCRIPT_RE = re.compile(r"<(script|style|noscript|template)\b[^>]*>.*?</\1\s*>", re.I | re.S)
BODY_RE = re.compile(r"<body\b[^>]*>(.*?)</body\s*>", re.I | re.S)
TAG_RE = re.compile(r"<[^>]*>")

# Comprehensive stealth init script. Runs in every frame (main + iframes)
# before any page JS, patching the surfaces anti-bot stacks probe:
# webdriver flag, window.chrome, plugins/languages/platform, permissions,
# WebGL vendor/renderer, hardware hints, visibility/focus.
STEALTH_JS = r"""
(() => {
  const define = (obj, prop, value) => {
    try { Object.defineProperty(obj, prop, { get: () => value, configurable: true }); } catch (e) {}
  };

  // -- navigator.webdriver: a real Chrome (with AutomationControlled off)
  //    doesn't expose the property AT ALL — not even as false. Playwright's
  //    Chromium sets the prototype getter to return false, which detectors
  //    flag ("property present"), so remove it from the prototype itself.
  try { delete Object.getPrototypeOf(navigator).webdriver; } catch (e) {}
  try { delete navigator.webdriver; } catch (e) {}

  // -- window.chrome: real shape with runtime/loadTimes/csi
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) {
    window.chrome.runtime = {
      PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' },
      PlatformArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64' },
      PlatformNaclArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64' },
      RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', UPDATE_AVAILABLE: 'update_available', THROTTLED: 'throttled' },
      OnInstalledReason: { INSTALL: 'install', UPDATE: 'update', CHROME_UPDATE: 'chrome_update', SHARED_MODULE_UPDATE: 'shared_module_update' },
      OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
    };
  }
  window.chrome.loadTimes = window.chrome.loadTimes || (() => ({
    requestTime: performance.timeOrigin / 1000,
    startLoadTime: performance.timeOrigin / 1000,
    commitLoadTime: Date.now() / 1000,
    finishDocumentLoadTime: Date.now() / 1000,
    finishLoadTime: Date.now() / 1000,
    firstPaintTime: Date.now() / 1000,
    firstPaintAfterLoadTime: 0,
    navigationType: 'Other',
    wasFetchedViaSpdy: true,
    wasNpnNegotiated: true,
    npnNegotiatedProtocol: 'h2',
    wasAlternateProtocolAvailable: false,
    connectionInfo: 'h2',
  }));
  window.chrome.csi = window.chrome.csi || (() => ({
    startE: Date.now(), onloadT: Date.now(), pageT: performance.now(),
    tran: 15,
  }));

  // -- plugins/mimeTypes: the fake [1,2,3,4,5] array is itself a bot tell
  //    (detectors check `instanceof PluginArray`). Build real PluginArray /
  //    MimeTypeArray instances holding the five PDF plugins real desktop
  //    Chrome ships, and Plugin instances for the entries.
  // Some Chromium builds don't expose the plugin DOM constructors at all,
  // which makes `navigator.plugins instanceof PluginArray` unpassable.
  // Polyfill them (Illegal-constructor style) and chain our objects to their
  // prototypes so both instanceof and toString checks pass.
  const ensureClass = (name, tag) => {
    if (window[name]) return window[name];
    const C = function () { throw new TypeError('Illegal constructor'); };
    C.prototype = Object.create(Object.prototype);
    Object.defineProperty(C.prototype, Symbol.toStringTag, { value: tag, configurable: true });
    Object.defineProperty(window, name, { value: C, configurable: true, writable: false });
    return C;
  };
  const PluginC = ensureClass('Plugin', 'Plugin');
  const MimeTypeC = ensureClass('MimeType', 'MimeType');
  const PluginArrayC = ensureClass('PluginArray', 'PluginArray');
  const MimeTypeArrayC = ensureClass('MimeTypeArray', 'MimeTypeArray');

  // Native prototypes carry accessor properties (length, name, type, ...)
  // with no setters — plain assignment fails silently and reads then invoke
  // the native getter (Illegal invocation). Shadow every property with
  // defineProperty instead.
  const prop = (obj, k, v) => {
    try { Object.defineProperty(obj, k, { value: v, writable: true, enumerable: true, configurable: true }); }
    catch (e) { try { obj[k] = v; } catch (e2) {} }
  };
  const mkPlugin = (name, desc) => {
    const p = Object.create(PluginC.prototype);
    prop(p, 'name', name); prop(p, 'description', desc); prop(p, 'filename', 'internal-pdf-viewer');
    const mt = Object.create(MimeTypeC.prototype);
    prop(mt, 'type', 'application/pdf'); prop(mt, 'suffixes', 'pdf'); prop(mt, 'description', desc);
    prop(mt, 'enabledPlugin', p);
    prop(p, '0', mt); prop(p, 'length', 1);
    return p;
  };
  const mkCollection = (proto, items) => {
    const col = Object.create(proto);
    prop(col, 'length', items.length);
    prop(col, 'item', (i) => items[i] || null);
    prop(col, 'namedItem', (n) => items.find((x) => x.name === n) || null);
    prop(col, 'refresh', () => {});
    items.forEach((it, i) => prop(col, String(i), it));
    return col;
  };
  const plugins = ['PDF Viewer', 'Chrome PDF Viewer', 'Chromium PDF Viewer',
                   'Microsoft Edge PDF Viewer', 'WebKit built-in PDF']
    .map((n) => mkPlugin(n, 'Portable Document Format'));
  define(navigator, 'plugins', mkCollection(PluginArrayC.prototype, plugins));
  define(navigator, 'mimeTypes', mkCollection(MimeTypeArrayC.prototype,
    plugins.map((p) => p[0])));

  define(navigator, 'languages', Object.freeze(['en-US', 'en']));
  define(navigator, 'platform', 'Win32');
  define(navigator, 'hardwareConcurrency', 8);
  define(navigator, 'deviceMemory', 8);
  define(navigator, 'maxTouchPoints', 0);

  // -- permissions: headless reports notifications as 'prompt' even when the
  //    real browser would say 'default'; report a self-consistent value.
  try {
    const q = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (p) => (p && p.name === 'notifications')
      ? Promise.resolve({ state: window.Notification ? Notification.permission : 'prompt', onchange: null })
      : q(p);
  } catch (e) {}

  // -- WebGL: headless falls back to SwiftShader; that vendor/renderer string
  //    is one of the strongest single-signal bot fingerprints.
  try {
    const VENDOR = 'Intel Inc.';
    const RENDERER = 'Intel Iris OpenGL Engine';
    const hook = function (param) {
      if (param === 37445) return VENDOR;   // UNMASKED_VENDOR_WEBGL
      if (param === 37446) return RENDERER; // UNMASKED_RENDERER_WEBGL
      return WebGLRenderingContext.prototype.getParameter.call(this, param);
    };
    WebGLRenderingContext.prototype.getParameter = hook;
    if (window.WebGL2RenderingContext) WebGL2RenderingContext.prototype.getParameter = hook;
  } catch (e) {}

  // -- visibility/focus: headless pages report 'hidden'/hasFocus=false.
  define(document, 'visibilityState', 'visible');
  define(document, 'hidden', false);
  try { document.hasFocus = () => true; } catch (e) {}
})();
"""

# html-to-markdown does NOT resolve relative/protocol-relative URLs, so rewrite
# every anchor href to absolute first. The browser's `a.href` property is
# already resolved against the document base, so writing it back makes the
# emitted markdown links absolute (required for the DDG redirect unwrapping).
RESOLVE_LINKS_JS = (
    "document.querySelectorAll('a[href]').forEach(a=>{"
    "try{a.setAttribute('href',a.href)}catch(e){}})"
)

# One evaluate() per phase instead of four: each roundtrip to the browser
# costs ~ms; combining cuts IPC by half without changing behavior.
PREPARE_JS = JS_CODE + "\n;\n" + RESOLVE_LINKS_JS
# FINISH_JS ends with an expression: evaluate() returns the rendered text length
# AFTER container selection, which the caller uses as the reference for "did the
# markdown conversion actually keep the page's text?" (see extract_text ladder).
FINISH_JS = CLEANUP_JS + "\n;\n" + MAIN_CONTENT_JS + "\n;\n(document.body.innerText||'').length"

# Boilerplate pruning. html-to-markdown strips script/style by default; we also
# drop nav/footer/aside so the fetched markdown is content-focused. `extract_metadata`
# is off so no YAML front-matter block is prepended.
CONVERT_OPTIONS = ConversionOptions(
    extract_metadata=False,
    exclude_selectors=[
        "nav", "footer", "aside", "script", "style", "noscript",
        # Sphinx/kramdown-style permanent-heading anchors ("¶"), which would
        # otherwise surface as junk links like "## Usage[¶](#usage)".
        ".headerlink", "a.anchor",
    ],
)


def emit(obj):
    try:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    except BrokenPipeError:
        # Consumer (TS side) is gone — nothing to write to; exit quietly
        # instead of spraying tracebacks on stderr.
        raise SystemExit(0)


def _slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def clean_markdown(md, page_url=None):
    """LLM-focused post-processing: drop image markup (badges/avatars are
    token waste; alt-text rarely carries content), unwrap self-referential
    heading-anchor links (href fragment == slug of the link text — MkDocs/
    GitHub-style "[Section titled ...](...#same-slug)" just duplicates the
    heading), drop empty-text icon links, and collapse the blank-line runs
    the converter emits around removed elements."""

    page_base = page_url.split("#", 1)[0].rstrip("/") if page_url else None

    def unwrap_anchor(m):
        text, href = m.group(1), m.group(2)
        frag = href.split("#", 1)[1] if "#" in href else ""
        if not frag:
            return m.group(0)
        # Only unwrap when the link actually points back at this page
        # (fragment-only, or a URL equal to the page's base). Cross-page
        # section links keep their URL — the link itself is useful.
        link_base = href.split("#", 1)[0]
        same_page = not link_base or (
            page_base and link_base.rstrip("/") == page_base)
        if not same_page:
            return m.group(0)
        # MkDocs "material" emits "[Section titled “X”](#anchor)" next to every
        # heading — pure noise once the heading text is already there: drop it.
        if text.startswith("Section titled"):
            return ""
        if _slug(text) == frag:
            return text
        return m.group(0)

    md = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", md)
    md = re.sub(r"\[([^\]]+)\]\(([^)]*#[^)]*)\)", unwrap_anchor, md)
    md = re.sub(r"\[\s*\]\([^)]*\)", "", md)
    md = re.sub(r"\n{3,}", "\n\n", md)
    return md.strip()


def extract_text(html, raw, page_url=None, expected_chars=0):
    """HTML -> markdown for LLM consumption.

    Some pages defeat the converter outright: it returns a few hundred chars for
    a body with tens of thousands (huge inline <script>/JSON-LD, unusual markup),
    or nothing at all. Silently shipping that is how a fetch "succeeds" with no
    content — the classic blank-page bug. So the extraction is verified against
    the page's own rendered text length and retried with progressively more
    aggressive inputs until the text is actually there.

    `expected_chars` = rendered text length (0 when unknown, e.g. raw fetches).
    """
    if raw:
        return html or ""
    if not html:
        return ""

    def to_md(source):
        try:
            return clean_markdown(convert(source, CONVERT_OPTIONS).content or "", page_url)
        except Exception:
            return ""

    text = to_md(html)
    # Markdown is normally LONGER than rendered text (link syntax, headings); at
    # half of it something was dropped. Below MIN_PAGE_CHARS nothing usable came
    # back regardless.
    threshold = max(MIN_PAGE_CHARS, int(expected_chars * 0.5))
    if len(text) >= threshold:
        return text

    body = BODY_RE.search(html)
    for candidate in (SCRIPT_RE.sub(" ", html), body.group(1) if body else ""):
        if not candidate:
            continue
        alt = to_md(candidate)
        if len(alt) > len(text):
            text = alt
        if len(text) >= threshold:
            return text

    # Last resort: strip tags so the caller gets the words rather than a blank.
    # Script/style/noscript come out FIRST — their source text is not content and
    # would otherwise make an empty JS shell look like a page with text.
    plain_src = SCRIPT_RE.sub(" ", body.group(1) if body else html)
    plain = re.sub(r"\s+", " ", html_unescape(TAG_RE.sub(" ", plain_src))).strip()
    return plain if len(plain) > len(text) else text


async def scroll_full_page(page):
    """Scroll to the bottom so lazy-loaded content renders, then back to top."""
    try:
        await page.evaluate("""async () => {
            // Human-ish scroll: irregular wheel-sized steps, jittered cadence,
            // an occasional "reading" pause, then back to the top.
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            const el = document.scrollingElement || document.documentElement;
            let y = 0;
            while (y < el.scrollHeight) {
                y += 300 + Math.floor(Math.random() * 500);   // one wheel flick
                window.scrollTo(0, y);
                await sleep(80 + Math.random() * 180);
                if (Math.random() < 0.08) await sleep(250 + Math.random() * 500);
                if (y > 100000) break;
            }
            await sleep(80 + Math.random() * 160);
            window.scrollTo(0, 0);
        }""")
    except Exception:
        pass


async def simulate_user(page):
    """A couple of mouse moves to look human (light simulation)."""
    try:
        vp = page.viewport_size or {"width": 1366, "height": 768}
        for _ in range(random.randint(2, 4)):
            # steps>1 makes Playwright interpolate intermediate points — a
            # gliding cursor, not a teleport between two coordinates.
            await page.mouse.move(
                random.randint(30, vp["width"] - 30),
                random.randint(30, vp["height"] - 30),
                steps=random.randint(8, 20),
            )
            await page.wait_for_timeout(random.randint(60, 250))
    except Exception:
        pass


async def page_visible_text(page, limit=1500):
    """First `limit` chars of rendered text — used only to CLASSIFY a page
    (bot check vs genuinely empty), never as content."""
    try:
        return (await page.evaluate("(n) => (document.body && document.body.innerText || '').slice(0, n)", limit)) or ""
    except Exception:
        return ""


async def extract_serp(page):
    """Structured SERP records from the loaded page. Retries once for engines
    that hydrate results after first paint. Returns [] when the page holds no
    results (bot check, consent wall, or a genuinely empty result set)."""
    recs = []
    for attempt in (0, 1):
        try:
            recs = await page.evaluate(SERP_JS, {}) or []
        except Exception:
            recs = []
        if recs:
            return recs
        if attempt == 0:
            try:
                await page.wait_for_timeout(800)
            except Exception:
                pass
    return recs


async def fetch_page(page, url, timeout_ms, page_delay_s, scan_full, light, want_html=True):
    """Navigate one page and return (html, error, meta). Per-page failures are
    returned as errors, NOT raised — so one bad URL doesn't fail the whole
    batch. `meta` carries {status, title, blocked} so the caller can explain
    WHY a page produced nothing instead of reporting a silent blank.
    `want_html=False` skips DOM cleanup + serialization (SERP jobs read the
    live DOM instead, so shipping the HTML over the pipe would be pure waste)."""
    meta = {"status": None, "title": "", "blocked": False}
    try:
        # domcontentloaded: don't block on images/subresources — the networkidle
        # wait below covers JS-rendered content, and images are disabled anyway.
        resp = await page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
        if resp is not None:
            meta["status"] = resp.status
    except Exception as e:
        return None, "navigation failed: %s" % e, meta
    try:
        await page.wait_for_load_state("networkidle", timeout=5000 if light else min(timeout_ms, 10000))
    except Exception:
        pass  # networkidle timeout is not fatal
    try:
        await page.bring_to_front()  # headless tabs report unfocused otherwise
    except Exception:
        pass
    try:
        await page.evaluate(PREPARE_JS)
    except Exception:
        pass
    if light:
        # Cheap config: no scrolling / human-simulation, used for search pages.
        await page.wait_for_timeout(300)
    else:
        if scan_full:
            await scroll_full_page(page)
        # Human simulation and settle delay only when explicitly configured:
        # page_delay_s == 0 means "fast mode" — no mouse moves, no jitter wait.
        if page_delay_s > 0:
            await simulate_user(page)
            # Jitter the settle delay (±30%) so batches don't leave a metronome
            # timing signature.
            jitter = page_delay_s * (0.7 + 0.6 * random.random())
            await page.wait_for_timeout(int(jitter * 1000))
    try:
        meta["title"] = ((await page.title()) or "").strip()[:200]
    except Exception:
        pass
    if not want_html:
        return None, None, meta
    # Cleanup runs AFTER scrolling: lazy-loaded content appears during scroll,
    # so removing icons/data-URIs earlier would miss it. The evaluate returns the
    # rendered text length, used as the reference for extraction sanity checks.
    try:
        meta["text_len"] = int(await page.evaluate(FINISH_JS if not light else CLEANUP_JS) or 0)
    except Exception:
        meta["text_len"] = 0
    try:
        html = await page.content()
    except Exception as e:
        return None, "extract failed: %s" % e, meta
    return html, None, meta


def empty_reason(meta, text_len):
    """Human-readable cause for an unusable extraction (drives the caller's
    error message — never a bare 'unknown')."""
    status = meta.get("status")
    bits = "HTTP %s, title %r, %d chars extracted" % (status, meta.get("title") or "", text_len)
    if meta.get("blocked"):
        return "blocked by a bot check / captcha (%s)" % bits
    if status in (401, 402, 403):
        return "access denied by the site (%s)" % bits
    if status == 404:
        return "page not found (%s)" % bits
    if status and status >= 400:
        return "HTTP error from the site (%s)" % bits
    return "no readable text — JS-only shell, paywall, or empty page (%s)" % bits


async def run_group(context, jobs, concurrency, batch_id, timeout_ms, page_delay_s, scan_full):
    """Crawl a set of jobs concurrently (bounded by a semaphore). Returns False
    only if the BROWSER itself failed (so the caller exits and lets TS respawn a
    fresh one). Per-page failures are emitted as ok:false results, not exceptions."""
    if not jobs:
        return True
    sem = asyncio.Semaphore(concurrency)
    fatal = False

    async def one(job):
        nonlocal fatal
        async with sem:
            try:
                page = await context.new_page()
            except Exception as e:
                fatal = True
                emit({"batch": batch_id, "key": job["key"], "url": job["url"],
                      "ok": False, "text": "", "error": "browser error: %s" % e})
                return
            try:
                if job.get("extract") == "serp":
                    await one_serp(page, job)
                else:
                    await one_page(page, job)
            except Exception as e:
                emit({"batch": batch_id, "key": job["key"], "url": job["url"],
                      "ok": False, "text": "", "error": "crawl error: %s" % e})
            finally:
                try:
                    await page.close()
                except Exception:
                    pass

    async def one_serp(page, job):
        """Search-engine result page: return structured records, and say whether
        the engine BLOCKED us — the caller uses that to pick another engine."""
        _html, err, meta = await fetch_page(
            page, job["url"], timeout_ms, page_delay_s, scan_full, True, want_html=False)
        if err:
            emit({"batch": batch_id, "key": job["key"], "url": job["url"],
                  "ok": False, "text": "", "error": err, "status": meta["status"]})
            return
        results = await extract_serp(page)
        if not results:
            vis = await page_visible_text(page)
            meta["blocked"] = bool(BLOCK_RE.search(vis)) or meta["status"] in (403, 429)
        if results:
            # Ads are dropped here: they are never what the caller asked for.
            results = [r for r in results if not r.get("ad")]
        emit({
            "batch": batch_id, "key": job["key"], "url": job["url"],
            "ok": bool(results), "text": "", "results": results,
            "blocked": meta["blocked"], "status": meta["status"],
            "error": "" if results else ("bot check / captcha" if meta["blocked"] else "no results found"),
        })

    async def one_page(page, job):
        """Normal page fetch: markdown/HTML text plus an honest failure reason."""
        raw = bool(job.get("raw"))
        html, err, meta = await fetch_page(
            page, job["url"], timeout_ms, page_delay_s, scan_full, bool(job.get("light")))
        if err:
            emit({"batch": batch_id, "key": job["key"], "url": job["url"],
                  "ok": False, "text": "", "error": err, "status": meta["status"],
                  "title": meta["title"]})
            return
        expected = int(meta.get("text_len") or 0)
        text = extract_text(html, raw, job["url"], expected)
        # Truncate HERE, before the pipe: the TS side asked for a per-job cap,
        # so oversized pages never cross the process boundary (fewer bytes
        # serialized, parsed, and buffered).
        cap = int(job.get("max") or 0)
        if cap and len(text) > cap:
            text = text[:cap]
        if len(text) < MIN_PAGE_CHARS:
            # One recovery attempt: late-hydrating SPAs (and pages whose content
            # arrives after networkidle) fill in if given a moment.
            try:
                await page.wait_for_timeout(1500)
                expected = int(await page.evaluate(FINISH_JS if not job.get("light") else CLEANUP_JS) or 0) or expected
                retry = extract_text(await page.content(), raw, job["url"], expected)
                if len(retry) > len(text):
                    text = retry[:cap] if cap else retry
            except Exception:
                pass
        if len(text) < MIN_PAGE_CHARS:
            vis = await page_visible_text(page)
            meta["blocked"] = bool(BLOCK_RE.search(vis)) or meta["status"] in (403, 429)
            emit({"batch": batch_id, "key": job["key"], "url": job["url"],
                  "ok": False, "text": "", "error": empty_reason(meta, len(text)),
                  "blocked": meta["blocked"], "status": meta["status"], "title": meta["title"]})
            return
        emit({"batch": batch_id, "key": job["key"], "url": job["url"],
              "ok": True, "text": text, "error": "", "status": meta["status"], "title": meta["title"]})

    await asyncio.gather(*(one(j) for j in jobs))
    return not fatal


async def handle_batch(context, req):
    """Run one batch. Always emits the batch terminator. Returns False if the
    browser is unhealthy (so the process exits and TS respawns)."""
    jobs = req.get("jobs") or []
    batch_id = req.get("batch")
    concurrency = int(req.get("concurrency") or 4)
    timeout_ms = int(req.get("timeout_ms") or 60000)
    page_delay_s = float(req.get("page_delay_s") or 2.0)
    scan_full = bool(req.get("scan_full_page", True))
    healthy = await run_group(
        context, jobs, concurrency, batch_id, timeout_ms, page_delay_s, scan_full)
    emit({"batch": batch_id, "done": True})
    return healthy


# Persistent profile directory: cookies/logins/site state are written here
# and survive process restarts, so the "same browser session" is kept across
# tool calls. The TS runner passes WEB_FETCH_PROFILE_DIR; standalone fallback
# mirrors the TS default.
PROFILE_DIR = os.environ.get("WEB_FETCH_PROFILE_DIR") or os.path.join(
    os.path.expanduser("~"), ".pi", "web-fetch-profile")

# Launch args shared by both browser variants. Chromium stops exposing
# navigator.webdriver at the engine level with AutomationControlled disabled
# (stronger than any JS patch); images stay off — text extraction never needs
# them and they dominate bandwidth/CPU.
LAUNCH_ARGS = [
    "--disable-gpu",                      # no GPU compositing for text extraction
    "--disable-dev-shm-usage",            # avoid /dev/shm pressure
    "--disable-background-networking",    # no prefetch/metrics/updates
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    "--blink-settings=imagesEnabled=false",
    "--ozone-platform=x11",
]


async def launch_browser(p):
    """Launch headless Chromium on a PERSISTENT profile directory (see
    PROFILE_DIR), preferring the FULL browser build over Playwright's default
    stripped 'headless shell'. The shell's fingerprint is trivially detected by
    anti-bot edges — X/Twitter's Cloudflare 403s it before any JS stealth can
    matter — while the full build in new-headless mode (channel="chromium")
    renders real content. Fall back to the shell only when it isn't installed,
    so partial setups keep working.

    launch_persistent_context returns the single shared context directly: every
    page opened in it (context.new_page() per job) shares cookies/localStorage/
    site state, both across the jobs of one batch and across batches and even
    across process restarts (the profile persists on disk)."""
    opts = dict(
        headless=True,
        viewport=random.choice(VIEWPORTS),  # same size every session is a fingerprint
        user_agent=USER_AGENT,
        locale="en-US",
        ignore_https_errors=True,
        args=LAUNCH_ARGS,
    )
    try:
        return await p.chromium.launch_persistent_context(PROFILE_DIR, channel="chromium", **opts)
    except Exception:
        return await p.chromium.launch_persistent_context(PROFILE_DIR, **opts)


async def serve():
    async with async_playwright() as p:
        context = await launch_browser(p)
        await context.add_init_script(STEALTH_JS)

        # Fix client-hint / UA headers on document requests: headless Chromium
        # brands itself HeadlessChrome in sec-ch-ua regardless of the JS-level
        # UA override — the single most common block trigger.
        async def fix_headers(route):
            if route.request.resource_type in ("document", "iframe"):
                h = dict(route.request.headers)
                h["user-agent"] = USER_AGENT
                h["sec-ch-ua"] = CH_UA
                h["sec-ch-ua-mobile"] = "?0"
                h["sec-ch-ua-platform"] = '"Windows"'
                h["accept-language"] = "en-US,en;q=0.9"
                await route.continue_(headers=h)
            else:
                await route.continue_()

        await context.route("**/*", fix_headers)
        try:
            while True:
                # Blocking readline in a thread: stdin is only read between batches.
                line = await asyncio.to_thread(sys.stdin.readline)
                if not line:
                    return 0  # EOF — TS closed stdin (idle timeout / session end)
                line = line.strip()
                if not line:
                    continue
                try:
                    req = json.loads(line)
                except Exception as e:
                    sys.stderr.write("bad request line: %s\n" % e)
                    continue
                try:
                    healthy = await handle_batch(context, req)
                except Exception:
                    traceback.print_exc()
                    healthy = False
                    # Best-effort terminator so TS never waits for a lost batch.
                    try:
                        emit({"batch": req.get("batch"), "done": True})
                    except Exception:
                        pass
                if not healthy:
                    return 1  # let TS respawn a fresh browser on the next batch
        finally:
            # context.close() also closes the browser it owns; with a persistent
            # profile Chromium flushes cookies/state to disk here (and on SIGTERM).
            await context.close()


def main():
    try:
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass
        sys.exit(asyncio.run(serve()))
    except (KeyboardInterrupt, BrokenPipeError):
        pass  # consumer gone / interrupted; already handled in emit()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
    finally:
        try:
            sys.stdout.close()  # avoid "Exception ignored" at interpreter shutdown
        except Exception:
            pass


if __name__ == "__main__":
    main()
