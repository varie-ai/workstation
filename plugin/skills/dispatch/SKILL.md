---
name: dispatch
description: Send a message/command to a specific session by ID. This skill is for the Manager session inside Workstation app. If you're in a standalone Claude Code session, suggest the user open the Workstation app and use this skill from the Manager terminal.
arguments: "<session-id> <message>"
---

# /dispatch

Send a message directly to a specific session.

**Context:** This skill is designed for the **Manager session** inside Workstation. If Claude detects it's not in a Manager context (no workstation socket responding), inform the user:
- "This skill works from the Manager session in Workstation."
- "Open the Workstation app and use /dispatch from the Manager terminal."

## When to Use

- When you have the exact session ID (from /work-sessions)
- When you want precise control over which session receives the message
- For follow-up messages to a session you've already identified

For fuzzy matching by repo name or task, use `/route` instead.

## Arguments

- `<session-id>` - The session ID (from /work-sessions output)
- `<message>` - The message to send to the session's terminal

## Implementation

### 1. Send dispatch command

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/workstation-dispatch dispatch "<session-id>" "<message>"
```

### 2. Handle the response

**Success response:**
```json
{
  "status": "ok",
  "received": "dispatch",
  "targetSessionId": "abc123"
}
```

**Error responses:**
```json
{"status": "error", "message": "Session not found: xyz789"}
{"status": "error", "message": "Cannot dispatch to external session"}
```

### 3. Report result to user

**On success:**
```
Dispatched to session abc123.
Message sent: "<first 50 chars of message>..."
```

**On error:**
```
Failed to dispatch: <error message>

Use /work-sessions to see available sessions.
```

## Example Usage

```
User: "Send 'check the API status' to session abc123"

Manager runs:
  ${CLAUDE_PLUGIN_ROOT}/scripts/workstation-dispatch dispatch "abc123" "check the API status"

Response:
  Dispatched to session abc123.
  Message sent: "check the API status"
```

## Creating New Sessions

`/dispatch` only sends to **existing** sessions. If you need to create a new session, you have two options:

1. **`/route`** — Auto-creates a first session on a repo if none exists
2. **`create-worker`** — Explicitly creates a session (use for additional sessions on a repo that already has one)

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/workstation-dispatch create-worker <repo> <repo-path> <task-name>
```

Always provide a **task name** when creating additional sessions so they can be differentiated.

## Notes

- The message is written to the session's terminal as if typed by a user
- The session's Claude Code will process it as a new prompt
- Use /work-sessions first to find valid session IDs
- For auto-routing, use /route instead
- Session permission mode is set at creation time. To configure default permissions for new sessions, use `/workstation skip-permissions on/off`.
