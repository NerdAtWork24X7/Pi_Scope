/**
 * Speech-to-Text — the live "listening" view.
 *
 *      ● listening ▓▓▓▓░░░░ 0:05 — release alt+t to transcribe
 *
 * Rendered as a widget in the row directly above the prompt (`ui.setWidget`),
 * which is the one surface every TUI configuration actually draws. The obvious
 * alternative — a footer status line (`ui.setStatus`) — is rendered by the
 * *built-in* footer only: install a custom footer with `ui.setFooter` (as
 * `custom-footer.ts` in this repo does) and every extension status silently
 * disappears. The widget also sits where the eye already is while dictating,
 * and it can carry the level meter and the stop hint.
 *
 * Rendering is a pure function of a snapshot (`renderListening`): the extension
 * owns the clock, computes each frame and repaints through
 * `ListeningView.update()`. Nothing here holds a timer or mutable DOM, so the
 * view is cheap to test and has nothing to tear down.
 */

import { truncateToWidth, visibleWidth, type Component, type TUI } from "@mariozechner/pi-tui";

/** Cells in the level meter bar. */
export const METER_SEGMENTS = 8;
/** Show the "no signal" hint after this long without audio. */
export const NO_SIGNAL_MS = 2500;
/** Pulse period of the state dot, in ms. */
const PULSE_MS = 600;

/** Frames of the state dot's pulse — a slow blink reads as "live, waiting". */
const DOT_FRAMES = ["\u25cf", "\u25c9"]; // ● ◉
/** Animated ellipsis for the transcribing state (one cell wider per frame). */
const DOTS_FRAMES = ["\u00b7  ", "\u00b7\u00b7 ", "\u00b7\u00b7\u00b7"];
/** Bar cells: full / empty. */
const BAR_FULL = "\u2588"; // █
const BAR_EMPTY = "\u2591"; // ░
/** Separator between the stop hint and the status text. */
const HINT_SEP = "\u2014"; // —

/** Widget key; one view per pi instance. */
const WIDGET_KEY = "speech-to-text";

/** The state the view renders. Refreshed on every tick while a clip is live. */
export interface ListeningState {
	phase: "recording" | "transcribing";
	/** Milliseconds since the clip (or the transcription) started. */
	elapsedMs: number;
	/** Smoothed input level, 0..1 — undefined when the meter is off. */
	level?: number;
	/** Milliseconds since the last signal above the silence floor — undefined when the meter is off. */
	silentMs?: number;
	/** How to stop the clip, e.g. "release alt+t to transcribe". "" while transcribing. */
	hint: string;
}

/** The slice of pi's `Theme` this view paints with. Structural, so tests can pass a stub. */
export interface ListeningTheme {
	fg(color: "accent" | "muted" | "dim" | "warning", text: string): string;
}

/** `m:ss`, clamped at zero. */
export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Number of filled cells for a 0..1 level. */
export function filledSegments(level: number, segments = METER_SEGMENTS): number {
	const n = Math.round(level * segments);
	return Math.min(segments, Math.max(0, Number.isFinite(n) ? n : 0));
}

/** Plain level bar (`▓▓▓░░░░░`) for a 0..1 level. */
export function meterBar(level: number, segments = METER_SEGMENTS): string {
	const filled = filledSegments(level, segments);
	return BAR_FULL.repeat(filled) + BAR_EMPTY.repeat(segments - filled);
}

/**
 * One widget line for the active clip, clipped to `width` cells.
 *
 * The parts that move (dot, label, meter, clock) are mandatory; the stop hint
 * and the no-signal badge are dropped, hint first, before anything is cut — so
 * a narrow terminal keeps the live feedback instead of a truncated sentence.
 */
export function renderListening(state: ListeningState, width: number, theme: ListeningTheme): string {
	const paint = (color: Parameters<ListeningTheme["fg"]>[0], text: string): string => {
		try {
			return theme.fg(color, text);
		} catch {
			return text; // host theme changed under us: keep the plain text
		}
	};
	const elapsed = Math.max(0, state.elapsedMs);
	const recording = state.phase === "recording";
	const dotGlyph = DOT_FRAMES[Math.floor(elapsed / PULSE_MS) % DOT_FRAMES.length];
	const label = recording ? "listening" : "transcribing";

	/** Each part carries its coloured text plus the plain text used to measure it. */
	const parts: Array<{ text: string; plain: string; optional?: boolean }> = [];
	const add = (text: string, plain: string, optional = false) => {
		parts.push({ text, plain, optional });
	};
	const colored = (
		color: Parameters<ListeningTheme["fg"]>[0],
		text: string,
		optional = false,
	) => add(paint(color, text), text, optional);

	add(`${paint("accent", dotGlyph)} ${paint("accent", label)}`, `${dotGlyph} ${label}`);
	if (!recording) {
		colored("dim", DOTS_FRAMES[Math.floor(elapsed / 300) % DOTS_FRAMES.length]);
	} else if (state.level !== undefined) {
		const filled = filledSegments(state.level);
		const bar = `${BAR_FULL.repeat(filled)}${BAR_EMPTY.repeat(METER_SEGMENTS - filled)}`;
		add(paint("accent", BAR_FULL.repeat(filled)) + paint("dim", BAR_EMPTY.repeat(METER_SEGMENTS - filled)), bar);
	}
	colored("muted", formatElapsed(elapsed));

	// Optional tail, in dropping order: "no signal?" tells the user the mic is
	// dead (more actionable than the stop instruction), then the stop hint.
	if (recording && state.level !== undefined && (state.silentMs ?? 0) > NO_SIGNAL_MS) {
		colored("warning", "no signal?", true);
	}
	if (state.hint) colored("dim", `${HINT_SEP} ${state.hint}`, true);

	const visible = (list: typeof parts): number =>
		list.reduce((sum, part) => sum + visibleWidth(part.plain), list.length - 1);
	const kept = [...parts];
	for (let i = parts.length - 1; i >= 0 && visible(kept) > width; i--) {
		if (parts[i].optional) kept.splice(i, 1);
	}
	const line = kept.map((part) => part.text).join(" ");
	return visibleWidth(line) > width ? truncateToWidth(line, width) : line;
}

/**
 * Owns the listening widget: installed when a clip starts, removed when it ends.
 * Repaints are driven by the extension's tick via `update()`, because the widget
 * component holds no timer of its own (pi re-renders components, it never asks
 * them to animate).
 */
export class ListeningView {
	private tui: TUI | null = null;
	private state: ListeningState | null = null;

	/** The snapshot the widget renders. Null while nothing is installed. */
	get current(): ListeningState | null {
		return this.state;
	}

	/** True once the widget has been handed to the host. */
	get attached(): boolean {
		return this.tui !== null;
	}

	/** Show the widget. Returns false on hosts without widget support (print/rpc). */
	install(ctx: any): boolean {
		const ui = ctx?.ui;
		if (!ui || typeof ui.setWidget !== "function") return false;
		try {
			ui.setWidget(
				WIDGET_KEY,
				(tui: TUI, theme: ListeningTheme) => new ListeningWidget(this, tui, theme),
				{ placement: "aboveEditor" },
			);
			return this.tui !== null;
		} catch {
			this.detach();
			return false; // never let status chrome break recording
		}
	}

	/** Publish a frame and repaint. A no-op when the widget is not installed. */
	update(state: ListeningState): void {
		this.state = state;
		try {
			this.tui?.requestRender();
		} catch { /* host is gone */ }
	}

	/** Hide the widget. Safe to call when nothing is installed. */
	remove(ctx: any): void {
		this.detach();
		try {
			ctx?.ui?.setWidget?.(WIDGET_KEY, undefined);
		} catch { /* session already torn down */ }
	}

	private detach(): void {
		this.state = null;
		this.tui = null;
	}

	/** Called by the widget pi builds, so the view can repaint it. */
	attach(tui: TUI): void {
		this.tui = tui;
	}
}

/** Pure renderer over the view's snapshot; pi owns its lifetime. */
class ListeningWidget implements Component {
	constructor(
		private readonly view: ListeningView,
		tui: TUI,
		private readonly theme: ListeningTheme,
	) {
		view.attach(tui);
	}

	render(width: number): string[] {
		const state = this.view.current;
		return state ? [renderListening(state, width, this.theme)] : [];
	}

	invalidate(): void {
		/* no cached state */
	}
}
