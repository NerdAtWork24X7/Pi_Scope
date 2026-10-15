#!/usr/bin/env bash
# Standalone setup for the web-fetch extension package.
# Installs Python deps into this package's local .venv and ensures the
# Chromium browser binary is available — no global `crwl`/venv required.
#
# POSIX/macOS. On native Windows run setup-web-fetch.ps1 instead.
set -euo pipefail
cd "$(dirname "$0")"   # this package directory

VENV=".venv"

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
  echo "Creating venv at $VENV ..."
  uv venv --python 3.12
  if [ -x "$VENV/bin/python3" ]; then
    PY="$VENV/bin/python3"
  elif [ -x "$VENV/Scripts/python.exe" ]; then
    PY="$VENV/Scripts/python.exe"
  else
    echo "error: no interpreter produced in $VENV" >&2
    exit 1
  fi
fi

echo "Installing Python dependencies ..."
uv pip install --upgrade pip
uv pip install -r requirements.txt

echo "Ensuring Chromium browser is installed ..."
"$PY" -m playwright install chromium

echo "Done. The web-fetch extension now runs from this package's .venv."
