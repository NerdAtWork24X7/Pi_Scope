// ── Custom file tools: custom_read, custom_write, custom_edit ──

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { randomBytes } from "crypto";

// ── File helpers shared by the custom read/write/edit tools ──

/** Read `[offset, offset+limit)` lines from a file without loading the whole
 *  file into memory. Stops reading as soon as `limit` lines are collected.
 *  Line content is preserved byte-for-byte (including `\r`); only the `\n`
 *  delimiter is stripped. Throws on binary files (NUL bytes). */
async function readLineRange(
  absolutePath: string,
  offset: number,
  limit: number,
): Promise<{ lines: string[]; scanned: number; complete: boolean }> {
  const stream = createReadStream(absolutePath, { encoding: "utf8", highWaterMark: 64 * 1024 });
  const lines: string[] = [];
  let buf = "";
  let scanned = 0;
  try {
    for await (const chunk of stream) {
      if ((chunk as string).includes("\0")) throw new Error("file appears to be binary (contains NUL bytes)");
      buf += chunk;
      let idx: number;
      let stop = false;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        scanned++;
        if (scanned >= offset) {
          lines.push(line);
          if (lines.length >= limit) { stop = true; break; }
        }
      }
      if (stop) return { lines, scanned, complete: false };
    }
    if (buf.length > 0) {
      scanned++;
      if (scanned >= offset && lines.length < limit) lines.push(buf);
    }
    return { lines, scanned, complete: true };
  } finally {
    stream.destroy();
  }
}

/** Atomic write: write to a temp file in the same directory, then rename.
 *  Creates parent directories as needed. A crash mid-write can no longer
 *  leave a truncated target file. */
function writeFileAtomic(absolutePath: string, content: string): void {
  mkdirSync(dirname(absolutePath), { recursive: true });
  const tmp = `${absolutePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, absolutePath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

// ── Side-by-side diff rendering (custom_edit result) ──

type DiffOp = { type: "same" | "del" | "add"; oldIdx?: number; newIdx?: number };

const LCS_CELL_LIMIT = 1_000_000; // fall back to block del+add above this
const DIFF_CONTEXT = 2;           // unchanged context lines around each change
const DIFF_ROW_CAP = 80;          // safety cap on rendered diff rows
const DIFF_DETAIL_CAP = 50_000;   // skip storing oldText/newText in details above this

/** Line-level LCS diff. Common prefix/suffix are trimmed first so large
 *  edits with small changes stay cheap; oversized middles degrade to a
 *  simple delete-all/add-all block instead of an O(n·m) blowup. */
function computeLineOps(oldLines: string[], newLines: string[]): DiffOp[] {
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd--; newEnd--; }

  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ type: "same", oldIdx: i, newIdx: i });

  const m = oldEnd - start;
  const n = newEnd - start;
  if (m > 0 || n > 0) {
    if (m * n <= LCS_CELL_LIMIT) {
      const width = n + 1;
      const dp = new Uint32Array((m + 1) * width);
      for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
          dp[i * width + j] = oldLines[start + i] === newLines[start + j]
            ? dp[(i + 1) * width + j + 1] + 1
            : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
        }
      }
      let i = 0;
      let j = 0;
      while (i < m && j < n) {
        if (oldLines[start + i] === newLines[start + j]) { ops.push({ type: "same", oldIdx: start + i, newIdx: start + j }); i++; j++; }
        else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) { ops.push({ type: "del", oldIdx: start + i }); i++; }
        else { ops.push({ type: "add", newIdx: start + j }); j++; }
      }
      while (i < m) { ops.push({ type: "del", oldIdx: start + i }); i++; }
      while (j < n) { ops.push({ type: "add", newIdx: start + j }); j++; }
    } else {
      for (let i = start; i < oldEnd; i++) ops.push({ type: "del", oldIdx: i });
      for (let j = start; j < newEnd; j++) ops.push({ type: "add", newIdx: j });
    }
  }

  for (let i = oldEnd; i < oldLines.length; i++) ops.push({ type: "same", oldIdx: i, newIdx: newEnd + (i - oldEnd) });
  return ops;
}

/** Build a line-numbered side-by-side diff for display in the TUI, framed in
 *  a rounded box with two equal columns (OLD │ NEW) that fit within `width`
 *  cells. Only change hunks plus DIFF_CONTEXT lines of context are shown;
 *  long unchanged runs collapse to a single marker row, overlong lines are
 *  truncated with an ellipsis so they never wrap, and the output is capped at
 *  DIFF_ROW_CAP rows so large edits cannot flood the TUI. */
function sideBySideDiff(oldText: string, newText: string, theme: any, width: number): string {
  const oldLines = oldText.length ? oldText.split("\n") : [];
  const newLines = newText.length ? newText.split("\n") : [];
  const ops = computeLineOps(oldLines, newLines);

  // Column geometry: │ left │ right │ — content columns padded to a fixed
  // width so the separators form straight vertical rules across all rows.
  const total = Math.max(24, width);
  const inner = total - 2; // cells between the outer borders
  const leftW = Math.floor((inner - 1) / 2);
  const rightW = inner - 1 - leftW;
  // Tabs would be expanded to 3 spaces by the Text component at render time,
  // so expand them here first to keep width accounting exact.
  const fit = (s: string, w: number) => {
    const t = s.replace(/\t/g, "   ");
    return t.length <= w ? t.padEnd(w) : t.slice(0, Math.max(0, w - 1)) + "…";
  };
  const border = (s: string) => theme.fg("border", s);
  const hBar = (l: string, m: string, r: string) =>
    border(l + "─".repeat(leftW) + m + "─".repeat(rightW) + r);

  // Mark ops to keep: every change plus DIFF_CONTEXT lines on each side.
  const keep = new Array<boolean>(ops.length).fill(false);
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type !== "same") {
      for (let k = -DIFF_CONTEXT; k <= DIFF_CONTEXT; k++) {
        if (i + k >= 0 && i + k < ops.length) keep[i + k] = true;
      }
    }
  }

  const numWidth = String(Math.max(oldLines.length, newLines.length, 1)).length;
  const gutterWidth = numWidth + 2; // sign + number + trailing space
  const gutter = (sign: string, n: number | undefined) =>
    `${sign}${n === undefined ? " ".repeat(numWidth) : String(n).padStart(numWidth)} `;
  const sep = border("│");

  // Header row: column titles aligned with the line content (past the gutter),
  // boxed and split from the body by a separator with a column junction.
  const gutterPad = " ".repeat(gutterWidth);
  const title = fit(" comparison", inner);
  const rows: string[] = [
    border("╭") + theme.fg("toolTitle", theme.bold(title)) + border("╮"),
    border("│") +
      theme.fg("error", theme.bold(fit(gutterPad + "OLD", leftW))) +
      sep +
      theme.fg("success", theme.bold(fit(gutterPad + "NEW", rightW))) +
      border("│"),
    hBar("├", "┬", "┤"),
  ];
  let hidden = 0;
  const flushHidden = () => {
    if (hidden > 0) {
      // Full-width marker row spanning both columns (TUI style).
      rows.push(border("│") + theme.fg("dim", fit(`${gutterPad}⋮ ${hidden} unchanged`, inner)) + border("│"));
      hidden = 0;
    }
  };

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (!keep[i]) { hidden++; continue; }
    if (op.type === "same") {
      flushHidden();
      const num = gutter(" ", op.oldIdx! + 1);
      rows.push(
        border("│") +
        theme.fg("dim", fit(num + oldLines[op.oldIdx!], leftW)) + sep +
        theme.fg("dim", fit(num + newLines[op.newIdx!], rightW)) +
        border("│"),
      );
      continue;
    }
    flushHidden();
    const dels: number[] = [];
    const adds: number[] = [];
    let j = i;
    while (j < ops.length && ops[j].type !== "same") {
      if (ops[j].type === "del") dels.push(ops[j].oldIdx!);
      else adds.push(ops[j].newIdx!);
      j++;
    }
    i = j - 1;
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) {
      const d = k < dels.length ? dels[k] : undefined;
      const a = k < adds.length ? adds[k] : undefined;
      const left = d === undefined ? " ".repeat(leftW) : theme.fg("error", fit(gutter("-", d + 1) + oldLines[d], leftW));
      const right = a === undefined ? " ".repeat(rightW) : theme.fg("success", fit(gutter("+", a + 1) + newLines[a], rightW));
      rows.push(border("│") + left + sep + right + border("│"));
    }
  }
  flushHidden();
  if (rows.length > 3) rows.push(hBar("╰", "┴", "╯"));

  let note = "";
  if (rows.length > DIFF_ROW_CAP) {
    note = "\n" + theme.fg("dim", `… ${rows.length - DIFF_ROW_CAP} more diff row(s) truncated`);
    const bottom = rows.pop()!; // keep the box's bottom border visible
    rows.length = DIFF_ROW_CAP - 1;
    rows.push(bottom);
  }
  return rows.join("\n") + note;
}

/** Compatibility wrapper for Pi's strict file reader. Accepts `file` as an alias for `path`. */
export function registerCustomReadTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "custom_read",
    label: "Custom Read",
    description: "Read file text or line range. Accepts path or file alias, plus optional offset and limit.",
    parameters: Type.Object({
      path: Type.Optional(Type.String()),
      file: Type.Optional(Type.String()),
      offset: Type.Optional(Type.Number()),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_id, params) {
      const input = params as Record<string, unknown>;
      const filePath = firstStringArg(input, "path", "file");
      if (typeof filePath !== "string" || !filePath) {
        throw new Error("custom_read requires `path` or `file`.");
      }

      const absolutePath = resolve(filePath);
      if (!existsSync(absolutePath)) {
        throw new Error(`File not found: ${filePath}`);
      }
      // Rejects directories (EISDIR) and FIFOs/sockets (which would hang a read).
      if (!statSync(absolutePath).isFile()) {
        throw new Error(`Not a regular file: ${filePath}`);
      }

      const offset = typeof input.offset === "number" ? Math.max(1, Math.floor(input.offset)) : 1;
      const limit = typeof input.limit === "number" ? Math.max(1, Math.floor(input.limit)) : Number.POSITIVE_INFINITY;

      try {
        const { lines, scanned, complete } = await readLineRange(absolutePath, offset, limit);
        const text = lines.join("\n");
        let note = "";
        if (lines.length === 0) {
          note = complete
            ? (scanned === 0 ? "file is empty" : `offset ${offset} is past end of file (${scanned} line(s))`)
            : "no lines in requested range";
        }
        return {
          content: [{ type: "text", text: note ? (text ? `${text}\n[custom_read: ${note}]` : `[custom_read: ${note}]`) : text }],
          details: {
            ok: true,
            filePath,
            offset,
            limit: Number.isFinite(limit) ? limit : undefined,
            lines: lines.length,
            complete,
            note: note || undefined,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Read failed for ${filePath}: ${message}`);
      }
    },
    renderCall(args, theme) {
      const a = args as any;
      const filePath = a.path || a.file || "?";
      const range = [a.offset, a.limit].filter((v) => v !== undefined).join(", ");
      return new Text(
        theme.fg("toolTitle", theme.bold("custom_read ")) +
        theme.fg("accent", filePath) +
        (range ? theme.fg("muted", ` (${range})`) : ""),
        0, 0,
      );
    },
    renderResult(result, options, theme) {
      const details = result.details as any;
      const text = (result.content[0] as any)?.text || "";
      if (details?.ok === false) return new Text(theme.fg("error", text), 0, 0);
      // Collapsed (Ctrl+O off): show a one-line summary only. Note that pi's
      // tool container still renders a trailing "…" line, which ends up above
      // this body — same as the built-in tools, so the affordance stays.
      if (!options?.expanded) {
        const filePath = details?.filePath || "?";
        const n = typeof details?.lines === "number" ? details.lines : 0;
        return new Text(theme.fg("dim", `— ${n} line(s) from `) + theme.fg("accent", filePath), 0, 0);
      }
      // Render with a dim line-number gutter (numbers exist only in the TUI —
      // the model receives raw text so exact-match edits keep working) and
      // cap the display so huge reads don't flood the scrollback.
      const RENDER_CAP = 400;
      const lines = text.split("\n");
      const realLines = typeof details?.lines === "number" ? details.lines : lines.length;
      const start = typeof details?.offset === "number" ? details.offset : 1;
      const shown = lines.slice(0, Math.min(realLines, RENDER_CAP));
      const width = String(start + Math.max(realLines, 1) - 1).length;
      const parts = shown.map((l: string, i: number) =>
        theme.fg("dim", `${String(start + i).padStart(width)} │ `) + theme.fg("muted", l),
      );
      if (details?.note) parts.push(theme.fg("dim", `[${details.note}]`));
      if (realLines > RENDER_CAP) parts.push(theme.fg("dim", `… ${realLines - RENDER_CAP} more line(s)`));
      return new Text(parts.join("\n"), 0, 0);
    },
  });
}

/** DeepSeek-friendly wrapper for Pi's strict file-writing tool. */
export function registerCustomWriteTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "custom_write",
    label: "Custom Write",
    description: "Write complete file contents to disk. Accepts path/file and content/text/data aliases.",
    parameters: Type.Object({
      path: Type.Optional(Type.String()),
      file: Type.Optional(Type.String()),
      content: Type.Optional(Type.String()),
      text: Type.Optional(Type.String()),
      data: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const input = params as Record<string, unknown>;
      const filePath = firstStringArg(input, "path", "file");
      const content = firstStringArg(input, "content", "text", "data");
      if (typeof filePath !== "string" || !filePath || typeof content !== "string") {
        throw new Error("custom_write requires path and content (aliases file/text/data accepted).");
      }
      try {
        const absolutePath = resolve(filePath);
        writeFileAtomic(absolutePath, content);
        const bytes = Buffer.byteLength(content, "utf8");
        return {
          content: [{ type: "text", text: `Wrote ${filePath} (${bytes} bytes).` }],
          details: {
            ok: true,
            filePath,
            bytes,
            characters: content.length,
            preview: content.slice(0, 2000),
            truncated: content.length > 2000,
            result: `Wrote ${filePath}.`,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Write failed for ${filePath}: ${message}`);
      }
    },
    renderCall(args, theme) {
      const a = args as any;
      const filePath = a.path || a.file || "?";
      const body = a.content ?? a.text ?? a.data;
      const size = typeof body === "string" ? theme.fg("muted", ` (${body.length} chars)`) : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("custom_write ")) + theme.fg("accent", filePath) + size,
        0, 0,
      );
    },
    renderResult(result, options, theme) {
      const details = result.details as any;
      if (!details) return new Text((result.content[0] as any)?.text || "", 0, 0);
      if (options.isPartial) {
        return new Text(theme.fg("accent", "custom_write - writing..."), 0, 0);
      }
      if (details.ok === false) {
        return new Text(theme.fg("error", "✗ ") + theme.fg("muted", (result.content[0] as any)?.text || "Write failed"), 0, 0);
      }
      const header = theme.fg("success", "✓ ") +
        theme.fg("accent", details.filePath || "?") +
        theme.fg("muted", ` — ${details.bytes ?? 0} bytes (${details.characters ?? 0} chars)`);
      if (!options.expanded) return new Text(header, 0, 0);
      const previewLines = (typeof details.preview === "string" ? details.preview : "").split("\n").slice(0, 12);
      const width = String(previewLines.length).length;
      const body = previewLines.map((l: string, i: number) =>
        theme.fg("dim", `${String(i + 1).padStart(width)} │ `) + theme.fg("muted", l),
      ).join("\n");
      const more = details.truncated ? "\n" + theme.fg("dim", "… (preview truncated)") : "";
      return new Text(header + "\n" + body + more, 0, 0);
    },
  });
}

/** DeepSeek-friendly replacement for Pi's strict exact-match edit tool. */
export function registerCustomEditTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "custom_edit",
    label: "Custom Edit",
    description: "Replace exact text in a file. Accepts path/file, oldString/search, and newString/replace aliases.",
    parameters: Type.Object({
      path: Type.Optional(Type.String()), file: Type.Optional(Type.String()),
      oldString: Type.Optional(Type.String()), old_string: Type.Optional(Type.String()), old_text: Type.Optional(Type.String()), search: Type.Optional(Type.String()),
      newString: Type.Optional(Type.String()), new_string: Type.Optional(Type.String()), new_text: Type.Optional(Type.String()), replace: Type.Optional(Type.String()),
      replaceAll: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params) {
      const input = params as Record<string, unknown>;
      const filePath = firstStringArg(input, "path", "file");
      const oldText = firstStringArg(input, "oldString", "old_string", "old_text", "search");
      const newText = firstStringArg(input, "newString", "new_string", "new_text", "replace");
      if (typeof filePath !== "string" || typeof oldText !== "string" || typeof newText !== "string") {
        throw new Error("custom_edit requires path, oldString, and newString (aliases accepted).");
      }
      const absolutePath = resolve(filePath);
      if (!existsSync(absolutePath)) throw new Error(`File not found: ${filePath}`);
      if (!statSync(absolutePath).isFile()) throw new Error(`Not a regular file: ${filePath}`);
      if (oldText.length === 0) throw new Error("oldString must not be empty.");
      if (oldText === newText) throw new Error("oldString and newString are identical; nothing to change.");
      try {
        const content = readFileSync(absolutePath, "utf8");
        if (content.includes("\0")) throw new Error(`Refusing to edit binary file: ${filePath}`);
        const matches = content.split(oldText).length - 1;
        if (matches === 0) throw new Error(`No match found in ${filePath}; re-read and retry.`);
        if (matches > 1 && input.replaceAll !== true) throw new Error(`Found ${matches} matches; provide a more specific search or set replaceAll=true.`);
        const updated = input.replaceAll === true ? content.split(oldText).join(newText) : content.replace(oldText, newText);
        writeFileAtomic(absolutePath, updated);
        // Avoid storing huge old/new strings in session details: above
        // DIFF_DETAIL_CAP the render falls back to a summary instead.
        const keepDiff = oldText.length + newText.length <= DIFF_DETAIL_CAP;
        return {
          content: [{ type: "text", text: `Updated ${filePath} (${matches} replacement${matches > 1 ? "s" : ""}).` }],
          details: {
            ok: true,
            matches,
            filePath,
            oldLines: oldText.split("\n").length,
            newLines: newText.split("\n").length,
            oldText: keepDiff ? oldText : undefined,
            newText: keepDiff ? newText : undefined,
            diffOmitted: !keepDiff,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Edit failed for ${filePath}: ${message}`);
      }
    },
    renderCall(args, theme) {
      const a = (args as any);
      const fp = a.path || a.file || "?";
      // Flatten newlines so multi-line oldString values can't break the header layout.
      const t = String(a.oldString || a.old_string || a.old_text || a.search || "").replace(/\r/g, "").replace(/\n/g, "⏎");
      return new Text(
        theme.fg("toolTitle", theme.bold("custom_edit ")) +
        theme.fg("accent", `${fp} - `) +
        theme.fg("muted", `${t.slice(0, 60)}${t.length > 60 ? "…" : ""}`),
        0, 0,
      );
    },
    renderResult(result, options, theme) {
      const d = result.details as any;
      if (!d) return new Text((result.content[0] as any)?.text || "", 0, 0);
      if (options.isPartial) {
        return new Text(theme.fg("accent", "custom_edit - editing..."), 0, 0);
      }
      if (d.ok !== true) {
        const msg = (result.content[0] as any)?.text || "Edit failed";
        return new Text(theme.fg("error", "✗ ") + theme.fg("muted", msg), 0, 0);
      }
      // Success — build side-by-side diff (or a summary for oversized edits).
      // Collapsed (Ctrl+O off): header line only; expanded shows the full diff.
      const fp = d.filePath || "?";
      const header = theme.fg("success", "✓ ") + theme.fg("accent", fp) +
        (d.matches > 1 ? theme.fg("muted", ` (${d.matches} replacements)`) : "");
      if (!options.expanded) return new Text(header, 0, 0);
      if (d.diffOmitted || typeof d.oldText !== "string" || typeof d.newText !== "string") {
        return new Text(header + "\n" + theme.fg("dim", `(large edit: ${d.oldLines ?? "?"} → ${d.newLines ?? "?"} lines, diff omitted)`), 0, 0);
      }
      // Fit the two-column diff to the terminal: the tool result renders in a
      // Box with 1-cell padding on each side, and 1 extra cell of slack keeps
      // long rows from wrapping if the surrounding chrome changes.
      const termWidth = typeof process.stdout?.columns === "number" ? process.stdout.columns : 80;
      return new Text(header + "\n" + sideBySideDiff(d.oldText, d.newText, theme, termWidth - 3), 0, 0);
    },
  });
}

/** First present string among a tool input's alias keys (deepseek-style
 *  `path`/`file`, `content`/`text`/`data`, …). Returns undefined when none
 *  of the aliases is a string — callers reject with their own message. */
function firstStringArg(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = input[k];
    if (typeof v === "string") return v;
  }
  return undefined;
}
