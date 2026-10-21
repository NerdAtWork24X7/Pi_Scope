/**
 * workflow-harness-settings.ts — the harness settings the Workflow feature owns,
 * read for the Chat view.
 *
 * Settings → Plugins → Workflow already lets a user re-point a built-in
 * harness's binary and define their own (`userHarnesses`). Those choices live in
 * that plugin's own store (`<plugins dir>/.data/subagent-workflow.json`), not in
 * pi's settings.json and not in Chat's state. Chat reads the same file so a CLI
 * only has to be described once: a custom harness added on the Workflow page
 * shows up in the Chat picker, and a binary re-pointed there is the one Chat
 * launches.
 *
 * Read-only, on purpose — the Workflow plugin remains the only writer. The file
 * is small and its store flushes synchronously (`plugins.ts` `makeStoreAt`), so
 * this re-reads it on each call instead of carrying a second cache that could
 * disagree with the page the user just saved. `SCOPE_WORKFLOW_STORE` points the
 * reader at another file (tests, or an operator with a relocated store).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EMPTY_HARNESS_SETTINGS, normaliseHarnessSettings, type HarnessSettings } from "./harnesses.ts";

/** The Workflow plugin's store file, matching `storeFor("subagent-workflow")`. */
export function workflowHarnessStorePath(): string {
  const override = String(process.env.SCOPE_WORKFLOW_STORE || "").trim();
  if (override) return override;
  const pluginsDir = String(process.env.SCOPE_PLUGINS_DIR || "").trim()
    || path.join(os.homedir(), ".pi-scope", "plugins");
  return path.join(path.resolve(pluginsDir), ".data", "subagent-workflow.json");
}

/**
 * The binary overrides and custom harnesses defined on the Workflow settings
 * page, in the shape the harness catalog uses. A missing or unreadable store is
 * simply "no customisations", never an error the Chat page has to show.
 */
export function workflowHarnessSettings(): HarnessSettings {
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(workflowHarnessStorePath(), "utf8"));
  } catch {
    return EMPTY_HARNESS_SETTINGS;
  }
  if (!raw || typeof raw !== "object") return EMPTY_HARNESS_SETTINGS;
  return normaliseHarnessSettings({ bins: raw.harnessBins, userHarnesses: raw.userHarnesses });
}
