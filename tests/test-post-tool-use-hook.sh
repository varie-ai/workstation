#!/bin/bash
# Smoke test for post-tool-use.sh hook
#
# Starts a temporary socket listener (Python), pipes mock PostToolUse JSON
# into the hook, and verifies the PluginEvent JSON arrives at the socket.
#
# Usage: bash tests/test-post-tool-use-hook.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
HOOK="$PROJECT_DIR/plugin/hooks/post-tool-use.sh"

# Use a temp socket to avoid interfering with real daemon
TEST_SOCKET="/tmp/varie-workstation-test-$$.sock"
OUTPUT_FILE="/tmp/post-tool-use-test-output-$$.txt"
DAEMON_INFO_DIR="$HOME/.varie-workstation"
DAEMON_INFO="$DAEMON_INFO_DIR/daemon.json"
DAEMON_INFO_BACKUP=""

cleanup() {
  rm -f "$TEST_SOCKET" "$OUTPUT_FILE"
  # Kill background listener
  if [[ -n "$LISTENER_PID" ]]; then
    kill "$LISTENER_PID" 2>/dev/null || true
    wait "$LISTENER_PID" 2>/dev/null || true
  fi
  # Restore daemon.json
  if [[ -n "$DAEMON_INFO_BACKUP" && -f "$DAEMON_INFO_BACKUP" ]]; then
    mv "$DAEMON_INFO_BACKUP" "$DAEMON_INFO"
  elif [[ -n "$DAEMON_INFO_BACKUP" ]]; then
    rm -f "$DAEMON_INFO"
  fi
}
trap cleanup EXIT

# Backup existing daemon.json if present
if [[ -f "$DAEMON_INFO" ]]; then
  DAEMON_INFO_BACKUP="${DAEMON_INFO}.bak.$$"
  cp "$DAEMON_INFO" "$DAEMON_INFO_BACKUP"
fi

# Write test daemon.json pointing to our test socket
mkdir -p "$DAEMON_INFO_DIR"
cat > "$DAEMON_INFO" <<EOF
{
  "socketPath": "$TEST_SOCKET",
  "pid": $$,
  "startedAt": "2026-01-01T00:00:00Z",
  "version": "test"
}
EOF

# Start a Python Unix socket listener in background
# Accepts one connection, reads one message, writes to OUTPUT_FILE
python3 -c "
import socket, sys, os
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.bind('$TEST_SOCKET')
sock.listen(1)
sock.settimeout(8)
try:
    conn, _ = sock.accept()
    conn.settimeout(3)
    data = b''
    while True:
        try:
            chunk = conn.recv(4096)
            if not chunk:
                break
            data += chunk
        except socket.timeout:
            break
    with open('$OUTPUT_FILE', 'wb') as f:
        f.write(data)
    conn.close()
except socket.timeout:
    pass
finally:
    sock.close()
    try:
        os.unlink('$TEST_SOCKET')
    except:
        pass
" &
LISTENER_PID=$!

# Give listener time to bind
sleep 0.5

# Verify socket exists
if [[ ! -S "$TEST_SOCKET" ]]; then
  echo "FAIL: Test socket not created"
  exit 1
fi

# Mock PostToolUse JSON (like Claude Code would send)
MOCK_INPUT=$(cat <<'ENDJSON'
{
  "session_id": "test-session-abc",
  "tool_name": "Edit",
  "tool_input": {
    "file_path": "/Users/test/project/src/main/index.ts",
    "old_string": "foo",
    "new_string": "bar"
  },
  "tool_response": "File edited successfully",
  "tool_use_id": "toolu_test123"
}
ENDJSON
)

# Run the hook with mock input
echo "$MOCK_INPUT" | bash "$HOOK"

# Wait for background send to arrive
sleep 2

# Wait for listener to finish
wait "$LISTENER_PID" 2>/dev/null || true
LISTENER_PID=""

# Check output
echo ""
echo "=== Post-Tool-Use Hook Smoke Test ==="
echo ""

if [[ ! -s "$OUTPUT_FILE" ]]; then
  echo "FAIL: No data received at socket"
  exit 1
fi

RECEIVED=$(cat "$OUTPUT_FILE")
echo "Received JSON:"
echo "$RECEIVED" | python3 -m json.tool 2>/dev/null || echo "$RECEIVED"
echo ""

# Validate key fields
check_field() {
  local field="$1"
  local expected="$2"
  local actual
  actual=$(echo "$RECEIVED" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d${field})" 2>/dev/null || echo "MISSING")
  if [[ "$actual" == "$expected" ]]; then
    echo "  PASS: ${field} = ${actual}"
  else
    echo "  FAIL: ${field} expected '${expected}', got '${actual}'"
    FAILURES=1
  fi
}

FAILURES=0
check_field "['type']" "tool_use"
check_field "['sessionId']" "test-session-abc"
check_field "['payload']['tool']" "Edit"
check_field "['payload']['target']" "/Users/test/project/src/main/index.ts"

echo ""
if [[ "$FAILURES" -eq 0 ]]; then
  echo "ALL CHECKS PASSED"
else
  echo "SOME CHECKS FAILED"
  exit 1
fi
