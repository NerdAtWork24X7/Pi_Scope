// Mock backend for the Chat-view end-to-end tests.
//
// Serves the REAL `apps/scope/public` assets over HTTP, so the browser runs the
// actual index.html / app.js / chat.js, while every API endpoint the Chat view
// talks to is implemented here. That keeps the tests deterministic and
// hermetic: no SQLite, no `pi` subprocess, and no network.
//
// The one bit of real behaviour we script is the chat stream: `POST /chat`
// returns an NDJSON response and hands the test a `Turn` controller, so a test
// can emit `text`/`thinking`/`tool_start`/`final`/`done` events exactly when it
// wants (see `nextTurn()`).

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, "..", "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => resolve(data));
  });
}

/** A controlled agent-team snapshot. `teamsOn` keeps the real Agent-Team rail
 *  path active (the fallback session list is also exercised by tests). */
export function defaultTeam(opts = {}) {
  return {
    enabled: true,
    activeTeam: "dev",
    teamsOrder: ["dev", "review"],
    teams: {
      dev: [
        { name: "orchestrator", model: "google/gemini-2.5-flash-lite", active: true },
        { name: "builder", model: "google/gemini-2.5-flash-lite", active: true },
      ],
      review: [{ name: "critic", model: "google/gemini-2.5-flash-lite", active: true }],
    },
    disabledAgents: [],
    skills: [],
    tools: [],
    skipOrchestratorTools: [],
    extensions: [
      { name: "agent-team", path: "/home/u/.pi/extensions/agent-team.ts", available: true, enabled: true },
    ],
    enabledModels: ["google/gemini-2.5-flash-lite", "deepseek/deepseek-v4-flash"],
    defaultModel: "google/gemini-2.5-flash-lite",
    mode: "standard",
    memoryActive: false,
    memoryModel: "",
    chatWorkspaces: [],
    chatWorkspacesRemoved: [],
    ...opts,
  };
}

export function makeSession(s) {
  const now = Date.now();
  return {
    session_id: s.session_id,
    cwd: s.cwd,
    agent_name: s.agent_name ?? "orchestrator",
    model: s.model ?? "google/gemini-2.5-flash-lite",
    first_msg: s.first_msg ?? "",
    last_ts: s.last_ts ?? new Date(now).toISOString(),
    first_ts: s.first_ts ?? new Date(now - 60_000).toISOString(),
    event_count: s.event_count ?? 1,
    tags: [],
    has_shutdown: s.has_shutdown ?? false,
    parent_session_id: s.parent_session_id,
    session_file: s.session_file ?? `/tmp/${s.session_id}.jsonl`,
    ...s,
  };
}

export async function startMockBackend() {
  const state = {
    cwd: "/tmp/pi-scope-e2e",
    sessions: [],
    eventsBySid: {},
    stats: {},
    team: defaultTeam(),
    chatWorkspaces: [],
    chatWorkspacesRemoved: [],
  };

  /** Every request the page made (path/method/parsed body) — tests assert on it. */
  const requests = [];
  const sseClients = new Set();

  // ── Chat stream scripting ────────────────────────────────────────────────
  const turns = []; // completed-but-not-yet-awaited turns
  const waiters = []; // nextTurn() promises awaiting a request
  let activeTurn = null;
  let sessionSeq = 0;

  function makeTurn(req) {
    const res = req.__res;
    const sessionId = req.__sessionId;
    res.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    });
    const turn = {
      sessionId,
      ended: false,
      events: [],
      send(ev) {
        if (turn.ended) return;
        turn.events.push(ev);
        res.write(JSON.stringify(ev) + "\n");
      },
      text(delta) { turn.send({ type: "text", delta }); },
      thinking(delta) { turn.send({ type: "thinking", delta }); },
      end() {
        if (turn.ended) return;
        turn.ended = true;
        try { res.end(); } catch { /* already gone */ }
        if (activeTurn === turn) activeTurn = null;
      },
    };
    activeTurn = turn;
    const w = waiters.shift();
    if (w) w(turn);
    else turns.push(turn);
    req.__res.on("close", () => { if (!turn.ended) { turn.ended = true; if (activeTurn === turn) activeTurn = null; } });
    return turn;
  }

  function nextTurn() {
    if (turns.length) return Promise.resolve(turns.shift());
    return new Promise((resolve) => waiters.push(resolve));
  }

  function broadcastSSE(evt) {
    const frame = `event: event\ndata: ${JSON.stringify(evt)}\n\n`;
    for (const c of sseClients) {
      try { c.write(frame); } catch { /* closed */ }
    }
  }

  function snapshotTeam() {
    return {
      ...state.team,
      chatWorkspaces: state.chatWorkspaces.slice(),
      chatWorkspacesRemoved: state.chatWorkspacesRemoved.slice(),
    };
  }

  function sendJSON(res, obj, status = 200) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
    res.end(body);
  }

  function serveStatic(req, res, pathname) {
    const rel = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
    const full = path.join(PUBLIC_DIR, rel);
    if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end("forbidden"); return; }
    let target = full;
    try {
      if (fs.statSync(full).isDirectory()) target = path.join(full, "index.html");
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    let body;
    try { body = fs.readFileSync(target); } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(target)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  }

  const server = http.createServer(async (req, res) => {
    const parsed = new URL(req.url, "http://localhost");
    const pathname = parsed.pathname;
    const method = req.method || "GET";
    // Exact API paths only — a bare startsWith("/chat") would swallow the real
    // static asset /chat.js (and /settings.js).
    const isAPI =
      pathname === "/chat" || pathname.startsWith("/chat/") ||
      pathname === "/sessions" || pathname.startsWith("/sessions/") ||
      pathname === "/health" ||
      pathname === "/agent-team" ||
      pathname === "/events/stream" ||
      pathname === "/settings" || pathname.startsWith("/settings/");

    if (!isAPI) return serveStatic(req, res, pathname);

    const raw = method === "GET" || method === "DELETE" ? "" : await readBody(req);
    let body = {};
    if (raw) { try { body = JSON.parse(raw); } catch { body = {}; } }
    req.__body = body;
    requests.push({ method, path: pathname, query: Object.fromEntries(parsed.searchParams), body });

    // ── Health ─────────────────────────────────────────────────────────────
    if (pathname === "/health") return sendJSON(res, { ok: true, cwd: state.cwd, version: "test" });

    // ── Sessions ───────────────────────────────────────────────────────────
    if (pathname === "/sessions" && method === "GET") {
      return sendJSON(res, { sessions: state.sessions });
    }
    if (pathname === "/sessions" && method === "DELETE") {
      const deleted = { sessions: state.sessions.length, events: Object.values(state.eventsBySid).reduce((n, e) => n + e.length, 0) };
      state.sessions = [];
      state.eventsBySid = {};
      state.stats = {};
      return sendJSON(res, { ok: true, deleted });
    }
    if (pathname === "/sessions/stats" && method === "GET") {
      const ids = String(parsed.searchParams.get("ids") || "").split(",").filter(Boolean);
      const stats = {};
      for (const id of ids) stats[id] = state.stats[id] || { total_cost: 0, total_tokens: 0, error_count: 0, models: [] };
      return sendJSON(res, { stats });
    }
    let m = pathname.match(/^\/sessions\/([^/]+)\/stats$/);
    if (m && method === "GET") {
      const id = decodeURIComponent(m[1]);
      return sendJSON(res, state.stats[id] || { total_cost: 0, total_tokens: 0, error_count: 0, models: [] });
    }
    m = pathname.match(/^\/sessions\/([^/]+)\/events$/);
    if (m && method === "GET") {
      const id = decodeURIComponent(m[1]);
      return sendJSON(res, { events: state.eventsBySid[id] || [] });
    }
    m = pathname.match(/^\/sessions\/([^/]+)$/);
    if (m && method === "DELETE") {
      const id = decodeURIComponent(m[1]);
      state.sessions = state.sessions.filter((s) => s.session_id !== id);
      delete state.eventsBySid[id];
      return sendJSON(res, { ok: true });
    }

    // ── SSE ────────────────────────────────────────────────────────────────
    if (pathname === "/events/stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write("event: hello\ndata: {}\n\n");
      sseClients.add(res);
      const ka = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* closed */ } }, 15_000);
      req.on("close", () => { clearInterval(ka); sseClients.delete(res); });
      return;
    }

    // ── Agent team (workspaces live here too) ──────────────────────────────
    if (pathname === "/agent-team" && method === "GET") return sendJSON(res, snapshotTeam());
    if (pathname === "/agent-team" && method === "POST") {
      const action = body.action;
      if (action === "addWorkspace" && typeof body.path === "string") {
        const p = body.path.trim();
        if (p && !state.chatWorkspaces.includes(p)) state.chatWorkspaces.push(p);
        state.chatWorkspacesRemoved = state.chatWorkspacesRemoved.filter((w) => w !== p);
      } else if (action === "removeWorkspace" && typeof body.path === "string") {
        state.chatWorkspaces = state.chatWorkspaces.filter((w) => w !== body.path);
        if (!state.chatWorkspacesRemoved.includes(body.path)) state.chatWorkspacesRemoved.push(body.path);
        state.sessions = state.sessions.filter((s) => (s.cwd || "(unknown)") !== body.path);
      } else if (action === "setTeam" && typeof body.team === "string") {
        state.team.activeTeam = body.team;
      } else if (action === "toggleMode") {
        state.team.mode = state.team.mode === "creative" ? "standard" : "creative";
      } else if (action === "toggleMemory") {
        state.team.memoryActive = !state.team.memoryActive;
      } else if (action === "toggleAgent" && typeof body.agent === "string") {
        const name = body.agent.toLowerCase();
        const set = new Set(state.team.disabledAgents || []);
        if (body.disabled) set.add(name); else set.delete(name);
        state.team.disabledAgents = [...set];
      }
      return sendJSON(res, snapshotTeam());
    }

    // ── Chat session lifecycle ─────────────────────────────────────────────
    if (pathname === "/chat/start" && method === "POST") {
      const sessionId = `pre-${++sessionSeq}`;
      return sendJSON(res, { sessionId, reused: false, cwd: body.cwd || state.cwd, model: body.model || "" });
    }
    if (pathname === "/chat/kill" || pathname === "/chat/stop") return sendJSON(res, { ok: true });
    if (pathname === "/chat/prefs") return sendJSON(res, { ok: true, sent: 2 });
    if (pathname === "/chat/ui") return sendJSON(res, { ok: true, sessionId: body.sessionId });

    if (pathname === "/chat/footer" && method === "GET") {
      return sendJSON(res, {
        branch: "main",
        thinking: "high",
        modelMeta: {
          "google/gemini-2.5-flash-lite": {
            provider: "google",
            contextWindow: 1_000_000,
            maxTokens: 8192,
            cost: { input: 0.1, output: 0.4, cacheRead: 0.02 },
            thinkingLevels: ["off", "low", "medium", "high"],
          },
          "deepseek/deepseek-v4-flash": {
            provider: "deepseek",
            contextWindow: 128_000,
            maxTokens: 8192,
            cost: { input: 0.07, output: 0.28 },
            thinkingLevels: ["off", "low", "high"],
          },
        },
        goUsage: null,
      });
    }

    if (pathname === "/chat/stt/status") {
      return sendJSON(res, {
        recording: false, startedAt: null, elapsedMs: 0, recorder: null,
        recorderAvailable: false, hasApiKey: false, apiKeySource: "",
        model: "whisper-large-v3", maxDurationSeconds: 120,
      });
    }

    if (pathname === "/chat" && method === "POST") {
      const wantsQueue = (body.streamingBehavior === "steer" || body.streamingBehavior === "followUp");
      // A prompt already streaming: the real server queues it and replies with
      // plain JSON, which is how the client detects the queued path.
      if (wantsQueue && activeTurn && !activeTurn.ended) {
        return sendJSON(res, { ok: true, queued: true, streamingBehavior: body.streamingBehavior });
      }
      req.__res = res;
      req.__sessionId = body.sessionId || `live-${++sessionSeq}`;
      makeTurn(req);
      return;
    }

    if (pathname === "/settings") return sendJSON(res, { pi: {}, settingsRaw: {}, ...snapshotTeam() });

    return sendJSON(res, { error: `mock: unhandled ${method} ${pathname}` }, 404);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const base = `http://127.0.0.1:${addr.port}`;

  return {
    base,
    state,
    requests,
    defaultTeam,
    makeSession,
    nextTurn,
    broadcastSSE,
    snapshotTeam,
    /** Seed the session list the next /sessions fetch will return. */
    setSessions(list) { state.sessions = list.map(makeSession); },
    setTeam(team) {
      state.team = team;
      // chatWorkspaces live in their own slot on the snapshot; mirror the
      // fixture's list so a test can seed session-less workspaces.
      state.chatWorkspaces = (team && team.chatWorkspaces) ? team.chatWorkspaces.slice() : [];
      state.chatWorkspacesRemoved = (team && team.chatWorkspacesRemoved) ? team.chatWorkspacesRemoved.slice() : [];
    },
    setEvents(sid, events) { state.eventsBySid[sid] = events; },
    get activeTurn() { return activeTurn; },
    requestsFor(pathname, method) {
      return requests.filter((r) => r.path === pathname && (!method || r.method === method));
    },
    /** Reset every piece of per-test state (called from beforeEach). */
    reset() {
      state.sessions = [];
      state.eventsBySid = {};
      state.stats = {};
      state.team = defaultTeam();
      state.chatWorkspaces = [];
      state.chatWorkspacesRemoved = [];
      requests.length = 0;
      turns.length = 0;
      waiters.splice(0).forEach(() => {});
      activeTurn = null;
    },
    async close() {
      for (const c of sseClients) { try { c.end(); } catch { /* closed */ } }
      sseClients.clear();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
