/**
 * agent-dir.ts — Pi Scope's own pi agent dir.
 *
 * Pi Scope installs and launches its own copy of the pi coding agent (see
 * pi-bundle.ts). That agent must NOT share the user's global pi agent dir:
 * if it did, pi would discover the global `settings.json` (and any extensions
 * listed there) alongside the Pi Scope extension Pi Scope force-loads, and the
 * two registrations collide — pi reports `Flag "--obs-server-url" conflicts
 * with …` and exits before the first prompt. It would also mean Pi Scope
 * mutates the user's global pi config (settings.json, api-keys.json, model
 * store), which is exactly the interference we want to avoid.
 *
 * So Pi Scope keeps its own agent dir. Everything the bundled agent needs —
 * settings.json, api-keys.json, models-store.json, auth.json, sessions,
 * skills, extensions — lives here, managed by Pi Scope's own Settings UI. The
 * user's global pi install is never read or written.
 *
 * Location (override with SCOPE_AGENT_DIR):
 *   • dev + packaged: ~/.pi-scope/agent
 * The bundled agent itself lives beside it in ~/.pi-scope/pi (pi-bundle-paths.ts);
 * the extensions' own npm dependencies live inside it, in <agentDir>/pi. The
 * shared Python venv and the Playwright browser builds sit beside it too
 * (~/.pi-scope/.venv, ~/.pi-scope/playwright-browsers).
 *
 * Importing this module creates the dir and pins `PI_CODING_AGENT_DIR` to it,
 * so every pi process Pi Scope spawns — Chat subprocesses, the commit-message
 * generator, and any `pi` typed into the in-app Terminal (which inherits the
 * server's environment) — lands on Pi Scope's agent dir. The pin also overrides
 * an inherited global `PI_CODING_AGENT_DIR`, so isolation holds even when the
 * launcher was started from a shell that had one exported.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Pi Scope's own pi agent dir. `SCOPE_AGENT_DIR` is the explicit override
 *  (used by the e2e tests, which point it at a temp dir). */
function resolveAgentDir(): string {
  const configured = (process.env.SCOPE_AGENT_DIR || "").trim();
  if (configured) return configured;
  return path.join(os.homedir(), ".pi-scope", "agent");
}

export const AGENT_DIR: string = resolveAgentDir();

/** The agent dir's own npm project. The dependencies the extensions declare are
 *  installed here (`pi-extensions-install.mjs`), and extensions that resolve
 *  their packages at run time are pointed at it with `PI_BROWSER_MODULE_ROOT`. */
export const AGENT_PI_DIR: string = path.join(AGENT_DIR, "pi");

/** The shared Python venv Pi Scope builds for every Python-dependent element
 *  (the `web_fetch` extension, the `video-creator` skill, …): a sibling of the
 *  agent dir, built with uv by `pi-python-install.mjs`. Elements locate it
 *  through `SCOPE_PYTHON_VENV`. Override with `SCOPE_PYTHON_VENV`. */
export const SCOPE_VENV_DIR: string = (process.env.SCOPE_PYTHON_VENV || "").trim()
  || path.join(path.dirname(AGENT_DIR), ".venv");

/** Pi Scope's Playwright browsers dir: the Chromium/… builds `playwright
 *  install` drops. A sibling of the agent dir so the browser the shared Python
 *  venv installed is the one the `browser` extension launches. Override with the
 *  standard `PLAYWRIGHT_BROWSERS_PATH` (an inherited value wins). */
export const SCOPE_BROWSERS_DIR: string = (process.env.PLAYWRIGHT_BROWSERS_PATH || "").trim()
  || path.join(path.dirname(AGENT_DIR), "playwright-browsers");

/** True when `dir` holds an installed Playwright browser build (a subdirectory
 *  named like chromium-<build>, firefox-<build>, webkit-<build>,
 *  headless_shell-<build>, or chromium_headless_shell-<build>). Used so
 *  `SCOPE_BROWSERS_DIR` is only adopted once it will actually work — an
 *  unfinished (or failed) install must never hide a browser the user already has
 *  in their shell rc / Playwright's default cache. */
export function holdsPlaywrightBrowser(dir: string = SCOPE_BROWSERS_DIR): boolean {
  try {
    return fs.readdirSync(dir).some((name) =>
      /^(chromium|firefox|webkit|headless_shell|chromium_headless_shell)-/.test(name)
    );
  } catch {
    return false;
  }
}

try {
  fs.mkdirSync(AGENT_DIR, { recursive: true });
} catch { /* read-only runtime dir — pi will recreate it / fail loudly */ }

// Make the isolation authoritative for this process and everything it spawns.
// Setting it here (at import time) covers chatChildEnv's `{...process.env}`,
// the bundled `pi` shim's `env` invocation, and the in-app Terminal.
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;

// Name the shared Python venv for everything spawned from here too, so an
// element reads the resolved path instead of guessing the default.
process.env.SCOPE_PYTHON_VENV = SCOPE_VENV_DIR;

// Advertise Pi Scope's Playwright browsers dir once it actually holds a build,
// so the `browser` extension and the Python elements share one Chromium — but
// leave the variable unset until then, so an incomplete install can't override a
// browser the user already has elsewhere.
if (holdsPlaywrightBrowser()) process.env.PLAYWRIGHT_BROWSERS_PATH = SCOPE_BROWSERS_DIR;
