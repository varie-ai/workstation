---
name: work-summarize
description: Provide a summary of current work state at requested detail level. Used by Manager to get session status without loading full context.
arguments: ""
---

# /work-summarize

Provide a summary of current work state at requested detail level.

## Purpose

This skill enables the Manager pattern where a lean Manager session requests summaries from other sessions without loading full context. Sessions provide self-contained summaries at varying detail levels.

## Detail Levels

| Level | Content | Use Case |
|-------|---------|----------|
| 1 | Task + step (one line) | Routing decisions |
| 3 | + status + notes (default) | Status overview |
| 10 | + files + next steps + blockers | Reviving work |
| full | Complete checkpoint dump | Deep investigation |

## Implementation Steps

### 1. Determine current session

Check if there's an active session for current directory:
```bash
PROJECT=$(basename "$PWD")
```

Read session from `~/.varie/sessions/` matching current project.

If no session:
```
No active session. Status: idle
```

### 2. Check checkpoint staleness (CRITICAL for crash recovery)

Before generating summary, verify checkpoint accuracy:

```bash
# Get checkpoint's recorded git state
# Compare to current git state
git status --porcelain
git rev-parse --short HEAD
```

**Staleness indicators:**
- `last_active` > 1 hour ago
- `git_state.last_commit` doesn't match current HEAD
- `git_state.dirty_files` doesn't match current `git status`

**If stale:**
```
⚠️ Checkpoint may be stale (last: {time} ago)

Checkpoint says: "{step} - {notes}"
Git shows: {current reality}

Run /work-recover for accurate state, or /work-resume to continue.
```

This ensures Manager knows when session state is uncertain after a crash.

### 3. Parse detail level

Default to 3 if not specified.
Accept: 1, 3, 10, "full"

### 3. Generate summary at requested level

**Level 1 (one line):**
```
{Task Name}: Step {N}/{total} - {step_name} ({status})
```

Example:
```
Character API Migration: Step 3/5 - frontend_api_client (in_progress)
```

**Level 3 (default):**
```
{Task Name} ({repo})
Step {N}/{total}: {step_name}
Notes: "{current notes}"
```

Example:
```
Character API Migration (webapp)
Step 3/5: frontend_api_client
Notes: "Working on response type definitions"
```

**Level 10 (detailed):**
```
{Task Name} ({repo})
Session: {id} | Branch: {branch}
Step {N}/{total}: {step_name} - {status}

Recent progress:
- {completed step 1}: {outcome}
- {completed step 2}: {outcome}
- {current step}: {notes}

Files touched:
- {file1}
- {file2}

Next steps:
- {pending step 1}
- {pending step 2}

Blockers: {none or description}
Last checkpoint: {time} ago
```

**Level full:**
Output the entire checkpoint YAML content.

### 4. Output summary

Just output the summary text. No additional commentary needed - this is meant for machine consumption by orchestrator.

## Examples

**User:** `/work-summarize`

**Output (level 3):**
```
Character API Migration (webapp)
Step 3/5: frontend_api_client
Notes: "Working on response type definitions"
```

**User:** `/work-summarize 1`

**Output:**
```
Character API Migration: Step 3/5 - frontend_api_client (in_progress)
```

**User:** `/work-summarize 10`

**Output:**
```
Character API Migration (webapp)
Session: abc123 | Branch: feature/character-api
Step 3/5: frontend_api_client - in_progress

Recent progress:
- update_api_contract: Added /companions endpoint
- backend_implementation: Handler + 5 tests passing
- frontend_api_client: Working on response types

Files touched:
- src/api/client.ts
- src/types/companion.ts

Next steps:
- frontend_components
- integration_test

Blockers: none
Last checkpoint: 15 min ago
```

## Manager Integration

The Manager uses this to stay lean:

```
Manager: "Session webapp, /work-summarize 1"
Session: "Character API Migration: Step 3/5 - frontend_api_client (in_progress)"
Manager: (makes routing decision with minimal context)
```

If Manager needs more detail:
```
Manager: "Session webapp, /work-summarize 10"
Session: (provides detailed summary)
Manager: (has enough context to revive or assist)
```
