/**
 * pi-bundle-paths.ts — where Pi Scope's bundled `pi` coding agent lives.
 *
 * The agent itself is an npm package (`@earendil-works/pi-coding-agent`) inside a
 * small npm project. Pi Scope *installs* that project into its own data
 * directory — `~/.pi-scope/pi` — rather than into the checkout or the packaged
 * resources, for three reasons:
 *
 *   1. It is writable, so Settings → Update can replace the agent in place. A
 *      copy shipped inside an AppImage/NSIS package is a read-only mount and
 *      could never be updated.
 *   2. It survives re-installing or moving the app, and never pollutes a
 *      checkout with a 150 MB `node_modules`.
 *   3. It matches the rest of Pi Scope's per-user state (`~/.pi-scope/agent`,
 *      `~/.pi-scope/plugins`, `~/.pi-scope/scope.db`).
 *
 * The repo (or the package) still keeps a *template*: `apps/scope-desktop/pi-bundle`
 * holds the manifest a fresh install needs, and a release build pre-installs it
 * there so the packaged app can seed `~/.pi-scope/pi` offline (it ships as
 * `resources/pi`). `apps/scope-desktop/pi-bundle-install.mjs` does the seeding.
 *
 * Resolution order (first hit wins):
 *   1. `SCOPE_PI_BUNDLE_DIR` — explicit operator override (also what the packaged
 *      launcher sets when it could not seed the managed copy, so a read-only
 *      `resources/pi` still works).
 *   2. `~/.pi-scope/pi` — the managed install.
 *   3. `<repo>/apps/scope-desktop/pi-bundle` — a dev checkout that predates the
 *      managed install; kept so the launcher/installer can migrate it in place.
 *
 * This module is deliberately side-effect free (no shim, no env writes, no I/O
 * beyond `statSync`): the launcher, the installer and the e2e tests all read the
 * same rules without triggering a boot.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** The npm package Pi Scope bundles. */
const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/** Repo root in dev; the app resources dir when packaged. Only reliable for
 *  locating dev paths — packaged callers pass `SCOPE_PI_BUNDLE_DIR`. */
export const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..");

/** Pi Scope's per-user data directory (`~/.pi-scope`). */
export function scopeHomeDir(): string {
  return path.join(os.homedir(), ".pi-scope");
}

/** The managed bundle install — the one Pi Scope creates, owns and updates. */
export function managedPiBundleDir(): string {
  return path.join(scopeHomeDir(), "pi");
}

/** The in-repo template/seed project (`apps/scope-desktop/pi-bundle`). A dev
 *  checkout that was installed before the managed copy existed has its
 *  `node_modules` here; the launcher's installer migrates it. */
export function repoPiBundleDir(): string {
  return path.join(PROJECT_ROOT, "apps", "scope-desktop", "pi-bundle");
}

/** Candidate bundle directories, most specific first (see the header). */
export function piBundleDirs(): string[] {
  const out: string[] = [];
  const configured = (process.env.SCOPE_PI_BUNDLE_DIR || "").trim();
  if (configured) out.push(configured);
  out.push(managedPiBundleDir(), repoPiBundleDir());
  return [...new Set(out)];
}

/** Path to the bundled package dir inside a bundle root. */
export function piPackageDirIn(bundleDir: string): string {
  return path.join(bundleDir, "node_modules", ...PI_PACKAGE.split("/"));
}

/** Path to the pi CLI entry inside a bundle root (what the shim launches). */
export function piCliPathIn(bundleDir: string): string {
  return path.join(piPackageDirIn(bundleDir), "dist", "bundle", "cli.js");
}

/** The pi CLI entry inside `bundleDir`, or null if that isn't a usable bundle. */
export function piCliIn(bundleDir: string | undefined): string | null {
  if (!bundleDir) return null;
  const cli = piCliPathIn(bundleDir);
  try {
    return fs.statSync(cli).isFile() ? cli : null;
  } catch {
    return null;
  }
}

/** The package's library entry (`dist/index.js`) — what the Auth runtime and the
 *  model catalogue import — or null when it isn't installed. */
export function piEntryIn(bundleDir: string | undefined): string | null {
  if (!bundleDir) return null;
  const entry = path.join(piPackageDirIn(bundleDir), "dist", "index.js");
  try {
    return fs.statSync(entry).isFile() ? entry : null;
  } catch {
    return null;
  }
}

/**
 * The bundle root Pi Scope ships, independent of how `pi` is launched.
 *
 * `PI_BUNDLE.dir` (pi-bundle.ts) is null when an operator override or a global
 * install wins the launcher resolution — but features that operate on the
 * bundled agent itself (Settings → Update / Authentication) still need to find
 * it. This checks the same candidate dirs for the package's `package.json` and
 * returns the first hit, or null when no bundle is present.
 */
export function resolvePiBundleRoot(): string | null {
  for (const dir of piBundleDirs()) {
    try {
      if (fs.statSync(path.join(piPackageDirIn(dir), "package.json")).isFile()) return dir;
    } catch { /* try next */ }
  }
  return null;
}
