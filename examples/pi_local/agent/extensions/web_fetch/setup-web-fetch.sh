#!/usr/bin/env bash
# Standalone setup for the web-fetch extension package.
# Installs Python deps into Pi Scope's shared venv (~/.pi-scope/.venv) and
# ensures the Chromium browser binary is available — no package-local .venv.
#
# Normally the launcher builds the shared venv (pi-python-install.mjs); this is
# the manual / fallback path. POSIX/macOS. On native Windows run
# setup-web-fetch.ps1 instead.
set -euo pipefail
cd "$(dirname "$0")"   # this package directory

# The one venv every Python-dependent element shares (SCOPE_PYTHON_VENV names
# it when Pi Scope launched us; the default covers a manual run).
VENV="${SCOPE_PYTHON_VENV:-$HOME/.pi-scope/.venv}"

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
