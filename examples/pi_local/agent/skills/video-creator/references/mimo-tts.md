# MiMo-TTS reference (voice "Milo")

Xiaomi's **MiMo-V2.5-TTS** family. Speech synthesis only — it is not a video model,
so it does not violate the "no video-generation models/APIs" rule.

## Models

| Model ID | Use | Notes |
|---|---|---|
| `mimo-v2.5-tts` | built-in premium voices (incl. **Milo**) | style via natural-language `user` message; inline `(tag)` / `[tag]` control |
| `mimo-v2.5-tts-voicedesign` | design a new voice from a text description | no preset voice field |
| `mimo-v2.5-tts-voiceclone` | clone a voice from a reference clip | voice = `data:audio/mpeg;base64,<...>` |

## Built-in voice IDs

`mimo_default`, `冰糖`, `茉莉`, `苏打`, `白桦`, `Mia`, `Chloe`, **`Milo`**, `Dean`.

`Milo` — English, male. This skill defaults to it.

## API (Xiaomi token plan — used automatically)

The skill resolves credentials with no configuration: `MIMO_API_KEY` / `XIAOMI_API_KEY`
env vars first, then the Xiaomi token-plan key in `~/.pi/agent/auth.json`
(provider `xiaomi-token-plan-ams`). `MIMO_BASE_URL` overrides the endpoint.

| Key source | Base URL |
|---|---|
| `xiaomi-token-plan-ams` (auth.json) | `https://token-plan-ams.xiaomimimo.com/v1` |
| `MIMO_API_KEY` env | `https://api.xiaomimimo.com/v1` |

Both expose `mimo-v2.5-tts` with the built-in **Milo** voice (verified: 200 OK,
24 kHz mono PCM16 WAV). OpenAI-compatible chat completions; style/instruction goes
in the `user` message, the text to speak in the `assistant` message, and
`audio: {"format": "wav", "voice": "Milo"}` selects the output. The audio is base64
in `choices[0].message.audio.data`.

```bash
.venv/bin/python scripts/video.py doctor     # prints the resolved key source + base URL
.venv/bin/python scripts/video.py tts-api \
  --text "Welcome to the walkthrough." \
  --style "warm, confident narrator, medium pace" \
  --voice Milo --out audio/scene-01.wav
```

## Browser path (optional, Playwright)

When you prefer to drive the TTS web UI itself (or have no API key), the skill does
it with **Playwright directly** — no pi `browser` tool and no system-audio capture:

```bash
# auto: open the page, type the text, submit, and save the generated audio
.venv/bin/python scripts/video.py tts-browser \
  --url "https://aistudio.xiaomimimo.com/" \
  --text "Welcome to the walkthrough." \
  --out audio/scene-01.wav

# manual: open a headed window, generate the clip yourself, it is saved on capture
.venv/bin/python scripts/video.py tts-browser --url "https://aistudio.xiaomimimo.com/" \
  --manual --out audio/scene-01.wav
```

It captures the audio from the **network response** (content-type `audio/*`) or the
page's `blob:`/`data:` `<audio>` URL, then writes WAV (mp3/m4a/ogg are transcoded with
the bundled ffmpeg). If the UI's box/button aren't found automatically, pass
`--input-selector` / `--submit-selector`; `--timeout` (default 120 s) covers slow
generations and `--headed` shows the window. `--manual` keeps it open for you to drive.
If the page is unreachable in your region, use the API instead.

For a payload extracted some other way, `tts-save` still wraps base64/PCM16:

```bash
.venv/bin/python scripts/video.py tts-save --b64-file audio/scene-01.b64 --out audio/scene-01.wav
```

## Reachability notes

- `token-plan-ams.xiaomimimo.com` — reachable with the Xiaomi token-plan key; serves `mimo-v2.5-tts`.
- `api.xiaomimimo.com` — reachable (returns HTTP 401 without a key).
- `platform.xiaomimimo.com`, `mimo.mi.com` — reachable (console requires login).
- `aistudio.xiaomimimo.com` (MiMo Studio) — **connection-refused on some hosts/regions**.
  Preflight it before relying on the browser path; otherwise use the API.

## Captions

Narration is authored text, so captions need no speech recognition: `vc merge` builds them from
`beats.json` (the measured beat timings), one cue per beat, split at ~7 words, then burns them in.
For *word*-level timing, install the optional `faster-whisper` extra and transcribe the narration
WAV locally — no API key.
