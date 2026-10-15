/**
 * Speech-to-Text — live audio level meter.
 *
 * Reads the WAV file that the recorder is *still writing* and computes an RMS
 * level from the PCM bytes appended since the last tick. This is deliberately
 * dependency-free and recorder-agnostic: the growing WAV file is the one thing
 * sox, arecord and ffmpeg all produce the same way.
 *
 * The header is parsed once to locate the `data` chunk; after that each tick
 * reads only the newly appended samples. A short decay keeps the bar from
 * flickering between the recorder's own output flushes.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";

/** dBFS mapped to the bottom of the meter (below this the bar is empty). */
const FLOOR_DB = -60;
/** Per-tick decay applied to the displayed level (120 ms ticks). */
const DECAY = 0.8;
/** Most audio read in one tick — enough for a couple of ticks of lag. */
const MAX_TICK_SECONDS = 0.25;
/** Level considered "signal present" for the no-signal hint. */
const SILENCE_LEVEL = 0.06;

function analyze(buf: Buffer): { rms: number; peak: number } {
	const samples = buf.length >> 1; // 16-bit mono
	if (samples === 0) return { rms: 0, peak: 0 };
	let sumSquares = 0;
	let peak = 0;
	for (let i = 0; i < samples; i++) {
		const s = buf.readInt16LE(i * 2) / 32768;
		sumSquares += s * s;
		const abs = s < 0 ? -s : s;
		if (abs > peak) peak = abs;
	}
	return { rms: Math.sqrt(sumSquares / samples), peak };
}

/** Map an RMS amplitude (0..1) onto 0..1 using a dBFS scale. */
function normalize(rms: number): number {
	const db = 20 * Math.log10(Math.max(rms, 1e-6));
	return Math.min(1, Math.max(0, (db - FLOOR_DB) / -FLOOR_DB));
}

export class AudioLevelMeter {
	private fd: number | null = null;
	/** Byte offset of the first PCM sample, or -1 until the header is parsed. */
	private dataOffset = -1;
	/** Absolute offset of the next unread sample byte. */
	private readOffset = 0;
	/** Smoothed display level, 0..1. */
	private level = 0;
	/** Last time the level was above the silence threshold. */
	private lastLoudAt = Date.now();
	/** Read buffer, reused across the ~8 samples per second of a clip. */
	private buffer: Buffer | null = null;

	constructor(private readonly file: string, private readonly sampleRate: number) {}

	/** Read whatever was appended since the last call and return the smoothed
	 *  level (0..1). Never throws; returns the decayed level on any I/O error. */
	sample(): number {
		try {
			const size = statSync(this.file).size;
			if (this.fd === null) this.fd = openSync(this.file, "r");
			if (this.dataOffset < 0) this.dataOffset = this.findDataOffset(size);
			if (this.dataOffset < 0) return this.decay();

			if (this.readOffset === 0) this.readOffset = this.dataOffset;
			if (size <= this.readOffset) return this.decay();

			// Cap the read so a stalled/behind tick can't produce a huge buffer
			// or a stale level: keep only the most recent window of audio.
			const windowBytes = Math.max(1024, Math.floor(this.sampleRate * 2 * MAX_TICK_SECONDS));
			let from = this.readOffset;
			if (size - from > windowBytes) from = Math.max(this.dataOffset, size - windowBytes);

			const len = size - from;
			const buf = this.bufferFor(len);
			const read = readSync(this.fd, buf, 0, len, from);
			this.readOffset = size;
			if (read <= 0) return this.decay();

			const { rms } = analyze(buf.subarray(0, read));
			const level = normalize(rms);
			if (level >= SILENCE_LEVEL) this.lastLoudAt = Date.now();
			this.level = Math.max(level, this.level * DECAY);
			return this.level;
		} catch {
			// The recorder may not have created the file yet, or it may be
			// mid-flush. Treat it as silence and try again next tick.
			return this.decay();
		}
	}

	/** A buffer large enough for `len` bytes, kept for the next tick. */
	private bufferFor(len: number): Buffer {
		const buf = this.buffer;
		if (buf && buf.length >= len) return buf;
		this.buffer = Buffer.allocUnsafe(len);
		return this.buffer;
	}

	/** How long the signal has been at/below the silence threshold, in ms. */
	silentForMs(): number {
		const silent = Date.now() - this.lastLoudAt;
		return silent > 0 ? silent : 0;
	}

	close(): void {
		if (this.fd === null) return;
		try { closeSync(this.fd); } catch { /* ignore */ }
		this.fd = null;
	}

	private decay(): number {
		this.level *= DECAY;
		return this.level;
	}

	/** Locate the PCM payload: walk the RIFF chunks for `data`. Returns -1 when
	 *  the header isn't written yet. */
	private findDataOffset(size: number): number {
		if (this.fd === null || size < 12) return -1;
		const head = Buffer.allocUnsafe(Math.min(size, 4096));
		const read = readSync(this.fd, head, 0, head.length, 0);
		if (read < 12) return -1;
		if (head.toString("ascii", 0, 4) !== "RIFF" || head.toString("ascii", 8, 12) !== "WAVE") return -1;

		let pos = 12;
		while (pos + 8 <= read) {
			const id = head.toString("ascii", pos, pos + 4);
			const chunkSize = head.readUInt32LE(pos + 4);
			if (id === "data") return pos + 8;
			// Streaming writers (ffmpeg) leave the data size unset; an
			// implausible size means we can't walk past this chunk.
			if (chunkSize === 0 || chunkSize > 0x7fffffff) break;
			pos += 8 + chunkSize + (chunkSize % 2); // chunks are word-aligned
		}

		// Fallback for headers whose chunk sizes don't walk cleanly (vendor
		// extensions, partially flushed headers): find the `data` marker itself.
		const marker = head.subarray(12, read).indexOf("data");
		return marker >= 0 ? 12 + marker + 8 : -1;
	}
}
