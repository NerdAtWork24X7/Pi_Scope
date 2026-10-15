"""Render ONE shot as a small, self-contained clip: picture + the exact slice of the voice clip.

Frame-exact: video has exactly `frames` frames and audio exactly frames/fps seconds, so clips
concatenate with zero drift and the final timeline equals the voice timeline.
Clips are .mov (H.264 + PCM) so no AAC priming gaps appear at joins; AAC is encoded once at merge.

Generated scenes are captured by ONE shared Chromium and streamed into FFmpeg as JPEG over stdin
— no per-frame PNG files on disk, no browser launch per shot.
"""

from __future__ import annotations

import asyncio
import contextlib
import subprocess

from . import capture
from .ffmpeg import ffmpeg_exe

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
VIDEO_EXT = {".mp4", ".mov", ".webm", ".mkv", ".m4v", ".avi"}


def _fit(width, height):
    return (f"scale={width}:{height}:force_original_aspect_ratio=increase,"
            f"crop={width}:{height},setsar=1")


def ffmpeg_args(job: dict) -> list:
    """FFmpeg command for one shot; HTML scenes read MJPEG frames from stdin (input 0)."""
    fps, frames = int(job["fps"]), int(job["frames"])
    width, height = int(job["w"]), int(job["h"])
    dur = frames / fps
    kind = job["kind"]
    if kind == "html":
        vin = ["-f", "image2pipe", "-vcodec", "mjpeg", "-framerate", str(fps), "-i", "pipe:0"]
        vf = "format=yuv420p"
    elif kind == "video":
        vin = ["-stream_loop", "-1", "-ss", f"{float(job.get('start_s', 0)):.3f}", "-i", job["asset"]]
        vf = f"{_fit(width, height)},fps={fps},format=yuv420p"
    elif kind == "image":
        vin = ["-framerate", str(fps), "-loop", "1", "-i", job["asset"]]
        vf = (f"scale={width * 2}:{height * 2}:force_original_aspect_ratio=increase,crop={width * 2}:{height * 2},"
              f"zoompan=z='1+0.12*on/{frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s={width}x{height}:fps={fps},"
              "setsar=1,format=yuv420p")
    else:
        raise ValueError(f"unknown clip kind {kind!r}")

    pad = float(job.get("pad_s", 0.5))
    # Audio is forced to EXACTLY `frames/fps` seconds starting at t=0 (atrim caps, apad fills),
    # so every clip's audio length equals its video length to the sample — no cumulative drift.
    audio = f"atrim=end={dur:.6f},apad=whole_dur={dur:.6f}"
    return [ffmpeg_exe(), "-loglevel", "error", "-y", *vin,
            "-ss", f"{float(job['a_start_s']):.6f}", "-t", f"{dur:.6f}", "-i", job["voice"],
            "-map", "0:v:0", "-map", "1:a:0",
            "-vf", f"tpad=stop_mode=clone:stop_duration={pad:.3f},{vf}",
            "-af", audio, "-ar", "48000", "-ac", "1",
            "-r", str(fps), "-fps_mode", "cfr", "-frames:v", str(frames), "-t", f"{dur:.6f}",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "17",
            "-c:a", "pcm_s16le", str(job["out"])]


def _tail(stderr: bytes) -> str:
    return stderr.decode("utf-8", "replace").strip()[-400:] or "ffmpeg failed"


@contextlib.asynccontextmanager
async def _frames_to_ffmpeg(job: dict):
    """Run ffmpeg and yield its `write(bytes)` for MJPEG frames on stdin.

    Shared by generated scenes and `browse` shots (both feed `kind="html"` frames); a failure while
    streaming, or a non-zero exit, is raised with ffmpeg's stderr tail, and the process is never
    left running.
    """
    proc = await asyncio.create_subprocess_exec(
        *ffmpeg_args(dict(job, kind="html")), stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

    async def write(data: bytes) -> None:
        proc.stdin.write(data)
        await proc.stdin.drain()

    try:
        yield write
        proc.stdin.close()
        await proc.stdin.wait_closed()
        stderr = await proc.stderr.read()
        if await proc.wait():
            raise RuntimeError(_tail(stderr))
    finally:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()


async def render_media_shot(job: dict) -> None:
    """Image/video asset -> clip (FFmpeg only; the asset is read directly)."""
    proc = await asyncio.create_subprocess_exec(
        *ffmpeg_args(job), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    stderr = await proc.stderr.read()
    if await proc.wait():
        raise RuntimeError(_tail(stderr))


async def render_html_shot(browser, job: dict) -> None:
    """Generated scene -> clip: seek one page per frame, stream JPEGs into FFmpeg's stdin."""
    frames, fps = int(job["frames"]), int(job["fps"])
    async with _frames_to_ffmpeg(job) as write:
        context = await capture.new_context(browser, job["w"], job["h"])
        try:
            page = await context.new_page()
            await page.goto(capture.page_url(job["html"]), wait_until="load")
            await page.evaluate(capture.READY_JS)
            await capture.stream_frames(page, frames, fps, write)
        finally:
            await context.close()


async def render_browse_shot(browser, job: dict) -> None:
    """Drive a real page through the shot's actions and capture it FRAME-EXACT into the clip.

    Frames are sampled on the clip clock (frame i == shot time i/fps) and streamed into FFmpeg,
    exactly like a generated scene, so a recorded shot can never drift against the narration —
    Playwright's screencast PTS (which drops the leading static period) is not trusted. Short
    actions run inline; `type`/`scroll` run in the background so frames capture them in progress;
    a dependent action first waits for the pending long ones.
    """
    frames, fps = int(job["frames"]), int(job["fps"])
    async with _frames_to_ffmpeg(job) as write:
        context = await capture.new_context(browser, job["w"], job["h"])
        try:
            page = await context.new_page()
            page.set_default_timeout(capture.DEFAULT_ACTION_TIMEOUT_MS)
            schedule = sorted(job["actions"], key=lambda a: a.get("at", 0))
            background: list = []
            nxt = 0

            for i in range(frames):
                t_ms = i * 1000.0 / fps
                while nxt < len(schedule) and schedule[nxt].get("at", 0) <= t_ms:
                    action = schedule[nxt]
                    nxt += 1
                    if action.get("type") in ("type", "scroll"):
                        background.append(asyncio.create_task(capture.apply_action(page, action)))
                    else:
                        for task in background:  # finish queued long actions before a dependent one
                            await task
                        background.clear()
                        await capture.apply_action(page, action)
                await write(await capture.jpeg(page, capture.JPEG_QUALITY))
            for task in background:
                await task
        finally:
            await context.close()
