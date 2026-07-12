#!/usr/bin/env bash
# build-release.sh — build a standalone Linux AppImage release of Pi Scope.
# Produces apps/scope-launcher/dist/Pi-Scope-<version>.AppImage.
# The server runs under a bundled portable Node 24 (required for node:sqlite),
# and node-pty is built for that Node's ABI during `npm install`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCHER="$ROOT/apps/scope-launcher"
cd "$LAUNCHER"

NODE_VER="v24.15.0"   # must match the Node that builds node-pty here (same ABI)
NODE_TARBALL="node-${NODE_VER}-linux-x64.tar.xz"
NODE_URL="https://nodejs.org/dist/${NODE_VER}/${NODE_TARBALL}"

echo "[build] installing launcher deps (electron, node-pty, ws, esbuild, electron-builder)..."
npm install --no-audit --no-fund

echo "[build] bundling SCOPE server (TS -> JS; node-pty/ws kept external)..."
mkdir -p server-bundle/public
npx esbuild "$ROOT/apps/scope/server.ts" \
  --bundle --platform=node --target=node22 --format=esm \
  --external:node-pty --external:ws \
  --outfile="$LAUNCHER/server-bundle/server.js"

echo "[build] copying WebUI assets..."
cp -r "$ROOT/apps/scope/public/." "$LAUNCHER/server-bundle/public/"
cp "$ROOT/apps/scope-launcher/icon.png" "$LAUNCHER/server-bundle/icon.png"

echo "[build] provisioning portable Node ($NODE_VER) for the bundled server..."
if [ ! -x "$LAUNCHER/node-portable/bin/node" ]; then
  mkdir -p "$LAUNCHER/node-portable"
  curl -fsSL "$NODE_URL" -o "/tmp/$NODE_TARBALL"
  tar -xJf "/tmp/$NODE_TARBALL" -C "$LAUNCHER/node-portable" --strip-components=1
fi

echo "[build] running electron-builder (linux AppImage)..."
npx electron-builder --linux AppImage --config electron-builder.yml

echo "[build] done -> $LAUNCHER/dist/"
ls -lh "$LAUNCHER/dist/"
