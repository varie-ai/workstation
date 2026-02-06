/**
 * OpenAI Provider Implementation
 *
 * Uses OpenAI's structured output (response_format.json_schema) for routing.
 * Implements the LLMProviderInterface for voice routing.
 */

import { log } from '../logger';
import {
  LLMProviderInterface,
  RoutingContext,
  RoutingDecision,
  RoutingConfidence,
} from './types';

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

// ============================================================================
// Routing Schema (JSON Schema for structured output)
// ============================================================================

const ROUTING_SCHEMA = {
  name: 'routing_decision',
  strict: true,
  schema: {
    type: 'object' as const,
    properties: {
      refined_transcript: {
        type: 'string',
        description: 'Cleaned up transcript with grammar fixes, punctuation, and corrected project/repo names',
      },
      target_session_id: {
        type: 'string',
        description: 'Session ID to route to, or "manager" for new work',
      },
      confidence: {
        type: 'string',
        enum: ['strong', 'weak', 'unknown'],
        description: 'Routing confidence level',
      },
      reasoning: {
        type: 'string',
        description: 'Brief explanation of routing decision',
      },
    },
    required: ['refined_transcript', 'target_session_id', 'confidence', 'reasoning'],
    additionalProperties: false,
  },
};

// ============================================================================
// OpenAI Provider
// ============================================================================

export class OpenAIProvider implements LLMProviderInterface {
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
        return `${i + 1}. [${s.id}] ${s.repo}${taskInfo}${activity}`;
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
   * Route a voice command using OpenAI's structured output.
   */
  async routeVoiceCommand(context: RoutingContext): Promise<RoutingDecision> {
    const prompt = this.buildPrompt(context);

    log('INFO', `OpenAI: Routing voice command with ${context.sessions.length} sessions`);

    try {
      const response = await fetch(OPENAI_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          max_completion_tokens: 20480,
          response_format: {
            type: 'json_schema',
            json_schema: ROUTING_SCHEMA,
          },
          messages: [
            {
              role: 'system',
              content: 'You are a voice command router. Route commands to the appropriate session based on context.',
            },
            { role: 'user', content: prompt },
          ],
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        log('ERROR', `OpenAI API error: ${response.status} - ${errorText}`);
        throw new Error(`OpenAI API error: ${response.status}`);
      }

      const data = await response.json();

      // Log full response for debugging
      log('INFO', 'OpenAI: Full API response:', JSON.stringify(data, null, 2));

      // Extract content from response
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        log('WARN', 'OpenAI: No content in response, falling back to manager');
        log('WARN', 'OpenAI: Response structure:', JSON.stringify({
          hasChoices: !!data.choices,
          choicesLength: data.choices?.length,
          firstChoice: data.choices?.[0],
          finishReason: data.choices?.[0]?.finish_reason,
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
        log('WARN', 'OpenAI: Failed to parse response JSON:', content);
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
        log('INFO', `OpenAI: Refined transcript: "${decision.refinedTranscript}"`);
      }

      log('INFO', `OpenAI: Routing decision: ${decision.targetSessionId} (${decision.confidence})`);
      return decision;
    } catch (err) {
      log('ERROR', 'OpenAI: Failed to route voice command:', err);
      throw err;
    }
  }

  /**
   * Test the API key and connection.
   */
  async testConnection(): Promise<boolean> {
    log('INFO', 'OpenAI: Testing connection...');

    try {
      const response = await fetch(OPENAI_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          max_completion_tokens: 10,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      if (response.ok) {
        log('INFO', 'OpenAI: Connection test successful');
        return true;
      }

      const errorText = await response.text();
      log('WARN', `OpenAI: Connection test failed: ${response.status} - ${errorText}`);
      return false;
    } catch (err) {
      log('ERROR', 'OpenAI: Connection test error:', err);
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
