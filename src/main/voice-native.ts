/**
 * Native macOS Speech Recognition
 *
 * Spawns the native Swift CLI tool for speech-to-text.
 * Communicates via JSON lines over stdout.
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { app } from 'electron';
import { log } from './logger';

export type VoiceStatus = 'idle' | 'listening' | 'recording' | 'processing' | 'error';

export interface VoiceEvent {
  type: 'status' | 'interim' | 'final' | 'error' | 'end' | 'available';
  status?: VoiceStatus;
  transcript?: string;
  confidence?: number;
  message?: string;
  available?: boolean;
  audioPath?: string;  // Path to recorded audio file (when audio recording enabled)
}

type VoiceEventCallback = (event: VoiceEvent) => void;

/**
 * NativeVoiceCapture - Manages the native speech recognition process
 */
export class NativeVoiceCapture {
  private process: ChildProcess | null = null;
  private callbacks: VoiceEventCallback[] = [];
  private binaryPath: string;
  private locale: string = 'auto';
  private audioRecordingEnabled: boolean = false;
  private currentAudioPath: string | null = null;

  constructor() {
    // In development, use the native/macos directory
    // In production, use the app resources
    if (app.isPackaged) {
      this.binaryPath = path.join(process.resourcesPath, 'native', 'macos', 'speech-recognizer');
    } else {
      // In development, __dirname is dist/main/, go up to project root
      this.binaryPath = path.join(app.getAppPath(), 'native', 'macos', 'speech-recognizer');
    }
    log('INFO', 'Voice capture binary path:', this.binaryPath);
  }

  /**
   * Set the speech recognition locale
   */
  setLocale(locale: string): void {
    this.locale = locale;
    log('INFO', 'Voice capture locale set to:', locale);
  }

  /**
   * Enable or disable audio recording (for direct audio to LLM)
   */
  setAudioRecording(enabled: boolean): void {
    this.audioRecordingEnabled = enabled;
    log('INFO', 'Voice audio recording:', enabled ? 'enabled' : 'disabled');
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
   * Check if native speech recognition is available
   */
  async checkAvailability(): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const proc = spawn(this.binaryPath, ['--check']);
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
   * Start listening for speech
   */
  start(): boolean {
    if (this.process) {
      log('WARN', 'Voice capture already running');
      return false;
    }

    try {
      log('INFO', 'Starting native voice capture:', this.binaryPath);

      // Check if binary exists
      const fs = require('fs');
      if (!fs.existsSync(this.binaryPath)) {
        log('ERROR', 'Voice capture binary not found at:', this.binaryPath);
        this.emit({ type: 'error', message: 'Voice binary not found' });
        return false;
      }

      // Build arguments
      const args = ['--locale', this.locale];

      // Add audio output if enabled
      if (this.audioRecordingEnabled) {
        // Clean up old audio files before creating new one
        this.cleanupOldAudioFiles();

        this.currentAudioPath = this.generateAudioPath();
        args.push('--audio-output', this.currentAudioPath);
        log('INFO', 'Audio recording to:', this.currentAudioPath);
      } else {
        this.currentAudioPath = null;
      }

      this.process = spawn(this.binaryPath, args);
      log('INFO', `Voice capture process spawned with locale=${this.locale}, audioRecording=${this.audioRecordingEnabled}, PID:`, this.process.pid);

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
   * Stop listening (kill the process)
   */
  stop(): void {
    if (this.process) {
      log('INFO', 'Stopping native voice capture');
      this.process.kill('SIGTERM');
      this.process = null;
    }
  }

  /**
   * Cancel listening (kill process and discard results)
   * Unlike stop(), this doesn't wait for or process the final transcript
   */
  cancel(): void {
    if (this.process) {
      log('INFO', 'Cancelling native voice capture');
      // Kill with SIGKILL for immediate termination (no final output)
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

      // Emit end event to reset UI
      this.emit({ type: 'end' });
    }
  }

  /**
   * Check if currently capturing
   */
  isActive(): boolean {
    return this.process !== null;
  }

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
