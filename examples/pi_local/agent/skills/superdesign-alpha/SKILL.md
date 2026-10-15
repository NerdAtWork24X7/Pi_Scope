---
name: superdesign-alpha
description: Near-black engineering-console aesthetic with a rationed amber accent, hairline grid texture, and a mono-adjacent geometric sans carrying every headline.
---

colors:
  background: "#0A0A0A"
  surface: "#121212"
  surface-alt: "#141414"
  text-primary: "#FFFFFF"
  text-secondary: "#71717A"
  text-tertiary: "#A1A1AA"
  text-muted: "#52525B"
  accent: "#F5C400"
  accent-alt: "#FF5A3C"
  danger: "#DC2626"
  success: "#10B981"
  border-subtle: "#2A2A2A"
  border-hairline: "rgba(255, 255, 255, 0.1)"
typography:
  display-lg:
    fontFamily: "Clash Grotesk"
    fontSize: "62px"
    fontWeight: 600
    lineHeight: "1"
    letterSpacing: "-1.5px"
  headline-md:
    fontFamily: "Clash Grotesk"
    fontSize: "44px"
    fontWeight: 600
    lineHeight: "0.91"
    letterSpacing: "-1.1px"
  body-md:
    fontFamily: "Satoshi"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: "1.63"
  label-md:
    fontFamily: "Clash Grotesk"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: "1.56"
    letterSpacing: "-0.4px"
  body-sm:
    fontFamily: "Satoshi"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "1.5"
  accent-mono:
    fontFamily: "monospace"
    fontSize: "14px"
    fontWeight: 400
    note: "terminal/console readout face used in the interactive demo panel"
spacing:
  base: "8px"
  scale: "0px, 4px, 8px, 10px, 12px, 16px"
  gap: "20px"
  section-padding: "112px"
  section-gap: "174px"
  content-max-width: "174px"
rounded:
  sharp: "2px"
  control: "6px"
  button: "8px"
  card: "12px"
  panel: "16px"
  pill: "9999px"
components:
  navbar:
    background: "#0A0A0A"
    width: "edge-to-edge, 100vw"
    height: "57px"
    radius: "0px 0px 0px 0px"
    position: "sticky"
    item-count: 6
  button-nav-cta:
    background: "#DC2626"
    text-color: "#FFFFFF"
    radius: "6px"
    height: "23px"
  button-primary:
    background: "#F5C400"
    text-color: "#000000"
    radius: "8px"
    height: "34px"
    padding: "8px 14px"
    shadow: "rgba(245, 196, 0, 0.25) 0px 0px 24px 0px"
  button-secondary-outline:
    background: "transparent"
    text-color: "#A1A1AA"
    radius: "8px"
    height: "34px"
    padding: "8px 14px"
    border: "1px solid rgba(255, 255, 255, 0.1)"
    hover-text-color: "#FFFFFF"
  panel-console:
    background: "#121212"
    radius: "12px"
    border: "1px solid rgba(255, 255, 255, 0.06)"
    shadow: "rgba(255, 255, 255, 0.06) 0px 0px 0px 1px, rgba(0, 0, 0, 0.55) 0px 24px 64px 0px"
  card-feature:
    background: "#121212"
    radius: "12px"
    border: "1px solid #2A2A2A"
    shadow: "rgba(255, 255, 255, 0.04) 0px 0px 0px 1px, rgba(0, 0, 0, 0.45) 0px 8px 32px 0px"
  card-fullwidth-band:
    background: "transparent"
    radius: "0px"
    padding: "112px 0px"

# Amber Terminal Noir
Source: https://p.superdesign.dev/draft/40365986-224a-4957-8a6c-fe73a38e0f65

## Overview
A dark-mode-default, engineering-tool aesthetic: near-black surfaces, a hairline dot/line grid texture underlying every section, and a single rationed amber accent standing in for "signal" against a field that is otherwise grayscale. Typography is the dominant carrier of personality — a tight, high-contrast geometric display face (Clash Grotesk) at negative tracking for headlines, paired with a workmanlike humanist sans (Satoshi) for body copy — plus a terminal/console mono treatment inside a simulated CLI window. The overall register reads as Swiss-adjacent technical minimalism crossed with a synthetic-terminal motif: sharp rectangles, thin borders, faux window chrome (traffic-light dots), and status readouts in place of illustration.

## Composition
The first screen is a centered, single-column hero: an oversized two-tone headline (white plus one amber-highlighted word run), a constrained body paragraph, a row of four small stat labels, then a wide pipeline-diagram panel with ten sequential numbered stages — this diagram is the hero's real visual anchor, not an image. Below the fold, the rhythm alternates between wide interactive console mockups (bordered dark panels with traffic-light chrome) and full-bleed text bands with a small eyebrow tag, a two-line headline, and a supporting paragraph — repeated three times as distinct thematic movements ("problem," "alternative/introducing," "built for"). A 2x5 icon-tile feature grid follows, then a pricing band, an FAQ accordion, and a closing CTA band with a warm amber-to-black gradient wash. Section gaps are large and constant (174px), giving the page a slow, deliberate scroll cadence rather than a dense one. The deliberate choice: text-led, diagram-led storytelling over photographic/illustrative hero imagery — this rejects a marketing-glossy product-screenshot hero in favor of a diagrammatic, almost technical-documentation feel.

## Colors
Background is overwhelmingly near-black: `#0A0A0A` dominates at roughly 82% of declared area and the pixel field confirms a ~75-96% black-on-black composition (`#000000`/`#181818` combined ~96%). Card and panel surfaces step up only slightly to `#121212`/`#141414`, a barely-perceptible elevation shift rather than a lightness jump. `#F5C400` (amber) is the singular accent — it's rationed to a highlighted headline word, a handful of icon glyphs, one CTA button, toggle switches, and a soft radial glow behind the console panel; it never fills a background. `#FF5A3C` (a coral/orange-red) appears only as accent bracketing/decorative dashed rules and an eyebrow tag border in the "problem" section, giving that band a distinct warning-adjacent tone versus the amber sections. `#DC2626` marks a single small danger-red nav CTA. `#10B981` is reserved for a success/status indicator. Text runs `#FFFFFF` primary, `#71717A` secondary/muted body, `#A1A1AA` tertiary labels — a strict three-step grayscale hierarchy with zero color in body copy. Borders are hairline `#2A2A2A` or `rgba(255,255,255,0.1)`, nearly invisible until zoomed.

## Typography
Clash Grotesk carries every headline at large sizes with aggressive negative letter-spacing (-1.5px at 62px, -1.1px at 44px) and near-1 line-height, producing dense, stacked, poster-like headline blocks. Satoshi handles all body and paragraph text at 14-15px, regular weight, generously leaded (1.63) for legibility against the dark field. Labels/eyebrows use small-caps-style uppercase tracking in Clash Grotesk at 18px/600. A monospace face appears only inside the terminal-window components (stage names, command-line prompts, status readouts), functioning as the system's signature accent face — it signals "engineering console" the instant it appears and should never be used for prose.

## Layout
Content is capped at a 1100px max-width, centered, with 112px section padding and a full 174px gap between major sections — a spacious, single-track editorial rhythm rather than a busy multi-column layout. The pipeline-stage diagram is a horizontal scrolling rail of ten equal compact nodes. The icon-feature grid is a clean 2-row uniform card grid: row one [5 equal] / row two [5 equal] (a 5-up bento-adjacent but actually uniform grid, each tile identical width). The "problem" section uses a 12-column asymmetric split: one narrow visual column (roughly 33%) beside a wider two-column text list (roughly 67%), itself internally divided into a 2x2 table-like grid of labeled problem statements. A separate 3-column, 20px-gap row groups three equal explainer panels (32/32/32) side-by-side. Pricing uses a 3-column asymmetric grid (23/49/23) with the center tier visually elevated. All grids are zero-radius, zero-fill "ghost" containers — visual structure comes from typography and hairline dividers, not card chrome.

## Components
- **Navbar**: edge-to-edge square bar spanning full 1920px viewport width, 0px left/right inset, 57px tall, zero corner radius on all four corners (flush rectangle), sticky on scroll, fill `#0A0A0A`. Contains 6 items: wordmark (with amber-accented single letter/word), a small descriptor label, then right-aligned status dot, icon utilities, and a compact CTA. Its CTA is a small danger-red pill: `#DC2626` fill, `#FFFFFF` text, 6px radius, 23px height — a low-emphasis nav-scoped button, not the hero primary.
- **Hero primary button**: the solid amber pill/rectangle beneath the headline reading as the page's true call-to-action — observed near-amber solid fill matching `#F5C400` family, dark/black text, approximately 8-10px corner radius, sitting directly under the stat row. Treat this as the primary CTA token even though the richest measured button cluster sits lower on the page.
- **Button — primary (measured)**: `#F5C400` fill, `#000000` text, 8px radius (slightly-rounded), 34px height, 8px/14px padding, amber glow shadow `rgba(245, 196, 0, 0.25) 0px 0px 24px 0px`. Appears beside the console demo panel and again at the closing CTA band.
- **Button — secondary outline**: transparent fill, `#A1A1AA` text lightening to `#FFFFFF` on hover, 8px radius, 34px height, 8px/14px padding, hairline border `1px solid rgba(255,255,255,0.1)`. Used as a paired "see demo/local mode" companion beside every primary button.
- **Console/terminal panel**: dark `#121212`-family surface, 12px radius, hairline border, deep ambient shadow `rgba(255,255,255,0.06) 0px 0px 0px 1px, rgba(0,0,0,0.55) 0px 24px 64px 0px`. Faux window chrome: three traffic-light dots top-left, a centered path/status label, a status dot top-right. Interior top-to-bottom: command prompt line, oversized wordmark, scanning/status log lines in mono type with green "OK" and red "OFF" status words, then a live input prompt with cursor. Appears twice — once as an interactive form/config panel in the hero, once as a pure narrative demo mid-page.
- **Pipeline stage rail**: 10 compact equal nodes in a horizontal row, each a small bordered chip with icon + numeral + label, three connector-dot legend keys above (computer/processing/review), 2-3 nodes tinted amber-active and one violet-active to indicate current stage.
- **Feature icon-tile grid**: 2 rows × 5 columns, uniform cards, `#121212`-toned fill, 12px radius, hairline border. Each tile: small amber square icon-glyph top, bold white heading label, one-line muted-gray description below — no numerals, no CTA, no chips.
- **Problem/explainer band**: full-width zero-radius zero-fill text panel, 112px vertical padding, asymmetric two-column split — a circular radar/target graphic (concentric rings, single red center dot) on the left third, a 2×2 grid of numbered problem statements on the right two-thirds; each cell: small coral eyebrow + three-digit numeral, bold white sub-heading, muted-gray body paragraph.
- **Pricing table**: 3-column grid at 23/49/23 proportions, center tier wider and visually promoted with a small "POPULAR" pill tag and brighter border/glow; each column a bordered card containing a tier label, price, and (below the visible crop) a feature checklist.
- **FAQ accordion**: full-width stacked rows, `#121212` fill panels, plus/expand glyph right-aligned, zero-radius-adjacent hairline dividers between entries.
- **Closing CTA band**: full-bleed section with amber-to-black radial wash background, centered two-line headline, single supporting paragraph, primary amber button + secondary outline button pair.
- **Footer**: `#080808` fill, wordmark + tagline left, three link columns (Product/Company/Legal) totaling 15 links, copyright line and social icon row at the base — zero radius, flush full-width band.

## Graphics & Effects
A subtle 1px hairline grid texture recurs across multiple sections as the page's signature texture layer: `linear-gradient(rgba(255,255,255,0.02) 1px, rgba(0,0,0,0) 1px)` paired with its 90°-rotated twin, and a second slightly-brighter pair at `0.03` alpha — together forming a faint graph-paper/blueprint grid over roughly 10-19% of total page area, concentrated behind the console panels and stat rows, never a full-bleed background. A radial amber wash `radial-gradient(60% 40% at 50% 0%, rgba(245,196,0,0.07), rgba(0,0,0,0) 70%)` sits behind the hero panel only, covering roughly the top-center 60%×40% zone — a rationed glow, not a page-wide gradient. The primary button carries a matching amber glow shadow (`0 0 24px` at 0.25 alpha) as its signature elevation cue. Panels use a two-layer shadow language: a 1px hairline "ring" shadow simulating a border, plus a large soft drop shadow (`0 24px 64px` at 0.55/0.45 alpha) for float/elevation. Dashed coral rule fragments act as decorative separators flanking eyebrow tags in the "introducing" section — an irregular Morse-code-like ornament, not a solid line.

## Motion
Entrances and layout shifts use a slow, eased cubic-bezier(0.22, 1, 0.36, 1) over 700ms for opacity/transform — a gentle, confident settle rather than a bounce. Color and border transitions (hover states on links, buttons, borders) run fast at 150ms with a standard cubic-bezier(0.4, 0, 0.2, 1) ease. General interactive state changes (toggles, panel expands) use 200-300ms on the same standard ease. A `pulse` keyframe animates the small status dots (nav GPU indicator, console readiness dot) for a steady breathing-alive signal. Overall motion character: unhurried macro-transitions, snappy micro-feedback — nothing springs or overshoots.

## Guardrails
- Never fill the hero or any full section background with the amber radial gradient — it is a small top-center glow behind one panel only.
- Never round the navbar corners or inset its width — it is a flush, square, edge-to-edge 57px bar.
- Never substitute the nav's red glass-adjacent CTA values for the hero's primary amber button — they are different components with different roles.
- Keep all grid/card containers zero-radius and zero-fill where specified; do not invent card chrome around text-only bands.
- Preserve the strict three-step grayscale text hierarchy (`#FFFFFF` / `#71717A` / `#A1A1AA`) — do not introduce additional text colors outside the amber/coral/red accent set.
- Keep the hairline grid texture faint (2-3% alpha) and confined to panel backdrops — it must never read as a bold visible grid line.
