/**
 * acp-harness.ts — the model-switch contract for each ACP harness.
 *
 * The JSON-RPC transport lives in `acp-client.ts` and is shared. Model
 * selection is not shared: every CLI implements a different piece of ACP, and a
 * workaround for one must never change how another is driven.
 *
 *   gemini    session/set_model only (session/new reports `models`)
 *   cline     session/set_model, then its `model` config option
 *   kilo      session/set_model only (it also has a `model` config option,
 *             but its set_model is the supported path)
 *   opencode  session/set_config_option only; `session/set_model` is Method
 *             not found, and its `model` option can arrive just after
 *             session/new
 *
 * A profile lists only the mechanisms its own CLI supports. That is the
 * isolation boundary: adding a fallback or a wait to `OPENCODE` cannot make
 * Gemini fall through to a config option, and a Gemini change cannot alter
 * Kilo. An unknown/custom ACP harness gets `GENERIC`.
 *
 * Print-mode harnesses (Claude Code, Codex, Aider, Cursor) never reach this
 * module; their per-harness `modelFlag` in `harnesses.ts` is the whole model
 * contract.
 */

export type AcpModelVia = "set_model" | "config_option";

export interface AcpHarnessProfile {
  /** Stable id used in errors/tests. */
  id: string;
  /** Binary names (or harness ids) that select this profile. */
  aliases: readonly string[];
  /** Model-switch mechanisms this CLI implements, tried in order. */
  modelVia: readonly AcpModelVia[];
  /** Config-option ids to use for `config_option`, in preference order. An
   *  empty list means "the first option in the model category, preferring
   *  `model`" (the generic ACP shape). */
  modelConfigIds: readonly string[];
  /** Wait this long for the model option to appear after session/new. Only
   *  consulted when `config_option` is in `modelVia`. */
  modelOptionWaitMs: number;
  /** Retry a rejected `set_config_option` once after this delay. Only
   *  consulted when `config_option` is in `modelVia`. */
  modelRetryMs: number;
  /** Reject an id the agent did not advertise before asking it to switch.
   *  Only Cline needs this: Gemini/Kilo/opencode reject an unknown id in their
   *  own set_model/set_config_option path, while Cline accepts any string and
   *  can end the turn with no answer instead of an error. */
  validateAdvertisedModel: boolean;
}

/** Gemini CLI: ACP v2, model via the standard `session/set_model`. Its
 *  session/new advertises `models.availableModels` / `currentModelId` and no
 *  model config option, so a config fallback would be meaningless. */
export const GEMINI_ACP_PROFILE: AcpHarnessProfile = {
  id: "gemini",
  aliases: ["gemini"],
  modelVia: ["set_model"],
  modelConfigIds: [],
  modelOptionWaitMs: 0,
  modelRetryMs: 0,
  validateAdvertisedModel: false,
};

/** Cline: `session/set_model` is the normal path. Older builds expose the
 *  model only as a config option; when we do fall back, use `model` — never
 *  the sibling `provider` option, which would change something else. The
 *  fallback option can arrive just after session/new while the provider
 *  catalogue loads, so it gets the same late-option wait as opencode. */
export const CLINE_ACP_PROFILE: AcpHarnessProfile = {
  id: "cline",
  aliases: ["cline"],
  modelVia: ["set_model", "config_option"],
  modelConfigIds: ["model"],
  modelOptionWaitMs: 1_500,
  modelRetryMs: 250,
  validateAdvertisedModel: true,
};

/** Kilo Code: model via `session/set_model`. It advertises a `model` config
 *  option too, but switching through it is not the supported path; a refused
 *  set_model is a real failure and must be reported, not masked by a second
 *  mechanism. */
export const KILO_ACP_PROFILE: AcpHarnessProfile = {
  id: "kilo",
  aliases: ["kilo", "kilocode"],
  modelVia: ["set_model"],
  modelConfigIds: ["model"],
  modelOptionWaitMs: 0,
  modelRetryMs: 0,
  validateAdvertisedModel: false,
};

/** opencode: no `session/set_model`; the model is a config option. It can be
 *  published a beat after session/new while the provider catalogue loads, so
 *  wait for it and retry a transient rejection once. */
export const OPENCODE_ACP_PROFILE: AcpHarnessProfile = {
  id: "opencode",
  aliases: ["opencode", "opencode-ai"],
  modelVia: ["config_option"],
  modelConfigIds: ["model"],
  modelOptionWaitMs: 1_500,
  modelRetryMs: 250,
  validateAdvertisedModel: false,
};

/** An ACP harness this build does not know (or a test double): try the
 *  standard method first, then the generic config option. */
export const GENERIC_ACP_PROFILE: AcpHarnessProfile = {
  id: "generic",
  aliases: [],
  modelVia: ["set_model", "config_option"],
  modelConfigIds: [],
  modelOptionWaitMs: 1_500,
  modelRetryMs: 250,
  validateAdvertisedModel: false,
};

const BUILT_IN_PROFILES: readonly AcpHarnessProfile[] = [
  GEMINI_ACP_PROFILE,
  CLINE_ACP_PROFILE,
  KILO_ACP_PROFILE,
  OPENCODE_ACP_PROFILE,
];

/** Resolve the profile for a harness id (`opencode`) or a binary path
 *  (`/home/me/.opencode/bin/opencode`). */
export function acpHarnessProfile(harnessOrBinary: string | null | undefined): AcpHarnessProfile {
  const raw = String(harnessOrBinary ?? "").trim().toLowerCase();
  if (!raw) return GENERIC_ACP_PROFILE;
  // A resolved path is common: createAcpSession is handed the executable, not
  // always the harness id. Windows shims add .cmd/.exe.
  const base = (raw.split(/[\\/]/).pop() || raw).replace(/\.(exe|cmd|bat)$/i, "");
  return BUILT_IN_PROFILES.find(
    (profile) => profile.aliases.includes(raw) || profile.aliases.includes(base),
  ) || GENERIC_ACP_PROFILE;
}
