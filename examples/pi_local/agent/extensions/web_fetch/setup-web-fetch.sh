#!/usr/bin/env bash
# Standalone setup for the web-fetch extension package.
# Installs Python deps into the shared venv beside the `pi` agent dir (under Pi
# Scope: ~/.pi-scope/.venv; under a global pi: ~/.pi/.venv) and ensures the
# Chromium browser binary is available — no package-local .venv.
#
# Normally the launcher builds the shared venv (pi-python-install.mjs); this is
# the manual / fallback path. POSIX/macOS. On native Windows run
# setup-web-fetch.ps1 instead.
set -euo pipefail
cd "$(dirname "$0")"   # this package directory

# The one venv every Python-dependent element shares. Derive its base from the
# agent dir (PI_CODING_AGENT_DIR is set by Pi Scope's shim; a global `pi` uses
# ~/.pi/agent by default) so the same script works under either. SCOPE_PYTHON_VENV
# names the venv directly when Pi Scope launched us.
AGENT_DIR="${PI_CODING_AGENT_DIR:-${SCOPE_AGENT_DIR:-$HOME/.pi/agent}}"
BASE_DIR="$(dirname "$AGENT_DIR")"
VENV="${SCOPE_PYTHON_VENV:-$BASE_DIR/.venv}"
# Keep Playwright's Chromium in the shared browsers dir (not ~/.cache/ms-playwright)
# so it matches what the launcher installs.
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$BASE_DIR/playwright-browsers}"

# The venv interpreter lives in bin/ on POSIX but Scripts/ on Windows, so a
# Windows venv reached through Git-Bash/MSYS resolves too.
if [ -x "$VENV/bin/python3" ]; then
  PY="$VENV/bin/python3"
elif [ -x "$VENV/Scripts/python.exe" ]; then
  PY="$VENV/Scripts/python.exe"
else
  PY=""
fi

if [ -z "$PY" ]; then
  echo "Creating shared venv at $VENV ..."
  uv venv --python 3.12 "$VENV"
  if [ -x "$VENV/bin/python3" ]; then
    PY="$VENV/bin/python3"
  elif [ -x "$VENV/Scripts/python.exe" ]; then
    PY="$VENV/Scripts/python.exe"
  else
    echo "error: no interpreter produced in $VENV" >&2
    exit 1
  fi
fi

echo "Installing Python dependencies into $VENV ..."
uv pip install --python "$PY" -r requirements.txt

echo "Ensuring Chromium browser is installed ..."
"$PY" -m playwright install chromium

echo "Done. The web-fetch extension now runs from the shared venv at $VENV."
