/**
 * Preload Script for Varie Workstation
 *
 * Exposes safe IPC methods to the renderer process.
 * Uses contextBridge for security.
 */

import { contextBridge, ipcRenderer } from 'electron';

// Types for the exposed API
export type SessionType = 'orchestrator' | 'worker';

export interface SessionInfo {
  id: string;
  repo: string;
  repoPath: string;
  taskId?: string;
  type: SessionType;
  isExternal: boolean;
  createdAt: string;
  lastActive: string;
}

// Voice event types
export interface VoiceEvent {
  type: 'status' | 'interim' | 'final' | 'error' | 'end' | 'available' | 'progress' | 'models';
  status?: string;
  transcript?: string;
  confidence?: number;
  message?: string;
  available?: boolean;
  audioPath?: string;
  progress?: number;
  model?: string;
}

// LLM types
export type LLMProvider = 'anthropic' | 'openai' | 'google';
export type SpeechLocale = 'auto' | 'en-US' | 'zh-CN' | 'zh-TW' | 'ja-JP' | 'ko-KR' | 'es-ES' | 'fr-FR' | 'de-DE';
export type SpeechEngine = 'apple-speech' | 'whisperkit';
export type VoiceRoutingMode = 'focused' | 'manager' | 'smart';

export interface LLMSettings {
  provider: LLMProvider;
  model: string;
  apiKey: string;
  voiceRoutingMode: VoiceRoutingMode;
  refineTranscript: boolean;
  speechLocale: SpeechLocale;
  speechEngine: SpeechEngine;
  directAudioRouting: boolean;
  whisperKitModel: string;
  confirmBeforeSend: boolean;
}

export interface WhisperKitModelsInfo {
  available: string[];
  downloaded: string[];
  default: string;
  supported: string[];
}

export interface ModelInfo {
  id: string;
  name: string;
  type: 'fast' | 'balanced' | 'flagship';
}

export interface SpeechLocaleInfo {
  id: SpeechLocale;
  name: string;
}

export interface WorkstationAPI {
  // Session management
  createSession: (repo: string, repoPath: string, type: SessionType, taskId?: string, claudeFlags?: string) => Promise<string>;
  closeSession: (sessionId: string) => Promise<boolean>;
  getSessions: () => Promise<SessionInfo[]>;
  focusSession: (sessionId: string) => void;

  // Terminal I/O
  writeToTerminal: (sessionId: string, data: string) => void;
  resizeTerminal: (sessionId: string, cols: number, rows: number) => void;

  // Events from main process
  onTerminalData: (callback: (sessionId: string, data: string) => void) => void;
  onSessionCreated: (callback: (session: SessionInfo) => void) => void;
  onSessionClosed: (callback: (sessionId: string) => void) => void;
  onSessionUpdated: (callback: (session: SessionInfo) => void) => void;
  onPluginEvent: (callback: (event: unknown) => void) => void;
  onWindowShow: (callback: () => void) => void;

  // Voice capture
  voiceCheck: () => Promise<boolean>;
  voiceStart: () => void;
  voiceStop: () => void;
  voiceCancel: () => void;
  onVoiceEvent: (callback: (event: VoiceEvent) => void) => void;

  // WhisperKit model management
  whisperKitCheck: () => Promise<boolean>;
  whisperKitListModels: () => Promise<WhisperKitModelsInfo>;
  whisperKitDownloadModel: (modelName: string) => Promise<{ success: boolean; error?: string }>;

  // LLM settings
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

  // Config
  getSkipPermissions: () => Promise<boolean>;
  setSkipPermissions: (enabled: boolean) => Promise<boolean>;

  // App control
  quit: () => void;
}

// Expose the API to the renderer
contextBridge.exposeInMainWorld('workstation', {
  // Session management
  createSession: (repo: string, repoPath: string, type: SessionType, taskId?: string, claudeFlags?: string) =>
    ipcRenderer.invoke('session:create', { repo, repoPath, type, taskId, claudeFlags }),

  closeSession: (sessionId: string) =>
    ipcRenderer.invoke('session:close', { sessionId }),

  browseFolder: () => ipcRenderer.invoke('dialog:openFolder') as Promise<string | null>,

  getSessions: () => ipcRenderer.invoke('session:list'),

  focusSession: (sessionId: string) =>
    ipcRenderer.send('session:focus', { sessionId }),

  // Terminal I/O
  writeToTerminal: (sessionId: string, data: string) =>
    ipcRenderer.send('terminal:write', { sessionId, data }),

  resizeTerminal: (sessionId: string, cols: number, rows: number) =>
    ipcRenderer.send('terminal:resize', { sessionId, cols, rows }),

  // Events from main process
  onTerminalData: (callback: (sessionId: string, data: string) => void) => {
    ipcRenderer.on('terminal:data', (_event, sessionId: string, data: string) => {
      callback(sessionId, data);
    });
  },

  onSessionCreated: (callback: (session: SessionInfo) => void) => {
    ipcRenderer.on('session:created', (_event, session: SessionInfo) => {
      callback(session);
    });
  },

  onSessionClosed: (callback: (sessionId: string) => void) => {
    ipcRenderer.on('session:closed', (_event, sessionId: string) => {
      callback(sessionId);
    });
  },

  onSessionUpdated: (callback: (session: SessionInfo) => void) => {
    ipcRenderer.on('session:updated', (_event, session: SessionInfo) => {
      callback(session);
    });
  },

  onPluginEvent: (callback: (event: unknown) => void) => {
    ipcRenderer.on('plugin:event', (_event, pluginEvent: unknown) => {
      callback(pluginEvent);
    });
  },

  // Window visibility (ISSUE-040)
  onWindowShow: (callback: () => void) => {
    ipcRenderer.on('window:show', () => {
      callback();
    });
  },

  // Voice capture
  voiceCheck: () => ipcRenderer.invoke('voice:check'),

  voiceStart: () => ipcRenderer.send('voice:start'),

  voiceStop: () => ipcRenderer.send('voice:stop'),

  voiceCancel: () => ipcRenderer.send('voice:cancel'),

  onVoiceEvent: (callback: (event: unknown) => void) => {
    ipcRenderer.on('voice:event', (_event, voiceEvent: unknown) => {
      callback(voiceEvent);
    });
  },

  // WhisperKit model management
  whisperKitCheck: () => ipcRenderer.invoke('whisperkit:check'),

  whisperKitListModels: () => ipcRenderer.invoke('whisperkit:listModels'),

  whisperKitDownloadModel: (modelName: string) =>
    ipcRenderer.invoke('whisperkit:downloadModel', modelName),

  // LLM settings
  llmGetSettings: () => ipcRenderer.invoke('llm:getSettings'),

  llmSaveSettings: (settings: LLMSettings) =>
    ipcRenderer.invoke('llm:saveSettings', settings),

  llmTestConnection: () => ipcRenderer.invoke('llm:testConnection'),

  llmGetProviders: () => ipcRenderer.invoke('llm:getProviders'),

  llmGetSpeechLocales: () => ipcRenderer.invoke('llm:getSpeechLocales'),

  llmIsRoutingAvailable: () => ipcRenderer.invoke('llm:isRoutingAvailable'),

  // Voice routing
  voiceRoute: (voiceInput: string, focusedSessionId?: string, audioPath?: string) =>
    ipcRenderer.invoke('voice:route', { voiceInput, focusedSessionId, audioPath }),

  // Config
  getSkipPermissions: () => ipcRenderer.invoke('config:getSkipPermissions'),
  setSkipPermissions: (enabled: boolean) => ipcRenderer.invoke('config:setSkipPermissions', enabled),

  // App control
  quit: () => ipcRenderer.send('app:quit'),
} as WorkstationAPI);

// Also expose for renderer logging
contextBridge.exposeInMainWorld('log', {
  info: (...args: unknown[]) => ipcRenderer.send('log', 'INFO', ...args),
  warn: (...args: unknown[]) => ipcRenderer.send('log', 'WARN', ...args),
  error: (...args: unknown[]) => ipcRenderer.send('log', 'ERROR', ...args),
});
