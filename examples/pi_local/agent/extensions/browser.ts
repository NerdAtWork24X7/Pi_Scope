/**
 * Browser Automation Tool - Stealth Playwright browser control for subagents
 *
 * Cookies: if <agent dir>/cookie exists (JSON array/object or Netscape cookies.txt), they are loaded into the context on launch.
 * Uses playwright-extra + stealth plugin to evade bot detection.
 * Each subagent process gets its own browser instance (module-level singleton).
 * Tools: browser (actions: launch, goto, click, type,
 *        screenshot, eval, read, wait, newpage, close)
 */

import { Type } from "@mariozechner/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";
import { createRequire } from "module";
import { pathToFileURL } from "url";

// ── Browser singleton (per-process) ──────────────────────────────────

let browser: any = null;
let context: any = null;
let page: any = null;
const pages = new Map<string, any>();
let activePageId = "main";
let headlessFallback = false;
let playwrightExtra: any = null;

const SCREENSHOT_DIR = join(tmpdir(), "pi-browser-screenshots");
mkdirSync(SCREENSHOT_DIR, { recursive: true });
// The agent dir pi is actually running with: ~/.pi-scope/agent for Pi Scope's
// bundled agent (PI_CODING_AGENT_DIR, pinned by its shim) and ~/.pi/agent for a
// global install. Never a hardcoded ~/.pi — Pi Scope's cookie lives beside its
// own agent, and a global install resolves to the same place as before.
const COOKIE_FILE = join(getAgentDir(), "cookie");

// ── Stealth & anti-detection patches (injected before every page) ────

const STEALTH_INIT_SCRIPT = `
  // 1. navigator.webdriver → false
  Object.defineProperty(navigator, 'webdriver', { get: () => false });

  // 2. Chrome runtime (window.chrome)
  if (!window.chrome) {
    window.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) };
  }

  // 3. Fake plugins array (non-empty)
  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      const plugins = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
      ];
      plugins.length = 3;
      return plugins;
    },
  });

  // 4. MimeTypes
  Object.defineProperty(navigator, 'mimeTypes', {
    get: () => ({
      length: 2,
      0: { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
      1: { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' },
    }),
  });

  // 5. languages
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

  // 5b. hardwareConcurrency / deviceMemory (headless often reports low/odd values)
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

  // 6. permissions.query patch (notifications → prompt, not denied)
  const origQuery = window.Permissions?.prototype?.query;
  if (origQuery) {
    window.Permissions.prototype.query = function(params) {
      if (params.name === 'notifications') {
        return Promise.resolve({ state: Notification.permission || 'prompt' });
      }
      return origQuery.call(this, params);
    };
  }

  // 7. WebGL vendor/renderer spoofing (WebGL1 + WebGL2 — sites can use either context)
  const getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(param) {
    if (param === 37445) return 'Intel Inc.';
    if (param === 37446) return 'Intel Iris OpenGL Engine';
    return getParameter.call(this, param);
  };
  if (window.WebGL2RenderingContext) {
    const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return 'Intel Inc.';
      if (param === 37446) return 'Intel Iris OpenGL Engine';
      return getParameter2.call(this, param);
    };
  }

  // 8. Remove cdc_ attributes injected by chromedriver
  const origSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    if (typeof name === 'string' && name.startsWith('cdc_')) return this;
    return origSetAttribute.call(this, name, value);
  };

  // 9. Override connection.rtt (headless sets 0, real browsers don't)
  if (navigator.connection) {
    Object.defineProperty(navigator.connection, 'rtt', { get: () => 50 });
  }

  // 10. Fix iframe contentWindow.chrome
  try {
    const frame = document.createElement('iframe');
    frame.style.display = 'none';
    document.body.appendChild(frame);
    if (frame.contentWindow && !frame.contentWindow.chrome) {
      frame.contentWindow.chrome = window.chrome;
    }
    document.body.removeChild(frame);
  } catch {}
`;

// ── Realistic default context options ────────────────────────────────

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 1536, height: 864 },
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
];

function randomViewport() {
  return VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)];
}

// ── Chromium launch args for stealth ─────────────────────────────────

const STEALTH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--disable-infobars",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-component-extensions-with-background-pages",
  "--disable-default-apps",
  "--disable-dev-shm-usage",
  // NOTE: --disable-gpu removed — it forces SwiftShader software rendering,
  // which conflicts with the WebGL vendor/renderer spoof below (sites can
  // detect the mismatch between reported vendor and actual render behavior).
  // NOTE: --disable-features=IsolateOrigins,site-per-process removed — Site
  // Isolation is ON by default in real consumer Chrome, so disabling it makes
  // the fingerprint diverge from a stock install instead of blending in.
  // --no-sandbox / --disable-setuid-sandbox are only needed when running as
  // root (Docker/CI) — added conditionally below, not unconditionally.
  ...(process.env.CI || (typeof process.getuid === "function" && process.getuid() === 0)
    ? ["--no-sandbox", "--disable-setuid-sandbox"]
    : []),
];

// ── Helpers ──────────────────────────────────────────────────────────

export type BrowserCookie = {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
};

function parseNetscapeCookies(text: string): BrowserCookie[] {
  const out: BrowserCookie[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split("\t");
    if (parts.length < 7) continue;
    const [domain, , path, secureFlag, expiresStr, name, value] = parts;
    const expires = Number(expiresStr);
    if (expires > 0 && expires <= Math.floor(Date.now() / 1000)) continue; // skip expired
    out.push({
      name,
      value,
      domain: domain.replace(/^\./, ""), // strip leading dot, Playwright covers subdomains
      path,
      secure: secureFlag === "TRUE",
      ...(expires > 0 ? { expires } : {}),
    });
  }
  return out;
}

function normalizeJsonCookies(list: unknown[]): BrowserCookie[] {
  const out: BrowserCookie[] = [];
  for (const raw of list) {
    const c = raw as Record<string, unknown>;
    if (!c || typeof c !== "object") continue;
    if (!c.name || !c.value || !c.domain) continue; // Playwright throws without these
    const expires = (c.expires ?? c.expirationDate) as number | undefined;
    if (typeof expires === "number" && expires > 0 && expires <= Math.floor(Date.now() / 1000)) continue; // skip expired
    const outCookie: BrowserCookie = {
      name: String(c.name),
      value: String(c.value),
      domain: String(c.domain).replace(/^\./, ""),
      ...(c.path ? { path: String(c.path) } : {}),
      ...(typeof expires === "number" && expires > 0 ? { expires } : {}),
      ...(typeof c.httpOnly === "boolean" ? { httpOnly: c.httpOnly } : {}),
      ...(typeof c.secure === "boolean" ? { secure: c.secure } : {}),
    };
    const ss = String(c.sameSite ?? "").toLowerCase();
    if (ss === "strict" || ss === "lax" || ss === "none" || ss === "no_restriction") {
      outCookie.sameSite = ss === "strict" ? "Strict" : ss === "lax" ? "Lax" : "None";
    }
    out.push(outCookie);
  }
  return out;
}

/** Parse cookie file content. Auto-detect: JSON (array or single object, Playwright/devtools style) or Netscape cookies.txt (tab-separated). Throws on malformed JSON. */
export function parseCookieFile(text: string): BrowserCookie[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error("cookie file JSON must be an array of cookie objects");
    return normalizeJsonCookies(parsed);
  }
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("cookie file JSON must be a cookie object or array");
    return normalizeJsonCookies([parsed]);
  }
  return parseNetscapeCookies(text);
}

/** Read the agent dir's cookie file; returns [] if missing. Throws on unparseable content. */
function readCookieFile(): BrowserCookie[] {
  let raw: string;
  try {
    raw = readFileSync(COOKIE_FILE, "utf8");
  } catch {
    return []; // no cookie file present — not an error
  }
  return parseCookieFile(raw);
}

/**
 * Resolve a bare specifier against a filesystem root (walks up node_modules).
 * pi loads this file from <agent dir>/extensions/browser.ts, which has no
 * node_modules of its own, so Node's ESM resolver (relative to the *importing
 * file*) fails even though the packages are installed in the project. Retrying
 * from process.cwd() bridges that gap.
 */
function resolveDepFrom(spec: string, root: string): string | null {
  try {
    return createRequire(join(root, "__resolve_dep__.js")).resolve(spec);
  } catch {
    return null;
  }
}

/** Roots to try, in order: explicit override, cwd, home. */
function depRoots(): string[] {
  return [process.env.PI_BROWSER_MODULE_ROOT, process.cwd(), homedir()].filter(
    (r): r is string => !!r
  );
}

/** Import a dependency, falling back to on-disk resolution from other roots. */
async function importDep(spec: string): Promise<any> {
  try {
    return await import(spec);
  } catch (primary: unknown) {
    for (const root of depRoots()) {
      const abs = resolveDepFrom(spec, root);
      if (!abs) continue;
      const mod = await import(pathToFileURL(abs).href);
      return mod;
    }
    const code = (primary as NodeJS.ErrnoException)?.code ?? String(primary);
    throw new Error(
      `${spec} could not be loaded (${code}). Searched node_modules upward from: ` +
      `${depRoots().join(", ")}. Install it with: npm i playwright playwright-extra ` +
      `puppeteer-extra-plugin-stealth (or set PI_BROWSER_MODULE_ROOT to the folder ` +
      `containing its node_modules).`
    );
  }
}

/** CJS/ESM interop: prefer the named export when asked for, else default. */
function interop(mod: any, namedExport?: string): any {
  return namedExport && mod?.[namedExport] ? mod : mod?.default ?? mod;
}

/**
 * User-global directories a Playwright browser install may live in, in
 * preference order: the configured PLAYWRIGHT_BROWSERS_PATH (the shared global
 * install, e.g. $HOME/playwright-browsers), Playwright's per-user default
 * cache, then the conventional $HOME/playwright-browsers. Agent-local
 * directories are deliberately never consulted — the browser tool always uses
 * the globally installed Chromium.
 */
function globalBrowsersRoots(): string[] {
  const defaultCache =
    process.platform === "win32"
      ? join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "ms-playwright")
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Caches", "ms-playwright")
        : join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "ms-playwright");
  return [
    ...new Set(
      [process.env.PLAYWRIGHT_BROWSERS_PATH, defaultCache, join(homedir(), "playwright-browsers")].filter(
        (r): r is string => !!r
      )
    ),
  ];
}

/**
 * Locate the globally installed Chromium binary (see globalBrowsersRoots).
 * Prefers the revision this playwright build wants (read from its own
 * browsers.json), else the newest installed one. Returns null when nothing is
 * installed, so the caller can fall back to playwright's own registry lookup.
 *
 * The relative layout differs per platform (linux64 / linux / mac .app / win
 * .exe), so all of them are probed. A missing layout would return null and
 * silently fall back to the registry lookup instead of pinning the revision.
 */
export function resolveChromiumExecutable(): string | null {
  const roots = globalBrowsersRoots();

  const exeOf = (root: string, dir: string) => {
    for (const rel of [
      "chrome-linux64/chrome",
      "chrome-linux/chrome",
      "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
      "chrome-win/chrome.exe",
      "chrome-win64/chrome.exe",
    ]) {
      const p = join(root, dir, rel);
      if (existsSync(p)) return p;
    }
    return null;
  };

  // 1. exact revision this playwright-core expects. Search the same roots the
  //    modules are loaded from (PI_BROWSER_MODULE_ROOT, cwd, home) — the file
  //    is not necessarily resolvable from process.cwd().
  let browsersJson: string | null = null;
  for (const root of depRoots()) {
    browsersJson = resolveDepFrom("playwright-core/browsers.json", root);
    if (browsersJson) break;
  }
  if (browsersJson) {
    try {
      const spec = JSON.parse(readFileSync(browsersJson, "utf8"));
      const rev = spec.browsers?.find((b: any) => b.name === "chromium")?.revision;
      if (rev) {
        for (const root of roots) {
          const exact = exeOf(root, `chromium-${rev}`);
          if (exact) return exact;
        }
      }
    } catch {
      // browsers.json unreadable — fall through to newest-revision scan
    }
  }

  // 2. newest chromium-<rev> present across every global browser root
  const revs = [
    ...new Set(
      roots.flatMap((root) =>
        existsSync(root)
          ? readdirSync(root)
              .map((d) => /^chromium-(\d+)$/.exec(d))
              .filter((m): m is RegExpExecArray => !!m)
              .map((m) => Number(m[1]))
          : []
      )
    ),
  ].sort((a, b) => b - a);
  for (const rev of revs) {
    for (const root of roots) {
      const exe = exeOf(root, `chromium-${rev}`);
      if (exe) return exe;
    }
  }
  return null;
}

async function getPw() {
  if (!playwrightExtra) {
    const pwExtra = interop(await importDep("playwright-extra"), "chromium");
    const stealthMod = interop(await importDep("puppeteer-extra-plugin-stealth"));
    const stealth = (stealthMod as any)();
    pwExtra.chromium.use(stealth);
    playwrightExtra = pwExtra;
  }
  return playwrightExtra;
}

function getActivePage(): any {
  if (!page) throw new Error("No browser page open. Call browser with action: launch first.");
  return page;
}

function ok(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

function err(msg: string) {
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], details: { error: msg } };
}

/** Add human-like jitter to a value (±5-15%) */
function jitter(value: number, pct = 0.1): number {
  return value + value * (Math.random() * pct * 2 - pct);
}

const TEARDOWN_NOISE = /target (page, context or browser|page|closed)|browser has been closed|protocol error|session closed/i;

/**
 * Close the browser and reset state.
 *
 * playwright-extra runs each stealth evasion's page.addInitScript as a
 * fire-and-forget promise. Closing right after launch (or on SIGTERM while a
 * subagent is still setting up pages) rejects those promises *after* the
 * browser is gone, and an unhandled rejection kills the whole pi subagent
 * process — the tool call itself was fine. So a narrow guard is installed for
 * the duration of teardown only: teardown-shaped rejections are swallowed,
 * anything else is logged and left to crash as it would have anyway.
 */
async function shutdownBrowser(): Promise<void> {
  const b = browser;
  // Reset state first so a concurrent/early exit hook sees a clean slate.
  browser = null;
  context = null;
  page = null;
  pages.clear();
  headlessFallback = false;

  const guard = (reason: unknown) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    if (!TEARDOWN_NOISE.test(msg)) {
      console.error("[browser] unhandled rejection during teardown:", reason);
    }
  };
  process.on("unhandledRejection", guard);
  try {
    if (b) await b.close();
  } catch {
    // close error ignored, state already reset
  } finally {
    // Give the late rejections a tick to surface while the guard is attached.
    await new Promise((r) => setTimeout(r, 150));
    process.off("unhandledRejection", guard);
  }
}

// ── Extension entry ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

  pi.registerTool({
    name: "browser",
    label: "Browser",
    description: "Automate browser actions: launch, goto, click, type, screenshot, eval, read, wait, newpage, close.",
    parameters: Type.Object({
      action: Type.String({ description: "Action: launch, goto, click, type, screenshot, eval, read, wait, newpage, close" }),
      browserType: Type.Optional(Type.String({ description: "Browser engine: chromium, firefox, webkit (default chromium)", default: "chromium" })),
      viewport: Type.Optional(Type.Object({
        width: Type.Number({ description: "Viewport width in px" }),
        height: Type.Number({ description: "Viewport height in px" }),
      })),
      url: Type.Optional(Type.String({ description: "URL to navigate to" })),
      waitUntil: Type.Optional(Type.String({ description: "Wait condition: load, domcontentloaded, networkidle, commit (default domcontentloaded)", default: "domcontentloaded" })),
      selector: Type.Optional(Type.String({ description: "CSS selector (use >> for text match, e.g. text=Sign In)" })),
      button: Type.Optional(Type.String({ description: "Mouse button: left, right, middle (default left)", default: "left" })),
      text: Type.Optional(Type.String({ description: "Text to type" })),
      clear: Type.Optional(Type.Boolean({ description: "Clear field before typing (default true)", default: true })),
      fullPage: Type.Optional(Type.Boolean({ description: "Capture full scrollable page (default false)", default: false })),
      expression: Type.Optional(Type.String({ description: "JavaScript expression to evaluate" })),
      timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default 10000)", default: 10_000 })),
      id: Type.Optional(Type.String({ description: "Page identifier (default auto-generated)", default: "" })),
    }),

    async execute(_id, params) {
      try {
        const p = params as any;
        switch (p.action) {
          case "launch": {
            let cookies: BrowserCookie[] = [];
            try {
              cookies = readCookieFile();
            } catch (e: unknown) {
              return err(`Failed to parse cookie file ${COOKIE_FILE}: ${e instanceof Error ? e.message : String(e)}. Fix or remove the file, then relaunch.`);
            }
            const browserType = p.browserType ?? "chromium";
            // Validate before the already-running short-circuit, otherwise a typo
            // silently reports "Browser already running." forever.
            const pw = await getPw();
            const launcher = (pw as any)[browserType];
            if (!launcher) return err(`Unknown browser: ${browserType}. Use chromium, firefox, or webkit.`);
            if (browser) return ok(`Browser already running (${browserType}).`);

            const vp = p.viewport || randomViewport();

            // Launch with stealth args. The binary comes from the user's global
            // Playwright install (see resolveChromiumExecutable).
            // headless:false is tried first so
            // window.chrome, plugins and WebGL behave like a real desktop
            // Chrome; it silently degrades to headless when no DISPLAY exists.
            const launchOpts: any = {
              headless: false,
              args: browserType === "chromium" ? STEALTH_ARGS : undefined,
            };
            if (browserType === "chromium") {
              // Pin the binary explicitly to the user's global Playwright
              // install (see resolveChromiumExecutable) instead of asking
              // playwright to look up its registry: the env var may not reach a
              // spawned subagent, and the newest revision there (e.g.
              // chromium-1243) differs from the one this playwright build
              // expects (1234) — asking for a missing revision fails with an
              // opaque "Executable doesn't exist".
              const exe = resolveChromiumExecutable();
              if (exe) launchOpts.executablePath = exe;
            }
            try {
              browser = await launcher.launch(launchOpts);
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              // Retry headless: a subagent may run without DISPLAY (no X/Wayland),
              // which makes headless:false fail even though the binary is fine.
              // DISPLAY is an X11 concept: on Windows and macOS it is always
              // unset, so only treat its absence as "no display" on Linux —
              // elsewhere fall straight through to the error so a real launch
              // failure is not masked by a doomed headless retry.
              const noDisplay = process.platform !== "linux" || !process.env.DISPLAY;
              if (/display|X server|missing X|Headless/i.test(msg) || noDisplay) {
                try {
                  browser = await launcher.launch({ ...launchOpts, headless: true });
                  headlessFallback = true;
                } catch {
                  throw new Error(`Chromium launch failed: ${msg}`);
                }
              } else {
                throw new Error(`Chromium launch failed: ${msg}`);
              }
            }

            // Derive UA / Client-Hints from the *actual* launched browser version
            // instead of hardcoding — a mismatch between navigator.userAgent,
            // navigator.userAgentData, and the sec-ch-ua headers is one of the
            // highest-signal bot tells for detectors like FingerprintJS/Cloudflare.
            const fullVersion: string = browser.version?.() ?? "124.0.6367.60";
            const majorVersion = fullVersion.split(".")[0];

            // Platform must match the persona the stealth plugin advertises in JS
            // (user-agent-override masks the Linux host as Windows), otherwise
            // navigator.userAgent and the HTTP headers disagree — a split far
            // more detectable than either value alone.
            const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${fullVersion} Safari/537.36`;
            // Client-Hints brands must match the binary: the pinned globally
            // installed build is Chromium, which never sends a
            // "Google Chrome" brand — only the real chrome channel does.
            const brands = launchOpts.executablePath
              ? `"Chromium";v="${majorVersion}", "Not-A.Brand";v="99"`
              : `"Chromium";v="${majorVersion}", "Google Chrome";v="${majorVersion}", "Not-A.Brand";v="99"`;

            // Create context with realistic fingerprint
            context = await browser.newContext({
              viewport: vp,
              // screen should be >= viewport; a viewport that exactly equals
              // screen with no chrome/taskbar allowance is itself a signal
              screen: { width: vp.width, height: vp.height + 40 },
              userAgent,
              locale: "en-US",
              timezoneId: "America/New_York",
              geolocation: { latitude: 40.7128, longitude: -74.006 },
              permissions: ["geolocation"],
              colorScheme: "light",
              deviceScaleFactor: 1,
              hasTouch: false,
              javaScriptEnabled: true,
              ignoreHTTPSErrors: true,
              extraHTTPHeaders: {
                "Accept-Language": "en-US,en;q=0.9",
                "Accept-Encoding": "gzip, deflate, br",
                "sec-ch-ua": brands,
                "sec-ch-ua-mobile": "?0",
                "sec-ch-ua-platform": '"Windows"',
              },
            });

            // Inject stealth scripts before every page/frame
            await context.addInitScript(STEALTH_INIT_SCRIPT);

            if (cookies.length > 0) {
              await context.addCookies(cookies);
            }

            page = await context.newPage();
            pages.set("main", page);
            activePageId = "main";

            return ok(
              `Stealth browser launched (${browserType}, headless=${headlessFallback}, viewport=${vp.width}x${vp.height}).` +
              (launchOpts.executablePath ? ` Binary: ${launchOpts.executablePath}.` : "") +
              (cookies.length > 0 ? ` Loaded ${cookies.length} cookies from ${COOKIE_FILE}.` : "")
            );
          }
          case "goto": {
            if (!p.url) return err("url is required for goto action");
            const waitUntil = p.waitUntil ?? "domcontentloaded";
            const pg = getActivePage();
            await pg.goto(p.url, { waitUntil: waitUntil as any, timeout: 30_000 });
            const title = await pg.title();
            return ok(`Navigated to ${p.url}\nTitle: ${title}`);
          }
          case "click": {
            if (!p.selector) return err("selector is required for click action");
            const button = p.button ?? "left";
            const pg = getActivePage();

            // Human-like: move to element area first, then click
            const el = await pg.$(p.selector);
            if (!el) return err(`Element not found: ${p.selector}`);
            const box = await el.boundingBox();
            if (box) {
              const x = jitter(box.x + box.width / 2);
              const y = jitter(box.y + box.height / 2);
              await pg.mouse.move(x, y, { steps: Math.floor(jitter(5, 0.5)) });
              await new Promise(r => setTimeout(r, jitter(80, 0.3)));
            }
            await el.click({ button: button as any, timeout: 10_000 });
            return ok(`Clicked: ${p.selector}`);
          }
          case "type": {
            if (!p.selector || p.text === undefined) return err("selector and text are required for type action");
            const clear = p.clear ?? true;
            const pg = getActivePage();
            if (clear) {
              await pg.fill(p.selector, "");
              // Type with human-like delay (40-90ms per char)
              await pg.type(p.selector, p.text, { delay: jitter(60, 0.4) });
            } else {
              await pg.type(p.selector, p.text, { delay: jitter(60, 0.4) });
            }
            return ok(`Typed into ${p.selector}`);
          }
          case "screenshot": {
            const fullPage = p.fullPage ?? false;
            const pg = getActivePage();
            const ts = Date.now();
            const filePath = join(SCREENSHOT_DIR, `screenshot-${ts}.png`);
            await pg.screenshot({ path: filePath, fullPage });
            return ok(`Screenshot saved: ${filePath}`);
          }
          case "eval": {
            if (!p.expression) return err("expression is required for eval action");
            const pg = getActivePage();
            const result = await pg.evaluate(p.expression);
            const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
            return ok(text);
          }
          case "read": {
            const selector = p.selector ?? "body";
            const pg = getActivePage();
            const text = await pg.innerText(selector);
            const trimmed = text.length > 16_000 ? text.slice(0, 16_000) + "\n... [truncated]" : text;
            return ok(trimmed);
          }
          case "wait": {
            const selector = p.selector ?? "";
            const timeout = p.timeout ?? 10_000;
            const pg = getActivePage();
            if (selector) {
              await pg.waitForSelector(selector, { timeout });
              return ok(`Element appeared: ${selector}`);
            }
            await pg.waitForLoadState("domcontentloaded", { timeout });
            return ok("Page loaded (domcontentloaded).");
          }
          case "newpage": {
            if (!context) return err("No browser context. Call browser with action: launch first.");
            const newPage = await context.newPage();
            const pageId = (p.id || "") || `page-${pages.size}`;
            pages.set(pageId, newPage);
            page = newPage;
            activePageId = pageId;
            return ok(`New page opened: ${pageId}`);
          }
          case "close": {
            await shutdownBrowser();
            return ok("Browser closed.");
          }
          default:
            return err(`Unknown action: ${p.action}. Use: launch, goto, click, type, screenshot, eval, read, wait, newpage, close`);
        }
      } catch (e: unknown) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });

  // ── Cleanup on process exit ─────────────────────────────────────

  process.on("exit", () => {
    if (browser) browser.close().catch(() => { });
  });
  process.on("SIGTERM", async () => {
    await shutdownBrowser();
    process.exit(0);
  });
}
