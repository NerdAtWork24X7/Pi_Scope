// Mock backend for the Chat-view end-to-end tests.
//
// Serves the REAL `apps/scope-server/public` assets over HTTP, so the browser runs the
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

const BUILTIN_PLUGINS_DIR = path.join(HERE, "..", "plugins");

/** The tools a subagent definition without its own `tools:` key gets, mirroring
 *  the real server's `agentDefaultTools` (the agent-team extension's built-in
 *  fallback list). */
export const AGENT_DEFAULT_TOOLS = ["read", "grep", "find", "ls"];

/** The model registry, shaped like the real server's `modelsMeta` (provider,
 *  context window, cost, thinking levels). One entry — anthropic's — is in the
 *  registry but NOT in the fixture's enabledModels, which is what the model
 *  pickers have to pick up ("all models", grouped by provider). */
export const MODEL_META = {
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
  "anthropic/claude-sonnet-4": {
    provider: "anthropic",
    contextWindow: 200_000,
    maxTokens: 64000,
    cost: { input: 3, output: 15 },
    thinkingLevels: ["off", "low", "high"],
  },
};

let pluginSnapshotCache = null;

/**
 * A `/plugins` snapshot shaped like the real server's (see plugins.ts
 * `pluginSnapshot()`), built from the checked-in built-in manifests. All
 * built-ins are enabled; `clientUrl` is only set for plugins that ship one.
 */
function pluginSnapshot() {
  if (pluginSnapshotCache) return pluginSnapshotCache;
  const plugins = [];
  let dirs = [];
  try { dirs = fs.readdirSync(BUILTIN_PLUGINS_DIR, { withFileTypes: true }); } catch { dirs = []; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const file = path.join(BUILTIN_PLUGINS_DIR, d.name, "plugin.json");
    let manifest = null;
    try { manifest = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    const id = manifest.id || d.name;
    const hasServer = !!manifest.server;
    const hasClient = !!manifest.client;
    plugins.push({
      id,
      name: manifest.name || id,
      description: manifest.description || "",
      version: manifest.version || "0.0.0",
      author: manifest.author || "",
      source: "builtin",
      enabled: true,
      core: manifest.core === true,
      hasServer,
      hasClient,
      clientUrl: hasClient ? `/plugins/file/${id}/client.js` : null,
      error: null,
      serverRoutes: manifest.serverRoutes || [],
      nav: manifest.nav || null,
      ui: manifest.ui || null,
      dir: path.dirname(file),
    });
  }
  pluginSnapshotCache = { pluginsDir: null, pluginsBuiltinDir: BUILTIN_PLUGINS_DIR, configPath: null, plugins };
  return pluginSnapshotCache;
}

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
    // The reference library the Office shows in its meeting room.
    library: [],
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
    // Subagent definitions (agents/*.md) as GET /settings returns them.
    agentDefs: [],
    // The Office plugin's own state, per workspace: its name, the Kanban task
    // queue and the runner switch. The real plugin keeps this in its own store
    // behind `/office` (plugins/office/server.ts), NOT in the team snapshot.
    office: {},
  };

  /** The bucket a workspace's office state lives in (the plugin keys on cwd). */
  const officeKey = (cwd) => String(cwd || state.cwd || "(default)");

  /** An office snapshot shaped like the plugin's `GET /office` answer. */
  function officeSnapshot(cwd) {
    const s = state.office[officeKey(cwd)] || {};
    return {
      officeName: s.officeName || undefined,
      tasks: (s.tasks || []).map((t) => ({ ...t })),
      // Paused is the default: anything but an explicit false means paused.
      runnerPaused: s.runnerPaused !== false,
    };
  }

  /** The mutable bucket behind a workspace's office state. */
  function officeBucket(cwd) {
    const key = officeKey(cwd);
    state.office[key] = state.office[key] || { tasks: [] };
    return state.office[key];
  }

  /** Every request the page made (path/method/parsed body) — tests assert on it. */
  const requests = [];
  const sseClients = new Set();
  // Injected failures (see failNext): the next matching API call answers with
  // an error, so a test can prove a view keeps its last good data.
  const fails = [];

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

  /** Mirror the server: `disabledAgents` is the running session's off-list and
   *  follows the active team's own roster rows, so duty never crosses teams. */
  function reconcileDisabledAgents() {
    const teams = state.team.teams || {};
    const named = state.team.activeTeam || "";
    const active = named && teams[named] ? named : Object.keys(teams)[0] || "";
    const members = active ? teams[active] : undefined;
    state.team.disabledAgents = Array.isArray(members)
      ? members
          .filter((m) => m && m.active === false && String(m.name || "").trim())
          .map((m) => String(m.name).toLowerCase())
      : [];
  }

  function snapshotTeam() {
    return {
      ...state.team,
      chatWorkspaces: state.chatWorkspaces.slice(),
      chatWorkspacesRemoved: state.chatWorkspacesRemoved.slice(),
    };
  }

  /** A /settings snapshot shaped like the real route's: the model registry, the
   *  default tool list a definition inherits, the subagent definitions, and the
   *  agent-team state the page reads alongside them. */
  function settingsSnapshot() {
    return {
      pi: {},
      settingsRaw: {},
      modelsMeta: MODEL_META,
      agentDefaultTools: AGENT_DEFAULT_TOOLS,
      agentDefs: state.agentDefs,
      ...snapshotTeam(),
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
      // The Office plugin's own routes (its name / Kanban queue / runner).
      pathname === "/office" ||
      pathname === "/events/stream" ||
      pathname === "/settings" || pathname.startsWith("/settings/") ||
      pathname === "/plugins" ||
      // The Files plugin's routes. Only the graph is needed: the Review view
      // asks for it from its onSessions hook, which can run during the boot
      // view-switch race even when another view ends up active.
      pathname === "/files" || pathname.startsWith("/files/");

    // ── Plugin files (client bundles + stylesheets) ────────────────────────
    // The real host serves any file inside a plugin's own directory here, which
    // is how a standalone plugin's client.js / client.css reach the browser.
    if (pathname.startsWith("/plugins/file/")) {
      const rest = pathname.slice("/plugins/file/".length);
      const slash = rest.indexOf("/");
      if (slash <= 0) { res.writeHead(404, { "content-type": "text/plain" }); res.end("not found"); return; }
      const id = decodeURIComponent(rest.slice(0, slash));
      const rel = decodeURIComponent(rest.slice(slash + 1));
      const full = path.join(BUILTIN_PLUGINS_DIR, id, rel);
      if (!full.startsWith(BUILTIN_PLUGINS_DIR)) { res.writeHead(403); res.end("forbidden"); return; }
      let body;
      try { body = fs.readFileSync(full); } catch {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      res.writeHead(200, {
        "content-type": MIME[path.extname(full)] || "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(body);
      return;
    }

    if (!isAPI) return serveStatic(req, res, pathname);

    const raw = method === "GET" || method === "DELETE" ? "" : await readBody(req);
    let body = {};
    if (raw) { try { body = JSON.parse(raw); } catch { body = {}; } }
    req.__body = body;
    requests.push({ method, path: pathname, query: Object.fromEntries(parsed.searchParams), body });

    // An injected failure for the next matching call (see failNext).
    const failAt = fails.findIndex((f) => f.path === pathname && (!f.method || f.method === method));
    if (failAt >= 0) {
      const f = fails.splice(failAt, 1)[0];
      return sendJSON(res, { error: "injected failure" }, f.status || 500);
    }

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
        reconcileDisabledAgents();
      } else if (action === "toggleMode") {
        state.team.mode = state.team.mode === "creative" ? "standard" : "creative";
      } else if (action === "toggleMemory") {
        state.team.memoryActive = !state.team.memoryActive;
      } else if (action === "addLibraryEntry" && typeof body.path === "string") {
        // The real route resolves the path on disk; the mock keys on path + the
        // agent it is for, so the same file may be listed per agent, once each.
        const p = body.path.trim();
        const note = typeof body.note === "string" ? body.note.trim() : "";
        const target = typeof body.target === "string" ? body.target.trim() : "";
        state.team.library = state.team.library || [];
        const same = (e) => e.path === p && (e.target || "") === target;
        const existing = state.team.library.find(same);
        if (existing) {
          if (note) existing.note = note;
        } else if (p) {
          const entry = { id: `lib_${state.team.library.length + 1}`, path: p };
          if (note) entry.note = note;
          if (target) entry.target = target;
          state.team.library.push(entry);
        }
      } else if (action === "setLibraryEntry" && typeof body.id === "string") {
        const list = state.team.library || [];
        const at = list.findIndex((e) => e.id === body.id);
        if (at >= 0) {
          const target = typeof body.target === "string" ? body.target.trim() : "";
          const note = typeof body.note === "string" ? body.note.trim() : "";
          const clash = list.findIndex((e, i) => i !== at && e.path === list[at].path && (e.target || "") === target);
          if (clash >= 0) {
            if (note) list[clash].note = note;
            list.splice(at, 1);
          } else {
            if (target) list[at].target = target; else delete list[at].target;
            if (note) list[at].note = note; else delete list[at].note;
          }
        }
      } else if (action === "removeLibraryEntry") {
        state.team.library = (state.team.library || [])
          .filter((e) => !(body.id ? e.id === body.id : e.path === body.path));
      } else if (action === "toggleAgent" && typeof body.agent === "string") {
        const name = body.agent.toLowerCase();
        // Duty is per team: a named team flips only that roster row (the same
        // member can sit on several teams and each keeps its own state).
        const team = typeof body.team === "string" ? body.team.trim() : "";
        if (team && !(state.team.teams || {})[team]) {
          return sendJSON(res, { error: `no such team: ${team}` }, 400);
        }
        const lists = team ? [state.team.teams[team]] : Object.values(state.team.teams || {});
        for (const members of lists) {
          const mem = (members || []).find((m) => (m.name || "").toLowerCase() === name);
          if (mem) mem.active = !body.disabled;
        }
        // `disabledAgents` only speaks for the running (active) team.
        if (!team || team === state.team.activeTeam) reconcileDisabledAgents();
      } else if (action === "addTeam" && typeof body.team === "string") {
        const name = body.team.trim();
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
          return sendJSON(res, { error: "team names may use letters, digits, '-' and '_'" }, 400);
        }
        state.team.teams = state.team.teams || {};
        if (!state.team.teams[name]) {
          state.team.teams[name] = [];
          state.team.teamsOrder = [...(state.team.teamsOrder || []), name];
        }
        // A team the user just created is the one they want to work on.
        state.team.activeTeam = name;
        reconcileDisabledAgents();
      } else if (action === "removeTeam" && typeof body.team === "string") {
        const name = body.team.trim();
        if (state.team.teams) delete state.team.teams[name];
        state.team.teamsOrder = (state.team.teamsOrder || []).filter((t) => t !== name);
        if (state.team.activeTeam === name) {
          const remaining = Object.keys(state.team.teams || {});
          if (remaining.length) state.team.activeTeam = remaining[0];
          else delete state.team.activeTeam;
        }
        reconcileDisabledAgents();
      } else if (action === "addMember" && typeof body.team === "string" && typeof body.name === "string") {
        const name = body.name.trim();
        state.team.teams = state.team.teams || {};
        const members = (state.team.teams[body.team] = state.team.teams[body.team] || []);
        if (name && !members.some((m) => (m.name || "").toLowerCase() === name.toLowerCase())) {
          const entry = { name };
          if (body.model) entry.model = String(body.model);
          if (body.displayName) entry.displayName = String(body.displayName);
          members.push(entry);
        }
        reconcileDisabledAgents();
      } else if (action === "removeMember" && typeof body.team === "string" && typeof body.name === "string") {
        const members = (state.team.teams || {})[body.team];
        if (Array.isArray(members)) {
          state.team.teams[body.team] = members.filter((m) => (m.name || "").toLowerCase() !== body.name.toLowerCase());
        }
        reconcileDisabledAgents();
      } else if (action === "setMemberDisplayName" && typeof body.team === "string" && typeof body.agent === "string") {
        const members = (state.team.teams || {})[body.team];
        const mem = Array.isArray(members)
          ? members.find((m) => (m.name || "").toLowerCase() === body.agent.toLowerCase())
          : null;
        const dn = String(body.displayName ?? "").trim();
        // Mirror the real server: one line, up to 64 characters, and no colon
        // (the line-based teams.yaml parser splits on it).
        if (!/^[^\r\n:]{0,64}$/.test(dn)) {
          return sendJSON(res, { error: "display names may be up to 64 characters, on one line" }, 400);
        }
        if (mem) {
          if (dn) mem.displayName = dn; else delete mem.displayName;
        }
      } else if (action === "setMemberModel" && typeof body.team === "string" && typeof body.agent === "string") {
        const members = (state.team.teams || {})[body.team];
        const mem = Array.isArray(members)
          ? members.find((m) => (m.name || "").toLowerCase() === String(body.agent).toLowerCase())
          : null;
        if (mem) {
          const model = String(body.model || "").trim();
          if (model) mem.model = model; else delete mem.model;
        }
      } else if (action === "toggleSkill" && typeof body.dir === "string") {
        // Orchestrator-only, like the real route: a subagent's skills are its
        // own agents/*.md `skills:` key (setAgentDefSkills), never a team field.
        const sk = (state.team.skills || []).find((s) => s.dir === body.dir);
        if (sk) sk.orchestrator = !sk.orchestrator;
      } else if (action === "toggleTool" && typeof body.tool === "string") {
        const key = String(body.tool).toLowerCase();
        const arr = Array.isArray(state.team.skipOrchestratorTools) ? [...state.team.skipOrchestratorTools] : [];
        const i = arr.findIndex((t) => String(t).toLowerCase() === key);
        if (i >= 0) arr.splice(i, 1); else arr.push(String(body.tool));
        state.team.skipOrchestratorTools = arr;
      } else if (action === "toggleExtension" && typeof body.path === "string") {
        const ex = (state.team.extensions || []).find((e) => e.path === body.path);
        if (ex) ex.enabled = ex.enabled === false;
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
        modelMeta: MODEL_META,
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

    if (pathname === "/settings" && method === "GET") {
      return sendJSON(res, settingsSnapshot());
    }    if (pathname === "/settings" && method === "POST") {
      // Only the actions the views exercise are modelled; the rest are no-ops
      // that still answer with the snapshot, like the real route.
      if (body.action === "saveAgentDefFile" && body.value && typeof body.value.file === "string") {
        const def = state.agentDefs.find((d) => d.file === body.value.file);
        if (!def) return sendJSON(res, { error: `no such agent definition: ${body.value.file}` }, 404);
        def.content = String(body.value.content ?? "");
      }
      // A subagent's own allowlists (agents/*.md `skills:` / `tools:`): the
      // Settings picker and a desk's popup both write these, so the mock keeps
      // the parsed fields in step the way the real frontmatter writer does
      // (null drops the key → the definition inherits again).
      if (body.action === "setAgentDefSkills" || body.action === "setAgentDefTools") {
        const key = body.action === "setAgentDefSkills" ? "skills" : "tools";
        const def = state.agentDefs.find((d) => d.file === body.value.file);
        if (!def) return sendJSON(res, { error: `no such agent definition: ${body.value.file}` }, 404);
        const names = body.value[key];
        const list = names === null || names === undefined
          ? []
          : [...new Set(names.map((n) => String(n).trim()).filter(Boolean))];
        def[key] = list;
        // `tools:` still has a default-list state worth tracking (the extension's
        // built-in list, which a missing OR empty key selects); `skills:` does
        // not — absent and empty both mean none.
        if (key === "tools") def.toolsAll = list.length === 0;
      }
      // The Office's orchestrator picker writes the app's default model.
      if (body.action === "setDefaultModel") state.team.defaultModel = String(body.value || "");
      if (body.action === "createAgentDefFile" && body.value && typeof body.value.file === "string") {
        const file = body.value.file;
        if (state.agentDefs.some((d) => d.file === file)) {
          return sendJSON(res, { error: `agent definition already exists: ${file}` }, 409);
        }
        const content = String(body.value.content ?? "");
        const named = content.match(/^name:\s*(.+)$/m);
        state.agentDefs.push({
          file,
          name: named ? named[1].trim() : file.replace(/\.md$/, ""),
          description: "",
          model: "",
          tools: [],
          toolsAll: true,
          thinking: "",
          skills: [],
          content,
        });
      }
      return sendJSON(res, settingsSnapshot());
    }

    // ── Files (Review) ─────────────────────────────────────────────────────
    // The graph the Review view renders. Its real handler shells out to git, so
    // for the mock's non-repo cwd the honest answer is the real route's own
    // failure shape (see plugins/files/server.ts).
    if (pathname === "/files/graph" && method === "GET") {
      const cwd = parsed.searchParams.get("cwd") || "";
      return sendJSON(res, {
        cwd,
        git: false,
        modules: [],
        edges: [],
        fileNodes: [],
        fileEdges: [],
        changed: [],
        head: null,
        stats: { files: 0, modules: 0, changedFiles: 0, add: 0, del: 0, truncated: false },
      });
    }

    // ── Office (the plugin's own routes) ───────────────────────────────────
    // Mirrors plugins/office/server.ts: the view's name, its Kanban queue and
    // the runner switch are plugin-owned, so they do NOT ride on /agent-team.
    if (pathname === "/office" && method === "GET") {
      return sendJSON(res, officeSnapshot(parsed.searchParams.get("cwd")));
    }
    if (pathname === "/office" && method === "POST") {
      const action = String(body.action || "");
      const bucket = officeBucket(body.cwd);
      const collapse = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
      if (action === "setOfficeName") {
        const name = collapse(body.name);
        if (name.length > 60) return sendJSON(res, { error: "office names may be up to 60 characters" }, 400);
        if (name) bucket.officeName = name; else delete bucket.officeName;
      } else if (action === "addTask") {
        const title = collapse(body.title);
        const note = collapse(body.note);
        if (!title) return sendJSON(res, { error: "missing title" }, 400);
        if (title.length > 200) return sendJSON(res, { error: "task titles may be up to 200 characters" }, 400);
        const task = { id: `task_${(bucket.tasks || []).length + 1}`, title, status: "todo", createdAt: Date.now() };
        if (note) task.note = note;
        bucket.tasks = [...(bucket.tasks || []), task];
      } else if (action === "moveTask") {
        const id = String(body.id || "").trim();
        const status = String(body.status || "");
        if (!id) return sendJSON(res, { error: "missing id" }, 400);
        if (!["todo", "planned", "in_progress", "done"].includes(status)) {
          return sendJSON(res, { error: `invalid status: ${status}` }, 400);
        }
        const task = (bucket.tasks || []).find((t) => t.id === id);
        if (!task) return sendJSON(res, { error: "no such task" }, 404);
        const at = Date.now();
        task.status = status;
        if (status === "planned") task.plannedAt = task.plannedAt || at;
        if (status === "todo") { delete task.plannedAt; delete task.startedAt; delete task.finishedAt; }
        if (status === "in_progress") task.startedAt = task.startedAt || at;
        if (status === "done") task.finishedAt = at;
      } else if (action === "removeTask") {
        const id = String(body.id || "").trim();
        if (!id) return sendJSON(res, { error: "missing id" }, 400);
        bucket.tasks = (bucket.tasks || []).filter((t) => t.id !== id);
      } else if (action === "setRunnerPaused") {
        bucket.runnerPaused = body.paused !== false;
      } else {
        return sendJSON(res, { error: `unknown action: ${action}` }, 400);
      }
      return sendJSON(res, officeSnapshot(body.cwd));
    }

    // ── Plugins ────────────────────────────────────────────────────────────
    // The client fetches this at boot to reconcile the built-in registry with
    // the server's manifests (see public/plugins.js). Serve the REAL manifests
    // from apps/scope-server/plugins so every built-in view stays enabled here,
    // exactly as the real server reports them.
    if (pathname === "/plugins") return sendJSON(res, pluginSnapshot());

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
    /** Seed the subagent definitions (agents/*.md) that GET /settings returns. */
    setAgentDefs(defs) { state.agentDefs = defs.map((d) => ({ ...d })); },
    /** Seed the reference library (files/folders injected at conversation start). */
    setLibrary(entries) { state.team.library = entries.map((e) => ({ ...e })); },
    /** Seed the Office plugin's own state for a workspace (name / queue / runner). */
    setOffice(o = {}, cwd) {
      const bucket = officeBucket(cwd);
      if ("officeName" in o) { if (o.officeName) bucket.officeName = o.officeName; else delete bucket.officeName; }
      if (Array.isArray(o.tasks)) bucket.tasks = o.tasks.map((t) => ({ ...t }));
      if ("runnerPaused" in o) bucket.runnerPaused = o.runnerPaused !== false;
    },
    /** The Office state the plugin route is currently holding for a workspace. */
    officeState: (cwd) => officeSnapshot(cwd),
    /** Seed one session's totals, as GET /sessions/stats reports them. */
    setStats(id, s) {
      state.stats[id] = { total_cost: 0, total_tokens: 0, error_count: 0, models: [], ...s };
    },
    get activeTurn() { return activeTurn; },
    requestsFor(pathname, method) {
      return requests.filter((r) => r.path === pathname && (!method || r.method === method));
    },
    /** Fail the NEXT matching API call with `status` (default 500). */
    failNext(pathname, method = "GET", status = 500) {
      fails.push({ path: pathname, method, status });
    },
    /** Reset every piece of per-test state (called from beforeEach). */
    reset() {
      state.sessions = [];
      state.eventsBySid = {};
      state.stats = {};
      state.team = defaultTeam();
      state.chatWorkspaces = [];
      state.chatWorkspacesRemoved = [];
      state.agentDefs = [];
      state.office = {};
      requests.length = 0;
      fails.length = 0;
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
