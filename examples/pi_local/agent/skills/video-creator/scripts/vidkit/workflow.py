"""The 6-step workflow as small, checkable commands.

  1 brief -> 2 script.json -> 3 voice (voice.wav + beats.json) -> 4 plan.json (shots)
  -> 5 clips (one synced clip per shot) -> 6 merge (final MP4)

Time is the single source of truth: beats.json (from the real voice clip) -> shots -> frames.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import assemble, capture, clips as clipmod, palette, pipeline, scenes as scene_engine, site, tts, verify
# aliased: this module defines its own `probe` (the browse dry-run), which would otherwise shadow
# the media prober that `fetch` validates a download with.
from .ffmpeg import probe as ffprobe, run

PLAYER_TEMPLATE = Path(__file__).resolve().parents[2] / "assets" / "player.html.tmpl"
SOURCES = {"create", "asset", "find", "browse"}
ASSET_EXT = clipmod.IMAGE_EXT | clipmod.VIDEO_EXT
# A browse action before the page is interactive fires on a blank/partial page. `goto`/`js`/`wait`
# are page-setup actions and are allowed at t=0; real interactions (click/type/…) must wait.
BROWSE_LOAD_MS = 800
BROWSE_SETUP_ACTIONS = {"goto", "js", "wait"}
BROWSE_INTERACTIONS = {"click", "type", "press", "hover", "highlight", "scroll"}


def load(path):
    path = Path(path)
    if not path.exists():
        raise RuntimeError(f"{path} not found — run `vc next --work {path.parent}` to see which step "
                           "is missing")
    return json.loads(path.read_text(encoding="utf-8"))


def save(path, data):
    Path(path).write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def warn(msg):
    print(f"WARNING: {msg}", file=sys.stderr)


def canvas(fmt, draft):
    """Always 1080p-class: 1920x1080 (16:9) or 1080x1920 (9:16).

    `--draft` halves the frame count, never the resolution — every render is 1080p.
    """
    w, h = (1080, 1920) if fmt == "9:16" else (1920, 1080)
    return (w, h, 15 if draft else 30)


def _available_gb() -> int:
    """Free memory in whole GB; a machine we cannot read is assumed to be a modest 4 GB."""
    try:
        for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) // (1024 * 1024)
    except (OSError, ValueError, IndexError):
        pass
    return 4


def default_workers() -> int:
    """How many shots to render at once when `--workers` is not given.

    Each worker holds a Chromium page plus an ffmpeg encoder, so CPU count alone over-subscribes a
    small container and can take the run (and the toolchain) down with it. Scale with the lesser of
    the CPUs this process may use and the free memory; `--workers N` always wins.
    """
    try:
        cpus = len(os.sched_getaffinity(0))  # respects cgroup/container CPU limits
    except AttributeError:  # pragma: no cover - non-Linux
        cpus = os.cpu_count() or 2
    return max(1, min(4, cpus, max(1, _available_gb() // 2)))


def _estimate_seconds(beats) -> int:
    """Rough spoken length of a drafted script.

    Fitted to both voice paths (the 900 ms-per-beat placeholder and measured MiMo narration), so
    the "voice vs target" check stays meaningful whichever one produced the clip.
    """
    spoken = sum(max(1.2, len(b["say"].split()) / 2.1) for b in beats)
    return max(5, round(spoken + 0.18 * max(0, len(beats) - 1) + 0.95))


# =========================================================================== draft (web projects)
def draft(args, work, project):
    """Existing pages -> inspect; none -> scaffold a showcase site from the brief. Writes
    script.json + plan.json as a *starting point* to improve."""
    spec = pipeline.draft_spec(args, work, project)
    beats, shots = [], []
    for i, scene in enumerate(spec["scenes"], 1):
        ids = []
        for text in scene.pop("say"):
            beats.append({"id": f"b{len(beats) + 1}", "say": text, "intent": scene["type"]})
            ids.append(beats[-1]["id"])
        visual = scene.get("text") or scene.get("src") or scene.get("url", "")
        shots.append({"id": f"s{i}", "beats": ids, "visual": f"{scene['type']}: {visual}"[:90],
                      "source": "create", **scene})
    save(work / "script.json", {
        # target_s comes from the drafted beats, so the "voice vs target" check is meaningful
        # instead of always warning against a fixed 60 s.
        "title": spec["title"],
        "brief": {"goal": f"Showcase {spec['title']}", "format": spec["format"],
                  "target_s": _estimate_seconds(beats)},
        "voice": spec["voice"], "style": spec["style"], "beats": beats})
    save(work / "plan.json", {"theme": spec["theme"], "format": spec["format"], "project": spec["project"], "shots": shots})
    print(f"drafted {work / 'script.json'} and {work / 'plan.json'} ({len(beats)} beats, {len(shots)} shots)")


# =========================================================================== step 3: voice
def voice(work, *, mode, gap_ms=180, lead_ms=250, tail_ms=700, workers=4):
    script_path = work / "script.json"
    script = load(script_path)
    beats = script["beats"]
    ids = [b["id"] for b in beats]
    if len(set(ids)) != len(ids) or not all(b.get("say", "").strip() for b in beats):
        raise RuntimeError("script.json: every beat needs a unique id and non-empty 'say'")
    name = script.get("voice") or tts.DEFAULT_VOICE
    style = script.get("style") or "warm, confident narrator, natural pace"
    cache = work / "audio" / "cache"
    cache.mkdir(parents=True, exist_ok=True)

    clips, todo = [], {}
    for beat in beats:
        key = hashlib.sha1(f"{mode}|{name}|{style}|{beat['say']}".encode()).hexdigest()[:12]
        clip = cache / f"{key}.wav"
        clips.append(clip)
        if not clip.exists():
            todo[clip] = beat["say"]

    def synth(item):
        clip, text = item
        if mode == "api":
            tts.api_synthesize(text, clip, style=style, voice=name)
        else:
            tts.silence_wav(clip, max(900, int(len(text.split()) / 2.6 * 1000)))

    if todo:
        print(f"{'synthesizing' if mode == 'api' else 'estimating'} {len(todo)} beat(s)...")
        with ThreadPoolExecutor(max_workers=workers if mode == "api" else 1) as pool:
            list(pool.map(synth, todo.items()))

    marks, total = tts.concat_wavs(clips, work / "audio" / "voice.wav", gap_ms=gap_ms, lead_ms=lead_ms, tail_ms=tail_ms)
    out = []
    for beat, m in zip(beats, marks):
        out.append({"id": beat["id"], "say": beat["say"], "intent": beat.get("intent", ""),
                    "start": round(m["start"] * 1000), "end": round((m["start"] + m["duration"]) * 1000)})
    save(work / "beats.json", {"voice": "audio/voice.wav", "mode": mode, "total_ms": round(total * 1000),
                               "script_sha": hashlib.sha1(script_path.read_bytes()).hexdigest(), "beats": out})
    print(f"voice clip: {work / 'audio' / 'voice.wav'}  ({total:.1f}s, {len(out)} beats, "
          f"{'Milo narration' if mode == 'api' else 'SILENT placeholder'})")
    for b in out:
        print(f"  {b['id']:>4}  {b['start'] / 1000:6.2f}-{b['end'] / 1000:6.2f}s  {b['say'][:70]}")
    target = (script.get("brief") or {}).get("target_s")
    if target and not (0.7 * target <= total <= 1.3 * target):
        warn(f"voice is {total:.0f}s but target is {target}s — tighten or extend the script, then re-run voice")
    if len(out[0]["say"].split()) > 14:
        warn("hook beat is long (>14 words) — open with a short, punchy line")
    return mode


# =========================================================================== timeline (frame-exact)
def _resolve_actions(actions, by_id, shot_start_ms, *, problems=None, shot_id=""):
    """Resolve symbolic `on_beat` targets into clip-time `at` (ms from the shot start).

    A shot's first beat maps to offset 0, so a hand-computed `at` of 0 fires the action on the
    very first frame — before `goto`/`js` setup has run. `{"on_beat": "b7"}` makes the intent
    explicit and lets the timeline do the arithmetic; `offset` (ms) nudges it later.
    Actions are copied, so the plan on disk is never mutated.
    """
    resolved = []
    for action in actions or []:
        action = dict(action)
        beat_id = action.pop("on_beat", None)
        offset = int(action.pop("offset", 0))
        if beat_id is not None:
            beat = by_id.get(beat_id)
            if beat is None:
                if problems is not None:
                    problems.append(f"{shot_id}: on_beat {beat_id!r} is not a beat id in beats.json")
                action["at"] = offset
            else:
                action["at"] = max(0, round(beat["start"] - shot_start_ms)) + offset
        elif offset:
            action["at"] = int(action.get("at", 0)) + offset
        resolved.append(action)
    return resolved


def timeline(beats_doc, plan, fps):
    by_id = {b["id"]: b for b in beats_doc["beats"]}
    total_f = round(beats_doc["total_ms"] * fps / 1000)
    starts = [0 if k == 0 else round(by_id[s["beats"][0]]["start"] * fps / 1000) for k, s in enumerate(plan["shots"])]
    ends = starts[1:] + [total_f]
    items = []
    for shot, sf, ef in zip(plan["shots"], starts, ends):
        frames = max(1, ef - sf)
        start_ms = sf * 1000 / fps
        marks = [{"start": max(0, round(by_id[b]["start"] - start_ms)),
                  "duration": by_id[b]["end"] - by_id[b]["start"], "text": by_id[b]["say"]} for b in shot["beats"]]
        if "actions" in shot:
            shot = dict(shot, actions=_resolve_actions(shot["actions"], by_id, start_ms, shot_id=shot.get("id", "?")))
        items.append({"shot": shot, "start_f": sf, "frames": frames, "start_s": sf / fps,
                      "dur_ms": frames * 1000 / fps, "marks": marks})
    return items


def _asset_path(src, work, project):
    for base in (Path.cwd(), work, Path(project) if project else work):
        cand = Path(src) if Path(src).is_absolute() else base / src
        if cand.exists():
            return cand.resolve()
    return None


def _local_target(src, project, work):
    """The local file behind a `browse`/`page` target, or None when it is remote or env-driven.

    Lets a shot's cache key include the *page it points at*: editing the page you are demoing must
    re-render the shot. A remote url is left alone (hashing it would mean a request), so those
    still need `--force` after the site changes.
    """
    text = str(src or "")
    if "${" in text:
        return None
    if text.startswith("file://"):
        text = urllib.parse.unquote(urllib.parse.urlsplit(text).path)
    elif re.match(r"^[a-z][a-z0-9+.\-]*:", text, re.I):  # http:, https:, data:, …
        return None
    for base in (work, Path(project) if project else work, Path.cwd()):
        cand = Path(text) if Path(text).is_absolute() else base / text
        if cand.is_file():
            return cand.resolve()
    return None


# =========================================================================== step 4b: check the plan
def check(work, fps=30) -> int:
    beats_doc, plan = load(work / "beats.json"), load(work / "plan.json")
    script = load(work / "script.json")
    errors, warns = [], []
    shots = plan.get("shots", [])
    if not shots:
        errors.append("plan.json has no shots")
    all_ids = [b["id"] for b in beats_doc["beats"]]
    by_id = {b["id"]: b for b in beats_doc["beats"]}
    used = [b for s in shots for b in s.get("beats", [])]
    if used != all_ids:
        missing = [b for b in all_ids if b not in used]
        dupes = sorted({b for b in used if used.count(b) > 1})
        errors.append("shots must cover every beat exactly once, in order"
                      + (f"; missing: {missing}" if missing else "") + (f"; duplicated: {dupes}" if dupes else "")
                      + ("" if missing or dupes else "; order is wrong"))
    sha = beats_doc.get("script_sha")
    if sha and sha != hashlib.sha1((work / "script.json").read_bytes()).hexdigest():
        errors.append("script.json changed after voice — re-run `vc voice`")

    # The palette may be a curated name or a bespoke dict (see `vc theme`); validate a dict so a
    # malformed/illegible custom palette fails here rather than in an unreadable render.
    theme = pipeline.choose_theme(script, plan, plan.get("format"))
    errors += palette.problems(theme)

    run_type, run_len = None, 0
    probe_hint = False
    for s in shots:
        sid = s.get("id", "?")
        src = s.get("source")
        if src not in SOURCES:
            errors.append(f"{sid}: source must be one of {sorted(SOURCES)}")
        elif src == "find":
            errors.append(f"{sid}: still 'find' — run `vc fetch --url … --license … --shot {sid}` or switch to source:create")
        elif src == "create":
            kind = s.get("type")
            if kind not in scene_engine.RENDERERS:
                errors.append(f"{sid}: type must be one of {', '.join(scene_engine.RENDERERS)}")
            if kind == "page" and not s.get("src"):
                errors.append(f"{sid}: page shot needs 'src'")
        elif src == "asset":
            path = _asset_path(s.get("asset", ""), work, plan.get("project"))
            if not path:
                errors.append(f"{sid}: asset file not found: {s.get('asset')}")
            elif path.suffix.lower() not in ASSET_EXT:
                errors.append(f"{sid}: unsupported asset type {path.suffix}")
        elif src == "browse":
            if not s.get("url"):
                errors.append(f"{sid}: browse shot needs 'url'")
            else:
                unset = pipeline.missing_env(s["url"])
                if unset:
                    errors.append(f"{sid}: url uses unset env var(s) {unset} — export them or use a literal value")
            actions = s.get("actions", [])
            bad = sorted({a.get("type") for a in actions if a.get("type") not in capture.ACTION_TYPES})
            if bad:
                errors.append(f"{sid}: unknown action type(s) {bad}; use {sorted(capture.ACTION_TYPES)}")
            for a in actions:
                kind = a.get("type")
                if kind in ("click", "type", "press", "hover", "highlight", "wait") and not a.get("sel"):
                    errors.append(f"{sid}: a '{kind}' action needs 'sel'")
                if kind == "type" and "text" not in a:
                    errors.append(f"{sid}: a 'type' action needs 'text'")
                if kind == "js" and not a.get("expr"):
                    errors.append(f"{sid}: a 'js' action needs 'expr'")
                if kind == "wait" and a.get("state") not in (None, "visible", "hidden", "attached", "detached"):
                    errors.append(f"{sid}: wait state must be visible|hidden|attached|detached, not {a.get('state')!r}")
            unknown_beats = sorted({a["on_beat"] for a in actions if a.get("on_beat") and a["on_beat"] not in by_id})
            if unknown_beats:
                errors.append(f"{sid}: on_beat references unknown beat id(s) {unknown_beats}")
            start_ms = by_id[s["beats"][0]]["start"] if s.get("beats") and s["beats"][0] in by_id else 0
            resolved = _resolve_actions(actions, by_id, start_ms, shot_id=sid)
            waits = {}
            for raw, act in zip(actions, resolved):
                at = act.get("at", 0)
                if raw.get("type") == "wait" and raw.get("sel"):
                    waits.setdefault(raw["sel"], at)
                if raw.get("type") in BROWSE_INTERACTIONS and at < BROWSE_LOAD_MS:
                    errors.append(f"{sid}: {raw['type']} on {raw.get('sel', '')!r} at {at}ms would fire before the "
                                  f"page is interactive (<{BROWSE_LOAD_MS}ms) — use on_beat with an offset, or raise the at")
            for raw, act in zip(actions, resolved):
                sel = raw.get("sel")
                if raw.get("type") in BROWSE_INTERACTIONS and sel in waits and act.get("at", 0) < waits[sel]:
                    warns.append(f"{sid}: {raw['type']} on {sel!r} at {act.get('at', 0):.0f}ms runs before its "
                                 f"wait at {waits[sel]:.0f}ms — it may hit a hidden/absent element")
            if any(a.get("type") in ("click", "type", "press") for a in actions):
                probe_hint = True
        # A UI tour legitimately uses many browse shots on the same app — only repeated *generated*
        # scene types are a "vary the visuals" problem.
        if src == "browse":
            run_type, run_len = None, 0
        else:
            key = s.get("type") if src == "create" else src
            run_len = run_len + 1 if key == run_type else 1
            run_type = key
            if run_len == 3:
                warns.append(f"{sid}: 3 shots in a row of type '{key}' — vary the visuals")
        if len(s.get("beats", [])) > 4:
            warns.append(f"{sid}: covers {len(s['beats'])} beats — split it so something new appears every ~3s")
    if errors:
        for e in errors:
            print(f"ERROR   {e}")
        return 1

    tl = timeline(beats_doc, plan, fps)
    if isinstance(theme, dict):
        print(f"theme: custom palette  bg {theme.get('bg')}  accent {theme.get('accent')}  fg {theme.get('fg')}")
    else:
        print(f"theme: {theme}")
    print(f"{'shot':<5}{'time':<14}{'dur':>5}  {'source':<8}{'visual'}")
    for item in tl:
        s = item["shot"]
        source = s.get("source")
        dur = item["dur_ms"] / 1000
        label = (s.get("visual") or s.get("type") or Path(s.get("asset", "")).name
                 or s.get("url", "") or s.get("src", "") or source)
        print(f"{s['id']:<5}{item['start_s']:5.1f}-{item['start_s'] + dur:<7.1f}{dur:5.1f}  "
              f"{str(source):<8}{str(label)[:60]}")
        actions = s.get("actions") or []
        events = [a for a in actions if a.get("type") != "goto"]
        limit = 14 if source == "asset" else 8
        # Count visual *events* (clicks/scrolls/types), not beats: a long browse shot with several
        # actions is not "one visual" even though it has a single beat.
        if dur > limit and not (source == "browse" and len(events) >= 2):
            warns.append(f"{s['id']}: {dur:.1f}s with few visual events — add a cut or visual event")
        if dur < 0.6:
            errors.append(f"{s['id']}: only {dur:.2f}s — merge it into a neighbour")
        if source == "browse":
            latest = max((a.get("at", 0) for a in actions), default=0)
            if latest > item["dur_ms"]:
                warns.append(f"{s['id']}: an action at {latest:.0f}ms is past the {item['dur_ms']:.0f}ms shot and will be cut")
    first = plan["shots"][0]
    if first.get("source") == "create" and first.get("type") not in ("hook", "stat"):
        warns.append("first shot should be a hook (bold claim/number) or striking footage")
    if plan["shots"][-1].get("type") != "outro":
        warns.append("last shot is not an outro/CTA")
    for w in warns:
        print(f"warning {w}")
    for e in errors:
        print(f"ERROR   {e}")
    if probe_hint:
        print("tip: `vc probe --work <work>` dry-runs browse actions (ok/missing/hidden/blocked) without rendering")
    print("plan OK" if not errors else "plan has errors")
    return 1 if errors else 0


# =========================================================================== step 4c: probe (dry-run browse actions)
async def _inspect_action(page, action: dict) -> tuple:
    """Classify whether a browse action can resolve, without touching a frame."""
    kind = action.get("type")
    sel = action.get("sel")
    if kind in ("goto", "js") or not sel:
        return "ok", ""
    locator = page.locator(sel)
    try:
        count = await locator.count()
    except Exception as exc:  # noqa: BLE001 - invalid selector / unsupported syntax
        return "error", f"invalid selector: {str(exc).splitlines()[0][:90]}"
    if kind == "wait":
        state = action.get("state", "visible")
        if count == 0:
            return ("ok", "nothing attached") if state in ("detached", "hidden") else ("missing", "no element matches")
        visible = await locator.first.is_visible()
        if state == "attached":
            return "ok", f"{count} match(es)"
        if state == "hidden":
            return ("ok", "hidden as expected") if not visible else ("blocked", "element is visible")
        return ("ok", "") if visible else ("hidden", f"{count} match(es) but none visible")
    if count == 0:
        return "missing", "no element matches"
    first = locator.first
    try:
        if not await first.is_visible():
            return "hidden", f"{count} match(es) but none visible"
        if kind in ("click", "type", "press", "hover"):
            if not await first.is_enabled():
                return "blocked", "disabled"
            blocked = await first.evaluate(capture.HITTEST_JS)
            if blocked:
                return "blocked", blocked
    except Exception as exc:  # noqa: BLE001
        return "error", str(exc).splitlines()[0][:90]
    return "ok", (f"{count} matches" if count > 1 else "")


async def _probe_shot(browser, item, url, page_timeout, *, fast):
    s = item["shot"]
    actions = [dict(a) for a in s.get("actions", [])]
    if not any(a.get("type") == "goto" for a in actions):
        actions.insert(0, {"at": 0, "type": "goto"})
    for action in actions:
        if action.get("type") == "goto":
            action.setdefault("url", url)
    schedule = sorted(actions, key=lambda a: a.get("at", 0))
    print(f"\n{s['id']}  {url}  ({len(actions)} action(s), clip {item['dur_ms'] / 1000:.1f}s)")
    context = await capture.new_context(browser, 1280, 720)
    page = await context.new_page()
    page.set_default_timeout(page_timeout)
    bad, started = 0, time.monotonic()
    try:
        for action in schedule:
            at = action.get("at", 0)
            if not fast:
                delay = started + at / 1000 - time.monotonic()
                if delay > 0:
                    await asyncio.sleep(delay)
            t0 = time.monotonic()
            status, detail = await _inspect_action(page, action)
            if status == "ok":
                try:
                    await capture.apply_action(page, action)
                except Exception as exc:  # noqa: BLE001 - report it, keep probing the rest
                    status, detail = "error", str(exc).splitlines()[0][:90]
            else:
                detail = detail or "skipped (would fail)"  # don't burn the action timeout
            took = time.monotonic() - t0
            bad += 0 if status == "ok" else 1
            desc = f"{action.get('type')} {action.get('sel') or action.get('key', '') or ''}".strip()
            late = " (past shot)" if at > item["dur_ms"] else ""
            print(f"  {at:>6.0f}ms  {desc:<28.28} {status:<8} {took:5.2f}s{late}" + (f"  {detail}" if detail else ""))
    finally:
        await context.close()
    print(f"  → {'OK' if not bad else f'{bad} problem(s)'}  (wall {time.monotonic() - started:.1f}s)")
    return bad


def probe(work, *, only=None, fast=False) -> int:
    """Dry-run `browse` shot actions with no frame capture; report per-action status + wall time.

    Replays the actions on the clip clock in a real page (so page state is faithful), reporting
    ok / missing / hidden / blocked / error per action — the 5-second replacement for a failed
    2.5-minute render. `--fast` skips the inter-action waits (selector checks only).
    """
    beats_doc, plan = load(work / "beats.json"), load(work / "plan.json")
    fmt = plan.get("format") or "16:9"
    _, _, fps = canvas(fmt, False)
    tl = timeline(beats_doc, plan, fps)
    project = plan.get("project") or Path.cwd()
    wanted = set(only.split(",")) if only else None
    browsed = [i for i in tl if i["shot"].get("source") == "browse" and (not wanted or i["shot"]["id"] in wanted)]
    if not browsed:
        print("no browse shots to probe")
        return 0
    async def go():
        async with capture.playwright_session() as pw:
            browser = await pw.chromium.launch(headless=True, args=capture.CHROMIUM_ARGS)
            try:
                failures = 0
                for item in browsed:
                    url = pipeline.resolve_src(item["shot"]["url"], project, work)
                    failures += await _probe_shot(browser, item, url, capture.DEFAULT_ACTION_TIMEOUT_MS, fast=fast)
            finally:
                await browser.close()
            return failures

    failures = asyncio.run(go())
    print(f"\nprobe: {'all actions resolve' if not failures else f'{failures} action(s) would fail'}")
    return 1 if failures else 0


# =========================================================================== step 5: clips
def _shot_key(item, fps, w, h, theme, extra=""):
    return hashlib.sha1(json.dumps([item["shot"], item["start_f"], item["frames"], item["marks"], fps, w, h, theme, extra],
                                   sort_keys=True).encode()).hexdigest()[:16]


def render_clips(work, *, only=None, workers=0, draft=False, force=False, fmt=None, theme=None) -> int:
    beats_doc, plan, script = load(work / "beats.json"), load(work / "plan.json"), load(work / "script.json")
    fmt = fmt or plan.get("format") or (script.get("brief") or {}).get("format") or "16:9"
    theme = theme or pipeline.choose_theme(script, plan, fmt)
    w, h, fps = canvas(fmt, draft)
    project = plan.get("project") or Path.cwd()
    tl = timeline(beats_doc, plan, fps)
    wanted = set(only.split(",")) if only else None
    voice_wav = work / beats_doc["voice"]

    clip_dir = work / "clips"
    clip_dir.mkdir(exist_ok=True)

    pending, page_jobs = [], {}
    for item in tl:
        s = item["shot"]
        if wanted and s["id"] not in wanted:
            continue
        # A shot re-renders when anything it depends on changes: an asset file, or the local page a
        # `browse`/`page` shot points at (its url/src string alone would not change).
        extra = ""
        if s["source"] == "asset":
            path = _asset_path(s["asset"], work, project)
            extra = f"{path}:{path.stat().st_mtime_ns}"
        else:
            target = _local_target(s.get("url") if s["source"] == "browse" else s.get("src"), project, work)
            if target:
                extra = f"page:{target}:{target.stat().st_mtime_ns}"
        key = _shot_key(item, fps, w, h, theme, extra)
        out = clip_dir / f"{s['id']}.mov"
        stamp = clip_dir / f"{s['id']}.key"
        if not force and out.exists() and stamp.exists() and stamp.read_text() == key:
            print(f"  {s['id']}: up to date")
            continue
        if s.get("source") == "create" and s.get("type") == "page":
            item["_url"] = pipeline.resolve_src(s["src"], project, work)
            page_jobs.setdefault(item["_url"], []).extend(f["sel"] for f in s.get("focus", []))
        pending.append((item, out, key))

    if pending:
        concurrency = workers or default_workers()
        print(f"rendering {len(pending)} clip(s) at {w}x{h}@{fps} with {concurrency} worker(s)...")
        failed = asyncio.run(_render_shots(pending, page_jobs, work, clip_dir, project, voice_wav,
                                           theme, fps, w, h, concurrency))
    else:
        failed = []
    save(clip_dir / "meta.json", {"fps": fps, "w": w, "h": h, "theme": theme})
    if failed:
        print(f"{len(failed)} shot(s) failed: {failed}. Fix the shot in plan.json (or switch it to another source) "
              f"and run: vc clips --only {','.join(failed)}", file=sys.stderr)
        return 1
    return 0


async def _render_shots(pending, page_jobs, work, clip_dir, project, voice_wav, theme, fps, w, h, concurrency):
    """Render every shot from ONE Chromium session: shoot the pages, then capture all scenes.

    Scenes stream JPEG frames straight into FFmpeg (bounded concurrency) instead of writing a
    PNG per frame; the browser is launched once for the whole run.
    """
    failed = []
    sem = asyncio.Semaphore(concurrency)

    async def render(item, out, key):
        async with sem:
            s = item["shot"]
            try:
                job = {"out": str(out), "voice": str(voice_wav), "a_start_s": item["start_s"],
                       "frames": item["frames"], "fps": fps, "w": w, "h": h}
                if s["source"] == "create":
                    scene = dict(s, _shot=shots[item["_url"]]) if s["type"] == "page" else s
                    ctx = scene_engine.Ctx(w, h, theme, item["dur_ms"], item["marks"])
                    html_file = work / "scenes" / f"{s['id']}.html"
                    html_file.parent.mkdir(exist_ok=True)
                    html_file.write_text(scene_engine.render(scene, ctx), encoding="utf-8")
                    job.update(kind="html", html=str(html_file))
                    await clipmod.render_html_shot(browser, job)
                elif s["source"] == "browse":
                    url = pipeline.resolve_src(s["url"], project, work)
                    actions = [dict(a) for a in s.get("actions", [])]
                    if not any(a.get("type") == "goto" for a in actions):
                        actions.insert(0, {"at": 0, "type": "goto"})
                    for action in actions:
                        if action.get("type") == "goto":
                            action.setdefault("url", url)
                    job.update(actions=actions)
                    await clipmod.render_browse_shot(browser, job)
                else:
                    path = _asset_path(s["asset"], work, project)
                    job.update(kind="image" if path.suffix.lower() in clipmod.IMAGE_EXT else "video",
                               asset=str(path), start_s=s.get("start", 0))
                    await clipmod.render_media_shot(job)
                (clip_dir / f"{s['id']}.key").write_text(key)
                print(f"  {s['id']}: ok")
            except Exception as exc:  # noqa: BLE001 - one bad shot must not block the rest
                failed.append(s["id"])
                print(f"  {s['id']}: FAILED - {exc}", file=sys.stderr)

    async with capture.playwright_session() as pw:
        browser = await pw.chromium.launch(headless=True, args=capture.CHROMIUM_ARGS)
        try:
            shots = await site.shoot_pages_async(browser, page_jobs, work / "pages") if page_jobs else {}
            await asyncio.gather(*(render(*p) for p in pending))
        finally:
            await browser.close()
    return failed


# =========================================================================== step 6: merge
def merge(work, out_path, *, burn_captions=True, music=None, strict_black=False) -> int:
    beats_doc, plan, script = load(work / "beats.json"), load(work / "plan.json"), load(work / "script.json")
    meta_path = work / "clips" / "meta.json"
    if not meta_path.exists():
        raise RuntimeError("no clips yet — run `vc clips` first")
    meta = load(meta_path)
    fps = meta["fps"]
    tl = timeline(beats_doc, plan, fps)
    paths = []
    for item in tl:
        sid = item["shot"]["id"]
        clip, stamp = work / "clips" / f"{sid}.mov", work / "clips" / f"{sid}.key"
        if not clip.exists() or not stamp.exists():
            raise RuntimeError(f"clip for {sid} missing — run `vc clips`")
        paths.append(clip)
    out = Path(out_path).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    total_s = sum(i["frames"] for i in tl) / fps

    merged = assemble.merge_clips(paths, work / "merged.mov")
    srt = assemble.build_srt_beats(beats_doc["beats"], work / "captions.srt", total_s=total_s)
    silent = beats_doc.get("mode") == "none"
    # loudnorm NaNs on digital silence, so captions-only builds skip it (finalize falls back too).
    assemble.finalize(merged, out, srt=srt, burn=burn_captions, music=music, loudnorm=not silent)

    chapters = [{"id": i["shot"]["id"], "title": (i["shot"].get("visual") or i["shot"].get("type") or i["shot"]["id"])[:60],
                 "start": i["start_s"], "duration": i["frames"] / fps} for i in tl]
    meta_txt = assemble.write_chapters(chapters, work / "chapters.txt", title=script.get("title", "Video"))
    tmp = work / "_chapters.mp4"
    assemble.apply_metadata(out, meta_txt, tmp)
    tmp.replace(out)
    assemble.build_player(chapters, out.name, out.parent / "index.html", title=script.get("title", "Video"),
                          template=PLAYER_TEMPLATE)

    result = verify.verify(out, expected_duration=total_s, strict_black=strict_black,
                           min_mean_db=-200.0 if silent else -50.0,
                           shots=[{"id": i["shot"]["id"], "start": i["start_s"], "dur": i["frames"] / fps} for i in tl])
    poster = out.parent / "poster.png"
    run(["-loglevel", "error", "-y", "-ss", "1.5", "-i", out, "-frames:v", "1", poster])
    sheet = work / "sheet.png"
    assemble.contact_sheet(out, sheet)

    credits = work / "credits.json"
    if credits.exists() and load(credits):
        lines = [f"{c['file']}: {c['credit'] or 'n/a'} — {c['license']} — {_public_url(c['url'])}"
                 for c in load(credits)]
        (out.parent / "CREDITS.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")

    if result["ok"]:
        # Remember where the final video went, so `vc next` stays accurate even when `merge` ran
        # with a custom --out or from another cwd.
        save(work / "merge.json", {"out": str(out), "duration_s": round(total_s, 2),
                                   "narration": "none" if silent else "voice"})

    info = result["probe"]
    print(json.dumps({"ok": result["ok"], "problems": result["problems"], "warnings": result["warnings"],
                      "findings": result["findings"],
                      "duration_s": round(info["duration"] or 0, 2), "expected_s": round(total_s, 2),
                      "resolution": f"{info['video']['width']}x{info['video']['height']}", "fps": info["video"]["fps"]},
                     indent=2))
    print(f"DONE  video={out}  poster={poster}  player={out.parent / 'index.html'}  sheet={sheet}  "
          f"narration={'Milo' if not silent else 'NONE (captions only — set MIMO_API_KEY)'}")
    return 0 if result["ok"] else 1


# =========================================================================== find -> fetch (licensed assets only)
def _public_url(url) -> str:
    """A credit URL without credentials or query string.

    A fetched asset's url can be a signed link carrying a token; `out/CREDITS.txt` is a deliverable
    meant to be shared, so only scheme/host/path belong in it (credits.json keeps the full url).
    """
    parts = urllib.parse.urlsplit(str(url))
    if not parts.scheme:
        return str(url)
    host = parts.hostname or ""
    if parts.port:
        host = f"{host}:{parts.port}"
    return urllib.parse.urlunsplit((parts.scheme, host, parts.path, "", ""))


def _asset_name(url, name) -> str:
    """A flat, safe filename inside assets/ (never a path, never '.'/'..')."""
    base = re.sub(r"[?#].*$", "", str(name or url))
    candidate = re.sub(r"[^\w.\-]", "_", Path(base).name).strip("_")
    return candidate if candidate and candidate not in (".", "..") else "asset"


def fetch(work, url, *, license_name, credit, name=None, shot=None):
    if not license_name:
        raise RuntimeError("--license is required (e.g. CC0, 'Pexels License', 'CC-BY 4.0'); only use clearly licensed media")
    scheme = urllib.parse.urlsplit(str(url)).scheme.lower()
    if scheme not in ("http", "https"):
        raise RuntimeError(f"--url must be http(s) (got {scheme or 'no scheme'!r}) — `vc fetch` downloads "
                           "licensed media over the web only")
    assets = work / "assets"
    assets.mkdir(parents=True, exist_ok=True)
    dest = assets / _asset_name(url, name)
    if dest.parent != assets:  # defense in depth: the sanitizer above must keep the file in assets/
        raise RuntimeError(f"refusing to write outside assets/: {dest}")
    request = urllib.request.Request(url, headers={"User-Agent": "video-creator/1.0"})
    with urllib.request.urlopen(request, timeout=120) as response, open(dest, "wb") as fh:
        shutil.copyfileobj(response, fh, length=1 << 20)
    if dest.suffix.lower() not in ASSET_EXT:
        dest.unlink(missing_ok=True)
        raise RuntimeError(f"unsupported media type {dest.suffix!r}; need one of {sorted(ASSET_EXT)}")
    info = ffprobe(dest)
    if not info["video"]:
        dest.unlink(missing_ok=True)
        raise RuntimeError("downloaded file is not a readable image/video")
    credits = load(work / "credits.json") if (work / "credits.json").exists() else []
    credits.append({"file": dest.name, "url": url, "license": license_name, "credit": credit or ""})
    save(work / "credits.json", credits)
    rel = f"assets/{dest.name}"
    if shot:
        plan = load(work / "plan.json")
        target = next((s for s in plan["shots"] if s["id"] == shot), None)
        if not target:
            raise RuntimeError(f"no shot {shot!r} in plan.json")
        target.update(source="asset", asset=rel)
        target.pop("find", None)
        save(work / "plan.json", plan)
        print(f"shot {shot} now uses {rel}")
    print(f"saved {dest} (license: {license_name}) and logged it in credits.json")
    return dest


# =========================================================================== guidance
def next_step(work, out_path) -> str:
    s, b, p = work / "script.json", work / "beats.json", work / "plan.json"
    if not s.exists():
        return ("STEP 1-2: understand the request, then write tmp/video/script.json "
                "(web project? run `vc draft --project .` for a starting script + plan).")
    if not b.exists() or s.stat().st_mtime > b.stat().st_mtime:
        return "STEP 3: run `vc voice` (creates the voice clip + beats.json)."
    if not p.exists():
        return "STEP 4: write tmp/video/plan.json — shots covering every beat (source: create | asset | find)."
    if p.stat().st_mtime > b.stat().st_mtime and not (work / "clips" / "meta.json").exists():
        return "STEP 4b: run `vc check`, fix errors, then STEP 5: `vc clips`."
    meta = work / "clips" / "meta.json"
    if not meta.exists():
        return "STEP 5: run `vc check`, then `vc clips`."
    try:
        plan = load(p)
        stale = [x["id"] for x in plan["shots"] if not (work / "clips" / f"{x['id']}.mov").exists()]
    except Exception:  # noqa: BLE001
        stale = []
    if stale or p.stat().st_mtime > meta.stat().st_mtime:
        return f"STEP 5: plan changed or clips missing {stale or ''} — run `vc clips` (only changed shots re-render)."
    merged = Path(out_path)
    recorded = work / "merge.json"
    if not merged.exists() and recorded.exists():
        merged = Path(load(recorded).get("out") or merged)  # merge was run with a custom --out
    if not merged.exists() or merged.stat().st_mtime < meta.stat().st_mtime:
        return "STEP 6: run `vc merge` to produce the final video."
    return (f"DONE: {merged} is merged — glance at tmp/video/sheet.png, then report absolute paths, "
            "duration, resolution, theme and narration status.")
