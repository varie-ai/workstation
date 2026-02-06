/**
 * LLM Types for Voice Routing
 *
 * Type definitions for LLM settings, providers, and routing decisions.
 */

// ============================================================================
// Provider & Model Configuration
// ============================================================================

export type LLMProvider = 'anthropic' | 'openai' | 'google';

export interface ModelInfo {
  id: string;
  name: string;
  type: 'fast' | 'balanced' | 'flagship';
}

export const PROVIDER_MODELS: Record<LLMProvider, ModelInfo[]> = {
  anthropic: [
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', type: 'fast' },
    { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', type: 'balanced' },
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', type: 'flagship' },
  ],
  openai: [
    { id: 'gpt-5-mini', name: 'GPT-5 Mini', type: 'fast' },
    { id: 'gpt-5', name: 'GPT-5', type: 'balanced' },
    { id: 'gpt-5.2', name: 'GPT-5.2', type: 'flagship' },
  ],
  google: [
    { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash', type: 'fast' },
    { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro', type: 'flagship' },
  ],
};

// Default models for routing (fast models recommended)
export const DEFAULT_MODELS: Record<LLMProvider, string> = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-5-mini',
  google: 'gemini-3-flash-preview',
};

// ============================================================================
// Speech Locale
// ============================================================================

export type SpeechLocale = 'auto' | 'en-US' | 'zh-CN' | 'zh-TW' | 'ja-JP' | 'ko-KR' | 'es-ES' | 'fr-FR' | 'de-DE';

export const SPEECH_LOCALES: Array<{ id: SpeechLocale; name: string }> = [
  { id: 'auto', name: 'Auto-detect' },
  { id: 'en-US', name: 'English (US)' },
  { id: 'zh-CN', name: '中文 (简体)' },
  { id: 'zh-TW', name: '中文 (繁體)' },
  { id: 'ja-JP', name: '日本語' },
  { id: 'ko-KR', name: '한국어' },
  { id: 'es-ES', name: 'Español' },
  { id: 'fr-FR', name: 'Français' },
  { id: 'de-DE', name: 'Deutsch' },
];

// ============================================================================
// Settings
// ============================================================================

export type VoiceInputMode = 'apple-speech' | 'direct-audio';

export interface LLMSettings {
  provider: LLMProvider;
  model: string;
  apiKey: string;
  enabled: boolean;
  refineTranscript: boolean;  // Fix grammar, punctuation, project names
  speechLocale: SpeechLocale; // Speech recognition language
  voiceInputMode: VoiceInputMode; // apple-speech (fast, offline) or direct-audio (accurate, requires API)
  confirmBeforeSend: boolean; // Wait for user to press Enter instead of auto-sending
}

export const DEFAULT_LLM_SETTINGS: LLMSettings = {
  provider: 'anthropic',
  model: DEFAULT_MODELS.anthropic,
  apiKey: '',
  enabled: false,
  refineTranscript: true,     // On by default when LLM routing is enabled
  speechLocale: 'auto',       // Auto-detect by default
  voiceInputMode: 'apple-speech', // Default to fast offline mode
  confirmBeforeSend: false,   // Default to auto-send (current behavior)
};

// ============================================================================
// Routing
// ============================================================================

export type RoutingConfidence = 'strong' | 'weak' | 'unknown';

export interface RoutingDecision {
  targetSessionId: string;
  confidence: RoutingConfidence;
  reasoning?: string;
  refinedTranscript?: string;  // Cleaned up transcript with grammar/punctuation fixes
}

export interface SessionSummary {
  id: string;
  repo: string;
  taskId?: string;
  status: 'active' | 'idle';
  lastActivity?: string;
}

export interface RoutingContext {
  sessions: SessionSummary[];
  voiceInput: string;
  focusedSessionId?: string;
  refineTranscript?: boolean;  // Whether to also refine/correct the transcript
  allProjectNames?: string[];  // All known project names (for transcript refinement context)
}

// ============================================================================
// Provider Interface
// ============================================================================

export interface LLMProviderInterface {
  /**
   * Route a voice command to the appropriate session.
   * Uses structured output to guarantee valid response schema.
   */
  routeVoiceCommand(context: RoutingContext): Promise<RoutingDecision>;

  /**
   * Route a voice command using direct audio input.
   * The LLM performs speech-to-text and routing in one call.
   * Not all providers support this - check supportsAudioInput().
   */
  routeVoiceCommandWithAudio?(audioPath: string, context: RoutingContext): Promise<RoutingDecision>;

  /**
   * Check if this provider supports direct audio input.
   */
  supportsAudioInput?(): boolean;

  /**
   * Test the connection to the LLM provider.
   * Returns true if the API key is valid and the provider is reachable.
   */
  testConnection(): Promise<boolean>;
}
