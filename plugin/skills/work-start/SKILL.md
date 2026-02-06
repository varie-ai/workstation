---
name: work-start
description: Initialize a new task with proper context loading and archive setup. Use when starting fresh work on a feature, bug fix, or project.
arguments: "task_name"
---

# /work-start

Initialize a new task with proper context loading and archive setup.

## Implementation Steps

### 1. Determine repo and validate

Get current repo from working directory:
```bash
basename "$PWD"
```

Verify it's a valid project directory (has CLAUDE.md or .git):
```bash
ls CLAUDE.md .git 2>/dev/null
```

### 2. Determine archive number

Find next sequential number in archive/:
```bash
ls -d archive/[0-9][0-9]_* 2>/dev/null | tail -1
```

If archive/ doesn't exist or is empty, start with `01`.
Otherwise, increment the highest number.

### 3. Create archive structure

```bash
ARCHIVE_PATH="archive/{nn}_{task_name}"
mkdir -p "$ARCHIVE_PATH/sessions"
```

Create initial `HANDOVER.md`:
```markdown
# Task: {Task Name} - Handover

**Created:** {date}
**Status:** Just started

## Goal

{To be defined with user}

## Steps

{To be defined}

## Resume Prompt

\```
Resume: {Task Name}

HANDOVER: {full_path}/archive/{nn}_{task_name}/HANDOVER.md

NEXT TASKS:
1. Define goals and scope
2. Break down into steps
3. Begin implementation
\```
```

Create initial `TODO.md`:
```markdown
# {Task Name} - TODO

## Planning
- [ ] Define goals
- [ ] Break into steps

## Implementation
{To be added}

## Verification
- [ ] Tests pass
- [ ] Manual testing
```

### 4. Generate session ID

```bash
uuidgen | cut -c1-8
```

Or use: `$(date +%s | tail -c 8)`

### 5. Create session meta

Create `~/.varie/sessions/{session_id}/meta.yaml`:

```yaml
session_id: "{id}"
created_at: "{ISO timestamp}"
last_active: "{ISO timestamp}"

repo: "{repo_name}"
repo_path: "{full_path}"

task:
  id: "{nn}_{task_name}"
  name: "{Human Readable Task Name}"
  archive_path: "archive/{nn}_{task_name}/"
  started_at: "{ISO timestamp}"

current_step: "planning"
status: "in_progress"
```

This is lightweight session tracking. Rich data lives in `<repo>/archive/`.

### 6. Auto-register project

If project not in `~/.varie/manager/projects.yaml`, add it:

```yaml
projects:
  {repo_name}:
    path: "{full_path}"
    status: active
    current_feature: "{nn}_{task_name}"
    last_updated: "{ISO timestamp}"
```

This ensures Manager can see all projects that have been worked on.

### 7. Load context

Read and summarize key context:
- `CLAUDE.md` - Project instructions
- Related projects from parent `CLAUDE.md` if exists

### 8. Notify daemon

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/workstation-notify session-start --task "{task_name}"
```

### 9. Output and prompt for goals

```
Created: archive/{nn}_{task_name}/

Context loaded:
- {repo}/CLAUDE.md ({brief description})
- Related: {related repos if any}

Initialized task: {Human Readable Task Name}
Session ID: {session_id}

What are the goals for this task? I'll help break it down into steps.
```

## Example

**User:** `/work-start user_auth`

**Output:**
```
Created: archive/33_user_auth/

Context loaded:
- webapp/CLAUDE.md (Character & Companion Development Hub)
- Related: varie/backend (backend APIs)

Initialized task: Character API
Session ID: a1b2c3d4

What are the goals for this task? I'll help break it down into steps.
```

**User provides goals, Claude responds:**
```
Got it. Here's the proposed breakdown:

Steps:
1. update_api_contract - Define new endpoint schema
2. backend_implementation - Implement handler and tests
3. frontend_api_client - Update TypeScript types and fetch
4. frontend_components - Update UI components
5. integration_test - End-to-end verification

Does this look right? I'll save this to the checkpoint and begin with step 1.
```
