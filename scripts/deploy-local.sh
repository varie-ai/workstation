#!/bin/bash
# deploy-local.sh — Build, package, and deploy Workstation locally
#
# Usage:
#   ./scripts/deploy-local.sh              # Full build + deploy + launch
#   ./scripts/deploy-local.sh --skip-build # Just kill, replace, and launch

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
APP_NAME="Workstation"
RELEASE_DIR="$PROJECT_DIR/release"
DEST_DIR="$HOME/Applications"
SOCKET="/tmp/varie-workstation.sock"

SKIP_BUILD=""
if [[ "$1" == "--skip-build" ]]; then
  SKIP_BUILD="1"
fi

echo "=== Workstation Local Deploy ==="

# Step 1: Build + package (unless skipped)
if [[ -z "$SKIP_BUILD" ]]; then
  echo "→ Building..."
  cd "$PROJECT_DIR"
  npm run build

  echo "→ Packaging macOS app..."
  npm run package:mac
else
  echo "→ Skipping build (--skip-build)"
  if [[ ! -d "$RELEASE_DIR/mac-arm64/$APP_NAME.app" ]]; then
    echo "ERROR: No build found at $RELEASE_DIR/mac-arm64/$APP_NAME.app"
    echo "Run without --skip-build first."
    exit 1
  fi
fi

# Step 2: Kill existing
echo "→ Killing running instances..."
pkill -9 -f "$APP_NAME" 2>/dev/null || true
sleep 0.5

# Step 3: Clean socket
rm -f "$SOCKET"

# Step 4: Replace app
echo "→ Installing to $DEST_DIR..."
rm -rf "$DEST_DIR/$APP_NAME.app"
cp -R "$RELEASE_DIR/mac-arm64/$APP_NAME.app" "$DEST_DIR/"

# Step 5: Launch in background
echo "→ Launching..."
open -g -j "$DEST_DIR/$APP_NAME.app"

echo
echo "=== Deployed: $DEST_DIR/$APP_NAME.app ==="
