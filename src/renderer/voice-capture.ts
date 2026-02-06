/**
 * Voice Capture Module for Varie Workstation
 *
 * Phase 1: Uses Web Speech API (Chromium's SpeechRecognition)
 * Future: Can swap in native Apple Speech, Whisper, etc.
 */

// Web Speech API types (not fully typed in standard lib)
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionResultList {
  length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
  isFinal: boolean;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message: string;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
  onaudiostart: (() => void) | null;
  onaudioend: (() => void) | null;
}

declare global {
  interface Window {
    SpeechRecognition: new () => SpeechRecognition;
    webkitSpeechRecognition: new () => SpeechRecognition;
  }
}

// Voice capture status
export type VoiceStatus =
  | 'idle'           // Not recording
  | 'listening'      // Waiting for speech
  | 'recording'      // Speech detected, recording
  | 'processing'     // Processing speech
  | 'error';         // Error occurred

export interface VoiceResult {
  transcript: string;
  confidence: number;
  isFinal: boolean;
}

export interface VoiceCaptureOptions {
  language?: string;          // Default: 'en-US'
  continuous?: boolean;       // Keep listening after result (default: false for push-to-talk)
  interimResults?: boolean;   // Show partial results (default: true)
}

type StatusCallback = (status: VoiceStatus, message?: string) => void;
type ResultCallback = (result: VoiceResult) => void;
type FinalCallback = (transcript: string) => void;

/**
 * VoiceCapture - Handles speech-to-text capture
 *
 * Usage:
 *   const voice = new VoiceCapture();
 *   voice.onStatus((status) => updateUI(status));
 *   voice.onResult((result) => showInterim(result));
 *   voice.onFinal((transcript) => dispatch(transcript));
 *
 *   // Push-to-talk
 *   voice.start();   // On key down
 *   voice.stop();    // On key up
 *
 *   // Toggle mode
 *   voice.toggle();  // Start/stop
 */
export class VoiceCapture {
  private recognition: SpeechRecognition | null = null;
  private status: VoiceStatus = 'idle';
  private statusCallbacks: StatusCallback[] = [];
  private resultCallbacks: ResultCallback[] = [];
  private finalCallbacks: FinalCallback[] = [];
  private options: Required<VoiceCaptureOptions>;
  private interimTranscript: string = '';
  private finalTranscript: string = '';
  private isSupported: boolean = false;

  constructor(options: VoiceCaptureOptions = {}) {
    this.options = {
      language: options.language ?? 'en-US',
      continuous: options.continuous ?? false,
      interimResults: options.interimResults ?? true,
    };

    this.isSupported = this.checkSupport();
    if (this.isSupported) {
      this.initRecognition();
    }
  }

  /**
   * Check if Web Speech API is available
   */
  private checkSupport(): boolean {
    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
    return !!SpeechRecognitionAPI;
  }

  /**
   * Initialize the speech recognition instance
   */
  private initRecognition(): void {
    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionAPI) return;

    this.recognition = new SpeechRecognitionAPI();
    this.recognition.continuous = this.options.continuous;
    this.recognition.interimResults = this.options.interimResults;
    this.recognition.lang = this.options.language;
    this.recognition.maxAlternatives = 1;

    // Event handlers
    this.recognition.onstart = () => {
      this.setStatus('listening');
    };

    this.recognition.onspeechstart = () => {
      this.setStatus('recording');
    };

    this.recognition.onspeechend = () => {
      this.setStatus('processing');
    };

    this.recognition.onresult = (event: SpeechRecognitionEvent) => {
      this.interimTranscript = '';
      this.finalTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0].transcript;
        const confidence = result[0].confidence;

        if (result.isFinal) {
          this.finalTranscript += transcript;
          this.emitResult({ transcript, confidence, isFinal: true });
        } else {
          this.interimTranscript += transcript;
          this.emitResult({ transcript, confidence, isFinal: false });
        }
      }

      // Emit final result when speech ends
      if (this.finalTranscript) {
        this.emitFinal(this.finalTranscript.trim());
      }
    };

    this.recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      const errorMessages: Record<string, string> = {
        'no-speech': 'No speech detected',
        'audio-capture': 'Microphone not available',
        'not-allowed': 'Microphone permission denied',
        'network': 'Network error - speech recognition requires internet',
        'aborted': 'Recognition aborted',
        'service-not-allowed': 'Speech service not allowed',
      };

      const message = errorMessages[event.error] || `Error: ${event.error}`;
      this.setStatus('error', message);

      // Auto-reset to idle after error
      setTimeout(() => {
        if (this.status === 'error') {
          this.setStatus('idle');
        }
      }, 3000);
    };

    this.recognition.onend = () => {
      // Only set to idle if not already in error state
      if (this.status !== 'error') {
        this.setStatus('idle');
      }

      // Emit final if we have interim results but no final
      if (this.interimTranscript && !this.finalTranscript) {
        this.emitFinal(this.interimTranscript.trim());
      }
    };
  }

  /**
   * Check if voice capture is supported
   */
  public available(): boolean {
    return this.isSupported;
  }

  /**
   * Get current status
   */
  public getStatus(): VoiceStatus {
    return this.status;
  }

  /**
   * Start voice capture
   */
  public start(): boolean {
    if (!this.recognition) {
      this.setStatus('error', 'Speech recognition not supported');
      return false;
    }

    if (this.status !== 'idle') {
      return false;
    }

    try {
      this.interimTranscript = '';
      this.finalTranscript = '';
      this.recognition.start();
      return true;
    } catch (err) {
      this.setStatus('error', `Failed to start: ${err}`);
      return false;
    }
  }

  /**
   * Stop voice capture
   */
  public stop(): void {
    if (!this.recognition) return;

    if (this.status === 'listening' || this.status === 'recording') {
      this.recognition.stop();
    }
  }

  /**
   * Abort voice capture (discard results)
   */
  public abort(): void {
    if (!this.recognition) return;

    this.interimTranscript = '';
    this.finalTranscript = '';
    this.recognition.abort();
    this.setStatus('idle');
  }

  /**
   * Toggle voice capture (start if idle, stop if active)
   */
  public toggle(): boolean {
    if (this.status === 'idle') {
      return this.start();
    } else {
      this.stop();
      return true;
    }
  }

  /**
   * Check if currently capturing
   */
  public isActive(): boolean {
    return this.status === 'listening' || this.status === 'recording' || this.status === 'processing';
  }

  // Event subscription methods
  public onStatus(callback: StatusCallback): () => void {
    this.statusCallbacks.push(callback);
    return () => {
      this.statusCallbacks = this.statusCallbacks.filter(cb => cb !== callback);
    };
  }

  public onResult(callback: ResultCallback): () => void {
    this.resultCallbacks.push(callback);
    return () => {
      this.resultCallbacks = this.resultCallbacks.filter(cb => cb !== callback);
    };
  }

  public onFinal(callback: FinalCallback): () => void {
    this.finalCallbacks.push(callback);
    return () => {
      this.finalCallbacks = this.finalCallbacks.filter(cb => cb !== callback);
    };
  }

  // Internal event emitters
  private setStatus(status: VoiceStatus, message?: string): void {
    this.status = status;
    this.statusCallbacks.forEach(cb => cb(status, message));
  }

  private emitResult(result: VoiceResult): void {
    this.resultCallbacks.forEach(cb => cb(result));
  }

  private emitFinal(transcript: string): void {
    this.finalCallbacks.forEach(cb => cb(transcript));
  }

  /**
   * Clean up resources
   */
  public dispose(): void {
    if (this.recognition) {
      this.recognition.abort();
      this.recognition = null;
    }
    this.statusCallbacks = [];
    this.resultCallbacks = [];
    this.finalCallbacks = [];
  }
}
