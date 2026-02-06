---
name: work-recover
description: Compare checkpoint state vs actual state and determine true position. Use after crashes, long breaks, or when checkpoint seems stale.
arguments: ""
---

# /work-recover

Compare checkpoint state vs actual state and determine true position.

## Usage

```
/work-recover
```

## Behavior

1. **Read current checkpoint** from `~/.varie/sessions/{id}.yaml`
2. **Inspect actual state:**
   - `git status` — what files are modified
   - `git diff` — what changes exist
   - File contents — what's actually implemented
   - Test results — does the code work
3. **Compare expected vs actual:**
   - Checkpoint says step X in progress with notes Y
   - Reality shows different progress
4. **Determine true position:**
   - Step actually complete? Mark it and move on
   - Step partially complete? Identify exact resume point
   - Step broken? Identify what needs fixing
5. **Update checkpoint** with corrected state
6. **Output** recovery assessment and recommended action

## When to Use

- After app crash
- When checkpoint feels stale
- When resuming after long break
- Automatically called by `/work-resume` if checkpoint is old

## Example: Normal Recovery

```
> /work-recover

Reading checkpoint: abc123
Task: Character API Migration
Checkpoint step: frontend_api_client (in_progress)
Checkpoint notes: "Working on response type definitions"
Checkpoint time: 2 hours ago

Inspecting actual state...

Git status:
  modified: src/api/client.ts
  new file: src/types/companion.ts

Analyzing src/api/client.ts...
  - CompanionResponse type: ✓ defined
  - CompanionListResponse type: ✓ defined
  - fetchCompanions(): ✓ updated
  - useCompanions(): ✗ not updated

Conclusion:
  Checkpoint was stale. More progress than recorded.

  Step frontend_api_client:
    Checkpoint said: "Working on response types"
    Reality shows: Types complete, fetch updated, hook pending

  Resuming from: useCompanions() hook in client.ts:145

Checkpoint updated with current state.
```

## Example: Step Actually Complete

```
> /work-recover

Reading checkpoint: def456
Checkpoint step: union_mask_implementation (in_progress)
Checkpoint notes: "Implementing mask union logic"

Inspecting actual state...

Git log shows commit: "feat: implement union mask for hair decorations"
Tests passing: test_hair_decoration.py (3/3)
Files complete and committed.

Conclusion:
  Step union_mask_implementation is COMPLETE.
  Moving to next step: stage_3b_integration

Checkpoint updated. Ready to continue.
```

## Example: Broken State

```
> /work-recover

Reading checkpoint: ghi789
Checkpoint step: backend_implementation (in_progress)

Inspecting actual state...

Git status: clean (no changes?)
Last commit: "feat: add API contract" (step 1)
Step 2 files: not modified

Conclusion:
  Checkpoint says step 2 in progress, but no evidence of work.
  Possible causes:
    - Work was done but not saved
    - Work was on a different branch
    - Checkpoint was incorrect

  Current branch: feature/user-prefs
  Expected files: subscription.py (unmodified)

  Recommendation: Start step backend_implementation fresh.

Continue? [y/n]
```

## Recovery Heuristics

| Signal | Interpretation |
|--------|----------------|
| Files modified, match expected | Work in progress |
| Files committed since checkpoint | Step likely complete |
| Tests passing for step | Step complete |
| No changes, clean git | Checkpoint stale or wrong |
| Merge conflicts | Manual intervention needed |
