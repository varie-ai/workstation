---
name: work-resume
description: Resume a task using fuzzy matching across all repos. Use when user wants to continue previous work, says "resume", "continue", or references a past task.
arguments: "description"
---

# /work-resume

Resume a task using fuzzy matching across all repos.

## Implementation Steps

### 1. Scan all checkpoints

```bash
ls ~/.varie/sessions/*.yaml 2>/dev/null
```

If no sessions exist:
```
No saved sessions found.
Use /work-start <task_name> to begin tracking work.
```

### 2. Read and parse sessions

For each session file, extract:
- `task.name` and `task.id`
- `task.tags`
- `current_step`
- `repo`
- `steps[*].notes` (recent notes)

### 3. Fuzzy match against description

Match the user's description against:
- Task names (highest weight)
- Task tags
- Step names
- Step notes
- Repo names

**Matching examples:**
| Input | Likely Match |
|-------|--------------|
| "character api" | task.name contains "character" AND "api" |
| "frontend types" | step.name or notes contain "frontend" or "types" |
| "webapp" | repo = "webapp" |

### 4. Handle match results

**Single match:**
Proceed to load context.

**Multiple matches:**
Present options:
```
Found multiple matches:

1. webapp: Character API Migration (step 3/5)
2. backend: Character Sync Feature (step 1/3)

Which one? (Enter number or type more specific description)
```

**No match:**
```
No matching task found for "{description}".

Active tasks:
- webapp: Character API Migration
- my-project: Communication Protocol

Try again with a more specific description, or use /work-status to see all tasks.
```

### 5. Load checkpoint and context

Read the matched session's checkpoint file.

Read the task's HANDOVER.md:
```bash
cat {repo_path}/{archive_path}/HANDOVER.md
```

### 6. Check if recovery needed

If last_active is old (> 1 hour), or git state doesn't match:
```
⚠️  Checkpoint may be stale (last: {time} ago)
Running recovery check...
```

Then run recovery logic (compare checkpoint vs actual git state).

### 7. Load into current session

Update the current session's context with:
- Task name and steps
- Current step and notes
- Files touched
- Git branch

### 8. Notify daemon

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/workstation-notify session-start --task "{task_id}"
```

### 9. Output resume summary

```
Resuming: {Task Name} ({repo})
Session: {session_id}
Status: Step {N}/{total} in progress

Current step: {step_name}
Notes: "{last notes}"

Files touched:
- {file1}
- {file2}

Last checkpoint: {time} ago

Ready to continue. What would you like to work on?
```

Or if recovery was run:
```
Resuming: {Task Name} ({repo})

Recovery found more progress than checkpoint:
- {step X}: checkpoint said "in progress", actually complete
- Resuming from: {actual position}

Ready to continue from {description}.
```

## Example

**User:** `/work-resume character api`

**Output:**
```
Resuming: Character API Migration (webapp)
Session: abc123
Status: Step 3/5 in progress

Current step: frontend_api_client
Notes: "Working on response type definitions"

Files touched:
- src/api/client.ts
- src/types/companion.ts

Last checkpoint: 15 minutes ago

Ready to continue. What would you like to work on?
```

## Recovery Integration

If checkpoint is stale, automatically runs `/work-recover` logic:

```
Resuming: Character API Migration (webapp)

⚠️  Checkpoint from 2 hours ago. Checking actual state...

Recovery found:
  Checkpoint: "Working on response types"
  Git shows: types complete, fetch updated, hook pending

Adjusted: Continuing from useCompanions() hook (client.ts:145)
```
