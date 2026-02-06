---
name: project
description: Show detailed status of a specific project by reading its archive, project_plan, and issues. Use for deep dive into one project's state.
arguments: "<project-name>"
---

# /project <name>

Show detailed status of a specific project.

## When to Use

- Deep dive into one project's current state
- Before resuming work on a project
- Preparing standup/status for a specific project
- Understanding what was done and what's pending

## Arguments

`<project-name>` - Name or alias of the project (as defined in projects.yaml)

## Implementation

### 1. Resolve project repos

```bash
# Read from projects.yaml
cat ~/.varie/manager/projects.yaml

# Find project by name or alias
# Get repos array (single or multiple)
```

Project can have one or more repos:
```yaml
# Single repo
webapp:
  repos:
    - path: /path/to/webapp

# Multi-repo
platform:
  repos:
    - path: /path/to/backend
      role: api
    - path: /path/to/frontend
      role: web
```

If project not found, suggest adding to projects.yaml.

### 2. Read project structure (for each repo)

Check what exists in each repo:

```bash
# Check for archive/
ls <repo>/archive/ 2>/dev/null

# Check for project_plan/
ls <repo>/project_plan/ 2>/dev/null

# Check for issues/
ls <repo>/issues/ 2>/dev/null

# Check for CLAUDE.md
cat <repo>/CLAUDE.md 2>/dev/null | head -50
```

### 3. Read latest archive entry

```bash
# Find most recent feature
LATEST=$(ls -t <repo>/archive/ | head -1)

# Read HANDOVER.md
cat <repo>/archive/$LATEST/HANDOVER.md

# Read TODO.md
cat <repo>/archive/$LATEST/TODO.md
```

### 4. Read project plan index

```bash
cat <repo>/project_plan/INDEX.md 2>/dev/null
```

### 5. Read issues index

```bash
cat <repo>/issues/INDEX.md 2>/dev/null
```

### 6. Format output

```
# Project: webapp

**Path:** ~/projects/webapp
**Status:** Active session (ml2abc123)

---

## Current Work

**Feature:** 03_user_auth
**Status:** Step 3/5 - frontend_api_client (in_progress)

### Recent Progress
- Backend implementation complete
- API contract updated
- Working on frontend types

### Next Steps
1. Complete response type definitions
2. Update React components
3. Integration testing

---

## Project Plan

| ID | Feature | Status |
|----|---------|--------|
| P01 | User Auth | Complete |
| P02 | Dashboard | Complete |
| P03 | API Integration | In Progress |
| P04 | Mobile Support | Planning |

---

## Open Issues

| ID | Issue | Priority | Status |
|----|-------|----------|--------|
| 005 | Session timeout bug | P1 | Open |
| 007 | Dark mode flickering | P2 | Open |

---

## Quick Actions

- /route webapp "continue work" - Resume this project
- /dispatch ml2abc123 /work-status - Get live status
```

## If Project Not Found

```
Project "foo" not found.

Registered projects:
- webapp
- varie
- data-pipeline

Add a new project to ~/.varie/manager/projects.yaml:
```yaml
projects:
  foo:
    path: /path/to/foo
    status: active
```
```

## If No Archive/Project Structure

```
# Project: my_project

**Path:** /path/to/repo
**Status:** No active session

No archive/ or project_plan/ structure found.

This project doesn't use the Varie workflow structure yet.
To start tracking:
1. Create archive/ directory
2. Use /work-start to begin tracked work
```

## Example

**User:** `/project webapp`

Shows full status including current feature, recent progress, project plan, and open issues.

**User:** `/project character` (using alias)

Resolves alias from projects.yaml, shows same detail.
