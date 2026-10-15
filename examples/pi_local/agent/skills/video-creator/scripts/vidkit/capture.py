"""Deterministic HTML capture: screen recording and frame-exact PNG capture.

Two modes:
  * record_scene()   headful screen recording of an interactive page (webm, VFR, no audio).
  * capture_frames() frame-exact PNGs by seeking the page's animations (CFR input to FFmpeg).

Determinism contract for scene HTML: no Date.now()/Math.random()/setTimeout autoplay;
expose `window.__ready` (a promise) and optionally `window.__seek(ms)`.
"""

from __future__ import annotations

import asyncio
import atexit
import time
from pathlib import Path


_SETUP_HINT = "reinstall the toolchain: rm -rf <skill>/.venv && <skill>/scripts/setup.sh"


def _playwright():
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:  # pragma: no cover - depends on setup.sh
        raise RuntimeError(f"playwright is unavailable ({exc}) — {_SETUP_HINT}") from exc
    return sync_playwright


def playwright_session():
    """A fresh Playwright async session, ready for `async with`.

    Every async capture path starts its browser through here, so a half-installed venv (interrupted
    install, truncated files) reports the exact fix instead of a bare ImportError traceback.
    """
    try:
        from playwright.async_api import async_playwright as entry
    except ImportError as exc:
        raise RuntimeError(f"playwright is unavailable ({exc}) — {_SETUP_HINT}") from exc
    return entry()


def _url(target) -> str:
    path = Path(target)
    return path.resolve().as_uri() if path.exists() else str(target)


_READY = "() => (window.__ready ?? document.fonts.ready)"
_SEEK = (
    "(ms) => { if (window.__seek) return window.__seek(ms); "
    "for (const a of document.getAnimations()) { a.pause(); a.currentTime = ms; } }"
)


# ONE deterministic context recipe (fixed locale/timezone/scale) for every capture path — sync and
# async, scene pages and browse shots — so a recording is reproducible and the two APIs cannot drift.
def context_options(width, height, *, scale: int = 1, **extra) -> dict:
    return {"viewport": {"width": int(width), "height": int(height)}, "device_scale_factor": scale,
            "locale": "en-US", "timezone_id": "UTC", **extra}


def _new_context(browser, width, height, **extra):
    return browser.new_context(**context_options(width, height, **extra))


async def new_context(browser, width, height, **extra):
    return await browser.new_context(**context_options(width, height, **extra))


# ── Reusable browser ──────────────────────────────────────────────────
# Launching Chromium costs ~0.7-1 s. The pipeline reuses ONE instance per
# process instead of starting a fresh browser for every shot / page pass, and
# the async render path shares a single instance across all shots (and the
# page-screenshot pass) at once.

_BROWSER = None
_PW = None
JPEG_QUALITY = 95
SCREENSHOT_RETRIES = 2
# Playwright's actionability auto-wait defaults to 30 s, which turns a single bad selector into a
# 30-second stall per action. 10 s keeps a real (slow) page viable while failing fast; override per
# action with `{"timeout": ms}`.
DEFAULT_ACTION_TIMEOUT_MS = 10_000
# /dev/shm is small in some containers; without this Chromium's capture pipeline
# can fail with a transient "Unable to capture screenshot" protocol error.
CHROMIUM_ARGS = ["--disable-dev-shm-usage"]


def browser():
    """Lazily start (and reuse) one headless Chromium for this process."""
    global _BROWSER, _PW
    if _BROWSER is None or not _BROWSER.is_connected():
        _PW = _playwright()().start()
        _BROWSER = _PW.chromium.launch(headless=True, args=CHROMIUM_ARGS)
    return _BROWSER


@atexit.register
def close_browser() -> None:
    """Best-effort teardown so the Playwright driver never outlives the CLI."""
    global _BROWSER, _PW
    try:
        if _BROWSER is not None:
            _BROWSER.close()
    except Exception:  # noqa: BLE001 - interpreter may already be tearing down
        pass
    try:
        if _PW is not None:
            _PW.stop()
    except Exception:  # noqa: BLE001
        pass
    _BROWSER = _PW = None


# Public JS hooks so the async render path can drive a page it owns.
READY_JS = _READY
SEEK_JS = _SEEK
page_url = _url


async def jpeg(page, quality: int) -> bytes:
    """One JPEG frame; retry a transient Chromium capture hiccup (deterministic re-capture)."""
    for attempt in range(SCREENSHOT_RETRIES + 1):
        try:
            return await page.screenshot(type="jpeg", quality=quality)
        except Exception:
            if attempt == SCREENSHOT_RETRIES:
                raise
            await asyncio.sleep(0.15 * (attempt + 1))
    raise AssertionError("unreachable")


async def stream_frames(page, frames: int, fps: int, write, *, quality: int = JPEG_QUALITY) -> int:
    """Seek `page` through a deterministic scene, handing each of `frames` JPEG frames to `write`.

    JPEG (not PNG) because the frames are fed straight into an H.264 encoder, and
    `write` streams them into FFmpeg's stdin — no per-frame files hit the disk.
    """
    for i in range(frames):
        await page.evaluate(_SEEK, i * 1000.0 / fps)
        await write(await jpeg(page, quality))
    return frames


# ── Scripted browser actions (the `browse` recorder) ──────────────────
# A `browse` shot replays a list of actions in a real Chromium and records it, so the clip
# shows the page actually being navigated/used instead of a static screenshot. A synthetic
# cursor makes clicks/typing legible in the resulting video.
#
# EVERY selector is resolved through Playwright's engine (locators), never raw
# `document.querySelector` — so `:has-text()`, `:visible`, `text=…` etc. behave identically in
# `wait`, `click`, `highlight`, `scroll` and the synthetic cursor. Raw CSS silently diverging is
# the worst kind of bug: it "works" in one action and throws in another.

ACTION_TYPES = {"goto", "click", "type", "press", "hover", "scroll", "wait", "highlight", "js"}

# Applied to a resolved element handle (`locator.evaluate`), so it accepts any Playwright selector.
_HIGHLIGHT_EL_JS = """(el) => {
  let s = document.getElementById('__vc_hl_style');
  if (!s) { s = document.createElement('style'); s.id = '__vc_hl_style';
    s.textContent = '.__vc_hl{outline:4px solid #B6FF3B !important;outline-offset:4px !important;'
      + 'box-shadow:0 0 0 10px rgba(182,255,59,.28) !important;border-radius:10px;transition:box-shadow .18s}';
    document.head.appendChild(s); }
  el.classList.add('__vc_hl');
  setTimeout(() => el.classList.remove('__vc_hl'), 1800);
  return true;
}"""

_CURSOR_JS = """() => {
  if (!document.body || document.getElementById('__vc_cursor')) return;
  const c = document.createElement('div'); c.id = '__vc_cursor';
  c.style.cssText = 'position:fixed;left:0;top:0;width:26px;height:26px;margin:-13px 0 0 -13px;'
    + 'border-radius:50%;border:3px solid #B6FF3B;background:rgba(182,255,59,.30);'
    + 'box-shadow:0 0 0 2px rgba(0,0,0,.45);pointer-events:none;z-index:2147483647;'
    + 'transform:translate(-60px,-60px);transition:transform .3s cubic-bezier(.2,.8,.2,1)';
  document.body.appendChild(c);
}"""

_CURSOR_POS_JS = """(p) => {
  const c = document.getElementById('__vc_cursor'); if (!c) return;
  c.style.transform = 'translate(' + p.x + 'px,' + p.y + 'px)';
}"""

# Reports why the element at a point is not directly clickable (used by `vc probe`), independent of
# Playwright actionability which we cannot query without performing the action.
HITTEST_JS = """(el) => {
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return 'zero-size';
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return 'off-screen';
  const top = document.elementFromPoint(x, y);
  if (!top) return 'no hit target';
  if (top === el || el.contains(top)) return null;
  return 'covered by ' + top.tagName.toLowerCase() + (top.id ? '#' + top.id : '');
}"""


async def _move_cursor(page, sel) -> None:
    await page.evaluate(_CURSOR_JS)
    try:
        box = await page.locator(sel).first.bounding_box(timeout=2000)
    except Exception:  # noqa: BLE001 - a missing selector is reported by probe; cursor is cosmetic
        box = None
    if box:
        await page.evaluate(_CURSOR_POS_JS, {"x": box["x"] + box["width"] / 2, "y": box["y"] + box["height"] / 2})
    await asyncio.sleep(0.32)  # let the transition finish so the click is legible


async def apply_action(page, action: dict, *, cursor: bool = True) -> None:
    """Apply one scripted browser action (see ACTION_TYPES) to `page`.

    Selectors go through Playwright's engine everywhere, so `:has-text()` / `:visible` work in
    `highlight`/`scroll`/`wait`/`click` alike.
    """
    kind = action.get("type")
    if kind not in ACTION_TYPES:
        raise ValueError(f"unknown action type: {kind!r}")
    sel = action.get("sel")
    timeout = action.get("timeout", DEFAULT_ACTION_TIMEOUT_MS)

    if kind == "goto":
        # `goto` carries the shot's url in a `browse` shot; elsewhere (a scene already opened by
        # `record_scene`) there is nothing to navigate to, so it just re-asserts page readiness.
        url = action.get("url") or action.get("src")
        if url:
            await page.goto(url, wait_until="load", timeout=timeout)
        await page.evaluate(READY_JS)
        if cursor:
            await page.evaluate(_CURSOR_JS)
        return
    if kind == "wait":
        # Default is `visible`; pass `state: attached` to wait for something inside a collapsed panel.
        await page.wait_for_selector(sel, state=action.get("state", "visible"), timeout=timeout)
        return
    if kind == "scroll":
        if sel:
            locator = page.locator(sel)
            if await locator.count():
                await locator.first.scroll_into_view_if_needed(timeout=timeout)
        else:
            await page.evaluate("(d) => window.scrollBy({top:d,behavior:'smooth'})", action.get("dy", 600))
        return
    if kind == "js":
        await page.evaluate(action.get("expr", "() => {}"))
        return
    if kind == "highlight":
        locator = page.locator(sel)
        if await locator.count():
            await locator.first.evaluate(_HIGHLIGHT_EL_JS)
        return

    if sel and cursor:
        await _move_cursor(page, sel)
    if kind == "click":
        await page.click(sel, timeout=timeout)
    elif kind == "type":
        await page.fill(sel, "", timeout=timeout)
        await page.locator(sel).press_sequentially(action.get("text", ""), delay=action.get("delay", 55))
    elif kind == "press":
        await page.press(sel, action.get("key", "Enter"), timeout=timeout)
    elif kind == "hover":
        await page.hover(sel, timeout=timeout)


def record_scene(html, out_webm, duration_ms, actions=None, *, width=1920, height=1080) -> Path:
    """Headful screen-record an interactive scene to `out_webm` (webm, no audio).

    Replays the same action list, through the same `apply_action` dispatcher, as a `browse` shot —
    so `record` and `browse` capture cannot diverge in behaviour.
    """
    out = Path(out_webm)
    out.parent.mkdir(parents=True, exist_ok=True)
    rec_dir = out.parent / "_rec"
    rec_dir.mkdir(parents=True, exist_ok=True)

    async def go() -> Path:
        async with playwright_session() as pw:
            browser = await pw.chromium.launch(headless=False)
            context = await new_context(browser, width, height, record_video_dir=str(rec_dir),
                                        record_video_size={"width": width, "height": height})
            try:
                page = await context.new_page()
                await page.goto(_url(html), wait_until="load")
                await page.evaluate(_READY)

                started = time.monotonic()
                for action in sorted(actions or [], key=lambda a: a.get("at", 0)):
                    await _sleep_until(started + action.get("at", 0) / 1000.0)
                    await apply_action(page, action)
                await _sleep_until(started + duration_ms / 1000.0)
                video = page.video
            finally:
                await context.close()
                await browser.close()
            return Path(await video.path())

    produced = asyncio.run(go())
    produced.replace(out)
    return out


def capture_frames(html, out_dir, duration_ms, *, fps=30, width=1920, height=1080):
    """Write frame-exact PNGs (f00000.png ...) by seeking the scene's animations."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    for stale in out.glob("f*.png"):
        stale.unlink()
    count = max(1, round(fps * duration_ms / 1000.0))

    context = _new_context(browser(), width, height)
    try:
        page = context.new_page()
        page.goto(_url(html), wait_until="load")
        page.evaluate(_READY)
        for i in range(count):
            page.evaluate(_SEEK, i * 1000.0 / fps)
            page.screenshot(path=str(out / f"f{i:05d}.png"))
    finally:
        context.close()

    return out, count


async def _sleep_until(deadline: float) -> None:
    delay = deadline - time.monotonic()
    if delay > 0:
        await asyncio.sleep(delay)
