/**
 * Custom Footer Extension - demonstrates ctx.ui.setFooter()
 *
 * footerData exposes data not otherwise accessible:
 * - getGitBranch(): current git branch
 * - getExtensionStatuses(): texts from ctx.ui.setStatus()
 *
 * Token stats come from ctx.sessionManager/ctx.model (already accessible).
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

type PlanEntry = {
  type: string;
  customType?: string;
  data?: { enabled: boolean; executing?: boolean; todos?: { completed: boolean }[] };
};

type GoUsageWindow = { goCost: number }; // $ of opencode-go usage in the window
type GoUsage = { h5: GoUsageWindow; wk: GoUsageWindow; mo: GoUsageWindow };
// Values from the live /zen/go/v1/usage endpoint: percent of the rolling
// $ limit and seconds until that window resets (rolling/weekly/monthly).
type GoUsageApi = {
  h5: { pct: number; resetSec: number };
  wk: { pct: number; resetSec: number };
  mo: { pct: number; resetSec: number };
};

// opencode.go dashboard metric: $ consumed / $ rolling-window limit
// ($12 / 5h, $30 / week, $60 / month). The website percentage is dollar-based,
// not a token share — so it can only be reproduced via the live endpoint.
const GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const GO_USAGE_TTL = 60_000; // refresh the API at most once a minute
const GO_LIMITS: Record<"h5" | "wk" | "mo", number> = { h5: 12, wk: 30, mo: 60 };

export default function (pi: ExtensionAPI) {
  let sessionStart = Date.now();

  function formatElapsed(ms: number): string {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rs = s % 60;
    if (m < 60) return `${m}m${rs > 0 ? rs + "s" : ""}`;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return `${h}h${rm > 0 ? rm + "m" : ""}`;
  }

  // Format a seconds-until-reset countdown as days/hours/minutes.
  function formatReset(sec: number): string {
    const s = Math.max(0, Math.floor(sec));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return h > 0 ? `${d}d${h}h` : `${d}d`;
    if (h > 0) return m > 0 ? `${h}h${m}m` : `${h}h`;
    if (m > 0) return `${m}m`;
    return `${s}s`;
  }

  // Seconds until a usage window resets, from the live /zen/go/v1/usage
  // response. The endpoint returns the reset as an ISO timestamp
  // (`resetsAt`), not seconds-until-reset; accept either form across API
  // variants — an ISO/date string (`resetsAt`/`resetAt`) or a numeric
  // seconds-until-reset (`resetInSec`/`resetSec`/`resetsIn`/`secondsUntilReset`).
  // Returns -1 when no reset boundary is known (e.g. a rolling window whose
  // boundary the endpoint does not report) so the countdown is omitted.
  function resetSeconds(window: GoUsageApi["h5"] | Record<string, unknown> | null | undefined): number {
    const w = (window ?? {}) as Record<string, unknown>;
    const dump = w.resetsAt ?? w.resetAt;
    if (typeof dump === "string") {
      const t = Date.parse(dump);
      if (!Number.isNaN(t)) return Math.max(0, Math.floor((t - Date.now()) / 1000));
    }
    const raw = w.resetInSec ?? w.resetSec ?? w.resetsIn ?? w.secondsUntilReset;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : -1;
  }

  function fmt(n: number): string {
    if (n < 1000) return `${n}`;
    if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
    return `${(n / 1_000_000).toFixed(1)}M`;
  }

  function contextBar(pct: number, width: number, theme: any): string {
    const filled = Math.min(width, Math.max(0, Math.round((pct / 100) * width)));
    const bar = "█".repeat(filled) + "░".repeat(width - filled);
    const color = pct > 90 ? "error" : pct > 70 ? "warning" : "accent";
    return theme.fg(color, bar);
  }

  // Static for the process lifetime — no need to re-split cwd on every render.
  const cwdParts = process.cwd().split(/[/\\]/);
  const cwdShort = cwdParts.length > 2 ? cwdParts.slice(-2).join("/") : process.cwd();

  // Handles for the current footer's timer/branch subscription, so a new
  // session replaces them instead of leaking one interval per session_switch.
  let footerTimer: ReturnType<typeof setInterval> | undefined;
  let footerUnsub: (() => void) | undefined;

  pi.on("session_start", async (_event, ctx) => {
    sessionStart = Date.now();

    // TUI only: footer + its 30 s usage refresh only exist for an interactive
    // session. Spawned subagents run `--mode rpc` (headless) and a JSON/print
    // run has no footer either — wiring the right-side `--right` refresh+render
    // there was pure wasted work (and a network call) per process.
    if (ctx?.mode !== "tui") return;

    // Release the previous session's footer wiring before installing new one.
    if (footerTimer) { clearInterval(footerTimer); footerTimer = undefined; }
    footerUnsub?.();
    footerUnsub = undefined;

    ctx.ui.setFooter((tui, theme, footerData) => {
      footerUnsub = footerData.onBranchChange(() => tui.requestRender());
      footerTimer = setInterval(() => {
        void refreshGoApiUsage();
        tui.requestRender();
      }, 30000);

      // Token usage accumulates as the branch grows, so only scan entries added
      // since the last render instead of re-walking the whole session each tick.
      let stats = { count: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

      function currentStats() {
        const branch = ctx.sessionManager.getBranch();
        if (branch.length < stats.count) {
          // Branch shrank (undo/checkpoint) — recompute from scratch.
          stats = { count: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
        }
        for (let i = stats.count; i < branch.length; i++) {
          const e = branch[i];
          if (e.type === "message" && e.message.role === "assistant") {
            const m = e.message as AssistantMessage;
            stats.input += m.usage.input;
            stats.output += m.usage.output;
            stats.cacheRead += m.usage.cacheRead;
            stats.cacheWrite += m.usage.cacheWrite;
            stats.cost += m.usage.cost.total;
          }
        }
        stats.count = branch.length;
        return stats;
      }

      // ── opencode-go usage: % of the rolling $ limit (mirrors the website) ─
      // The OpenCode Go dashboard reports usage as *dollar* percent of rolling
      // window limits ($12/5h, $30/wk, $60/mo) — not a token share relative to
      // other providers, so the old go-tokens/total-tokens boxes never matched
      // the site. Primary source here is the same live endpoint the website
      // uses: GET https://opencode.ai/zen/go/v1/usage (Bearer <opencode-go
      // key>), returning rolling/weekly/monthly percent for the account. If
      // that fetch fails (offline / no key / endpoint change), fall back to the
      // same metric computed locally: sum per-message *cost* of provider
      // "opencode-go" from the session files and divide by the window limits.
      // Per-file results are cached by mtime; renders only re-scan changed/new
      // session files (files untouched for >30 days contribute 0 and are
      // skipped outright).
      const goUsageCache = new Map<string, { mtimeMs: number } & GoUsage>();
      let goApiUsage: GoUsageApi | null = null; // values from the live endpoint
      let goApiFetchedAt = 0;
      let goApiKey: string | undefined;

      function newWindow(): GoUsageWindow {
        return { goCost: 0 };
      }

      async function refreshGoApiUsage() {
        if (ctx.model?.provider !== "opencode-go") return; // section hidden
        const now = Date.now();
        if (now - goApiFetchedAt < GO_USAGE_TTL) return;
        goApiFetchedAt = now; // re-attempt after the TTL even on failure
        try {
          if (!goApiKey) {
            goApiKey = await ctx.modelRegistry?.getApiKeyForProvider("opencode-go");
          }
          if (!goApiKey) return;
          const res = await fetch(GO_USAGE_URL, { headers: { Authorization: `Bearer ${goApiKey}` } });
          if (!res.ok) return;
          const data = await res.json();
          const u = data?.usage;
          if (u) {
            goApiUsage = {
              h5: { pct: Number(u.rolling?.percent ?? -1), resetSec: resetSeconds(u.rolling) },
              wk: { pct: Number(u.weekly?.percent ?? -1), resetSec: resetSeconds(u.weekly) },
              mo: { pct: Number(u.monthly?.percent ?? -1), resetSec: resetSeconds(u.monthly) },
            };
            tui.requestRender();
          }
        } catch {
          // Keep last known values; retry after the TTL.
        }
      }

      function opencodeGoUsage(now: number): GoUsage {
        const h5t = now - 5 * 3600 * 1000;
        const wkt = now - 7 * 24 * 3600 * 1000;
        const mot = now - 30 * 24 * 3600 * 1000;
        const total: GoUsage = { h5: newWindow(), wk: newWindow(), mo: newWindow() };
        const bump = (win: GoUsageWindow, cost: number) => {
          win.goCost += cost;
        };
        const merge = (target: GoUsage, src: GoUsage) => {
          for (const k of ["h5", "wk", "mo"] as const) {
            target[k].goCost += src[k].goCost;
          }
        };
        let root: string;
        try {
          root = join(ctx.sessionManager.getSessionDir(), "..");
        } catch {
          return total;
        }
        let projects: string[];
        try {
          projects = readdirSync(root);
        } catch {
          return total;
        }
        for (const proj of projects) {
          const dir = join(root, proj);
          let files: string[];
          try {
            files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
          } catch {
            continue; // not a project dir
          }
          for (const file of files) {
            const path = join(dir, file);
            let st;
            try {
              st = statSync(path);
            } catch {
              continue;
            }
            if (st.mtimeMs < mot) continue; // all messages older than 30 days
            const cached = goUsageCache.get(path);
            if (cached && cached.mtimeMs === st.mtimeMs) {
              merge(total, cached);
              continue;
            }
            const agg: GoUsage = { h5: newWindow(), wk: newWindow(), mo: newWindow() };
            let text: string;
            try {
              text = readFileSync(path, "utf8");
            } catch {
              continue;
            }
            for (const line of text.split("\n")) {
              if (!line) continue;
              let entry: any;
              try {
                entry = JSON.parse(line);
              } catch {
                continue;
              }
              if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
              if (entry.message?.provider !== "opencode-go") continue;
              const rawTs = entry.timestamp ?? entry.message?.timestamp;
              const ts = typeof rawTs === "number" ? rawTs : Date.parse(rawTs);
              if (!ts) continue;
              const cost = entry.message?.usage?.cost?.total;
              if (!cost || cost <= 0) continue;
              if (ts >= h5t) {
                bump(agg.h5, cost);
                bump(agg.wk, cost);
                bump(agg.mo, cost);
              } else if (ts >= wkt) {
                bump(agg.wk, cost);
                bump(agg.mo, cost);
              } else if (ts >= mot) {
                bump(agg.mo, cost);
              }
            }
            goUsageCache.set(path, { mtimeMs: st.mtimeMs, h5: agg.h5, wk: agg.wk, mo: agg.mo });
            merge(total, agg);
          }
        }
        return total;
      }

      // Last matching plan-mode entry, without allocating a filtered array.
      function lastPlanEntry(entries: PlanEntry[]): PlanEntry | undefined {
        for (let i = entries.length - 1; i >= 0; i--) {
          const e = entries[i];
          if (e.type === "custom" && e.customType === "plan-mode") return e;
        }
        return undefined;
      }

      // First fetch — runs after the go-usage state above is initialized;
      // the render falls back to local $ sums until the response arrives.
      void refreshGoApiUsage();

      return {
        dispose() {
          // Owned by the outer session_start handler so a later session can
          // replace them; clear whichever handles this footer installed.
          footerUnsub?.();
          footerUnsub = undefined;
          if (footerTimer) { clearInterval(footerTimer); footerTimer = undefined; }
        },
        invalidate() {},
        render(width: number): string[] {
          const { input, output, cacheRead, cacheWrite, cost } = currentStats();

          const usage = ctx.getContextUsage();
          const ctxWindow = usage?.contextWindow ?? 0;
          const pct = usage?.percent ?? 0;

          // ── Model + thinking level ──
          const thinking = pi.getThinkingLevel();
          const thinkColor =
            thinking === "high" ? "warning"
            : thinking === "medium" ? "accent"
            : thinking === "low" ? "dim"
            : "muted";
          const modelId = ctx.model?.id || "no-model";
          const modelBadge =
            theme.fg("accent", `◆ ${modelId}`) + " " + theme.fg(thinkColor, `● ${thinking}`);

          // ── Configured context window + max tokens ──
          const cfgCtx = ctx.model?.contextWindow ?? 0;
          const cfgMax = ctx.model?.maxTokens ?? 0;
          const modelCfg =
            cfgCtx > 0 || cfgMax > 0
              ? theme.fg("dim", `◧ ${cfgCtx > 0 ? fmt(cfgCtx) : "?"} ctx · ${cfgMax > 0 ? fmt(cfgMax) : "?"} max`)
              : "";

          // ── Token stats ──
          const tokenParts: string[] = [
            theme.fg("accent", `↑${fmt(input)}`) + " " + theme.fg("text", `↓${fmt(output)}`),
          ];
          if (cacheRead > 0 || cacheWrite > 0) {
            const cacheParts: string[] = [];
            if (cacheRead > 0) cacheParts.push(`↺${fmt(cacheRead)}`);
            if (cacheWrite > 0) cacheParts.push(`↻${fmt(cacheWrite)}`);
            tokenParts.push(theme.fg("success", `💾 ${cacheParts.join(" ")}`));
          }
          const tokenStr = tokenParts.join("  ");

          // ── Cost ──
          const costStr = theme.fg("warning", "$" + cost.toFixed(2));

          // ── Context usage mini-bar ──
          let contextStr = "";
          if (ctxWindow > 0) {
            const bar = contextBar(pct, 8, theme);
            contextStr = `${bar} ${theme.fg(pct > 75 ? "error" : pct > 50 ? "warning" : "success", `${pct.toFixed(0)}%`)}`;
          }

          // ── Session meta ──
          const elapsed = theme.fg("dim", `⏱ ${formatElapsed(Date.now() - sessionStart)}`);
          const cwdStr = theme.fg("muted", `⌂ ${cwdShort}`);

          const branch = footerData.getGitBranch();
          const branchStr = branch ? theme.fg("accent", `⎇ ${branch}`) : "";

          // ── Plan mode status ──
          const planEntry = lastPlanEntry(ctx.sessionManager.getEntries() as PlanEntry[]);
          const planEnabled = planEntry?.data?.enabled ?? false;
          const planExecuting = planEntry?.data?.executing ?? false;
          const planTodos = planEntry?.data?.todos ?? [];
          let planStr = "";
          if (planExecuting && planTodos.length > 0) {
            let completed = 0;
            for (const t of planTodos) if (t.completed) completed++;
            planStr = theme.fg("accent", `📋 ${completed}/${planTodos.length}`);
          } else if (planEnabled) {
            planStr = theme.fg("warning", "PLAN");
          }

          // ── Row 1: model, tokens, cost, context, meta ──
          const sep = theme.fg("dim", " · ");
          const sections: string[] = [modelBadge, tokenStr, costStr];
          if (modelCfg) sections.push(modelCfg);
          if (contextStr) sections.push(contextStr);
          sections.push(elapsed, cwdStr);
          if (branchStr) sections.push(branchStr);
          if (planStr) sections.push(planStr);

          const line1 = theme.fg("accent", "▌ ") + sections.join(sep);

          // ── Row 2: model provider + per-token pricing ──
          const provider = ctx.model?.provider ?? "?";
          const providerBadge = theme.fg("accent", `◈ ${provider}`);
          const mCost = ctx.model?.cost;
          let pricingStr = "";
          if (mCost) {
            const priceIn = mCost.input === 0 ? "free" : "$" + mCost.input.toFixed(2) + "/M";
            const priceOut = mCost.output === 0 ? "free" : "$" + mCost.output.toFixed(2) + "/M";
            pricingStr = `${theme.fg("dim", `in ${priceIn}`)} ${theme.fg("text", `out ${priceOut}`)}`;
            if (mCost.cacheRead) {
              pricingStr += " " + theme.fg("success", "↺ $" + mCost.cacheRead.toFixed(2) + "/M");
            }
          }
          // ── opencode-go usage — % of rolling $ limit (matches website) ──
          // Only shown when the active provider is opencode-go; otherwise the
          // rolling $ limits don't apply to the current account/model.
          let usageStr = "";
          if (provider === "opencode-go") {
            const fallbackGo = opencodeGoUsage(Date.now()); // local $ sums (API offline)
            const pctFor = (key: "h5" | "wk" | "mo"): number => {
              if (goApiUsage && goApiUsage[key].pct >= 0) return goApiUsage[key].pct;
              const win = fallbackGo[key];
              return win.goCost > 0 ? Math.min(100, (win.goCost / GO_LIMITS[key]) * 100) : 0;
            };
            // Seconds until the window resets, from the live endpoint. The
            // local fallback computes *rolling* $ sums with no discrete reset
            // boundary, so it reports -1 and the countdown is omitted there.
            const resetFor = (key: "h5" | "wk" | "mo"): number => {
              return goApiUsage ? goApiUsage[key].resetSec : -1;
            };
            const pctBox = (label: string, key: "h5" | "wk" | "mo") => {
              const pct = pctFor(key);
              const color = pct > 75 ? "error" : pct > 50 ? "warning" : "success";
              const filled = Math.min(4, Math.round((pct / 100) * 4));
              const bar = "█".repeat(filled) + "░".repeat(4 - filled);
              const reset = resetFor(key);
              const resetStr = reset >= 0 ? " " + theme.fg("dim", "" + formatReset(reset)) : "";
              return `${theme.fg("dim", label)} [${theme.fg(color, bar)} ${theme.fg(color, `${pct.toFixed(0)}%`)}]${resetStr}`;
            };
            usageStr = [
              theme.fg("dim", "go"),
              pctBox("5h", "h5"),
              pctBox("wk", "wk"),
              pctBox("mo", "mo"),
            ].join("  ");
          }

          const line2 =
            theme.fg("accent", "▌ ") +
            [providerBadge, pricingStr, usageStr].filter(Boolean).join(` ${sep} `);

          return [truncateToWidth(line1, width), truncateToWidth(line2, width)];
        },
      };
    });
  });

  pi.on("session_switch", async (event, _ctx) => {
    if (event.reason === "new") {
      sessionStart = Date.now();
    }
  });
}
