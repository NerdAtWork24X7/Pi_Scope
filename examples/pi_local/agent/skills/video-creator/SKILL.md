---
name: video-creator
description: MANDATORY for any request to create, make or edit a video (explainer, promo, demo, walkthrough, social short, slideshow with voiceover). Turns a brief into a finished narrated MP4 in six steps — understand, write a creative script, synthesize one voice clip, plan shots (generated animated scenes + clearly-licensed assets), render frame-exact audio-synced clips, then merge into one video with burned captions, chapters and a player. One command (`scripts/vc`) does all rendering. Do NOT write your own ffmpeg/Playwright/TTS/storyboard code. No video-generation models or paid APIs.
---

# video-creator — narrated video in six steps

`<skill>` = absolute path of the folder containing this file. Run everything from the user's project root.
One tool does the work: `"<skill>/scripts/vc"` (bootstraps its venv on first use).

**Keep the working folder inside the project: `--work tmp/video` (relative paths resolve against the
current working directory). Never pass a system temp dir such as `/tmp/...` — it is wiped between runs
and the tool now refuses it; `<skill>/tmp` is the only other allowed home for scratch.**

The six steps map exactly to the user's request:

| Step | Who | Command / artifact |
|---|---|---|
| 1. Understand the request | you | read the ask; pick format, length, audience |
| 2. Write the creative script | you | `tmp/video/script.json` (beats, one idea per beat) |
| 3. Create the voice clip | tool | `vc voice` → `tmp/video/audio/voice.wav` + `beats.json` |
| 4. Plan the video clips | you | `tmp/video/plan.json` (shots); `vc fetch` for licensed assets |
| 5. Create synced clips | tool | `vc check` + `vc probe` then `vc clips` → one `.mov` per shot |
| 6. Merge into one video | tool | `vc merge` → `out/video.mp4` (+ captions, chapters, player, poster) |

**Never re-author the tool.** If a step errors, read the message, fix the cause (usually the script or plan JSON), re-run (max 2 retries), then report honestly.

---

## Step 1–2 · Understand, then write `tmp/video/script.json`

Decide format/length from the request: promo 20–45 s · short/reel 15–40 s (**9:16**) · explainer 60–120 s (16:9). Read `references/creative-playbook.md` before writing. Rules: hook in ≤ 3 s, one idea per sentence, ≤ 14 words each, no "Hello and welcome". Never invent stats, quotes or assets.

Write `tmp/video/script.json`:

```json
{
  "title": "Acme",
  "brief": { "goal": "Show how Acme saves 3 hours a week", "format": "16:9", "target_s": 45 },
  "voice": "Milo",
  "style": "warm, confident narrator, natural pace",
  "beats": [
    { "id": "b1", "say": "You lose three hours a week to this." },
    { "id": "b2", "say": "Acme gives them back." },
    { "id": "b3", "say": "Connect your tools in one click." },
    { "id": "b4", "say": "Try Acme today." }
  ]
}
```

Every beat needs a **unique `id`** and **non-empty `say`**. One beat = one sentence = one visual event. `voice`/`style` are optional (defaults: `Milo`, warm/confident).

## Step 3 · Voice clip

```bash
"<skill>/scripts/vc" voice --work tmp/video
```

Synthesizes each beat with MiMo-TTS "Milo" (cached by text+style, so re-runs are free), joins them with gaps, and writes `tmp/video/audio/voice.wav` plus `tmp/video/beats.json` — **the exact start/end of every beat**. Time is now the single source of truth; visuals conform to it, never the reverse.

- No TTS key? `--tts none` produces a silent placeholder with the *same real timings* and burned captions. `--tts auto` (default) falls back silently and warns.
- Voice too long/short vs `target_s`? Tighten or extend `script.json` and re-run `voice`.

## Step 4 · Plan the shots in `tmp/video/plan.json`

Read `tmp/video/beats.json` and write `plan.json`. **Every beat must appear in exactly one shot, in order** (shots are a partition of the beat list).

**Design the theme from the request — never fall back to one.** A colour theme is *not* a preset you pick: read the brief (mood, audience, brand) and give the video its own palette. `vc theme "<one-line brief>"` **designs** three bespoke, contrast-checked palettes (colour-theory accents, deterministic per brief) and prints ready-to-paste JSON; `draft`/`make` call it automatically from `--tagline/--description/--feature`/`--format`, and `--seed "#RRGGBB"` anchors the accent to a brand colour.

Put the palette object directly in `theme` (or keep a curated name as a fallback):

```json
"theme": { "bg": "#0C1217", "fg": "#F4F5F6", "accent": "#69D3CA", "card": "#19232C", "muted": "#64686C", "on": "#0B0F1A" }
```

Keys are `bg · fg · accent · card` plus derived `muted`/`on` (auto-filled if omitted). `check` **rejects** a malformed palette and one whose contrast is too low (fg/bg ≥ 4.5, accent/bg ≥ 3, on/accent ≥ 3) — never ship unreadable text. Curated fallbacks (use only when the brief has no signal, or `--theme NAME` to force one): `midnight-lime` (techy/dev, punchy) · `paper-ink` (editorial/docs, warm) · `ocean-glass` (calm, finance/health/security) · `sunset-pop` (playful, social/music/food) · `slate-sky` (clean product/SaaS, tutorial) · `ember-noir` (premium, cinematic, launch).

Each shot has a `source`:

```json
{
  "theme": { "bg": "#0C1217", "fg": "#F4F5F6", "accent": "#69D3CA", "card": "#19232C", "muted": "#64686C", "on": "#0B0F1A" },
  "format": "16:9",
  "shots": [
    { "id": "s1", "beats": ["b1"], "source": "create", "type": "hook", "text": "*three hours* a week" },
    { "id": "s2", "beats": ["b2"], "source": "create", "type": "steps",
      "title": "How it works", "items": [{ "title": "Connect", "desc": "One click" }, { "title": "Automate", "desc": "Set and forget" }] },
    { "id": "s3", "beats": ["b3", "b4"], "source": "create", "type": "outro", "text": "Try Acme", "sub": "acme.dev", "button": "Get started" }
  ]
}
```

**`create` — generated animated scene** (`type` = one of):

| type | fields | use |
|---|---|---|
| `hook` | `text` (wrap words in `*stars*` for accent), `sub?` | opening claim/number |
| `stat` | `value` (int counts up), `prefix?`, `suffix?`, `label` | one number, big |
| `steps` | `title?`, `items`: list of `{title, desc?}` or strings | ordered points |
| `compare` | `before`, `after`, `before_label?`, `after_label?` | before/after split |
| `page` | `src` (HTML path/URL), `focus`: `[{sel, label}]` | static full-page image + camera moves (fallback) |
| `outro` | `text`, `sub?`, `button?` | single CTA, echoes the hook |

**`browse` — drive and capture a REAL browser session.** The page is actually navigated/used and captured **frame-exact into the clip** (frame *i* == shot time *i*/*fps*), so it is always in sync with the narration — unlike a screen recording, whose timestamps can drift. Prefer this over the static `page` type for demos and walkthroughs:

```json
{ "source": "browse", "url": "http://localhost:3000",
  "actions": [
    { "at": 0,                                    "type": "goto" },
    { "on_beat": "b3",                 "offset": 900, "type": "type",      "sel": "#q", "text": "acme" },
    { "on_beat": "b4",                                "type": "click",     "sel": "[data-testid=go]" },
    { "on_beat": "b4",                 "offset": 400, "type": "highlight", "sel": "#out" } ] }
```

Time an action **symbolically**: `on_beat` = the beat's start relative to the shot, `offset` = extra ms. A shot's first beat maps to offset 0, so the first real interaction must be ≥ 800 ms (`check` rejects interaction before then, since `goto`/setup would still be running). Action types: `goto · click · type · press · hover · scroll` (`sel` or `dy`) `· wait · highlight · js`. Every selector uses Playwright's engine (`:has-text()`, `:visible` work in `wait`/`click`/`highlight`/`scroll`). `wait` defaults to `visible`; add `"state":"attached"` for an element inside a collapsed panel. A synthetic cursor makes clicks/typing legible.

**Freshness (biggest gotcha):** each `browse` shot runs in a **fresh browser context** — `localStorage`, cookies, theme and auth do **not** carry over between shots. Re-establish state in *every* shot with a `js` action at the start, or pass it in the URL (e.g. `"?theme=dark&token=${SCOPE_TOKEN}"`, with env interpolation — see below).

`at` = ms from the shot start (align it with the beats; actions land on that exact frame). `vc draft`/`vc make` generate `browse` shots automatically for web projects (goto → scroll → highlight each section).

**`asset` — licensed image/video you supply**: `{ "source": "asset", "asset": "tmp/video/assets/clip.mp4", "start": 0.0 }`. Images get a slow Ken-Burns zoom; videos loop from `start`.

**`find` — placeholder you must resolve.** Download only clearly-licensed media, which attaches it to the shot and logs the credit:

```bash
"<skill>/scripts/vc" fetch --work tmp/video --url "$URL" --license "CC0" --credit "Author / Source" --shot s4
```

Pacing: a new visual event every ≤ 3 s, vary scene types, ≤ 4 beats per shot, keep the hook first and the outro last. `vc check` warns when it sees 3 shots of the same type in a row, a shot > 8 s, or a missing hook/outro.

## Step 5 · Check, then render clips

```bash
"<skill>/scripts/vc" check --work tmp/video      # prints the shot table + chosen theme; fix every ERROR first
"<skill>/scripts/vc" probe --work tmp/video      # dry-run browse actions (~5 s, no frames): fix missing/hidden/blocked
"<skill>/scripts/vc" clips --work tmp/video      # one frame-exact, audio-synced .mov per shot
```

`probe` replays each `browse` shot's actions on the clip clock and reports `ok / missing / hidden / blocked` per action plus wall time — do this before `clips` so a bad selector costs 5 s, not a failed render. `--only s5,s13` limits it; `--fast` skips the waits.

`clips` renders each shot with its **exact slice of the voice** (frame count = audio seconds × fps), so clips concatenate with zero drift. Unchanged shots are skipped — a shot re-renders when its definition, its asset, or a **local** page it points at changes (a remote url needs `--force`); re-render only what changed with `--only s2,s4`. Use `--draft` (still 1080p, 15 fps) for a fast preview, `--workers N` to parallelize (the default scales with the CPUs *and* free RAM available, so a small container will not be over-subscribed).

## Step 6 · Merge into one video

```bash
"<skill>/scripts/vc" merge --work tmp/video --out out/video.mp4
```

Concatenates the clips (drift-free, AAC encoded once), burns captions timed to the real beats, adds chapters + an interactive chapter player, grabs a poster, and runs `verify`. Deliverables: `out/video.mp4`, `out/index.html`, `out/poster.png`, `tmp/video/sheet.png`, `tmp/video/captions.srt`, `tmp/video/chapters.txt` (+ `out/CREDITS.txt` when assets were fetched).

---

## Express path (web projects & briefs)

For a project that already has HTML pages, or a one-shot brief, `make` runs steps 2–6 for you and writes a **starting** script + plan you can improve:

```bash
# existing site
"<skill>/scripts/vc" make --project . --name "Acme"
# from a brief (no pages): scaffolds a showcase site first
"<skill>/scripts/vc" make --name "Acme" --tagline "Win your week back" \
  --feature "Fast:Why it's fast." --feature "Simple:Why it's simple." --cta "Try Acme" --url acme.dev
```

Add `--draft` for speed, `--regen` to redraft, `--format 9:16` for a vertical cut. A bespoke theme is **designed** from the brief (override with `--theme NAME`, or anchor it to a brand colour with `--seed "#RRGGBB"`). Then edit `say` lines / add shots and re-run `make` (audio is cached).

### Driving an existing local app

Point `make` at a running instance instead of scaffolding a site. `${VAR}` in a url is resolved from the environment at render time (so `check` fails early on an unset var, and secrets never land in `plan.json`):

```bash
export SCOPE_URL="http://127.0.0.1:4178"
export SCOPE_TOKEN="$(cat .demo-token)"
"<skill>/scripts/vc" make --project . --page "${SCOPE_URL}/?token=${SCOPE_TOKEN}" --name "Acme"
```

Run an **isolated instance** so the demo can't touch real data: separate port, pinned token, copied DB/config — e.g. `PORT=4178 DATABASE_URL=file:tmp/demo.db pnpm start` (or `docker compose -f demo.yml up`). Re-establish per-shot state (theme/cwd/auth) with a `js` action, since each `browse` shot gets a fresh context; tear the instance down when done.

> `tmp/video/plan.json` can contain a live auth token or url. Never commit or share `tmp/video/`; prefer `${SCOPE_TOKEN}` interpolation.

## Commands

`next` (what to do next — run whenever unsure) · `draft` · `voice` · `check` · `probe [--only ids] [--fast]` · `clips` · `merge` · `fetch` · `make` · `theme ["brief"] [--seed HEX] [--variants N] [--json]` · `doctor` · `verify --file F [--expected S]` · `sheet --file F --out P` · `frames` · `record` · `tts-api` · `tts-browser` · `tts-save` · `normalize` · `assemble`.
Common flags: `--work tmp/video` (working folder — always inside the project, never `/tmp`), `--draft` (1080p at 15 fps). Formats `16:9` / `9:16`. `theme` designs a bespoke palette from a brief; `--theme NAME` forces one of the curated fallbacks listed in step 4.

## Rules

1. Run the tool; don't write wrappers, storyboards or scene HTML yourself.
2. Never print secrets; never use video-generation models/APIs; never invent facts or assets.
3. Use only clearly-licensed media (pass `--license`), and keep credits.
4. Check exit codes. Run `vc probe` before `vc clips` for `browse` shots. `verify` warnings name the shot and time and say whether the region looks blank or rendered; `"ok": false` is a failure.
5. Finish by glancing at `tmp/video/sheet.png`, then report absolute paths, duration, resolution, theme, and narration status (real vs silent).
6. Never commit or share `tmp/video/` (`plan.json` can hold a live token/url); use `${VAR}` interpolation for secrets.
7. If the toolchain itself breaks (import errors, a core dump mid-render), run `vc doctor`: it names the broken piece and prints the exact reinstall command. Never hand-patch the venv.

## Reference
- [references/creative-playbook.md](references/creative-playbook.md) — hooks, pacing, motion, sound, QA checklist.
- [references/manual-pipeline.md](references/manual-pipeline.md) — JSON schemas, command details, failure handling.
- [references/mimo-tts.md](references/mimo-tts.md) — voices, MiMo-TTS API, browser fallback.
