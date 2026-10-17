/**
 * register-bundle.mjs — resolve the test suite's bare ESM imports (Playwright)
 * out of the shared install in `~/.pi-scope/pi`, since a checkout keeps no
 * `node_modules` of its own.
 *
 * The server loads its runtime packages through `pi-deps.ts`, but the e2e tests
 * (and test/harness.mjs) import `playwright` as an ordinary bare specifier, and
 * Node's ESM resolver does not consult NODE_PATH. Wire this in with `--import`:
 *
 *   node --import ./test/register-bundle.mjs --test test/*.test.mjs
 *
 * The hook itself lives in bundle-hooks.mjs and is registered through the
 * asynchronous, ESM-only `register()` API — see that file for why.
 */
import { register } from "node:module";

register("./bundle-hooks.mjs", import.meta.url);
