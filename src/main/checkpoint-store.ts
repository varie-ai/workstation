/**
 * Checkpoint Store for Varie Workstation
 *
 * Reads and writes checkpoint files to ~/.varie/
 * Manages workspace state and session checkpoints.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'yaml';
import { log } from './logger';
import type { Session, Workspace, SessionSummary } from '../shared/types';

const VARIE_DIR = path.join(os.homedir(), '.varie');
const SESSIONS_DIR = path.join(VARIE_DIR, 'sessions');
const WORKSPACE_FILE = path.join(VARIE_DIR, 'workspace.yaml');

export class CheckpointStore {
  constructor() {
    this.ensureDirectories();
  }

  private ensureDirectories(): void {
    if (!fs.existsSync(VARIE_DIR)) {
      fs.mkdirSync(VARIE_DIR, { recursive: true });
      log('INFO', 'Created ~/.varie directory');
    }
    if (!fs.existsSync(SESSIONS_DIR)) {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      log('INFO', 'Created ~/.varie/sessions directory');
    }
  }

  // =========================================================================
  // Session Checkpoints
  // =========================================================================

  /**
   * Save a session checkpoint
   */
  saveSession(session: Session): void {
    const filePath = path.join(SESSIONS_DIR, `${session.session_id}.yaml`);
    try {
      const content = yaml.stringify(session);
      fs.writeFileSync(filePath, content, 'utf-8');
      log('INFO', `Saved session checkpoint: ${session.session_id}`);
    } catch (err) {
      log('ERROR', `Failed to save session ${session.session_id}:`, err);
    }
  }

  /**
   * Load a session checkpoint
   */
  loadSession(sessionId: string): Session | null {
    const filePath = path.join(SESSIONS_DIR, `${sessionId}.yaml`);
    try {
      if (!fs.existsSync(filePath)) {
        return null;
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      return yaml.parse(content) as Session;
    } catch (err) {
      log('ERROR', `Failed to load session ${sessionId}:`, err);
      return null;
    }
  }

  /**
   * Delete a session checkpoint
   */
  deleteSession(sessionId: string): void {
    const filePath = path.join(SESSIONS_DIR, `${sessionId}.yaml`);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        log('INFO', `Deleted session checkpoint: ${sessionId}`);
      }
    } catch (err) {
      log('ERROR', `Failed to delete session ${sessionId}:`, err);
    }
  }

  /**
   * List all saved sessions
   */
  listSessions(): string[] {
    try {
      const files = fs.readdirSync(SESSIONS_DIR);
      return files
        .filter((f) => f.endsWith('.yaml'))
        .map((f) => f.replace('.yaml', ''));
    } catch (err) {
      log('ERROR', 'Failed to list sessions:', err);
      return [];
    }
  }

  /**
   * Load all session checkpoints
   */
  loadAllSessions(): Session[] {
    const sessionIds = this.listSessions();
    const sessions: Session[] = [];
    for (const id of sessionIds) {
      const session = this.loadSession(id);
      if (session) {
        sessions.push(session);
      }
    }
    return sessions;
  }

  // =========================================================================
  // Workspace State
  // =========================================================================

  /**
   * Load workspace state
   */
  loadWorkspace(): Workspace | null {
    try {
      if (!fs.existsSync(WORKSPACE_FILE)) {
        return null;
      }
      const content = fs.readFileSync(WORKSPACE_FILE, 'utf-8');
      return yaml.parse(content) as Workspace;
    } catch (err) {
      log('ERROR', 'Failed to load workspace:', err);
      return null;
    }
  }

  /**
   * Save workspace state
   */
  saveWorkspace(workspace: Workspace): void {
    try {
      const content = yaml.stringify(workspace);
      fs.writeFileSync(WORKSPACE_FILE, content, 'utf-8');
      log('INFO', 'Saved workspace state');
    } catch (err) {
      log('ERROR', 'Failed to save workspace:', err);
    }
  }

  /**
   * Update workspace with current active sessions
   */
  updateWorkspaceActiveSessions(sessions: SessionSummary[]): void {
    let workspace = this.loadWorkspace();
    if (!workspace) {
      workspace = {
        root: path.join(os.homedir(), 'workplace', 'projects'),
        repos: {},
        active_sessions: [],
      };
    }
    workspace.active_sessions = sessions;
    this.saveWorkspace(workspace);
  }

  /**
   * Get session summaries for workspace
   */
  getSessionSummaries(): SessionSummary[] {
    const sessions = this.loadAllSessions();
    return sessions.map((s) => ({
      session_id: s.session_id,
      repo: s.repo,
      task: s.task.name,
      current_step: s.current_step,
      status: s.steps.find((step) => step.id === s.current_step)?.status || 'pending',
      last_active: s.last_active,
    }));
  }

  // =========================================================================
  // Utility Methods
  // =========================================================================

  /**
   * Get the path to the varie directory
   */
  getVarieDir(): string {
    return VARIE_DIR;
  }

  /**
   * Get the path to the sessions directory
   */
  getSessionsDir(): string {
    return SESSIONS_DIR;
  }

  /**
   * Check if a session checkpoint exists
   */
  sessionExists(sessionId: string): boolean {
    const filePath = path.join(SESSIONS_DIR, `${sessionId}.yaml`);
    return fs.existsSync(filePath);
  }

  /**
   * Clean up old/stale sessions
   * Sessions older than maxAgeDays without activity are removed
   */
  cleanupStaleSessions(maxAgeDays: number = 30): void {
    const now = Date.now();
    const maxAge = maxAgeDays * 24 * 60 * 60 * 1000;

    const sessions = this.loadAllSessions();
    for (const session of sessions) {
      const lastActive = new Date(session.last_active).getTime();
      if (now - lastActive > maxAge) {
        log('INFO', `Cleaning up stale session: ${session.session_id}`);
        this.deleteSession(session.session_id);
      }
    }
  }
}
