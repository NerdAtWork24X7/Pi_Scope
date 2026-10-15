"""Post-render verification: stream shape, loudness, duration, black-run advisory.

Black-frame detection is reported as a **warning**, not a failure: dark-themed
scenes are legitimately near-black, so pixel darkness alone cannot distinguish a
design choice from a broken encode. Only a *contiguous* near-black run longer
than `black_run_s` is flagged. Pass `strict_black=True` to make it an error.
"""

from __future__ import annotations

import re
import subprocess

from .ffmpeg import ffmpeg_exe, probe, run

_BLACK_FRAME = re.compile(r"frame:(\d+) pblack:(\d+)")
_TOTAL_FRAMES = re.compile(r"frame=\s*(\d+)")
_MEAN = re.compile(r"mean_volume:\s*(-?[\d.]+) dB")
_MAX = re.compile(r"max_volume:\s*(-?[\d.]+) dB")


def black_frames(path, *, threshold=98, amount=32) -> dict:
    """Count near-black frames and the longest *contiguous* near-black run.

    `blackframe` only logs frames over the threshold, so contiguity is recovered
    from the frame indices it prints.
    """
    err = run(["-i", path, "-vf", f"blackframe={threshold}:{amount}", "-f", "null", "-"],
              capture=True, check=False).stderr or ""
    indices = [int(frame) for frame, pblack in _BLACK_FRAME.findall(err) if int(pblack) >= threshold]
    totals = _TOTAL_FRAMES.findall(err)
    longest = current = best_start = run_start = 0
    previous = None
    for index in indices:
        if previous is not None and index == previous + 1:
            current += 1
        else:
            current, run_start = 1, index
        if current > longest:
            longest, best_start = current, run_start
        previous = index
    return {
        "count": len(indices),
        "frames": int(totals[-1]) if totals else None,
        "longest_run": longest,
        "start_frame": best_start,  # first frame of the longest contiguous run (-1 if none)
    }


def loudness(path) -> dict:
    err = run(["-i", path, "-af", "volumedetect", "-f", "null", "-"],
              capture=True, check=False).stderr or ""
    mean = _MEAN.search(err)
    peak = _MAX.search(err)
    return {
        "mean_db": float(mean.group(1)) if mean else None,
        "max_db": float(peak.group(1)) if peak else None,
    }


_FREEZE_EVENT = re.compile(r"freeze_(start|duration|end):\s*([\d.]+)")


def freezes(path, *, min_s=4.0, total=None) -> list:
    """Freezes longer than `min_s` as `[{start, duration}]` (seconds) so they can be located.

    `freezedetect` only emits `freeze_duration` when motion resumes, so a freeze that runs to the
    end of the file has a `freeze_start` but no duration — recover it from the media length
    (`total`) instead of silently dropping the dead air at the tail.
    """
    err = run(["-i", path, "-vf", f"freezedetect=n=0.003:d={min_s}", "-an", "-f", "null", "-"],
              capture=True, check=False).stderr or ""
    events, pending = [], None
    for key, value in _FREEZE_EVENT.findall(err):
        if key == "start":
            pending = float(value)
        elif key == "duration":
            if pending is not None:
                events.append({"start": pending, "duration": float(value)})
            pending = None
        else:  # freeze_end — the run closed with a duration already recorded
            pending = None
    if pending is not None and total:  # a freeze that never resumed before EOF
        tail = total - pending
        if tail >= min_s:
            events.append({"start": pending, "duration": round(tail, 3)})
    return events


def locate(at, shots) -> str:
    """Map a time (s) to the shot id that covers it (assumes shots are ordered by start)."""
    current = "?"
    for shot in shots or []:
        if at >= shot["start"]:
            current = shot["id"]
        else:
            break
    return current


# Richness: sample ONE downscaled raw frame and measure how much is actually on screen, so a
# "static stretch" can be told apart from a genuinely blank page without hand-rolling a decoder.
_SAMPLE_W, _SAMPLE_H = 160, 90


def richness(path, at) -> dict | None:
    """Luma stddev, distinct quantized colours and edge energy of one frame at `at` seconds."""
    cmd = [ffmpeg_exe(), "-hide_banner", "-nostdin", "-loglevel", "error", "-ss", f"{max(0.0, at):.3f}",
           "-i", str(path), "-frames:v", "1", "-vf", f"scale={_SAMPLE_W}:{_SAMPLE_H},format=rgb24",
           "-f", "rawvideo", "pipe:1"]
    try:
        data = subprocess.run(cmd, capture_output=True).stdout
    except OSError:
        return None
    if len(data) < _SAMPLE_W * _SAMPLE_H * 3:
        return None
    luma, colors = [], set()
    for i in range(0, _SAMPLE_W * _SAMPLE_H * 3, 3):
        r, g, b = data[i], data[i + 1], data[i + 2]
        luma.append(0.299 * r + 0.587 * g + 0.114 * b)
        colors.add((r >> 5, g >> 5, b >> 5))
    mean = sum(luma) / len(luma)
    stddev = (sum((v - mean) ** 2 for v in luma) / len(luma)) ** 0.5
    edges = 0.0
    for y in range(_SAMPLE_H):
        row = y * _SAMPLE_W
        for x in range(_SAMPLE_W - 1):
            edges += abs(luma[row + x] - luma[row + x + 1])
        if y:
            edges += sum(abs(luma[row + x] - luma[row - _SAMPLE_W + x]) for x in range(_SAMPLE_W))
    return {"stddev": round(stddev, 1), "colors": len(colors), "edge": round(edges / (_SAMPLE_W * _SAMPLE_H), 2),
            "luma": round(mean, 1)}


def _richness_note(r) -> str:
    if not r:
        return ""
    if r["stddev"] < 2 and r["colors"] <= 2 and r["edge"] < 1:
        look = "looks BLANK"
    elif r["stddev"] < 6:
        look = "low detail"
    else:
        look = "rendered UI"
    return f"{look} (σ={r['stddev']}, colors={r['colors']}, edge={r['edge']})"


_TIME = re.compile(r"time=(\d+):(\d+):(\d+(?:\.\d+)?)")


def _stream_end(path, extra) -> float | None:
    """End time (s) of one stream. Decodes the stream: `-c copy` under-reports the last DTS."""
    err = run(["-i", path, *extra, "-f", "null", "-"], capture=True, check=False).stderr or ""
    times = _TIME.findall(err)
    if not times:
        return None
    hours, minutes, seconds = times[-1]
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def av_sync(path) -> dict:
    """Audio vs video end times. A difference beyond one frame means the two drift apart."""
    return {"video": _stream_end(path, ["-map", "0:v:0", "-an"]),
            "audio": _stream_end(path, ["-map", "0:a:0", "-vn"])}


def verify(path, *, expected_duration=None, tolerance=0.5, min_mean_db=-50.0,
           black_run_s=1.0, strict_black=False, shots=None) -> dict:
    info = probe(path)
    problems: list[str] = []
    warnings: list[str] = []
    findings: list[dict] = []

    if not info["video"]:
        problems.append("no video stream")
    if not info["audio"]:
        problems.append("no audio stream")
    if expected_duration is not None and info["duration"] is not None:
        if abs(info["duration"] - expected_duration) > tolerance:
            problems.append(
                f"duration {info['duration']:.2f}s != expected {expected_duration:.2f}s "
                f"(±{tolerance}s)"
            )

    black = black_frames(path)
    fps = (info["video"] or {}).get("fps") or 30.0

    sync = av_sync(path)
    if sync["video"] is not None and sync["audio"] is not None:
        delta = abs(sync["video"] - sync["audio"])
        if delta > 1.0 / fps + 0.05:
            problems.append(
                f"audio/video length mismatch: video {sync['video']:.2f}s vs audio {sync['audio']:.2f}s "
                f"(Δ{delta:.3f}s)")

    black_seconds = black["longest_run"] / fps
    if black_seconds > black_run_s:
        start = black.get("start_frame", 0) / fps
        rich = richness(path, start + black_seconds / 2)
        where = f"{locate(start, shots)} @ {start:.1f}s" if shots else f"{start:.1f}s"
        message = (f"[{where}] contiguous near-black run of {black_seconds:.1f}s "
                   f"({black['longest_run']} frames) — intended for dark themes, inspect otherwise"
                   + (f"; {_richness_note(rich)}" if rich else ""))
        (problems if strict_black else warnings).append(message)
        findings.append({"shot": locate(start, shots) if shots else None, "start": round(start, 2),
                         "dur": round(black_seconds, 2), "kind": "near-black", "richness": rich})

    for event in freezes(path, total=info["duration"]):
        rich = richness(path, event["start"] + event["duration"] / 2)
        where = f"{locate(event['start'], shots)} @ {event['start']:.1f}s" if shots else f"{event['start']:.1f}s"
        warnings.append(f"[{where}] static for {event['duration']:.1f}s — add motion or cut"
                        + (f"; {_richness_note(rich)}" if rich else ""))
        findings.append({"shot": locate(event["start"], shots) if shots else None, "start": round(event["start"], 2),
                         "dur": round(event["duration"], 2), "kind": "static", "richness": rich})

    level = loudness(path)
    if level["mean_db"] is not None and level["mean_db"] < min_mean_db:
        problems.append(f"audio may be silent (mean {level['mean_db']} dB)")

    return {"ok": not problems, "problems": problems, "warnings": warnings, "findings": findings,
            "probe": info, "black": black, "loudness": level, "sync": sync}
