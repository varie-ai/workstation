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

export class Dispatcher {
  private sessionManager: SessionManager;
  private repoResolver: RepoResolver;

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
        return this.dispatchDirect(event);

      case 'route':
        return this.routeToWorker(event);

      case 'create_worker':
        return this.createWorker(event);

      case 'discover_projects':
        return this.discoverProjects(event);

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
   * Dispatch directly to a specific worker by session ID
   */
  private dispatchDirect(event: PluginEvent): DispatchResponse {
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

          // Wait for Claude to be ready (event-based, up to 30s)
          log('INFO', `Waiting for Claude to be ready in ${resolved.repo.name}...`);
          const ready = await this.sessionManager.waitForClaudeReady(sessionId, 30000);

          if (!ready) {
            return {
              status: 'error',
              message: `Created worker but Claude did not start within 30s`,
              targetSessionId: sessionId,
              autoCreated: true,
            };
          }

          // Small buffer after output settled — readline should be ready now
          await this.delay(500);

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
   * Create a new worker session
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
