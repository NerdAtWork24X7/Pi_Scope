/**
 * pi-auth.ts — a GUI mirror of the pi coding agent's `/login` command.
 *
 * pi signs into model providers through its own auth runtime (the same code
 * `/login` drives in the TUI): an *interaction* object supplies prompts
 * (`text` / `secret` / `select` / `manual_code`) and receives notifications
 * (`auth_url`, `device_code`, `info`, `progress`). This module loads that
 * runtime from the bundled agent and exposes it to the Settings UI as an
 * HTTP-driven, poll-based login session:
 *
 *   GET  /auth/providers      → provider catalogue + stored credentials
 *   POST /auth/login          → start a login, answer a prompt, or cancel
 *   GET  /auth/login?id=      → current login state (prompt + event log)
 *   POST /auth/logout         → remove a stored credential
 *
 * Credentials land in Pi Scope's own agent dir (`auth.json`), exactly where the
 * bundled agent looks for them — logging in here is equivalent to running
 * `/login` in a pi terminal, but reachable from the browser.
 *
 * The pi runtime is imported lazily (only when the Authentication tab is first
 * used) straight out of the bundle, so Pi Scope doesn't pay to load it at boot
 * and can never disagree with the agent it ships about provider auth.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { AGENT_DIR } from "./agent-dir.ts";
import { resolvePiBundleRoot } from "./pi-bundle.ts";

/** Where the bundled agent stores credentials (matches server.ts's AUTH_JSON). */
const AUTH_JSON = process.env.SCOPE_AUTH_JSON ?? path.join(AGENT_DIR, "auth.json");
const PKG = "@earendil-works/pi-coding-agent";
/** A finished login is forgotten after this long; a running one after the second. */
const DONE_TTL_MS = 5 * 60_000;
const RUNNING_TTL_MS = 30 * 60_000;

export type AuthType = "oauth" | "api_key";

export interface AuthMethod {
  type: AuthType;
  /** Button label, e.g. "Sign in with Claude Pro/Max" or "DeepSeek API key". */
  label: string;
  /** False for ambient-only providers whose key/config lives outside pi. */
  canLogin: boolean;
}

export interface AuthProvider {
  id: string;
  name: string;
  methods: AuthMethod[];
  /** Any method already usable (stored credential, environment, …). */
  configured: boolean;
  /** The configured credential is OAuth rather than an API key. */
  usingOAuth: boolean;
  /** Human-readable effective source, e.g. "stored credential", "ANTHROPIC_API_KEY". */
  statusLabel: string;
}

export interface AuthCredential {
  providerId: string;
  name: string;
  type: AuthType;
}

export interface AuthPromptOut {
  id: number;
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: { id: string; label: string; description?: string }[];
}

export interface AuthEventOut {
  seq: number;
  type: "info" | "auth_url" | "device_code" | "progress";
  message?: string;
  url?: string;
  instructions?: string;
  links?: { url: string; label?: string }[];
  userCode?: string;
  verificationUri?: string;
}

export interface LoginState {
  id: string;
  providerId: string;
  providerName: string;
  type: AuthType;
  status: "running" | "ok" | "error" | "cancelled";
  prompt: AuthPromptOut | null;
  events: AuthEventOut[];
  error?: string;
  startedAt: number;
}

/** Server-side login bookkeeping that never leaves the process. */
interface LoginSession extends LoginState {
  controller: AbortController;
  promptSeq: number;
  eventSeq: number;
  resolvePrompt?: (value: string) => void;
  rejectPrompt?: (err: Error) => void;
}

const sessions = new Map<string, LoginSession>();

// ─── Bundled runtime (loaded on demand) ──────────────────────────────────────

let runtimePromise: Promise<any> | null = null;
// Bumped by resetAuthRuntime() so the next load imports the fresh bundle files
// (a query string makes Node treat the same path as a distinct module).
let runtimeGeneration = 0;

/** Filesystem entry of the bundled agent, or null when it can't be located. */
function bundleEntry(): string | null {
  const root = resolvePiBundleRoot();
  if (!root) return null;
  const entry = path.join(root, "node_modules", ...PKG.split("/"), "dist", "index.js");
  try { return fs.statSync(entry).isFile() ? entry : null; } catch { return null; }
}

/**
 * Drop the loaded runtime so the next authentication request re-imports the
 * bundled agent from disk. Called after Settings → Update installs a newer pi,
 * so providers added in the new release appear without restarting the server.
 */
export function resetAuthRuntime(): void {
  runtimePromise = null;
  runtimeGeneration += 1;
}

/** Whether the auth runtime can be loaded, with a reason when it can't. */
export function authBundleStatus(): { ready: boolean; reason?: string } {
  if (runtimePromise) return { ready: true };
  if (!resolvePiBundleRoot()) {
    return { ready: false, reason: "The bundled pi coding agent was not found, so provider login is unavailable." };
  }
  if (!bundleEntry()) {
    return { ready: false, reason: "The bundled pi coding agent has no loadable entry point." };
  }
  return { ready: true };
}

/** Import the bundled agent's ModelRuntime (once) and build a ModelRuntime. */
async function getRuntime(): Promise<any> {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const entry = bundleEntry();
      if (!entry) throw new Error("bundled pi coding agent not found");
      const mod: any = await import(`${pathToFileURL(entry).href}?gen=${runtimeGeneration}`);
      if (typeof mod?.ModelRuntime?.create !== "function") {
        throw new Error("bundled pi coding agent does not expose ModelRuntime");
      }
      return mod.ModelRuntime.create({ authPath: AUTH_JSON });
    })();
    // A failed load must not be cached — a later request can retry.
    runtimePromise.catch(() => { runtimePromise = null; });
  }
  return runtimePromise;
}

/** Stable per-installation id some login flows send as an agent host id. */
function deviceId(): string {
  const file = path.join(AGENT_DIR, "device-id");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch { /* first use */ }
  const id = crypto.randomUUID();
  try { fs.writeFileSync(file, id, { mode: 0o600 }); } catch { /* best effort */ }
  return id;
}

// ─── Provider catalogue ──────────────────────────────────────────────────────

/** Effective auth status, mirroring the TUI's `formatAuthSelectorProviderStatus`. */
function describeAuth(runtime: any, provider: any): Pick<AuthProvider, "configured" | "usingOAuth" | "statusLabel"> {
  const status = runtime.getProviderAuthStatus(provider.id) || { configured: false };
  const usingOAuth = runtime.isUsingOAuth(provider.id);
  if (!status.configured) return { configured: false, usingOAuth: false, statusLabel: "" };
  let label: string;
  if (usingOAuth) label = "OAuth";
  else if (status.source === "environment") label = status.label || "environment";
  else if (status.source === "stored") label = "stored credential";
  else if (status.source === "runtime") label = "session key";
  else label = status.label || status.source || "configured";
  return { configured: true, usingOAuth, statusLabel: label };
}

function methodsOf(provider: any): AuthMethod[] {
  const methods: AuthMethod[] = [];
  const auth = provider.auth || {};
  if (auth.oauth) {
    methods.push({
      type: "oauth",
      label: auth.oauth.loginLabel || "Sign in with an account",
      canLogin: typeof auth.oauth.login === "function",
    });
  }
  if (auth.apiKey) {
    methods.push({
      type: "api_key",
      label: auth.apiKey.name || "API key",
      canLogin: typeof auth.apiKey.login === "function",
    });
  }
  return methods;
}

export interface AuthSnapshot {
  ready: boolean;
  reason?: string;
  providers: AuthProvider[];
  credentials: AuthCredential[];
}

/** Provider catalogue (usable by `/login`) plus the stored credentials. */
export async function listAuthProviders(): Promise<AuthSnapshot> {
  const availability = authBundleStatus();
  if (!availability.ready) return { ...availability, providers: [], credentials: [] };
  const runtime = await getRuntime();

  const providers: AuthProvider[] = [];
  for (const provider of runtime.getProviders()) {
    const methods = methodsOf(provider);
    if (!methods.length) continue;
    providers.push({
      id: provider.id,
      name: provider.name,
      methods,
      ...describeAuth(runtime, provider),
    });
  }
  providers.sort((a, b) => a.name.localeCompare(b.name));

  const credentials: AuthCredential[] = (await runtime.listCredentials({ signal: AbortSignal.timeout(15_000) }))
    .map((c: any) => ({
      providerId: c.providerId,
      name: runtime.getProvider(c.providerId)?.name || c.providerId,
      type: c.type,
    }))
    .sort((a: AuthCredential, b: AuthCredential) => a.name.localeCompare(b.name));

  return { ready: true, providers, credentials };
}

// ─── Login sessions ──────────────────────────────────────────────────────────

function pruneSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    const ttl = session.status === "running" ? RUNNING_TTL_MS : DONE_TTL_MS;
    if (now - session.startedAt <= ttl) continue;
    if (session.status === "running") {
      try { session.controller.abort(); } catch { /* already gone */ }
    }
    sessions.delete(id);
  }
}

/** Public, serializable view of a session (no resolver closures). */
export function getLogin(id: string): LoginState | null {
  const session = sessions.get(id);
  if (!session) return null;
  return {
    id: session.id,
    providerId: session.providerId,
    providerName: session.providerName,
    type: session.type,
    status: session.status,
    prompt: session.prompt,
    events: session.events,
    error: session.error,
    startedAt: session.startedAt,
  };
}

/**
 * Start a `/login`-equivalent flow for `providerId` and the given method.
 * Resolves with the initial session state; the flow continues in the background
 * and is observed through `getLogin` until its status is no longer "running".
 */
export async function startLogin(providerId: string, type: string): Promise<LoginState> {
  const runtime = await getRuntime();
  const provider = runtime.getProvider(providerId);
  if (!provider) throw new Error(`unknown provider: ${providerId}`);
  const authType: AuthType | null = type === "oauth" ? "oauth" : type === "api_key" ? "api_key" : null;
  if (!authType) throw new Error(`invalid auth type: ${type}`);
  const method = authType === "oauth" ? provider.auth?.oauth : provider.auth?.apiKey;
  if (!method) throw new Error(`${provider.name} does not support ${authType === "oauth" ? "account sign-in" : "API key sign-in"}`);
  if (typeof method.login !== "function") {
    throw new Error(`${provider.name} is configured outside pi (${method.name || "ambient credentials"}).`);
  }

  pruneSessions();
  const id = crypto.randomUUID();
  const session: LoginSession = {
    id,
    providerId,
    providerName: provider.name,
    type: authType,
    status: "running",
    prompt: null,
    events: [],
    startedAt: Date.now(),
    controller: new AbortController(),
    promptSeq: 0,
    eventSeq: 0,
  };
  sessions.set(id, session);

  const notify = (event: any): void => {
    const seq = ++session.eventSeq;
    if (event?.type === "auth_url") {
      session.events.push({ seq, type: "auth_url", url: event.url, instructions: event.instructions });
    } else if (event?.type === "device_code") {
      session.events.push({ seq, type: "device_code", userCode: event.userCode, verificationUri: event.verificationUri });
    } else if (event?.type === "info") {
      session.events.push({ seq, type: "info", message: event.message, links: event.links });
    } else {
      session.events.push({ seq, type: "progress", message: event?.message });
    }
  };

  // A pending prompt is stored on the session and resolved by answerLogin().
  const prompt = (p: any): Promise<string> => new Promise<string>((resolve, reject) => {
    if (session.controller.signal.aborted) { reject(new Error("Login cancelled")); return; }
    const promptId = ++session.promptSeq;
    session.prompt = {
      id: promptId,
      type: p.type,
      message: p.message,
      placeholder: p.placeholder,
      options: p.options,
    };
    const clear = () => { if (session.prompt?.id === promptId) session.prompt = null; };
    session.resolvePrompt = (value) => { clear(); resolve(value); };
    session.rejectPrompt = (err) => { clear(); reject(err); };
    // pi aborts a prompt's own signal when an out-of-band event (e.g. the OAuth
    // callback server) resolves that step first — reject it like the TUI does.
    p.signal?.addEventListener("abort", () => { clear(); reject(new Error("Login cancelled")); }, { once: true });
  });

  void (async () => {
    try {
      await runtime.login(providerId, authType, { signal: session.controller.signal, prompt, notify }, { getDeviceId: deviceId });
      session.status = "ok";
    } catch (err: any) {
      if (session.controller.signal.aborted) session.status = "cancelled";
      else { session.status = "error"; session.error = String(err?.message || err); }
    } finally {
      session.prompt = null;
      session.resolvePrompt = undefined;
      session.rejectPrompt = undefined;
    }
  })();

  return getLogin(id)!;
}

/** Answer the pending prompt of a login session. False when it doesn't match. */
export function answerLogin(id: string, promptId: number, value: string): boolean {
  const session = sessions.get(id);
  if (!session || session.status !== "running") return false;
  if (!session.prompt || session.prompt.id !== promptId || !session.resolvePrompt) return false;
  const resolve = session.resolvePrompt;
  session.resolvePrompt = undefined;
  session.rejectPrompt = undefined;
  session.prompt = null;
  resolve(value);
  return true;
}

/** Abort a running login (user pressed Cancel). */
export function cancelLogin(id: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  if (session.status === "running") {
    session.status = "cancelled";
    try { session.rejectPrompt?.(new Error("Login cancelled")); } catch { /* ignore */ }
    session.rejectPrompt = undefined;
    session.resolvePrompt = undefined;
    session.prompt = null;
    try { session.controller.abort(); } catch { /* already gone */ }
  }
  return true;
}

/** Remove a provider's stored credential (pi's `/logout`). */
export async function logoutProvider(providerId: string): Promise<void> {
  const runtime = await getRuntime();
  if (!runtime.getProvider(providerId)) throw new Error(`unknown provider: ${providerId}`);
  await runtime.logout(providerId);
}
