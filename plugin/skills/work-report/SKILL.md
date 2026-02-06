---
name: work-report
description: Generate human-readable work reports for standups, team syncs, and manager updates. Summarizes accomplishments, progress, and next steps across projects.
arguments: ""
---

# /work-report

Generate work reports for human communication - standups, team meetings, manager syncs.

## When to Use

- Daily standup preparation
- Weekly team sync
- Progress update for manager/PM/TPM
- Reflecting on what was accomplished
- Preparing status for cross-functional meetings

## Usage

```
/work-report                    # Smart default (today or recent)
/work-report today              # Today's work
/work-report yesterday          # Yesterday's work
/work-report this week          # This week
/work-report last week          # Last week
/work-report Jan 27-31          # Custom range
```

## Output Philosophy

**Human-first:** Written for people, not systems. Focus on *what was accomplished* in plain language.

**Audience-agnostic:** Start neutral, user can request adjustments:
- "Make it more technical for engineering sync"
- "Summarize for PM - focus on deliverables"
- "Add more detail on the auth work"

**Divide & conquer:** High-level summary first, details only for significant milestones/deliverables/findings.

## Implementation

### Step 1: Determine Time Period

Parse the user's request to determine the time range:
- "today" → today's date
- "yesterday" → yesterday's date
- "this week" → Monday to today
- "last week" → Previous Monday to Sunday
- Custom range → Parse dates

Default (no argument): Today if there's activity, otherwise last 7 days.

### Step 2: Gather Project Data

```bash
# Read project index
cat ~/.varie/manager/projects.yaml
```

### Step 3: Gather Session Data

```bash
# Find all usage files
ls ~/.varie/sessions/*/usage.json

# Read each and filter by time period
# Group by initial_cwd to identify which projects had activity
```

For each usage.json, check if `started_at` or `last_updated` falls within the time period.

### Step 4: Detect Meaningful Work

**Why:** Token count is a poor proxy for meaningful work. A 500-token session with a bug fix commit is more valuable than a 50K-token exploration with no output. Filter noise to report on actual accomplishments.

#### Work Categories

| Category | Signal | Report As |
|----------|--------|-----------|
| **COMPLETED** | Has git commits in time period | "Done" section |
| **IN_PROGRESS** | Has uncommitted code changes (excluding noise) | "In Progress" section |
| **RESEARCH** | High tokens (>10K) + handover/checkpoint exists | "Exploring" section |
| **EXCLUDED** | Noise (see below) | Not reported (footnote only) |

#### Noise Detection (EXCLUDED)

Exclude from report:
- **CLAUDE.md Varie-section only**: Auto-injected plugin reference, not real work
- **Minimal sessions**: <1K tokens with no file changes
- **Quick opens**: `started_at` ≈ `last_updated` (within 60 seconds)

#### Git-Based Detection

For each project with sessions in time period:

```bash
# 1. Check for commits in period
git log --oneline --since="$START_DATE" --until="$END_DATE"

# 2. Check for uncommitted changes
git diff --name-only HEAD
git status --porcelain | grep '^\?\?'  # untracked files

# 3. Detect CLAUDE.md Varie-section-only change
# The auto-injected section is exactly:
#   ## Workstation
#   (empty line)
#   Key skills: `/work-start`, `/work-checkpoint`, `/work-handover`, `/work-status`.
# If CLAUDE.md diff contains ONLY this (≤4 lines added at end), it's noise.
```

#### Multi-Repo Session Handling

When `initial_cwd` is a parent directory (e.g., `/workplace/projects/`):

1. **Primary**: Check git activity across all known projects during session timeframe
   - Attribute session to projects that had commits or uncommitted changes
   - Same session can credit multiple projects
2. **Fallback**: If no git changes detected, mark as "Cross-project work"
   - Report under separate "Cross-Project" section
   - Suggest using `/work-start <repo> <task>` for better tracking

### Step 5: Gather Work Details

For each project classified as COMPLETED, IN_PROGRESS, or RESEARCH:

```bash
# Git commit messages (for COMPLETED)
git log --oneline --since="$START_DATE" --until="$END_DATE"

# Find latest archive entry (for context)
LATEST=$(ls -t <repo>/archive/ 2>/dev/null | head -1)

# Read HANDOVER.md for recent work
cat <repo>/archive/$LATEST/HANDOVER.md 2>/dev/null

# Check for issues
cat <repo>/issues/INDEX.md 2>/dev/null
```

### Step 6: Synthesize Report

Transform technical data into human-readable prose. Write as if speaking in standup - conversational, focused on what matters.

```markdown
## Work Report - [Time Period]

### Summary
[1-2 sentence high-level summary - what was the focus, what got done]

### Done
- **[Project]**: [Descriptive accomplishment - what was done, why it matters]
- **[Project]**: [Another accomplishment]

### In Progress
- **[Project]**: [Current focus] - [brief status, e.g., "working through API integration"]

### Exploring
- **[Project]**: [What was investigated and key takeaways]

### Cross-Project
- [Only if multi-repo sessions with no clear attribution]
- [Suggest `/work-start <repo> <task>` for better tracking]

### Key Findings / Decisions
- [Important discoveries, blockers resolved, architectural decisions]
- [Only include if significant - skip section if nothing notable]

### Next Steps
- [What's planned next - actionable items]

---
*[N] sessions across [M] projects ([X] excluded as noise)*
```

**Section rules:**
- Omit empty sections entirely (don't show "Exploring" if none)
- "Done" requires git commits - don't inflate with uncommitted work
- "Cross-Project" only appears when attribution unclear
- Footer notes excluded sessions so user knows filtering happened

## Example Output

### Daily Report

```markdown
## Work Report - February 3, 2026

### Summary
Shipped several bug fixes for Workstation dispatch and made progress on character extension i18n.

### Done
- **varie-workstation**: Fixed the dispatch Enter key bug that was causing commands to fail intermittently
- **varie-workstation**: Added external repo support to project discovery

### In Progress
- **react-app**: Updating internationalization - working through translation key updates

### Exploring
- **data-pipeline**: Getting familiar with the architecture for potential integration work

### Next Steps
- Finish i18n updates and test across languages
- Document data-pipeline findings if integration moves forward

---
*6 sessions across 3 projects (2 excluded as noise)*
```

### Weekly Report

```markdown
## Work Report - Week of January 27, 2026

### Summary
Focused week on Workstation plugin development. Completed the visibility layer (Phase C2) and context tracking features (Phase C3). Set foundation for reporting.

### Done
- **varie-workstation**: Phase C2 - Project visibility via `/projects`, `/project` skills
- **varie-workstation**: Phase C3 - Context tracking, checkpoint hints, `/work-stats`
- **varie-workstation**: Auto-setup flow for status line configuration
- **react-app**: Fixed component loading race condition

### In Progress
- **varie-workstation**: Phase C4 - Reporting features

### Exploring
- **ml-pipeline**: Investigated optimization options - documented in handover

### Key Findings
- Repo-centric data model (archive/ in repos) better than session-centric for persistence
- Manager should coordinate, not command - sessions are autonomous

### Issues Resolved
- #003: Orchestrator terminal not opening

### Issues Opened
- #007: Auto-download workstation app on plugin install

### Next Steps
- Complete reporting skill
- Begin workstation app distribution setup
- Resume react-app API work

---
*12 sessions across 4 projects (5 excluded as noise)*
```

## Handling Edge Cases

### No Activity in Time Period

```markdown
## Work Report - [Time Period]

No tracked sessions found for this time period.

To track work:
1. Ensure the varie-workstation plugin is installed
2. Status line should be configured (check with `/work-stats`)
3. Start working - sessions are tracked automatically
```

### All Sessions Excluded (Only Noise)

```markdown
## Work Report - [Time Period]

No meaningful work detected for this time period.

8 sessions were excluded:
- 6 had no code changes (CLAUDE.md updates only)
- 2 were brief opens (<1K tokens)

If you did meaningful work, consider:
- Using `/work-checkpoint` to save progress
- Using `/work-handover` to document exploration
```

### Research Without Handover

If high-token session (>10K) with no commits, no uncommitted changes, and no handover:

```markdown
### Exploring
- **[project]**: Exploration session (undocumented) - consider `/work-handover` to capture findings
```

### No Handover Data for Completed Work

If a project has commits but no HANDOVER.md:

```markdown
### Done
- **[project]**: [commit message summary from git log]
```

Git commits provide enough context; handover is optional for completed work.

### Multi-Repo Session Without Clear Attribution

```markdown
### Cross-Project
- **General exploration** (from /workplace/projects/): 2 sessions, 45K tokens
  - Tip: Use `/work-start <repo> <task>` for better tracking
```

## Follow-up Refinements

After generating a report, user can request adjustments:

- "Make it shorter - just bullet points"
- "Add more detail on the workstation work"
- "Format for Slack"
- "Make it suitable for my manager (non-technical)"
- "Focus on blockers and risks"

## Notes

- Reports are generated, not stored - run again to get updated data
- **Meaningful work detection**: Reports filter out noise (CLAUDE.md-only changes, minimal sessions) to focus on actual accomplishments
- Token/cost stats available via `/work-stats` if user wants technical details
- For detailed project status, use `/project <name>`
- For live session list, use `/work-sessions`
- Git commits are the primary signal for "Done" - uncommitted work shows as "In Progress"
