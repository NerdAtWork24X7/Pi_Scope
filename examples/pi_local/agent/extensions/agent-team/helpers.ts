/**
 * helpers.ts — shared utilities used by two or more agent-team modules.
 *
 * Everything here is pure (no module state) and imports only from core.ts,
 * so any module can pull these in without creating import cycles:
 *
 *   core.ts      types + primitives (no internal imports)
 *   helpers.ts   derived shared helpers  → imports core only
 *   config / extensions / memory / orchestration / ui / integrations / index
 *
 * What lives here and why:
 *   visLen / trunc / padToVis   text measuring — were private copies in ui.ts and memory.ts
 *   statusDisplay               one status→(color, icon) map — was copy-pasted 3× in ui.ts
 *   cardTitleLine               the "▌ ● Name model  12s" card header — was 2× in ui.ts
 *   boxBorder / sidebarRow      bordered row builders — were ~15 inline copies in ui.ts
 *   piBin / fullModelId         platform/model-id helpers — were inline in 3 files
 *   availableAgentNames         "Agent X not found. Available: …" list — was 3× in orchestration.ts
 */

import type { AgentTeamContext } from "./core";
import { ansiRe, displayName, hrPad } from "./core";

// ── Text measure / transform ──

/** Matches any code point outside 7-bit ASCII. Pure-ASCII strings need no
 *  grapheme accounting (code units === code points === cells), so the `[...s]`
 *  spread can be skipped entirely — and these three helpers run for every cell
 *  of every widget/sidebar frame (agent cards, log panels, sidebar rows), where
 *  log text is overwhelmingly ASCII. Same fast-path idea as hrPad in core.ts. */
const NON_ASCII_RE = /[^\x00-\x7F]/;

/** Visible cell count of a (possibly ANSI-colored) string. */
export function visLen(s: string): number {
  const plain = s.replace(ansiRe, "");
  return NON_ASCII_RE.test(plain) ? [...plain].length : plain.length;
}

/** Truncate to at most `n` graphemes, including a 1-char "…" when cut. */
export function trunc(s: string, n: number): string {
  if (!s || n <= 0) return "";
  if (!NON_ASCII_RE.test(s)) return s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s;
  const cells = [...s];
  return cells.length > n ? cells.slice(0, Math.max(0, n - 1)).join("") + "…" : s;
}

/** Pad a coloured string to exactly `targetW` visible cells with trailing spaces. */
export function padToVis(colored: string, targetW: number): string {
  const pad = targetW - visLen(colored);
  return pad > 0 ? colored + " ".repeat(pad) : colored;
}

// ── Status presentation ──

const STATUS_DISPLAY: Record<string, { color: string; icon: string }> = {
  idle: { color: "dim", icon: "○" },
  starting: { color: "warning", icon: "◐" },
  recording: { color: "warning", icon: "◐" },
  running: { color: "accent", icon: "●" },
  summarizing: { color: "accent", icon: "●" },
  done: { color: "success", icon: "✓" },
};

/** Shared status → (theme color, icon) mapping for agent cards, the memory
 *  card, and the sidebar agent list. Unknown statuses (error/dead) fall back
 *  to the error style. */
export function statusDisplay(status: string): { color: string; icon: string } {
  return STATUS_DISPLAY[status] ?? { color: "error", icon: "●" };
}

/** Line 1 of a status card: "▌ ● Name model<pad>12s" — shared by the agent
 *  card and the memory card so the two can't drift apart. */
export function cardTitleLine(
  theme: any,
  w: number,
  color: string,
  icon: string,
  name: string,
  model: string,
  timeStr: string,
): string {
  const prefixLen = 4; // "▌ ● "
  const modelStr = model ? ` ${model}` : "";
  const maxLabel = Math.max(1, w - prefixLen - [...timeStr].length - 1);
  const truncatedName = trunc(name, maxLabel - [...modelStr].length);
  const visibleL1 = prefixLen + [...truncatedName].length + [...modelStr].length;
  const spacing = Math.max(1, w - visibleL1 - [...timeStr].length);
  return (
    theme.fg(color, "▌ ") +
    theme.fg(color, icon + " ") +
    theme.fg("text", theme.bold(truncatedName)) +
    theme.fg("dim", modelStr) +
    " ".repeat(spacing) +
    theme.fg("dim", timeStr)
  );
}

// ── Boxed row builders (sidebar + widget) ──

export type BorderKind = "top" | "sep" | "bottom";

/** One horizontal border line ("╭──╮" / "├──┤" / "╰──╯") exactly `w` cells wide. */
export function boxBorder(theme: any, w: number, kind: BorderKind): string {
  const [l, r] = kind === "top" ? ["╭", "╮"] : kind === "bottom" ? ["╰", "╯"] : ["├", "┤"];
  return theme.fg("border", hrPad("", w, l, r, "─"));
}

export interface SidebarCell {
  /** Plain text (no ANSI) — used for both rendering and width math. */
  t: string;
  /** Theme color name. */
  c: string;
  /** Bold. */
  b?: boolean;
}

/** Build one bordered sidebar row from colored cells, exactly `w` cells wide.
 *  Cells are emitted left-to-right; when the row overflows, the cell that
 *  crosses the boundary is truncated with "…" and the rest are dropped.
 *  When `selected`, the whole body (content + padding) gets the selection
 *  background. Replaces the ~9 hand-rolled copies of this pattern that used
 *  to make up the sidebar renderer. */
export function sidebarRow(theme: any, w: number, cells: SidebarCell[], selected = false): string {
  const inner = w - 2; // cells between the two border glyphs
  let budget = Math.max(0, inner - 1); // reserve the leading space
  let content = "";
  let used = 0;
  for (const cell of cells) {
    if (budget <= 0) break;
    let text = cell.t;
    const len = [...text].length;
    if (len > budget) text = [...text].slice(0, Math.max(0, budget - 1)).join("") + "…";
    const emitted = [...text].length;
    content += cell.b ? theme.fg(cell.c, theme.bold(text)) : theme.fg(cell.c, text);
    used += emitted;
    budget -= len;
  }
  const body = " " + content + " ".repeat(Math.max(0, inner - 1 - used));
  return theme.fg("border", "│") + (selected ? theme.bg("selectedBg", body) : body) + theme.fg("border", "│");
}

// ── Process / model helpers ──

/** Platform-correct pi binary name (Windows needs the .cmd shim). */
export function piBin(): string {
  return process.platform === "win32" ? "pi.cmd" : "pi";
}

/** Provider-prefixed model id (e.g. "zai/glm-5.1") from a ctx.model object.
 *  The prefix avoids ambiguous resolution when multiple providers define the
 *  same model id. */
export function fullModelId(m: any): string {
  return m ? (m.provider ? `${m.provider}/${m.id}` : m.id) : "";
}

/** Comma-separated display names of all loaded agents — used in the standard
 *  "Agent not found. Available: …" error message. */
export function availableAgentNames(ctx: AgentTeamContext): string {
  return Array.from(ctx.procs.values()).map(a => displayName(a.def.name)).join(", ");
}
