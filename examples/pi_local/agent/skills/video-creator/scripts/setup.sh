#!/usr/bin/env bash
# video-creator skill — one-time toolchain bootstrap (no root required).
# Installs requirements.txt into the shared Python venv beside the agent dir
# (under Pi Scope: ~/.pi-scope/.venv; under a global pi: ~/.pi/.venv), ensures
# the Chromium build, then runs `video.py doctor` to prove the toolchain works.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The one venv every Python-dependent element shares (see
# apps/scope-desktop/pi-python-install.mjs). Derive its base from the agent dir
# so the same script works under Pi Scope and a global pi.
AGENT_DIR="${PI_CODING_AGENT_DIR:-${SCOPE_AGENT_DIR:-$HOME/.pi/agent}}"
BASE_DIR="$(dirname "$AGENT_DIR")"
VENV="${SCOPE_PYTHON_VENV:-$BASE_DIR/.venv}"
# Keep Playwright's Chromium in the shared browsers dir, matching the launcher.
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$BASE_DIR/playwright-browsers}"
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
# otherwise download it into PLAYWRIGHT_BROWSERS_PATH (the shared dir, set above).
echo "→ ensuring Chromium"
"$PY" -m playwright install chromium

echo "→ doctor"
"$PY" "$SKILL_DIR/scripts/video.py" doctor
