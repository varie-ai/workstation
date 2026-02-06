/**
 * Voice Router
 *
 * Routes voice commands to the appropriate session using LLM-based routing.
 * Falls back to focused session when LLM routing is disabled or fails.
 */

import { log } from '../logger';
import { loadLLMSettings, isLLMRoutingConfigured, loadAllProjectNames } from './settings';
import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';
import { GoogleProvider } from './google';
import {
  LLMProviderInterface,
  RoutingContext,
  RoutingDecision,
  SessionSummary,
} from './types';

// Re-export RoutingDecision for the let declaration
type RoutingDecisionType = RoutingDecision;

// ============================================================================
// Provider Factory
// ============================================================================

function createProvider(): LLMProviderInterface | null {
  const settings = loadLLMSettings();

  if (!settings.enabled || !settings.apiKey) {
    return null;
  }

  switch (settings.provider) {
    case 'anthropic':
      return new AnthropicProvider(settings.apiKey, settings.model);

    case 'openai':
      return new OpenAIProvider(settings.apiKey, settings.model);

    case 'google':
      return new GoogleProvider(settings.apiKey, settings.model);

    default:
      log('WARN', `Unknown provider: ${settings.provider}`);
      return null;
  }
}

// ============================================================================
// Voice Router
// ============================================================================

export interface RouteVoiceCommandOptions {
  voiceInput: string;
  sessions: SessionSummary[];
  focusedSessionId?: string;
  managerSessionId?: string;
  refineTranscript?: boolean;
  audioPath?: string;  // Path to audio file for direct audio mode
}

export interface RouteVoiceCommandResult {
  targetSessionId: string;
  confidence: 'strong' | 'weak' | 'unknown' | 'direct' | 'fallback';
  reasoning?: string;
  usedLLM: boolean;
  refinedTranscript?: string;
}

/**
 * Route a voice command to the appropriate session.
 *
 * When LLM routing is enabled and configured:
 * - Uses the configured LLM provider to make routing decisions
 * - Returns confidence level from the LLM
 *
 * When LLM routing is disabled:
 * - Routes directly to the focused session
 * - Returns 'direct' confidence
 *
 * When LLM routing is enabled but fails (API error, etc.):
 * - Falls back to Manager session (smart fallback)
 * - Returns 'fallback' confidence
 */
export async function routeVoiceCommand(
  options: RouteVoiceCommandOptions
): Promise<RouteVoiceCommandResult> {
  const { voiceInput, sessions, focusedSessionId, managerSessionId, refineTranscript, audioPath } = options;

  // Check if LLM routing is configured
  if (!isLLMRoutingConfigured()) {
    log('INFO', 'Router: LLM routing not configured, using direct routing');
    return directRoute(focusedSessionId, managerSessionId);
  }

  // Create provider
  const provider = createProvider();
  if (!provider) {
    log('INFO', 'Router: Could not create provider, falling back to Manager');
    return fallbackRoute(managerSessionId, focusedSessionId, 'Could not create LLM provider');
  }

  // Load all known project names for transcript refinement context
  const allProjectNames = loadAllProjectNames();

  // Build context
  const context: RoutingContext = {
    voiceInput,
    sessions,
    focusedSessionId,
    refineTranscript,
    allProjectNames,
  };

  try {
    let decision: RoutingDecision;

    // Use audio routing if audioPath is provided and provider supports it
    if (audioPath && provider.supportsAudioInput?.() && provider.routeVoiceCommandWithAudio) {
      log('INFO', 'Router: Using direct audio routing');
      decision = await provider.routeVoiceCommandWithAudio(audioPath, context);
    } else {
      // Use text-based routing
      decision = await provider.routeVoiceCommand(context);
    }

    // Validate target session exists
    const targetExists =
      decision.targetSessionId === 'manager' ||
      sessions.some((s) => s.id === decision.targetSessionId);

    if (!targetExists) {
      log('WARN', `Router: LLM returned invalid session ID: ${decision.targetSessionId}`);
      // Fall back to manager
      return {
        targetSessionId: managerSessionId || focusedSessionId || 'unknown',
        confidence: 'unknown',
        reasoning: 'LLM returned invalid session, routed to manager',
        usedLLM: true,
      };
    }

    // Map 'manager' to actual manager session ID
    const actualTargetId =
      decision.targetSessionId === 'manager'
        ? managerSessionId || focusedSessionId || sessions[0]?.id || 'unknown'
        : decision.targetSessionId;

    // When confidence is weak, route to Manager for additional verification
    // Manager can review and route manually if needed
    if (decision.confidence === 'weak' && managerSessionId && actualTargetId !== managerSessionId) {
      log('INFO', `Router: Weak confidence (${decision.reasoning}), routing to Manager for verification`);
      return {
        targetSessionId: managerSessionId,
        confidence: 'weak',
        reasoning: `Weak confidence routing to Manager: ${decision.reasoning}`,
        usedLLM: true,
        refinedTranscript: decision.refinedTranscript,
      };
    }

    return {
      targetSessionId: actualTargetId,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      usedLLM: true,
      refinedTranscript: decision.refinedTranscript,
    };
  } catch (err) {
    log('ERROR', 'Router: LLM routing failed, falling back to Manager:', err);
    return fallbackRoute(managerSessionId, focusedSessionId, 'LLM routing failed');
  }
}

/**
 * Direct routing (no LLM configured) - go to focused session.
 * Used when user has disabled LLM routing.
 */
function directRoute(
  focusedSessionId?: string,
  managerSessionId?: string
): RouteVoiceCommandResult {
  const targetSessionId = focusedSessionId || managerSessionId || 'unknown';
  return {
    targetSessionId,
    confidence: 'direct',
    reasoning: 'Direct routing to focused session (LLM routing disabled)',
    usedLLM: false,
  };
}

/**
 * Fallback routing (LLM configured but failed) - go to Manager.
 * Used when user enabled LLM routing but it failed (API error, etc.).
 * Manager can interpret the command and route manually.
 */
function fallbackRoute(
  managerSessionId?: string,
  focusedSessionId?: string,
  reason?: string
): RouteVoiceCommandResult {
  // Prefer Manager when LLM was configured but failed
  const targetSessionId = managerSessionId || focusedSessionId || 'unknown';
  return {
    targetSessionId,
    confidence: 'fallback',
    reasoning: `LLM routing fallback to Manager: ${reason || 'unknown error'}`,
    usedLLM: false,
  };
}

/**
 * Test the LLM connection with current settings.
 * Note: This bypasses the 'enabled' check so users can test their API key
 * before enabling routing.
 */
export async function testLLMConnection(): Promise<{
  success: boolean;
  error?: string;
}> {
  const settings = loadLLMSettings();

  if (!settings.apiKey) {
    return { success: false, error: 'No API key configured' };
  }

  // Create provider directly (bypassing enabled check for testing)
  let provider: LLMProviderInterface | null = null;
  switch (settings.provider) {
    case 'anthropic':
      provider = new AnthropicProvider(settings.apiKey, settings.model);
      break;
    case 'openai':
      provider = new OpenAIProvider(settings.apiKey, settings.model);
      break;
    case 'google':
      provider = new GoogleProvider(settings.apiKey, settings.model);
      break;
    default:
      return { success: false, error: `Provider '${settings.provider}' not supported` };
  }

  try {
    const success = await provider.testConnection();
    return { success };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

/**
 * Check if LLM routing is available and configured.
 */
export function isLLMRoutingAvailable(): boolean {
  return isLLMRoutingConfigured();
}
