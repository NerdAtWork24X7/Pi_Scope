// Cross-process fetch cache + in-flight lock for the `web-fetch` tool.
//
// Parallel dispatch runs each subagent as its OWN pi process, each with its own
// tool instance, so an in-memory map cannot stop two agents crawling the same
// page at the same time. This module coordinates through the filesystem instead
// (the same approach model-cache.ts uses for provider model lists):
//
//   <cwd>/.pi/web-fetch-cache/<key>.json   freshly crawled page text
//   <cwd>/.pi/web-fetch-cache/<key>.lock   "a crawler owns this URL right now"
//
// A fetch first looks for a fresh entry. If another process holds the lock, it
// waits for that entry instead of starting a second crawl — and only crawls the
// page itself when the holder dies or overruns the wait budget. Every subagent
// runs from the project root, so they all share one directory.
//
// Only full-page renders are cached. Search-engine SERP pages are query-specific
// and volatile, so they always go to the crawler.

import { createHash } from "crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { canonicalKey } from "./search";

function envNum(name: string, fallback: number): number {
	const n = Number(process.env[name]);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Shared cache directory. Project-local: every subagent inherits the project
 *  root as its cwd, so parallel agents write to the same place. */
export const CACHE_DIR = process.env.WEB_FETCH_CACHE_DIR ?? join(process.cwd(), ".pi", "web-fetch-cache");
/** How long a crawled page stays usable. 0 disables caching/dedupe entirely. */
export const CACHE_TTL_MS = envNum("WEB_FETCH_CACHE_TTL_MS", 10 * 60_000);
/** How long to wait on another process's in-flight crawl before doing it ourselves. */
export const CACHE_WAIT_MS = envNum("WEB_FETCH_CACHE_WAIT_MS", 45_000);
/** A lock older than this is treated as abandoned (crashed or killed crawler). */
const STALE_LOCK_MS = envNum("WEB_FETCH_CACHE_STALE_MS", 120_000);
/** Poll interval while waiting on another process. */
const POLL_MS = 150;

export interface CacheEntry {
	/** Canonical URL this entry answers for (diagnostics only). */
	url: string;
	fetchedAt: number;
	/** Char cap the text was crawled with, so callers know how much they got. */
	max: number;
	text: string;
}

/** Cache key: canonical URL (fragments/www/tracking params collapsed) plus the
 *  raw-vs-markdown variant, so the two never answer for each other. */
export function cacheKey(url: string, raw: boolean): string {
	return createHash("sha1").update(`${raw ? "raw" : "md"}\u0000${canonicalKey(url)}`).digest("hex").slice(0, 32);
}

/**
 * Whether a cached page can answer a call that wants up to `max` characters.
 * True when the entry was crawled with at least as much text as we need, or
 * when the page itself was shorter than the cap it was crawled with — then the
 * cached text is the whole page no matter which cap asked for it. A page that
 * was cut off at a smaller cap is a miss, so the caller re-crawls for full text.
 */
export function entryUsableFor(entry: CacheEntry, max: number): boolean {
	return entry.text.length < entry.max || entry.max >= max;
}

function entryPath(key: string): string {
	return join(CACHE_DIR, `${key}.json`);
}

function lockPath(key: string): string {
	return join(CACHE_DIR, `${key}.lock`);
}

function ensureDir(): void {
	try {
		mkdirSync(CACHE_DIR, { recursive: true });
	} catch {
		/* another process won the race — fine */
	}
}

/** Fresh cached page text for `key`, or null when absent/expired/unreadable. */
export function readCachedPage(key: string): CacheEntry | null {
	if (CACHE_TTL_MS <= 0) return null;
	try {
		const raw = readFileSync(entryPath(key), "utf-8");
		const entry = JSON.parse(raw) as CacheEntry;
		if (!entry || typeof entry.text !== "string" || typeof entry.fetchedAt !== "number") return null;
		if (Date.now() - entry.fetchedAt >= CACHE_TTL_MS) return null;
		return entry;
	} catch {
		return null; // missing / half-written / corrupt → crawl it
	}
}

/** Store a successful crawl. Written to a temp file + renamed so a concurrent
 *  reader never sees a torn entry (same pattern as model-cache.ts). */
export function writeCachedPage(key: string, entry: CacheEntry): void {
	if (CACHE_TTL_MS <= 0) return;
	ensureDir();
	const target = entryPath(key);
	const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
	try {
		writeFileSync(tmp, JSON.stringify(entry));
		renameSync(tmp, target);
	} catch {
		try { unlinkSync(tmp); } catch { /* nothing to clean */ }
	}
}

/** A lock whose file is missing or older than STALE_LOCK_MS is abandoned. */
function lockIsStale(key: string): boolean {
	try {
		return Date.now() - statSync(lockPath(key)).mtimeMs > STALE_LOCK_MS;
	} catch {
		return true; // no lock file at all
	}
}

/** Try to become the crawler for `key` (atomic create-exclusive). */
function tryAcquireLock(key: string): boolean {
	ensureDir();
	try {
		const fd = openSync(lockPath(key), "wx");
		try {
			writeFileSync(fd, `${process.pid}:${Date.now()}`);
		} finally {
			closeSync(fd);
		}
		return true;
	} catch {
		return false;
	}
}

function releaseLock(key: string): void {
	try { unlinkSync(lockPath(key)); } catch { /* already gone */ }
}

/** Per-tool-call dedupe state: which keys we crawl, which we wait on, and the
 *  locks we must release when the call ends for any reason. */
export interface FetchDedupe {
	/** "mine" → crawl it (lock held); "other" → someone else is on it. */
	claim(key: string): "mine" | "other";
	/** Wait for the other process's crawl. Returns the entry it produced, or
	 *  null when we should crawl the page ourselves (holder died/too slow). */
	settle(key: string, signal?: AbortSignal): Promise<CacheEntry | null>;
	/** Cache a successful crawl and release the lock. */
	store(key: string, entry: CacheEntry): void;
	/** Give up a lock we hold without publishing anything (failure/abort). */
	release(key: string): void;
	/** Release every lock we still hold (abort/error paths). */
	releaseAll(): void;
}

export function createFetchDedupe(): FetchDedupe {
	const held = new Set<string>();

	const claim = (key: string): "mine" | "other" => {
		if (CACHE_TTL_MS <= 0) return "mine"; // caching disabled → no coordination
		if (tryAcquireLock(key)) {
			held.add(key);
			return "mine";
		}
		// The holder may have died with its lock still on disk.
		if (lockIsStale(key)) {
			releaseLock(key);
			if (tryAcquireLock(key)) {
				held.add(key);
				return "mine";
			}
		}
		return "other";
	};

	const store = (key: string, entry: CacheEntry): void => {
		writeCachedPage(key, entry);
		if (held.delete(key)) releaseLock(key);
	};

	const settle = async (key: string, signal?: AbortSignal): Promise<CacheEntry | null> => {
		const deadline = Date.now() + CACHE_WAIT_MS;
		while (Date.now() < deadline) {
			if (signal?.aborted) return null;
			const hit = readCachedPage(key);
			if (hit) return hit;
			if (lockIsStale(key)) return null; // holder died → crawl it ourselves
			await new Promise((r) => setTimeout(r, POLL_MS));
		}
		return readCachedPage(key);
	};

	// Only ever removes locks we created — a lock owned by another process is
	// never touched here (it may still be mid-crawl).
	const release = (key: string): void => {
		if (held.delete(key)) releaseLock(key);
	};

	const releaseAll = (): void => {
		for (const key of held) releaseLock(key);
		held.clear();
	};

	return { claim, settle, store, release, releaseAll };
}
