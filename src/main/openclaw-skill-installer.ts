/**
 * OpenClawSkillInstaller — Auto-installs the workstation skill and wctl CLI
 * into the user's OpenClaw workspace on app launch.
 *
 * Resolves workspace path from ~/.openclaw/openclaw.json (never hardcoded).
 * Only overwrites if bundled version is newer than installed version.
 * Skips silently if OpenClaw is not installed.
 */

import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { log } from './logger';

const OPENCLAW_CONFIG = path.join(os.homedir(), '.openclaw', 'openclaw.json');
const DEFAULT_WORKSPACE = path.join(os.homedir(), '.openclaw', 'workspace');
const WCTL_SYMLINK = path.join(os.homedir(), '.local', 'bin', 'wctl');

/**
 * Resolve the bundled openclaw directory (dev vs packaged).
 */
function resolveBundledDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'openclaw');
  }
  return path.join(app.getAppPath(), 'openclaw');
}

/**
 * Read OpenClaw config and resolve workspace path.
 * Returns null if OpenClaw is not installed.
 */
function resolveWorkspacePath(): string | null {
  if (!fs.existsSync(OPENCLAW_CONFIG)) {
    return null;
  }

  try {
    const config = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf-8'));
    return config.agents?.defaults?.workspace || DEFAULT_WORKSPACE;
  } catch (err) {
    log('WARN', '[openclaw-installer] Failed to parse openclaw.json:', (err as Error).message);
    return DEFAULT_WORKSPACE;
  }
}

/**
 * Check if source file is newer than target file.
 */
function isNewer(source: string, target: string): boolean {
  if (!fs.existsSync(target)) return true;

  try {
    const sourceStat = fs.statSync(source);
    const targetStat = fs.statSync(target);
    return sourceStat.mtimeMs > targetStat.mtimeMs;
  } catch {
    return true;
  }
}

/**
 * Install the workstation SKILL.md to the OpenClaw workspace.
 */
function installSkill(bundledDir: string, workspace: string): boolean {
  const source = path.join(bundledDir, 'skills', 'workstation', 'SKILL.md');
  const targetDir = path.join(workspace, 'skills', 'workstation');
  const target = path.join(targetDir, 'SKILL.md');

  if (!fs.existsSync(source)) {
    log('WARN', '[openclaw-installer] Bundled SKILL.md not found:', source);
    return false;
  }

  if (!isNewer(source, target)) {
    log('INFO', '[openclaw-installer] SKILL.md is up to date');
    return false;
  }

  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(source, target);
  log('INFO', '[openclaw-installer] Installed SKILL.md to:', target);
  return true;
}

/**
 * Install wctl CLI to ~/.local/bin/wctl.
 */
function installWctl(bundledDir: string): boolean {
  const source = path.join(bundledDir, 'wctl.js');

  if (!fs.existsSync(source)) {
    log('WARN', '[openclaw-installer] Bundled wctl.js not found:', source);
    return false;
  }

  // Ensure ~/.local/bin exists
  const binDir = path.dirname(WCTL_SYMLINK);
  fs.mkdirSync(binDir, { recursive: true });

  // If symlink exists and points to a valid file, check if we need to update
  if (fs.existsSync(WCTL_SYMLINK)) {
    try {
      const existingTarget = fs.realpathSync(WCTL_SYMLINK);
      if (existingTarget === fs.realpathSync(source)) {
        log('INFO', '[openclaw-installer] wctl symlink is up to date');
        return false;
      }
    } catch {
      // Broken symlink or error — remove and recreate
    }
    fs.unlinkSync(WCTL_SYMLINK);
  }

  fs.symlinkSync(source, WCTL_SYMLINK);
  fs.chmodSync(source, 0o755);
  log('INFO', '[openclaw-installer] Installed wctl symlink:', WCTL_SYMLINK, '->', source);
  return true;
}

/**
 * Main entry point — called from initServices().
 * Installs workstation skill and wctl if OpenClaw is present.
 */
export function installOpenClawSkills(): void {
  const workspace = resolveWorkspacePath();
  if (!workspace) {
    log('INFO', '[openclaw-installer] OpenClaw not installed, skipping skill installation');
    return;
  }

  const bundledDir = resolveBundledDir();
  if (!fs.existsSync(bundledDir)) {
    log('WARN', '[openclaw-installer] Bundled openclaw directory not found:', bundledDir);
    return;
  }

  let installed = false;
  installed = installSkill(bundledDir, workspace) || installed;
  installed = installWctl(bundledDir) || installed;

  if (installed) {
    log('INFO', '[openclaw-installer] Skills installed. New OpenClaw sessions will pick them up automatically.');
  }
}
