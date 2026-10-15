/**
 * Shared disk cache for provider model-list fetches.
 *
 * Provider extensions (kilo, tokenharbor) fetch their model lists over the
 * network at extension load time. The agent-team extension loads every
 * extension into every spawned subagent process, so each subagent boot paid
 * one or more remote fetches (up to 10s timeout each) before it could even
 * start the LLM. Caching the model list to disk makes subagent boots read a
 * local file instead — network only happens when the cache is missing or
 * stale. The host process refreshes the cache on its own boot; short-lived
 * subagents consume it.
 *
 * Every provider shares ONE cache directory (<agent dir>/../Provider_Cache) and
 * ONE cache file (model_provider.json) holding one section per provider cache
 * key, instead of a separate <key>.json per provider.
 */

import { dirname, join } from "path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "fs";
import { randomBytes } from "crypto";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { safeUnlink } from "./core";

// Per-user cache directory, shared by all projects, placed beside the pi that
// runs this extension instead of a fixed ~/.pi: the agent dir's parent is the
// install/data root — ~/.pi-scope for Pi Scope's bundled agent
// (PI_CODING_AGENT_DIR=~/.pi-scope/agent, alongside its pi shim) and ~/.pi for a
// global install — so each agent reads and writes its OWN cache and Pi Scope
// never touches the user's global pi data. The cached model lists describe
// provider APIs, not the local project, so one copy still serves every project.
const CACHE_DIR = join(dirname(getAgentDir()), "Provider_Cache");
/** All providers are stored in this one file, keyed by provider cache key,
 *  so the per-user cache directory holds a single model_provider.json. */
const CACHE_FILE = join(CACHE_DIR, "model_provider.json");
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

/** Owner-only. Cached model lists can reflect account-specific entitlements
 *  (e.g. a provider's custom/allowed model set for the caller's API key), so
 *  the cache directory and its files should not be world-readable on shared
 *  machines.
 *
 *  POSIX-only guarantee: Windows has no mode bits (NTFS uses ACLs), so the
 *  mode argument and the chmodSync below are ignored there and the cache
 *  inherits the user profile's ACL — which is already per-user on a default
 *  Windows install, so there is nothing to tighten. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function ensureCacheDir(): void {
  mkdirSync(CACHE_DIR, { recursive: true, mode: DIR_MODE });
  // mkdirSync's `mode` isn't reliably honoured for pre-existing directories
  // (e.g. left over from before this change, or created with a wider
  // process umask), so enforce it explicitly. Best-effort: unsupported on
  // some platforms/filesystems.
  try { chmodSync(CACHE_DIR, DIR_MODE); } catch { /* best effort */ }
}

interface CacheEnvelope<T> {
  cachedAt: number;
  data: T;
}

/** The whole file: provider cache key → that provider's envelope. */
type CacheFile = Record<string, CacheEnvelope<unknown>>;

/** Read every provider section. A missing or corrupted file reads as empty
 *  so callers degrade to "no cache" instead of throwing. */
function readCacheFile(): CacheFile {
  try {
    if (!existsSync(CACHE_FILE)) return {};
    const parsed = JSON.parse(readFileSync(CACHE_FILE, "utf-8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as CacheFile;
    }
  } catch {
    /* missing / corrupted — treat as no cache */
  }
  return {};
}

function readEnvelope<T>(key: string): CacheEnvelope<T> | null {
  const env = readCacheFile()[key];
  if (env && typeof env.cachedAt === "number" && Array.isArray(env.data)) {
    return env as CacheEnvelope<T>;
  }
  return null;
}

/** A model list is only usable when non-empty — caching an empty array would
 *  pin the provider to zero models for the whole TTL (e.g. a rate-limited
 *  upstream that momentarily returns `{ data: [] }`). */
function isUsable(models: unknown[]): boolean {
  return models.length > 0;
}

/**
 * Serialize read-modify-write of the shared cache file within this process:
 * a write must re-read the current file first so the other providers'
 * sections survive. TokenHarbor and Kilo register in parallel at load, so on
 * a cold (or fully stale) cache both fetches finish at once and, without
 * this, the second write would silently drop the first provider's section.
 */
let writeChain: Promise<unknown> = Promise.resolve();

/** Persist one provider's section, preserving every other section already in
 *  the file. */
function writeEnvelope<T>(key: string, data: T[]): void {
  writeChain = writeChain
    .then(() => {
      const all = readCacheFile();
      all[key] = { cachedAt: Date.now(), data } satisfies CacheEnvelope<T[]>;
      // Write via temp file + rename so a concurrent reader (host + a
      // subagent booting at the same time) never sees a torn file. The temp
      // name is unique per call (pid + random suffix) so two writers racing
      // across processes never share a path and interleave writes into the
      // same file; whichever rename lands last wins atomically. A
      // cross-process race can still lose the other process's section, which
      // costs one extra fetch later — never a corrupt file.
      const tmp = `${CACHE_FILE}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      try {
        ensureCacheDir();
        writeFileSync(tmp, JSON.stringify(all), { mode: FILE_MODE });
        renameSync(tmp, CACHE_FILE);
      } catch {
        /* cache write failure is non-fatal — but don't leave an orphaned
         * temp file sitting on disk forever if we got past the write. */
        safeUnlink(tmp);
      }
    })
    .catch(() => {
      /* a failed write must not poison the chain for later keys */
    });
}

/**
 * Return the cached model list for `key` when it exists and is fresher than
 * `ttlMs`; otherwise fetch via `fetchFn` and write the result to disk. On a
 * fetch failure, fall back to the stale cache when one exists (better to
 * serve slightly stale model metadata than an empty provider). Throws only
 * when there is neither a usable cache nor a successful fetch.
 */
export async function loadCachedModels<T>(
  key: string,
  fetchFn: () => Promise<T[]>,
  opts?: { ttlMs?: number },
): Promise<T[]> {
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;

  const fresh = readEnvelope<T[]>(key);
  if (fresh && isUsable(fresh.data) && Date.now() - fresh.cachedAt < ttlMs) return fresh.data;

  try {
    const data = await fetchFn();
    writeEnvelope(key, data);
    return data;
  } catch (err) {
    const stale = readEnvelope<T[]>(key);
    if (stale && isUsable(stale.data)) return stale.data;
    throw err;
  }
}
