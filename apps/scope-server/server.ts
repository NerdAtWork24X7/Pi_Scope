/**
 * server.ts — Node HTTP + SSE + SQLite scope server.
 *
 * Single-file server. Hand-rolled routing. Uses node:sqlite via db.ts.
 * Serves static UI from apps/scope-server/public/.
 */

import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import * as http from "node:http";
import { Readable } from "node:stream";
import { createDb, prepare, toRow, toSessionRow, rowToSession, rowToEvent, canonicalSessionId } from "./db.ts";
import { MAX_REQUEST_BYTES } from "../../shared/types.ts";
import type { ObsEvent } from "../../shared/types.ts";
import { attachTerminal } from "./terminal.ts";
import {
  discover as discoverPlugins,
  activate as activatePlugins,
  pluginSnapshot,
  setPluginEnabled,
  reload as reloadPlugins,
  disabledPluginForRoute,
  matchPluginRoute,
  runPluginRoute,
  emitPluginEvent,
  resolvePluginFile,
  isEnabled as isPluginEnabled,
} from "./plugins.ts";
import { startChat, startChatSession, killChatSession, stopChat, answerChatUi, shutdownChatSessions, pushChatPrefs, generateCommitMessage } from "./chat.ts";
import { startStt, stopStt, sttStatus, abortStt, loadSttConfig } from "./stt.ts";
import { keyEntries, maskSecret, setStoredKey, clearStoredKey, isValidKeyName, MAX_KEY_LENGTH } from "./api-keys.ts";
import { parseLLMRequestBody, parseLLMResponseBody, extractUserMsgPreview } from "../../shared/capture.ts";
import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import { WebSocket } from "ws";

// ─── Config ─────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.SCOPE_PORT ?? "43190", 10);
const HOST = process.env.SCOPE_HOST ?? "127.0.0.1";
// A wildcard bind (0.0.0.0 / ::) makes the server reachable from the LAN — e.g. a
// phone opening the Chat view on the same Wi-Fi. Several routes below skip the
// auth wall on the premise that "only a local process can reach me", which only
// holds while the bind is loopback. LAN_EXPOSED turns that premise off: those
// exemptions then apply to loopback peers only, and every other caller must
// present the token.
const LAN_EXPOSED = !["127.0.0.1", "::1", "localhost"].includes(HOST);
// Resolve database path: if SCOPE_DB_PATH env is set, use it as is.
// Otherwise, default to the "db/scope.db" directory relative to the project root.
const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");
const DEFAULT_DB_PATH = path.join(PROJECT_ROOT, "db", "scope.db");
// Terminal launches at $HOME when packaged (AppImage mount is read-only); in
// dev it opens at the project root so the shell starts where you're working.
const TERMINAL_CWD = process.env.SCOPE_PACKAGED ? os.homedir() : PROJECT_ROOT;
const DB_PATH = process.env.SCOPE_DB_PATH ?? DEFAULT_DB_PATH;

// Ensure parent folder exists (e.g. "db/" directory) before initializing SQLite
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const AUTH_TOKEN = process.env.SCOPE_AUTH_TOKEN ?? crypto.randomUUID();
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

// Internal header carrying the real TCP peer address (set in the Node server
// shim below, never from the client). Used only to decide whether the
// loopback-trusted producer exemption still applies on a LAN bind.
const PEER_HEADER = "x-scope-peer";
function peerIsLoopback(req: Request): boolean {
  const addr = (req.headers.get(PEER_HEADER) ?? "")
    // Node reports IPv4 clients on a dual-stack socket as IPv4-mapped IPv6.
    .replace(/^::ffff:/i, "")
    // Drop any zone id ("fe80::1%eth0").
    .replace(/%.*$/, "")
    .trim();
  // An empty/unknown peer address is NOT loopback — fail closed so a request
  // that somehow loses its peer info can never claim the local-producer trust.
  if (addr === "") return false;
  return addr === "::1" || addr.startsWith("127.");
}

// Persist the effective token to a local, owner-only file so other local
// components (launcher UI, pi extension) can discover the per-run token
// instead of relying on a hardcoded constant like "devtoken".
const TOKEN_FILE = process.env.SCOPE_TOKEN_FILE ?? path.join(PROJECT_ROOT, "tmp", "scope_token");
try {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, AUTH_TOKEN, { mode: 0o600 });
} catch {}

// ─── Agent-team sidebar state ───────────────────────────────────────────────
// The pi agent-team harness persists its sidebar state to two files under the
// agent dir (~/.pi/agent): agents/teams.yaml (teams + members + memory_model)
// and agent-team-config.json (activeTeam, mode, disabledAgents, skills). The
// web Chat view's right sidebar mirrors the agent-team sidebar (sidebar.ts), so
// the server reads these files and returns a normalized snapshot.
const AGENT_DIR = process.env.SCOPE_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
const TEAMS_YAML = process.env.SCOPE_TEAMS_YAML ?? path.join(AGENT_DIR, "agents", "teams.yaml");
const AGENT_CONFIG = process.env.SCOPE_AGENT_CONFIG ?? path.join(AGENT_DIR, "agent-team-config.json");
const SETTINGS_JSON = process.env.SCOPE_SETTINGS_JSON ?? path.join(AGENT_DIR, "settings.json");
const SKILLS_DIR = process.env.SCOPE_SKILLS_DIR ?? path.join(AGENT_DIR, "skills");

// ─── Project-scoped agent-team config (agent-team-config.json / teams.yaml) ─
// pi's agent-team extension now stores these PER PROJECT under each project's
// own <project>/.pi/settings directory (it resolves them from process.cwd() =
// the directory pi was launched from). Scope chats launch pi with cwd = the
// selected chat workspace, so each chat workspace is a "project" with its own
// agent-team configuration. Mirror the extension's resolution exactly:
//   • read  → project-local <proj>/.pi/settings/... when present, else the
//             global agent-dir copy (fallback)
//   • write → always project-local, so toggles persist per project instead of
//             mutating the global config
// Scope targets the chat workspace currently open (client sends cwd on every
// agent-team / settings call); when none is given it falls back to the most
// recently used project, then the server's own launch directory.
let lastProjectDir: string | null = null;

function projectSettingsDir(proj: string): string {
  return path.join(proj, ".pi", "settings");
}
function projectTeamsYamlPath(proj: string): string {
  return path.join(projectSettingsDir(proj), "agents", "teams.yaml");
}
function projectAgentConfigPath(proj: string): string {
  return path.join(projectSettingsDir(proj), "agent-team-config.json");
}
function fileExists(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
/** Read path for teams.yaml for a project: project-local when present, else
 *  the global agent-dir copy. Mirrors the extension's teamsYamlPath(). */
function readTeamsPathFor(proj: string): string {
  const p = projectTeamsYamlPath(proj);
  return fileExists(p) ? p : TEAMS_YAML;
}
/** Read path for agent-team-config.json for a project: project-local when
 *  present, else the global agent-dir copy. Mirrors loadPersistedConfig(). */
function readAgentConfigPathFor(proj: string): string {
  const p = projectAgentConfigPath(proj);
  return fileExists(p) ? p : AGENT_CONFIG;
}
/** Resolve the project directory for an agent-team request: an explicit
 *  workspace (cwd) wins, then the last project seen, then the server's launch
 *  directory. `remember=false` (used by validateCwd) never moves the cursor. */
function resolveProjectDir(cwdRaw?: string | null, remember = true): string | null {
  let proj: string | null = null;
  if (cwdRaw) {
    try {
      const abs = fs.realpathSync(path.resolve(cwdRaw));
      if (fs.statSync(abs).isDirectory()) proj = abs;
    } catch { /* not a real directory — fall through */ }
  }
  proj = proj || lastProjectDir || TERMINAL_CWD || null;
  if (proj && remember) lastProjectDir = proj;
  return proj;
}

/** Team names are written as teams.yaml top-level keys and member names as
 *  `name:` values, so validate both: anything with a newline or colon could
 *  break the file structure. Keep the accepted set identical to the parser's. */
const TEAM_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MEMBER_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
/** Model ids are written into teams.yaml as `model:` values. They are plain
 *  `provider/model` strings, so refuse anything a YAML line couldn't hold — a
 *  newline would let the value inject extra teams/members into the file. */
const MODEL_ID_RE = /^[A-Za-z0-9._:\/+@-]{1,128}$/;
function isModelId(value: string): boolean {
  return MODEL_ID_RE.test(value);
}

/** Minimal parser for the teams.yaml format used by the agent-team harness. */
function parseTeamsYaml(raw: string): { teams: Record<string, any[]>; memoryModel?: string; memoryActive?: boolean } {
  const teams: Record<string, any[]> = {};
  let memoryModel: string | undefined;
  let memoryActive: boolean | undefined;
  let curTeam: string | null = null;
  let curMember: any = null;
  let inMemory = false;

  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    // Top-level key: no leading whitespace, `key:`.
    const top = t.match(/^([A-Za-z0-9_-]+):\s*$/);
    if (top && !/^\s/.test(line)) {
      curMember = null;
      if (top[1] === "memory_model") {
        inMemory = true;
        curTeam = null;
      } else {
        inMemory = false;
        curTeam = top[1];
        // A team with no members still exists: an empty team is valid (the
        // Settings page can create one before adding subagents), so materialize
        // its empty list here or it would vanish on the next read.
        if (!teams[curTeam]) teams[curTeam] = [];
      }
      continue;
    }
    // Member list item: "- name: x", "- name" (simple), or "- agent_name".
    if (t.startsWith("- ")) {
      const rest = t.slice(2).trim();
      const simple = rest.match(/^([A-Za-z0-9_.-]+)$/);
      if (simple && !inMemory) {
        curMember = { name: simple[1] };
        if (curTeam) (teams[curTeam] = teams[curTeam] || []).push(curMember);
        continue;
      }
      const nm = rest.match(/^name:\s*(.+)$/);
      if (nm && !inMemory) {
        curMember = { name: nm[1].trim() };
        if (curTeam) (teams[curTeam] = teams[curTeam] || []).push(curMember);
        continue;
      }
      curMember = null;
      continue;
    }
    // Property line: "model: x" / "active: true" under a member or memory_model.
    const prop = t.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (prop) {
      const k = prop[1];
      const v = prop[2].trim();
      if (inMemory) {
        if (k === "model") memoryModel = v;
        else if (k === "active") memoryActive = v === "true";
      } else if (curMember) {
        if (k === "model") curMember.model = v;
        else if (k === "active") curMember.active = v === "true";
      }
    }
  }
  return { teams, memoryModel, memoryActive };
}

function loadAgentTeam(proj?: string | null): Record<string, any> {
  const out: Record<string, any> = {
    teams: {},
    teamsOrder: [],
    memoryModel: undefined,
    memoryActive: undefined,
    activeTeam: undefined,
    mode: undefined,
    enabled: true, // agent-team-config.json `enabled` master switch (default on)
    disabledAgents: [],
    orchestratorSkills: [],
    subagentSkills: [],
    skipOrchestratorTools: [],
    tools: [],
    skills: [],
    extensions: [],
    enabledModels: [],
    defaultModel: undefined,
    project: null, // resolved project dir these team settings belong to
  };
  const project = resolveProjectDir(proj, false);
  out.project = project;
  try {
    const p = parseTeamsYaml(fs.readFileSync(readTeamsPathFor(project || TERMINAL_CWD), "utf8"));
    out.teams = p.teams;
    out.teamsOrder = Object.keys(p.teams);
    out.memoryModel = p.memoryModel;
    out.memoryActive = p.memoryActive;
  } catch { /* teams.yaml absent — return empty teams */ }
  try {
    const cfg = JSON.parse(fs.readFileSync(readAgentConfigPathFor(project || TERMINAL_CWD), "utf8"));
    out.activeTeam = cfg.activeTeam;
    out.mode = cfg.mode;
    // The "agent team enabled" master switch pi honors for the team harness;
    // default on when the field is absent.
    out.enabled = cfg.enabled !== false;
    out.disabledAgents = cfg.disabledAgents || [];
    out.orchestratorSkills = cfg.orchestratorSkills || [];
    out.subagentSkills = cfg.subagentSkills || [];
    out.skipOrchestratorTools = cfg.skipOrchestratorTools || [];
    // Chat view workspaces: directories the user added explicitly, plus
    // session-derived workspaces the user removed from the list. Stored in
    // the project's own agent-team-config.json (per-project, like pi).
    out.chatWorkspaces = cfg.chatWorkspaces || [];
    out.chatWorkspacesRemoved = cfg.chatWorkspacesRemoved || [];
  } catch { /* config absent */ }

  // Models the user enabled in pi settings — the authoritative model list for
  // the Chat composer dropdown.
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_JSON, "utf8"));
    out.enabledModels = Array.isArray(settings.enabledModels) ? settings.enabledModels : [];
    out.defaultModel = settings.defaultModel;
  } catch { /* settings absent */ }

  // Skills: all discovered from the skills dir, annotated with which agent
  // group (orchestrator/subagent) currently has them enabled.
  const orchSet = new Set(out.orchestratorSkills || []);
  const subSet = new Set(out.subagentSkills || []);
  out.skills = discoverSkills().map((s) => ({
    ...s,
    orchestrator: orchSet.has(s.dir),
    subagent: subSet.has(s.dir),
  }));
  out.extensions = discoverExtensions();

  // Orchestrator tools: the web server can't query pi's live tool registry, so
  // the list is rebuilt from (a) tool names observed in captured llm_request
  // events — pi sends its ACTIVE allowlist with every provider request, so the
  // union across captures ≈ pi's allTools() — and (b) the configured skip
  // denylist (real tool names even if never observed, e.g. on a fresh machine).
  // The internal dispatch routing tools are excluded, mirroring pi's allTools().
  const ROUTING_TOOLS = new Set(["dispatch_agent", "dispatch_agents"]);
  const toolNames = new Map<string, string>(); // lowercased key → display name
  const addTool = (n: string) => {
    const key = String(n).toLowerCase();
    if (key && !ROUTING_TOOLS.has(key) && !toolNames.has(key)) toolNames.set(key, String(n));
  };
  for (const t of observedOrchestratorTools()) addTool(t);
  for (const t of out.skipOrchestratorTools) addTool(t);
  out.tools = Array.from(toolNames.values()).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return out;
}

/** Tool names seen in captured llm_request events (pi's active allowlist per
 *  provider request). Returns [] when the DB is unavailable or has no captures. */
function observedOrchestratorTools(): string[] {
  const tools: string[] = [];
  try {
    const rows = (db.prepare(
      `SELECT payload_json FROM events WHERE type = 'llm_request'`
    ).all() as Array<{ payload_json: string }>);
    for (const row of rows) {
      try {
        const p = JSON.parse(row.payload_json ?? "{}");
        if (Array.isArray(p.tools)) {
          for (const t of p.tools) if (typeof t === "string" && t.trim()) tools.push(t);
        }
      } catch { /* malformed payload — skip */ }
    }
  } catch { /* DB unavailable */ }
  return tools;
}

// ─── Settings snapshot (consolidated pi + agent-team config) ────────────────

/** Valid thinking levels, in ascending effort (pi resolves at agent start). */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Read settings.json as a plain object (absent → {}). */
function readSettingsJson(): Record<string, any> {
  try { return JSON.parse(fs.readFileSync(SETTINGS_JSON, "utf8")); } catch { return {}; }
}

/** Read agent-team-config.json as a plain object (absent → {}). */
function readAgentConfig(proj?: string | null): Record<string, any> {
  try { return JSON.parse(fs.readFileSync(readAgentConfigPathFor(proj || TERMINAL_CWD), "utf8")); } catch { return {}; }
}

/** API-key rows for the Settings page: every known key plus custom stored ones.
 *  Groq's provenance comes from stt.ts, which owns that key's full resolution
 *  (Settings → env → shell rc → speech-to-text.json) — without it a key that
 *  only lives in speech-to-text.json would look unset here. Secrets are masked. */
function apiKeysSnapshot(proj?: string | null): Record<string, any>[] {
  const entries = keyEntries();
  return entries.map((entry) => {
    if (entry.name !== "GROQ_API_KEY") return entry;
    const stt = loadSttConfig(proj || TERMINAL_CWD);
    return { ...entry, source: stt.apiKeySource, masked: stt.apiKey ? maskSecret(stt.apiKey) : "" };
  });
}

/** Full, normalized settings snapshot for the Settings page: everything the
 *  agent-team rail knows ADD the raw config fields and model metadata that are
 *  only meaningful in a fuller settings surface. A single endpoint keeps the
 *  page and the rail in sync and gives one source of truth for the UI. */
function loadSettingsSnapshot(proj?: string | null): Record<string, any> {
  const team = loadAgentTeam(proj);
  const settings = readSettingsJson();
  const cfg = readAgentConfig(proj);
  return {
    ...team,
    // API keys (stored in <agentDir>/api-keys.json; masked previews only)
    apiKeys: apiKeysSnapshot(proj),
    // Plugin registry (enable/disable state + where plugin dirs live). Feature
    // plugins are the app's views; the Settings → Plugins section toggles them.
    plugins: pluginSnapshot(),
    // Model used by Git → "generate commit message". Empty = fall back to the
    // agent's default model at generation time.
    gitCommitModel: typeof settings.gitCommitModel === "string" ? settings.gitCommitModel : "",
    // Instruction template for the same feature. Empty = built-in default; the
    // default is also returned so the Settings textarea can show it as a hint.
    gitCommitTemplate: typeof settings.gitCommitTemplate === "string" ? settings.gitCommitTemplate : "",
    gitCommitTemplateDefault: DEFAULT_COMMIT_TEMPLATE,
    // settings.json
    settingsRaw: {
      defaultModel: settings.defaultModel,
      defaultProvider: settings.defaultProvider,
      defaultThinkingLevel: settings.defaultThinkingLevel,
      theme: settings.theme,
      quietStartup: settings.quietStartup,
      doubleEscapeAction: settings.doubleEscapeAction,
      hideThinkingBlock: settings.hideThinkingBlock,
      editorPaddingX: settings.editorPaddingX,
      terminal: settings.terminal ?? {},
      compaction: settings.compaction ?? {},
      packages: Array.isArray(settings.packages) ? settings.packages : [],
    },
    // agent-team-config.json
    agentConfigRaw: {
      enabled: cfg.enabled,
      gridCols: cfg.gridCols,
      parallelDispatch: cfg.parallelDispatch,
      maxParallel: cfg.maxParallel,
      debugLevel: cfg.debugLevel,
      skipOrchestratorTools: Array.isArray(cfg.skipOrchestratorTools) ? cfg.skipOrchestratorTools : [],
      destructiveTools: Array.isArray(cfg.destructiveTools) ? cfg.destructiveTools : [],
    },
    // Shared vocabulary for form controls
    thinkingLevels: THINKING_LEVELS,
    modelsMeta: buildModelMeta(),
    // The raw teams.yaml teams/members (deduped over loadAgentTeam for editing).
    teams: team.teams ?? {},
    teamsOrder: team.teamsOrder ?? Object.keys(team.teams ?? {}),
  };
}

/** Final setter for any settings.json scalar — reused by all settings actions. */
function setSettingsField(key: string, value: unknown): void {
  updateSettingsJson((cfg) => { cfg[key] = value; });
}

/** Set a nested settings.json object path (e.g. terminal.showTerminalProgress). */
function setSettingsNested(paths: string[], value: unknown): void {
  updateSettingsJson((cfg) => {
    let node = cfg;
    for (let i = 0; i < paths.length - 1; i++) {
      if (typeof node[paths[i]] !== "object" || node[paths[i]] === null) node[paths[i]] = {};
      node = node[paths[i]];
    }
    node[paths[paths.length - 1]] = value;
  });
}

/** Parse the teams.yaml a project resolves to (project-local when present, else
 *  the global agent-dir copy). Used by the team editor to validate a write
 *  before mutating, since updateTeamsYaml's callback can't abort the request. */
function readTeams(proj: string | null): { teams: Record<string, any[]>; memoryModel?: string; memoryActive?: boolean } {
  try { return parseTeamsYaml(fs.readFileSync(readTeamsPathFor(proj || TERMINAL_CWD), "utf8")); }
  catch { return { teams: {} }; }
}

/** Set a list-valued agent-team-config.json field (destructiveTools / skipOrchestratorTools). */
function setAgentConfigList(proj: string | null, key: string, values: string[]): void {
  updateAgentConfig(proj, (cfg) => { cfg[key] = Array.isArray(values) ? values : []; });
}

// ─── Settings / skills / extensions discovery ───────────────────────────────

/** Parse a settings.json `extensions` entry into { path, enabled }.
 *  Entries look like "+extensions/agent-team/index.ts" or "-extensions/obscura/index.ts". */
function parseExtensionEntry(entry: string): { path: string; enabled: boolean } | null {
  const m = entry.match(/^([-+]?)(extensions?\/.+)$/);
  if (!m) return null;
  return { path: m[2], enabled: m[1] !== "-" };
}

/** Parse a settings.json `skills` entry into { name, disabled }.
 *  Entries look like "-skills/flet/SKILL.md" or "+skills/electron-scaffold/SKILL.md". */
function parseSkillSettingEntry(entry: string): { name: string; disabled: boolean } | null {
  const m = entry.match(/^([-+]?)skills\/([^/]+)\/SKILL\.md$/);
  if (!m) return null;
  return { name: m[2], disabled: m[1] === "-" };
}

/** Read settings.json extensions list and return normalized entries, each
 *  annotated with whether its file actually exists on disk (`available`).
 *  Relative entries resolve against the agent dir (pi's extension layout);
 *  absolute entries are used as-is. Entries whose file is missing (moved,
 *  deleted, mistyped) can't be loaded by pi, so UIs skip them instead of
 *  showing dead toggles. */
function discoverExtensions(): { path: string; enabled: boolean; name: string; available: boolean }[] {
  let list: string[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_JSON, "utf8"));
    list = Array.isArray(raw?.extensions) ? raw.extensions : [];
  } catch { /* settings absent */ }
  const out: { path: string; enabled: boolean; name: string; available: boolean }[] = [];
  for (const entry of list) {
    const parsed = parseExtensionEntry(String(entry));
    if (!parsed) continue;
    const base = path.basename(parsed.path);
    // index.ts → use the directory name (e.g. agent-team); otherwise the file base name.
    const name = base === "index.ts" ? path.basename(path.dirname(parsed.path)) : base.replace(/\.ts$/, "");
    const abs = path.isAbsolute(parsed.path) ? parsed.path : path.join(AGENT_DIR, parsed.path);
    let available = false;
    try { available = fs.statSync(abs).isFile(); } catch { /* file missing */ }
    out.push({ path: parsed.path, enabled: parsed.enabled, name, available });
  }
  return out;
}

/** Scan the skills dir for SKILL.md frontmatter, returning all skills with
 *  whether they are currently enabled at the settings.json level. */
function discoverSkills(): { name: string; dir: string; description: string; settingsEnabled: boolean }[] {
  const disabled = new Set<string>();
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_JSON, "utf8"));
    const list: string[] = Array.isArray(raw?.skills) ? raw.skills : [];
    for (const entry of list) {
      const parsed = parseSkillSettingEntry(String(entry));
      if (parsed?.disabled) disabled.add(parsed.name);
    }
  } catch { /* settings absent */ }
  const out: { name: string; dir: string; description: string; settingsEnabled: boolean }[] = [];
  if (!fs.existsSync(SKILLS_DIR)) return out;
  for (const f of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!f.isDirectory()) continue;
    const md = path.join(SKILLS_DIR, f.name, "SKILL.md");
    if (!fs.existsSync(md)) continue;
    let name = f.name, description = "";
    try {
      const raw = fs.readFileSync(md, "utf8");
      const fm = raw.match(/^---\s*\n([\s\S]*?)\n---\s*/);
      if (fm) {
        for (const line of fm[1].split("\n")) {
          const i = line.indexOf(":");
          if (i > 0) {
            const k = line.slice(0, i).trim();
            const v = line.slice(i + 1).trim();
            if (k === "name") name = v;
            else if (k === "description") description = v;
          }
        }
      }
    } catch { /* skip unreadable */ }
    out.push({ name, dir: f.name, description, settingsEnabled: !disabled.has(f.name) });
  }
  return out;
}

// ─── Config persistence (teams.yaml / agent-team-config.json / settings.json) ─

function serializeTeamsYaml(data: { teams: Record<string, any[]>; memoryModel?: string; memoryActive?: boolean }): string {
  const lines: string[] = [];
  if (data.memoryModel) {
    lines.push("memory_model:");
    lines.push(`  model: ${data.memoryModel}`);
    lines.push(`  active: ${data.memoryActive === true ? "true" : "false"}`);
    lines.push("");
  }
  for (const [teamName, members] of Object.entries(data.teams || {})) {
    lines.push(`${teamName}:`);
    for (const m of members) {
      lines.push(`  - name: ${m.name}`);
      if (m.model) lines.push(`    model: ${m.model}`);
      if (m.active === false) lines.push(`    active: false`);
    }
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

function updateTeamsYaml(proj: string | null, mutate: (p: { teams: Record<string, any[]>; memoryModel?: string; memoryActive?: boolean }) => void): void {
  const readPath = readTeamsPathFor(proj || TERMINAL_CWD);
  let parsed: { teams: Record<string, any[]>; memoryModel?: string; memoryActive?: boolean };
  try {
    parsed = parseTeamsYaml(fs.readFileSync(readPath, "utf8"));
  } catch {
    parsed = { teams: {} };
  }
  mutate(parsed);
  const writePath = proj ? projectTeamsYamlPath(proj) : projectTeamsYamlPath(TERMINAL_CWD);
  fs.mkdirSync(path.dirname(writePath), { recursive: true });
  fs.writeFileSync(writePath, serializeTeamsYaml(parsed));
}

function updateAgentConfig(proj: string | null, mutate: (cfg: any) => void): void {
  const readPath = readAgentConfigPathFor(proj || TERMINAL_CWD);
  let cfg: any = {};
  try { cfg = JSON.parse(fs.readFileSync(readPath, "utf8")); } catch { /* absent */ }
  mutate(cfg);
  const writePath = proj ? projectAgentConfigPath(proj) : projectAgentConfigPath(TERMINAL_CWD);
  fs.mkdirSync(path.dirname(writePath), { recursive: true });
  fs.writeFileSync(writePath, JSON.stringify(cfg, null, 2) + "\n");
}

function updateSettingsJson(mutate: (cfg: any) => void): void {
  let cfg: any = {};
  try { cfg = JSON.parse(fs.readFileSync(SETTINGS_JSON, "utf8")); } catch { /* absent */ }
  mutate(cfg);
  // The agent dir may not exist yet (fresh machine, SCOPE_SETTINGS_JSON pointed
  // at a new path) — mirror what the teams/config writers do.
  fs.mkdirSync(path.dirname(SETTINGS_JSON), { recursive: true });
  fs.writeFileSync(SETTINGS_JSON, JSON.stringify(cfg, null, 2) + "\n");
}

// ─── Chat footer (pi custom-footer port) ───────────────────────────────────
// Mirrors the pi terminal's custom-footer extension in the Chat composer:
// model/thinking, token stats, cost, context bar, elapsed, cwd, git branch,
// provider pricing, and opencode-go rolling $ usage. The go-usage values come
// from the same live endpoint the pi footer uses, refreshed at most once a
// minute, with local DB $ sums as fallback until the fetch lands.
const MODELS_STORE = process.env.SCOPE_MODELS_STORE ?? path.join(AGENT_DIR, "models-store.json");
const AUTH_JSON = process.env.SCOPE_AUTH_JSON ?? path.join(AGENT_DIR, "auth.json");
const GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const GO_USAGE_TTL = 60_000;
const GO_LIMITS: Record<"h5" | "wk" | "mo", number> = { h5: 12, wk: 30, mo: 60 };
// The `kilo` provider (kilo.ai) keeps its own on-disk model cache, separate from
// models-store.json. Its models are ingested here so the Settings cost catalog
// surfaces `kilo` as an independent provider (never conflated with a model of the
// same id under another provider such as openrouter). The path mirrors the
// agent-team extension's model-cache.ts CACHE_DIR (~/.pi/kilo_Cache), which is
// the only writer of these files.
const KILO_CACHE_DIR = process.env.SCOPE_KILO_CACHE_DIR ?? path.join(os.homedir(), ".pi", "kilo_Cache");

let modelsStoreCache: { mtimeMs: number; data: Record<string, any> } | null = null;
let kiloCache: { models: any[] } | null = null;

/** Read the pi model store (~/.pi/agent/models-store.json), cached by mtime. */
function loadModelsStore(): Record<string, any> {
  try {
    const st = fs.statSync(MODELS_STORE);
    if (modelsStoreCache && modelsStoreCache.mtimeMs === st.mtimeMs) return modelsStoreCache.data;
    const data = JSON.parse(fs.readFileSync(MODELS_STORE, "utf8"));
    modelsStoreCache = { mtimeMs: st.mtimeMs, data };
    return data;
  } catch {
    return {};
  }
}

/** Read the kilo provider's model cache (~/.pi/kilo_Cache/kilo-models.json and
 *  kilo-free-models.json). Each is a { cachedAt, data: [...] } envelope; merge
 *  the arrays. Cached in-process; a fresh read happens once per process since
 *  the caches change only when the kilo extension refreshes them at boot. */
function loadKiloModels(): any[] {
  if (kiloCache) return kiloCache.models;
  const models: any[] = [];
  for (const file of ["kilo-models.json", "kilo-free-models.json"]) {
    try {
      const env = JSON.parse(fs.readFileSync(path.join(KILO_CACHE_DIR, file), "utf8"));
      if (Array.isArray(env?.data)) models.push(...env.data);
    } catch { /* cache absent / corrupt — skip */ }
  }
  kiloCache = { models };
  return models;
}

/** Thinking levels a model supports, from its thinkingLevelMap (array form, or
 *  object map whose non-null values are supported). null → use pi's default. */
function thinkingLevelsFor(m: any): string[] | null {
  const map = m?.thinkingLevelMap;
  if (Array.isArray(map)) return map;
  if (map && typeof map === "object") {
    const keys = Object.keys(map).filter((k) => map[k] !== null && map[k] !== undefined);
    return keys.length ? keys : null;
  }
  return null;
}

/** Flatten the store + kilo cache into { "<provider>/<id>": { provider, contextWindow, maxTokens, cost, thinkingLevels } }. */
function buildModelMeta(): Record<string, any> {
  const out: Record<string, any> = {};
  const store = loadModelsStore();
  for (const [provider, entry] of Object.entries(store) as [string, any][]) {
    for (const m of entry?.models ?? []) {
      if (!m?.id) continue;
      out[`${provider}/${m.id}`] = {
        provider,
        contextWindow: m.contextWindow ?? 0,
        maxTokens: m.maxTokens ?? 0,
        cost: m.cost ?? {},
        thinkingLevels: thinkingLevelsFor(m),
      };
    }
  }
  // `kilo` is an independent provider whose models live in its own cache, not
  // models-store.json. Register them under the `kilo/` key so they show up in
  // the cost catalog as a provider of their own — distinct from any same-id
  // model that another provider (e.g. openrouter) happens to expose.
  for (const m of loadKiloModels()) {
    if (!m?.id) continue;
    out[`kilo/${m.id}`] = {
      provider: "kilo",
      contextWindow: m.contextWindow ?? 0,
      maxTokens: m.maxTokens ?? 0,
      cost: m.cost ?? {},
      thinkingLevels: thinkingLevelsFor(m),
    };
  }
  return out;
}

/** opencode-go $ usage in the 5h/7d/30d rolling windows from the DB (fallback). */
function goUsageFromDb(now: number): { h5: number; wk: number; mo: number } {
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const sum = (msAgo: number): number => {
    try {
      const row = q.getProviderCostSince.get({ $provider: "opencode-go", $since: iso(msAgo) }) as any;
      return row?.cost ?? 0;
    } catch { return 0; }
  };
  return { h5: sum(5 * 3600 * 1000), wk: sum(7 * 24 * 3600 * 1000), mo: sum(30 * 24 * 3600 * 1000) };
}

/** Seconds until a usage window resets; -1 when unknown (countdown omitted). */
function goResetSeconds(w: any): number {
  const dump = w?.resetsAt ?? w?.resetAt;
  if (typeof dump === "string") {
    const t = Date.parse(dump);
    if (!Number.isNaN(t)) return Math.max(0, Math.floor((t - Date.now()) / 1000));
  }
  const raw = w?.resetInSec ?? w?.resetSec ?? w?.resetsIn ?? w?.secondsUntilReset;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : -1;
}

let goApiUsage: { h5: { pct: number; resetSec: number }; wk: { pct: number; resetSec: number }; mo: { pct: number; resetSec: number } } | null = null;
let goApiFetchedAt = 0;

/** Live /zen/go/v1/usage refresh (Bearer opencode-go key). Best-effort. */
async function refreshGoApiUsage(): Promise<void> {
  const now = Date.now();
  if (now - goApiFetchedAt < GO_USAGE_TTL) return;
  goApiFetchedAt = now; // re-attempt after the TTL even on failure
  try {
    let key = "";
    try {
      key = JSON.parse(fs.readFileSync(AUTH_JSON, "utf8"))?.["opencode-go"]?.key ?? "";
    } catch { /* auth absent */ }
    if (!key) return;
    const res = await fetch(GO_USAGE_URL, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return;
    const data = await res.json();
    const u = data?.usage;
    if (!u) return;
    goApiUsage = {
      h5: { pct: Number(u.rolling?.percent ?? -1), resetSec: goResetSeconds(u.rolling) },
      wk: { pct: Number(u.weekly?.percent ?? -1), resetSec: goResetSeconds(u.weekly) },
      mo: { pct: Number(u.monthly?.percent ?? -1), resetSec: goResetSeconds(u.monthly) },
    };
  } catch { /* keep last known values; retry after the TTL */ }
}

/** Percent of the rolling $ limit per window (live endpoint, else DB sums). */
function computeGoUsage(): Record<string, { pct: number; resetSec: number }> {
  const now = Date.now();
  const fallback = goUsageFromDb(now);
  const pctFor = (key: "h5" | "wk" | "mo"): number => {
    if (goApiUsage && goApiUsage[key].pct >= 0) return goApiUsage[key].pct;
    return fallback[key] > 0 ? Math.min(100, (fallback[key] / GO_LIMITS[key]) * 100) : 0;
  };
  const resetFor = (key: "h5" | "wk" | "mo"): number => (goApiUsage ? goApiUsage[key].resetSec : -1);
  return {
    h5: { pct: pctFor("h5"), resetSec: resetFor("h5") },
    wk: { pct: pctFor("wk"), resetSec: resetFor("wk") },
    mo: { pct: pctFor("mo"), resetSec: resetFor("mo") },
  };
}

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

// External IPv4 addresses a phone on the same Wi-Fi could actually reach.
// Filters out loopback/internal and non-IPv4 interfaces, and prefers a
// routable-looking address over docker/bridge ranges when several exist.
function lanIpv4Addrs(): string[] {
  const all = Object.values(os.networkInterfaces())
    .flatMap((ifaces) => ifaces ?? [])
    .filter((i) => i.family === "IPv4" && !i.internal && !i.address.startsWith("169.254."));
  const isVirtual = (ip: string) => ip.startsWith("172.17.") || ip.startsWith("192.168.56.") || ip.startsWith("10.0.2.");
  return [...new Set([...all.filter((i) => !isVirtual(i.address)), ...all.filter((i) => isVirtual(i.address))])]
    .map((i) => i.address);
}

const tokenMasked = AUTH_TOKEN.length > 8 ? `${AUTH_TOKEN.slice(0,4)}…${AUTH_TOKEN.slice(-4)}` : "****";
console.log(`\n  pi-scope server v${VERSION}`);
console.log(`  UI:    ${OPEN_URL}`);
console.log(`  Token: ${tokenMasked}`);
console.log(`  DB:    ${DB_PATH}`);
if (LAN_EXPOSED) {
  // A wildcard bind prints a useless 0.0.0.0 URL, so resolve a real LAN address
  // for the phone. Skip internal/loopback and non-IPv4 interfaces — a phone
  // cannot route to 127.0.0.1 or a docker bridge.
  const lanIps = lanIpv4Addrs();
  if (lanIps.length === 0) {
    console.log("  LAN:   no external IPv4 interface found — reachable on loopback only.");
  } else {
    console.log(`  LAN:   ${lanIps.map((ip) => `http://${ip}:${PORT}/?token=${encodeURIComponent(AUTH_TOKEN)}`).join("\n         ")}`);
    console.log("         (open on a phone on the same Wi-Fi; token required)");
  }
}
console.log("");

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

// One encoder for the process — this used to allocate a TextEncoder on every
// push, for every subscriber, for every event.
const sseEncoder = new TextEncoder();

// A backlog this deep means the client stopped draining (dead socket, frozen
// tab). `desiredSize` reports against the stream's 1-chunk high-water mark and
// goes negative as soon as a *burst* queues a second chunk, so the previous
// `desiredSize < 0` test dropped healthy subscribers mid-burst — the live
// stream disappeared and had to reconnect. Only a genuinely abandoned socket is
// evicted now.
const SSE_MAX_BACKLOG = 4096;

/** Push an SSE-formatted event to one subscriber. Returns false if closed. */
function pushSSE(sub: SSESubscriber, data: string): boolean {
  try {
    const size = sub.controller.desiredSize;
    if (size !== null && size < -SSE_MAX_BACKLOG) {
      removeSubscriber(sub.id);
      return false;
    }
    sub.controller.enqueue(sseEncoder.encode(data));
    return true;
  } catch {
    removeSubscriber(sub.id);
    return false;
  }
}

/** Broadcast an event to all SSE subscribers matching the event's pool/tags/session. */
function broadcastEvent(event: ObsEvent) {
  // Plugin hook: every ingested event reaches subscribed plugins, whether or
  // not a browser is connected over SSE.
  emitPluginEvent(event);
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

/** Constant-time token comparison. The token is a per-run secret that gates a
 *  real shell, and a plain `===` short-circuits on the first differing byte —
 *  measurable from the same machine, which on a loopback bind is enough to
 *  recover it byte by byte. */
function tokenMatches(candidate: string | null): boolean {
  if (!candidate) return false;
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(AUTH_TOKEN, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function checkAuth(req: Request): boolean {
  // Check Authorization header
  const auth = req.headers.get("authorization");
  if (auth) {
    const parts = auth.split(" ");
    if (parts.length === 2 && parts[0].toLowerCase() === "bearer") return tokenMatches(parts[1]);
    return false;
  }
  // Check ?token= query param
  return tokenMatches(new URL(req.url).searchParams.get("token"));
}

/**
 * True when a request either carries no Origin (a non-browser client: the pi
 * extension, curl, the launcher's health poll) or an Origin that is this
 * server's own.
 *
 * Browsers attach Origin to every POST — same-origin included — so requiring it
 * to match closes CSRF against the routes that sit above the auth wall because
 * they trust the caller's loopback *address* (`POST /shutdown`, `POST /events`,
 * `/capture/*`). A page the user merely visits can still have the browser
 * deliver a "simple" cross-origin POST (no preflight, and the attacker cannot
 * read the reply — but the side effect happens: forged telemetry, a killed
 * server). Those routes are legitimately reachable without the token, so the
 * Origin has to be the thing that proves who is asking.
 */
function originSameServer(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  // A LAN-bound server is reached at an address the ALLOWED_ORIGINS set (built
  // from HOST = 0.0.0.0) can't name, so accept the Host the client actually
  // used. "null" (sandboxed/opaque origins) never matches and is refused.
  const host = req.headers.get("host");
  return !!host && (origin === `http://${host}` || origin === `https://${host}`);
}

/** Parse a non-negative integer query param, clamped to `max`; `def` when
 *  absent or malformed. A malformed value used to reach SQLite as NaN and fail
 *  the whole request with "datatype mismatch" (LIMIT ?). */
function intParam(url: URL, name: string, def: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === "") return def;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return def;
  return Math.min(n, max);
}

/** Parse an integer query param; null when absent or malformed (never NaN). */
function intOrNull(url: URL, name: string): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === "") return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Ingest a single event: insert into DB, upsert session, broadcast to SSE (or
 * hand the stored event to a batch's `emit` callback — see ingestBatch).
 * Returns the event_id if ingested, null if duplicate.
 */
function ingestEvent(event: ObsEvent, emit?: (e: ObsEvent) => void): string | null {
  // pi can hand a resumed conversation a fresh session id while it keeps writing
  // to the SAME session file — attribute the event to the row that owns that
  // file, so a resumed session's turns never appear under a second session.
  const canonical = canonicalSessionId(q, event);
  let effective = canonical !== event.session_id ? { ...event, session_id: canonical } : event;
  let result = q.insertEvent.run(toRow(effective));

  // A no-op insert means (session_id, seq) already exists. Two cases:
  //   1. Idempotent retry — the same event_id is already stored. Keep the
  //      no-op (returning null) so a batch re-POST never duplicates rows.
  //   2. Seq collision — a resumed session's counter raced its server seed,
  //      restarted at 0, and collided with the stored sequence. Renumber to
  //      the next free seq and retry, so continued turns are NEVER silently
  //      dropped (previously they were, leaving transcripts stuck at the
  //      original data).
  if (result.changes === 0) {
    const dup = q.getEventById.get({ $event_id: effective.event_id });
    if (dup) return null;
    const maxRow: any = q.getMaxSeq.get({ $session_id: effective.session_id });
    const next = (maxRow?.max_seq ?? -1) + 1;
    // Keep `effective` (not the raw `event`): re-expanding from the original
    // event here dropped the canonical session id, so a seq-collision retry on
    // a resumed subprocess filed the continued turn under the subprocess's own
    // fresh session id instead of the row that owns its session file — a
    // second, phantom session showing another session's messages.
    effective = { ...effective, seq: next };
    result = q.insertEvent.run(toRow(effective));
  }

  const isNew = result.changes > 0;

  // Bump event_count only for genuinely new events; duplicates (INSERT OR
  // IGNORE no-op) just refresh the session row without inflating the count.
  q.upsertSession.run(toSessionRow(effective, isNew));

  if (isNew) {
    // Inside a batch the caller collects events and broadcasts them after
    // COMMIT, so a failed transaction can never publish what it didn't store.
    if (emit) emit(effective);
    else broadcastEvent(effective);
  }

  return isNew ? effective.event_id : null;
}

/**
 * Run a multi-event ingest inside ONE SQLite transaction.
 *
 * Every statement otherwise commits on its own: in WAL mode each commit is its
 * own durable write, so a full 50-event batch from the extension cost up to
 * 100 commits. The whole batch is a single one now, and its SSE frames are
 * emitted only after the transaction lands.
 *
 * The callback MUST be synchronous — nothing else may interleave on the shared
 * connection while the transaction is open.
 */
function ingestBatch(fn: (emit: (e: ObsEvent) => void) => void): void {
  const pending: ObsEvent[] = [];
  db.exec("BEGIN");
  try {
    fn((e) => { pending.push(e); });
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* connection already unwound */ }
    throw err;
  }
  for (const e of pending) broadcastEvent(e);
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

/**
 * In-memory cache for static assets, validated per request by mtime + size.
 *
 * This runs on every page load and used to read each file from disk (the two
 * vendor fonts plus the xterm bundle are ~1.5 MB) and answer with no validator
 * at all, so a browser re-downloaded the lot every time. The body is now read
 * once and re-read only when the file actually changes — the dev server runs
 * under `node --watch`, so edits are still picked up immediately — and every
 * response carries an ETag + `no-cache`, so a reload costs one revalidation
 * instead of a full body transfer.
 */
type StaticEntry = { body: Uint8Array; mime: string; mtimeMs: number; size: number };
const staticCache = new Map<string, StaticEntry>();

function serveStatic(relPath: string, req?: Request): Response | null {
  // Remove leading slash and strip path-traversal segments (defense in depth).
  const safe = relPath.replace(/^\/+/, "").replace(/\.\./g, "");
  const publicRoot = path.resolve(import.meta.dirname, "public");
  const filePath = path.resolve(publicRoot, safe);
  // Refuse anything that escapes the public root.
  if (filePath !== publicRoot && !filePath.startsWith(publicRoot + path.sep)) return null;

  // One stat replaces the old existsSync + statSync pair, and carries the
  // size/mtime the cache and the validators are keyed on.
  let st: fs.Stats;
  try {
    st = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;

  // (size, mtime) is enough to identify the representation: byte-exact for any
  // given pair, and it changes the moment a file is rewritten (including by a
  // `node --watch` restart-editing editor).
  const etag = `"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`;
  const baseHeaders: Record<string, string> = {
    etag,
    "cache-control": "no-cache",
    "last-modified": st.mtime.toUTCString(),
    "access-control-allow-origin": "*",
  };

  if (req) {
    const inm = req.headers.get("if-none-match");
    if (inm && inm.split(",").some((v) => v.trim() === etag)) {
      return new Response(null, { status: 304, headers: baseHeaders });
    }
  }

  let entry = staticCache.get(filePath);
  if (!entry || entry.mtimeMs !== st.mtimeMs || entry.size !== st.size) {
    entry = {
      body: fs.readFileSync(filePath),
      // extname, not lastIndexOf("."): a dot in a directory name (e.g.
      // "vendor/x.term/app.js") used to select the wrong MIME type.
      mime: MIME[path.extname(safe) || ".html"] ?? "application/octet-stream",
      mtimeMs: st.mtimeMs,
      size: st.size,
    };
    staticCache.set(filePath, entry);
  }
  return new Response(entry.body, {
    headers: { ...baseHeaders, "content-type": entry.mime },
  });
}

/**
 * Serve index.html, propagating a cache-bust marker to the page's local assets.
 *
 * The Chat button hard-reloads the app with `?_=<ts>` so a stale Electron
 * renderer can never keep running old chat JS/CSS. Adding the marker to the
 * document URL alone is not enough — subresources keep their own URLs and would
 * still be served from cache — so every local `src=`/`href=` in the HTML is
 * tagged with the same marker. That makes each one a URL the browser has never
 * cached, forcing a network fetch. The HTML itself is `no-store` for the same
 * reason. Without the marker this is a plain (ETag-revalidated) static read.
 */
async function serveIndex(req: Request, url: URL): Promise<Response | null> {
  const bust = url.searchParams.get("_");
  if (!bust) return serveStatic("index.html", req);
  const base = serveStatic("index.html");
  if (!base) return null;
  const html = (await base.text()).replace(
    /\b(src|href)="([^"#?]+)"/g,
    (m, attr, val) =>
      // Leave absolute paths, protocol-relative and scheme URLs (data:, http:…) alone.
      /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(val)
        ? m
        : `${attr}="${val}?_=${encodeURIComponent(bust)}"`,
  );
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
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

// Default file-system sandbox for /files/* and /checkpoints/* endpoints.
// When SCOPE_FILE_ROOT is not set, operations are restricted to the directory
// that contains the terminal's launch directory. In dev the terminal launches
// at the project root, so sibling projects in the same workspace are allowed.
// In packaged mode the terminal launches at $HOME, so the whole home directory
// is allowed. Set SCOPE_FILE_ROOT to a comma-separated list of allowed roots
// (e.g. "/home/user/projects,/home/user/work") to override this.
const DEFAULT_FILE_ROOT = process.env.SCOPE_PACKAGED ? TERMINAL_CWD : path.dirname(TERMINAL_CWD);

// Live current working directories reported by connected terminal sessions.
// validateCwd uses these so the Files/Checkpoints views can follow the user
// wherever the terminal navigates, without requiring SCOPE_FILE_ROOT.
const liveTerminalCwds = new Map<WebSocket, string>();

/**
 * Validate `cwd`: must exist as a real directory (symlinks resolved). When
 * SCOPE_FILE_ROOT is set (comma-separated allowlist), the cwd must lie within
 * one of those roots. Otherwise it must lie within the project root. Returns
 * the resolved absolute path, or null if invalid or disallowed. This stops
 * the /files/* and /checkpoints/* endpoints from trusting an arbitrary
 * caller-supplied absolute path.
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
  const rawRoots = process.env.SCOPE_FILE_ROOT ?? DEFAULT_FILE_ROOT;
  const roots = rawRoots
    .split(",").map((s) => s.trim()).filter(Boolean)
    .map((s) => { try { return fs.realpathSync(path.resolve(s)); } catch { return null; } })
    .filter((s): s is string => s !== null);
  let ok = roots.some((r) => abs === r || abs.startsWith(r + path.sep));
  // Also allow any directory that a connected terminal has reported as its live
  // cwd, so the file root follows the terminal even when it leaves the default
  // sandbox (e.g. switching to another project).
  if (!ok) {
    ok = Array.from(liveTerminalCwds.values()).some((cwd) => {
      const live = path.resolve(cwd);
      return abs === live || abs.startsWith(live + path.sep);
    });
  }
  // Also allow directories the user explicitly added as chat workspaces in the
  // Chat view (persisted in the current project's agent-team-config.json —
  // per-project, like pi). The project context is the last one seen or the
  // server's launch directory; never moves the project cursor here.
  if (!ok) {
    try {
      const cfgProj = lastProjectDir || TERMINAL_CWD || AGENT_DIR;
      const cfg = JSON.parse(fs.readFileSync(readAgentConfigPathFor(cfgProj), "utf8"));
      const extras: string[] = cfg.chatWorkspaces || [];
      ok = extras.some((r) => {
        const live = path.resolve(r);
        return abs === live || abs.startsWith(live + path.sep);
      });
    } catch { /* config absent */ }
  }
  if (!ok) return null;
  return abs;
}/** Default instructions for Git → “✨ generate”, substituted into the prompt
 *  sent to the model. Settings → Models can override this with a custom
 *  template; the following placeholders are replaced server-side:
 *    {{branch}}  current branch (or "(detached)")
 *    {{source}}  "staged" | "working tree"
 *    {{files}}   changed file paths, one per line
 *    {{diff}}    the unified diff (clipped to a safe size for argv) */
const DEFAULT_COMMIT_TEMPLATE =
  "Write a git commit message for the change below.\n" +
  "Rules: follow Conventional Commits (type(scope): summary). One imperative subject line, " +
  "at most 72 characters, no trailing period. Add a short body only when it earns its place. " +
  "Return the commit message text only — no code fences, no commentary, no quotes.\n\n" +
  "Branch: {{branch}}\n" +
  "Changes ({{source}}):\n{{diff}}";

/** Build inline `-c key=value` config args so git commands never touch the
 *  user's global or local git config. */
function gitConfigArgs(config: Record<string, string>): string[] {
  return Object.entries(config).flatMap(([k, v]) => ["-c", `${k}=${v}`]);
}

/**
 * Run a git command without throwing — returns { ok, out } where `out` carries
 * stdout on success and stdout+stderr on failure. Used by the Git GUI so a
 * failed push/pull/merge surfaces its real message instead of a 500. Remote
 * ops get GIT_TERMINAL_PROMPT=0 so a credential prompt can never hang the
 * request (it fails fast with "could not read Username" instead).
 */
function gitTry(cwd: string, args: string[], config: Record<string, string> = {}, timeoutMs = 30_000): { ok: boolean; out: string } {
  const configArgs = gitConfigArgs(config);
  try {
    const out = execFileSync("git", ["-C", cwd, ...configArgs, ...args], {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { ok: true, out: typeof out === "string" ? out : out.toString() };
  } catch (err: any) {
    const stdout = typeof err?.stdout === "string" ? err.stdout : (err?.stdout ? err.stdout.toString() : "");
    const stderr = typeof err?.stderr === "string" ? err.stderr : (err?.stderr ? err.stderr.toString() : "");
    const msg = [stdout, stderr].filter(Boolean).join("\n").trim();
    return { ok: false, out: msg || String(err?.message ?? err).split("\n")[0] };
  }
}

/** Run a git command and return stdout; throws on failure. For call sites that
 * treat failure as exceptional (e.g. checkpoint create/restore). Local ops
 * keep the shorter 20s timeout; remote ops should call gitTry directly. */
function git(cwd: string, args: string[], config: Record<string, string> = {}): string {
  const r = gitTry(cwd, args, config, 20_000);
  if (!r.ok) throw new Error(r.out || "git command failed");
  return r.out;
}

/** Ensure `cwd` is a git repository; initialize it if needed. */
function ensureGitRepo(cwd: string): { initialized: boolean } {
  try {
    git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return { initialized: false };
  } catch {
    git(cwd, ["init"]);
    return { initialized: true };
  }
}

/** Validate an array of caller-supplied file paths stay inside `cwd`. */
function cleanPaths(absCwd: string, paths: unknown): string[] | null {
  if (!Array.isArray(paths)) return null;
  const out: string[] = [];
  for (const p of paths) {
    if (typeof p !== "string" || !p) return null;
    if (!resolveWithinCwd(absCwd, p)) return null;
    out.push(p);
  }
  return out;
}

/**
 * Reject caller-supplied values that git would read as an option.
 *
 * Every git call here passes the value as its own argv entry, so a value like
 * `-d` can't inject a second command — but it CAN become an option of the
 * command being run (`git tag -d <sha>` deletes a tag instead of creating one).
 * `/git/compare` and `/git/cat` already refuse a leading dash; this keeps the
 * rest of the Git GUI honest. `--` can't help: it ends option parsing for
 * paths, not for a ref/name argument.
 */
function rejectOptionLike(...values: string[]): boolean {
  return values.some((v) => v.startsWith("-"));
}

// ─── `git status --porcelain` parsing ───────────────────────────────────────
// The Review (files), Git and Review-diagram views each walked the same
// porcelain output with their own copy of this parsing (rename arrow form,
// workspace status classification, conflict detection). One parser now feeds
// all three.

interface PorcelainEntry {
  /** The two status columns, e.g. "M ", " M", "??", "R ". */
  code: string;
  x: string;
  y: string;
  /** Destination path (the new path for a rename). */
  path: string;
  /** Source path of a rename, else null. */
  renamedFrom: string | null;
  conflicted: boolean;
  ignored: boolean;
}

function parsePorcelainLine(raw: string): PorcelainEntry | null {
  if (!raw) return null;
  const code = raw.slice(0, 2);
  let p = raw.slice(3);
  let renamedFrom: string | null = null;
  if (code.includes("R")) {
    const mm = p.match(/^(.*?) -> (.*)$/);
    if (mm) { renamedFrom = mm[1]; p = mm[2]; }
  }
  const x = code[0], y = code[1];
  return {
    code, x, y, path: p, renamedFrom,
    conflicted: x === "U" || y === "U" || code === "AA" || code === "DD" || code === "AU" || code === "UA" || code === "DU" || code === "UD",
    ignored: code === "!!",
  };
}

/** Workspace-level status label for a porcelain entry. */
function porcelainStatus(e: PorcelainEntry): "ignored" | "untracked" | "deleted" | "added" | "renamed" | "modified" {
  if (e.ignored) return "ignored";
  if (e.code === "??") return "untracked";
  if (e.code.includes("D")) return "deleted";
  if (e.code.includes("A")) return "added";
  if (e.code.includes("R")) return "renamed";
  return "modified";
}

// ─── Review → Diagram: repository dependency graph ──────────────────────────
// Builds a module-level dependency graph from LOCAL imports, so the Review view
// can show how changed code relates to the rest of the repo. A "module" is a
// directory that contains source files; edges aggregate imports between
// directories. Third-party/package imports are ignored — only relative (and,
// for Python/Go, resolvable) imports can indicate what a change might break
// inside this repo.

const GRAPH_JS_EXTS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte"]);
const GRAPH_PY_EXTS = new Set([".py"]);
const GRAPH_GO_EXTS = new Set([".go"]);
const GRAPH_READ_EXTS = new Set([...GRAPH_JS_EXTS, ...GRAPH_PY_EXTS, ...GRAPH_GO_EXTS]);
const GRAPH_SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage", "vendor",
  ".next", ".nuxt", ".cache", ".turbo", ".parcel-cache", ".svelte-kit",
  "target", "__pycache__", ".venv", "venv", "env", ".tox", ".mypy_cache",
  ".pytest_cache", "bower_components", "jspm_packages",
]);
const GRAPH_MAX_FILES = 2500;
const GRAPH_MAX_READ_BYTES = 768 * 1024;
const GRAPH_JS_IMPORT_RES: RegExp[] = [
  /\bimport\s+(?:type\s+)?(?:[^'"`()]*?\bfrom\s*)?["'`]([^"'`]+)["'`]/g,
  /\bexport\s+(?:type\s+)?(?:[^'"`()]*?\bfrom\s*)?["'`]([^"'`]+)["'`]/g,
  /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
  /\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
];
// Extensions tried, in order, when resolving an extensionless JS/TS import.
const GRAPH_JS_RESOLVE = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".json"];

interface GraphFileNode { path: string; module: string; loc: number; imports: string[]; }
interface GraphModule {
  id: string; label: string; depth: number; files: number; loc: number;
  changedFiles: number; add: number; del: number; fanIn: number; fanOut: number;
  statuses: Record<string, number>;
}

function graphExt(rel: string): string {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}
function graphDir(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "." : rel.slice(0, i);
}
function graphModuleLabel(dir: string): string { return dir === "." ? "(root)" : dir; }

/** List source files to graph: tracked + untracked (gitignore respected), with a
 * filesystem-walk fallback when the directory is not a git repo. */
function listGraphFiles(absCwd: string): { files: string[]; truncated: boolean } {
  const raw: string[] = [];
  const r = gitTry(absCwd, ["ls-files", "-co", "--exclude-standard"]);
  if (r.ok) {
    for (const f of r.out.split("\n")) if (f) raw.push(f);
  } else {
    const walk = (dir: string, rel: string) => {
      if (raw.length >= GRAPH_MAX_FILES) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (raw.length >= GRAPH_MAX_FILES) return;
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { if (!GRAPH_SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), childRel); }
        else if (e.isFile()) raw.push(childRel);
      }
    };
    walk(absCwd, "");
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of raw) {
    if (!f || seen.has(f)) continue;
    seen.add(f);
    if (f.split("/").some((seg) => GRAPH_SKIP_DIRS.has(seg))) continue;
    if (!GRAPH_READ_EXTS.has(graphExt(f))) continue;
    out.push(f);
  }
  const truncated = out.length > GRAPH_MAX_FILES;
  return { files: truncated ? out.slice(0, GRAPH_MAX_FILES) : out, truncated };
}

/** Resolve a relative JS/TS import specifier to a repo file, if it exists. */
function resolveGraphJs(fromRel: string, spec: string, fileSet: Set<string>): string | null {
  if (!spec.startsWith(".")) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  if (fileSet.has(base)) return base;
  for (const ext of GRAPH_JS_RESOLVE) if (ext && fileSet.has(base + ext)) return base + ext;
  for (const ext of GRAPH_JS_RESOLVE) if (ext && fileSet.has(`${base}/index${ext}`)) return `${base}/index${ext}`;
  return null;
}

/** Resolve a Python dotted import (absolute or package-relative) to a repo file. */
function resolveGraphPy(fromRel: string, spec: string, fileSet: Set<string>): string | null {
  let dots = 0;
  while (dots < spec.length && spec[dots] === ".") dots++;
  const rest = spec.slice(dots).split(".").filter(Boolean);
  let baseDir = dots > 0 ? path.posix.dirname(fromRel) : ".";
  for (let k = 0; k < dots - 1; k++) baseDir = path.posix.dirname(baseDir);
  const base = rest.length ? path.posix.join(baseDir, ...rest) : baseDir;
  if (fileSet.has(base + ".py")) return base + ".py";
  if (fileSet.has(base + "/__init__.py")) return base + "/__init__.py";
  return null;
}

function readGoModule(absCwd: string): string | null {
  try {
    const m = fs.readFileSync(path.join(absCwd, "go.mod"), "utf8").match(/^\s*module\s+(\S+)/m);
    return m ? m[1] : null;
  } catch { return null; }
}

/** Resolve a Go import path to a directory anchor inside this repo. */
function resolveGraphGo(fromRel: string, spec: string, goModule: string | null, dirIndex: Map<string, string>): string | null {
  let rel: string | null = null;
  if (goModule && (spec === goModule || spec.startsWith(goModule + "/"))) {
    rel = spec === goModule ? "." : spec.slice(goModule.length + 1);
  } else if (spec.startsWith(".")) {
    rel = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  }
  if (rel == null) return null;
  const anchor = dirIndex.get(rel);
  if (!anchor || anchor === fromRel) return null;
  return anchor;
}

/** Extract resolved local imports from one source file (best-effort per language). */
function extractGraphImports(rel: string, text: string, fileSet: Set<string>, dirIndex: Map<string, string>, goModule: string | null): string[] {
  const ext = graphExt(rel);
  const out = new Set<string>();
  const add = (p: string | null) => { if (p && p !== rel) out.add(p); };
  if (GRAPH_JS_EXTS.has(ext)) {
    for (const re of GRAPH_JS_IMPORT_RES) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) add(resolveGraphJs(rel, m[1], fileSet));
    }
  } else if (GRAPH_PY_EXTS.has(ext)) {
    let m: RegExpExecArray | null;
    const fromRe = /^\s*from\s+([.\w]+)\s+import\b/gm;
    while ((m = fromRe.exec(text))) add(resolveGraphPy(rel, m[1], fileSet));
    const impRe = /^\s*import\s+([.\w]+)/gm;
    while ((m = impRe.exec(text))) add(resolveGraphPy(rel, m[1].split(".")[0], fileSet));
  } else if (GRAPH_GO_EXTS.has(ext)) {
    let m: RegExpExecArray | null;
    const blockRe = /import\s*\(([\s\S]*?)\)/g;
    while ((m = blockRe.exec(text))) {
      const lineRe = /["`]([^"`]+)["`]/g;
      let n: RegExpExecArray | null;
      while ((n = lineRe.exec(m[1]))) add(resolveGraphGo(rel, n[1], goModule, dirIndex));
    }
    const oneRe = /^\s*import\s+(?:\w+\s+)?["`]([^"`]+)["`]/gm;
    while ((m = oneRe.exec(text))) add(resolveGraphGo(rel, m[1], goModule, dirIndex));
  }
  return [...out];
}

/** Build the module dependency graph + change overlay for the Review diagram. */
function buildRepoGraph(absCwd: string): unknown {
  const { files, truncated } = listGraphFiles(absCwd);
  const fileSet = new Set(files);
  const dirIndex = new Map<string, string>();
  for (const f of files) { const d = graphDir(f); if (!dirIndex.has(d)) dirIndex.set(d, f); }
  const goModule = readGoModule(absCwd);

  // ── Changed files (status + churn), so the graph can overlay "what moved". ─
  const statusMap = new Map<string, string>();
  const numstat = new Map<string, { add: number; del: number }>();
  const st = gitTry(absCwd, ["status", "--porcelain", "-uall"]);
  if (st.ok) {
    for (const raw of st.out.split("\n")) {
      const e = parsePorcelainLine(raw);
      if (e) statusMap.set(e.path, porcelainStatus(e));
    }
  }
  // HEAD-relative numstat captures both staged and unstaged churn; fall back to
  // the index-relative diff for a repo with no commits yet.
  const headNs = gitTry(absCwd, ["diff", "HEAD", "--numstat"]);
  const nsOut = headNs.ok ? headNs.out : gitTry(absCwd, ["diff", "--numstat"]).out;
  for (const line of (nsOut || "").split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    numstat.set(parts.slice(2).join("\t"), {
      add: parts[0] === "-" ? 0 : parseInt(parts[0], 10) || 0,
      del: parts[1] === "-" ? 0 : parseInt(parts[1], 10) || 0,
    });
  }

  // ── Read + parse source files. ──────────────────────────────────────────
  const nodes = new Map<string, GraphFileNode>();
  let totalBytes = 0;
  for (const rel of files) {
    let text = "";
    try {
      const abs = path.join(absCwd, rel);
      const s = fs.statSync(abs);
      if (s.size <= GRAPH_MAX_READ_BYTES && totalBytes + s.size <= 64 * 1024 * 1024) {
        text = fs.readFileSync(abs, "utf8");
        totalBytes += s.size;
      }
    } catch { /* unreadable — keep the node, no edges */ }
    nodes.set(rel, {
      path: rel,
      module: graphDir(rel),
      loc: text ? text.split("\n").length : 0,
      imports: text ? extractGraphImports(rel, text, fileSet, dirIndex, goModule) : [],
    });
  }
  // Changed non-source files (README, config…) still highlight their module.
  for (const p of statusMap.keys()) {
    if (!nodes.has(p)) nodes.set(p, { path: p, module: graphDir(p), loc: 0, imports: [] });
  }

  // ── Aggregate file edges into module edges + file fan-in. ───────────────
  const modFiles = new Map<string, GraphFileNode[]>();
  for (const n of nodes.values()) {
    const arr = modFiles.get(n.module) || [];
    arr.push(n);
    modFiles.set(n.module, arr);
  }
  const moduleIds = new Set(modFiles.keys());
  const edgeWeight = new Map<string, number>();
  const fileFanIn = new Map<string, number>();
  const fileEdgeSet = new Set<string>();
  for (const n of nodes.values()) {
    for (const imp of n.imports) {
      if (imp === n.path || !moduleIds.has(graphDir(imp))) continue;
      fileFanIn.set(imp, (fileFanIn.get(imp) || 0) + 1);
      if (fileEdgeSet.size < 6000) fileEdgeSet.add(n.path + "\u0000" + imp);
      const toMod = graphDir(imp);
      if (toMod === n.module) continue;
      const key = n.module + "\u0000" + toMod;
      edgeWeight.set(key, (edgeWeight.get(key) || 0) + 1);
    }
  }
  const fanInMod = new Map<string, number>();
  const fanOutMod = new Map<string, number>();
  for (const key of edgeWeight.keys()) {
    const [a, b] = key.split("\u0000");
    fanOutMod.set(a, (fanOutMod.get(a) || 0) + 1);
    fanInMod.set(b, (fanInMod.get(b) || 0) + 1);
  }

  const modules: GraphModule[] = [];
  for (const id of moduleIds) {
    const fs2 = modFiles.get(id)!;
    let loc = 0, add = 0, del = 0, changedFiles = 0;
    const statuses: Record<string, number> = {};
    for (const f of fs2) {
      loc += f.loc;
      const s = statusMap.get(f.path);
      if (!s) continue;
      changedFiles++;
      statuses[s] = (statuses[s] || 0) + 1;
      const nss = numstat.get(f.path);
      if (nss) { add += nss.add; del += nss.del; }
      else if (s === "untracked" || s === "added") add += f.loc;
    }
    modules.push({
      id, label: graphModuleLabel(id), depth: id === "." ? 0 : id.split("/").length,
      files: fs2.length, loc, changedFiles, add, del,
      fanIn: fanInMod.get(id) || 0, fanOut: fanOutMod.get(id) || 0, statuses,
    });
  }

  let edges = [...edgeWeight.entries()].map(([key, weight]) => {
    const [from, to] = key.split("\u0000");
    return { from, to, weight };
  });
  edges.sort((a, b) => b.weight - a.weight);
  if (edges.length > 5000) edges = edges.slice(0, 5000);

  const changed = [...statusMap.entries()].map(([p, status]) => {
    const n = nodes.get(p);
    const nss = numstat.get(p);
    return {
      path: p,
      module: n ? n.module : graphDir(p),
      status,
      loc: n ? n.loc : 0,
      add: nss ? nss.add : ((status === "untracked" || status === "added") && n ? n.loc : 0),
      del: nss ? nss.del : 0,
      fanIn: fileFanIn.get(p) || 0,
    };
  }).sort((a, b) => (b.fanIn * 3 + b.add + b.del) - (a.fanIn * 3 + a.add + a.del));

  let head: unknown = null;
  const lg = gitTry(absCwd, ["log", "-1", "--format=%h\u001f%s\u001f%an\u001f%ad", "--date=short"]);
  if (lg.ok && lg.out.trim()) {
    const [hash, subject, author, date] = lg.out.trim().split("\u001f");
    head = { hash, subject, author, date };
  }

  const fileNodes = [...nodes.values()].map((n) => {
    const s = statusMap.get(n.path) || null;
    const nss = numstat.get(n.path);
    return {
      path: n.path, module: n.module, loc: n.loc, status: s,
      add: nss ? nss.add : ((s === "untracked" || s === "added") ? n.loc : 0),
      del: nss ? nss.del : 0,
      fanIn: fileFanIn.get(n.path) || 0,
      fanOut: n.imports.length,
    };
  });
  const fileEdges = [...fileEdgeSet].map((key) => {
    const [from, to] = key.split("\u0000");
    return { from, to };
  });

  return {
    cwd: absCwd,
    git: st.ok,
    modules,
    edges,
    fileNodes,
    fileEdges,
    changed,
    head,
    stats: {
      files: nodes.size,
      modules: modules.length,
      changedFiles: statusMap.size,
      add: changed.reduce((s, c) => s + c.add, 0),
      del: changed.reduce((s, c) => s + c.del, 0),
      truncated,
    },
  };
}

// ─── Routing helpers ────────────────────────────────────────────────────────

/** Match /sessions/<session_id>/events */
function matchSessionEvents(pathname: string): string | null {
  const m = pathname.match(/^\/sessions\/([^/]+)\/events$/);
  return m ? m[1] : null;
}

/** Match /sessions/<session_id>/seq (loopback seq-seed probe) */
function matchSessionSeq(pathname: string): string | null {
  const m = pathname.match(/^\/sessions\/([^/]+)\/seq$/);
  return m ? m[1] : null;
}

/** Match /sessions/<session_id>/stats */
function matchSessionStats(pathname: string): string | null {
  const m = pathname.match(/^\/sessions\/([^/]+)\/stats$/);
  return m ? m[1] : null;
}

/** Match /sessions/<session_id> (for single-session DELETE) */
function matchSession(pathname: string): string | null {
  const m = pathname.match(/^\/sessions\/([^/]+)$/);
  return m ? m[1] : null;
}

// ─── Graceful shutdown ──────────────────────────────────────────────────────

let shuttingDown = false;
let wssRef: import("ws").WebSocketServer | null = null;

function gracefulShutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n  Shutting down gracefully…");

  // Close all WebSocket terminal connections so PTY processes are killed.
  if (wssRef) {
    for (const client of wssRef.clients) {
      try { client.close(); } catch {}
    }
    try { wssRef.close(); } catch {}
  }

  // Kill any lingering pi chat subprocesses.
  shutdownChatSessions();

  // Stop a live microphone capture before the process exits.
  abortStt();

  // Checkpoint and close the SQLite database.
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
  try { db.close(); } catch {}

  // Remove the token file on clean exit.
  try { fs.unlinkSync(TOKEN_FILE); } catch {}

  // Stop accepting new connections, then exit.
  server.close(() => {
    console.log("  Server stopped.");
    process.exit(0);
  });

  // Force exit after 5s if graceful close hangs.
  setTimeout(() => { console.error("  Forcing exit after timeout."); process.exit(1); }, 5_000).unref();
}

// Handle OS-level termination signals for graceful shutdown.
process.on("SIGTERM", () => gracefulShutdown());
process.on("SIGINT", () => gracefulShutdown());

// ─── Main handler ───────────────────────────────────────────────────────────

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method.toUpperCase();

  // OPTIONS — CORS preflight (uses same restricted origin as normal responses)
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": corsOrigin(req),
        "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
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

  // ── POST /shutdown (graceful; loopback-trusted, token-gated on LAN) ──
  if (pathname === "/shutdown" && method === "POST") {
    // This sits above the auth wall because /health above it must stay open for
    // the launcher's readiness poll — so it carries its own gate. On a loopback
    // bind the only possible caller is this machine (stop.sh, the launcher); on
    // a LAN bind an unauthenticated caller could kill the server, so the token
    // becomes mandatory. A cross-site POST from a page the user is visiting is
    // delivered by the browser even though its reply can't be read, so on a
    // loopback bind the caller must also not be another origin (see
    // originSameServer) — otherwise any website could stop the server.
    if ((LAN_EXPOSED || !originSameServer(req)) && !checkAuth(req)) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    const response = jsonResponse({ ok: true, message: "shutting down" });
    // Defer shutdown so the caller receives the response before we close.
    setImmediate(() => gracefulShutdown());
    return response;
  }

  if (pathname === "/favicon.ico") {
    return new Response(null, { status: 204 });
  }

  if (pathname === "/" || pathname === "/index.html") {
    return (await serveIndex(req, url)) ?? textResponse("not found", 404, "text/plain");
  }

  // ── User plugin client bundles ─────────────────────────────────────────
  // Served from the user plugin directory (outside public/) so a plugin the
  // user installs after the server started is loadable. A <script src> tag
  // cannot send an Authorization header, so these accept ?token= (which
  // checkAuth already understands) and are marked no-store.
  if (pathname.startsWith("/plugins/file/")) {
    if (!checkAuth(req)) return textResponse("unauthorized", 401, "text/plain");
    const rest = pathname.slice("/plugins/file/".length);
    const slash = rest.indexOf("/");
    if (slash <= 0) return textResponse("not found", 404, "text/plain");
    const pid = decodeURIComponent(rest.slice(0, slash));
    const rel = decodeURIComponent(rest.slice(slash + 1));
    const file = resolvePluginFile(pid, rel);
    if (!file) return textResponse("not found", 404, "text/plain");
    try {
      const body = fs.readFileSync(file);
      const ext = path.extname(file).toLowerCase();
      const type = ext === ".json" ? "application/json"
        : ext === ".css" ? "text/css"
        : ext === ".html" ? "text/html"
        : "text/javascript";
      return new Response(body, {
        status: 200,
        headers: { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store", "access-control-allow-origin": "*" },
      });
    } catch {
      return textResponse("not found", 404, "text/plain");
    }
  }

  if (pathname.match(/\.(js|css|svg|png|ico|ttf|woff2?)$/)) {
    return serveStatic(pathname.replace(/^\//, ""), req) ?? textResponse("not found", 404, "text/plain");
  }

  // ── Auth wall ──────────────────────────────────────────────────────────
  // POST /events is the local producer path. With a loopback bind (HOST
  // defaults to 127.0.0.1) any sender is already a trusted local process, so
  // skipping the token check here removes the token-file race that otherwise
  // 401s every POST across server restarts / source-vs-packaged builds. That
  // exemption is scoped to loopback *peers*: once the server is LAN-bound the
  // same routes would otherwise accept forged events from any device on the
  // Wi-Fi, so they fall back to the token. All reads (sessions, SSE, files,
  // checkpoints) stay token-gated either way.
  const isLocalProducer =
    (pathname === "/events" && method === "POST") ||
    pathname === "/capture/llm-request" ||
    pathname === "/capture/llm-response" ||
    // Loopback seq-seed probe (used by the extension to continue a resumed
    // session's event sequence). Same trust model as POST /events.
    (method === "GET" && matchSessionSeq(pathname) !== null);
  const isTrustedProducer =
    isLocalProducer && (!LAN_EXPOSED || peerIsLoopback(req)) && originSameServer(req);
  if (!isTrustedProducer && !checkAuth(req)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  // ── Feature-plugin gate ────────────────────────────────────────────────
  // A disabled feature plugin owns its server routes. Refusing them here (the
  // route handlers never run) is what makes "disable Git / Terminal / Chat in
  // Settings" a real capability switch rather than a hidden nav button.
  const disabledOwner = disabledPluginForRoute(pathname);
  if (disabledOwner) {
    return jsonResponse({ error: `plugin disabled: ${disabledOwner}`, plugin: disabledOwner }, 403);
  }

  // ── Plugins API ────────────────────────────────────────────────────────
  // GET  /plugins → manifest snapshot, enabled state, plugin directories.
  // POST /plugins → { action: "enable"|"disable"|"reload", id? }.
  if (pathname === "/plugins" && method === "GET") {
    return jsonResponse(pluginSnapshot());
  }
  if (pathname === "/plugins" && method === "POST") {
    let body: any;
    try { body = JSON.parse(await readBody(req)); } catch { return jsonResponse({ error: "invalid JSON" }, 400); }
    const action = String(body?.action ?? "");
    try {
      if (action === "enable" || action === "disable") {
        const id = String(body?.id ?? "");
        if (!id) return jsonResponse({ error: "id required" }, 400);
        return jsonResponse(await setPluginEnabled(id, action === "enable", { kit: pluginKit }));
      }
      if (action === "reload") {
        return jsonResponse(await reloadPlugins({ kit: pluginKit }));
      }
      return jsonResponse({ error: "unknown action" }, 400);
    } catch (err: any) {
      console.error("Plugin action failed:", err);
      return jsonResponse({ error: "plugin action failed" }, 400);
    }
  }

  // ── GET /lan (phone pairing) ─────────────────────────────────────────────
  // Backs the "scan from your phone" QR panel. Token-gated like every other
  // read: the response contains the auth token itself, so it must never be
  // handed to an unauthenticated caller.
  if (pathname === "/lan" && method === "GET") {
    const ips = lanIpv4Addrs();
    return jsonResponse({
      lan_exposed: LAN_EXPOSED,
      port: PORT,
      bind_host: HOST,
      // Always report the machine's real IPv4s so the panel can name the exact
      // address to rebind to — but only advertise scannable URLs when the
      // server is genuinely reachable off-box. A 127.0.0.1 QR would scan fine
      // on the desktop and then open nothing at all on the phone.
      ips,
      urls: LAN_EXPOSED
        ? ips.map((ip) => `http://${ip}:${PORT}/?token=${encodeURIComponent(AUTH_TOKEN)}`)
        : [],
    });
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

    // The extension posts batches of up to 50 events; ingest them in a single
    // transaction instead of 100 individual commits.
    ingestBatch((emit) => {
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

        const ingestedId = ingestEvent(evt as ObsEvent, emit);
        if (ingestedId) {
          ingested.push(ingestedId);
        } else {
          rejected.push(evt.event_id);
        }
      }
    });

    return jsonResponse({ ingested: ingested.length, rejected });
  }

  // ── POST /capture/llm-request ─────────────────────────────────────────
  // Raw LLM provider request body, posted by any harness (not just the Pi extension).
  // The server parses provider-format bodies (Anthropic, OpenAI, etc.), creates the
  // appropriate scope events, and stores/broadcasts them.
  //
  // {
  //   "session_id": "...",      // required — unique session identifier
  //   "request_body": { ... },  // required — exact JSON body sent to the LLM provider
  //   "client": "pi|...",      // optional — harness name
  //   "agent_name": "...",     // optional — friendly agent label
  //   "pool": "default",       // optional
  //   "tags": ["tag1"],        // optional
  //   "cwd": "/path",         // optional
  //   "timestamp": "ISO",      // optional — defaults to now
  // }
  if (pathname === "/capture/llm-request" && method === "POST") {
    let bodyText: string;
    try {
      bodyText = await readBody(req);
    } catch (err: any) {
      return jsonResponse({ error: err.message }, 413);
    }

    let parsed: any;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return jsonResponse({ error: "invalid JSON" }, 400);
    }

    const sessionId = typeof parsed.session_id === "string" && parsed.session_id.trim()
      ? parsed.session_id.trim() : "";
    if (!sessionId) return jsonResponse({ error: "session_id is required" }, 400);
    if (!parsed.request_body || typeof parsed.request_body !== "object") {
      return jsonResponse({ error: "request_body is required and must be an object" }, 400);
    }

    const ts = typeof parsed.timestamp === "string" ? parsed.timestamp : new Date().toISOString();
    const pool = typeof parsed.pool === "string" ? parsed.pool : "default";
    const tags: string[] = Array.isArray(parsed.tags) ? parsed.tags.map(String).filter(Boolean) : [];
    const cwd = typeof parsed.cwd === "string" ? parsed.cwd : "";
    const agentName = typeof parsed.agent_name === "string" ? parsed.agent_name : (parsed.client ?? undefined);

    // Parse the provider-format request body into scope fields
    const requestInfo = parseLLMRequestBody(parsed.request_body);
    const userMsgPreview = extractUserMsgPreview(parsed.request_body);

    const llmRequestPayload: any = {
      system_prompt: requestInfo.system_prompt || "(no system prompt)",
    };
    if (requestInfo.tools.length) llmRequestPayload.tools = requestInfo.tools;
    if (requestInfo.model) llmRequestPayload.model = requestInfo.model;
    if (requestInfo.messages.length) llmRequestPayload.message_count = requestInfo.messages.length;
    if (Object.keys(requestInfo.args).length) llmRequestPayload.request_args = requestInfo.args;
    if (userMsgPreview) llmRequestPayload.user_msg_preview = userMsgPreview;

    // Generate event_id and sequence
    let seq = Date.now();
    const eventId = crypto.randomUUID();

    const requestEvent: ObsEvent = {
      event_id: eventId,
      session_id: sessionId,
      seq,
      ts,
      type: "llm_request",
      pool,
      tags,
      payload: llmRequestPayload,
      provider: parsed.request_body?.provider ?? requestInfo.model ?? undefined,
      model: requestInfo.model ?? undefined,
      agent_name: agentName,
      cwd,
    };

    ingestEvent(requestEvent);

    // Also create user_message events from each user message in the request
    for (const msg of requestInfo.messages) {
      if (msg.role !== "user") continue;
      let text = "";
      let imagesCount = 0;
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b.type === "text") text += (b.text || "") + "\n";
          else if (b.type === "image") imagesCount++;
        }
        text = text.trim();
      }
      if (text || imagesCount) {
        const userEvent: ObsEvent = {
          event_id: crypto.randomUUID(),
          session_id: sessionId,
          seq: ++seq,
          ts,
          type: "user_message",
          pool,
          tags,
          payload: { text, images_count: imagesCount },
          agent_name: agentName,
          cwd,
        };
        ingestEvent(userEvent);
      }
    }

    return jsonResponse({
      ok: true,
      session_id: sessionId,
      event_id: eventId,
      type: "llm_request",
    });
  }

  // ── POST /capture/llm-response ────────────────────────────────────────
  // Raw LLM provider response body, posted by any harness.
  // The server parses provider-format responses (Anthropic, OpenAI, etc.), creates
  // the appropriate scope events (assistant_message, tool_call, thinking), and
  // updates session stats.
  //
  // {
  //   "session_id": "...",            // required
  //   "response_body": { ... },       // required — exact JSON response from the LLM provider
  //   "request_event_id": "...",      // optional — links back to the llm_request event
  //   "timing": {                     // optional — wall-clock timing
  //     "started_at": "ISO",
  //     "finished_at": "ISO",
  //     "latency_ms": 12345
  //   },
  //   "pool": "default",
  //   "tags": ["tag1"],
  // }
  if (pathname === "/capture/llm-response" && method === "POST") {
    let bodyText: string;
    try {
      bodyText = await readBody(req);
    } catch (err: any) {
      return jsonResponse({ error: err.message }, 413);
    }

    let parsed: any;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return jsonResponse({ error: "invalid JSON" }, 400);
    }

    const sessionId = typeof parsed.session_id === "string" && parsed.session_id.trim()
      ? parsed.session_id.trim() : "";
    if (!sessionId) return jsonResponse({ error: "session_id is required" }, 400);
    if (!parsed.response_body || typeof parsed.response_body !== "object") {
      return jsonResponse({ error: "response_body is required and must be an object" }, 400);
    }

    const ts = typeof parsed.timestamp === "string" ? parsed.timestamp : new Date().toISOString();
    const pool = typeof parsed.pool === "string" ? parsed.pool : "default";
    const tags: string[] = Array.isArray(parsed.tags) ? parsed.tags.map(String).filter(Boolean) : [];

    // Parse the provider-format response body into scope fields
    const responseInfo = parseLLMResponseBody(parsed.response_body);

    // Calculate timing
    const timing = parsed.timing || {};
    const startedAt = timing.started_at ? new Date(timing.started_at).getTime() : undefined;
    const finishedAt = timing.finished_at ? new Date(timing.finished_at).getTime() : Date.now();
    const latencyMs = timing.latency_ms ?? (startedAt ? finishedAt - startedAt : undefined);
    const prefillMs = timing.prefill_ms ?? undefined;
    const generationMs = timing.generation_ms ?? undefined;
    const outputTps = timing.output_tps ?? (
      generationMs && generationMs >= 50 && responseInfo.usage.output > 0
        ? Math.round((responseInfo.usage.output / generationMs) * 1000)
        : undefined
    );

    const assistantPayload: any = {
      text: responseInfo.text,
      thinking: responseInfo.thinking,
      tool_call_ids: responseInfo.tool_calls.map((tc) => tc.id),
      stop_reason: responseInfo.stop_reason,
      usage: {
        input: responseInfo.usage.input,
        output: responseInfo.usage.output,
        cache_read: responseInfo.usage.cache_read,
        cache_write: responseInfo.usage.cache_write,
        total_tokens: responseInfo.usage.input + responseInfo.usage.output,
        cost_total: timing.cost_total ?? 0,
      },
      turn_index: parsed.turn_index ?? undefined,
    };
    if (latencyMs != null) assistantPayload.latency_ms = latencyMs;
    if (prefillMs != null) assistantPayload.prefill_ms = prefillMs;
    if (generationMs != null) assistantPayload.generation_ms = generationMs;
    if (outputTps != null) assistantPayload.output_tps = outputTps;

    let seq = Date.now() + 1;
    const eventId = crypto.randomUUID();

    const assistantEvent: ObsEvent = {
      event_id: eventId,
      session_id: sessionId,
      seq,
      ts,
      type: "assistant_message",
      pool,
      tags,
      payload: assistantPayload,
      provider: responseInfo.model ?? parsed.response_body?.provider ?? undefined,
      model: responseInfo.model ?? parsed.response_body?.model ?? undefined,
    };

    ingestEvent(assistantEvent);

    // Create tool_call events for each tool call in the response
    for (const tc of responseInfo.tool_calls) {
      const toolEvent: ObsEvent = {
        event_id: crypto.randomUUID(),
        session_id: sessionId,
        seq: ++seq,
        ts,
        type: "tool_call",
        pool,
        tags,
        payload: {
          tool_call_id: tc.id,
          tool_name: tc.name,
          args: tc.args,
          args_truncated: false,
        },
        provider: assistantEvent.provider,
        model: assistantEvent.model,
      };
      ingestEvent(toolEvent);
    }

    // Create thinking event if thinking content exists
    if (responseInfo.thinking) {
      const thinkingEvent: ObsEvent = {
        event_id: crypto.randomUUID(),
        session_id: sessionId,
        seq: ++seq,
        ts,
        type: "thinking",
        pool,
        tags,
        payload: { text: responseInfo.thinking },
        provider: assistantEvent.provider,
        model: assistantEvent.model,
      };
      ingestEvent(thinkingEvent);
    }

    return jsonResponse({
      ok: true,
      session_id: sessionId,
      event_id: eventId,
      type: "assistant_message",
      tool_calls: responseInfo.tool_calls.length,
      total_tokens: assistantPayload.usage.total_tokens,
    });
  }

  // ── GET /models ────────────────────────────────────────────────────────
  if (pathname === "/models" && method === "GET") {
    try {
      const rows = q.listModels.all() as any[];
      return jsonResponse({ models: rows.map((r) => r.model) });
    } catch (err: any) {
      return jsonResponse({ error: err.message }, 500);
    }
  }

  // ── GET /chat/footer (composer footer: git branch, thinking level, model
  // metadata for pricing/context, opencode-go rolling usage) ─────────────
  if (pathname === "/chat/footer" && method === "GET") {
    const cwd = url.searchParams.get("cwd") ?? "";
    if (!cwd) return jsonResponse({ error: "missing cwd" }, 400);
    const absCwd = validateCwd(cwd);
    if (!absCwd) return jsonResponse({ error: "invalid or disallowed cwd" }, 400);
    let branch: string | null = null;
    const b = gitTry(absCwd, ["branch", "--show-current"]);
    if (b.ok && b.out.trim()) branch = b.out.trim();
    let thinking = "high";
    try {
      const settings = JSON.parse(fs.readFileSync(SETTINGS_JSON, "utf8"));
      if (typeof settings.defaultThinkingLevel === "string" && settings.defaultThinkingLevel) thinking = settings.defaultThinkingLevel;
    } catch { /* settings absent */ }
    void refreshGoApiUsage();
    return jsonResponse({ branch, thinking, modelMeta: buildModelMeta(), goUsage: computeGoUsage() });
  }

  // ── GET /settings (consolidated pi + agent-team settings snapshot) ──────
  // `cwd` (chat workspace) selects which project's agent-team config to load;
  // absent → last-used project, then the server's launch directory.
  if (pathname === "/settings" && method === "GET") {
    const proj = resolveProjectDir(url.searchParams.get("cwd"));
    return jsonResponse(loadSettingsSnapshot(proj));
  }

  // ── POST /settings (persist a granular pi / agent-team setting) ─────────
  // Scalar field actions for settings.json and agent-team-config.json that the
  // agent-team rail does not surface. Team / mode / memory / agent / skill /
  // extension toggles continue to go through POST /agent-team so both surfaces
  // share one writer.
  if (pathname === "/settings" && method === "POST") {
    let body: any;
    try { body = JSON.parse(await readBody(req)); } catch { return jsonResponse({ error: "invalid JSON" }, 400); }
    const action = body?.action;
    const value = body?.value;
    const proj = resolveProjectDir(typeof body.cwd === "string" ? body.cwd : null);
    try {
      switch (action) {
        case "setDefaultModel":
          setSettingsField("defaultModel", String(value || ""));
          break;
        // Model for the Git view's AI commit-message generator (Pi Scope's own
        // field in settings.json; empty falls back to defaultModel).
        case "setGitCommitModel":
          setSettingsField("gitCommitModel", String(value || ""));
          break;
        // Instruction template for the commit-message generator (placeholders
        // {{branch}} {{source}} {{files}} {{diff}}); empty = built-in default.
        case "setGitCommitTemplate":
          setSettingsField("gitCommitTemplate", String(value || ""));
          break;
        case "setDefaultProvider":
          setSettingsField("defaultProvider", String(value || ""));
          break;
        // Set both defaultProvider + defaultModel in one write — the equivalent
        // of the pi /modelcost selector's "set as default" action. `value` is
        // { provider, model }.
        case "setDefaultModelProvider": {
          const v = (value ?? {}) as { provider?: unknown; model?: unknown };
          const provider = String(v.provider ?? "").trim();
          const model = String(v.model ?? "").trim();
          updateSettingsJson((cfg) => {
            if (provider) cfg.defaultProvider = provider;
            if (model) cfg.defaultModel = model;
          });
          break;
        }
        case "setDefaultThinkingLevel": {
          const level = String(value || "");
          if (!THINKING_LEVELS.includes(level)) return jsonResponse({ error: `invalid thinking level: ${level}` }, 400);
          setSettingsField("defaultThinkingLevel", level);
          break;
        }
        case "setTheme":
          setSettingsField("theme", String(value || ""));
          break;
        case "setQuietStartup":
          setSettingsField("quietStartup", !!value);
          break;
        case "setDoubleEscapeAction":
          setSettingsField("doubleEscapeAction", String(value || ""));
          break;
        case "setHideThinkingBlock":
          setSettingsField("hideThinkingBlock", !!value);
          break;
        case "setEditorPaddingX":
          setSettingsField("editorPaddingX", Number(value) || 0);
          break;
        case "setTerminalShowProgress":
          setSettingsNested(["terminal", "showTerminalProgress"], !!value);
          break;
        case "setCompactionEnabled":
          setSettingsNested(["compaction", "enabled"], !!value);
          break;
        case "setEnabledModels": {
          const list = Array.isArray(value) ? value.map((s) => String(s)) : [];
          updateSettingsJson((cfg) => { cfg.enabledModels = list; });
          break;
        }
        case "setTeamEnabled":
          updateAgentConfig(proj, (cfg) => { cfg.enabled = !!value; });
          break;
        case "setGridCols":
          updateAgentConfig(proj, (cfg) => { cfg.gridCols = Math.min(4, Math.max(1, Number(value) || 1)); });
          break;
        case "setParallelDispatch":
          updateAgentConfig(proj, (cfg) => { cfg.parallelDispatch = !!value; });
          break;
        case "setMaxParallel":
          updateAgentConfig(proj, (cfg) => { cfg.maxParallel = Math.max(1, Number(value) || 1); });
          break;
        case "setDebugLevel":
          updateAgentConfig(proj, (cfg) => { cfg.debugLevel = Math.min(3, Math.max(0, Number(value) || 0)); });
          break;
        case "setSkipOrchestratorTools":
          setAgentConfigList(proj, "skipOrchestratorTools", Array.isArray(value) ? value : []);
          break;
        case "setDestructiveTools":
          setAgentConfigList(proj, "destructiveTools", Array.isArray(value) ? value : []);
          break;
        case "setMemoryModel": {
          const model = String(value || "").trim();
          if (model && !isModelId(model)) return jsonResponse({ error: "invalid model id" }, 400);
          updateTeamsYaml(proj, (p) => { p.memoryModel = model || undefined; });
          break;
        }
        // API keys: stored in <agentDir>/api-keys.json (0600) and applied to the
        // pi subprocess env + speech-to-text env. An empty value clears it.
        case "setApiKey": {
          const v = (value ?? {}) as { name?: unknown; value?: unknown };
          const name = String(v.name ?? "").trim();
          const secret = String(v.value ?? "").trim();
          if (!isValidKeyName(name)) return jsonResponse({ error: "invalid key name" }, 400);
          if (secret.length > MAX_KEY_LENGTH) return jsonResponse({ error: "key is too long" }, 400);
          setStoredKey(name, secret);
          break;
        }
        case "clearApiKey": {
          const v = (value ?? {}) as { name?: unknown };
          const name = String(v.name ?? "").trim();
          if (!isValidKeyName(name)) return jsonResponse({ error: "invalid key name" }, 400);
          clearStoredKey(name);
          break;
        }
        default:
          return jsonResponse({ error: `unknown settings action: ${action}` }, 400);
      }
    } catch (err: any) {
      console.error("POST /settings failed:", err);
      return jsonResponse({ error: "internal server error" }, 500);
    }
    return jsonResponse(loadSettingsSnapshot(proj));
  }

  // ── GET /agent-team (snapshot of the agent-team sidebar state) ──────────
  // `cwd` (chat workspace) selects which project's agent-team config to load;
  // absent → last-used project, then the server's launch directory.
  if (pathname === "/agent-team" && method === "GET") {
    const proj = resolveProjectDir(url.searchParams.get("cwd"));
    return jsonResponse(loadAgentTeam(proj));
  }

  // ── POST /agent-team (persist a sidebar toggle) ─────────────────────────
  if (pathname === "/agent-team" && method === "POST") {
    let body: any;
    try { body = JSON.parse(await readBody(req)); } catch { return jsonResponse({ error: "invalid JSON" }, 400); }
    const action = body?.action;
    const proj = resolveProjectDir(typeof body.cwd === "string" ? body.cwd : null);
    try {
      switch (action) {
        case "setTeam":
          updateAgentConfig(proj, (cfg) => { cfg.activeTeam = body.team; });
          break;
        case "toggleMode":
          updateAgentConfig(proj, (cfg) => { cfg.mode = cfg.mode === "creative" ? "standard" : "creative"; });
          break;
        case "setMode": {
          const m = String(body.mode || "");
          if (m !== "creative" && m !== "standard") return jsonResponse({ error: `invalid mode: ${m}` }, 400);
          updateAgentConfig(proj, (cfg) => { cfg.mode = m; });
          break;
        }
        case "toggleMemory":
          updateTeamsYaml(proj, (p) => {
            const on = p.memoryActive !== true;
            // Mirror pi's agent-team toggleMemory (memory.ts): enabling memory
            // falls back to the default model when teams.yaml has no
            // memory_model configured (pi uses the orchestrator's current
            // model), so the toggle works even before a memory model is ever
            // set. Without any model the feature can't run — keep it off.
            const model = p.memoryModel || readSettingsJson().defaultModel || "";
            if (on && model) p.memoryModel = model;
            p.memoryActive = on ? !!model : false;
          });
          break;
        case "setThinkingLevel": {
          const level = String(body.level || "").trim();
          const VALID = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
          if (!VALID.includes(level)) return jsonResponse({ error: `invalid thinking level: ${level}` }, 400);
          // pi resolves the thinking level at agent start and clamps it to the
          // model's capabilities. Chat prompts also carry thinkingLevel and the
          // chat module pushes it to the running rpc subprocess via
          // set_thinking_level, so the choice applies without a respawn.
          updateSettingsJson((cfg) => { cfg.defaultThinkingLevel = level; });
          break;
        }
        case "toggleAgent": {
          const key = String(body.agent || "").toLowerCase();
          const disabled = !!body.disabled;
          updateTeamsYaml(proj, (p) => {
            for (const members of Object.values(p.teams || {})) {
              const mem = (members as any[]).find((m) => (m.name || "").toLowerCase() === key);
              if (mem) mem.active = !disabled;
            }
          });
          updateAgentConfig(proj, (cfg) => {
            cfg.disabledAgents = cfg.disabledAgents || [];
            const set = new Set(cfg.disabledAgents.map((s: string) => s.toLowerCase()));
            if (disabled) set.add(key); else set.delete(key);
            cfg.disabledAgents = Array.from(set);
          });
          break;
        }
        case "setMemberModel": {
          // Set a specific team member's model in teams.yaml. `agent` is the
          // member name; the write targets every team containing that member
          // (a member may exist in several teams). Empty model clears it.
          const key = String(body.agent || "");
          const model = String(body.model || "").trim();
          if (!key) return jsonResponse({ error: "missing agent" }, 400);
          if (model && !isModelId(model)) return jsonResponse({ error: "invalid model id" }, 400);
          updateTeamsYaml(proj, (p) => {
            for (const members of Object.values(p.teams || {})) {
              const mem = (members as any[]).find((m) => (m.name || "").toLowerCase() === key.toLowerCase());
              if (mem) { if (model) mem.model = model; else delete mem.model; }
            }
          });
          break;
        }
        // ── Team editor: create / rename / delete teams and their members ──
        // Writes go to the project's own .pi/settings/agents/teams.yaml, the
        // same file pi's agent-team extension reads back.
        case "addTeam": {
          const name = String(body.team || "").trim();
          if (!TEAM_NAME_RE.test(name)) {
            return jsonResponse({ error: "team names may use letters, digits, '-' and '_'" }, 400);
          }
          if (readTeams(proj).teams[name]) return jsonResponse({ error: `team already exists: ${name}` }, 400);
          updateTeamsYaml(proj, (p) => {
            p.teams = p.teams || {};
            p.teams[name] = [];
          });
          // A team the user just created is the one they want to work on.
          updateAgentConfig(proj, (cfg) => { cfg.activeTeam = name; });
          break;
        }
        case "renameTeam": {
          const from = String(body.team || "").trim();
          const to = String(body.to || "").trim();
          if (!from) return jsonResponse({ error: "missing team" }, 400);
          if (!TEAM_NAME_RE.test(to)) {
            return jsonResponse({ error: "team names may use letters, digits, '-' and '_'" }, 400);
          }
          if (from === to) break;
          const current = readTeams(proj).teams;
          if (!current[from]) return jsonResponse({ error: `no such team: ${from}` }, 400);
          if (current[to]) return jsonResponse({ error: `team already exists: ${to}` }, 400);
          updateTeamsYaml(proj, (p) => {
            // Rebuild the map in place so the renamed team keeps its position
            // in the sidebar order (teamsOrder follows the file's key order).
            const next: Record<string, any[]> = {};
            for (const [key, members] of Object.entries(p.teams || {})) next[key === from ? to : key] = members;
            p.teams = next;
          });
          updateAgentConfig(proj, (cfg) => { if (cfg.activeTeam === from) cfg.activeTeam = to; });
          break;
        }
        case "removeTeam": {
          const name = String(body.team || "").trim();
          if (!name) return jsonResponse({ error: "missing team" }, 400);
          updateTeamsYaml(proj, (p) => { if (p.teams) delete p.teams[name]; });
          // Never leave activeTeam pointing at a team that no longer exists.
          const remaining = Object.keys(readTeams(proj).teams);
          updateAgentConfig(proj, (cfg) => {
            if (cfg.activeTeam !== name) return;
            if (remaining.length) cfg.activeTeam = remaining[0];
            else delete cfg.activeTeam;
          });
          break;
        }
        case "addMember": {
          const team = String(body.team || "").trim();
          const name = String(body.name || "").trim();
          if (!team) return jsonResponse({ error: "missing team" }, 400);
          if (!MEMBER_NAME_RE.test(name)) return jsonResponse({ error: "invalid subagent name" }, 400);
          if (!readTeams(proj).teams[team]) return jsonResponse({ error: `no such team: ${team}` }, 400);
          const newMemberModel = String(body.model || "").trim();
          if (newMemberModel && !isModelId(newMemberModel)) return jsonResponse({ error: "invalid model id" }, 400);
          updateTeamsYaml(proj, (p) => {
            const teams = (p.teams = p.teams || {});
            const members = (teams[team] = teams[team] || []);
            // Names are unique within a team; adding an existing one is a no-op
            // so the UI can be clicked twice safely.
            if (members.some((m) => (m.name || "").toLowerCase() === name.toLowerCase())) return;
            const entry: Record<string, any> = { name };
            if (newMemberModel) entry.model = newMemberModel;
            members.push(entry);
          });
          break;
        }
        case "removeMember": {
          const team = String(body.team || "").trim();
          const name = String(body.name || "").trim();
          if (!team || !name) return jsonResponse({ error: "missing team or name" }, 400);
          // Per-team: a member may legitimately exist in several teams.
          updateTeamsYaml(proj, (p) => {
            const members = p.teams && p.teams[team];
            if (members) p.teams[team] = members.filter((m) => (m.name || "").toLowerCase() !== name.toLowerCase());
          });
          break;
        }
        case "toggleSkill": {
          const group = body.group; // "orchestrator" | "subagent"
          const dir = String(body.dir || "");
          if (!dir) return jsonResponse({ error: "missing skill" }, 400);
          updateAgentConfig(proj, (cfg) => {
            const key = group === "orchestrator" ? "orchestratorSkills" : "subagentSkills";
            const arr: string[] = cfg[key] || [];
            const set = new Set(arr);
            if (set.has(dir)) set.delete(dir); else set.add(dir);
            cfg[key] = Array.from(set);
          });
          break;
        }
        case "toggleTool": {
          // Enable/disable an orchestrator tool (mirrors pi's sidebar
          // toggleOrchestratorTool): off = added to skipOrchestratorTools,
          // on = removed from it. Case-insensitive, like pi's denylist checks.
          const name = String(body.tool || "").trim();
          if (!name) return jsonResponse({ error: "missing tool" }, 400);
          const key = name.toLowerCase();
          updateAgentConfig(proj, (cfg) => {
            const arr: string[] = Array.isArray(cfg.skipOrchestratorTools) ? cfg.skipOrchestratorTools : [];
            const i = arr.findIndex((t) => String(t).toLowerCase() === key);
            if (i >= 0) arr.splice(i, 1); else arr.push(name);
            cfg.skipOrchestratorTools = arr;
          });
          break;
        }
        case "toggleExtension": {
          const entryPath = body.path;
          updateSettingsJson((cfg) => {
            cfg.extensions = cfg.extensions || [];
            const idx = cfg.extensions.findIndex((e: string) => parseExtensionEntry(e)?.path === entryPath);
            if (idx >= 0) {
              const parsed = parseExtensionEntry(cfg.extensions[idx]);
              if (parsed) cfg.extensions[idx] = (parsed.enabled ? "-" : "+") + parsed.path;
            }
          });
          break;
        }
        case "toggleSkillSetting": {
          // `dir` becomes part of a `skills/<dir>/SKILL.md` settings entry, which
          // pi resolves against its own config dir — keep it a plain name so it
          // can never point outside the skills folder.
          const dir = String(body.dir || "");
          if (!/^[A-Za-z0-9_.-]{1,64}$/.test(dir)) return jsonResponse({ error: "invalid skill name" }, 400);
          updateSettingsJson((cfg) => {
            cfg.skills = cfg.skills || [];
            const idx = cfg.skills.findIndex((e: string) => parseSkillSettingEntry(e)?.name === dir);
            if (idx >= 0) {
              const parsed = parseSkillSettingEntry(cfg.skills[idx]);
              cfg.skills[idx] = (parsed?.disabled ? "+" : "-") + `skills/${dir}/SKILL.md`;
            } else {
              cfg.skills.push(`+skills/${dir}/SKILL.md`);
            }
          });
          break;
        }
        case "addWorkspace": {
          // Add a directory as a chat workspace. Must already exist on disk.
          const p = String(body.path || "").trim();
          if (!p) return jsonResponse({ error: "missing path" }, 400);
          let abs: string;
          try { abs = fs.realpathSync(path.resolve(p)); } catch { return jsonResponse({ error: `directory not found: ${p}` }, 400); }
          let st: fs.Stats;
          try { st = fs.statSync(abs); } catch { return jsonResponse({ error: `directory not found: ${p}` }, 400); }
          if (!st.isDirectory()) return jsonResponse({ error: `not a directory: ${p}` }, 400);
          // chatWorkspaces lives in the current project's agent-team-config.json
          // (per-project, like pi) — the project this request targets via cwd.
          updateAgentConfig(proj, (cfg) => {
            const arr: string[] = cfg.chatWorkspaces || [];
            if (!arr.includes(abs)) arr.push(abs);
            cfg.chatWorkspaces = arr;
            // Re-adding un-hides it if it was previously removed.
            cfg.chatWorkspacesRemoved = (cfg.chatWorkspacesRemoved || []).filter((s: string) => s !== abs);
          });
          // Self-register the workspace in ITS OWN project config too. The rail
          // lists each project's chatWorkspaces, so without this, opening a
          // session-less workspace makes it the active project and its own
          // (empty) list drops the row — clicking a workspace would hide it.
          if (abs !== proj) {
            updateAgentConfig(abs, (cfg) => {
              const arr: string[] = cfg.chatWorkspaces || [];
              if (!arr.includes(abs)) arr.push(abs);
              cfg.chatWorkspaces = arr;
              cfg.chatWorkspacesRemoved = (cfg.chatWorkspacesRemoved || []).filter((s: string) => s !== abs);
            });
          }
          break;
        }
        case "removeWorkspace": {
          // Remove a workspace from the chat rail. Session-derived workspaces
          // are remembered as removed so the session poll doesn't re-add them.
          const raw = String(body.path || "");
          if (!raw) return jsonResponse({ error: "missing path" }, 400);
          const key = raw === "(unknown)" ? raw : path.resolve(raw);
          updateAgentConfig(proj, (cfg) => {
            cfg.chatWorkspaces = (cfg.chatWorkspaces || []).filter((s: string) => path.resolve(s) !== key);
            const removed: string[] = cfg.chatWorkspacesRemoved || [];
            if (!removed.includes(key)) removed.push(key);
            cfg.chatWorkspacesRemoved = removed;
          });
          // Drop the workspace from its own project list too (and remember the
          // removal), so it can't resurface when that workspace becomes active.
          // Skip when there's no per-project config there yet (session-derived
          // rows shouldn't cause config files to be created just by removal).
          if (key !== proj && key !== "(unknown)" && fileExists(projectAgentConfigPath(key))) {
            updateAgentConfig(key, (cfg) => {
              cfg.chatWorkspaces = (cfg.chatWorkspaces || []).filter((s: string) => path.resolve(s) !== key);
              const removed: string[] = cfg.chatWorkspacesRemoved || [];
              if (!removed.includes(key)) removed.push(key);
              cfg.chatWorkspacesRemoved = removed;
            });
          }
          // Removing a workspace also clears its recorded telemetry: the rail
          // row and the sessions/events behind it go together, so re-adding the
          // directory starts clean instead of replaying conversations the user
          // just cleared. Delete by the resolved path AND the raw one, since a
          // session's stored cwd is whatever the agent reported.
          for (const cwdKey of new Set([key, raw])) {
            q.deleteSessionEventsByCwd.run({ $cwd: cwdKey });
            q.deleteSessionRowsByCwd.run({ $cwd: cwdKey });
          }
          break;
        }
        default:
          return jsonResponse({ error: `unknown action: ${action}` }, 400);
      }
    } catch (err: any) {
      console.error("POST /agent-team failed:", err);
      return jsonResponse({ error: "internal server error" }, 500);
    }
    return jsonResponse(loadAgentTeam(proj));
  }

  // ── POST /chat/start (pre-spawn the pi session for a workspace) ────────
  // Called when the user selects a workspace in the Chat view so `pi --mode
  // rpc` is already running before the first prompt is typed.
  if (pathname === "/chat/start" && method === "POST") {
    let bodyText: string;
    try { bodyText = await readBody(req); } catch (err: any) { return jsonResponse({ error: err.message }, 413); }
    let parsed: any;
    try { parsed = JSON.parse(bodyText); } catch { return jsonResponse({ error: "invalid JSON" }, 400); }
    const cwd = typeof parsed.cwd === "string" ? parsed.cwd : "";
    if (!cwd) return jsonResponse({ error: "missing cwd" }, 400);
    const absCwd = validateCwd(cwd);
    if (!absCwd) return jsonResponse({ error: "invalid or disallowed cwd" }, 400);
    const r = startChatSession({ cwd: absCwd, model: typeof parsed.model === "string" ? parsed.model : "" });
    return jsonResponse({ ...r, cwd: absCwd, model: (parsed.model || "").trim() || "google/gemini-2.5-flash-lite" });
  }

  // ── POST /chat (real-time prompt to the pi coding agent) ───────────────
  if (pathname === "/chat" && method === "POST") {
    let bodyText: string;
    try { bodyText = await readBody(req); } catch (err: any) { return jsonResponse({ error: err.message }, 413); }
    let parsed: any;
    try { parsed = JSON.parse(bodyText); } catch { return jsonResponse({ error: "invalid JSON" }, 400); }
    const cwd = typeof parsed.cwd === "string" ? parsed.cwd : "";
    if (!cwd) return jsonResponse({ error: "missing cwd" }, 400);
    const absCwd = validateCwd(cwd);
    if (!absCwd) return jsonResponse({ error: "invalid or disallowed cwd" }, 400);
    return startChat({
      cwd: absCwd,
      model: typeof parsed.model === "string" ? parsed.model : "",
      // The composer's thinking-level choice; pushed to the subprocess via RPC
      // set_thinking_level so it applies without a respawn (pi otherwise caches
      // settings.json's defaultThinkingLevel at boot).
      thinkingLevel: typeof parsed.thinkingLevel === "string" ? parsed.thinkingLevel : "",
      prompt: typeof parsed.prompt === "string" ? parsed.prompt : "",
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : "",
      sessionFile: typeof parsed.sessionFile === "string" ? parsed.sessionFile : "",
      streamingBehavior: typeof parsed.streamingBehavior === "string" ? parsed.streamingBehavior : "",
    });
  }

  // ── POST /chat/stop (abort the agent's current run, keep the session) ────
  // Unlike /chat/kill, this sends `clear_queue` + `abort` to the live pi
  // subprocess so the current run stops but the conversation context survives —
  // the user can keep chatting in the same session.
  if (pathname === "/chat/stop" && method === "POST") {
    let bodyText: string;
    try { bodyText = await readBody(req); } catch (err: any) { return jsonResponse({ error: err.message }, 413); }
    let parsed: any;
    try { parsed = JSON.parse(bodyText); } catch { return jsonResponse({ error: "invalid JSON" }, 400); }
    const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId.trim() : "";
    const ok = sessionId ? stopChat(sessionId) : false;
    return jsonResponse({ ok, sessionId });
  }

  // ── POST /chat/kill (stop a chat subprocess by session id) ─────────────
  // Called when the user starts a brand-new conversation: the old pi subprocess
  // holds the previous conversation's context, so it is killed and its entry
  // removed rather than left idle to be picked up again.
  if (pathname === "/chat/kill" && method === "POST") {
    let bodyText: string;
    try { bodyText = await readBody(req); } catch (err: any) { return jsonResponse({ error: err.message }, 413); }
    let parsed: any;
    try { parsed = JSON.parse(bodyText); } catch { return jsonResponse({ error: "invalid JSON" }, 400); }
    const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId.trim() : "";
    if (sessionId) killChatSession(sessionId);
    return jsonResponse({ ok: true });
  }

  // ── POST /chat/prefs (push model/thinking into a running chat subprocess) ─
  // Applies updated default model / thinking level to an already-running (or
  // pre-spawned) pi session in place, so Settings changes take effect on the
  // live agent without killing it and losing the conversation context.
  if (pathname === "/chat/prefs" && method === "POST") {
    let bodyText: string;
    try { bodyText = await readBody(req); } catch (err: any) { return jsonResponse({ error: err.message }, 413); }
    let parsed: any;
    try { parsed = JSON.parse(bodyText); } catch { return jsonResponse({ error: "invalid JSON" }, 400); }
    const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId.trim() : "";
    if (!sessionId) return jsonResponse({ error: "missing sessionId" }, 400);
    return jsonResponse(pushChatPrefs(sessionId, {
      model: typeof parsed.model === "string" ? parsed.model : "",
      thinkingLevel: typeof parsed.thinkingLevel === "string" ? parsed.thinkingLevel : "",
    }));
  }

  // ── POST /chat/ui (answer an extension_ui dialog, e.g. ask_user_question) ──
  // pi blocks while an extension waits on the host for a select/input dialog
  // (the ask_user_question questionnaire). The chat view renders the dialog
  // as an answerable card; answering POSTs here, which writes the matching
  // `extension_ui_response` back to the pi subprocess's stdin so the tool
  // resolves and the agent can continue.
  if (pathname === "/chat/ui" && method === "POST") {
    let bodyText: string;
    try { bodyText = await readBody(req); } catch (err: any) { return jsonResponse({ error: err.message }, 413); }
    let parsed: any;
    try { parsed = JSON.parse(bodyText); } catch { return jsonResponse({ error: "invalid JSON" }, 400); }
    const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId.trim() : "";
    const uiId = typeof parsed.id === "string" ? parsed.id.trim() : "";
    if (!sessionId || !uiId) return jsonResponse({ error: "missing sessionId or dialog id" }, 400);
    const ok = answerChatUi(sessionId, uiId, {
      value: typeof parsed.value === "string" ? parsed.value : "",
      cancelled: parsed.cancelled === true,
    });
    return jsonResponse({ ok, sessionId });
  }

  // ── GET /chat/stt/status (dictation availability for the composer mic) ──
  // Reports whether a host recorder and a Groq key are available, plus whether
  // a recording is live. The Chat view uses this to explain a greyed-out mic.
  if (pathname === "/chat/stt/status" && method === "GET") {
    const cwd = url.searchParams.get("cwd") ?? "";
    const absCwd = (cwd && validateCwd(cwd)) || TERMINAL_CWD;
    return jsonResponse(sttStatus(absCwd));
  }

  // ── POST /chat/stt/start (record the host microphone) ──────────────────
  // Mirrors the pi `speech-to-text` extension: capture on the host with
  // sox/arecord/ffmpeg, then transcribe with Groq Whisper on stop.
  if (pathname === "/chat/stt/start" && method === "POST") {
    let bodyText: string;
    try { bodyText = await readBody(req); } catch (err: any) { return jsonResponse({ error: err.message }, 413); }
    let parsed: any;
    try { parsed = JSON.parse(bodyText); } catch { return jsonResponse({ error: "invalid JSON" }, 400); }
    const cwd = typeof parsed.cwd === "string" ? parsed.cwd : "";
    if (!cwd) return jsonResponse({ error: "missing cwd" }, 400);
    const absCwd = validateCwd(cwd);
    if (!absCwd) return jsonResponse({ error: "invalid or disallowed cwd" }, 400);
    return jsonResponse(startStt(absCwd));
  }

  // ── POST /chat/stt/stop (stop recording + transcribe via Groq) ─────────
  // Returns { ok, text } — the transcript to splice into the composer.
  if (pathname === "/chat/stt/stop" && method === "POST") {
    return jsonResponse(await stopStt());
  }

  // ── GET /sessions ──────────────────────────────────────────────────────
  if (pathname === "/sessions" && method === "GET") {
    const pool = url.searchParams.get("pool") ?? "";
    const tag = url.searchParams.get("tag") ?? "";
    const since = url.searchParams.get("since") ?? "";
    const limit = intParam(url, "limit", 50, 200);

    try {
      const rows = q.listSessions.all({ $pool: pool, $tag: tag, $limit: limit }) as any[];

      // Filter by `since` in application code (optional low-frequency filter)
      const sessions = rows
        .filter((r) => !since || r.last_ts >= since)
        .map(rowToSession);

      // Annotate each session with the authoritative context window from the
      // model metadata store, keyed "<provider>/<model>" — the same source the
      // Chat footer gauge uses. The UI context bar otherwise falls back to a
      // small regex table that mis-sizes the alias models pi actually runs.
      const modelMeta = buildModelMeta();
      for (const s of sessions) {
        const key = s.provider && s.model ? `${s.provider}/${s.model}` : "";
        s.context_window = (key && modelMeta[key]?.contextWindow) || 0;
      }

      // Spawn linkage for subagent nesting in the UI. The exact parent is
      // stored on the session row (recorded by the extension from the
      // SCOPE_PARENT_SESSION env var its harness sets). For sessions without
      // one — anything recorded before that field existed, or harnesses that
      // don't set it — fall back to inferring from spawn-ish tool_call events.
      // Inference is batched into one query over the sessions that still need
      // it; failures are non-fatal — the list just renders flat.
      const needInfer = sessions.filter((s) => !s.parent_session_id);
      if (needInfer.length) {
        try {
          const ids = needInfer.map((s) => s.session_id);
          const parents = q.getSessionParents.all({ $session_ids: JSON.stringify(ids) }) as any[];
          const byChild = new Map(parents.map((p: any) => [p.child_id, p.parent_id]));
          for (const s of needInfer) s.parent_session_id = byChild.get(s.session_id) || undefined;
        } catch { /* nesting is optional — skip on query error */ }
      }

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

  // ── DELETE /sessions/:session_id (delete single session) ──────────────
  const sidDelete = matchSession(pathname);
  if (sidDelete && method === "DELETE") {
    try {
      q.deleteSessionEvents.run({ $session_id: sidDelete });
      q.deleteSessionRow.run({ $session_id: sidDelete });
      return jsonResponse({ ok: true, session_id: sidDelete });
    } catch (err: any) {
      return jsonResponse({ error: err.message }, 500);
    }
  }

  // ── GET /sessions/:session_id/seq (loopback-trusted) ───────────────────
  // Returns the highest stored seq for a session (or -1 if none). The
  // extension uses this to continue numbering a resumed session where it left
  // off — without it, continued events restart at 0, collide on the
  // (session_id, seq) UNIQUE index, and are silently dropped by INSERT OR
  // IGNORE (resumed transcripts go stale).
  const sidSeq = matchSessionSeq(pathname);
  if (sidSeq && method === "GET") {
    try {
      const row: any = q.getMaxSeq.get({ $session_id: sidSeq });
      return jsonResponse({ ok: true, session_id: sidSeq, seq: row?.max_seq ?? -1 });
    } catch (err: any) {
      return jsonResponse({ error: err.message }, 500);
    }
  }

  // ── GET /sessions/:session_id/events ───────────────────────────────────
  const sidEvents = matchSessionEvents(pathname);
  if (sidEvents && method === "GET") {
    const limit = intParam(url, "limit", 200, 1000);
    const beforeSeq = intOrNull(url, "before_seq");
    const sinceSeq = intOrNull(url, "since_seq");
    const type = url.searchParams.get("type") ?? "";

    try {
      if (sinceSeq !== null) {
        // Forward resync: seq > since_seq, ascending
        const rows = q.getSessionEventsSince.all({
          $session_id: sidEvents,
          $limit: limit,
          $since_seq: sinceSeq,
          $type: type,
        }) as any[];
        return jsonResponse({ events: rows.map(rowToEvent) });
      }

      const rows = q.getSessionEvents.all({
        $session_id: sidEvents,
        $limit: limit,
        $before_seq: beforeSeq,
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
      const modelRows = q.getSessionModelTokens.all({ $session_id: sidStats }) as any[];
      return jsonResponse({
        total_tokens: row.total_tokens ?? 0,
        input_tokens: row.input_tokens ?? 0,
        output_tokens: row.output_tokens ?? 0,
        total_cost: row.total_cost ?? 0,
        error_count: row.error_count ?? 0,
        latest_input: ctx?.latest_input ?? null,
        latest_ts: ctx?.latest_ts ?? null,
        models: (modelRows ?? []).map((m) => ({
          model: m.model ?? "unknown",
          total_tokens: m.total_tokens ?? 0,
          input_tokens: m.input_tokens ?? 0,
          output_tokens: m.output_tokens ?? 0,
          cost_total: m.cost_total ?? 0,
        })),
      });
    } catch (err: any) {
      return jsonResponse({ error: err.message }, 500);
    }
  }

  // ── GET /sessions/stats?ids=a,b,c (batch stats) ──────────────────────
  if (pathname === "/sessions/stats" && method === "GET") {
    const idsParam = url.searchParams.get("ids") ?? "";
    const ids = idsParam.split(",").map((s) => s.trim()).filter(Boolean);
    if (!ids.length) return jsonResponse({ stats: {} });
    try {
      const sessionIdsJson = JSON.stringify(ids);
      const rows = q.getBatchStats.all({ $session_ids: sessionIdsJson }) as any[];
      const stats = {};
      for (const r of rows) {
        stats[r.session_id] = {
          total_tokens: r.total_tokens ?? 0,
          input_tokens: r.input_tokens ?? 0,
          output_tokens: r.output_tokens ?? 0,
          total_cost: r.total_cost ?? 0,
          error_count: r.error_count ?? 0,
        };
      }
      return jsonResponse({ stats });
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

        // Initial hello — reuse the process-wide encoder (one less allocation
        // per connection, same as pushSSE).
        const hello = JSON.stringify({ server: "pi-scope", version: VERSION });
        controller.enqueue(sseEncoder.encode(`retry: 5000\nevent: hello\ndata: ${hello}\n\n`));
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


  // ══ Git GUI endpoints ════════════════════════════════════════════════════
  // A read/write git client for the shared working directory, exposed to the
  // Git view. Every operation goes through validateCwd() + resolveWithinCwd(),
  // the same sandbox as /files/* and /checkpoints/*.


  // ── Plugin routes ────────────────────────────────────────────────────────
  // Checked last so a plugin can never shadow a built-in route; a plugin that
  // wants a new namespace owns that namespace.
  const pluginMatch = matchPluginRoute(method, pathname);
  if (pluginMatch) {
    return runPluginRoute(pluginMatch, {
      url, method, req,
      readBody: (r) => readBody(r),
      json: (b, s) => jsonResponse(b, s),
      cwd: url.searchParams.get("cwd"),
    });
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
  // Carry the TCP peer address into the Web Request so the auth layer can tell a
  // loopback caller from a LAN one. Assigned AFTER the copy loop on purpose: a
  // client-supplied `x-scope-peer` header must never be able to spoof this.
  headers[PEER_HEADER] = req.socket.remoteAddress ?? "";
  const request = new Request(url, {
    method: req.method ?? "GET",
    headers,
    body,
  });
  let response: Response;
  try {
    response = await handle(request);
  } catch (err) {
    console.error("Request handling failed:", err);
    response = jsonResponse({ error: "Internal server error" }, 500);
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
wssRef = attachTerminal(server, {
  port: PORT,
  host: HOST,
  token: AUTH_TOKEN,
  launchCwd: TERMINAL_CWD,
  isEnabled: () => isPluginEnabled("terminal"),
  onCwdChange: (ws, cwd) => liveTerminalCwds.set(ws, cwd),
  onClose: (ws) => liveTerminalCwds.delete(ws),
});

// ─── Plugin host kit ────────────────────────────────────────────────────────
// The Files / Git / Checkpoints plugins are ordinary modules in
// `apps/scope-server/plugins/<id>/server.ts`; their routes no longer live in
// this file. What they still share is this kit — the git / porcelain / graph
// primitives plus the settings reader and cwd validation that are bound to
// server state (allowed file roots, live terminal cwds, project config).
// Handing it over at activation keeps a plugin from importing server.ts, which
// would re-enter a module that is still evaluating.
const pluginKit = {
  fs, path,
  jsonResponse, textResponse, readBody, intParam, intOrNull,
  validateCwd, readSettingsJson, DEFAULT_COMMIT_TEMPLATE, generateCommitMessage,
  git, gitTry, gitConfigArgs, ensureGitRepo,
  resolveWithinCwd, cleanPaths, rejectOptionLike,
  parsePorcelainLine, porcelainStatus,
  buildRepoGraph,
};

// Discover + activate plugins before accepting traffic so a plugin's routes are
// live from the first request (these routes used to be synchronous inline
// handlers, so a request that beat activation would have 404'd). A plugin that
// throws is reported on its record, never fatal.
discoverPlugins();
await activatePlugins({ kit: pluginKit });
{
  const active = pluginSnapshot().plugins as any[];
  if (process.env.SCOPE_VERBOSE) {
    console.log(`  Plugins: ${active.filter((p) => p.enabled).map((p) => p.id).join(", ") || "none"}`);
  }
}

server.listen(PORT, HOST, () => {
  console.log(`  Listening on http://${HOST}:${PORT}`);
  if (process.env.SCOPE_VERBOSE) console.log(`  Open the UI →  ${OPEN_URL}\n`);
});
