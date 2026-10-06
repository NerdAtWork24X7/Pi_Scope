#!/usr/bin/env bash
# Start.sh — one command to bring up Pi Scope.
#
#   ./Start.sh              desktop app (Electron window, default)
#   ./Start.sh --web        headless server + open the WebUI in your browser
#   ./Start.sh --server     headless server only, stays in the foreground
#
# Extra flags: --dev (server with --watch), --keep-server (leave the server up
# after this script exits), --port/--host/--db/--token.
#
# The server is started at most once: if one is already healthy on the target
# port its token is adopted instead of a second instance being spawned (same
# rule the Electron launcher follows). Ctrl-C shuts down only a server this
# script started.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$ROOT_DIR/apps/scope-server"
DESKTOP_DIR="$ROOT_DIR/apps/scope-desktop"
RUN_DIR="$ROOT_DIR/tmp"           # git-ignored: pid, log, token file
PID_FILE="$RUN_DIR/scope_server.pid"
LOG_FILE="$RUN_DIR/scope-server.log"
ENV_FILE="$DESKTOP_DIR/scope.env" # optional per-machine launcher settings

# ── Options ──────────────────────────────────────────────────────────────────

MODE="desktop"
DEV=0
KEEP_SERVER=0

die()  { printf '\033[31mStart.sh:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }

usage() {
  sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    -d|--desktop)   MODE="desktop" ;;
    -w|--web)       MODE="web" ;;
    -s|--server)    MODE="server" ;;
    --dev)          DEV=1 ;;
    --keep-server)  KEEP_SERVER=1 ;;
    -p|--port)      SCOPE_PORT="${2:?--port needs a number}"; shift ;;
    -H|--host)      SCOPE_HOST="${2:?--host needs an address}"; shift ;;
    -D|--db)        SCOPE_DB_PATH="${2:?--db needs a path}"; shift ;;
    -t|--token)     SCOPE_AUTH_TOKEN="${2:?--token needs a value}"; shift ;;
    -h|--help)      usage; exit 0 ;;
    *)              die "unknown option '$1' (try --help)" ;;
  esac
  shift
done

[ -f "$SERVER_DIR/server.ts" ] || die "server.ts not found under $SERVER_DIR"

# ── Node (nvm-aware; GUI launches do not source .bashrc) ─────────────────────

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true

command -v node >/dev/null 2>&1 || die "node not found on PATH — install Node.js 24+ (https://nodejs.org)"
NODE_BIN="$(command -v node)"

# `node server.ts` relies on native TypeScript stripping (no build step), which
# is only unflagged from Node 23.6 on. Fail loudly here instead of letting the
# server die with a cryptic syntax error.
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null | tr -dc '0-9')"
[ -n "$NODE_MAJOR" ] || die "cannot read the Node.js version from '$NODE_BIN' ($("$NODE_BIN" -v 2>&1 | head -1))"
[ "$NODE_MAJOR" -ge 24 ] || die "Node.js 24+ required (found $("$NODE_BIN" -v)); the server runs .ts sources directly"

mkdir -p "$RUN_DIR"

# ── Config: real env > scope.env file > defaults ─────────────────────────────

# Mirrors scope-control.js so the desktop icon and this script agree on host,
# port and token. Real environment variables always win; file values are only
# defaults (never exported over an existing value).
if [ -r "$ENV_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"          # ltrim
    case "$line" in ''|\#*) continue ;; esac
    key="${line%%=*}"; val="${line#*=}"
    [ "$key" = "$line" ] && continue                  # no '='
    case "$key" in
      SCOPE_PORT|SCOPE_HOST|SCOPE_DB_PATH|SCOPE_AUTH_TOKEN) ;;
      *) continue ;;
    esac
    val="${val#"${val%%[![:space:]]*}"}"            # trim value
    # Strip one layer of matching quotes so values may contain spaces.
    case "$val" in
      \"*\") val="${val:1:${#val}-2}" ;;
      \'*\') val="${val:1:${#val}-2}" ;;
    esac
    var="SCOPE_${key#SCOPE_}"
    [ -n "${!var:-}" ] || export "$var=$val"
  done < "$ENV_FILE"
fi

export SCOPE_PORT="${SCOPE_PORT:-43190}"
export SCOPE_HOST="${SCOPE_HOST:-127.0.0.1}"
export SCOPE_DB_PATH="${SCOPE_DB_PATH:-$ROOT_DIR/db/scope.db}"
export SCOPE_TOKEN_FILE="${SCOPE_TOKEN_FILE:-$RUN_DIR/scope_token}"

# A wildcard bind is not a usable browser target; the server's own boot banner
# prints the LAN URL for phones.
DISPLAY_HOST="$SCOPE_HOST"
case "$SCOPE_HOST" in 0.0.0.0|::|"[::]") DISPLAY_HOST="127.0.0.1" ;; esac

HEALTH_URL="http://${DISPLAY_HOST}:${SCOPE_PORT}/health"

# ── Helpers ──────────────────────────────────────────────────────────────────

# node is guaranteed at this point, so probe with it instead of assuming curl.
http_ok() { # http_ok <url> [auth-token] — 0 on 2xx
  "$NODE_BIN" -e '
    const [url, token] = process.argv.slice(1);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 2500);
    fetch(url, { signal: ac.signal, headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => process.exit(r.ok ? 0 : 1))
      .catch(() => process.exit(1));
  ' "$1" "${2:-}" >/dev/null 2>&1
}

mint_token() {
  # 32 hex chars; no openssl dependency.
  "$NODE_BIN" -e 'console.log(require("node:crypto").randomBytes(16).toString("hex"))'
}

port_busy() { # 0 = something already holds SCOPE_PORT on SCOPE_HOST
  "$NODE_BIN" -e '
    const [port, host] = process.argv.slice(1);
    const s = require("node:net").createServer();
    s.once("error", (e) => process.exit(e.code === "EADDRINUSE" ? 0 : 1));
    s.once("listening", () => s.close(() => process.exit(1)));
    s.listen(Number(port), host);
  ' "$SCOPE_PORT" "$SCOPE_HOST" >/dev/null 2>&1
}

port_owner_note() { # " (pid 1234)" when the tooling can tell us
  local pid=""
  pid="$(ss -tlnp 2>/dev/null | sed -n "s/.*:${SCOPE_PORT}[[:space:]].*pid=\([0-9]\+\).*/\1/p" | head -1)"
  [ -z "$pid" ] && pid="$(lsof -ti "tcp:${SCOPE_PORT}" -sTCP:LISTEN 2>/dev/null | head -1)"
  [ -n "$pid" ] && printf ' (pid %s)' "$pid"
  return 0
}

# ── Boot the server ──────────────────────────────────────────────────────────

SPAWNED_PID=""
SERVER_UP=0

shutdown_server() {
  [ -n "$SPAWNED_PID" ] || return 0
  info "stopping server (pid $SPAWNED_PID)…"
  # Graceful first: /shutdown closes the DB, kills terminals, removes the token.
  "$NODE_BIN" -e '
    const [url, token] = process.argv.slice(1);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 4000);
    fetch(url, { method: "POST", signal: ac.signal,
                 headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(() => process.exit(0)).catch(() => process.exit(1));
  ' "http://${DISPLAY_HOST}:${SCOPE_PORT}/shutdown" "$SCOPE_AUTH_TOKEN" >/dev/null 2>&1 || true

  for _ in $(seq 1 20); do            # up to 10s
    kill -0 "$SPAWNED_PID" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$SPAWNED_PID" 2>/dev/null; then
    kill "$SPAWNED_PID" 2>/dev/null || true
    sleep 1
    kill -9 "$SPAWNED_PID" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  info "server stopped."
}

cleanup() {
  trap - EXIT INT TERM
  if [ "$KEEP_SERVER" -eq 1 ] && [ -n "$SPAWNED_PID" ]; then
    info "leaving the server running (pid $SPAWNED_PID, log: $LOG_FILE)."
  else
    shutdown_server
  fi
}

# A SIGKILLed run (OOM, `kill -9`, closed terminal) leaves a server behind that
# no trap can collect, and the next launch would then be told the port is busy
# by a half-dead process. The pid file is written by this script and only ever
# holds one of our own servers, so a live pid there + a dead /health means an
# orphan: reap it. Never touches a healthy server (that path adopts instead).
reap_stale_server() {
  [ -s "$PID_FILE" ] || return 0
  local pid; pid="$(head -1 "$PID_FILE" 2>/dev/null | tr -dc '0-9')"
  [ -n "$pid" ] || { rm -f "$PID_FILE"; return 0; }
  kill -0 "$pid" 2>/dev/null || { rm -f "$PID_FILE"; return 0; }
  # Guard against pid reuse: only reap something that still looks like ours —
  # our server.ts, running from this repo. On Linux the cwd is authoritative
  # (the cmdline is just `node server.ts`); elsewhere fall back to the cmdline.
  local cmd cwd; cmd="$(ps -o args= -p "$pid" 2>/dev/null || true)"
  cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
  case "$cmd" in *server.ts*) ;; *) rm -f "$PID_FILE"; return 0 ;; esac
  if [ -n "$cwd" ] && [ "$cwd" != "$SERVER_DIR" ]; then rm -f "$PID_FILE"; return 0; fi
  info "reaping an orphaned server from a previous run (pid $pid)…"
  kill -TERM "$pid" 2>/dev/null || true
  # A stopped process (SIGSTOP, or a hung GPU-less box) only sees SIGTERM once
  # it is resumed — nudge it so it can exit gracefully instead of waiting for
  # the SIGKILL below.
  sleep 0.3
  kill -CONT "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
}

if http_ok "$HEALTH_URL"; then
  info "reusing the Pi Scope server already listening on ${SCOPE_HOST}:${SCOPE_PORT}."
  SERVER_UP=1
  # A pid file from an earlier run points at a process we no longer own (and
  # maybe at an unrelated one after pid reuse) — this run adopted, not spawned.
  rm -f "$PID_FILE"
  # Adopt its token so the URL we open is the one the running instance accepts.
  if [ -z "${SCOPE_AUTH_TOKEN:-}" ] && [ -r "$SCOPE_TOKEN_FILE" ]; then
    SCOPE_AUTH_TOKEN="$(cat "$SCOPE_TOKEN_FILE" 2>/dev/null || true)"
  fi
else
  reap_stale_server

  # The port may be held by something that is not a Pi Scope server at all (or
  # by one too broken to answer /health). Say so in one line instead of letting
  # node crash with an EADDRINUSE stack trace 20 lines further down.
  if port_busy; then
    die "port $SCOPE_PORT is already taken by another process$(port_owner_note).
     Stop it, or pick another port:  ./Start.sh --port $((SCOPE_PORT + 1))"
  fi

  # Pin the token ourselves so we can print a working URL (and authenticate the
  # shutdown call) without waiting for the file the server writes.
  [ -n "${SCOPE_AUTH_TOKEN:-}" ] || SCOPE_AUTH_TOKEN="$(mint_token)"
  export SCOPE_AUTH_TOKEN

  SERVER_ARGS=(server.ts)
  [ "$DEV" -eq 1 ] && SERVER_ARGS=(--watch server.ts)

  info "starting Pi Scope server on ${SCOPE_HOST}:${SCOPE_PORT}…"
  # `setsid` (falling back to nohup) puts the server in its own session so a
  # Ctrl-C aimed at this script's process group cannot kill it outright — the
  # EXIT/INT trap below then shuts it down gracefully (DB closed, terminals
  # killed, token file removed) instead of dropping an open SQLite file.
  # NB: the `cd` is a separate statement; `cd X && cmd &` would background the
  # whole list and $! would then be the wrapper subshell, not node.
  LAUNCH=(nohup)
  command -v setsid >/dev/null 2>&1 && LAUNCH=(setsid nohup)
  (
    cd "$SERVER_DIR" || exit 1
    "${LAUNCH[@]}" "$NODE_BIN" "${SERVER_ARGS[@]}" >>"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"
  )
  SPAWNED_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  [ -n "$SPAWNED_PID" ] || die "failed to spawn the server (see $LOG_FILE)"

  trap cleanup EXIT INT TERM

  READY=0
  for _ in $(seq 1 60); do            # up to 30s — node + SQLite open on cold disks
    if ! kill -0 "$SPAWNED_PID" 2>/dev/null; then
      printf '\n' >&2
      tail -n 30 "$LOG_FILE" >&2 || true
      die "server exited during startup (full log: $LOG_FILE)"
    fi
    if http_ok "$HEALTH_URL"; then READY=1; break; fi
    sleep 0.5
  done
  [ "$READY" -eq 1 ] || die "server did not become healthy within 30s (see $LOG_FILE)"
  SERVER_UP=1
  info "server healthy."
fi

# Built by node so the token is encoded exactly like the Electron launcher does.
UI_URL="$("$NODE_BIN" -e 'console.log(`http://${process.argv[1]}:${process.argv[2]}/?token=${encodeURIComponent(process.argv[3] ?? "")}`)' \
  "$DISPLAY_HOST" "$SCOPE_PORT" "${SCOPE_AUTH_TOKEN:-}")"

[ "$SERVER_UP" -eq 1 ] || exit 1

# ── Launch ───────────────────────────────────────────────────────────────────

wait_for_exit() {
  # Block until the server stops answering. Works for an adopted server too
  # (no pid to watch), and needs three consecutive failed probes so one busy
  # moment does not look like a dead server.
  local misses=0
  while :; do
    if [ -n "$SPAWNED_PID" ] && ! kill -0 "$SPAWNED_PID" 2>/dev/null; then break; fi
    if http_ok "$HEALTH_URL"; then
      misses=0
    else
      misses=$((misses + 1))
      [ "$misses" -ge 3 ] && break
    fi
    sleep 1
  done
  info "server stopped responding."
}

case "$MODE" in
  server)
    info "Pi Scope is ready → $UI_URL"
    info "Press Ctrl-C to stop it. Log: $LOG_FILE"
    # Stay in the foreground so the script *is* the server's lifetime.
    wait_for_exit
    trap - EXIT INT TERM
    ;;

  web)
    info "Pi Scope is ready → $UI_URL"
    if command -v xdg-open >/dev/null 2>&1; then
      xdg-open "$UI_URL" >/dev/null 2>&1 || true
    elif command -v open >/dev/null 2>&1; then
      open "$UI_URL" >/dev/null 2>&1 || true
    else
      info "no opener found — open the URL above manually."
    fi
    # Tail the log so a server-side crash is visible instead of silent.
    tail -n 0 -f "$LOG_FILE" 2>/dev/null &
    TAIL_PID=$!
    wait_for_exit
    kill "$TAIL_PID" 2>/dev/null || true
    trap - EXIT INT TERM
    ;;

  desktop)
    if [ ! -x "$ROOT_DIR/node_modules/.bin/electron" ]; then
      info "installing dependencies (first run only)…"
      ( cd "$ROOT_DIR" && npm install --no-audit --no-fund ) \
        || die "npm install failed — run it manually in $ROOT_DIR"
    fi
    # Same environment fix-up as run.sh: the Chromium SUID sandbox is broken in
    # some environments and would hard-crash Electron before app code runs.
    export ELECTRON_DISABLE_SANDBOX=1

    ELECTRON="$ROOT_DIR/node_modules/.bin/electron"
    STARTED_AT=$SECONDS
    info "opening the Pi Scope desktop app…"
    "$ELECTRON" "$DESKTOP_DIR" &
    ELECTRON_PID=$!
    set +e; wait "$ELECTRON_PID"; STATUS=$?; set -e

    # "GPU process isn't usable. Goodbye." kills Chromium during startup on
    # machines with a broken GPU/sandbox stack (common in VMs and containers).
    # Only a crash *this early* is retried, with rendering forced to software;
    # a window the user later closed must never relaunch itself.
    if [ "$STATUS" -ne 0 ] && [ $((SECONDS - STARTED_AT)) -lt 30 ]; then
      info "desktop app died during startup — retrying with software rendering…"
      "$ELECTRON" --disable-gpu --disable-gpu-sandbox --disable-software-rasterizer \
                  --in-process-gpu "$DESKTOP_DIR" &
      ELECTRON_PID=$!
      set +e; wait "$ELECTRON_PID"; STATUS=$?; set -e
    fi

    [ "$STATUS" -eq 0 ] || info "desktop app exited with status $STATUS (log: $DESKTOP_DIR/launcher.log)."
    exit "$STATUS"   # non-zero propagates to the caller; the trap still cleans up
    ;;
esac