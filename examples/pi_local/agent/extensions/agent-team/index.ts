/**
 * Agent Team - Ephemeral subagent orchestrator
 *
 * Subagents are spawned on-demand per task. A fresh `pi --mode rpc` process
 * is created for each dispatch, the task runs, and the process is killed
 * once the result is reported back to the orchestrator. No context
 * accumulates between dispatches — each task starts with a clean slate.
 *
 * Lifecycle:
 *   session_start  → load agent defs only (NO spawning)
 *   dispatch       → spawn fresh process → send task → await result → kill
 *   session_end    → cleanup any residual processes
 *
 * Commands:
 *   /agents-team          - switch active team
 *   /agents-list          - list agents + process status
 *   /agents-grid N        - set grid columns (default 1)
 *   /agents-team-toggle   - enable/disable (on/off/status)
 *   /agents-restart       - kill any running subagent processes
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { mkdirSync, existsSync, readFileSync, statSync } from "fs";
import { readdir as readdirAsync, stat as statAsync, unlink as unlinkAsync } from "fs/promises";
import { join } from "path";

import type { AgentDef, AgentProc, TeamMember, TeamConfig, AgentTeamContext, BatchDispatchResult, AgentMode } from "./core";
import { displayName, shortModel, SessionLogger, RwLock, filterSkills, agentNameKey, DEFAULT_DISPATCH_TIMEOUT_MS, clampDispatchTimeout } from "./core";
import { loadPersistedConfig, savePersistedConfig, scanAgents, loadTeamsYaml, discoverEnabledSkills, loadAgentMd, teamsYamlPath, persistTeams, seedProjectTeamsYaml, seedProjectConfig, resolveSkillPath } from "./config";
// A subagent's skills are NOT a team setting any more: each definition's own
// `agents/<name>.md` frontmatter `skills:` key is the single source of truth
// (see config.ts#parseAgentFile and orchestration.ts#spawnProc). The retired
// `subagentSkills` array is dropped from the file on the next save.
import { scanExtensionPaths, refreshExtensionSettings, extensionSettingsSignature, orchestratorHiddenTools } from "./extensions";
import { ProcessManager, activateTeam as activateTeamImpl, handleEvent as handleEventImpl, dispatchTasks as dispatchTasksImpl } from "./orchestration";
import { MemoryManager, createMemoryManager, extractLastAssistantText, installMemoryEscEditor, memoryFiles } from "./memory";
import { buildSystemPrompt, initWidget as initWidgetImpl, invalidate as invalidateImpl, closeSidebar } from "./ui";
import { registerDispatchTool, registerCommands, registerShortcut } from "./integrations";
import { fullModelId } from "./helpers";

/** Remove session files older than 24 hours to prevent unbounded disk growth
 *  when the CLI exits abruptly and leaves orphaned files behind.
 *  Uses async I/O to avoid blocking the event loop. */
/** All tool names except the dispatch tool — the active-tool set restored
 *  whenever the agent team is disabled. Shared by disableAgentTeam and the
 *  disabled session_start path so the exclusion list can't drift apart. */
function nonDispatchTools(pi: ExtensionAPI): string[] {
  return pi.getAllTools().map(t => t.name).filter(n => n !== "dispatch_agents");
}

async function cleanupOldSessionFiles(sessionDir: string) {
  const CUTOFF_MS = 24 * 60 * 60 * 1000;
  try {
    const now = Date.now();
    const files = await readdirAsync(sessionDir);
    await Promise.all(files.map(async (f) => {
      const p = join(sessionDir, f);
      try {
        const st = await statAsync(p);
        if (now - st.mtimeMs > CUTOFF_MS) await unlinkAsync(p);
      } catch { /* ignore per-file errors */ }
    }));
  } catch { /* ignore directory read errors */ }
}

export class AgentTeam implements AgentTeamContext {
  pi: ExtensionAPI;
  procs = new Map<string, AgentProc>(); // key = lowercase name
  allDefs: AgentDef[] = [];
  teams: Record<string, TeamMember[]> = {};
  saved: Partial<TeamConfig> = {};
  activeTeam = "";
  gridCols = 2;
  animFrame = 0;
  wCtx: any = null;
  wInvalidate: (() => void) | null = null;
  sessionDir = "";
  skillsCache: Array<{ name: string; description: string; dir: string }> = [];
  agentMdCache: string | null = null;
  enabled = true;
  parallelDispatch = true;
  maxParallel = 5;
  /** Hard wall-clock cap (ms) for a single subagent dispatch. */
  dispatchTimeoutMs = DEFAULT_DISPATCH_TIMEOUT_MS;
  /** Orchestrator system-prompt mode: "standard" (strict) or "creative". */
  mode: AgentMode = "standard";
  /** Debug verbosity for the dispatch pipeline (0 off, 1 lifecycle, 2 raw JSONL).
   *  See DebugLevel in core.ts. Persisted in agent-team-config.json. */
  debugLevel = 0;
  destructiveTools: string[] = ["custom_edit", "custom_write", "edit", "write", "web-fetch"];
  dispatchLock: RwLock = new RwLock();
  batchClones = new Set<AgentProc>();
  /** Set of agent names that are temporarily disabled by the user */
  disabledAgents = new Set<string>();
  /** Skill directory names enabled for orchestrator system prompt. Empty = none. */
  orchestratorSkills = new Set<string>();
  /** Orchestrator tool denylist. Tools listed are hidden from the orchestrator. Empty = all tools shown. */
  skipOrchestratorTools: string[] = [];

  // Live external config sync: signature of the tool-affecting fields last
  // applied from disk (see startConfigWatch), so the poll only re-applies on
  // real changes instead of every tick.
  private appliedConfigSig = "";
  private appliedExtSettingsSig = "";
  private configWatchTimer: ReturnType<typeof setInterval> | null = null;

  cachedExtPaths: string[] = []; // resolved once per session_start

  // Bound once so the same reference can be used for both `on` and `off`,
  // and so `this` is the team (not the WriteStream emitter) on invocation.
  resizeHandler = () => this.handleTerminalResize();
  orchestratorModel = ""; // model id from orchestrator's context

  // Memory feature (only used when memoryModel is set AND active: true in teams.yaml)
  memoryModel = "";
  memoryActive = false;
  originalMemoryModel = ""; // preserved value for re-enabling after toggle off
  memoryDir = "";
  memoryManager: MemoryManager | null = null;

  logger: SessionLogger;
  procMgr: ProcessManager;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
    // Materialize the project-scoped agent-team-config.json from the global
    // default (verbatim copy) before the first read, so the project file
    // exists for every later read — the config watcher and savePersistedConfig
    // included — instead of silently reading through to the global file.
    seedProjectConfig();
    this.saved = loadPersistedConfig();
    this.gridCols = this.saved.gridCols ?? 2;
    this.enabled = this.saved.enabled ?? true;
    this.parallelDispatch = this.saved.parallelDispatch ?? true;
    this.maxParallel = this.saved.maxParallel ?? 5;
    this.dispatchTimeoutMs = clampDispatchTimeout(this.saved.dispatchTimeoutMs);
    this.debugLevel = this.saved.debugLevel ?? 0;
    this.mode = this.saved.mode ?? "standard";
    this.destructiveTools = this.saved.destructiveTools ?? ["custom_edit", "custom_write", "edit", "write", "web-fetch"];
    this.disabledAgents = new Set(this.saved.disabledAgents ?? []);
    this.orchestratorSkills = new Set(this.saved.orchestratorSkills ?? []);
    this.skipOrchestratorTools = this.saved.skipOrchestratorTools ?? [];

    this.logger = new SessionLogger();

    // Wire the debug config through statics so core.ts never has to import
    // the runtime context (import cycle). SessionLogger.debugDir is set in
    // loadAgents once sessionDir is known.
    SessionLogger.debugLevel = this.debugLevel;

    // ProcessManager takes accessor closures so it can read the latest
    // values of sessionDir/cachedExtPaths/orchestratorModel without
    // holding stale references. `this` is stable for invalidate.
    this.procMgr = new ProcessManager(
      () => this.sessionDir,
      () => this.cachedExtPaths,
      () => this.orchestratorModel,
      () => this.invalidate(),
      this.logger,
    );

    // External config changes (web Chat view toggles, hand edits) apply to the
    // RUNNING process instead of only the next one.
    this.startConfigWatch();
  }

  // ── Live external config sync ─────────────────────────────────────
  // The web Chat view (Scope) toggles tools by rewriting agent-team-config.json
  // (its POST /agent-team writes the same project-local file this extension
  // reads). The extension only reads the config at construction, so without
  // this poll a web-side toggle would never reach the RUNNING pi subprocess —
  // it would only land on a restarted session. Watch the effective config
  // file's mtime and, when a tool-affecting field changes on disk, re-apply
  // the active tool allowlist immediately (the same call the sidebar's own
  // toggle makes), so the next turn runs under the new denylist with the
  // conversation intact.
  startConfigWatch() {
    this.stopConfigWatch();
    this.appliedConfigSig = this.configFileSig();
    this.appliedExtSettingsSig = extensionSettingsSignature(this.cachedExtPaths);
    this.configWatchTimer = setInterval(() => {
      // Per-extension extension.json edits are watched separately from the
      // agent-team config so a change applies on the next dispatch (subagents)
      // or repaint (orchestrator tools) instead of needing a restart.
      const extSig = extensionSettingsSignature(this.cachedExtPaths);
      if (extSig !== this.appliedExtSettingsSig) {
        this.appliedExtSettingsSig = extSig;
        refreshExtensionSettings(this.cachedExtPaths);
        try { this.pi.setActiveTools(this.activeToolList()); } catch { /* not ready yet */ }
        this.invalidate();
      }
      const sig = this.configFileSig();
      if (sig === this.appliedConfigSig) return;
      this.appliedConfigSig = sig;
      const cfg = loadPersistedConfig();
      const skip = Array.isArray(cfg.skipOrchestratorTools) ? cfg.skipOrchestratorTools.map(s => String(s)) : [];
      const keyOf = (a: string[]) => a.map(s => s.toLowerCase()).sort().join(",");
      if (keyOf(skip) !== keyOf(this.skipOrchestratorTools)) this.skipOrchestratorTools = skip;
      if (typeof cfg.parallelDispatch === "boolean" && cfg.parallelDispatch !== this.parallelDispatch) {
        this.parallelDispatch = cfg.parallelDispatch;
      }
      if (cfg.dispatchTimeoutMs !== undefined) {
        const next = clampDispatchTimeout(cfg.dispatchTimeoutMs);
        if (next !== this.dispatchTimeoutMs) {
          this.dispatchTimeoutMs = next;
          if (this.wCtx) this.wCtx.ui.notify(`Subagent dispatch timeout: ${Math.round(next / 60000)} min`, "info");
        }
      }
      // Duty is per team and lives in teams.yaml's roster rows; the Scope UI
      // (Office / Settings) writes that same file. Re-derive the running
      // session's off-list from whichever team is active so a duty toggle made
      // in either place reaches the other, and a member kept off duty on
      // another team can never leak into this one.
      const liveMembers = loadTeamsYaml(teamsYamlPath()).teams[this.activeTeam] || [];
      const liveOff = new Set(liveMembers.filter(m => m.active === false).map(m => agentNameKey(m.name)));
      if (keyOf([...liveOff]) !== keyOf([...this.disabledAgents])) {
        // Mirror the sidebar's own toggle: a subagent that just went off duty
        // stops running rather than finishing its turn first.
        for (const key of liveOff) {
          if (this.disabledAgents.has(key)) continue;
          const ap = this.procs.get(key);
          if (!ap) continue;
          if (ap.status === "running" || ap.status === "starting") this.killProc(ap, true);
          ap.status = "dead";
        }
        this.disabledAgents = liveOff;
        // Keep the active team's in-memory rows in step for the sidebar.
        if (this.teams[this.activeTeam]) this.teams[this.activeTeam] = liveMembers;
      }
      try {
        this.pi.setActiveTools(this.activeToolList());
      } catch { /* pi runtime not initialized yet — next tick retries */ }
      this.invalidate();
    }, 1500);
    // Don't keep an otherwise-idle pi process alive just for the poll.
    if (typeof this.configWatchTimer.unref === "function") this.configWatchTimer.unref();
  }

  stopConfigWatch() {
    if (this.configWatchTimer) { clearInterval(this.configWatchTimer); this.configWatchTimer = null; }
  }

  /** Effective agent-team-config.json path + mtime — the change signature the
   *  watcher polls on (mirrors loadPersistedConfig's read resolution). */
  private configFileSig(): string {
    const p = join(process.cwd(), ".pi", "settings", "agent-team-config.json");
    const file = existsSync(p) ? p : join(getAgentDir(), "agent-team-config.json");
    try { return `${file}:${statSync(file).mtimeMs}`; } catch { return "none"; }
  }

  // ── Orchestration delegation (ctx -> this.procMgr) ──

  killProc(ap: AgentProc, immediate?: boolean) {
    this.procMgr.killProc(ap, immediate);
  }

  async killAll(): Promise<void> {
    await this.procMgr.killAll(this);
  }

  spawnProc(ap: AgentProc): Promise<boolean> {
    return this.procMgr.spawnProc(this, ap);
  }

  wipeSessionFile(ap: AgentProc) {
    this.procMgr.wipeSessionFile(ap);
  }

  resolveIfPending(ap: AgentProc, output: string, code: number) {
    this.procMgr.resolveIfPending(ap, output, code);
  }

  writeSystemPrompt(ap: AgentProc) {
    // Pass memory info so subagent prompts get the Project Memory section when
    // memory is enabled (mirrors how the orchestrator prompt receives it).
    this.procMgr.writeSystemPrompt(ap, this.mode, this.memoryManager ? { dir: this.memoryDir, files: memoryFiles(this.memoryDir) } : null);
  }

  cleanSystemPrompt(ap: AgentProc) {
    this.procMgr.cleanSystemPrompt(ap);
  }

  // ── Dispatch / RPC delegation ──

  async dispatchTasks(tasks: Array<{ agent: string; task: string }>, signal?: AbortSignal): Promise<BatchDispatchResult> {
    return dispatchTasksImpl(this, tasks, signal);
  }

  async activateTeam(name: string) {
    return activateTeamImpl(this, name);
  }

  handleEvent(ap: AgentProc, line: string) {
    handleEventImpl(this, ap, line);
  }

  // ── UI delegation ──

  initWidget() {
    initWidgetImpl(this);
  }

  invalidate() {
    invalidateImpl(this);
  }

  // ── Local instance methods ──

  /** Agent header: "[name][model] - heading" */
  tag(ap: AgentProc, heading: string): string {
    return `[${displayName(ap.def.name)}][${shortModel(ap.model)}] - ${heading}`;
  }

  // Persist current runtime state to disk
  persist() {
    // Read the on-disk config so manual edits to keys the runtime doesn't
    // track (and partial writes) survive. savePersistedConfig does a full
    // file rewrite, so without this merge any user edit to skipOrchestratorTools
    // (or other keys) gets clobbered by the stale construction-time snapshot.
    const onDisk = loadPersistedConfig();
    savePersistedConfig({
      ...onDisk,
      activeTeam: this.activeTeam,
      gridCols: this.gridCols,
      enabled: this.enabled,
      mode: this.mode,
      parallelDispatch: this.parallelDispatch,
      maxParallel: this.maxParallel,
      dispatchTimeoutMs: this.dispatchTimeoutMs,
      debugLevel: this.debugLevel,
      destructiveTools: this.destructiveTools,
      disabledAgents: Array.from(this.disabledAgents),
      orchestratorSkills: Array.from(this.orchestratorSkills),
      // skipOrchestratorTools has a runtime setter now (sidebar tool toggles),
      // so the runtime value always wins over the on-disk copy.
      skipOrchestratorTools: this.skipOrchestratorTools,
    });
  }

  /** All tools available to the orchestrator. Excludes the dispatch routing
   *  tool (dispatch_agents), which is governed by the parallelDispatch setting
   *  rather than the sidebar tool list. */
  allTools(): string[] {
    return this.pi.getAllTools().map(t => t.name).filter(n => n !== "dispatch_agents");
  }

  /** Enable/disable an orchestrator tool from the sidebar. Disabling adds it
   *  to the skip denylist (hidden from the orchestrator prompt + allowlist);
   *  enabling removes it. Persists and re-applies the active tool allowlist
   *  immediately so the next turn sees the change. */
  toggleOrchestratorTool(name: string, enabled: boolean) {
    const key = name.toLowerCase();
    const i = this.skipOrchestratorTools.findIndex(t => t.toLowerCase() === key);
    if (enabled) {
      if (i >= 0) this.skipOrchestratorTools.splice(i, 1);
    } else if (i < 0) {
      this.skipOrchestratorTools.push(name);
    }
    this.persist();
    this.pi.setActiveTools(this.activeToolList());
    this.invalidate();
  }

  /** Active tool allowlist. The single `dispatch_agents` routing tool is always
   *  exposed; whether a batch runs in parallel is decided at dispatch time from
   *  `parallelDispatch` rather than by swapping tools.
   *
   *  Two denylists apply: tools the user switched off in the sidebar, and tools
   *  whose extension declares `orchestrator: false` in its extension.json. */
  activeToolList(): string[] {
    const all = this.pi.getAllTools().map(t => t.name);
    // Start from full PI tool set, remove internal routing tools
    let base = all.filter(n => n !== "dispatch_agents");
    const block = new Set(this.skipOrchestratorTools.map(t => t.toLowerCase()));
    for (const t of orchestratorHiddenTools(this.cachedExtPaths)) block.add(t);
    if (block.size) base = base.filter(n => !block.has(n.toLowerCase()));
    base.unshift("dispatch_agents");
    return base;
  }

  // ── Logging methods (bound to logger) ──

  handleTerminalResize() {
    this.invalidate();
  }

  // ── Agent Loading ───────────────────────────────────────────────

  async loadAgents(cwd: string): Promise<void> {

    // Project-local so each project keeps its own session logs.
    this.sessionDir = join(cwd, ".pi", "agent-team-log", "agent-sessions");
    this.memoryDir = join(cwd, ".pi_memory");
    mkdirSync(this.sessionDir, { recursive: true });
    // Level-2 debug traces land next to the session files.
    SessionLogger.debugDir = this.sessionDir;
    void cleanupOldSessionFiles(this.sessionDir); // fire-and-forget async cleanup

    this.allDefs = scanAgents(cwd);
    this.cachedExtPaths = scanExtensionPaths(cwd);
    // Prime the extension.json cache for this session (and adopt the current
    // signature) so per-dispatch lookups never touch the filesystem.
    refreshExtensionSettings(this.cachedExtPaths);
    this.appliedExtSettingsSig = extensionSettingsSignature(this.cachedExtPaths);
    this.skillsCache = discoverEnabledSkills();
    this.agentMdCache = loadAgentMd(cwd);

    // Materialize the project-scoped teams.yaml from the global default on
    // first load (verbatim copy, comments included). Without this the project
    // file never appears and every session reads through to the global file,
    // so project edits and the global default can never diverge cleanly.
    seedProjectTeamsYaml();

    const parsed = loadTeamsYaml(teamsYamlPath());
    this.teams = parsed.teams;
    this.memoryModel = parsed.memoryModel || "";
    this.originalMemoryModel = this.memoryModel;
    this.memoryActive = parsed.memoryActive === true;

    // Tear down any prior memory manager and (re)create if the model is set.
    // When memoryModel is empty/undefined the feature is fully disabled:
    // the manager is never constructed and the event hooks are no-ops.
    if (this.memoryManager) {
      await this.memoryManager.awaitIdle(0);
    }
    this.memoryManager = null;
    if (this.memoryModel && this.memoryActive) {
      this.memoryManager = createMemoryManager(this, this.memoryModel);
    }

    if (!Object.keys(this.teams).length) {
      this.teams = { all: this.allDefs.map(d => ({ name: d.name })) };
      // Seed teams.yaml (project-local) with the fallback so later sidebar
      // toggles find their members in the file and persist correctly.
      // Without this, updateTeamsYaml loads an empty file, finds no member
      // to mutate, and every toggle is silently lost.
      // memory_model is seeded explicit-off with no model; toggleMemory
      // falls back to the orchestrator's model when enabling.
      persistTeams(this.teams, "", false);
    }
  }

  // ── Shared enable/disable (used by command + shortcut) ─────────

  async enableAgentTeam(ctx: any) {
    this.enabled = true;
    this.persist();

    await this.killAll();
    this.procs.clear();

    this.loadAgents(ctx.cwd);

    const names = Object.keys(this.teams);
    const teamToActivate = (this.activeTeam && names.includes(this.activeTeam)) ? this.activeTeam : (names[0] || "");
    if (teamToActivate) {
      await this.activateTeam(teamToActivate);
    }

    this.pi.setActiveTools(this.activeToolList());
    this.invalidate();
    this.wCtx = ctx;
    ctx.ui.setStatus("agent-team", `Team: ${this.activeTeam} (${this.procs.size})`);
    setAgentTeamHeader(ctx, true, isContextPrunerEnabled(ctx.cwd));
  }

  async disableAgentTeam(ctx: any) {
    this.enabled = false;
    this.persist();
    await this.killAll();
    this.wCtx = ctx;
    // Restore all tools EXCEPT dispatch_agents
    this.pi.setActiveTools(nonDispatchTools(this.pi));
    this.invalidate();
    setAgentTeamHeader(ctx, false, false);
  }
}

function buildBanner(): string {
  // Rainbow VS banner — each line gets its own 256-color wrap.
  // We embed raw SGR codes so the colors survive the TUI header render.
  const RST = "\x1b[0m";
  const rb = (s: string, i: number) =>
    `\x1b[38;5;${[196, 208, 226, 46, 51, 21, 201][i % 7]}m${s}${RST}`;
  return (
    rb(`VVVVVVVV           VVVVVVVV   SSSSSSSSSSSSSSS `, 0) + "\n" +
    rb(`V::::::V           V::::::V SS:::::::::::::::S`, 1) + "\n" +
    rb(`V::::::V           V::::::VS:::::SSSSSS::::::S`, 2) + "\n" +
    rb(`V::::::V           V::::::VS:::::S     SSSSSSS`, 3) + "\n" +
    rb(` V:::::V           V:::::V S:::::S            `, 4) + "\n" +
    rb(`  V:::::V         V:::::V  S:::::S            `, 5) + "\n" +
    rb(`   V:::::V       V:::::V    S::::SSSS         `, 6) + "\n" +
    rb(`    V:::::V     V:::::V      SS::::::SSSSS    `, 7) + "\n" +
    rb(`     V:::::V   V:::::V         SSS::::::::SS  `, 8) + "\n" +
    rb(`      V:::::V V:::::V             SSSSSS::::S `, 9) + "\n" +
    rb(`       V:::::V:::::V                    S:::::S`, 10) + "\n" +
    rb(`        V:::::::::V                    S:::::S`, 11) + "\n" +
    rb(`         V:::::::V         SSSSSSS     S:::::S`, 12) + "\n" +
    rb(`          V:::::V          S::::::SSSSSS:::::S`, 13) + "\n" +
    rb(`           V:::V           S:::::::::::::::SS `, 14) + "\n" +
    rb(`            VVV             SSSSSSSSSSSSSSS   `, 15) + "\n" +
    `/agents-team           Select a team\n` +
    `Alt+S                  Toggle sidebar\n`
  );
}

/** Read context-pruner state from its persisted config. */
function isContextPrunerEnabled(cwd: string): boolean {
  try {
    const p = join(cwd, ".pi", "context-pruner-config.json");
    if (!existsSync(p)) return false;
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    return raw.enabled === true;
  } catch {
    return false;
  }
}

function setAgentTeamHeader(ctx: any, enabled: boolean, prunerEnabled: boolean = false) {
  if (!ctx.ui?.setHeader) return;
  if (!enabled) {
    ctx.ui.setHeader(undefined);
    return;
  }
  ctx.ui.setHeader((_tui: any, theme: any) => ({
    render: (_width: number) => {
      const lines = buildBanner().split("\n");
      if (prunerEnabled) {
        lines.push(theme.fg("dim", "🌿"));
      }
      return lines;
    },
    invalidate: () => { },
  }));
}

export default function (pi: ExtensionAPI) {
  const team = new AgentTeam(pi);

  // When the agent team is active, label the orchestrator "orchestrator" in
  // observability so the session list (the table below "clear all agents")
  // shows the main agent distinctly from spawned subagents. Subagents carry
  // their real role via --o-name (see orchestration.ts / memory.ts). Respect
  // any explicit SCOPE_NAME the operator already set.
  if (team.enabled && !process.env.SCOPE_NAME) process.env.SCOPE_NAME = "orchestrator";

  // ── System Prompt Override ──────────────────────────────────────

  pi.on("before_agent_start", async (event, _ctx) => {
    if (!team.enabled) return;

    // Sync orchestrator model on each turn
    // Use provider-prefixed ID (e.g. "zai/glm-5.1") to avoid ambiguous resolution
    // when multiple providers define the same model ID (e.g. "glm-5.1" exists
    // under opencode, opencode-go, and zai providers)
    const newModel = fullModelId(_ctx.model);
    if (newModel && newModel !== team.orchestratorModel) {
      team.orchestratorModel = newModel;
      // Update subagents that don't have their own model
      for (const ap of team.procs.values()) {
        if (!ap.teamModel && !ap.def.model) ap.model = team.orchestratorModel;
      }
    }

    // Memory: capture the user's prompt for this turn. No-op when disabled.
    if (team.memoryManager) {
      team.memoryManager.recordInput((event && event.prompt) || "");
    }

    // buildSystemPrompt reads live team state from ctx, so only pass what
    // it actually consumes. (The skill↔agent map, read-only list, catalog
    // build, etc. that used to be computed here were never read by the
    // prompt builder — dropping them is the per-turn speed win.)
    return buildSystemPrompt({
      ctx: team,
      date: new Date().toISOString().split("T")[0],
      cwd: process.cwd(),
      memory: team.memoryManager ? { dir: team.memoryDir, files: memoryFiles(team.memoryDir) } : null,
      agentMd: team.agentMdCache,
      skills: filterSkills(team.skillsCache, team.orchestratorSkills).map(s => ({ name: s.name, description: s.description, path: resolveSkillPath(s.dir) })),
      orchestratorTools: team.activeToolList(),
    });
  });

  // ── Memory: per-turn background summarization ──

  pi.on("agent_end", async (event, _ctx) => {
    if (!team.enabled) return;
    if (!team.memoryManager) return;
    const text = extractLastAssistantText(event && event.messages);
    // Pass the turn's abort signal so ESC/abort of the turn also cancels
    // the memory summarizer spawned for it (parity with dispatch clones).
    team.memoryManager.recordOutput(text, _ctx.signal);
    team.invalidate();
  });

  // ── Session Start ───────────────────────────────────────────────

  pi.on("session_start", async (_event, _ctx) => {
    // Clean up any leftover processes
    await team.killAll();

    if (team.wCtx) { team.wCtx.ui.setWidget("agent-team", undefined); team.wInvalidate = null; }
    team.wCtx = _ctx;
    team.orchestratorModel = fullModelId(_ctx.model);

    await team.loadAgents(_ctx.cwd);

    // ESC aborts an in-flight memory summary (the key is reserved, so this
    // goes through a custom editor component rather than registerShortcut).
    if (team.memoryManager) installMemoryEscEditor(team, _ctx);

    team.initWidget();

    if (!team.enabled) {
      // Ensure the dispatch tools are NOT in active tools when disabled
      pi.setActiveTools(nonDispatchTools(pi));
      setAgentTeamHeader(_ctx, false);
      _ctx.ui.notify(
        "Agent team is disabled. Use /agents-team-toggle on to enable.",
        "info",
      );
      return;
    }

    // Restore saved team or default to first — NO spawning
    const names = Object.keys(team.teams);
    const savedTeam = team.saved.activeTeam || "";
    const restoreTeam = (savedTeam && names.includes(savedTeam)) ? savedTeam : (names[0] || "");
    if (restoreTeam) await team.activateTeam(restoreTeam);

    // Lock to dispatcher-only tools
    pi.setActiveTools(team.activeToolList());

    _ctx.ui.setStatus("agent-team", `Team: ${team.activeTeam} (${team.procs.size})`);
    setAgentTeamHeader(_ctx, team.enabled, isContextPrunerEnabled(_ctx.cwd));
    team.invalidate();
  });

  // ── Session Shutdown ────────────────────────────────────────────

  pi.on("session_shutdown", async () => {
    process.stdout.off("resize", team.resizeHandler);
    closeSidebar();
    team.persist();
    if (team.memoryManager) await team.memoryManager.awaitIdle(3000);
    await team.killAll();
    if (team.wCtx?.ui?.setHeader) team.wCtx.ui.setHeader(undefined);
  });

  // Register tools, commands, shortcut. The custom file tools (custom_read /
  // custom_write / custom_edit) are registered by the standalone custom-tools
  // extension, not here — subagents exclude agent-team from their extension
  // paths, so those tools must live outside this extension to be available.
  registerDispatchTool(pi, team);
  registerCommands(pi, team);
  registerShortcut(pi, team);
}
