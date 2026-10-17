#!/usr/bin/env bash
# video-creator skill — one-time toolchain bootstrap (no root required).
# Installs requirements.txt into Pi Scope's shared Python venv
# (~/.pi-scope/.venv), ensures the Chromium build, then runs `video.py doctor`
# to prove the toolchain works.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The one venv every Python-dependent element shares (see
# apps/scope-desktop/pi-python-install.mjs).
VENV="${SCOPE_PYTHON_VENV:-$HOME/.pi-scope/.venv}"
if [ -x "$VENV/Scripts/python.exe" ]; then
  PY="$VENV/Scripts/python.exe"
else
  PY="$VENV/bin/python"
fi

HAVE_UV=0; command -v uv >/dev/null 2>&1 && HAVE_UV=1

echo "→ venv      : $VENV"
echo "→ skill dir : $SKILL_DIR"
if [ "$HAVE_UV" = 1 ]; then
  [ -d "$VENV" ] || uv venv --python 3.12 "$VENV"
  echo "→ installing requirements (pinned)"
  uv pip install --python "$PY" -q -r "$SKILL_DIR/requirements.txt"
else
  [ -d "$VENV" ] || python3 -m venv "$VENV"
  echo "→ installing requirements (pinned, pip)"
  "$PY" -m pip install -q -r "$SKILL_DIR/requirements.txt"
fi

# Reuse the shared browser cache when the pinned revision is already present;
# otherwise download it (PLAYWRIGHT_BROWSERS_PATH is honoured automatically).
echo "→ ensuring Chromium"
"$PY" -m playwright install chromium

echo "→ doctor"
"$PY" "$SKILL_DIR/scripts/video.py" doctor
