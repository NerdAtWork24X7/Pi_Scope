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

# Install the .desktop into the user applications dir (idempotent) so the DE
# can match this window's WM_CLASS to its icon in the dock/taskbar.
APPS_DIR="$HOME/.local/share/applications"
mkdir -p "$APPS_DIR"
DESKTOP_SRC="$DIR/pi-scope.desktop"
DESKTOP_DST="$APPS_DIR/pi-scope.desktop"
if [ ! -f "$DESKTOP_DST" ] || ! cmp -s "$DESKTOP_SRC" "$DESKTOP_DST"; then
  cp "$DESKTOP_SRC" "$DESKTOP_DST"
fi

# Also install an identical copy on the Desktop shortcut (idempotent) so the
# icon renders there too. XDG_DESKTOP_DIR falls back to ~/Desktop.
DESKTOP_DIR="${XDG_DESKTOP_DIR:-$HOME/Desktop}"
mkdir -p "$DESKTOP_DIR"
DESKTOP_SHORTCUT="$DESKTOP_DIR/pi-scope.desktop"
if [ ! -f "$DESKTOP_SHORTCUT" ] || ! cmp -s "$DESKTOP_SRC" "$DESKTOP_SHORTCUT"; then
  cp "$DESKTOP_SRC" "$DESKTOP_SHORTCUT"
  chmod +x "$DESKTOP_SHORTCUT"
fi

# Install electron on first run (idempotent).
if [ ! -d node_modules/electron ]; then
  npm install --no-audit --no-fund
fi

# Overwrite launcher.log each run so failures are easy to read.
exec npx electron . > "$DIR/launcher.log" 2>&1
