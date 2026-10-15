"""FFmpeg discovery and small process/probe helpers.

The skill ships `imageio-ffmpeg`, whose bundled binary is a full static build
(libx264, aac, libmp3lame, libvpx, libopus, libass). It is the only encoder used
for final output — Playwright's own ffmpeg is webm/VP8-only and must never be
used for muxing.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from functools import lru_cache
from pathlib import Path


class FfmpegError(RuntimeError):
    """Raised when no usable FFmpeg binary can be found."""


REINSTALL_HINT = "reinstall the toolchain: rm -rf <skill>/.venv && <skill>/scripts/setup.sh"


@lru_cache(maxsize=1)
def ffmpeg_exe() -> str:
    """The ffmpeg binary to use: `FFMPEG_BIN`/`IMAGEIO_FFMPEG_EXE`, the bundled build, or PATH.

    A half-installed `imageio-ffmpeg` (interrupted install, truncated files) raises on import —
    that is reported as *broken*, not merely *missing*, so the fix is unambiguous.
    """
    # An explicit override must be honoured, not silently ignored: a stale path would otherwise
    # make you think you were testing with a different ffmpeg than you were.
    for name in ("FFMPEG_BIN", "IMAGEIO_FFMPEG_EXE"):
        cand = os.environ.get(name)
        if not cand:
            continue
        if not Path(cand).is_file():
            raise FfmpegError(f"{name}={cand} is not a file")
        if not os.access(cand, os.X_OK):
            raise FfmpegError(f"{name}={cand} is not executable")
        return cand
    broken = ""
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as exc:  # noqa: BLE001 - report whatever went wrong, then fall back
        broken = f"the bundled imageio-ffmpeg looks broken ({type(exc).__name__}: {exc})"
    found = shutil.which("ffmpeg")
    if found:
        return found
    raise FfmpegError(
        "ffmpeg not found. Run scripts/setup.sh (installs imageio-ffmpeg) or set "
        "FFMPEG_BIN to an ffmpeg binary." + (f" — {broken}; {REINSTALL_HINT}" if broken else "")
    )


def run(args, *, capture: bool = False, check: bool = True) -> subprocess.CompletedProcess:
    """Run ffmpeg with `args`. capture=True keeps stdout/stderr as text."""
    cmd = [ffmpeg_exe(), "-hide_banner", "-nostdin", *[str(a) for a in args]]
    return subprocess.run(cmd, capture_output=capture, text=True, check=check)


@lru_cache(maxsize=1)
def _encoders() -> str:
    return run(["-encoders"], capture=True, check=False).stdout or ""


def has_encoder(name: str) -> bool:
    return name in _encoders()


@lru_cache(maxsize=1)
def _filters() -> str:
    return run(["-filters"], capture=True, check=False).stdout or ""


def has_filter(name: str) -> bool:
    return re.search(rf"\b{re.escape(name)}\b", _filters()) is not None


_DURATION = re.compile(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)")
_DIM = re.compile(r"(\d{2,5})x(\d{2,5})")
_FPS = re.compile(r"([\d.]+)\s+fps")


def probe(path) -> dict:
    """Parse `ffmpeg -i` stderr into {duration, video:{...}, audio:{...}}.

    imageio-ffmpeg ships no ffprobe, so stream metadata is read from ffmpeg.
    """
    err = run(["-i", path], capture=True, check=False).stderr or ""
    info: dict = {"path": str(path), "duration": None, "video": None, "audio": None}

    match = _DURATION.search(err)
    if match:
        hours, minutes, seconds = match.groups()
        info["duration"] = int(hours) * 3600 + int(minutes) * 60 + float(seconds)

    for line in err.splitlines():
        line = line.strip()
        if not line.startswith("Stream #"):
            continue
        if "Video:" in line and info["video"] is None:
            codec = line.split("Video:", 1)[1].strip().split()[0].rstrip(",")
            dim = _DIM.search(line)
            fps = _FPS.search(line)
            info["video"] = {
                "codec": codec,
                "width": int(dim.group(1)) if dim else None,
                "height": int(dim.group(2)) if dim else None,
                "fps": float(fps.group(1)) if fps else None,
            }
        elif "Audio:" in line and info["audio"] is None:
            codec = line.split("Audio:", 1)[1].strip().split()[0].rstrip(",")
            info["audio"] = {"codec": codec}
    return info
