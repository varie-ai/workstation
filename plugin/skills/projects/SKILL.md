---
name: projects
description: Show all projects with current status. Manager-specific skill for cross-project visibility.
arguments: ""
---

# /projects

List all projects in the Manager's project index.

## When to Use

Use this skill when you need to:
- See all tracked projects and their status
- Check which projects have active sessions
- Review project priorities before routing work

## Implementation

### 1. Read projects.yaml

```bash
cat ~/.varie/manager/projects.yaml 2>/dev/null
```

If file doesn't exist or is empty, show helpful message.

### 2. Parse and format

Extract projects from YAML and format as table:

| Project | Status | Current Feature | Last Updated |
|---------|--------|-----------------|--------------|
| webapp | active | user_auth | 2 hours ago |
| backend | idle | - | 2 days ago |

### 3. Show active sessions

Cross-reference with `/work-sessions` to indicate which projects have active sessions.

## Output Format

```
## Projects

| Project | Path | Status | Current Work |
|---------|------|--------|--------------|
| webapp | ~/projects/webapp | active | user_auth |
| varie | ~/projects/varie | idle | - |

Active sessions: 1 (webapp)

## Aliases
- character → webapp
- infra → backend
```

## Empty State

If no projects are configured:

```
## Projects

No projects configured yet.

To add a project, edit ~/.varie/manager/projects.yaml:

```yaml
projects:
  my_project:
    path: /path/to/repo
    status: active
    current_feature: feature_name
```

Or use /route to auto-create sessions - projects will be tracked automatically.
```

## Example

**User:** `/projects`

**Output:**
```
## Projects

| Project | Path | Status | Current Work |
|---------|------|--------|--------------|
| webapp | ~/workplace/projects/webapp | active | user_auth |
| varie | ~/workplace/projects/varie | idle | - |
| data-pipeline | ~/workplace/projects/data-pipeline | paused | regime_v2 |

Active sessions: 1
- webapp (session m7abc123)

## Aliases
- character → webapp
- infra → varie/backend
```
