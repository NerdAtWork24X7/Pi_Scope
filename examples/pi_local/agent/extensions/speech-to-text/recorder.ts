/**
 * Speech-to-Text — microphone capture.
 *
 * Drives whichever recorder is available on the host and writes a mono 16-bit
 * PCM WAV, which is the format Groq's transcription endpoint wants. Three
 * backends are supported; `recorder: "auto"` probes them in PROBE_ORDER
 * (config.ts), which is platform-specific:
 *
 *   sox (rec)   — best UX: silence detection and a clean SIGINT finalization.
 *                 Linux/macOS first choice; on Windows only a hard terminate
 *                 stops it, so it is a fallback behind ffmpeg.
 *   arecord     — ALSA utils. Linux only; never probed on macOS/Windows.
 *   ffmpeg      — pulse/alsa on Linux, AVFoundation on macOS, DirectShow on
 *                 Windows. First choice on Windows: it is the one backend that
 *                 finalizes the container on a stdin "q".
 *
 * Stopping is "graceful first, then SIGKILL after a grace period" so the WAV
 * header gets finalized before we upload it. ffmpeg finalizes on a stdin "q";
 * the others rely on SIGINT, which on Windows is a hard terminate.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { PROBE_ORDER, RECORDER_KINDS, type RecorderKind, type SttConfig } from "./config";

export interface RecorderHandle {
	kind: RecorderKind;
	bin: string;
	file: string;
	proc: ChildProcess;
	/** Set once stopRecorder() has been called, so double-stops are no-ops. */
	stopped: boolean;
	/** stderr tail, surfaced when the recorder exits non-zero. */
	stderr: string;
}

/** Resolve `bin` to the absolute path PATH would pick, or null when it is not
 *  installed. Windows needs the extension list because the installers ship
 *  `ffmpeg.exe` / `rec.exe` rather than extension-less names. */
export function resolveBin(bin: string): string | null {
	const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
	const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
	for (const dir of dirs) {
		for (const ext of exts) {
			const p = join(dir, bin + ext);
			if (existsSync(p)) return p;
		}
	}
	return null;
}

/** Is `bin` resolvable on PATH? */
export function which(bin: string): boolean {
	return resolveBin(bin) !== null;
}

/** First available recorder kind, honoring an explicit config preference. */
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
	for (const kind of PROBE_ORDER) {
		if (which(binFor(kind))) return kind;
	}
	throw new Error(
		process.platform === "win32"
			? "No audio recorder found. Install ffmpeg (winget install Gyan.FFmpeg) or sox."
			: process.platform === "darwin"
				? "No audio recorder found. Install sox (brew install sox) or ffmpeg."
				: "No audio recorder found. Install one of: sox (rec), alsa-utils (arecord), or ffmpeg.",
	);
}

function binFor(kind: RecorderKind): string {
	return kind === "sox" ? "rec" : kind === "arecord" ? "arecord" : "ffmpeg";
}

/** Pull the first `"Name" (audio)` entry out of `ffmpeg -list_devices` output. */
function parseDshowAudio(text: string): string | null {
	const m = /"([^"]+)"\s*\(audio\)/.exec(text);
	return m ? m[1] : null;
}

/** DirectShow input spec for the Windows ffmpeg backend.
 *
 *  dshow needs an exact device name — `audio=default` is not a device and
 *  ffmpeg fails with "Could not find audio only device with name". Enumerate
 *  the machine's real inputs once (ffmpeg lists them on stderr and exits
 *  non-zero) and reuse the first. Falls back to `default` when enumeration
 *  fails, so a build that does accept the alias still works. */
let dshowDevice: string | null | undefined;
function dshowInput(): string {
	if (dshowDevice === undefined) {
		dshowDevice = null;
		const args = ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"];
		try {
			dshowDevice = parseDshowAudio(execFileSync("ffmpeg", args, {
				encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 5000,
			}));
		} catch (e) {
			// The device list goes to stderr and ffmpeg exits 1 after printing it.
			dshowDevice = parseDshowAudio(String((e as { stderr?: string })?.stderr ?? ""));
		}
	}
	return `audio=${dshowDevice ?? "default"}`;
}

function buildArgs(kind: RecorderKind, cfg: SttConfig, file: string): string[] {
	const rate = String(cfg.sampleRate);
	if (kind === "sox") {
		const args = ["-q", "-c", "1", "-r", rate, "-b", "16", file];
		// `silence <above-periods> <duration> <threshold> <below-periods> <duration> <threshold>`
		// stops recording ~2s after speech ends, but only after the user has started talking.
		if (cfg.silenceAutoStop) args.push("silence", "1", "0.1", "3%", "1", "2.0", "5%");
		return args;
	}
	if (kind === "arecord") {
		return ["-q", "-f", "S16_LE", "-r", rate, "-c", "1", "-t", "wav", file];
	}
	// ffmpeg
	const input =
		process.platform === "darwin"
			? ["-f", "avfoundation", "-i", ":0"]
			: process.platform === "win32"
				? ["-f", "dshow", "-i", dshowInput()]
				: ["-f", "pulse", "-i", "default"];
	return ["-hide_banner", "-loglevel", "error", "-y", ...input, "-ac", "1", "-ar", rate, "-c:a", "pcm_s16le", file];
}

/** Spawn a recorder writing to `file`. Throws when no backend is usable. */
export function startRecorder(cfg: SttConfig, file: string): RecorderHandle {
	const kind = detectRecorder(cfg.recorder);
	const bin = binFor(kind);

	// ffmpeg is stopped gracefully by writing "q" to stdin; the others only
	// need a signal, so keep their stdio minimal.
	const stdin = kind === "ffmpeg" ? "pipe" : "ignore";
	// Spawn the resolved absolute path so a same-named shim earlier on PATH
	// cannot shadow the real binary. A .cmd/.bat shim (scoop/npm-style installs)
	// still cannot be exec'd directly on Windows, so route only those through
	// the shell; real .exe installs spawn directly.
	const exe = resolveBin(bin) ?? bin;
	const proc = spawn(exe, buildArgs(kind, cfg, file), {
		stdio: [stdin, "ignore", "pipe"],
		shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(exe),
		windowsHide: true,
	});
	const handle: RecorderHandle = { kind, bin, file, proc, stopped: false, stderr: "" };
	proc.stderr?.on("data", (chunk: Buffer) => {
		handle.stderr = (handle.stderr + chunk.toString()).slice(-2000);
	});
	return handle;
}

function waitExit(proc: ChildProcess, ms: number): Promise<void> {
	return new Promise((resolve) => {
		if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
		const timer = setTimeout(() => {
			proc.removeListener("exit", onExit);
			resolve();
		}, ms);
		const onExit = () => {
			clearTimeout(timer);
			resolve();
		};
		proc.once("exit", onExit);
	});
}

/** Stop a recorder, finalizing the WAV. Safe to call more than once. */
export async function stopRecorder(handle: RecorderHandle): Promise<void> {
	if (handle.stopped) return;
	handle.stopped = true;
	const proc = handle.proc;
	if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;

	// ffmpeg finalizes its container when it reads `q`; SIGINT does the same
	// for sox/arecord. Sending both is harmless.
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

/** True when the capture actually produced audio (not just a bare WAV header). */
export function hasAudio(file: string): boolean {
	try {
		return statSync(file).size > 1024;
	} catch {
		return false;
	}
}
