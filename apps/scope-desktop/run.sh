#!/usr/bin/env bash
# run.sh — launch the Pi Scope Electron app (used by the desktop icon).
# Desktop/GUI sessions do NOT source .bashrc, so node/npm/npx (via nvm)
# are missing from PATH. Load them explicitly here so a double-click just works.
set -euo pipefail

# Disable the Chromium SUID sandbox: this environment's chrome-sandbox helper is
# not root-owned, which would otherwise hard-crash Electron before app code runs.
export ELECTRON_DISABLE_SANDBOX=1

# Load node/npm/npx via nvm (the GUI session does not source .bashrc).
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# Everything the app needs — the bundled pi agent, the server's runtime packages
# (node-pty, ws) and the desktop tooling (electron, …) — lives in one shared npm
# project in the user's data dir, not in this checkout, so the checkout keeps no
# node_modules. app-deps-install.mjs seeds/completes that install (idempotent);
# the server launches every `pi` from it and falls back to a global pi install
# when it is missing.
PI_DIR="$HOME/.pi-scope/pi"

# Install the .desktop into the user applications dir (idempotent) so the DE
# can match this window's WM_CLASS to its icon in the dock/taskbar.
APPS_DIR="$HOME/.local/share/applications"
mkdir -p "$APPS_DIR"
#DESKTOP_SRC="$DIR/pi-scope.desktop"
#DESKTOP_DST="$APPS_DIR/pi-scope.desktop"
#if [ ! -f "$DESKTOP_DST" ] || ! cmp -s "$DESKTOP_SRC" "$DESKTOP_DST"; then
#  cp "$DESKTOP_SRC" "$DESKTOP_DST"
#fi

# Also install an identical copy on the Desktop shortcut (idempotent) so the
# icon renders there too. XDG_DESKTOP_DIR falls back to ~/Desktop.
#DESKTOP_DIR="${XDG_DESKTOP_DIR:-$HOME/Desktop}"
#mkdir -p "$DESKTOP_DIR"
#DESKTOP_SHORTCUT="$DESKTOP_DIR/pi-scope.desktop"
#if [ ! -f "$DESKTOP_SHORTCUT" ] || ! cmp -s "$DESKTOP_SRC" "$DESKTOP_SHORTCUT"; then
#  cp "$DESKTOP_SRC" "$DESKTOP_SHORTCUT"
#  chmod +x "$DESKTOP_SHORTCUT"
#fi

# Install the shared app project on first run (idempotent). app-deps-install.mjs
# also seeds the bundled pi agent into the same tree and migrates a bundle an
# older layout left in pi-bundle/.
if command -v node >/dev/null 2>&1 &&
   { [ ! -d "$PI_DIR/node_modules/electron" ] || [ ! -d "$PI_DIR/node_modules/@earendil-works/pi-coding-agent" ]; }; then
  node "$DIR/app-deps-install.mjs" || true
fi

# Overwrite launcher.log each run so failures are easy to read.
exec "$PI_DIR/node_modules/.bin/electron" . > "$DIR/launcher.log" 2>&1
