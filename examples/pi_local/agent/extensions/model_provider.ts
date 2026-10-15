/**
 * Model Provider Extension — TokenHarbor + Kilo + /modelcost
 *
 * One extension file that registers both dynamic model providers and the
 * `/modelcost` model-cost selector:
 *
 *  • TokenHarbor (https://tokenharbor.ai) — one OpenAI-compatible gateway
 *    (base URL https://tokenharbor.ai/v1) in front of many upstream vendors
 *    with transparent per-token pricing, semantic/exact caching, and a free
 *    tier on select `:free` model ids. The catalog is fetched live from the
 *    OpenAI-compatible /v1/models endpoint at extension load, disk-cached, and
 *    re-fetched on session_start and via /tokenharbor. The catalog endpoint
 *    requires the API key (anonymous requests get 401), so models register only
 *    once TOKENHARBOR_API_KEY (or an auth.json credential) is set.
 *
 *  • Kilo — 300+ AI models via the Kilo Gateway (OpenRouter-compatible), with
 *    device-code flow for browser-based authentication. Free models are
 *    registered unauthenticated; /login kilo (or KILO_API_KEY=...) upgrades to
 *    the full catalog.
 *
 *  • /modelcost — a TUI selector over every model in the registry showing its
 *    input/output price ($/M) and context window, with fuzzy search, provider
 *    paging (←→, including a Free filter) and Ctrl+S to toggle the highlighted
 *    model in the session's enabledModels scope. This was its own
 *    `modelcost.ts` extension; it lives here now because it reads and writes
 *    exactly the same settings keys (`enabledModels`, `defaultProvider`,
 *    `defaultModel`) that the two providers below already load, so one file
 *    owns that contract instead of two.
 *
 * They live in one file because both providers are dynamic provider extensions
 * with the same shape — catalog fetch + disk cache + status-line display —
 * sharing the agent-team/model-cache helper. Subagent provider routing treats
 * this file as the provider extension for both "kilo" and "tokenharbor" (see
 * PROVIDER_EXTENSIONS in agent-team/extensions.ts).
 *
 * Usage:
 *   export TOKENHARBOR_API_KEY=thk_live_...   # from tokenharbor.ai/dashboard/api-keys
 *   # …or let pi store it: auth.json entry for "tokenharbor" ({ type: "api_key", key })
 *   /login kilo                               # device-code login for Kilo
 *   # …or set KILO_API_KEY=...
 *   pi
 *   # pick a model with /model or /modelcost (auto-scoped), refresh TokenHarbor via:
 *   /tokenharbor                              # re-fetch the catalog + show status
 */

import type {
  Api,
  Model,
  OAuthCredentials,
  OAuthLoginCallbacks,
} from "@mariozechner/pi-ai";
import {
  DynamicBorder,
  getAgentDir,
  keyHint,
  type ExtensionAPI,
  type ProviderModelConfig,
  type Theme,
} from "@mariozechner/pi-coding-agent";
import {
  Container,
  fuzzyFilter,
  getKeybindings,
  Input,
  Key,
  matchesKey,
  Spacer,
  Text,
  type Component,
  type TUI,
} from "@mariozechner/pi-tui";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCachedModels } from "./agent-team/model-cache";

// =============================================================================
// Shared — provider model shape
// =============================================================================

/** In current pi releases `ProviderModelConfig` is a chat | image | classifier
 *  union, and only the chat member carries `reasoning` / `contextWindow` /
 *  `maxTokens` / `compat` — so reading those off the bare union (or indexing it
 *  with `["compat"]`) does not typecheck. Every model this file registers is a
 *  chat model, so the chat member is what all of the mapping code below means.
 *  `ProviderChatModelConfig` is not re-exported from the package root, so the
 *  member is derived structurally; on older pi releases, where
 *  `ProviderModelConfig` is already the single chat-shaped interface, the
 *  extraction matches nothing and the whole type is used instead. */
type ProviderChatConfig = Extract<ProviderModelConfig, { type?: "chat" }>;
type ChatModelConfig = [ProviderChatConfig] extends [never]
  ? ProviderModelConfig
  : ProviderChatConfig;

// =============================================================================
// Shared — settings.json helpers (defaults, enabledModels scope)
// =============================================================================
//
// One read-modify-write path for the settings file the providers boot from and
// the /modelcost selector mutates: `enabledModels` (the session scope) plus
// `defaultProvider`/`defaultModel` (what the next session starts on).

const SETTINGS_PATH = join(getAgentDir(), "settings.json");

function readSettings(): Record<string, unknown> {
  try {
    if (existsSync(SETTINGS_PATH)) {
      return JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
    }
  } catch {
    /* fall through to empty */
  }
  return {};
}

function writeSettings(settings: Record<string, unknown>): void {
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}

function getEnabledModels(): string[] {
  const list = readSettings().enabledModels;
  return Array.isArray(list) ? (list as string[]) : [];
}

function setEnabledModels(list: string[]): void {
  const settings = readSettings();
  if (list.length === 0) delete settings.enabledModels;
  else settings.enabledModels = list;
  writeSettings(settings);
}

// =============================================================================
// TokenHarbor — Constants
// =============================================================================

const TOKENHARBOR_BASE_URL = (
  process.env.TOKENHARBOR_BASE_URL ?? "https://tokenharbor.ai/v1"
).replace(/\/+$/, "");
const TOKENHARBOR_TOS_URL = "https://tokenharbor.ai/terms";
const FETCH_TIMEOUT_MS = 10_000;
// Versioned because the disk cache stores the *mapped* ChatModelConfig[]
// (reasoning/cost/compat already applied), not the raw catalog: a mapping
// change must not be shadowed by a still-fresh 12h-old entry. Bump on any
// change to mapTokenHarborModel.
const TOKENHARBOR_CACHE_KEY = "tokenharbor-models-v2";

// =============================================================================
// TokenHarbor — API key resolution
// =============================================================================

/**
 * Key resolution order: TOKENHARBOR_API_KEY env → the tokenharbor credential
 * in pi's auth.json (getAgentDir()/auth.json — the git-ignored store pi itself
 * writes, format { type: "api_key", key } or OAuth-shaped { access }).
 */
function readAuthJsonKey(): string {
  try {
    const authPath = join(getAgentDir(), "auth.json");
    if (!existsSync(authPath)) return "";
    const data = JSON.parse(readFileSync(authPath, "utf8")) as Record<
      string,
      any
    >;
    const cred = data?.["tokenharbor"];
    if (!cred) return "";
    return typeof cred.key === "string"
      ? cred.key
      : typeof cred.access === "string"
        ? cred.access
        : "";
  } catch {
    return "";
  }
}

function resolveApiKey(): string {
  return process.env.TOKENHARBOR_API_KEY || readAuthJsonKey();
}

// =============================================================================
// TokenHarbor — Models API (OpenAI-compatible /v1/models + pricing fields)
// =============================================================================

/**
 * TokenHarbor pricing is USD per million tokens, matching pi's `cost` unit.
 * The live /v1/models catalog returns `input_usd_per_1m` / `output_usd_per_1m`
 * (numbers, 0 on `:free` ids); the OpenRouter-shaped `prompt`/`completion`/
 * `input_cache_*` keys are kept as fallbacks for shape changes. Price fields
 * are nullable when the catalog omits them — pi's cost is informational here
 * (the gateway bills upstream per-token usage), so omitted prices map to 0.
 *
 * The catalog carries no capability metadata: no `supported_parameters`, no
 * `architecture`, only `label`, `tier`, `blurb`, `tool_call`, and
 * `supports_prompt_cache`. Reasoning therefore cannot be detected from it.
 */
interface TokenHarborModel {
  id: string;
  label?: string;
  name?: string;
  blurb?: string;
  tier?: string;
  context_length?: number | null;
  max_completion_tokens?: number | null;
  max_output_tokens?: number | null;
  supports_prompt_cache?: boolean;
  tool_call?: boolean;
  function_call?: boolean;
  architecture?: {
    input_modalities?: string[] | null;
    output_modalities?: string[] | null;
  };
  supported_parameters?: string[];
  pricing?: {
    input_usd_per_1m?: string | number | null;
    output_usd_per_1m?: string | number | null;
    prompt?: string | number | null;
    completion?: string | number | null;
    input_cache_read?: string | number | null;
    input_cache_write?: string | number | null;
  };
}

/** TokenHarbor prices are already USD per million tokens. */
function parseTokenHarborPrice(
  price: string | number | null | undefined,
): number {
  if (price === null || price === undefined) return 0;
  const parsed = typeof price === "number" ? price : parseFloat(price);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapTokenHarborModel(m: TokenHarborModel): ChatModelConfig {
  const inputModalities = m.architecture?.input_modalities ?? ["text"];
  const supportsImages = inputModalities.includes("image");
  const contextWindow = m.context_length || 200_000;
  const maxTokens =
    m.max_completion_tokens ?? m.max_output_tokens ?? Math.min(65_536, contextWindow);
  const pricing = m.pricing ?? {};

  return {
    id: m.id,
    name: m.label ?? m.name ?? m.id,
    // Every model the gateway exposes is reasoning-capable, but the catalog
    // does not say so: it omits `supported_parameters` (and `architecture`),
    // so capability probing returns nothing and pi would offer no thinking
    // levels at all. TokenHarbor's own pi adapter marks every catalog entry
    // `reasoning: true`; the gateway accepts (and translates) the resulting
    // `reasoning_effort` for each upstream. With no `thinkingLevelMap`, pi
    // exposes off/minimal/low/medium/high and sends the level verbatim.
    reasoning: true,
    // Pi would otherwise send the OpenAI `developer` role for reasoning
    // models. This gateway fronts many vendors and also speaks the Anthropic
    // Messages shape (which has no `developer` role), so the universally
    // accepted `system` role is the safe hop.
    compat: { supportsDeveloperRole: false },
    input: supportsImages ? ["text", "image"] : ["text"],
    cost: {
      input: parseTokenHarborPrice(pricing.input_usd_per_1m ?? pricing.prompt),
      output: parseTokenHarborPrice(pricing.output_usd_per_1m ?? pricing.completion),
      cacheRead: parseTokenHarborPrice(pricing.input_cache_read),
      cacheWrite: parseTokenHarborPrice(pricing.input_cache_write),
    },
    contextWindow,
    maxTokens,
  };
}

async function fetchTokenHarborModels(
  token: string,
): Promise<ChatModelConfig[]> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "pi-tokenharbor-provider",
    Authorization: `Bearer ${token}`,
  };

  const response = await fetch(`${TOKENHARBOR_BASE_URL}/models`, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(
        "Unauthorized (401): the TokenHarbor catalog requires a valid API key — set TOKENHARBOR_API_KEY to your thk_live_… key from tokenharbor.ai/dashboard/api-keys",
      );
    }
    throw new Error(
      `GET ${TOKENHARBOR_BASE_URL}/models failed: HTTP ${response.status} ${response.statusText}`,
    );
  }

  const json = (await response.json()) as { data?: TokenHarborModel[] };
  if (!json.data || !Array.isArray(json.data)) {
    throw new Error("Invalid /v1/models response: missing data array");
  }

  return json.data
    .filter((m) => {
      // Skip image generation models
      const outputMods = m.architecture?.output_modalities ?? [];
      if (outputMods.includes("image")) return false;
      return true;
    })
    .map(mapTokenHarborModel);
}

// =============================================================================
// TokenHarbor — Provider config
// =============================================================================

function makeTokenHarborConfig(
  models: ChatModelConfig[],
): Record<string, unknown> {
  return {
    name: "Token Harbor",
    baseUrl: TOKENHARBOR_BASE_URL,
    // Resolved literal key keeps the provider "configured" in pi's model
    // registry (same approach as the omni-router extension). The catalog
    // fetch and chat requests share this key.
    apiKey: resolveApiKey() || "thk_unconfigured",
    api: "openai-completions" as const,
    models,
  };
}

// =============================================================================
// TokenHarbor — Extension wiring
// =============================================================================

async function registerTokenHarborProvider(pi: ExtensionAPI): Promise<void> {
  // Register immediately with the disk-cached catalog (if present) so the
  // provider is usable before any network round-trip; the session_start hook
  // refreshes it. Cached to disk: the agent-team extension loads this file
  // into every spawned subagent, so a warm cache avoids a network fetch per
  // subagent boot. The catalog endpoint requires the API key (anonymous
  // requests get 401), so without one there is nothing to fetch — the
  // session_start hook surfaces a hint instead.
  const token = resolveApiKey();

  let models: ChatModelConfig[] = [];
  if (token) {
    try {
      models = await loadCachedModels(TOKENHARBOR_CACHE_KEY, () =>
        fetchTokenHarborModels(token),
      );
    } catch (error) {
      console.warn(
        "[tokenharbor] Failed to load models at startup:",
        error instanceof Error ? error.message : error,
      );
    }
  } else {
    console.warn(
      "[tokenharbor] No API key found. Set TOKENHARBOR_API_KEY (thk_live_… from tokenharbor.ai/dashboard/api-keys) or add a tokenharbor entry to auth.json to load the model catalog.",
    );
  }

  pi.registerProvider("tokenharbor", makeTokenHarborConfig(models));

  // Refresh the catalog when a session starts (models and prices change; the
  // free tier requires no key, so the refresh runs even when unconfigured).
  pi.on("session_start", async (_event, ctx) => {
    const token = resolveApiKey();
    const theme = ctx.ui.theme;

    if (!token) {
      ctx.ui.setStatus(
        "tokenharbor",
        theme.fg("muted", "⚓ set TOKENHARBOR_API_KEY"),
      );
      return;
    }

    try {
      const fetched = await loadCachedModels(TOKENHARBOR_CACHE_KEY, () =>
        fetchTokenHarborModels(token),
      );
      models = fetched;
      pi.registerProvider("tokenharbor", makeTokenHarborConfig(fetched));
      ctx.ui.setStatus(
        "tokenharbor",
        theme.fg("accent", `⚓ ${fetched.length} models`),
      );
    } catch (error) {
      ctx.ui.setStatus(
        "tokenharbor",
        theme.fg("error", "⚓ TokenHarbor unreachable"),
      );
      console.warn(
        "[tokenharbor] Failed to refresh models at session start:",
        error instanceof Error ? error.message : error,
      );
    }
  });

  // Refresh the catalog + show status on demand.
  pi.registerCommand("tokenharbor", {
    description:
      "Refresh the TokenHarbor model catalog and show provider status",
    handler: async (_args, ctx) => {
      const token = resolveApiKey();
      if (!token) {
        ctx.ui.notify(
          "No TokenHarbor API key. Set TOKENHARBOR_API_KEY (thk_live_… from tokenharbor.ai/dashboard/api-keys) or add a tokenharbor entry to auth.json.",
          "warning",
        );
        return;
      }
      try {
        const fetched = await loadCachedModels(
          TOKENHARBOR_CACHE_KEY,
          () => fetchTokenHarborModels(token),
          // Commands are explicit user actions — always hit the network so a
          // manual refresh isn't silently served from a 12h-old cache.
          { ttlMs: 0 },
        );
        models = fetched;
        pi.registerProvider("tokenharbor", makeTokenHarborConfig(fetched));
        ctx.ui.notify(
          `TokenHarbor: ${fetched.length} models registered from ${TOKENHARBOR_BASE_URL}.`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          `TokenHarbor unreachable at ${TOKENHARBOR_BASE_URL}: ${
            error instanceof Error ? error.message : error
          }`,
          "error",
        );
      }
    },
  });

  // On first use of a TokenHarbor model without a configured key, print the
  // ToS notice (the free tier is a real upstream service).
  let tosShown = false;

  pi.on("before_agent_start", async (_event, ctx) => {
    if (tosShown) return;
    if (ctx.model?.provider !== "tokenharbor") return;

    tosShown = true;

    if (resolveApiKey()) return;

    return {
      message: {
        customType: "tokenharbor",
        content: `By using TokenHarbor, you agree to the Terms of Service: ${TOKENHARBOR_TOS_URL}`,
        display: true,
      },
    };
  });
}

// =============================================================================
// Kilo — Constants
// =============================================================================

const KILO_API_BASE = process.env.KILO_API_URL || "https://api.kilo.ai";
const KILO_GATEWAY_BASE = `${KILO_API_BASE}/api/gateway`;
const KILO_DEVICE_AUTH_ENDPOINT = `${KILO_API_BASE}/api/device-auth/codes`;
const POLL_INTERVAL_MS = 3000;
const MODELS_FETCH_TIMEOUT_MS = 10_000;
const TOKEN_EXPIRATION_MS = 365 * 24 * 60 * 60 * 1000; // 1 year
const KILO_TOS_URL = "https://kilo.ai/terms";
const KILO_PROFILE_ENDPOINT = `${KILO_API_BASE}/api/profile`;

// =============================================================================
// Kilo — Balance Fetching
// =============================================================================

interface KiloBalance {
  balance?: number;
}

async function fetchKiloBalance(token: string): Promise<number | null> {
  try {
    const response = await fetch(`${KILO_PROFILE_ENDPOINT}/balance`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as KiloBalance;
    return data.balance ?? null;
  } catch {
    return null;
  }
}

function formatCredits(balance: number): string {
  if (balance >= 1000) {
    return `$${(balance / 1000).toFixed(1)}k`;
  } else {
    return `$${balance.toFixed(2)}`;
  }
}

// =============================================================================
// Kilo — Device Authorization Flow
// =============================================================================

interface DeviceAuthResponse {
  code: string;
  verificationUrl: string;
  expiresIn: number;
}

interface DeviceAuthPollResponse {
  status: "pending" | "approved" | "denied" | "expired";
  token?: string;
  userEmail?: string;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Login cancelled"));
      return;
    }
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new Error("Login cancelled"));
      },
      { once: true },
    );
  });
}

async function initiateDeviceAuth(): Promise<DeviceAuthResponse> {
  const response = await fetch(KILO_DEVICE_AUTH_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    if (response.status === 429) {
      throw new Error(
        "Too many pending authorization requests. Please try again later.",
      );
    }
    throw new Error(
      `Failed to initiate device authorization: ${response.status}`,
    );
  }

  return (await response.json()) as DeviceAuthResponse;
}

async function pollDeviceAuth(code: string): Promise<DeviceAuthPollResponse> {
  const response = await fetch(`${KILO_DEVICE_AUTH_ENDPOINT}/${code}`);

  if (response.status === 202) return { status: "pending" };
  if (response.status === 403) return { status: "denied" };
  if (response.status === 410) return { status: "expired" };

  if (!response.ok) {
    throw new Error(`Failed to poll device authorization: ${response.status}`);
  }

  return (await response.json()) as DeviceAuthPollResponse;
}

async function loginKilo(
  callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
  callbacks.onProgress?.("Initiating device authorization...");
  const authData = await initiateDeviceAuth();
  const { code, verificationUrl, expiresIn } = authData;

  callbacks.onAuth({
    url: verificationUrl,
    instructions: `Enter code: ${code}`,
  });

  callbacks.onProgress?.("Waiting for browser authorization...");

  const deadline = Date.now() + expiresIn * 1000;
  while (Date.now() < deadline) {
    if (callbacks.signal?.aborted) {
      throw new Error("Login cancelled");
    }

    await abortableSleep(POLL_INTERVAL_MS, callbacks.signal);

    const result = await pollDeviceAuth(code);

    if (result.status === "approved") {
      if (!result.token) {
        throw new Error("Authorization approved but no token received");
      }
      callbacks.onProgress?.("Login successful!");
      return {
        refresh: result.token,
        access: result.token,
        expires: Date.now() + TOKEN_EXPIRATION_MS,
      };
    }

    if (result.status === "denied") {
      throw new Error("Authorization denied by user.");
    }

    if (result.status === "expired") {
      throw new Error("Authorization code expired. Please try again.");
    }

    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    callbacks.onProgress?.(
      `Waiting for browser authorization... (${remaining}s remaining)`,
    );
  }

  throw new Error("Authentication timed out. Please try again.");
}

async function refreshKiloToken(
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  if (credentials.expires > Date.now()) {
    return credentials;
  }
  throw new Error(
    "Kilo token expired. Please run /login kilo to re-authenticate.",
  );
}

// =============================================================================
// Kilo — Dynamic Model Loading
// =============================================================================

interface OpenRouterModel {
  id: string;
  name: string;
  context_length: number;
  max_completion_tokens?: number | null;
  pricing?: {
    prompt?: string | null;
    completion?: string | null;
    input_cache_write?: string | null;
    input_cache_read?: string | null;
  };
  architecture?: {
    input_modalities?: string[] | null;
    output_modalities?: string[] | null;
  };
  top_provider?: { max_completion_tokens?: number | null };
  supported_parameters?: string[];
}

/** OpenRouter prices are per-token; pi expects per-million-token. */
function parseKiloPrice(price: string | null | undefined): number {
  if (!price) return 0;
  const parsed = parseFloat(price);
  if (isNaN(parsed)) return 0;
  return parsed * 1_000_000;
}

function isFreeModel(m: OpenRouterModel): boolean {
  const prompt = parseFloat(m.pricing?.prompt ?? "1");
  const completion = parseFloat(m.pricing?.completion ?? "1");
  if (prompt !== 0 || completion !== 0) return false;
  // Zero pricing alone isn't reliable (some models report "0" but require auth).
  // Use the :free suffix (OpenRouter convention), Kilo-native models (no vendor
  // prefix), or known Kilo/OpenRouter free routers.
  if (m.id === "kilo-auto/free") return true;
  if (m.id.includes(":free")) return true;
  if (!m.id.includes("/")) return true;
  if (m.id.startsWith("kilo/") || m.id.startsWith("openrouter/")) return true;
  return false;
}

type KiloReasoningLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

type KiloModelCompat = {
  cacheControlFormat?: "anthropic";
  requiresReasoningContentOnAssistantMessages?: boolean;
  reasoningEffortMap?: Partial<Record<KiloReasoningLevel, string>>;
};

function getKiloModelCompat(
  m: OpenRouterModel,
): ChatModelConfig["compat"] | undefined {
  const compat: KiloModelCompat = {};

  // Kilo's gateway is OpenRouter-compatible, but it uses api.kilo.ai so
  // pi-ai's URL/provider auto-detection cannot infer OpenRouter model quirks.
  if (m.id.startsWith("anthropic/")) {
    compat.cacheControlFormat = "anthropic";
  }

  if (m.id === "deepseek/deepseek-v4-flash" || m.id === "deepseek/deepseek-v4-pro") {
    compat.requiresReasoningContentOnAssistantMessages = true;
  }

  if (m.id === "deepseek/deepseek-v4-pro") {
    compat.reasoningEffortMap = { xhigh: "max" };
  }

  return Object.keys(compat).length > 0
    ? (compat as ChatModelConfig["compat"])
    : undefined;
}

function mapOpenRouterModel(m: OpenRouterModel): ChatModelConfig {
  const inputModalities = m.architecture?.input_modalities ?? ["text"];
  const supportsImages = inputModalities.includes("image");
  const supportsReasoning =
    m.supported_parameters?.includes("reasoning") ?? false;
  const maxTokens =
    m.top_provider?.max_completion_tokens ??
    m.max_completion_tokens ??
    Math.ceil(m.context_length * 0.2);

  return {
    id: m.id,
    name: m.name,
    reasoning: supportsReasoning,
    input: supportsImages ? ["text", "image"] : ["text"],
    cost: {
      input: parseKiloPrice(m.pricing?.prompt),
      output: parseKiloPrice(m.pricing?.completion),
      cacheRead: parseKiloPrice(m.pricing?.input_cache_read),
      cacheWrite: parseKiloPrice(m.pricing?.input_cache_write),
    },
    contextWindow: m.context_length,
    maxTokens: maxTokens,
    compat: getKiloModelCompat(m),
  };
}

async function fetchKiloModels(options?: {
  token?: string;
  freeOnly?: boolean;
}): Promise<ChatModelConfig[]> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "pi-kilo-provider",
  };
  if (options?.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  const response = await fetch(`${KILO_GATEWAY_BASE}/models`, {
    headers,
    signal: AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch models: ${response.status} ${response.statusText}`,
    );
  }

  const json = (await response.json()) as { data?: OpenRouterModel[] };
  if (!json.data || !Array.isArray(json.data)) {
    throw new Error("Invalid models response: missing data array");
  }

  return json.data
    .filter((m) => {
      // Skip image generation models
      const outputMods = m.architecture?.output_modalities ?? [];
      if (outputMods.includes("image")) return false;
      // When unauthenticated, only show free models
      if (options?.freeOnly && !isFreeModel(m)) return false;
      return true;
    })
    .map(mapOpenRouterModel);
}

// =============================================================================
// Kilo — Provider Config
// =============================================================================

const KILO_PROVIDER_CONFIG = {
  baseUrl: KILO_GATEWAY_BASE,
  apiKey: "$KILO_API_KEY",
  api: "openai-completions" as const,
  headers: {
    "X-KILOCODE-EDITORNAME": "Pi",
    "User-Agent": "pi-kilo-provider",
  },
};

// =============================================================================
// Kilo — Extension wiring
// =============================================================================

async function registerKiloProvider(pi: ExtensionAPI): Promise<void> {
  // Fetch free models at load time so the provider is immediately usable.
  // Cached to disk: the agent-team extension loads this file into every
  // spawned subagent, so a warm cache avoids a network fetch per subagent
  // boot (up to 10s timeout). The host process refreshes it here.
  let freeModels: ChatModelConfig[] = [];
  try {
    freeModels = await loadCachedModels("kilo-free-models", () =>
      fetchKiloModels({ freeOnly: true }),
    );
  } catch (error) {
    console.warn(
      "[kilo] Failed to fetch free models at startup:",
      error instanceof Error ? error.message : error,
    );
  }

  // Full model list cached after login or session_start (when already logged in).
  // Used by modifyModels to upgrade the free list without an async fetch.
  let cachedAllModels: ChatModelConfig[] = [];

  function makeOAuthConfig() {
    return {
      name: "Kilo",
      login: async (callbacks: OAuthLoginCallbacks) => {
        const cred = await loginKilo(callbacks);
        // Cache full models so modifyModels can use them during the
        // modelRegistry.refresh() that runs right after login returns.
        try {
          cachedAllModels = await fetchKiloModels({ token: cred.access });
        } catch (error) {
          console.warn(
            "[kilo] Failed to fetch models after login:",
            error instanceof Error ? error.message : error,
          );
        }
        return cred;
      },
      refreshToken: refreshKiloToken,
      getApiKey: (cred: OAuthCredentials) => cred.access,
      // Called by modelRegistry.refresh() when credentials exist.
      // After logout, credentials are removed so this won't be called,
      // leaving only the free models from config.models.
      modifyModels: (models: Model<Api>[], _cred: OAuthCredentials) => {
        if (cachedAllModels.length === 0) return models;
        // Use an existing kilo model as a template for provider metadata
        const template = models.find((m) => m.provider === "kilo");
        if (!template) return models;
        const nonKilo = models.filter((m) => m.provider !== "kilo");
        const fullModels = cachedAllModels.map((m) => ({
          ...template,
          id: m.id,
          name: m.name,
          reasoning: m.reasoning,
          input: m.input,
          cost: m.cost,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          compat: m.compat,
        }));
        return [...nonKilo, ...fullModels];
      },
    };
  }

  // Always register with free models. modifyModels upgrades to full list
  // when credentials exist, and naturally falls back after logout.
  pi.registerProvider("kilo", {
    ...KILO_PROVIDER_CONFIG,
    models: freeModels,
    oauth: makeOAuthConfig(),
  });

  // After session starts, pre-fetch all models if already logged in so
  // modifyModels has data to work with. Also fetch and display credits.
  pi.on("session_start", async (_event, ctx) => {
    const token = await ctx.modelRegistry.getApiKeyForProvider("kilo");

    // Clear credits if not logged in
    if (!token) {
      ctx.ui.setStatus("kilo-credits", undefined);
      return;
    }

    try {
      cachedAllModels = await loadCachedModels("kilo-models", () =>
        fetchKiloModels({ token }),
      );
    } catch (error) {
      console.warn(
        "[kilo] Failed to fetch models at session start:",
        error instanceof Error ? error.message : error,
      );
      return;
    }
    if (cachedAllModels.length > 0) {
      // Re-register to trigger modifyModels with the cached data.
      ctx.modelRegistry.registerProvider("kilo", {
        ...KILO_PROVIDER_CONFIG,
        models: freeModels,
        oauth: makeOAuthConfig(),
      });
    }

    // Fetch and display credits balance
    try {
      const balance = await fetchKiloBalance(token);
      if (balance !== null) {
        const theme = ctx.ui.theme;
        ctx.ui.setStatus(
          "kilo-credits",
          theme.fg("accent", `💰 ${formatCredits(balance)}`),
        );
      }
    } catch (error) {
      console.warn(
        "[kilo] Failed to fetch balance:",
        error instanceof Error ? error.message : error,
      );
    }
  });

  // Update credits display when model changes to a Kilo model
  pi.on("model_select", async (event, ctx) => {
    if (event.model?.provider !== "kilo") return;

    const token = await ctx.modelRegistry.getApiKeyForProvider("kilo");
    if (!token) return;

    try {
      const balance = await fetchKiloBalance(token);
      if (balance !== null) {
        const theme = ctx.ui.theme;
        ctx.ui.setStatus(
          "kilo-credits",
          theme.fg("accent", `💰 ${formatCredits(balance)}`),
        );
      }
    } catch (error) {
      console.warn(
        "[kilo] Failed to fetch balance on model select:",
        error instanceof Error ? error.message : error,
      );
    }
  });

  // Refresh credits after each turn
  pi.on("turn_end", async (_event, ctx) => {
    const token = await ctx.modelRegistry.getApiKeyForProvider("kilo");
    if (!token) return;

    try {
      const balance = await fetchKiloBalance(token);
      if (balance !== null) {
        const theme = ctx.ui.theme;
        ctx.ui.setStatus(
          "kilo-credits",
          theme.fg("accent", `💰 ${formatCredits(balance)}`),
        );
      }
    } catch (error) {
      console.warn(
        "[kilo] Failed to fetch balance on turn end:",
        error instanceof Error ? error.message : error,
      );
    }
  });

  // On first use of a Kilo model without login, print ToS notice.
  let tosShown = false;

  pi.on("before_agent_start", async (_event, ctx) => {
    if (tosShown) return;
    if (ctx.model?.provider !== "kilo") return;

    if (ctx.modelRegistry.getProviderAuthStatus("kilo")?.label === "oauth") {
      tosShown = true;
      return;
    }

    tosShown = true;

    return {
      message: {
        customType: "kilo",
        content: `By using Kilo, you agree to the Terms of Service: ${KILO_TOS_URL}`,
        display: true,
      },
    };
  });
}

// =============================================================================
// /modelcost — price + context-window model selector
// =============================================================================
//
// Registers the `/modelcost` slash command: a selector listing every model in
// the registry sorted by input+output price, with a live fuzzy filter, provider
// paging (←→, with a Free tier filter) and Ctrl+S to add/remove the highlighted
// model in the enabledModels scope. Host-side UI only — registering a command
// is inert in a spawned subagent, which is why this can ride along in the
// provider extension file.

function formatPrice(perMillion: number): string {
  if (perMillion === 0) return "free";
  if (perMillion < 0.01) return `$${perMillion.toFixed(4)}`;
  if (perMillion < 1) return `$${perMillion.toFixed(3)}`;
  if (perMillion < 100) return `$${perMillion.toFixed(2)}`;
  return `$${perMillion.toFixed(0)}`;
}

function formatContextWindow(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return `${n}`;
}

interface ModelCostSelectorOptions {
  tui: TUI;
  theme: Theme;
  models: Model<any>[];
  currentModel: Model<any> | undefined;
  scopedKeys?: Set<string>;
  initialSearch?: string;
  onSelect: (m: Model<any>) => void;
  onAddToScope?: (m: Model<any>) => boolean | null;
  onCancel: () => void;
}

class ModelCostSelector extends Container {
  readonly searchInput: Input;
  private listContainer: Container;
  private allModels: Model<any>[];
  private filteredModels: Model<any>[];
  private selectedIndex = 0;
  private currentModel: Model<any> | undefined;
  private theme: Theme;
  private tui: TUI;
  private onSelectCb: (m: Model<any>) => void;
  private onCancelCb: () => void;
  private selectedProviderIndex = -1;  // -1=All, -2=Free, 0..n=provider
  private providers: string[] = [];
  private providerText: Text;
  private onAddToScopeCb?: (m: Model<any>) => boolean | null;
  private scopedKeys: Set<string>;

  constructor(opts: ModelCostSelectorOptions) {
    super();
    this.tui = opts.tui;
    this.theme = opts.theme;
    this.allModels = [...opts.models].sort(
      (a, b) => a.cost.input + a.cost.output - (b.cost.input + b.cost.output),
    );
    this.currentModel = opts.currentModel;
    this.onSelectCb = opts.onSelect;
    this.onCancelCb = opts.onCancel;
    this.onAddToScopeCb = opts.onAddToScope;
    this.scopedKeys = opts.scopedKeys ?? new Set();

    this.providers = [...new Set(this.allModels.map((m) => m.provider))].sort();

    this.addChild(new DynamicBorder((s) => opts.theme.fg("border", s)));
    this.addChild(
      new Text(opts.theme.fg("accent", opts.theme.bold("Select Model by Cost")), 1, 0),
    );
    this.addChild(new Spacer(1));
    this.providerText = new Text("", 1, 0);
    this.addChild(this.providerText);
    this.addChild(new Spacer(1));
    this.updateProviderBar();
    this.addChild(new Text(opts.theme.fg("muted", "Filter:"), 1, 0));
    this.searchInput = new Input();
    if (opts.initialSearch) {
      this.searchInput.setValue(opts.initialSearch);
    }
    this.searchInput.onSubmit = () => {
      if (this.filteredModels[this.selectedIndex]) {
        this.onSelectCb(this.filteredModels[this.selectedIndex]);
      }
    };
    this.searchInput.onEscape = () => this.onCancelCb();
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));

    this.listContainer = new Container();
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));

    const hintLine =
      opts.theme.fg("muted", "←→") +
      " " +
      opts.theme.fg("muted", "provider") +
      " " +
      opts.theme.fg("muted", "·") +
      " " +
      keyHint("tui.select.up", "up") +
      " " +
      opts.theme.fg("muted", "·") +
      " " +
      keyHint("tui.select.down", "down") +
      " " +
      opts.theme.fg("muted", "·") +
      " " +
      keyHint("tui.select.confirm", "select") +
      " " +
      opts.theme.fg("muted", "·") +
      " " +
      keyHint("tui.select.cancel", "cancel") +
      " " +
      opts.theme.fg("muted", "·") +
      " " +
      opts.theme.fg("muted", "ctrl+s") +
      " " +
      opts.theme.fg("muted", "scope");
    this.addChild(new Text(hintLine, 0, 0));
    this.addChild(new Spacer(1));

    this.addChild(new DynamicBorder((s) => opts.theme.fg("border", s)));

    this.filteredModels = this.allModels;
    this.filterModels(this.searchInput.getValue());
    this.tui.requestRender();
  }

  private isCurrent(m: Model<any>): boolean {
    return (
      this.currentModel !== undefined &&
      this.currentModel.provider === m.provider &&
      this.currentModel.id === m.id
    );
  }

  private filterModels(query: string): void {
    let models = this.allModels;
    if (this.selectedProviderIndex === -2) {
      models = models.filter((m) => m.cost.input === 0 && m.cost.output === 0);
    } else if (this.selectedProviderIndex >= 0 && this.selectedProviderIndex < this.providers.length) {
      const provider = this.providers[this.selectedProviderIndex];
      models = models.filter((m) => m.provider === provider);
    }
    this.filteredModels = query
      ? fuzzyFilter(models, query, (m) => `${m.id} ${m.name} ${m.provider}`)
      : models;
    this.filteredModels = [
      ...this.filteredModels.filter((m) => this.scopedKeys.has(`${m.provider}/${m.id}`)),
      ...this.filteredModels.filter((m) => !this.scopedKeys.has(`${m.provider}/${m.id}`)),
    ];
    this.selectedIndex = 0;
    this.updateList();
  }

  private updateList(): void {
    this.listContainer.clear();
    const maxVisible = 10;
    const total = this.filteredModels.length;
    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(maxVisible / 2),
        total - maxVisible,
      ),
    );
    const endIndex = Math.min(startIndex + maxVisible, total);

    for (let i = startIndex; i < endIndex; i++) {
      const m = this.filteredModels[i];
      if (!m) continue;
      const isSelected = i === this.selectedIndex;
      const isCurrent = this.isCurrent(m);
      const arrow = isSelected ? this.theme.fg("accent", "→ ") : "  ";
      const name = isSelected
        ? this.theme.fg("accent", m.name)
        : m.name;
      const provider = this.theme.fg("muted", `[${m.provider}]`);
      const inputPrice = this.theme.fg(
        "text",
        `${formatPrice(m.cost.input)} in`,
      );
      const outputPrice = this.theme.fg(
        "text",
        `${formatPrice(m.cost.output)} out`,
      );
      const ctx = this.theme.fg(
        "dim",
        `${formatContextWindow(m.contextWindow)} ctx`,
      );
      const checkmark = isCurrent ? this.theme.fg("success", " ✓") : "";
      const scoped = this.scopedKeys.has(`${m.provider}/${m.id}`);
      const scopeIcon = this.onAddToScopeCb
        ? scoped
          ? this.theme.fg("accent", " ✖")
          : this.theme.fg("muted", " ✚")
        : "";
      const line = `${arrow}${name} ${provider}   ${inputPrice}  ${outputPrice}  ${ctx}${scopeIcon}${checkmark}`;
      this.listContainer.addChild(new Text(line, 0, 0));
    }

    if (total > 0 && (startIndex > 0 || endIndex < total)) {
      this.listContainer.addChild(
        new Text(
          this.theme.fg("muted", `  (${this.selectedIndex + 1}/${total})`),
          0,
          0,
        ),
      );
    }

    if (total === 0) {
      this.listContainer.addChild(
        new Text(this.theme.fg("muted", "  No matching models"), 0, 0),
      );
    } else {
      const selected = this.filteredModels[this.selectedIndex];
      if (selected) {
        this.listContainer.addChild(new Spacer(1));
        const cacheParts: string[] = [];
        if (selected.cost.cacheRead) {
          cacheParts.push(
            `cache read ${formatPrice(selected.cost.cacheRead)}`,
          );
        }
        if (selected.cost.cacheWrite) {
          cacheParts.push(
            `cache write ${formatPrice(selected.cost.cacheWrite)}`,
          );
        }
        const detail = `${selected.name} (${selected.provider})${
          cacheParts.length > 0 ? ` — ${cacheParts.join(", ")}` : ""
        }`;
        this.listContainer.addChild(
          new Text(this.theme.fg("muted", `  ${detail}`), 0, 0),
        );
      }
    }
    this.tui.requestRender();
  }

  private updateProviderBar(): void {
    const parts: string[] = [];
    const allSelected = this.selectedProviderIndex === -1;
    const freeSelected = this.selectedProviderIndex === -2;
    parts.push(
      allSelected
        ? this.theme.fg("accent", this.theme.bold("[ All ]"))
        : this.theme.fg("muted", "[ All ]"),
    );
    parts.push(
      freeSelected
        ? this.theme.fg("accent", this.theme.bold("[ Free ]"))
        : this.theme.fg("muted", "[ Free ]"),
    );
    for (let i = 0; i < this.providers.length; i++) {
      const selected = i === this.selectedProviderIndex;
      parts.push(
        selected
          ? this.theme.fg("accent", this.theme.bold(`[ ${this.providers[i]} ]`))
          : this.theme.fg("muted", `[ ${this.providers[i]} ]`),
      );
    }
    this.providerText.setText(parts.join(" "));
    this.tui.requestRender();
  }

  handleInput(keyData: string): void {
    const kb = getKeybindings();
    if (matchesKey(keyData, Key.right)) {
      if (this.selectedProviderIndex >= this.providers.length - 1) {
        this.selectedProviderIndex = -1;
      } else if (this.selectedProviderIndex === -1) {
        this.selectedProviderIndex = -2;
      } else if (this.selectedProviderIndex === -2) {
        this.selectedProviderIndex = 0;
      } else {
        this.selectedProviderIndex++;
      }
      this.updateProviderBar();
      this.filterModels(this.searchInput.getValue());
      return;
    }
    if (matchesKey(keyData, Key.left)) {
      if (this.selectedProviderIndex === -1) {
        this.selectedProviderIndex = this.providers.length - 1;
      } else if (this.selectedProviderIndex === -2) {
        this.selectedProviderIndex = -1;
      } else if (this.selectedProviderIndex === 0) {
        this.selectedProviderIndex = -2;
      } else {
        this.selectedProviderIndex--;
      }
      this.updateProviderBar();
      this.filterModels(this.searchInput.getValue());
      return;
    }
    if (kb.matches(keyData, "tui.select.up")) {
      if (this.filteredModels.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === 0
          ? this.filteredModels.length - 1
          : this.selectedIndex - 1;
      this.updateList();
      return;
    }
    if (kb.matches(keyData, "tui.select.down")) {
      if (this.filteredModels.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === this.filteredModels.length - 1
          ? 0
          : this.selectedIndex + 1;
      this.updateList();
      return;
    }
    if (kb.matches(keyData, "tui.select.confirm")) {
      const selected = this.filteredModels[this.selectedIndex];
      if (selected) this.onSelectCb(selected);
      return;
    }
    if (kb.matches(keyData, "tui.select.cancel")) {
      this.onCancelCb();
      return;
    }
    if (matchesKey(keyData, Key.ctrl("s")) && this.onAddToScopeCb) {
      const selected = this.filteredModels[this.selectedIndex];
      if (selected) {
        const result = this.onAddToScopeCb(selected);
        if (result === null) return;
        const key = `${selected.provider}/${selected.id}`;
        if (result) {
          this.scopedKeys.add(key);
        } else {
          this.scopedKeys.delete(key);
        }
        this.updateList();
      }
      return;
    }
    this.searchInput.handleInput(keyData);
    this.filterModels(this.searchInput.getValue());
  }
}

/** Expand a `*`/`**`/`?`/`[abc]` glob into an anchored, case-insensitive regex. */
function globToRegex(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // ** — match everything including /
        re += ".*";
        i++;
      } else {
        // * — match anything except /
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if (ch === "[") {
      const end = pattern.indexOf("]", i);
      if (end === -1) {
        re += "\\[";
      } else {
        re += pattern.substring(i, end + 1);
        i = end;
      }
    } else if (ch === "." || ch === "(" || ch === ")" || ch === "+" || ch === "^" || ch === "$" || ch === "|" || ch === "\\" || ch === "{" || ch === "}") {
      re += "\\" + ch;
    } else {
      re += ch;
    }
    i++;
  }
  return new RegExp("^" + re + "$", "i");
}

/** Resolve `enabledModels` patterns (`provider/id`, bare id, or glob, each with
 *  an optional `:thinkingLevel` suffix) into live registry entries. */
function resolveScopeSync(
  patterns: string[],
  models: Model<any>[],
): { model: Model<any>; thinkingLevel?: string }[] {
  const scoped: { model: Model<any>; thinkingLevel?: string }[] = [];
  const validLevels = ["low", "medium", "high", "minimal", "xhigh"];

  for (const pattern of patterns) {
    let globPattern = pattern;
    let thinkingLevel: string | undefined;
    const colonIdx = pattern.lastIndexOf(":");
    if (colonIdx > 0) {
      const suffix = pattern.substring(colonIdx + 1);
      if (validLevels.includes(suffix)) {
        thinkingLevel = suffix;
        globPattern = pattern.substring(0, colonIdx);
      }
    }

    // Exact match: provider/id or bare id
    const slashIdx = globPattern.indexOf("/");
    let exactMatch: Model<any> | undefined;
    if (slashIdx > 0) {
      const provider = globPattern.substring(0, slashIdx);
      const id = globPattern.substring(slashIdx + 1);
      exactMatch = models.find(
        (m) => m.provider === provider && m.id === id,
      );
    }
    if (!exactMatch) {
      const lower = globPattern.toLowerCase();
      exactMatch = models.find((m) => m.id.toLowerCase() === lower);
    }

    if (exactMatch) {
      if (
        !scoped.find(
          (s) =>
            s.model.provider === exactMatch!.provider &&
            s.model.id === exactMatch!.id,
        )
      ) {
        scoped.push({ model: exactMatch, thinkingLevel });
      }
      continue;
    }

    // Glob matching
    const hasGlob =
      globPattern.includes("*") ||
      globPattern.includes("?") ||
      globPattern.includes("[");
    if (hasGlob) {
      const regex = globToRegex(globPattern);
      for (const m of models) {
        const fullId = `${m.provider}/${m.id}`;
        if (regex.test(fullId) || regex.test(m.id)) {
          if (
            !scoped.find(
              (s) =>
                s.model.provider === m.provider && s.model.id === m.id,
            )
          ) {
            scoped.push({ model: m, thinkingLevel });
          }
        }
      }
    }
  }
  return scoped;
}

/** Persist `defaultProvider`/`defaultModel` to the global settings file so a
 *  model selected in the selector survives an app restart. pi-core only
 *  updates these on the explicit "set as default" (Ctrl+S) action inside its
 *  own /model selector; the /modelcost selector has no equivalent action, so
 *  we write them directly (read-modify-write to preserve all other keys). */
function persistDefaultModelAndProvider(model: Model<any>): void {
  try {
    const settings = readSettings();
    settings.defaultProvider = model.provider;
    settings.defaultModel = model.id;
    writeSettings(settings);
  } catch { /* non-fatal */ }
}

/** The `/modelcost` command: an inline (belowEditor) model selector. */
function registerModelCostCommand(pi: ExtensionAPI): void {
  pi.registerCommand("modelcost", {
    description: "Select model with input/output token cost ($/M)",
    handler: async (args, ctx) => {
      const allModels = ctx.modelRegistry.getAvailable();
      if (allModels.length === 0) {
        ctx.ui.notify("No models available", "warning");
        return;
      }
      const searchTerm = args.trim();
      // Direct match: try provider/id or unique bare id
      let directMatch: Model<any> | undefined;
      const slashIdx = searchTerm.indexOf("/");
      if (slashIdx > 0) {
        const provider = searchTerm.substring(0, slashIdx);
        const id = searchTerm.substring(slashIdx + 1);
        directMatch = ctx.modelRegistry.find(provider, id);
      }
      if (!directMatch && searchTerm) {
        const lower = searchTerm.toLowerCase();
        const idMatches = allModels.filter(
          (m) => m.id.toLowerCase() === lower,
        );
        directMatch = idMatches.length === 1 ? idMatches[0] : undefined;
      }
      if (directMatch) {
        const ok = await pi.setModel(directMatch);
        if (ok) {
          persistDefaultModelAndProvider(directMatch);
          ctx.ui.notify(`Default model: ${directMatch.provider}/${directMatch.id}`, "info");
        }
        return;
      }

      const addToScope = (model: Model<any>): boolean | null => {
        const key = `${model.provider}/${model.id}`;
        const enabledModels = getEnabledModels();
        const idx = enabledModels.indexOf(key);
        let added: boolean;
        if (idx >= 0) {
          enabledModels.splice(idx, 1);
          added = false;
        } else {
          enabledModels.push(key);
          added = true;
        }
        try {
          setEnabledModels(enabledModels);
        } catch {
          return null;
        }
        syncScope();
        return added;
      };
      const buildScopedSet = (): Set<string> => new Set(getEnabledModels());

      const syncScope = (): void => {
        const live =
          ctx.scopedModels as unknown as {
            model: Model<any>;
            thinkingLevel?: string;
          }[];
        const resolved = resolveScopeSync(getEnabledModels(), allModels);
        live.splice(0, live.length, ...resolved);
      };

      // Apply scope from settings immediately (in case changed externally
      // or not yet applied for this session)
      syncScope();

      // We use setWidget + onTerminalInput (rather than ctx.ui.custom) so the
      // selector renders in the "belowEditor" slot — between the input box and
      // the footer — instead of as a centered overlay modal.
      const WIDGET_KEY = "modelcost-selector";
      const selected = await new Promise<Model<any> | null>((resolve) => {
        let selector: ModelCostSelector | undefined;
        let unsubscribe: (() => void) | undefined;
        let resolved = false;

        const finish = (result: Model<any> | null) => {
          if (resolved) return;
          resolved = true;
          if (selector) selector.searchInput.focused = false;
          if (unsubscribe) unsubscribe();
          ctx.ui.setWidget(WIDGET_KEY, undefined);
          resolve(result);
        };

        ctx.ui.setWidget(
          WIDGET_KEY,
          (tui, theme): Component => {
            selector = new ModelCostSelector({
              tui,
              theme,
              models: allModels,
              currentModel: ctx.model,
              scopedKeys: buildScopedSet(),
              initialSearch: searchTerm || undefined,
              onSelect: (m) => finish(m),
              onAddToScope: (m) => addToScope(m),
              onCancel: () => finish(null),
            });
            // TUI focus isn't routed to below-editor widgets, so set the
            // search-input focus flag directly to make the cursor visible.
            selector.searchInput.focused = true;
            return selector;
          },
          { placement: "belowEditor" },
        );

        // Forward all terminal input to the selector and consume it so the
        // editor doesn't receive keystrokes while the selector is open.
        unsubscribe = ctx.ui.onTerminalInput((data) => {
          if (selector) selector.handleInput(data);
          return { consume: true };
        });
      });
      if (selected) {
        const ok = await pi.setModel(selected);
        if (ok) {
          persistDefaultModelAndProvider(selected);
          ctx.ui.notify(`Default model: ${selected.provider}/${selected.id}`, "info");
        }
      }
    },
  });
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default async function (pi: ExtensionAPI) {
  // Pure host-side UI registration (no I/O), so it is registered before the
  // slower provider bootstraps below.
  registerModelCostCommand(pi);

  // Both providers register in parallel so the two catalog fetches (each up to
  // 10s, disk-cached after the first boot) overlap exactly as they did when
  // they lived in separate extension files.
  await Promise.all([
    registerTokenHarborProvider(pi),
    registerKiloProvider(pi),
  ]);
}
