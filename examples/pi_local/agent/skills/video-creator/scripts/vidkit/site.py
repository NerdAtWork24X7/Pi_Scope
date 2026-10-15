"""Showcase-site scaffold, existing-page inspection, and page screenshots (with element rects)."""

from __future__ import annotations

import hashlib
import struct
from pathlib import Path

from .capture import _READY, context_options
from .scenes import esc, resolve_theme

MAX_CSS_H = 7000  # keeps hi-dpi screenshots under Chromium's 16384px limit

_SITE_CSS = """
:root{--bg:@@bg@@;--fg:@@fg@@;--accent:@@accent@@;--muted:@@muted@@;--card:@@card@@;--on:@@on@@}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Inter,"Segoe UI",Roboto,system-ui,-apple-system,Arial,sans-serif;background:var(--bg);color:var(--fg);line-height:1.5;
 background-image:radial-gradient(900px 500px at 12% -5%,@@accent@@33,transparent 60%)}
.nav{display:flex;justify-content:space-between;align-items:center;padding:28px 6vw}
.nav b{font-size:22px;letter-spacing:-.01em}.nav a{color:var(--muted);text-decoration:none;margin-left:28px;font-weight:500}
.hero{padding:90px 6vw 110px;max-width:1240px;margin:0 auto}
.eyebrow{display:inline-block;color:var(--accent);font-weight:700;letter-spacing:.14em;text-transform:uppercase;font-size:14px;margin-bottom:22px}
h1{font-size:76px;line-height:1.02;letter-spacing:-.03em;font-weight:800;max-width:920px}
.lead{font-size:24px;color:var(--muted);max-width:700px;margin:26px 0 38px}
.btn{display:inline-block;background:var(--accent);color:var(--on);font-weight:700;padding:16px 30px;border-radius:14px;text-decoration:none;font-size:18px}
section{padding:80px 6vw;max-width:1240px;margin:0 auto}
h2{font-size:46px;letter-spacing:-.02em;margin-bottom:36px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:24px}
.card{background:var(--card);border-radius:20px;padding:30px;border:1px solid rgba(128,128,128,.18)}
.ico{width:44px;height:44px;border-radius:12px;background:var(--accent);color:var(--on);display:grid;place-items:center;font-weight:800;margin-bottom:18px}
.card h3{font-size:24px;margin-bottom:8px}.card p{color:var(--muted);font-size:17px}
#cta{text-align:center;padding-bottom:120px}#cta p{color:var(--muted);font-size:22px;margin:-14px 0 32px}
"""


def scaffold_site(site: dict, theme, out_dir) -> Path:
    t = resolve_theme(theme)
    css = _SITE_CSS
    for key, value in t.items():
        css = css.replace(f"@@{key}@@", value)
    cards = "".join(
        f'<article class="card"><div class="ico">{i:02d}</div><h3>{esc(f["title"])}</h3><p>{esc(f.get("desc", ""))}</p></article>'
        for i, f in enumerate(site["features"], 1))
    name, cta = esc(site["name"]), esc(site.get("cta") or f"Get started with {site['name']}")
    lead = f'<p class="lead">{esc(site["description"])}</p>' if site.get("description") else ""
    page = (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>{name}</title><meta name="description" content="{esc(site["tagline"])}"><style>{css}</style></head><body>'
            f'<header class="nav"><b>{name}</b><nav><a href="#features">Features</a><a href="#cta">Get started</a></nav></header>'
            f'<main><section class="hero"><span class="eyebrow">{name}</span><h1>{esc(site["tagline"])}</h1>{lead}'
            f'<a class="btn" href="#cta">{cta}</a></section>'
            f'<section id="features"><h2>Why {name}</h2><div class="grid">{cards}</div></section>'
            f'<section id="cta"><h2>{cta}</h2><p>{esc(site.get("url", ""))}</p><a class="btn" href="#cta">{cta}</a></section></main>'
            '</body></html>')
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    target = out / "index.html"
    target.write_text(page, encoding="utf-8")
    return target


def site_focus(site: dict) -> list:
    focus = [{"sel": "h1", "label": site["tagline"][:56]}]
    focus += [{"sel": f"#features .card:nth-child({i})", "label": f["title"]}
              for i, f in enumerate(site["features"], 1)]
    focus.append({"sel": "#cta .btn", "label": site.get("cta") or "Get started"})
    return focus


_INSPECT_JS = """() => {
  const path = el => { const p=[]; while(el && el.nodeType===1 && el!==document.body){ let i=1,s=el;
      while((s=s.previousElementSibling)) if(s.tagName===el.tagName) i++;
      p.unshift(el.tagName.toLowerCase()+':nth-of-type('+i+')'); el=el.parentElement; } return 'body > '+p.join(' > '); };
  const vis = el => { const r=el.getBoundingClientRect(); return r.width>40 && r.height>14 && getComputedStyle(el).visibility!=='hidden'; };
  const txt = el => (el.innerText||'').trim().replace(/\\s+/g,' ');
  const nextP = el => { let n=el.nextElementSibling; for(let k=0;n&&k<3;k++,n=n.nextElementSibling){
      const t=txt(n); if(n.tagName==='P' && t.length>20) return t; } return ''; };
  const meta = document.querySelector('meta[name=description]');
  const out = []; const h1 = document.querySelector('h1');
  if (h1 && vis(h1)) out.push({sel:path(h1), label:txt(h1), note:nextP(h1)||(meta?meta.content:''), kind:'h1'});
  [...document.querySelectorAll('h2, h3')].filter(vis).slice(0,5).forEach(h=>out.push({sel:path(h),label:txt(h),note:nextP(h),kind:'h2'}));
  [...document.querySelectorAll('button, a.btn, a.button, [role=button], input[type=submit]')].filter(vis).slice(0,1)
    .forEach(b=>out.push({sel:path(b),label:txt(b)||b.value||'Take action',note:'',kind:'cta'}));
  return {title:document.title, description: meta?meta.content:'', h1: h1?txt(h1):'', focus: out};
}"""

_SCROLL_JS = """async () => { const h=Math.min(document.documentElement.scrollHeight, %d);
  for (let y=0;y<h;y+=500){ window.scrollTo(0,y); await new Promise(r=>setTimeout(r,60)); }
  window.scrollTo(0,0); await new Promise(r=>setTimeout(r,250)); }""" % MAX_CSS_H


# Hi-dpi (2x) page screenshots: the `page` scene reads element rects in CSS pixels and `_png_size`
# divides the PNG dimensions by the same factor.
SCREENSHOT_SCALE = 2
SCREENSHOT_VIEWPORT_H = 900


def _open(browser, width):
    return browser.new_context(**context_options(width, SCREENSHOT_VIEWPORT_H, scale=SCREENSHOT_SCALE))


def _png_size(path) -> tuple[float, float]:
    px_w, px_h = struct.unpack(">II", Path(path).read_bytes()[16:24])
    return px_w / SCREENSHOT_SCALE, px_h / SCREENSHOT_SCALE


def inspect_pages(urls, *, width=1440) -> dict:
    from .capture import browser as shared_browser

    info = {}
    ctx = _open(shared_browser(), width)
    try:
        page = ctx.new_page()
        for url in urls:
            page.goto(url, wait_until="load")
            page.evaluate(_READY)
            info[url] = page.evaluate(_INSPECT_JS)
    finally:
        ctx.close()
    return info


async def shoot_pages_async(browser, jobs: dict, out_dir, *, width=1440) -> dict:
    """jobs = {url: [selectors]} -> {url: {file, w, h, title, rects{sel: box|None}}}.

    Uses the caller's browser (one context/page for every URL in the batch).
    """
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    result = {}
    ctx = await browser.new_context(**context_options(width, SCREENSHOT_VIEWPORT_H, scale=SCREENSHOT_SCALE))
    try:
        page = await ctx.new_page()
        for url, selectors in jobs.items():
            await page.goto(url, wait_until="load")
            await page.evaluate(_READY)
            await page.evaluate(_SCROLL_JS)  # triggers scroll-reveal content, then back to top
            await page.add_style_tag(content="*{animation:none!important;transition:none!important;caret-color:transparent!important}")
            height = min(int(await page.evaluate("document.documentElement.scrollHeight")), MAX_CSS_H)
            rects = {}
            for sel in selectors:
                try:
                    box = await page.locator(sel).first.bounding_box(timeout=2500)
                except Exception:  # noqa: BLE001 - a missing selector just means no focus ring
                    box = None
                rects[sel] = box if box and box["y"] + box["height"] <= height + 2 else None
            name = hashlib.sha1(url.encode()).hexdigest()[:10] + ".png"
            await page.screenshot(path=str(out / name), full_page=True,
                                  clip={"x": 0, "y": 0, "width": width, "height": height})
            px_w, px_h = _png_size(out / name)
            result[url] = {"file": name, "w": px_w, "h": px_h, "rects": rects, "title": await page.title()}
    finally:
        await ctx.close()
    return result
