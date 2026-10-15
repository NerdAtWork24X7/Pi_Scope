/**
 * Speech-to-Text — configuration.
 *
 * Resolution order (first hit wins per field):
 *   environment variable  →  project .pi/speech-to-text.json  →  global
 *   <agentDir>/speech-to-text.json  →  built-in default
 *
 * The API key is intentionally env-first so the secret never has to live in a
 * committed config file:  export GROQ_API_KEY=gsk_...
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

/** Which recorder binary the extension may drive. Every kind is accepted in
 *  config on every platform; availability is decided by PROBE_ORDER + PATH. */
export type RecorderKind = "sox" | "arecord" | "ffmpeg";
export const RECORDER_KINDS: RecorderKind[] = ["sox", "arecord", "ffmpeg"];

/** Probe order for `recorder: "auto"`, per platform.
 *
 *  - Linux:   sox, arecord (ALSA), ffmpeg. sox first — it gives silence
 *             detection and a clean SIGINT finalization.
 *  - macOS:   sox, ffmpeg (avfoundation). `arecord` is ALSA-only, so it is
 *             never probed there.
 *  - Windows: ffmpeg first — the only backend that finalizes the WAV on a
 *             stdin `"q"`, and the most commonly installed there. sox
 *             (`rec.exe`) is a fallback that can only be stopped by a hard
 *             terminate, which leaves the RIFF size fields unwritten.
 *             `arecord` does not exist on Windows. */
export const PROBE_ORDER: RecorderKind[] =
	process.platform === "win32"
		? ["ffmpeg", "sox"]
		: process.platform === "darwin"
			? ["sox", "ffmpeg"]
			: ["sox", "arecord", "ffmpeg"];

export const DEFAULT_MODEL = "whisper-large-v3-turbo";

export interface SttConfig {
	/** Groq API key (required to transcribe). */
	apiKey: string;
	/** Groq transcription model id. */
	model: string;
	/** ISO-639-1 language hint, or "" to let Whisper auto-detect. */
	language: string;
	/** Optional vocabulary/context prompt passed to Whisper. */
	prompt: string;
	/** Hard cap on a single recording, in seconds. */
	maxDurationSeconds: number;
	/** How long to wait, in ms, after the last alt+t event of a hold before
	 *  deciding the key was released. This gap is the only release signal on
	 *  terminals that never report key releases (xterm modifyOtherKeys, legacy
	 *  terminals, re-encoding pipelines); where releases do arrive they end the
	 *  clip immediately and the gap becomes a safety net. */
	holdReleaseGapMs: number;
	/** Stop automatically when sox hears trailing silence. */
	silenceAutoStop: boolean;
	/** "auto" or an explicit recorder kind. */
	recorder: string;
	/** Keep the recorded WAV on disk instead of deleting it after use. */
	keepAudio: boolean;
	/** Capture sample rate in Hz. */
	sampleRate: number;
	/** Show a live audio level meter in the recording status line. */
	levelMeter: boolean;
	/** Runtime on/off switch (see the /stt command). */
	enabled: boolean;
}

const DEFAULTS: SttConfig = {
	apiKey: "",
	model: DEFAULT_MODEL,
	language: "",
	prompt: "",
	maxDurationSeconds: 120,
	holdReleaseGapMs: 900,
	silenceAutoStop: false,
	recorder: "auto",
	keepAudio: false,
	sampleRate: 16000,
	levelMeter: true,
	enabled: true,
};

function readJson(path: string): Partial<SttConfig> {
	try {
		if (!existsSync(path)) return {};
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" ? (parsed as Partial<SttConfig>) : {};
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

/** Parse a boolean-ish environment variable ("1", "off", …). */
function envBool(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	switch (value.trim().toLowerCase()) {
		case "1":
		case "true":
		case "on":
		case "yes":
			return true;
		case "0":
		case "false":
		case "off":
		case "no":
			return false;
		default:
			return fallback;
	}
}

/** Global config path (same directory pi stores auth.json/settings in). */
export function globalConfigPath(): string {
	return join(getAgentDir(), "speech-to-text.json");
}

/** Project-local config path. */
export function projectConfigPath(cwd: string): string {
	return join(cwd, ".pi", "speech-to-text.json");
}

/** Load the effective config. Never throws — a broken file falls back to defaults. */
export function loadConfig(cwd: string): SttConfig {
	const global = readJson(globalConfigPath());
	const project = readJson(projectConfigPath(cwd));
	const merged: Partial<SttConfig> = { ...global, ...project };
	const env = process.env;

	// "auto" is the documented value for auto-detect; an empty string means auto too.
	const recorder = str(env.GROQ_STT_RECORDER ?? merged.recorder, DEFAULTS.recorder);
	const language = str(env.GROQ_STT_LANGUAGE ?? merged.language, DEFAULTS.language);

	return {
		apiKey:
			process.env.GROQ_API_KEY?.trim() ||
			process.env.GROQ_STT_API_KEY?.trim() ||
			str(merged.apiKey, ""),
		model: str(env.GROQ_STT_MODEL ?? merged.model, DEFAULTS.model),
		language: language.toLowerCase() === "auto" ? "" : language,
		prompt: str(merged.prompt, DEFAULTS.prompt),
		maxDurationSeconds: clamp(
			num(env.GROQ_STT_MAX_SECONDS ?? merged.maxDurationSeconds, DEFAULTS.maxDurationSeconds),
			5,
			600,
		),
		holdReleaseGapMs: clamp(
			num(env.GROQ_STT_HOLD_RELEASE_MS ?? merged.holdReleaseGapMs, DEFAULTS.holdReleaseGapMs),
			200,
			5000,
		),
		silenceAutoStop: bool(merged.silenceAutoStop, DEFAULTS.silenceAutoStop),
		recorder: recorder || DEFAULTS.recorder,
		keepAudio: bool(merged.keepAudio, DEFAULTS.keepAudio),
		sampleRate: clamp(num(merged.sampleRate, DEFAULTS.sampleRate), 8000, 48000),
		levelMeter: envBool(process.env.GROQ_STT_METER, bool(merged.levelMeter, DEFAULTS.levelMeter)),
		enabled: true,
	};
}
