import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing
vi.mock('../../../src/main/logger', () => ({
  log: vi.fn(),
}));

vi.mock('../../../src/main/llm/settings', () => ({
  loadLLMSettings: vi.fn(),
  isLLMRoutingConfigured: vi.fn(),
  loadAllProjectNames: vi.fn(() => []),
}));

vi.mock('../../../src/main/llm/anthropic', () => ({
  AnthropicProvider: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../../src/main/llm/openai', () => ({
  OpenAIProvider: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../../src/main/llm/google', () => ({
  GoogleProvider: vi.fn().mockImplementation(() => ({})),
}));

import { routeVoiceCommand, testLLMConnection } from '../../../src/main/llm/router';
import { loadLLMSettings, isLLMRoutingConfigured } from '../../../src/main/llm/settings';
import { AnthropicProvider } from '../../../src/main/llm/anthropic';
import { OpenAIProvider } from '../../../src/main/llm/openai';
import { GoogleProvider } from '../../../src/main/llm/google';
import type { SessionSummary } from '../../../src/main/llm/types';

const mockLoadSettings = vi.mocked(loadLLMSettings);
const mockIsConfigured = vi.mocked(isLLMRoutingConfigured);

const sessions: SessionSummary[] = [
  { id: 'sess-1', repo: 'varie-workstation', status: 'active', lastActivity: 'writing tests' },
  { id: 'sess-2', repo: 'varie-avatar', status: 'active', lastActivity: 'fixing bug' },
];

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// Direct routing (LLM disabled)
// ============================================================================

describe('routeVoiceCommand — direct routing (LLM disabled)', () => {
  beforeEach(() => {
    mockIsConfigured.mockReturnValue(false);
  });

  it('routes to focused session when LLM is not configured', async () => {
    const result = await routeVoiceCommand({
      voiceInput: 'check the tests',
      sessions,
      focusedSessionId: 'sess-1',
      managerSessionId: 'mgr-1',
    });

    expect(result.targetSessionId).toBe('sess-1');
    expect(result.confidence).toBe('direct');
    expect(result.usedLLM).toBe(false);
  });

  it('falls back to manager when no focused session', async () => {
    const result = await routeVoiceCommand({
      voiceInput: 'hello',
      sessions,
      managerSessionId: 'mgr-1',
    });

    expect(result.targetSessionId).toBe('mgr-1');
    expect(result.confidence).toBe('direct');
  });

  it('returns unknown when no focused or manager session', async () => {
    const result = await routeVoiceCommand({
      voiceInput: 'hello',
      sessions,
    });

    expect(result.targetSessionId).toBe('unknown');
    expect(result.confidence).toBe('direct');
  });
});

// ============================================================================
// LLM routing — provider creation
// ============================================================================

describe('routeVoiceCommand — provider creation', () => {
  beforeEach(() => {
    mockIsConfigured.mockReturnValue(true);
  });

  it('falls back to manager when provider returns null (no API key)', async () => {
    mockLoadSettings.mockReturnValue({
      enabled: false,
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      apiKey: '',
      refineTranscript: true,
      speechLocale: 'auto',
      voiceInputMode: 'apple-speech',
      confirmBeforeSend: false,
    });

    const result = await routeVoiceCommand({
      voiceInput: 'check tests',
      sessions,
      managerSessionId: 'mgr-1',
      focusedSessionId: 'sess-1',
    });

    expect(result.targetSessionId).toBe('mgr-1');
    expect(result.confidence).toBe('fallback');
    expect(result.usedLLM).toBe(false);
  });

  it('creates Anthropic provider when configured', async () => {
    mockLoadSettings.mockReturnValue({
      enabled: true,
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      apiKey: 'sk-test',
      refineTranscript: true,
      speechLocale: 'auto',
      voiceInputMode: 'apple-speech',
      confirmBeforeSend: false,
    });

    const mockRoute = vi.fn().mockResolvedValue({
      targetSessionId: 'sess-1',
      confidence: 'strong',
      reasoning: 'Matches workstation repo',
    });
    vi.mocked(AnthropicProvider).mockImplementation(function() {
      return { routeVoiceCommand: mockRoute, testConnection: vi.fn() } as any;
    } as any);

    const result = await routeVoiceCommand({
      voiceInput: 'check the workstation tests',
      sessions,
      focusedSessionId: 'sess-1',
      managerSessionId: 'mgr-1',
    });

    expect(AnthropicProvider).toHaveBeenCalledWith('sk-test', 'claude-haiku-4-5');
    expect(result.targetSessionId).toBe('sess-1');
    expect(result.confidence).toBe('strong');
    expect(result.usedLLM).toBe(true);
  });

  it('creates OpenAI provider when configured', async () => {
    mockLoadSettings.mockReturnValue({
      enabled: true,
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'sk-openai',
      refineTranscript: false,
      speechLocale: 'auto',
      voiceInputMode: 'apple-speech',
      confirmBeforeSend: false,
    });

    const mockRoute = vi.fn().mockResolvedValue({
      targetSessionId: 'sess-2',
      confidence: 'strong',
    });
    vi.mocked(OpenAIProvider).mockImplementation(function() {
      return { routeVoiceCommand: mockRoute, testConnection: vi.fn() } as any;
    } as any);

    const result = await routeVoiceCommand({
      voiceInput: 'fix avatar bug',
      sessions,
      focusedSessionId: 'sess-1',
      managerSessionId: 'mgr-1',
    });

    expect(OpenAIProvider).toHaveBeenCalledWith('sk-openai', 'gpt-5-mini');
    expect(result.targetSessionId).toBe('sess-2');
  });

  it('creates Google provider when configured', async () => {
    mockLoadSettings.mockReturnValue({
      enabled: true,
      provider: 'google',
      model: 'gemini-3-flash-preview',
      apiKey: 'goog-key',
      refineTranscript: false,
      speechLocale: 'auto',
      voiceInputMode: 'apple-speech',
      confirmBeforeSend: false,
    });

    const mockRoute = vi.fn().mockResolvedValue({
      targetSessionId: 'manager',
      confidence: 'unknown',
    });
    vi.mocked(GoogleProvider).mockImplementation(function() {
      return { routeVoiceCommand: mockRoute, testConnection: vi.fn(), supportsAudioInput: () => true } as any;
    } as any);

    const result = await routeVoiceCommand({
      voiceInput: 'start new feature',
      sessions,
      managerSessionId: 'mgr-1',
    });

    expect(GoogleProvider).toHaveBeenCalledWith('goog-key', 'gemini-3-flash-preview');
    expect(result.targetSessionId).toBe('mgr-1');
  });
});

// ============================================================================
// LLM routing — decision handling
// ============================================================================

describe('routeVoiceCommand — decision handling', () => {
  function setupProvider(decision: any) {
    mockIsConfigured.mockReturnValue(true);
    mockLoadSettings.mockReturnValue({
      enabled: true,
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      apiKey: 'sk-test',
      refineTranscript: false,
      speechLocale: 'auto',
      voiceInputMode: 'apple-speech',
      confirmBeforeSend: false,
    });
    vi.mocked(AnthropicProvider).mockImplementation(function() {
      return { routeVoiceCommand: vi.fn().mockResolvedValue(decision), testConnection: vi.fn() } as any;
    } as any);
  }

  it('routes to valid session with strong confidence', async () => {
    setupProvider({ targetSessionId: 'sess-2', confidence: 'strong', reasoning: 'avatar bug' });

    const result = await routeVoiceCommand({
      voiceInput: 'fix avatar',
      sessions,
      focusedSessionId: 'sess-1',
      managerSessionId: 'mgr-1',
    });

    expect(result.targetSessionId).toBe('sess-2');
    expect(result.confidence).toBe('strong');
    expect(result.usedLLM).toBe(true);
  });

  it('routes weak confidence to manager for verification', async () => {
    setupProvider({ targetSessionId: 'sess-2', confidence: 'weak', reasoning: 'ambiguous' });

    const result = await routeVoiceCommand({
      voiceInput: 'check the code',
      sessions,
      focusedSessionId: 'sess-1',
      managerSessionId: 'mgr-1',
    });

    expect(result.targetSessionId).toBe('mgr-1');
    expect(result.confidence).toBe('weak');
  });

  it('maps "manager" target to actual manager session ID', async () => {
    setupProvider({ targetSessionId: 'manager', confidence: 'unknown' });

    const result = await routeVoiceCommand({
      voiceInput: 'new feature',
      sessions,
      managerSessionId: 'mgr-1',
    });

    expect(result.targetSessionId).toBe('mgr-1');
  });

  it('handles invalid session ID from LLM', async () => {
    setupProvider({ targetSessionId: 'sess-nonexistent', confidence: 'strong' });

    const result = await routeVoiceCommand({
      voiceInput: 'do something',
      sessions,
      managerSessionId: 'mgr-1',
    });

    expect(result.targetSessionId).toBe('mgr-1');
    expect(result.confidence).toBe('unknown');
    expect(result.reasoning).toContain('invalid session');
  });

  it('passes through refined transcript', async () => {
    setupProvider({
      targetSessionId: 'sess-1',
      confidence: 'strong',
      refinedTranscript: 'Check the workstation tests.',
    });

    const result = await routeVoiceCommand({
      voiceInput: 'check the workstation test',
      sessions,
      focusedSessionId: 'sess-1',
      managerSessionId: 'mgr-1',
      refineTranscript: true,
    });

    expect(result.refinedTranscript).toBe('Check the workstation tests.');
  });
});

// ============================================================================
// LLM routing — error handling
// ============================================================================

describe('routeVoiceCommand — error handling', () => {
  it('falls back to manager on API error', async () => {
    mockIsConfigured.mockReturnValue(true);
    mockLoadSettings.mockReturnValue({
      enabled: true,
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      apiKey: 'sk-test',
      refineTranscript: false,
      speechLocale: 'auto',
      voiceInputMode: 'apple-speech',
      confirmBeforeSend: false,
    });
    vi.mocked(AnthropicProvider).mockImplementation(function() {
      return { routeVoiceCommand: vi.fn().mockRejectedValue(new Error('API 500')), testConnection: vi.fn() } as any;
    } as any);

    const result = await routeVoiceCommand({
      voiceInput: 'test',
      sessions,
      managerSessionId: 'mgr-1',
      focusedSessionId: 'sess-1',
    });

    expect(result.targetSessionId).toBe('mgr-1');
    expect(result.confidence).toBe('fallback');
    expect(result.usedLLM).toBe(false);
  });

  it('falls back to focused session when no manager on error', async () => {
    mockIsConfigured.mockReturnValue(true);
    mockLoadSettings.mockReturnValue({
      enabled: true,
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      apiKey: 'sk-test',
      refineTranscript: false,
      speechLocale: 'auto',
      voiceInputMode: 'apple-speech',
      confirmBeforeSend: false,
    });
    vi.mocked(AnthropicProvider).mockImplementation(function() {
      return { routeVoiceCommand: vi.fn().mockRejectedValue(new Error('network')), testConnection: vi.fn() } as any;
    } as any);

    const result = await routeVoiceCommand({
      voiceInput: 'test',
      sessions,
      focusedSessionId: 'sess-1',
    });

    expect(result.targetSessionId).toBe('sess-1');
    expect(result.confidence).toBe('fallback');
  });
});

// ============================================================================
// testLLMConnection
// ============================================================================

describe('testLLMConnection', () => {
  it('returns error when no API key', async () => {
    mockLoadSettings.mockReturnValue({
      enabled: false,
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      apiKey: '',
      refineTranscript: true,
      speechLocale: 'auto',
      voiceInputMode: 'apple-speech',
      confirmBeforeSend: false,
    });

    const result = await testLLMConnection();
    expect(result.success).toBe(false);
    expect(result.error).toContain('No API key');
  });

  it('returns success when provider test passes', async () => {
    mockLoadSettings.mockReturnValue({
      enabled: true,
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      apiKey: 'sk-test',
      refineTranscript: true,
      speechLocale: 'auto',
      voiceInputMode: 'apple-speech',
      confirmBeforeSend: false,
    });
    vi.mocked(AnthropicProvider).mockImplementation(function() {
      return { routeVoiceCommand: vi.fn(), testConnection: vi.fn().mockResolvedValue(true) } as any;
    } as any);

    const result = await testLLMConnection();
    expect(result.success).toBe(true);
  });

  it('returns error message on provider failure', async () => {
    mockLoadSettings.mockReturnValue({
      enabled: true,
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'sk-openai',
      refineTranscript: true,
      speechLocale: 'auto',
      voiceInputMode: 'apple-speech',
      confirmBeforeSend: false,
    });
    vi.mocked(OpenAIProvider).mockImplementation(function() {
      return { routeVoiceCommand: vi.fn(), testConnection: vi.fn().mockRejectedValue(new Error('Invalid API key')) } as any;
    } as any);

    const result = await testLLMConnection();
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid API key');
  });

  it('returns unsupported for unknown provider', async () => {
    mockLoadSettings.mockReturnValue({
      enabled: true,
      provider: 'unknown-provider' as any,
      model: 'x',
      apiKey: 'key',
      refineTranscript: true,
      speechLocale: 'auto',
      voiceInputMode: 'apple-speech',
      confirmBeforeSend: false,
    });

    const result = await testLLMConnection();
    expect(result.success).toBe(false);
    expect(result.error).toContain('not supported');
  });
});
