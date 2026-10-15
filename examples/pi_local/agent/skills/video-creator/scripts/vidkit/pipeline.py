"""Zero-authoring pipeline helpers: find/scaffold pages, draft the spec, plan narration timing."""

from __future__ import annotations

import os
import re
from pathlib import Path

from . import palette, site, tts

SKIP_DIRS = {"node_modules", ".venv", "venv", "tmp", "out", ".git", "__pycache__", "vendor", "assets", "references"}

# ${VAR} in a url/src is resolved from the environment at render time, so a plan can point at a
# local instance (`${SCOPE_URL}`) or inject an auth token (`${SCOPE_TOKEN}`) without hard-coding it
# in plan.json (which is shareable). `missing_env` lets `check` fail before a render.
_ENV = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


def missing_env(value) -> list:
    """Names of `${VAR}` references in `value` that are not set in the environment."""
    return [name for name in dict.fromkeys(_ENV.findall(str(value))) if not os.environ.get(name)]


def interpolate_env(value) -> str:
    """Replace `${VAR}` with os.environ['VAR']; raise a clear error if a variable is unset."""
    def sub(match):
        name = match.group(1)
        if name not in os.environ:
            raise RuntimeError(f"environment variable {name} referenced in {value!r} is not set")
        return os.environ[name]

    return _ENV.sub(sub, str(value))


# --------------------------------------------------------------------------- pages
def discover_pages(project, limit=4) -> list:
    root = Path(project).resolve()
    found = []
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]
        depth = len(Path(dirpath).relative_to(root).parts)
        if depth > 3:
            dirs[:] = []
            continue
        for name in files:
            path = Path(dirpath) / name
            if name.lower().endswith(".html") and path.stat().st_size > 300:
                found.append((name != "index.html", depth, str(path)))
    found.sort()
    return [p for _, _, p in found[:limit]]


def resolve_src(src, project, work) -> str:
    src = interpolate_env(src)
    if re.match(r"^(https?|file)://", src):
        return src
    for base in (Path(project), Path.cwd(), Path(work)):
        cand = (Path(src) if Path(src).is_absolute() else base / src)
        if cand.exists():
            return cand.resolve().as_uri()
    raise RuntimeError(f"page not found: {src}")


# --------------------------------------------------------------------------- spec drafting
def _sentence(text, max_words=16) -> str:
    text = re.sub(r"\s+", " ", text or "").strip()
    if not text:
        return ""
    m = re.match(r"(.+?[.!?])(\s|$)", text)
    s = m.group(1) if m else text
    words = s.split()
    if len(words) > max_words:
        s = " ".join(words[:max_words]).rstrip(",;:-") + "."
    return s if s[-1] in ".!?" else s + "."


def _beat(label, note) -> str:
    label = re.sub(r"\s+", " ", label or "").strip()[:80].rstrip(".!?:")
    return f"{label}. {_sentence(note)}".strip()


def _accent(text) -> str:
    words = text.split()[:10]
    if len(words) < 2:
        return text
    n = 2 if len(words) >= 4 else 1
    return " ".join(words[:-n] + ["*" + " ".join(words[-n:]) + "*"])


def _browse_actions(focus, step_ms=1200, lead_ms=900) -> list:
    """A deterministic action script: goto, then scroll to + highlight each focus selector.

    `lead_ms` keeps the first interaction after the page is interactive (check rejects browse
    interactions before 800 ms, which would edit a blank/partial page).
    """
    actions = [{"at": 0, "type": "goto"}]
    for i, f in enumerate(focus):
        at = lead_ms + i * step_ms
        actions.append({"at": at, "type": "scroll", "sel": f["sel"]})
        actions.append({"at": at + 450, "type": "highlight", "sel": f["sel"]})
    return actions


def _clean_title(title, fallback="Your project") -> str:
    return re.split(r"\s[|\u2013\u2014-]\s", title or "")[0].strip() or fallback


# Theme selection: map the *meaning* of the request onto a palette instead of defaulting to one
# colour scheme. Ordered (theme, keywords); ties resolve to the earlier theme. `draft`/`make` use
# this when the plan/script names no theme, and SKILL.md documents it as the rubric for hand plans.
THEME_RUBRIC = [
    ("ocean-glass", {"finance", "fintech", "bank", "insurance", "security", "secure", "privacy", "health",
                     "medical", "clinic", "trust", "compliance", "enterprise", "cloud", "infrastructure",
                     "devops", "consulting", "b2b", "government", "calm", "reliable", "safety"}),
    ("paper-ink", {"editorial", "article", "blog", "writing", "writer", "newsletter", "documentation", "docs",
                   "report", "research", "academic", "paper", "journal", "story", "book", "education",
                   "course", "lecture", "history", "culture", "recipe", "craft"}),
    ("sunset-pop", {"social", "fun", "playful", "music", "fitness", "workout", "food", "restaurant", "travel",
                    "kids", "family", "community", "event", "party", "festival", "creator", "influencer",
                    "vibrant", "bold", "energy", "game", "gaming", "dance", "beauty"}),
    ("ember-noir", {"premium", "luxury", "exclusive", "keynote", "cinematic", "elegant", "brand", "fashion",
                    "wine", "coffee", "realestate", "real-estate", "invest", "investment", "fund", "crypto",
                    "hospitality", "studio", "portfolio"}),
    ("slate-sky", {"product", "platform", "saas", "dashboard", "analytics", "workspace", "team", "crm",
                   "onboarding", "tutorial", "guide", "howto", "how-to", "walkthrough", "tool", "workflow",
                   "automation", "integrations", "agency", "business", "support", "billing"}),
    ("midnight-lime", {"tech", "technology", "developer", "dev", "code", "coding", "software", "engineering",
                       "ai", "ml", "model", "app", "mobile", "startup", "launch", "fast", "speed",
                       "performance", "ship", "build", "framework", "open-source", "opensource", "gpu", "cli"}),
]
_THEME_TONE = {
    "punchy": "midnight-lime", "energetic": "sunset-pop", "fast": "midnight-lime",
    "calm": "ocean-glass", "reassuring": "ocean-glass", "serious": "ocean-glass",
    "editorial": "paper-ink", "warm": "paper-ink", "conversational": "paper-ink",
    "premium": "ember-noir", "cinematic": "ember-noir",
    "professional": "slate-sky", "clean": "slate-sky",
}


def pick_theme(*texts, format=None):
    """Best palette for a request inferred from its wording; None when there is no signal."""
    blob = " ".join(str(t) for t in texts if t).lower()
    words = set(re.findall(r"[a-z0-9][a-z0-9-]+", blob))
    scores = {theme: len(words & hints) for theme, hints in THEME_RUBRIC}
    for token, theme in _THEME_TONE.items():
        if token in words:
            scores[theme] = scores.get(theme, 0) + 2
    if format == "9:16":
        for theme in ("sunset-pop", "midnight-lime"):
            scores[theme] += 1
    best = max(scores, key=lambda theme: scores[theme])
    return best if scores[best] > 0 else None


def design_theme(args, blurb):
    """Explicit `--theme` wins; otherwise *design* a bespoke palette from the brief and fall back
    to the nearest curated preset only when the brief carries no colour/mood signal."""
    if getattr(args, "theme", None):
        return args.theme
    return (palette.best(blurb, format=getattr(args, "format", None), seed=getattr(args, "seed", None))
            or pick_theme(blurb, format=getattr(args, "format", None)) or "midnight-lime")


def brief_blurb(script) -> str:
    """The one-line request description a palette is designed from (goal + title + style)."""
    return " ".join(str(v) for v in ((script.get("brief") or {}).get("goal"), script.get("title"),
                                     script.get("style")) if v)


def choose_theme(script, plan, fmt=None):
    """Resolve a plan's palette: explicit `theme` -> designed from the brief -> curated fallback.

    `check` and `clips` both call this, so validation and render always agree — and a hand-written
    plan that names no theme gets the same bespoke palette `draft`/`make` would have designed,
    instead of silently dropping to a curated preset.
    """
    explicit = plan.get("theme") or script.get("theme")
    if explicit:
        return explicit
    fmt = fmt or plan.get("format") or (script.get("brief") or {}).get("format")
    blurb = brief_blurb(script)
    return palette.best(blurb, format=fmt) or pick_theme(blurb, format=fmt) or "midnight-lime"


def parse_features(raw) -> list:
    feats = []
    for item in raw or []:
        title, _, desc = item.partition(":")
        feats.append({"title": title.strip(), "desc": desc.strip()})
    return feats


def draft_spec(args, work, project) -> dict:
    """Existing pages -> inspect them. No pages -> scaffold a showcase site from the brief."""
    work = Path(work)
    # Keep the AUTHORED value (possibly `${VAR}`) in plan.json; only the interpolated copy is used
    # to inspect the running page, so a token in the url never gets written to disk.
    pages = list(args.page or []) or discover_pages(project)
    urls = [interpolate_env(p) for p in pages]
    urls = [p if re.match(r"^(https?|file)://", p) else Path(p).resolve().as_uri() for p in urls]
    theme = args.theme  # explicit --theme always wins; otherwise designed per branch below
    scenes = []

    if urls:
        print(f"found {len(urls)} page(s) — inspecting")
        info = site.inspect_pages(urls)
        first = info[urls[0]]
        name = args.name or _clean_title(first["title"])
        headline = args.tagline or first["h1"] or first["title"] or name
        desc = _sentence(args.description or first["description"])
        theme = theme or design_theme(args, " ".join([name, headline, desc]))
        say = [s for s in dict.fromkeys([_sentence(headline), desc]) if s]
        scenes.append({"type": "hook", "text": _accent(headline), "say": say})
        for n, url in enumerate(urls):
            focus = [f for f in info[url]["focus"] if f["label"]][: 4 if n == 0 else 3]
            beats = [_beat(f["label"], f.get("note", "")) if f["kind"] != "cta" else f"Then one clear action: {f['label']}."
                     for f in focus] or [f"Here is {info[url]['title'] or 'the page'}."]
            scenes.append({"type": "browse", "source": "browse", "url": pages[n],
                           "actions": _browse_actions(focus), "say": beats})
        spec_site = None
    else:
        feats = parse_features(args.feature)
        if not (args.name and args.tagline and len(feats) >= 2):
            raise RuntimeError(
                f"No HTML pages found in {project}. To build a showcase site + video, pass: "
                "--name \"X\" --tagline \"one-line promise\" --feature \"Title:short description\" "
                "(at least two --feature) [--cta \"Try X\"] [--url x.dev] [--description \"...\"]")
        name = args.name
        theme = theme or design_theme(args, " ".join([name or "", args.tagline or "", args.description or "",
                                                      *(f"{f['title']} {f['desc']}" for f in feats)]))
        spec_site = {"name": name, "tagline": args.tagline, "description": args.description or "",
                     "features": feats, "cta": args.cta or f"Try {name}", "url": args.url or ""}
        target = site.scaffold_site(spec_site, theme or "midnight-lime", work / "site")
        print(f"scaffolded showcase site -> {target}")
        scenes.append({"type": "hook", "text": _accent(args.tagline),
                       "say": [_sentence(args.tagline)] + ([_sentence(args.description)] if args.description else [])})
        scenes.append({"type": "browse", "source": "browse", "url": str(target),
                       "actions": _browse_actions(site.site_focus(spec_site)[1:-1]),
                       "say": [_beat(f["title"], f["desc"]) for f in feats]})

    cta = args.cta or f"Try {name}"
    scenes.append({"type": "outro", "text": cta, "sub": args.url or name, "button": "Get started",
                   "say": [f"{name}. {cta}."]})
    return {"title": name, "theme": theme or "midnight-lime", "format": args.format or "16:9",
            "voice": args.voice or tts.DEFAULT_VOICE,
            "style": args.style or "warm, confident narrator, natural pace",
            "project": str(Path(project).resolve()), "site": spec_site, "scenes": scenes}
