#!/usr/bin/env bash
#
# setup.sh — extract the bundled Obscura binaries from their tarballs.
#
# The raw executables (obscura, obscura-worker) are git-ignored because they
# exceed GitHub's 100 MB file limit, so the compressed tarballs are committed
# instead. Run this script once after cloning to produce the runnable binaries
# that agent/extensions/obscura/index.ts expects alongside this file.
#
# POSIX only, and only useful on Linux: both tarballs contain Linux x86_64 ELF
# binaries, and index.ts stays inert on macOS/Windows (see its header). On
# Windows, extract manually with the built-in tar:  tar -xzf obscura.tar.gz
#
# Usage:
#   ./setup.sh          extract only if a binary is missing
#   ./setup.sh --force  re-extract even if binaries already exist

set -euo pipefail

# Resolve this script's directory (handles symlinks).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# binary_name:tarball_name
PAIRS=(
  "obscura:obscura.tar.gz"
  "obscura-worker:obscura-worker.tar.gz"
)

FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

for pair in "${PAIRS[@]}"; do
  bin="${pair%%:*}"
  tar="${pair##*:}"
  tar_path="$SCRIPT_DIR/$tar"
  bin_path="$SCRIPT_DIR/$bin"

  if [[ ! -f "$tar_path" ]]; then
    echo "skip: tarball not found: $tar_path" >&2
    continue
  fi

  if [[ -x "$bin_path" && $FORCE -eq 0 ]]; then
    echo "ok: $bin already extracted (use --force to overwrite)"
    continue
  fi

  echo "extracting: $tar -> $bin"
  tar xzf "$tar_path" -C "$SCRIPT_DIR"
  chmod +x "$bin_path"

  if [[ ! -x "$bin_path" ]]; then
    echo "error: failed to produce executable: $bin_path" >&2
    exit 1
  fi
  echo "done: $bin"
done

echo "Obscura binaries ready in: $SCRIPT_DIR"
