# Creative playbook

Read once before storyboarding. Goal: a video people finish.

## 1. Retention rules

1. **Hook in ≤ 3 s.** Open on the payoff, the problem, or a surprising number. No intro, no logo.
2. **Visual event every ≤ 3 s**, pattern interrupt every ≤ 8 s (zoom, colour flip, layout change, sfx hit).
3. **One idea per scene, one verb per beat.** If you need "and", split it.
4. **Show, don't read.** On-screen text is ≤ 7 words per beat and *not* a transcript of the voice. Voice adds the why; screen shows the what.
5. **Open loops.** Tease something early ("…and the third one surprised me") and pay it off later.
6. **Loop the ending** back to the opening frame/colour; end with exactly one CTA.
7. **Silence is a tool.** 180 ms between beats, 600 ms tail per scene; a 400 ms hold before the key line.
8. **Length:** promo 20–45 s, short 15–40 s, explainer 60–120 s. Cut anything that is not the promise.

## 2. Script for the ear

- ≈150 wpm, sentences ≤ 14 words, contractions, second person ("you").
- Numbers as spoken ("three hours", not "3h") in narration; digits on screen.
- Forbidden openers: "Hello and welcome", "In this video", "Today we'll".
- Read it aloud (or synthesize) — rewrite anything that stumbles.

**MiMo-TTS style direction** (the `--style` text; one short phrase):
`warm, confident narrator, natural pace` (default) · `punchy, energetic, slightly faster` (promo) · `calm, reassuring, slower` (tutorial) · `curious, conversational` (explainer) · `urgent, low and serious` (problem/stakes beat).
Inline cues like `(pause)` or `[emphasis]` are model-specific; test one line before using them in bulk.

## 3. Look & feel — design the palette for the request

**Colour is a design decision, not a preset.** Read the brief's mood, audience and brand, then create a palette for *this* video: `vc theme "<brief>"` **designs** three bespoke options (colour-theory accents, deterministic per brief, contrast-checked) and prints JSON to drop into `plan.json`; add `--seed "#RRGGBB"` to anchor the accent to a brand colour. Two videos about different subjects should not share a palette.

Discipline: exactly **one accent colour**; choose a dark *or* light canvas (never both); keep `fg/bg ≥ 4.5` and `accent/bg ≥ 3` (`check` rejects worse); tint the background and hairlines with the accent's hue so the whole frame feels intentional.

Curated **fallbacks** — use only when the brief carries no signal, or `--theme NAME` to force one:

| Preset | Background | Text | Accent | Feel |
|---|---|---|---|---|
| `midnight-lime` | `#0B0F1A` | `#F3F5F9` | `#B6FF3B` | techy, punchy |
| `paper-ink` | `#F6F1E7` | `#1B1B1F` | `#E4572E` | editorial, warm |
| `ocean-glass` | `#06202B` | `#E8F6FA` | `#35D0BA` | calm, trustworthy |
| `sunset-pop` | `#1A1033` | `#FFF4EC` | `#FF6B6B` | playful, social |
| `slate-sky` | `#F4F7FB` | `#0F1B2D` | `#2F6FED` | clean product, SaaS |
| `ember-noir` | `#120D0A` | `#F6EFE6` | `#E9A23B` | premium, cinematic |

Type: one family (system stack `Inter, "Segoe UI", system-ui, sans-serif`), three sizes only — display 140–200 px, body 56–72 px, caption 36–44 px; weights 800 / 500. Spacing scale 8·16·32·64·96 px.
Add depth cheaply: soft radial gradient, 6–12 % noise overlay (inline SVG filter), large blurred accent blob drifting slowly (keyframes), 24 px rounded cards with a subtle shadow.

## 4. Motion vocabulary (all CSS keyframes / WAAPI — seekable)

- **Entrances:** 450 ms, `cubic-bezier(.2,.8,.2,1)`, translateY(24px)+opacity; stagger children 80 ms.
- **Emphasis:** scale 1→1.06→1 (300 ms), highlight bar wipe behind a word, underline draw.
- **Number count-up:** animate a CSS `@property --n` integer and render via `counter()`; seekable and deterministic.
- **Kinetic type:** split words into spans with incrementing `animation-delay` matching the beat offsets in `beats.json`.
- **Camera feel:** slow 1.00→1.06 scale + 8 px pan across the whole scene (ken-burns) so no frame is ever fully static.
- **Cuts:** hard cut on the first syllable of the next beat; use `fade` ≤ 0.4 s only to signal time passing or a mood change.
- Avoid: bounce/elastic easing everywhere, spinning, > 2 simultaneous moving things, text moving while being read.

## 5. Scene archetypes (start from these)

1. **kinetic-claim** — huge statement or number, words/digits animate on beats. Best hook.
2. **problem-glitch** — the pain shown literally (messy list, red counters, shaking card) before the fix.
3. **ui-walkthrough** — a `browse` shot: the real page is navigated (goto → type → click → scroll → highlight) and captured **frame-exact** with a synthetic cursor, so the clip is always in sync with the narration. (Static `page` shots are the fallback.)
4. **before/after split** — vertical divider wipes to reveal the improved side.
5. **stat-reveal** — one number, count-up, one-line context, tiny source label (real sources only).
6. **steps-stack** — 3 cards enter in sequence, current one highlighted, others dimmed to 40 %.
7. **diagram-build** — inline SVG nodes/arrows draw in with `stroke-dashoffset` in narration order.
8. **code-typewriter** — monospaced block typing via `steps()` width animation, highlighted line on the beat.
9. **quote/testimonial** — only with user-supplied text.
10. **outro-loop** — echoes hook visual, single CTA button, URL/handle large and readable.

Each scene file: canvas div, `<style>` tokens at top (`--bg --fg --accent`), markup, keyframes, `window.__ready`.

## 6. Captions (most viewers are muted)

Burn in for shorts/social. Max 2 lines, ≤ 42 chars/line, white bold with 2 px outline, bottom 18 % safe zone, never over the key visual. `vc merge` already times one cue per beat from `beats.json` and splits long beats at ~7 words, so captions land on the real voice.

## 7. Sound design (optional, local only)

- Voice is king: −16 LUFS; music bed (licensed, user-provided) at gain ≈ 0.10–0.14, ducked under speech.
- Synthesize tiny sfx with FFmpeg `lavfi` (no licensing): whoosh = `anoisesrc=d=0.35:c=pink,lowpass=f=1800,afade=t=in:d=0.05,afade=t=out:st=0.2:d=0.15`; tick = 40 ms sine burst `sine=f=1400:d=0.04`. Place on pattern interrupts only, at −24 dB. Never sfx on every beat.

## 8. Format variants

- **9:16 cut:** same script, `1080x1920`, stack layouts vertically, text ≥ 64 px, captions burned in mid-lower third, ≤ 40 s.
- **Poster/thumbnail:** best hook frame from `sheet`, big claim ≤ 5 words, accent colour pop.

## 9. QA scorecard (all must be yes)

- [ ] First 3 s state a claim, problem or number — no title card
- [ ] A visual event at least every 3 s; no static stretch > 4 s (`verify` warns)
- [ ] Each beat's visual lands on its first syllable (±150 ms)
- [ ] On-screen text ≤ 7 words/beat, readable at phone size (≥ 36 px caption)
- [ ] One accent colour, ≤ 3 type sizes, no clipped/overlapping text on the contact sheet
- [ ] Audio even across scenes, no clipping, no dead air > 1 s
- [ ] Single clear CTA in the last scene; ending echoes the hook
- [ ] `verify` → `"ok": true`; duration matches plan; resolution correct

## 10. Anti-patterns

Title-card intros · reading the screen aloud · more than 3 points per video · stock "corporate" gradient with no motion · different fonts/colours per scene · fade between every scene · invented statistics · music louder than −20 LUFS under speech.
