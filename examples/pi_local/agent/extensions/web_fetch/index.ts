import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";
import {
	MAX_RAW_CHARS,
	MAX_RESULT_CHARS,
	MAX_SEARCH_TOTAL_CHARS,
	runBatch,
	shutdownRunner,
	type Job,
	type JobResult,
	type Update,
} from "./runner";
import { SEARCH_ENGINES, selectSources, toKeywords, type SerpRecord } from "./search";
import { cacheKey, createFetchDedupe, entryUsableFor, readCachedPage, type CacheEntry } from "./cache";

// Floor for the per-source markdown cap when the search budget is split wide.
const MIN_SOURCE_CHARS = 4_000;
const MAX_RESULTS_CAP = 10;

function errRes(text: string) {
	return { content: [{ type: "text" as const, text }], details: { error: text } };
}

/** Normalize a URL and require http(s); returns null when invalid. */
function validHttpUrl(u: string): string | null {
	try {
		const p = new URL(u);
		return p.protocol === "http:" || p.protocol === "https:" ? p.href : null;
	} catch {
		return null;
	}
}

/** One query's search outcome, kept small: what we asked, where it came from,
 *  what we picked, and why it failed when it did. */
interface QueryOutcome {
	query: string;
	keywords: string;
	engine: string | null; // engine that answered
	blocked: string[]; // engines that served a bot check
	error: string | null; // last engine-level failure
	sources: SerpRecord[];
}

export default function (pi: ExtensionAPI) {
	pi.on("session_shutdown", async () => {
		shutdownRunner();
	});

	pi.registerTool({
		name: "web-fetch",
		label: "Web Fetch",
		description:
			"Fetch web pages as Markdown via a persistent headless browser (one shared session across calls), or search with 'query'/'queries'. " +
			"Search extracts your keywords, queries DuckDuckGo, and fetches the top 'maxResults' results (ad slots and duplicate URLs dropped, titles/snippets/sources returned). " +
			"Pass 'urls' (array) and/or 'queries' (array) to batch many fetches/searches in ONE tool call — everything is crawled in parallel in the same browser session. Singular 'url'/'query' still work. " +
			"Pages are cached per project: a URL another agent already fetched is reused instead of crawled again, so parallel agents asking for the same page only pay for it once.",
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "A single URL to fetch (omit if using query/queries)", default: "" })),
			urls: Type.Optional(Type.Array(Type.String({ description: "Multiple URLs to fetch in one batch (parallel, shared session)", default: [] }))),
			raw: Type.Optional(Type.Boolean({ description: "Return raw HTML instead of markdown (default false)", default: false })),
			query: Type.Optional(Type.String({ description: "A search query; its keywords are searched and the top results fetched (omit if using url/urls)", default: "" })),
			queries: Type.Optional(Type.Array(Type.String({ description: "Multiple search queries, each searched and fetched, all in one batch", default: [] }))),
			maxResults: Type.Optional(Type.Number({ description: "How many search results to fetch per query (1-10, default 5)", default: 5 })),
		}),

		async execute(_toolCallId: unknown, params: { url?: string; urls?: string[]; raw?: boolean; query?: string; queries?: string[]; maxResults?: number }, signal?: AbortSignal, onUpdate?: (u: Update) => void) {
			const raw = params.raw ?? false;
			const maxResults = Math.min(Math.max(Math.trunc(params.maxResults ?? 5), 1), MAX_RESULTS_CAP);

			// Collect + dedupe queries and direct URLs (plural + singular forms).
			const queryInputs = [...(params.query ? [params.query] : []), ...(params.queries ?? [])]
				.map((q) => q.replace(/\s+/g, " ").trim()).filter((q) => q.length > 0);
			const seenQ = new Set<string>();
			const queries = queryInputs.filter((q) => { const k = q.toLowerCase(); if (seenQ.has(k)) return false; seenQ.add(k); return true; });

			const urlInputs = [...(params.url ? [params.url] : []), ...(params.urls ?? [])]
				.map((u) => u.trim()).filter((u) => u.length > 0);
			const seenU = new Set<string>();
			const urls: string[] = [];
			const badUrls: string[] = [];
			for (const u of urlInputs) {
				const norm = validHttpUrl(u);
				if (!norm) { badUrls.push(u); continue; }
				if (seenU.has(norm)) continue;
				seenU.add(norm);
				urls.push(norm);
			}

			if (queries.length === 0 && urlInputs.length === 0) {
				return errRes("Error: provide 'url', 'urls', 'query', or 'queries'.");
			}
			// Checked before "nothing to do": an all-invalid input list must say
			// WHY it was rejected, not that nothing was provided.
			if (badUrls.length > 0) {
				return errRes(`Error: invalid URL(s): ${badUrls.join(", ")} (must be valid http(s) URLs).`);
			}

			const details: Record<string, any> = { urlsFetched: 0, urlsFailed: 0 };
			if (queries.length) details.queries = queries;
			if (urls.length) details.urls = urls;

			type Target = { key: number; url: string; raw: boolean; light: boolean; max: number; extract?: "serp" };
			const targets: Target[] = [];
			const results = new Map<number, JobResult>();
			const keyUrl = new Map<number, string>();
			const byUrl = new Map<string, number>();
			let seq = 0;

			// Register a target for fetching, deduped by URL — the same page found
			// by two queries, or a search hit that is also a direct URL, is crawled
			// exactly once.
			const reg = (u: string, opts: { raw: boolean; light: boolean; max: number; extract?: "serp" }): number => {
				const existing = byUrl.get(u);
				if (existing !== undefined) return existing;
				const k = seq++;
				byUrl.set(u, k);
				keyUrl.set(k, u);
				targets.push({ key: k, url: u, ...opts });
				return k;
			};

			// ── Cross-agent dedupe ──────────────────────────────────────────────
			// Parallel dispatch runs every subagent in its OWN pi process, so an
			// in-memory map cannot stop two agents crawling the same URL. This
			// coordinates through .pi/web-fetch-cache: the first agent to reach a
			// URL crawls it and publishes the page; the others wait for that page
			// instead of launching a second (expensive) browser session for it.
			const dedupe = createFetchDedupe();
			const fromCache = new Set<number>(); // targets answered without a crawl
			// SERP pages are query-specific and volatile — only real pages are reused.
			const cacheable = (t: Target) => t.extract !== "serp" && !t.light;
			const usableFor = entryUsableFor;
			const cachedResult = (entry: CacheEntry): JobResult => ({ ok: true, text: entry.text, error: "" });

			// Crawl every not-yet-fetched target as ONE batch on the warm runner
			// (single Chromium, parallel tabs, shared session).
			const fetchMissing = async () => {
				const need = targets.filter((t) => !results.has(t.key));
				if (need.length === 0) return;
				const toCrawl: Target[] = [];
				const claimed = new Map<number, string>(); // target key -> cache key we own
				const mine = new Set<string>(); // cache keys this call is crawling
				const waiting: Array<Promise<{ t: Target; entry: CacheEntry | null }>> = [];

				for (const t of need) {
					if (!cacheable(t)) { toCrawl.push(t); continue; }
					const ck = cacheKey(t.url, t.raw);
					const hit = readCachedPage(ck);
					if (hit && usableFor(hit, t.max)) {
						results.set(t.key, cachedResult(hit));
						fromCache.add(t.key);
						continue;
					}
					// Two link forms of one page land on the same key; never wait on the
					// lock this same call is holding.
					if (mine.has(ck)) { toCrawl.push(t); continue; }
					if (dedupe.claim(ck) === "mine") { mine.add(ck); claimed.set(t.key, ck); toCrawl.push(t); continue; }
					// Another agent is crawling this URL right now — wait for its page.
					waiting.push(dedupe.settle(ck, signal).then((entry) => ({ t, entry })));
				}
				for (const { t, entry } of await Promise.all(waiting)) {
					if (entry && usableFor(entry, t.max)) {
						results.set(t.key, cachedResult(entry));
						fromCache.add(t.key);
					} else {
						// Holder died, overran the wait budget, or has less text than we
						// need — crawl it ourselves rather than report a stub page. Take
						// the lock if it is free so our page gets published; if a live
						// holder still owns it, crawl without publishing so we never
						// clobber the page it is about to store.
						const ck = cacheKey(t.url, t.raw);
						if (!mine.has(ck) && dedupe.claim(ck) === "mine") { mine.add(ck); claimed.set(t.key, ck); }
						toCrawl.push(t);
					}
				}
				if (toCrawl.length === 0) return;

				const jobs: Job[] = toCrawl.map((t) => ({ key: t.key, url: t.url, raw: t.raw, light: t.light, max: t.max, extract: t.extract }));
				try {
					const got = await runBatch(jobs, signal, onUpdate);
					for (const t of toCrawl) {
						const r = got.get(t.key);
						const ck = claimed.get(t.key);
						if (r && (r.ok || r.text || r.results)) {
							results.set(t.key, r);
							// Publish the page so agents waiting on this URL can reuse it.
							if (ck && r.ok && r.text) dedupe.store(ck, { url: t.url, fetchedAt: Date.now(), max: t.max, text: r.text });
							else if (ck) dedupe.release(ck);
						} else {
							results.set(t.key, { ok: false, text: "", error: r?.error ?? "no result from crawler", blocked: r?.blocked, status: r?.status });
							if (ck) dedupe.release(ck); // nothing to share — let peers through
						}
					}
				} catch (e) {
					// Batch-level failure (timeout/abort/crash): release the locks so
					// peers don't wait on us, record the reason on every pending
					// target so sections can show it, then rethrow.
					for (const ck of claimed.values()) dedupe.release(ck);
					const msg = e instanceof Error ? e.message : "batch failed";
					for (const t of toCrawl) results.set(t.key, { ok: false, text: "", error: msg });
					throw e;
				}
			};

			urls.forEach((u) => reg(u, { raw, light: false, max: raw ? MAX_RAW_CHARS : MAX_RESULT_CHARS }));

			// ── 1. Search: keywords -> engine -> top results (engine fallback) ──
			const outcomes: QueryOutcome[] = queries.map((q) => ({
				query: q, keywords: toKeywords(q), engine: null, blocked: [], error: null, sources: [],
			}));
			const serpKey = (qi: number, engineIdx: number): number =>
				reg(SEARCH_ENGINES[engineIdx].searchUrl(outcomes[qi].keywords), { raw: false, light: true, max: 0, extract: "serp" });

			// Read one engine's SERP into the query outcome: hits, or the reason it
			// has none (bot check vs plain "no results" drives the next engine).
			const collectSerp = (qi: number, engineIdx: number, records: SerpRecord[]): void => {
				const o = outcomes[qi];
				const r = results.get(serpKey(qi, engineIdx));
				const got = r?.results ?? [];
				if (got.length > 0) {
					o.engine = SEARCH_ENGINES[engineIdx].label;
					records.push(...got);
					return;
				}
				if (r?.blocked) o.blocked.push(SEARCH_ENGINES[engineIdx].label);
				else if (!r || r.error) o.error = `${SEARCH_ENGINES[engineIdx].label}: ${r?.error ?? "no result from crawler"}`;
			};

			// One engine at a time, only for the queries still without results.
			const hits: SerpRecord[][] = queries.map(() => []);
			const pending = () => queries.map((_, qi) => hits[qi].length === 0);
			for (let engineIdx = 0; engineIdx < SEARCH_ENGINES.length; engineIdx++) {
				const todo = pending();
				if (!todo.some(Boolean)) break;
				if (engineIdx === 0 && queries.length) {
					onUpdate?.({
						content: [{ type: "text", text: `Searching ${SEARCH_ENGINES[0].label}: ${outcomes.map((o) => o.keywords).join(" | ")}` }],
						details: { queries, phase: "search" },
					});
				}
				for (let qi = 0; qi < queries.length; qi++) if (todo[qi]) serpKey(qi, engineIdx);
				try {
					await fetchMissing();
				} catch { /* recorded per query below; search is best-effort */ }
				for (let qi = 0; qi < queries.length; qi++) if (todo[qi]) collectSerp(qi, engineIdx, hits[qi]);
			}

			// ── 2. Pick the sources to fetch: top N per query ──
			for (let qi = 0; qi < queries.length; qi++) outcomes[qi].sources = selectSources(hits[qi], maxResults);

			if (urls.length === 0 && outcomes.length > 0 && outcomes.every((o) => o.sources.length === 0)) {
				const why = outcomes
					.map((o) => {
						const bits = [...(o.blocked.length ? [`bot check from ${o.blocked.join(", ")}`] : []), ...(o.error ? [o.error] : [])];
						return `"${o.query}" — ${bits.join("; ") || "no results"}`;
					})
					.join("\n");
				return errRes(`No search results.\n${why}\nTry different keywords, or pass 'url'/'urls' directly.`);
			}

			// One markdown budget is shared across all search-derived pages, so a
			// 5-result search can't dump 5 x MAX_RESULT_CHARS into the context.
			const selected = new Set<string>();
			for (const o of outcomes) for (const s of o.sources) selected.add(s.url);
			const sourceMax = Math.min(MAX_RESULT_CHARS, Math.max(MIN_SOURCE_CHARS, Math.floor(MAX_SEARCH_TOTAL_CHARS / Math.max(1, selected.size))));
			for (const o of outcomes) for (const s of o.sources) reg(s.url, { raw, light: false, max: sourceMax });

			if (selected.size > 0) {
				onUpdate?.({
					content: [{ type: "text", text: `Fetching ${selected.size} result page(s)${urls.length ? ` + ${urls.length} direct URL(s)` : ""}` }],
					details: { phase: "fetch", urls: [...selected, ...urls] },
				});
			}
			// ── 3. Fetch the selected pages (plus any direct URLs) ──
			try {
				await fetchMissing();
			} catch (e) {
				if (queries.length === 0) {
					return errRes(`Error fetching ${urls.join(", ")}: ${e instanceof Error ? e.message : "batch failed"}`);
				}
			}

			// ── 4. Report ──
			const sections: string[] = [];
			const counted = new Set<number>();
			const count = (k: number, ok: boolean) => {
				if (counted.has(k)) return;
				counted.add(k);
				if (ok) details.urlsFetched++; else details.urlsFailed++;
			};
			const searchDetails: Array<Record<string, any>> = [];
			// One page can be the top result for two queries. It is fetched once and
			// its text rendered once; later sections point at it instead of dumping
			// the same 30k characters into the context again.
			const rendered = new Map<number, { query: string; n: number }>();

			for (const o of outcomes) {
				const body: string[] = [];
				if (o.sources.length === 0) {
					body.push(`_No results. ${[...(o.blocked.length ? [`bot check from ${o.blocked.join(", ")}`] : []), ...(o.error ? [o.error] : [])].join("; ") || "the engine returned nothing"}._`);
					searchDetails.push({ query: o.query, keywords: o.keywords, error: o.blocked.length ? "blocked" : "no results" });
					sections.push(`# Search: ${o.query}\n\n${body.join("\n")}`);
					continue;
				}
				body.push(`_Keywords: ${o.keywords} — ${o.sources.length} result(s) from ${o.engine}._`);
				if (o.blocked.length) body.push(`_Note: ${o.blocked.join(", ")} served a bot check._`);
				let n = 0;
				for (const s of o.sources) {
					const k = byUrl.get(s.url)!;
					const r = results.get(k);
					body.push(`\n## Result ${++n}: ${s.title || s.url}\n\n${s.url}${s.snippet ? `\n\n> ${s.snippet}` : ""}`);
					const prev = rendered.get(k);
					if (prev) {
						body.push(`\n_Already fetched above for "${prev.query}" (result ${prev.n}) — not repeated here._`);
						continue;
					}
					if (r && r.ok && r.text) {
						if (fromCache.has(k)) body.push(`\n_Not re-crawled: served from the shared web-fetch cache (another agent already fetched this page)._`);
						body.push(`\n${r.text}`);
						count(k, true);
						rendered.set(k, { query: o.query, n });
					} else {
						body.push(`\n_Fetch failed: ${r?.error || "unknown error"}_`);
						count(k, false);
					}
				}
				searchDetails.push({
					query: o.query, keywords: o.keywords, engine: o.engine,
					results: o.sources.map((s) => ({ url: s.url, title: s.title })),
				});
				sections.push(`# Search: ${o.query}\n\n${body.join("\n")}`);
			}

			for (const u of urls) {
				const r = results.get(byUrl.get(u)!);
				const body: string[] = [];
				if (r && r.ok && r.text) {
					if (fromCache.has(byUrl.get(u)!)) body.push(`_Not re-crawled: served from the shared web-fetch cache (another agent already fetched this page)._\n`);
					body.push(r.text);
					count(byUrl.get(u)!, true);
				} else {
					body.push(`_Fetch failed: ${r?.error || "unknown error"}_`);
					count(byUrl.get(u)!, false);
				}
				sections.push(`# Fetch: ${u}\n\n${body.join("\n")}`);
			}

			if (sections.length === 0) {
				return errRes(`Error: nothing to fetch (${badUrls.length ? `invalid URLs: ${badUrls.join(", ")}` : "no usable inputs"}).`);
			}
			if (searchDetails.length) details.search = searchDetails;
			if (fromCache.size) details.cacheHits = fromCache.size;
			return { content: [{ type: "text", text: sections.join("\n\n---\n\n") }], details };
		},
	});
}
