---
name: work-status
description: Show status of all active tasks across repos. Use when user asks "what's the status", "what am I working on", or to get overview of active work.
arguments: ""
---

# /work-status

Show unified status of all active tasks across repos.

## Implementation Steps

### 1. Check if workspace exists

```bash
ls -la ~/.varie/workspace.yaml ~/.varie/sessions/ 2>/dev/null
```

If `~/.varie/` doesn't exist, output:
```
No active workstation sessions found.
Use /work-start <repo> <task> to begin tracking work.
```

### 2. Read workspace state

Read `~/.varie/workspace.yaml` to get list of known repos and active sessions.

### 3. Read session checkpoints

For each session in `~/.varie/sessions/*.yaml`:
- Extract: repo, task name, current step, status, last_active timestamp
- Calculate time since last activity

### 4. Format output

**Default format (compact):**
```
Active Tasks (N):

| Repo            | Task                    | Current Step         | Status  | Last Active |
|-----------------|-------------------------|----------------------|---------|-------------|
| webapp | Character API Migration | frontend_api_client  | working | 5 min ago   |
| ml-pipeline     | Data Processing Fix     | stage_3b_integration | working | 30 min ago  |
```

**Verbose format (--verbose):**
For each task, show:
- Full step list with status markers: [✓] done, [→] current, [ ] pending
- Current step notes
- Files touched
- Git branch

**Filtered format (--repo):**
Show only tasks matching the specified repo.

### 5. Notify daemon (optional)

If daemon socket exists, send status_request event:
```bash
${CLAUDE_PLUGIN_ROOT}/scripts/workstation-notify status-request
```

## Example Outputs

### No sessions
```
No active workstation sessions found.
Use /work-start <repo> <task> to begin tracking work.
```

### Default output
```
Active Tasks (2):

| Repo            | Task                    | Step                | Status  | Last Active |
|-----------------|-------------------------|---------------------|---------|-------------|
| webapp | Character API Migration | frontend_api_client | working | 5 min ago   |
| my-project | Communication Protocol | design_complete   | idle    | 2 hours ago |

Most recent: webapp
```

### Verbose output
```
═══ webapp: Character API Migration ═══
Session: abc123 | Branch: feature/character-api
Started: 2h ago | Last active: 5 min ago

Steps:
  [✓] update_api_contract — "Added /companions endpoint"
  [✓] backend_implementation — "Handler + 5 tests"
  [→] frontend_api_client — "Working on response types"
  [ ] frontend_components
  [ ] integration_test

Files: src/api/client.ts, src/types/companion.ts
```
