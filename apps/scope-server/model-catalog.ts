/**
 * model-catalog.ts — keep Pi's two model catalogs fresh while Pi Scope is open.
 *
 *   <agent dir>/models-store.json         pi's provider/model store: ids,
 *                                         context windows, pricing. Pi Scope
 *                                         reads it for the composer footer, the
 *                                         Settings cost catalog and the Workflow
 *                                         node's model metadata.
 *   <agent dir>/model-update-cache.json   the `pi-updater` extension's models.dev
 *                                         release cache — { checkedAt, models,
 *                                         notified }, refreshed behind a 4h TTL.
 *
 * Both are written by *pi*, never by Pi Scope: `pi update --models` rewrites the
 * store (pi's own package manager runs `modelRuntime.refresh({ allowNetwork:
 * true })`), and the pi-updater extension pulls models.dev on session start. But
 * Pi Scope launches pi with `PI_OFFLINE=1` (see chat.ts — a resumed session must
 * not race a startup version check), and pi-updater bails out on `PI_OFFLINE` and
 * on a session without UI. So while the app is in use those two files only age:
 * someone who works entirely inside Pi Scope never sees a new model, a new price
 * or a new context window.
 *
 * This module hands that duty to the app: while the server is up it re-checks
 * both files and refreshes whichever has gone past the TTL, so opening the app
 * is enough to bring them current. It is deliberately conservative:
 *
 *   • **A catalog is (re)written only from a real source.** The store is produced
 *     by pi's own `update --models`; the cache by a validated models.dev
 *     response. There is no synthesized fallback, so a machine with no network
 *     ends up with no file rather than a fabricated one. Both are therefore also
 *     *created* when absent (an agent dir that has never run pi online gets its
 *     catalogs from the app, which is the point of the feature).
 *   • **Pi's own command does the store.** `pi update --models` is spawned (the
 *     bundle's CLI entry, not the `pi` shim: the shim injects `--extension`
 *     before the subcommand, which pi's package manager parses as an argument of
 *     `update` and rejects). `PI_CODING_AGENT_DIR` is pinned to the agent dir Pi
 *     Scope reads, so the write lands where the read happens.
 *   • **The models.dev response is validated before it replaces anything**, and
 *     `notified` is preserved, exactly as pi-updater does — a failed or
 *     unrecognized response leaves the previous catalog in place.
 *   • **`SCOPE_MODEL_CATALOG=off` disables the background scheduler** (an explicit
 *     refresh still works: that is a user asking, not the app assuming).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { AGENT_DIR } from "./agent-dir.ts";
import { PI_BIN, PI_BUNDLE } from "./pi-bundle.ts";

/** Pi's model store. `SCOPE_MODELS_STORE` is honoured so tests (and a user with a
 *  relocated agent dir) can point it elsewhere — server.ts reads the same file. */
export const MODELS_STORE_PATH = process.env.SCOPE_MODELS_STORE ?? path.join(AGENT_DIR, "models-store.json");
/** The pi-updater extension's release cache. */
export const MODEL_UPDATE_CACHE_PATH =
  process.env.SCOPE_MODEL_UPDATE_CACHE ?? path.join(AGENT_DIR, "model-update-cache.json");

/** How old a catalog may get before the app refreshes it. This is pi-updater's
 *  own interval, so a terminal pi and Pi Scope agree on what "current" means. */
export const MODEL_CATALOG_TTL_MS = 4 * 60 * 60 * 1000;

/** How often the app re-checks (cheap stats) while it is open. */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** Wait after boot before the first check, so startup never competes with it. */
const BOOT_DELAY_MS = 5_000;
/** models.dev lookup budget. */
const FETCH_TIMEOUT_MS = 10_000;
/** `pi update --models` budget. */
const UPDATE_TIMEOUT_MS = 3 * 60 * 1000;
/** Keep only the tail of pi's output — it is for diagnostics, not display. */
const MAX_OUTPUT = 4_000;

/** The catalog pi-updater downloads. Overridable (tests point it at a local
 *  server, air-gapped installs at a mirror). */
function catalogUrl(): string {
  return (process.env.SCOPE_MODELS_DEV_URL || "https://models.dev/api.json").trim();
}

// ─── The release cache (pi-updater's file) ──────────────────────────────────

interface CatalogModel {
  provider: string;
  id: string;
  family: string;
  releaseDate: string;
  canonicalId?: string;
  deprecated?: boolean;
}

interface ModelUpdateCache {
  checkedAt: number;
  models: CatalogModel[];
  notified: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function isReleaseDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
function isCatalogModel(value: unknown): value is CatalogModel {
  return isRecord(value) && isText(value.provider) && isText(value.id) &&
    isText(value.family) && isReleaseDate(value.releaseDate) &&
    (value.canonicalId === undefined || isText(value.canonicalId)) &&
    (value.deprecated === undefined || typeof value.deprecated === "boolean");
}

/** The parsed cache, memoised by mtime, with the number of distinct providers it
 *  names. `modelCatalogStatus` reports both on every Settings snapshot, and
 *  re-parsing a multi-megabyte file just to show a number would be the most
 *  expensive thing in that response. */
let updateCacheMemo: { mtimeMs: number; cache: ModelUpdateCache; providers: number } | null = null;

/** Read the cache, tolerating anything: it is another extension's file and may be
 *  absent, half-written, or a shape from a newer pi-updater. */
function readUpdateCache(): ModelUpdateCache {
  const mtimeMs = statMtime(MODEL_UPDATE_CACHE_PATH);
  if (mtimeMs === null) {
    // The file may have been deleted (or never written): drop the memo so a
    // stale parse cannot be reported as current.
    updateCacheMemo = null;
    return { checkedAt: 0, models: [], notified: [] };
  }
  if (updateCacheMemo && updateCacheMemo.mtimeMs === mtimeMs) return updateCacheMemo.cache;
  let cache: ModelUpdateCache = { checkedAt: 0, models: [], notified: [] };
  try {
    const value: unknown = JSON.parse(fs.readFileSync(MODEL_UPDATE_CACHE_PATH, "utf8"));
    if (isRecord(value) && typeof value.checkedAt === "number" && Number.isFinite(value.checkedAt) &&
      Array.isArray(value.models) && Array.isArray(value.notified)) {
      cache = {
        checkedAt: value.checkedAt,
        models: value.models.filter(isCatalogModel),
        notified: value.notified.filter(isText),
      };
    }
  } catch { /* absent or unreadable */ }
  updateCacheMemo = {
    mtimeMs,
    cache,
    providers: new Set(cache.models.map((m) => m.provider)).size,
  };
  return cache;
}

/** Atomic write, same shape pi-updater produces (`JSON.stringify` + newline). */
function writeUpdateCache(cache: ModelUpdateCache): void {
  const temporary = `${MODEL_UPDATE_CACHE_PATH}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(MODEL_UPDATE_CACHE_PATH), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(cache) + "\n");
    fs.renameSync(temporary, MODEL_UPDATE_CACHE_PATH);
    // Drop the memo rather than trusting the new mtime: a same-millisecond
    // rename must not be masked by a stale parse.
    updateCacheMemo = null;
  } catch {
    try { fs.unlinkSync(temporary); } catch { /* never created */ }
  }
}

/** Turn a models.dev response into `CatalogModel[]`, or null when it is not a
 *  catalog we recognize (an error page must never replace a good cache). */
function parseCatalog(value: unknown): CatalogModel[] | null {
  if (!isRecord(value)) return null;
  const models: CatalogModel[] = [];
  for (const [provider, entry] of Object.entries(value)) {
    if (!isRecord(entry) || !isRecord(entry.models)) continue;
    for (const [id, model] of Object.entries(entry.models)) {
      if (!isRecord(model) || !isText(model.family) || !isReleaseDate(model.release_date)) continue;
      if (model.type !== undefined && model.type !== "chat") continue;
      models.push({
        provider,
        id,
        family: model.family,
        releaseDate: model.release_date,
        canonicalId: isText(model.canonical_model_id) ? model.canonical_model_id : undefined,
        deprecated: model.status === "deprecated",
      });
    }
  }
  return models.length ? models : null;
}

interface PartResult {
  /** True when this run actually refreshed the file. */
  refreshed: boolean;
  /** Why it did not, when it did not. */
  skipped?: "fresh" | "no-command";
  /** Failure detail, when the refresh was attempted and failed. */
  error?: string;
  /** Tail of the command's output (store refresh only). */
  output?: string;
}

async function refreshUpdateCache(): Promise<PartResult> {
  const cache = readUpdateCache();
  let models = cache.models;
  let error: string | undefined;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(catalogUrl(), {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`);
    const parsed = parseCatalog(await res.json());
    if (!parsed) throw new Error("models.dev response had no model release metadata");
    models = parsed;
  } catch (err: any) {
    error = err?.name === "AbortError"
      ? `models.dev timed out after ${FETCH_TIMEOUT_MS / 1000}s`
      : String(err?.message ?? err);
  } finally {
    clearTimeout(timer);
  }
  // Like pi-updater: record the attempt either way so a failing endpoint is not
  // retried on every pass, and never replace a good catalog with a bad response.
  // The one exception is a cache that does not exist yet: a failed fetch must not
  // *create* an empty one, or the app would be inventing pi's state.
  if (!error || statMtime(MODEL_UPDATE_CACHE_PATH) !== null) {
    writeUpdateCache({ ...cache, checkedAt: Date.now(), models });
  }
  return { refreshed: !error, error };
}

// ─── The model store (pi's own command) ─────────────────────────────────────

/**
 * How to ask pi to refresh its catalogs.
 *
 * The bundle's CLI entry is used when Pi Scope owns a bundle: the `pi` shim it
 * installs passes `--extension <pi-scope.ts>` *before* the subcommand, and pi's
 * package manager reads whatever follows as `update`'s own arguments, so
 * `pi update --models` through the shim fails with "Unknown option: --models".
 * An override (SCOPE_PI_BIN, e.g. an operator's own pi) or a global install is
 * still asked — the refresh writes into the agent dir Pi Scope reads.
 */
function storeRefreshCommand(): { bin: string; args: string[] } | null {
  if (PI_BUNDLE.cli) return { bin: process.execPath, args: [PI_BUNDLE.cli, "update", "--models"] };
  return PI_BIN ? { bin: PI_BIN, args: ["update", "--models"] } : null;
}

function refreshStore(): Promise<PartResult> {
  const command = storeRefreshCommand();
  if (!command) return Promise.resolve({ refreshed: false, skipped: "no-command" });
  return new Promise((resolve) => {
    // A refresh needs the network, so PI_OFFLINE (which means "don't") is dropped
    // for this child only. The agent dir is pinned so pi writes the very file the
    // server reads, whatever PI_CODING_AGENT_DIR the surrounding shell had.
    const env: Record<string, string | undefined> = { ...process.env, PI_CODING_AGENT_DIR: AGENT_DIR };
    delete env.PI_OFFLINE;
    delete env.PI_SCOPE_FORCE_EXTENSION;
    let output = "";
    let settled = false;
    const done = (result: PartResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, output: output.trim() || undefined });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command.bin, command.args, { env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err: any) {
      resolve({ refreshed: false, error: `could not run ${command.bin}: ${err?.message ?? err}` });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* gone */ }
      done({ refreshed: false, error: `pi update --models timed out after ${UPDATE_TIMEOUT_MS / 60_000} minutes` });
    }, UPDATE_TIMEOUT_MS);
    const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-MAX_OUTPUT); };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", (err: any) => {
      done({
        refreshed: false,
        error: err?.code === "ENOENT" ? `pi not found (${command.bin})` : String(err?.message ?? err),
      });
    });
    child.on("close", (code) => {
      if (code === 0) done({ refreshed: true });
      else done({ refreshed: false, error: `pi update --models exited with code ${code}` });
    });
  });
}

// ─── Status + refresh ───────────────────────────────────────────────────────

export interface ModelCatalogStatus {
  /** Where pi's model store lives (the file the Settings cost catalog reads). */
  storePath: string;
  /** Where the release cache lives (pi-updater's file). */
  cachePath: string;
  /** mtime of the store, or null when pi has never written one. */
  storeUpdatedAt: number | null;
  /** `checkedAt` of the release cache, or null when it does not exist. */
  cacheCheckedAt: number | null;
  /** How many release entries the cache holds. */
  cacheModels: number;
  /** How many distinct providers those entries name. The cost table lists only
   *  the providers pi is configured for, so the two counts differ by design and
   *  the UI shows both. */
  cacheProviders: number;
  /** Whether pi has ever written the store in this agent dir. */
  storePresent: boolean;
  /** Whether the release cache exists. */
  cachePresent: boolean;
  /** The store is absent or past the TTL — a refresh would do something. */
  storeStale: boolean;
  /** The cache is absent or past the TTL — a refresh would do something. */
  cacheStale: boolean;
  ttlMs: number;
  /** A refresh is running right now. */
  refreshing: boolean;
  /** Whether the background scheduler is enabled in this process. */
  scheduled: boolean;
  /** Failure detail from the most recent attempt, if any. */
  lastError?: string;
  /** When the most recent attempt finished (ms epoch). */
  lastCheckedAt?: number;
  /** What the most recent attempt did, per file. */
  lastResult?: { store: PartResult; cache: PartResult };
}

function statMtime(file: string): number | null {
  try {
    const st = fs.statSync(file);
    return st.mtimeMs;
  } catch {
    return null;
  }
}

/** Whether the app keeps the model catalogs current by itself. On unless an
 *  operator sets `SCOPE_MODEL_CATALOG=off`; server.ts reads the same switch for
 *  the runtime "available models" read (it is "keep the model list fresh" too). */
export function modelCatalogAutoEnabled(): boolean {
  return String(process.env.SCOPE_MODEL_CATALOG || "").trim().toLowerCase() !== "off";
}

let inFlight: Promise<ModelCatalogStatus> | null = null;
let lastError: string | undefined;
let lastCheckedAt: number | undefined;
let lastResult: { store: PartResult; cache: PartResult } | undefined;
let timer: NodeJS.Timeout | null = null;

export function modelCatalogStatus(): ModelCatalogStatus {
  const now = Date.now();
  const storeUpdatedAt = statMtime(MODELS_STORE_PATH);
  const cacheMtime = statMtime(MODEL_UPDATE_CACHE_PATH);
  const cacheExists = cacheMtime !== null;
  const cache = cacheExists ? readUpdateCache() : null;
  return {
    storePath: MODELS_STORE_PATH,
    cachePath: MODEL_UPDATE_CACHE_PATH,
    storeUpdatedAt,
    cacheCheckedAt: cache ? cache.checkedAt : null,
    cacheModels: cache ? cache.models.length : 0,
    cacheProviders: cacheExists ? (updateCacheMemo?.providers ?? 0) : 0,
    storePresent: storeUpdatedAt !== null,
    cachePresent: cacheExists,
    // Absent counts as needing a refresh: the app produces the file from pi's own
    // command (store) or a validated models.dev response (cache).
    storeStale: storeUpdatedAt === null || now - storeUpdatedAt > MODEL_CATALOG_TTL_MS,
    cacheStale: !cacheExists || cache.checkedAt === 0 || now - cache.checkedAt > MODEL_CATALOG_TTL_MS,
    ttlMs: MODEL_CATALOG_TTL_MS,
    refreshing: inFlight !== null,
    scheduled: timer !== null,
    lastError,
    lastCheckedAt,
    lastResult,
  };
}

export function isRefreshingCatalog(): boolean {
  return inFlight !== null;
}

/**
 * Refresh whichever catalog is absent or behind the TTL. Concurrent calls share
 * one pass. `force` refreshes both files even when they look fresh (the Settings
 * → Update button).
 */
export function refreshModelCatalog(opts: { force?: boolean } = {}): Promise<ModelCatalogStatus> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      await run(opts);
    } finally {
      // Cleared before the status is read, so a returned status never claims a
      // refresh is still running (a concurrent caller shares this promise and
      // gets the same settled answer).
      inFlight = null;
    }
    return modelCatalogStatus();
  })();
  return inFlight;

  async function run(opts: { force?: boolean }): Promise<void> {
    const status = modelCatalogStatus();
    if (!opts.force && !status.storeStale && !status.cacheStale) {
      lastCheckedAt = Date.now();
      lastError = undefined;
      lastResult = {
        store: { refreshed: false, skipped: "fresh" },
        cache: { refreshed: false, skipped: "fresh" },
      };
      return;
    }
    const store = !opts.force && !status.storeStale
      ? { refreshed: false, skipped: "fresh" as const }
      : await refreshStore();
    const cache = !opts.force && !status.cacheStale
      ? { refreshed: false, skipped: "fresh" as const }
      : await refreshUpdateCache();
    lastCheckedAt = Date.now();
    lastResult = { store, cache };
    lastError = store.error || cache.error;
    if (store.refreshed || cache.refreshed) {
      console.log(
        `  Model catalogs: refreshed ${[store.refreshed ? "models-store.json" : null, cache.refreshed ? "model-update-cache.json" : null].filter(Boolean).join(" + ")}`,
      );
    } else if (lastError) {
      console.error(`  Model catalogs: refresh failed — ${lastError}`);
    }
  }
}

/**
 * Start the while-open refresh loop: one check shortly after boot, then hourly.
 * Both timers are unref'd, so they never hold the process open. No-op when the
 * scheduler is disabled or already running. The first tick also creates the two
 * catalogs when the agent dir has none, so opening the app is enough to have
 * them.
 */
export function startModelCatalogScheduler(): void {
  if (timer || !modelCatalogAutoEnabled()) return;
  const tick = () => {
    void refreshModelCatalog().catch((err) => {
      console.error("  Model catalogs: refresh threw:", (err as Error)?.message ?? err);
    });
  };
  const boot = setTimeout(tick, BOOT_DELAY_MS);
  boot.unref?.();
  timer = setInterval(tick, CHECK_INTERVAL_MS);
  timer.unref?.();
}
