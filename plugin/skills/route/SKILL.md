---
name: route
description: Auto-route a message to the best matching session based on repo name, task ID, or context. This skill is for the Manager session inside Workstation app. If you're in a standalone Claude Code session, suggest the user open the Workstation app and use this skill from the Manager terminal.
arguments: "<query> <message>"
---

# /route

Auto-route a message to the best matching session.

**Context:** This skill is designed for the **Manager session** inside Workstation. If Claude detects it's not in a Manager context (no workstation socket responding), inform the user:
- "This skill works from the Manager session in Workstation."
- "Open the Workstation app and use /route from the Manager terminal."

## When to Use

This is the **primary dispatch skill** for orchestration. Use it when:

- User says "continue the character API work" → route "character API" "resume"
- User says "check status of spine automation" → route "spine" "what's the current status?"
- User wants to send work to a repo without knowing the session ID
- Natural language dispatch to any session

## Arguments

- `<query>` - Search query to match a session (repo name, task ID, or keywords)
- `<message>` - The message to send to the matched session's terminal

## Matching Logic

The workstation uses fuzzy matching to find the best session:

1. **Exact repo name match** (highest priority)
2. **Repo name contains query**
3. **Query contains repo name**
4. **Task ID match**
5. **Path match** (lower priority)
6. **Recency boost** (recently active sessions score higher)

## Implementation

### 1. Send route command

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/workstation-dispatch route "<query>" "<message>"
```

### 2. Handle the response

**Success response:**
```json
{
  "status": "ok",
  "received": "route",
  "targetSessionId": "abc123"
}
```

**Error responses:**
```json
{"status": "error", "message": "No session found matching: xyz"}
{"status": "error", "message": "Missing query in payload"}
```

### 3. Report result to user

**On success:**
```
Routed to session (matched: "<query>")
Session: abc123
Message sent: "<first 50 chars>..."
```

**On no match:**
```
No session found matching "<query>".

Available sessions:
  - webapp (task: user_auth)
  - my-project (task: orchestration)

Would you like me to:
1. Create a new session for this repo?
2. Try a different search query?
```

## Example Usage

### Natural language dispatch

```
User: "Continue the character API work"

Manager interprets:
  - Query: "character API" (from user's words)
  - Message: "resume the work" (inferred intent)

Runs:
  ${CLAUDE_PLUGIN_ROOT}/scripts/workstation-dispatch route "character API" "resume the work"

Response to user:
  Routed to webapp session.
  Sent: "resume the work"
```

### Status check

```
User: "What's happening with spine automation?"

Orchestrator:
  ${CLAUDE_PLUGIN_ROOT}/scripts/workstation-dispatch route "spine" "what's your current status?"
```

### Resume task

```
User: "Let's get back to the infra work"

Orchestrator:
  ${CLAUDE_PLUGIN_ROOT}/scripts/workstation-dispatch route "infra" "/work-resume"
```

## Best Practices

1. **Extract keywords from user intent** - "continue the character API work" → query: "character API"
2. **Infer the message** - If user just wants to resume, send "resume" or "/work-resume"
3. **Be specific in queries** - "character" is better than "char"
4. **Report what was matched** - Tell user which session received the message
5. **Offer alternatives on failure** - If no match, show available sessions

## Notes

- The query doesn't need to be exact - fuzzy matching handles variations
- Recently active sessions are preferred when scores are close
- If no session matches, consider using the UI to create a new one
- The message is sent to the session's terminal as user input
- Auto-created sessions inherit the `skipPermissions` setting from `~/.varie/config.yaml`. Use `/workstation skip-permissions on` to enable autonomous mode for auto-created workers.
