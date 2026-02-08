import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Mock logger
vi.mock('../../../src/main/logger', () => ({
  log: vi.fn(),
}));

// Mock os module to override homedir — uses literal because vi.mock is hoisted
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => '/tmp/test-varie-settings' };
});

const TEST_HOME = '/tmp/test-varie-settings';
const VARIE_HOME = path.join(TEST_HOME, '.varie');
const CONFIG_PATH = path.join(VARIE_HOME, 'llm-config.yaml');

import {
  loadLLMSettings,
  saveLLMSettings,
  clearSettingsCache,
  isLLMRoutingConfigured,
  getModelsForProvider,
  getLLMConfigPath,
} from '../../../src/main/llm/settings';
import { DEFAULT_LLM_SETTINGS, PROVIDER_MODELS } from '../../../src/main/llm/types';

beforeEach(() => {
  clearSettingsCache();
  // Clean up test directory
  if (fs.existsSync(VARIE_HOME)) {
    fs.rmSync(VARIE_HOME, { recursive: true });
  }
});

afterEach(() => {
  // Clean up
  if (fs.existsSync(TEST_HOME)) {
    fs.rmSync(TEST_HOME, { recursive: true });
  }
});

// ============================================================================
// loadLLMSettings
// ============================================================================

describe('loadLLMSettings', () => {
  it('creates config file with template when missing', () => {
    const settings = loadLLMSettings();

    expect(fs.existsSync(CONFIG_PATH)).toBe(true);
    expect(settings.provider).toBe('anthropic');
    expect(settings.voiceRoutingMode).toBe('focused');
  });

  it('returns defaults when config does not exist', () => {
    const settings = loadLLMSettings();

    expect(settings.voiceRoutingMode).toBe('focused');
    expect(settings.provider).toBe(DEFAULT_LLM_SETTINGS.provider);
    expect(settings.model).toBe(DEFAULT_LLM_SETTINGS.model);
    expect(settings.apiKey).toBe('');
    expect(settings.refineTranscript).toBe(true);
    expect(settings.speechLocale).toBe('auto');
    expect(settings.speechEngine).toBe('apple-speech');
    expect(settings.directAudioRouting).toBe(false);
    expect(settings.whisperKitModel).toBe('base');
    expect(settings.confirmBeforeSend).toBe(false);
  });

  it('loads valid YAML config', () => {
    fs.mkdirSync(VARIE_HOME, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, `
voiceRoutingMode: smart
provider: openai
model: gpt-5-mini
apiKey: "sk-test-key"
refineTranscript: false
speechLocale: en-US
speechEngine: apple-speech
directAudioRouting: true
confirmBeforeSend: true
`);

    const settings = loadLLMSettings();
    expect(settings.voiceRoutingMode).toBe('smart');
    expect(settings.provider).toBe('openai');
    expect(settings.model).toBe('gpt-5-mini');
    expect(settings.apiKey).toBe('sk-test-key');
    expect(settings.refineTranscript).toBe(false);
    expect(settings.speechLocale).toBe('en-US');
    expect(settings.speechEngine).toBe('apple-speech');
    expect(settings.directAudioRouting).toBe(true);
    expect(settings.confirmBeforeSend).toBe(true);
  });

  it('migrates old enabled=true to voiceRoutingMode=smart', () => {
    fs.mkdirSync(VARIE_HOME, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, `
enabled: true
provider: openai
model: gpt-5-mini
apiKey: "sk-key"
`);

    const settings = loadLLMSettings();
    expect(settings.voiceRoutingMode).toBe('smart');
  });

  it('migrates old alwaysSendToManager=true to voiceRoutingMode=manager', () => {
    fs.mkdirSync(VARIE_HOME, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, `
alwaysSendToManager: true
provider: openai
model: gpt-5-mini
`);

    const settings = loadLLMSettings();
    expect(settings.voiceRoutingMode).toBe('manager');
  });

  it('uses defaults for missing fields', () => {
    fs.mkdirSync(VARIE_HOME, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, `
enabled: true
provider: anthropic
`);

    const settings = loadLLMSettings();
    expect(settings.voiceRoutingMode).toBe('smart'); // migrated from enabled: true
    expect(settings.provider).toBe('anthropic');
    expect(settings.model).toBe(DEFAULT_LLM_SETTINGS.model);
    expect(settings.apiKey).toBe('');
  });

  it('falls back to default for invalid provider', () => {
    fs.mkdirSync(VARIE_HOME, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, `
provider: invalid-provider
model: something
`);

    const settings = loadLLMSettings();
    expect(settings.provider).toBe('anthropic');
  });

  it('falls back to default model when model does not match provider', () => {
    fs.mkdirSync(VARIE_HOME, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, `
provider: anthropic
model: gpt-5-mini
`);

    const settings = loadLLMSettings();
    expect(settings.model).toBe('claude-haiku-4-5');
  });

  it('validates speech locale', () => {
    fs.mkdirSync(VARIE_HOME, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, `
speechLocale: invalid-locale
`);

    const settings = loadLLMSettings();
    expect(settings.speechLocale).toBe('auto');
  });

  it('validates speech engine', () => {
    fs.mkdirSync(VARIE_HOME, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, `
speechEngine: invalid-engine
`);

    const settings = loadLLMSettings();
    expect(settings.speechEngine).toBe('apple-speech');
  });

  it('accepts whisperkit speech engine', () => {
    fs.mkdirSync(VARIE_HOME, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, `
speechEngine: whisperkit
whisperKitModel: small
`);

    const settings = loadLLMSettings();
    expect(settings.speechEngine).toBe('whisperkit');
    expect(settings.whisperKitModel).toBe('small');
  });

  it('defaults whisperKitModel to base when missing', () => {
    fs.mkdirSync(VARIE_HOME, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, `
speechEngine: whisperkit
`);

    const settings = loadLLMSettings();
    expect(settings.whisperKitModel).toBe('base');
  });

  it('defaults directAudioRouting to false', () => {
    fs.mkdirSync(VARIE_HOME, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, `
speechEngine: apple-speech
`);

    const settings = loadLLMSettings();
    expect(settings.directAudioRouting).toBe(false);
  });

  it('caches settings after first load', () => {
    const settings1 = loadLLMSettings();
    const settings2 = loadLLMSettings();

    // Same object reference = cached
    expect(settings1).toBe(settings2);
  });

  it('returns fresh settings after cache clear', () => {
    const settings1 = loadLLMSettings();
    clearSettingsCache();
    const settings2 = loadLLMSettings();

    expect(settings1).not.toBe(settings2);
    expect(settings1).toEqual(settings2);
  });

  it('handles corrupted YAML gracefully', () => {
    fs.mkdirSync(VARIE_HOME, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, `
: : : invalid yaml [[[
`);

    const settings = loadLLMSettings();
    expect(settings.provider).toBe(DEFAULT_LLM_SETTINGS.provider);
  });
});

// ============================================================================
// saveLLMSettings
// ============================================================================

describe('saveLLMSettings', () => {
  it('saves and reloads settings correctly', () => {
    // First load creates the file
    loadLLMSettings();
    clearSettingsCache();

    const newSettings = {
      ...DEFAULT_LLM_SETTINGS,
      voiceRoutingMode: 'smart' as const,
      provider: 'google' as const,
      model: 'gemini-3-flash-preview',
      apiKey: 'goog-key-123',
      refineTranscript: false,
      speechLocale: 'zh-CN' as const,
      confirmBeforeSend: true,
    };

    saveLLMSettings(newSettings);
    clearSettingsCache();

    const loaded = loadLLMSettings();
    expect(loaded.voiceRoutingMode).toBe('smart');
    expect(loaded.provider).toBe('google');
    expect(loaded.model).toBe('gemini-3-flash-preview');
    expect(loaded.apiKey).toBe('goog-key-123');
    expect(loaded.refineTranscript).toBe(false);
    expect(loaded.speechLocale).toBe('zh-CN');
    expect(loaded.confirmBeforeSend).toBe(true);
  });

  it('saves and reloads whisperkit settings correctly', () => {
    loadLLMSettings();
    clearSettingsCache();

    const newSettings = {
      ...DEFAULT_LLM_SETTINGS,
      speechEngine: 'whisperkit' as const,
      directAudioRouting: true,
      whisperKitModel: 'large-v3-turbo',
    };

    saveLLMSettings(newSettings);
    clearSettingsCache();

    const loaded = loadLLMSettings();
    expect(loaded.speechEngine).toBe('whisperkit');
    expect(loaded.directAudioRouting).toBe(true);
    expect(loaded.whisperKitModel).toBe('large-v3-turbo');
  });

  it('preserves YAML comments after save', () => {
    // Load to create template
    loadLLMSettings();
    clearSettingsCache();

    saveLLMSettings({ ...DEFAULT_LLM_SETTINGS, enabled: true });

    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    expect(content).toContain('# Workstation');
    expect(content).toContain('# Available Models');
  });

  it('updates cache after save', () => {
    loadLLMSettings();

    const newSettings = { ...DEFAULT_LLM_SETTINGS, voiceRoutingMode: 'smart' as const };
    saveLLMSettings(newSettings);

    // Should return cached (saved) settings without clearing
    const loaded = loadLLMSettings();
    expect(loaded.voiceRoutingMode).toBe('smart');
  });
});

// ============================================================================
// isLLMRoutingConfigured
// ============================================================================

describe('isLLMRoutingConfigured', () => {
  it('returns false when routing mode is focused', () => {
    loadLLMSettings(); // creates default (focused, no key)
    clearSettingsCache();

    expect(isLLMRoutingConfigured()).toBe(false);
  });

  it('returns false when smart but no API key', () => {
    fs.mkdirSync(VARIE_HOME, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, `
voiceRoutingMode: smart
provider: anthropic
model: claude-haiku-4-5
apiKey: ""
`);

    expect(isLLMRoutingConfigured()).toBe(false);
  });

  it('returns true when smart with API key', () => {
    fs.mkdirSync(VARIE_HOME, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, `
voiceRoutingMode: smart
provider: anthropic
model: claude-haiku-4-5
apiKey: "sk-test"
`);

    expect(isLLMRoutingConfigured()).toBe(true);
  });
});

// ============================================================================
// getModelsForProvider
// ============================================================================

describe('getModelsForProvider', () => {
  it('returns Anthropic models', () => {
    const models = getModelsForProvider('anthropic');
    expect(models.length).toBeGreaterThan(0);
    expect(models.some(m => m.id === 'claude-haiku-4-5')).toBe(true);
    expect(models.some(m => m.type === 'fast')).toBe(true);
  });

  it('returns OpenAI models', () => {
    const models = getModelsForProvider('openai');
    expect(models.length).toBeGreaterThan(0);
    expect(models.some(m => m.id === 'gpt-5-mini')).toBe(true);
  });

  it('returns Google models', () => {
    const models = getModelsForProvider('google');
    expect(models.length).toBeGreaterThan(0);
    expect(models.some(m => m.type === 'fast')).toBe(true);
  });
});

// ============================================================================
// Types validation
// ============================================================================

describe('PROVIDER_MODELS', () => {
  it('all models have required fields', () => {
    for (const [provider, models] of Object.entries(PROVIDER_MODELS)) {
      for (const model of models) {
        expect(model.id, `${provider}/${model.name} missing id`).toBeTruthy();
        expect(model.name, `${provider}/${model.id} missing name`).toBeTruthy();
        expect(['fast', 'balanced', 'flagship'], `${provider}/${model.id} invalid type`).toContain(model.type);
      }
    }
  });

  it('each provider has at least one fast model', () => {
    for (const [provider, models] of Object.entries(PROVIDER_MODELS)) {
      expect(models.some(m => m.type === 'fast'), `${provider} has no fast model`).toBe(true);
    }
  });
});
