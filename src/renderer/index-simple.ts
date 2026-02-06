/**
 * Simplified renderer - just orchestrator, no split pane
 * Testing if the flex layout is the issue
 */

import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';

interface SessionInfo {
  id: string;
  repo: string;
  repoPath: string;
  type: 'orchestrator' | 'worker';
  isExternal: boolean;
}

declare global {
  interface Window {
    workstation: {
      createSession: (repo: string, repoPath: string, type: string) => Promise<string>;
      getSessions: () => Promise<SessionInfo[]>;
      writeToTerminal: (sessionId: string, data: string) => void;
      resizeTerminal: (sessionId: string, cols: number, rows: number) => void;
      onTerminalData: (callback: (sessionId: string, data: string) => void) => void;
      onSessionCreated: (callback: (session: SessionInfo) => void) => void;
    };
    log: {
      info: (...args: unknown[]) => void;
      error: (...args: unknown[]) => void;
    };
  }
}

// Simple state - like test-minimal-app
let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let sessionId: string | null = null;

async function init() {
  console.log('Simple app init...');

  // Set up IPC handler FIRST
  window.workstation.onTerminalData((sid, data) => {
    if (terminal && sid === sessionId) {
      terminal.write(data);
    }
  });

  window.workstation.onSessionCreated((session) => {
    console.log('Session created:', session.id, session.type);
    if (session.type === 'orchestrator' && !terminal) {
      createTerminal(session.id);
    }
  });

  // Check for existing sessions
  const sessions = await window.workstation.getSessions();
  const orchestrator = sessions.find(s => s.type === 'orchestrator' && !s.isExternal);

  if (orchestrator) {
    createTerminal(orchestrator.id);
  } else {
    // Create new orchestrator session
    await window.workstation.createSession('orchestrator', '~', 'orchestrator');
  }
}

function createTerminal(sid: string) {
  console.log('Creating terminal for session:', sid);
  sessionId = sid;

  const container = document.getElementById('terminal');
  if (!container) {
    console.error('Container not found!');
    return;
  }

  terminal = new Terminal({
    theme: {
      background: '#1e1e1e',
      foreground: '#cccccc',
      cursor: '#ffffff',
    },
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 10000,
  });

  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  // Wire up input
  terminal.onData((data) => {
    window.workstation.writeToTerminal(sid, data);
  });

  terminal.onResize(({ cols, rows }) => {
    window.workstation.resizeTerminal(sid, cols, rows);
  });

  // Open terminal
  terminal.open(container);
  fitAddon.fit();
  terminal.focus();

  const { cols, rows } = terminal;
  console.log('Terminal opened:', cols, 'x', rows);
  window.workstation.resizeTerminal(sid, cols, rows);

  // Window resize
  window.addEventListener('resize', () => {
    if (fitAddon) fitAddon.fit();
  });
}

// Start
init();
