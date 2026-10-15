"""Template engine: scene dict + audio timing -> deterministic, seekable HTML.

Everything is CSS @keyframes (no JS timers, no randomness), so `capture_frames` can seek it
frame-exactly. Sizes use vmin so one layout serves 16:9 and 9:16.
Scene types: hook, stat, steps, compare, page, outro.
"""

from __future__ import annotations

import html

from . import palette

THEMES = {
    "midnight-lime": dict(bg="#0B0F1A", fg="#F3F5F9", accent="#B6FF3B", muted="#8A93A6", card="#151B2B", on="#0B0F1A"),
    "paper-ink": dict(bg="#F6F1E7", fg="#1B1B1F", accent="#E4572E", muted="#6B665C", card="#FFFFFF", on="#FFFFFF"),
    "ocean-glass": dict(bg="#06202B", fg="#E8F6FA", accent="#35D0BA", muted="#7FA3AE", card="#0C3040", on="#06202B"),
    "sunset-pop": dict(bg="#1A1033", fg="#FFF4EC", accent="#FF6B6B", muted="#B7A6D6", card="#271A48", on="#1A1033"),
    "slate-sky": dict(bg="#F4F7FB", fg="#0F1B2D", accent="#2F6FED", muted="#5B6B82", card="#FFFFFF", on="#FFFFFF"),
    "ember-noir": dict(bg="#120D0A", fg="#F6EFE6", accent="#E9A23B", muted="#A38F7A", card="#1E1611", on="#120D0A"),
}


def resolve_theme(theme) -> dict:
    """A theme is a curated preset *name* or a bespoke palette dict.

    A dict comes from `vc theme` / `palette.design` (or the agent) and may omit the secondary
    tokens — they are derived from the ones that are present so a one-off palette always renders.
    """
    if isinstance(theme, dict):
        given = {k: v for k, v in theme.items() if k in palette.KEYS and palette.HEX.match(str(v))}
        for key in ("bg", "fg", "accent"):
            given.setdefault(key, THEMES["midnight-lime"][key])
        return palette.normalize(given)
    return THEMES.get(theme) or THEMES["midnight-lime"]


def esc(value) -> str:
    return html.escape(str(value), quote=True)


class Ctx:
    def __init__(self, width, height, theme, dur_ms, marks):
        self.W, self.H = int(width), int(height)
        self.t = resolve_theme(theme)
        self.dur = int(dur_ms)
        self.marks = marks or []          # [{start, duration, text}] in ms
        self.portrait = self.H > self.W

    def times(self, n):
        """Start time (ms) for n visual events, snapped to narration beats when possible."""
        if n <= 0:
            return []
        starts = [int(m["start"]) for m in self.marks]
        if len(starts) >= n:
            if n == 1:
                return [starts[0]]
            return [starts[round(i * (len(starts) - 1) / (n - 1))] for i in range(n)]
        t0 = starts[0] if starts else 400
        end = max(self.dur - 700, t0 + 600)
        step = (end - t0) / n
        return [int(t0 + i * step) for i in range(n)]

    def stage(self):
        if self.portrait:
            sw, sh = self.W - 80, int(self.H * 0.52)
        else:
            sw, sh = self.W - 240, int(self.H * 0.74)
        return sw - sw % 2, sh - sh % 2, int(self.H * 0.055)


BASE_CSS = """
:root{--bg:@@bg@@;--fg:@@fg@@;--accent:@@accent@@;--muted:@@muted@@;--card:@@card@@;--on:@@on@@}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:@@W@@px;height:@@H@@px;overflow:hidden;background:var(--bg);color:var(--fg);
 font-family:Inter,"Segoe UI",Roboto,system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif}
.bg{position:absolute;inset:0;overflow:hidden}
.blob{position:absolute;border-radius:50%;filter:blur(8vmin);opacity:.55;animation:drift @@DUR@@ms linear both}
.b1{width:70vmin;height:70vmin;left:-10vmin;top:-14vmin;background:@@accent@@55}
.b2{width:60vmin;height:60vmin;right:-12vmin;bottom:-16vmin;background:@@accent@@33;animation-direction:reverse}
@keyframes drift{from{transform:translate(0,0) scale(1)}to{transform:translate(8vmin,5vmin) scale(1.2)}}
.stage{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
 gap:3.4vmin;padding:0 6vw 12vh;animation:push @@DUR@@ms linear both}
@keyframes push{from{transform:scale(1)}to{transform:scale(1.035)}}
.r{animation:rise 560ms cubic-bezier(.2,.8,.2,1) both;animation-delay:var(--d,0ms)}
@keyframes rise{from{opacity:0;transform:translateY(3.2vmin)}to{opacity:1;transform:none}}
@keyframes fadeout{from{opacity:1}to{opacity:0}}
@keyframes dim{from{opacity:1}to{opacity:.4}}
.fo{animation:fadeout 300ms both;animation-delay:var(--o)}
.dm{animation:dim 400ms both;animation-delay:var(--o)}
"""


def shell(c: Ctx, body: str, css: str = "") -> str:
    text = BASE_CSS + css
    repl = dict(c.t, W=c.W, H=c.H, DUR=c.dur)
    for key, value in repl.items():
        text = text.replace(f"@@{key}@@", str(value))
    return ("<!doctype html><html><head><meta charset=\"utf-8\"><title>scene</title>"
            f"<style>{text}</style></head><body>"
            "<div class=\"bg\"><div class=\"blob b1\"></div><div class=\"blob b2\"></div></div>"
            f"{body}<script>window.__ready=document.fonts.ready;</script></body></html>")


def _words(text):
    out, on = [], False
    for tok in str(text).split():
        if tok.startswith("*"):
            on, tok = True, tok.lstrip("*")
        end = tok.endswith("*")
        tok = tok.rstrip("*")
        if tok:
            out.append((tok, on))
        if end:
            on = False
    return out


# --------------------------------------------------------------------------- hook
def hook(s, c: Ctx):
    words = _words(s.get("text", ""))
    plain_len = sum(len(w) + 1 for w, _ in words)
    size = 17 if plain_len <= 22 else 13 if plain_len <= 44 else 10
    t0 = (c.marks[0]["start"] if c.marks else 0) + 150
    first = c.marks[0]["duration"] if c.marks else 1400
    span = min(1400, max(500, int(first * 0.75)))
    spans = "".join(
        f'<span class="w{" a" if a else ""}" style="--d:{t0 + int(i * span / max(1, len(words)))}ms">{esc(w)}</span>'
        for i, (w, a) in enumerate(words))
    after = t0 + span + 250
    sub_t = c.marks[1]["start"] if len(c.marks) > 1 else after
    sub = f'<p class="sub r" style="--d:{sub_t}ms">{esc(s["sub"])}</p>' if s.get("sub") else ""
    body = (f'<div class="stage"><h1 class="h" style="font-size:{size}vmin">{spans}</h1>'
            f'<div class="rule r" style="--d:{after}ms"></div>{sub}</div>')
    css = (".h{font-weight:800;letter-spacing:-.025em;line-height:1.05;text-align:center;max-width:92%}"
           ".h .w{display:inline-block;margin:0 .14em;animation:rise 520ms cubic-bezier(.2,.8,.2,1) both;animation-delay:var(--d)}"
           ".h .a{color:var(--accent)}.rule{width:14vmin;height:1.1vmin;border-radius:1vmin;background:var(--accent)}"
           ".sub{font-size:4.2vmin;color:var(--muted);text-align:center;max-width:82%;font-weight:500;line-height:1.3}")
    return shell(c, body, css)


# --------------------------------------------------------------------------- stat
def stat(s, c: Ctx):
    val = s.get("value", 0)
    is_int = isinstance(val, int) or (isinstance(val, str) and val.isdigit())
    t = c.times(2)
    if is_int:
        num = '<span class="num" style="animation-delay:%dms"></span>' % t[0]
        kf = "@keyframes count{from{--n:0}to{--n:%d}}" % int(val)
    else:
        num = f'<span class="r" style="--d:{t[0]}ms">{esc(val)}</span>'
        kf = ""
    pre = f'<span class="pre">{esc(s["prefix"])}</span>' if s.get("prefix") else ""
    suf = f'<span class="pre">{esc(s["suffix"])}</span>' if s.get("suffix") else ""
    body = (f'<div class="stage"><div class="stat r" style="--d:{max(0, t[0] - 100)}ms">{pre}{num}{suf}</div>'
            f'<p class="label r" style="--d:{t[1]}ms">{esc(s.get("label", ""))}</p></div>')
    css = ("@property --n{syntax:'<integer>';inherits:false;initial-value:0}" + kf +
           ".stat{display:flex;align-items:baseline;gap:1vmin;font-weight:800;font-size:30vmin;line-height:1;"
           "letter-spacing:-.04em;color:var(--accent);font-variant-numeric:tabular-nums}"
           ".num{animation:count 1500ms cubic-bezier(.2,.8,.2,1) both}.num::after{counter-reset:n var(--n);content:counter(n)}"
           ".pre{font-size:.45em}.label{font-size:6vmin;font-weight:600;text-align:center;max-width:82%;line-height:1.2}")
    return shell(c, body, css)


# --------------------------------------------------------------------------- steps
def steps(s, c: Ctx):
    items = s.get("items", [])
    t = c.times(len(items))
    title = f'<p class="cap r" style="--d:150ms">{esc(s["title"])}</p>' if s.get("title") else ""
    cards = []
    for i, item in enumerate(items):
        text = item["title"] if isinstance(item, dict) else item
        desc = item.get("desc", "") if isinstance(item, dict) else ""
        d2 = f'<small>{esc(desc)}</small>' if desc else ""
        inner = (f'<div class="card r" style="--d:{t[i]}ms"><b>{i + 1}</b>'
                 f'<span>{esc(text)}{d2}</span></div>')
        if i + 1 < len(items):
            cards.append(f'<div class="dm" style="--o:{t[i + 1]}ms">{inner}</div>')
        else:
            cards.append(f"<div>{inner}</div>")
    body = f'<div class="stage">{title}<div class="list">{"".join(cards)}</div></div>'
    css = (".list{display:flex;flex-direction:column;gap:2.6vmin;width:min(86vw,125vmin)}"
           ".card{display:flex;align-items:center;gap:3vmin;background:var(--card);border-radius:2.4vmin;padding:2.8vmin 3.6vmin;"
           "font-size:5vmin;font-weight:700;border:1px solid rgba(128,128,128,.18)}"
           ".card b{flex:none;width:7.5vmin;height:7.5vmin;border-radius:50%;background:var(--accent);color:var(--on);"
           "display:grid;place-items:center;font-size:4.4vmin}"
           ".card small{display:block;font-size:3.4vmin;color:var(--muted);font-weight:500;margin-top:.6vmin}"
           ".cap{font-size:4vmin;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);font-weight:700}")
    return shell(c, body, css)


# --------------------------------------------------------------------------- compare
def compare(s, c: Ctx):
    t = c.times(2)
    body = ('<div class="stage"><div class="two">'
            f'<div class="card r" style="--d:{t[0]}ms"><i>{esc(s.get("before_label", "Before"))}</i>{esc(s.get("before", ""))}</div>'
            f'<div class="card ok r" style="--d:{t[1]}ms"><i>{esc(s.get("after_label", "After"))}</i>{esc(s.get("after", ""))}</div>'
            '</div></div>')
    css = (".two{display:flex;flex-wrap:wrap;gap:3vmin;justify-content:center;width:min(92vw,170vmin)}"
           ".card{flex:1 1 40vmin;background:var(--card);border-radius:2.6vmin;padding:4.5vmin;font-size:5.2vmin;font-weight:700;"
           "line-height:1.25;border:1px solid rgba(128,128,128,.18);opacity:.9}"
           ".card i{display:block;font-style:normal;font-size:3.2vmin;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-bottom:2vmin}"
           ".ok{border:.5vmin solid var(--accent);opacity:1}.ok i{color:var(--accent)}")
    return shell(c, body, css)


# --------------------------------------------------------------------------- outro
def outro(s, c: Ctx):
    t = c.times(3)
    button = (f'<div class="r" style="--d:{t[2]}ms"><div class="pill">{esc(s["button"])}</div></div>'
              if s.get("button") else "")
    sub = f'<p class="sub r" style="--d:{t[1]}ms">{esc(s["sub"])}</p>' if s.get("sub") else ""
    body = (f'<div class="stage"><h1 class="h r" style="--d:{t[0]}ms;font-size:{12 if len(str(s.get("text", ""))) < 30 else 9}vmin">'
            f'{esc(s.get("text", ""))}</h1>{sub}{button}</div>')
    css = (".h{font-weight:800;letter-spacing:-.025em;text-align:center;line-height:1.08;max-width:92%;color:var(--accent)}"
           ".sub{font-size:5vmin;color:var(--fg);font-weight:600;text-align:center}"
           ".pill{background:var(--accent);color:var(--on);font-weight:800;font-size:4.6vmin;padding:2vmin 5vmin;border-radius:4vmin;"
           "animation:pulse 1600ms ease-in-out infinite}"
           "@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.06)}}")
    return shell(c, body, css)


# --------------------------------------------------------------------------- page (camera over a real page screenshot)
def _state(rect, iw, ih, sw, vh, k0):
    z = max(1.0, min(2.2, sw * 0.7 / max(1.0, rect["width"] * k0)))
    k = k0 * z
    cx, cy = rect["x"] + rect["width"] / 2, rect["y"] + rect["height"] / 2
    tx = min(0.0, max(sw - iw * k, sw / 2 - cx * k))
    ty = (vh - ih * k) / 2 if ih * k <= vh else min(0.0, max(vh - ih * k, vh / 2 - cy * k))
    return tx, ty, k


def page(s, c: Ctx):
    shot = s["_shot"]
    iw, ih = float(shot["w"]), float(shot["h"])
    sw, sh, top = c.stage()
    bar = max(28, sh // 16)
    vh = sh - bar
    k0 = sw / iw
    focus = [f for f in s.get("focus", []) if shot["rects"].get(f["sel"])]
    tms = c.times(len(focus))
    s0 = (0.0, 0.0, k0)

    pts, total = [(0, s0)], c.dur
    if focus:
        prev, last = s0, 0
        for T, f in zip(tms, focus):
            state = _state(shot["rects"][f["sel"]], iw, ih, sw, vh, k0)
            dep = max(T - 350, last + 10)
            arr = max(T + 350, dep + 300)
            pts += [(dep, prev), (arr, state)]
            prev, last = state, arr
        total = max(c.dur, last + 10)
        pts.append((total, prev))
    else:
        end = (0.0, min(0.0, vh - ih * k0), k0)
        pts += [(400, s0), (total, end)]

    kf = "".join(
        f"{t / total * 100:.4f}%{{transform:translate({a:.2f}px,{b:.2f}px) scale({k:.5f});"
        "animation-timing-function:cubic-bezier(.5,0,.2,1)}" for t, (a, b, k) in pts)

    rings, chips = [], []
    for i, f in enumerate(focus):
        r = shot["rects"][f["sel"]]
        out = f' fo" style="--o:{tms[i + 1] - 120}ms' if i + 1 < len(focus) else ""
        wrap_cls = "rw" + (" fo" if out else "")
        wrap_style = (f"left:{r['x'] - 10:.1f}px;top:{r['y'] - 10:.1f}px;width:{r['width'] + 20:.1f}px;height:{r['height'] + 20:.1f}px"
                      + (f";--o:{tms[i + 1] - 120}ms" if out else ""))
        rings.append(f'<div class="{wrap_cls}" style="{wrap_style}"><div class="ring" style="--d:{tms[i] + 250}ms"></div></div>')
        label = str(f.get("label", ""))[:56]
        if label:
            cs = f"--o:{tms[i + 1] - 120}ms" if i + 1 < len(focus) else ""
            chips.append(f'<div class="chipw{" fo" if cs else ""}" style="{cs}"><div class="chip r" style="--d:{tms[i]}ms">{esc(label)}</div></div>')

    left = (c.W - sw) // 2
    chip_top = top + sh + int(c.H * 0.016)
    url = esc(shot.get("title") or s.get("src", ""))
    body = (f'<div class="chrome r" style="left:{left}px;top:{top}px;width:{sw}px;height:{sh}px;--d:0ms">'
            f'<div class="bar" style="height:{bar}px"><i></i><i></i><i></i><span>{url}</span></div>'
            f'<div class="view" style="height:{vh}px"><div class="cam" style="width:{iw:.0f}px;height:{ih:.0f}px">'
            f'<img src="../pages/{esc(shot["file"])}" width="{iw:.0f}" height="{ih:.0f}">{"".join(rings)}</div></div></div>'
            f'<div class="chips" style="top:{chip_top}px">{"".join(chips)}</div>')
    css = ("@keyframes camk{" + kf + "}"
           ".chrome{position:absolute;border-radius:2vmin;overflow:hidden;background:var(--card);"
           "box-shadow:0 4vmin 10vmin rgba(0,0,0,.45);border:1px solid rgba(128,128,128,.25)}"
           ".bar{display:flex;align-items:center;gap:.9vmin;padding:0 2vmin;background:var(--card);border-bottom:1px solid rgba(128,128,128,.25)}"
           ".bar i{width:1.5vmin;height:1.5vmin;border-radius:50%;background:var(--muted);opacity:.6}"
           ".bar span{margin-left:2vmin;font-size:1.9vmin;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"
           ".view{position:relative;overflow:hidden;background:#fff}"
           f".cam{{position:absolute;left:0;top:0;transform-origin:0 0;animation:camk {total}ms linear both}}"
           ".cam img{display:block}.rw{position:absolute;pointer-events:none}"
           ".ring{position:absolute;inset:0;border:4px solid var(--accent);border-radius:12px;box-shadow:0 0 28px @@accent@@88;"
           "animation:ringin 450ms cubic-bezier(.2,.8,.2,1) both;animation-delay:var(--d)}"
           "@keyframes ringin{from{opacity:0;transform:scale(1.08)}to{opacity:1;transform:none}}"
           ".chips{position:absolute;left:0;right:0;height:7vmin}.chipw{position:absolute;inset:0;display:flex;justify-content:center}"
           ".chip{background:var(--accent);color:var(--on);font-weight:800;font-size:3.4vmin;padding:1vmin 3vmin;border-radius:4vmin;"
           "height:fit-content;white-space:nowrap}")
    return shell(c, body, css)


RENDERERS = {"hook": hook, "stat": stat, "steps": steps, "compare": compare, "outro": outro, "page": page}


def render(scene, ctx: Ctx) -> str:
    kind = scene.get("type")
    if kind not in RENDERERS:
        raise ValueError(f"unknown scene type {kind!r}; use one of {', '.join(RENDERERS)}")
    return RENDERERS[kind](scene, ctx)
