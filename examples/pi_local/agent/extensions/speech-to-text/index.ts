/**
 * Speech-to-Text (Groq Whisper)
 *
 * Push-to-talk dictation into the pi prompt:
 *
 *   hold Alt+T   record while held  →  release  →  the clip is transcribed
 *
 * The transcript is appended to whatever is already in the prompt editor so
 * you can review it before sending. `/listen` toggles a recording instead of
 * holding, and `/stt` reports/configures the extension.
 *
 * How the key is detected: extensions receive raw terminal input *before* the
 * editor, via `ctx.ui.onTerminalInput`. pi asks the terminal for the Kitty
 * keyboard protocol with flags 1|2|4 (`CSI > 7 u`), so on Kitty/Ghostty/
 * WezTerm/foot/Alacritty etc. the release arrives as an explicit event and ends
 * the clip the instant it lands.
 *
 * That release is a fast path, never the only plan. Key events travel through
 * layers that cannot report one at all — xterm modifyOtherKeys, legacy
 * terminals, and remote pipelines that re-encode presses (VS Code, Herdr, a
 * browser terminal in the middle). Those layers may even label a press with a
 * Kitty event type, which proves nothing about releases. So *every* alt+t event
 * of a hold re-arms the `holdReleaseGapMs` watchdog: auto-repeat keeps pushing
 * it out while the key is down, and it fires once the key comes up.
 *
 * While a clip is live, a widget in the row above the prompt shows the state —
 * a pulsing dot, a live level meter read straight from the WAV the recorder is
 * still writing, the elapsed time, and how to stop:
 *
 *   ● listening ▓▓▓▓░░░░ 0:05 — release alt+t to transcribe
 *
 * (Why a widget and not `ui.setStatus`: see the header of `view.ts`.)
 *
 * Setup:  export GROQ_API_KEY=gsk_...      (https://console.groq.com/keys)
 *
 * The clip is written to `<cwd>/.pi/stt/` (falling back to the OS temp dir if
 * that tree can't be created) and deleted right after transcription — set
 * `keepAudio` to keep it, e.g. while tuning the recorder.
 *
 * Optional overrides, either via environment or a JSON config file
 * (`<agentDir>/speech-to-text.json`, overridden by `.pi/speech-to-text.json`):
 *
 *   {
 *     "model": "whisper-large-v3-turbo",   // GROQ_STT_MODEL
 *     "language": "en",                    // GROQ_STT_LANGUAGE ("" = auto)
 *     "prompt": "Kubernetes, TypeScript",  // vocabulary hints
 *     "maxDurationSeconds": 120,           // GROQ_STT_MAX_SECONDS
 *     "holdReleaseGapMs": 900,             // GROQ_STT_HOLD_RELEASE_MS
 *     "silenceAutoStop": false,            // sox only: stop after trailing silence
 *     "recorder": "auto",                  // GROQ_STT_RECORDER: auto|sox|arecord|ffmpeg
 *     "sampleRate": 16000,
 *     "levelMeter": true,                  // GROQ_STT_METER=0 to disable
 *     "keepAudio": false
 *   }
 *
 * Requires a host recorder: sox (`rec`), alsa-utils (`arecord`), or ffmpeg.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Key, isKeyRelease, isKeyRepeat, matchesKey, parseKey } from "@mariozechner/pi-tui";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MODEL, globalConfigPath, loadConfig, projectConfigPath, type SttConfig } from "./config";
import { transcribe } from "./groq";
import { AudioLevelMeter } from "./level";
import { detectRecorder, hasAudio, startRecorder, stopRecorder, type RecorderHandle } from "./recorder";
import { ListeningView } from "./view";

type Phase = "idle" | "recording" | "transcribing";
type NotifyType = "info" | "warning" | "error";

const LISTEN_KEY = Key.alt("t");

/** Session-local scratch directory for in-flight clips. */
const AUDIO_DIR = join(".pi", "stt");

/** Last-resort guard so a transcript can never blow past the editor. */
const MAX_TRANSCRIPT_CHARS = 4000;

/** Repaint cadence while a clip is live: fast enough for a live meter. */
const TICK_MS = 120;
/** Repaint cadence for a clip when the meter is off (only the clock moves). */
const PLAIN_TICK_MS = 1000;

/** Modifiers a release of the dictation key may still carry: by the time the
 *  letter is up the terminal may only report the modifiers still held (often
 *  none of them). */
const LISTEN_RELEASE_MODIFIERS = new Set(["alt", "shift"]);

/** Gap used once this terminal has proven it reports key releases: long enough
 *  that auto-repeat can never trip it, short enough that a lost release cannot
 *  strand a clip. */
const RELEASE_SAFETY_MS = 4000;

/** Does this key-release event end a dictation hold?
 *
 *  Matched on the key itself rather than on `alt+t`: terminals disagree about
 *  which modifiers they attach to a release, and letting go of the held letter
 *  can only mean the hold is over. Ctrl/Super releases are ignored so a stray
 *  chord cannot cut the clip. */
function isDictationKeyRelease(data: string): boolean {
	const id = parseKey(data);
	if (!id) return false;
	const parts = id.split("+");
	if (parts.pop() !== "t") return false;
	return parts.every((modifier) => LISTEN_RELEASE_MODIFIERS.has(modifier));
}

const HOLD_HINT = "release alt+t to transcribe";
const TOGGLE_HINT = "alt+t or /listen to stop";

class SpeechToText {
	private cfg: SttConfig;
	private phase: Phase = "idle";
	private handle: RecorderHandle | null = null;
	private startedAt = 0;
	private tickTimer: ReturnType<typeof setInterval> | null = null;
	private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
	/** Fires the hold gap after the last alt+t event of the current clip;
	 *  auto-repeat keeps re-arming it while the key is down. */
	private releaseWatchdog: ReturnType<typeof setTimeout> | null = null;
	/** True once a key release has ended a hold in this session — the only
	 *  proof that this terminal reports releases at all. */
	private releasesSeen = false;
	/** True when the current recording was started by holding alt+t, so a key
	 *  release (or the repeat-gap watchdog) is expected to stop it. False for
	 *  /listen-style toggles, which stop on the next press instead. */
	private waitForRelease = false;
	/** Stop instruction shown in the widget for the current clip. */
	private hint = HOLD_HINT;
	/** Live level meter reading the WAV the recorder is still writing. */
	private meter: AudioLevelMeter | null = null;
	/** The "● listening" widget above the prompt. */
	private view = new ListeningView();
	/** Unsubscribe for the raw terminal input listener (TUI only). */
	private unsubscribe: (() => void) | null = null;
	/** True while a stop we initiated is in flight, so the recorder's own exit
	 *  event doesn't kick off a second transcription pass. */
	private ownStop = false;
	/** Timestamp of the last alt+t event we handled, so the registered-shortcut
	 *  fallback never double-handles an event the terminal listener consumed. */
	lastKeyEventAt = 0;
	/** Last ctx seen, reused for notifications that fire after a handler returns. */
	ctx: any = null;

	constructor(private readonly cwd: string) {
		this.cfg = loadConfig(cwd);
	}

	/** Where clips are written: `<cwd>/.pi/stt`, created on demand with
	 *  owner-only permissions (a dictation clip is as private as typed text).
	 *  Falls back to the OS temp dir if that tree can't be created — a
	 *  read-only or sandboxed cwd must not break recording. */
	private audioDir(): string {
		const dir = join(this.cwd, AUDIO_DIR);
		try {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			return dir;
		} catch {
			return tmpdir();
		}
	}

	// ── Raw terminal input (press / repeat / release) ───────────────────

	/** Install the TUI input listener. No-op outside interactive mode. */
	installTerminalListener(): void {
		if (this.unsubscribe) return;
		const ui = this.ctx?.ui;
		if (this.ctx?.mode !== "tui" || typeof ui?.onTerminalInput !== "function") return;
		this.unsubscribe = ui.onTerminalInput((data: string) => this.handleTerminalInput(data));
	}

	/** Runs before the editor sees the key. Returns `{ consume: true }` for
	 *  alt+t so the editor never inserts it and the shortcut can't double-fire. */
	private handleTerminalInput(data: string): { consume?: boolean } | undefined {
		// Explicit release: the fast path, and the only signal a re-encoding
		// pipeline cannot fake with auto-repeat.
		if (isKeyRelease(data)) {
			if (!this.isHolding || !isDictationKeyRelease(data)) return undefined;
			this.lastKeyEventAt = Date.now();
			this.releasesSeen = true;
			this.cancelWatchdog();
			void this.stopAndTranscribe();
			return { consume: true };
		}

		if (!matchesKey(data, LISTEN_KEY)) return undefined;
		this.lastKeyEventAt = Date.now();

		// Auto-repeat: the key is still held, or a pipeline re-encoded the held
		// key as a fresh press. Either way the clip lives on and the release gap
		// is pushed out — only a release (or the gap itself) ends it.
		if (isKeyRepeat(data)) {
			this.armHoldWatchdog();
			return { consume: true };
		}

		this.onPress();
		return { consume: true };
	}

	/** True while a hold-style clip is waiting for alt+t to come back up. */
	private get isHolding(): boolean {
		return this.phase === "recording" && this.waitForRelease;
	}

	private onPress(): void {
		if (this.phase === "transcribing") {
			this.notify("Still transcribing the previous clip…", "info");
			return;
		}
		if (this.phase === "recording") {
			if (!this.waitForRelease) {
				// Toggle recording (/listen): the next press stops it.
				void this.stopAndTranscribe();
				return;
			}
			// The hold continues: the key is still down, or this terminal reports
			// its auto-repeat as fresh presses. Push the release gap out instead
			// of assuming a release event is on its way — it may never come.
			this.armHoldWatchdog();
			return;
		}
		void this.start("hold");
	}

	// ── Recording ───────────────────────────────────────────────────────

	private async start(mode: "hold" | "toggle"): Promise<void> {
		if (!this.cfg.enabled) {
			this.notify("Speech-to-text is off. Run /stt on to enable it.", "warning");
			return;
		}
		if (!this.cfg.apiKey) {
			this.notify("Speech-to-text: set GROQ_API_KEY (https://console.groq.com/keys) first.", "error");
			return;
		}

		const file = join(this.audioDir(), `pi-stt-${process.pid}-${Date.now()}.wav`);
		let handle: RecorderHandle;
		try {
			handle = startRecorder(this.cfg, file);
		} catch (err) {
			this.notify(`Speech-to-text: ${err instanceof Error ? err.message : String(err)}`, "error");
			return;
		}

		this.handle = handle;
		this.phase = "recording";
		this.waitForRelease = mode === "hold";
		this.ownStop = false;
		this.startedAt = Date.now();
		this.hint = mode === "hold" ? HOLD_HINT : TOGGLE_HINT;

		// The recorder can end on its own (sox silence detection, unplugged
		// device, ffmpeg crash). Only treat that as an auto-stop while this
		// handle is still the one we are waiting on.
		handle.proc.once("exit", () => this.onRecorderExit(handle));
		handle.proc.once("error", (err: Error) => {
			if (this.handle === handle) {
				this.notify(`Recording failed: ${err.message}`, "error");
				void this.stopAndTranscribe();
			}
		});

		// Every hold arms the release gap: terminals that report a release end
		// the clip the moment it lands, terminals that never do rely on the gap
		// alone. /listen toggles have no held key, so they must not arm it.
		if (mode === "hold") this.armHoldWatchdog();

		// Live level meter: sample the growing WAV and repaint the widget.
		if (this.cfg.levelMeter) this.meter = new AudioLevelMeter(file, this.cfg.sampleRate);
		if (this.view.install(this.ctx)) this.paint();
		this.startTick(this.cfg.levelMeter ? TICK_MS : PLAIN_TICK_MS);

		if (this.cfg.maxDurationSeconds > 0) {
			this.maxDurationTimer = setTimeout(() => {
				this.notify(`Reached the ${this.cfg.maxDurationSeconds}s limit — transcribing.`, "info");
				void this.stopAndTranscribe();
			}, this.cfg.maxDurationSeconds * 1000);
		}
	}

	/** Publish the current state to the widget. */
	private paint(): void {
		if (this.phase === "idle") return;
		this.view.update({
			phase: this.phase,
			elapsedMs: Date.now() - this.startedAt,
			level: this.meter?.sample(),
			silentMs: this.meter?.silentForMs(),
			hint: this.hint,
		});
	}

	private startTick(ms: number): void {
		this.stopTick();
		this.tickTimer = setInterval(() => this.paint(), ms);
	}

	private stopTick(): void {
		if (!this.tickTimer) return;
		clearInterval(this.tickTimer);
		this.tickTimer = null;
	}

	/** (Re)arm "alt+t must still be down" for the current hold.
	 *
	 *  Until a release has been seen this gap *is* the release signal, so it
	 *  stays tight (`holdReleaseGapMs`). Once a terminal has proven it sends
	 *  releases, the gap only has to rescue a lost one and can be generous —
	 *  auto-repeat keeps re-arming it either way. */
	private armHoldWatchdog(): void {
		if (!this.isHolding) return;
		this.cancelWatchdog();
		const gap = this.releasesSeen
			? Math.max(this.cfg.holdReleaseGapMs, RELEASE_SAFETY_MS)
			: this.cfg.holdReleaseGapMs;
		this.releaseWatchdog = setTimeout(() => {
			this.releaseWatchdog = null;
			// No alt+t event for the gap → the key was released.
			void this.stopAndTranscribe();
		}, gap);
	}

	private cancelWatchdog(): void {
		if (!this.releaseWatchdog) return;
		clearTimeout(this.releaseWatchdog);
		this.releaseWatchdog = null;
	}

	private onRecorderExit(handle: RecorderHandle): void {
		if (this.handle !== handle || this.ownStop || this.phase !== "recording") return;
		// Ended by itself (sox silence, or a crash that already notified).
		void this.stopAndTranscribe();
	}

	private async stopAndTranscribe(): Promise<void> {
		if (this.phase !== "recording" || !this.handle) return;
		this.phase = "transcribing";
		this.ownStop = true;
		this.clearTimers();
		this.closeMeter();

		const handle = this.handle;
		this.handle = null;
		const file = handle.file;

		// The widget clock now tracks the request, not the clip.
		this.hint = "";
		this.startedAt = Date.now();
		this.paint();
		this.startTick(TICK_MS);

		try {
			await stopRecorder(handle);
		} catch { /* best effort — use whatever was captured */ }

		try {
			if (!hasAudio(file)) {
				const detail = handle.stderr.trim() ? ` (${handle.stderr.trim().split("\n").pop()})` : "";
				throw new Error(`no audio captured${detail}`);
			}
			const { text, model, elapsedMs } = await transcribe(this.cfg, file);
			if (!text) {
				this.notify(`No speech detected (${model}, ${elapsedMs}ms).`, "warning");
			} else {
				const applied = this.insertText(text);
				const preview = text.length > 120 ? `${text.slice(0, 120)}…` : text;
				this.notify(
					applied ? `Transcribed: “${preview}”` : `Transcript (editor unavailable): “${preview}”`,
					applied ? "info" : "warning",
				);
			}
		} catch (err) {
			this.notify(`Speech-to-text: ${err instanceof Error ? err.message : String(err)}`, "error");
		} finally {
			this.clearTimers();
			this.view.remove(this.ctx);
			this.cleanupAudio(file);
			this.phase = "idle";
			this.ownStop = false;
			this.waitForRelease = false;
			this.hint = HOLD_HINT;
		}
	}

	// ── Fallback entry point (/listen, and the registered shortcut when the
	//    terminal listener isn't what received the key) ──────────────────

	async toggle(ctx: any): Promise<void> {
		this.ctx = ctx;
		if (this.phase === "recording") {
			void this.stopAndTranscribe();
			return;
		}
		if (this.phase === "transcribing") {
			this.notify("Still transcribing the previous clip…", "info");
			return;
		}
		await this.start("toggle");
	}

	// ── Prompt insertion ────────────────────────────────────────────────

	/** Append the transcript to the prompt editor, preserving typed text.
	 *  Returns false when the host exposes no editor text API. */
	private insertText(text: string): boolean {
		const ui = this.ctx?.ui;
		const safe = text.slice(0, MAX_TRANSCRIPT_CHARS);
		if (!ui || typeof ui.setEditorText !== "function") {
			this.notify(`Transcript (copy manually): ${safe}`, "warning");
			return false;
		}
		let current = "";
		try {
			current = typeof ui.getEditorText === "function" ? ui.getEditorText() ?? "" : "";
		} catch {
			current = "";
		}
		const sep = current.length > 0 && !/\s$/.test(current) ? " " : "";
		try {
			ui.setEditorText(`${current}${sep}${safe}`);
			return true;
		} catch {
			this.notify(`Transcript (copy manually): ${safe}`, "warning");
			return false;
		}
	}

	// ── Command/diagnostic surface ──────────────────────────────────────

	get isEnabled(): boolean {
		return this.cfg.enabled;
	}

	get hasApiKey(): boolean {
		return this.cfg.apiKey.length > 0;
	}

	get language(): string {
		return this.cfg.language || "auto";
	}

	get model(): string {
		return this.cfg.model;
	}

	statusLines(): string[] {
		const rec = (() => {
			try {
				return detectRecorder(this.cfg.recorder);
			} catch (err) {
				return `unavailable — ${err instanceof Error ? err.message : String(err)}`;
			}
		})();
		const input = this.unsubscribe
			? `alt+t (raw input; ${this.releasesSeen ? "key releases detected" : `the ${this.cfg.holdReleaseGapMs}ms gap ends a hold`})`
			: "shortcut only — /listen records";
		return [
			`state:    ${this.cfg.enabled ? "enabled" : "disabled"} (now: ${this.phase})`,
			`key:      ${this.hasApiKey ? "GROQ_API_KEY set" : "MISSING — set GROQ_API_KEY"}`,
			`model:    ${this.cfg.model}${this.cfg.model === DEFAULT_MODEL ? "" : ` (default ${DEFAULT_MODEL})`}`,
			`language: ${this.language}`,
			`recorder: ${rec}`,
			`input:    ${input}, meter ${this.cfg.levelMeter ? "on" : "off"}`,
			`limit:    ${this.cfg.maxDurationSeconds}s${this.cfg.silenceAutoStop ? ", silence auto-stop on" : ""}`,
			`config:   ${projectConfigPath(process.cwd())} (fallback ${globalConfigPath()})`,
			`keys:     hold alt+t to record · /listen to toggle · /stt on|off · /stt lang <code|auto>`,
		];
	}

	setEnabled(enabled: boolean): void {
		this.cfg.enabled = enabled;
		if (!enabled && this.phase === "recording") void this.stopAndTranscribe();
	}

	setLanguage(language: string): void {
		const next = language.trim().toLowerCase();
		this.cfg.language = next === "auto" || next === "" ? "" : next;
	}

	setModel(model: string): void {
		this.cfg.model = model.trim() || DEFAULT_MODEL;
	}

	// ── Helpers ─────────────────────────────────────────────────────────

	private notify(message: string, type: NotifyType = "info"): void {
		try {
			this.ctx?.ui?.notify?.(message, type);
		} catch { /* no UI (print/rpc) — nothing to do */ }
	}

	private clearTimers(): void {
		this.stopTick();
		if (this.maxDurationTimer) { clearTimeout(this.maxDurationTimer); this.maxDurationTimer = null; }
		this.cancelWatchdog();
	}

	private closeMeter(): void {
		this.meter?.close();
		this.meter = null;
	}

	private cleanupAudio(file: string): void {
		if (this.cfg.keepAudio) return;
		try { rmSync(file, { force: true }); } catch { /* ignore */ }
	}

	/** Tear down on session shutdown. */
	async dispose(): Promise<void> {
		this.clearTimers();
		this.closeMeter();
		this.view.remove(this.ctx);
		try { this.unsubscribe?.(); } catch { /* ignore */ }
		this.unsubscribe = null;
		const handle = this.handle;
		this.handle = null;
		this.phase = "idle";
		if (handle) {
			try { await stopRecorder(handle); } catch { /* ignore */ }
			this.cleanupAudio(handle.file);
		}
	}
}

export default function (pi: ExtensionAPI) {
	const get = (ctx: any): SpeechToText => {
		const stt = new SpeechToText(ctx?.cwd ?? process.cwd());
		stt.ctx = ctx;
		stt.installTerminalListener();
		return stt;
	};
	let stt: SpeechToText | null = null;

	// ── Lifecycle ───────────────────────────────────────────────────────
	pi.on("session_start", async (_event: any, ctx: any) => {
		if (stt) await stt.dispose();
		stt = get(ctx);

		// Fail loudly at startup rather than on the first keypress. TUI only:
		// subagent/print sessions load this extension too and must stay quiet.
		if (ctx?.mode === "tui" && !stt.hasApiKey) {
			ctx.ui.notify(
				"Speech-to-text ready (hold alt+t), but GROQ_API_KEY is not set — get a key at https://console.groq.com/keys",
				"warning",
			);
		}
	});

	pi.on("session_shutdown", async () => {
		if (stt) await stt.dispose();
		stt = null;
	});

	// ── Shortcut: press alt+t to record, press again to transcribe ──────
	// In the TUI the terminal input listener above consumes alt+t and handles
	// press/repeat/release precisely, so this handler only runs when that
	// listener isn't the one that saw the key (non-TUI modes, or another
	// handler consuming input first). That path has no key-release signal, so
	// it toggles instead of holding — a hold would stop on the release-gap
	// watchdog while the key is still down. The timestamp guard keeps the two
	// paths from double-handling the same keystroke.
	pi.registerShortcut(LISTEN_KEY, {
		description: "Speech-to-text: start/stop recording (Groq Whisper)",
		handler: async (ctx: any) => {
			if (!stt) stt = get(ctx);
			if (Date.now() - stt.lastKeyEventAt < 300) return;
			await stt.toggle(ctx);
		},
	});

	// ── Commands ────────────────────────────────────────────────────────
	pi.registerCommand("listen", {
		description: "Speech-to-text: start/stop recording (press-once alternative to holding alt+t)",
		handler: async (_args: string, ctx: any) => {
			if (!stt) stt = get(ctx);
			await stt.toggle(ctx);
		},
	});

	pi.registerCommand("stt", {
		description: "Speech-to-text: status, on|off, lang <code|auto>, model <id>",
		handler: async (args: string, ctx: any) => {
			if (!stt) stt = get(ctx);
			stt.ctx = ctx;

			const [sub = "", ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);
			switch (sub.toLowerCase()) {
				case "":
				case "status":
					ctx.ui.notify(stt.statusLines().join("\n"), "info");
					return;
				case "on":
					stt.setEnabled(true);
					ctx.ui.notify("Speech-to-text enabled. Hold alt+t to record.", "info");
					return;
				case "off":
					stt.setEnabled(false);
					ctx.ui.notify("Speech-to-text disabled.", "info");
					return;
				case "lang":
				case "language":
					if (!rest[0]) {
						ctx.ui.notify(`Language: ${stt.language}`, "info");
						return;
					}
					stt.setLanguage(rest[0]);
					ctx.ui.notify(`Speech-to-text language: ${stt.language}`, "info");
					return;
				case "model":
					if (!rest[0]) {
						ctx.ui.notify(`Model: ${stt.model}`, "info");
						return;
					}
					stt.setModel(rest[0]);
					ctx.ui.notify(`Speech-to-text model: ${stt.model}`, "info");
					return;
				default:
					ctx.ui.notify("Usage: /stt [status|on|off|lang <code|auto>|model <id>]", "warning");
			}
		},
	});
}
