#!/bin/bash
# pre-tool-use.sh — Forward PreToolUse events to Workstation daemon
#
# Called by Claude Code BEFORE tool execution when approval is needed.
# Sends an approval_needed event so mobile clients can approve/reject.
#
# Privacy boundary: Only tool name + file path + short summary.
# Never file contents or full terminal output.
#
# Stdin: JSON from Claude Code PreToolUse hook
# {
#   "session_id": "...",
#   "tool_name": "Bash",
#   "tool_input": { "command": "npm install", ... }
# }

set -e

# Socket path
DAEMON_INFO="$HOME/.varie-workstation/daemon.json"
SOCKET="/tmp/varie-workstation.sock"

if [[ -f "$DAEMON_INFO" ]]; then
  SOCKET=$(grep -o '"socketPath"[[:space:]]*:[[:space:]]*"[^"]*"' "$DAEMON_INFO" 2>/dev/null | sed 's/.*"socketPath"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || echo "$SOCKET")
fi

# Exit silently if daemon not running
[[ ! -S "$SOCKET" ]] && exit 0

# Read stdin (Claude Code hook JSON)
INPUT=""
if [[ ! -t 0 ]]; then
  INPUT=$(cat)
fi
[[ -z "$INPUT" ]] && exit 0

# Extract fields using grep/sed (no jq dependency)
SESSION_ID=$(echo "$INPUT" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
TOOL_NAME=$(echo "$INPUT" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')

# Skip if no tool name
[[ -z "$TOOL_NAME" ]] && exit 0

# Extract file path
FILE_PATH=$(echo "$INPUT" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')

# Extract command (Bash) — first 80 chars for privacy
COMMAND=$(echo "$INPUT" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"command"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
COMMAND="${COMMAND:0:80}"

# Build target summary
TARGET=""
if [[ -n "$FILE_PATH" ]]; then
  TARGET="$FILE_PATH"
elif [[ -n "$COMMAND" ]]; then
  TARGET="$COMMAND"
fi

# For interactive tools, extract tool_input so mobile can render the question/plan UI
# PreToolUse has tool_input BEFORE the tool executes — perfect timing for mobile forwarding
TOOL_INPUT_JSON=""
if [[ "$TOOL_NAME" == "AskUserQuestion" || "$TOOL_NAME" == "ExitPlanMode" ]]; then
  TOOL_INPUT_JSON=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(json.dumps(d.get('tool_input', {})))
except:
    print('{}')
" 2>/dev/null || echo '{}')
fi

# Fallback session ID
SID="${SESSION_ID:-${CLAUDE_SESSION_ID:-unknown}}"

# Get project info
PROJECT="$(basename "$PWD")"
PROJECT_PATH="$PWD"

# Escape special chars for JSON
escape_json() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\t'/\\t}"
  echo "$s"
}

TOOL_NAME=$(escape_json "$TOOL_NAME")
TARGET=$(escape_json "$TARGET")
PROJECT=$(escape_json "$PROJECT")

# Build payload — include toolInput for interactive tools (questions, plan approval)
if [[ -n "$TOOL_INPUT_JSON" && "$TOOL_INPUT_JSON" != "{}" ]]; then
  PAYLOAD_EXTRA=", \"toolInput\": $TOOL_INPUT_JSON"
else
  PAYLOAD_EXTRA=""
fi

# Build PluginEvent JSON
JSON=$(cat <<EOF
{
  "type": "tool_use",
  "sessionId": "$SID",
  "timestamp": $(date +%s)000,
  "context": {
    "project": "$PROJECT",
    "projectPath": "$PROJECT_PATH"
  },
  "payload": {
    "tool": "$TOOL_NAME",
    "target": "$TARGET",
    "needsApproval": true$PAYLOAD_EXTRA
  }
}
EOF
)

# Send to daemon in background (non-blocking, fire-and-forget)
# Compact JSON to single line + trailing newline — socket server uses newline-delimited parsing
(
  exec >/dev/null 2>&1
  (echo "$JSON" | tr -d '\n'; echo) | nc -w1 -U "$SOCKET" || true
) </dev/null >/dev/null 2>&1 &

exit 0
