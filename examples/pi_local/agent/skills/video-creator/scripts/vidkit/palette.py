"""Request-driven colour design: turn a brief (or a brand seed) into a bespoke palette.

The six curated `scenes.THEMES` are safe fallbacks, but picking one of six by keyword makes every
video look the same. This module instead *designs* a palette so two different requests do not
collapse onto one preset: it reads the brief's mood and any explicit colour, then builds a
harmonious, contrast-safe palette with colour theory (analogous / complementary accents).

Deterministic and LLM-free: the same brief always yields the same palette, so a render is
reproducible. Contrast is enforced to WCAG levels (`fg/bg ≥ 4.5`, `accent/bg ≥ 3`, `on/accent ≥ 3`,
`muted/bg ≥ 3`) so the result is always legible, whatever the mood.
"""

from __future__ import annotations

import colorsys
import hashlib
import re

HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
_WORD = re.compile(r"[a-z0-9][a-z0-9+.-]*")
KEYS = ("bg", "fg", "accent", "muted", "card", "on")

# Contrast floors. `on` sits on `accent` as bold text/digits, `accent` is large graphic + display
# text, `muted` is secondary copy — all deliberately at WCAG AA-for-large-text levels.
_FG_BG, _ACCENT_BG, _ON_ACCENT, _MUTED_BG = 4.5, 3.0, 3.0, 3.0


# ── colour maths ─────────────────────────────────────────────────────
def clamp(value, lo, hi):
    return max(lo, min(hi, value))


def hex_to_rgb(color):
    value = str(color).lstrip("#")
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def rgb_to_hex(r, g, b):
    return "#%02X%02X%02X" % (round(clamp(r, 0, 255)), round(clamp(g, 0, 255)), round(clamp(b, 0, 255)))


def hsl(h, l, s):
    """Hue 0-360, lightness/saturation 0-1 -> `#RRGGBB`."""
    r, g, b = colorsys.hls_to_rgb((h % 360) / 360.0, clamp(l, 0, 1), clamp(s, 0, 1))
    return rgb_to_hex(r * 255, g * 255, b * 255)


def luminance(color):
    def channel(c):
        c /= 255.0
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (channel(c) for c in hex_to_rgb(color))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    """WCAG contrast ratio (1.0 – 21.0) between two `#RRGGBB` colours."""
    hi, lo = sorted((luminance(a), luminance(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


def mix(a, b, t):
    """Blend `a`->`b` in RGB; t=0 returns `a`, t=1 returns `b`."""
    ra, ga, ba = hex_to_rgb(a)
    rb, gb, bb = hex_to_rgb(b)
    return rgb_to_hex(ra + (rb - ra) * t, ga + (gb - ga) * t, ba + (bb - ba) * t)


def on_color(accent):
    """The legible foreground (near-black or white) to place on an accent fill."""
    dark, light = "#0B0F1A", "#FFFFFF"
    return dark if contrast(accent, dark) >= contrast(accent, light) else light


def normalize(theme: dict) -> dict:
    """Fill the derived tokens (`card`/`muted`/`on`) a bespoke palette may omit.

    `bg`/`fg`/`accent` must already be present and valid — callers supply defaults for those.
    """
    t = dict(theme)
    bg, fg, accent = t["bg"], t["fg"], t["accent"]
    t.setdefault("card", mix(bg, fg, 0.08))
    t.setdefault("muted", mix(fg, bg, 0.45))
    t.setdefault("on", on_color(accent))
    return t


def _fit(bg, hue, sat, target, go_light, cap=None):
    """Search lightness from the most extreme end inward for the first tone meeting `target`."""
    lo, hi = (0.02, 0.96) if go_light else (0.04, 0.98)
    if cap is not None:
        hi = min(hi, cap) if go_light else max(lo, cap)
    best = None
    span = hi - lo
    for i in range(51):
        l = (hi - span * i / 50) if go_light else (lo + span * i / 50)
        color = hsl(hue, l, sat)
        c = contrast(color, bg)
        if c >= target:
            return color, c
        if best is None or c > best[1]:
            best = (color, c)
    return best


def _accent(bg, hue, sat, desired_l, target=_ACCENT_BG):
    """Accent at roughly `desired_l`, pushed away from the background until it reaches `target`."""
    go_light = luminance(bg) < 0.5
    best = None
    for i in range(61):
        l = clamp(desired_l + (0.012 * i if go_light else -0.012 * i), 0.05, 0.95)
        color = hsl(hue, l, sat)
        c = contrast(color, bg)
        legible_on = max(contrast(color, "#000000"), contrast(color, "#FFFFFF")) >= 4.5
        if c >= target and legible_on:
            return color, c
        if best is None or c > best[1]:
            best = (color, c)
        if (go_light and l >= 0.95) or (not go_light and l <= 0.05):
            break
    return best


def _muted(fg, bg, target=_MUTED_BG):
    """Secondary text tone: the dimmest fg/bg blend that still meets `target`."""
    best = (mix(fg, bg, 0.5), 0.0)
    for i in range(41):
        color = mix(fg, bg, 0.62 - 0.011 * i)
        c = contrast(color, bg)
        if c >= target:
            return color, c
        if c > best[1]:
            best = (color, c)
    return best


# ── request -> recipe ────────────────────────────────────────────────
# Each recipe is a *mood*: a canvas bias (light/dark), a background hue band, and an accent hue
# band. Accents are chosen for harmony with the canvas so the pair reads as intentional.
RECIPES = [
    dict(name="premium", label="premium / near-black + gold", preset="ember-noir",
         mode="dark", bg=(30, 48), accent=(36, 52), bg_sat=0.30, card_l=0.115,
         accent_sat=0.70, accent_l=0.60,
         keywords={"luxury", "premium", "exclusive", "elegant", "cinematic", "noir", "wine", "whisky",
                   "whiskey", "champagne", "cigar", "gold", "jewellery", "jewelry", "fashion",
                   "couture", "hotel", "hospitality", "spa", "gala", "bespoke", "perfume", "watch",
                   "yacht", "private", "keynote", "boutique", "distillery"}),
    dict(name="tech", label="tech / deep canvas + neon", preset="midnight-lime",
         mode="dark", bg=(205, 268), accent=(72, 158), bg_sat=0.36, card_l=0.145,
         accent_sat=0.85, accent_l=0.63,
         keywords={"tech", "technology", "developer", "dev", "code", "coding", "software", "engineering",
                   "ai", "ml", "gpu", "crypto", "bitcoin", "blockchain", "cyber", "hacker", "neon",
                   "arcade", "gaming", "game", "esports", "synth", "techno", "brutalist", "futuristic",
                   "startup", "saas", "platform", "api", "cloud", "robotics", "space", "quantum",
                   "terminal", "linux", "server", "database"}),
    dict(name="calm", label="calm / clinical teal", preset="ocean-glass",
         mode="dark", bg=(190, 216), accent=(165, 200), bg_sat=0.30, card_l=0.135,
         accent_sat=0.55, accent_l=0.62,
         keywords={"finance", "fintech", "bank", "banking", "insurance", "invest", "investment", "wealth",
                   "health", "medical", "hospital", "clinic", "care", "therapy", "calm", "minimal",
                   "minimalist", "meditation", "wellness", "mindfulness", "security", "cybersecurity",
                   "privacy", "trust", "enterprise", "compliance", "legal", "government", "nonprofit",
                   "science", "research", "lab", "clinical", "data"}),
    dict(name="playful", label="playful / plum + pop", preset="sunset-pop",
         mode="dark", bg=(260, 300), accent=(322, 362), bg_sat=0.34, card_l=0.155,
         accent_sat=0.85, accent_l=0.66,
         keywords={"playful", "fun", "kids", "child", "toy", "candy", "sweet", "party", "festival",
                   "social", "music", "dance", "fitness", "sport", "sporty", "energetic", "bold", "pop",
                   "colourful", "colorful", "vibrant", "creative", "art", "design", "beauty", "makeup",
                   "album", "band", "concert", "nightlife"}),
    dict(name="nature", label="nature / forest + leaf", preset="ocean-glass",
         mode="dark", bg=(140, 178), accent=(88, 142), bg_sat=0.30, card_l=0.125,
         accent_sat=0.62, accent_l=0.61,
         keywords={"eco", "green", "sustainable", "sustainability", "climate", "environment", "solar",
                   "energy", "plant", "garden", "forest", "tree", "leaf", "ocean", "sea", "water",
                   "river", "mountain", "travel", "outdoor", "adventure", "wildlife", "agriculture",
                   "harvest", "recycling", "renewable", "bakery", "farm", "organic", "coffee", "tea"}),
    dict(name="editorial", label="editorial / warm paper", preset="paper-ink",
         mode="light", bg=(22, 46), accent=(10, 40), bg_sat=0.24, card_l=0.995,
         accent_sat=0.62, accent_l=0.42,
         keywords={"editorial", "paper", "book", "magazine", "blog", "journal", "story", "storytelling",
                   "cozy", "warm", "artisan", "handmade", "craft", "cafe", "bakery", "restaurant",
                   "recipe", "cook", "kitchen", "brunch", "chocolate", "vintage", "retro", "classic",
                   "heritage", "family", "museum", "theatre", "theater", "film", "documentary", "podcast"}),
    dict(name="clean", label="clean / product blue", preset="slate-sky",
         mode="light", bg=(205, 228), accent=(210, 244), bg_sat=0.30, card_l=1.0,
         accent_sat=0.78, accent_l=0.46,
         keywords={"product", "platform", "dashboard", "analytics", "workspace", "productivity", "tool",
                   "tutorial", "guide", "howto", "how-to", "walkthrough", "docs", "documentation",
                   "course", "learn", "school", "university", "education", "app", "mobile", "onboarding",
                   "crm", "team", "collaboration", "support", "billing", "agency", "business", "widget"}),
]
_RECIPE = {r["name"]: r for r in RECIPES}
_ORDER = [r["name"] for r in RECIPES]

# Explicit colour words beat the mood's own hue band.
COLOR_HUES = {
    "red": 2, "crimson": 350, "ruby": 350, "scarlet": 5, "coral": 14, "orange": 28, "amber": 42,
    "gold": 45, "yellow": 52, "lime": 85, "olive": 70, "green": 140, "emerald": 150, "mint": 162,
    "teal": 180, "turquoise": 176, "cyan": 186, "aqua": 184, "sky": 205, "blue": 220, "navy": 226,
    "indigo": 250, "violet": 268, "purple": 275, "lavender": 285, "magenta": 310, "pink": 330,
    "rose": 344, "burgundy": 350, "maroon": 355, "sand": 38, "beige": 42, "peach": 22, "charcoal": 220,
    "mono": 220, "monochrome": 220, "greyscale": 220, "grayscale": 220,
}


def _slug(text, limit=40):
    words = re.findall(r"[a-z0-9]+", (text or "").lower())
    return "-".join(words[:6])[:limit] or "theme"


def _pick(brief, band, salt):
    lo, hi = band
    span = (hi - lo) % 360 or 360
    frac = (int(hashlib.sha1(f"{salt}|{brief}".encode()).hexdigest(), 16) % 10000) / 10000.0
    return (lo + span * frac) % 360


def _match(brief):
    """Return (recipe_name, matched_words, colour_word, score)."""
    words = set(_WORD.findall((brief or "").lower()))
    scores = {r["name"]: len(words & r["keywords"]) for r in RECIPES}
    winner = max(_ORDER, key=lambda name: (scores[name], -_ORDER.index(name)))
    colors = [w for w in words if w in COLOR_HUES]
    color = sorted(colors, key=lambda w: list(COLOR_HUES).index(w))[0] if colors else None
    hits = sorted(words & _RECIPE[winner]["keywords"])
    return winner, hits, color, scores[winner]


def _build(name, recipe, brief, *, accent_hue=None, bg_hue=None, accent_l=None, seed_hue=None):
    mode = recipe["mode"]
    dark = mode == "dark"
    bg_hue = bg_hue if bg_hue is not None else _pick(brief, recipe["bg"], f"bg:{name}")
    accent_hue = accent_hue if accent_hue is not None else _pick(brief, recipe["accent"], f"ac:{name}")
    if seed_hue is not None:
        accent_hue = seed_hue
    bg = hsl(bg_hue, 0.07 if dark else 0.955, recipe["bg_sat"])
    card = hsl(bg_hue, recipe["card_l"], recipe["bg_sat"] * 0.9)
    fg, _ = _fit(bg, bg_hue, 0.12, _FG_BG + 2.5, go_light=dark)
    accent, _ = _accent(bg, accent_hue, recipe["accent_sat"], accent_l if accent_l is not None else recipe["accent_l"])
    muted, _ = _muted(fg, bg)
    return {"bg": bg, "fg": fg, "accent": accent, "muted": muted, "card": card, "on": on_color(accent)}


def _metrics(p):
    return {"fg/bg": round(contrast(p["fg"], p["bg"]), 2), "accent/bg": round(contrast(p["accent"], p["bg"]), 2),
            "on/accent": round(contrast(p["on"], p["accent"]), 2), "muted/bg": round(contrast(p["muted"], p["bg"]), 2)}


def design(brief, *, format=None, seed=None, variants=3, signal_only=False) -> list:
    """Design up to `variants` palettes for `brief`. Returns [] when there is no signal and
    `signal_only` is set (so callers can fall back to a curated preset)."""
    name, hits, color, score = _match(brief)
    seed_hue = None
    if seed and HEX.match(str(seed)):
        seed_hue = colorsys.rgb_to_hls(*[c / 255 for c in hex_to_rgb(seed)])[0] * 360
    if signal_only and not hits and not color and seed_hue is None:
        return []
    if not hits:
        name = "clean"

    recipe = _RECIPE[name]
    band = recipe["accent"]
    accents = []
    for i in range(max(1, variants)):
        if color:
            h = COLOR_HUES[color] if i == 0 else COLOR_HUES[color] + (i * 14) * (1 if i % 2 else -1)
            accents.append(h % 360)
        else:
            accents.append(_pick(brief, band, f"accent{i}"))  # brief-dependent, distinct per variant
    light_ls = [recipe["accent_l"], recipe["accent_l"] + 0.10, recipe["accent_l"] - 0.08]

    out = []
    for i, hue in enumerate(accents):
        pal = _build(f"{name}{i}", recipe, brief, accent_hue=hue, accent_l=light_ls[i % len(light_ls)],
                     seed_hue=seed_hue if seed_hue is not None else None)
        reason = ("seeded by brand colour " + seed) if seed_hue is not None else (
            "explicit colour " + color if color else ("matched: " + ", ".join(hits) if hits else "no explicit signal — balanced default"))
        out.append({"name": f"{_slug(brief)}-{i + 1}", "recipe": name, "label": recipe["label"],
                    "preset": recipe["preset"], "reason": reason, "palette": pal, "contrast": _metrics(pal)})
    return out


def best(brief, *, format=None, seed=None):
    """The single best-designed palette for `brief`, or None when there is no signal to design from."""
    found = design(brief, format=format, seed=seed, variants=1, signal_only=True)
    return found[0]["palette"] if found else None


# ── validation (used by `vc check`) ──────────────────────────────────
def problems(theme) -> list:
    """Format + contrast problems with a custom palette (empty list for a valid/absent one).

    `bg`/`fg`/`accent` are required; `card`/`muted`/`on` are derived when omitted.
    """
    if not isinstance(theme, dict):
        return []
    issues = []
    for key in KEYS:
        if key in theme and not HEX.match(str(theme[key])):
            issues.append(f"custom palette '{key}' must be #RRGGBB, got {theme[key]!r}")
    for key in ("bg", "fg", "accent"):
        if key not in theme:
            issues.append(f"custom palette is missing '{key}'")
    if issues:
        return issues
    resolved = normalize(theme)
    for label, fg, bg, target in (("fg/bg", resolved["fg"], resolved["bg"], _FG_BG),
                                  ("accent/bg", resolved["accent"], resolved["bg"], _ACCENT_BG),
                                  ("on/accent", resolved["on"], resolved["accent"], _ON_ACCENT),
                                  ("muted/bg", resolved["muted"], resolved["bg"], _MUTED_BG)):
        ratio = contrast(fg, bg)
        if ratio < target:
            issues.append(f"custom palette {label} contrast {ratio:.1f} < {target} (text would be hard to read)")
    return issues
