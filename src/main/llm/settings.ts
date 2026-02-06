/**
 * LLM Settings Management
 *
 * Load/save LLM settings to ~/.varie/llm-config.yaml
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as YAML from 'yaml';
import { log } from '../logger';
import { LLMSettings, LLMProvider, SpeechLocale, VoiceInputMode, DEFAULT_LLM_SETTINGS, DEFAULT_MODELS, PROVIDER_MODELS, SPEECH_LOCALES } from './types';

// ============================================================================
// Paths
// ============================================================================

const VARIE_HOME = path.join(os.homedir(), '.varie');
const LLM_CONFIG_PATH = path.join(VARIE_HOME, 'llm-config.yaml');

// ============================================================================
// Template
// ============================================================================

const CONFIG_TEMPLATE = `# Workstation - LLM Configuration
# Used for voice command routing

# Enable LLM-based smart routing
# When disabled, voice commands go to the focused session
enabled: false

# Provider: anthropic | openai | google
provider: anthropic

# Model ID (see list below)
model: claude-haiku-4-5

# API Key (required when enabled)
# Get your key from:
# - Anthropic: https://console.anthropic.com/
# - OpenAI: https://platform.openai.com/api-keys
# - Google: https://aistudio.google.com/apikey
apiKey: ""

# Refine transcript before routing
# Fixes grammar, adds punctuation, corrects misheard project names
refineTranscript: true

# Speech recognition language
# Options: auto, en-US, zh-CN, zh-TW, ja-JP, ko-KR, es-ES, fr-FR, de-DE
# "auto" enables mixed-language mode (e.g., Chinese with English project names)
speechLocale: auto

# Voice input mode
# - apple-speech: Fast, offline. Uses Apple Speech for transcription, LLM for routing/refinement
# - direct-audio: More accurate. Sends audio directly to LLM (Gemini only, requires API)
voiceInputMode: apple-speech

# Confirm before send
# When true, voice commands and dispatch type text but wait for user to press Enter
# When false (default), commands are sent automatically after typing
confirmBeforeSend: false

# ============================================================================
# Available Models (2026)
# ============================================================================
#
# Anthropic:
#   - claude-haiku-4-5   (fast, recommended for routing)
#   - claude-sonnet-4-5  (balanced)
#   - claude-opus-4-6    (flagship)
#
# OpenAI:
#   - gpt-5-mini  (fast, recommended for routing)
#   - gpt-5       (balanced)
#   - gpt-5.2     (flagship)
#
# Google:
#   - gemini-3-flash  (fast, recommended for routing)
#   - gemini-3-pro    (flagship)
#
# Note: Fast models are recommended for voice routing.
# Routing is a simple task that doesn't need flagship models.
`;

// ============================================================================
// Settings Management
// ============================================================================

let cachedSettings: LLMSettings | null = null;

/**
 * Ensure the config file exists, create with template if not.
 */
function ensureConfigFile(): void {
  // Ensure ~/.varie directory exists
  if (!fs.existsSync(VARIE_HOME)) {
    fs.mkdirSync(VARIE_HOME, { recursive: true });
  }

  // Create config file with template if it doesn't exist
  if (!fs.existsSync(LLM_CONFIG_PATH)) {
    fs.writeFileSync(LLM_CONFIG_PATH, CONFIG_TEMPLATE, 'utf-8');
    log('INFO', `Created LLM config template: ${LLM_CONFIG_PATH}`);
  }
}

/**
 * Load LLM settings from disk.
 * Returns cached settings if available.
 */
export function loadLLMSettings(): LLMSettings {
  if (cachedSettings) {
    return cachedSettings;
  }

  ensureConfigFile();

  try {
    const content = fs.readFileSync(LLM_CONFIG_PATH, 'utf-8');
    const parsed = YAML.parse(content);

    // Validate and merge with defaults
    const settings: LLMSettings = {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_LLM_SETTINGS.enabled,
      provider: isValidProvider(parsed.provider) ? parsed.provider : DEFAULT_LLM_SETTINGS.provider,
      model: typeof parsed.model === 'string' ? parsed.model : DEFAULT_LLM_SETTINGS.model,
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : DEFAULT_LLM_SETTINGS.apiKey,
      refineTranscript: typeof parsed.refineTranscript === 'boolean' ? parsed.refineTranscript : DEFAULT_LLM_SETTINGS.refineTranscript,
      speechLocale: isValidSpeechLocale(parsed.speechLocale) ? parsed.speechLocale : DEFAULT_LLM_SETTINGS.speechLocale,
      voiceInputMode: isValidVoiceInputMode(parsed.voiceInputMode) ? parsed.voiceInputMode : DEFAULT_LLM_SETTINGS.voiceInputMode,
      confirmBeforeSend: typeof parsed.confirmBeforeSend === 'boolean' ? parsed.confirmBeforeSend : DEFAULT_LLM_SETTINGS.confirmBeforeSend,
    };

    // Validate model matches provider
    if (!isValidModel(settings.provider, settings.model)) {
      log('WARN', `Invalid model ${settings.model} for provider ${settings.provider}, using default`);
      settings.model = DEFAULT_MODELS[settings.provider];
    }

    cachedSettings = settings;
    log('INFO', `Loaded LLM settings: provider=${settings.provider}, model=${settings.model}, enabled=${settings.enabled}`);
    return settings;
  } catch (err) {
    log('ERROR', 'Failed to load LLM settings:', err);
    return { ...DEFAULT_LLM_SETTINGS };
  }
}

/**
 * Save LLM settings to disk.
 */
export function saveLLMSettings(settings: LLMSettings): void {
  ensureConfigFile();

  try {
    // Read existing file to preserve comments structure
    const existingContent = fs.readFileSync(LLM_CONFIG_PATH, 'utf-8');
    const lines = existingContent.split('\n');
    const newLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();

      // Update enabled
      if (trimmed.startsWith('enabled:')) {
        newLines.push(`enabled: ${settings.enabled}`);
        continue;
      }

      // Update provider
      if (trimmed.startsWith('provider:') && !trimmed.startsWith('#')) {
        newLines.push(`provider: ${settings.provider}`);
        continue;
      }

      // Update model
      if (trimmed.startsWith('model:') && !trimmed.startsWith('#')) {
        newLines.push(`model: ${settings.model}`);
        continue;
      }

      // Update apiKey
      if (trimmed.startsWith('apiKey:')) {
        newLines.push(`apiKey: "${settings.apiKey}"`);
        continue;
      }

      // Update refineTranscript
      if (trimmed.startsWith('refineTranscript:')) {
        newLines.push(`refineTranscript: ${settings.refineTranscript}`);
        continue;
      }

      // Update speechLocale
      if (trimmed.startsWith('speechLocale:')) {
        newLines.push(`speechLocale: ${settings.speechLocale}`);
        continue;
      }

      // Update voiceInputMode
      if (trimmed.startsWith('voiceInputMode:')) {
        newLines.push(`voiceInputMode: ${settings.voiceInputMode}`);
        continue;
      }

      // Update confirmBeforeSend
      if (trimmed.startsWith('confirmBeforeSend:')) {
        newLines.push(`confirmBeforeSend: ${settings.confirmBeforeSend}`);
        continue;
      }

      newLines.push(line);
    }

    fs.writeFileSync(LLM_CONFIG_PATH, newLines.join('\n'), 'utf-8');
    cachedSettings = settings;
    log('INFO', `Saved LLM settings: provider=${settings.provider}, model=${settings.model}, enabled=${settings.enabled}`);
  } catch (err) {
    log('ERROR', 'Failed to save LLM settings:', err);
    throw err;
  }
}

/**
 * Clear cached settings (force reload on next access).
 */
export function clearSettingsCache(): void {
  cachedSettings = null;
}

/**
 * Get the path to the LLM config file.
 */
export function getLLMConfigPath(): string {
  return LLM_CONFIG_PATH;
}

// ============================================================================
// Validation Helpers
// ============================================================================

function isValidProvider(value: unknown): value is LLMProvider {
  return value === 'anthropic' || value === 'openai' || value === 'google';
}

function isValidSpeechLocale(value: unknown): value is SpeechLocale {
  return SPEECH_LOCALES.some((l) => l.id === value);
}

function isValidVoiceInputMode(value: unknown): value is VoiceInputMode {
  return value === 'apple-speech' || value === 'direct-audio';
}

function isValidModel(provider: LLMProvider, model: string): boolean {
  const models = PROVIDER_MODELS[provider];
  return models.some((m) => m.id === model);
}

/**
 * Get available models for a provider.
 */
export function getModelsForProvider(provider: LLMProvider) {
  return PROVIDER_MODELS[provider];
}

/**
 * Check if settings are configured and ready for routing.
 */
export function isLLMRoutingConfigured(): boolean {
  const settings = loadLLMSettings();
  return settings.enabled && settings.apiKey.length > 0;
}

// ============================================================================
// Project Names (for transcript refinement context)
// ============================================================================

const PROJECTS_YAML_PATH = path.join(VARIE_HOME, 'manager', 'projects.yaml');

/**
 * Load all known project names from projects.yaml.
 * Used to provide context for transcript refinement (correcting misheard project names).
 */
export function loadAllProjectNames(): string[] {
  try {
    if (!fs.existsSync(PROJECTS_YAML_PATH)) {
      log('INFO', 'projects.yaml not found, no project context available');
      return [];
    }

    const content = fs.readFileSync(PROJECTS_YAML_PATH, 'utf-8');
    const parsed = YAML.parse(content);

    if (!parsed?.projects || typeof parsed.projects !== 'object') {
      return [];
    }

    // Extract project names (keys of the projects object)
    const projectNames = Object.keys(parsed.projects);
    log('INFO', `Loaded ${projectNames.length} project names for context`);
    return projectNames;
  } catch (err) {
    log('WARN', 'Failed to load project names:', err);
    return [];
  }
}
