/**
 * provider-env.ts — expose shell-rc provider API keys to the server process.
 *
 * Pi Scope is often launched from a GUI/desktop session that never sources the
 * user's shell rc, so an API key exported only there (CEREBRAS_API_KEY,
 * GEMINI_API_KEY, …) is invisible to the server. A terminal `pi` sees those
 * keys and lists the providers they authenticate; the server does not, which
 * made the Settings cost table disagree with `/modelcost`:
 *
 *   • the model-catalog refresh (`pi update --models`, model-catalog.ts) only
 *     persists a provider whose credential it can resolve — a stored `auth.json`
 *     credential or an environment key — so env-only providers were never
 *     cached in models-store.json;
 *   • the runtime read that fills the cost table (pi-auth.ts) resolves provider
 *     auth from `process.env` too, so it skipped them as well.
 *
 * This seeds `process.env` once at boot with the provider keys found in the
 * shell rc, never overwriting a value the process already has. Everything
 * downstream then sees the same credentials a terminal pi would: the catalog
 * refresh child, the bundled runtime's auth resolution, and the chat
 * subprocesses (which inherit the server env).
 *
 * The list is the set of `envApiKeyAuth` environment variables in the bundled
 * pi-ai provider definitions. A provider pi adds later simply isn't seeded until
 * this list grows — the same behaviour as before this module, never worse.
 */

import { readShellEnvMap } from "../../shared/shell.ts";

/** Environment variables pi-ai's built-in providers read for API-key auth. */
const PROVIDER_ENV_VARS: readonly string[] = [
  "AI_GATEWAY_API_KEY",
  "ANT_LING_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "BASETEN_API_KEY",
  "CEREBRAS_API_KEY",
  "COPILOT_GITHUB_TOKEN",
  "DEEPSEEK_API_KEY",
  "FIREWORKS_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "HF_TOKEN",
  "KIMI_API_KEY",
  "META_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "MISTRAL_API_KEY",
  "MOONSHOT_API_KEY",
  "NVIDIA_API_KEY",
  "OPENAI_API_KEY",
  "OPENCODE_API_KEY",
  "OPENROUTER_API_KEY",
  "QWEN_TOKEN_PLAN_API_KEY",
  "QWEN_TOKEN_PLAN_CN_API_KEY",
  "RADIUS_API_KEY",
  "TOGETHER_API_KEY",
  "TYPESAFE_API_KEY",
  "XAI_API_KEY",
  "XIAOMI_API_KEY",
  "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  "ZAI_API_KEY",
  "ZAI_CODING_CN_API_KEY",
];

let seeded = false;

/**
 * Seed `process.env` with provider API keys found in the user's shell rc files
 * (a key already present in the environment always wins). Idempotent; returns
 * the variable names it filled in, so callers/tests can report what changed.
 */
export function seedProviderEnvFromShell(): string[] {
  if (seeded) return [];
  seeded = true;
  let shell: Record<string, string>;
  try {
    shell = readShellEnvMap();
  } catch {
    return []; // unreadable rc files: nothing to seed
  }
  const names: string[] = [];
  for (const name of PROVIDER_ENV_VARS) {
    if ((process.env[name] || "").trim()) continue;
    const value = (shell[name] || "").trim();
    if (!value) continue;
    process.env[name] = value;
    names.push(name);
  }
  if (names.length) {
    console.log(`  Provider keys: seeded ${names.length} from the shell rc (${names.join(", ")})`);
  }
  return names;
}
