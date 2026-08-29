# AGENTS.md — Pi Scope (repo map for AI agents)

> Read this first if you are an AI agent working in or fetching this repository. It is a
> concise, factual map of what this project is, how it is laid out, how to run/build it,
> and the gotchas that have caused real bugs. Prefer the descriptions here; verify against
> the linked files before editing.

## What this project is

**Pi Scope** is a local-first observability dashboard for AI coding agents. A Node server
(`apps/scope/server.ts`, Node 24+ using built-in `node:sqlite` + `node:http`) ingests
agent events and serves a browser WebUI (`apps/scope/public/*`). A `pi` agent extension
(`extension/pi-scope.ts`) streams telemetry to the server. A self-contained Linux AppImage
is produced by `build-release.sh` (Electron + bundled portable Node 24).

Upstream/base: fork of `disler/pi-agent-observability`.

## Directory layout

| Path | Purpose |
|---|---|
| `apps/scope/server.ts` | HTTP + SSE + WebSocket server; ingests events, serves UI, git/files/checkpoints APIs. |
| `apps/scope/db.ts` | SQLite schema + queries (built-in `node:sqlite`). |
| `apps/scope/terminal.ts` | In-browser PTY (node-pty) + Herdr multiplexer cwd mirroring over WebSocket. |
| `apps/scope/public/` | Static WebUI: `index.html`, `app.js` (state/SSE/keyboard), `trajectory.js`, `terminal.js`, `files.js`, `checkpoints.js`, `git.js`, `helpers.js`, `vendor/` (xterm). |
| `apps/scope-launcher/` | Electron launcher (`main.js`, `scope-control.js`), `run.sh`, `stop.sh`, `build-release.sh` packaging. |
| `extension/pi-scope.ts` | `pi` agent extension: hooks agent lifecycle, POSTs events, auto-discovers token. See `extension/README.md`. |
| `shared/` | `types.ts` (canonical event types/envelopes), `capture.ts`. Inlined into the server bundle by esbuild. |
| `docs/` | `shots/*.png` screenshots, `video/*.mp4` tour. |
| `db/scope.db` | Default SQLite database (gitignored in practice; present in repo). |
| `tmp/` | Dev token (`tmp/scope_token`), logs, screenshots (gitignored). |
| `build-release.sh` | Builds the AppImage (bundles portable Node 24 for node-pty ABI). |

## How to run

- **End users:** `./Pi-Scope-1.0.0.AppImage` (data in `~/.local/share/pi-scope/`).
- **From source (dev):** `apps/scope-launcher/run.sh` (needs Node 24+). Or
  `cd apps/scope && node server.ts` (default token `dev_token`, port `43190`).
- **Health check:** `curl -i http://127.0.0.1:43190/health` → expect `200`.
- **Feed it data:** run a `pi` agent with `-e extension/pi-scope.ts` (auto-discovers the
  token). Or `POST /events`.

## How to build the release

```bash
./build-release.sh   # → apps/scope-launcher/dist/Pi-Scope-<version>.AppImage
```
This esbuild-bundles `server.ts` (`--external:node-pty --external:ws`), copies the WebUI,
writes `server-bundle/package.json` (`{"type":"module"}`), provisions portable Node 24,
and runs electron-builder.

## Key concepts & gotchas (verified from history)

- **Versions differ:** server `VERSION = "0.1.0"` (`apps/scope/server.ts:38`); launcher
  package `1.0.0` (drives the AppImage filename); feature tour video is labeled `5.0.0`.
- **Launcher reuses a running server:** the Electron launcher does NOT restart an
  already-listening server. After editing `server.ts`/`terminal.ts`, `pkill -f "node
  server.ts"` (or fully quit/relaunch the app) or you will run stale code.
- **Token discovery:** default `dev_token` (`SCOPE_AUTH_TOKEN` overrides). Dev path
  `tmp/scope_token`; packaged path `~/.local/share/pi-scope/scope_token`. Extension checks
  `SCOPE_TOKEN_FILE` env → dev path → packaged path.
- **Port override mismatch:** the extension defaults to `http://127.0.0.1:43190`. A custom
  `SCOPE_PORT` requires passing `OBS_SERVER_URL=` / `--obs-server-url` on the extension
  side too (not auto-discovered).
- **No automated tests** in the repo. Verify with `node --check` / `node
  --experimental-strip-types --check` and the `/health` curl smoke test.
- **Extension changes are not hot-reloaded:** restart the `pi` agent and refresh the
  browser to pick them up.
- **Herdr cwd:** terminal decides active directory by real input (idle > 3s → mirror
  Herdr focused pane), not by pane visibility. Socket discovered from `$HERDR_SOCKET_PATH`
  / `$HERDR_SOCK` / XDG paths, re-checked every few seconds.
- **Packaging paths are AppImage-safe** (`SCOPE_TOKEN_FILE`, `SCOPE_DB_PATH`, static UI,
  `shared/types` inlined, terminal cwd via `SCOPE_PACKAGED`, herdr socket). `PROJECT_ROOT`
  only feeds env-overridden defaults.
- **`.gitignore`** excludes `node_modules/`, `.venv/`, `__pycache__/`, `*.pyc`, `.pi/`,
  `.pi_memory/`, `tmp/`, `.DS_Store`, `.idea/`, `*.log`. `package-lock.json` is tracked.

## Editing conventions

- TypeScript, ESM everywhere (`"type":"module"`). Server uses Node 24 built-ins
  (`node:sqlite`, `node:http`) — no Express.
- WebUI is vanilla JS + xterm; no bundler for `public/` (served statically).
- Keep changes minimal and scoped; do not add dependencies or refactor unrequested.
- After edits, re-read the affected section and run the narrowest relevant check before
  claiming success.
