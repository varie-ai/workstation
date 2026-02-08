/**
 * LLM Module - Voice Routing
 *
 * Exports all LLM-related functionality for voice command routing.
 */

// Types
export {
  LLMProvider,
  LLMSettings,
  ModelInfo,
  SpeechLocale,
  SpeechEngine,
  RoutingConfidence,
  RoutingDecision,
  RoutingContext,
  SessionSummary,
  PROVIDER_MODELS,
  DEFAULT_MODELS,
  DEFAULT_LLM_SETTINGS,
  SPEECH_LOCALES,
} from './types';

// Settings
export {
  loadLLMSettings,
  saveLLMSettings,
  clearSettingsCache,
  getLLMConfigPath,
  getModelsForProvider,
  isLLMRoutingConfigured,
  loadAllProjectNames,
} from './settings';

// Router
export {
  routeVoiceCommand,
  testLLMConnection,
  isLLMRoutingAvailable,
  RouteVoiceCommandOptions,
  RouteVoiceCommandResult,
} from './router';
