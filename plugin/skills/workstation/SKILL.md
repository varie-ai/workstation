---
name: workstation
description: Configure Workstation settings. Use to enable/disable auto-launch, check status, or launch the workstation app.
arguments: "[subcommand]"
---

# /workstation

Configure and manage Workstation.

## Subcommands

- `/workstation` — Show current status and settings
- `/workstation autolaunch on` — Enable auto-launch on Claude Code start
- `/workstation autolaunch off` — Disable auto-launch (default)
- `/workstation skip-permissions on` — Enable `--dangerously-skip-permissions` for all sessions
- `/workstation skip-permissions off` — Disable skip-permissions (default)
- `/workstation launch` — Launch the workstation app now
- `/workstation open` — Alias for launch

## Implementation

### Parse subcommand

The argument comes as a single string. Parse the first word as subcommand:

```bash
ARGS="$1"  # e.g., "autolaunch on" or "" or "launch"
SUBCOMMAND=$(echo "$ARGS" | awk '{print $1}')
SUBARG=$(echo "$ARGS" | awk '{print $2}')
```

### Handle each subcommand

**No args or "status"** — Show current config:

```bash
CONFIG_FILE="$HOME/.varie/config.yaml"
SOCKET="/tmp/varie-workstation.sock"

# Check if running - test actual socket connectivity, not just file existence
RUNNING="no"
if [[ -S "$SOCKET" ]]; then
  # Try to connect and send a ping - if it responds, workstation is running
  RESPONSE=$(echo '{"type":"ping"}' | nc -U -w1 "$SOCKET" 2>/dev/null || true)
  if [[ -n "$RESPONSE" ]]; then
    RUNNING="yes"
  else
    # Socket exists but not responding - stale socket
    RUNNING="no (stale socket)"
  fi
fi

# Check autoLaunch setting
if [[ -f "$CONFIG_FILE" ]] && grep -q 'autoLaunch:[[:space:]]*true' "$CONFIG_FILE"; then
  AUTO_LAUNCH="enabled"
else
  AUTO_LAUNCH="disabled"
fi

# Check skipPermissions setting
if [[ -f "$CONFIG_FILE" ]] && grep -q 'skipPermissions:[[:space:]]*true' "$CONFIG_FILE"; then
  SKIP_PERMS="enabled"
else
  SKIP_PERMS="disabled"
fi

# Check if packaged app is installed
INSTALLED="no"
if [[ -d "/Applications/Workstation.app" ]] || [[ -d "$HOME/Applications/Workstation.app" ]]; then
  INSTALLED="yes"
fi

echo "Workstation"
echo "  Running: $RUNNING"
echo "  Installed: $INSTALLED"
echo "  Auto-launch: $AUTO_LAUNCH"
echo "  Skip permissions: $SKIP_PERMS"
echo ""
echo "Commands:"
echo "  /workstation autolaunch on        - Enable auto-launch (requires installed app)"
echo "  /workstation autolaunch off       - Disable auto-launch"
echo "  /workstation skip-permissions on  - Enable --dangerously-skip-permissions for sessions"
echo "  /workstation skip-permissions off - Disable skip-permissions"
echo "  /workstation launch               - Launch workstation now"
if [[ "$INSTALLED" == "no" ]]; then
  echo ""
  echo "Note: Auto-launch requires the packaged app."
  echo "For development, run manually: cd varie-workstation && npm run dev"
fi
```

**"autolaunch on"** — Enable auto-launch:

```bash
CONFIG_FILE="$HOME/.varie/config.yaml"
mkdir -p "$HOME/.varie"

if [[ -f "$CONFIG_FILE" ]]; then
  # Update existing file
  if grep -q 'autoLaunch:' "$CONFIG_FILE"; then
    sed -i '' 's/autoLaunch:.*/autoLaunch: true/' "$CONFIG_FILE"
  else
    echo "autoLaunch: true" >> "$CONFIG_FILE"
  fi
else
  # Create new file
  echo "autoLaunch: true" > "$CONFIG_FILE"
fi
echo "Auto-launch enabled. Workstation will start with Claude Code."
```

**"autolaunch off"** — Disable auto-launch:

```bash
CONFIG_FILE="$HOME/.varie/config.yaml"
if [[ -f "$CONFIG_FILE" ]]; then
  if grep -q 'autoLaunch:' "$CONFIG_FILE"; then
    sed -i '' 's/autoLaunch:.*/autoLaunch: false/' "$CONFIG_FILE"
  fi
fi
echo "Auto-launch disabled."
```

**"skip-permissions on"** — Enable skip-permissions for all new sessions:

**IMPORTANT: Before running the bash command below, you MUST warn the user with this message:**

> **Warning:** This enables `--dangerously-skip-permissions` for all new Claude sessions in the Workstation app. Sessions will execute commands — file edits, shell commands, deletions — without asking for approval. Already-running sessions are not affected.
>
> Only enable this if you're comfortable with fully autonomous operation and have version control in place. You can disable it anytime with `/workstation skip-permissions off`.
>
> Proceed?

**Wait for the user to confirm before running the command.** If they say no, do not run it.

```bash
CONFIG_FILE="$HOME/.varie/config.yaml"
mkdir -p "$HOME/.varie"

if [[ -f "$CONFIG_FILE" ]]; then
  if grep -q 'skipPermissions:' "$CONFIG_FILE"; then
    sed -i '' 's/skipPermissions:.*/skipPermissions: true/' "$CONFIG_FILE"
  else
    echo "skipPermissions: true" >> "$CONFIG_FILE"
  fi
else
  echo "skipPermissions: true" > "$CONFIG_FILE"
fi
echo "Skip-permissions enabled. New sessions will use --dangerously-skip-permissions."
```

**"skip-permissions off"** — Disable skip-permissions:

```bash
CONFIG_FILE="$HOME/.varie/config.yaml"
if [[ -f "$CONFIG_FILE" ]]; then
  if grep -q 'skipPermissions:' "$CONFIG_FILE"; then
    sed -i '' 's/skipPermissions:.*/skipPermissions: false/' "$CONFIG_FILE"
  fi
fi
echo "Skip-permissions disabled. New sessions will use default permission mode."
```

**"launch" or "open"** — Launch workstation:

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/ensure-workstation-running
echo "Workstation launching..."
```

## Example Usage

```
User: "/workstation"
→ Shows status: Running: no, Auto-launch: disabled, Skip permissions: disabled

User: "/workstation autolaunch on"
→ "Auto-launch enabled. Workstation will start with Claude Code."

User: "/workstation skip-permissions on"
→ "Skip-permissions enabled. New sessions will use --dangerously-skip-permissions."

User: "/workstation skip-permissions off"
→ "Skip-permissions disabled. New sessions will use default permission mode."

User: "/workstation launch"
→ Launches the workstation app
```

## Notes

- Config stored in `~/.varie/config.yaml`
- Auto-launch is disabled by default (non-intrusive)
- Skip-permissions is disabled by default (safe by default)
- When skip-permissions is enabled, new sessions start with `--dangerously-skip-permissions`
- Existing sessions are not affected — only new sessions pick up the setting
- The workstation is a heavy app; users should opt-in to auto-launch
