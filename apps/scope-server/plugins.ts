/**
 * plugins.ts — Pi Scope server-side plugin host.
 *
 * Pi Scope's features (Chat, Terminal, Review, Checkpoints, Git, Single,
 * Trajectory, …) are modelled as *plugins*. Each plugin is a directory with a
 * `plugin.json` manifest and — optionally — a server entry module and a client
 * entry bundle. The host is responsible for:
 *
 *   1. Discovering plugins in two roots: the app's built-in plugins
 *      (`apps/scope-server/plugins/`) and the user's plugin directory
 *      (`$SCOPE_PLUGINS_DIR`, default `~/.pi-scope/plugins`).
 *   2. Persisting which plugins are enabled/disabled (`plugins.json` in the
 *      user plugin directory) — the Settings → Plugins page writes this via
 *      `POST /plugins`.
 *   3. Loading the server entry of every enabled plugin and handing it a small
 *      API (`api.route`, `api.onEvent`, `api.store`, `api.log`) so a plugin can
 *      add HTTP routes, observe ingested events, and keep its own state.
 *   4. Gating the built-in feature routes: when a feature plugin is disabled,
 *      requests under its declared `serverRoutes` prefixes are refused.
 *
 * The host is intentionally dependency-free (node:fs / node:path / node:url)
 * and has no import of server.ts, so server.ts can import it without a cycle.
 * HTTP helpers it needs (json responses, body parsing) are passed in at request
 * time by the caller.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

// ─── Locations ──────────────────────────────────────────────────────────────

/**
 * Built-in plugins shipped with the app (feature modules + examples).
 *
 * Resolved next to the host module so the same path works in both layouts: the
 * repo (`apps/scope-server/plugins`, where server.ts lives) and a packaged build
 * (`server-bundle/plugins`, beside the bundled server.js — see build-release.sh).
 * `SCOPE_BUILTIN_PLUGINS_DIR` overrides it.
 */
export const BUILTIN_DIR =
  process.env.SCOPE_BUILTIN_PLUGINS_DIR ?? path.join(import.meta.dirname, "plugins");

/** User plugins. Override with SCOPE_PLUGINS_DIR (e.g. to keep them in-repo). */
export const USER_DIR =
  process.env.SCOPE_PLUGINS_DIR ?? path.join(os.homedir(), ".pi-scope", "plugins");

/** Where enable/disable choices are persisted. */
const CONFIG_PATH = path.join(USER_DIR, "plugins.json");
/** Namespaced JSON storage handed to plugins via `api.store`. */
const STORE_DIR = path.join(USER_DIR, ".data");

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PluginManifest {
  id: string;
  name: string;
  description?: string;
  version?: string;
  author?: string;
  /** Enabled unless explicitly disabled (or listed in the config). */
  defaultEnabled?: boolean;
  /** Core plugins host infrastructure and can never be disabled. */
  core?: boolean;
  /** Server entry module, relative to the plugin dir (e.g. "server.js"). */
  server?: string;
  /** Client entry bundle, relative to the plugin dir (e.g. "client.js"). */
  client?: string;
  /**
   * URL prefixes the plugin owns. A built-in feature plugin declares the
   * server routes it backs; when the plugin is disabled those routes return
   * 403 instead of running. A user plugin may also declare them for the same
   * coarse gate (its own routes are always served while it is enabled).
   */
  serverRoutes?: string[];
  /** Optional nav/UI metadata for a feature plugin's own nav entry. */
  nav?: { label?: string; order?: number; group?: string };
  /** Free-form fields copied into the snapshot for the UI. */
  ui?: Record<string, unknown>;
}

export interface PluginRecord {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  source: "builtin" | "user";
  dir: string;
  manifest: PluginManifest;
  enabled: boolean;
  hasServer: boolean;
  hasClient: boolean;
  /** URL the browser can load a client bundle from, or null without a client. */
  clientUrl: string | null;
  /** Set when the plugin failed to load — surfaced in Settings. */
  error: string | null;
  serverRoutes: string[];
}

type Ctx = {
  url: URL;
  method: string;
  req: Request;
  params: Record<string, string>;
  readBody: (req: Request) => Promise<string>;
  json: (body: unknown, status?: number) => Response;
  cwd?: string | null;
};

type RouteHandler = (ctx: Ctx) => unknown | Promise<unknown>;

interface PluginRoute {
  pluginId: string;
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: RouteHandler;
}

/** Services the server hands to plugins at activation time. The shared git /
 *  diff / graph primitives and the settings reader live in server.ts (they are
 *  bound to server-owned state such as the allowed file roots), so they are
 *  passed in rather than imported — that keeps a plugin from importing server.ts
 *  and hitting a partially-initialised module. */
export interface PluginHost {
  kit?: Record<string, any>;
}

export interface PluginApi {
  id: string;
  dir: string;
  source: "builtin" | "user";
  /** Shared host primitives (git, diff, graph, settings, HTTP helpers). */
  kit: Record<string, any>;
  /** Validate a caller-supplied cwd against the server's allowed file roots. */
  validateCwd: (cwd: string) => string | null;
  log: (...args: unknown[]) => void;
  /** Register an HTTP route. Path supports `:name` params, and `*` suffixes. */
  route: (method: string, routePath: string, handler: RouteHandler) => void;
  /** Observe every event ingested through POST /events. */
  onEvent: (handler: (event: any) => void) => void;
  /** Namespaced JSON storage, persisted to `<USER_DIR>/.data/<id>.json`. */
  store: {
    get: <T = any>(key: string, fallback?: T) => T | undefined;
    set: (key: string, value: unknown) => void;
    all: () => Record<string, unknown>;
  };
}

// ─── State ──────────────────────────────────────────────────────────────────

const records = new Map<string, PluginRecord>();
const routes: PluginRoute[] = [];
const eventHooks: { pluginId: string; handler: (event: any) => void }[] = [];
const loaded = new Set<string>();
const activations = new Map<string, PluginApi>();

let config: { disabled: string[] } = { disabled: [] };

// ─── Config ─────────────────────────────────────────────────────────────────

function readConfig(): { disabled: string[] } {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return { disabled: Array.isArray(parsed?.disabled) ? parsed.disabled.map(String) : [] };
  } catch {
    return { disabled: [] };
  }
}

function writeConfig(): void {
  try {
    fs.mkdirSync(USER_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ disabled: [...config.disabled].sort() }, null, 2) + "\n", { mode: 0o600 });
  } catch (err) {
    console.error("[plugins] failed to persist plugins.json:", err);
  }
}

// ─── Discovery ──────────────────────────────────────────────────────────────

function readManifest(dir: string): PluginManifest | null {
  const file = path.join(dir, "plugin.json");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`[plugins] invalid JSON in ${file}:`, err);
    return null;
  }
  const id = String(parsed?.id ?? path.basename(dir)).trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
    console.error(`[plugins] invalid plugin id in ${file}: ${id}`);
    return null;
  }
  return {
    id,
    name: String(parsed?.name ?? id),
    description: String(parsed?.description ?? ""),
    version: String(parsed?.version ?? "0.0.0"),
    author: String(parsed?.author ?? ""),
    defaultEnabled: parsed?.defaultEnabled !== false,
    core: parsed?.core === true,
    server: typeof parsed?.server === "string" ? parsed.server : undefined,
    client: typeof parsed?.client === "string" ? parsed.client : undefined,
    // Never accept an empty prefix — it would match every request path.
    serverRoutes: Array.isArray(parsed?.serverRoutes)
      ? parsed.serverRoutes.map(String).map((s) => s.trim()).filter(Boolean)
      : [],
    nav: parsed?.nav && typeof parsed.nav === "object" ? parsed.nav : undefined,
    ui: parsed?.ui && typeof parsed.ui === "object" ? parsed.ui : undefined,
  };
}

function scanDir(root: string, source: "builtin" | "user"): PluginManifest[] {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: PluginManifest[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const dir = path.join(root, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const manifest = readManifest(dir);
    if (manifest) out.push(manifest);
  }
  return out;
}

/**
 * (Re)build the plugin table from disk. User plugins with the same id as a
 * built-in override it — that is how a user swaps out a shipped feature.
 */
export function discover(): PluginRecord[] {
  records.clear();
  config = readConfig();
  const disabled = new Set(config.disabled);

  // Scan each root once: the built-in manifests feed both the id lookup (to
  // tell a built-in from a user plugin) and the merged table below.
  const seen = new Map<string, PluginManifest>();
  const builtinManifests = scanDir(BUILTIN_DIR, "builtin");
  const builtinIds = new Set(builtinManifests.map((m) => m.id));
  for (const m of builtinManifests) seen.set(m.id, m);
  for (const m of scanDir(USER_DIR, "user")) seen.set(m.id, m);

  for (const manifest of seen.values()) {
    const source: "builtin" | "user" = builtinIds.has(manifest.id) && !isUserOverride(manifest.id) ? "builtin" : "user";
    const dir = pluginDir(manifest.id, source);
    const serverEntry = manifest.server ? path.join(dir, manifest.server) : null;
    const clientEntry = manifest.client ? path.join(dir, manifest.client) : null;
    records.set(manifest.id, {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description ?? "",
      version: manifest.version ?? "0.0.0",
      author: manifest.author ?? "",
      source,
      dir,
      manifest,
      enabled: manifest.defaultEnabled !== false && !disabled.has(manifest.id),
      hasServer: !!serverEntry && fs.existsSync(serverEntry),
      hasClient: !!clientEntry && fs.existsSync(clientEntry),
      // Any plugin — built-in or user — may ship a client bundle. Built-ins
      // used to be hard-wired into index.html; serving them through the same
      // `/plugins/file/` route (and the same dynamic <script> load) is what lets
      // one be a self-contained plugin directory (see plugins/office).
      clientUrl: clientEntry && fs.existsSync(clientEntry)
        ? `/plugins/file/${encodeURIComponent(manifest.id)}/${manifest.client!.split(path.sep).join("/")}`
        : null,
      error: null,
      serverRoutes: manifest.serverRoutes ?? [],
    });
  }
  return [...records.values()].sort(comparePlugins);
}

/** A user plugin only exists in USER_DIR — a built-in id may still be overridden. */
function isUserOverride(id: string): boolean {
  return fs.existsSync(path.join(USER_DIR, id, "plugin.json"));
}

function pluginDir(id: string, source: "builtin" | "user"): string {
  return source === "user" ? path.join(USER_DIR, id) : path.join(BUILTIN_DIR, id);
}

function comparePlugins(a: PluginRecord, b: PluginRecord): number {
  const ao = a.manifest.nav?.order ?? 1000;
  const bo = b.manifest.nav?.order ?? 1000;
  if (ao !== bo) return ao - bo;
  return a.id.localeCompare(b.id);
}

// ─── Storage ────────────────────────────────────────────────────────────────

function storeFile(id: string): string {
  return path.join(STORE_DIR, `${id}.json`);
}

/**
 * The namespaced store instances handed out so far, keyed by plugin id.
 *
 * A plugin's store is memoised per id on purpose: the host may also read it (the
 * Git feature's settings are read by core for the Settings snapshot), and two
 * handles over one file would each cache their own copy — a write through one
 * would be invisible to the other.
 */
const stores = new Map<string, PluginApi["store"]>();

/** The store for `id` (`<USER_DIR>/.data/<id>.json`), created once per id. */
export function storeFor(id: string): PluginApi["store"] {
  let store = stores.get(id);
  if (!store) {
    store = makeStore(id);
    stores.set(id, store);
  }
  return store;
}

function makeStore(id: string): PluginApi["store"] {
  let cache: Record<string, unknown> | null = null;
  const read = (): Record<string, unknown> => {
    if (cache) return cache;
    try {
      cache = JSON.parse(fs.readFileSync(storeFile(id), "utf8"));
    } catch {
      cache = {};
    }
    return cache!;
  };
  const flush = () => {
    try {
      fs.mkdirSync(STORE_DIR, { recursive: true });
      fs.writeFileSync(storeFile(id), JSON.stringify(cache ?? {}, null, 2) + "\n", { mode: 0o600 });
    } catch (err) {
      console.error(`[plugins:${id}] failed to persist store:`, err);
    }
  };
  return {
    get(key, fallback) {
      const all = read();
      return (key in all ? (all[key] as any) : fallback) as any;
    },
    set(key, value) {
      read()[key] = value;
      flush();
    },
    all: () => ({ ...read() }),
  };
}

// ─── Route registry ─────────────────────────────────────────────────────────

/** Compile a plugin route path (`/foo/:id/bar`) into a RegExp + param keys. */
function compileRoute(routePath: string): { pattern: RegExp; keys: string[] } {
  const keys: string[] = [];
  const normalized = routePath.startsWith("/") ? routePath : `/${routePath}`;
  // Escape regex metacharacters except our own tokens.
  const parts = normalized.split("/").map((seg) => {
    if (seg.startsWith(":")) {
      keys.push(seg.slice(1));
      return "([^/]+)";
    }
    if (seg === "*") {
      keys.push("wildcard");
      return "(.*)";
    }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return { pattern: new RegExp(`^${parts.join("/")}$`), keys };
}

function makeApi(record: PluginRecord, host: PluginHost): PluginApi {
  return {
    id: record.id,
    dir: record.dir,
    source: record.source,
    kit: { ...(host.kit ?? {}) },
    validateCwd: host.kit?.validateCwd ?? (() => null),
    log: (...args: unknown[]) => console.log(`[plugin:${record.id}]`, ...args),
    route: (method, routePath, handler) => {
      const { pattern, keys } = compileRoute(routePath);
      routes.push({ pluginId: record.id, method: method.toUpperCase(), pattern, keys, handler });
    },
    onEvent: (handler) => {
      eventHooks.push({ pluginId: record.id, handler });
    },
    store: storeFor(record.id),
  };
}

// ─── Activation ─────────────────────────────────────────────────────────────

let activating: Promise<void> | null = null;

/** Load the server entry of every enabled plugin that declares one. */
export async function activate(host: PluginHost = {}): Promise<void> {
  if (activating) return activating;
  activating = (async () => {
    if (!records.size) discover();
    for (const record of records.values()) {
      if (!record.enabled || !record.hasServer || loaded.has(record.id)) continue;
      const entryRel = record.manifest.server!;
      const entry = path.resolve(record.dir, entryRel);
      // The entry must stay inside the plugin directory.
      if (!entry.startsWith(record.dir + path.sep)) {
        record.error = "server entry escapes the plugin directory";
        continue;
      }
      try {
        const mod: any = await import(pathToFileURL(entry).href);
        const activateFn = mod?.activate ?? mod?.default;
        if (typeof activateFn !== "function") {
          record.error = "server entry has no activate() export";
          continue;
        }
        const api = makeApi(record, host);
        await activateFn(api);
        activations.set(record.id, api);
        loaded.add(record.id);
        console.log(`[plugins] activated ${record.id} (${record.source})`);
      } catch (err: any) {
        record.error = String(err?.message ?? err);
        console.error(`[plugins] failed to activate ${record.id}:`, err);
      }
    }
  })().finally(() => { activating = null; });
  return activating;
}

/** Drop a plugin's routes, hooks and activation so it can be re-imported. */
function deactivate(id: string): void {
  for (let i = routes.length - 1; i >= 0; i--) if (routes[i].pluginId === id) routes.splice(i, 1);
  for (let i = eventHooks.length - 1; i >= 0; i--) if (eventHooks[i].pluginId === id) eventHooks.splice(i, 1);
  loaded.delete(id);
  activations.delete(id);
}

// ─── Public API used by server.ts ───────────────────────────────────────────

export function getRecord(id: string): PluginRecord | undefined {
  return records.get(id);
}

export function isEnabled(id: string): boolean {
  return records.get(id)?.enabled === true;
}

export function listPlugins(): PluginRecord[] {
  return [...records.values()].sort(comparePlugins);
}

/** Snapshot handed to `GET /plugins` and embedded in the Settings payload. */
export function pluginSnapshot(): Record<string, unknown> {
  return {
    pluginsDir: USER_DIR,
    pluginsBuiltinDir: BUILTIN_DIR,
    configPath: CONFIG_PATH,
    plugins: listPlugins().map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      version: r.version,
      author: r.author,
      source: r.source,
      enabled: r.enabled,
      core: r.manifest.core === true,
      hasServer: r.hasServer,
      hasClient: r.hasClient,
      clientUrl: r.clientUrl,
      error: r.error,
      serverRoutes: r.serverRoutes,
      nav: r.manifest.nav ?? null,
      ui: r.manifest.ui ?? null,
      dir: r.dir,
    })),
  };
}

/**
 * Enable/disable a plugin. Persists the choice, tears the plugin down when it
 * is disabled, and activates it when it is enabled. Returns the fresh snapshot.
 */
export async function setPluginEnabled(
  id: string,
  enabled: boolean,
  host: PluginHost = {},
): Promise<Record<string, unknown>> {
  const record = records.get(id);
  if (!record) throw new Error(`unknown plugin: ${id}`);
  if (!enabled && record.manifest.core) throw new Error(`plugin ${id} is core and cannot be disabled`);
  const disabled = new Set(config.disabled);
  if (enabled) disabled.delete(id);
  else disabled.add(id);
  config = { disabled: [...disabled] };
  writeConfig();

  record.enabled = enabled;
  if (!enabled) {
    deactivate(id);
    record.error = null;
  } else if (record.hasServer && !loaded.has(id)) {
    await activate(host);
  }
  return pluginSnapshot();
}

/** Re-scan disk and (re)activate. Used by the Reload action + on boot. */
export async function reload(host: PluginHost = {}): Promise<Record<string, unknown>> {
  for (const id of [...loaded]) deactivate(id);
  discover();
  await activate(host);
  return pluginSnapshot();
}

/**
 * Gate a built-in feature route by plugin enablement. Returns the id of a
 * *disabled* plugin owning `pathname`, or null when the route may proceed.
 */
export function disabledPluginForRoute(pathname: string): string | null {
  for (const record of records.values()) {
    if (record.enabled) continue;
    for (const prefix of record.serverRoutes) {
      const base = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
      if (pathname === base || pathname.startsWith(`${base}/`)) return record.id;
    }
  }
  return null;
}

/** Find the enabled plugin route matching a method + pathname. */
export function matchPluginRoute(
  method: string,
  pathname: string,
): { route: PluginRoute; params: Record<string, string> } | null {
  const m = method.toUpperCase();
  for (const route of routes) {
    if (route.method !== m) continue;
    if (!records.get(route.pluginId)?.enabled) continue;
    const match = route.pattern.exec(pathname);
    if (!match) continue;
    const params: Record<string, string> = {};
    route.keys.forEach((k, i) => { params[k] = decodeURIComponent(match[i + 1] ?? ""); });
    return { route, params };
  }
  return null;
}

/** Run a plugin route handler and normalize its return value to a Response. */
export async function runPluginRoute(
  match: { route: PluginRoute; params: Record<string, string> },
  ctx: Omit<Ctx, "params">,
): Promise<Response> {
  try {
    const result = await match.route.handler({ ...ctx, params: match.params });
    if (result instanceof Response) return result;
    return ctx.json(result ?? { ok: true });
  } catch (err: any) {
    console.error(`[plugins] route ${match.route.pattern} failed:`, err);
    return ctx.json({ error: String(err?.message ?? err) }, 500);
  }
}

/** Fan out an ingested event to every enabled plugin that asked for events. */
export function emitPluginEvent(event: any): void {
  for (const hook of [...eventHooks]) {
    if (!records.get(hook.pluginId)?.enabled) continue;
    try {
      hook.handler(event);
    } catch (err) {
      console.error(`[plugins:${hook.pluginId}] event hook failed:`, err);
    }
  }
}

/** Resolve a user-plugin client bundle to a path on disk (within its dir). */
export function resolvePluginFile(id: string, rel: string): string | null {
  const record = records.get(id);
  if (!record) return null;
  const base = record.dir;
  const full = path.resolve(base, rel);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}
