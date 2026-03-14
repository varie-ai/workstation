/**
 * BridgeService — Manages the openclaw-bridge child process.
 *
 * Spawns bridge/openclaw-bridge.js as a child process so it inherits
 * the Workstation app's Screen Recording permission (macOS TCC).
 * The bridge watches ~/.varie-workstation/events.jsonl and sends
 * Telegram/WhatsApp notifications for session events.
 */

import { app } from 'electron';
import { fork, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { log } from './logger';

export class BridgeService {
  private process: ChildProcess | null = null;
  private messageHandler: ((msg: Record<string, unknown>) => void) | null = null;

  /**
   * Resolve the bridge script path (dev vs packaged).
   */
  private resolveBridgePath(): string {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'bridge', 'openclaw-bridge.js');
    }
    return path.join(app.getAppPath(), 'bridge', 'openclaw-bridge.js');
  }

  /**
   * Start the bridge child process.
   */
  start(): void {
    if (this.process) {
      log('WARN', 'Bridge already running, PID:', this.process.pid);
      return;
    }

    const bridgePath = this.resolveBridgePath();
    if (!fs.existsSync(bridgePath)) {
      log('WARN', 'Bridge script not found:', bridgePath);
      return;
    }

    log('INFO', 'Starting bridge:', bridgePath);

    // Electron apps inherit a minimal macOS PATH (/usr/bin:/bin:/usr/sbin:/sbin).
    // The bridge needs /opt/homebrew/bin (openclaw) and ~/.local/bin (wctl).
    const homedir = require('os').homedir();
    const extraPaths = [
      '/opt/homebrew/bin',
      path.join(homedir, '.local', 'bin'),
    ];
    const currentPath = process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin';
    const augmentedPath = [...extraPaths, ...currentPath.split(':')]
      .filter((v, i, a) => a.indexOf(v) === i) // dedupe
      .join(':');

    this.process = fork(bridgePath, [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      detached: false,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PATH: augmentedPath },
    });

    // Forward stdout/stderr to Workstation log
    this.process.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().trim().split('\n');
      for (const line of lines) {
        log('INFO', '[bridge]', line);
      }
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().trim().split('\n');
      for (const line of lines) {
        log('WARN', '[bridge]', line);
      }
    });

    this.process.on('exit', (code, signal) => {
      log('INFO', `Bridge exited: code=${code}, signal=${signal}`);
      this.process = null;
    });

    this.process.on('message', (msg) => {
      if (this.messageHandler) this.messageHandler(msg as Record<string, unknown>);
    });

    this.process.on('error', (err) => {
      log('ERROR', 'Bridge process error:', err.message);
      this.process = null;
    });

    log('INFO', 'Bridge spawned, PID:', this.process.pid);
  }

  /**
   * Stop the bridge process gracefully.
   */
  stop(): void {
    if (!this.process) return;

    log('INFO', 'Stopping bridge, PID:', this.process.pid);
    this.process.kill('SIGTERM');
    this.process = null;
  }

  /**
   * Send an IPC message to the bridge process.
   */
  send(message: Record<string, unknown>): void {
    if (this.process?.connected) {
      this.process.send(message);
    }
  }

  /**
   * Register a handler for IPC messages from the bridge process.
   */
  onMessage(handler: (msg: Record<string, unknown>) => void): void {
    this.messageHandler = handler;
  }

  isRunning(): boolean {
    return this.process !== null;
  }
}
