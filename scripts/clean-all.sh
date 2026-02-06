#!/bin/bash
# clean-all.sh - Complete cleanup for fresh Workstation testing
#
# Removes:
# - Running Workstation processes
# - Installed app (~/Applications, /Applications)
# - Plugin cache and installation
# - Workstation data (~/.varie/)
# - Electron app data
# - Unix socket
#
# Does NOT remove:
# - Source code (this repo)
# - Injected CLAUDE.md sections in other repos (manual cleanup needed)

set -e

echo "=== Workstation Complete Cleanup ==="
echo ""
echo "This will remove:"
echo "  - Workstation.app from ~/Applications and /Applications"
echo "  - Plugin from ~/.claude/plugins/"
echo "  - All data from ~/.varie/"
echo "  - Electron data from ~/Library/Application Support/"
echo "  - Socket at /tmp/varie-workstation.sock"
echo ""
read -p "Continue? (y/N) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Cancelled."
  exit 0
fi

echo ""

# 1. Kill running processes (use bundle ID to be specific)
echo "[1/6] Killing running processes..."
# Kill by bundle identifier (safest, won't affect other Electron apps)
osascript -e 'quit app id "ai.varie.workstation"' 2>/dev/null || true
# Fallback: kill by exact app name in Applications folder
pkill -f "/Applications/Workstation.app" 2>/dev/null || true
pkill -f "$HOME/Applications/Workstation.app" 2>/dev/null || true
pkill -f "/Applications/Varie Workstation.app" 2>/dev/null || true  # Old name
pkill -f "$HOME/Applications/Varie Workstation.app" 2>/dev/null || true  # Old name
sleep 1

# 2. Remove installed apps
echo "[2/6] Removing installed apps..."
rm -rf "$HOME/Applications/Workstation.app" 2>/dev/null || true
rm -rf "$HOME/Applications/Varie Workstation.app" 2>/dev/null || true  # Old name
rm -rf "/Applications/Workstation.app" 2>/dev/null || true
rm -rf "/Applications/Varie Workstation.app" 2>/dev/null || true  # Old name
echo "  Removed apps"

# 3. Remove plugin
echo "[3/6] Removing plugin..."
rm -rf "$HOME/.claude/plugins/cache/workstation-local" 2>/dev/null || true
rm -rf "$HOME/.claude/plugins/cache/varie-workstation" 2>/dev/null || true
# Remove from installed plugins list if present
if [[ -f "$HOME/.claude/plugins/installed.json" ]]; then
  # Create backup
  cp "$HOME/.claude/plugins/installed.json" "$HOME/.claude/plugins/installed.json.bak"
  # Remove workstation entries (simple grep -v approach)
  grep -v "workstation" "$HOME/.claude/plugins/installed.json.bak" > "$HOME/.claude/plugins/installed.json" 2>/dev/null || true
fi
echo "  Removed plugin cache"

# 4. Remove workstation data (specific files only, preserves other varie apps)
echo "[4/6] Removing workstation data from ~/.varie/..."
if [[ -d "$HOME/.varie" ]]; then
  # Only remove workstation-specific items
  rm -rf "$HOME/.varie/manager" 2>/dev/null && echo "  Removed ~/.varie/manager/"
  rm -rf "$HOME/.varie/sessions" 2>/dev/null && echo "  Removed ~/.varie/sessions/"
  rm -f "$HOME/.varie/config.yaml" 2>/dev/null && echo "  Removed ~/.varie/config.yaml"
  rm -f "$HOME/.varie/llm-config.yaml" 2>/dev/null && echo "  Removed ~/.varie/llm-config.yaml"
  rm -f "$HOME/.varie/.statusline-configured" 2>/dev/null && echo "  Removed ~/.varie/.statusline-configured"
  # Remove ~/.varie/ only if empty
  rmdir "$HOME/.varie" 2>/dev/null && echo "  Removed empty ~/.varie/" || echo "  ~/.varie/ kept (has other files)"
else
  echo "  ~/.varie/ not found (already clean)"
fi

# 5. Remove Electron app data
echo "[5/6] Removing Electron app data..."
rm -rf "$HOME/Library/Application Support/Workstation" 2>/dev/null || true
rm -rf "$HOME/Library/Application Support/Varie Workstation" 2>/dev/null || true  # Old name
rm -rf "$HOME/Library/Application Support/varie-workstation" 2>/dev/null || true
rm -rf "$HOME/Library/Caches/Workstation" 2>/dev/null || true
rm -rf "$HOME/Library/Caches/Varie Workstation" 2>/dev/null || true
rm -rf "$HOME/Library/Preferences/ai.varie.workstation.plist" 2>/dev/null || true
echo "  Removed Electron data"

# 6. Remove socket
echo "[6/6] Removing socket..."
rm -f /tmp/varie-workstation.sock 2>/dev/null || true
echo "  Removed socket"

echo ""
echo "=== Cleanup Complete ==="
echo ""
echo "Remaining manual steps (if needed):"
echo "  1. Remove '## Workstation' sections from CLAUDE.md in test repos"
echo "  2. Restart Claude Code to clear any cached plugin state"
echo ""
echo "To reinstall fresh:"
echo "  1. ./scripts/rebuild-mac.sh    # Build and install app"
echo "  2. In Claude Code: /plugin add <path-to-plugin>"
echo ""
