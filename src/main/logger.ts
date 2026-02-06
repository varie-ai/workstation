/**
 * File-based logging for Varie Workstation
 *
 * Logs to both console and file for debugging packaged applications.
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

let LOG_FILE: string;
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_LOG_AGE_DAYS = 7;

// Track if stdout is still available (becomes unavailable after launching terminal closes)
let stdoutAvailable = true;

export function initLogger(): void {
  const userDataPath = app.getPath('userData');
  LOG_FILE = path.join(userDataPath, 'debug.log');

  // Rotate if log too large
  if (fs.existsSync(LOG_FILE)) {
    try {
      const stats = fs.statSync(LOG_FILE);
      if (stats.size > MAX_LOG_SIZE) {
        const rotatedPath = LOG_FILE.replace('.log', `.${Date.now()}.log`);
        fs.renameSync(LOG_FILE, rotatedPath);
      }
    } catch {
      // Ignore rotation errors
    }
  }

  // Delete old rotated logs
  try {
    const files = fs.readdirSync(userDataPath);
    const now = Date.now();
    for (const file of files) {
      if (file.match(/debug\.\d+\.log$/)) {
        const filePath = path.join(userDataPath, file);
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1000) {
          fs.unlinkSync(filePath);
        }
      }
    }
  } catch {
    // Ignore cleanup errors
  }

  fs.writeFileSync(
    LOG_FILE,
    `=== Workstation Debug Log ===\nStarted: ${new Date().toISOString()}\nLog file: ${LOG_FILE}\n\n`
  );

  log('INFO', 'App starting...');
  log('INFO', 'Electron version:', process.versions.electron);
  log('INFO', 'Platform:', process.platform, process.arch);
}

export function log(level: string, ...args: unknown[]): void {
  const timestamp = new Date().toISOString();
  const message = `[${timestamp}] [${level}] ${args
    .map((a) => (typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)))
    .join(' ')}\n`;

  // Only try console.log if stdout is still available
  if (stdoutAvailable) {
    try {
      console.log(message.trim());
    } catch {
      // EPIPE error - stdout pipe closed (launching terminal closed)
      stdoutAvailable = false;
    }
  }

  // Always write to file log if initialized
  if (LOG_FILE) {
    try {
      fs.appendFileSync(LOG_FILE, message);
    } catch {
      // Ignore file write errors
    }
  }
}
