/**
 * agent-dir.ts — Pi Scope's own pi agent dir.
 *
 * Pi Scope ships and launches its own copy of the pi coding agent (see
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
export function resolveAgentDir(): string {
  const configured = (process.env.SCOPE_AGENT_DIR || "").trim();
  if (configured) return configured;
  return path.join(os.homedir(), ".pi-scope", "agent");
}

export const AGENT_DIR: string = resolveAgentDir();

try {
  fs.mkdirSync(AGENT_DIR, { recursive: true });
} catch { /* read-only runtime dir — pi will recreate it / fail loudly */ }

// Make the isolation authoritative for this process and everything it spawns.
// Setting it here (at import time) covers chatChildEnv's `{...process.env}`,
// the bundled `pi` shim's `env` invocation, and the in-app Terminal.
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
