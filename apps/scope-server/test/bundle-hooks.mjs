/**
 * bundle-hooks.mjs — the ESM resolve hook behind register-bundle.mjs.
 *
 * Kept separate because `module.register()` (the asynchronous, ESM-only hook
 * API) requires a module specifier for the hooks. ESM-only matters: the
 * synchronous `module.registerHooks()` also intercepts CommonJS `require`, so
 * resolving the bundle with `createRequire(...).resolve()` would re-enter the
 * hook and recurse forever. Here the hook sees `import` only — the server's CJS
 * loads (pi-deps.ts) stay untouched.
 *
 * Fallback resolution re-anchors the specifier at a file inside the bundle and
 * lets Node's *own* ESM resolver run again, so export conditions (`import` vs
 * `require`) and `exports` maps are honoured — resolving straight to a package
 * file would pick Playwright's CJS `index.js` and lose its named exports.
 *
 * Bundle roots match pi-bundle-paths.ts: SCOPE_PI_BUNDLE_DIR, then the managed
 * `~/.pi-scope/pi`, then a legacy checkout copy.
 */
import { pathToFileURL, fileURLToPath } from "node:url";
import * as os from "node:os";
import * as path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const dirs = [];
const configured = (process.env.SCOPE_PI_BUNDLE_DIR || "").trim();
if (configured) dirs.push(configured);
dirs.push(path.join(os.homedir(), ".pi-scope", "pi"));
// HERE is apps/scope-server/test → repo/apps/scope-desktop/pi-bundle.
dirs.push(path.join(HERE, "..", "..", "scope-desktop", "pi-bundle"));

/** A file that need not exist: Node resolves a bare specifier by walking up from
 *  the parent's directory to the nearest `node_modules`, which is all we need. */
const anchors = dirs.map((dir) => pathToFileURL(path.join(dir, "__resolve__.mjs")).href);

const isBare = (specifier) =>
  !specifier.startsWith(".") && !specifier.startsWith("/") && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier);

export async function resolve(specifier, context, nextResolve) {
  if (!isBare(specifier)) return nextResolve(specifier, context);
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    for (const parentURL of anchors) {
      try {
        return await nextResolve(specifier, { ...context, parentURL });
      } catch { /* not in this bundle — try the next */ }
    }
    throw err;
  }
}
