#!/bin/bash
# rebuild-mac.sh - Clean rebuild and install Workstation for macOS
#
# This script:
# 1. Kills any running Workstation instances
# 2. Cleans up old builds
# 3. Rebuilds the macOS app
# 4. Copies the new build to ~/Applications/

set -e  # Exit on error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
APP_NAME="Workstation"
RELEASE_DIR="$PROJECT_DIR/release"
DEST_DIR="$HOME/Applications"

echo "=== Workstation macOS Rebuild ==="
echo "Project: $PROJECT_DIR"
echo ""

# Step 1: Kill running instances
echo "[1/5] Killing running instances..."
pkill -f "Workstation" 2>/dev/null || true
# Give it a moment to fully terminate
sleep 1

# Step 2: Clean up socket/daemon files
echo "[2/5] Cleaning up daemon files..."
rm -f /tmp/varie-workstation.sock
rm -f ~/.varie-workstation/daemon.json

# Step 3: Clean old builds
echo "[3/5] Cleaning old builds..."
rm -rf "$RELEASE_DIR"
rm -rf "$PROJECT_DIR/dist"

# Step 4: Rebuild
echo "[4/5] Building macOS app (this may take a minute)..."
cd "$PROJECT_DIR"
npm run package:mac

# Step 5: Copy to Applications
echo "[5/5] Installing to $DEST_DIR..."
# Remove old app if exists
rm -rf "$DEST_DIR/$APP_NAME.app"
# Copy new app
cp -R "$RELEASE_DIR/mac-arm64/$APP_NAME.app" "$DEST_DIR/"

echo ""
echo "=== Done! ==="
echo "Installed: $DEST_DIR/$APP_NAME.app"
echo ""
echo "To launch: open \"$DEST_DIR/$APP_NAME.app\""
echo "Or click the app in Finder/Launchpad"
