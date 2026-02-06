---
name: work-handover
description: Generate comprehensive handover documentation for session end. Use when wrapping up a session, taking a long break, or handing off to another session.
arguments: ""
---

# /work-handover

Generate comprehensive handover documentation for session end.

## Usage

```
/work-handover
```

## Behavior

1. **Read current checkpoint** and task state
2. **Summarize completed work** this session
3. **Identify next steps** from remaining pending steps
4. **Generate HANDOVER.md** in archive folder
5. **Update TODO.md** if exists
6. **Save final checkpoint**
7. **Output** handover summary and resume prompt

## Generated Files

### HANDOVER.md

```markdown
# Task: Character API Migration - Handover

**Date:** 2026-01-29
**Session:** abc123
**Status:** 3/5 steps complete

## Completed This Session

- [x] **update_api_contract**: Added /companions endpoint, deprecated /characters
- [x] **backend_implementation**: Handler in subscription.py:245-312, 5 tests passing
- [x] **frontend_api_client**: Types and fetch function updated (partial)

## Current Position

Step `frontend_api_client` partially complete:
- CompanionResponse type: done
- CompanionListResponse type: done
- fetchCompanions(): done
- useCompanions(): NOT DONE ← resume here

## Next Steps

1. Complete useCompanions() hook in client.ts:145
2. Update frontend components to use new types
3. Run integration tests

## Resume Prompt

\```
Resume: Character API Migration

HANDOVER: ~/projects/webapp/archive/33_user_auth/HANDOVER.md

NEXT TASKS:
1. Complete useCompanions() hook (client.ts:145)
2. Update CharacterList component to use CompanionResponse
3. Run integration test suite
\```

## Files Modified

- `backend/user_subscription/docker/subscription.py` (new endpoint)
- `backend/user_subscription/tests/test_companions.py` (new tests)
- `varie-character-extension/src/api/client.ts` (updated types, fetch)
- `varie-character-extension/src/types/companion.ts` (new file)

## Notes

Response type naming follows pattern from existing CharacterResponse.
Backend validation uses same schema as /characters for consistency.
```

### TODO.md Update

```markdown
# Character API Migration - TODO

## Completed
- [x] Define API contract changes
- [x] Implement backend handler
- [x] Add backend tests
- [x] Update TypeScript types
- [x] Update fetch function

## In Progress
- [ ] Update useCompanions hook ← CURRENT

## Pending
- [ ] Update CharacterList component
- [ ] Update CharacterDetail component
- [ ] Integration tests
- [ ] Update documentation
```

## Example

```
> /work-handover

Generating handover for: Character API Migration

Session summary:
  Duration: 2h 15m
  Steps completed: 2.5 of 5
  Files changed: 4

Writing: archive/33_user_auth/HANDOVER.md
Updating: archive/33_user_auth/TODO.md
Saving final checkpoint...

═══════════════════════════════════════════════════

Handover complete. Copy this to resume:

───────────────────────────────────────────────────
Resume: Character API Migration

HANDOVER: ~/projects/webapp/archive/33_user_auth/HANDOVER.md

NEXT TASKS:
1. Complete useCompanions() hook (client.ts:145)
2. Update CharacterList component
3. Run integration tests
───────────────────────────────────────────────────
```
