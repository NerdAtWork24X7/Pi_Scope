/**
 * Custom File Tools — standalone extension providing `custom_read`,
 * `custom_write`, and `custom_edit`.
 *
 * Kept independent of the agent-team extension on purpose: subagents are
 * spawned with `--no-extensions` and only the non-agent-team extension paths
 * (see agent-team/extensions.ts#scanExtensionPaths), so these generic file
 * tools must live outside agent-team/ to be available to subagents whose
 * tool allowlists reference them.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerCustomReadTool, registerCustomWriteTool, registerCustomEditTool } from "./custom_tools";

export default function (pi: ExtensionAPI) {
	registerCustomReadTool(pi);
	registerCustomWriteTool(pi);
	registerCustomEditTool(pi);
}