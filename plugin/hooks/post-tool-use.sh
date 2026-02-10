#!/bin/bash
# post-tool-use.sh — Forward PostToolUse events to Workstation daemon
#
# Called by Claude Code after each tool use. Extracts tool name + file path
# and sends as a tool_use PluginEvent to the daemon via Unix socket.
#
# Privacy boundary: Only tool name + file path + short summary.
# Never file contents or full terminal output.
#
# Stdin: JSON from Claude Code PostToolUse hook
# {
#   "session_id": "...",
#   "tool_name": "Edit",
#   "tool_input": { "file_path": "...", ... },
#   "tool_response": "..."
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

# Extract file path (Read, Edit, Write, NotebookEdit)
FILE_PATH=$(echo "$INPUT" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')

# Extract pattern (Grep, Glob)
PATTERN=$(echo "$INPUT" | grep -o '"pattern"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"pattern"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')

# Extract command (Bash) — first 80 chars only for privacy
COMMAND=$(echo "$INPUT" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"command"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
COMMAND="${COMMAND:0:80}"

# Extract URL (WebFetch)
URL=$(echo "$INPUT" | grep -o '"url"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')

# Extract query (WebSearch)
QUERY=$(echo "$INPUT" | grep -o '"query"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"query"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')

# Build a short path/target for the activity summary
TARGET=""
if [[ -n "$FILE_PATH" ]]; then
  TARGET="$FILE_PATH"
elif [[ -n "$PATTERN" ]]; then
  TARGET="$PATTERN"
elif [[ -n "$COMMAND" ]]; then
  TARGET="$COMMAND"
elif [[ -n "$URL" ]]; then
  TARGET="$URL"
elif [[ -n "$QUERY" ]]; then
  TARGET="$QUERY"
fi

# For interactive tools, extract tool_input for structured forwarding to mobile
# AskUserQuestion: questions + options for selection UI
# ExitPlanMode: plan approval prompt
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

# Build payload — include toolInput for interactive tools
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
    "target": "$TARGET"$PAYLOAD_EXTRA
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
