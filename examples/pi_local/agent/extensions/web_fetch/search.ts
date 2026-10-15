// Search helpers for the `web-fetch` tool: the search engines, keyword
// extraction, URL identity, and source selection. Pure module (no imports) so
// it stays trivially testable.
//
// The flow it supports: keywords in → search engine → top N sources out.

export type EngineId = "duckduckgo" | "duckduckgo-lite";

export interface SearchEngine {
	id: EngineId;
	label: string;
	searchUrl: (query: string) => string;
}

// One index, two endpoints: DuckDuckGo's HTML endpoint is the primary, and the
// lighter /lite/ endpoint serves the same results when the HTML one bot-checks
// us. Kept in fallback order.
export const SEARCH_ENGINES: SearchEngine[] = [
	{
		id: "duckduckgo",
		label: "DuckDuckGo",
		searchUrl: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
	},
	{
		id: "duckduckgo-lite",
		label: "DuckDuckGo Lite",
		searchUrl: (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`,
	},
];

export interface SerpRecord {
	url: string;
	title: string;
	snippet: string;
	ad?: boolean;
}

// Filler words that add nothing to a search query. Terms the user marked as
// meaningful (quoted phrases, `site:`, `-exclusions`) are never touched.
const STOPWORDS = new Set([
	"a", "an", "the", "of", "for", "to", "in", "on", "at", "and", "or", "is", "are", "was", "were",
	"be", "been", "by", "with", "how", "what", "why", "does", "do", "did", "my", "me", "i", "you",
	"it", "its", "that", "this", "from", "as", "if", "then", "than", "can", "could", "should", "would",
	"please", "tell", "give", "about", "into", "when", "where", "which", "there", "their", "use", "using",
]);

/** Search keywords for a user query: filler words dropped, operators kept.
 *  A query containing quotes/operators is passed through untouched — rewriting
 *  a query the caller crafted precisely is how you get irrelevant results. */
export function toKeywords(query: string): string {
	const normalized = query.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
	if (!normalized) return "";
	if (/["']|(^|\s)(site|filetype|inurl|intitle|related):|-/.test(normalized)) return normalized;
	const words = normalized.split(" ").filter((w) => !STOPWORDS.has(w.toLowerCase()));
	// Never search for nothing: fall back to the original query.
	return words.length ? words.join(" ") : normalized;
}

// Campaign/analytics parameters that create duplicate URLs for one resource.
const TRACKING_PARAMS = new Set([
	"gclid", "fbclid", "msclkid", "yclid", "twclid", "ttclid", "igshid", "mc_cid", "mc_eid",
	"ref", "ref_src", "ref_url", "spm", "scm", "si", "source", "feature", "_hsenc", "_hsmi",
	"cmpid", "campaign_id", "s_kwcid", "li_fat_id",
]);

function isTrackingParam(name: string): boolean {
	const n = name.toLowerCase();
	return n.startsWith("utm_") || TRACKING_PARAMS.has(n);
}

/**
 * Dedupe identity for a URL: fragments, `www.`, trailing slashes and tracking
 * params are cosmetic; the query string is not. Never throws — unparseable
 * input still collides with itself.
 */
export function canonicalKey(url: string): string {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return url.trim().toLowerCase();
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") return url.trim().toLowerCase();
	const host = u.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
	const path = u.pathname.replace(/\/+$/, "");
	const params: Array<[string, string]> = [];
	for (const [k, v] of u.searchParams) if (!isTrackingParam(k)) params.push([k, v]);
	params.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
	const query = params.map(([k, v]) => (v ? `${k}=${v}` : k)).join("&");
	return query ? `${host}${path}?${query}` : `${host}${path}`;
}

/** The URL to fetch and show: the engine's href minus campaign/analytics noise. */
function cleanUrl(url: string): string {
	try {
		const u = new URL(url);
		const drop: string[] = [];
		for (const k of u.searchParams.keys()) if (isTrackingParam(k)) drop.push(k);
		for (const k of drop) u.searchParams.delete(k);
		return u.href;
	} catch {
		return url;
	}
}

/**
 * Top sources from a SERP: ads dropped, duplicates (across engines and inside
 * one) collapsed, engine order preserved. Search-engine ranking is already
 * relevance ranking — re-scoring it here only makes results less predictable.
 */
export function selectSources(records: SerpRecord[], limit: number): SerpRecord[] {
	if (limit <= 0) return [];
	const out: SerpRecord[] = [];
	const seen = new Set<string>();
	for (const rec of records) {
		if (rec.ad) continue;
		let u: URL;
		try {
			u = new URL(rec.url);
		} catch {
			continue;
		}
		if (u.protocol !== "http:" && u.protocol !== "https:") continue;
		const key = canonicalKey(rec.url);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ url: cleanUrl(u.href), title: rec.title, snippet: rec.snippet });
		if (out.length >= limit) break;
	}
	return out;
}
