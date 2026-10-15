import { readFileSync, readdirSync, existsSync, writeFileSync, statSync, mkdirSync, copyFileSync } from "fs";
import { dirname, join } from "path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { scanDirs } from "./core";
import type { AgentDef, TeamMember, TeamConfig } from "./core";

export interface ParsedTeams {
  teams: Record<string, TeamMember[]>;
  memoryModel?: string;
  memoryActive?: boolean;
}

/** Strip UTF-8 BOM and normalize CRLF/CR to LF so the line-based parsing
 *  below matches cleanly across platforms. */
function normalize(raw: string): string {
  return raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

/** Parse a frontmatter block into a flat key→value map (last wins). */
function frontmatterKV(block: string): Record<string, string> {
  const fm: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return fm;
}

export function parseTeamsYaml(raw: string): ParsedTeams {
  raw = normalize(raw);
  const teams: Record<string, TeamMember[]> = {};
  let memoryModel: string | undefined;
  let memoryActive: boolean | undefined;
  let cur = "";
  let curMember: TeamMember | null = null;
  for (const line of raw.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    // Nested memory_model block: "memory_model:" followed by indented model:/active:
    const mmBlock = line.match(/^memory_model:\s*$/);
    if (mmBlock) {
      cur = "memory_model";
      curMember = null;
      // Opt-in: enabled only by an explicit active: true below; no default-on.
      continue;
    }
    const mm = line.match(/^memory_model:\s*(.+)$/);
    if (mm) {
      const v = mm[1].trim();
      if (v) memoryModel = v;
      // Opt-in: inline `memory_model: <model>` alone does NOT enable memory.
      cur = "";
      curMember = null;
      continue;
    }
    const tm = line.match(/^(\S[^:]*):$/);
    if (tm) { cur = tm[1].trim(); teams[cur] = []; curMember = null; continue; }
    if (!cur) continue;
    // Named member: "  - name: worker"
    const nm = line.match(/^\s*-\s+name:\s*(.+)$/);
    if (nm) {
      curMember = { name: nm[1].trim(), active: true };
      teams[cur].push(curMember);
      continue;
    }
    // Simple string member: "  - worker"
    const im = line.match(/^\s*-\s+(\S+)$/);
    if (im) {
      curMember = { name: im[1].trim(), active: true };
      teams[cur].push(curMember);
      continue;
    }
    // Member property: "    model: foo" or "    active: false"  (indented under a named member)
    const pm = line.match(/^\s{2,}(\w+):\s*(.+)$/);
    if (pm && curMember) {
      const key = pm[1].trim();
      if (key === "model") curMember.model = pm[2].trim();
      else if (key === "active") curMember.active = pm[2].trim().toLowerCase() !== "false";
      continue;
    }
    if (pm && cur === "memory_model" && !curMember) {
      const key = pm[1].trim();
      if (key === "model") memoryModel = pm[2].trim();
      else if (key === "active") memoryActive = pm[2].trim().toLowerCase() === "true";
      continue;
    }
  }
  const out: ParsedTeams = { teams };
  if (memoryModel) out.memoryModel = memoryModel;
  if (memoryActive !== undefined) out.memoryActive = memoryActive;
  return out;
}

export function parseAgentFile(fp: string): AgentDef | null {
  try {
    let raw = readFileSync(fp, "utf-8");
    raw = normalize(raw);
    const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    if (!m) return null;
    const fm = frontmatterKV(m[1]);
    if (!fm.name) return null;
    // Tool allowlist comes strictly from the frontmatter `tools:` key.
    // The body is intentionally NOT scanned — prose examples routinely
    // contain backtick-wrapped identifiers (Python libs, skill names,
    // sample tool names) that are NOT actual tools, and silently adding
    // them would widen the agent's permissions in surprising ways.
    const tools = new Set(
      (fm.tools || "read,grep,find,ls").split(",").map(s => s.replace(/\s+/g, "")).filter(Boolean)
    );
    return {
      name: fm.name,
      description: fm.description || "",
      tools: [...tools].join(","),
      model: fm.model,
      thinking: fm.thinking || undefined,
      skills: parseAgentSkills(fm.skills),
      systemPrompt: m[2].trim(),
      file: fp,
    };
  } catch { return null; }
}

/** Parse a frontmatter `skills:` value into short skill names.
 *  Empty/whitespace entries are ignored. */
function parseAgentSkills(raw?: string): string[] | undefined {
  if (raw === undefined) return undefined;
  const names: string[] = [];
  for (const name of raw.split(",")) {
    const trimmed = name.trim();
    if (trimmed) names.push(trimmed);
  }
  return names;
}

/** Project-local settings dir: <cwd>/.pi/settings. The pi CLI is launched
 *  from the project root, so process.cwd() identifies the current project.
 *  Project files take precedence on read; writes always go here so each
 *  project carries its own agent-team configuration. */
function projectSettingsPath(rel: string): string {
  return join(process.cwd(), ".pi", "settings", rel);
}

function projectTeamsYamlPath(): string {
  return projectSettingsPath(join("agents", "teams.yaml"));
}

/** Global default team definitions shipped in the agent dir. */
function globalTeamsYamlPath(): string {
  return join(getAgentDir(), "agents", "teams.yaml");
}

/** Read path for the team definitions file (teams.yaml): project-local
 *  <cwd>/.pi/settings/agents/teams.yaml when present, otherwise the global
 *  agent-dir copy. Single source for the path — it was previously rebuilt
 *  inline in 4 places. */
export function teamsYamlPath(): string {
  const p = projectTeamsYamlPath();
  if (existsSync(p)) return p;
  return globalTeamsYamlPath();
}

/** Write path for teams.yaml — always project-local so toggles persist
 *  per project instead of mutating the global config. */
function teamsYamlWritePath(): string {
  return projectTeamsYamlPath();
}

/** Materialize the project-local teams.yaml by copying the global default
 *  verbatim when the project file is absent. A byte-for-byte copy preserves
 *  comments, ordering, and keys the parser ignores, which re-serializing
 *  would drop. Returns true only when a copy was performed; no-op when the
 *  project file already exists, no global default exists, or the copy fails
 *  (the caller then reads through to the global file as before). */
export function seedProjectTeamsYaml(): boolean {
  const dest = projectTeamsYamlPath();
  if (existsSync(dest)) return false;
  const src = globalTeamsYamlPath();
  if (!existsSync(src)) return false;
  try {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a skill short name to an absolute SKILL.md path.
 *  Returns undefined if the skill directory does not exist.
 *
 *  Cached for the process lifetime: this runs once per skill per subagent
 *  spawn (see ProcessManager.spawnProc), and the skills directory does not
 *  change under a running session — the freshly scanned `discoverEnabledSkills`
 *  list already gates which names can reach here. */
const skillPathCache = new Map<string, string | undefined>();

export function resolveSkillPath(name: string): string | undefined {
  const cached = skillPathCache.get(name);
  if (cached !== undefined || skillPathCache.has(name)) return cached;
  const p = join(getAgentDir(), "skills", name, "SKILL.md");
  const resolved = existsSync(p) ? p : undefined;
  skillPathCache.set(name, resolved);
  return resolved;
}

// Extension discovery (scanExtensionPaths / loadDisabledExtensions / isDisabled)
// now lives in ./extensions — see that file for rationale.

export function scanAgents(cwd: string): AgentDef[] {
  const dirs = [
    join(cwd, "agents"),
    join(cwd, ".claude", "agents"),
    join(cwd, ".pi", "agents"),
    join(getAgentDir(), "agents"),
  ];
  const agents: AgentDef[] = [];
  const seen = new Set<string>();
  for (const fp of scanDirs(dirs, f => f.endsWith(".md"))) {
    const def = parseAgentFile(fp);
    if (def && !seen.has(def.name.toLowerCase())) {
      seen.add(def.name.toLowerCase());
      agents.push(def);
    }
  }
  return agents;
}

export interface Skill {
  name: string;
  description: string;
  /** Directory name under getAgentDir()/skills/. Used for path resolution. */
  dir: string;
}

/** Parse YAML frontmatter (very limited: just `name:` and `description:`) */
function parseSkillFrontmatter(raw: string): { name: string; description: string } | null {
  const m = normalize(raw).match(/^---\s*\n([\s\S]*?)\n---\s*/);
  if (!m) return null;
  const fm = frontmatterKV(m[1]);
  return fm.name ? { name: fm.name, description: fm.description || "" } : null;
}

/** Convert settings.json `skills` entry to a skill name.
 *  Entries look like:
 *    "-skills/electron-scaffold/SKILL.md"  -> disabled
 *    "+skills/foo/SKILL.md" or "skills/foo/SKILL.md" -> enabled
 *  Returns { name, disabled } or null if the entry doesn't look like a skill. */
function parseSkillSettingEntry(entry: string): { name: string; disabled: boolean } | null {
  const m = entry.match(/^([-+]?)skills\/([^/]+)\/SKILL\.md$/);
  if (!m) return null;
  return { name: m[2], disabled: m[1] === "-" };
}

/** Single cached scan backing both discoverEnabledSkills and
 *  discoverAllSkills. Keyed by the max mtime of settings.json + the skills
 *  dir; one directory pass produces both lists (previously the sidebar's
 *  discoverAllSkills re-read every SKILL.md on each open). */
let skillsCache: { mtime: number; all: Skill[]; enabled: Skill[] } | null = null;

function skillsCacheKey(): number {
  let key = 0;
  const settingsPath = join(getAgentDir(), "settings.json");
  if (existsSync(settingsPath)) {
    try { key = Math.max(key, statSync(settingsPath).mtimeMs); } catch { /* ignore */ }
  }
  try { key = Math.max(key, statSync(join(getAgentDir(), "skills")).mtimeMs); } catch { /* ignore */ }
  return key;
}

function cachedSkills(): { all: Skill[]; enabled: Skill[] } {
  if (!existsSync(join(getAgentDir(), "skills"))) return { all: [], enabled: [] };
  const key = skillsCacheKey();
  if (skillsCache && skillsCache.mtime === key) return skillsCache;
  const result = scanSkills();
  skillsCache = { mtime: key, ...result };
  return skillsCache;
}

/** Discover skills enabled in settings.json (skills listed with `-` are disabled). */
export function discoverEnabledSkills(): Skill[] {
  return cachedSkills().enabled;
}

/** Discover ALL skills, including those disabled in settings.json.
 *  Used by the sidebar so users can toggle skills on/off. */
export function discoverAllSkills(): Skill[] {
  return cachedSkills().all;
}

/** One directory pass over getAgentDir()/skills/, deriving both the full
 *  list and the settings-filtered enabled list. */
function scanSkills(): { all: Skill[]; enabled: Skill[] } {
  const skillsDir = join(getAgentDir(), "skills");
  const settingsPath = join(getAgentDir(), "settings.json");
  const disabled = new Set<string>();
  if (existsSync(settingsPath)) {
    try {
      const raw = JSON.parse(readFileSync(settingsPath, "utf-8"));
      const list: string[] = Array.isArray(raw?.skills) ? raw.skills : [];
      for (const entry of list) {
        if (typeof entry !== "string") continue;
        const parsed = parseSkillSettingEntry(entry);
        if (!parsed) continue;
        if (parsed.disabled) disabled.add(parsed.name);
      }
    } catch { /* ignore */ }
  }
  const all: Skill[] = [];
  for (const f of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!f.isDirectory()) continue;
    const skillMd = join(skillsDir, f.name, "SKILL.md");
    if (!existsSync(skillMd)) continue;
    try {
      const raw = readFileSync(skillMd, "utf-8");
      const fm = parseSkillFrontmatter(raw);
      all.push(fm ? { name: fm.name, description: fm.description, dir: f.name } : { name: f.name, description: "", dir: f.name });
    } catch { /* skip unreadable */ }
  }
  return { all, enabled: all.filter(s => !disabled.has(s.dir)) };
}

/** Load AGENTS.md content. Tries cwd first, then falls back to getAgentDir()/AGENTS.md.
 *  Returns the trimmed content, or null if neither file exists.
 *  Cached by mtimeMs of the chosen candidate; re-reads only if the file changes. */
/** Cached result keyed by candidate mtimeMs. */
let agentMdCache: { key: number; content: string | null } | null = null;

export function loadAgentMd(cwd: string): string | null {
  const candidates = [join(cwd, "AGENTS.md"), join(getAgentDir(), "AGENTS.md")];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    let mtime = 0;
    try { mtime = statSync(p).mtimeMs; } catch { continue; }
    if (agentMdCache && agentMdCache.key === mtime) return agentMdCache.content;
    try {
      const raw = readFileSync(p, "utf-8").trim();
      const content = raw || null;
      agentMdCache = { key: mtime, content };
      return content;
    } catch { /* try next */ }
  }
  return null;
}

// ── Config Persistence ────────────────────────────────────────────────

/** Cached result keyed by mtimeMs. Invalidates when teams.yaml changes. */
let teamsYamlCache: { key: string; parsed: ParsedTeams } | null = null;

/** Load and parse teams.yaml, cached by mtimeMs so `loadAgents` doesn't
 *  re-read+re-parse on every toggle. Returns an empty ParsedTeams when
 *  the file doesn't exist. */
export function loadTeamsYaml(filePath: string): ParsedTeams {
  if (!existsSync(filePath)) {
    teamsYamlCache = null;
    return { teams: {} };
  }
  let mtime = 0;
  try { mtime = statSync(filePath).mtimeMs; } catch { /* fall through */ }
  const key = `${filePath}:${mtime}`;
  if (teamsYamlCache && teamsYamlCache.key === key) return teamsYamlCache.parsed;
  const parsed = parseTeamsYaml(readFileSync(filePath, "utf-8"));
  teamsYamlCache = { key, parsed };
  return parsed;
}

/** Serialize a ParsedTeams structure back to YAML and write to disk.
 *  Preserves comments and ordering is best-effort (teams are rebuilt from
 *  the in-memory data). */
export function saveTeamsYaml(filePath: string, data: ParsedTeams): void {
  const lines: string[] = [];
  lines.push("# Agent Team Definitions");
  lines.push("# ---------------------------------------------");
  lines.push("# Simple format:");
  lines.push("#   team_name:");
  lines.push("#     - agent_name");
  lines.push("#");
  lines.push("# With model override (takes precedence over .md frontmatter model):");
  lines.push("#   team_name:");
  lines.push("#     - name: agent_name");
  lines.push("#       model: provider/model-name");
  lines.push("#");
  lines.push("# Top-level keys:");
  lines.push("#   memory_model:");
  lines.push("#       model: <provider>/<model>  - summarizer model; memory runs only when active: true.");
  lines.push("#       active: true|false         - persistent on/off switch (must be true to run; sidebar toggle).");
  lines.push("#       A background subprocess summarizes each orchestrator turn and writes");
  lines.push("#       per-category files under <cwd>/.pi_memory/.");
  lines.push("");
  // Write the memory_model block whenever any part of it is set, so a
  // seeded file always carries an explicit `active:` switch (false by
  // default when no model is configured).
  if (data.memoryModel || data.memoryActive !== undefined) {
    lines.push("memory_model:");
    if (data.memoryModel) lines.push(`  model: ${data.memoryModel}`);
    lines.push(`  active: ${data.memoryActive === true ? "true" : "false"}`);
    lines.push("");
  }
  for (const [teamName, members] of Object.entries(data.teams)) {
    lines.push(`${teamName}:`);
    for (const m of members) {
      // Always use named format so we can include model and active
      lines.push(`  - name: ${m.name}`);
      if (m.model) lines.push(`    model: ${m.model}`);
      if (m.active === false) lines.push(`    active: false`);
    }
    lines.push("");
  }
  // Invalidate the in-memory cache since we just wrote new content.
  teamsYamlCache = null;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, lines.join("\n") + "\n");
}

/** Persist the given teams (plus memory_model flags) to the project-local
 *  teams.yaml. Used to seed the file when it doesn't exist yet, so that
 *  subsequent updateTeamsYaml calls find their members and persist. */
export function persistTeams(
  teams: Record<string, TeamMember[]>,
  memoryModel?: string,
  memoryActive?: boolean,
): void {
  saveTeamsYaml(teamsYamlWritePath(), {
    teams,
    ...(memoryModel ? { memoryModel } : {}),
    ...(memoryActive !== undefined ? { memoryActive } : {}),
  });
}

/** Read-modify-write teams.yaml in one step (load → mutate → save), so
 *  toggle sites don't each rebuild the load/save round-trip. Loads from
 *  the effective read path (project or global fallback) and always writes
 *  to the project-local path, migrating global config on first write. */
export function updateTeamsYaml(mutate: (parsed: ParsedTeams) => void): void {
  const parsed = loadTeamsYaml(teamsYamlPath());
  mutate(parsed);
  saveTeamsYaml(teamsYamlWritePath(), parsed);
}

export const CONFIG_FILE = "agent-team-config.json";

/** Global default agent-team config shipped in the agent dir. */
function globalConfigPath(): string {
  return join(getAgentDir(), CONFIG_FILE);
}

/** Materialize the project-local agent-team-config.json by copying the global
 *  default verbatim when the project file is absent. Mirrors
 *  seedProjectTeamsYaml: a byte-for-byte copy keeps formatting and unknown keys
 *  intact. No-op (returns false) when the project file exists, no global
 *  default exists, or the copy fails — callers then read through to the global
 *  file exactly as before. */
export function seedProjectConfig(): boolean {
  const dest = projectSettingsPath(CONFIG_FILE);
  if (existsSync(dest)) return false;
  const src = globalConfigPath();
  if (!existsSync(src)) return false;
  try {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    return true;
  } catch {
    return false;
  }
}

/** Load persisted config: project-local <cwd>/.pi/settings/agent-team-config.json
 *  when present, otherwise the global agent-dir copy. */
export function loadPersistedConfig(): Partial<TeamConfig> {
  const p = projectSettingsPath(CONFIG_FILE);
  const file = existsSync(p) ? p : globalConfigPath();
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, "utf-8")); } catch { return {}; }
}

/** Persist config to the project-local path so settings are per project.
 *
 *  The retired `subagentSkills` key is stripped here rather than in persist()
 *  because persist() spreads the on-disk config first (so manual edits to
 *  untracked keys survive): a file that still carries the old key would
 *  otherwise re-write it forever. Subagent skills live in the definition —
 *  `agents/<name>.md` `skills:` — which is the only source of truth now. */
export function savePersistedConfig(cfg: TeamConfig) {
  const p = projectSettingsPath(CONFIG_FILE);
  mkdirSync(dirname(p), { recursive: true });
  const { subagentSkills: _retired, ...rest } = cfg as TeamConfig & { subagentSkills?: unknown };
  writeFileSync(p, JSON.stringify(rest, null, 2));
}
