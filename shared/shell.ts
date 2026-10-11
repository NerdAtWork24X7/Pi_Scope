/**
 * shell.ts — shared shell/env helpers for the scope server's user-shell
 * integration.
 *
 * The server is frequently launched from a GUI/desktop session that never
 * sources the user's shell rc files, so anything exported only there is
 * invisible to it. Both chat.ts (PLAYWRIGHT_BROWSERS_PATH for pi's web tools)
 * and stt.ts (GROQ_API_KEY for dictation) have to read those files the same
 * way, and both chat.ts and terminal.ts have to quote values for `sh -c`.
 * Those were three near-identical local copies; they live here now.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Shell rc files an interactive terminal sources, in the order we check them. */
export function shellRcFiles(): string[] {
  const home = os.homedir();
  return [".zshenv", ".zshrc", ".zprofile", ".zlogin", ".bash_profile", ".bashrc", ".profile"]
    .map((f) => path.join(home, f))
    .filter((p) => fs.existsSync(p));
}

/** Expand a leading `~` and `$HOME`/`${HOME}` the way a shell would. */
export function expandShellPath(value: string): string {
  const home = os.homedir();
  return value.replace(/^~(?=\/|$)/, home).replace(/\$\{HOME\}|\$HOME/g, home);
}

/**
 * Every `NAME=value` (optionally `export NAME=value`) assignment for `name`
 * found in the user's shell rc files, in file order and unexpanded. Comment and
 * blank lines are skipped; matching surrounding quotes are stripped. Callers
 * that need a specific value (e.g. a dir that must exist) can scan the list
 * instead of guessing which file wins.
 */
export function readShellEnvValues(name: string): string[] {
  const out: string[] = [];
  for (const rc of shellRcFiles()) {
    let content: string;
    try { content = fs.readFileSync(rc, "utf8"); } catch { continue; }
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const assignment = line.startsWith("export ") ? line.slice(7).trim() : line;
      const eq = assignment.indexOf("=");
      if (eq <= 0 || assignment.slice(0, eq).trim() !== name) continue;
      const val = assignment.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, "$2").trim();
      if (val) out.push(val);
    }
  }
  return out;
}

/** First assignment for `name` in the shell rc files, or "" — the rc-file
 *  equivalent of reading a single environment variable. */
export function readShellEnvValue(name: string): string {
  const [first] = readShellEnvValues(name);
  return first ? expandShellPath(first) : "";
}

/**
 * Every `NAME=value` assignment reachable from the shell rc files, as one map
 * (first occurrence wins; `$HOME`/`~` expanded). Follows `source`/`.` includes
 * whose path is a file under the user's home, so a key defined in a sourced env
 * file (e.g. `~/.free-coding-models.env`) is seen the way a shell would — one
 * pass, bounded depth and file count.
 */
const MAX_SOURCE_DEPTH = 3;
const MAX_SOURCE_FILES = 25;
/** `source <path>` / `. <path>` after a line start or a shell separator. */
const SOURCE_RE = /(?:^|[;&|]\s*)(?:source|\.)\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g;

export function readShellEnvMap(): Record<string, string> {
  const out: Record<string, string> = {};
  const home = os.homedir();
  const seen = new Set<string>();
  const visit = (file: string, depth: number): void => {
    let real: string;
    try { real = fs.realpathSync(file); } catch { return; }
    if (seen.has(real) || seen.size >= MAX_SOURCE_FILES) return;
    seen.add(real);
    let content: string;
    try { content = fs.readFileSync(real, "utf8"); } catch { return; }
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const assignment = line.startsWith("export ") ? line.slice(7).trim() : line;
      const eq = assignment.indexOf("=");
      if (eq > 0) {
        const name = assignment.slice(0, eq).trim();
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !(name in out)) {
          const val = assignment.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, "$2").trim();
          if (val) out[name] = expandShellPath(val);
        }
      }
      if (depth >= MAX_SOURCE_DEPTH) continue;
      for (const match of line.matchAll(SOURCE_RE)) {
        const raw = match[1].replace(/^(['"])(.*)\1$/, "$2").trim();
        // Only literal paths and $HOME: a variable we can't expand is skipped.
        if (!raw || raw.replace(/\$\{HOME\}|\$HOME/g, "").includes("$")) continue;
        const resolved = path.resolve(expandShellPath(raw));
        // Never follow system paths or anything outside the user's home.
        if (!resolved.startsWith(home + path.sep)) continue;
        try { if (fs.statSync(resolved).isFile()) visit(resolved, depth + 1); } catch { /* absent */ }
      }
    }
  };
  for (const rc of shellRcFiles()) visit(rc, 0);
  return out;
}

/** POSIX single-quote escaping for a shell argument (bash/zsh): safe for
 *  spaces, quotes, and metacharacters in paths. */
export function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
