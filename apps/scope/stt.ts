/**
 * stt.ts — speech to text for the chat composer.
 *
 * Mirrors the pi `speech-to-text` extension's pipeline: record the host
 * microphone with a local recorder (`sox` / `arecord` / `ffmpeg`) into a mono
 * 16-bit WAV, then POST it to Groq's OpenAI-compatible transcription endpoint
 * (Whisper). Configuration is read from the same places the extension reads it:
 *
 *   GROQ_API_KEY / GROQ_STT_*  →  <project>/.pi/speech-to-text.json
 *                              →  <agentDir>/speech-to-text.json  →  defaults
 *
 * The web Chat view only reveals its microphone when the pi `speech-to-text`
 * extension is enabled (settings.json `extensions` list). These endpoints work
 * standalone, but the extension is what tells the UI the feature is installed.
 *
 * One recording at a time — there is a single host microphone. `stopStt()` is
 * idempotent and returns the transcript, so a client that misses the
 * auto-stop (max duration cap) still gets its text.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { storedKey } from "./api-keys.ts";

const AGENT_DIR = process.env.SCOPE_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";
const DEFAULT_MODEL = "whisper-large-v3-turbo";
const RECORDER_KINDS: RecorderKind[] = ["sox", "arecord", "ffmpeg"];

/** dBFS mapped to the bottom of the level meter (below this the bar is empty). */
const FLOOR_DB = -60;
/** Per-tick decay applied to the displayed level (matches ~150 ms polling). */
const LEVEL_DECAY = 0.8;
/** Most audio read in one meter tick — enough for a tick or two of lag. */
const MAX_TICK_SECONDS = 0.25;
/** Level considered "signal present" for the no-signal hint. */
const SILENCE_LEVEL = 0.06;

export type RecorderKind = "sox" | "arecord" | "ffmpeg";

export interface SttConfig {
  apiKey: string;
  /** Where apiKey came from: the Settings page ("settings"), the process env,
   *  the shell rc ("shell"), speech-to-text.json ("config"), or "". */
  apiKeySource: "settings" | "env" | "shell" | "config" | "";
  model: string;
  language: string;
  prompt: string;
  maxDurationSeconds: number;
  sampleRate: number;
  recorder: string;
  keepAudio: boolean;
}

/** Normalized reply for the /chat/stt/* routes. */
export interface SttResult {
  ok: boolean;
  text: string;
  model?: string;
  elapsedMs?: number;
  error?: string;
}

interface RecorderHandle {
  kind: RecorderKind;
  bin: string;
  file: string;
  proc: ChildProcess;
  stopped: boolean;
  stderr: string;
}

interface ActiveStt {
  cwd: string;
  startedAt: number;
  config: SttConfig;
  handle: RecorderHandle;
  maxTimer: NodeJS.Timeout | null;
  /** Set once the recorder stopped and transcription finished (auto-stop). */
  ready: SttResult | null;
  /** In-flight stop, so concurrent stop calls join instead of racing. */
  stopping: Promise<SttResult> | null;
  /** Live level meter reading the WAV the recorder is still writing. */
  meter: AudioLevelMeter;
}

let active: ActiveStt | null = null;
/** Last successful transcript, so a stop after an auto-stop still returns text. */
let lastResult: { at: number; result: SttResult } | null = null;
const LAST_RESULT_TTL_MS = 2 * 60 * 1000;

// ─── Config (mirrors the pi extension's resolution order) ────────────────────

function globalConfigPath(): string {
  return path.join(AGENT_DIR, "speech-to-text.json");
}
function projectConfigPath(cwd: string): string {
  return path.join(cwd, ".pi", "speech-to-text.json");
}

/** Shell rc files an interactive terminal sources, in the order we check them.
 *  A GUI/desktop-launched server never reads these, so variables exported only
 *  there are invisible to it — the same problem `chatChildEnv` solves for
 *  PLAYWRIGHT_BROWSERS_PATH. */
function shellRcFiles(): string[] {
  const home = os.homedir();
  return [".zshenv", ".zshrc", ".bash_profile", ".bashrc", ".profile"]
    .map((f) => path.join(home, f))
    .filter((p) => fs.existsSync(p));
}

/** Scan the user's shell rc files for `export NAME=value` (quotes and a leading
 *  `~`/`$HOME` are handled). Returns "" when nothing is found. */
function readShellEnv(name: string): string {
  const home = os.homedir();
  const expand = (v: string) => v.replace(/^~(?=\/|$)/, home).replace(/\$\{HOME\}|\$HOME/g, home);
  for (const rc of shellRcFiles()) {
    let content: string;
    try { content = fs.readFileSync(rc, "utf8"); } catch { continue; }
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const assignment = line.startsWith("export ") ? line.slice(7).trim() : line;
      const eq = assignment.indexOf("=");
      if (eq <= 0 || assignment.slice(0, eq).trim() !== name) continue;
      const val = assignment.slice(eq + 1).trim().replace(/^(['\"])(.*)\1$/, "$2").trim();
      if (val) return expand(val);
    }
  }
  return "";
}

/** Resolve GROQ_* variables the way the user's interactive terminal would: the
 *  server's own env first, then the shell rc files (see readShellEnv). Only
 *  non-empty results are cached, so a key the user adds to their profile after
 *  the server started is picked up without a restart. */
const shellEnvCache = new Map<string, string>();
function shellEnvValue(name: string): string {
  const direct = (process.env[name] || "").trim();
  if (direct) return direct;
  const cached = shellEnvCache.get(name);
  if (cached) return cached;
  const found = readShellEnv(name);
  if (found) shellEnvCache.set(name, found);
  return found;
}

function readJson(file: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function num(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}
function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}
function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}
function envBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  switch (value.trim().toLowerCase()) {
    case "1": case "true": case "on": case "yes": return true;
    case "0": case "false": case "off": case "no": return false;
    default: return fallback;
  }
}

/** Effective STT config for a workspace. Never throws — bad files fall back. */
export function loadSttConfig(cwd: string): SttConfig {
  const merged: Record<string, unknown> = {
    ...readJson(globalConfigPath()),
    ...readJson(projectConfigPath(cwd)),
  };
  const env = process.env;
  const language = str(env.GROQ_STT_LANGUAGE ?? merged.language, "");
  // A key entered on the Settings page wins (that is an explicit user choice,
  // and it's what makes the feature work under a desktop launch that never
  // sourced the shell). Then env, the shell rc, and finally the extension's own
  // speech-to-text.json. The pi extension reads the same GROQ_API_KEY.
  const savedKey = storedKey("GROQ_API_KEY") || storedKey("GROQ_STT_API_KEY");
  const envKey = shellEnvValue("GROQ_API_KEY") || shellEnvValue("GROQ_STT_API_KEY");
  const fileKey = str(merged.apiKey, "");
  const fromProcess = !!(env.GROQ_API_KEY || "").trim() || !!(env.GROQ_STT_API_KEY || "").trim();
  return {
    apiKey: savedKey || envKey || fileKey,
    apiKeySource: savedKey ? "settings" : envKey ? (fromProcess ? "env" : "shell") : fileKey ? "config" : "",
    model: str(env.GROQ_STT_MODEL ?? merged.model, DEFAULT_MODEL),
    language: language.toLowerCase() === "auto" ? "" : language,
    prompt: str(merged.prompt, ""),
    maxDurationSeconds: clamp(num(env.GROQ_STT_MAX_SECONDS ?? merged.maxDurationSeconds, 120), 5, 600),
    sampleRate: clamp(num(merged.sampleRate, 16000), 8000, 48000),
    recorder: str(env.GROQ_STT_RECORDER ?? merged.recorder, "auto") || "auto",
    keepAudio: envBool(env.GROQ_STT_KEEP_AUDIO, bool(merged.keepAudio, false)),
  };
}

// ─── Recorder discovery / capture ────────────────────────────────────────────

/** Is `bin` resolvable on PATH (plus the common system dirs)? */
export function which(bin: string): boolean {
  const dirs = [
    ...(process.env.PATH || "").split(path.delimiter),
    "/usr/local/bin",
    "/usr/bin",
    path.join(os.homedir(), ".local", "bin"),
  ].filter(Boolean);
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  return dirs.some((dir) => exts.some((ext) => {
    try { fs.accessSync(path.join(dir, bin + ext), fs.constants.X_OK); return true; }
    catch { return false; }
  }));
}

function binFor(kind: RecorderKind): string {
  return kind === "sox" ? "rec" : kind === "arecord" ? "arecord" : "ffmpeg";
}

/** First usable recorder, honoring an explicit config preference. Throws with a
 *  user-facing message when none is installed. */
export function detectRecorder(preference: string): RecorderKind {
  const wanted = (preference || "auto").toLowerCase();
  if (wanted !== "auto") {
    if (!(RECORDER_KINDS as string[]).includes(wanted)) {
      throw new Error(`Unknown recorder "${preference}" (expected auto, ${RECORDER_KINDS.join(", ")})`);
    }
    const kind = wanted as RecorderKind;
    if (!which(binFor(kind))) throw new Error(`Recorder "${kind}" (${binFor(kind)}) not found on PATH`);
    return kind;
  }
  for (const kind of RECORDER_KINDS) {
    if (which(binFor(kind))) return kind;
  }
  throw new Error("No audio recorder found. Install one of: sox (rec), alsa-utils (arecord), or ffmpeg.");
}

function buildArgs(kind: RecorderKind, cfg: SttConfig, file: string): string[] {
  const rate = String(cfg.sampleRate);
  if (kind === "sox") {
    return ["-q", "-c", "1", "-r", rate, "-b", "16", file];
  }
  if (kind === "arecord") {
    return ["-q", "-f", "S16_LE", "-r", rate, "-c", "1", "-t", "wav", file];
  }
  const input =
    process.platform === "darwin"
      ? ["-f", "avfoundation", "-i", ":0"]
      : process.platform === "win32"
        ? ["-f", "dshow", "-i", "audio=default"]
        : ["-f", "pulse", "-i", "default"];
  return ["-hide_banner", "-loglevel", "error", "-y", ...input, "-ac", "1", "-ar", rate, "-c:a", "pcm_s16le", file];
}

function startRecorder(cfg: SttConfig, file: string): RecorderHandle {
  const kind = detectRecorder(cfg.recorder);
  const bin = binFor(kind);
  const handle: RecorderHandle = { kind, bin, file, stopped: false, stderr: "", proc: undefined as unknown as ChildProcess };
  // ffmpeg is stopped gracefully by writing "q" to stdin; the others only need a signal.
  const stdin = kind === "ffmpeg" ? "pipe" : "ignore";
  const proc = spawn(bin, buildArgs(kind, cfg, file), { stdio: [stdin, "ignore", "pipe"] });
  handle.proc = proc;
  proc.stderr?.on("data", (chunk: Buffer) => {
    handle.stderr = (handle.stderr + chunk.toString()).slice(-2000);
  });
  return handle;
}

function waitExit(proc: ChildProcess, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    const timer = setTimeout(() => { proc.removeListener("exit", onExit); resolve(); }, ms);
    const onExit = () => { clearTimeout(timer); resolve(); };
    proc.once("exit", onExit);
  });
}

/** Stop a recorder, finalizing the WAV. Safe to call more than once. */
async function stopRecorder(handle: RecorderHandle): Promise<void> {
  if (handle.stopped) return;
  handle.stopped = true;
  const proc = handle.proc;
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  try {
    if (handle.kind === "ffmpeg" && proc.stdin && proc.stdin.writable) proc.stdin.write("q");
  } catch { /* stdin already closed */ }
  try { proc.kill("SIGINT"); } catch { /* already gone */ }
  await waitExit(proc, 2500);
  if (proc.exitCode === null && proc.signalCode === null) {
    try { proc.kill("SIGKILL"); } catch { /* already gone */ }
    await waitExit(proc, 1000);
  }
}

/** True when the capture produced audio (not just a bare WAV header). */
function hasAudio(file: string): boolean {
  try { return fs.statSync(file).size > 1024; } catch { return false; }
}

function cleanupAudio(file: string, keep: boolean): void {
  if (keep) return;
  try { fs.rmSync(file, { force: true }); } catch { /* already gone */ }
}

// ─── Live audio level meter ──────────────────────────────────────────────────
// Reads the WAV the recorder is *still writing* and computes an RMS level from
// the PCM appended since the last tick. Dependency-free and recorder-agnostic:
// the growing WAV is the one artifact sox, arecord and ffmpeg all produce the
// same way. Ported from the pi speech-to-text extension's level meter so the
// web composer shows the same bar its terminal footer does.

function analyzeAudio(buf: Buffer): number {
  const samples = buf.length >> 1; // 16-bit mono
  if (samples === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < samples; i++) {
    const s = buf.readInt16LE(i * 2) / 32768;
    sumSquares += s * s;
  }
  return Math.sqrt(sumSquares / samples);
}

/** Map an RMS amplitude (0..1) onto 0..1 along a dBFS scale. */
function normalizeLevel(rms: number): number {
  const db = 20 * Math.log10(Math.max(rms, 1e-6));
  return Math.min(1, Math.max(0, (db - FLOOR_DB) / -FLOOR_DB));
}

export class AudioLevelMeter {
  private fd: number | null = null;
  /** Byte offset of the first PCM sample, or -1 until the header is parsed. */
  private dataOffset = -1;
  /** Absolute offset of the next unread sample byte. */
  private readOffset = 0;
  private level = 0;
  private lastLoudAt = Date.now();
  // Plain fields, not constructor parameter properties: Node runs these .ts
  // files with type-stripping only, which rejects that shorthand.
  private readonly file: string;
  private readonly sampleRate: number;

  constructor(file: string, sampleRate: number) {
    this.file = file;
    this.sampleRate = sampleRate;
  }

  /** Smoothed level (0..1) of the audio appended since the last call. Never
   *  throws — a mid-flush or not-yet-created file just decays. */
  sample(): number {
    try {
      const size = fs.statSync(this.file).size;
      if (this.fd === null) this.fd = fs.openSync(this.file, "r");
      if (this.dataOffset < 0) this.dataOffset = this.findDataOffset(size);
      if (this.dataOffset < 0) return this.decay();

      if (this.readOffset === 0) this.readOffset = this.dataOffset;
      if (size <= this.readOffset) return this.decay();

      // Cap the read so a stalled tick can't buffer a huge window or report a
      // stale level: keep only the most recent slice of audio.
      const windowBytes = Math.max(1024, Math.floor(this.sampleRate * 2 * MAX_TICK_SECONDS));
      let from = this.readOffset;
      if (size - from > windowBytes) from = Math.max(this.dataOffset, size - windowBytes);

      const len = size - from;
      const buf = Buffer.allocUnsafe(len);
      const read = fs.readSync(this.fd, buf, 0, len, from);
      this.readOffset = size;
      if (read <= 0) return this.decay();

      const level = normalizeLevel(analyzeAudio(read === len ? buf : buf.subarray(0, read)));
      if (level >= SILENCE_LEVEL) this.lastLoudAt = Date.now();
      this.level = Math.max(level, this.level * LEVEL_DECAY);
      return this.level;
    } catch {
      // The recorder may not have created the file yet, or be mid-flush.
      return this.decay();
    }
  }

  /** How long the signal has been at/below the silence threshold, in ms. */
  silentForMs(): number {
    const silent = Date.now() - this.lastLoudAt;
    return silent > 0 ? silent : 0;
  }

  close(): void {
    if (this.fd === null) return;
    try { fs.closeSync(this.fd); } catch { /* ignore */ }
    this.fd = null;
  }

  private decay(): number {
    this.level *= LEVEL_DECAY;
    return this.level;
  }

  /** Locate the PCM payload by walking the RIFF chunks for `data`; -1 when the
   *  header isn't written yet. */
  private findDataOffset(size: number): number {
    if (this.fd === null || size < 12) return -1;
    const head = Buffer.allocUnsafe(Math.min(size, 4096));
    const read = fs.readSync(this.fd, head, 0, head.length, 0);
    if (read < 12) return -1;
    if (head.toString("ascii", 0, 4) !== "RIFF" || head.toString("ascii", 8, 12) !== "WAVE") return -1;

    let pos = 12;
    while (pos + 8 <= read) {
      const id = head.toString("ascii", pos, pos + 4);
      const chunkSize = head.readUInt32LE(pos + 4);
      if (id === "data") return pos + 8;
      // Streaming writers (ffmpeg) leave the data size unset; an implausible
      // size means we can't walk past this chunk.
      if (chunkSize === 0 || chunkSize > 0x7fffffff) break;
      pos += 8 + chunkSize + (chunkSize % 2); // chunks are word-aligned
    }

    // Fallback for headers whose sizes don't walk cleanly (vendor extensions,
    // partially flushed headers): locate the `data` marker itself.
    const marker = head.subarray(12, read).indexOf("data");
    return marker >= 0 ? 12 + marker + 8 : -1;
  }
}

// ─── Transcription ───────────────────────────────────────────────────────────

function describeGroqError(status: number, body: string): string {
  const snippet = body.replace(/\s+/g, " ").trim().slice(0, 300);
  if (status === 401 || status === 403) return `Groq rejected the API key (HTTP ${status}). Check GROQ_API_KEY. ${snippet}`;
  if (status === 413) return `Recording too large for Groq (HTTP 413). Try a shorter clip. ${snippet}`;
  if (status === 429) return `Groq rate limit hit (HTTP 429). Wait a moment and retry. ${snippet}`;
  return `Groq transcription failed (HTTP ${status}). ${snippet}`;
}

/** POST a local WAV to Groq's transcription endpoint. Throws a user-facing error. */
async function transcribe(cfg: SttConfig, file: string): Promise<{ text: string; model: string; elapsedMs: number }> {
  const audio = await readFile(file);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), path.basename(file));
  form.append("model", cfg.model);
  form.append("response_format", "json");
  form.append("temperature", "0");
  if (cfg.language) form.append("language", cfg.language);
  if (cfg.prompt) form.append("prompt", cfg.prompt);

  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(GROQ_ENDPOINT, { method: "POST", headers: { Authorization: `Bearer ${cfg.apiKey}` }, body: form });
  } catch (err) {
    throw new Error(`Could not reach Groq: ${err instanceof Error ? err.message : String(err)}`);
  }
  const raw = await res.text();
  if (!res.ok) throw new Error(describeGroqError(res.status, raw));

  let text = "";
  try {
    const parsed = JSON.parse(raw) as { text?: unknown };
    text = typeof parsed.text === "string" ? parsed.text : "";
  } catch {
    throw new Error(`Unexpected Groq response: ${raw.slice(0, 300)}`);
  }
  return { text: text.trim(), model: cfg.model, elapsedMs: Date.now() - startedAt };
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface SttStartInfo {
  ok: boolean;
  reused?: boolean;
  startedAt?: number;
  recorder?: string;
  model?: string;
  maxDurationSeconds?: number;
  error?: string;
}

/** Start (or join) the single host recording. */
export function startStt(cwd: string): SttStartInfo {
  if (active) {
    if (active.ready) return { ok: false, error: "the previous clip is still being transcribed" };
    return {
      ok: true,
      reused: true,
      startedAt: active.startedAt,
      recorder: active.handle.kind,
      model: active.config.model,
      maxDurationSeconds: active.config.maxDurationSeconds,
    };
  }

  const config = loadSttConfig(cwd);
  if (!config.apiKey) {
    return {
      ok: false,
      error:
        "GROQ_API_KEY is not set — add it under Settings → API Keys " +
        "(or export it in your shell profile, or add \"apiKey\" to speech-to-text.json)",
    };
  }

  const file = path.join(os.tmpdir(), `scope-stt-${process.pid}-${Date.now()}.wav`);
  let handle: RecorderHandle;
  try {
    handle = startRecorder(config, file);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const state: ActiveStt = {
    cwd,
    startedAt: Date.now(),
    config,
    handle,
    maxTimer: null,
    ready: null,
    stopping: null,
    meter: new AudioLevelMeter(file, config.sampleRate),
  };
  active = state;
  // Hard cap on a single clip, like the extension's maxDurationSeconds.
  state.maxTimer = setTimeout(() => { void stopStt(); }, config.maxDurationSeconds * 1000);
  state.maxTimer.unref?.();
  return {
    ok: true,
    startedAt: state.startedAt,
    recorder: handle.kind,
    model: config.model,
    maxDurationSeconds: config.maxDurationSeconds,
  };
}

/** Stop the recording (if any) and return its transcript. Idempotent: a stop
 *  after the auto-stop returns the cached transcript. */
export async function stopStt(): Promise<SttResult> {
  const cur = active;

  if (!cur) {
    if (lastResult && Date.now() - lastResult.at < LAST_RESULT_TTL_MS) return lastResult.result;
    return { ok: false, text: "", error: "not recording" };
  }
  if (cur.stopping) return cur.stopping;
  if (cur.ready) {
    if (cur.maxTimer) clearTimeout(cur.maxTimer);
    cur.meter.close();
    active = null;
    lastResult = { at: Date.now(), result: cur.ready };
    return cur.ready;
  }

  cur.stopping = (async (): Promise<SttResult> => {
    if (cur.maxTimer) clearTimeout(cur.maxTimer);
    await stopRecorder(cur.handle);
    cur.meter.close();
    let result: SttResult;
    if (!hasAudio(cur.handle.file)) {
      const stderr = cur.handle.stderr.trim().split("\n").pop() || "";
      result = { ok: false, text: "", error: stderr ? `no audio captured (${stderr})` : "no audio captured" };
    } else {
      try {
        const t = await transcribe(cur.config, cur.handle.file);
        result = { ok: true, text: t.text, model: t.model, elapsedMs: t.elapsedMs };
        lastResult = { at: Date.now(), result };
      } catch (err) {
        result = { ok: false, text: "", error: err instanceof Error ? err.message : String(err) };
      }
    }
    cleanupAudio(cur.handle.file, cur.config.keepAudio);
    active = null;
    return result;
  })();

  return cur.stopping;
}

/** Snapshot for the composer: whether a recording is live and whether the host
 *  can record / transcribe at all. */
export function sttStatus(cwd: string): {
  recording: boolean;
  startedAt: number | null;
  elapsedMs: number;
  recorder: string | null;
  recorderAvailable: boolean;
  hasApiKey: boolean;
  apiKeySource: "settings" | "env" | "shell" | "config" | "";
  model: string;
  maxDurationSeconds: number;
} {
  // While recording the status endpoint is polled for the level meter (~7/s),
  // so reuse the live session's config/recorder instead of re-reading the
  // speech-to-text.json files and re-probing PATH on every tick.
  const config = active ? active.config : loadSttConfig(cwd);
  let recorderAvailable = !!active;
  let recorder: string | null = active ? active.handle.kind : null;
  if (!active) {
    try { recorder = detectRecorder(config.recorder); recorderAvailable = true; } catch { /* none installed */ }
  }
  return {
    recording: !!active && !active.ready,
    startedAt: active ? active.startedAt : null,
    elapsedMs: active ? Date.now() - active.startedAt : 0,
    // Live RMS level (0..1) of the audio appended since the last poll, plus how
    // long it has been quiet — the composer renders these as a level bar.
    level: active && !active.ready ? active.meter.sample() : 0,
    silentMs: active && !active.ready ? active.meter.silentForMs() : 0,
    recorder,
    recorderAvailable,
    hasApiKey: !!config.apiKey,
    // Lets the UI say *where* the key is missing from when it isn't set.
    apiKeySource: config.apiKeySource,
    model: config.model,
    maxDurationSeconds: config.maxDurationSeconds,
  };
}

/** Kill any live recording without transcribing (server shutdown). */
export function abortStt(): void {
  const cur = active;
  active = null;
  lastResult = null;
  if (!cur) return;
  if (cur.maxTimer) clearTimeout(cur.maxTimer);
  cur.meter.close();
  void stopRecorder(cur.handle).then(() => cleanupAudio(cur.handle.file, false)).catch(() => {});
}
