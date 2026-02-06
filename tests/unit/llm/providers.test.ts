import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('../../../src/main/logger', () => ({
  log: vi.fn(),
}));

import { AnthropicProvider } from '../../../src/main/llm/anthropic';
import { OpenAIProvider } from '../../../src/main/llm/openai';
import { GoogleProvider } from '../../../src/main/llm/google';
import type { RoutingContext } from '../../../src/main/llm/types';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
});

const baseContext: RoutingContext = {
  voiceInput: 'check the workstation tests',
  sessions: [
    { id: 'sess-1', repo: 'varie-workstation', status: 'active', lastActivity: 'writing tests' },
    { id: 'sess-2', repo: 'varie-avatar', status: 'active', lastActivity: 'fixing bug' },
  ],
  focusedSessionId: 'sess-1',
};

// ============================================================================
// Anthropic Provider
// ============================================================================

describe('AnthropicProvider', () => {
  const provider = new AnthropicProvider('sk-ant-test', 'claude-haiku-4-5');

  describe('routeVoiceCommand', () => {
    it('sends correct request format', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          content: [{
            type: 'tool_use',
            name: 'route_voice_command',
            input: {
              target_session_id: 'sess-1',
              confidence: 'strong',
              reasoning: 'matches workstation',
            },
          }],
        }),
      });

      await provider.routeVoiceCommand(baseContext);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1/messages',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'x-api-key': 'sk-ant-test',
            'anthropic-version': '2023-06-01',
          }),
        }),
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('claude-haiku-4-5');
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0].name).toBe('route_voice_command');
      expect(body.tool_choice.type).toBe('tool');
    });

    it('parses tool_use response correctly', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          content: [{
            type: 'tool_use',
            name: 'route_voice_command',
            input: {
              target_session_id: 'sess-2',
              confidence: 'strong',
              reasoning: 'avatar bug fix',
              refined_transcript: 'Fix the avatar bug.',
            },
          }],
        }),
      });

      const result = await provider.routeVoiceCommand(baseContext);
      expect(result.targetSessionId).toBe('sess-2');
      expect(result.confidence).toBe('strong');
      expect(result.reasoning).toBe('avatar bug fix');
      expect(result.refinedTranscript).toBe('Fix the avatar bug.');
    });

    it('falls back to manager when no tool_use in response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          content: [{ type: 'text', text: 'I am not sure' }],
        }),
      });

      const result = await provider.routeVoiceCommand(baseContext);
      expect(result.targetSessionId).toBe('manager');
      expect(result.confidence).toBe('unknown');
    });

    it('throws on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve('{"error":{"message":"Invalid API key"}}'),
      });

      await expect(provider.routeVoiceCommand(baseContext)).rejects.toThrow('Anthropic API error: 401');
    });

    it('handles invalid confidence from LLM', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          content: [{
            type: 'tool_use',
            name: 'route_voice_command',
            input: {
              target_session_id: 'sess-1',
              confidence: 'very-sure',  // invalid
            },
          }],
        }),
      });

      const result = await provider.routeVoiceCommand(baseContext);
      expect(result.confidence).toBe('unknown');
    });
  });

  describe('testConnection', () => {
    it('returns true on 200', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });
      expect(await provider.testConnection()).toBe(true);
    });

    it('throws with parsed error message on failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve('{"error":{"message":"model not found"}}'),
      });

      await expect(provider.testConnection()).rejects.toThrow('model not found');
    });

    it('throws with raw text when JSON parse fails', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });

      await expect(provider.testConnection()).rejects.toThrow('Anthropic API error 500');
    });

    it('throws on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(provider.testConnection()).rejects.toThrow('ECONNREFUSED');
    });
  });
});

// ============================================================================
// OpenAI Provider
// ============================================================================

describe('OpenAIProvider', () => {
  const provider = new OpenAIProvider('sk-openai-test', 'gpt-5-mini');

  describe('routeVoiceCommand', () => {
    it('sends correct request format', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          choices: [{
            message: {
              content: JSON.stringify({
                target_session_id: 'sess-1',
                confidence: 'strong',
                reasoning: 'test',
                refined_transcript: 'test',
              }),
            },
          }],
        }),
      });

      await provider.routeVoiceCommand(baseContext);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': 'Bearer sk-openai-test',
          }),
        }),
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('gpt-5-mini');
      expect(body.response_format.type).toBe('json_schema');
    });

    it('parses structured output response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          choices: [{
            message: {
              content: JSON.stringify({
                target_session_id: 'sess-2',
                confidence: 'weak',
                reasoning: 'could be either',
                refined_transcript: 'Check the code.',
              }),
            },
          }],
        }),
      });

      const result = await provider.routeVoiceCommand(baseContext);
      expect(result.targetSessionId).toBe('sess-2');
      expect(result.confidence).toBe('weak');
      expect(result.refinedTranscript).toBe('Check the code.');
    });

    it('falls back to manager when no content', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: null } }] }),
      });

      const result = await provider.routeVoiceCommand(baseContext);
      expect(result.targetSessionId).toBe('manager');
      expect(result.confidence).toBe('unknown');
    });

    it('falls back to manager on invalid JSON content', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: 'not json at all' } }],
        }),
      });

      const result = await provider.routeVoiceCommand(baseContext);
      expect(result.targetSessionId).toBe('manager');
      expect(result.confidence).toBe('unknown');
    });

    it('throws on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: () => Promise.resolve('Rate limited'),
      });

      await expect(provider.routeVoiceCommand(baseContext)).rejects.toThrow('OpenAI API error: 429');
    });
  });

  describe('testConnection', () => {
    it('returns true on success', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });
      expect(await provider.testConnection()).toBe(true);
    });

    it('returns false on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      });
      expect(await provider.testConnection()).toBe(false);
    });
  });
});

// ============================================================================
// Google Provider
// ============================================================================

describe('GoogleProvider', () => {
  const provider = new GoogleProvider('goog-test-key', 'gemini-3-flash-preview');

  describe('routeVoiceCommand', () => {
    it('sends correct request format', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify({
                  target_session_id: 'sess-1',
                  confidence: 'strong',
                  reasoning: 'test',
                  refined_transcript: 'test',
                }),
              }],
            },
          }],
        }),
      });

      await provider.routeVoiceCommand(baseContext);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('gemini-3-flash-preview:generateContent'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'x-goog-api-key': 'goog-test-key',
          }),
        }),
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.generationConfig.responseMimeType).toBe('application/json');
      expect(body.generationConfig.responseSchema).toBeDefined();
    });

    it('parses Gemini response structure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify({
                  target_session_id: 'sess-2',
                  confidence: 'strong',
                  reasoning: 'avatar',
                  refined_transcript: 'Fix the avatar.',
                }),
              }],
            },
          }],
        }),
      });

      const result = await provider.routeVoiceCommand(baseContext);
      expect(result.targetSessionId).toBe('sess-2');
      expect(result.confidence).toBe('strong');
      expect(result.refinedTranscript).toBe('Fix the avatar.');
    });

    it('falls back to manager when no candidates', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ candidates: [] }),
      });

      const result = await provider.routeVoiceCommand(baseContext);
      expect(result.targetSessionId).toBe('manager');
    });

    it('throws on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: () => Promise.resolve('Forbidden'),
      });

      await expect(provider.routeVoiceCommand(baseContext)).rejects.toThrow('Gemini API error: 403');
    });
  });

  describe('supportsAudioInput', () => {
    it('returns true', () => {
      expect(provider.supportsAudioInput()).toBe(true);
    });
  });

  describe('testConnection', () => {
    it('returns true on success', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });
      expect(await provider.testConnection()).toBe(true);
    });

    it('returns false on error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve('Bad request'),
      });
      expect(await provider.testConnection()).toBe(false);
    });
  });
});
