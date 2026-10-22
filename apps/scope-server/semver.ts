/**
 * semver.ts — the tiny version comparison the update checks need.
 *
 * Pi Scope compares npm/PyPI's `latest` tag against what a CLI reports for
 * `--version`. A full semver implementation is not needed: the versions that
 * matter here are plain `x.y.z` releases with an optional prerelease suffix.
 *
 * Kept separate from pi-update.ts because Settings → Update now checks more
 * than Pi (the coding harnesses in harness-update.ts) and both must agree on
 * what "newer" means.
 */

/** Split a semver into numeric components + a prerelease string. */
export function parseVersion(v: string): { nums: number[]; pre: string } {
  const [core, ...pre] = String(v).trim().replace(/^v/i, "").split("-");
  return { nums: core.split(".").map((n) => parseInt(n, 10) || 0), pre: pre.join("-") };
}

/** -1 / 0 / 1 for `a` before / equal to / after `b`. Release beats prerelease. */
export function compareVersions(a: string, b: string): number {
  const A = parseVersion(a);
  const B = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    const diff = (A.nums[i] ?? 0) - (B.nums[i] ?? 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  if (A.pre === B.pre) return 0;
  if (!A.pre) return 1;
  if (!B.pre) return -1;
  return A.pre > B.pre ? 1 : -1;
}

/**
 * The first version-looking token in a CLI's `--version` output, or null.
 *
 * Every harness prints its version in a slightly different wrapper —
 * `2.1.301 (Claude Code)`, `codex-cli 0.163.0`, `opencode v2.1.3`,
 * `aider 0.86.1` — so callers search rather than assume the whole line is one.
 * A date or a build hash next to the version is ignored because a semver has
 * two dots.
 */
export function findVersion(text: string): string | null {
  const match = String(text ?? "").match(/\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/);
  return match ? match[1] : null;
}
