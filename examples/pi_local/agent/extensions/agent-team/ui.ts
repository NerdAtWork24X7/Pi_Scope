// ── UI: system prompt builder + widget rendering (sidebar → ./sidebar.ts) ──

import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { Text } from "@mariozechner/pi-tui";
import type { AgentProc, AgentTeamContext } from "./core";
import { agentNameKey, displayName, fmtTok, shortModel, toolsAreWritable } from "./core";
import { boxBorder, cardTitleLine, padToVis, statusDisplay, trunc, visLen } from "./helpers";

/** `file` relative to `dir`, with separators normalized to "/" for prompt
 *  display. Falls back to the absolute path when the file is not under `dir`.
 *  Uses path.relative so it works with either separator (the previous
 *  `dir + "/"` prefix strip never matched Windows backslash paths). */
function relativeToDir(file: string, dir: string): string {
  const rel = relative(dir, file);
  return (rel && !rel.startsWith("..") ? rel : file).replace(/\\/g, "/");
}

/** Platform-correct Python interpreter for the orchestrator prompt footer.
 *  The venv layout differs (POSIX: `.venv/bin/python`, Windows:
 *  `.venv\Scripts\python.exe`), so probe both and fall back to the platform
 *  default when neither exists yet. */
function venvHint(cwd: string): string {
  const win = join(cwd, ".venv", "Scripts", "python.exe");
  const posix = join(cwd, ".venv", "bin", "python");
  if (existsSync(win)) return win;
  if (existsSync(posix)) return posix;
  return process.platform === "win32" ? win : posix;
}

// The sidebar overlay lives in ./sidebar — re-exported here so existing
// import sites (index.ts, integrations.ts) keep working unchanged.
export { closeSidebar, isSidebarVisible, toggleSidebar } from "./sidebar";

/** An agent is "working" when it is actively doing something. Idle / done /
 *  error / dead agents are hidden from the widget so only live subagents show. */
export function isWorking(ap: AgentProc): boolean {
  return ap.status === "running" || ap.status === "starting";
}


// ── System prompt builder ──

export function buildSystemPrompt(args: {
  ctx: AgentTeamContext;
  /** Retained for backward compatibility with the call site; the prompt now reads live team state from ctx. */
  catalog?: string;
  date: string;
  cwd: string;
  memory?: { dir: string; files: Array<{ path: string; heading: string }> } | null;
  agentMd?: string | null;
  skills?: Array<{ name: string; description: string; path?: string }>;
  parallel?: boolean;
  harshCriticEnabled?: boolean;
  orchestratorTools?: string[];
  readOnlyAgents?: string[];
  skillAgentMap?: Record<string, string[]>;
}): { systemPrompt: string } {

  const ctx = args.ctx;
  const mode = (args.ctx.mode ?? "standard") as "standard" | "creative";
  const creative = mode === "creative";
  const enabled = Array.from(ctx.procs.values()).filter(a => !ctx.disabledAgents.has(agentNameKey(a.def.name)));

  // How dispatch_agents schedules this agent's tasks: read-only agents are
  // parallel-eligible, edit/write agents are always serialized, and the global
  // parallel-dispatch setting can force every agent onto the serialized path.
  const dispatchMode = (tools: string): string =>
    toolsAreWritable(tools, ctx.destructiveTools) || !ctx.parallelDispatch ? "serialized" : "parallel";

  const tableRows = enabled.map(a =>
    "| " + a.def.name + " | " + (a.def.description || "(no description)").replace(/\s+/g, " ") + " | " + (a.def.tools || "") + " | " + dispatchMode(a.def.tools) + " |"
  ).join("\n");

  const findEnabled = (role: string): string | null =>
    enabled.find(a => agentNameKey(a.def.name) === agentNameKey(role))?.def.name ?? null;
  const tick = (n: string) => "`" + n + "`";

  const searcher = findEnabled("searcher");
  const docGen = findEnabled("doc_generator");
  const fileReader = findEnabled("file_reader");
  const tester = findEnabled("tester");
  const documenter = findEnabled("documenter");
  const harsh = findEnabled("harsh_critic");

  const webFallback = searcher ? `dispatch \`${searcher}\`` : "use `web-fetch`";
  const fileGenNote = docGen ? `dispatch \`${docGen}\`` : "write directly (no chat dumps)";

  const readers = [fileReader, searcher].filter((n): n is string => !!n);
  // Only promise parallelism when the global switch actually allows it.
  const ctxGap = readers.length
    ? "dispatch " + readers.map(tick).join("/") + (ctx.parallelDispatch ? " in parallel" : " (one at a time — parallelism is off)")
    : "inspect directly";

  const qualityGateStep = harsh
    ? `Quality gate: dispatch \`${harsh}\` to audit changes (max 2 rounds).`
    : `Self-audit against edge cases and acceptance criteria.`;

  const verifyStep = tester
    ? `Verify via \`${tester}\` — run targeted checks covering edge cases.`
    : `Run targeted checks directly — cover edge cases with execution evidence.`;

  const docsStep = documenter
    ? `If public surfaces changed, dispatch \`${documenter}\`.`
    : `If public surfaces changed, update documentation directly.`;

  const creativeCritiquePhrase = harsh ? `dispatch \`${harsh}\` for critique` : `critique against intent`;
  const creativeVerifyPhrase = tester ? `verify via \`${tester}\`` : `run checks directly`;
  const taskRouting = (!enabled || enabled.length === 0) ? "Execute directly" : "Dispatch specialized subagents from the table";

  const dispatchToolNote = !enabled || enabled.length === 0 ? "" :
    `- **Dispatch Tool**: \`dispatch_agents(tasks: [{agent, task}, ...])\` is the only delegation tool — always send the whole batch in ONE call, one entry per task, in execution order (a single task is a one-entry array). Concurrency is not your decision: the scheduler runs independent read-only tasks in parallel when parallel dispatch is ON (currently ${ctx.parallelDispatch ? "ON" : "OFF"}) and one at a time when OFF. Destructive agents (edit/write) are always serialized regardless of the setting — never rely on parallel writes to the same file.\n`;

  const subagentsSection = (!enabled || enabled.length === 0) ? "" : `## Subagents & Delegation
Subagents are stateless, isolated workers. You own architecture, integration, and final decisions.
- **Plan First**: Formulate subtasks and dependencies before dispatching. Provide specific objective, non-overlapping scope (files/paths/symbols), relevant context, and acceptance criteria.
${dispatchToolNote}- **Parallel Strategy**: Run independent read-only searches/lookups in parallel (${ctxGap}). Batch file edits into single dispatches; NEVER edit or write to the same file concurrently.
- **Delegation Guidelines**: Research requires primary sources & exact versions; image tasks need absolute paths; UI tasks must include the Visual Standard in context. Review/audit tasks must name the exact files or sections to inspect and a bounded scope — never ask a reviewer to audit "everything"; split a whole-project audit into per-area tasks.
- **Failure Protocol**: Non-zero exit, timeout, or BLOCKED = failure. Never invent success. Edit mismatch? Re-read file and send exact whitespace. Retry once with narrowed scope (max 2 retries total), then resolve directly or report blocker.

| Subagent | Role | Tools | Dispatch |
|---|---|---|---|
${tableRows}
`;

  const craftBar = `## Craft & Engineering Bar (Mandatory)
- **Act Smart, Not Hard**: Find the highest-leverage solution. Check YAGNI first. Prefer platform/stdlib built-ins, then installed dependencies, before writing custom code. Choose optimal data structures and algorithms over brute-force boilerplate. Clean, decoupled modules (KISS, SOLID) without unrequested abstractions.
- **Best Quality, Optimized Code**: High-performance, clean, robust code with minimal runtime/memory overhead. Keep diffs surgical and minimal in standard mode; clean, elegant, and justified in creative mode. ${fileGenNote ? `Docs/exports: ${fileGenNote}.` : ""}
- **Edge Cases are Mandatory**: Every solution must proactively handle edge cases: null/undefined, empty collections, zero/boundary limits, invalid formats, off-by-one errors, async races, and network/IO failures. Never ship happy-path only.
- **Always Deliver a "Wow" Moment**: Exceed expectations with a standout highlight on every deliverable—an elegant architectural simplification, an algorithmically optimal speedup, a proactive edge-case catch, or delightful polish.
- **UI/Visual Standard**: Modern, distinctive, accessible, responsive—tailored to this product, not generic AI templates. Purposeful typography (2-3 sizes), cohesive spacing, one intentional accent color, visible focus states, mobile-responsive layouts, designed empty/loading/error states, and smooth purposeful motion. Zero bloat, fast first-paint, no layout shifts.`;

  const workflowSection = creative
    ? `## Execution Workflow
1. Read files in .pi_memory/ folder to understand the current architecture, task breakdown, and previous steps.
2. **Research**: Research the problem space to understand the best approach to solve the problem from web search.
3. **Plan and Architect**: Determine the best approach to solve the problem; close context gaps: ${ctxGap}; update architecture and high-level task breakdown in .pi_memory/architecture.md
4. **Delegate & Execute**: ${taskRouting}. Choose the highest-quality approach, giving subagents clear context.
5. **Refine & Verify**: Critically iterate. ${creativeCritiquePhrase}. ${creativeVerifyPhrase}. Ensure edge cases and the Craft Bar are cleared.
6. **Finalize**: Inspect final diff, ensure execution evidence, and summarize decisions.`
    : `## Execution Workflow
1. Read files in .pi_memory/ folder to understand the current architecture, task breakdown, and previous steps.
2. **Plan**: Define acceptance criteria, identify edge cases, and map required subagents and dependencies.
3. **Inspect**: Check relevant files and close context gaps (${ctxGap}). ${creative ? "" : "Read targeted line ranges; never read full files when grep/range suffices."}
4. **Delegate & Execute**: ${taskRouting}. Provide explicit scope and acceptance criteria. Synthesize outputs and reconcile conflicts.
5. **Audit & Verify**: ${qualityGateStep} ${verifyStep} Confirm edge cases are tested and execution evidence is captured.
6. **Finalize**: ${docsStep} Inspect diff against the Craft Bar. Ensure no unverified claims or regressions remain.`;

  const agentMdSection = args.agentMd ? "\n## Project AGENTS.md\n" + args.agentMd.trim() + "\n" : "";
  const skillsSection = args.skills && args.skills.length ? "\n## Skills\nEnabled skills — read each skill's `SKILL.md` for full instructions:\n" + args.skills.map(s => "- **" + s.name + "**" + (s.path ? " (`" + s.path + "`)" : "") + ": " + (s.description || "(no description)")).join("\n") + "\n" : "";
  const memorySection = args.memory && (args.memory.dir || (args.memory.files && args.memory.files.length))
    ? "\n## Project Memory\nMemory directory = `" + args.memory.dir + "`:\n" +
    args.memory.files.map(f => "- `" + relativeToDir(f.path, args.memory.dir) + "` - " + f.heading).join("\n") +
    "\n\n**VERY IMPORTANT** Read memory files to understand Repo before working on any Task.\n"
    : "";

  const enabledTools = (args.orchestratorTools && args.orchestratorTools.length) ? args.orchestratorTools : ctx.activeToolList();
  const toolsSection = enabledTools.length ? "\n## Tools\n" + enabledTools.map(t => "- `" + t + "`").join("\n") + "\n" : "";

  const raw = `## Role & Operating Mode (${creative ? "Creative" : "Standard"})
Lead engineer & orchestrator. Own the lifecycle: plan upfront, delegate specialized/parallel work to subagents, integrate results, rigorously verify, and deliver exceptional quality. Subagents are disposable specialists—you own architecture, conflicts, and final answers.
- **Tone**: Pragmatic senior engineer. Dense, factual, GFM. No filler or emojis. Unsure about external facts/APIs? ${webFallback}—never guess.
- **Mode Directive**: ${creative ? "Explore innovative solutions; justified structural improvements and clean rewrites are encouraged." : "Make the minimal surgical change that satisfies the brief; propose larger restructures before executing."}

${craftBar}
${toolsSection}
${subagentsSection}
${workflowSection}
${agentMdSection}${skillsSection}${memorySection}
## Safety & Constraints
- **Establish Baseline**: Inspect current behavior before editing; inspect diffs and re-read affected lines after editing.
- **Evidence-Based**: Never claim success without concrete execution evidence. Never guess missing paths, versions, or APIs.
- **Strictly Forbidden**: Parallel writes to the same file; fabricating tool/subagent success; letting subagents make architectural decisions; ${creative ? "" : "reading entire large files when grep/range suffices; "}untested happy-path only code.

## Output Format (omit inapplicable lines)
- Result: <summary of changes, solution, or answer>
- Wow Moment: <key optimization, smart leverage, or standout polish delivered>
- Files Changed: <file>: <concise description of changes>
- Verification & Edge Cases: <command/test>: <evidence of pass, including edge cases tested>
- Design Check (UI only): <distinctive styling + visual polish confirmation, or N/A>
- Remaining / Next Steps: <blockers, unverified items, or recommended follow-ups>

Date: ${args.date}
CWD: ${args.cwd}
Tmp: ${join(args.cwd, "tmp")}
Python: ${venvHint(args.cwd)}
`;

  return { systemPrompt: raw.replace(/\n{3,}/g, "\n\n").trim() + "\n" };
}

// ── Widget rendering ──

export function initWidget(ctx: AgentTeamContext) {
  if (!ctx.wCtx) return;
  ctx.wInvalidate = null;

  ctx.wCtx.ui.setWidget("agent-team", (tui: any, theme: any) => {
    const text = new Text("", 0, 1);
    ctx.wInvalidate = () => tui.requestRender();
    return {
      render(width: number): string[] {
        const hasMemory = !!ctx.memoryManager;
        const activeClones = [...ctx.batchClones].filter(isWorking);
        const visibleProcs = [...ctx.procs.values()].filter(ap => !ctx.disabledAgents.has(agentNameKey(ap.def.name)));
        const totalCount = visibleProcs.length + activeClones.length;
        // Memory runs on its own subprocess, independent of the agent-team
        // toggle and of whether any subagents are loaded. Count it as a slot
        // so its card always renders — otherwise memory could be enabled yet
        // invisible in the grid when the team is disabled / no agents show.
        const slotCount = totalCount + (hasMemory ? 1 : 0);

        const boxPad = 4;
        const innerW = width - boxPad;
        const cols = Math.max(1, Math.min(ctx.gridCols, slotCount));
        const cardGap = 1;
        const colW = Math.floor((innerW - cardGap * (cols - 1)) / cols);

        // Agent cards render only when the team is enabled; the memory card
        // is appended whenever memory is active (independent of the team).
        const cards: string[][] = [];
        if (ctx.enabled) {
          for (const ap of visibleProcs) cards.push(renderCard(ctx, ap, colW, theme));
          for (const ap of activeClones) {
            const label = displayName(ap.def.name) + (ap.runId ? " *" : "");
            cards.push(renderCard(ctx, ap, colW, theme, label));
          }
        }
        if (hasMemory) cards.push(renderMemoryCard(ctx, colW, theme));

        if (!cards.length) {
          const hint = ctx.enabled
            ? "No agents. Add subagent to agent.yml files to agents/"
            : "Agent team disabled. /agents-team-toggle on";
          const hintVis = [...hint].length;
          const hintLine =
            theme.fg("border", "│   ") +
            theme.fg("dim", hint) +
            theme.fg("border", " ".repeat(Math.max(0, width - 4 - hintVis - 2)) + " │");
          const topBorder = boxBorder(theme, width, "top");
          const bottomBorder = boxBorder(theme, width, "bottom");
          text.setText([topBorder, hintLine, bottomBorder].join("\n"));
          return text.render(width);
        }

        const rows: string[][] = [];
        for (let i = 0; i < cards.length; i += cols) {
          const row = cards.slice(i, i + cols);
          while (row.length < cols) row.push([" ".repeat(colW)]);
          const h = Math.max(...row.map(c => c.length));
          for (const c of row) { while (c.length < h) c.push(" ".repeat(colW)); }
          for (let line = 0; line < h; line++) {
            rows.push(row.map(c => c[line] || ""));
          }
        }

        const topBorder = boxBorder(theme, width, "top");
        // ── Header: "Subagent Team" + active mode sits inside the box, left-aligned after the border ──
        const headerText = "Subagent Team";
        const modeSuffix = " · " + (ctx.mode === "creative" ? "Creative" : "Standard");
        const headerPad = Math.max(0, innerW - [...headerText].length - [...modeSuffix].length);
        const headerLine =
          theme.fg("border", "│ ") +
          theme.fg("accent", theme.bold(headerText)) +
          theme.fg("dim", modeSuffix) +
          " ".repeat(headerPad) +
          " " + theme.fg("border", "│");
        const sepLine = boxBorder(theme, width, "sep");
        const boxedRows = rows.map(r => {
          const rowStr = r.join(" ".repeat(cardGap));
          const rowVis = visLen(rowStr);
          const padded = rowStr + " ".repeat(Math.max(0, innerW - rowVis));
          return theme.fg("border", "│") + " " + padded + " " + theme.fg("border", "│");
        });
        const bottomBorder = boxBorder(theme, width, "bottom");

        // ── Per-agent TUI log grid (scales with swapped agents) ──
        const logRows = renderLogGrid(ctx, innerW, theme);

        const parts = [topBorder, headerLine, sepLine, ...boxedRows];
        if (logRows.length) parts.push(boxBorder(theme, width, "sep"), ...logRows);
        parts.push(bottomBorder);

        text.setText(parts.join("\n"));
        return text.render(width);
      },
    };
  }, { placement: "aboveEditor" });

  process.stdout.off("resize", ctx.resizeHandler);
  process.stdout.on("resize", ctx.resizeHandler);

  if (!ctx.wInvalidate) ctx.wInvalidate = () => { };
}

const LOG_PANEL_LINES = 6; // max log lines shown per agent panel

/** Present the logical order of a bounded log without changing the hot-path
 *  append representation used by SessionLogger. */
function orderedLogLines(ap: AgentProc): string[] {
  if (!ap.logLines?.length || !ap.logHead) return ap.logLines || [];
  return [...ap.logLines.slice(ap.logHead), ...ap.logLines.slice(0, ap.logHead)];
}

/** Build the per-agent log grid rendered beneath the status cards. Each column
 *  is one agent (team member + active parallel clone + memory), its lines pulled
 *  from that agent's in-memory ring buffer. The grid scales: more swapped agents
 *  → more columns, laid out across `gridCols`. */
function renderLogGrid(ctx: AgentTeamContext, innerW: number, theme: any): string[] {
  const slots: Array<{ label: string; lines: string[]; accent: boolean }> = [];
  for (const ap of ctx.procs.values()) {
    if (!isWorking(ap)) continue;
    if (ctx.disabledAgents.has(agentNameKey(ap.def.name))) continue;
    slots.push({ label: displayName(ap.def.name), lines: orderedLogLines(ap), accent: true });
  }
  for (const ap of ctx.batchClones) {
    if (!isWorking(ap)) continue;
    const label = displayName(ap.def.name) + (ap.runId ? " *" : "");
    slots.push({ label, lines: orderedLogLines(ap), accent: false });
  }
  if (ctx.memoryManager && ctx.memoryManager.memoryLogAgent
    && ["recording", "summarizing"].includes(ctx.memoryManager.snapshot.status)) {
    slots.push({ label: "Memory", lines: ctx.memoryManager.memoryLogAgent.logLines || [], accent: false });
  }
  if (!slots.length) return [];

  const gap = " │ "; // 3 chars between columns
  const cols = Math.max(1, Math.min(ctx.gridCols, slots.length));
  const colW = Math.max(6, Math.floor((innerW - (cols - 1) * gap.length) / cols));
  const maxLines = Math.max(1, ...slots.map(s => s.lines.length));
  const L = Math.min(maxLines, LOG_PANEL_LINES);

  const wrap = (s: string) => padToVis(trunc(s, colW), colW);
  const rowStr = (cells: string[]) =>
    theme.fg("border", "│") + " " + cells.join(gap) + " " + theme.fg("border", "│");

  // Render `cols` agent columns as one self-contained block (label row + L
  // log rows). Slots are chunked so a wide set of agents wraps into
  // stacked blocks instead of one over-wide row that the terminal wraps and
  // mixes. Matches the status-card grid's row-of-cols layout.
  function renderBlock(block: Array<{ label: string; lines: string[]; accent: boolean }>): string[] {
    const rows: string[] = [];
    rows.push(rowStr(block.map(s => theme.fg(s.accent ? "accent" : "text", theme.bold(wrap(s.label))))));
    for (let r = 0; r < L; r++) {
      rows.push(rowStr(block.map(s => {
        const idx = s.lines.length - L + r;
        const ln = idx >= 0 ? s.lines[idx] : "";
        return theme.fg("text", wrap(ln));
      })));
    }
    return rows;
  }

  const out: string[] = [];
  for (let i = 0; i < slots.length; i += cols) {
    out.push(...renderBlock(slots.slice(i, i + cols)));
  }
  return out;
}

export function invalidate(ctx: AgentTeamContext) {
  ctx.animFrame++;
  if (!ctx.wCtx) return;
  if (ctx.wInvalidate) ctx.wInvalidate();
  else initWidget(ctx);
}

// ── Card rendering (modern compact — thin accent bar, pill-like stats) ──

/** 1–2 line agent card: accent bar + icon + name + time, optional stats row. */
function renderCard(_ctx: AgentTeamContext, ap: AgentProc, w: number, theme: any, labelOverride?: string): string[] {
  const { color: statusColor, icon: statusIcon } = statusDisplay(ap.status);
  const timeStr = ["running", "starting", "done"].includes(ap.status)
    ? `${Math.round(ap.elapsed / 1000)}s` : "";

  // ── Line 1: ▌ ● Coder claude-3.5              12s ──
  const lines = [cardTitleLine(theme, w, statusColor, statusIcon, labelOverride ?? displayName(ap.def.name), shortModel(ap.model), timeStr)];

  // ── Line 2: ▌   ████░░░░  45% · In 1.2k · Out 400 · ⚡ H=500 ──
  if (ap.contextWindow > 0 && (ap.tokensUsed > 0 || ap.tokensOut > 0)) {
    const pct = Math.min(100, Math.round((ap.tokensUsed / ap.contextWindow) * 100));
    const barW = Math.min(10, Math.max(4, Math.floor((w - 4) / 4)));
    const filled = Math.round((pct / 100) * barW);
    const bar = "█".repeat(filled) + "░".repeat(barW - filled);
    const barColor = pct > 90 ? "error" : pct > 70 ? "warning" : "accent";

    let statStr = `${pct}% · In ${fmtTok(ap.tokensUsed)} · Out ${fmtTok(ap.tokensOut)}`;
    let cachePill = "";
    if (ap.cacheRead > 0 || ap.cacheSavedTotal > 0) {
      const parts: string[] = [];
      if (ap.cacheRead > 0) parts.push(`H=${fmtTok(ap.cacheRead)}`);
      if (ap.cacheSavedTotal > 0) parts.push(`Σ=${fmtTok(ap.cacheSavedTotal)}`);
      cachePill = ` · ⚡ ${parts.join(" ")}`;
    }

    // Drop cache pill if it would overflow; fall back to compact if still too wide
    if (4 + barW + 2 + [...statStr].length + [...cachePill].length > w) cachePill = "";
    if (4 + barW + 2 + [...statStr].length > w) {
      // Still overflowing — drop to bar + percentage only
      statStr = `${pct}%`;
    }

    const line2 = padToVis(
      theme.fg(statusColor, "▌   ") +
      theme.fg(barColor, bar) + "  " +
      theme.fg("dim", statStr) +
      theme.fg("success", cachePill),
      w,
    );

    lines.push(line2);
  }

  return lines;
}

// ── Memory card ──

function formatAgo(ms: number): string {
  if (!ms) return "";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function renderMemoryCard(ctx: AgentTeamContext, w: number, theme: any): string[] {
  const mm = ctx.memoryManager;
  if (!mm) return [theme.fg("dim", "·".repeat(w))];

  const s = mm.snapshot;
  const status = s.status;
  const { color: statusColor, icon: statusIcon } = statusDisplay(status);

  const timeStr = (status === "summarizing") ? `${Math.round(s.elapsed / 1000)}s`
    : (s.lastSummaryAt ? formatAgo(s.lastSummaryAt) : "");

  // Line 1: ▌ ✓ Memory claude-3.5            5m
  const line1 = cardTitleLine(theme, w, statusColor, statusIcon, "Memory", ctx.memoryModel ? shortModel(ctx.memoryModel) : "", timeStr);

  // Line 2: ▌   last: 2025-01-01 12:00 · turn 3
  let detail = "";
  if (status === "error" && s.lastError) {
    detail = s.lastError.length > w - 5 ? s.lastError.slice(0, w - 6) + "…" : s.lastError;
  } else if (status === "done" && s.lastSummaryAt) {
    const ts = new Date(s.lastSummaryAt).toISOString().replace("T", " ").slice(0, 19);
    detail = `last: ${ts} · turn ${s.runCount}`;
  } else if (status === "recording") {
    detail = "recording turn…";
  } else if (status === "summarizing") {
    detail = "summarizing…";
  } else {
    detail = `turns: ${s.runCount}`;
  }
  const detailColor = status === "error" ? "error" : "dim";
  const line2 = padToVis(
    theme.fg(statusColor, "▌   ") + theme.fg(detailColor, detail),
    w,
  );

  return [line1, line2];
}
