/**
 * Anthropic Provider Implementation
 *
 * Uses Claude's tool_use feature for structured output.
 * Implements the LLMProviderInterface for voice routing.
 */

import { log } from '../logger';
import {
  LLMProviderInterface,
  RoutingContext,
  RoutingDecision,
  RoutingConfidence,
} from './types';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

// ============================================================================
// Routing Tool Schema
// ============================================================================

const ROUTING_TOOL = {
  name: 'route_voice_command',
  description: 'Route a voice command to the appropriate session, optionally refining the transcript first',
  input_schema: {
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
    required: ['target_session_id', 'confidence'],
  },
};

// ============================================================================
// Anthropic Provider
// ============================================================================

export class AnthropicProvider implements LLMProviderInterface {
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

Include a refined_transcript that:
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
Use the route_voice_command tool to respond.

Routing Guidelines:
- If the command clearly matches a session's work context, route there with "strong" confidence
- If the command is ambiguous between sessions, route to "manager" with "weak" confidence
- If the command seems like new work or doesn't match any session, route to "manager" with "unknown" confidence
- If only one session exists and the command isn't clearly unrelated, route there
- Consider the focused session as a tiebreaker when confidence is similar
- Keep reasoning brief (1 sentence max)`;
  }

  /**
   * Route a voice command using Claude's tool_use.
   */
  async routeVoiceCommand(context: RoutingContext): Promise<RoutingDecision> {
    const prompt = this.buildPrompt(context);

    log('INFO', `Anthropic: Routing voice command with ${context.sessions.length} sessions`);

    try {
      const response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 256,
          tools: [ROUTING_TOOL],
          tool_choice: { type: 'tool', name: 'route_voice_command' },
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        log('ERROR', `Anthropic API error: ${response.status} - ${errorText}`);
        throw new Error(`Anthropic API error: ${response.status}`);
      }

      const data = await response.json();

      // Extract tool use from response
      const toolUse = data.content?.find((block: any) => block.type === 'tool_use');
      if (!toolUse || toolUse.name !== 'route_voice_command') {
        log('WARN', 'Anthropic: No tool_use in response, falling back to manager');
        return {
          targetSessionId: 'manager',
          confidence: 'unknown',
          reasoning: 'LLM did not provide routing decision',
        };
      }

      const input = toolUse.input;
      const decision: RoutingDecision = {
        targetSessionId: input.target_session_id || 'manager',
        confidence: isValidConfidence(input.confidence) ? input.confidence : 'unknown',
        reasoning: input.reasoning,
        refinedTranscript: input.refined_transcript,
      };

      if (decision.refinedTranscript) {
        log('INFO', `Anthropic: Refined transcript: "${decision.refinedTranscript}"`);
      }
      log('INFO', `Anthropic: Routing decision: ${decision.targetSessionId} (${decision.confidence})`);
      return decision;
    } catch (err) {
      log('ERROR', 'Anthropic: Failed to route voice command:', err);
      throw err;
    }
  }

  /**
   * Test the API key and connection.
   * Throws an error with details if the test fails.
   */
  async testConnection(): Promise<boolean> {
    log('INFO', `Anthropic: Testing connection with model ${this.model}...`);

    try {
      const response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      if (response.ok) {
        log('INFO', 'Anthropic: Connection test successful');
        return true;
      }

      const errorText = await response.text();
      log('WARN', `Anthropic: Connection test failed: ${response.status} - ${errorText}`);

      // Parse error for better message
      try {
        const errorJson = JSON.parse(errorText);
        const message = errorJson.error?.message || errorText;
        throw new Error(`Anthropic API: ${message}`);
      } catch (parseErr) {
        throw new Error(`Anthropic API error ${response.status}: ${errorText.slice(0, 200)}`);
      }
    } catch (err) {
      log('ERROR', 'Anthropic: Connection test error:', err);
      throw err;
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

function isValidConfidence(value: unknown): value is RoutingConfidence {
  return value === 'strong' || value === 'weak' || value === 'unknown';
}
