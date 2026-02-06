/**
 * Renderer Process for Varie Workstation
 *
 * Split-pane layout with orchestrator (left) and workers grid (right).
 */

import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import 'xterm/css/xterm.css';
import { themes, getThemeById, getDefaultTheme, TerminalTheme } from './themes';
// Note: Web Speech API voice capture kept for reference, now using native macOS via IPC

// Types
type SessionType = 'orchestrator' | 'worker';

interface SessionInfo {
  id: string;
  repo: string;
  repoPath: string;
  taskId?: string;
  type: SessionType;
  isExternal: boolean;
  createdAt: string;
  lastActive: string;
}

// LLM types
type LLMProvider = 'anthropic' | 'openai' | 'google';

type SpeechLocale = 'auto' | 'en-US' | 'zh-CN' | 'zh-TW' | 'ja-JP' | 'ko-KR' | 'es-ES' | 'fr-FR' | 'de-DE';
type VoiceInputMode = 'apple-speech' | 'direct-audio';

interface LLMSettings {
  provider: LLMProvider;
  model: string;
  apiKey: string;
  enabled: boolean;
  refineTranscript: boolean;
  speechLocale: SpeechLocale;
  voiceInputMode: VoiceInputMode;
  confirmBeforeSend: boolean;
}

interface ModelInfo {
  id: string;
  name: string;
  type: 'fast' | 'balanced' | 'flagship';
}

interface SpeechLocaleInfo {
  id: SpeechLocale;
  name: string;
}

interface WorkstationAPI {
  createSession: (repo: string, repoPath: string, type: SessionType, taskId?: string) => Promise<string>;
  closeSession: (sessionId: string) => Promise<boolean>;
  browseFolder: () => Promise<string | null>;
  getSessions: () => Promise<SessionInfo[]>;
  focusSession: (sessionId: string) => void;
  writeToTerminal: (sessionId: string, data: string) => void;
  resizeTerminal: (sessionId: string, cols: number, rows: number) => void;
  onTerminalData: (callback: (sessionId: string, data: string) => void) => void;
  onSessionCreated: (callback: (session: SessionInfo) => void) => void;
  onSessionClosed: (callback: (sessionId: string) => void) => void;
  onSessionUpdated: (callback: (session: SessionInfo) => void) => void;
  onPluginEvent: (callback: (event: unknown) => void) => void;
  onWindowShow: (callback: () => void) => void;
  // Voice
  voiceCheck: () => Promise<boolean>;
  voiceStart: () => void;
  voiceStop: () => void;
  onVoiceEvent: (callback: (event: any) => void) => void;
  // LLM
  llmGetSettings: () => Promise<LLMSettings>;
  llmSaveSettings: (settings: LLMSettings) => Promise<{ success: boolean; error?: string }>;
  llmTestConnection: () => Promise<{ success: boolean; error?: string }>;
  llmGetProviders: () => Promise<Record<LLMProvider, ModelInfo[]>>;
  llmGetSpeechLocales: () => Promise<SpeechLocaleInfo[]>;
  llmIsRoutingAvailable: () => Promise<boolean>;
  // Voice routing
  voiceRoute: (voiceInput: string, focusedSessionId?: string, audioPath?: string) => Promise<{
    targetSessionId: string;
    confidence: 'strong' | 'weak' | 'unknown' | 'direct';
    reasoning?: string;
    usedLLM: boolean;
    refinedTranscript?: string;
  }>;
  quit: () => void;
}

declare global {
  interface Window {
    workstation: WorkstationAPI;
    log: {
      info: (...args: unknown[]) => void;
      warn: (...args: unknown[]) => void;
      error: (...args: unknown[]) => void;
    };
  }
}

// ============================================================================
// State
// ============================================================================

interface TerminalState {
  terminal: Terminal;
  fitAddon: FitAddon;
  session: SessionInfo;
  opened: boolean;
  gridPosition?: number;  // 0-3 for grid, undefined for tabs
  containerEl?: HTMLElement;  // Terminal container for re-attachment
  headerEl?: HTMLElement;     // Cell header for re-attachment
}

// Orchestrator state
let orchestratorState: TerminalState | null = null;

// Workers state
const workers: Map<string, TerminalState> = new Map();
const gridPositions: (string | null)[] = [null, null, null, null];
let activeWorkerId: string | null = null;

// Layout state
type LayoutPreset = '1x1' | '1x2' | '2x2';
let currentLayout: LayoutPreset = '1x2';

// Theme state
let currentTheme: TerminalTheme = getDefaultTheme();

// ============================================================================
// DOM Elements - Get only what we need, lazily
// ============================================================================

// DISABLED: Get elements at module load - might cause issues
// const orchestratorTerminalEl = document.getElementById('orchestrator-terminal')!;
const orchestratorStatusEl = document.getElementById('orchestrator-status');
const workersGrid = document.getElementById('workers-grid');
const workersTabs = document.getElementById('workers-tabs');
const newWorkerBtn = document.getElementById('new-worker-btn');
const sessionCountEl = document.getElementById('session-count');

// Modal elements - DISABLED
const modal = document.getElementById('new-worker-modal');
const newWorkerForm = document.getElementById('new-worker-form') as HTMLFormElement | null;
const cancelBtn = document.getElementById('cancel-new-worker');
const workerPathInput = document.getElementById('worker-path') as HTMLInputElement | null;
const workerNameInput = document.getElementById('worker-name') as HTMLInputElement | null;
const workerPermissionSelect = document.getElementById('worker-permission') as HTMLSelectElement | null;

// ============================================================================
// Drag and Drop Support (ISSUE-035, ISSUE-038)
// ============================================================================

// Custom MIME type for session drag-to-swap (ISSUE-038)
const SESSION_DRAG_TYPE = 'application/x-workstation-session';

/**
 * Set up a grid cell as a drop target for session swaps (ISSUE-038).
 * Handles dragging sessions between grid positions.
 */
function setupCellDropZone(cell: HTMLElement, targetPosition: number): void {
  cell.addEventListener('dragover', (e) => {
    // Only accept session drags, not file drops
    if (e.dataTransfer?.types.includes(SESSION_DRAG_TYPE)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      cell.classList.add('drop-target');
    }
  });

  cell.addEventListener('dragleave', (e) => {
    // Only remove if leaving the cell entirely (not entering a child)
    if (!cell.contains(e.relatedTarget as Node)) {
      cell.classList.remove('drop-target');
    }
  });

  cell.addEventListener('drop', (e) => {
    cell.classList.remove('drop-target');

    // Only handle session drops
    const draggedSessionId = e.dataTransfer?.getData(SESSION_DRAG_TYPE);
    if (!draggedSessionId) return;

    e.preventDefault();
    e.stopPropagation();

    // Get the session currently at target position
    const targetSessionId = gridPositions[targetPosition];

    // Get dragged session's current position
    const draggedState = workers.get(draggedSessionId);
    if (!draggedState) return;

    const sourcePosition = draggedState.gridPosition;

    window.log.info(`Drop: session ${draggedSessionId} (pos ${sourcePosition}) -> position ${targetPosition} (session ${targetSessionId})`);

    // Perform the swap
    if (sourcePosition !== undefined && sourcePosition !== targetPosition) {
      // Both sessions are in grid - swap positions
      if (targetSessionId) {
        swapGridPositions(draggedSessionId, sourcePosition, targetSessionId, targetPosition);
      } else {
        // Target cell is empty - just move
        moveWorkerToGrid(draggedSessionId, targetPosition);
      }
    } else if (sourcePosition === undefined) {
      // Dragging from overflow tabs to grid
      if (targetSessionId) {
        // Swap: target goes to overflow, dragged takes its place
        moveWorkerToTabs(targetSessionId);
        moveWorkerToGrid(draggedSessionId, targetPosition);
      } else {
        // Target cell empty - just place
        moveWorkerToGrid(draggedSessionId, targetPosition);
      }
    }

    focusWorker(draggedSessionId);
  });
}

/**
 * Swap two sessions' grid positions (ISSUE-038).
 */
function swapGridPositions(
  sessionA: string,
  positionA: number,
  sessionB: string,
  positionB: number
): void {
  const stateA = workers.get(sessionA);
  const stateB = workers.get(sessionB);
  if (!stateA || !stateB) return;

  window.log.info(`Swapping: ${sessionA} (pos ${positionA}) <-> ${sessionB} (pos ${positionB})`);

  // Detach both from their current cells
  const cellA = getGridCell(positionA);
  const cellB = getGridCell(positionB);

  if (cellA && stateA.containerEl && stateA.headerEl) {
    stateA.containerEl.remove();
    stateA.headerEl.remove();
  }
  if (cellB && stateB.containerEl && stateB.headerEl) {
    stateB.containerEl.remove();
    stateB.headerEl.remove();
  }

  // Update grid positions
  gridPositions[positionA] = sessionB;
  gridPositions[positionB] = sessionA;
  stateA.gridPosition = positionB;
  stateB.gridPosition = positionA;

  // Re-attach to swapped cells
  placeWorkerInGrid(sessionA, positionB);
  placeWorkerInGrid(sessionB, positionA);

  updateWorkerCellStates();
}

/**
 * Quote a file path if it contains spaces or special characters.
 * Uses single quotes and escapes any single quotes in the path.
 */
function quotePathIfNeeded(path: string): string {
  // If path contains spaces, quotes, or shell special chars, quote it
  if (/[\s'"\\$`!]/.test(path)) {
    // Escape single quotes by ending quote, adding escaped quote, reopening quote
    const escaped = path.replace(/'/g, "'\\''");
    return `'${escaped}'`;
  }
  return path;
}

/**
 * Set up drag and drop file handling for a terminal container.
 * Dropped files have their paths inserted into the terminal.
 */
function setupTerminalDragDrop(container: HTMLElement, sessionId: string): void {
  // Prevent default drag behavior (would open file in browser)
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    container.classList.add('drag-over');
  });

  container.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    container.classList.remove('drag-over');
  });

  container.addEventListener('dragend', () => {
    container.classList.remove('drag-over');
  });

  container.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    container.classList.remove('drag-over');

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) {
      window.log.info('Drop: no files');
      return;
    }

    // Extract file paths (Electron provides full paths)
    const paths: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i] as File & { path?: string };
      if (file.path) {
        paths.push(quotePathIfNeeded(file.path));
      }
    }

    if (paths.length === 0) {
      window.log.warn('Drop: no file paths available');
      return;
    }

    // Join paths with space and write to terminal
    const pathString = paths.join(' ');
    window.log.info(`Drop: inserting ${paths.length} path(s) into session ${sessionId}`);
    window.workstation.writeToTerminal(sessionId, pathString);
  });
}

// ============================================================================
// Terminal Creation Helpers
// ============================================================================

function createTerminalInstance(): { terminal: Terminal; fitAddon: FitAddon } {
  const terminal = new Terminal({
    theme: currentTheme.colors,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 10000,
    // Preserve scroll position when ED2 (Erase in Display All) is used
    // This prevents jumping to top when Claude Code clears screen for diffs
    scrollOnEraseInDisplay: true,
  });

  // Intercept shortcuts before xterm.js captures them
  // Return false to prevent xterm from processing the key
  terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
    // Ctrl+1/2/4: Layout shortcuts
    if (e.ctrlKey && !e.metaKey && (e.key === '1' || e.key === '2' || e.key === '4')) {
      return false;
    }
    // Ctrl+V: Voice toggle (not Cmd+V which is paste)
    if (e.ctrlKey && !e.metaKey && !e.shiftKey && e.key === 'v') {
      return false;
    }
    // Let xterm.js handle all other keys
    return true;
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  // TEMP: Disabled WebLinksAddon to test if it causes issues
  // terminal.loadAddon(new WebLinksAddon());

  return { terminal, fitAddon };
}

// ============================================================================
// Orchestrator Management
// ============================================================================

function createOrchestratorUI(session: SessionInfo): void {
  window.log.info('Creating orchestrator UI');

  const { terminal, fitAddon } = createTerminalInstance();

  // Wire up events
  terminal.onData((data) => {
    window.workstation.writeToTerminal(session.id, data);
  });

  terminal.onResize(({ cols, rows }) => {
    window.workstation.resizeTerminal(session.id, cols, rows);
  });

  orchestratorState = {
    terminal,
    fitAddon,
    session,
    opened: true,
  };

  // Get container fresh (like working minimal app)
  const container = document.getElementById('orchestrator-terminal');
  if (!container) {
    window.log.error('Container not found!');
    return;
  }

  // Simple open pattern - like the working minimal test
  terminal.open(container);
  fitAddon.fit();
  terminal.focus();

  const { cols, rows } = terminal;
  window.log.info(`Orchestrator opened: ${cols}x${rows}`);
  window.workstation.resizeTerminal(session.id, cols, rows);

  // Set up drag and drop for file path insertion (ISSUE-035)
  setupTerminalDragDrop(container, session.id);

  // Listen for terminal focus to clear worker tab highlight (ISSUE-037)
  // xterm 5.3 removed onFocus — use textarea DOM event instead
  terminal.textarea?.addEventListener('focus', () => {
    if (activeWorkerId !== null) {
      activeWorkerId = null;
      updateWorkerCellStates();
      updateOrchestratorStatus(getManagerTips());
    }
  });

  updateOrchestratorStatus(getManagerTips());
}

function getManagerTips(): string {
  return 'Skills: /projects · /work-sessions · /work-status · /work-report';
}

function getShortcutHints(): string {
  return '⌘O Manager · ⌘1-4 Sessions · ⌃1/2/4 Layout · ⌘N New · ⌘W Close';
}

function focusOrchestrator(): void {
  if (!orchestratorState) return;

  // Remove active from workers
  activeWorkerId = null;
  updateWorkerCellStates();

  orchestratorState.terminal.focus();
  orchestratorState.fitAddon.fit();

  // Show skill tips when Manager is focused
  updateOrchestratorStatus(getManagerTips());
}

function updateOrchestratorStatus(status: string): void {
  if (orchestratorStatusEl) orchestratorStatusEl.textContent = status;
}

// ============================================================================
// Worker Management
// ============================================================================

function createWorkerUI(session: SessionInfo): void {
  window.log.info('Creating worker UI for:', session.id);

  const { terminal, fitAddon } = createTerminalInstance();

  // Wire up events
  terminal.onData((data) => {
    window.workstation.writeToTerminal(session.id, data);
  });

  terminal.onResize(({ cols, rows }) => {
    window.log.info(`Worker ${session.id} resize: ${cols}x${rows}`);
    window.workstation.resizeTerminal(session.id, cols, rows);
  });

  // Find grid position or put in tabs
  const gridPos = findEmptyGridPosition();

  const state: TerminalState = {
    terminal,
    fitAddon,
    session,
    opened: false,
    gridPosition: gridPos ?? undefined,  // null -> undefined for overflow sessions
  };

  workers.set(session.id, state);

  // Always create a tab for every session (like browser tabs)
  createWorkerTab(session);

  if (gridPos !== null) {
    // Place in grid
    gridPositions[gridPos] = session.id;
    placeWorkerInGrid(session.id, gridPos);
    // Focus this worker
    focusWorker(session.id);
  } else {
    // Grid is full - swap new session to front (takes position of active worker)
    window.log.info(`createWorkerUI: grid full, swapping ${session.id} to front`);
    swapTabToGrid(session.id);
  }

  updateSessionCount();
}

function findEmptyGridPosition(): number | null {
  // Only consider positions within the visible cell count for current layout
  const visibleCount = getVisibleCellCount();
  for (let i = 0; i < visibleCount; i++) {
    if (gridPositions[i] === null) return i;
  }
  return null;
}

function getGridCell(position: number): HTMLElement | null {
  // Cells are now nested in columns:
  // Left column (grid-col-left): positions 0, 2
  // Right column (grid-col-right): positions 1, 3
  return document.querySelector(`.worker-cell[data-position="${position}"]`) as HTMLElement | null;
}

function placeWorkerInGrid(sessionId: string, position: number): void {
  const state = workers.get(sessionId);
  if (!state) {
    window.log.error(`placeWorkerInGrid: session ${sessionId} not found`);
    return;
  }

  const cell = getGridCell(position);
  if (!cell) {
    window.log.error(`placeWorkerInGrid: cell not found for position ${position}`);
    return;
  }

  window.log.info(`placeWorkerInGrid: ${sessionId} at position ${position}, opened=${state.opened}, hasContainer=${!!state.containerEl}`);

  // Clear placeholder if present
  const placeholder = cell.querySelector('.cell-placeholder');
  if (placeholder) placeholder.remove();

  if (state.opened && state.containerEl && state.headerEl) {
    // Re-attach existing elements (terminal already opened)
    window.log.info(`placeWorkerInGrid: re-attaching existing elements for ${sessionId}`);
    cell.appendChild(state.headerEl);
    cell.appendChild(state.containerEl);

    // Re-setup click handler for this cell
    cell.onclick = () => focusWorker(sessionId);
    setupHeaderHoverZone(cell, state.headerEl);

    // Refit terminal to new cell size
    state.fitAddon.fit();
    const { cols, rows } = state.terminal;
    window.workstation.resizeTerminal(sessionId, cols, rows);
  } else {
    // First time placement - create elements and open terminal
    window.log.info(`placeWorkerInGrid: first time placement for ${sessionId}, creating elements`);
    const container = document.createElement('div');
    container.className = 'terminal-container';
    container.id = `worker-terminal-${sessionId}`;

    const header = document.createElement('div');
    header.className = 'cell-header';

    const title = document.createElement('span');
    title.className = 'cell-title';
    title.textContent = state.session.repo + (state.session.taskId ? ` (${state.session.taskId})` : '');

    const closeBtn = document.createElement('button');
    closeBtn.className = 'cell-close';
    closeBtn.textContent = '\u00d7';
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      closeWorker(sessionId);
    };

    header.appendChild(title);
    header.appendChild(closeBtn);

    // Make header draggable for drag-to-swap (ISSUE-038)
    header.draggable = true;
    header.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData(SESSION_DRAG_TYPE, sessionId);
      e.dataTransfer!.effectAllowed = 'move';
      header.classList.add('dragging');
      cell.classList.add('dragging');
    });
    header.addEventListener('dragend', () => {
      header.classList.remove('dragging');
      cell.classList.remove('dragging');
    });

    cell.appendChild(header);
    cell.appendChild(container);

    // Store references for re-attachment
    state.containerEl = container;
    state.headerEl = header;

    // Click to focus
    cell.onclick = () => focusWorker(sessionId);

    // Header visibility: only show when mouse is in top 20% of cell
    setupHeaderHoverZone(cell, header);

    // Open terminal
    state.terminal.open(container);
    state.opened = true;
    state.fitAddon.fit();
    const { cols, rows } = state.terminal;
    window.workstation.resizeTerminal(sessionId, cols, rows);

    // Listen for terminal focus to sync tab highlight (ISSUE-037)
    // xterm 5.3 removed onFocus — use textarea DOM event instead
    state.terminal.textarea?.addEventListener('focus', () => {
      if (activeWorkerId !== sessionId) {
        activeWorkerId = sessionId;
        updateWorkerCellStates();
        updateOrchestratorStatus(getShortcutHints());
      }
    });

    // Set up drag and drop for file path insertion (ISSUE-035)
    setupTerminalDragDrop(container, sessionId);
  }
}

function setupHeaderHoverZone(cell: HTMLElement, header: HTMLElement): void {
  const HOVER_ZONE_PERCENT = 0.18; // Top 18% of cell

  cell.addEventListener('mousemove', (e) => {
    const rect = cell.getBoundingClientRect();
    const relativeY = e.clientY - rect.top;
    const threshold = rect.height * HOVER_ZONE_PERCENT;

    if (relativeY <= threshold) {
      header.classList.add('visible');
    } else {
      header.classList.remove('visible');
    }
  });

  cell.addEventListener('mouseleave', () => {
    header.classList.remove('visible');
  });
}

function createWorkerTab(session: SessionInfo): void {
  if (!workersTabs) return;

  const tab = document.createElement('button');
  tab.className = 'worker-tab';
  tab.dataset.sessionId = session.id;
  tab.textContent = session.repo + (session.taskId ? ` (${session.taskId})` : '');

  // Click behavior depends on whether session is in grid or overflow
  tab.onclick = () => handleTabClick(session.id);

  // Drag-to-swap support (ISSUE-038)
  tab.draggable = true;
  tab.addEventListener('dragstart', (e) => {
    e.dataTransfer?.setData(SESSION_DRAG_TYPE, session.id);
    e.dataTransfer!.effectAllowed = 'move';
    tab.classList.add('dragging');
  });
  tab.addEventListener('dragend', () => {
    tab.classList.remove('dragging');
  });

  workersTabs.appendChild(tab);
}

function handleTabClick(sessionId: string): void {
  const state = workers.get(sessionId);
  if (!state) return;

  if (state.gridPosition !== undefined) {
    // Session is in grid - just focus it
    focusWorker(sessionId);
  } else {
    // Session is in overflow - swap with active grid session
    swapTabToGrid(sessionId);
  }
}

function swapTabToGrid(tabSessionId: string): void {
  const tabState = workers.get(tabSessionId);
  if (!tabState) {
    window.log.error(`swapTabToGrid: session ${tabSessionId} not found`);
    return;
  }

  // First, check if there's an empty grid position
  const emptyPos = findEmptyGridPosition();
  if (emptyPos !== null) {
    window.log.info(`swapTabToGrid: placing ${tabSessionId} in empty position ${emptyPos}`);
    moveWorkerToGrid(tabSessionId, emptyPos);
    focusWorker(tabSessionId);
    return;
  }

  // No empty position - need to swap with a session currently in grid
  // First try the active worker, but if it's not in grid, find any worker that is
  let swapTargetId: string | null = null;
  let swapTargetPos: number | null = null;

  // Try active worker first
  if (activeWorkerId && activeWorkerId !== tabSessionId) {
    const activeState = workers.get(activeWorkerId);
    if (activeState && activeState.gridPosition !== undefined) {
      swapTargetId = activeWorkerId;
      swapTargetPos = activeState.gridPosition;
    }
  }

  // If active worker not in grid, find any worker that is in grid
  if (swapTargetId === null) {
    const visibleCount = getVisibleCellCount();
    for (let i = 0; i < visibleCount; i++) {
      const sessionInGrid = gridPositions[i];
      if (sessionInGrid && sessionInGrid !== tabSessionId) {
        swapTargetId = sessionInGrid;
        swapTargetPos = i;
        break;
      }
    }
  }

  if (swapTargetId === null || swapTargetPos === null) {
    window.log.warn(`swapTabToGrid: no session in grid to swap with`);
    return;
  }

  window.log.info(`swapTabToGrid: swapping ${tabSessionId} with ${swapTargetId} at position ${swapTargetPos}`);

  // Move current grid session to tabs first
  moveWorkerToTabs(swapTargetId);

  // Move tab to grid
  moveWorkerToGrid(tabSessionId, swapTargetPos);

  // Focus the new grid worker
  focusWorker(tabSessionId);
}

function moveWorkerToGrid(sessionId: string, position: number): void {
  if (position === null || position === undefined || position < 0 || position > 3) {
    window.log.error(`moveWorkerToGrid: invalid position ${position}`);
    return;
  }

  const state = workers.get(sessionId);
  if (!state) {
    window.log.error(`moveWorkerToGrid: session ${sessionId} not found`);
    return;
  }

  const oldPosition = state.gridPosition;
  window.log.info(`moveWorkerToGrid: moving ${sessionId} from position ${oldPosition} to position ${position}`);

  // Clean up old position if session was in grid (ISSUE-038 fix)
  if (oldPosition !== undefined && oldPosition !== position) {
    const oldCell = getGridCell(oldPosition);
    if (oldCell) {
      // Detach terminal elements from old cell
      if (state.containerEl && state.containerEl.parentNode === oldCell) {
        state.containerEl.remove();
      }
      if (state.headerEl && state.headerEl.parentNode === oldCell) {
        state.headerEl.remove();
      }
      // Add placeholder back to old cell
      const placeholder = document.createElement('div');
      placeholder.className = 'cell-placeholder';
      placeholder.textContent = 'No session';
      oldCell.appendChild(placeholder);
      oldCell.onclick = null;
    }
    // Clear old position in grid array
    gridPositions[oldPosition] = null;
  }

  // Update state
  state.gridPosition = position;
  gridPositions[position] = sessionId;

  // Place in grid
  placeWorkerInGrid(sessionId, position);
}

function moveWorkerToTabs(sessionId: string): void {
  const state = workers.get(sessionId);
  if (!state || state.gridPosition === undefined) return;

  const position = state.gridPosition;
  const cell = getGridCell(position);
  if (!cell) return;

  // Detach terminal elements (don't destroy - keep for re-attachment)
  if (state.containerEl && state.containerEl.parentNode) {
    state.containerEl.remove();
  }
  if (state.headerEl && state.headerEl.parentNode) {
    state.headerEl.remove();
  }

  // Add placeholder back
  const placeholder = document.createElement('div');
  placeholder.className = 'cell-placeholder';
  placeholder.textContent = 'No session';
  cell.appendChild(placeholder);
  cell.onclick = null;

  // Update state
  gridPositions[position] = null;
  state.gridPosition = undefined;

  // Tab already exists (all sessions always have tabs)
}

function focusWorker(sessionId: string): void {
  const state = workers.get(sessionId);
  if (!state) return;

  activeWorkerId = sessionId;
  updateWorkerCellStates();

  if (state.gridPosition !== undefined && state.opened) {
    // Focus terminal in grid - simple, no RAF
    state.fitAddon.fit();
    state.terminal.focus();
  }

  window.workstation.focusSession(sessionId);

  // Show shortcuts when Sessions are focused
  updateOrchestratorStatus(getShortcutHints());
}

function updateWorkerCellStates(): void {
  if (!workersGrid || !workersTabs) return;

  // Update grid cell active states
  for (let i = 0; i < 4; i++) {
    const cell = getGridCell(i);
    if (cell) {
      const isActive = gridPositions[i] === activeWorkerId;
      cell.classList.toggle('active', isActive);
    }
  }

  // Update tab states (active + overflow)
  workersTabs.querySelectorAll('.worker-tab').forEach((tab) => {
    const tabEl = tab as HTMLElement;
    const sessionId = tabEl.dataset.sessionId;
    const state = sessionId ? workers.get(sessionId) : null;

    // Active state
    tabEl.classList.toggle('active', sessionId === activeWorkerId);

    // Overflow state (not in grid)
    const isOverflow = state?.gridPosition === undefined;
    tabEl.classList.toggle('overflow', isOverflow);
  });
}

function closeWorker(sessionId: string): void {
  window.log.info('Closing worker:', sessionId);
  window.workstation.closeSession(sessionId);
}

function removeWorkerUI(sessionId: string): void {
  const state = workers.get(sessionId);
  if (!state) return;

  // Remove from grid if present
  if (state.gridPosition !== undefined) {
    const position = state.gridPosition;
    const cell = getGridCell(position);
    if (cell) {
      cell.innerHTML = '<div class="cell-placeholder">No session</div>';
      cell.onclick = null;
    }
    gridPositions[position] = null;
  }

  // Remove tab if present
  const tab = workersTabs.querySelector(`[data-session-id="${sessionId}"]`);
  if (tab) tab.remove();

  // Dispose terminal
  state.terminal.dispose();
  workers.delete(sessionId);

  // Update active
  if (activeWorkerId === sessionId) {
    activeWorkerId = null;
    // Focus another worker if available
    const remaining = Array.from(workers.keys());
    if (remaining.length > 0) {
      focusWorker(remaining[0]);
    }
  }

  updateWorkerCellStates();
  updateSessionCount();
}

function updateSessionCount(): void {
  if (sessionCountEl) {
    sessionCountEl.textContent = `(${workers.size})`;
  }
}

// ============================================================================
// Modal Handling
// ============================================================================

function showNewWorkerModal(): void {
  modal.classList.remove('hidden');
  workerPathInput.focus();
  if (!workerPathInput.value) {
    workerPathInput.value = '';
  }
}

function hideNewWorkerModal(): void {
  modal.classList.add('hidden');
  newWorkerForm.reset();
}

async function handleNewWorker(e: Event): Promise<void> {
  e.preventDefault();

  const repoPath = workerPathInput.value.trim();
  if (!repoPath) return;

  let repo = workerNameInput.value.trim();
  if (!repo) {
    repo = repoPath.split('/').filter(Boolean).pop() || 'worker';
  }

  const claudeFlags = workerPermissionSelect?.value || undefined;

  try {
    window.log.info('Creating new worker:', repo, repoPath, claudeFlags ? `flags: ${claudeFlags}` : '');
    await window.workstation.createSession(repo, repoPath, 'worker', undefined, claudeFlags);
    hideNewWorkerModal();
  } catch (err) {
    window.log.error('Failed to create worker:', err);
    alert('Failed to create worker session.');
  }
}

// ============================================================================
// Keyboard Shortcuts
// ============================================================================

function setupKeyboardShortcuts(): void {
  document.addEventListener('keydown', (e) => {
    const isMod = e.metaKey || e.ctrlKey;

    // Cmd+O: Focus orchestrator
    if (isMod && e.key === 'o') {
      e.preventDefault();
      focusOrchestrator();
      return;
    }

    // Cmd+N: New worker
    if (isMod && e.key === 'n') {
      e.preventDefault();
      showNewWorkerModal();
      return;
    }

    // Ctrl+1/2/4: Switch layout presets (Ctrl+3 conflicts with Claude rewind)
    if (e.ctrlKey && !e.metaKey && (e.key === '1' || e.key === '2' || e.key === '4')) {
      e.preventDefault();
      const layoutMap: Record<string, LayoutPreset> = { '1': '1x1', '2': '1x2', '4': '2x2' };
      setLayout(layoutMap[e.key]);
      return;
    }

    // Cmd+1-4: Focus grid workers (without Shift)
    if (isMod && !e.shiftKey && e.key >= '1' && e.key <= '4') {
      e.preventDefault();
      const pos = parseInt(e.key, 10) - 1;
      const sessionId = gridPositions[pos];
      if (sessionId) {
        focusWorker(sessionId);
      }
      return;
    }

    // Cmd+W: Close active worker
    if (isMod && e.key === 'w' && activeWorkerId) {
      e.preventDefault();
      closeWorker(activeWorkerId);
      return;
    }

    // Escape: Close modal
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      hideNewWorkerModal();
      return;
    }
  });
}

// ============================================================================
// Window Resize
// ============================================================================

function setupResizeHandler(): void {
  window.addEventListener('resize', () => {
    // Refit orchestrator
    if (orchestratorState?.opened) {
      orchestratorState.fitAddon.fit();
    }

    // Refit visible workers based on current layout
    refitVisibleWorkers();
  });
}

// ============================================================================
// Layout Management
// ============================================================================

function getVisibleCellCount(): number {
  switch (currentLayout) {
    case '1x1': return 1;
    case '1x2': return 2;
    case '2x2': return 4;
    default: return 4;
  }
}

function setLayout(layout: LayoutPreset): void {
  if (layout === currentLayout) return;

  window.log.info(`Switching layout: ${currentLayout} -> ${layout}`);
  currentLayout = layout;

  // Update grid CSS class
  if (workersGrid) {
    workersGrid.classList.remove('layout-1x1', 'layout-1x2', 'layout-2x2');
    workersGrid.classList.add(`layout-${layout}`);
  }

  // Update layout button active states
  document.querySelectorAll('.layout-btn').forEach((btn) => {
    const btnEl = btn as HTMLElement;
    btnEl.classList.toggle('active', btnEl.dataset.layout === layout);
  });

  // Move sessions in now-hidden positions to tabs
  handleLayoutOverflow();

  // Refit visible terminals after layout change
  requestAnimationFrame(() => {
    refitVisibleWorkers();
  });
}

function handleLayoutOverflow(): void {
  const visibleCount = getVisibleCellCount();
  window.log.info(`handleLayoutOverflow: visibleCount=${visibleCount}, gridPositions=${JSON.stringify(gridPositions)}`);

  // Move sessions from hidden positions to tabs (when shrinking)
  for (let pos = visibleCount; pos < 4; pos++) {
    const sessionId = gridPositions[pos];
    if (sessionId) {
      window.log.info(`handleLayoutOverflow: moving ${sessionId} from hidden position ${pos} to tabs`);
      moveWorkerToTabs(sessionId);
    }
  }

  // Auto-populate empty cells with overflow sessions (when expanding)
  for (let pos = 0; pos < visibleCount; pos++) {
    if (gridPositions[pos] === null) {
      const overflowSession = findOverflowSession();
      window.log.info(`handleLayoutOverflow: position ${pos} is empty, overflow session = ${overflowSession}`);
      if (overflowSession) {
        moveWorkerToGrid(overflowSession, pos);
      }
    }
  }

  updateWorkerCellStates();
}

function findOverflowSession(): string | null {
  // Find a session that's not in the grid (overflow)
  // Check for both undefined and null (defensive)
  for (const [sessionId, state] of workers) {
    if (state.gridPosition === undefined || state.gridPosition === null) {
      return sessionId;
    }
  }
  return null;
}

function refitVisibleWorkers(): void {
  const visibleCount = getVisibleCellCount();
  workers.forEach((state) => {
    if (state.opened && state.gridPosition !== undefined && state.gridPosition < visibleCount) {
      state.fitAddon.fit();
    }
  });
}

function setupLayoutSelector(): void {
  document.querySelectorAll('.layout-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const layout = (btn as HTMLElement).dataset.layout as LayoutPreset;
      if (layout) {
        setLayout(layout);
      }
    });
  });
}

// ============================================================================
// Theme Management
// ============================================================================

const THEME_STORAGE_KEY = 'varie-workstation-theme';

function loadSavedTheme(): void {
  const savedThemeId = localStorage.getItem(THEME_STORAGE_KEY);
  if (savedThemeId) {
    const theme = getThemeById(savedThemeId);
    if (theme) {
      currentTheme = theme;
      window.log.info(`Loaded saved theme: ${theme.name}`);
    }
  }
}

function saveTheme(themeId: string): void {
  localStorage.setItem(THEME_STORAGE_KEY, themeId);
}

function setTheme(themeId: string): void {
  const theme = getThemeById(themeId);
  if (!theme) {
    window.log.warn(`Theme not found: ${themeId}`);
    return;
  }

  if (theme.id === currentTheme.id) return;

  window.log.info(`Switching theme: ${currentTheme.name} -> ${theme.name}`);
  currentTheme = theme;

  // Save to localStorage for persistence
  saveTheme(themeId);

  // Apply to orchestrator
  if (orchestratorState?.terminal) {
    orchestratorState.terminal.options.theme = theme.colors;
  }

  // Apply to all workers
  workers.forEach((state) => {
    if (state.terminal) {
      state.terminal.options.theme = theme.colors;
    }
  });

  // Update theme selector UI
  updateThemeSelectorUI();

  // Update CSS custom properties for UI consistency
  document.documentElement.style.setProperty('--terminal-bg', theme.colors.background);
}

function updateThemeSelectorUI(): void {
  const selector = document.getElementById('theme-selector') as HTMLSelectElement | null;
  if (selector) {
    selector.value = currentTheme.id;
  }
}

function setupThemeSelector(): void {
  // Load saved theme first
  loadSavedTheme();

  // Set CSS variable for initial theme (needed for container backgrounds)
  document.documentElement.style.setProperty('--terminal-bg', currentTheme.colors.background);

  const selector = document.getElementById('theme-selector') as HTMLSelectElement | null;
  if (!selector) return;

  // Populate options
  selector.innerHTML = themes.map(t =>
    `<option value="${t.id}"${t.id === currentTheme.id ? ' selected' : ''}>${t.name}</option>`
  ).join('');

  // Handle change
  selector.addEventListener('change', () => {
    setTheme(selector.value);
  });
}

// ============================================================================
// Skip Permissions Toggle
// ============================================================================

function updateSkipPermsUI(toggleBtn: HTMLElement, enabled: boolean): void {
  toggleBtn.classList.toggle('active', enabled);
  toggleBtn.title = enabled
    ? 'Skip Permissions: ON (new sessions skip permission prompts)'
    : 'Skip Permissions: OFF (new sessions use default permissions)';
}

function setupSkipPermissionsToggle(): void {
  const toggleBtn = document.getElementById('skip-perms-toggle');
  const confirmModal = document.getElementById('skip-perms-modal');
  const cancelBtn = document.getElementById('skip-perms-cancel');
  const acceptBtn = document.getElementById('skip-perms-accept');
  if (!toggleBtn || !confirmModal || !cancelBtn || !acceptBtn) return;

  // Load initial state from config
  window.workstation.getSkipPermissions().then((enabled) => {
    updateSkipPermsUI(toggleBtn, enabled);
  });

  // Toggle on click
  toggleBtn.addEventListener('click', async () => {
    const current = toggleBtn.classList.contains('active');

    if (current) {
      // Turning OFF — no confirmation needed, just disable
      await window.workstation.setSkipPermissions(false);
      updateSkipPermsUI(toggleBtn, false);
      window.log.info('Skip permissions disabled');
    } else {
      // Turning ON — show confirmation modal
      confirmModal.classList.remove('hidden');
    }
  });

  // Cancel — close modal, stay off
  cancelBtn.addEventListener('click', () => {
    confirmModal.classList.add('hidden');
  });

  // Accept — enable and close modal
  acceptBtn.addEventListener('click', async () => {
    confirmModal.classList.add('hidden');
    await window.workstation.setSkipPermissions(true);
    updateSkipPermsUI(toggleBtn, true);
    window.log.info('Skip permissions enabled (user accepted)');
  });

  // Close modal on backdrop click
  confirmModal.addEventListener('click', (e) => {
    if (e.target === confirmModal) {
      confirmModal.classList.add('hidden');
    }
  });

  // Close modal on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !confirmModal.classList.contains('hidden')) {
      confirmModal.classList.add('hidden');
    }
  });
}

// ============================================================================
// Panel Resize (Draggable Divider)
// ============================================================================

let managerWidthPercent = 30; // Default 30%

function setupDividerResize(): void {
  const divider = document.getElementById('divider');
  const orchestratorPanel = document.getElementById('orchestrator-panel');
  const mainContainer = document.getElementById('main-container');

  if (!divider || !orchestratorPanel || !mainContainer) return;

  let isDragging = false;
  let startX = 0;
  let startWidth = 0;

  const onMouseDown = (e: MouseEvent) => {
    isDragging = true;
    startX = e.clientX;
    startWidth = orchestratorPanel.offsetWidth;

    divider.classList.add('dragging');
    document.body.classList.add('resizing');

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    e.preventDefault();
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!isDragging) return;

    const containerWidth = mainContainer.offsetWidth;
    const deltaX = e.clientX - startX;
    const newWidth = startWidth + deltaX;

    // Calculate percentage (clamp between 15% and 70%)
    const newPercent = Math.max(15, Math.min(70, (newWidth / containerWidth) * 100));
    managerWidthPercent = newPercent;

    // Apply via CSS custom property
    orchestratorPanel.style.setProperty('--manager-width', `${newPercent}%`);
    orchestratorPanel.style.width = `var(--manager-width)`;

    // Refit terminals during drag (throttled via RAF)
    requestAnimationFrame(() => {
      if (orchestratorState?.opened) {
        orchestratorState.fitAddon.fit();
      }
      refitVisibleWorkers();
    });
  };

  const onMouseUp = () => {
    if (!isDragging) return;

    isDragging = false;
    divider.classList.remove('dragging');
    document.body.classList.remove('resizing');

    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);

    // Final refit
    if (orchestratorState?.opened) {
      orchestratorState.fitAddon.fit();
    }
    refitVisibleWorkers();

    window.log.info(`Manager panel resized to ${managerWidthPercent.toFixed(1)}%`);
  };

  divider.addEventListener('mousedown', onMouseDown);

  // Double-click to reset to default
  divider.addEventListener('dblclick', () => {
    managerWidthPercent = 30;
    orchestratorPanel.style.setProperty('--manager-width', '30%');
    orchestratorPanel.style.width = 'var(--manager-width)';

    requestAnimationFrame(() => {
      if (orchestratorState?.opened) {
        orchestratorState.fitAddon.fit();
      }
      refitVisibleWorkers();
    });

    window.log.info('Manager panel reset to 40%');
  });
}

// ============================================================================
// Grid Divider Resize (Between Worker Sessions)
// ============================================================================

let gridLeftWidthPercent = 50; // Default 50%

function setupGridDividerResize(): void {
  const gridDivider = document.getElementById('grid-divider');
  const gridColLeft = document.getElementById('grid-col-left');
  const grid = document.getElementById('workers-grid');

  if (!gridDivider || !gridColLeft || !grid) return;

  let isDragging = false;
  let startX = 0;
  let startWidth = 0;

  const onMouseDown = (e: MouseEvent) => {
    // Don't resize if in 1x1 mode (divider is hidden)
    if (currentLayout === '1x1') return;

    isDragging = true;
    startX = e.clientX;
    startWidth = gridColLeft.offsetWidth;

    gridDivider.classList.add('dragging');
    document.body.classList.add('resizing');

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    e.preventDefault();
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!isDragging) return;

    const gridWidth = grid.offsetWidth - 6; // Subtract divider width
    const deltaX = e.clientX - startX;
    const newWidth = startWidth + deltaX;

    // Calculate percentage (clamp between 20% and 80%)
    const newPercent = Math.max(20, Math.min(80, (newWidth / gridWidth) * 100));
    gridLeftWidthPercent = newPercent;

    // Apply via CSS custom property
    gridColLeft.style.setProperty('--grid-left-width', `${newPercent}%`);
    gridColLeft.style.width = `var(--grid-left-width)`;

    // Refit terminals during drag
    requestAnimationFrame(() => {
      refitVisibleWorkers();
    });
  };

  const onMouseUp = () => {
    if (!isDragging) return;

    isDragging = false;
    gridDivider.classList.remove('dragging');
    document.body.classList.remove('resizing');

    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);

    // Final refit
    refitVisibleWorkers();

    window.log.info(`Grid columns resized to ${gridLeftWidthPercent.toFixed(1)}% / ${(100 - gridLeftWidthPercent).toFixed(1)}%`);
  };

  gridDivider.addEventListener('mousedown', onMouseDown);

  // Double-click to reset to 50/50
  gridDivider.addEventListener('dblclick', () => {
    gridLeftWidthPercent = 50;
    gridColLeft.style.setProperty('--grid-left-width', '50%');
    gridColLeft.style.width = 'var(--grid-left-width)';

    requestAnimationFrame(() => {
      refitVisibleWorkers();
    });

    window.log.info('Grid columns reset to 50/50');
  });
}

// ============================================================================
// Row Divider Resize (Between Top/Bottom Cells in 2x2 Layout)
// ============================================================================

let gridTopHeightPercent = 50; // Default 50%

function setupRowDividerResize(): void {
  const grid = document.getElementById('workers-grid');
  const rowDividerLeft = document.getElementById('row-divider-left');
  const rowDividerRight = document.getElementById('row-divider-right');

  if (!grid || !rowDividerLeft || !rowDividerRight) return;

  let isDragging = false;
  let startY = 0;
  let startHeight = 0;
  let activeColumn: HTMLElement | null = null;

  const onMouseDown = (e: MouseEvent, divider: HTMLElement) => {
    // Don't resize if not in 2x2 mode
    if (currentLayout !== '2x2') return;

    isDragging = true;
    startY = e.clientY;

    // Get the column this divider is in
    activeColumn = divider.closest('.grid-column') as HTMLElement;
    if (!activeColumn) return;

    // Get the top cell's current height
    const topCell = activeColumn.querySelector('.worker-cell[data-position="0"], .worker-cell[data-position="1"]') as HTMLElement;
    startHeight = topCell?.offsetHeight || 0;

    divider.classList.add('dragging');
    document.body.classList.add('resizing-row');

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    e.preventDefault();
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!isDragging || !activeColumn) return;

    // Calculate column height (minus divider)
    const columnHeight = activeColumn.offsetHeight - 4; // Subtract row divider height
    const deltaY = e.clientY - startY;
    const newHeight = startHeight + deltaY;

    // Calculate percentage (clamp between 20% and 80%)
    const newPercent = Math.max(20, Math.min(80, (newHeight / columnHeight) * 100));
    gridTopHeightPercent = newPercent;

    // Apply to both columns (synced row heights)
    grid.style.setProperty('--grid-top-height', `${newPercent}%`);

    // Refit terminals during drag
    requestAnimationFrame(() => {
      refitVisibleWorkers();
    });
  };

  const onMouseUp = () => {
    if (!isDragging) return;

    isDragging = false;
    activeColumn = null;

    rowDividerLeft.classList.remove('dragging');
    rowDividerRight.classList.remove('dragging');
    document.body.classList.remove('resizing-row');

    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);

    // Final refit
    refitVisibleWorkers();

    window.log.info(`Grid rows resized to ${gridTopHeightPercent.toFixed(1)}% / ${(100 - gridTopHeightPercent).toFixed(1)}%`);
  };

  // Attach to both row dividers
  rowDividerLeft.addEventListener('mousedown', (e) => onMouseDown(e, rowDividerLeft));
  rowDividerRight.addEventListener('mousedown', (e) => onMouseDown(e, rowDividerRight));

  // Double-click to reset to 50/50
  const resetRows = () => {
    gridTopHeightPercent = 50;
    grid.style.setProperty('--grid-top-height', '50%');

    requestAnimationFrame(() => {
      refitVisibleWorkers();
    });

    window.log.info('Grid rows reset to 50/50');
  };

  rowDividerLeft.addEventListener('dblclick', resetRows);
  rowDividerRight.addEventListener('dblclick', resetRows);
}

// ============================================================================
// Voice Capture (Native macOS)
// ============================================================================

// Track voice capture state
let isVoiceCapturing = false;

async function setupVoiceCapture(): Promise<void> {
  const voiceBar = document.getElementById('voice-bar');
  const voiceBtn = document.getElementById('voice-btn');
  const voiceCancelBtn = document.getElementById('voice-cancel-btn');
  const voiceStatusText = document.getElementById('voice-status-text');
  const voiceInterim = document.getElementById('voice-interim');
  const voiceFinal = document.getElementById('voice-final');
  const voiceSettingsBtn = document.getElementById('voice-settings-btn');

  if (!voiceBar || !voiceBtn) {
    window.log.warn('Voice UI elements not found');
    return;
  }

  // Helper to show/hide cancel button
  const showCancelBtn = (show: boolean) => {
    if (voiceCancelBtn) {
      voiceCancelBtn.classList.toggle('hidden', !show);
    }
  };

  // Cancel voice capture (discard without processing)
  const cancelVoiceCapture = () => {
    if (isVoiceCapturing) {
      window.log.info('Voice: cancelling');
      isVoiceCapturing = false;
      showCancelBtn(false);
      window.workstation.voiceCancel();
      // Reset UI
      voiceBar.dataset.status = 'idle';
      if (voiceStatusText) {
        voiceStatusText.textContent = 'Cancelled';
        voiceStatusText.classList.remove('hint-text');
      }
      if (voiceInterim) voiceInterim.textContent = '';
      voiceBtn.classList.remove('recording');
      // Reset status text after brief moment
      setTimeout(() => {
        if (voiceStatusText && voiceStatusText.textContent === 'Cancelled') {
          voiceStatusText.textContent = 'Ctrl+V to speak';
        }
      }, 1000);
    }
  };

  // Check if native voice capture is available
  const isAvailable = await window.workstation.voiceCheck();
  if (!isAvailable) {
    window.log.warn('Native voice capture not available');
    voiceBar.classList.add('hidden');
    return;
  }

  window.log.info('Native voice capture available');

  // Handle voice events from main process
  window.workstation.onVoiceEvent((event: any) => {
    window.log.info('Voice event:', event.type, event);

    switch (event.type) {
      case 'status':
        voiceBar.dataset.status = event.status;
        const statusMessages: Record<string, string> = {
          idle: 'Ctrl+V to speak',
          listening: 'Esc to cancel · Ctrl+V to finish',
          recording: 'Esc to cancel · Ctrl+V to finish',
          processing: 'Processing...',
        };
        if (voiceStatusText) {
          voiceStatusText.textContent = statusMessages[event.status] || event.status;
          // Smaller font for recording hints (more text)
          voiceStatusText.classList.toggle('hint-text', event.status === 'listening' || event.status === 'recording');
        }
        voiceBtn.classList.toggle('recording', event.status === 'listening');
        // Show cancel button when recording, hide otherwise
        showCancelBtn(event.status === 'listening' || event.status === 'recording');
        if (event.status === 'idle') {
          isVoiceCapturing = false;
          showCancelBtn(false);
        }
        break;

      case 'interim':
        if (voiceInterim) {
          voiceInterim.textContent = event.transcript || '';
          // Auto-scroll to show latest text
          const transcript = document.getElementById('voice-transcript');
          if (transcript) transcript.scrollLeft = transcript.scrollWidth;
        }
        break;

      case 'final':
        window.log.info(`Voice final: "${event.transcript}", audioPath: ${event.audioPath || 'none'}`);
        if (voiceInterim) voiceInterim.textContent = '';
        if (voiceFinal) {
          voiceFinal.textContent = event.transcript || '';
          // Auto-scroll to show latest text
          const transcript = document.getElementById('voice-transcript');
          if (transcript) transcript.scrollLeft = transcript.scrollWidth;
        }
        handleVoiceCommand(event.transcript || '', event.audioPath);
        break;

      case 'error':
        voiceBar.dataset.status = 'error';
        if (voiceStatusText) {
          voiceStatusText.textContent = event.message || 'Error';
          voiceStatusText.classList.remove('hint-text');
        }
        isVoiceCapturing = false;
        showCancelBtn(false);
        // Reset after 3 seconds
        setTimeout(() => {
          if (voiceBar.dataset.status === 'error') {
            voiceBar.dataset.status = 'idle';
            if (voiceStatusText) voiceStatusText.textContent = 'Ctrl+V to speak';
          }
        }, 3000);
        break;

      case 'end':
        isVoiceCapturing = false;
        voiceBar.dataset.status = 'idle';
        if (voiceStatusText) {
          voiceStatusText.textContent = 'Ctrl+V to speak';
          voiceStatusText.classList.remove('hint-text');
        }
        voiceBtn.classList.remove('recording');
        showCancelBtn(false);
        break;
    }
  });

  // Toggle mode: Click to start, click again to stop
  voiceBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (isVoiceCapturing) {
      // Stop recording
      window.log.info('Voice: stopping (toggle off)');
      isVoiceCapturing = false;
      window.workstation.voiceStop();
      // Note: handleVoiceCommand is called when 'final' event arrives
    } else {
      // Start recording
      window.log.info('Voice: starting (toggle on)');
      if (voiceFinal) voiceFinal.textContent = '';
      if (voiceInterim) voiceInterim.textContent = '';
      isVoiceCapturing = true;
      window.workstation.voiceStart();
    }
  });

  // Settings button - open modal
  voiceSettingsBtn?.addEventListener('click', () => {
    showVoiceSettingsModal();
  });

  // Cancel button - discard recording
  voiceCancelBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    cancelVoiceCapture();
  });

  // Escape key - cancel recording (global listener)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isVoiceCapturing) {
      e.preventDefault();
      cancelVoiceCapture();
    }
  });

  window.log.info('Voice capture UI set up');
}

// ============================================================================
// Voice Settings Modal
// ============================================================================

let providerModels: Record<LLMProvider, ModelInfo[]> | null = null;

async function showVoiceSettingsModal(): Promise<void> {
  const modal = document.getElementById('voice-settings-modal');
  const form = document.getElementById('voice-settings-form') as HTMLFormElement | null;
  const enabledCheckbox = document.getElementById('llm-enabled') as HTMLInputElement | null;
  const refineCheckbox = document.getElementById('llm-refine') as HTMLInputElement | null;
  const confirmBeforeSendCheckbox = document.getElementById('confirm-before-send') as HTMLInputElement | null;
  const speechLocaleSelect = document.getElementById('speech-locale') as HTMLSelectElement | null;
  const voiceInputModeSelect = document.getElementById('voice-input-mode') as HTMLSelectElement | null;
  const providerSelect = document.getElementById('llm-provider') as HTMLSelectElement | null;
  const modelSelect = document.getElementById('llm-model') as HTMLSelectElement | null;
  const apiKeyInput = document.getElementById('llm-api-key') as HTMLInputElement | null;
  const toggleKeyBtn = document.getElementById('toggle-api-key');
  const testBtn = document.getElementById('test-connection-btn');
  const connectionStatus = document.getElementById('connection-status');
  const cancelBtn = document.getElementById('cancel-voice-settings');
  const apiKeyHint = document.getElementById('api-key-hint');

  if (!modal || !form || !enabledCheckbox || !refineCheckbox || !confirmBeforeSendCheckbox || !speechLocaleSelect || !voiceInputModeSelect || !providerSelect || !modelSelect || !apiKeyInput) {
    window.log.error('Voice settings modal elements not found');
    return;
  }

  // Load provider models if not cached
  if (!providerModels) {
    try {
      providerModels = await window.workstation.llmGetProviders();
    } catch (err) {
      window.log.error('Failed to load provider models:', err);
      return;
    }
  }

  // Load speech locales
  let speechLocales: SpeechLocaleInfo[];
  try {
    speechLocales = await window.workstation.llmGetSpeechLocales();
  } catch (err) {
    window.log.error('Failed to load speech locales:', err);
    return;
  }

  // Load current settings
  let settings: LLMSettings;
  try {
    settings = await window.workstation.llmGetSettings();
  } catch (err) {
    window.log.error('Failed to load LLM settings:', err);
    return;
  }

  // Populate form
  enabledCheckbox.checked = settings.enabled;
  refineCheckbox.checked = settings.refineTranscript;
  confirmBeforeSendCheckbox.checked = settings.confirmBeforeSend;
  providerSelect.value = settings.provider;
  apiKeyInput.value = settings.apiKey;

  // Populate speech locales
  populateSpeechLocales(speechLocaleSelect, speechLocales, settings.speechLocale);

  // Set voice input mode
  voiceInputModeSelect.value = settings.voiceInputMode || 'apple-speech';

  // Populate models for current provider
  populateModels(modelSelect, providerModels[settings.provider], settings.model);

  // Update API key hint
  updateApiKeyHint(apiKeyHint, settings.provider);

  // Clear connection status
  if (connectionStatus) {
    connectionStatus.textContent = '';
    connectionStatus.className = 'connection-status';
  }

  // Show modal
  modal.classList.remove('hidden');

  // Handle provider change
  const providerChangeHandler = () => {
    const provider = providerSelect.value as LLMProvider;
    if (providerModels) {
      populateModels(modelSelect, providerModels[provider]);
      updateApiKeyHint(apiKeyHint, provider);
    }
  };
  providerSelect.addEventListener('change', providerChangeHandler);

  // Handle voice input mode change - lock to Gemini when direct-audio selected
  const voiceInputModeChangeHandler = () => {
    const mode = voiceInputModeSelect.value;
    if (mode === 'direct-audio') {
      // Direct audio only works with Gemini - lock provider and model
      providerSelect.value = 'google';
      providerSelect.disabled = true;
      if (providerModels) {
        populateModels(modelSelect, providerModels.google);
        // Select gemini-3-flash-preview (fast model for routing)
        modelSelect.value = 'gemini-3-flash-preview';
      }
      modelSelect.disabled = true;
      updateApiKeyHint(apiKeyHint, 'google');
    } else {
      // Apple Speech - unlock provider and model selection
      providerSelect.disabled = false;
      modelSelect.disabled = false;
    }
  };
  voiceInputModeSelect.addEventListener('change', voiceInputModeChangeHandler);
  // Apply initial state based on loaded settings
  voiceInputModeChangeHandler();

  // Handle toggle API key visibility
  const toggleKeyHandler = () => {
    apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
  };
  toggleKeyBtn?.addEventListener('click', toggleKeyHandler);

  // Handle test connection
  const testHandler = async () => {
    if (!connectionStatus || !testBtn) return;

    testBtn.setAttribute('disabled', 'true');
    connectionStatus.textContent = 'Testing...';
    connectionStatus.className = 'connection-status testing';

    // Save current settings first (to test with them)
    const testSettings: LLMSettings = {
      enabled: enabledCheckbox.checked,
      refineTranscript: refineCheckbox.checked,
      confirmBeforeSend: confirmBeforeSendCheckbox.checked,
      speechLocale: speechLocaleSelect.value as SpeechLocale,
      voiceInputMode: voiceInputModeSelect.value as VoiceInputMode,
      provider: providerSelect.value as LLMProvider,
      model: modelSelect.value,
      apiKey: apiKeyInput.value,
    };

    try {
      await window.workstation.llmSaveSettings(testSettings);
      const result = await window.workstation.llmTestConnection();

      if (result.success) {
        connectionStatus.textContent = 'Connected!';
        connectionStatus.className = 'connection-status success';
      } else {
        connectionStatus.textContent = result.error || 'Failed';
        connectionStatus.className = 'connection-status error';
      }
    } catch (err) {
      connectionStatus.textContent = 'Error';
      connectionStatus.className = 'connection-status error';
    }

    testBtn.removeAttribute('disabled');
  };
  testBtn?.addEventListener('click', testHandler);

  // Handle form submit (save)
  const submitHandler = async (e: Event) => {
    e.preventDefault();

    const newSettings: LLMSettings = {
      enabled: enabledCheckbox.checked,
      refineTranscript: refineCheckbox.checked,
      confirmBeforeSend: confirmBeforeSendCheckbox.checked,
      speechLocale: speechLocaleSelect.value as SpeechLocale,
      voiceInputMode: voiceInputModeSelect.value as VoiceInputMode,
      provider: providerSelect.value as LLMProvider,
      model: modelSelect.value,
      apiKey: apiKeyInput.value,
    };

    try {
      const result = await window.workstation.llmSaveSettings(newSettings);
      if (result.success) {
        window.log.info('LLM settings saved');
        hideVoiceSettingsModal();
      } else {
        window.log.error('Failed to save LLM settings:', result.error);
        alert('Failed to save settings: ' + (result.error || 'Unknown error'));
      }
    } catch (err) {
      window.log.error('Failed to save LLM settings:', err);
      alert('Failed to save settings');
    }

    // Clean up handlers
    cleanup();
  };
  form.addEventListener('submit', submitHandler);

  // Handle cancel
  const cancelHandler = () => {
    hideVoiceSettingsModal();
    cleanup();
  };
  cancelBtn?.addEventListener('click', cancelHandler);

  // Handle escape key
  const escapeHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      hideVoiceSettingsModal();
      cleanup();
    }
  };
  document.addEventListener('keydown', escapeHandler);

  // Handle click outside
  const outsideClickHandler = (e: MouseEvent) => {
    if (e.target === modal) {
      hideVoiceSettingsModal();
      cleanup();
    }
  };
  modal.addEventListener('click', outsideClickHandler);

  // Cleanup function
  const cleanup = () => {
    providerSelect.removeEventListener('change', providerChangeHandler);
    toggleKeyBtn?.removeEventListener('click', toggleKeyHandler);
    testBtn?.removeEventListener('click', testHandler);
    form.removeEventListener('submit', submitHandler);
    cancelBtn?.removeEventListener('click', cancelHandler);
    document.removeEventListener('keydown', escapeHandler);
    modal.removeEventListener('click', outsideClickHandler);
  };
}

function hideVoiceSettingsModal(): void {
  const modal = document.getElementById('voice-settings-modal');
  modal?.classList.add('hidden');
}

function populateModels(
  select: HTMLSelectElement,
  models: ModelInfo[],
  selectedId?: string
): void {
  select.innerHTML = '';
  for (const model of models) {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = `${model.name} (${model.type})`;
    if (model.id === selectedId) {
      option.selected = true;
    }
    select.appendChild(option);
  }
}

function populateSpeechLocales(
  select: HTMLSelectElement,
  locales: SpeechLocaleInfo[],
  selectedId?: string
): void {
  select.innerHTML = '';
  for (const locale of locales) {
    const option = document.createElement('option');
    option.value = locale.id;
    option.textContent = locale.name;
    if (locale.id === selectedId) {
      option.selected = true;
    }
    select.appendChild(option);
  }
}

function updateApiKeyHint(hintEl: HTMLElement | null, provider: LLMProvider): void {
  if (!hintEl) return;

  const hints: Record<LLMProvider, string> = {
    anthropic: 'Get your key from console.anthropic.com',
    openai: 'Get your key from platform.openai.com/api-keys',
    google: 'Get your key from aistudio.google.com/apikey',
  };

  hintEl.textContent = hints[provider] || 'Enter your API key';
}

async function handleVoiceCommand(transcript: string, audioPath?: string): Promise<void> {
  if (!transcript.trim()) {
    window.log.info('Voice command: empty transcript, skipping');
    return;
  }

  window.log.info(`Voice command: "${transcript}", audioPath: ${audioPath || 'none'}`);

  const voiceStatusText = document.getElementById('voice-status-text');
  const voiceFinal = document.getElementById('voice-final');
  const voiceInterim = document.getElementById('voice-interim');

  // Get focused session ID
  let focusedSessionId: string | undefined;
  let focusedName: string = '';

  if (activeWorkerId) {
    const worker = workers.get(activeWorkerId);
    if (worker) {
      focusedSessionId = activeWorkerId;
      focusedName = worker.session.repo + (worker.session.taskId ? ` (${worker.session.taskId})` : '');
    }
  } else if (orchestratorState) {
    focusedSessionId = orchestratorState.session.id;
    focusedName = 'Manager';
  }

  // Check if LLM routing is available
  let useRouting = false;
  try {
    useRouting = await window.workstation.llmIsRoutingAvailable();
  } catch (err) {
    window.log.warn('Could not check LLM routing availability:', err);
  }

  let targetSessionId: string | undefined;
  let targetName: string = '';
  let routingInfo: string = '';

  if (useRouting) {
    // Use LLM-based routing
    if (voiceStatusText) {
      voiceStatusText.textContent = 'Routing...';
    }

    try {
      const result = await window.workstation.voiceRoute(transcript, focusedSessionId, audioPath);
      window.log.info('Voice routing result:', result);

      targetSessionId = result.targetSessionId;

      // Use refined transcript if available
      if (result.refinedTranscript) {
        window.log.info(`Using refined transcript: "${result.refinedTranscript}"`);
        transcript = result.refinedTranscript;
      }

      // Determine target name
      if (targetSessionId === orchestratorState?.session.id) {
        targetName = 'Manager';
      } else {
        const worker = workers.get(targetSessionId);
        if (worker) {
          targetName = worker.session.repo + (worker.session.taskId ? ` (${worker.session.taskId})` : '');
        } else {
          targetName = targetSessionId;
        }
      }

      // Add routing confidence to status
      if (result.usedLLM) {
        routingInfo = ` (${result.confidence})`;
      }
    } catch (err) {
      window.log.error('Voice routing failed:', err);
      // Fall back to focused session
      targetSessionId = focusedSessionId;
      targetName = focusedName;
    }
  } else {
    // Direct routing to focused session
    targetSessionId = focusedSessionId;
    targetName = focusedName;
  }

  if (targetSessionId && targetSessionId !== 'unknown') {
    // Bring target session to front if it's a hidden worker
    const targetWorker = workers.get(targetSessionId);
    if (targetWorker && targetWorker.gridPosition === undefined) {
      // Session is in overflow tabs - swap to grid
      window.log.info(`Voice routing: bringing hidden session ${targetSessionId} to front`);
      swapTabToGrid(targetSessionId);
    } else if (targetWorker) {
      // Session is in grid - just focus it
      focusWorker(targetSessionId);
    }

    // Send to target session's terminal
    window.workstation.writeToTerminal(targetSessionId, transcript);

    // Get confirmBeforeSend setting
    let confirmBeforeSend = false;
    try {
      const llmSettings = await window.workstation.llmGetSettings();
      confirmBeforeSend = llmSettings.confirmBeforeSend;
    } catch (err) {
      window.log.warn('Could not get confirmBeforeSend setting:', err);
    }

    // When LLM routing is enabled and confirmBeforeSend is false, auto-press Enter
    // (xterm/Claude needs text and Enter to be separate writes)
    // 150ms allows Claude input handler to fully process command text
    // See ISSUE-030: 50ms was occasionally insufficient
    const shouldAutoSend = useRouting && !confirmBeforeSend;
    if (shouldAutoSend) {
      setTimeout(() => {
        window.workstation.writeToTerminal(targetSessionId, '\r');
        window.log.info(`Sent Enter key for: "${transcript.substring(0, 30)}..."`);
      }, 150);
    }

    window.log.info(`Sent to ${targetName}: "${transcript}"${shouldAutoSend ? ' [auto-enter]' : ' [waiting for Enter]'}`);

    // Clear transcript display
    if (voiceFinal) voiceFinal.textContent = '';
    if (voiceInterim) voiceInterim.textContent = '';

    // Update voice bar to show where it was sent
    if (voiceStatusText) {
      if (shouldAutoSend) {
        voiceStatusText.textContent = `Sent to ${targetName}${routingInfo}`;
      } else {
        // When confirmBeforeSend is true, prompt user to press Enter
        voiceStatusText.textContent = `Typed in ${targetName} - press Enter to send`;
      }
      // Reset after 2 seconds (longer for confirm mode so user sees instruction)
      setTimeout(() => {
        voiceStatusText.textContent = 'Ctrl+V to speak';
      }, shouldAutoSend ? 2000 : 4000);
    }
  } else {
    window.log.warn('No session to send voice command');
    if (voiceStatusText) {
      voiceStatusText.textContent = 'No session available';
      setTimeout(() => {
        voiceStatusText.textContent = 'Ctrl+V to speak';
      }, 2000);
    }
  }
}

function setupVoiceKeyboardShortcuts(): void {
  // Ctrl+V: Toggle voice recording (Ctrl, not Cmd - Cmd+V is paste)
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && !e.metaKey && !e.shiftKey && e.key === 'v') {
      e.preventDefault();
      e.stopPropagation();

      // Toggle recording (same as clicking the button)
      const voiceBtn = document.getElementById('voice-btn');
      voiceBtn?.click();
    }
  });
}

// ============================================================================
// Scroll Position Preservation & ANSI Sequence Detection
// ============================================================================

// Debug flag - set to true to log ANSI sequences that may cause scroll issues
const DEBUG_SCROLL_SEQUENCES = false;

// Patterns that can cause scroll/viewport issues
const SCROLL_AFFECTING_PATTERNS = [
  { pattern: /\x1b\[2J/g, name: 'ED2 (Erase Display All)' },
  { pattern: /\x1b\[H/g, name: 'Cursor Home' },
  { pattern: /\x1b\[\?1049h/g, name: 'Alt Screen Buffer ON' },
  { pattern: /\x1b\[\?1049l/g, name: 'Alt Screen Buffer OFF' },
  { pattern: /\x1b\[\?47h/g, name: 'Alt Screen (legacy) ON' },
  { pattern: /\x1b\[\?47l/g, name: 'Alt Screen (legacy) OFF' },
  { pattern: /\x1b\[r/g, name: 'Reset Scroll Region' },
  { pattern: /\x1b\[\d*;\d*r/g, name: 'Set Scroll Region' },
];

// Track pending scroll-to-bottom per terminal (debounced)
const pendingScrollToBottom: Map<Terminal, number> = new Map();
const SCROLL_DEBOUNCE_MS = 150; // Wait for rapid writes to settle

function scheduleScrollToBottom(terminal: Terminal): void {
  // Clear any existing timeout for this terminal
  const existingTimeout = pendingScrollToBottom.get(terminal);
  if (existingTimeout) {
    clearTimeout(existingTimeout);
  }

  // Schedule new scroll-to-bottom
  const timeoutId = window.setTimeout(() => {
    pendingScrollToBottom.delete(terminal);
    terminal.scrollToBottom();
    if (DEBUG_SCROLL_SEQUENCES) {
      window.log.info('[SCROLL DEBUG] Debounced scrollToBottom executed');
    }
  }, SCROLL_DEBOUNCE_MS);

  pendingScrollToBottom.set(terminal, timeoutId);
}

function detectScrollAffectingSequences(data: string): string[] {
  const found: string[] = [];
  for (const { pattern, name } of SCROLL_AFFECTING_PATTERNS) {
    if (pattern.test(data)) {
      found.push(name);
      // Reset lastIndex since we're reusing the regex
      pattern.lastIndex = 0;
    }
  }
  return found;
}

function isTerminalAtBottom(terminal: Terminal): boolean {
  const buffer = terminal.buffer.active;
  // Check if viewport is at or near the bottom of the buffer
  // baseY is the top line of the viewport in the scrollback
  // buffer.length is total lines, terminal.rows is viewport height
  const maxBaseY = Math.max(0, buffer.length - terminal.rows);
  return buffer.baseY >= maxBaseY - 1; // Allow 1 line tolerance
}

function writeWithScrollPreservation(terminal: Terminal, data: string): void {
  const wasAtBottom = isTerminalAtBottom(terminal);
  const previousBaseY = terminal.buffer.active.baseY;
  const previousBufferLength = terminal.buffer.active.length;

  // Detect ED2 (Erase Display) - this often causes scroll-to-top issues
  const hasED2 = /\x1b\[2J/.test(data);

  // Debug: detect scroll-affecting sequences
  if (DEBUG_SCROLL_SEQUENCES) {
    const sequences = detectScrollAffectingSequences(data);
    if (sequences.length > 0) {
      window.log.warn(`[SCROLL DEBUG] Detected sequences: ${sequences.join(', ')} | wasAtBottom=${wasAtBottom} baseY=${previousBaseY} bufLen=${previousBufferLength}`);
    }
  }

  // FIX: If we detect ED2 and user was at bottom, schedule a debounced scroll-to-bottom
  // This handles rapid writes after ED2 that would otherwise leave us at top
  if (hasED2 && wasAtBottom && previousBaseY > 10) {
    if (DEBUG_SCROLL_SEQUENCES) {
      window.log.info(`[SCROLL DEBUG] ED2 detected while at bottom, scheduling debounced scrollToBottom`);
    }
    scheduleScrollToBottom(terminal);
  }

  // Write data with callback to handle scroll after write completes
  terminal.write(data, () => {
    const buffer = terminal.buffer.active;
    const newBaseY = buffer.baseY;
    const newBufferLength = buffer.length;

    // Debug: log significant scroll position changes
    if (DEBUG_SCROLL_SEQUENCES && Math.abs(newBaseY - previousBaseY) > 10) {
      window.log.warn(`[SCROLL DEBUG] Large scroll change: baseY ${previousBaseY} -> ${newBaseY} (delta: ${newBaseY - previousBaseY}) | bufLen ${previousBufferLength} -> ${newBufferLength}`);
    }

    if (!wasAtBottom) {
      // User was scrolled up - try to maintain their position
      const maxBaseY = Math.max(0, buffer.length - terminal.rows);

      // Calculate how much content was added
      const targetBaseY = Math.min(previousBaseY, maxBaseY);

      // Scroll back to approximately where user was
      if (buffer.baseY !== targetBaseY) {
        const linesToScroll = targetBaseY - buffer.baseY;
        terminal.scrollLines(linesToScroll);
      }
    }
    // If was at bottom, xterm naturally scrolls to show new content
    // (and if ED2 was detected, debounced scrollToBottom will handle it)
  });
}

// ============================================================================
// IPC Event Handlers
// ============================================================================

function setupIPCHandlers(): void {
  // Terminal data from PTY (with scroll preservation)
  window.workstation.onTerminalData((sessionId, data) => {
    // Check orchestrator
    if (orchestratorState?.session.id === sessionId) {
      writeWithScrollPreservation(orchestratorState.terminal, data);
      return;
    }
    // Check workers
    const worker = workers.get(sessionId);
    if (worker) {
      writeWithScrollPreservation(worker.terminal, data);
    }
  });

  // Session created
  window.workstation.onSessionCreated((session) => {
    window.log.info('Session created:', session.id, session.type);

    // Add type to session if missing (backward compat)
    if (!session.type) {
      session.type = 'worker';
    }

    if (session.type === 'orchestrator') {
      if (!orchestratorState) {
        createOrchestratorUI(session);
      }
    } else {
      if (!workers.has(session.id)) {
        createWorkerUI(session);
      }
    }
  });

  // Session closed
  window.workstation.onSessionClosed((sessionId) => {
    window.log.info('Session closed:', sessionId);

    if (orchestratorState?.session.id === sessionId) {
      // Orchestrator closed - shouldn't happen normally
      orchestratorState.terminal.dispose();
      orchestratorState = null;
    } else {
      removeWorkerUI(sessionId);
    }
  });

  // Plugin events
  window.workstation.onPluginEvent((event) => {
    window.log.info('Plugin event:', event);
  });

  // Window show - refresh all terminals (ISSUE-040: fix cursor position after window hide/show)
  window.workstation.onWindowShow(() => {
    window.log.info('Window shown, refreshing terminals');

    // Refresh orchestrator
    if (orchestratorState) {
      orchestratorState.fitAddon.fit();
      orchestratorState.terminal.refresh(0, orchestratorState.terminal.rows - 1);
    }

    // Refresh all workers
    for (const [sessionId, state] of workers) {
      state.fitAddon.fit();
      state.terminal.refresh(0, state.terminal.rows - 1);
      window.log.info(`Refreshed worker terminal: ${sessionId}`);
    }
  });
}

// ============================================================================
// Grid Drag-to-Swap Setup (ISSUE-038)
// ============================================================================

function setupGridDropZones(): void {
  // Set up all 4 grid cells as drop targets
  for (let pos = 0; pos < 4; pos++) {
    const cell = getGridCell(pos);
    if (cell) {
      setupCellDropZone(cell, pos);
    }
  }

  // Set up tabs area as drop target (to move session to overflow)
  if (workersTabs) {
    workersTabs.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes(SESSION_DRAG_TYPE)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        workersTabs.classList.add('drop-target');
      }
    });

    workersTabs.addEventListener('dragleave', (e) => {
      if (!workersTabs.contains(e.relatedTarget as Node)) {
        workersTabs.classList.remove('drop-target');
      }
    });

    workersTabs.addEventListener('drop', (e) => {
      workersTabs.classList.remove('drop-target');

      const draggedSessionId = e.dataTransfer?.getData(SESSION_DRAG_TYPE);
      if (!draggedSessionId) return;

      e.preventDefault();

      const state = workers.get(draggedSessionId);
      if (!state) return;

      // Only move to tabs if currently in grid
      if (state.gridPosition !== undefined) {
        window.log.info(`Drop to tabs: moving ${draggedSessionId} from grid to overflow`);
        moveWorkerToTabs(draggedSessionId);
        updateWorkerCellStates();
      }
    });
  }

  window.log.info('Grid drop zones initialized');
}

// ============================================================================
// Event Listeners
// ============================================================================

function setupEventListeners(): void {
  newWorkerBtn?.addEventListener('click', showNewWorkerModal);
  cancelBtn?.addEventListener('click', hideNewWorkerModal);
  newWorkerForm?.addEventListener('submit', handleNewWorker);

  // Browse folder button
  const browseFolderBtn = document.getElementById('browse-folder-btn');
  browseFolderBtn?.addEventListener('click', async () => {
    const folderPath = await window.workstation.browseFolder();
    if (folderPath && workerPathInput) {
      workerPathInput.value = folderPath;
      // Auto-fill name from folder name if empty
      if (workerNameInput && !workerNameInput.value) {
        workerNameInput.value = folderPath.split('/').filter(Boolean).pop() || '';
      }
    }
  });

  modal?.addEventListener('click', (e) => {
    if (e.target === modal) hideNewWorkerModal();
  });
}

// ============================================================================
// Initialization
// ============================================================================

async function init(): Promise<void> {
  window.log.info('Renderer initializing (split-pane layout)...');

  setupIPCHandlers();
  setupEventListeners();
  setupKeyboardShortcuts();
  setupResizeHandler();
  setupLayoutSelector();
  setupThemeSelector();
  setupSkipPermissionsToggle();
  setupDividerResize();
  setupGridDividerResize();
  setupRowDividerResize();
  setupGridDropZones();
  setupVoiceCapture();
  setupVoiceKeyboardShortcuts();

  // Load existing sessions
  try {
    const sessions = await window.workstation.getSessions();
    window.log.info('Loaded sessions:', sessions.length);

    for (const session of sessions) {
      if (session.isExternal) continue;

      if (session.type === 'orchestrator') {
        createOrchestratorUI(session);
      } else {
        createWorkerUI(session);
      }
    }
  } catch (err) {
    window.log.error('Failed to load sessions:', err);
  }

  // If no orchestrator exists, request one
  if (!orchestratorState) {
    window.log.info('No orchestrator found, creating one...');
    try {
      await window.workstation.createSession(
        'orchestrator',
        '~',
        'orchestrator'
      );
    } catch (err) {
      window.log.error('Failed to create orchestrator:', err);
    }
  }

  window.log.info('Renderer initialized');
}

// Start
init();
