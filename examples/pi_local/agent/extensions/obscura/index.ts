/**
 * Web Fetch Tool — headless page fetch via Obscura (Rust browser engine)
 *
 * Uses the Obscura CLI (`obscura fetch`) for fast, lightweight headless browsing.
 * Obscura is a Rust-based headless browser that runs JavaScript via V8, with
 * instant startup (~85ms) and low memory (~30MB vs 200MB+ for Chrome).
 *
 * PLATFORM: the bundled binary (and the only published release asset) is a
 * Linux x86_64 ELF. On macOS/Windows this extension therefore registers no
 * tool and stays inert — the Playwright-backed `web_fetch` extension covers
 * fetching there. Point OBSCURA_BIN at a native build to force-enable it.
 *
 * The obscura binary is bundled alongside this script. If missing,
 * install from the Obscura releases page:
 *   curl -LO https://github.com/h4ckf0r0day/obscura/releases/latest/download/obscura-x86_64-linux-stealth.tar.gz
 *   tar xzf obscura-x86_64-linux-stealth.tar.gz
 *
 * Results are served from a two-layer cache:
 *   1. in-memory LRU  — repeat fetches in this process skip disk entirely
 *   2. on-disk cache  — shared across processes, atomic writes (temp+rename)
 *
 * ENV:
 *   OBSCURA_BIN               — path to obscura binary (default bundled)
 *   WEB_FETCH_CACHE_DIR       — disk cache directory (default <cwd>/.pi/web-fetch-cache)
 *   WEB_FETCH_CACHE_TTL_MS    — cache TTL in ms (default 1 hour)
 *   WEB_FETCH_FETCH_TIMEOUT_MS — per-fetch timeout in ms (default 30s)
 *   WEB_FETCH_MAX_CHARS       — per-page text cap (default 4000)
 *   WEB_FETCH_STEALTH         — stealth mode: consistent Windows-Chrome TLS/HTTP
 *                               fingerprint + tracker blocking (default on; set 0/off to disable)
 *   WEB_FETCH_PROXY           — default proxy URL (e.g. http://user:pass@host:port or socks5://host:port)
 */

import { createHash } from "crypto";
import { execFile } from "child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { getAgentDir, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";

// ── Extension directory (for bundled binary) ──────────────────────────────

const EXTENSION_DIR: string = (() => {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return __dirname;
  }
})();

// ── Config ──────────────────────────────────────────────────────────────────

const OBSCURA_BIN: string = (() => {
  const env = process.env.OBSCURA_BIN;
  if (env && existsSync(env)) return env;
  const bundled = join(EXTENSION_DIR, "obscura");
  if (existsSync(bundled)) return bundled;
  // Beside pi's data root, like the provider model cache: ~/.pi-scope for Pi
  // Scope's own agent, ~/.pi for a global install.
  const def = join(dirname(getAgentDir()), "obscura", "obscura");
  if (existsSync(def)) return def;
  // last resort — hope it's on PATH
  return "obscura";
})();

const CACHE_DIR = process.env.WEB_FETCH_CACHE_DIR
  ? resolve(process.env.WEB_FETCH_CACHE_DIR)
  : join(process.cwd(), ".pi", "web-fetch-cache"); // project-local

function envMs(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return !/^(0|false|no|off)$/i.test(v.trim());
}

const CACHE_TTL_MS = envMs("WEB_FETCH_CACHE_TTL_MS", 3_600_000);   // 1 hour
const FETCH_TIMEOUT_MS = envMs("WEB_FETCH_FETCH_TIMEOUT_MS", 30_000); // 30s
const MAX_RESULT_CHARS = envMs("WEB_FETCH_MAX_CHARS", 4000);       // per-page cap
const STEALTH_DEFAULT = envBool("WEB_FETCH_STEALTH", true);        // stealth on by default
const PROXY_DEFAULT = (process.env.WEB_FETCH_PROXY ?? "").trim();  // default proxy ("" = direct)
const MAX_CACHE_ENTRIES = 2000;
const MEM_CACHE_MAX = 100;
const MEM_CACHE_MAX_ENTRY = 512 * 1024; // big raw HTML stays disk-only

// ── Cookie helpers ──────────────────────────────────────────────────────────

const AGENT_COOKIE_FILE = join(getAgentDir(), "cookie");

/** Load the agent dir's cookie (JSON array of Playwright-style cookies) and
 *  convert to Obscura cookies.json format. Returns null if file missing/empty. */
function loadAgentCookies(): string | null {
  let raw: string;
  try {
    raw = readFileSync(AGENT_COOKIE_FILE, "utf8");
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let parsed: unknown[];
  try {
    const v = JSON.parse(trimmed);
    if (Array.isArray(v)) parsed = v;
    else if (v && typeof v === "object") parsed = [v];
    else throw new Error();
  } catch {
    return null; // unparseable — ignore, file might be in Netscape format
  }

  const out: unknown[] = [];
  for (const c of parsed) {
    const obj = c as Record<string, unknown>;
    if (!obj || typeof obj !== "object") continue;
    const name = String(obj.name ?? "");
    const value = String(obj.value ?? "");
    const domain = String(obj.domain ?? "").replace(/^\./, "");
    if (!name || !value || !domain) continue;
    const expires = obj.expires as number | undefined;
    out.push({
      name,
      value,
      domain,
      path: obj.path ?? "/",
      secure: obj.secure === true,
      http_only: obj.httpOnly === true,
      host_only: false,
      same_site: normalizeObscuraSameSite(obj.sameSite),
      ...(typeof expires === "number" && expires > 0 ? { expires } : {}),
    });
  }
  return out.length > 0 ? JSON.stringify(out) : null;
}

/** Normalize Playwright sameSite values to Obscura snake-case expected values. */
function normalizeObscuraSameSite(ss: unknown): string {
  if (typeof ss !== "string") return "Lax";
  switch (ss.toLowerCase()) {
    case "strict": return "Strict";
    case "none": return "None";
    default: return "Lax";
  }
}

/** Build a deterministic hash for cache-key derivation. */
function cookieHash(cookiesJson: string): string {
  return createHash("sha256").update(cookiesJson).digest("hex").slice(0, 12);
}

/** Create a temp storage dir and write cookies.json, return the dir path. */
function setupCookieStorageDir(cookiesJson: string): string {
  const dir = join(CACHE_DIR, `cookies-${cookieHash(cookiesJson)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cookies.json"), cookiesJson);
  return dir;
}

// ── Cache (sync for simplicity; async would need persistent child process) ──

const CACHE_NAMESPACE = "obscura";
const memCache = new Map<string, { t: number; text: string }>();

function cacheKey(url: string, dump: string, cookieHash?: string, stealth?: boolean, proxyHash?: string): string {
  let key = `${CACHE_NAMESPACE}:${url}:${dump}:${stealth ? "s1" : "s0"}`;
  if (cookieHash) key += `:c${cookieHash}`;
  if (proxyHash) key += `:p${proxyHash}`;
  return key;
}

function cachePath(key: string): string {
  return join(CACHE_DIR, `${createHash("sha256").update(key).digest("hex")}.json`);
}

function memSet(key: string, text: string): void {
  if (text.length > MEM_CACHE_MAX_ENTRY) return;
  if (memCache.size >= MEM_CACHE_MAX) {
    const oldest = memCache.keys().next().value;
    if (oldest !== undefined) memCache.delete(oldest);
  }
  memCache.set(key, { t: Date.now(), text });
}

function getCache(key: string): string | null {
  const m = memCache.get(key);
  if (m) {
    if (Date.now() - m.t <= CACHE_TTL_MS) return m.text;
    memCache.delete(key);
    return null;
  }
  const p = cachePath(key);
  if (!existsSync(p)) return null;
  try {
    if (Date.now() - statSync(p).mtimeMs > CACHE_TTL_MS) {
      try { unlinkSync(p); } catch { /* best-effort */ }
      return null;
    }
    const text: unknown = JSON.parse(readFileSync(p, "utf-8"));
    if (typeof text !== "string") return null;
    memSet(key, text);
    return text;
  } catch {
    return null;
  }
}

function setCache(key: string, text: string): void {
  memSet(key, text);
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const p = cachePath(key);
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(text));
    try { renameSync(tmp, p); } catch {
      // Windows cannot rename over an existing file
      try { unlinkSync(p); } catch { /* ignore */ }
      try { renameSync(tmp, p); } catch { /* best-effort */ }
    }
  } catch { /* cache failure must not break the fetch */ }
}

// Prune oldest 10% of cache entries when count exceeds max.
let lastPrune = 0;
function maybePrune(force = false): void {
  const now = Date.now();
  if (!force && now - lastPrune < 300_000) return; // throttle to 5 min
  lastPrune = now;
  try {
    const files = readdirSync(CACHE_DIR).filter((f) => f.endsWith(".json"));
    if (files.length <= MAX_CACHE_ENTRIES) return;
    const withMtime = files
      .map((name) => {
        try { return { name, mtime: statSync(join(CACHE_DIR, name)).mtimeMs }; } catch { return null; }
      })
      .filter((x): x is { name: string; mtime: number } => x !== null);
    withMtime.sort((a, b) => a.mtime - b.mtime);
    const removeCount = Math.ceil(files.length * 0.1);
    for (let i = 0; i < removeCount; i++) {
      try { unlinkSync(join(CACHE_DIR, withMtime[i].name)); } catch { /* best-effort */ }
    }
  } catch { /* best-effort */ }
}

// ── Obscura fetch wrapper ──────────────────────────────────────────────────

interface FetchOptions {
  storageDir?: string;
  stealth?: boolean;
  proxy?: string;
}

function obscuraFetch(url: string, dump: string, opts: FetchOptions = {}): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const args = ["fetch", url, "--dump", dump, "--quiet"];
    if (opts.stealth) args.push("--stealth");
    if (opts.proxy) args.push("--proxy", opts.proxy);
    if (opts.storageDir) args.push("--storage-dir", opts.storageDir);
    const child = execFile(
      OBSCURA_BIN,
      args,
      {
        timeout: FETCH_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || "").trim();
          const message = detail ? `obscura: ${detail}` : `obscura exited: ${err.message}`;
          rejectPromise(new Error(message));
          return;
        }
        resolvePromise(stdout);
      },
    );
    if (child.stdout) {
      child.stdout.on("error", () => { /* ignore pipe errors */ });
    }
    if (child.stderr) {
      child.stderr.on("error", () => { /* ignore pipe errors */ });
    }
  });
}

// Cache the fetch-dump pair. Accepts cookie context for key isolation and storage;
// stealth/proxy shape both the request identity and the cache key.
async function fetchWithCache(
  url: string,
  dump: string,
  cookieHashVal?: string,
  storageDir?: string,
  stealth?: boolean,
  proxy?: string,
): Promise<string> {
  const proxyHashVal = proxy ? cookieHash(proxy) : undefined;
  const key = cacheKey(url, dump, cookieHashVal, stealth, proxyHashVal);
  const cached = getCache(key);
  if (cached !== null) return cached;

  const text = await obscuraFetch(url, dump, { storageDir, stealth, proxy });
  setCache(key, text);
  // Background prune — fire and forget
  setImmediate(() => maybePrune());
  return text;
}

// ── DuckDuckGo search helpers ──────────────────────────────────────────────

const DDG_SKIP_DOMAINS = ["duckduckgo.com", "duck.co", "help.duckduckgo.com", "spreadprivacy.com"];

/** Extract real result URLs from DuckDuckGo HTML search results. */
function extractUrlsFromDDGHTML(html: string, limit: number): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  // Match <a class="result__a" href="...">  — DDG's result link pattern
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    let href = m[1];
    try {
      const u = new URL(href, "https://duckduckgo.com");
      // DDG redirect URLs look like: /l/?uddg=REAL_URL&...
      const uddg = u.searchParams.get("uddg");
      if (uddg) href = decodeURIComponent(uddg.replace(/\+/g, " "));
      const final = new URL(href);
      const host = final.hostname.toLowerCase();
      if (DDG_SKIP_DOMAINS.some((d) => host === d || host.endsWith("." + d))) continue;
      if (seen.has(final.href)) continue;
      seen.add(final.href);
      urls.push(final.href);
      if (urls.length >= limit) return urls;
    } catch { /* skip malformed */ }
  }
  return urls;
}

// ── Result helpers ─────────────────────────────────────────────────────────

function errRes(text: string) {
  return { content: [{ type: "text" as const, text }], details: { error: text } };
}

export default function (pi: ExtensionAPI) {
  // The bundled obscura/obscura-worker are Linux x86_64 ELF binaries, so on
  // macOS/Windows there is nothing runnable to exec and this extension stays
  // inert (see the header). An explicit OBSCURA_BIN is honoured anyway, so a
  // native build can still be wired up on those platforms.
  if (process.platform !== "linux" && !process.env.OBSCURA_BIN) return;

  // Prune stale entries once at load time.
  setImmediate(() => maybePrune(true));

  pi.registerTool({
    name: "web-fetch",
    label: "Web Fetch",
    description: "Fetch web pages as Markdown/HTML via headless browser, or search DuckDuckGo via 'query'. Supports JS, anti-bot stealth, and proxy.",
    parameters: Type.Object({
      url: Type.Optional(
        Type.String({ description: "URL to fetch (omit if using query)", default: "" }),
      ),
      raw: Type.Optional(
        Type.Boolean({ description: "Return raw HTML instead of markdown (default false)", default: false }),
      ),
      query: Type.Optional(
        Type.String({
          description: "Search query to find and fetch top DuckDuckGo results",
          default: "",
        }),
      ),
      maxResults: Type.Optional(
        Type.Number({
          description: "Max search results to fetch (1–5, default 5)",
          default: 5,
        }),
      ),
      stealth: Type.Optional(
        Type.Boolean({
          description: "Bypass bot detection with TLS fingerprinting (default true)",
          default: true,
        }),
      ),
      proxy: Type.Optional(
        Type.String({
          description: "Optional proxy URL (http/socks5)",
          default: "",
        }),
      ),
    }),

    async execute(
      _toolCallId: unknown,
      params: { url?: string; raw?: boolean; query?: string; maxResults?: number; stealth?: boolean; proxy?: string },
    ) {
      const raw = params.raw ?? false;
      const query = params.query?.trim() ?? "";
      const url = params.url?.trim() ?? "";
      if (!query && !url) {
        return errRes("Error: provide either 'url' or 'query' parameter.");
      }

      // ── Stealth & proxy resolution (param overrides env default) ──
      const stealth = params.stealth ?? STEALTH_DEFAULT;
      const proxy = (params.proxy?.trim() ?? "") || PROXY_DEFAULT || undefined;

      // ── Cookie setup (auto-load from the agent dir's cookie) ──────
      const cookiesJson = loadAgentCookies();
      let cookieHashVal: string | undefined;
      let storageDir: string | undefined;
      if (cookiesJson) {
        cookieHashVal = cookieHash(cookiesJson);
        storageDir = setupCookieStorageDir(cookiesJson);
      }

      const dump = raw ? "html" : "markdown";
      const details: Record<string, any> = {
        urlsFetched: 0,
        urlsFailed: 0,
        stealth,
        ...(proxy ? { proxy } : {}),
        ...(cookieHashVal ? { cookiesHash: cookieHashVal } : {}),
      };
      const sections: string[] = [];

      // ── Mode 1: DuckDuckGo search → fetch top results ──────────
      if (query) {
        const maxResults = Math.min(Math.max(params.maxResults ?? 5, 1), 5);
        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        details.query = query;
        details.searchUrl = searchUrl;

        try {
          const searchHtml = await fetchWithCache(searchUrl, "html", cookieHashVal, storageDir, stealth, proxy);
          const resultUrls = extractUrlsFromDDGHTML(searchHtml, maxResults);

          if (resultUrls.length === 0) {
            // Fallback: extract from markdown if HTML parsing found nothing
            sections.push(
              `## Search: ${query}\n\n_DuckDuckGo returned no extractable results._`,
            );
            details.urlsFound = 0;
          } else {
            sections.push(`## Search: ${query}\n\n_Found ${resultUrls.length} results._`);
            details.urlsFound = resultUrls.length;

            for (const ru of resultUrls) {
              try {
                const text = await fetchWithCache(ru, dump, cookieHashVal, storageDir, stealth, proxy);
                const label = raw ? `Raw: ${ru}` : ru;
                if (text) {
                  sections.push(`## ${label}\n\n${text.slice(0, MAX_RESULT_CHARS)}`);
                  details.urlsFetched++;
                }
              } catch (err) {
                sections.push(
                  `## ${ru}\n\n_Fetch failed: ${err instanceof Error ? err.message : "unknown error"}_`,
                );
                details.urlsFailed++;
              }
            }
          }
        } catch (err) {
          return errRes(
            `Error searching "${query}": ${err instanceof Error ? err.message : "unknown error"}`,
          );
        }
      }

      // ── Mode 2: Direct URL fetch ───────────────────────────────
      if (url) {
        details.url = url;
        try {
          const text = await fetchWithCache(url, dump, cookieHashVal, storageDir, stealth, proxy);
          const label = raw ? `Raw HTML: ${url}` : url;
          sections.push(`## ${label}\n\n${text.slice(0, MAX_RESULT_CHARS)}`);
          details.urlsFetched = (details.urlsFetched as number) + 1;
        } catch (err) {
          sections.push(
            `## ${url}\n\n_Fetch failed: ${err instanceof Error ? err.message : "unknown error"}_`,
          );
          details.urlsFailed = (details.urlsFailed as number) + 1;
        }
      }

      if (sections.length === 0) {
        return errRes("No content fetched.");
      }

      const header = query ? `# Search: ${query}` : `# Fetch: ${url}`;
      return {
        content: [{ type: "text", text: `${header}\n\n${sections.join("\n\n---\n\n")}` }],
        details,
      };
    },
  });
}