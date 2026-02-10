/**
 * Relay Client for Varie Workstation
 *
 * WebSocket client that connects to the Cloud Relay service,
 * receives mobile commands, routes them through the Dispatcher,
 * and broadcasts session status back.
 *
 * Opt-in only: requires cloudRelay: true in ~/.varie/config.yaml.
 * URL is hardcoded (not user-configurable). Use RELAY_URL env var for dev.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { log } from './logger';
import { getCloudRelayToken } from './config';
import { SessionManager, TerminalSession } from './session-manager';

// ============================================================================
// Constants
// ============================================================================

const PRODUCTION_RELAY_URL = 'wss://cloud-relay-2gjzl6zq7a-uw.a.run.app/ws';
const RELAY_URL = process.env.RELAY_URL || PRODUCTION_RELAY_URL;

const HEARTBEAT_INTERVAL_MS = 25_000;   // 25s (server pong timeout is 90s)
const RECONNECT_BASE_MS = 1_000;        // Start at 1s
const RECONNECT_MAX_MS = 60_000;        // Cap at 60s
const RECONNECT_JITTER_RATIO = 0.2;     // +/- 20%
const CONNECTION_TIMEOUT_MS = 10_000;    // 10s to establish connection

const MACHINE_ID_PATH = path.join(os.homedir(), '.varie', 'machine-id');

// Workstation version (read from package.json at build time is fragile; use constant)
const WORKSTATION_VERSION = '0.2.6';

// ============================================================================
// Types
// ============================================================================

export type RelayStatus = 'disconnected' | 'connecting' | 'connected' | 'registered';

export interface RelayState {
  status: RelayStatus;
  connectionId: string | null;
  machineId: string;
  lastHeartbeat: string | null;
  reconnectAttempts: number;
  error: string | null;
}

export type RelayEventCallback = (state: RelayState) => void;

/** Callback when a command arrives from the relay. Caller handles routing. */
export type RelayCommandCallback = (command: string, requestId: string, source: string) => void;

// WebSocket message types (mirrors Go types.go)
interface HeartbeatMsg {
  type: 'heartbeat';
}

interface StatusMsg {
  type: 'status';
  sessions: SessionSummary[];
}

interface CommandResultMsg {
  type: 'command_result';
  requestId: string;
  result: CommandResult;
}

interface StreamMsg {
  type: 'stream';
  sessionId: string;
  event: string;        // "tool_use"
  data: Record<string, unknown>;
  timestamp: string;    // ISO 8601
}

interface SessionSummary {
  id: string;
  repo: string;
  task: string;
  status: string;       // "idle" | "working" | "waiting"
  lastActivity: string; // ISO 8601
}

export interface CommandResult {
  requestId: string;
  status: string;               // "routed" | "completed" | "error"
  sessionId?: string;
  sessionRepo?: string;
  message: string;
  timestamp: string;
}

// Relay → Workstation messages
interface RegisteredMsg {
  type: 'registered';
  connectionId: string;
}

interface CommandMsg {
  type: 'command';
  requestId: string;
  command: string;
  source: string;
}

type IncomingMessage = RegisteredMsg | CommandMsg;

// ============================================================================
// Machine ID
// ============================================================================

/**
 * Get or generate a stable machine identifier.
 * Persisted in ~/.varie/machine-id across restarts.
 */
export function getMachineId(): string {
  try {
    if (fs.existsSync(MACHINE_ID_PATH)) {
      const id = fs.readFileSync(MACHINE_ID_PATH, 'utf-8').trim();
      if (id.length >= 16) return id;
    }
  } catch {
    // Fall through to generate
  }

  const id = crypto.randomUUID();
  try {
    const dir = path.dirname(MACHINE_ID_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(MACHINE_ID_PATH, id, 'utf-8');
    log('INFO', `Generated new machine ID: ${id}`);
  } catch (err) {
    log('WARN', 'Failed to persist machine ID:', err);
  }
  return id;
}

// ============================================================================
// RelayClient
// ============================================================================

export class RelayClient {
  private sessionManager: SessionManager;
  private onStateChange: RelayEventCallback;
  private onCommand: RelayCommandCallback;

  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionTimer: ReturnType<typeof setTimeout> | null = null;

  private state: RelayState;
  private currentToken: string | null = null;
  private intentionalDisconnect = false;

  constructor(
    sessionManager: SessionManager,
    onStateChange: RelayEventCallback,
    onCommand: RelayCommandCallback,
  ) {
    this.sessionManager = sessionManager;
    this.onStateChange = onStateChange;
    this.onCommand = onCommand;

    this.state = {
      status: 'disconnected',
      connectionId: null,
      machineId: getMachineId(),
      lastHeartbeat: null,
      reconnectAttempts: 0,
      error: null,
    };
  }

  /**
   * Connect to the Cloud Relay.
   * @param token Auth token (Firebase JWT in production, any string in DEV_MODE)
   */
  connect(token: string): void {
    if (this.ws) {
      log('WARN', 'Relay already connected, disconnecting first');
      this.disconnect();
    }

    this.currentToken = token;
    this.intentionalDisconnect = false;

    const url = `${RELAY_URL}?token=${encodeURIComponent(token)}&machineId=${encodeURIComponent(this.state.machineId)}&version=${encodeURIComponent(WORKSTATION_VERSION)}`;
    log('INFO', `Relay connecting to ${RELAY_URL}...`);

    this.updateState({ status: 'connecting', error: null });

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      log('ERROR', 'Failed to create WebSocket:', err);
      this.updateState({ status: 'disconnected', error: 'Failed to create connection' });
      this.scheduleReconnect();
      return;
    }

    // Connection timeout
    this.connectionTimer = setTimeout(() => {
      if (this.ws?.readyState === WebSocket.CONNECTING) {
        log('WARN', 'Relay connection timed out');
        this.ws.close();
      }
    }, CONNECTION_TIMEOUT_MS);

    this.ws.onopen = () => {
      this.clearConnectionTimeout();
      log('INFO', 'Relay WebSocket connected, waiting for registration...');
      this.updateState({ status: 'connected' });
      // Registration handled by server at HTTP upgrade (from URL query params).
      // Server sends 'registered' message back — handled in handleRegistered().
      this.startHeartbeat();
    };

    this.ws.onmessage = (event) => {
      this.handleMessage(event.data as string);
    };

    this.ws.onerror = (event) => {
      this.clearConnectionTimeout();
      log('ERROR', 'Relay WebSocket error:', event);
      this.updateState({ error: 'Connection error' });
    };

    this.ws.onclose = (event) => {
      this.clearConnectionTimeout();
      this.stopHeartbeat();
      log('INFO', `Relay WebSocket closed: code=${event.code} reason=${event.reason}`);

      this.ws = null;

      // Auth errors: don't reconnect
      if (event.code === 4001 || event.code === 4003) {
        this.updateState({
          status: 'disconnected',
          connectionId: null,
          error: 'Authentication failed',
        });
        return;
      }

      // User-initiated: don't reconnect
      if (this.intentionalDisconnect) {
        this.updateState({ status: 'disconnected', connectionId: null, error: null });
        return;
      }

      // Otherwise: reconnect
      this.updateState({ status: 'disconnected', connectionId: null });
      this.scheduleReconnect();
    };
  }

  /**
   * Gracefully disconnect. Will not auto-reconnect.
   */
  disconnect(): void {
    this.intentionalDisconnect = true;
    this.clearReconnect();
    this.clearConnectionTimeout();
    this.stopHeartbeat();

    if (this.ws) {
      this.ws.close(1000, 'user disconnect');
      this.ws = null;
    }

    this.updateState({ status: 'disconnected', connectionId: null, error: null });
  }

  /**
   * Full cleanup (app quit). Same as disconnect.
   */
  destroy(): void {
    this.disconnect();
    this.currentToken = null;
  }

  getState(): RelayState {
    return { ...this.state };
  }

  isConnected(): boolean {
    return this.state.status === 'registered';
  }

  /**
   * Broadcast current session list to the relay.
   * Called when sessions are created, closed, or updated.
   */
  broadcastSessionStatus(): void {
    if (!this.ws || this.state.status !== 'registered') return;

    const sessions = this.sessionManager.getAllSessions();
    const summaries: SessionSummary[] = sessions
      .filter((s) => s.type === 'worker')
      .map((s) => ({
        id: s.id,
        repo: s.repo,
        task: s.taskId || '',
        status: this.inferSessionStatus(s),
        lastActivity: s.lastActive.toISOString(),
      }));

    const msg: StatusMsg = { type: 'status', sessions: summaries };
    this.send(msg);
  }

  /**
   * Send a tool activity event to the relay for streaming to mobile clients.
   * Called when a PostToolUse hook event arrives from a session.
   */
  sendActivityEvent(sessionId: string, tool: string, target: string): void {
    this.sendStreamEvent(sessionId, 'tool_use', { tool, target });
  }

  /**
   * Send a generic stream event to the relay.
   * Used for tool activity, turn lifecycle (stop, session_start, session_end), etc.
   */
  sendStreamEvent(sessionId: string, event: string, data: Record<string, unknown> = {}): void {
    if (!this.ws || this.state.status !== 'registered') return;

    const msg: StreamMsg = {
      type: 'stream',
      sessionId,
      event,
      data,
      timestamp: new Date().toISOString(),
    };
    this.send(msg);
  }

  // ==========================================================================
  // Private: WebSocket messaging
  // ==========================================================================

  private send(msg: HeartbeatMsg | StatusMsg | CommandResultMsg | StreamMsg): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (err) {
      log('ERROR', 'Relay send failed:', err);
    }
  }

  private sendCommandResult(requestId: string, result: CommandResult): void {
    const msg: CommandResultMsg = {
      type: 'command_result',
      requestId,
      result,
    };
    this.send(msg);
  }

  // ==========================================================================
  // Private: Message handling
  // ==========================================================================

  private handleMessage(raw: string): void {
    let parsed: { type?: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      log('WARN', 'Relay received non-JSON message:', raw.substring(0, 100));
      return;
    }

    switch (parsed.type) {
      case 'registered':
        this.handleRegistered(parsed as RegisteredMsg);
        break;
      case 'command':
        this.handleCommand(parsed as CommandMsg);
        break;
      default:
        log('DEBUG', `Relay received unknown message type: ${parsed.type}`);
    }
  }

  private handleRegistered(msg: RegisteredMsg): void {
    log('INFO', `Relay registered: connectionId=${msg.connectionId}`);
    this.state.reconnectAttempts = 0;
    this.updateState({
      status: 'registered',
      connectionId: msg.connectionId,
      error: null,
    });

    // Broadcast current session status immediately after registration
    this.broadcastSessionStatus();
  }

  private handleCommand(msg: CommandMsg): void {
    log('INFO', `Relay command: requestId=${msg.requestId}, command="${msg.command.substring(0, 80)}"`);

    // Delegate routing to the caller (main process → renderer voice pipeline)
    // The caller is responsible for calling reportCommandResult() when done.
    try {
      this.onCommand(msg.command, msg.requestId, msg.source);
    } catch (err) {
      log('ERROR', 'Relay command callback failed:', err);
      this.reportCommandResult(msg.requestId, {
        requestId: msg.requestId,
        status: 'error',
        message: err instanceof Error ? err.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Report a command result back to the relay service.
   * Called by the main process after the renderer finishes routing.
   */
  reportCommandResult(requestId: string, result: CommandResult): void {
    this.sendCommandResult(requestId, result);
  }

  // ==========================================================================
  // Private: Heartbeat
  // ==========================================================================

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send({ type: 'heartbeat' });
        this.updateState({ lastHeartbeat: new Date().toISOString() });
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ==========================================================================
  // Private: Reconnection
  // ==========================================================================

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    if (!this.currentToken) return;

    this.state.reconnectAttempts++;

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s, 60s, 60s, ...
    const baseDelay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.state.reconnectAttempts - 1),
      RECONNECT_MAX_MS,
    );

    // Jitter to prevent thundering herd
    const jitter = baseDelay * RECONNECT_JITTER_RATIO * (Math.random() * 2 - 1);
    const delay = Math.round(baseDelay + jitter);

    log('INFO', `Relay reconnecting in ${delay}ms (attempt ${this.state.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Re-read token from config in case it was refreshed (Firebase tokens expire in 1h)
      const freshToken = getCloudRelayToken() || this.currentToken!;
      this.connect(freshToken);
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.state.reconnectAttempts = 0;
  }

  private clearConnectionTimeout(): void {
    if (this.connectionTimer) {
      clearTimeout(this.connectionTimer);
      this.connectionTimer = null;
    }
  }

  // ==========================================================================
  // Private: Helpers
  // ==========================================================================

  private inferSessionStatus(session: TerminalSession): string {
    const secondsSinceActive = (Date.now() - session.lastActive.getTime()) / 1000;
    if (secondsSinceActive < 10) return 'working';
    if (secondsSinceActive < 60) return 'idle';
    return 'waiting';
  }

  private updateState(partial: Partial<RelayState>): void {
    this.state = { ...this.state, ...partial };
    try {
      this.onStateChange({ ...this.state });
    } catch (err) {
      log('WARN', 'Relay state change callback error:', err);
    }
  }
}
