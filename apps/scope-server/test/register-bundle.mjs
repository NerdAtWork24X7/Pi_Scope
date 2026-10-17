/**
 * register-bundle.mjs — resolve the test suite's bare ESM imports (Playwright)
 * out of the install that holds them — the app bundle in `~/.pi-scope/pi` or the
 * agent dir's own npm project in `~/.pi-scope/agent/pi` — since a checkout keeps
 * no `node_modules` of its own.
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
