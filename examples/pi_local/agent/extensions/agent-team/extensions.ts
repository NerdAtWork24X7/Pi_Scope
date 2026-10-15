/**
 * Extension discovery + subagent CLI-arg building.
 *
 * Everything related to "which extensions does a spawned pi subprocess get"
 * lives here: scanning for extension entry points, honouring settings.json
 * disable-lists, detecting the Pi Scope observability extension, and
 * building the actual --extension/-o-name CLI flags that memory.ts and
 * orchestration.ts pass to spawned subprocesses.
 *
 * This was previously split across core.ts (hasPiScopeExtension), config.ts
 * (scanExtensionPaths/loadDisabledExtensions/isDisabled), and duplicated
 * inline in both memory.ts and orchestration.ts (identical arg-building).
 * Consolidating it here means:
 *   - the extension-disable check happens once instead of being re-derived
 *     from settings.json twice per scan (loadDisabledExtensions used to
 *     re-read+re-parse the same file that scanExtensionPaths also read)
 *   - the Pi Scope check is memoized per extPaths array instead of being
 *     re-scanned on every single subagent dispatch (extPaths is a stable,
 *     session-lifetime array — see index.ts loadAgents — so recomputing a
 *     regex scan over it on every dispatch was pure waste)
 *   - the CLI-arg fragments are built in one place instead of two files
 *     drifting out of sync with each other
 */

import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join, isAbsolute, dirname, basename } from "path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

// ── Disabled-extension matching ─────────────────────────────────────────

interface DisabledPatterns {
  /** Bare basename patterns (no path separator) — O(1) membership check. */
  basenames: Set<string>;
  /** Patterns containing a path separator — matched by suffix, checked
   *  only when the (rarer) basename check misses. */
  suffixes: string[];
}

const EMPTY_DISABLED: DisabledPatterns = { basenames: new Set(), suffixes: [] };

/** Read settings.json once. Returns null if missing/unreadable so callers
 *  can short-circuit without re-checking existsSync separately. */
function readSettingsJson(): Record<string, unknown> | null {
  try {
    const settingsPath = join(getAgentDir(), "settings.json");
    if (!existsSync(settingsPath)) return null;
    return JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch {
    return null;
  }
}

/** Load disabled-extension patterns from settings.json's `extensions` list
 *  (entries prefixed with `-`). */
export function loadDisabledExtensions(settings?: Record<string, unknown> | null): Set<string> {
  const raw = settings === undefined ? readSettingsJson() : settings;
  const disabled = new Set<string>();
  const exts = (raw?.extensions as unknown[]) || [];
  for (const e of exts) {
    if (typeof e === "string" && e.startsWith("-")) disabled.add(e.slice(1));
  }
  return disabled;
}

function compilePatterns(disabled: Set<string>): DisabledPatterns {
  if (disabled.size === 0) return EMPTY_DISABLED;
  const basenames = new Set<string>();
  const suffixes: string[] = [];
  for (const pattern of disabled) {
    if (pattern.includes("/") || pattern.includes("\\")) suffixes.push(pattern);
    else basenames.add(pattern);
  }
  return { basenames, suffixes };
}

/** Check if an extension path is disabled. Match is by basename so that
 *  patterns like "foo/index.ts" do not also match "myfoo/index.ts". */
export function isDisabled(extPath: string, disabled: Set<string> | DisabledPatterns): boolean {
  const patterns = disabled instanceof Set ? compilePatterns(disabled) : disabled;
  const base = extPath.split(/[/\\]/).pop() || extPath;
  if (patterns.basenames.has(base)) return true;
  for (const pattern of patterns.suffixes) {
    if (extPath.endsWith(pattern)) return true;
  }
  return false;
}

// ── Extension path scanning ─────────────────────────────────────────────

/** Collect extension paths (excluding agent-team and disabled extensions)
 *  for -e flags. Reads settings.json exactly once — both the disable-list
 *  and the absolute-path extension list are derived from that single read. */
export function scanExtensionPaths(cwd: string): string[] {
  const dirs = [
    join(cwd, ".pi", "extensions"),
    join(getAgentDir(), "extensions"),
  ];
  const settings = readSettingsJson();
  const patterns = compilePatterns(loadDisabledExtensions(settings));

  const seen = new Set<string>();
  const paths: string[] = [];
  const add = (p: string) => {
    if (seen.has(p)) return;
    seen.add(p);
    paths.push(p);
  };

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        if (f.isDirectory()) {
          const idx = join(dir, f.name, "index.ts");
          if (existsSync(idx) && !isDisabled(idx, patterns)) add(idx);
        } else if (f.isFile() && f.name.endsWith(".ts")) {
          const p = join(dir, f.name);
          if (!isDisabled(p, patterns)) add(p);
        }
      }
    } catch { /* unreadable extensions dir — skip */ }
  }

  // Also load absolute-path extensions from settings.json (e.g. observability)
  const extEntries = (settings?.extensions as unknown[]) || [];
  for (const ext of extEntries) {
    if (typeof ext !== "string" || ext.startsWith("-")) continue; // not a string, or disabled
    const resolved = isAbsolute(ext) ? ext : join(getAgentDir(), ext);
    if (existsSync(resolved)) add(resolved);
  }

  return paths.filter(p => !p.includes("agent-team"));
}

// ── Pi Scope detection (memoized) ───────────────────────────────────────

/** `extPaths` is a stable, session-lifetime array (assigned once in
 *  index.ts#loadAgents and shared by reference via a closure into
 *  MemoryManager/ProcessManager). A WeakMap lets us cache the boolean per
 *  array *instance* without holding a strong reference to it — if a future
 *  session reload ever produces a new array, the old cache entry is
 *  collected instead of accumulating forever. */
const piScopeCache = new WeakMap<string[], boolean>();

function computeHasPiScopeExtension(extPaths: string[]): boolean {
  return extPaths.some((p) => {
    const normalized = p.replace(/\\/g, "/");
    const base = normalized.split("/").pop()?.replace(/\.((ts|js))$/i, "") ?? "";
    return base === "pi-scope" || /(^|\/)pi-scope\//.test(normalized);
  });
}

/** Returns true if the Pi Scope observability extension is present in the
 *  list of extension entry-point paths. Used to decide whether it is safe
 *  to pass Pi-Scope-specific CLI flags (e.g. --o-name) to spawned pi
 *  subprocesses. Memoized per extPaths array reference so repeated
 *  per-dispatch calls (one per subagent spawn) don't re-scan the same
 *  session-lifetime array every time. */
export function hasPiScopeExtension(extPaths: string[]): boolean {
  const cached = piScopeCache.get(extPaths);
  if (cached !== undefined) return cached;
  const result = computeHasPiScopeExtension(extPaths);
  piScopeCache.set(extPaths, result);
  return result;
}

// ── Extension settings (one file per extensions directory) ──────────────
//
// Enablement lives in a single manifest beside the extensions it configures:
//
//   <extensions>/extensions.json      (e.g. agent/extensions/extensions.json)
//
//   {
//     "web_fetch": { "orchestrator": true, "subagent": true },
//     "speech-to-text": { "subagent": false },
//     "browser": { "orchestrator": false }
//   }
//
// Keys are extension names: the directory name for a directory extension, the
// file stem for a single-file one — exactly the names that appear in the
// extensions folder. `subagent: false` keeps the extension out of every spawned
// child (dispatch clones and the memory summarizer); `orchestrator: false`
// hides that extension's tools from the orchestrator's active tool list. Both
// default to true, so an unlisted extension, a missing file and invalid JSON
// all mean "enabled for both" — this layer changes nothing until an entry says
// otherwise.
//
// Deliberately NO tool names here: what a subagent may call is its own `.md`
// frontmatter `tools:` list (passed through as `--tools`), and which extensions
// a child needs follows from that. This file only says yes/no.

export interface ExtensionSettings {
  /** Whether the extension's tools are offered to the orchestrator. */
  orchestrator: boolean;
  /** Whether spawned subagents may load the extension. */
  subagent: boolean;
}

const EXTENSION_SETTINGS_DEFAULTS: ExtensionSettings = { orchestrator: true, subagent: true };
/** Name of the shared manifest, read from each extensions directory. */
export const EXTENSION_SETTINGS_FILE = "extensions.json";

/** The directory that holds `extPath` — `<name>.ts` sits directly in it, while
 *  a directory extension is `<name>/index.ts`. This is where the manifest lives. */
export function extensionsDirFor(extPath: string): string {
  return basename(extPath) === "index.ts" ? dirname(dirname(extPath)) : dirname(extPath);
}

/** Key an extension is addressed by in the manifest. */
export function extensionKey(extPath: string): string {
  return basename(extPath) === "index.ts" ? basename(dirname(extPath)) : basename(extPath).replace(/\.ts$/, "");
}

/** Manifest path that governs this extension. */
export function extensionSettingsFileFor(extPath: string): string {
  return join(extensionsDirFor(extPath), EXTENSION_SETTINGS_FILE);
}

/** extPath → its parsed entry. Refilled by refreshExtensionSettings, so the
 *  dispatch hot path is pure map reads (no statSync per spawn). */
const settingsCache = new Map<string, ExtensionSettings>();

/** Read one extension's entry out of its directory's manifest. */
export function loadExtensionSettings(extPath: string): ExtensionSettings {
  const cached = settingsCache.get(extPath);
  if (cached) return cached;
  const settings = readExtensionSettings(extPath);
  settingsCache.set(extPath, settings);
  return settings;
}

/** Parse a manifest. Unreadable or invalid JSON → null (all defaults). */
function parseManifest(file: string): Record<string, any> | null {
  try {
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null; // unreadable/invalid → don't change behavior
  }
}

function readExtensionSettings(extPath: string): ExtensionSettings {
  const entry = parseManifest(extensionSettingsFileFor(extPath))?.[extensionKey(extPath)];
  if (!entry || typeof entry !== "object") return EXTENSION_SETTINGS_DEFAULTS;
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  return {
    orchestrator: bool(entry.orchestrator, true),
    subagent: bool(entry.subagent, true),
  };
}

/** Drop cached settings and re-read the manifests, so the next lookup sees the
 *  current files. Called at session start and when the watcher spots an edit. */
export function refreshExtensionSettings(extPaths: string[]): void {
  settingsCache.clear();
  for (const p of extPaths) loadExtensionSettings(p);
}

/** Change signature over the manifests referenced by `extPaths`. The config
 *  watcher polls this so editing extensions.json takes effect without a restart. */
export function extensionSettingsSignature(extPaths: string[]): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const p of extPaths) {
    const file = extensionSettingsFileFor(p);
    if (seen.has(file)) continue;
    seen.add(file);
    let mtime = 0;
    try { mtime = statSync(file).mtimeMs; } catch { /* no manifest */ }
    parts.push(`${file}:${mtime}`);
  }
  return parts.join("|");
}

/** Tool names the orchestrator must not see because their extension is marked
 *  `orchestrator: false`.
 *
 *  A tool is only hidden when every extension providing it is switched off: two
 *  extensions can expose the same tool name (web_fetch and obscura both provide
 *  `web-fetch`), so a tool that a still-enabled extension also provides stays
 *  available. Extensions with no known tools (UI/wiring only) hide nothing. */
export function orchestratorHiddenTools(extPaths: string[]): string[] {
  const disabled = new Set<string>();
  const enabled = new Set<string>();
  for (const p of extPaths) {
    const tools = toolsProvidedBy(p);
    if (!tools.length) continue;
    const settings = loadExtensionSettings(p);
    for (const t of tools) (settings.orchestrator ? enabled : disabled).add(t.toLowerCase());
  }
  return [...disabled].filter(t => !enabled.has(t));
}

// ── Subagent extension routing ──────────────────────────────────────────
//
// Every spawned subagent used to load EVERY configured extension. A subagent
// boots straight into its first tool call, so that module load (transpile +
// execute + any boot side effect) sat directly on the dispatch critical path,
// multiplied by the task count of each batch — for tools the agent could not
// even call. These three tables route the set per child; anything not listed
// is passed through untouched (fail open, so a newly added extension keeps
// working without touching this file).

/** Extensions whose only job is registering agent-facing tools: keep one only
 *  when the child's `--tools` allowlist actually uses one of its tools. */
const TOOL_EXTENSIONS: Array<{ match: RegExp; tools: string[] }> = [
  { match: /(^|\/)custom-tools\/index\.ts$/, tools: ["custom_read", "custom_write", "custom_edit"] },
  { match: /(^|\/)web_fetch\/index\.ts$/, tools: ["web-fetch"] },
  { match: /(^|\/)obscura\/index\.ts$/, tools: ["web-fetch"] },
  { match: /(^|\/)browser\.ts$/, tools: ["browser"] },
  { match: /(^|\/)context7\.ts$/, tools: ["context7-search", "context7-query"] },
];

/** Interactive-host extensions: UI wiring (footer, dictation, previews) or
 *  input hooks that are inert in a headless RPC child. A subagent can never
 *  use them, and each one costs a module load per dispatch.
 *
 *  model_provider.ts is NOT host-only despite registering the /modelcost
 *  model picker: it also registers the kilo/tokenharbor providers, so a child
 *  on either of those models needs it — PROVIDER_EXTENSIONS below routes it. */
const HOST_ONLY_EXTENSIONS: RegExp[] = [
  /(^|\/)speech-to-text\/index\.ts$/,
  /(^|\/)custom-footer\.ts$/,
  /(^|\/)image-preview\.ts$/,
];

/** Provider extensions: they register a *dynamic* provider, so a child needs
 *  one only when its own model belongs to that provider. When the model id has
 *  no provider prefix we keep them all (fail open — an unregistered provider
 *  would make the child's model unresolvable). */
const PROVIDER_EXTENSIONS: Array<{ match: RegExp; providers: string[] }> = [
  // One file registers both dynamic providers (see model_provider.ts), so the
  // child gets it when its model belongs to either one.
  { match: /(^|\/)model_provider\.ts$/, providers: ["kilo", "tokenharbor"] },
];

export interface SubagentExtensionFilter {
  /** The child's tool allowlist — its `--tools` value (comma-separated). */
  tools: string;
  /** Provider prefix of the child's model, when known (e.g. "kilo" for
   *  "kilo/stepfun/step-3.7-flash:free"). */
  provider?: string;
}

/** Pick the extensions a spawned subagent actually needs.
 *
 *  `filter.tools` is the agent's own `.md` frontmatter tool list (the `--tools`
 *  allowlist): an extension that registers tools is included exactly when the
 *  agent is allowed to call one of them, so a file_reader never pays for the
 *  browser or the docs client. Anything the tables don't recognise is kept
 *  (fail open), so this can only ever *remove* known extensions. */
export function selectSubagentExtensions(extPaths: string[], filter: SubagentExtensionFilter): string[] {
  const tools = new Set(filter.tools.split(",").map(t => t.trim().toLowerCase()).filter(Boolean));
  const provider = filter.provider?.toLowerCase();
  return extPaths.filter((p) => {
    const settings = loadExtensionSettings(p);
    // An explicit per-extension switch wins over every inferred rule below.
    if (!settings.subagent) return false;
    const path = p.replace(/\\/g, "/");
    if (HOST_ONLY_EXTENSIONS.some(re => re.test(path))) return false;
    const toolExt = TOOL_EXTENSIONS.find(e => e.match.test(path));
    if (toolExt) return toolExt.tools.some(t => tools.has(t.toLowerCase()));
    const providerExt = PROVIDER_EXTENSIONS.find(e => e.match.test(path));
    if (providerExt) return !provider || providerExt.providers.includes(provider);
    return true;
  });
}

/** Tool names an extension is known to register, from the routing table. */
function toolsProvidedBy(extPath: string): string[] {
  const path = extPath.replace(/\\/g, "/");
  return TOOL_EXTENSIONS.find(e => e.match.test(path))?.tools ?? [];
}

// ── Shared subprocess CLI-arg builders ──────────────────────────────────

/** `--no-extensions` plus one `--extension <path>` pair per entry. Shared
 *  by memory.ts and orchestration.ts so the two subprocess spawn paths
 *  can't drift out of sync.
 *
 *  Pass a `filter` for spawned subagents to route the set to that child's
 *  tools/provider (see selectSubagentExtensions); omit it to load everything. */
export function buildExtensionCliArgs(extPaths: string[], filter?: SubagentExtensionFilter): string[] {
  const selected = filter ? selectSubagentExtensions(extPaths, filter) : extPaths;
  return ["--no-extensions", ...selected.flatMap(p => ["--extension", p])];
}

/** `--o-name <name>` iff the Pi Scope extension is loaded, else []. */
export function buildScopeNameArgs(extPaths: string[], name: string): string[] {
  return hasPiScopeExtension(extPaths) ? ["--o-name", name] : [];
}
