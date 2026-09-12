# Pi Scope Server

Node HTTP server (Node 24+, built-in `node:sqlite` + `node:http`) that ingests
agent events, stores them in SQLite, and serves a live scope UI.

## Quick start

Requires Node 24+ (no install step — `node:sqlite` is built in).

```bash
# Start with the default dev_token
node server.ts

# Or with explicit token
SCOPE_AUTH_TOKEN=my-secret-token node server.ts
```

## Environment variables

| Var | Default | Description |
|-----|---------|-------------|
| `SCOPE_PORT` | `43190` | HTTP port |
| `SCOPE_HOST` | `127.0.0.1` | Bind address |
| `SCOPE_DB_PATH` | `db/scope.db` | SQLite database path |
| `SCOPE_AUTH_TOKEN` | dev_token | Bearer token for auth |
| `SCOPE_FILE_ROOT` | project root | Comma-separated allowed roots for `/files/*` and `/checkpoints/*` |
| `SCOPE_SETTINGS_JSON` | `~/.pi/agent/settings.json` | Override the pi settings file the agent-team sidebar reads/writes |
| `SCOPE_SKILLS_DIR` | `~/.pi/agent/skills` | Override the skills directory scanned for the agent-team sidebar |
| `SCOPE_EXTRA_PATH` | — | Colon-separated extra dirs prepended to `PATH` for chat-spawned `pi` subprocesses (e.g. `SCOPE_EXTRA_PATH=/path/to/.venv/bin`) |
| `SCOPE_KEYS_JSON` | `~/.pi/agent/api-keys.json` | API keys entered in Settings → API Keys (owner-only file, mode 0600) |

Chat-spawned `pi` subprocesses are launched through the user's **interactive
shell** (`bash -ic` / `zsh -ic`, preferring `$SHELL`), so the environment they see
is the one a terminal would give them: `~/.bashrc` (bash) or `~/.zshrc` (zsh) is
sourced. This matters because the desktop launcher starts the server from a
session that never reads those files. The login flag is deliberately omitted:
login-only profile files are skipped, so a slow or banner-printing login shell
can't delay or corrupt the chat protocol. The shell's own stdout is discarded and
pi's NDJSON stream is routed to a dedicated fd, so rc banners or prompt themes
can't corrupt the RPC stream either.

On top of that they get the workspace's Python venv bin dirs prepended to `PATH`,
and `PLAYWRIGHT_BROWSERS_PATH` restored from the user's shell rc files (or
Playwright's default cache dirs) when the server env lacks it — so tools like
`web-fetch` find the venv's `playwright` and its Chromium browser exactly as they
do in the terminal, even when the server was launched from a GUI session that
never sourced the shell rc. The `PATH` prefix is re-applied inside the shell too,
so an rc file that reassigns `PATH` instead of prepending to it doesn't drop
those dirs.

API keys entered in **Settings → API Keys** are stored in
`~/.pi/agent/api-keys.json` (mode 0600) and injected into the environment of
every chat-spawned `pi` subprocess, so an extension that reads `process.env`
(e.g. the speech-to-text extension's `GROQ_API_KEY`) works without the key
living in a shell profile. A stored key overrides the inherited environment; the
Settings page shows each key's effective source. Secrets never leave the server
— the UI only receives a masked preview.

## Herdr cwd integration

The Terminal endpoint supports a **Herdr** multiplexer shell. When selected, the shared
working directory (used by `/files/*` and `/checkpoints/*`) mirrors the focused Herdr
pane's live cwd — queried over Herdr's Unix socket — instead of the frozen PTY directory.

The server resolves the socket from (in order) `$HERDR_SOCKET_PATH`, `$HERDR_SOCK`,
`$XDG_CONFIG_HOME/herdr/herdr.sock`, `~/.config/herdr/herdr.sock`,
`$XDG_RUNTIME_DIR/herdr/herdr.sock`, `$XDG_RUNTIME_DIR/herdr.sock`, and
`~/.local/share/herdr/herdr.sock`, with a 3-second discovery cache so a Herdr that
starts after the server is also detected. If no socket is reachable it falls back to the
PTY's `/proc/<pid>/cwd`.

## Smoke test

```bash
# Terminal 1: start server
SCOPE_AUTH_TOKEN=dev_token node server.ts

# Terminal 2: check health (expect HTTP 200)
curl -i http://127.0.0.1:43190/health
```

## End-to-end tests

The Chat view has a headless-browser suite that runs the **real** `public/` assets
against a mock backend (`test/mock-backend.mjs`) — no SQLite, no `pi` subprocess,
no network. `test/chat.e2e.test.mjs` drives workspace selection / restore / add /
remove / subagent nesting and the streaming + click flows; `test/harness.mjs` holds
the shared Playwright helpers.

```bash
# from apps/scope (Playwright + Chromium come from the repo's root install)
npm test
# or pick a subset:
node --test --test-name-pattern="workspace" test/chat.e2e.test.mjs
```

## API

All endpoints except `/health` and `/` require `Authorization: Bearer <token>`.
The SSE endpoint also accepts `?token=<token>` (browsers can't set headers on EventSource).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check + version + uptime + totals (no auth) |
| POST | `/shutdown` | Graceful server shutdown (no auth) |
| GET | `/` | Scope UI (no auth) |
| POST | `/events` | Ingest single event or array (no auth — loopback only) |
| GET | `/models` | List distinct models seen |
| GET | `/sessions` | List sessions (pool/tag/since/limit) |
| DELETE | `/sessions` | Delete ALL sessions + events (destructive) |
| DELETE | `/sessions/:id` | Delete one session + events |
| GET | `/sessions/:id/events` | Replay events (limit/before_seq/since_seq/type) |
| GET | `/sessions/:id/stats` | Per-session stats (tokens/cost/models) |
| GET | `/sessions/stats?ids=` | Batch stats for multiple sessions |
| GET | `/events/stream` | SSE stream (pool/tag/session_id/?token=) |
| GET | `/files/modified` | Git status (porcelain) for a cwd |
| GET | `/files/diff` | HEAD vs working-tree diff for one file |
| POST | `/files/save` | Write a working-tree file |
| POST | `/checkpoints/create` | Git-backed working-tree snapshot |
| GET | `/checkpoints/list` | List checkpoints for a cwd |
| POST | `/checkpoints/restore` | Hard reset to a checkpoint |
| GET | `/checkpoints/branches` | List branches for checkpoint merge |
| POST | `/checkpoints/merge` | Merge a checkpoint into a branch |
| POST | `/checkpoints/delete` | Delete a checkpoint ref (+ optional branch) |
| GET | `/git/status` | Full git status (branch, upstream, ahead/behind, files) |
| POST | `/git/stage` | Stage files (paths or all) |
| POST | `/git/unstage` | Unstage files |
| POST | `/git/discard` | Revert changes / delete untracked |
| GET | `/git/diff` | Unified diff (cached or worktree) |
| GET | `/git/log` | Commit history with parents |
| GET | `/git/show` | One commit detail + diff |
| GET | `/git/compare` | Diff between two SHAs |
| GET | `/git/cat` | File content at a commit |
| POST | `/git/action` | Graph context menu (checkout/cherry-pick/revert/rebase/reset/branch/tag) |
| POST | `/git/commit` | Create commit (with amend support) |
| POST | `/git/branch` | Create/switch/delete branch |
| GET | `/git/branches` | List all branches |
| GET | `/git/remotes` | List remotes |
| POST | `/git/remote` | Add/remove a remote |
| POST | `/git/push` | Push (auto set-upstream) |
| POST | `/git/pull` | Pull |
| POST | `/git/fetch` | Fetch |
| GET | `/git/stash` | List stashes |
| POST | `/git/stash` | Push/pop/drop a stash |
| GET | `/git/submodules` | List submodules |
| POST | `/git/submodule` | Add/remove/update/init/deinit/sync a submodule |
