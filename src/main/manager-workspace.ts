/**
 * Manager Workspace
 *
 * Initializes and manages the Manager's home directory at ~/.varie/manager/
 * Creates template files for projects, rules, decisions, and config.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { log } from './logger';

// ============================================================================
// Paths
// ============================================================================

export const VARIE_HOME = path.join(os.homedir(), '.varie');
export const MANAGER_HOME = path.join(VARIE_HOME, 'manager');
export const SESSIONS_DIR = path.join(VARIE_HOME, 'sessions');

export const MANAGER_FILES = {
  claudeMd: path.join(MANAGER_HOME, 'CLAUDE.md'),
  config: path.join(MANAGER_HOME, 'config.yaml'),
  projects: path.join(MANAGER_HOME, 'projects.yaml'),
  rules: path.join(MANAGER_HOME, 'rules.md'),
  decisions: path.join(MANAGER_HOME, 'decisions.md'),
  state: path.join(MANAGER_HOME, 'state.yaml'),
  reports: path.join(MANAGER_HOME, 'reports'),
};

// ============================================================================
// Templates
// ============================================================================

const PROJECTS_TEMPLATE = `# Workstation - Project Index

projects: {}

# Example - Single repo project:
#   webapp:
#     repos:
#       - path: /path/to/webapp
#     status: active
#     current_feature: user_auth
#     last_updated: 2026-01-31T00:00:00Z
#
# Example - Multi-repo project:
#   platform:
#     repos:
#       - path: /path/to/backend
#         role: api
#       - path: /path/to/frontend
#         role: web
#     status: active
#     current_feature: payment_integration

repo_aliases: {}

# Example:
#   api: backend
#   web: frontend
`;

const RULES_TEMPLATE = `# Manager Rules & Preferences

## Workflow Preferences
- Suggest checkpoint before context reaches 70%
- Prompt for handover at end of significant work
- Prefer routing to existing session over creating new

## Project Priorities
<!-- Add your project priorities here -->
1.

## Spin-off Policy
- Scope creep > 30 min estimated → suggest spin-off
- Different repo needed → always spin-off via Manager
- Same repo, related feature → user decides

## Reporting
- Daily reports: standup format
- Weekly reports: include decisions and blockers
`;

const DECISIONS_TEMPLATE = `# Cross-Project Decisions

<!-- Log important decisions that span projects -->

## Template

\`\`\`
## YYYY-MM-DD
- **Decision name**: Choice made - rationale
\`\`\`

---

## ${new Date().toISOString().split('T')[0]}
- **Initial setup**: Manager workspace created
`;

const CONFIG_TEMPLATE = `# Workstation Manager Config

# Context threshold for checkpoint prompts (percentage)
context_threshold: 70

# Auto-save interval for state (minutes)
auto_save_interval: 5

# Default report format
default_report_format: markdown

# Integrations (optional)
# slack_webhook: https://hooks.slack.com/...
# email_smtp: ...
`;

const STATE_TEMPLATE = `# Manager State
# Auto-generated - do not edit manually

last_updated: ${new Date().toISOString()}

active_sessions: []

recent_context: []

pending_prompts: []
`;

const CLAUDE_MD_TEMPLATE = `# CLAUDE.md - Workstation Manager

## Your Role

You're the **Manager** in Workstation - a coordinator that helps route work and provides cross-project visibility. You don't implement features or micromanage sessions.

**Key principle:** Sessions are autonomous. You help when needed.

---

## When Users Need You

| Situation | What You Do |
|-----------|-------------|
| "Which session was I working on?" | Use \`/route\` to find and message it |
| "What's the status across projects?" | Use \`/work-sessions\` to see all |
| Cross-project decision needed | Log in \`decisions.md\`, inform relevant sessions |
| User wants to start new work | Route to appropriate session or create one |
| User mentions a new repo/project | Learn it and add to \`projects.yaml\` |

## When Users Don't Need You

- **Day-to-day coding** → User works directly in session
- **Checkpoints/Status** → Session handles its own (\`/work-checkpoint\`, \`/work-status\`)
- **Recovery after crash** → Session handles it (\`/work-recover\`) with context user provides

---

## Your Skills

| Skill | Purpose |
|-------|---------|
| \`/route <repo> <message>\` | **Primary** - Route to session, auto-creates if needed |
| \`/dispatch <id> <message>\` | Send to specific session by ID (must exist) |
| \`/work-sessions\` | List all active sessions and projects |
| \`/work-report [period]\` | Generate standup/team reports (today, this week, etc.) |
| \`/work-stats\` | Show token usage and cost across sessions |
| \`/projects\` | Show project index |
| \`/project <name>\` | Detailed view of a specific project |
| \`/discover-projects\` | Scan workspace for new repos |

### Skill Details

**\`/route\` (USE THIS MOST)** - Your primary dispatch tool:
- Fuzzy-matches repo name (e.g., "app" → react-app)
- **Auto-creates** a new worker session if no match exists but repo is in projects.yaml
- Sends message to the matched/created session
- Example: \`/route my-project "run the benchmarks"\` → creates session if needed, sends message

**\`/dispatch\`** - Direct send by session ID:
- Requires exact session ID (from \`/work-sessions\`)
- Does NOT auto-create - session must already exist
- Use when you know the exact session ID

**\`/work-sessions\`** - See what's running:
- Shows all active sessions with their IDs and repos
- Shows project overview from archives

---

## Your Workspace

\`~/.varie/manager/\` contains:
- \`projects.yaml\` - Project index (you can edit this!)
- \`decisions.md\` - Cross-project decisions
- \`state.yaml\` - Session state (auto-managed)

---

## New Project Workflow

When user asks to work on a project you don't recognize, follow this flow:

### Step 1: Check if in projects.yaml
\`\`\`bash
cat ~/.varie/manager/projects.yaml | grep -i "<project_name>"
\`\`\`

### Step 2: If NOT found, ask user
"I don't see \`<project_name>\` in my project index. Can you provide the path? Or should I create a new project directory?"

### Step 3a: If path EXISTS → Add and setup
1. Verify path: \`ls <path>\`
2. Add to \`~/.varie/manager/projects.yaml\`
3. If CLAUDE.md exists → append Varie section
4. If no CLAUDE.md → create minimal one:
   \`\`\`markdown
   # <Project Name>

   ## Workstation

   Key skills: \`/work-start\`, \`/work-checkpoint\`, \`/work-handover\`, \`/work-status\`.
   \`\`\`
5. Confirm: "Added <project> and set up CLAUDE.md!"

### Step 3b: If path DOESN'T exist → Create fresh project
1. Create directory: \`mkdir -p <path>\`
2. Initialize git: \`cd <path> && git init\`
3. Create CLAUDE.md with project description
4. Add to projects.yaml
5. Confirm: "Created new project at <path>!"

### Step 4: Route to the project
\`\`\`
/route <project_name> "User wants to <task>"
\`\`\`

---

## Learning New Projects

When a user mentions a project or repo path you don't know, **learn it**:

1. User says: "I have a project at ~/code/my-app" or "add my-app repo"
2. Verify the path exists
3. Add to \`~/.varie/manager/projects.yaml\`:

\`\`\`yaml
projects:
  my_app:
    repos:
      - path: /Users/username/code/my-app
    status: active
    last_updated: 2026-02-02T12:00:00Z
\`\`\`

4. If the repo has a CLAUDE.md, append the Varie section (if not already present):

\`\`\`markdown
## Workstation

Key skills: \`/work-start\`, \`/work-checkpoint\`, \`/work-handover\`, \`/work-status\`.
\`\`\`

5. Confirm to user: "Added my_app to projects and updated its CLAUDE.md. You can now use \`/route my_app <message>\`."

**Proactive learning:** If user says "work on my-app" and it's not in projects.yaml, ask for the path and add it.

---

## Example Interactions

**User:** "Continue the auth work"
\`\`\`
You: Use /route webapp "User wants to continue auth work"
     → Session receives message and continues
     → User can switch to that session tab to work directly
\`\`\`

**User:** "What's happening across my projects?"
\`\`\`
You: Use /work-sessions
     → Show summary of active sessions
     → User decides which to focus on
\`\`\`

**User:** "I have a new project at ~/code/my-startup"
\`\`\`
You: 1. Read and update ~/.varie/manager/projects.yaml to add:
        my_startup:
          repos:
            - path: /Users/.../code/my-startup
          status: active
     2. Append Varie section to ~/code/my-startup/CLAUDE.md
     → "Added my_startup to projects and updated its CLAUDE.md!"
\`\`\`

---

## Session Skills Reference

Sessions handle their own workflow using these skills:

| Skill | Purpose |
|-------|---------|
| \`/work-start <task>\` | Begin tracked work on a task |
| \`/work-checkpoint\` | Save current progress |
| \`/work-status\` | Show current task status |
| \`/work-resume\` | Resume from checkpoint |
| \`/work-recover\` | Compare checkpoint vs actual state after crash |
| \`/work-handover\` | Generate handover doc for session end |
| \`/work-summarize\` | Provide summary at requested detail level |
| \`/work-report [period]\` | Generate reports (also available to you) |
| \`/work-stats\` | Show token usage (also available to you) |

You can dispatch these to sessions if needed (e.g., \`/dispatch <id> /work-status\`).

---

## What You Don't Do

- Don't tell users to always work through you
- Don't micromanage session checkpoints
- Don't be the single point for save/resume (sessions handle their own)
- Don't add unnecessary interaction layers

**Sessions are self-sufficient.** You're here for routing and visibility.

---

## Configuration

Settings in \`~/.varie/config.yaml\`:

| Setting | Values | Effect |
|---------|--------|--------|
| \`autoLaunch\` | \`true\`/\`false\` | Auto-launch Workstation on Claude Code start |
| \`skipPermissions\` | \`true\`/\`false\` | Start sessions with \`--dangerously-skip-permissions\` |

Use \`/workstation skip-permissions on\` to enable autonomous mode for all new sessions.
Use \`/workstation skip-permissions off\` to return to default permission prompts.

When \`skipPermissions: true\`, all sessions (manager + workers) start Claude with \`--dangerously-skip-permissions\`, skipping interactive permission prompts for fully autonomous operation.
`;


// ============================================================================
// Initialization
// ============================================================================

/**
 * Initialize the Manager workspace directory structure.
 * Creates directories and template files if they don't exist.
 * Does NOT overwrite existing files.
 */
export function initManagerWorkspace(): void {
  log('INFO', 'Initializing Manager workspace...');

  // Create directories
  const dirs = [VARIE_HOME, MANAGER_HOME, SESSIONS_DIR, MANAGER_FILES.reports];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      log('INFO', `Created directory: ${dir}`);
    }
  }

  // Create template files (only if they don't exist)
  const templates: Array<{ path: string; content: string; name: string }> = [
    { path: MANAGER_FILES.claudeMd, content: CLAUDE_MD_TEMPLATE, name: 'CLAUDE.md' },
    { path: MANAGER_FILES.config, content: CONFIG_TEMPLATE, name: 'config.yaml' },
    { path: MANAGER_FILES.projects, content: PROJECTS_TEMPLATE, name: 'projects.yaml' },
    { path: MANAGER_FILES.rules, content: RULES_TEMPLATE, name: 'rules.md' },
    { path: MANAGER_FILES.decisions, content: DECISIONS_TEMPLATE, name: 'decisions.md' },
    { path: MANAGER_FILES.state, content: STATE_TEMPLATE, name: 'state.yaml' },
  ];

  for (const { path: filePath, content, name } of templates) {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, content, 'utf-8');
      log('INFO', `Created template: ${name}`);
    }
  }

  log('INFO', 'Manager workspace ready:', MANAGER_HOME);
}

/**
 * Check if Manager workspace exists and is valid.
 */
export function isManagerWorkspaceValid(): boolean {
  return (
    fs.existsSync(MANAGER_HOME) &&
    fs.existsSync(MANAGER_FILES.projects) &&
    fs.existsSync(MANAGER_FILES.state)
  );
}

/**
 * Get the Manager home directory path.
 */
export function getManagerHome(): string {
  return MANAGER_HOME;
}

/**
 * Read a file from the Manager workspace.
 */
export function readManagerFile(filename: keyof typeof MANAGER_FILES): string | null {
  const filePath = MANAGER_FILES[filename];
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath, 'utf-8');
}

/**
 * Write a file to the Manager workspace.
 */
export function writeManagerFile(filename: keyof typeof MANAGER_FILES, content: string): void {
  const filePath = MANAGER_FILES[filename];
  if (!filePath) {
    log('ERROR', `Unknown manager file: ${filename}`);
    return;
  }
  fs.writeFileSync(filePath, content, 'utf-8');
  log('INFO', `Updated manager file: ${filename}`);
}

// ============================================================================
// Projects YAML Management
// ============================================================================

export interface RepoDiscovery {
  name: string;
  path: string;
  hasClaudeMd: boolean;
}

/** @internal - exported for testing */
export interface ProjectEntry {
  repos: Array<{ path: string; role?: string }>;
  status?: string;
  current_feature?: string;
  last_updated?: string;
}

/** @internal - exported for testing */
export interface ProjectsData {
  projects: Record<string, ProjectEntry>;
  repo_aliases: Record<string, string>;
}

/**
 * Parse projects.yaml into a structured object
 * @internal - exported for testing
 */
export function parseProjectsYaml(content: string): ProjectsData {
  const result: ProjectsData = {
    projects: {},
    repo_aliases: {},
  };

  const lines = content.split('\n');
  let currentSection: 'projects' | 'repo_aliases' | null = null;
  let currentProject: string | null = null;
  let currentProjectData: ProjectEntry | null = null;
  let inReposArray = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip comments and empty lines
    if (trimmed.startsWith('#') || trimmed === '') continue;

    // Top-level sections
    if (line.match(/^projects:\s*(\{\})?\s*$/)) {
      currentSection = 'projects';
      continue;
    }
    if (line.match(/^repo_aliases:\s*(\{\})?\s*$/)) {
      // Save current project
      if (currentProject && currentProjectData) {
        result.projects[currentProject] = currentProjectData;
      }
      currentSection = 'repo_aliases';
      currentProject = null;
      currentProjectData = null;
      continue;
    }

    // In projects section
    if (currentSection === 'projects') {
      // New project entry (2 spaces indent)
      const projectMatch = line.match(/^  (\w[\w-]*):\s*$/);
      if (projectMatch) {
        // Save previous project
        if (currentProject && currentProjectData) {
          result.projects[currentProject] = currentProjectData;
        }
        currentProject = projectMatch[1];
        currentProjectData = { repos: [] };
        inReposArray = false;
        continue;
      }

      // repos array start
      if (line.match(/^    repos:\s*$/)) {
        inReposArray = true;
        continue;
      }

      // repo array item
      if (inReposArray && line.match(/^      - /)) {
        const pathMatch = line.match(/^      - path:\s*(.+)$/);
        if (pathMatch && currentProjectData) {
          currentProjectData.repos.push({ path: pathMatch[1].trim() });
        }
        continue;
      }

      // repo item role
      if (inReposArray && line.match(/^        role:/)) {
        const roleMatch = line.match(/^        role:\s*(.+)$/);
        if (roleMatch && currentProjectData && currentProjectData.repos.length > 0) {
          currentProjectData.repos[currentProjectData.repos.length - 1].role = roleMatch[1].trim();
        }
        continue;
      }

      // Other project fields
      if (currentProjectData) {
        const statusMatch = line.match(/^    status:\s*(.+)$/);
        if (statusMatch) {
          currentProjectData.status = statusMatch[1].trim();
          inReposArray = false;
          continue;
        }

        const featureMatch = line.match(/^    current_feature:\s*(.+)$/);
        if (featureMatch) {
          currentProjectData.current_feature = featureMatch[1].trim();
          inReposArray = false;
          continue;
        }

        const updatedMatch = line.match(/^    last_updated:\s*(.+)$/);
        if (updatedMatch) {
          currentProjectData.last_updated = updatedMatch[1].trim();
          inReposArray = false;
          continue;
        }
      }
    }

    // In repo_aliases section
    if (currentSection === 'repo_aliases') {
      const aliasMatch = line.match(/^  (\w[\w-]*):\s*(.+)$/);
      if (aliasMatch) {
        result.repo_aliases[aliasMatch[1]] = aliasMatch[2].trim();
      }
    }
  }

  // Save last project
  if (currentProject && currentProjectData) {
    result.projects[currentProject] = currentProjectData;
  }

  return result;
}

/**
 * Serialize projects data back to YAML format
 * @internal - exported for testing
 */
export function serializeProjectsYaml(data: ProjectsData): string {
  const lines: string[] = [
    '# Workstation - Project Index',
    '',
    'projects:',
  ];

  const projectNames = Object.keys(data.projects).sort();

  if (projectNames.length === 0) {
    lines.push('  # No projects yet - add repos or use /work-start in a repo');
  } else {
    for (const name of projectNames) {
      const project = data.projects[name];
      lines.push(`  ${name}:`);
      lines.push('    repos:');
      for (const repo of project.repos) {
        lines.push(`      - path: ${repo.path}`);
        if (repo.role) {
          lines.push(`        role: ${repo.role}`);
        }
      }
      if (project.status) {
        lines.push(`    status: ${project.status}`);
      }
      if (project.current_feature) {
        lines.push(`    current_feature: ${project.current_feature}`);
      }
      if (project.last_updated) {
        lines.push(`    last_updated: ${project.last_updated}`);
      }
    }
  }

  lines.push('');
  lines.push('repo_aliases:');

  const aliasNames = Object.keys(data.repo_aliases).sort();
  if (aliasNames.length === 0) {
    lines.push('  # Add aliases: shortname: project_name');
  } else {
    for (const alias of aliasNames) {
      lines.push(`  ${alias}: ${data.repo_aliases[alias]}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Sync discovered repos to projects.yaml
 * - Adds new repos as projects (doesn't overwrite existing)
 * - Uses repo name as project name
 * - Sets status to 'discovered' for new entries
 */
// ============================================================================
// CLAUDE.md Injection for Discovered Repos
// ============================================================================

const VARIE_CLAUDEMD_SECTION = `
## Workstation

Key skills: \`/work-start\`, \`/work-checkpoint\`, \`/work-handover\`, \`/work-status\`.
`;

const VARIE_SECTION_MARKER = '## Workstation';

/**
 * Check if a CLAUDE.md file already has the Workstation section
 */
function hasVarieSection(claudeMdContent: string): boolean {
  return claudeMdContent.includes(VARIE_SECTION_MARKER);
}

/**
 * Inject Workstation section into an existing CLAUDE.md file
 * Returns true if injection was performed, false if skipped
 */
export function injectVarieSectionToClaudeMd(repoPath: string): boolean {
  const claudeMdPath = path.join(repoPath, 'CLAUDE.md');

  // Only inject if CLAUDE.md exists
  if (!fs.existsSync(claudeMdPath)) {
    return false;
  }

  try {
    const content = fs.readFileSync(claudeMdPath, 'utf-8');

    // Skip if already has the section
    if (hasVarieSection(content)) {
      log('DEBUG', `Skipping ${repoPath} - already has Varie section`);
      return false;
    }

    // Append the section
    const newContent = content.trimEnd() + '\n' + VARIE_CLAUDEMD_SECTION;
    fs.writeFileSync(claudeMdPath, newContent, 'utf-8');
    log('INFO', `Injected Varie section into ${claudeMdPath}`);
    return true;
  } catch (err) {
    log('WARN', `Failed to inject Varie section into ${claudeMdPath}:`, err);
    return false;
  }
}

/**
 * Read repos from projects.yaml for RepoResolver to use as a source.
 * Returns a flat array of {name, path} entries.
 */
export function getReposFromProjectsYaml(): Array<{ name: string; path: string }> {
  const content = readManagerFile('projects');
  if (!content) return [];

  const data = parseProjectsYaml(content);
  const repos: Array<{ name: string; path: string }> = [];

  for (const [name, project] of Object.entries(data.projects)) {
    for (const repo of project.repos) {
      repos.push({ name, path: repo.path });
    }
  }

  return repos;
}

export function syncDiscoveredRepos(repos: RepoDiscovery[]): number {
  log('INFO', `Syncing ${repos.length} discovered repos to projects.yaml...`);

  // Read current projects.yaml
  const content = readManagerFile('projects');
  if (!content) {
    log('WARN', 'Could not read projects.yaml');
    return 0;
  }

  const data = parseProjectsYaml(content);
  let added = 0;
  let injected = 0;

  // Build a set of existing paths for deduplication
  const existingPaths = new Set<string>();
  for (const project of Object.values(data.projects)) {
    for (const repo of project.repos) {
      existingPaths.add(repo.path);
    }
  }

  // Add new repos (skip if path already exists in any project)
  for (const repo of repos) {
    if (existingPaths.has(repo.path)) {
      continue;
    }

    // Use repo name as project name (normalize to lowercase with underscores)
    const projectName = repo.name.toLowerCase().replace(/-/g, '_');

    // If project with same name exists, skip (user may have customized it)
    if (data.projects[projectName]) {
      continue;
    }

    // Add new project
    data.projects[projectName] = {
      repos: [{ path: repo.path }],
      status: repo.hasClaudeMd ? 'active' : 'discovered',
      last_updated: new Date().toISOString(),
    };

    // Inject Varie section into CLAUDE.md if it exists
    if (repo.hasClaudeMd) {
      if (injectVarieSectionToClaudeMd(repo.path)) {
        injected++;
      }
    }

    added++;
    log('INFO', `Added project: ${projectName} -> ${repo.path}`);
  }

  // Write back if we added anything
  if (added > 0) {
    const newContent = serializeProjectsYaml(data);
    writeManagerFile('projects', newContent);
    log('INFO', `Synced ${added} new repos to projects.yaml (injected ${injected} CLAUDE.md sections)`);
  } else {
    log('INFO', 'No new repos to sync');
  }

  return added;
}
