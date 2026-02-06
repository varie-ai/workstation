/**
 * Manager State Persistence
 *
 * Persists Manager state (active sessions, recent context) to ~/.varie/manager/state.yaml
 * Enables session recovery across daemon restarts.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { log } from './logger';

export interface SessionState {
  sessionId: string;
  repo: string;
  repoPath: string;
  tabIndex: number;
  type: 'orchestrator' | 'worker';
  taskId?: string;
  status: 'active' | 'idle';
  createdAt: string;
  lastActive: string;
}

export interface ManagerState {
  lastUpdated: string;
  activeSessions: SessionState[];
  recentContext: string[];
}

const STATE_FILE = path.join(os.homedir(), '.varie', 'manager', 'state.yaml');
const AUTO_SAVE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let currentState: ManagerState = {
  lastUpdated: new Date().toISOString(),
  activeSessions: [],
  recentContext: [],
};

let autoSaveTimer: NodeJS.Timeout | null = null;

/**
 * Load state from disk
 */
export function loadState(): ManagerState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const content = fs.readFileSync(STATE_FILE, 'utf-8');
      const parsed = parseYaml(content);
      if (parsed) {
        currentState = {
          lastUpdated: parsed.last_updated || new Date().toISOString(),
          activeSessions: (parsed.active_sessions || []).map((s: Record<string, unknown>) => ({
            sessionId: s.session_id || '',
            repo: s.repo || '',
            repoPath: s.repo_path || '',
            tabIndex: s.tab_index || 0,
            type: s.type || 'worker',
            taskId: s.task_id,
            status: s.status || 'idle',
            createdAt: s.created_at || new Date().toISOString(),
            lastActive: s.last_active || new Date().toISOString(),
          })),
          recentContext: parsed.recent_context || [],
        };
        log('INFO', `Loaded Manager state: ${currentState.activeSessions.length} sessions`);
      }
    }
  } catch (err) {
    log('WARN', `Failed to load Manager state: ${err}`);
  }
  return currentState;
}

/**
 * Save state to disk
 */
export function saveState(): void {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    currentState.lastUpdated = new Date().toISOString();
    const yaml = serializeYaml(currentState);
    fs.writeFileSync(STATE_FILE, yaml, 'utf-8');
    log('DEBUG', `Saved Manager state: ${currentState.activeSessions.length} sessions`);
  } catch (err) {
    log('ERROR', `Failed to save Manager state: ${err}`);
  }
}

/**
 * Get current state
 */
export function getState(): ManagerState {
  return currentState;
}

/**
 * Update session in state
 */
export function updateSession(session: SessionState): void {
  const idx = currentState.activeSessions.findIndex((s) => s.sessionId === session.sessionId);
  if (idx >= 0) {
    currentState.activeSessions[idx] = session;
  } else {
    currentState.activeSessions.push(session);
  }
  saveState();
}

/**
 * Remove session from state
 */
export function removeSession(sessionId: string): void {
  currentState.activeSessions = currentState.activeSessions.filter(
    (s) => s.sessionId !== sessionId
  );
  saveState();
}

/**
 * Add context note
 */
export function addContextNote(note: string): void {
  currentState.recentContext.unshift(note);
  // Keep only last 10 notes
  if (currentState.recentContext.length > 10) {
    currentState.recentContext = currentState.recentContext.slice(0, 10);
  }
  saveState();
}

/**
 * Clear all sessions (on fresh start)
 */
export function clearSessions(): void {
  currentState.activeSessions = [];
  saveState();
}

/**
 * Start auto-save timer
 */
export function startAutoSave(): void {
  if (autoSaveTimer) {
    clearInterval(autoSaveTimer);
  }
  autoSaveTimer = setInterval(() => {
    saveState();
    log('DEBUG', 'Auto-saved Manager state');
  }, AUTO_SAVE_INTERVAL_MS);
  log('INFO', `Started auto-save (every ${AUTO_SAVE_INTERVAL_MS / 1000}s)`);
}

/**
 * Stop auto-save timer
 */
export function stopAutoSave(): void {
  if (autoSaveTimer) {
    clearInterval(autoSaveTimer);
    autoSaveTimer = null;
    log('INFO', 'Stopped auto-save');
  }
}

// Simple YAML parser (handles our specific format)
function parseYaml(content: string): Record<string, unknown> | null {
  try {
    const result: Record<string, unknown> = {};
    const lines = content.split('\n');
    let currentKey = '';
    let currentArray: Record<string, unknown>[] = [];
    let currentObject: Record<string, unknown> = {};
    let inArray = false;
    let inArrayItem = false;

    for (const line of lines) {
      // Skip comments and empty lines
      if (line.trim().startsWith('#') || line.trim() === '') continue;

      // Check for array item start
      if (line.match(/^\s+-\s+\w+:/)) {
        if (inArrayItem && Object.keys(currentObject).length > 0) {
          currentArray.push(currentObject);
        }
        currentObject = {};
        inArrayItem = true;
        // Parse the first field of the array item
        const match = line.match(/^\s+-\s+(\w+):\s*(.*)$/);
        if (match) {
          currentObject[match[1]] = parseValue(match[2]);
        }
        continue;
      }

      // Check for array item field continuation
      if (inArrayItem && line.match(/^\s{4,}\w+:/)) {
        const match = line.match(/^\s+(\w+):\s*(.*)$/);
        if (match) {
          currentObject[match[1]] = parseValue(match[2]);
        }
        continue;
      }

      // Check for top-level array key
      if (line.match(/^[\w_]+:\s*$/)) {
        // Save previous array if exists
        if (inArray && currentKey && currentArray.length > 0) {
          if (inArrayItem && Object.keys(currentObject).length > 0) {
            currentArray.push(currentObject);
          }
          result[currentKey] = currentArray;
        }

        currentKey = line.replace(':', '').trim();
        currentArray = [];
        currentObject = {};
        inArray = true;
        inArrayItem = false;
        continue;
      }

      // Check for simple key-value
      const kvMatch = line.match(/^([\w_]+):\s*(.+)$/);
      if (kvMatch) {
        if (inArray && currentKey && currentArray.length > 0) {
          if (inArrayItem && Object.keys(currentObject).length > 0) {
            currentArray.push(currentObject);
          }
          result[currentKey] = currentArray;
          currentArray = [];
          currentObject = {};
          inArray = false;
          inArrayItem = false;
        }
        result[kvMatch[1]] = parseValue(kvMatch[2]);
      }
    }

    // Save final array
    if (inArray && currentKey) {
      if (inArrayItem && Object.keys(currentObject).length > 0) {
        currentArray.push(currentObject);
      }
      if (currentArray.length > 0) {
        result[currentKey] = currentArray;
      }
    }

    return result;
  } catch (err) {
    log('WARN', `YAML parse error: ${err}`);
    return null;
  }
}

function parseValue(value: string): string | number | boolean {
  const trimmed = value.trim();
  // Remove quotes
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  // Boolean
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  // Number
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);
  return trimmed;
}

// Simple YAML serializer
function serializeYaml(state: ManagerState): string {
  const lines: string[] = [
    '# Workstation Manager State',
    '# Auto-generated - do not edit manually',
    '',
    `last_updated: "${state.lastUpdated}"`,
    '',
    'active_sessions:',
  ];

  for (const session of state.activeSessions) {
    lines.push(`  - session_id: "${session.sessionId}"`);
    lines.push(`    repo: "${session.repo}"`);
    lines.push(`    repo_path: "${session.repoPath}"`);
    lines.push(`    tab_index: ${session.tabIndex}`);
    lines.push(`    type: "${session.type}"`);
    if (session.taskId) {
      lines.push(`    task_id: "${session.taskId}"`);
    }
    lines.push(`    status: "${session.status}"`);
    lines.push(`    created_at: "${session.createdAt}"`);
    lines.push(`    last_active: "${session.lastActive}"`);
  }

  if (state.activeSessions.length === 0) {
    lines.push('  # No active sessions');
  }

  lines.push('');
  lines.push('recent_context:');
  for (const note of state.recentContext) {
    lines.push(`  - "${note.replace(/"/g, '\\"')}"`);
  }
  if (state.recentContext.length === 0) {
    lines.push('  # No recent context');
  }

  return lines.join('\n') + '\n';
}
