"""Assemble scenes into a master MP4: mux, concat, captions, chapters, music, player."""

from __future__ import annotations

import html
import json
import re
import subprocess
import sys
from pathlib import Path

from .ffmpeg import has_filter, probe, run

_SENTENCE = re.compile(r"(?<=[.!?。！？])\s+|(?<=[,;:，；：])\s+")

# One caption style for every burned-in path (soft-caption builds ignore it).
SRT_STYLE = "FontName=DejaVu Sans,Bold=1,FontSize=14,Outline=2,Shadow=0,MarginV=60"


def mux_scene(video, audio, out_mp4, *, fps=30, width=1920, height=1080, pad_s=None, total_s=None) -> Path:
    """Mux one recorded scene with its narration, normalized to CFR H.264/AAC."""
    out = Path(out_mp4)
    out.parent.mkdir(parents=True, exist_ok=True)
    vf = []
    if pad_s and pad_s > 0:
        vf.append(f"tpad=stop_mode=clone:stop_duration={pad_s:.3f}")
    vf += [
        f"scale={width}:{height}:force_original_aspect_ratio=decrease:force_divisible_by=2",
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2",
    ]
    run(
        ["-loglevel", "error", "-y", "-i", video, "-i", audio,
         "-map", "0:v:0", "-map", "1:a:0", "-vf", ",".join(vf), *(["-af", "apad", "-t", f"{total_s:.3f}"] if total_s else []),
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", fps, "-fps_mode", "cfr", "-crf", "18",
         "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "1",
         *([] if total_s else ["-shortest"]), "-movflags", "+faststart", out]
    )
    return out


def concat(segments, out_mp4, *, transition="none", duration_s=0.4) -> Path:
    """Concatenate identical-parameter segments (stream copy) or xfade them."""
    segs = [Path(s) for s in segments]
    out = Path(out_mp4)
    out.parent.mkdir(parents=True, exist_ok=True)

    if transition in (None, "none", ""):
        listfile = out.parent / "concat.txt"
        listfile.write_text("".join(f"file '{s.as_posix()}'\n" for s in segs), encoding="utf-8")
        run(["-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", listfile,
             "-c", "copy", "-movflags", "+faststart", out])
        return out

    if not has_filter("xfade"):
        raise RuntimeError("xfade filter unavailable in this ffmpeg build")

    durations = [probe(s)["duration"] or 0.0 for s in segs]
    inputs: list = []
    for seg in segs:
        inputs += ["-i", seg]
    parts = []
    vlabel, alabel = "0:v", "0:a"
    offset = durations[0] - duration_s
    for i in range(1, len(segs)):
        vout, aout = f"v{i}", f"a{i}"
        parts.append(
            f"[{vlabel}][{i}:v]xfade=transition=fade:duration={duration_s}:offset={offset:.3f}[{vout}]"
        )
        parts.append(f"[{alabel}][{i}:a]acrossfade=d={duration_s}[{aout}]")
        vlabel, alabel = vout, aout
        offset += durations[i] - duration_s
    run(["-loglevel", "error", "-y", *inputs, "-filter_complex", ";".join(parts),
         "-map", f"[{vlabel}]", "-map", f"[{alabel}]",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
         "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out])
    return out


def _timestamp(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    hours, ms = divmod(ms, 3_600_000)
    minutes, ms = divmod(ms, 60_000)
    secs, ms = divmod(ms, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{ms:03d}"


def build_srt(scenes, out_srt) -> Path:
    """Build captions from narration text, timed proportionally within each scene."""
    out = Path(out_srt)
    out.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    index = 0
    for scene in scenes:
        text = (scene.get("narration") or "").strip()
        if not text:
            continue
        chunks = [c for c in _SENTENCE.split(text) if c.strip()] or [text]
        total = sum(len(c) for c in chunks)
        cursor = scene["start"]
        for chunk in chunks:
            span = scene["duration"] * (len(chunk) / total)
            index += 1
            lines += [str(index), f"{_timestamp(cursor)} --> {_timestamp(cursor + span)}",
                      chunk.strip(), ""]
            cursor += span
    out.write_text("\n".join(lines), encoding="utf-8")
    return out


def write_chapters(scenes, out_txt, *, title="Video") -> Path:
    """Write an FFMETADATA chapter file from the scene timeline."""
    out = Path(out_txt)
    out.parent.mkdir(parents=True, exist_ok=True)
    parts = [";FFMETADATA1", f"title={title}"]
    for scene in scenes:
        start = int(round(scene["start"] * 1000))
        end = int(round((scene["start"] + scene["duration"]) * 1000))
        parts += ["[CHAPTER]", "TIMEBASE=1/1000", f"START={start}", f"END={end}",
                  f"title={scene.get('title') or scene.get('id', '')}"]
    out.write_text("\n".join(parts) + "\n", encoding="utf-8")
    return out


def apply_metadata(in_mp4, meta_txt, out_mp4) -> Path:
    run(["-loglevel", "error", "-y", "-i", in_mp4, "-i", meta_txt, "-map_metadata", "1",
         "-map", "0", "-c", "copy", "-movflags", "+faststart", out_mp4])
    return Path(out_mp4)


def add_subtitles(in_mp4, srt, out_mp4, *, burn=False) -> Path:
    """Burn captions in (libass) or mux them as a soft mov_text track."""
    if burn and has_filter("subtitles"):
        run(["-loglevel", "error", "-y", "-i", in_mp4, "-vf", f"subtitles={srt}:force_style='{SRT_STYLE}'",
             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-c:a", "copy",
             "-movflags", "+faststart", out_mp4])
    else:
        run(["-loglevel", "error", "-y", "-i", in_mp4, "-i", srt, "-map", "0", "-map", "1",
             "-c:v", "copy", "-c:a", "copy", "-c:s", "mov_text",
             "-movflags", "+faststart", out_mp4])
    return Path(out_mp4)


def mix_music(in_mp4, music, out_mp4, *, gain=0.12) -> Path:
    """Mix a licensed music bed under the narration at low gain."""
    run(["-loglevel", "error", "-y", "-i", in_mp4, "-i", music, "-filter_complex",
         f"[1:a]volume={gain}[bed];[0:a][bed]amix=inputs=2:duration=first:dropout_transition=2[a]",
         "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
         "-movflags", "+faststart", out_mp4])
    return Path(out_mp4)


def _json_literal(data) -> str:
    """`data` as JSON that is safe inside a `<script>` block.

    `json.dumps` leaves `/`, `<` and `&` untouched, so a chapter title could close the surrounding
    `/* … */` comment (`*/`) or open a `</script>` tag. Escaping them keeps the markup inert.
    """
    text = json.dumps(data, ensure_ascii=False)
    for char, escape in (("/", "\\/"), ("<", "\\u003c"), (">", "\\u003e"), ("&", "\\u0026"),
                         ("\u2028", "\\u2028"), ("\u2029", "\\u2029")):
        text = text.replace(char, escape)
    return text


def build_player(scenes, video_rel, out_html, *, title="Video", template) -> Path:
    """Render the interactive player (chapter buttons + captions track)."""
    chapters = [
        {"title": scene.get("title") or scene.get("id", ""), "start": round(scene["start"], 3)}
        for scene in scenes
    ]
    markup = (
        Path(template)
        .read_text(encoding="utf-8")
        .replace("/*__CHAPTERS__*/", _json_literal(chapters))
        .replace("__TITLE__", html.escape(title))
        .replace("__VIDEO__", html.escape(video_rel, quote=True))
    )
    out = Path(out_html)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(markup, encoding="utf-8")
    return out


# --------------------------------------------------------------------------- clip-based merge
def _filter_path(path) -> str:
    """Escape a path for use inside an ffmpeg filter argument."""
    text = str(Path(path).resolve()).replace("\\", "/")
    return "'" + text.replace(":", "\\:").replace("'", "\\'") + "'"


def build_srt_beats(beats, out_srt, *, total_s, max_words=7) -> Path:
    """Captions with exact timing from the voice clip: one cue per beat, long beats split by words."""
    out = Path(out_srt)
    out.parent.mkdir(parents=True, exist_ok=True)
    lines, index = [], 0
    for i, beat in enumerate(beats):
        start = beat["start"] / 1000
        end = (beats[i + 1]["start"] / 1000 if i + 1 < len(beats) else total_s)
        end = min(end, start + (beat["end"] - beat["start"]) / 1000 + 0.35)
        words = beat["say"].split()
        chunks = [" ".join(words[j:j + max_words]) for j in range(0, len(words), max_words)] or [beat["say"]]
        total_chars = sum(len(c) for c in chunks)
        cursor = start
        for chunk in chunks:
            span = (end - start) * len(chunk) / total_chars
            index += 1
            lines += [str(index), f"{_timestamp(cursor)} --> {_timestamp(cursor + span)}", chunk, ""]
            cursor += span
    out.write_text("\n".join(lines), encoding="utf-8")
    return out


def contact_sheet(video, out_png, *, tiles=16) -> Path:
    """Tile `tiles` evenly-spaced frames into a 4x4 PNG for one-glance QA.

    Shared by `vc sheet` and `vc merge` so the QA image is produced by one recipe.
    """
    duration = probe(video)["duration"] or float(tiles)
    step = max(0.5, duration / tiles)
    run(["-loglevel", "error", "-y", "-i", video, "-vf",
         f"fps=1/{step:.3f},scale=480:-2,tile=4x4", "-frames:v", "1", str(out_png)])
    return Path(out_png)


def merge_clips(clips, out_mov) -> Path:
    """Concatenate identically-encoded clips by stream copy (no re-encode, no drift)."""
    out = Path(out_mov)
    listing = out.parent / "concat-clips.txt"
    listing.write_text("".join(f"file '{Path(c).resolve().as_posix()}'\n" for c in clips), encoding="utf-8")
    run(["-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", listing, "-c", "copy", out])
    return out


def _finalize_once(cmd, out, *, music, srt, burn, gain, loudnorm) -> None:
    voice = "[0:a]loudnorm=I=-16:TP=-1.5:LRA=11[v]" if loudnorm else "[0:a]anull[v]"
    if music:
        graph = f"{voice};[1:a]volume={gain}[bed];[v][bed]amix=inputs=2:duration=first:dropout_transition=2[a]"
    else:
        graph = f"{voice};[v]anull[a]"
    video = ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p"]
    if srt and burn and has_filter("subtitles"):
        graph += f";[0:v]subtitles={_filter_path(srt)}:force_style='{SRT_STYLE}'[vv]"
        maps = ["-map", "[vv]", "-map", "[a]"]
    else:
        maps = ["-map", "0:v", "-map", "[a]"]
        video = ["-c:v", "copy"]
    if srt and not burn:
        maps += ["-map", f"{2 if music else 1}:0", "-c:s", "mov_text"]
    run(cmd + ["-filter_complex", graph, *maps, *video, "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
               "-movflags", "+faststart", out])


def finalize(merged, out_mp4, *, srt=None, burn=True, music=None, gain=0.12, loudnorm=True) -> Path:
    """One pass: AAC audio (loudness-normalized, optional music bed) + captions (burned or soft).

    Retries without loudnorm if that filter fails, because `loudnorm` emits NaN on digital
    silence (captions-only builds) and would otherwise fail the AAC encode.
    """
    out = Path(out_mp4)
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = ["-loglevel", "error", "-y", "-i", merged]
    if music:
        cmd += ["-i", music]
    if srt and not burn:
        cmd += ["-i", srt]
    variants = [loudnorm, False] if loudnorm else [False]
    for attempt, use in enumerate(variants):
        try:
            _finalize_once(cmd, out, music=music, srt=srt, burn=burn, gain=gain, loudnorm=use)
            return out
        except subprocess.CalledProcessError:
            if attempt == len(variants) - 1:
                raise
            print("WARNING: loudnorm failed (silent audio?) - retrying without normalization", file=sys.stderr)
    return out
