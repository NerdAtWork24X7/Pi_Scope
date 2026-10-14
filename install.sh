#!/bin/sh
# install.sh — install Pi Scope with one command.
#
#   curl -fsSL https://raw.githubusercontent.com/NerdAtWork24X7/Pi_Scope/main/install.sh | sh
#
# Downloads the app (a GitHub tarball, so `git` is not required), checks for a
# Node.js 24+ runtime, and installs its dependencies. Run it from a checkout
# instead (`./install.sh`) and it installs that checkout in place.
#
# Options (environment variable in brackets):
#   --dir <path>   where to install             [PISC_DIR, default ./Pi_Scope]
#   --ref  <name>  branch or tag to fetch       [PISC_REF, default main]
#   --url  <url>   override the download URL    [PISC_URL]
#   --no-deps      skip `npm install`           [PISC_SKIP_DEPS=1]
#   -h, --help     this text
#
# Windows: use install.ps1 (see the README's Windows quick start).
set -eu

SLUG="NerdAtWork24X7/Pi_Scope"
REF="${PISC_REF:-main}"
URL="${PISC_URL:-}"
DIR=""
DIR_GIVEN=0
if [ -n "${PISC_DIR:-}" ]; then DIR="$PISC_DIR"; DIR_GIVEN=1; fi
SKIP_DEPS="${PISC_SKIP_DEPS:-0}"

die()  { printf 'install.sh: %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    -d|--dir)   DIR="${2:?--dir needs a path}"; DIR_GIVEN=1; shift ;;
    -r|--ref)   REF="${2:?--ref needs a name}"; shift ;;
    -u|--url)   URL="${2:?--url needs a URL}"; shift ;;
    --no-deps)  SKIP_DEPS=1 ;;
    -h|--help)  usage; exit 0 ;;
    *)          die "unknown option '$1' (try --help)" ;;
  esac
  shift
done

# Where this script itself lives. `curl | sh` has no file, so this is only a
# checkout when the script really is a file sitting next to the project.
SELF_DIR=""
if [ -f "$0" ]; then
  SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fi

# Running from a checkout installs that checkout in place — unless the caller
# named a directory, in which case that is where the copy goes.
IN_PLACE=0
if [ "$DIR_GIVEN" -eq 0 ] && [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/package.json" ] && [ -f "$SELF_DIR/apps/scope-server/server.ts" ]; then
  IN_PLACE=1
  DIR="$SELF_DIR"
fi
[ -n "$DIR" ] || DIR="$PWD/Pi_Scope"
[ -n "$URL" ] || URL="https://codeload.github.com/$SLUG/tar.gz/refs/heads/$REF"

# ── Node 24+ (the server runs its .ts sources directly) ──────────────────────

command -v node >/dev/null 2>&1 || die "node not found on PATH — install Node.js 24+ (https://nodejs.org) and run this again"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$NODE_MAJOR" -ge 24 ] || die "Node.js 24+ required (found $(node -v 2>/dev/null)) — the server runs .ts sources directly"

# ── Fetch the app (unless we are already inside one) ─────────────────────────

if [ "$IN_PLACE" -eq 0 ]; then
  command -v tar >/dev/null 2>&1 || die "tar is required to unpack the download"
  TMP=$(mktemp -d 2>/dev/null || mktemp -d -t piscope) || die "could not create a temporary directory"
  # shellcheck disable=SC2064
  trap "rm -rf '$TMP'" EXIT INT TERM

  info "downloading $SLUG ($REF)…"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$URL" -o "$TMP/app.tar.gz" || die "download failed: $URL"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$TMP/app.tar.gz" "$URL" || die "download failed: $URL"
  else
    die "neither curl nor wget is available; download $URL and unpack it yourself"
  fi

  info "unpacking into $DIR…"
  mkdir -p "$TMP/x" "$DIR"
  tar -xzf "$TMP/app.tar.gz" -C "$TMP/x" || die "could not unpack the download"
  SRC=$(find "$TMP/x" -mindepth 1 -maxdepth 1 -type d | head -n 1)
  [ -n "$SRC" ] || die "the archive did not contain the project directory"
  cp -R "$SRC/." "$DIR/" || die "could not copy the app into $DIR"
  [ -f "$DIR/apps/scope-server/server.ts" ] || die "$DIR does not look like Pi Scope after unpacking"
fi

# ── Dependencies ─────────────────────────────────────────────────────────────

if [ "$SKIP_DEPS" -eq 1 ]; then
  info "skipping dependency install (--no-deps)."
else
  command -v npm >/dev/null 2>&1 || die "npm is required to install dependencies (it ships with Node.js)"
  info "installing dependencies in $DIR (this can take a minute)…"
  ( cd "$DIR" && npm install --no-audit --no-fund ) || die "npm install failed — run it manually in $DIR"
  # The bundled Pi coding agent keeps its own npm project, so Chat works with no
  # global `pi` install. A failure here is not fatal: Chat falls back to a `pi`
  # on PATH, and the server says which one it chose at boot.
  if [ -f "$DIR/apps/scope-desktop/pi-bundle/package.json" ]; then
    info "installing the bundled Pi coding agent…"
    ( cd "$DIR/apps/scope-desktop/pi-bundle" && npm install --no-audit --no-fund ) \
      || info "the bundled Pi agent could not be installed — Chat will fall back to a pi on PATH."
  fi
fi

# ── Done ─────────────────────────────────────────────────────────────────────

info "Pi Scope is installed in $DIR"
if [ "$SKIP_DEPS" -eq 1 ]; then
  printf 'Next:\n  cd "%s" && npm install && ./Start.sh\n' "$DIR"
else
  printf 'Next:\n  cd "%s"\n  ./Start.sh          # desktop window (--web opens the browser, --server runs headless)\n' "$DIR"
fi
