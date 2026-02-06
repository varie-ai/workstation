---
name: work-stats
description: Show token usage statistics across sessions. Use when you want to understand resource consumption or usage patterns.
arguments: ""
---

# /work-stats

Show token usage statistics across sessions.

## When to Use

- Review how many tokens have been used across sessions
- Understand usage patterns (which projects consume most)
- Manager aggregating stats across all sessions

## Arguments

- `--project <name>` - Filter to specific project
- `--today` - Only sessions from today
- `--week` - Only sessions from past 7 days
- (no args) - Show all sessions

## Implementation

### 1. Find all usage files

```bash
# List all session usage files
ls ~/.varie/sessions/*/usage.json 2>/dev/null
```

### 2. Read and aggregate data

For each usage.json file:

```bash
cat ~/.varie/sessions/<session_id>/usage.json
```

Extract and sum:
- `tokens.total_input`
- `tokens.total_output`
- `tokens.cache_read`
- `tokens.cache_creation`

### 3. Format output

```
## Token Usage Statistics

> **Note:** Token counts are estimates based on status line data and may not match actual billing.

### Overall
| Metric | Value |
|--------|-------|
| Total Sessions | 12 |
| Input Tokens | 2.5M |
| Output Tokens | 450K |
| Cache Read | 1.8M |
| Cache Creation | 120K |

### By Initial Directory (Top 5)
| Directory | Sessions | Input | Output |
|-----------|----------|-------|--------|
| react | 5 | 1.2M | 200K |
| next.js | 3 | 800K | 150K |
| express | 2 | 300K | 80K |

### Recent Sessions
| Session | Started | Context % | Input | Output |
|---------|---------|-----------|-------|--------|
| abc123 | 2h ago | 42% | 150K | 45K |
| def456 | 5h ago | 78% | 280K | 92K |
```

## Filtering Examples

### By Project

```
/work-stats --project react
```

Shows only sessions where `initial_cwd` contains "react".

### By Time

```
/work-stats --today
```

Filters to sessions where `started_at` is today.

```
/work-stats --week
```

Filters to sessions from the past 7 days.

## If No Usage Data

```
## Token Usage Statistics

No usage data found.

Usage tracking requires the status line to be configured.
See: https://github.com/varie-ai/varie-workstation#status-line-setup
```

## Notes

- Usage data is collected by the `statusline-context` script
- Data persists in `~/.varie/sessions/<id>/usage.json`
- **Token counts are estimates and may not match actual billing**
- Sessions without usage.json are not included in stats
