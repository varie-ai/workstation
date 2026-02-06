---
name: discover-projects
description: Scan for new project repos and add them to the Manager's project index. Use when you want to discover repos that aren't yet tracked.
arguments: "[path]"
---

# /discover-projects

Scan for new project repos and add them to the project index.

## When to Use

- First time setup - discover all repos in workspace
- After creating new repos - add them to tracking
- User mentions a repo that isn't tracked yet
- Adding repos from external locations (outside default workspace)

## Usage

```
/discover-projects                    # Scan default workspace
/discover-projects ~/external_projects # Scan a directory for repos
/discover-projects ~/code/my-app      # Add a single repo
```

## Smart Path Detection

When you provide a path, the daemon detects what it is:

| Path Type | Behavior |
|-----------|----------|
| Has `.git` or `CLAUDE.md` | Treated as a single repo, added directly |
| Directory without `.git` | Scanned for repos inside (up to 3 levels deep) |
| Non-existent path | Returns error |

## Implementation

### 1. With Custom Path

```bash
# Add a single repo
${CLAUDE_PLUGIN_ROOT}/scripts/workstation-dispatch discover-projects ~/code/my-app

# Scan a directory
${CLAUDE_PLUGIN_ROOT}/scripts/workstation-dispatch discover-projects ~/external_projects
```

Response:
```json
{
  "status": "ok",
  "message": "Discovered 3 repos at ~/external_projects, added 3 to projects",
  "discovered": [
    {
      "name": "project-a",
      "path": "~/external_projects/project-a",
      "hasClaudeMd": true,
      "source": "learned"
    }
  ],
  "total": 3,
  "newCount": 3,
  "customPath": "~/external_projects"
}
```

### 2. Default Scan (no path)

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/workstation-dispatch discover-projects
```

Returns all known repos (from default workspace scan + previously learned repos).

### 3. If daemon not running, manual scan

Read current projects:
```bash
cat ~/.varie/manager/projects.yaml
```

Scan common locations:
```bash
# List directories in workspace
ls -d ~/workplace/projects/*/ 2>/dev/null

# Check each for .git or CLAUDE.md
for dir in ~/workplace/projects/*/; do
  if [ -d "$dir/.git" ] || [ -f "$dir/CLAUDE.md" ]; then
    echo "$dir"
  fi
done
```

## Persistence

Repos discovered via custom path are persisted to:
```
~/.varie-workstation/learned-repos.json
```

This means they survive daemon restarts and will be available for routing.

## Format Output

### New repos found:

```
## Discovered Projects

Found 3 repos at ~/external_projects:

| Repo | Path | CLAUDE.md |
|------|------|-----------|
| project-a | ~/external_projects/project-a | Added Varie section |
| project-b | ~/external_projects/project-b | Created |
| project-c | ~/external_projects/project-c | Already present |

Projects index updated. You can now use `/route project-a <message>` to work with them.
```

### Single repo added:

```
## Discovered Projects

Added repo: my-app

| Repo | Path | CLAUDE.md |
|------|------|-----------|
| my-app | ~/code/my-app | Added Varie section |

You can now use `/route my-app <message>` to work with it.
```

### No new repos:

```
## Discover Projects

Scanned ~/external_projects/

No new repos found. Path may already be known or contain no git repos.

Use `/projects` to see all tracked projects.
```

### Path doesn't exist:

```
## Discover Projects

Error: Path does not exist: ~/nonexistent/path

Please check the path and try again.
```

## CLAUDE.md Injection

For repos with existing CLAUDE.md, the skill injects a minimal section:

```markdown
## Workstation

Key skills: `/work-start`, `/work-checkpoint`, `/work-handover`, `/work-status`.
```

This helps sessions in those repos know about available skills.

## Examples

### User has external projects

**User:** "I have some projects in ~/clients that I want to track"

**Response:**
```
Running discovery for ~/clients...

## Discovered Projects

Found 2 repos at ~/clients:

| Repo | Path | CLAUDE.md |
|------|------|-----------|
| client-a | ~/clients/client-a | Added Varie section |
| client-b | ~/clients/client-b | Created |

Projects added to index. You can now use `/route client-a <message>` to work with them.
```

### User cloned a new repo

**User:** "I just cloned a repo to ~/code/new-project, can you add it?"

**Response:**
```
Running discovery for ~/code/new-project...

## Discovered Projects

Added 1 repo:

| Repo | Path | CLAUDE.md |
|------|------|-----------|
| new-project | ~/code/new-project | Added Varie section |

You can now use `/route new-project <message>` to work with it.
```

### First time setup

**User:** "This is my first time, can you find my repos?"

**Response:**
```
Running discovery for default workspace...

## Discovered Projects

Found 12 repos in ~/workplace/projects:

| Repo | Path | CLAUDE.md |
|------|------|-----------|
| webapp | ~/workplace/projects/webapp | Already present |
| api-server | ~/workplace/projects/api-server | Added Varie section |
... (etc)

All repos added to project index. Use `/projects` to see the full list.

Tip: If you have repos in other locations, use `/discover-projects <path>` to add them.
```
