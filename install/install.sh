#!/bin/sh
# install.sh — install Pi Scope with one command (curl channel).
#
#   curl -fsSL https://raw.githubusercontent.com/NerdAtWork24X7/Pi_Scope/main/install/install.sh | sh
#
# Downloads the app (a GitHub tarball, so `git` is not required), checks for a
# Node.js 24+ runtime, and installs its dependencies. Run it from a checkout
# instead (`./install/install.sh`) and it installs that checkout in place.
#
# Options (environment variable in brackets):
#   --dir <path>     where to install              [PISC_DIR, default ./Pi_Scope]
#   --pm <name>      npm | pnpm | bun for deps      [PISC_PM, default npm]
#   --ref <name>     branch or tag to fetch         [PISC_REF, default main]
#   --url <url>      override the download URL      [PISC_URL] (https only)
#   --no-deps        skip the dependency install    [PISC_SKIP_DEPS=1]
#   -h, --help       this text
#
# Windows and package-manager-specific channels: see install/README.md.
set -eu

SLUG="NerdAtWork24X7/Pi_Scope"
REF="${PISC_REF:-main}"
URL="${PISC_URL:-}"
PM="${PISC_PM:-npm}"
DIR=""
DIR_GIVEN=0
if [ -n "${PISC_DIR:-}" ]; then DIR="$PISC_DIR"; DIR_GIVEN=1; fi
SKIP_DEPS="${PISC_SKIP_DEPS:-0}"

die()  { printf 'install.sh: %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }

usage() { sed -n '2,18p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    -d|--dir)   DIR="${2:?--dir needs a path}"; DIR_GIVEN=1; shift ;;
    -p|--pm)    PM="${2:?--pm needs a name}"; shift ;;
    -r|--ref)   REF="${2:?--ref needs a name}"; shift ;;
    -u|--url)   URL="${2:?--url needs a URL}"; shift ;;
    --no-deps)  SKIP_DEPS=1 ;;
    -h|--help)  usage; exit 0 ;;
    *)          die "unknown option '$1' (try --help)" ;;
  esac
  shift
done

case "$PM" in
  npm|pnpm|bun) ;;
  *) die "--pm must be npm, pnpm or bun (got '$PM')" ;;
esac

# Where this script lives. `curl | sh` has no file, so SELF_DIR is only set for
# a real checkout. The script now lives in install/, so the project root is the
# script's own directory or its parent.
SELF_DIR=""
if [ -f "$0" ]; then
  SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fi

# Running from a checkout installs that checkout in place — unless the caller
# named a directory, in which case that is where the copy goes.
IN_PLACE=0
if [ "$DIR_GIVEN" -eq 0 ] && [ -n "$SELF_DIR" ]; then
  for cand in "$SELF_DIR" "$SELF_DIR/.."; do
    if [ -f "$cand/package.json" ] && [ -f "$cand/apps/scope-server/server.ts" ]; then
      IN_PLACE=1
      DIR=$(CDPATH= cd -- "$cand" && pwd)
      break
    fi
  done
fi
[ -n "$DIR" ] || DIR="$PWD/Pi_Scope"
[ -n "$URL" ] || URL="https://codeload.github.com/$SLUG/tar.gz/refs/heads/$REF"

# https only: the archive is unpacked and then executed, so a plain-HTTP
# download is code an on-path attacker gets to choose. There is deliberately no
# http escape hatch here.
case "$URL" in
  https://*) ;;
  *) die "--url must be an https:// URL (got '$URL')" ;;
esac

# Never unpack over a directory we do not recognise: a --dir that points at an
# existing non-empty folder would otherwise have its contents overwritten. An
# update over a previous Pi Scope is fine — server.ts identifies one.
if [ -e "$DIR" ] && [ ! -d "$DIR" ]; then
  die "$DIR exists and is not a directory"
fi
if [ -d "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ] && [ ! -f "$DIR/apps/scope-server/server.ts" ]; then
  die "$DIR is not empty and does not look like Pi Scope — pass --dir <new path> or empty it first"
fi

# Installing as root leaves a tree this user cannot later write to (and npm
# refuses to run build scripts as root). Warn rather than refuse: containers are
# legitimately root.
if [ "$(id -u 2>/dev/null || echo 1)" -eq 0 ]; then
  info "running as root — $DIR will be owned by root"
fi

# ── Node 24+ (the server runs its .ts sources directly) ──────────────────────

command -v node >/dev/null 2>&1 || die "node not found on PATH — install Node.js 24+ (https://nodejs.org) and run this again"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
# A node that prints anything unexpected must fail the version check, not the
# `[ -ge ]` test below (which would abort with a confusing "integer expected").
case "$NODE_MAJOR" in ''|*[!0-9]*) NODE_MAJOR=0 ;; esac
[ "$NODE_MAJOR" -ge 24 ] || die "Node.js 24+ required (found $(node -v 2>/dev/null)) — the server runs .ts sources directly"

# ── Fetch the app (unless we are already inside one) ─────────────────────────

if [ "$IN_PLACE" -eq 0 ]; then
  command -v tar >/dev/null 2>&1 || die "tar is required to unpack the download"
  TMP=$(mktemp -d 2>/dev/null || mktemp -d -t piscope) || die "could not create a temporary directory"
  # Single-quoted so $TMP is expanded when the trap fires, not when it is set:
  # the directory name (from TMPDIR) never reaches the shell as source text.
  # shellcheck disable=SC2064
  trap 'rm -rf -- "$TMP"' EXIT INT TERM

  info "downloading $SLUG ($REF)…"
  # --proto/--tlsv1.2 keep even a redirected request on https and on modern TLS;
  # --https-only does the same for wget.
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 -o "$TMP/app.tar.gz" "$URL" \
      || die "download failed: $URL"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --https-only --secure-protocol=TLSv1_2 -O "$TMP/app.tar.gz" "$URL" \
      || die "download failed: $URL"
  else
    die "neither curl nor wget is available; download $URL and unpack it yourself"
  fi

  info "unpacking into $DIR…"
  # Reject absolute members and `..` traversal (a "zip-slip" archive) before
  # extracting: one that escapes $TMP/x could drop files anywhere the user can
  # write. The listing also proves the download really is a tarball.
  tar -tzf "$TMP/app.tar.gz" > "$TMP/list" 2>/dev/null \
    || die "could not read the download — is $URL a .tar.gz?"
  if grep -Eq '(^/|(^|/)\.\.(/|$))' "$TMP/list"; then
    die "the archive contains unsafe paths — refusing to unpack it"
  fi
  mkdir -p "$TMP/x" "$DIR"
  tar -xzf "$TMP/app.tar.gz" -C "$TMP/x" || die "could not unpack the download"
  SRC=$(find "$TMP/x" -mindepth 1 -maxdepth 1 -type d | head -n 1)
  [ -n "$SRC" ] || die "the archive did not contain the project directory"
  cp -R "$SRC/." "$DIR/" || die "could not copy the app into $DIR"
  [ -f "$DIR/apps/scope-server/server.ts" ] || die "$DIR does not look like Pi Scope after unpacking"
fi

# ── Dependencies ─────────────────────────────────────────────────────────────

pm_install() { # pm_install <dir> — install one npm project with the chosen PM
  case "$PM" in
    npm)  ( cd "$1" && npm install --no-audit --no-fund ) ;;
    # pnpm blocks dependency build scripts by default; node-pty, esbuild and
    # ffmpeg-static need them, so force them to run.
    pnpm) ( cd "$1" && pnpm install --no-ignore-scripts ) ;;
    # Bun also blocks those build scripts until a package is trusted. Trusting
    # them may write a trustedDependencies field; it exits 1 when there is
    # nothing left to run, which is not a failure.
    bun)  ( cd "$1" && bun install && { bun pm trust --all || true; } ) ;;
  esac
}

if [ "$SKIP_DEPS" -eq 1 ]; then
  info "skipping dependency install (--no-deps)."
else
  command -v "$PM" >/dev/null 2>&1 || die "$PM is required to install dependencies — install it and run this again"
  info "installing dependencies in $DIR with $PM (this can take a minute)…"
  pm_install "$DIR" || die "$PM install failed — run it manually in $DIR"
  # The bundled Pi coding agent — and with it the server's own runtime packages
  # (node-pty, ws, see apps/scope-server/pi-deps.ts) — installs into the user's
  # own data dir (~/.pi-scope/pi) rather than into this checkout, so Settings →
  # Update can replace it and the tree survives re-installing the app. `--move`
  # migrates a bundle an older release left in apps/scope-desktop/pi-bundle
  # instead of fetching it again. A failure here is not fatal: Chat falls back
  # to a `pi` on PATH, and the server says which one it chose at boot.
  BUNDLE_INSTALLER="$DIR/apps/scope-desktop/pi-bundle-install.mjs"
  if [ -f "$BUNDLE_INSTALLER" ]; then
    info "installing the bundled Pi coding agent and server packages with $PM…"
    node "$BUNDLE_INSTALLER" --pm "$PM" --move \
      || info "the bundled Pi agent could not be installed — Chat will fall back to a pi on PATH."
  fi
fi

# ── Seed the agent dir (first run only) ──────────────────────────────────────

# Pi Scope runs its bundled `pi` in its own agent dir (agent-dir.ts; default
# ~/.pi-scope/agent). Give a fresh machine a starting template — settings,
# skills and extensions — copied from the example agent. An existing agent dir
# is never touched.
AGENT_DIR="${SCOPE_AGENT_DIR:-$HOME/.pi-scope/agent}"
TEMPLATE="$DIR/examples/pi_local/agent"

if [ -e "$AGENT_DIR" ]; then
  info "agent dir already exists at $AGENT_DIR — leaving it untouched."
elif [ ! -d "$TEMPLATE" ]; then
  info "no agent template at $TEMPLATE — skipping the initial agent setup."
else
  info "seeding the agent template into $AGENT_DIR…"
  mkdir -p "$AGENT_DIR"
  # Copy config and sources only: the skills' Python .venv and the obscura
  # *.tar.gz bundles are large and platform-bound, and session logs are
  # per-machine. tar keeps the tree intact and is already a dependency. Both the
  # bare and the wildcard-prefixed patterns are given so GNU tar and macOS
  # bsdtar agree on what to drop.
  if tar -cf - -C "$TEMPLATE" \
        --exclude='.venv'       --exclude='*/.venv' \
        --exclude='sessions'    --exclude='*/sessions' \
        --exclude='__pycache__' --exclude='*/__pycache__' \
        --exclude='*.tar.gz'    --exclude='*.pyc' . \
      | tar -xf - -C "$AGENT_DIR"; then
    info "agent template installed in $AGENT_DIR."
  else
    info "could not seed the agent template — Pi Scope creates its agent dir on first run."
  fi
fi

# ── Extension dependencies ───────────────────────────────────────────────────

# pi discovers extensions in the agent dir (its `extensions/` directory plus
# whatever settings.json adds or removes). A *local* extension's npm packages are
# nobody's job but ours — pi only installs dependencies for the packages it
# installed itself — so this walks every extension pi has available, reads the
# dependencies each one declares in a nearby package.json, and installs the
# missing ones into the bundled pi project (~/.pi-scope/pi), whose node_modules
# the app, the agent and every extension already share.
#
# Not fatal: an extension whose packages are missing reports that itself when it
# runs (the `browser` extension's message names the packages and
# PI_BROWSER_MODULE_ROOT), so keep going and let the app start.
# The manifest lives in the agent template, so a fresh agent dir already has it;
# --seed-manifest covers a dir seeded by an older release, which is never
# re-seeded and would otherwise declare nothing.
EXT_INSTALLER="$DIR/apps/scope-desktop/pi-extensions-install.mjs"
EXT_MANIFEST="$DIR/examples/pi_local/agent/extensions/package.json"
if [ "$SKIP_DEPS" -eq 0 ] && [ -f "$EXT_INSTALLER" ]; then
  node "$EXT_INSTALLER" --pm "$PM" --agent "$AGENT_DIR" --seed-manifest "$EXT_MANIFEST" \
    || info "some extension dependencies could not be installed — the extensions needing them will say so at run time."
fi

# ── Done ─────────────────────────────────────────────────────────────────────

info "Pi Scope is installed in $DIR"
if [ "$SKIP_DEPS" -eq 1 ]; then
  printf 'Next:\n  cd "%s" && %s install && ./pi-scope\n' "$DIR" "$PM"
else
  printf 'Next:\n  cd "%s"\n  ./pi-scope          # desktop window (--web opens the browser, --server runs headless)\n' "$DIR"
fi
