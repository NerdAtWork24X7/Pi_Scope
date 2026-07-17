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

## Herdr cwd integration

The Terminal endpoint supports a **Herdr** multiplexer shell. When selected, the shared
working directory (used by `/files/*` and `/checkpoints/*`) mirrors the focused Herdr
pane's live cwd — queried over Herdr's Unix socket — instead of the frozen PTY directory.

The server resolves the socket from `$HERDR_SOCKET_PATH` / `$HERDR_SOCK`, then the XDG
paths `~/.config/herdr/herdr.sock`, `~/.local/share/herdr/herdr.sock`, and
`$XDG_RUNTIME_DIR/herdr.sock`, with a 3-second discovery cache so a Herdr that starts
after the server is also detected. If no socket is reachable it falls back to the PTY's
`/proc/<pid>/cwd`.

## Smoke test

```bash
# Terminal 1: start server
SCOPE_AUTH_TOKEN=dev_token node server.ts

# Terminal 2: check health (expect HTTP 200)
curl -i http://127.0.0.1:43190/health
```

## API

All endpoints except `/health` and `/` require `Authorization: Bearer <token>`.
The SSE endpoint also accepts `?token=<token>` (browsers can't set headers on EventSource).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (no auth) |
| POST | `/events` | Ingest single event or array |
| GET | `/sessions` | List sessions (pool/tag/since/limit) |
| GET | `/sessions/:id/events` | Replay events for a session |
| GET | `/events/stream` | SSE stream (pool/tag/session_id/?token=) |
| GET | `/` | Scope UI (no auth) |
