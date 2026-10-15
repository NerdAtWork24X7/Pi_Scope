"""MiMo-TTS helpers (voice "Milo") — no video-generation models involved.

Three ingestion paths, all key-free-or-free-tier and local-first:
  * api_synthesize():     OpenAI-compatible call. Credentials resolve automatically
                          to the Xiaomi token-plan key in ~/.pi/agent/auth.json
                          (provider `xiaomi-token-plan-ams`); MIMO_API_KEY env
                          overrides and switches to the public endpoint.
  * browser_synthesize(): drives the MiMo-TTS web UI with Playwright directly
                          (no pi `browser` tool, no system-audio capture) and
                          saves WAV. Use it when you prefer the web UI or have
                          no API key.
  * save_base64():        write base64 audio to WAV (used by api_synthesize and
                          for hand-extracted payloads).

Raw 24 kHz PCM16 is wrapped in a WAV container automatically.
"""

from __future__ import annotations

import base64
import json
import os
import re
import urllib.error
import urllib.request
import wave
from pathlib import Path

TOKEN_PLAN_BASE_URL = "https://token-plan-ams.xiaomimimo.com/v1"
PUBLIC_BASE_URL = "https://api.xiaomimimo.com/v1"
DEFAULT_BASE_URL = TOKEN_PLAN_BASE_URL
DEFAULT_MODEL = "mimo-v2.5-tts"
DEFAULT_VOICE = "Milo"
DEFAULT_RATE = 24_000  # MiMo-TTS PCM16 output is 24 kHz mono

_DATA_URI = re.compile(r"^data:[^;]+;base64,", re.I)

_AUTH_FILE = Path.home() / ".pi" / "agent" / "auth.json"
_TOKEN_PLAN_PROVIDERS = ("xiaomi-token-plan-ams", "xiaomi-token-plan", "xiaomi")


def _key_from_env():
    for name in ("MIMO_API_KEY", "XIAOMI_API_KEY", "XIAOMI_TOKEN_PLAN_KEY"):
        value = os.environ.get(name)
        if value:
            base = TOKEN_PLAN_BASE_URL if "TOKEN" in name else PUBLIC_BASE_URL
            return value, f"env:{name}", base
    return None


def _key_from_pi_auth():
    try:
        data = json.loads(_AUTH_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    for provider in _TOKEN_PLAN_PROVIDERS:
        entry = data.get(provider) or {}
        key = entry.get("key") or entry.get("access")
        if key:
            return key, f"auth.json:{provider}", TOKEN_PLAN_BASE_URL
    return None


def resolve_credentials():
    """Resolve `(api_key, base_url, source)` from the environment or pi's auth.json.

    The Xiaomi token-plan key (provider `xiaomi-token-plan-ams`) is picked up
    automatically. `MIMO_BASE_URL` / `XIAOMI_BASE_URL` override the endpoint.
    """
    override = os.environ.get("MIMO_BASE_URL") or os.environ.get("XIAOMI_BASE_URL")
    resolved = _key_from_env() or _key_from_pi_auth()
    if not resolved:
        return None, override or DEFAULT_BASE_URL, None
    key, source, base = resolved
    return key, override or base, source


def save_base64(payload: str, out_wav, *, sample_rate: int = DEFAULT_RATE) -> Path:
    """Write base64 audio to `out_wav`. Raw PCM16 gets a WAV header."""
    raw = base64.b64decode(_DATA_URI.sub("", payload.strip()))
    out = Path(out_wav)
    out.parent.mkdir(parents=True, exist_ok=True)
    if raw[:4] == b"RIFF" or raw[:3] == b"ID3" or raw[:2] == b"\xff\xfb":
        out.write_bytes(raw)
        return out
    with wave.open(str(out), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(raw)
    return out


# --- Playwright web-UI path (replaces the pi `browser` tool) -----------------

_AUDIO_EXT = re.compile(r"\.(wav|mp3|m4a|ogg|opus)(\?|$)", re.I)
_AUDIO_HINT = ("/tts", "/speech", "/synthes")
_GRAB_JS = """(async () => {
  const urls = [...document.querySelectorAll('audio')].map(a => a.currentSrc || a.src).filter(Boolean);
  const src = urls.reverse().find(s => s.startsWith('blob:') || s.startsWith('data:'))
              || (window.__lastAudioUrl || '');
  if (!src || !(src.startsWith('blob:') || src.startsWith('data:'))) return '';
  const ab = await (await fetch(src)).arrayBuffer();
  const u = new Uint8Array(ab);
  let bin = '';
  for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(bin);
})()"""


def _looks_audio(url: str, headers) -> bool:
    ctype = str((headers or {}).get("content-type", "")).lower()
    low = (url or "").lower()
    return ctype.startswith("audio/") or bool(_AUDIO_EXT.search(low)) or any(h in low for h in _AUDIO_HINT)


def _first_visible(page, selectors):
    for sel in selectors:
        if not sel:
            continue
        try:
            loc = page.locator(sel).first
            if loc.count() and loc.is_visible():
                return loc
        except Exception:  # noqa: BLE001 - a bad selector must not abort the run
            continue
    return None


def _submit_text(page, text, input_selector, submit_selector) -> None:
    box = _first_visible(page, [input_selector, "textarea", "[contenteditable='true']",
                                "[contenteditable=true]", "input[type='text']"])
    if box is None:
        raise RuntimeError("TTS prompt box not found — pass --input-selector")
    box.click()
    try:
        box.fill(text)
    except Exception:  # noqa: BLE001 - contenteditable may reject fill()
        box.type(text)
    button = _first_visible(page, [submit_selector, "button:has-text('生成')", "button:has-text('合成')",
                                   "button:has-text('朗读')", "button:has-text('发送')",
                                   "button:has-text('Generate')", "button:has-text('Send')",
                                   "button:has-text('Speak')", "button[type='submit']"])
    if button is not None:
        button.click()
    else:
        page.keyboard.press("Enter")


def _write_audio(raw: bytes, out_wav) -> Path:
    out = Path(out_wav)
    out.parent.mkdir(parents=True, exist_ok=True)
    if raw[:4] == b"RIFF":  # already a WAV container
        out.write_bytes(raw)
        return out
    from .ffmpeg import FfmpegError, run

    tmp = out.with_name(out.name + ".src")
    tmp.write_bytes(raw)
    try:
        run(["-y", "-i", str(tmp), "-ar", str(DEFAULT_RATE), "-ac", "1", str(out)])
        return out
    except FfmpegError:  # headerless PCM16 -> wrap in a WAV container
        return save_base64(base64.b64encode(raw).decode("ascii"), out)
    finally:
        tmp.unlink(missing_ok=True)


def browser_synthesize(url, out_wav, *, text=None, input_selector=None, submit_selector=None,
                       manual=False, headless=True, timeout=120_000) -> Path:
    """Synthesize by driving the MiMo-TTS web UI with Playwright, then save WAV.

    No pi `browser` tool and no system-audio capture: Chromium opens `url`, types
    `text` and submits (unless `manual`), then the generated audio is taken from
    the network response or the page's `blob:`/`data:` <audio> URL. `manual=True`
    opens a headed window so you can generate the clip yourself.
    """
    import time

    from playwright.sync_api import sync_playwright

    captured: list[bytes] = []
    pending: list = []

    def on_response(resp):
        try:
            if _looks_audio(resp.url, resp.headers):
                pending.append(resp)
        except Exception:  # noqa: BLE001 - ignore malformed responses
            pass

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=headless and not manual,
                                     args=["--disable-dev-shm-usage",
                                           "--autoplay-policy=no-user-gesture-required"])
        try:
            page = browser.new_context(accept_downloads=True).new_page()
            page.on("response", on_response)
            page.goto(url, wait_until="domcontentloaded", timeout=timeout)
            if text and not manual:
                _submit_text(page, text, input_selector, submit_selector)
            deadline = time.monotonic() + timeout / 1000
            while not captured and time.monotonic() < deadline:
                while pending and not captured:
                    try:
                        body = pending.pop(0).body()
                        if body and len(body) > 512:
                            captured.append(body)
                    except Exception:  # noqa: BLE001
                        pass
                if captured:
                    break
                try:
                    blob = page.evaluate(_GRAB_JS)
                except Exception:  # noqa: BLE001
                    blob = ""
                if blob:
                    captured.append(base64.b64decode(blob))
                    break
                page.wait_for_timeout(400)
        finally:
            browser.close()

    if not captured:
        raise RuntimeError(
            "no TTS audio captured — check --url/--input-selector/--submit-selector, "
            "raise --timeout, or run with --manual and generate the clip by hand"
        )
    return _write_audio(captured[0], out_wav)


def api_synthesize(
    text,
    out_wav,
    *,
    style=None,
    voice=DEFAULT_VOICE,
    model=DEFAULT_MODEL,
    base_url=None,
    api_key=None,
    timeout=180,
) -> Path:
    """Synthesize `text` with the MiMo-TTS API. Style goes in the `user` message."""
    resolved_key, resolved_base, _ = resolve_credentials()
    key = api_key or resolved_key
    base = base_url or resolved_base
    if not key:
        raise RuntimeError(
            "no MiMo/Xiaomi key found — export MIMO_API_KEY or sign in so "
            "~/.pi/agent/auth.json has a xiaomi-token-plan-ams key"
        )

    messages = []
    if style:
        messages.append({"role": "user", "content": style})
    messages.append({"role": "assistant", "content": text})

    body = json.dumps(
        {"model": model, "messages": messages, "audio": {"format": "wav", "voice": voice}}
    ).encode("utf-8")
    request = urllib.request.Request(
        f"{base.rstrip('/')}/chat/completions",
        data=body,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:  # keep the key out of the message
        detail = exc.read().decode("utf-8", "replace")[:300]
        raise RuntimeError(f"MiMo TTS HTTP {exc.code}: {detail}") from exc

    return save_base64(data["choices"][0]["message"]["audio"]["data"], out_wav)


def normalize(in_audio, out_wav, *, loudness=-16.0, rate=48_000) -> Path:
    """EBU R128 loudness-normalize narration to a uniform target."""
    from .ffmpeg import run

    out = Path(out_wav)
    out.parent.mkdir(parents=True, exist_ok=True)
    run(
        ["-y", "-i", in_audio, "-af", f"loudnorm=I={loudness}:TP=-1.5:LRA=11",
         "-ar", rate, "-ac", 1, out]
    )
    return out


def silence_wav(out_wav, ms, *, rate=DEFAULT_RATE) -> Path:
    out = Path(out_wav)
    out.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(out), "wb") as dst:
        dst.setnchannels(1); dst.setsampwidth(2); dst.setframerate(rate)
        dst.writeframes(b"\x00\x00" * int(rate * ms / 1000))
    return out


def concat_wavs(parts, out_wav, *, gap_ms=180, lead_ms=0, tail_ms=0):
    """Join same-format WAV clips with silences. Returns (marks, total_s); marks[i] =
    {start, duration} in seconds on the joined timeline (lead silence included)."""
    out = Path(out_wav)
    out.parent.mkdir(parents=True, exist_ok=True)
    marks, params, t = [], None, lead_ms / 1000

    def pad(dst, ms, cur):
        dst.writeframes(b"\x00" * (int(cur[2] * ms / 1000) * cur[0] * cur[1]))

    with wave.open(str(out), "wb") as dst:
        for i, part in enumerate(parts):
            with wave.open(str(part), "rb") as src:
                cur = (src.getnchannels(), src.getsampwidth(), src.getframerate())
                if params is None:
                    params = cur
                    dst.setnchannels(cur[0]); dst.setsampwidth(cur[1]); dst.setframerate(cur[2])
                    if lead_ms:
                        pad(dst, lead_ms, cur)
                elif cur != params:
                    raise RuntimeError(f"WAV format mismatch in {part}: {cur} != {params}")
                data, dur = src.readframes(src.getnframes()), src.getnframes() / cur[2]
            if i:
                pad(dst, gap_ms, cur)
                t += gap_ms / 1000
            marks.append({"start": round(t, 3), "duration": round(dur, 3)})
            dst.writeframes(data)
            t += dur
        if params and tail_ms:
            pad(dst, tail_ms, params)
            t += tail_ms / 1000
    return marks, t
