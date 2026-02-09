/**
 * Google Gemini Provider Implementation
 *
 * Uses Google's Gemini API with responseSchema for structured output.
 * Implements the LLMProviderInterface for voice routing.
 *
 * Note: This uses the Gemini API (Google AI Studio), not Vertex AI.
 * Vertex AI would require OAuth2/service account auth instead of API keys.
 */

import * as fs from 'fs';
import { log } from '../logger';
import {
  LLMProviderInterface,
  RoutingContext,
  RoutingDecision,
  RoutingConfidence,
} from './types';

// ============================================================================
// Gemini API Configuration
// ============================================================================

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// ============================================================================
// Routing Schema (JSON Schema for responseSchema)
// ============================================================================

const ROUTING_SCHEMA = {
  type: 'object' as const,
  properties: {
    refined_transcript: {
      type: 'string' as const,
      description: 'Cleaned up transcript with grammar fixes, punctuation, and corrected project/repo names',
    },
    target_session_id: {
      type: 'string' as const,
      description: 'Session ID to route to, or "manager" for new work',
    },
    confidence: {
      type: 'string' as const,
      enum: ['strong', 'weak', 'unknown'],
      description: 'Routing confidence level',
    },
    reasoning: {
      type: 'string' as const,
      description: 'Brief explanation of routing decision',
    },
  },
  required: ['refined_transcript', 'target_session_id', 'confidence', 'reasoning'],
};

// ============================================================================
// Google Provider
// ============================================================================

export class GoogleProvider implements LLMProviderInterface {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey;
    this.model = model;
  }

  /**
   * Build the routing prompt from context.
   */
  private buildPrompt(context: RoutingContext): string {
    const sessionsList = context.sessions
      .map((s, i) => {
        const taskInfo = s.taskId ? ` (${s.taskId})` : '';
        const activity = s.lastActivity ? `: ${s.lastActivity}` : '';
        const context = s.workDescription ? `\n   Context: ${s.workDescription}` : '';
        return `${i + 1}. [${s.id}] ${s.repo}${taskInfo}${activity}${context}`;
      })
      .join('\n');

    // Use all known project names for transcript refinement (not just active sessions)
    const projectNames = context.allProjectNames?.length
      ? context.allProjectNames.join(', ')
      : context.sessions.map((s) => s.repo).join(', ');

    const focusedInfo = context.focusedSessionId
      ? `\n## Currently Focused\nSession: [${context.focusedSessionId}]`
      : '';

    const refineInstructions = context.refineTranscript
      ? `
## Transcript Refinement
The voice input may contain:
- Speech recognition errors (especially for project names)
- Missing punctuation
- Grammar issues from non-native speakers
- Mixed languages (e.g., Chinese with English project names)

Known project/repo names: ${projectNames || 'none'}

First, create a refined_transcript that:
1. Fixes grammar and adds proper punctuation
2. Corrects likely misheard words (especially project names from the list above)
3. Preserves the user's intent even if phrasing is awkward
`
      : '';

    return `## Active Sessions

${sessionsList}
${sessionsList.length === 0 ? '(No active sessions - route to "manager")' : ''}
${focusedInfo}

## Voice Command (raw speech recognition)
"${context.voiceInput}"
${refineInstructions}
## Task
${context.refineTranscript ? 'Refine the transcript AND determine' : 'Determine'} which session should receive this voice command.

Routing Guidelines:
- If the command clearly matches a session's work context, route there with "strong" confidence
- If the command is ambiguous between sessions, route to "manager" with "weak" confidence
- If the command seems like new work or doesn't match any session, route to "manager" with "unknown" confidence
- If only one session exists and the command isn't clearly unrelated, route there
- Consider the focused session as a tiebreaker when confidence is similar
- Keep reasoning brief (1 sentence max)`;
  }

  /**
   * Route a voice command using Gemini's structured output.
   */
  async routeVoiceCommand(context: RoutingContext): Promise<RoutingDecision> {
    const prompt = this.buildPrompt(context);
    const apiUrl = `${GEMINI_API_BASE}/${this.model}:generateContent`;

    log('INFO', `Gemini: Routing voice command with ${context.sessions.length} sessions`);

    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: `You are a voice command router. Route commands to the appropriate session based on context.\n\n${prompt}`,
                },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: ROUTING_SCHEMA,
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        log('ERROR', `Gemini API error: ${response.status} - ${errorText}`);
        throw new Error(`Gemini API error: ${response.status}`);
      }

      const data = await response.json();

      // Log full response for debugging
      log('INFO', 'Gemini: Full API response:', JSON.stringify(data, null, 2));

      // Extract content from Gemini response structure
      const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!content) {
        log('WARN', 'Gemini: No content in response, falling back to manager');
        log('WARN', 'Gemini: Response structure:', JSON.stringify({
          hasCandidates: !!data.candidates,
          candidatesLength: data.candidates?.length,
          firstCandidate: data.candidates?.[0],
        }));
        return {
          targetSessionId: 'manager',
          confidence: 'unknown',
          reasoning: 'LLM did not provide routing decision',
        };
      }

      // Parse JSON response
      let parsed: any;
      try {
        parsed = JSON.parse(content);
      } catch (parseErr) {
        log('WARN', 'Gemini: Failed to parse response JSON:', content);
        return {
          targetSessionId: 'manager',
          confidence: 'unknown',
          reasoning: 'Failed to parse LLM response',
        };
      }

      const decision: RoutingDecision = {
        targetSessionId: parsed.target_session_id || 'manager',
        confidence: isValidConfidence(parsed.confidence) ? parsed.confidence : 'unknown',
        reasoning: parsed.reasoning,
        refinedTranscript: parsed.refined_transcript,
      };

      if (decision.refinedTranscript) {
        log('INFO', `Gemini: Refined transcript: "${decision.refinedTranscript}"`);
      }

      log('INFO', `Gemini: Routing decision: ${decision.targetSessionId} (${decision.confidence})`);
      return decision;
    } catch (err) {
      log('ERROR', 'Gemini: Failed to route voice command:', err);
      throw err;
    }
  }

  /**
   * Check if this provider supports direct audio input.
   */
  supportsAudioInput(): boolean {
    return true;  // Gemini supports audio input
  }

  /**
   * Route a voice command using direct audio input.
   * Gemini performs speech-to-text and routing in one call.
   */
  async routeVoiceCommandWithAudio(audioPath: string, context: RoutingContext): Promise<RoutingDecision> {
    const apiUrl = `${GEMINI_API_BASE}/${this.model}:generateContent`;

    log('INFO', `Gemini: Routing voice command with audio file: ${audioPath}`);

    // Read and base64 encode the audio file
    let audioBase64: string;
    try {
      const audioBuffer = fs.readFileSync(audioPath);
      audioBase64 = audioBuffer.toString('base64');
      log('INFO', `Gemini: Audio file size: ${audioBuffer.length} bytes`);
    } catch (err) {
      log('ERROR', 'Gemini: Failed to read audio file:', err);
      throw new Error(`Failed to read audio file: ${err}`);
    }

    // Build context prompt (without the voice input text since we're sending audio)
    const prompt = this.buildAudioPrompt(context);

    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                {
                  inline_data: {
                    mime_type: 'audio/wav',
                    data: audioBase64,
                  },
                },
                {
                  text: prompt,
                },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: ROUTING_SCHEMA,
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        log('ERROR', `Gemini API error (audio): ${response.status} - ${errorText}`);
        throw new Error(`Gemini API error: ${response.status}`);
      }

      const data = await response.json();

      // Log full response for debugging
      log('INFO', 'Gemini (audio): Full API response:', JSON.stringify(data, null, 2));

      // Extract content from Gemini response structure
      const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!content) {
        log('WARN', 'Gemini (audio): No content in response, falling back to manager');
        return {
          targetSessionId: 'manager',
          confidence: 'unknown',
          reasoning: 'LLM did not provide routing decision',
        };
      }

      // Parse JSON response
      let parsed: any;
      try {
        parsed = JSON.parse(content);
      } catch (parseErr) {
        log('WARN', 'Gemini (audio): Failed to parse response JSON:', content);
        return {
          targetSessionId: 'manager',
          confidence: 'unknown',
          reasoning: 'Failed to parse LLM response',
        };
      }

      const decision: RoutingDecision = {
        targetSessionId: parsed.target_session_id || 'manager',
        confidence: isValidConfidence(parsed.confidence) ? parsed.confidence : 'unknown',
        reasoning: parsed.reasoning,
        refinedTranscript: parsed.refined_transcript,  // This is the LLM's transcription
      };

      log('INFO', `Gemini (audio): Transcribed: "${decision.refinedTranscript}"`);
      log('INFO', `Gemini (audio): Routing decision: ${decision.targetSessionId} (${decision.confidence})`);
      return decision;
    } catch (err) {
      log('ERROR', 'Gemini (audio): Failed to route voice command:', err);
      throw err;
    }
  }

  /**
   * Build the routing prompt for audio input (no voiceInput text).
   */
  private buildAudioPrompt(context: RoutingContext): string {
    const sessionsList = context.sessions
      .map((s, i) => {
        const taskInfo = s.taskId ? ` (${s.taskId})` : '';
        const activity = s.lastActivity ? `: ${s.lastActivity}` : '';
        const context = s.workDescription ? `\n   Context: ${s.workDescription}` : '';
        return `${i + 1}. [${s.id}] ${s.repo}${taskInfo}${activity}${context}`;
      })
      .join('\n');

    // Use all known project names for better transcription
    const projectNames = context.allProjectNames?.length
      ? context.allProjectNames.join(', ')
      : context.sessions.map((s) => s.repo).join(', ');

    const focusedInfo = context.focusedSessionId
      ? `\n## Currently Focused\nSession: [${context.focusedSessionId}]`
      : '';

    return `You are a voice command router. Listen to the audio and:
1. Transcribe what the user said (put in refined_transcript)
2. Route the command to the appropriate session

## Active Sessions

${sessionsList}
${sessionsList.length === 0 ? '(No active sessions - route to "manager")' : ''}
${focusedInfo}

## Known Project Names
${projectNames || 'none'}

When transcribing, use the project names above to correct any misheard words.

## Routing Guidelines
- If the command clearly matches a session's work context, route there with "strong" confidence
- If the command is ambiguous between sessions, route to "manager" with "weak" confidence
- If the command seems like new work or doesn't match any session, route to "manager" with "unknown" confidence
- If only one session exists and the command isn't clearly unrelated, route there
- Consider the focused session as a tiebreaker when confidence is similar
- Keep reasoning brief (1 sentence max)`;
  }

  /**
   * Test the API key and connection.
   */
  async testConnection(): Promise<boolean> {
    log('INFO', 'Gemini: Testing connection...');
    const apiUrl = `${GEMINI_API_BASE}/${this.model}:generateContent`;

    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: 'Hi' }],
            },
          ],
          generationConfig: {
            maxOutputTokens: 10,
          },
        }),
      });

      if (response.ok) {
        log('INFO', 'Gemini: Connection test successful');
        return true;
      }

      const errorText = await response.text();
      log('WARN', `Gemini: Connection test failed: ${response.status} - ${errorText}`);
      return false;
    } catch (err) {
      log('ERROR', 'Gemini: Connection test error:', err);
      return false;
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

function isValidConfidence(value: unknown): value is RoutingConfidence {
  return value === 'strong' || value === 'weak' || value === 'unknown';
}
