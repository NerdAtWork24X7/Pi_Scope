// Where the installed pi bundle is, for the suites that need the real agent.
//
// The bundle is no longer part of the checkout: Pi Scope installs it into the
// user's data dir (`~/.pi-scope/pi`) — the launcher, the one-line installers and
// the packaged app all seed it there (apps/scope-desktop/pi-bundle-install.mjs).
// These helpers ask the server's own resolution rules (pi-bundle-paths.ts), so a
// test never hardcodes a path that can move again, and a checkout that still has
// the old in-repo install keeps working.
//
//   node --test apps/scope-server/test/pi-bundle-*.test.mjs
import { piBundleDirs, piCliIn, piEntryIn } from "../pi-bundle-paths.ts";

/** The candidate dirs the server itself tries, most specific first. */
export { piBundleDirs };

/** Bundle root the server would use here (SCOPE_PI_BUNDLE_DIR override → the
 *  managed `~/.pi-scope/pi` → an older checkout's `apps/scope-desktop/pi-bundle`),
 *  or null when no bundle is installed. */
export const PI_BUNDLE_ROOT = piBundleDirs().find((dir) => piCliIn(dir)) ?? null;

/** The pi CLI entry inside that bundle (what the shim launches). */
export const PI_BUNDLE_CLI = PI_BUNDLE_ROOT ? piCliIn(PI_BUNDLE_ROOT) : null;

/** The package's library entry (`dist/index.js`) — what the auth runtime and the
 *  model catalogue import. */
export const PI_BUNDLE_ENTRY = PI_BUNDLE_ROOT ? piEntryIn(PI_BUNDLE_ROOT) : null;

/** True when a usable bundle is installed; suites skip themselves when not. */
export const PI_BUNDLE_PRESENT = Boolean(PI_BUNDLE_ROOT && PI_BUNDLE_CLI && PI_BUNDLE_ENTRY);
