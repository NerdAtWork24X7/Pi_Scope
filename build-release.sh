#!/usr/bin/env bash
# build-release.sh — build a standalone Linux AppImage release of Pi Scope.
# Produces apps/scope-desktop/dist/Pi-Scope-<version>.AppImage.
# The server runs under a bundled portable Node 24 (required for node:sqlite).
#
# Pi Scope keeps no node_modules in the checkout. The app's tooling (Electron,
# electron-builder, esbuild, Playwright) and the server's runtime packages
# (node-pty, ws) live in one shared project in the user's data dir —
# ~/.pi-scope/pi — installed by apps/scope-desktop/app-deps-install.mjs. For the
# packaged app, a runtime-only copy of the Pi agent is bundled as the read-only
# `resources/pi` seed (the `pi-bundle` template below, carrying node-pty built
# for the portable Node's ABI); scope-control.js then seeds ~/.pi-scope/pi from
# it on first launch.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCHER="$ROOT/apps/scope-desktop"
cd "$LAUNCHER"

NODE_VER="v24.15.0"   # must match the Node that builds node-pty here (same ABI)
NODE_TARBALL="node-${NODE_VER}-linux-x64.tar.xz"
NODE_URL="https://nodejs.org/dist/${NODE_VER}/${NODE_TARBALL}"

# The shared install: the whole app's npm project, outside the checkout.
PI_DIR="${SCOPE_PI_BUNDLE_DIR:-$HOME/.pi-scope/pi}"

echo "[build] installing the app project (agent, node-pty, ws, electron, esbuild, electron-builder) into $PI_DIR..."
node "$LAUNCHER/app-deps-install.mjs"

ESBUILD="$PI_DIR/node_modules/.bin/esbuild"
ELECTRON_BUILDER="$PI_DIR/node_modules/.bin/electron-builder"
[ -x "$ESBUILD" ] || { echo "[build] missing $ESBUILD — run apps/scope-desktop/app-deps-install.mjs" >&2; exit 1; }
[ -x "$ELECTRON_BUILDER" ] || { echo "[build] missing $ELECTRON_BUILDER — run apps/scope-desktop/app-deps-install.mjs" >&2; exit 1; }

# Pre-install a runtime-only copy of the Pi coding agent (with node-pty and ws)
# so the packaged app can seed the user's copy (~/.pi-scope/pi) on first launch
# with no network and no system npm. This is the one build artifact that
# materializes under the checkout; it is removed again by the cleanup at the end.
# The app never runs from resources/pi directly: that copy is read-only, so
# Settings → Update could not replace it.
echo "[build] bundling the Pi coding agent and server packages (pi-bundle seed)..."
( cd "$LAUNCHER/pi-bundle" && npm install --no-audit --no-fund )
# Ship the Pi Scope extension inside the seed so the seeded `pi` shim can
# force-load it without depending on the user's global pi configuration.
cp "$ROOT/extension/pi-scope.ts" "$LAUNCHER/pi-bundle/pi-scope.ts"

# The agent extensions' dependency manifest travels beside the app (not inside
# the pi seed): scope-control.js hands it to pi-extensions-install.mjs as the
# declaration for an agent dir that was seeded before the manifest existed —
# those dirs are never re-seeded, so it is the only way their extensions get
# their packages installed.
echo "[build] copying the extensions dependency manifest..."
cp "$ROOT/examples/pi_local/agent/extensions/package.json" "$LAUNCHER/agent-extensions.json"

# node-pty/ws are loaded at runtime from the bundled pi agent (~/.pi-scope/pi,
# see apps/scope-server/pi-deps.ts), so they are not imported here at all.
echo "[build] bundling SCOPE server (TS -> JS)..."
mkdir -p server-bundle/public server-bundle/plugins
"$ESBUILD" "$ROOT/apps/scope-server/server.ts" \
  --bundle --platform=node --target=node22 --format=esm \
  --outfile="$LAUNCHER/server-bundle/server.js"

echo "[build] copying WebUI assets..."
cp -r "$ROOT/apps/scope-server/public/." "$LAUNCHER/server-bundle/public/"
# The built-in plugins (feature server modules + their client bundles, e.g. the
# Office view) are loaded from disk at runtime, so they travel beside server.js.
# plugins.ts resolves BUILTIN_DIR next to the host module for exactly this.
cp -r "$ROOT/apps/scope-server/plugins/." "$LAUNCHER/server-bundle/plugins/"
cp "$ROOT/apps/scope-desktop/icon.png" "$LAUNCHER/server-bundle/icon.png"

echo "[build] writing server-bundle/package.json (type:module) to silence ESM warning..."
printf '{"type":"module"}\n' > "$LAUNCHER/server-bundle/package.json"

echo "[build] provisioning portable Node ($NODE_VER) for the bundled server..."
if [ ! -x "$LAUNCHER/node-portable/bin/node" ]; then
  mkdir -p "$LAUNCHER/node-portable"
  curl -fsSL "$NODE_URL" -o "/tmp/$NODE_TARBALL"
  tar -xJf "/tmp/$NODE_TARBALL" -C "$LAUNCHER/node-portable" --strip-components=1
fi

echo "[build] running electron-builder (linux AppImage)..."
"$ELECTRON_BUILDER" --linux AppImage --config electron-builder.yml

# Clean up intermediate build files, keeping the final AppImage and the
# node-portable cache (so the next build skips re-downloading portable Node).
# The pi-bundle seed's node_modules is deleted too: the checkout keeps no
# node_modules — the shared install in ~/.pi-scope/pi is the only real tree.
echo "[build] cleaning up intermediate build files..."
rm -rf "$LAUNCHER/server-bundle"
rm -rf "$LAUNCHER/pi-bundle/node_modules" "$LAUNCHER/pi-bundle/pi-scope.ts"
rm -f "$LAUNCHER/agent-extensions.json"
if [ -d "$LAUNCHER/dist" ]; then
  # drop linux-unpacked/, builder-*.yml metadata, blockmaps, etc. — keep *.AppImage
  find "$LAUNCHER/dist" -mindepth 1 -maxdepth 1 ! -name '*.AppImage' -exec rm -rf {} +
fi

echo "[build] done -> $LAUNCHER/dist/"
ls -lh "$LAUNCHER/dist/"
