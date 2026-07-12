# Pi Scope Server

Node HTTP server (Node 24+, built-in `node:sqlite` + `node:http`) that ingests
agent events, stores them in SQLite, and serves a live scope UI.

## Quick start

Requires Node 24+ (no install step — `node:sqlite` is built in).

```bash
# Start with auto-generated token
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
| `SCOPE_AUTH_TOKEN` | auto-generated | Bearer token for auth |

## Smoke test

```bash
# Terminal 1: start server
SCOPE_AUTH_TOKEN=dev node server.ts

# Terminal 2: run smoke tests
SCOPE_AUTH_TOKEN=dev bash ../../scripts/smoke-server.sh
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
