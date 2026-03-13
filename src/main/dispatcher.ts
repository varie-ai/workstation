/**
 * Dispatcher for Varie Workstation
 *
 * Handles routing and dispatch of commands from orchestrator to workers.
 * Implements fuzzy matching for natural language routing.
 * Auto-creates workers for recognized repos.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { log } from './logger';
import { SessionManager, TerminalSession, SessionType } from './session-manager';
import { PluginEvent, DispatchResponse, WorkerInfo } from './socket-server';
import { RepoResolver, RepoInfo } from './repo-resolver';
import { syncDiscoveredRepos, injectVarieSectionToClaudeMd } from './manager-workspace';
import { loadLLMSettings } from './llm/settings';
import { getClaudeFlags } from './config';
import { SessionReadinessTracker } from './session-readiness';

export class Dispatcher {
  private sessionManager: SessionManager;
  private repoResolver: RepoResolver;
  private readiness = new SessionReadinessTracker();
  public remoteModeAllowed = false;

  constructor(sessionManager: SessionManager) {
    this.sessionManager = sessionManager;
    this.repoResolver = new RepoResolver();
  }

  /**
   * Handle dispatch commands from the socket server
   */
  async handleCommand(event: PluginEvent): Promise<DispatchResponse> {
    log('INFO', `Dispatcher handling: ${event.type}`);

    switch (event.type) {
      case 'list_workers':
        return this.listWorkers();

      case 'dispatch':
        return this.handleRemoteFlag(event, () => this.dispatchDirect(event));

      case 'dispatch_answers':
        return this.handleRemoteFlag(event, () => this.dispatchAnswersDirect(event));

      case 'route':
        return this.handleRemoteFlag(event, () => this.routeToWorker(event));

      case 'create_worker':
        return this.handleRemoteFlag(event, () => this.createWorker(event));

      case 'discover_projects':
        return this.discoverProjects(event);

      case 'focus_session':
        return this.focusSession(event);

      case 'set_remote_mode':
        return this.setRemoteMode(event);

      case 'send_escape':
        return this.sendControlKey(event, '\x1b', 'escape');

      case 'send_interrupt':
        return this.sendControlKey(event, '\x03', 'interrupt');

      case 'send_enter':
        return this.sendControlKey(event, '\r', 'enter');

      case 'screenshot':
        return this.validateScreenshot(event);

      default:
        return {
          status: 'error',
          message: `Unknown dispatch command: ${event.type}`,
        };
    }
  }

  /**
   * List all workers with their status
   */
  private listWorkers(): DispatchResponse {
    const sessions = this.sessionManager.getAllSessions();
    const workers: WorkerInfo[] = sessions
      .filter((s) => s.type === 'worker')
      .map((s) => this.sessionToWorkerInfo(s));

    log('INFO', `Listing ${workers.length} workers`);

    return {
      status: 'ok',
      received: 'list_workers',
      workers,
    };
  }

  /**
   * Validate a string payload field: must be a non-empty string within max length.
   */
  private validateString(value: unknown, fieldName: string, maxLength: number = 4096): string | DispatchResponse {
    if (typeof value !== 'string' || value.length === 0) {
      return { status: 'error', message: `Missing or invalid ${fieldName} in payload` };
    }
    if (value.length > maxLength) {
      return { status: 'error', message: `${fieldName} exceeds maximum length (${maxLength})` };
    }
    return value;
  }

  /**
   * Resolve and validate a filesystem path. Returns null if path escapes allowed boundaries.
   */
  private validatePath(rawPath: string): string | null {
    const resolved = path.resolve(rawPath.replace(/^~/, os.homedir()));
    const normalized = path.normalize(resolved);

    // Block path traversal: must be under home directory or common dev paths
    const home = os.homedir();
    if (!normalized.startsWith(home) && !normalized.startsWith('/tmp') && !normalized.startsWith('/opt')) {
      log('WARN', `Path validation rejected: ${normalized} (not under ${home})`);
      return null;
    }

    return normalized;
  }

  /**
   * Dispatch directly to a specific worker by session ID.
   * Awaits session readiness if the session was recently created (ISSUE-016).
   */
  private async dispatchDirect(event: PluginEvent): Promise<DispatchResponse> {
    const targetIdResult = this.validateString(event.payload?.targetSessionId, 'targetSessionId', 128);
    if (typeof targetIdResult !== 'string') return targetIdResult;
    const targetId = targetIdResult;

    const messageResult = this.validateString(event.payload?.message, 'message');
    if (typeof messageResult !== 'string') return messageResult;
    const message = messageResult;

    const session = this.sessionManager.getSession(targetId);
    if (!session) {
      return {
        status: 'error',
        message: `Session not found: ${targetId}`,
      };
    }

    if (session.isExternal) {
      return {
        status: 'error',
        message: 'Cannot dispatch to external session (not implemented)',
      };
    }

    // ISSUE-016: await readiness if session was just created
    const ready = await this.awaitSessionReady(targetId);
    if (!ready) {
      return {
        status: 'error',
        message: `Session ${targetId} did not become ready in time`,
      };
    }

    // Check confirmBeforeSend setting (ISSUE-034)
    const llmSettings = loadLLMSettings();
    const autoSendEnter = !llmSettings.confirmBeforeSend;

    // Write to the worker's terminal
    // Always use ensureClaude=false since sessions auto-start Claude
    // The ensureClaude=true path has issues (sends "claude\r" to active Claude prompt)
    const success = this.sessionManager.dispatch(targetId, message, false, autoSendEnter);

    if (success) {
      log('INFO', `Dispatched to ${targetId}: ${message.substring(0, 50)}... (autoSendEnter=${autoSendEnter})`);
      return {
        status: 'ok',
        received: 'dispatch',
        targetSessionId: targetId,
        confirmBeforeSend: llmSettings.confirmBeforeSend,
      };
    } else {
      return {
        status: 'error',
        message: 'Failed to dispatch to session',
      };
    }
  }

  /**
   * Dispatch multiple answers for Claude Code's AskUserQuestion.
   * Each answer is written without Enter (Claude auto-advances),
   * final Enter submits all answers.
   * Awaits session readiness if recently created (ISSUE-016).
   */
  private async dispatchAnswersDirect(event: PluginEvent): Promise<DispatchResponse> {
    const targetIdResult = this.validateString(event.payload?.targetSessionId, 'targetSessionId', 128);
    if (typeof targetIdResult !== 'string') return targetIdResult;
    const targetId = targetIdResult;

    const answers = event.payload?.answers;
    const hasChatArrows = typeof event.payload?.chatArrows === 'number';
    if (!Array.isArray(answers) || answers.length === 0) {
      if (!hasChatArrows) {
        return { status: 'error', message: 'Missing or empty answers array in payload' };
      }
    }

    // Validate each answer is a short string
    for (let i = 0; i < answers.length; i++) {
      if (typeof answers[i] !== 'string' || answers[i].length === 0 || answers[i].length > 256) {
        return { status: 'error', message: `Invalid answer at index ${i}` };
      }
    }

    const session = this.sessionManager.getSession(targetId);
    if (!session) {
      return { status: 'error', message: `Session not found: ${targetId}` };
    }

    if (session.isExternal) {
      return { status: 'error', message: 'Cannot dispatch to external session (not implemented)' };
    }

    // ISSUE-016: await readiness if session was just created
    const ready = await this.awaitSessionReady(targetId);
    if (!ready) {
      return { status: 'error', message: `Session ${targetId} did not become ready in time` };
    }

    const delayMs = typeof event.payload?.delayMs === 'number' ? event.payload.delayMs : 2000;
    const optionCounts = Array.isArray(event.payload?.optionCounts) ? event.payload.optionCounts as number[] : undefined;
    const chatArrows = typeof event.payload?.chatArrows === 'number' ? event.payload.chatArrows : undefined;
    const success = this.sessionManager.dispatchAnswers(targetId, answers, delayMs, optionCounts, chatArrows);

    if (success) {
      log('INFO', `Dispatched ${answers.length} answers to ${targetId}: [${answers.join(', ')}]`);
      return {
        status: 'ok',
        received: 'dispatch_answers',
        targetSessionId: targetId,
      };
    } else {
      return { status: 'error', message: 'Failed to dispatch answers to session' };
    }
  }

  /**
   * Route to worker via fuzzy matching
   * Auto-creates worker if repo is recognized but no worker exists
   */
  private async routeToWorker(event: PluginEvent): Promise<DispatchResponse> {
    const queryResult = this.validateString(event.payload?.query, 'query', 512);
    if (typeof queryResult !== 'string') return queryResult;
    const query = queryResult;

    const messageResult = this.validateString(event.payload?.message, 'message');
    if (typeof messageResult !== 'string') return messageResult;
    const message = messageResult;

    // 1. Try to find existing worker
    let match = this.findBestMatch(query);

    // 1b. Guard against false positives: if the query resolves to a known repo
    // that differs from the matched session, prefer creating a new session.
    // Example: query "my-app-backend" fuzzy-matches existing "my-app" session,
    // but repoResolver knows "my-app-backend" is a separate repo.
    if (match) {
      const resolved = this.repoResolver.resolve(query);
      if (resolved.found && resolved.repo) {
        const normalize = (s: string) => s.toLowerCase().replace(/[_-]/g, '');
        if (normalize(match.repo) !== normalize(resolved.repo.name)) {
          log('INFO', `Fuzzy match "${match.repo}" overridden — query "${query}" resolves to different repo "${resolved.repo.name}"`);
          match = null;
        }
      }
    }

    // 2. If no worker, try to auto-create from known repos
    if (!match) {
      log('INFO', `No existing worker for "${query}", attempting auto-create...`);

      const resolved = this.repoResolver.resolve(query);

      if (resolved.found && resolved.repo) {
        // Create new worker for this repo
        try {
          const flags = getClaudeFlags();
          const sessionId = this.sessionManager.createSession(
            resolved.repo.name,
            resolved.repo.path,
            'worker',
            undefined,
            flags || undefined
          );

          log('INFO', `Auto-created worker for ${resolved.repo.name} (${sessionId})`);

          // ISSUE-016: use shared readiness tracker (same as create_worker path)
          this.readiness.register(sessionId, this.sessionManager.waitForClaudeReady(sessionId, 30000));
          const ready = await this.awaitSessionReady(sessionId);

          if (!ready) {
            return {
              status: 'error',
              message: `Created worker but Claude did not start within 30s`,
              targetSessionId: sessionId,
              autoCreated: true,
            };
          }

          // Check confirmBeforeSend setting (ISSUE-034)
          const llmSettings = loadLLMSettings();
          const autoSendEnter = !llmSettings.confirmBeforeSend;

          // Dispatch without ensureClaude since we just auto-started it
          const success = this.sessionManager.dispatch(sessionId, message, false, autoSendEnter);

          if (success) {
            log('INFO', `Auto-created and dispatched to ${resolved.repo.name} (${sessionId}), autoSendEnter=${autoSendEnter}`);
            return {
              status: 'ok',
              received: 'route',
              targetSessionId: sessionId,
              autoCreated: true,
              message: `Auto-created worker for ${resolved.repo.name} and dispatched command.`,
              confirmBeforeSend: llmSettings.confirmBeforeSend,
            };
          } else {
            return {
              status: 'error',
              message: `Created worker but failed to dispatch message`,
            };
          }
        } catch (err) {
          return {
            status: 'error',
            message: `Found repo but failed to create worker: ${err}`,
          };
        }
      } else {
        // Could not resolve repo
        return {
          status: 'error',
          message: resolved.message || `No worker found matching: ${query}`,
          suggestions: resolved.suggestions,
        };
      }
    }

    if (match.isExternal) {
      return {
        status: 'error',
        message: `Matched external session ${match.repo} - cannot dispatch (not implemented)`,
      };
    }

    // Check if Claude is likely active in this session (recent activity)
    const isActive = this.sessionManager.isClaudeActive(match.id);

    // Check confirmBeforeSend setting (ISSUE-034)
    const llmSettings = loadLLMSettings();
    const autoSendEnter = !llmSettings.confirmBeforeSend;

    // Dispatch to matched worker
    // If active, skip ensureClaude to avoid sending extra "claude" command
    const success = this.sessionManager.dispatch(match.id, message, !isActive, autoSendEnter);

    if (success) {
      log('INFO', `Routed "${query}" to ${match.repo} (${match.id}), ensureClaude=${!isActive}, autoSendEnter=${autoSendEnter}: ${message.substring(0, 50)}...`);
      return {
        status: 'ok',
        received: 'route',
        targetSessionId: match.id,
        confirmBeforeSend: llmSettings.confirmBeforeSend,
      };
    } else {
      return {
        status: 'error',
        message: 'Failed to dispatch to matched session',
      };
    }
  }

  /**
   * Create a new worker session.
   * Registers readiness tracking so subsequent dispatches auto-wait (ISSUE-016).
   */
  private createWorker(event: PluginEvent): DispatchResponse {
    const repoResult = this.validateString(event.payload?.repo, 'repo', 256);
    if (typeof repoResult !== 'string') return repoResult;
    const repo = repoResult;

    const repoPathResult = this.validateString(event.payload?.repoPath, 'repoPath', 1024);
    if (typeof repoPathResult !== 'string') return repoPathResult;

    const validatedPath = this.validatePath(repoPathResult);
    if (!validatedPath) {
      return { status: 'error', message: `Invalid repo path: path must be under home directory` };
    }

    const taskId = typeof event.payload?.taskId === 'string' ? event.payload.taskId.slice(0, 256) : undefined;
    // Accept explicit claudeFlags from payload, otherwise use config default
    const claudeFlags = (typeof event.payload?.claudeFlags === 'string' ? event.payload.claudeFlags : '') || getClaudeFlags();

    try {
      const sessionId = this.sessionManager.createSession(repo, validatedPath, 'worker', taskId, claudeFlags || undefined);
      log('INFO', `Created worker: ${repo} at ${validatedPath} (${sessionId})`);

      // ISSUE-016: track readiness in background — dispatches will auto-wait
      this.readiness.register(sessionId, this.sessionManager.waitForClaudeReady(sessionId, 30000));

      return {
        status: 'ok',
        received: 'create_worker',
        newSessionId: sessionId,
      };
    } catch (err) {
      return {
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to create worker',
      };
    }
  }

  /**
   * Focus a single session full-screen (for agent screenshot mode).
   * Validates that the session exists; IPC to renderer is handled by index.ts.
   */
  private focusSession(event: PluginEvent): DispatchResponse {
    if (!this.remoteModeAllowed) {
      return { status: 'error', message: 'Remote mode is not enabled' };
    }

    const targetIdResult = this.validateString(event.payload?.targetSessionId, 'targetSessionId', 128);
    if (typeof targetIdResult !== 'string') return targetIdResult;
    const targetId = targetIdResult;

    const session = this.sessionManager.getSession(targetId);
    if (!session) {
      return { status: 'error', message: `Session not found: ${targetId}` };
    }

    return {
      status: 'ok',
      received: 'focus_session',
      targetSessionId: targetId,
    };
  }

  private handleRemoteFlag(event: PluginEvent, handler: () => DispatchResponse | Promise<DispatchResponse>): DispatchResponse | Promise<DispatchResponse> {
    if (event.payload?.remote === true && !this.remoteModeAllowed) {
      this.remoteModeAllowed = true;
      log('INFO', 'Remote mode auto-enabled by remote flag on dispatch');
    }
    return handler();
  }

  private setRemoteMode(event: PluginEvent): DispatchResponse {
    const enabled = event.payload?.enabled;
    if (typeof enabled !== 'boolean') {
      return { status: 'error', message: 'Missing or invalid "enabled" boolean in payload' };
    }

    this.remoteModeAllowed = enabled;
    log('INFO', `Remote mode ${enabled ? 'enabled' : 'disabled'}`);

    return {
      status: 'ok',
      received: 'set_remote_mode',
      enabled: this.remoteModeAllowed,
    };
  }

  /**
   * Send a raw control key to a session's PTY (escape, interrupt, enter).
   */
  private sendControlKey(event: PluginEvent, key: string, keyName: string): DispatchResponse {
    const targetIdResult = this.validateString(event.payload?.targetSessionId, 'targetSessionId', 128);
    if (typeof targetIdResult !== 'string') return targetIdResult;
    const targetId = targetIdResult;

    const session = this.sessionManager.getSession(targetId);
    if (!session) {
      return { status: 'error', message: `Session not found: ${targetId}` };
    }

    if (session.isExternal) {
      return { status: 'error', message: 'Cannot send keys to external session (not implemented)' };
    }

    const success = this.sessionManager.write(targetId, key);
    if (success) {
      log('INFO', `Sent ${keyName} to ${targetId}`);
      return {
        status: 'ok',
        received: event.type,
        targetSessionId: targetId,
      };
    } else {
      return { status: 'error', message: `Failed to send ${keyName} to session` };
    }
  }

  /**
   * Validate screenshot request. Actual capture is handled by index.ts
   * (needs mainWindow access for capturePage).
   */
  private validateScreenshot(event: PluginEvent): DispatchResponse {
    const mode = (event.payload?.mode as string) || 'session';

    if (mode === 'session') {
      if (!this.remoteModeAllowed) {
        return { status: 'error', message: 'Remote mode is not enabled' };
      }

      const targetIdResult = this.validateString(event.payload?.targetSessionId, 'targetSessionId', 128);
      if (typeof targetIdResult !== 'string') return targetIdResult;
      const targetId = targetIdResult;

      const session = this.sessionManager.getSession(targetId);
      if (!session) {
        return { status: 'error', message: `Session not found: ${targetId}` };
      }

      if (session.isExternal) {
        return { status: 'error', message: 'Cannot screenshot external session (not implemented)' };
      }

      return {
        status: 'ok',
        received: 'screenshot',
        targetSessionId: targetId,
      };
    } else if (mode === 'screen') {
      return {
        status: 'ok',
        received: 'screenshot',
      };
    }

    return { status: 'error', message: `Unknown screenshot mode: ${mode}` };
  }

  /**
   * Find best matching worker for a query
   * Matches against: repo name, task ID, repo path
   */
  private findBestMatch(query: string): TerminalSession | null {
    const workers = this.sessionManager
      .getAllSessions()
      .filter((s) => s.type === 'worker');

    if (workers.length === 0) {
      return null;
    }

    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/);

    // Score each worker
    const scored = workers.map((worker) => {
      let score = 0;

      // Exact repo name match (highest priority)
      if (worker.repo.toLowerCase() === queryLower) {
        score += 100;
      }

      // Repo name contains query
      if (worker.repo.toLowerCase().includes(queryLower)) {
        score += 50;
      }

      // Query contains repo name
      if (queryLower.includes(worker.repo.toLowerCase())) {
        score += 40;
      }

      // Task ID match
      if (worker.taskId) {
        const taskLower = worker.taskId.toLowerCase();
        if (taskLower === queryLower) {
          score += 80;
        } else if (taskLower.includes(queryLower) || queryLower.includes(taskLower)) {
          score += 30;
        }
      }

      // Path match (lower priority)
      const pathLower = worker.repoPath.toLowerCase();
      if (pathLower.includes(queryLower)) {
        score += 20;
      }

      // Match individual terms
      for (const term of queryTerms) {
        if (term.length < 3) continue; // Skip short terms

        if (worker.repo.toLowerCase().includes(term)) {
          score += 10;
        }
        if (worker.taskId?.toLowerCase().includes(term)) {
          score += 10;
        }
        if (pathLower.includes(term)) {
          score += 5;
        }
      }

      // Recency boost (more recent = higher score)
      const hoursSinceActive =
        (Date.now() - worker.lastActive.getTime()) / (1000 * 60 * 60);
      if (hoursSinceActive < 1) {
        score += 15;
      } else if (hoursSinceActive < 24) {
        score += 5;
      }

      return { worker, score };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Return best match only if score >= 50 (requires at least partial repo match)
    // This prevents "api-server" from matching "api-client" just because both contain "api"
    const best = scored[0];
    if (best && best.score >= 50) {
      log('INFO', `Best match for "${query}": ${best.worker.repo} (score: ${best.score})`);
      return best.worker;
    }

    if (best && best.score > 0) {
      log('INFO', `No good match for "${query}" - best was ${best.worker.repo} (score: ${best.score}, below threshold 50)`);
    }

    return null;
  }

  /**
   * ISSUE-016: Await session readiness before dispatching.
   * Returns immediately for sessions that are already ready or untracked.
   * For newly created sessions, waits for Claude startup + 500ms settle buffer.
   */
  private async awaitSessionReady(sessionId: string): Promise<boolean> {
    if (this.readiness.isReady(sessionId)) return true;

    log('INFO', `Waiting for session ${sessionId} to become ready...`);
    const ready = await this.readiness.awaitReady(sessionId);

    if (ready) {
      // Post-ready settle buffer — readline needs a moment after Claude's prompt appears
      await this.delay(500);
      log('INFO', `Session ${sessionId} is ready`);
    } else {
      log('WARN', `Session ${sessionId} readiness timed out`);
    }

    return ready;
  }

  /**
   * Helper to delay execution
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Convert session to worker info for API response
   */
  private sessionToWorkerInfo(session: TerminalSession): WorkerInfo {
    return {
      sessionId: session.id,
      repo: session.repo,
      repoPath: session.repoPath,
      taskId: session.taskId,
      type: session.type,
      isExternal: session.isExternal,
      lastActive: session.lastActive.toISOString(),
      workContext: this.sessionManager.getRecentOutput(session.id),
    };
  }

  /**
   * Discover and sync projects to projects.yaml
   * Also injects Varie section into CLAUDE.md files
   *
   * If event.payload.path is provided, scans that specific path:
   * - If path is a repo (has .git or CLAUDE.md), adds just that repo
   * - If path is a directory, scans for repos inside it
   *
   * If no path provided, returns all known repos (default scan + learned)
   */
  private discoverProjects(event: PluginEvent): DispatchResponse {
    const rawPath = event.payload?.path as string | undefined;

    if (rawPath) {
      if (typeof rawPath !== 'string' || rawPath.length > 1024) {
        return { status: 'error', message: 'Invalid path in payload' };
      }

      const validatedPath = this.validatePath(rawPath);
      if (!validatedPath) {
        return { status: 'error', message: `Invalid path: must be under home directory` };
      }

      // Scan custom path and learn repos
      log('INFO', `Running project discovery for custom path: ${validatedPath}`);

      const learnedRepos = this.repoResolver.scanAndLearnPath(validatedPath);

      if (learnedRepos.length === 0) {
        if (!fs.existsSync(validatedPath)) {
          return {
            status: 'error',
            message: `Path does not exist: ${validatedPath}`,
          };
        }

        return {
          status: 'ok',
          message: `No new repos found at ${validatedPath}. Path may already be known or contain no git repos.`,
          discovered: [],
          total: 0,
          newCount: 0,
        };
      }

      // Sync newly learned repos to projects.yaml
      const discoveryInfo = learnedRepos.map((r) => ({
        name: r.name,
        path: r.path,
        hasClaudeMd: r.hasClaudeMd,
      }));
      const addedCount = syncDiscoveredRepos(discoveryInfo);

      // Refresh resolver so newly discovered repos are immediately routable
      this.repoResolver.refresh();

      log('INFO', `Custom path discovery complete: ${learnedRepos.length} repos learned, ${addedCount} added to projects.yaml`);

      return {
        status: 'ok',
        message: `Discovered ${learnedRepos.length} repos at ${validatedPath}, added ${addedCount} to projects`,
        discovered: learnedRepos.map((r) => ({
          name: r.name,
          path: r.path,
          hasClaudeMd: r.hasClaudeMd,
          source: r.source,
        })),
        total: learnedRepos.length,
        newCount: addedCount,
        customPath: validatedPath,
      };
    }

    // Default behavior: return all known repos
    log('INFO', 'Running project discovery (default path)...');

    const repos = this.repoResolver.getAllRepos();

    // Prepare discovery info
    const discoveryInfo = repos.map((r) => ({
      name: r.name,
      path: r.path,
      hasClaudeMd: r.hasClaudeMd,
    }));

    // Sync to projects.yaml (this also injects CLAUDE.md sections)
    const addedCount = syncDiscoveredRepos(discoveryInfo);

    // Build response with details about what was discovered/injected
    const discovered = repos.map((r) => ({
      name: r.name,
      path: r.path,
      hasClaudeMd: r.hasClaudeMd,
      source: r.source,
    }));

    // Refresh resolver so synced repos are immediately routable
    this.repoResolver.refresh();

    log('INFO', `Discovery complete: ${repos.length} total repos, ${addedCount} newly added`);

    return {
      status: 'ok',
      message: `Discovered ${repos.length} repos, added ${addedCount} new`,
      discovered,
      total: repos.length,
      newCount: addedCount,
    };
  }

  /**
   * Get all discovered repos for syncing to projects.yaml
   */
  getDiscoveredRepos(): Array<{ name: string; path: string; hasClaudeMd: boolean }> {
    return this.repoResolver.getAllRepos().map((r) => ({
      name: r.name,
      path: r.path,
      hasClaudeMd: r.hasClaudeMd,
    }));
  }
}
