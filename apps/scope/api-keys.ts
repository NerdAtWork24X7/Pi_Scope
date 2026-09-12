/**
 * api-keys.ts — user-entered API keys for the app and its pi extensions.
 *
 * Keys for app features (Groq speech-to-text) and for pi extensions that read
 * process.env (omni-router, kilo, speech-to-text, …) used to have to be exported
 * in a shell profile. That is unreliable here: the desktop launcher spawns the
 * SCOPE server from a GUI session that never sources the shell rc, so an
 * exported key never reaches it. The Settings page writes them into this store
 * instead, and they are applied in three places:
 *
 *   1. stt.ts — Groq speech-to-text reads the stored value first (see its
 *      precedence chain: Settings → env → shell rc → speech-to-text.json).
 *   2. chat.ts — every stored key is injected into the `pi` subprocess env, so
 *      extensions pick them up exactly like an exported variable.
 *   3. The Settings page — each key reports whether its effective value comes
 *      from here or from the environment, so the two can't be confused.
 *
 * File: <agentDir>/api-keys.json (mode 0600), override with SCOPE_KEYS_JSON.
 * Secrets stay server-side; the UI only ever receives a masked preview.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const AGENT_DIR = process.env.SCOPE_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");

/** Where the Settings page stores user-entered keys. */
export const KEYS_JSON = process.env.SCOPE_KEYS_JSON ?? path.join(AGENT_DIR, "api-keys.json");

export interface KnownKey {
  /** Environment-variable name, e.g. GROQ_API_KEY. */
  name: string;
  /** Short label for the Settings row. */
  label: string;
  /** What needs the key. */
  description: string;
  /** Where the user gets a key, when there's a public signup page. */
  url?: string;
}

/** Keys the app and its pi extensions read from the environment. The Settings
 *  page can also store custom names; these are the ones we can label. Extending
 *  this list is all that's needed to add a documented key. */
export const KNOWN_KEYS: KnownKey[] = [
  {
    name: "GROQ_API_KEY",
    label: "Groq",
    description: "Speech-to-text dictation in the Chat composer (Whisper transcription).",
    url: "https://console.groq.com/keys",
  },
  {
    name: "OMNI_ROUTER_API_KEY",
    label: "Omni Router",
    description: "The omni-router pi extension (it also accepts OMNIROUTE_API_KEY).",
  },
  {
    name: "KILO_API_KEY",
    label: "Kilo",
    description: "The kilo pi extension.",
  },
];

/** A stored name must be a valid environment variable name: stored keys are
 *  injected into the pi subprocess environment, so anything else could never
 *  take effect. */
const KEY_NAME_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
/** Hard cap so a paste of a whole file can't be stored. */
export const MAX_KEY_LENGTH = 8192;

export function isValidKeyName(name: string): boolean {
  return KEY_NAME_RE.test(name);
}

/** Read the store, dropping malformed entries rather than failing. */
export function readStoredKeys(): Record<string, string> {
  try {
    const raw = JSON.parse(fs.readFileSync(KEYS_JSON, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      if (KEY_NAME_RE.test(name) && typeof value === "string" && value.trim()) out[name] = value.trim();
    }
    return out;
  } catch {
    return {}; // absent or unreadable — no keys stored
  }
}

function writeStoredKeys(keys: Record<string, string>): void {
  fs.mkdirSync(path.dirname(KEYS_JSON), { recursive: true });
  // Owner-only: the file holds plaintext secrets. writeFileSync's mode only
  // applies on create, so chmod an existing file too.
  fs.writeFileSync(KEYS_JSON, JSON.stringify(keys, null, 2) + "\n", { mode: 0o600 });
  try { fs.chmodSync(KEYS_JSON, 0o600); } catch { /* best effort (e.g. odd FS) */ }
}

/** Store (or, with an empty value, remove) one key. Throws on a bad name. */
export function setStoredKey(name: string, value: string): void {
  if (!isValidKeyName(name)) throw new Error(`invalid key name: ${name}`);
  const keys = readStoredKeys();
  const trimmed = (value || "").trim();
  if (trimmed) keys[name] = trimmed;
  else delete keys[name];
  writeStoredKeys(keys);
}

/** Remove a stored key, falling back to the environment value if one exists. */
export function clearStoredKey(name: string): void {
  if (!isValidKeyName(name)) throw new Error(`invalid key name: ${name}`);
  const keys = readStoredKeys();
  if (!(name in keys)) return;
  delete keys[name];
  writeStoredKeys(keys);
}

/** The stored value for `name`, or "" — the read used by the rest of the app. */
export function storedKey(name: string): string {
  return readStoredKeys()[name] || "";
}

/** Enough of a secret to recognise it, without revealing it. */
export function maskSecret(value: string): string {
  const v = (value || "").trim();
  if (!v) return "";
  if (v.length <= 4) return "•".repeat(v.length);
  return "•".repeat(Math.min(12, v.length - 4)) + v.slice(-4);
}

export interface KeyEntry {
  name: string;
  label: string;
  description: string;
  url: string;
  /** Where the effective value comes from: this store, the server's env, or
   *  nowhere. ("shell"/"config" aren't visible here — stt.ts owns Groq's full
   *  resolution and the server overrides this entry with its answer.) */
  source: "settings" | "env" | "";
  /** Masked preview of the effective value; never the secret itself. */
  masked: string;
  /** False for user-added names that aren't in KNOWN_KEYS. */
  known: boolean;
}

/** Snapshot for the Settings page: every known key plus any custom stored key,
 *  each with its effective source and a masked preview. */
export function keyEntries(): KeyEntry[] {
  const stored = readStoredKeys();
  const out: KeyEntry[] = [];
  const seen = new Set<string>();
  const add = (name: string, label: string, description: string, url: string, known: boolean) => {
    if (seen.has(name)) return;
    seen.add(name);
    const fromStore = stored[name] || "";
    const fromEnv = (process.env[name] || "").trim();
    out.push({
      name,
      label,
      description,
      url,
      source: fromStore ? "settings" : fromEnv ? "env" : "",
      masked: maskSecret(fromStore || fromEnv),
      known,
    });
  };
  for (const k of KNOWN_KEYS) add(k.name, k.label, k.description, k.url || "", true);
  for (const name of Object.keys(stored)) add(name, name, "Custom key", "", false);
  return out;
}
