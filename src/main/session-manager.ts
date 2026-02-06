/**
 * Session Manager for Varie Workstation
 *
 * Manages terminal sessions using node-pty.
 * Tracks session state and provides dispatch capabilities.
 */

import * as pty from 'node-pty';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { log } from './logger';

export type SessionType = 'orchestrator' | 'worker';

export interface TerminalSession {
  id: string;
  pty: pty.IPty;
  repo: string;
  repoPath: string;
  taskId?: string;
  type: SessionType;
  createdAt: Date;
  lastActive: Date;
  // For external sessions (from plugin, not created by workstation)
  isExternal: boolean;
  // Claude CLI flags (e.g. '--dangerously-skip-permissions')
  claudeFlags?: string;
}

export type TerminalDataCallback = (sessionId: string, data: string) => void;
export type SessionEventCallback = (
  event: 'created' | 'closed' | 'updated',
  sessionId: string,
  session?: TerminalSession
) => void;

export class SessionManager {
  private sessions: Map<string, TerminalSession> = new Map();
  private onData: TerminalDataCallback;
  private onSessionEvent: SessionEventCallback;
  private bundledPluginPath: string | null = null;

  constructor(onData: TerminalDataCallback, onSessionEvent: SessionEventCallback) {
    this.onData = onData;
    this.onSessionEvent = onSessionEvent;
  }

  /**
   * Set the path to the bundled plugin directory.
   * When set, all Claude sessions will be started with --plugin-dir <path>.
   */
  setBundledPluginPath(pluginPath: string | null): void {
    this.bundledPluginPath = pluginPath;
    if (pluginPath) {
      log('INFO', `Bundled plugin path set: ${pluginPath}`);
    }
  }

  /**
   * Create a new terminal session
   */
  createSession(repo: string, repoPath: string, type: SessionType = 'worker', taskId?: string, claudeFlags?: string): string {
    const sessionId = this.generateSessionId();

    // Validate and resolve path
    let resolvedPath = repoPath;
    if (!path.isAbsolute(repoPath)) {
      resolvedPath = path.resolve(os.homedir(), repoPath);
    }

    // Check if path exists, fall back to home directory
    if (!fs.existsSync(resolvedPath)) {
      log('WARN', `Path does not exist: ${resolvedPath}, falling back to home directory`);
      resolvedPath = os.homedir();
    }

    // Manager session starts in ~/.varie/manager/
    const isManager = type === 'orchestrator';
    if (isManager) {
      const managerDir = path.join(os.homedir(), '.varie', 'manager');
      if (fs.existsSync(managerDir)) {
        resolvedPath = managerDir;
        log('INFO', `Manager session: using workspace directory ${resolvedPath}`);
      }
    }

    // Determine shell
    const shell =
      process.platform === 'win32'
        ? 'powershell.exe'
        : process.env.SHELL || '/bin/zsh';

    // Shell args - use login shell to ensure PATH is fully set up
    // (Electron inherits a minimal env; login shell sources /etc/zprofile etc.)
    const shellArgs: string[] = ['-l'];

    log('INFO', `Creating session ${sessionId} for ${repo} at ${resolvedPath}`);
    log('INFO', `Shell: ${shell} ${shellArgs.join(' ')}`);

    let ptyProcess: pty.IPty;
    try {
      // Spawn PTY
      ptyProcess = pty.spawn(shell, shellArgs, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: resolvedPath,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          // Pass session ID for plugin to discover
          VARIE_SESSION_ID: sessionId,
          // Manager session gets special env var for identity injection
          ...(isManager && { VARIE_MANAGER_SESSION: 'true' }),
        },
      });
    } catch (err) {
      log('ERROR', `Failed to spawn PTY:`, err);
      throw new Error(`Failed to create terminal: ${err}`);
    }

    const session: TerminalSession = {
      id: sessionId,
      pty: ptyProcess,
      repo,
      repoPath: resolvedPath,
      type,
      taskId,
      createdAt: new Date(),
      lastActive: new Date(),
      isExternal: false,
      claudeFlags,
    };

    // Handle PTY data
    ptyProcess.onData((data) => {
      session.lastActive = new Date();
      this.onData(sessionId, data);
    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode, signal }) => {
      log('INFO', `Session ${sessionId} exited with code ${exitCode}, signal ${signal}`);
      this.sessions.delete(sessionId);
      this.onSessionEvent('closed', sessionId);
    });

    this.sessions.set(sessionId, session);
    this.onSessionEvent('created', sessionId, session);

    // Auto-run claude for all sessions (orchestrator and workers)
    setTimeout(() => {
      const pluginFlag = this.bundledPluginPath ? ` --plugin-dir "${this.bundledPluginPath}"` : '';
      const flags = `${pluginFlag}${claudeFlags ? ` ${claudeFlags}` : ''}`;
      log('INFO', `Auto-starting claude in session ${sessionId}${flags ? ` with flags: ${flags.trim()}` : ''}`);
      ptyProcess.write(`clear && claude${flags}\r`);
      // Auto-confirm the skip-permissions safety prompt if needed
      if (claudeFlags?.includes('--dangerously-skip-permissions')) {
        this.autoConfirmSkipPermissions(sessionId, ptyProcess);
      }
    }, 1000);

    log('INFO', `Session ${sessionId} created successfully`);
    return sessionId;
  }

  /**
   * Register an external session (from plugin, running in external terminal)
   */
  registerExternalSession(
    sessionId: string,
    repo: string,
    repoPath: string,
    type: SessionType = 'worker',
    taskId?: string
  ): void {
    // Don't overwrite existing sessions
    if (this.sessions.has(sessionId)) {
      const existing = this.sessions.get(sessionId)!;
      existing.lastActive = new Date();
      if (taskId) existing.taskId = taskId;
      this.onSessionEvent('updated', sessionId, existing);
      return;
    }

    log('INFO', `Registering external session ${sessionId} for ${repo}`);

    const session: TerminalSession = {
      id: sessionId,
      pty: null as unknown as pty.IPty, // External sessions don't have PTY
      repo,
      repoPath,
      type,
      taskId,
      createdAt: new Date(),
      lastActive: new Date(),
      isExternal: true,
    };

    this.sessions.set(sessionId, session);
    this.onSessionEvent('created', sessionId, session);
  }

  /**
   * Remove an external session
   */
  removeExternalSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.isExternal) {
      log('INFO', `Removing external session ${sessionId}`);
      this.sessions.delete(sessionId);
      this.onSessionEvent('closed', sessionId);
    }
  }

  /**
   * Get a session by ID
   */
  getSession(sessionId: string): TerminalSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get all sessions
   */
  getAllSessions(): TerminalSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get sessions that have PTY (built-in terminals)
   */
  getBuiltInSessions(): TerminalSession[] {
    return this.getAllSessions().filter((s) => !s.isExternal);
  }

  /**
   * Write data to a session's terminal
   */
  write(sessionId: string, data: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.isExternal) {
      log('WARN', `Cannot write to session ${sessionId}: not found or external`);
      return false;
    }

    // Debug: log what xterm sends (especially for Enter key)
    if (data.length <= 4) {
      const hex = Buffer.from(data).toString('hex');
      log('DEBUG', `Terminal write [${data.length} bytes]: hex=${hex}`);
    }

    session.pty.write(data);
    session.lastActive = new Date();
    return true;
  }

  /**
   * Resize a session's terminal
   */
  resize(sessionId: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.isExternal) {
      return false;
    }

    log('INFO', `Resizing PTY ${sessionId} to ${cols}x${rows}`);
    session.pty.resize(cols, rows);
    return true;
  }

  /**
   * Close a session
   */
  closeSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    log('INFO', `Closing session ${sessionId}`);

    if (!session.isExternal) {
      session.pty.kill();
    }

    this.sessions.delete(sessionId);
    this.onSessionEvent('closed', sessionId);
    return true;
  }

  /**
   * Close all sessions
   */
  closeAllSessions(): void {
    for (const [sessionId, session] of this.sessions) {
      if (!session.isExternal) {
        session.pty.kill();
      }
      this.onSessionEvent('closed', sessionId);
    }
    this.sessions.clear();
  }

  /**
   * Dispatch a command to a session (for built-in terminals)
   * If ensureClaude is true, will restart Claude if it's not running
   * If autoSendEnter is false, types command but waits for user to press Enter
   */
  dispatch(sessionId: string, command: string, ensureClaude: boolean = true, autoSendEnter: boolean = true): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      log('WARN', `Cannot dispatch to session ${sessionId}: not found`);
      return false;
    }

    if (session.isExternal) {
      log('WARN', `Cannot dispatch to external session ${sessionId}`);
      return false;
    }

    log('INFO', `Dispatching to ${sessionId}: ${command.substring(0, 50)}... (autoSendEnter=${autoSendEnter})`);

    if (ensureClaude) {
      // Ensure Claude is running:
      // 1. Send Ctrl+C to cancel any stuck state (safe if Claude is running)
      // 2. Send "claude" to start/restart (no-op if prompt already shows)
      // 3. Wait, then send actual command
      const pluginFlag = this.bundledPluginPath ? ` --plugin-dir "${this.bundledPluginPath}"` : '';
      const flags = `${pluginFlag}${session.claudeFlags ? ` ${session.claudeFlags}` : ''}`;
      session.pty.write('\x03'); // Ctrl+C
      setTimeout(() => {
        session.pty.write(`claude${flags}\r`);
        // Auto-confirm the skip-permissions safety prompt if needed
        const hasSkipPerms = session.claudeFlags?.includes('--dangerously-skip-permissions');
        if (hasSkipPerms) {
          this.autoConfirmSkipPermissions(sessionId, session.pty);
        }
        // Wait longer when skip-permissions is active (confirmation prompt takes ~2.5s)
        const claudeStartDelay = hasSkipPerms ? 4000 : 1500;
        setTimeout(() => {
          // Send command text first
          session.pty.write(command);
          // Then Enter key after delay (required for xterm/Claude to be ready)
          // 300ms allows Claude input handler to fully process command text
          // See ISSUE-030: 50ms was insufficient, 150ms still intermittent with Electron 40
          // Only send Enter if autoSendEnter is true (ISSUE-034: confirmBeforeSend)
          if (autoSendEnter) {
            setTimeout(() => {
              session.pty.write('\r');
              log('DEBUG', `Sent Enter key for command: ${command.substring(0, 30)}...`);
            }, 300);
          } else {
            log('DEBUG', `Command typed, waiting for user Enter: ${command.substring(0, 30)}...`);
          }
        }, claudeStartDelay); // Wait for Claude to start (longer with skip-permissions prompt)
      }, 100);
    } else {
      // Direct dispatch - command first, then optionally Enter after delay
      // 300ms allows Claude input handler to fully process command text
      // See ISSUE-030: 50ms was insufficient, 150ms still intermittent with Electron 40
      session.pty.write(command);
      // Only send Enter if autoSendEnter is true (ISSUE-034: confirmBeforeSend)
      if (autoSendEnter) {
        setTimeout(() => {
          session.pty.write('\r');
          log('DEBUG', `Sent Enter key for command: ${command.substring(0, 30)}...`);
        }, 300);
      } else {
        log('DEBUG', `Command typed, waiting for user Enter: ${command.substring(0, 30)}...`);
      }
    }

    session.lastActive = new Date();
    return true;
  }

  /**
   * Check if Claude is likely running in a session
   * Based on recent activity (within last 60s suggests active session)
   */
  isClaudeActive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.isExternal) return false;

    const secondsSinceActive = (Date.now() - session.lastActive.getTime()) / 1000;
    // If active within last 60s, Claude is likely running
    return secondsSinceActive < 60;
  }

  /**
   * Wait for Claude to be ready in a session
   * Waits for Claude startup (~2-3s) then confirms with activity check
   */
  async waitForClaudeReady(sessionId: string, timeoutMs: number = 30000): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const startTime = Date.now();
    const minWaitTime = 1500; // Ignore early output (shell prompt before claude starts)
    const settleTime = 2000;  // Fallback: output quiet for 2s
    const promptChar = '\u25b8'; // ▸ — Claude Code's input prompt character

    log('INFO', `Waiting for Claude ready in ${sessionId} (timeout: ${timeoutMs}ms)...`);

    return new Promise<boolean>((resolve) => {
      let resolved = false;
      let lastDataTime = Date.now();
      let activityStarted = false;

      const cleanup = () => {
        dataListener.dispose();
        clearInterval(fallbackTimer);
        clearTimeout(timeoutTimer);
      };

      const done = (result: boolean, reason: string) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        log('INFO', `Claude ready=${result} in ${sessionId}: ${reason} (${Date.now() - startTime}ms)`);
        resolve(result);
      };

      // Primary: watch PTY output for Claude's prompt character (▸)
      // ▸ is multi-byte UTF-8 (U+25B8) so it cannot appear inside ANSI escape sequences
      const dataListener = session.pty.onData((data: string) => {
        lastDataTime = Date.now();
        activityStarted = true;

        // Only check for prompt after minWaitTime to skip shell prompt
        if (Date.now() - startTime < minWaitTime) return;

        if (data.includes(promptChar)) {
          done(true, 'prompt character detected');
        }
      });

      // Fallback: settle heuristic (output quiet for settleTime)
      // Catches cases where Claude version uses a different prompt character
      const fallbackTimer = setInterval(() => {
        if (activityStarted && Date.now() - startTime >= minWaitTime && Date.now() - lastDataTime >= settleTime) {
          done(true, `output settled for ${settleTime}ms (fallback)`);
        }
      }, 300);

      // Timeout
      const timeoutTimer = setTimeout(() => {
        done(activityStarted,
          activityStarted
            ? 'timeout but activity detected — proceeding'
            : 'timeout with no activity');
      }, timeoutMs);
    });
  }

  /**
   * Find sessions by repo name (fuzzy match)
   */
  findSessionsByRepo(repoQuery: string): TerminalSession[] {
    const query = repoQuery.toLowerCase();
    return this.getAllSessions().filter(
      (s) =>
        s.repo.toLowerCase().includes(query) ||
        s.repoPath.toLowerCase().includes(query)
    );
  }

  /**
   * Find sessions by task ID (fuzzy match)
   */
  findSessionsByTask(taskQuery: string): TerminalSession[] {
    const query = taskQuery.toLowerCase();
    return this.getAllSessions().filter(
      (s) => s.taskId && s.taskId.toLowerCase().includes(query)
    );
  }

  /**
   * Auto-confirm the --dangerously-skip-permissions safety prompt.
   * The prompt shows two options with "No, exit" selected by default:
   *   ❯ 1. No, exit ✔
   *     2. Yes, I accept
   *
   * Uses event-driven detection: watches PTY output for the prompt text,
   * then sends Down arrow + Enter. This avoids timing issues where a
   * buffered \r from the command could confirm the default "No" option.
   */
  private autoConfirmSkipPermissions(sessionId: string, ptyProcess: pty.IPty): void {
    let outputBuffer = '';
    let confirmed = false;

    const onData = ptyProcess.onData((data: string) => {
      if (confirmed) return;
      outputBuffer += data;

      // Detect the confirmation prompt by looking for the "Yes, I accept" option
      if (outputBuffer.includes('Yes, I accept')) {
        confirmed = true;
        onData.dispose(); // Stop listening
        log('INFO', `Detected skip-permissions prompt for session ${sessionId}, auto-confirming`);
        // Small delay to ensure prompt is fully rendered and ready for input
        setTimeout(() => {
          // Down arrow to select "Yes, I accept"
          ptyProcess.write('\x1b[B');
          setTimeout(() => {
            // Enter to confirm
            ptyProcess.write('\r');
          }, 150);
        }, 300);
      }
    });

    // Timeout: stop listening after 15s if prompt never appeared
    setTimeout(() => {
      if (!confirmed) {
        onData.dispose();
        log('WARN', `Skip-permissions prompt not detected for session ${sessionId} within 15s`);
      }
    }, 15000);
  }

  private generateSessionId(): string {
    // Simple ID: timestamp + random suffix
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `${timestamp}-${random}`;
  }
}
