/**
 * Varie Workstation - Main Process Entry Point
 *
 * Electron main process that manages:
 * - Application window
 * - Terminal sessions (via node-pty)
 * - Socket server for plugin communication
 * - Checkpoint persistence
 * - IPC communication with renderer
 */

import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import * as path from 'path';
import * as os from 'os';

import { initLogger, log } from './logger';
import { SocketServer, PluginEvent } from './socket-server';
import { SessionManager, TerminalSession } from './session-manager';
import { CheckpointStore } from './checkpoint-store';
import { Dispatcher } from './dispatcher';
import { initManagerWorkspace, syncDiscoveredRepos } from './manager-workspace';
import { getClaudeFlags, getSkipPermissions, setSkipPermissions, getMarketplacePluginInstall } from './config';
import * as fs from 'fs';
import * as managerState from './manager-state';
import { NativeVoiceCapture, VoiceEvent } from './voice-native';
import {
  loadLLMSettings,
  saveLLMSettings,
  testLLMConnection,
  routeVoiceCommand,
  isLLMRoutingAvailable,
  PROVIDER_MODELS,
  SPEECH_LOCALES,
  LLMSettings,
  SessionSummary,
} from './llm';

// Handle EPIPE errors globally - occurs when launching terminal closes
// This prevents the "A JavaScript error occurred in the main process" dialog
process.on('uncaughtException', (error) => {
  if ((error as NodeJS.ErrnoException).code === 'EPIPE') {
    // Silently ignore EPIPE - stdout/stderr pipe closed
    return;
  }
  log('ERROR', 'Uncaught exception:', error);
  // Re-throw other errors in development
  if (process.env.NODE_ENV === 'development') {
    throw error;
  }
});

process.stdout?.on?.('error', (err) => {
  if ((err as NodeJS.ErrnoException).code === 'EPIPE') return;
});

process.stderr?.on?.('error', (err) => {
  if ((err as NodeJS.ErrnoException).code === 'EPIPE') return;
});

// Global state
let mainWindow: BrowserWindow | null = null;
let socketServer: SocketServer | null = null;
let sessionManager: SessionManager | null = null;
let checkpointStore: CheckpointStore | null = null;
let dispatcher: Dispatcher | null = null;
let voiceCapture: NativeVoiceCapture | null = null;
let isQuitting = false;  // Track if app is quitting (vs just hiding window)

// ============================================================================
// Window Management
// ============================================================================

function createWindow(): void {
  log('INFO', 'Creating main window...');

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Workstation',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    // Show immediately (like test-minimal-app) - avoids xterm dimension issues
    show: true,
  });

  // Load renderer
  const htmlPath = path.join(__dirname, '../renderer/index.html');
  log('INFO', 'Loading HTML:', htmlPath);
  mainWindow.loadFile(htmlPath);

  mainWindow.once('ready-to-show', () => {
    log('INFO', 'Window ready');
  });

  // Log renderer events
  mainWindow.webContents.on('did-finish-load', () => {
    log('INFO', 'Renderer: did-finish-load');
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    log('ERROR', 'Renderer: did-fail-load', errorCode, errorDescription);
  });

  mainWindow.webContents.on('console-message', (_event, level, message) => {
    const levelStr = ['DEBUG', 'INFO', 'WARN', 'ERROR'][level] || 'LOG';
    log(`RENDERER:${levelStr}`, message);
  });

  // On macOS, hide window instead of destroying it (ISSUE-040)
  // This keeps PTYs alive and preserves terminal state
  // But allow actual quit when user quits from dock or menu
  mainWindow.on('close', (event) => {
    if (process.platform === 'darwin' && !isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
      log('INFO', 'Window hidden (macOS close behavior)');
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Refresh terminals when window is shown again
  mainWindow.on('show', () => {
    log('INFO', 'Window shown, refreshing terminals');
    mainWindow?.webContents.send('window:show');
  });

  // Open DevTools in development
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }
}

// ============================================================================
// Bundled Plugin
// ============================================================================

/**
 * Resolve the path to the bundled plugin directory.
 * In dev: <project-root>/plugin
 * In production: <app>/Contents/Resources/plugin (via extraResources)
 */
function resolveBundledPluginPath(): string | null {
  let pluginPath: string;
  if (app.isPackaged) {
    pluginPath = path.join(process.resourcesPath, 'plugin');
  } else {
    pluginPath = path.join(app.getAppPath(), 'plugin');
  }

  // Verify the plugin directory exists and has a plugin.json
  const pluginJson = path.join(pluginPath, '.claude-plugin', 'plugin.json');
  if (fs.existsSync(pluginJson)) {
    log('INFO', `Bundled plugin found: ${pluginPath} (packaged=${app.isPackaged})`);
    return pluginPath;
  }

  log('WARN', `Bundled plugin not found at ${pluginPath}`);
  return null;
}

// ============================================================================
// Service Initialization
// ============================================================================

function initServices(): void {
  log('INFO', 'Initializing services...');

  // Initialize Manager workspace (~/.varie/manager/)
  initManagerWorkspace();

  // Load Manager state (clear stale sessions - they don't survive daemon restart)
  managerState.loadState();
  managerState.clearSessions();
  managerState.startAutoSave();

  // Initialize checkpoint store
  checkpointStore = new CheckpointStore();

  // Initialize session manager
  sessionManager = new SessionManager(
    // Terminal data callback -> forward to renderer
    (sessionId, data) => {
      mainWindow?.webContents.send('terminal:data', sessionId, data);
    },
    // Session event callback -> forward to renderer + update state
    (event, sessionId, session) => {
      const sessionInfo = session ? sessionToInfo(session) : undefined;

      switch (event) {
        case 'created':
          mainWindow?.webContents.send('session:created', sessionInfo);
          // Track in Manager state
          if (session) {
            managerState.updateSession({
              sessionId: session.id,
              repo: session.repo,
              repoPath: session.repoPath,
              tabIndex: 0, // Will be updated by renderer
              type: session.type,
              taskId: session.taskId,
              status: 'active',
              createdAt: session.createdAt.toISOString(),
              lastActive: session.lastActive.toISOString(),
            });
          }
          break;
        case 'closed':
          mainWindow?.webContents.send('session:closed', sessionId);
          managerState.removeSession(sessionId);
          break;
        case 'updated':
          mainWindow?.webContents.send('session:updated', sessionInfo);
          break;
      }
    }
  );

  // Resolve bundled plugin path and inject into session manager
  const bundledPluginPath = resolveBundledPluginPath();
  if (bundledPluginPath) {
    sessionManager.setBundledPluginPath(bundledPluginPath);
    const marketplaceInstall = getMarketplacePluginInstall();
    if (marketplaceInstall) {
      log('INFO', `Plugin also installed via marketplace: ${marketplaceInstall.key} at ${marketplaceInstall.installPath}`);
    }
  }

  // Initialize dispatcher
  dispatcher = new Dispatcher(sessionManager);

  // Sync discovered repos to projects.yaml for skills to access
  const discoveredRepos = dispatcher.getDiscoveredRepos();
  syncDiscoveredRepos(discoveredRepos);

  // Initialize socket server
  socketServer = new SocketServer((event: PluginEvent) => {
    handlePluginEvent(event);
  });

  // Set dispatch handler for orchestrator commands
  socketServer.setDispatchHandler((event) => dispatcher!.handleCommand(event));

  socketServer.start();

  log('INFO', 'Services initialized');
}

function sessionToInfo(session: TerminalSession): object {
  return {
    id: session.id,
    repo: session.repo,
    repoPath: session.repoPath,
    taskId: session.taskId,
    type: session.type,
    isExternal: session.isExternal,
    createdAt: session.createdAt.toISOString(),
    lastActive: session.lastActive.toISOString(),
  };
}

// ============================================================================
// Plugin Event Handling
// ============================================================================

function handlePluginEvent(event: PluginEvent): void {
  log('INFO', 'Handling plugin event:', event.type);

  switch (event.type) {
    case 'session_start':
      // Register external session if not already tracked
      if (event.context) {
        sessionManager?.registerExternalSession(
          event.sessionId,
          event.context.project,
          event.context.projectPath,
          event.context.taskId
        );
      }
      break;

    case 'session_end':
      sessionManager?.removeExternalSession(event.sessionId);
      break;

    case 'checkpoint':
      // Save checkpoint data
      if (event.payload?.checkpoint) {
        log('INFO', 'Saving checkpoint for session:', event.sessionId);
        // The checkpoint data comes from the plugin
        // We could save it directly or merge with our state
      }
      break;

    case 'attention_needed':
    case 'question':
      // Forward to renderer for UI notification
      mainWindow?.webContents.send('plugin:event', event);
      // Could also trigger system notification
      break;

    default:
      // Forward other events to renderer
      mainWindow?.webContents.send('plugin:event', event);
  }
}

// ============================================================================
// IPC Handlers
// ============================================================================

function setupIpcHandlers(): void {
  log('INFO', 'Setting up IPC handlers...');

  // Create session
  ipcMain.handle('session:create', async (_event, { repo, repoPath, type, taskId, claudeFlags }) => {
    // Resolve ~ to home directory (renderer can't access os.homedir)
    const resolvedPath = repoPath?.replace(/^~/, os.homedir()) || os.homedir();
    log('INFO', 'IPC: session:create', repo, resolvedPath, type);
    // Use per-session override if provided, otherwise read from config
    const flags = claudeFlags || getClaudeFlags();
    const sessionId = sessionManager?.createSession(repo, resolvedPath, type || 'worker', taskId, flags || undefined);
    return sessionId;
  });

  // Browse for folder (native dialog)
  ipcMain.handle('dialog:openFolder', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      defaultPath: os.homedir(),
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // Close session
  ipcMain.handle('session:close', async (_event, { sessionId }) => {
    log('INFO', 'IPC: session:close', sessionId);
    return sessionManager?.closeSession(sessionId);
  });

  // List sessions
  ipcMain.handle('session:list', async () => {
    const sessions = sessionManager?.getAllSessions() || [];
    return sessions.map(sessionToInfo);
  });

  // Focus session (no response needed)
  ipcMain.on('session:focus', (_event, { sessionId }) => {
    log('INFO', 'IPC: session:focus', sessionId);
    // Could track focused session for dispatch purposes
  });

  // Write to terminal
  ipcMain.on('terminal:write', (_event, { sessionId, data }) => {
    sessionManager?.write(sessionId, data);
  });

  // Resize terminal
  ipcMain.on('terminal:resize', (_event, { sessionId, cols, rows }) => {
    sessionManager?.resize(sessionId, cols, rows);
  });

  // Config: skipPermissions toggle
  ipcMain.handle('config:getSkipPermissions', async () => {
    return getSkipPermissions();
  });

  ipcMain.handle('config:setSkipPermissions', async (_event, enabled: boolean) => {
    log('INFO', `IPC: config:setSkipPermissions ${enabled}`);
    setSkipPermissions(enabled);
    return enabled;
  });

  // Quit app
  ipcMain.on('app:quit', () => {
    log('INFO', 'IPC: app:quit');
    app.quit();
  });

  // Renderer logging
  ipcMain.on('log', (_event, level: string, ...args: unknown[]) => {
    log(`RENDERER:${level}`, ...args);
  });

  // Voice capture handlers
  let voiceEventUnsubscribe: (() => void) | null = null;

  ipcMain.handle('voice:check', async () => {
    if (!voiceCapture) {
      voiceCapture = new NativeVoiceCapture();
      // Set up event forwarding to renderer (once)
      voiceEventUnsubscribe = voiceCapture.onEvent((event: VoiceEvent) => {
        log('INFO', 'Forwarding voice event to renderer:', event.type);
        mainWindow?.webContents.send('voice:event', event);
      });
    }
    return voiceCapture.checkAvailability();
  });

  ipcMain.on('voice:start', () => {
    log('INFO', 'IPC: voice:start');
    if (!voiceCapture) {
      voiceCapture = new NativeVoiceCapture();
      // Set up event forwarding to renderer (once)
      voiceEventUnsubscribe = voiceCapture.onEvent((event: VoiceEvent) => {
        log('INFO', 'Forwarding voice event to renderer:', event.type);
        mainWindow?.webContents.send('voice:event', event);
      });
    }

    // Build start options from LLM settings
    const settings = loadLLMSettings();
    voiceCapture.start({
      speechEngine: settings.speechEngine,
      locale: settings.speechLocale,
      directAudioRouting: settings.directAudioRouting,
      whisperKitModel: settings.whisperKitModel,
    });
  });

  ipcMain.on('voice:stop', () => {
    log('INFO', 'IPC: voice:stop');
    voiceCapture?.stop();
  });

  ipcMain.on('voice:cancel', () => {
    log('INFO', 'IPC: voice:cancel');
    voiceCapture?.cancel();
  });

  // WhisperKit model management handlers
  ipcMain.handle('whisperkit:check', async () => {
    log('INFO', 'IPC: whisperkit:check');
    if (!voiceCapture) {
      voiceCapture = new NativeVoiceCapture();
      voiceEventUnsubscribe = voiceCapture.onEvent((event: VoiceEvent) => {
        mainWindow?.webContents.send('voice:event', event);
      });
    }
    return voiceCapture.checkAvailability('whisperkit');
  });

  ipcMain.handle('whisperkit:listModels', async () => {
    log('INFO', 'IPC: whisperkit:listModels');
    if (!voiceCapture) {
      voiceCapture = new NativeVoiceCapture();
      voiceEventUnsubscribe = voiceCapture.onEvent((event: VoiceEvent) => {
        mainWindow?.webContents.send('voice:event', event);
      });
    }
    try {
      return await voiceCapture.whisperKitListModels();
    } catch (err) {
      log('ERROR', 'whisperkit:listModels failed:', err);
      return { available: [], downloaded: [], default: 'base', supported: [] };
    }
  });

  ipcMain.handle('whisperkit:downloadModel', async (_event, modelName: string) => {
    log('INFO', 'IPC: whisperkit:downloadModel', modelName);
    if (!voiceCapture) {
      voiceCapture = new NativeVoiceCapture();
      voiceEventUnsubscribe = voiceCapture.onEvent((event: VoiceEvent) => {
        mainWindow?.webContents.send('voice:event', event);
      });
    }
    try {
      const success = await voiceCapture.whisperKitDownloadModel(modelName);
      return { success };
    } catch (err) {
      log('ERROR', 'whisperkit:downloadModel failed:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  // LLM settings handlers
  ipcMain.handle('llm:getSettings', async () => {
    log('INFO', 'IPC: llm:getSettings');
    return loadLLMSettings();
  });

  ipcMain.handle('llm:saveSettings', async (_event, settings: LLMSettings) => {
    log('INFO', 'IPC: llm:saveSettings');
    try {
      saveLLMSettings(settings);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('llm:testConnection', async () => {
    log('INFO', 'IPC: llm:testConnection');
    return testLLMConnection();
  });

  ipcMain.handle('llm:getProviders', async () => {
    log('INFO', 'IPC: llm:getProviders');
    return PROVIDER_MODELS;
  });

  ipcMain.handle('llm:getSpeechLocales', async () => {
    log('INFO', 'IPC: llm:getSpeechLocales');
    return SPEECH_LOCALES;
  });

  ipcMain.handle('llm:isRoutingAvailable', async () => {
    return isLLMRoutingAvailable();
  });

  // Voice routing - assembles context from sessions and calls LLM router
  ipcMain.handle('voice:route', async (_event, { voiceInput, focusedSessionId, audioPath }) => {
    log('INFO', 'IPC: voice:route', { voiceInput, focusedSessionId, audioPath: audioPath ? 'provided' : 'none' });

    // Build session summaries from session manager
    const allSessions = sessionManager?.getAllSessions() || [];
    const sessions: SessionSummary[] = allSessions.map((s) => ({
      id: s.id,
      repo: s.repo,
      taskId: s.taskId,
      status: 'active' as const, // TODO: track actual activity status
      lastActivity: s.taskId ? `Working on ${s.taskId}` : undefined,
      workDescription: sessionManager?.getRecentOutput(s.id),
    }));

    // Find manager session ID
    const managerSession = allSessions.find((s) => s.type === 'orchestrator');
    const managerSessionId = managerSession?.id;

    // Get settings for refineTranscript
    const llmSettings = loadLLMSettings();

    try {
      const result = await routeVoiceCommand({
        voiceInput,
        sessions,
        focusedSessionId,
        managerSessionId,
        refineTranscript: llmSettings.refineTranscript,
        audioPath: llmSettings.directAudioRouting ? audioPath : undefined,
      });

      log('INFO', 'Voice routing result:', result);
      return result;
    } catch (err) {
      log('ERROR', 'Voice routing failed:', err);
      // Fall back to focused session
      return {
        targetSessionId: focusedSessionId || managerSessionId || 'unknown',
        confidence: 'direct',
        reasoning: 'Routing failed, using focused session',
        usedLLM: false,
      };
    }
  });

  log('INFO', 'IPC handlers set up');
}

// ============================================================================
// Application Lifecycle
// ============================================================================

app.whenReady().then(() => {
  initLogger();
  log('INFO', 'App ready');

  setupIpcHandlers();
  initServices();
  createWindow();

  app.on('activate', () => {
    // On macOS, show hidden window or create new one
    if (mainWindow) {
      mainWindow.show();
      log('INFO', 'Showing hidden window on activate');
    } else if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  log('INFO', 'All windows closed');

  // On macOS, keep services running - user may reopen window from dock
  // Cleanup happens in before-quit instead
  if (process.platform !== 'darwin') {
    managerState.stopAutoSave();
    managerState.saveState();
    sessionManager?.closeAllSessions();
    socketServer?.stop();
    app.quit();
  }
});

app.on('before-quit', () => {
  log('INFO', 'App before-quit');
  isQuitting = true;  // Allow window to actually close
  managerState.stopAutoSave();
  managerState.saveState();
  sessionManager?.closeAllSessions();
  socketServer?.stop();
});

// Handle single instance - skip in development for easier testing
// Use --allow-multiple flag to force multiple instances (for debugging packaged builds)
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
const allowMultiple = process.argv.includes('--allow-multiple');

if (!isDev && !allowMultiple) {
  const gotTheLock = app.requestSingleInstanceLock();
  if (!gotTheLock) {
    // Exit immediately without showing any UI
    // Use process.exit() to avoid any Electron cleanup that might show dialogs
    process.exit(0);
  } else {
    app.on('second-instance', () => {
      // Someone tried to run a second instance, focus our window
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });
  }
}
