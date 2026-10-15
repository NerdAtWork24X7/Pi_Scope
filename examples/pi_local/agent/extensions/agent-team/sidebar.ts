// ── Sidebar: team/agent/skill/memory overlay (toggled with Alt+S) ──
//
// Split out of ui.ts: the sidebar is its own concern (overlay component +
// toggle actions) and was half of that file. All row rendering goes through
// the shared sidebarRow/boxBorder builders in helpers.ts, and all state
// mutations go through the small action helpers below, so render and
// handleInput stay compact declarative dispatchers.

import { matchesKey, Key } from "@mariozechner/pi-tui";
import type { AgentProc, AgentTeamContext, TeamMember } from "./core";
import { agentNameKey, displayName, shortModel, clampDispatchTimeout } from "./core";
import { updateTeamsYaml, discoverAllSkills, type Skill } from "./config";
import { installMemoryEscEditor, removeMemoryEscEditor, toggleMemory } from "./memory";
import { boxBorder, sidebarRow, statusDisplay } from "./helpers";

/** Sidebar visibility state - module-level so it persists across re-renders */
let sidebarVisible = false;
let sidebarOverlayHandle: any = null;
let sidebarCtx: AgentTeamContext | null = null;

export function isSidebarVisible(): boolean {
  return sidebarVisible;
}

export function toggleSidebar(ctx: AgentTeamContext) {
  if (sidebarVisible) {
    closeSidebar();
  } else {
    openSidebar(ctx);
  }
}

export function closeSidebar(ctx?: AgentTeamContext) {
  sidebarVisible = false;
  if (sidebarOverlayHandle) {
    sidebarOverlayHandle.hide();
    sidebarOverlayHandle = null;
  }
  // Sync the ESC->abort editor to the (possibly toggled) memory state now that
  // the overlay has released focus. Swapping it inside the sidebar's input
  // handler would call setEditorComponent->setFocus, which steals focus from the
  // open overlay and dismisses it.
  const syncCtx = ctx ?? sidebarCtx;
  if (syncCtx?.wCtx) {
    if (syncCtx.memoryManager) installMemoryEscEditor(syncCtx, syncCtx.wCtx);
    else removeMemoryEscEditor(syncCtx.wCtx);
  }
  sidebarCtx = null;
}

// ── Toggle actions (handleInput delegates here) ──

/** Persist the `active` flag for a specific agent in the current team to
 *  teams.yaml, mirroring it into the in-memory teams data. */
function persistAgentActive(ctx: AgentTeamContext, agentName: string, active: boolean) {
  const key = agentNameKey(agentName);
  const findByKey = (members: TeamMember[] | undefined) => members?.find(m => agentNameKey(m.name) === key);
  updateTeamsYaml(p => {
    const member = findByKey(p.teams[ctx.activeTeam]);
    if (member) member.active = active;
  });
  const mem = findByKey(ctx.teams[ctx.activeTeam]);
  if (mem) mem.active = active;
}

/** Toggle a skill in an enable-set (empty set = none enabled), then persist. */
function toggleSkill(ctx: AgentTeamContext, set: Set<string>, sk: Skill) {
  if (set.has(sk.dir)) {
    set.delete(sk.dir);
  } else {
    set.add(sk.dir);
  }
  ctx.persist();
}

/** Enable/disable an agent from the sidebar: updates the disabled set, kills
 *  a running proc when disabling, and persists `active:` to teams.yaml. */
function setAgentDisabled(ctx: AgentTeamContext, ap: AgentProc, disabled: boolean) {
  const key = agentNameKey(ap.def.name);
  if (disabled) {
    // Kill if running
    if (ap.status === "running" || ap.status === "starting") {
      ctx.killProc(ap, true);
      ctx.wipeSessionFile(ap);
      ap.status = "dead";
    }
    ctx.disabledAgents.add(key);
  } else {
    ctx.disabledAgents.delete(key);
  }
  persistAgentActive(ctx, ap.def.name, !disabled);
  ctx.persist();
  ctx.invalidate();
}

/** One skill toggle row — shared by the orchestrator and subagent skill lists. */
function skillRow(theme: any, w: number, sk: Skill, on: boolean, selected: boolean): string {
  const c = selected ? "accent" : "text";
  return sidebarRow(theme, w, [
    { t: selected ? "▸ " : "  ", c },
    { t: on ? "● " : "○ ", c: on ? "success" : "dim" },
    { t: sk.name, c },
  ], selected);
}

/** Toggle the orchestrator system-prompt mode between standard and creative,
 *  then persist the choice so it survives across sessions. */
function toggleMode(ctx: AgentTeamContext) {
  ctx.mode = ctx.mode === "creative" ? "standard" : "creative";
  ctx.persist();
  ctx.invalidate();
}

/** Preset wall-clock caps (ms) cycled from the sidebar's Limits row. */
const DISPATCH_TIMEOUT_PRESETS_MS = [300_000, 600_000, 900_000, 1_200_000, 1_800_000, 2_700_000, 3_600_000];
/** Human-readable minute label for a dispatch timeout. */
function fmtTimeout(ms: number): string {
  return `${Math.round(ms / 60_000)} min`;
}
/** Cycle the per-dispatch wall-clock timeout through the presets, persist, and
 *  repaint. A value not in the preset list snaps to the nearest/next preset. */
function cycleDispatchTimeout(ctx: AgentTeamContext) {
  const cur = clampDispatchTimeout(ctx.dispatchTimeoutMs);
  const i = DISPATCH_TIMEOUT_PRESETS_MS.indexOf(cur);
  ctx.dispatchTimeoutMs = DISPATCH_TIMEOUT_PRESETS_MS[(i + 1) % DISPATCH_TIMEOUT_PRESETS_MS.length];
  ctx.persist();
  ctx.invalidate();
}

/** Focus sections in Tab-cycling order. */
const SECTION_ORDER = ["orch", "tools", "mode", "limits", "memory", "teams", "sub"] as const;
type Section = typeof SECTION_ORDER[number];

export function openSidebar(ctx: AgentTeamContext) {
  if (!ctx.wCtx) return;
  sidebarVisible = true;
  sidebarCtx = ctx;

  const overlayWidth = 45;

  ctx.wCtx.ui.custom(
    (tui: any, theme: any, _keybindings: any, done: () => void) => {
      let section: Section = "orch"; // which section is focused
      let teamIdx = 0; // index within teams section
      let skillIdx = 0; // index within orchestrator skill list
      let toolIdx = 0; // index within orchestrator tool list
      let subIdx = 0; // index within the subagents list
      let scrollTop = 0; // viewport offset into the rendered line list
      let viewport = 40; // last computed visible line count (page size for PgUp/PgDn)
      // Snapshot ALL available skills (including disabled in settings.json) once when sidebar opens
      const allSkills = discoverAllSkills();
      const agents = () => Array.from(ctx.procs.values());

      const component = {
        render(width: number): string[] {
          const lines: string[] = [];
          let selectedLine = 0; // absolute index of the focused row (drives the scroll viewport)
          const allAgents = agents();
          const w = Math.min(width, overlayWidth);
          const teamNames = Object.keys(ctx.teams);
          const subLen = allAgents.length;

          const toolNames = ctx.allTools();

          // Clamp section indices against their (possibly shrunken) lists
          if (skillIdx >= allSkills.length) skillIdx = Math.max(0, allSkills.length - 1);
          if (toolIdx >= toolNames.length) toolIdx = Math.max(0, toolNames.length - 1);
          if (teamIdx >= teamNames.length) teamIdx = Math.max(0, teamNames.length - 1);
          if (subIdx >= subLen) subIdx = Math.max(0, subLen - 1);

          // Title + orchestrator status
          lines.push(boxBorder(theme, w, "top"));
          lines.push(sidebarRow(theme, w, [{ t: "◆ Agent Team", c: "accent", b: true }]));
          const orchModel = shortModel(ctx.orchestratorModel);
          lines.push(sidebarRow(theme, w, [{ t: `● Orchestrator${orchModel ? ` ${orchModel}` : ""}`, c: "success" }]));

          // Orchestrator skills (folded under the orchestrator header)
          for (let i = 0; i < allSkills.length; i++) {
            const sk = allSkills[i];
            if (section === "orch" && i === skillIdx) selectedLine = lines.length;
            lines.push(skillRow(theme, w, sk, ctx.orchestratorSkills.has(sk.dir), section === "orch" && i === skillIdx));
          }

          // Orchestrator tools (what the orchestrator may call), 2 columns
          lines.push(boxBorder(theme, w, "sep"));
          lines.push(sidebarRow(theme, w, [{ t: "Tools (Enter to toggle)", c: "dim", b: true }]));
          if (toolNames.length === 0) {
            lines.push(sidebarRow(theme, w, [{ t: "No tools available", c: "dim" }]));
          } else {
            // Each column cell: "▸ ● name" padded to exactly colW cells so
            // both columns align; long names truncate with "…" instead of
            // bleeding into the neighboring column.
            const colW = Math.floor((w - 3) / 2);
            const maxName = Math.max(1, colW - 4 - 1); // reserve prefix+icon and "…"
            const toolCell = (name: string | undefined, idx: number) => {
              if (name === undefined) return [{ t: " ".repeat(colW), c: "text" }];
              const on = !ctx.skipOrchestratorTools.some(t => t.toLowerCase() === name.toLowerCase());
              const sel = section === "tools" && idx === toolIdx;
              const c = sel ? "accent" : "text";
              let nm = name;
              if ([...nm].length > maxName) nm = [...nm].slice(0, maxName).join("") + "…";
              const pad = Math.max(0, colW - 4 - [...nm].length);
              return [
                { t: sel ? "▸ " : "  ", c },
                { t: on ? "● " : "○ ", c: on ? "success" : "dim" },
                { t: nm, c: on ? c : "dim" },
                { t: " ".repeat(pad), c: "text" },
              ];
            };
            for (let r = 0; r * 2 < toolNames.length; r++) {
              const li = r * 2;
              const ri = li + 1;
              const cells = [
                ...toolCell(toolNames[li], li),
                ...toolCell(ri < toolNames.length ? toolNames[ri] : undefined, ri),
              ];
              if (section === "tools" && (li === toolIdx || ri === toolIdx)) selectedLine = lines.length;
              lines.push(sidebarRow(theme, w, cells, section === "tools" && (li === toolIdx || ri === toolIdx)));
            }
          }

          // Mode section
          lines.push(boxBorder(theme, w, "sep"));
          lines.push(sidebarRow(theme, w, [{ t: "Mode (Enter to toggle)", c: "dim", b: true }]));
          {
            const creative = ctx.mode === "creative";
            const sel = section === "mode";
            if (sel) selectedLine = lines.length;
            lines.push(sidebarRow(theme, w, [
              { t: sel ? "▸ " : "  ", c: sel ? "accent" : "text" },
              { t: creative ? "◆ " : "◇ ", c: creative ? "accent" : "dim" },
              { t: creative ? "Creative (free-form)" : "Standard (strict/YAGNI)", c: sel ? "accent" : "text" },
            ], sel));
          }

          // Limits section
          lines.push(boxBorder(theme, w, "sep"));
          lines.push(sidebarRow(theme, w, [{ t: "Limits (Enter to cycle)", c: "dim", b: true }]));
          {
            const sel = section === "limits";
            if (sel) selectedLine = lines.length;
            lines.push(sidebarRow(theme, w, [
              { t: sel ? "▸ " : "  ", c: sel ? "accent" : "text" },
              { t: "⏱ ", c: sel ? "accent" : "dim" },
              { t: `Subagent timeout: ${fmtTimeout(ctx.dispatchTimeoutMs)}`, c: sel ? "accent" : "text" },
            ], sel));
          }

          // Memory section
          lines.push(boxBorder(theme, w, "sep"));
          lines.push(sidebarRow(theme, w, [{ t: "Memory (Enter to toggle)", c: "dim", b: true }]));
          {
            const hasMem = !!ctx.memoryManager;
            const sel = section === "memory";
            if (sel) selectedLine = lines.length;
            lines.push(sidebarRow(theme, w, [
              { t: sel ? "▸ " : "  ", c: sel ? "accent" : "text" },
              { t: hasMem ? "● " : "○ ", c: hasMem ? "success" : "dim" },
              { t: hasMem ? `Memory ${shortModel(ctx.memoryModel) || ""}`.trim() : "Memory (off)", c: sel ? "accent" : hasMem ? "text" : "dim" },
            ], sel));
          }

          // Teams section
          lines.push(boxBorder(theme, w, "sep"));
          lines.push(sidebarRow(theme, w, [{ t: "Teams (Tab to switch focus)", c: "dim", b: true }]));
          if (teamNames.length === 0) {
            lines.push(sidebarRow(theme, w, [{ t: "No teams defined", c: "dim" }]));
          } else {
            for (let i = 0; i < teamNames.length; i++) {
              const tn = teamNames[i];
              const isActive = tn === ctx.activeTeam;
              const sel = section === "teams" && i === teamIdx;
              if (sel) selectedLine = lines.length;
              const members = ctx.teams[tn] || [];
              const activeCount = members.filter(m => m.active !== false).length;
              lines.push(sidebarRow(theme, w, [{
                t: `${sel ? "▸ " : "  "}${isActive ? "●" : "○"} ${tn} (${activeCount}/${members.length})`,
                c: isActive ? "success" : sel ? "accent" : "text",
              }], sel));
            }
          }

          // Subagents section
          lines.push(boxBorder(theme, w, "sep"));
          lines.push(sidebarRow(theme, w, [{ t: "Subagents (Enter to toggle)", c: "dim", b: true }]));
          if (allAgents.length === 0) {
            lines.push(sidebarRow(theme, w, [{ t: "No agents loaded", c: "dim" }]));
          } else {
            for (let i = 0; i < allAgents.length; i++) {
              const ap = allAgents[i];
              const sel = section === "sub" && i === subIdx;
              if (sel) selectedLine = lines.length;
              const isDisabled = ctx.disabledAgents.has(agentNameKey(ap.def.name));
              const icon = isDisabled ? "◌" : statusDisplay(ap.status).icon;
              const model = shortModel(ap.model);
              lines.push(sidebarRow(theme, w, [{
                t: `${sel ? "▸ " : "  "}${icon} ${displayName(ap.def.name)}${model ? ` · ${model}` : ""}${isDisabled ? " [off]" : ""}`,
                c: isDisabled ? "dim" : sel ? "accent" : "text",
              }], sel));
            }
          }

          // (A subagent's skills are its own `agents/<name>.md` `skills:` key —
          // one source of truth — so there is no subagent skill list here.)

          // Help text + bottom border
          lines.push(boxBorder(theme, w, "sep"));
          for (const help of [
            "Tab Switch focus ↑↓ Navigate",
            "Enter Select team / Toggle skill / tool / agent / memory / mode / timeout",
            "PgUp/PgDn Page · Home/End Jump · ●=enabled ○=disabled",
            "Esc/Alt+S Close sidebar",
          ]) {
            lines.push(sidebarRow(theme, w, [{ t: help, c: "dim" }]));
          }
          lines.push(boxBorder(theme, w, "bottom"));

          // Scrollable viewport: cap the overlay at 80% of the terminal height
          // and window the line list around the focused row. Mirrors the
          // overlay's own maxHeight clamp (margin 1 top/bottom) so the host
          // never clips a rendered line.
          const termRows = tui?.terminal?.rows ?? 40;
          const maxVisible = Math.max(1, Math.min(Math.floor(termRows * 0.8), Math.max(1, termRows - 2)));
          viewport = maxVisible;
          if (selectedLine < scrollTop) scrollTop = selectedLine;
          else if (selectedLine >= scrollTop + maxVisible) scrollTop = selectedLine - maxVisible + 1;
          scrollTop = Math.max(0, Math.min(scrollTop, Math.max(0, lines.length - maxVisible)));
          return lines.slice(scrollTop, scrollTop + maxVisible);
        },

        handleInput(data: string) {
          const allAgents = agents();
          const teamNames = Object.keys(ctx.teams);
          const subLen = allAgents.length;

          const move = (delta: number) => {
            const clamp = (v: number, max: number) => Math.max(0, Math.min(Math.max(0, max), v));
            if (section === "teams") teamIdx = clamp(teamIdx + delta, teamNames.length - 1);
            else if (section === "orch") skillIdx = clamp(skillIdx + delta, allSkills.length - 1);
            else if (section === "tools") toolIdx = clamp(toolIdx + delta, ctx.allTools().length - 1);
            else if (section === "sub") subIdx = clamp(subIdx + delta, subLen - 1);
            tui.requestRender();
          };

          // Absolute jump within the focused section (Home/End; Infinity = last).
          const jumpTo = (idx: number) => {
            const clamp = (v: number, max: number) => Math.max(0, Math.min(Math.max(0, max), v));
            if (section === "teams") teamIdx = clamp(idx, teamNames.length - 1);
            else if (section === "orch") skillIdx = clamp(idx, allSkills.length - 1);
            else if (section === "tools") toolIdx = clamp(idx, ctx.allTools().length - 1);
            else if (section === "sub") subIdx = clamp(idx, subLen - 1);
            tui.requestRender();
          };

          if (matchesKey(data, Key.tab)) {
            // Cycle focus: orch → memory → teams → sub → orch
            section = SECTION_ORDER[(SECTION_ORDER.indexOf(section) + 1) % SECTION_ORDER.length];
            tui.requestRender();
          } else if (matchesKey(data, Key.up)) {
            move(-1);
          } else if (matchesKey(data, Key.down)) {
            move(1);
          } else if (matchesKey(data, Key.pageUp)) {
            // Page up: move selection by a viewport page (render keeps it on-screen)
            move(-Math.max(1, viewport - 4));
          } else if (matchesKey(data, Key.pageDown)) {
            move(Math.max(1, viewport - 4));
          } else if (matchesKey(data, Key.home)) {
            jumpTo(0);
          } else if (matchesKey(data, Key.end)) {
            jumpTo(Infinity); // clamped to the section's last index
          } else if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
            if (section === "memory") {
              // Toggle memory on/off (persists to teams.yaml)
              toggleMemory(ctx);
              tui.requestRender();
            } else if (section === "mode") {
              // Toggle orchestrator mode standard/creative
              toggleMode(ctx);
              tui.requestRender();
            } else if (section === "limits") {
              // Cycle the per-dispatch wall-clock timeout (persists)
              cycleDispatchTimeout(ctx);
              tui.requestRender();
            } else if (section === "teams") {
              // Switch to the selected team
              const newTeam = teamNames[teamIdx];
              if (newTeam && newTeam !== ctx.activeTeam) {
                void ctx.activateTeam(newTeam).then(() => {
                  ctx.invalidate();
                  if (ctx.wCtx) {
                    ctx.wCtx.ui.setStatus("agent-team", `Team: ${newTeam} (${ctx.procs.size})`);
                    ctx.wCtx.ui.notify(`Switched to team: ${newTeam}`, "info");
                  }
                  tui.requestRender();
                });
              }
            } else if (section === "orch") {
              // Toggle orchestrator skill
              if (skillIdx >= 0 && skillIdx < allSkills.length) {
                toggleSkill(ctx, ctx.orchestratorSkills, allSkills[skillIdx]);
                tui.requestRender();
              }
            } else if (section === "tools") {
              // Toggle orchestrator tool on/off
              const toolNames = ctx.allTools();
              const name = toolNames[toolIdx];
              if (name) {
                const on = !ctx.skipOrchestratorTools.some(t => t.toLowerCase() === name.toLowerCase());
                ctx.toggleOrchestratorTool(name, !on);
                tui.requestRender();
              }
            } else if (subIdx >= 0 && subIdx < allAgents.length) {
              // Toggle agent enabled/disabled
              const ap = allAgents[subIdx];
              setAgentDisabled(ctx, ap, !ctx.disabledAgents.has(agentNameKey(ap.def.name)));
              tui.requestRender();
            }
          } else if (matchesKey(data, Key.escape)) {
            closeSidebar();
            done();
          }
        },

        invalidate() { },
        wantsKeyRelease: false,
      };

      return component;
    },
    {
      overlay: true,
      overlayOptions: {
        width: overlayWidth,
        anchor: "right-center",
        offsetX: -2,
        offsetY: 0,
        margin: 1,
        // Cap the overlay at 80% of the terminal; the component windows its
        // own content to this height and scrolls the focused row into view.
        maxHeight: "80%",
      },
      onHandle: (handle: any) => {
        sidebarOverlayHandle = handle;
      },
    }
  );
}
