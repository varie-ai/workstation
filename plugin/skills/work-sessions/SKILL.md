---
name: work-sessions
description: List all active sessions in the Workstation. This skill is for the Manager session inside Workstation app. If you're in a standalone Claude Code session, suggest the user open the Workstation app and use this skill from the Manager terminal.
arguments: ""
---

# /work-sessions

List all active sessions and project status in Workstation.

**Context:** This skill is designed for the **Manager session** inside Workstation. If Claude detects it's not in a Manager context (no workstation socket responding), inform the user:
- "This skill works from the Manager session in Workstation."
- "Open the Workstation app and use /work-sessions from the Manager terminal."

## When to Use

- See what sessions are running and their status
- Get session IDs for direct dispatch
- Overview of all tracked projects
- Before dispatching work

## Implementation

### 1. Query active sessions from daemon

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/workstation-dispatch list-workers
```

Response:
```json
{
  "status": "ok",
  "sessions": [
    {
      "sessionId": "abc123",
      "repo": "webapp",
      "repoPath": "/path/to/repo",
      "taskId": "feature_name",
      "lastActive": "2026-01-31T14:30:00Z",
      "workContext": "Implementing user auth API | Writing tests for login endpoint"
    }
  ]
}
```

The `workContext` field contains a brief snippet of recent session activity (from terminal output). Use it to give the user a sense of what each session is doing without switching to it.

### 2. Read projects index

```bash
cat ~/.varie/manager/projects.yaml
```

### 3. For each project with a path, check latest work

```bash
# Find latest archive entry
ls -t <repo>/archive/ | head -1

# Read HANDOVER.md for current status
cat <repo>/archive/<latest>/HANDOVER.md | head -30
```

### 4. Format combined output

```
## Active Sessions

| ID | Repo | Task | Last Active | Working On |
|----|------|------|-------------|------------|
| abc123 | webapp | user_auth | 5 min ago | Writing tests for login endpoint |
| def456 | varie | auth_refactor | 30 min ago | Refactoring middleware chain |

## Projects Overview

| Project | Path | Latest Feature | Status |
|---------|------|----------------|--------|
| webapp | ~/projects/webapp | 03_user_auth | Step 3/5 in progress |
| varie | ~/projects/varie | 02_auth | Completed |
| data-pipeline | ~/projects/data-pipeline | - | No archive |

Use:
- /dispatch <id> <message> - Send to specific session
- /route <repo> <message> - Auto-route to repo
- /project <name> - Detailed project view
```

## If No Daemon Running

Show projects overview only (without active sessions).

## If No Projects Configured

```
No projects configured in ~/.varie/manager/projects.yaml

Add projects:
```yaml
projects:
  my_project:
    path: /path/to/repo
    status: active
```

Or use /route to auto-create sessions.
```

## Example

User: "What's the status across my work?"

```
## Active Sessions

| ID | Repo | Last Active |
|----|------|-------------|
| ml2abc | webapp | 2 min ago |

## Projects Overview

| Project | Latest Feature | Status |
|---------|----------------|--------|
| webapp | 03_user_auth | In progress - "Working on response types" |
| my-project | 01_initial_planning | Phase C1 complete |

2 active sessions across 2 projects.
```
