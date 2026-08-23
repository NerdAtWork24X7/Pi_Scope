#!/usr/bin/env bash
# stop.sh — Gracefully shut down a running Pi Scope server.
#
# First tries the /shutdown HTTP endpoint (clean: closes DB, kills terminals,
# removes the token file, and exits). Falls back to finding and killing the
# server process by its port or PID.
set -euo pipefail

PORT="${SCOPE_PORT:-43190}"
HOST="${SCOPE_HOST:-127.0.0.1}"
SHUTDOWN_URL="http://${HOST}:${PORT}/shutdown"
TOKEN_FILE="${SCOPE_TOKEN_FILE:-}"

# Resolve the token file path (same logic as server.ts).
if [ -z "$TOKEN_FILE" ]; then
  DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  PROJECT_ROOT="$(cd "$DIR/../.." && pwd)"
  TOKEN_FILE="$PROJECT_ROOT/tmp/scope_token"
fi

# ── Try graceful shutdown via the HTTP endpoint ────────────────────────────

echo "Stopping Pi Scope server on ${HOST}:${PORT}…"

# Check if the server is even listening.
if ! curl -sf --max-time 3 "http://${HOST}:${PORT}/health" > /dev/null 2>&1; then
  echo "  No server listening on ${HOST}:${PORT}."
else
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    --max-time 5 \
    -X POST "$SHUTDOWN_URL" 2>/dev/null || echo "000")

  if [ "$HTTP_CODE" = "200" ]; then
    echo "  Shutdown request accepted. Waiting for server to stop…"

    # Wait up to 10s for the server to stop listening.
    for i in $(seq 1 20); do
      if ! curl -sf --max-time 1 "http://${HOST}:${PORT}/health" > /dev/null 2>&1; then
        echo "  Server stopped."
        exit 0
      fi
      sleep 0.5
    done

    echo "  Server did not stop in time after graceful request."
  else
    echo "  Shutdown endpoint returned HTTP $HTTP_CODE, falling back to kill…"
  fi
fi

# ── Fallback: find and kill the server process ──────────────────────────────

# Try to find the PID by the port it's listening on.
PID=$(ss -tlnp 2>/dev/null | grep -E "127\\.0\\.0\\.1:${PORT}\\b" | sed -n 's/.*pid=\\([0-9]\\+\\).*/\\1/p' | head -1 || true)
if [ -z "$PID" ]; then
  PID=$(lsof -ti "tcp:${PORT}" -sTCP:LISTEN 2>/dev/null || true)
fi

if [ -z "$PID" ]; then
  echo "  Could not find a process listening on ${HOST}:${PORT}."
  exit 0
fi

echo "  Sending SIGTERM to PID $PID…"
kill "$PID" 2>/dev/null || true

# Wait for the process to exit.
for i in $(seq 1 10); do
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "  Server stopped."
    exit 0
  fi
  sleep 0.5
done

echo "  Server did not stop after SIGTERM, sending SIGKILL…"
kill -9 "$PID" 2>/dev/null || true
echo "  Server killed."