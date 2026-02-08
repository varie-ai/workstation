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
import { LLMSettings, LLMProvider, SpeechLocale, SpeechEngine, VoiceRoutingMode, DEFAULT_LLM_SETTINGS, DEFAULT_MODELS, PROVIDER_MODELS, SPEECH_LOCALES } from './types';

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

# Voice routing mode
# - focused: Send to the focused session (default)
# - manager: Always send to the manager session
# - smart: Use LLM to route to the best matching session (requires API key)
voiceRoutingMode: focused

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

# Speech engine (which STT binary to use)
# - apple-speech: Fast, offline. Real-time interim transcripts
# - whisperkit: Accurate, offline. Batch mode (Whisper on Apple Silicon). Requires model download
speechEngine: apple-speech

# Direct audio routing
# When true, also saves audio and sends to LLM for routing (Gemini only, requires API)
# Works with both speech engines
directAudioRouting: false

# WhisperKit model (only used when speechEngine is whisperkit)
# Options: base (default, ~150MB), small (~500MB), large-v3-turbo (~1.5GB)
# Models are downloaded from settings before first use
whisperKitModel: base

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

    // Migrate from old enabled/alwaysSendToManager booleans to voiceRoutingMode
    let routingMode: VoiceRoutingMode = DEFAULT_LLM_SETTINGS.voiceRoutingMode;
    if (isValidVoiceRoutingMode(parsed.voiceRoutingMode)) {
      routingMode = parsed.voiceRoutingMode;
    } else if (parsed.alwaysSendToManager === true) {
      routingMode = 'manager';
    } else if (parsed.enabled === true) {
      routingMode = 'smart';
    }

    // Validate and merge with defaults
    const settings: LLMSettings = {
      voiceRoutingMode: routingMode,
      provider: isValidProvider(parsed.provider) ? parsed.provider : DEFAULT_LLM_SETTINGS.provider,
      model: typeof parsed.model === 'string' ? parsed.model : DEFAULT_LLM_SETTINGS.model,
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : DEFAULT_LLM_SETTINGS.apiKey,
      refineTranscript: typeof parsed.refineTranscript === 'boolean' ? parsed.refineTranscript : DEFAULT_LLM_SETTINGS.refineTranscript,
      speechLocale: isValidSpeechLocale(parsed.speechLocale) ? parsed.speechLocale : DEFAULT_LLM_SETTINGS.speechLocale,
      speechEngine: isValidSpeechEngine(parsed.speechEngine) ? parsed.speechEngine : DEFAULT_LLM_SETTINGS.speechEngine,
      directAudioRouting: typeof parsed.directAudioRouting === 'boolean' ? parsed.directAudioRouting : DEFAULT_LLM_SETTINGS.directAudioRouting,
      whisperKitModel: typeof parsed.whisperKitModel === 'string' && parsed.whisperKitModel.length > 0 ? parsed.whisperKitModel : DEFAULT_LLM_SETTINGS.whisperKitModel,
      confirmBeforeSend: typeof parsed.confirmBeforeSend === 'boolean' ? parsed.confirmBeforeSend : DEFAULT_LLM_SETTINGS.confirmBeforeSend,
    };

    // Validate model matches provider
    if (!isValidModel(settings.provider, settings.model)) {
      log('WARN', `Invalid model ${settings.model} for provider ${settings.provider}, using default`);
      settings.model = DEFAULT_MODELS[settings.provider];
    }

    cachedSettings = settings;
    log('INFO', `Loaded LLM settings: provider=${settings.provider}, model=${settings.model}, routing=${settings.voiceRoutingMode}`);
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

      // Update voiceRoutingMode (also match old 'enabled:' for migration)
      if (trimmed.startsWith('voiceRoutingMode:') || trimmed.startsWith('enabled:')) {
        newLines.push(`voiceRoutingMode: ${settings.voiceRoutingMode}`);
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

      // Update speechEngine
      if (trimmed.startsWith('speechEngine:')) {
        newLines.push(`speechEngine: ${settings.speechEngine}`);
        continue;
      }

      // Update directAudioRouting
      if (trimmed.startsWith('directAudioRouting:')) {
        newLines.push(`directAudioRouting: ${settings.directAudioRouting}`);
        continue;
      }

      // Update whisperKitModel
      if (trimmed.startsWith('whisperKitModel:')) {
        newLines.push(`whisperKitModel: ${settings.whisperKitModel}`);
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
    log('INFO', `Saved LLM settings: provider=${settings.provider}, model=${settings.model}, routing=${settings.voiceRoutingMode}`);
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

function isValidSpeechEngine(value: unknown): value is SpeechEngine {
  return value === 'apple-speech' || value === 'whisperkit';
}

function isValidVoiceRoutingMode(value: unknown): value is VoiceRoutingMode {
  return value === 'focused' || value === 'manager' || value === 'smart';
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
  return settings.voiceRoutingMode === 'smart' && settings.apiKey.length > 0;
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
