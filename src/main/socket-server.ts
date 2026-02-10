/**
 * Socket Server for Varie Workstation
 *
 * Receives events from Claude Code plugin via Unix socket.
 */

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { app } from 'electron';
import { log } from './logger';

// Event types from plugin
export interface PluginEvent {
  type:
    // Status events (plugin → daemon)
    | 'session_start'
    | 'session_end'
    | 'checkpoint'
    | 'step_started'
    | 'step_completed'
    | 'step_blocked'
    | 'task_started'
    | 'task_completed'
    | 'attention_needed'
    | 'question'
    | 'status_request'
    // Tool activity events (PostToolUse hook → daemon → relay)
    | 'tool_use'
    // Dispatch commands (orchestrator plugin → daemon → worker)
    | 'dispatch'        // Send to specific worker by ID
    | 'route'           // Auto-route via fuzzy match
    | 'list_workers'    // Get all workers with status
    | 'create_worker';  // Create new worker session
  sessionId: string;
  timestamp: number;
  context?: {
    project: string;
    projectPath: string;
    taskId?: string;
    currentStep?: string;
    branch?: string;
  };
  payload?: Record<string, unknown>;
}

// Response for dispatch commands
export interface DispatchResponse {
  status: 'ok' | 'error';
  received?: string;
  message?: string;
  // For list_workers
  workers?: WorkerInfo[];
  // For route/dispatch
  targetSessionId?: string;
  // For create_worker
  newSessionId?: string;
  // For auto-created workers
  autoCreated?: boolean;
  // Suggestions when repo not found
  suggestions?: string[];
  // For confirmBeforeSend mode (ISSUE-034)
  confirmBeforeSend?: boolean;
}

export interface WorkerInfo {
  sessionId: string;
  repo: string;
  repoPath: string;
  taskId?: string;
  type: 'orchestrator' | 'worker';
  isExternal: boolean;
  lastActive: string;
  workContext?: string;  // Brief summary of recent session activity
}

export type EventCallback = (event: PluginEvent) => void;
export type DispatchHandler = (event: PluginEvent) => Promise<DispatchResponse>;

// Dispatch command types that expect a response
const DISPATCH_COMMANDS = ['dispatch', 'route', 'list_workers', 'create_worker', 'discover_projects'];

const SOCKET_HEALTH_INTERVAL_MS = 10_000; // Check every 10s

export class SocketServer {
  private server: net.Server | null = null;
  private socketPath: string;
  private onEvent: EventCallback;
  private onDispatch: DispatchHandler | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  constructor(onEvent: EventCallback) {
    this.onEvent = onEvent;

    // Dev instances use a separate socket to avoid deleting production's socket (ISSUE-054)
    const isDev = !app.isPackaged;
    const suffix = isDev ? '-dev' : '';

    // Socket path - use /tmp on macOS/Linux, named pipe on Windows
    this.socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\varie-workstation${suffix}`
        : `/tmp/varie-workstation${suffix}.sock`;
  }

  start(): void {
    // Clean up existing socket file
    if (process.platform !== 'win32' && fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
    }

    this.server = net.createServer((socket) => {
      let buffer = '';

      socket.on('data', (data) => {
        buffer += data.toString();

        // Process complete JSON messages (newline-delimited)
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.trim()) {
            this.handleMessage(line.trim(), socket);
          }
        }
      });

      socket.on('error', (err) => {
        log('WARN', 'Socket client error:', err.message);
      });
    });

    this.server.listen(this.socketPath, () => {
      log('INFO', `Socket server listening on ${this.socketPath}`);

      // Set socket permissions to owner-only (security: prevents other users from sending commands)
      if (process.platform !== 'win32') {
        fs.chmodSync(this.socketPath, 0o600);
      }
    });

    this.server.on('error', (err) => {
      log('ERROR', 'Socket server error:', err);
    });

    // Write socket path to known location for plugin to find
    this.writeDaemonInfo();

    // Self-healing: periodically check socket file still exists (ISSUE-053)
    this.startHealthCheck();
  }

  stop(): void {
    this.stopHealthCheck();
    this.server?.close();
    if (process.platform !== 'win32' && fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
    }

    // Clean up daemon info
    const configDir = path.join(os.homedir(), '.varie-workstation');
    const infoPath = path.join(configDir, 'daemon.json');
    if (fs.existsSync(infoPath)) {
      fs.unlinkSync(infoPath);
    }
  }

  // ==========================================================================
  // Socket health check (ISSUE-053)
  // ==========================================================================

  private startHealthCheck(): void {
    this.stopHealthCheck();
    this.healthTimer = setInterval(() => {
      if (process.platform === 'win32') return;
      if (!fs.existsSync(this.socketPath)) {
        log('WARN', 'Socket file missing, recreating...');
        this.rebind();
      }
    }, SOCKET_HEALTH_INTERVAL_MS);
  }

  private stopHealthCheck(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  /**
   * Rebind the socket server after the socket file was deleted.
   * Closes the old server and creates a new one on the same path.
   */
  private rebind(): void {
    // Close existing server (it's broken — socket file is gone)
    this.server?.close();

    // Recreate server with the same connection handler
    this.server = net.createServer((socket) => {
      let buffer = '';

      socket.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.trim()) {
            this.handleMessage(line.trim(), socket);
          }
        }
      });

      socket.on('error', (err) => {
        log('WARN', 'Socket client error:', err.message);
      });
    });

    this.server.listen(this.socketPath, () => {
      log('INFO', `Socket server rebound on ${this.socketPath}`);
      if (process.platform !== 'win32') {
        fs.chmodSync(this.socketPath, 0o600);
      }
    });

    this.server.on('error', (err) => {
      log('ERROR', 'Socket rebind error:', err);
    });

    // Update daemon.json
    this.writeDaemonInfo();
  }

  private handleMessage(message: string, socket: net.Socket): void {
    // Skip empty or whitespace-only messages
    if (!message || !message.trim()) {
      return;
    }

    try {
      const event = JSON.parse(message) as PluginEvent;
      event.timestamp = event.timestamp || Date.now();

      log('INFO', 'Received event:', event.type, event.sessionId);

      // Check if this is a dispatch command
      if (DISPATCH_COMMANDS.includes(event.type)) {
        this.handleDispatchCommand(event, socket);
        return;
      }

      // Regular event - notify callback
      this.onEvent(event);

      // Send acknowledgment
      socket.write(JSON.stringify({ status: 'ok', received: event.type }) + '\n');
    } catch {
      // Only log once per connection to reduce noise
      // This can happen if plugin sends partial data or non-JSON
      log('DEBUG', 'Ignoring non-JSON message:', message.substring(0, 50));
      socket.write(JSON.stringify({ status: 'error', message: 'Invalid JSON' }) + '\n');
    }
  }

  private async handleDispatchCommand(event: PluginEvent, socket: net.Socket): Promise<void> {
    if (!this.onDispatch) {
      log('WARN', 'Dispatch command received but no handler set:', event.type);
      socket.write(JSON.stringify({
        status: 'error',
        message: 'Dispatch handler not configured'
      }) + '\n');
      socket.end();
      return;
    }

    // Track socket state
    let socketClosed = false;
    socket.on('close', () => {
      socketClosed = true;
      log('DEBUG', 'Socket closed during dispatch handling');
    });
    socket.on('error', (err) => {
      log('WARN', 'Socket error during dispatch:', err.message);
    });

    try {
      log('INFO', `Starting dispatch handler for ${event.type}...`);
      const response = await this.onDispatch(event);
      log('INFO', `Dispatch handler completed, sending response...`);

      if (socketClosed) {
        log('WARN', 'Socket already closed, cannot send response');
        return;
      }

      const responseStr = JSON.stringify(response) + '\n';
      socket.write(responseStr, (err) => {
        if (err) {
          log('ERROR', 'Failed to write response:', err.message);
        } else {
          log('INFO', 'Response sent successfully');
        }
        socket.end();
      });
    } catch (err) {
      log('ERROR', 'Dispatch handler error:', err);
      if (!socketClosed) {
        socket.write(JSON.stringify({
          status: 'error',
          message: err instanceof Error ? err.message : 'Dispatch failed'
        }) + '\n');
        socket.end();
      }
    }
  }

  private writeDaemonInfo(): void {
    const configDir = path.join(os.homedir(), '.varie-workstation');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    const infoPath = path.join(configDir, 'daemon.json');
    fs.writeFileSync(
      infoPath,
      JSON.stringify(
        {
          socketPath: this.socketPath,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          version: '0.1.0',
        },
        null,
        2
      )
    );

    log('INFO', 'Daemon info written to', infoPath);
  }

  getSocketPath(): string {
    return this.socketPath;
  }

  /**
   * Set handler for dispatch commands (dispatch, route, list_workers, create_worker)
   */
  setDispatchHandler(handler: DispatchHandler): void {
    this.onDispatch = handler;
  }
}
