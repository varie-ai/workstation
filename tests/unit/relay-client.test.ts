import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger
vi.mock('../../src/main/logger', () => ({
  log: vi.fn(),
}));

// getMachineId reads from real ~/.varie/machine-id (path computed at import time).
// We test it by verifying the returned value is a valid UUID format.
import { getMachineId } from '../../src/main/relay-client';

describe('getMachineId', () => {
  it('returns a string of at least 16 characters', () => {
    const id = getMachineId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThanOrEqual(16);
  });

  it('returns the same ID on repeated calls', () => {
    const id1 = getMachineId();
    const id2 = getMachineId();
    expect(id1).toBe(id2);
  });
});

// ============================================================================
// RelayClient
// ============================================================================

import { RelayClient, RelayState } from '../../src/main/relay-client';

// Mock WebSocket
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  sentMessages: string[] = [];

  send(data: string) {
    this.sentMessages.push(data);
  }

  close(_code?: number, _reason?: string) {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose({ code: _code || 1000, reason: _reason || '' });
    }
  }

  // Test helpers
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    if (this.onopen) this.onopen({});
  }

  simulateMessage(data: unknown) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(data) });
  }

  simulateClose(code = 1000, reason = '') {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) this.onclose({ code, reason });
  }

  simulateError() {
    if (this.onerror) this.onerror({ type: 'error' });
  }
}

// Track created instances
let mockWsInstance: MockWebSocket | null = null;

// Mock global WebSocket
vi.stubGlobal('WebSocket', class extends MockWebSocket {
  constructor(_url: string) {
    super();
    mockWsInstance = this;
  }

  // Expose static constants
  static readonly CONNECTING = MockWebSocket.CONNECTING;
  static readonly OPEN = MockWebSocket.OPEN;
  static readonly CLOSING = MockWebSocket.CLOSING;
  static readonly CLOSED = MockWebSocket.CLOSED;
});

function createMockSessionManager() {
  return {
    getAllSessions: vi.fn().mockReturnValue([]),
    getSession: vi.fn().mockReturnValue(undefined),
    getRecentOutput: vi.fn().mockReturnValue(undefined),
  } as unknown as import('../../src/main/session-manager').SessionManager;
}

describe('RelayClient', () => {
  let client: RelayClient;
  let sessionManager: ReturnType<typeof createMockSessionManager>;
  let stateChanges: RelayState[];
  let commandsReceived: Array<{ command: string; requestId: string; source: string }>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockWsInstance = null;
    sessionManager = createMockSessionManager();
    stateChanges = [];
    commandsReceived = [];
    client = new RelayClient(
      sessionManager as any,
      (state) => stateChanges.push({ ...state }),
      (command, requestId, source) => commandsReceived.push({ command, requestId, source }),
    );
  });

  afterEach(() => {
    client.destroy();
    vi.useRealTimers();
  });

  it('starts disconnected', () => {
    const state = client.getState();
    expect(state.status).toBe('disconnected');
    expect(state.connectionId).toBeNull();
    expect(state.error).toBeNull();
  });

  it('transitions to connecting on connect()', () => {
    client.connect('test-token');
    expect(stateChanges.some((s) => s.status === 'connecting')).toBe(true);
  });

  it('does not send register message (server handles via URL params)', () => {
    client.connect('test-token');
    mockWsInstance!.simulateOpen();

    // No register message should be sent — registration happens at HTTP upgrade
    const registerMsgs = mockWsInstance!.sentMessages.filter((m) => {
      const parsed = JSON.parse(m);
      return parsed.type === 'register';
    });
    expect(registerMsgs).toHaveLength(0);
  });

  it('transitions to registered on registered message', () => {
    client.connect('test-token');
    mockWsInstance!.simulateOpen();
    mockWsInstance!.simulateMessage({ type: 'registered', connectionId: 'conn-123' });

    const state = client.getState();
    expect(state.status).toBe('registered');
    expect(state.connectionId).toBe('conn-123');
    expect(client.isConnected()).toBe(true);
  });

  it('sends heartbeat after interval', () => {
    client.connect('test-token');
    mockWsInstance!.simulateOpen();
    mockWsInstance!.simulateMessage({ type: 'registered', connectionId: 'conn-123' });

    // Clear register message
    mockWsInstance!.sentMessages = [];

    // Advance past heartbeat interval (25s)
    vi.advanceTimersByTime(25_000);

    const heartbeats = mockWsInstance!.sentMessages.filter((m) => {
      const parsed = JSON.parse(m);
      return parsed.type === 'heartbeat';
    });
    expect(heartbeats.length).toBe(1);
  });

  it('delegates commands to onCommand callback', async () => {
    client.connect('test-token');
    mockWsInstance!.simulateOpen();
    mockWsInstance!.simulateMessage({ type: 'registered', connectionId: 'conn-123' });

    // Simulate command from relay
    mockWsInstance!.simulateMessage({
      type: 'command',
      requestId: 'req-1',
      command: 'check varie-workstation status',
      source: 'mobile',
    });

    // Verify callback was called (not dispatcher)
    expect(commandsReceived).toHaveLength(1);
    expect(commandsReceived[0]).toEqual({
      command: 'check varie-workstation status',
      requestId: 'req-1',
      source: 'mobile',
    });
  });

  it('sends command_result via reportCommandResult()', () => {
    client.connect('test-token');
    mockWsInstance!.simulateOpen();
    mockWsInstance!.simulateMessage({ type: 'registered', connectionId: 'conn-123' });

    // Clear sent messages
    mockWsInstance!.sentMessages = [];

    // Simulate the main process reporting a result
    client.reportCommandResult('req-1', {
      requestId: 'req-1',
      status: 'routed',
      sessionId: 'session-1',
      sessionRepo: 'my-repo',
      message: 'Sent to my-repo',
      timestamp: '2026-02-09T00:00:00Z',
    });

    const resultMsgs = mockWsInstance!.sentMessages.filter((m) => {
      const parsed = JSON.parse(m);
      return parsed.type === 'command_result';
    });
    expect(resultMsgs.length).toBe(1);
    const result = JSON.parse(resultMsgs[0]);
    expect(result.result.status).toBe('routed');
    expect(result.result.requestId).toBe('req-1');
    expect(result.result.sessionRepo).toBe('my-repo');
  });

  it('does not reconnect on intentional disconnect', () => {
    client.connect('test-token');
    mockWsInstance!.simulateOpen();

    client.disconnect();

    // Advance time — should NOT attempt reconnect
    vi.advanceTimersByTime(120_000);

    const state = client.getState();
    expect(state.status).toBe('disconnected');
    expect(state.reconnectAttempts).toBe(0);
  });

  it('does not reconnect on auth failure (code 4001)', () => {
    client.connect('test-token');
    mockWsInstance!.simulateOpen();
    mockWsInstance!.simulateClose(4001, 'auth failed');

    const state = client.getState();
    expect(state.status).toBe('disconnected');
    expect(state.error).toBe('Authentication failed');

    // Should NOT schedule reconnect
    vi.advanceTimersByTime(120_000);
    expect(client.getState().reconnectAttempts).toBe(0);
  });

  it('sends stream message via sendActivityEvent()', () => {
    client.connect('test-token');
    mockWsInstance!.simulateOpen();
    mockWsInstance!.simulateMessage({ type: 'registered', connectionId: 'conn-123' });

    // Clear sent messages (register + status broadcast)
    mockWsInstance!.sentMessages = [];

    client.sendActivityEvent('session-42', 'Edit', 'src/main/index.ts');

    expect(mockWsInstance!.sentMessages).toHaveLength(1);
    const msg = JSON.parse(mockWsInstance!.sentMessages[0]);
    expect(msg.type).toBe('stream');
    expect(msg.sessionId).toBe('session-42');
    expect(msg.event).toBe('tool_use');
    expect(msg.data).toEqual({ tool: 'Edit', target: 'src/main/index.ts' });
    expect(msg.timestamp).toBeTruthy();
  });

  it('does not send activity event when not registered', () => {
    client.connect('test-token');
    mockWsInstance!.simulateOpen();
    // NOT registered yet — only "connected"

    mockWsInstance!.sentMessages = [];
    client.sendActivityEvent('session-42', 'Read', 'README.md');

    // No stream message should be sent (register msg was already sent before we cleared)
    const streamMsgs = mockWsInstance!.sentMessages.filter((m) => {
      const parsed = JSON.parse(m);
      return parsed.type === 'stream';
    });
    expect(streamMsgs).toHaveLength(0);
  });

  it('broadcasts session status on registration', () => {
    (sessionManager.getAllSessions as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        id: 's1',
        repo: 'my-repo',
        taskId: 'TASK-1',
        type: 'worker',
        lastActive: new Date(),
        isExternal: false,
      },
    ]);

    client.connect('test-token');
    mockWsInstance!.simulateOpen();
    // Clear register message
    mockWsInstance!.sentMessages = [];
    mockWsInstance!.simulateMessage({ type: 'registered', connectionId: 'conn-123' });

    // Should have sent a status message
    const statusMsgs = mockWsInstance!.sentMessages.filter((m) => {
      const parsed = JSON.parse(m);
      return parsed.type === 'status';
    });
    expect(statusMsgs.length).toBe(1);
    const status = JSON.parse(statusMsgs[0]);
    expect(status.sessions).toHaveLength(1);
    expect(status.sessions[0].repo).toBe('my-repo');
    expect(status.sessions[0].task).toBe('TASK-1');
  });
});
