/**
 * server.ts — Node HTTP + SSE + SQLite scope server.
 *
 * Single-file server. Hand-rolled routing. Uses node:sqlite via db.ts.
 * Serves static UI from apps/scope/public/.
 */

import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import * as http from "node:http";
import { Readable } from "node:stream";
import { createDb, prepare, toRow, toSessionRow, rowToSession, rowToEvent } from "./db.ts";
import { MAX_REQUEST_BYTES } from "../../shared/types.ts";
import type { ObsEvent } from "../../shared/types.ts";
import { attachTerminal } from "./terminal.ts";
import { execFileSync } from "node:child_process";

// ─── Config ─────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.SCOPE_PORT ?? "43190", 10);
const HOST = process.env.SCOPE_HOST ?? "127.0.0.1";
// Resolve database path: if SCOPE_DB_PATH env is set, use it as is.
// Otherwise, default to the "db/scope.db" directory relative to the project root.
const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");
const DEFAULT_DB_PATH = path.join(PROJECT_ROOT, "db", "scope.db");
const DB_PATH = process.env.SCOPE_DB_PATH ?? DEFAULT_DB_PATH;

// Ensure parent folder exists (e.g. "db/" directory) before initializing SQLite
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const DEFAULT_AUTH_TOKEN = "dev_token";
const AUTH_TOKEN = process.env.SCOPE_AUTH_TOKEN ?? DEFAULT_AUTH_TOKEN;
const VERSION = "0.1.0";
const MAX_SSE_SUBSCRIBERS = 256;
// Browser-openable UI URL with the token baked in. The UI's API + SSE calls are
// auth-walled, so opening the bare host:port (no ?token=) yields a blank UI.
// Print this so copy/paste straight from the boot banner just works.
const OPEN_URL = `http://${HOST}:${PORT}/?token=${encodeURIComponent(AUTH_TOKEN)}`;

// Restrict CORS to loopback origins that match this server. Prevents a remote
// site from reading responses cross-origin (CSRF / data exfiltration).
const ALLOWED_ORIGINS = new Set([
  `http://${HOST}:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
]);
function corsOrigin(req: Request): string {
  const o = req.headers.get("origin");
  return o && ALLOWED_ORIGINS.has(o) ? o : `http://127.0.0.1:${PORT}`;
}

// Persist the effective token to a local, owner-only file so other local
// components (launcher UI, pi extension) can discover the per-run token
// instead of relying on a hardcoded constant like "devtoken".
const TOKEN_FILE = process.env.SCOPE_TOKEN_FILE ?? path.join(PROJECT_ROOT, "tmp", "scope_token");
try {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, AUTH_TOKEN, { mode: 0o600 });
} catch {}

// ─── Init ───────────────────────────────────────────────────────────────────

// Restrict the on-disk DB (and its WAL/shm sidecars) to the owner only, so
// plaintext system prompts / messages at rest aren't world-readable.
function secureDbFile(p: string): void {
  for (const f of [p, p + "-wal", p + "-shm"]) {
    try { if (fs.existsSync(f)) fs.chmodSync(f, 0o600); } catch {}
  }
}
const db = createDb(DB_PATH);
secureDbFile(DB_PATH);
const q = prepare(db);
const startTime = Date.now();

const tokenMasked = AUTH_TOKEN.length > 8 ? `${AUTH_TOKEN.slice(0,4)}…${AUTH_TOKEN.slice(-4)}` : "****";
console.log(`\n  pi-scope server v${VERSION}`);
if (process.env.SCOPE_VERBOSE) {
  console.log(`  UI:    ${OPEN_URL}`);
  console.log(`  Token: ${AUTH_TOKEN}`);
} else {
  console.log(`  UI:    http://${HOST}:${PORT}/?token=<hidden — set SCOPE_VERBOSE=1 to print>`);
  console.log(`  Token: ${tokenMasked}`);
}
console.log(`  DB:    ${DB_PATH}\n`);

// ─── SSE subscriber registry ────────────────────────────────────────────────

interface SSESubscriber {
  id: number;
  controller: ReadableStreamDefaultController<Uint8Array>;
  pool?: string;
  tag?: string;
  session_id?: string;
}

let nextSubId = 1;
const subscribers = new Map<number, SSESubscriber>();

function addSubscriber(
  controller: ReadableStreamDefaultController<Uint8Array>,
  pool?: string,
  tag?: string,
  session_id?: string,
): number {
  const id = nextSubId++;
  subscribers.set(id, { id, controller, pool, tag, session_id });
  return id;
}

function removeSubscriber(id: number) {
  subscribers.delete(id);
}

/** Push an SSE-formatted event to one subscriber. Returns false if closed. */
function pushSSE(sub: SSESubscriber, data: string): boolean {
  try {
    if (sub.controller.desiredSize !== null && sub.controller.desiredSize < 0) {
      removeSubscriber(sub.id);
      return false;
    }
    sub.controller.enqueue(new TextEncoder().encode(data));
    return true;
  } catch {
    removeSubscriber(sub.id);
    return false;
  }
}

/** Broadcast an event to all SSE subscribers matching the event's pool/tags/session. */
function broadcastEvent(event: ObsEvent) {
  const payload = JSON.stringify(event);
  const frame = `event: event\ndata: ${payload}\n\n`;
  for (const sub of subscribers.values()) {
    if (sub.pool && sub.pool !== event.pool) continue;
    if (sub.tag && (!event.tags || !event.tags.includes(sub.tag))) continue;
    if (sub.session_id && sub.session_id !== event.session_id) continue;
    pushSSE(sub, frame);
  }
}

// Heartbeat every 15s
setInterval(() => {
  if (subscribers.size === 0) return;
  const ping = ": ping\n\n";
  for (const sub of subscribers.values()) {
    pushSSE(sub, ping);
  }
}, 15_000);

// ─── Helpers ────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}

function textResponse(body: string, status: number, contentType: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": contentType, "access-control-allow-origin": "*" },
  });
}

function checkAuth(req: Request): boolean {
  // Check Authorization header
  const auth = req.headers.get("authorization");
  if (auth) {
    const parts = auth.split(" ");
    if (parts.length === 2 && parts[0].toLowerCase() === "bearer" && parts[1] === AUTH_TOKEN) {
      return true;
    }
    return false;
  }
  // Check ?token= query param
  const url = new URL(req.url);
  const qToken = url.searchParams.get("token");
  if (qToken && qToken === AUTH_TOKEN) return true;

  return false;
}

/**
 * Ingest a single event: insert into DB, upsert session, broadcast to SSE.
 * Returns the event_id if ingested, null if duplicate.
 */
function ingestEvent(event: ObsEvent): string | null {
  const row = toRow(event);
  const result = q.insertEvent.run(row);
  const isNew = result.changes > 0;

  if (isNew) {
    q.upsertSession.run(toSessionRow(event));
  } else {
    q.upsertSessionNoBump.run(toSessionRow(event));
  }

  if (isNew) {
    broadcastEvent(event);
  }

  return isNew ? event.event_id : null;
}

// ─── Request body reader with size cap ─────────────────────────────────────

async function readBody(req: Request): Promise<string> {
  const len = parseInt(req.headers.get("content-length") ?? "0", 10);
  if (len > MAX_REQUEST_BYTES) {
    throw new Error("Payload too large");
  }
  return await req.text();
}

// ─── MIME types for static files ────────────────────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
};

function serveStatic(pathname: string): Response | null {
  // Remove leading slash and strip path-traversal segments (defense in depth).
  const safe = pathname.replace(/^\/+/, "").replace(/\.\./g, "");
  const publicRoot = path.resolve(import.meta.dirname, "public");
  const filePath = path.resolve(publicRoot, safe);
  // Refuse anything that escapes the public root.
  if (filePath !== publicRoot && !filePath.startsWith(publicRoot + path.sep)) return null;
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  const data = fs.readFileSync(filePath);
  const mimeKey = safe.slice(safe.lastIndexOf(".")) || ".html";
  return new Response(data, {
    headers: { "content-type": MIME[mimeKey] ?? "application/octet-stream" },
  });
}

// ─── File diff helpers (git working-tree vs HEAD) ──────────────────────

/** Resolve `file` against `cwd`, refusing anything that escapes `cwd`. */
function resolveWithinCwd(cwd: string, file: string): string | null {
  const absCwd = path.resolve(cwd);
  const absFile = path.resolve(absCwd, file);
  const rel = path.relative(absCwd, absFile);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return absFile;
}

/**
 * Validate `cwd`: must exist as a real directory (symlinks resolved). When
 * SCOPE_FILE_ROOT is set (comma-separated allowlist), the cwd must lie within
 * one of those roots. Returns the resolved absolute path, or null if invalid
 * or disallowed. This stops the /files/* and /checkpoints/* endpoints from
 * trusting an arbitrary caller-supplied absolute path.
 */
function validateCwd(cwd: string): string | null {
  if (!cwd) return null;
  let abs: string;
  try {
    abs = fs.realpathSync(path.resolve(cwd));
  } catch {
    return null;
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return null;
  }
  if (!st.isDirectory()) return null;
  const roots = (process.env.SCOPE_FILE_ROOT ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean)
    .map((s) => { try { return fs.realpathSync(path.resolve(s)); } catch { return null; } })
    .filter((s): s is string => s !== null);
  if (roots.length) {
    const ok = roots.some((r) => abs === r || abs.startsWith(r + path.sep));
    if (!ok) return null;
  }
  return abs;
}

/** Run a git command in `cwd`; returns stdout string, throws on failure. */
function git(cwd: string, args: string[]): string {
  const out = execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return typeof out === "string" ? out : out.toString();
}

// ─── Routing helpers ────────────────────────────────────────────────────────

/** Match /sessions/<session_id>/events */
function matchSessionEvents(pathname: string): string | null {
  const m = pathname.match(/^\/sessions\/([^/]+)\/events$/);
  return m ? m[1] : null;
}

/** Match /sessions/<session_id>/stats */
function matchSessionStats(pathname: string): string | null {
  const m = pathname.match(/^\/sessions\/([^/]+)\/stats$/);
  return m ? m[1] : null;
}

// ─── Main handler ───────────────────────────────────────────────────────────

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method.toUpperCase();

  // OPTIONS — CORS preflight
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "Authorization, Content-Type",
      },
    });
  }

  // ── Unauthenticated routes ─────────────────────────────────────────────
  if (pathname === "/health") {
    if (method !== "GET") return jsonResponse({ error: "method not allowed" }, 405);

    try {
      const totals = q.countTotals.get() as any;
      return jsonResponse({
        ok: true,
        version: VERSION,
        uptime_s: Math.round((Date.now() - startTime) / 1000),
        events_total: totals.events_total ?? 0,
        sessions_total: totals.sessions_total ?? 0,
      });
    } catch (err: any) {
      return jsonResponse({ ok: false, error: err.message }, 500);
    }
  }

  if (pathname === "/favicon.ico") {
    return new Response(null, { status: 204 });
  }

  if (pathname === "/" || pathname === "/index.html") {
    return serveStatic("index.html") ?? textResponse("not found", 404, "text/plain");
  }

  if (pathname.match(/\.(js|css|svg|png|ico|ttf|woff2?)$/)) {
    return serveStatic(pathname.replace(/^\//, "")) ?? textResponse("not found", 404, "text/plain");
  }

  // ── Auth wall ──────────────────────────────────────────────────────────
  // POST /events is the local producer path. The server only binds loopback
  // (HOST defaults to 127.0.0.1), so any sender is already a trusted local
  // process. Skipping the token check here removes the token-file race that
  // otherwise 401s every POST across server restarts / source-vs-packaged
  // builds. All reads (sessions, SSE, files, checkpoints) stay token-gated.
  const isLocalProducer = pathname === "/events" && method === "POST";
  if (!isLocalProducer && !checkAuth(req)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  // ── POST /events ───────────────────────────────────────────────────────
  if (pathname === "/events" && method === "POST") {
    let bodyText: string;
    try {
      bodyText = await readBody(req);
    } catch (err: any) {
      return jsonResponse({ error: err.message }, 413);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return jsonResponse({ error: "invalid JSON" }, 400);
    }

    const events: ObsEvent[] = Array.isArray(parsed) ? parsed : [parsed];
    const ingested: string[] = [];
    const rejected: string[] = [];

    for (const evt of events) {
      if (!evt || typeof evt !== "object" || !evt.event_id || !evt.type) {
        rejected.push(evt?.event_id ?? "unknown");
        continue;
      }
      // Normalize defaults
      evt.pool = evt.pool ?? "default";
      evt.tags = evt.tags ?? [];
      evt.seq = typeof evt.seq === "number" ? evt.seq : 0;
      evt.cwd = evt.cwd ?? "";

      const ingestedId = ingestEvent(evt as ObsEvent);
      if (ingestedId) {
        ingested.push(ingestedId);
      } else {
        rejected.push(evt.event_id);
      }
    }

    return jsonResponse({ ingested: ingested.length, rejected });
  }

  // ── GET /sessions ──────────────────────────────────────────────────────
  if (pathname === "/sessions" && method === "GET") {
    const pool = url.searchParams.get("pool") ?? "";
    const tag = url.searchParams.get("tag") ?? "";
    const since = url.searchParams.get("since") ?? "";
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);

    try {
      const rows = q.listSessions.all({ $pool: pool, $tag: tag, $limit: limit }) as any[];

      // Filter by `since` in application code (optional low-frequency filter)
      const sessions = rows
        .filter((r) => !since || r.last_ts >= since)
        .map(rowToSession);

      return jsonResponse({ sessions });
    } catch (err: any) {
      return jsonResponse({ error: err.message }, 500);
    }
  }

  // ── DELETE /sessions (clear all data — destructive) ────────────────────
  if (pathname === "/sessions" && method === "DELETE") {
    try {
      const before = q.countTotals.get() as any;
      q.clearEvents.run();
      q.clearSessions.run();
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      return jsonResponse({ ok: true, deleted: { sessions: before.sessions_total ?? 0, events: before.events_total ?? 0 } });
    } catch (err: any) {
      return jsonResponse({ error: err.message }, 500);
    }
  }

  // ── GET /sessions/:session_id/events ───────────────────────────────────
  const sidEvents = matchSessionEvents(pathname);
  if (sidEvents && method === "GET") {
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "200", 10), 1000);
    const beforeSeq = url.searchParams.get("before_seq");
    const sinceSeq = url.searchParams.get("since_seq");
    const type = url.searchParams.get("type") ?? "";

    try {
      if (sinceSeq !== null) {
        // Forward resync: seq > since_seq, ascending
        const rows = q.getSessionEventsSince.all({
          $session_id: sidEvents,
          $limit: limit,
          $since_seq: parseInt(sinceSeq, 10),
          $type: type,
        }) as any[];
        return jsonResponse({ events: rows.map(rowToEvent) });
      }

      const rows = q.getSessionEvents.all({
        $session_id: sidEvents,
        $limit: limit,
        $before_seq: beforeSeq ? parseInt(beforeSeq, 10) : null,
        $type: type,
      }) as any[];

      const events = rows.map(rowToEvent);
      // Return in ascending seq order for display
      events.reverse();
      return jsonResponse({ events });
    } catch (err: any) {
      return jsonResponse({ error: err.message }, 500);
    }
  }

  // ── GET /sessions/:session_id/stats ────────────────────────────────────
  const sidStats = matchSessionStats(pathname);
  if (sidStats && method === "GET") {
    try {
      const row = q.getSessionStats.get({ $session_id: sidStats }) as any;
      const ctx = q.getSessionContext.get({ $session_id: sidStats }) as any;
      return jsonResponse({
        total_tokens: row.total_tokens ?? 0,
        input_tokens: row.input_tokens ?? 0,
        output_tokens: row.output_tokens ?? 0,
        total_cost: row.total_cost ?? 0,
        error_count: row.error_count ?? 0,
        latest_input: ctx?.latest_input ?? null,
        latest_ts: ctx?.latest_ts ?? null,
      });
    } catch (err: any) {
      return jsonResponse({ error: err.message }, 500);
    }
  }

  // ── GET /events/stream (SSE) ──────────────────────────────────────────
  if (pathname === "/events/stream" && method === "GET") {
    if (subscribers.size >= MAX_SSE_SUBSCRIBERS) {
      return jsonResponse({ error: "too many SSE connections" }, 429);
    }
    const streamPool = url.searchParams.get("pool") ?? undefined;
    const streamTag = url.searchParams.get("tag") ?? undefined;
    const streamSession = url.searchParams.get("session_id") ?? undefined;

    let subId: number;

    const stream = new ReadableStream({
      start(controller) {
        subId = addSubscriber(controller, streamPool, streamTag, streamSession);

        // Initial hello
        const hello = JSON.stringify({ server: "pi-scope", version: VERSION });
        controller.enqueue(new TextEncoder().encode(`retry: 5000\nevent: hello\ndata: ${hello}\n\n`));
      },
      cancel() {
        removeSubscriber(subId!);
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "connection": "keep-alive",
        "access-control-allow-origin": "*",
      },
    });
  }

  // ── GET /files/modified (git status in a session's cwd) ──────────────
  if (pathname === "/files/modified" && method === "GET") {
    const cwd = url.searchParams.get("cwd") ?? "";
    if (!cwd) return jsonResponse({ error: "missing cwd" }, 400);
    const includeIgnored = url.searchParams.get("ignored") === "1";
    const absCwd = validateCwd(cwd);
    if (!absCwd) return jsonResponse({ error: "invalid or disallowed cwd" }, 400);
    try {
      const out = git(absCwd, ["status", "--porcelain", "-uall", ...(includeIgnored ? ["--ignored"] : [])]);
      const files: any[] = [];
      for (const raw of out.split("\n")) {
        if (!raw) continue;
        const code = raw.slice(0, 2);
        let p = raw.slice(3);
        let renamed_from: string | null = null;
        if (code[0] === "R" || code[1] === "R") {
          const mm = p.match(/^(.*?) -> (.*)$/);
          if (mm) { renamed_from = mm[1]; p = mm[2]; }
        }
        const isIgnored = code === "!!";
        const staged = !isIgnored && code[0] !== " " && code[0] !== "?";
        const status = isIgnored ? "ignored"
          : code === "??" ? "untracked"
          : code.includes("D") ? "deleted"
          : code.includes("A") ? "added"
          : (code[0] === "R" || code[1] === "R") ? "renamed"
          : "modified";
        files.push({ path: p, status, staged, renamed_from });
      }
      return jsonResponse({ cwd: absCwd, git: true, files });
    } catch (err: any) {
      return jsonResponse({ cwd: absCwd, git: false, files: [], error: String(err?.message ?? err).split("\n")[0] });
    }
  }

  // ── GET /files/diff (git HEAD vs working tree for one file) ──────────
  if (pathname === "/files/diff" && method === "GET") {
    const cwd = url.searchParams.get("cwd") ?? "";
    const file = url.searchParams.get("file") ?? "";
    if (!cwd || !file) return jsonResponse({ error: "missing cwd or file" }, 400);
    const absCwd = validateCwd(cwd);
    if (!absCwd) return jsonResponse({ error: "invalid or disallowed cwd" }, 400);
    const absFile = resolveWithinCwd(absCwd, file);
    if (!absFile) return jsonResponse({ error: "invalid file path" }, 400);
    try {
      const newExists = fs.existsSync(absFile) && fs.statSync(absFile).isFile();
      const newContent = newExists ? fs.readFileSync(absFile, "utf8") : "";
      if (newContent.includes("\u0000")) {
        return jsonResponse({ cwd: absCwd, file, binary: true, old: "", new: "" });
      }
      let oldContent = "";
      try { oldContent = git(absCwd, ["show", `HEAD:${file}`]); } catch { oldContent = ""; }
      return jsonResponse({ cwd: absCwd, file, binary: false, old: oldContent, new: newContent });
    } catch (err: any) {
      return jsonResponse({ error: String(err?.message ?? err).split("\n")[0] }, 500);
    }
  }

  // ── POST /files/save (write working-tree file, contained to cwd) ────
  if (pathname === "/files/save" && method === "POST") {
    let bodyText: string;
    try { bodyText = await readBody(req); } catch (err: any) { return jsonResponse({ error: err.message }, 413); }
    let parsed: any;
    try { parsed = JSON.parse(bodyText); } catch { return jsonResponse({ error: "invalid JSON" }, 400); }
    const cwd = parsed.cwd ?? "";
    const file = parsed.file ?? "";
    const content = typeof parsed.content === "string" ? parsed.content : "";
    if (!cwd || !file) return jsonResponse({ error: "missing cwd or file" }, 400);
    const absCwd = validateCwd(cwd);
    if (!absCwd) return jsonResponse({ error: "invalid or disallowed cwd" }, 400);
    const absFile = resolveWithinCwd(absCwd, file);
    if (!absFile) return jsonResponse({ error: "invalid file path" }, 400);
    try {
      fs.mkdirSync(path.dirname(absFile), { recursive: true });
      fs.writeFileSync(absFile, content, "utf8");
      return jsonResponse({ ok: true, file, bytes: Buffer.byteLength(content, "utf8") });
    } catch (err: any) {
      return jsonResponse({ error: String(err?.message ?? err).split("\n")[0] }, 500);
    }
  }

  // ── Checkpoint helpers (git-backed working-tree snapshots) ──────────────
  function cwdNs(cwd: string): string {
    return "cwd-" + Buffer.from(cwd || "unknown").toString("base64url").slice(0, 16);
  }

  // ── POST /checkpoints/create ────────────────────────────────────────────
  if (pathname === "/checkpoints/create" && method === "POST") {
    let bodyText: string;
    try { bodyText = await readBody(req); } catch (err: any) { return jsonResponse({ error: err.message }, 413); }
    let parsed: any;
    try { parsed = JSON.parse(bodyText); } catch { return jsonResponse({ error: "invalid JSON" }, 400); }
    const cwd = parsed.cwd ?? "";
    if (!cwd) return jsonResponse({ error: "missing cwd" }, 400);
    const absCwd = validateCwd(cwd);
    if (!absCwd) return jsonResponse({ error: "invalid or disallowed cwd" }, 400);
    const label = typeof parsed.label === "string" && parsed.label.trim() ? parsed.label.trim().slice(0, 120) : "";
    try {
      git(absCwd, ["rev-parse", "--is-inside-work-tree"]);
      const ns = cwdNs(absCwd);
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const message = `chk: ${id}${label ? " · " + label : ""}`;
      // Each checkpoint gets its own branch (checkpoints/<ns>/<id>) instead of a
      // shared ns branch, so deleting one checkpoint can delete its branch without
      // touching others. commit-tree + branch -f creates the branch without moving
      // the working tree; we then `git switch` onto it so HEAD tracks the checkpoint.
      const cpBranch = `checkpoints/${ns}/${id}`;
      git(absCwd, ["add", "-A"]);
      const tree = git(absCwd, ["write-tree"]).trim();
      // Parent: most recent existing checkpoint commit for this cwd (keeps a linear
      // history); fall back to current HEAD when this is the first checkpoint.
      let parent = "HEAD";
      try {
        const prev = git(absCwd, ["for-each-ref", "--format=%(objectname)", "--sort=-creatordate", `refs/checkpoints/${ns}/*`])
          .split("\n").map((l: string) => l.trim()).find((l: string) => l);
        if (prev) parent = prev;
      } catch {}
      const sha = git(absCwd, ["commit-tree", tree, "-p", parent, "-m", message]).trim();
      git(absCwd, ["branch", "-f", cpBranch, sha]);
      git(absCwd, ["switch", cpBranch]); // move HEAD onto the new checkpoint branch (working tree unchanged)
      const ref = `refs/checkpoints/${ns}/${id}`;
      git(absCwd, ["update-ref", ref, sha]);
      git(absCwd, ["reset", "-q"]); // restore index to HEAD (now cpBranch); working tree unchanged
      return jsonResponse({ ok: true, ref, sha, message, session: ns, ts: new Date().toISOString() });
    } catch (err: any) {
      return jsonResponse({ git: true, ok: false, error: String(err?.message ?? err).split("\n")[0] }, 500);
    }
  }

  // ── GET /checkpoints/list ───────────────────────────────────────────────
  if (pathname === "/checkpoints/list" && method === "GET") {
    const cwd = url.searchParams.get("cwd") ?? "";
    if (!cwd) return jsonResponse({ error: "missing cwd" }, 400);
    const absCwd = validateCwd(cwd);
    if (!absCwd) return jsonResponse({ error: "invalid or disallowed cwd" }, 400);
    const ns = cwdNs(absCwd);
    const glob = `refs/checkpoints/${ns}/*`;
    try {
      const out = git(absCwd, ["for-each-ref", "--format=%(refname) %(objectname) %(creatordate:iso-strict) %(contents:subject)", glob]);
      const items: any[] = [];
      for (const raw of out.split("\n")) {
        if (!raw.trim()) continue;
        const m = raw.match(/^(\S+) (\S+) (\S+)[ \t]+(.*)$/);
        if (!m) continue;
        const [, ref, sha, ts, subject] = m;
        items.push({ ref, sha, ts, message: subject, session: ns });
      }
      items.sort((a, b) => (a.ts < b.ts ? 1 : -1));
      return jsonResponse({ git: true, items });
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (msg.includes("not a git repository") || msg.includes("did not match")) {
        return jsonResponse({ git: false, items: [] });
      }
      return jsonResponse({ git: false, items: [], error: msg.split("\n")[0] });
    }
  }

  // ── POST /checkpoints/restore ───────────────────────────────────────────
  if (pathname === "/checkpoints/restore" && method === "POST") {
    let bodyText: string;
    try { bodyText = await readBody(req); } catch (err: any) { return jsonResponse({ error: err.message }, 413); }
    let parsed: any;
    try { parsed = JSON.parse(bodyText); } catch { return jsonResponse({ error: "invalid JSON" }, 400); }
    const ref = parsed.ref ?? "";
    if (!ref.startsWith("refs/checkpoints/")) {
      return jsonResponse({ error: "ref must be a checkpoint ref (refs/checkpoints/...)" }, 400);
    }
    const cwd = parsed.cwd ?? "";
    if (!cwd) return jsonResponse({ error: "missing cwd" }, 400);
    const absCwd = validateCwd(cwd);
    if (!absCwd) return jsonResponse({ error: "invalid or disallowed cwd" }, 400);
    try {
      git(absCwd, ["rev-parse", "--verify", ref]);
      git(absCwd, ["reset", "--hard", ref]);
      git(absCwd, ["clean", "-fdq"]);
      const sha = git(absCwd, ["rev-parse", "HEAD"]).trim();
      return jsonResponse({ ok: true, ref, sha });
    } catch (err: any) {
      return jsonResponse({ ok: false, error: String(err?.message ?? err).split("\n")[0] }, 500);
    }
  }

  // ── POST /checkpoints/delete ────────────────────────────────────────────
  if (pathname === "/checkpoints/delete" && method === "POST") {
    let bodyText: string;
    try { bodyText = await readBody(req); } catch (err: any) { return jsonResponse({ error: err.message }, 413); }
    let parsed: any;
    try { parsed = JSON.parse(bodyText); } catch { return jsonResponse({ error: "invalid JSON" }, 400); }
    const ref = parsed.ref ?? "";
    if (!ref.startsWith("refs/checkpoints/")) {
      return jsonResponse({ error: "ref must be a checkpoint ref (refs/checkpoints/...)" }, 400);
    }
    const cwd = parsed.cwd ?? "";
    if (!cwd) return jsonResponse({ error: "missing cwd" }, 400);
    const absCwd = validateCwd(cwd);
    if (!absCwd) return jsonResponse({ error: "invalid or disallowed cwd" }, 400);
    try {
      const parts = ref.split("/");
      const id = parts[parts.length - 1];
      const ns = parts[2];
      let msg = "";
      if (parsed.deleteBranch) {
        const cpBranch = `checkpoints/${ns}/${id}`;
        // git can't delete the currently checked-out branch. Move HEAD to the
        // parent commit first — preferring an existing branch that already points
        // there (e.g. the previous checkpoint branch or the base branch) — then
        // delete it. If there are conflicting uncommitted changes we can't switch,
        // so report and bail out without deleting anything.
        try {
          const cur = git(absCwd, ["branch", "--show-current"]).trim();
          if (cur === cpBranch) {
            const parent = git(absCwd, ["rev-parse", `${cpBranch}^`]).trim();
            const onParent = git(absCwd, ["for-each-ref", "--format=%(refname:lstrip=2)", "--points-at", parent, "refs/heads"])
              .split("\n").map((l: string) => l.trim()).find((l: string) => l && l !== cpBranch);
            if (onParent) { git(absCwd, ["switch", onParent]); msg = `switched to '${onParent}'`; }
            else { git(absCwd, ["switch", "--detach", parent]); msg = `switched to detached HEAD ${parent.slice(0, 8)}`; }
          }
        } catch {
          return jsonResponse({ ok: false, git: true, error: "checkpoint branch is checked out and has uncommitted changes — commit or stash them, then merge into another branch before deleting" }, 409);
        }
        try { git(absCwd, ["branch", "-D", cpBranch]); } catch {}
      }
      git(absCwd, ["update-ref", "-d", ref]);

      const out: any = { ok: true, ref, deleteBranch: !!parsed.deleteBranch };
      if (msg) out.message = `checkpoint branch was checked out — ${msg} and deleted. Merge any uncommitted changes into another branch first.`;
      return jsonResponse(out);
    } catch (err: any) {
      return jsonResponse({ ok: false, error: String(err?.message ?? err).split("\n")[0] }, 500);
    }
  }

  // ── 404 ─────────────────────────────────────────────────────────────────
  return jsonResponse({ error: "not found" }, 404);
}

// ─── Boot ───────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const host = req.headers.host ?? `${HOST}:${PORT}`;
  const url = new URL(req.url ?? "/", `http://${host}`);
  let body: Buffer | undefined;
  if (req.method && req.method !== "GET" && req.method !== "HEAD") {
    try {
      body = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        req.on("data", (c: Buffer) => {
          total += c.length;
          if (total > MAX_REQUEST_BYTES) { reject(new Error("payload too large")); req.destroy(); return; }
          chunks.push(c);
        });
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
      });
    } catch {
      res.statusCode = 413;
      res.end("payload too large");
      return;
    }
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (k === "transfer-encoding" || k === "connection") continue;
    headers[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  const request = new Request(url, {
    method: req.method ?? "GET",
    headers,
    body,
  });
  let response: Response;
  try {
    response = await handle(request);
  } catch (err) {
    response = jsonResponse({ error: String(err) }, 500);
  }
  // Restrict CORS to loopback origins that match this server (see corsOrigin).
  response.headers.set("access-control-allow-origin", corsOrigin(request));
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (response.body) {
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
  } else {
    res.end();
  }
});

// WebSocket terminal bridge (xterm.js in the browser ↔ node-pty shell on the server)
// Terminal launches at $HOME when packaged (AppImage mount is read-only); in
// dev it opens at the project root so the shell starts where you're working.
const TERMINAL_CWD = process.env.SCOPE_PACKAGED ? os.homedir() : PROJECT_ROOT;
attachTerminal(server, { port: PORT, host: HOST, token: AUTH_TOKEN, launchCwd: TERMINAL_CWD });

server.listen(PORT, HOST, () => {
  console.log(`  Listening on http://${HOST}:${PORT}`);
  if (process.env.SCOPE_VERBOSE) console.log(`  Open the UI →  ${OPEN_URL}\n`);
});
