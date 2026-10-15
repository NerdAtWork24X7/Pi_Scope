#!/usr/bin/env python
"""video-creator skill CLI — HTML scenes -> browser recording -> FFmpeg -> MP4.

Run with the skill venv:
    <skill>/.venv/bin/python <skill>/scripts/video.py <command> [options]

Workflow (see SKILL.md):  next | draft | voice | check | probe | clips | merge | fetch | make
Utilities:                doctor | theme | verify | sheet | frames | record | tts-api | tts-browser | tts-save | normalize | assemble
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from vidkit import assemble, capture, palette, scenes as scene_engine, tts, verify, workflow  # noqa: E402
from vidkit.ffmpeg import REINSTALL_HINT, FfmpegError, ffmpeg_exe, has_encoder, has_filter, probe, run  # noqa: E402

SKILL_DIR = Path(__file__).resolve().parents[1]
PLAYER_TEMPLATE = SKILL_DIR / "assets" / "player.html.tmpl"

_THEME_USE = {
    "midnight-lime": "techy/developer, punchy launch, high-energy",
    "paper-ink": "editorial, docs, story, warm and readable",
    "ocean-glass": "calm, trustworthy — finance/health/security, B2B",
    "sunset-pop": "playful, social, music/food/fitness, bold",
    "slate-sky": "clean product/SaaS walkthrough, tutorial, professional",
    "ember-noir": "premium, cinematic, keynote/launch, luxury",
}


def _size(text: str) -> tuple[int, int]:
    width, height = text.lower().split("x")
    return int(width), int(height)


def _resolve(base: Path, value) -> Path:
    path = Path(value)
    return path if path.is_absolute() else (base / path)


def cmd_doctor(_args) -> int:
    try:
        exe = ffmpeg_exe()
    except FfmpegError as exc:
        print(f"FAIL ffmpeg: {exc}")
        if "FFMPEG_BIN" not in str(exc) and "IMAGEIO_FFMPEG_EXE" not in str(exc):
            print(f"     fix: {REINSTALL_HINT}   (or set FFMPEG_BIN to a working binary)")
        return 1
    print(f"ffmpeg     : {exe}")
    # `exists` is not `runs`: a truncated/partial install leaves a file that cannot execute.
    print(f"  runs     : {run(['-version'], capture=True, check=False).returncode == 0}")
    print(f"  libx264  : {has_encoder('libx264')}   aac: {has_encoder('aac')}")
    print(f"  subtitles: {has_filter('subtitles')}   loudnorm: {has_filter('loudnorm')}")
    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            print(f"playwright : chromium {browser.version}")
            browser.close()
    except Exception as exc:  # noqa: BLE001 - report any launch failure verbatim
        print(f"FAIL playwright: {exc}")
        print(f"     fix: {REINSTALL_HINT}   (then `python -m playwright install chromium`)")
        return 1
    _, base, source = tts.resolve_credentials()
    print(f"tts key    : {source or 'NOT FOUND (use MIMO_API_KEY or `vc tts-browser`)'}")
    print(f"tts base   : {base}")
    print(f"tts voice  : {tts.DEFAULT_VOICE}  (model {tts.DEFAULT_MODEL})")
    print("OK")
    return 0


def cmd_record(args) -> int:
    actions = json.loads(Path(args.actions).read_text(encoding="utf-8")) if args.actions else []
    width, height = _size(args.size)
    out = capture.record_scene(args.html, args.out, args.duration, actions,
                               width=width, height=height)
    print(out)
    return 0


def cmd_frames(args) -> int:
    width, height = _size(args.size)
    out_dir, count = capture.capture_frames(args.html, args.out_dir, args.duration,
                                            fps=args.fps, width=width, height=height)
    print(f"{count} frames -> {out_dir}")
    if args.mp4:
        run(["-y", "-framerate", args.fps, "-i", str(Path(args.out_dir) / "f%05d.png"),
             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", args.mp4])
        print(args.mp4)
    return 0


def cmd_tts_api(args) -> int:
    text = args.text or Path(args.text_file).read_text(encoding="utf-8")
    print(tts.api_synthesize(text, args.out, style=args.style, voice=args.voice, model=args.model))
    return 0


def cmd_tts_save(args) -> int:
    print(tts.save_base64(Path(args.b64_file).read_text(encoding="utf-8"), args.out,
                          sample_rate=args.rate))
    return 0


def cmd_tts_browser(args) -> int:
    text = args.text or (Path(args.text_file).read_text(encoding="utf-8") if args.text_file else None)
    print(tts.browser_synthesize(args.url, args.out, text=text, input_selector=args.input_selector,
                                 submit_selector=args.submit_selector, manual=args.manual,
                                 headless=not (args.headed or args.manual),
                                 timeout=int(args.timeout * 1000)))
    return 0


def cmd_normalize(args) -> int:
    print(tts.normalize(args.inp, args.out, loudness=args.loudness))
    return 0


def cmd_assemble(args) -> int:
    manifest_path = Path(args.manifest).resolve()
    base = manifest_path.parent
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    fps = manifest.get("fps", args.fps)
    width, height = _size(manifest.get("size", args.size))
    out = Path(args.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)

    scenes = sorted(manifest["scenes"], key=lambda s: s.get("order", 0))
    segments: list[Path] = []
    timeline: list[dict] = []
    cursor = 0.0

    for scene in scenes:
        sid = scene["id"]
        video = _resolve(base, scene["video"])
        audio = scene.get("audio")
        if audio:
            audio = _resolve(base, audio)
        else:
            audio = base / f"silence-{sid}.wav"
            silence_s = scene.get("duration") or probe(video)["duration"] or 2.0
            run(["-loglevel", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono",
                 "-t", f"{silence_s:.3f}", "-c:a", "pcm_s16le", audio])

        video_dur = probe(video)["duration"] or 0.0
        audio_dur = probe(audio)["duration"] or scene.get("duration", 0.0)
        segment = base / f"seg-{sid}.mp4"
        assemble.mux_scene(video, audio, segment, fps=fps, width=width, height=height,
                           pad_s=max(0.0, audio_dur - video_dur),
                           total_s=max(audio_dur, video_dur) or None)
        seg_dur = probe(segment)["duration"] or audio_dur

        timeline.append({"id": sid, "title": scene.get("title", ""), "start": cursor,
                         "duration": seg_dur, "narration": scene.get("narration")})
        cursor += seg_dur
        segments.append(segment)

    if manifest.get("transition", "none") not in (None, "none", ""):
        overlap = 0.4  # must match assemble.concat duration_s
        for i, item in enumerate(timeline):
            item["start"] = max(0.0, item["start"] - i * overlap)
        cursor -= overlap * (len(segments) - 1)

    master = out
    assemble.concat(segments, master, transition=manifest.get("transition", "none"))

    if manifest.get("music"):
        mixed = base / "_music.mp4"
        assemble.mix_music(master, _resolve(base, manifest["music"]), mixed)
        mixed.replace(master)

    srt = base / "captions.srt"
    if not args.no_captions:
        assemble.build_srt(timeline, srt)
        subs_out = base / "_subs.mp4"
        assemble.add_subtitles(master, srt, subs_out, burn=args.burn_captions)
        subs_out.replace(master)

    meta = base / "chapters.txt"
    assemble.write_chapters(timeline, meta, title=manifest.get("title", "Video"))
    with_meta = base / "_chapters.mp4"
    assemble.apply_metadata(master, meta, with_meta)
    with_meta.replace(master)

    if not args.no_player:
        assemble.build_player(timeline, master.name, out.parent / "index.html",
                              title=manifest.get("title", "Video"), template=PLAYER_TEMPLATE)

    result = verify.verify(master, expected_duration=cursor, strict_black=args.strict_black,
                           min_mean_db=-200.0 if getattr(args, 'allow_silent', False) else -50.0)
    print(json.dumps({"master": str(master), "captions": str(srt) if not args.no_captions else None,
                      "scenes": len(scenes), "duration": round(cursor, 2),
                      "verify": result}, indent=2))
    return 0 if result["ok"] else 1


def cmd_sheet(args) -> int:
    print(assemble.contact_sheet(args.file, args.out))
    return 0


def _check_workdir(work: Path) -> None:
    """Keep the working folder inside the project (or the skill) — never the OS temp dir.

    Everything the skill writes (script/plan/beats/clips, the voice cache, page screenshots) lives
    here, and a system temp dir is wiped between runs, may be shared, and is usually small. The
    convention is the project's own `tmp/` (`--work tmp/video`, relative to the current working
    directory); `<skill>/tmp` is fine too. Relative paths always resolve against the cwd.
    """
    roots = (Path.cwd().resolve(), SKILL_DIR)
    if any(work == root or root in work.parents for root in roots):
        return
    temp = Path(tempfile.gettempdir()).resolve()
    if work == temp or temp in work.parents:
        raise RuntimeError(
            f"--work {work} is inside the system temp dir ({temp}) — keep the working folder inside "
            f"{Path.cwd()} as `tmp/video`, or under <skill>/tmp")
    print(f"WARNING: --work {work} is outside the project and the skill — the convention is "
          f"`--work tmp/video` inside the current working directory", file=sys.stderr)


def _work(args) -> Path:
    work = Path(args.work).resolve()
    _check_workdir(work)
    work.mkdir(parents=True, exist_ok=True)
    return work


def _tts_mode(args) -> str:
    if args.tts == "none":
        return "none"
    if tts.resolve_credentials()[0]:
        return "api"
    if args.tts == "api":
        raise RuntimeError("no MiMo/Xiaomi TTS key found (set MIMO_API_KEY)")
    print("WARNING: no MiMo key found - voice will be a SILENT placeholder with real timings; captions are burned "
          "in. Set MIMO_API_KEY for Milo narration.", file=sys.stderr)
    return "none"


def cmd_draft(args) -> int:
    workflow.draft(args, _work(args), Path(args.project).resolve())
    return 0


def _voice(args, work) -> str:
    mode = _tts_mode(args)
    try:
        return workflow.voice(work, mode=mode)
    except (RuntimeError, OSError) as exc:
        if mode == "api" and args.tts == "auto":
            print(f"WARNING: TTS failed ({exc}); using a silent placeholder voice", file=sys.stderr)
            return workflow.voice(work, mode="none")
        raise


def cmd_voice(args) -> int:
    _voice(args, _work(args))
    return 0


def cmd_check(args) -> int:
    return workflow.check(_work(args), fps=15 if args.draft else 30)


def cmd_probe(args) -> int:
    return workflow.probe(_work(args), only=args.only, fast=args.fast)


def cmd_theme(args) -> int:
    """List curated palettes, or *design* bespoke, contrast-checked palettes for a request."""
    if args.direction or args.seed:
        found = palette.design(args.direction or "brand palette", format=args.format, seed=args.seed,
                               variants=max(1, args.variants))
        if args.json:
            print(json.dumps(found, indent=2))
            return 0
        print(f"request: {args.direction!r}" + (f"   brand seed: {args.seed}" if args.seed else ""))
        for opt in found:
            t, c = opt["palette"], opt["contrast"]
            print(f"\n{opt['name']}  ·  {opt['label']}  (nearest preset: {opt['preset']}; {opt['reason']})")
            print(f"  bg {t['bg']}  fg {t['fg']}  accent {t['accent']}  card {t['card']}  muted {t['muted']}  on {t['on']}")
            print(f"  contrast  fg/bg {c['fg/bg']}  accent/bg {c['accent/bg']}  on/accent {c['on/accent']}  muted/bg {c['muted/bg']}")
        print("\nuse one — drop this object into plan.json/script.json as \"theme\":")
        print(json.dumps(found[0]["palette"], indent=2))
        print('or pass a curated name:  vc make --theme paper-ink   (list them:  vc theme)')
        return 0
    print("curated palettes (safe fallbacks; `vc theme \"<brief>\"` designs a bespoke one):")
    for name, t in scene_engine.THEMES.items():
        print(f"  {name:<14} bg {t['bg']}  accent {t['accent']}   {_THEME_USE.get(name, '')}")
    print('design one for a request:  vc theme "cozy bakery in Lisbon" [--seed #7C3AED] [--variants 3] [--json]')
    return 0


def cmd_clips(args) -> int:
    return workflow.render_clips(_work(args), only=args.only, workers=args.workers, draft=args.draft,
                                 force=args.force, fmt=args.format, theme=args.theme)


def cmd_merge(args) -> int:
    return workflow.merge(_work(args), args.out, burn_captions=not args.no_burn, music=args.music)


def cmd_fetch(args) -> int:
    workflow.fetch(_work(args), args.url, license_name=args.license, credit=args.credit, name=args.name, shot=args.shot)
    return 0


def cmd_next(args) -> int:
    print(workflow.next_step(_work(args), args.out))
    return 0


def cmd_make(args) -> int:
    """EXPRESS: draft (if no script/plan yet) -> voice -> check -> clips -> merge."""
    work = _work(args)
    if not (work / "script.json").exists() or not (work / "plan.json").exists() or args.regen:
        workflow.draft(args, work, Path(args.project).resolve())
    _voice(args, work)
    if workflow.check(work, fps=15 if args.draft else 30):
        return 1
    if workflow.render_clips(work, workers=args.workers, draft=args.draft, fmt=args.format, theme=args.theme):
        return 1
    return workflow.merge(work, args.out, burn_captions=not args.no_burn, music=args.music)


def cmd_verify(args) -> int:
    result = verify.verify(args.file, expected_duration=args.expected,
                           strict_black=args.strict_black,
                           min_mean_db=-200.0 if args.allow_silent else -50.0)
    print(json.dumps(result, indent=2))
    return 0 if result["ok"] else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="video.py", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("doctor", help="verify the toolchain").set_defaults(func=cmd_doctor)

    p = sub.add_parser("record", help="screen-record an interactive HTML scene")
    p.add_argument("--html", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--duration", type=float, required=True, help="clip length in ms")
    p.add_argument("--actions", help="JSON file: [{at,type,sel,...}]")
    p.add_argument("--size", default="1920x1080")
    p.set_defaults(func=cmd_record)

    p = sub.add_parser("frames", help="frame-exact PNG capture of an HTML scene")
    p.add_argument("--html", required=True)
    p.add_argument("--out-dir", required=True)
    p.add_argument("--duration", type=float, required=True, help="clip length in ms")
    p.add_argument("--fps", type=int, default=30)
    p.add_argument("--size", default="1920x1080")
    p.add_argument("--mp4", help="also encode the frames to this MP4")
    p.set_defaults(func=cmd_frames)

    p = sub.add_parser("tts-api", help="MiMo-TTS API synthesis (needs MIMO_API_KEY)")
    p.add_argument("--text")
    p.add_argument("--text-file")
    p.add_argument("--out", required=True)
    p.add_argument("--style", help="natural-language style direction (user message)")
    p.add_argument("--voice", default=tts.DEFAULT_VOICE)
    p.add_argument("--model", default=tts.DEFAULT_MODEL)
    p.set_defaults(func=cmd_tts_api)

    p = sub.add_parser("tts-save", help="write base64 audio (hand-extracted) to WAV")
    p.add_argument("--b64-file", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--rate", type=int, default=tts.DEFAULT_RATE)
    p.set_defaults(func=cmd_tts_save)

    p = sub.add_parser("tts-browser", help="synthesize by driving the TTS web UI with Playwright")
    p.add_argument("--url", required=True, help="TTS web UI URL")
    p.add_argument("--text")
    p.add_argument("--text-file")
    p.add_argument("--out", required=True)
    p.add_argument("--input-selector", help="CSS selector for the prompt box")
    p.add_argument("--submit-selector", help="CSS selector for the generate button")
    p.add_argument("--manual", action="store_true", help="open a headed window and generate by hand")
    p.add_argument("--headed", action="store_true", help="show the browser window (auto submit)")
    p.add_argument("--timeout", type=float, default=120.0, help="seconds to wait for audio")
    p.set_defaults(func=cmd_tts_browser)

    p = sub.add_parser("normalize", help="loudness-normalize a narration clip")
    p.add_argument("--in", dest="inp", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--loudness", type=float, default=-16.0)
    p.set_defaults(func=cmd_normalize)

    p = sub.add_parser("assemble", help="manifest.json -> master MP4 + player")
    p.add_argument("--manifest", required=True)
    p.add_argument("--out", default="video.mp4")
    p.add_argument("--fps", type=int, default=30)
    p.add_argument("--size", default="1920x1080")
    p.add_argument("--burn-captions", action="store_true")
    p.add_argument("--no-captions", action="store_true")
    p.add_argument("--no-player", action="store_true")
    p.add_argument("--strict-black", action="store_true",
                   help="treat near-black frames as an error (dark themes are fine by default)")
    p.set_defaults(func=cmd_assemble)

    def common(p, tts_opts=False):
        p.add_argument("--work", default="tmp/video", help="working folder (default tmp/video)")
        p.add_argument("--draft", action="store_true", help="1080p preview at 15fps (faster, fewer frames)")
        if tts_opts:
            p.add_argument("--tts", choices=["auto", "api", "none"], default="auto")

    def brief(p):
        p.add_argument("--project", default=".", help="folder containing existing HTML pages")
        p.add_argument("--page", action="append", help="explicit page path or URL (repeatable)")
        p.add_argument("--name"); p.add_argument("--tagline"); p.add_argument("--description")
        p.add_argument("--cta"); p.add_argument("--url")
        p.add_argument("--feature", action="append", help='"Title:description" (used when no pages exist)')
        p.add_argument("--theme", choices=sorted(scene_engine.THEMES))
        p.add_argument("--seed", help="brand colour (#RRGGBB) to anchor the designed palette")
        p.add_argument("--format", choices=["16:9", "9:16"])
        p.add_argument("--voice"); p.add_argument("--style")

    p = sub.add_parser("next", help="what to do next (run this whenever unsure)")
    common(p); p.add_argument("--out", default="out/video.mp4"); p.set_defaults(func=cmd_next)

    p = sub.add_parser("draft", help="web project: inspect pages (or scaffold a site) -> starting script.json + plan.json")
    common(p); brief(p); p.set_defaults(func=cmd_draft)

    p = sub.add_parser("voice", help="STEP 3: script.json -> voice.wav + beats.json (exact beat timings)")
    common(p, True); p.set_defaults(func=cmd_voice)

    p = sub.add_parser("check", help="STEP 4b: validate plan.json against the voice timing; prints the shot table")
    common(p); p.set_defaults(func=cmd_check)

    p = sub.add_parser("probe", help="STEP 4c: dry-run browse actions (no frames) — ok/missing/hidden/blocked + wall time")
    common(p); p.add_argument("--only", help="comma-separated shot ids")
    p.add_argument("--fast", action="store_true", help="skip inter-action waits (selector checks only)")
    p.set_defaults(func=cmd_probe)

    p = sub.add_parser("theme", help="list curated palettes, or design bespoke ones from your request")
    p.add_argument("direction", nargs="?", help="one-line description of the request (omit to list curated themes)")
    p.add_argument("--format", choices=["16:9", "9:16"])
    p.add_argument("--seed", help="brand colour (#RRGGBB) to anchor the accent")
    p.add_argument("--variants", type=int, default=3, help="how many palette options to design (default 3)")
    p.add_argument("--json", action="store_true", help="print the designed palettes as JSON")
    p.set_defaults(func=cmd_theme)

    p = sub.add_parser("clips", help="STEP 5: render one synced clip per shot (unchanged shots are skipped)")
    common(p); p.add_argument("--only", help="comma-separated shot ids"); p.add_argument("--force", action="store_true")
    p.add_argument("--workers", type=int, default=0); p.add_argument("--theme", choices=sorted(scene_engine.THEMES))
    p.add_argument("--format", choices=["16:9", "9:16"]); p.set_defaults(func=cmd_clips)

    p = sub.add_parser("merge", help="STEP 6: concat clips -> final MP4 + captions + chapters + player + verify")
    common(p); p.add_argument("--out", default="out/video.mp4"); p.add_argument("--no-burn", action="store_true",
                                                                                   help="soft captions instead of burned-in")
    p.add_argument("--music", help="licensed/user-provided music bed"); p.set_defaults(func=cmd_merge)

    p = sub.add_parser("fetch", help="download a LICENSED image/video into assets/ (and attach it to a shot)")
    common(p); p.add_argument("--url", required=True); p.add_argument("--license", required=True)
    p.add_argument("--credit"); p.add_argument("--name"); p.add_argument("--shot"); p.set_defaults(func=cmd_fetch)

    p = sub.add_parser("make", help="EXPRESS for web projects: draft -> voice -> check -> clips -> merge")
    common(p, True); brief(p); p.add_argument("--out", default="out/video.mp4")
    p.add_argument("--workers", type=int, default=0); p.add_argument("--no-burn", action="store_true")
    p.add_argument("--music"); p.add_argument("--regen", action="store_true"); p.set_defaults(func=cmd_make)

    p = sub.add_parser("sheet", help="4x4 contact sheet of a video for visual review")
    p.add_argument("--file", required=True)
    p.add_argument("--out", required=True)
    p.set_defaults(func=cmd_sheet)

    p = sub.add_parser("verify", help="post-render checks")
    p.add_argument("--file", required=True)
    p.add_argument("--expected", type=float, help="expected duration in seconds")
    p.add_argument("--strict-black", action="store_true")
    p.add_argument("--allow-silent", action="store_true", help="don't fail on silent audio (captions-only builds)")
    p.set_defaults(func=cmd_verify)

    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        return args.func(args)
    except (FfmpegError, RuntimeError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
