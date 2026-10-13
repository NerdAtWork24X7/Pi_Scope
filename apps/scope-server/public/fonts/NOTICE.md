# Vendored fonts

| File | Family | Used by |
|---|---|---|
| `ClashGrotesk-Variable.woff2` | [Clash Grotesk](https://www.fontshare.com/fonts/clash-grotesk) | `mobile.css` — every display/headline/label face (`--font-display`) |
| `Satoshi-Variable.woff2` | [Satoshi](https://www.fontshare.com/fonts/satoshi) | `mobile.css` — body/prose (`--font-body`) |
| `MesloLGSNerdFontMono-*.ttf` | MesloLGS Nerd Font Mono | `styles.css` — the desktop Terminal view |
| `NotoColorEmoji.ttf` | Noto Color Emoji | emoji fallback appended to every stack |

Both fontshare families are distributed by the Indian Type Foundry under the
**ITF Free Font License (FFL)**, which permits self-hosting and web embedding.
The full terms are in [`ITF-FFL.txt`](./ITF-FFL.txt); the files here are the
unmodified "WEB/fonts" variable `woff2` weights from the official
`https://api.fontshare.com/v2/fonts/download/<family>` packages.

They are self-hosted (not linked from Fontshare's CDN) on purpose: Pi Scope is a
local-first server that phones reach over a LAN that may have no internet route,
so the mobile layout must not depend on a third-party font host.

Only the mobile layout loads them; the desktop bundle is untouched.
