/**
 * Workstation configuration helpers
 *
 * Reads ~/.varie/config.yaml for workstation settings.
 * Uses simple string matching (no YAML parser) — consistent with
 * the grep/sed pattern used in plugin shell scripts.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { log } from './logger';

const CONFIG_PATH = path.join(os.homedir(), '.varie', 'config.yaml');

/**
 * Read a boolean setting from ~/.varie/config.yaml.
 * Returns true only if the key is explicitly set to true.
 */
function readConfigBool(key: string): boolean {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return false;
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const regex = new RegExp(`^${key}:\\s*true`, 'm');
    return regex.test(content);
  } catch (err) {
    log('WARN', `Failed to read config (${key}):`, err);
    return false;
  }
}

/**
 * Write a boolean setting to ~/.varie/config.yaml.
 * Creates the file/directory if needed. Uses sed-style replacement
 * consistent with the plugin shell script pattern.
 */
function writeConfigBool(key: string, value: boolean): void {
  try {
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (fs.existsSync(CONFIG_PATH)) {
      let content = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const regex = new RegExp(`^${key}:.*$`, 'm');
      if (regex.test(content)) {
        content = content.replace(regex, `${key}: ${value}`);
      } else {
        content = content.trimEnd() + `\n${key}: ${value}\n`;
      }
      fs.writeFileSync(CONFIG_PATH, content);
    } else {
      fs.writeFileSync(CONFIG_PATH, `${key}: ${value}\n`);
    }
    log('INFO', `Config: set ${key} = ${value}`);
  } catch (err) {
    log('ERROR', `Failed to write config (${key}):`, err);
  }
}

/**
 * Read a string setting from ~/.varie/config.yaml.
 * Returns defaultValue if the key is not found.
 */
function readConfigString(key: string, defaultValue: string): string {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return defaultValue;
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const regex = new RegExp(`^${key}:\\s*(.+)$`, 'm');
    const match = content.match(regex);
    if (match) {
      let val = match[1].trim();
      // Strip quotes if present
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      return val;
    }
    return defaultValue;
  } catch (err) {
    log('WARN', `Failed to read config (${key}):`, err);
    return defaultValue;
  }
}

/**
 * Write a string setting to ~/.varie/config.yaml.
 * Creates the file/directory if needed.
 */
function writeConfigString(key: string, value: string): void {
  try {
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (fs.existsSync(CONFIG_PATH)) {
      let content = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const regex = new RegExp(`^${key}:.*$`, 'm');
      if (regex.test(content)) {
        content = content.replace(regex, `${key}: ${value}`);
      } else {
        content = content.trimEnd() + `\n${key}: ${value}\n`;
      }
      fs.writeFileSync(CONFIG_PATH, content);
    } else {
      fs.writeFileSync(CONFIG_PATH, `${key}: ${value}\n`);
    }
    log('INFO', `Config: set ${key} = ${value}`);
  } catch (err) {
    log('ERROR', `Failed to write config (${key}):`, err);
  }
}

// ============================================================================
// Cloud Relay settings
// ============================================================================

export function getCloudRelayEnabled(): boolean {
  return readConfigBool('cloudRelay');
}

export function setCloudRelayEnabled(enabled: boolean): void {
  writeConfigBool('cloudRelay', enabled);
}

export function getCloudRelayToken(): string {
  return readConfigString('cloudRelayToken', '');
}

export function setCloudRelayToken(token: string): void {
  writeConfigString('cloudRelayToken', token);
}

// ============================================================================
// Skip permissions
// ============================================================================

/**
 * Get the current skipPermissions setting value.
 */
export function getSkipPermissions(): boolean {
  return readConfigBool('skipPermissions');
}

/**
 * Set the skipPermissions setting.
 */
export function setSkipPermissions(enabled: boolean): void {
  writeConfigBool('skipPermissions', enabled);
}

/**
 * Get Claude CLI flags based on workstation config.
 * Reads fresh from disk each call (no caching) so toggling
 * skipPermissions takes effect for the next session without restart.
 *
 * Returns flag string (e.g. '--dangerously-skip-permissions') or empty string.
 */
export function getClaudeFlags(): string {
  const skip = readConfigBool('skipPermissions');
  if (skip) {
    log('INFO', 'skipPermissions enabled — sessions will use --dangerously-skip-permissions');
    return '--dangerously-skip-permissions';
  }
  return '';
}

/**
 * Check if varie-workstation plugin is installed via marketplace.
 * Reads ~/.claude/plugins/installed_plugins.json for any key matching
 * "varie-workstation@*". Returns the install path if found, null otherwise.
 */
export function getMarketplacePluginInstall(): { key: string; installPath: string } | null {
  try {
    const installedPath = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
    if (!fs.existsSync(installedPath)) return null;
    const data = JSON.parse(fs.readFileSync(installedPath, 'utf-8'));
    if (!data.plugins) return null;
    for (const key of Object.keys(data.plugins)) {
      if (key.startsWith('varie-workstation@')) {
        const entries = data.plugins[key];
        if (Array.isArray(entries) && entries.length > 0) {
          return { key, installPath: entries[0].installPath };
        }
      }
    }
    return null;
  } catch (err) {
    log('WARN', 'Failed to check marketplace plugin install:', err);
    return null;
  }
}
