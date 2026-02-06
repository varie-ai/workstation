---
name: work-checkpoint
description: Save current work state to persistent checkpoint. Use frequently to track progress, especially after completing steps or before taking breaks.
arguments: ""
---

# /work-checkpoint

Save current work state to persistent checkpoint.

## Implementation Steps

### 1. Verify active session

Check if there's an active session for the current directory:

```bash
# Find session file for current project
PROJECT=$(basename "$PWD")
ls ~/.varie/sessions/*.yaml 2>/dev/null | head -5
```

If no session exists for current project:
```
No active session for this project.
Use /work-start <repo> <task> to begin tracking, or /work-resume to continue existing work.
```

### 2. Gather current state

**Git state:**
```bash
git branch --show-current
git rev-parse --short HEAD
git status --porcelain
```

**Current step info:** Read from session file or infer from recent work.

**Files touched:** From git status modified/new files.

### 3. Build checkpoint YAML

Update or create `~/.varie/sessions/{session_id}.yaml`:

```yaml
session_id: "{id}"
last_active: "{ISO timestamp}"

repo: "{repo_name}"
repo_path: "{full_path}"

task:
  id: "{task_id}"
  name: "{Human Readable Name}"
  archive_path: "archive/{nn}_{task_id}/"

steps:
  - id: "{step_id}"
    name: "{Step Name}"
    status: "completed"  # or in_progress, pending, blocked
    outcome: "{what was done}"
  - id: "{current_step}"
    status: "in_progress"
    notes: "{message or auto-generated}"
    files_touched:
      - "{file1}"
      - "{file2}"

current_step: "{current_step_id}"
next_step: "{next_step_id}"

git_state:
  branch: "{branch}"
  last_commit: "{sha}"
  dirty_files:
    - path: "{file}"
      status: "modified"  # or added, deleted
```

### 4. Update workspace index

Update `~/.varie/workspace.yaml` with session's latest status:

```yaml
active_sessions:
  - session_id: "{id}"
    repo: "{repo}"
    task: "{task_name}"
    current_step: "{step}"
    status: "in_progress"
    last_active: "{timestamp}"
```

### 5. Notify daemon

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/workstation-notify checkpoint --message "{message}"
```

### 6. Output confirmation

```
Checkpoint saved: {session_id}
Task: {Task Name}
Step: {current_step} ({status})
Note: "{message}"
Files: {file1}, {file2}
Git: {branch} (+{N} modified)

Time: {ISO timestamp}
```

## Directory Setup

Ensure directories exist before writing:
```bash
mkdir -p ~/.varie/sessions
```

## Auto-Checkpoint Triggers

This skill should be called:
- After completing a step (mark as completed, move to next)
- When user says "checkpoint", "save progress", "I'm taking a break"
- Before running /work-handover
- When switching to different work

## Example

**User:** "checkpoint - response types done"

**Output:**
```
Checkpoint saved: abc123
Task: Character API Migration
Step: frontend_api_client (in_progress)
Note: "response types done"
Files: src/api/client.ts, src/types/companion.ts
Git: feature/character-api (+2 modified)

Time: 2026-01-30T15:30:00Z
```
