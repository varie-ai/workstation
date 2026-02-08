/**
 * Native macOS Voice Capture
 *
 * Spawns native Swift CLI tools for speech-to-text.
 * Supports two engines:
 *   - apple-speech: Real-time streaming via Apple Speech framework
 *   - whisperkit: Batch mode via WhisperKit (Whisper on Apple Silicon)
 *
 * Both communicate via JSON lines over stdout with the same event protocol.
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { app } from 'electron';
import { log } from './logger';
import { SpeechEngine } from './llm/types';

export type VoiceStatus = 'idle' | 'listening' | 'recording' | 'processing' | 'downloading' | 'loading' | 'buffering' | 'transcribing' | 'error';

export interface VoiceEvent {
  type: 'status' | 'interim' | 'final' | 'error' | 'end' | 'available' | 'progress' | 'models';
  status?: VoiceStatus;
  transcript?: string;
  confidence?: number;
  message?: string;
  available?: boolean;
  audioPath?: string;
  // WhisperKit-specific
  progress?: number;   // 0-1 download progress
  model?: string;      // model name for status context
  // Model list (from --list-models)
  models?: WhisperKitModelsInfo;
}

export interface WhisperKitModelsInfo {
  available: string[];
  downloaded: string[];
  default: string;
  supported: string[];
}

export interface VoiceStartOptions {
  speechEngine: SpeechEngine;
  locale: string;
  directAudioRouting: boolean;
  whisperKitModel?: string;
}

type VoiceEventCallback = (event: VoiceEvent) => void;

const WHISPERKIT_MODELS_DIR = path.join(os.homedir(), '.varie', 'models', 'whisperkit');

/**
 * NativeVoiceCapture - Manages the native speech recognition process
 *
 * Supports multiple speech engines. Binary is resolved per-start() call
 * so users can switch engines between recordings without recreating the instance.
 */
export class NativeVoiceCapture {
  private process: ChildProcess | null = null;
  private callbacks: VoiceEventCallback[] = [];
  private currentAudioPath: string | null = null;

  /**
   * Resolve binary path for a given speech engine.
   * Dev paths differ because whisperkit-recognizer is a Swift Package with .build/.
   */
  private resolveBinaryPath(engine: SpeechEngine): string {
    if (engine === 'whisperkit') {
      if (app.isPackaged) {
        return path.join(process.resourcesPath, 'native', 'macos', 'whisperkit-recognizer');
      } else {
        return path.join(app.getAppPath(), 'native', 'macos', 'whisperkit-recognizer', '.build', 'release', 'whisperkit-recognizer');
      }
    } else {
      if (app.isPackaged) {
        return path.join(process.resourcesPath, 'native', 'macos', 'speech-recognizer');
      } else {
        return path.join(app.getAppPath(), 'native', 'macos', 'speech-recognizer');
      }
    }
  }

  /**
   * Get the current audio file path (if recording was enabled)
   */
  getAudioPath(): string | null {
    return this.currentAudioPath;
  }

  /**
   * Generate a unique temp file path for audio in a private directory
   */
  private generateAudioPath(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    const voiceTmpDir = path.join(os.homedir(), '.varie', 'tmp');
    if (!fs.existsSync(voiceTmpDir)) {
      fs.mkdirSync(voiceTmpDir, { recursive: true, mode: 0o700 });
    }
    return path.join(voiceTmpDir, `varie-voice-${timestamp}-${random}.wav`);
  }

  /**
   * Clean up current audio file
   */
  cleanupAudioFile(): void {
    if (this.currentAudioPath && fs.existsSync(this.currentAudioPath)) {
      try {
        fs.unlinkSync(this.currentAudioPath);
        log('INFO', 'Cleaned up audio file:', this.currentAudioPath);
      } catch (err) {
        log('WARN', 'Failed to clean up audio file:', err);
      }
    }
    this.currentAudioPath = null;
  }

  /**
   * Clean up all old varie-voice audio files from temp directory
   * Called periodically to prevent temp directory spam
   * Removes files older than maxAgeMs (default 5 minutes)
   */
  cleanupOldAudioFiles(maxAgeMs: number = 5 * 60 * 1000): void {
    const voiceTmpDir = path.join(os.homedir(), '.varie', 'tmp');
    if (!fs.existsSync(voiceTmpDir)) return;
    const now = Date.now();
    let cleaned = 0;

    try {
      const files = fs.readdirSync(voiceTmpDir);
      for (const file of files) {
        if (file.startsWith('varie-voice-') && file.endsWith('.wav')) {
          const filePath = path.join(voiceTmpDir, file);
          try {
            const stat = fs.statSync(filePath);
            const age = now - stat.mtimeMs;
            if (age > maxAgeMs) {
              fs.unlinkSync(filePath);
              cleaned++;
            }
          } catch {
            // Ignore errors for individual files
          }
        }
      }
      if (cleaned > 0) {
        log('INFO', `Cleaned up ${cleaned} old audio files`);
      }
    } catch (err) {
      log('WARN', 'Failed to clean up old audio files:', err);
    }
  }

  /**
   * Check if native speech recognition is available.
   * Checks the specified engine (defaults to apple-speech for basic availability).
   */
  async checkAvailability(engine: SpeechEngine = 'apple-speech'): Promise<boolean> {
    const binaryPath = this.resolveBinaryPath(engine);
    return new Promise((resolve) => {
      try {
        if (!fs.existsSync(binaryPath)) {
          log('WARN', `Binary not found for ${engine}:`, binaryPath);
          resolve(false);
          return;
        }
        const proc = spawn(binaryPath, ['--check']);
        let output = '';

        proc.stdout.on('data', (data) => {
          output += data.toString();
        });

        proc.on('close', (code) => {
          if (code === 0) {
            try {
              const result = JSON.parse(output.trim());
              resolve(result.available === true);
            } catch {
              resolve(false);
            }
          } else {
            resolve(false);
          }
        });

        proc.on('error', () => {
          resolve(false);
        });
      } catch {
        resolve(false);
      }
    });
  }

  /**
   * Start listening for speech with the given options.
   * Binary and arguments are determined from options — no stale state.
   */
  start(options: VoiceStartOptions): boolean {
    if (this.process) {
      log('WARN', 'Voice capture already running');
      return false;
    }

    const binaryPath = this.resolveBinaryPath(options.speechEngine);

    try {
      log('INFO', `Starting voice capture: engine=${options.speechEngine}, binary=${binaryPath}`);

      if (!fs.existsSync(binaryPath)) {
        log('ERROR', 'Voice capture binary not found at:', binaryPath);
        this.emit({ type: 'error', message: `${options.speechEngine} binary not found` });
        return false;
      }

      // Build arguments based on engine
      const args: string[] = ['--locale', options.locale];

      // Audio output for direct-audio routing (both engines support --audio-output)
      if (options.directAudioRouting) {
        this.cleanupOldAudioFiles();
        this.currentAudioPath = this.generateAudioPath();
        args.push('--audio-output', this.currentAudioPath);
        log('INFO', 'Audio recording to:', this.currentAudioPath);
      } else {
        this.currentAudioPath = null;
      }

      // WhisperKit-specific arguments
      if (options.speechEngine === 'whisperkit') {
        args.push('--model', options.whisperKitModel || 'base');
        args.push('--models-dir', WHISPERKIT_MODELS_DIR);
      }

      this.process = spawn(binaryPath, args);
      log('INFO', `Voice capture spawned: engine=${options.speechEngine}, args=${args.join(' ')}, PID:`, this.process.pid);

      let buffer = '';

      this.process.stdout?.on('data', (data) => {
        buffer += data.toString();

        // Process complete JSON lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.trim()) {
            try {
              const event = JSON.parse(line) as VoiceEvent;
              this.emit(event);
            } catch (err) {
              log('WARN', 'Failed to parse voice event:', line, err);
            }
          }
        }
      });

      this.process.stderr?.on('data', (data) => {
        log('WARN', 'Voice capture stderr:', data.toString());
      });

      this.process.on('close', (code) => {
        log('INFO', 'Voice capture process closed with code:', code);
        this.process = null;
        this.emit({ type: 'status', status: 'idle' });
      });

      this.process.on('error', (err) => {
        log('ERROR', 'Voice capture process error:', err);
        this.process = null;
        this.emit({ type: 'error', message: err.message });
      });

      return true;
    } catch (err) {
      log('ERROR', 'Failed to start voice capture:', err);
      this.emit({ type: 'error', message: `Failed to start: ${err}` });
      return false;
    }
  }

  /**
   * Stop listening (SIGTERM → binary transcribes → outputs final → exits)
   */
  stop(): void {
    if (this.process) {
      log('INFO', 'Stopping native voice capture');
      this.process.kill('SIGTERM');
      // Don't null process here — let 'close' event handle it
      // so we still receive the final transcript
    }
  }

  /**
   * Cancel listening (SIGKILL — immediate, discard results)
   */
  cancel(): void {
    if (this.process) {
      log('INFO', 'Cancelling native voice capture');
      this.process.kill('SIGKILL');
      this.process = null;

      // Clean up any temp audio file
      if (this.currentAudioPath && fs.existsSync(this.currentAudioPath)) {
        try {
          fs.unlinkSync(this.currentAudioPath);
          log('INFO', 'Deleted cancelled audio file:', this.currentAudioPath);
        } catch (err) {
          log('WARN', 'Failed to delete audio file:', err);
        }
      }
      this.currentAudioPath = null;

      this.emit({ type: 'end' });
    }
  }

  /**
   * Check if currently capturing
   */
  isActive(): boolean {
    return this.process !== null;
  }

  // ===========================================================================
  // WhisperKit Model Management
  // ===========================================================================

  /**
   * List available and downloaded WhisperKit models.
   * Spawns whisperkit-recognizer --list-models as a one-shot process.
   */
  async whisperKitListModels(): Promise<WhisperKitModelsInfo> {
    const binaryPath = this.resolveBinaryPath('whisperkit');
    return new Promise((resolve, reject) => {
      try {
        if (!fs.existsSync(binaryPath)) {
          reject(new Error('whisperkit-recognizer binary not found'));
          return;
        }
        const proc = spawn(binaryPath, ['--list-models', '--models-dir', WHISPERKIT_MODELS_DIR]);
        let buffer = '';

        proc.stdout.on('data', (data) => {
          buffer += data.toString();
        });

        proc.on('close', (code) => {
          // Parse all JSON lines, find the 'models' event
          const lines = buffer.split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line);
              if (event.type === 'models') {
                resolve({
                  available: event.available || [],
                  downloaded: event.downloaded || [],
                  default: event.default || 'base',
                  supported: event.supported || [],
                });
                return;
              }
              if (event.type === 'error') {
                reject(new Error(event.message));
                return;
              }
            } catch {
              // skip unparseable lines
            }
          }
          reject(new Error(`list-models exited with code ${code}, no models event`));
        });

        proc.on('error', (err) => reject(err));
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Download a WhisperKit model. Emits progress events via the event callback system.
   * Returns true on success, false on failure.
   */
  async whisperKitDownloadModel(modelName: string): Promise<boolean> {
    const binaryPath = this.resolveBinaryPath('whisperkit');
    return new Promise((resolve, reject) => {
      try {
        if (!fs.existsSync(binaryPath)) {
          reject(new Error('whisperkit-recognizer binary not found'));
          return;
        }
        log('INFO', `Downloading WhisperKit model: ${modelName}`);
        const proc = spawn(binaryPath, ['--download-model', modelName, '--models-dir', WHISPERKIT_MODELS_DIR]);
        let buffer = '';

        proc.stdout.on('data', (data) => {
          buffer += data.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line) as VoiceEvent;
              // Forward progress and status events to listeners
              this.emit(event);
            } catch {
              // skip
            }
          }
        });

        proc.stderr?.on('data', (data) => {
          log('WARN', 'WhisperKit download stderr:', data.toString());
        });

        proc.on('close', (code) => {
          if (code === 0) {
            log('INFO', `WhisperKit model downloaded: ${modelName}`);
            resolve(true);
          } else {
            log('ERROR', `WhisperKit model download failed with code ${code}`);
            resolve(false);
          }
        });

        proc.on('error', (err) => reject(err));
      } catch (err) {
        reject(err);
      }
    });
  }

  // ===========================================================================
  // Event System
  // ===========================================================================

  /**
   * Subscribe to voice events
   */
  onEvent(callback: VoiceEventCallback): () => void {
    this.callbacks.push(callback);
    return () => {
      this.callbacks = this.callbacks.filter(cb => cb !== callback);
    };
  }

  private emit(event: VoiceEvent): void {
    for (const callback of this.callbacks) {
      try {
        callback(event);
      } catch (err) {
        log('ERROR', 'Voice event callback error:', err);
      }
    }
  }
}
