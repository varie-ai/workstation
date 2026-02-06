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
