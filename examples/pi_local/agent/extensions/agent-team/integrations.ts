// ── Integrations: tool registration + slash commands + shortcut ──

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text, type AutocompleteItem } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import type { AgentTeamContext, BatchTaskResult } from "./core";
import { SessionLogger, displayName, isWritable, shortModel } from "./core";
import { MAX_RESPONSE_LENGTH } from "./orchestration";
import { toggleSidebar } from "./ui";

/** Shared "✓/✗ label - N task(s), F failed (Xs)" summary line for the batch
 *  renderResult. The aggregate elapsed is the sum of per-task elapsed times,
 *  which for a parallel batch is wall-clock-optimistic — it is labelled as
 *  total work, not batch duration. */
function batchSummary(d: any, label: string): [string, string] {
  const results: any[] = d.results ?? [];
  const n = results.length;
  const fails = results.filter(r => r.code !== 0).length;
  const ok = d.status === "done" && fails === 0;
  const total = results.reduce((s, r) => s + (r.elapsed || 0), 0);
  const elapsed = total ? ` (${Math.round(total / 1000)}s)` : "";
  return [ok ? "success" : "error", `${ok ? "✓" : "✗"} ${label} - ${n} task(s)${fails ? `, ${fails} failed` : ""}${elapsed}`];
}

/** How a batch will actually run, given the global parallelDispatch setting and
 *  whether any task targets a writable agent. Mirrors dispatchTasks' routing so
 *  the tool output/labels can't contradict what the scheduler does. */
function batchIsParallel(team: AgentTeamContext, tasks: Array<{ agent: string }>): boolean {
  if (!team.parallelDispatch) return false;
  const anyWritable = tasks.some(t => {
    const ap = team.procs.get(t.agent.toLowerCase());
    return !!ap && isWritable(ap.def, team.destructiveTools);
  });
  return !anyWritable;
}

/** Standard result returned when a dispatch tool runs while the team is off. */
const TEAM_DISABLED_RESULT = { content: [{ type: "text" as const, text: "Agent team is disabled. /agents-team-toggle on" }], details: {} };

/** Truncate a subagent output to the tool-result cap (keeps the tail). */
function capOutput(out: string): string {
  return out.length > MAX_RESPONSE_LENGTH ? out.slice(-MAX_RESPONSE_LENGTH) : out;
}

/** Format a multi-task batch as markdown sections joined by "---", each
 *  headed by the agent name and task, preceded by a status summary.
 *
 *  EVERY task is always represented: its header, status and reason are never
 *  dropped. Only the per-task output BODY is truncated when the combined text
 *  would exceed MAX_RESPONSE_LENGTH, and each task gets an equal share of the
 *  budget. The previous version stopped adding tasks at the cap, so one large
 *  (or a timed-out) result could hide every later task — including ones that
 *  completed — from the orchestrator, which then redid finished work. */
function formatBatchParts(results: BatchTaskResult[]): string {
  const completed = results.filter(r => r.code === 0).length;
  const failed = results.length - completed;

  // One-line-per-task summary so the orchestrator can see at a glance what
  // succeeded, what failed, and why — without reading the full bodies.
  const summaryLines = results.map((res, i) => {
    const mark = res.code === 0 ? "✓" : "✗";
    const why = res.code === 0 ? "" : ` — ${firstLine(res.error || res.output) || "did not complete"}`;
    return `${mark} ${i + 1}. ${res.agent}${why}`;
  });
  const summary =
    `**Batch: ${completed}/${results.length} completed${failed ? `, ${failed} did not` : ""}.**` +
    (failed
      ? `\nCompleted results below are FINAL — do NOT redo them. Retry only the ✗ task(s).`
      : "") +
    `\n${summaryLines.join("\n")}`;

  // Reserve headroom for the summary + every header/status before splitting the
  // remaining budget evenly across task bodies, so no task is ever omitted.
  const headers = results.map(res => {
    const status = res.code === 0 ? "done" : "error";
    return `### ${res.agent}\n${res.task}\n→ ${status} (${Math.round(res.elapsed / 1000)}s)`;
  });
  const overhead = summary.length + headers.reduce((n, h) => n + h.length + 10, 0);
  const perTask = Math.max(1000, Math.floor((MAX_RESPONSE_LENGTH - overhead) / Math.max(1, results.length)));

  const parts = results.map((res, i) => {
    const body = res.output.length > perTask
      ? `${res.output.slice(0, perTask)}\n… [${res.output.length - perTask} more chars truncated]`
      : res.output;
    return `${headers[i]}\n\n${body}`;
  });

  return `${summary}\n\n---\n\n${parts.join("\n\n---\n\n")}`;
}

/** First non-empty line of a string, trimmed (for compact failure reasons). */
function firstLine(s: string): string {
  return (s.split("\n").find(l => l.trim()) || "").trim();
}

/** Get agent display info: [name][model] tag */
function agentTag(team: AgentTeamContext, name: string): string {
  const apRef = team.procs.get(name.toLowerCase());
  return `[${name}][${apRef ? shortModel(apRef.model) : "?"}]`;
}

/** The single subagent-delegation tool. One task, a fan-out of many tasks, or
 *  the same agent across many tasks are all the same shape — a `tasks` array —
 *  and the scheduler decides serial vs parallel from `parallelDispatch` (see
 *  dispatchTasks). Keeping one tool means the model never has to choose a tool
 *  name to control concurrency; the setting does. */
export function registerDispatchTool(pi: ExtensionAPI, team: AgentTeamContext) {
  pi.registerTool({
    name: "dispatch_agents",
    label: "Dispatch Agents",
    description: "Delegate isolated tasks to specialized subagents — one {agent, task} entry per task (a single task is a one-element array). Always send the whole batch in one call; the scheduler decides concurrency from the parallel-dispatch setting: read-only tasks run in parallel when it is ON, and everything runs one at a time when it is OFF. A batch containing any agent with a destructive tool (edit/write) is always serialized regardless of the setting, so destructive work never races. Provide explicit objective, file paths, constraints, and required output format.",
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          agent: Type.String({ description: "Target agent name (e.g. coder, tester, file_reader, searcher)" }),
          task: Type.String({ description: "Task description with objective, context, relevant paths/symbols, and acceptance criteria" }),
        }),
        { description: "Tasks to dispatch, in execution order when serialized" },
      ),
    }),

    async execute(_id, params, signal, onUpdate, _ctx) {
      const { tasks } = params as { tasks: Array<{ agent: string; task: string }> };
      if (!team.enabled) return TEAM_DISABLED_RESULT;
      if (!Array.isArray(tasks) || tasks.length === 0) {
        return {
          content: [{ type: "text", text: "dispatch_agents requires a non-empty `tasks` array of {agent, task}." }],
          details: {},
        };
      }

      const single = tasks.length === 1;
      // ESC / abort tears down only the clones this call created (the abort
      // handler inside runClonePool scopes termination to them).
      try {
        const parallel = batchIsParallel(team, tasks);
        const tag = single ? agentTag(team, tasks[0].agent) : `${tasks.length} task(s)`;
        const modeLabel = parallel ? "in parallel" : "serialized";

        onUpdate?.({
          content: [{ type: "text", text: `${tag} - dispatching ${modeLabel}...` }],
          details: { tasks, status: "dispatching", parallel, single },
        });

        const r = await team.dispatchTasks(tasks, signal);
        if (!r.ok) {
          if (team.wCtx) team.wCtx.ui.notify(`dispatch_agents rejected`, "error");
          return {
            content: [{ type: "text", text: `dispatch_agents rejected: ${r.error}` }],
            details: { tasks, status: "error", error: r.error },
          };
        }

        const anyFail = r.results.some(res => res.code !== 0);
        // A single task returns its raw output; a batch gets the sectioned form.
        const finalOutput = single ? capOutput(r.results[0].output) : formatBatchParts(r.results);
        const totalElapsed = r.results.reduce((s, res) => s + res.elapsed, 0);
        const status = anyFail ? "error" : "done";

        if (anyFail && team.wCtx) {
          team.wCtx.ui.notify(`${tag} - ${status} (${r.results.filter(x => x.code !== 0).length} failed)`, "error");
        }

        return {
          content: [{ type: "text", text: finalOutput }],
          details: { tasks, status, elapsed: totalElapsed, exitCode: anyFail ? 1 : 0, parallel, single, fullOutput: finalOutput, results: r.results },
        };
      } catch (err: any) {
        const names = tasks.map(t => t.agent).join(", ");
        if (team.wCtx) team.wCtx.ui.notify(`[${names}] Error: ${err?.message || err}`, "error");
        return {
          content: [{ type: "text", text: `Error dispatching [${names}]: ${err?.message || err}. The orchestrator should inform the user.` }],
          details: { tasks, status: "error", elapsed: 0, exitCode: 1, fullOutput: "" },
        };
      }
    },

    renderCall(args, theme) {
      const list: Array<{ agent?: string }> = (args as any).tasks || [];
      const names = list.map(t => t.agent).join(", ");
      return new Text(
        theme.fg("toolTitle", theme.bold("dispatch_agents ")) +
        theme.fg("accent", `(${list.length}) `) +
        theme.fg("muted", names),
        0, 0,
      );
    },

    renderResult(result, options, theme) {
      const d = result.details as any;
      if (!d) return new Text((result.content[0] as any)?.text || "", 0, 0);
      if (options.isPartial || d.status === "dispatching") {
        return new Text(theme.fg("accent", `dispatch_agents - working...`), 0, 0);
      }
      // Rejected before any task ran (unknown/disabled agent, team toggled off).
      if (!d.results?.length) {
        return new Text(theme.fg("error", `✗ dispatch_agents - ${d.error || "rejected"}`), 0, 0);
      }

      let header: string;
      if (d.single && d.results?.[0]) {
        const [sumColor, sumText] = batchSummary(d, `${agentTag(team, d.results[0].agent)} -`);
        header = theme.fg(sumColor as any, sumText);
      } else {
        const [sumColor, sumText] = batchSummary(d, `dispatch_agents${d.parallel ? " (parallel)" : " (serialized)"} -`);
        header = theme.fg(sumColor as any, sumText);
      }

      if (options.expanded && d.fullOutput) {
        return new Text(header + "\n" + theme.fg("muted", d.fullOutput), 0, 0);
      }
      return new Text(header, 0, 0);
    },
  });
}

export function registerCommands(pi: ExtensionAPI, team: AgentTeamContext) {
  pi.registerCommand("agents-team", {
    description: "Select a team",
    handler: async (_args, ctx) => {
      team.wCtx = ctx;
      const names = Object.keys(team.teams);
      if (!names.length) { ctx.ui.notify("No teams defined", "warning"); return; }

      const opts = names.map(n => {
        const m = team.teams[n].map(t => displayName(t.name)).join(", ");
        return `${n} - ${m}`;
      });

      const choice = await ctx.ui.select("Select Team", opts);
      if (choice === undefined) return;

      const name = names[opts.indexOf(choice)];
      await team.activateTeam(name);
      team.invalidate();
      ctx.ui.setStatus("agent-team", `Team: ${name} (${team.procs.size})`);
      ctx.ui.notify(`Team: ${name} - ${Array.from(team.procs.values()).map(a => displayName(a.def.name)).join(", ")}`, "info");
    },
  });

  pi.registerCommand("agents-list", {
    description: "List agents + process status",
    handler: async (_args, ctx) => {
      team.wCtx = ctx;
      const list = Array.from(team.procs.values())
        .map(a => {
          const alive = a.proc ? "alive" : "dead";
          return `${displayName(a.def.name)} [${a.status}|${alive}|runs:${a.runCount}] ${a.def.description}`;
        })
        .join("\n");
      ctx.ui.notify(list || "No agents loaded", "info");
    },
  });

  pi.registerCommand("agents-grid", {
    description: "Set grid columns: /agents-grid <1-6>",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const items = ["1", "2", "3", "4", "5", "6"].map(n => ({ value: n, label: `${n} columns` }));
      const f = items.filter(i => i.value.startsWith(prefix));
      return f.length ? f : items;
    },
    handler: async (args, ctx) => {
      team.wCtx = ctx;
      const n = parseInt(args?.trim() || "", 10);
      if (n >= 1 && n <= 6) {
        team.gridCols = n;
        team.persist();
        ctx.ui.notify(`Grid: ${team.gridCols} columns`, "info");
        team.invalidate();
      } else {
        ctx.ui.notify("Usage: /agents-grid <1-6>", "error");
      }
    },
  });

  pi.registerCommand("agents-team-toggle", {
    description: "Enable/disable agent team (on/off/status)",
    handler: async (args, ctx) => {
      const sub = (args.trim().split(/\s+/)[0] ?? "").toLowerCase();
      if (sub === "on") {
        await team.enableAgentTeam(ctx);
        const members = Array.from(team.procs.values()).map(a => displayName(a.def.name)).join(", ");
        await ctx.ui.notify(`✓ Agent team enabled — Team: ${team.activeTeam} (${members}) — agents spawn on-demand`);
      } else if (sub === "off") {
        await team.disableAgentTeam(ctx);
        await ctx.ui.notify("✓ Agent team disabled - all subagent processes killed");
      } else if (sub === "status") {
        await ctx.ui.notify(team.enabled ? "Agent team is enabled" : "Agent team is disabled");
      } else {
        await ctx.ui.notify("Usage: /agents-team-toggle on|off|status");
      }
    },
  });

  pi.registerCommand("agents-debug", {
    description: "Set dispatch-pipeline debug level: /agents-debug [0|1|2|status]",
    handler: async (args, ctx) => {
      team.wCtx = ctx;
      const sub = (args?.trim().split(/\s+/)[0] ?? "").toLowerCase();
      if (sub === "status") {
        const label = team.debugLevel === 0 ? "OFF" : team.debugLevel === 2 ? "2 (lifecycle + raw JSONL)" : "1 (lifecycle)";
        const logPath = SessionLogger.debugLogPath() || "<sessionDir>/agent-team-debug.log";
        ctx.ui.notify(`Debug level: ${label}. Lifecycle log: ${logPath}. Level 2 also writes per-dispatch <agent>-debug.jsonl traces.`, "info");
        return;
      }
      const n = parseInt(sub, 10);
      if (!(n === 0 || n === 1 || n === 2)) {
        ctx.ui.notify("Usage: /agents-debug <0|1|2|status>", "error");
        return;
      }
      team.debugLevel = n;
      SessionLogger.debugLevel = n; // statics are read on the hot dispatch path
      team.persist();
      const logPath = SessionLogger.debugLogPath() || "<sessionDir>/agent-team-debug.log";
      ctx.ui.notify(
        n === 0
          ? "Debug: OFF"
          : n === 1
            ? `Debug: 1 — dispatch lifecycle events appended to ${logPath}.`
            : `Debug: 2 — lifecycle events + per-dispatch raw JSONL traces under ${SessionLogger.debugDir || "<sessionDir>"}/.`,
        "info",
      );
      team.invalidate();
    },
  });

  pi.registerCommand("agents-parallel", {
    description: "Toggle GLOBAL parallelism (subagent dispatch + host tool calls): /agents-parallel [on|off|status] [max N]",
    handler: async (args, ctx) => {
      team.wCtx = ctx;
      const tokens = (args?.trim().split(/\s+/).filter(Boolean) ?? []).map(t => t.toLowerCase());
      let changed = false;
      let note = "";
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t === "on") { team.parallelDispatch = true; changed = true; }
        else if (t === "off") { team.parallelDispatch = false; changed = true; }
        else if (t === "status") { /* report only */ }
        else if (t === "max") {
          const n = parseInt(tokens[++i] ?? "", 10);
          if (Number.isFinite(n) && n >= 1 && n <= 20) { team.maxParallel = n; changed = true; }
          else note += "Invalid max (1-20). ";
        } else if (t.startsWith("max=")) {
          const n = parseInt(t.slice(4), 10);
          if (Number.isFinite(n) && n >= 1 && n <= 20) { team.maxParallel = n; changed = true; }
          else note += "Invalid max (1-20). ";
        } else {
          note += `Unknown arg "${t}". `;
        }
      }
      if (changed) {
        team.persist();
        pi.setActiveTools(team.activeToolList());
        team.invalidate();
      }
      const mode = team.parallelDispatch ? "ON" : "OFF";
      ctx.ui.notify(
        `${note}Parallelism: ${mode} — covers subagent dispatch AND host tool calls (read/grep/find/ls); writes always serialized. ` +
        (team.parallelDispatch
          ? `Independent read-only tasks run in parallel (max ${team.maxParallel} at once); any batch with a writable agent is serialized.`
          : "dispatch_agents runs one task at a time, in the order given."),
        "info",
      );
    },
  });
}


export function registerShortcut(pi: ExtensionAPI, team: AgentTeamContext) {
  pi.registerShortcut("alt+s", {
    description: "Toggle agent team sidebar",
    handler: async (ctx) => {
      if (!team.enabled) return;
      team.wCtx = ctx;
      toggleSidebar(team);
    },
  });

  pi.registerShortcut("ctrl+shift+e", {
    description: "Toggle agent team on/off",
    handler: async (ctx) => {
      team.wCtx = ctx;
      if (team.enabled) {
        await team.disableAgentTeam(ctx);
        ctx.ui.notify("✓ Agent team disabled", "info");
      } else {
        await team.enableAgentTeam(ctx);
        const members = Array.from(team.procs.values()).map(a => displayName(a.def.name)).join(", ");
        ctx.ui.setStatus("agent-team", `Team: ${team.activeTeam} (${team.procs.size})`);
        ctx.ui.notify(`✓ Agent team enabled — Team: ${team.activeTeam} (${members})`, "info");
      }
    },
  });

}
