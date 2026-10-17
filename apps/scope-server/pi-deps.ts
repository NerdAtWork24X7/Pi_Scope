/**
 * pi-deps.ts — the npm packages the server itself needs.
 *
 * Pi Scope ships exactly one npm install of runtime packages: the bundled pi
 * project in the user's data dir (`~/.pi-scope/pi`, see pi-bundle-paths.ts).
 * `node-pty` (the Terminal's PTY) and `ws` (the server's WebSocket layer) are
 * dependencies of that project, so the server loads them from there instead of
 * keeping a second copy: a checkout never compiles its own native node-pty, the
 * desktop app's package.json has no duplicate, and the packaged app carries one
 * copy inside the `resources/pi` seed it installs as `~/.pi-scope/pi`.
 *
 * Resolution order (first hit wins):
 *   1. the candidate bundle dirs — `SCOPE_PI_BUNDLE_DIR` override →
 *      `~/.pi-scope/pi` → an old checkout's `apps/scope-desktop/pi-bundle` — so
 *      Settings → Update (which replaces that project) also updates these;
 *   2. this module's own resolution. Only a checkout that still has a stale
 *      `node_modules` with the packages hits this; a fresh one does not, which
 *      is the point of moving them into the bundle.
 *
 * Both packages are CommonJS, so `require` (through createRequire) loads them
 * synchronously and without top-level `await` in the modules that import them.
 * A missing copy is reported with the install that is supposed to provide it
 * rather than a bare `MODULE_NOT_FOUND`.
 */
import { createRequire } from "node:module";
import { piBundleDirs } from "./pi-bundle-paths.ts";

const requireFromHere = createRequire(import.meta.url);

/**
 * Absolute path of `spec`'s entry file, resolved out of the bundled pi install.
 *
 * Throws — naming the bundle installer — when no candidate provides the package,
 * because that means the app was started without the bundle being seeded.
 */
export function resolvePiDep(spec: string): string {
  for (const dir of piBundleDirs()) {
    try {
      return requireFromHere.resolve(spec, { paths: [dir] });
    } catch { /* not in this bundle — try the next candidate */ }
  }
  try {
    return requireFromHere.resolve(spec);
  } catch { /* no stale checkout copy either */ }
  throw new Error(
    `Pi Scope could not load '${spec}': it is installed with the bundled pi agent in ` +
    `~/.pi-scope/pi, but that bundle is not installed. Run ` +
    `apps/scope-desktop/pi-bundle-install.mjs (or start the app normally) to install it.`,
  );
}

/**
 * Load `spec` from the bundled pi install. Typed at the call site with the
 * package's own types, e.g. `loadPiDep<typeof import("ws")>("ws")`.
 */
export function loadPiDep<T = any>(spec: string): T {
  return requireFromHere(resolvePiDep(spec)) as T;
}
