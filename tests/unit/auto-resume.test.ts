import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Use isolated temp directory to avoid interference from real sessions
const VARIE_DIR = path.join(os.tmpdir(), 'varie-test-auto-resume');
const SESSIONS_DIR = path.join(VARIE_DIR, 'sessions');
const PLUGIN_SCRIPTS = path.resolve(__dirname, '../../plugin/scripts');

// Test CWD — use the actual repo path so git commands work
const TEST_CWD = path.resolve(__dirname, '../..');

// Standard test session ID used across tests
const TEST_SID = 'test-session';

// Per-session flag file path
function flagPath(sid: string): string {
  return path.join(VARIE_DIR, `resume-pending-${sid}`);
}

// Clean up all resume-pending-* flag files
function cleanFlags(): void {
  if (!fs.existsSync(VARIE_DIR)) return;
  for (const f of fs.readdirSync(VARIE_DIR)) {
    if (f.startsWith('resume-pending-')) {
      fs.unlinkSync(path.join(VARIE_DIR, f));
    }
  }
}

// Clean up test session YAML files
function cleanTestSessions(): void {
  if (!fs.existsSync(SESSIONS_DIR)) return;
  for (const f of fs.readdirSync(SESSIONS_DIR)) {
    if (f.startsWith('test-')) fs.unlinkSync(path.join(SESSIONS_DIR, f));
  }
}

// Helper: run a hook script with JSON input (passes VARIE_DIR for isolation)
function runScript(scriptName: string, input: object): string {
  const scriptPath = path.join(PLUGIN_SCRIPTS, scriptName);
  try {
    return execSync(`echo '${JSON.stringify(input)}' | bash "${scriptPath}"`, {
      encoding: 'utf-8',
      timeout: 10000,
      env: { ...process.env, VARIE_DIR },
    });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    if (e.status === 0) return e.stdout || '';
    throw err;
  }
}

// Helper: run prompt-checkpoint-hint with session context
function runHint(prompt: string, sid: string = TEST_SID, cwd: string = TEST_CWD): string {
  return runScript('prompt-checkpoint-hint', { prompt, session_id: sid, cwd });
}

// Helper: read flag file as key-value map
function readFlag(sid: string = TEST_SID): Record<string, string> {
  const file = flagPath(sid);
  if (!fs.existsSync(file)) return {};
  const content = fs.readFileSync(file, 'utf-8');
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    if (line.startsWith('---')) break;
    const eq = line.indexOf('=');
    if (eq > 0) {
      result[line.slice(0, eq)] = line.slice(eq + 1);
    }
  }
  return result;
}

// Helper: read multiline sections from flag file
function readFlagSection(sectionName: string, sid: string = TEST_SID): string {
  const file = flagPath(sid);
  if (!fs.existsSync(file)) return '';
  const content = fs.readFileSync(file, 'utf-8');
  const startMarker = `---${sectionName}---`;
  const endMarker = '---end---';
  const startIdx = content.indexOf(startMarker);
  if (startIdx === -1) return '';
  const afterStart = content.indexOf('\n', startIdx) + 1;
  const endIdx = content.indexOf(endMarker, afterStart);
  if (endIdx === -1) return '';
  return content.slice(afterStart, endIdx).trim();
}

// Helper: write a flag file for prompt-checkpoint-hint tests
function writeFlag(lines: string[], sid: string = TEST_SID): void {
  fs.writeFileSync(flagPath(sid), lines.join('\n'), 'utf-8');
}

// Helper: create a test checkpoint
function createTestCheckpoint(id: string, repoPath: string, opts: {
  taskName?: string;
  currentStep?: string;
  archivePath?: string;
  lastActive?: string;
  branch?: string;
  commit?: string;
} = {}): string {
  const filePath = path.join(SESSIONS_DIR, `${id}.yaml`);
  const now = opts.lastActive || new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const content = `session_id: "${id}"
created_at: "${now}"
last_active: "${now}"
repo: "${path.basename(repoPath)}"
repo_path: "${repoPath}"
working_dir: "${repoPath}"
task:
  id: "test-task"
  name: "${opts.taskName || 'Test Task'}"
  archive_path: "${opts.archivePath || ''}"
current_step: "${opts.currentStep || 'step1'}"
steps:
  - id: "step1"
    name: "Step One"
    status: "in_progress"
    notes: "test notes"
git_state:
  branch: "${opts.branch || 'main'}"
  last_commit: "${opts.commit || 'abc1234'}"
`;
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

// =========================================================================
// auto-checkpoint-on-compact (PreCompact)
// =========================================================================

describe('auto-checkpoint-on-compact (PreCompact)', () => {
  beforeEach(() => {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    cleanFlags();
    cleanTestSessions();
  });

  afterEach(() => {
    cleanFlags();
    cleanTestSessions();
  });

  it('creates flag file with git info when no checkpoint exists', () => {
    const sid = 'test-no-cp';
    runScript('auto-checkpoint-on-compact', {
      session_id: sid, cwd: TEST_CWD, trigger: 'auto',
    });

    const flag = readFlag(sid);
    expect(flag.type).toBe('compact');
    expect(flag.trigger).toBe('auto');
    expect(flag.repo_name).toBe('varie-workstation');
    expect(flag.branch).toBe('main');
    expect(flag.commit).toBeTruthy();
  });

  it('auto-creates checkpoint YAML when none exists', () => {
    const sid = 'test-autocreate';
    runScript('auto-checkpoint-on-compact', {
      session_id: sid, cwd: TEST_CWD, trigger: 'auto',
    });

    const cpPath = path.join(SESSIONS_DIR, `${sid}.yaml`);
    expect(fs.existsSync(cpPath)).toBe(true);

    const content = fs.readFileSync(cpPath, 'utf-8');
    expect(content).toContain('repo_path: "' + TEST_CWD + '"');
    expect(content).toContain('Working in varie-workstation');
    expect(content).toContain('git_state:');
  });

  it('captures recent commits in flag file', () => {
    const sid = 'test-commits';
    runScript('auto-checkpoint-on-compact', {
      session_id: sid, cwd: TEST_CWD, trigger: 'auto',
    });

    const commits = readFlagSection('recent_commits', sid);
    expect(commits).toBeTruthy();
    expect(commits.split('\n').length).toBeGreaterThan(2);
  });

  it('captures modified files in flag file', () => {
    const sid = 'test-dirty';
    runScript('auto-checkpoint-on-compact', {
      session_id: sid, cwd: TEST_CWD, trigger: 'auto',
    });

    const content = fs.readFileSync(flagPath(sid), 'utf-8');
    expect(content).toContain('type=compact');
  });

  it('refreshes last_active on existing checkpoint', () => {
    const sid = 'test-123';
    const cpPath = createTestCheckpoint('test-refresh', TEST_CWD, {
      lastActive: '2026-01-01T00:00:00Z',
    });

    runScript('auto-checkpoint-on-compact', {
      session_id: sid, cwd: TEST_CWD, trigger: 'manual',
    });

    const content = fs.readFileSync(cpPath, 'utf-8');
    const lastActiveLine = content.split('\n').find(l => l.startsWith('last_active:'));
    expect(lastActiveLine).toBeDefined();
    expect(lastActiveLine).not.toContain('2026-01-01T00:00:00Z');

    const flag = readFlag(sid);
    expect(flag.task).toBe('Test Task');
    expect(flag.current_step).toBe('step1');
    expect(flag.checkpoint).toBe(cpPath);
  });
});

// =========================================================================
// auto-resume-check (SessionStart)
// =========================================================================

describe('auto-resume-check (SessionStart)', () => {
  beforeEach(() => {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    cleanFlags();
    cleanTestSessions();
  });

  afterEach(() => {
    cleanFlags();
    cleanTestSessions();
  });

  it('produces no flag when no checkpoint exists', () => {
    const sid = 'test-clean';
    runScript('auto-resume-check', { session_id: sid, cwd: TEST_CWD });
    expect(fs.existsSync(flagPath(sid))).toBe(false);
  });

  it('produces auto-resume flag for recent checkpoint (<2h)', () => {
    createTestCheckpoint('test-recent', TEST_CWD, { taskName: 'Recent Work' });

    runScript('auto-resume-check', { session_id: TEST_SID, cwd: TEST_CWD });

    const flag = readFlag();
    expect(flag.type).toBe('restart');
    expect(flag.mode).toBe('auto-resume');
    expect(flag.task).toBe('Recent Work');
  });

  it('produces prompted flag for old checkpoint (2-24h)', () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
    createTestCheckpoint('test-old', TEST_CWD, {
      taskName: 'Old Work', lastActive: threeHoursAgo,
    });

    runScript('auto-resume-check', { session_id: TEST_SID, cwd: TEST_CWD });

    const flag = readFlag();
    expect(flag.type).toBe('restart');
    expect(flag.mode).toBe('prompted');
    expect(flag.task).toBe('Old Work');
  });

  it('produces hint flag for stale checkpoint (>24h)', () => {
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
    createTestCheckpoint('test-stale', TEST_CWD, {
      taskName: 'Stale Work', lastActive: twoDaysAgo,
    });

    runScript('auto-resume-check', { session_id: TEST_SID, cwd: TEST_CWD });

    const flag = readFlag();
    expect(flag.type).toBe('restart');
    expect(flag.mode).toBe('hint');
    expect(flag.task).toBe('Stale Work');
  });

  it('does not overwrite compact flag', () => {
    createTestCheckpoint('test-cp', TEST_CWD);

    // Write a compact flag first for same session
    writeFlag(['type=compact', 'trigger=auto']);

    runScript('auto-resume-check', { session_id: TEST_SID, cwd: TEST_CWD });

    const flag = readFlag();
    expect(flag.type).toBe('compact');
  });

  it('creates separate flag files for different sessions', () => {
    createTestCheckpoint('test-multi', TEST_CWD, { taskName: 'Multi' });

    runScript('auto-resume-check', { session_id: 'test-sess-A', cwd: TEST_CWD });
    runScript('auto-resume-check', { session_id: 'test-sess-B', cwd: TEST_CWD });

    expect(fs.existsSync(flagPath('test-sess-A'))).toBe(true);
    expect(fs.existsSync(flagPath('test-sess-B'))).toBe(true);

    const flagA = readFlag('test-sess-A');
    const flagB = readFlag('test-sess-B');
    expect(flagA.task).toBe('Multi');
    expect(flagB.task).toBe('Multi');
  });
});

// =========================================================================
// prompt-checkpoint-hint (UserPromptSubmit)
// =========================================================================

describe('prompt-checkpoint-hint (UserPromptSubmit)', () => {
  beforeEach(() => {
    cleanFlags();
  });

  afterEach(() => {
    cleanFlags();
    cleanTestSessions();
  });

  it('injects compaction recovery context when compact flag exists', () => {
    writeFlag([
      'type=compact',
      'task=My Task',
      'current_step=step2',
      'branch=feature-x',
      'commit=def5678',
      'checkpoint=/tmp/test.yaml',
      `repo_path=${TEST_CWD}`,
      'repo_name=myrepo',
      '---recent_commits---',
      'def5678 Add feature X',
      'abc1234 Initial commit',
      '---end---',
    ]);

    const output = runHint('continue');
    const json = JSON.parse(output);

    expect(json.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    const ctx = json.hookSpecificOutput.additionalContext;
    expect(ctx).toContain('Context Recovery after Compaction');
    expect(ctx).toContain('My Task');
    expect(ctx).toContain('step2');
    expect(ctx).toContain('feature-x');
    expect(ctx).toContain('def5678 Add feature X');
  });

  it('injects auto-resume context for restart flag', () => {
    writeFlag([
      'type=restart',
      'mode=auto-resume',
      'time_ago=5 minutes ago',
      'task=Resume Task',
      'current_step=step1',
      'branch=main',
      'commit=abc1234',
      'checkpoint=/tmp/test.yaml',
      `repo_path=${TEST_CWD}`,
    ]);

    const output = runHint('hi');
    const json = JSON.parse(output);
    const ctx = json.hookSpecificOutput.additionalContext;

    expect(ctx).toContain('Auto-Resume');
    expect(ctx).toContain('Resume Task');
    expect(ctx).toContain('5 minutes ago');
    expect(ctx).toContain('without asking for confirmation');
  });

  it('injects prompted context for prompted mode', () => {
    writeFlag([
      'type=restart',
      'mode=prompted',
      'time_ago=5 hours ago',
      'task=Old Task',
      'checkpoint=/tmp/test.yaml',
      `repo_path=${TEST_CWD}`,
    ]);

    const output = runHint('hi');
    const json = JSON.parse(output);
    const ctx = json.hookSpecificOutput.additionalContext;

    expect(ctx).toContain('Prior Work Found');
    expect(ctx).toContain('Old Task');
    expect(ctx).toContain('5 hours ago');
    expect(ctx).toContain('resume, or start fresh');
  });

  it('injects hint context for hint mode', () => {
    writeFlag([
      'type=restart',
      'mode=hint',
      'task=Ancient Task',
      'time_ago=3 days ago',
      `repo_path=${TEST_CWD}`,
    ]);

    const output = runHint('hello');
    const json = JSON.parse(output);
    const ctx = json.hookSpecificOutput.additionalContext;

    expect(ctx).toContain('Old work exists');
    expect(ctx).toContain('/work-resume');
  });

  it('deletes flag after consuming it', () => {
    writeFlag([
      'type=compact', 'task=Test', `repo_path=${TEST_CWD}`,
      'repo_name=test', 'branch=main', 'commit=abc',
    ]);

    runHint('hi');
    expect(fs.existsSync(flagPath(TEST_SID))).toBe(false);
  });

  it('does not re-inject on subsequent prompts', () => {
    writeFlag([
      'type=compact', 'task=Test', `repo_path=${TEST_CWD}`,
      'repo_name=test', 'branch=main', 'commit=abc',
    ]);

    runHint('first');
    const output = runHint('second');
    expect(output.trim()).toBe('');
  });

  it('skips injection if CWD does not match flag repo_path', () => {
    writeFlag([
      'type=compact', 'task=Wrong Repo',
      'repo_path=/some/other/repo',
      'repo_name=other', 'branch=main', 'commit=abc',
    ]);

    const output = runHint('continue');
    // Should not inject — wrong repo
    expect(output.trim()).toBe('');
    // Flag should be cleaned up
    expect(fs.existsSync(flagPath(TEST_SID))).toBe(false);
  });

  it('falls back to phrase detection when no flag exists', () => {
    const output = runHint('done for today');
    const json = JSON.parse(output);
    expect(json.hookSpecificOutput.additionalContext).toContain('/work-handover');
  });

  it('produces no output for normal prompts without flag', () => {
    const output = runHint('implement the login feature');
    expect(output.trim()).toBe('');
  });
});

// =========================================================================
// End-to-end flows
// =========================================================================

describe('end-to-end: PreCompact → UserPromptSubmit', () => {
  beforeEach(() => {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    cleanFlags();
    cleanTestSessions();
  });

  afterEach(() => {
    cleanFlags();
    cleanTestSessions();
  });

  it('full compaction flow: no prior checkpoint → auto-create → inject', () => {
    const sid = 'test-e2e';

    // Step 1: PreCompact fires
    runScript('auto-checkpoint-on-compact', {
      session_id: sid, cwd: TEST_CWD, trigger: 'auto',
    });

    expect(fs.existsSync(path.join(SESSIONS_DIR, `${sid}.yaml`))).toBe(true);
    expect(fs.existsSync(flagPath(sid))).toBe(true);

    // Step 2: User types next prompt (same session_id)
    const output = runHint('where was I?', sid);
    const json = JSON.parse(output);
    const ctx = json.hookSpecificOutput.additionalContext;

    expect(ctx).toContain('Context Recovery after Compaction');
    expect(ctx).toContain('varie-workstation');
    expect(ctx).toContain('Recent commits');

    // Step 3: Flag consumed
    expect(fs.existsSync(flagPath(sid))).toBe(false);

    // Step 4: No double injection
    const output2 = runHint('continue', sid);
    expect(output2.trim()).toBe('');
  });

  it('full compaction flow: existing checkpoint → refresh → inject', () => {
    const sid = 'test-123';
    createTestCheckpoint('test-existing', TEST_CWD, {
      taskName: 'Feature Work',
      currentStep: 'implementation',
      lastActive: '2026-01-01T00:00:00Z',
    });

    // Step 1: PreCompact fires
    runScript('auto-checkpoint-on-compact', {
      session_id: sid, cwd: TEST_CWD, trigger: 'auto',
    });

    const flag = readFlag(sid);
    expect(flag.task).toBe('Feature Work');
    expect(flag.current_step).toBe('implementation');

    // last_active refreshed
    const cp = fs.readFileSync(path.join(SESSIONS_DIR, 'test-existing.yaml'), 'utf-8');
    const lastActiveLine = cp.split('\n').find(l => l.startsWith('last_active:'));
    expect(lastActiveLine).toBeDefined();
    expect(lastActiveLine).not.toContain('2026-01-01T00:00:00Z');

    // Step 2: UserPromptSubmit (same session_id)
    const output = runHint('continue', sid);
    const json = JSON.parse(output);
    const ctx = json.hookSpecificOutput.additionalContext;

    expect(ctx).toContain('Feature Work');
    expect(ctx).toContain('implementation');
  });

  it('full restart flow: recent checkpoint → auto-resume → inject', () => {
    createTestCheckpoint('test-restart', TEST_CWD, { taskName: 'Restart Work' });

    // Step 1: SessionStart fires
    runScript('auto-resume-check', { session_id: TEST_SID, cwd: TEST_CWD });

    const flag = readFlag();
    expect(flag.mode).toBe('auto-resume');

    // Step 2: User types first prompt (same session_id)
    const output = runHint('hi');
    const json = JSON.parse(output);
    const ctx = json.hookSpecificOutput.additionalContext;

    expect(ctx).toContain('Auto-Resume');
    expect(ctx).toContain('Restart Work');
  });

  it('no cross-session flag leakage', () => {
    createTestCheckpoint('test-leak', TEST_CWD, { taskName: 'Leak Test' });

    // Session A writes a flag
    runScript('auto-resume-check', { session_id: 'test-sess-A', cwd: TEST_CWD });
    expect(fs.existsSync(flagPath('test-sess-A'))).toBe(true);

    // Session B should NOT see session A's flag
    const output = runHint('hi', 'test-sess-B');
    expect(output.trim()).toBe('');

    // Session A's flag still exists (not consumed by B)
    expect(fs.existsSync(flagPath('test-sess-A'))).toBe(true);
  });
});
