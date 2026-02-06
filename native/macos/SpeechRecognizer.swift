#!/usr/bin/env swift

/**
 * Native macOS Speech Recognition CLI
 *
 * Usage:
 *   swift SpeechRecognizer.swift                              # Start listening (auto-detect language)
 *   swift SpeechRecognizer.swift --locale en-US              # Start listening with specific locale
 *   swift SpeechRecognizer.swift --locale auto               # Explicitly use auto-detect
 *   swift SpeechRecognizer.swift --audio-output /tmp/out.wav # Also save audio to file
 *   swift SpeechRecognizer.swift --check                     # Check if speech recognition is available
 *
 * Supported locales: en-US, zh-CN, zh-TW, ja-JP, ko-KR, es-ES, fr-FR, de-DE, auto
 *
 * Output format (JSON lines):
 *   {"type": "status", "status": "listening"}
 *   {"type": "interim", "transcript": "hello"}
 *   {"type": "final", "transcript": "hello world", "confidence": 0.95, "audioPath": "/tmp/out.wav"}
 *   {"type": "error", "message": "..."}
 *   {"type": "end"}
 *
 * Requirements:
 *   - macOS 10.15+
 *   - Microphone permission (granted via System Preferences)
 */

import Foundation
import Speech
import AVFoundation

// MARK: - JSON Output Helpers

func outputJSON(_ dict: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: dict),
       let str = String(data: data, encoding: .utf8) {
        print(str)
        fflush(stdout)
    }
}

func outputStatus(_ status: String) {
    outputJSON(["type": "status", "status": status])
}

func outputInterim(_ transcript: String) {
    outputJSON(["type": "interim", "transcript": transcript])
}

func outputFinal(_ transcript: String, confidence: Float, audioPath: String? = nil) {
    var dict: [String: Any] = ["type": "final", "transcript": transcript, "confidence": confidence]
    if let path = audioPath {
        dict["audioPath"] = path
    }
    outputJSON(dict)
}

func outputError(_ message: String) {
    outputJSON(["type": "error", "message": message])
}

func outputEnd() {
    outputJSON(["type": "end"])
}

// MARK: - Speech Recognizer

class SpeechRecognizerCLI: NSObject, SFSpeechRecognizerDelegate {
    private let speechRecognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private let audioEngine = AVAudioEngine()

    private var lastTranscript = ""
    private var silenceTimer: Timer?
    private let silenceTimeout: TimeInterval = 60.0  // Long timeout - user controls stop via toggle
    private let localeIdentifier: String?

    // Audio file recording
    private let audioOutputPath: String?
    private var audioFile: AVAudioFile?

    init(locale: String?, audioOutput: String? = nil) {
        self.localeIdentifier = locale
        self.audioOutputPath = audioOutput

        // nil or "auto" means use system default (supports mixed languages better)
        if let loc = locale, loc != "auto" {
            self.speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: loc))
        } else {
            // Use default recognizer - better for mixed language input
            self.speechRecognizer = SFSpeechRecognizer()
        }

        super.init()
        self.speechRecognizer?.delegate = self
    }

    convenience override init() {
        self.init(locale: nil, audioOutput: nil)
    }

    func checkAvailability() -> Bool {
        guard let recognizer = speechRecognizer else {
            outputError("Speech recognizer not available for this locale")
            return false
        }

        if !recognizer.isAvailable {
            outputError("Speech recognizer not currently available")
            return false
        }

        outputJSON(["type": "available", "available": true])
        return true
    }

    func requestAuthorization(completion: @escaping (Bool) -> Void) {
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                switch status {
                case .authorized:
                    completion(true)
                case .denied:
                    outputError("Speech recognition permission denied")
                    completion(false)
                case .restricted:
                    outputError("Speech recognition restricted on this device")
                    completion(false)
                case .notDetermined:
                    outputError("Speech recognition permission not determined")
                    completion(false)
                @unknown default:
                    outputError("Unknown authorization status")
                    completion(false)
                }
            }
        }
    }

    func startListening() {
        guard let recognizer = speechRecognizer, recognizer.isAvailable else {
            outputError("Speech recognizer not available")
            exit(1)
        }

        // Note: On macOS, we don't need to configure AVAudioSession like on iOS
        // The audio engine handles microphone access directly

        // Create recognition request
        recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        guard let request = recognitionRequest else {
            outputError("Failed to create recognition request")
            exit(1)
        }

        request.shouldReportPartialResults = true

        // Use on-device recognition if available (iOS 13+, macOS 10.15+)
        if #available(macOS 10.15, *) {
            request.requiresOnDeviceRecognition = false  // Allow cloud for better accuracy
        }

        // Get input node
        let inputNode = audioEngine.inputNode

        // Start recognition task
        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self = self else { return }

            var isFinal = false

            if let result = result {
                let transcript = result.bestTranscription.formattedString
                isFinal = result.isFinal

                if transcript != self.lastTranscript {
                    self.lastTranscript = transcript

                    if isFinal {
                        let confidence = result.bestTranscription.segments.last?.confidence ?? 0.0
                        outputFinal(transcript, confidence: confidence, audioPath: self.audioOutputPath)
                    } else {
                        outputInterim(transcript)
                    }

                    // Reset silence timer on new speech
                    self.resetSilenceTimer()
                }
            }

            if error != nil || isFinal {
                self.stopListening()
                outputEnd()
                exit(0)
            }
        }

        // Configure audio input
        let recordingFormat = inputNode.outputFormat(forBus: 0)

        // Create audio file if output path specified
        if let outputPath = audioOutputPath {
            do {
                let url = URL(fileURLWithPath: outputPath)
                // Use Linear PCM format for WAV compatibility
                let settings: [String: Any] = [
                    AVFormatIDKey: kAudioFormatLinearPCM,
                    AVSampleRateKey: recordingFormat.sampleRate,
                    AVNumberOfChannelsKey: recordingFormat.channelCount,
                    AVLinearPCMBitDepthKey: 16,
                    AVLinearPCMIsFloatKey: false,
                    AVLinearPCMIsBigEndianKey: false
                ]
                audioFile = try AVAudioFile(forWriting: url, settings: settings)
            } catch {
                outputError("Failed to create audio file: \(error.localizedDescription)")
                // Continue without audio recording
            }
        }

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { buffer, _ in
            self.recognitionRequest?.append(buffer)

            // Write to audio file if available
            if let file = self.audioFile {
                do {
                    try file.write(from: buffer)
                } catch {
                    // Silently ignore write errors to not spam output
                }
            }
        }

        // Start audio engine
        audioEngine.prepare()
        do {
            try audioEngine.start()
            outputStatus("listening")

            // Start silence timer
            resetSilenceTimer()
        } catch {
            outputError("Failed to start audio engine: \(error.localizedDescription)")
            exit(1)
        }
    }

    private func resetSilenceTimer() {
        silenceTimer?.invalidate()
        silenceTimer = Timer.scheduledTimer(withTimeInterval: silenceTimeout, repeats: false) { [weak self] _ in
            // Silence detected, end recognition
            self?.stopListening()
            outputEnd()
            exit(0)
        }
    }

    func stopListening() {
        silenceTimer?.invalidate()
        silenceTimer = nil

        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)

        recognitionRequest?.endAudio()
        recognitionRequest = nil

        recognitionTask?.cancel()
        recognitionTask = nil

        // Close audio file
        audioFile = nil
    }

    /// Called when process receives SIGTERM/SIGINT
    /// Output whatever transcript we have before exiting
    func handleTermination() {
        // Output final transcript if we have one
        if !lastTranscript.isEmpty {
            outputFinal(lastTranscript, confidence: 0.8, audioPath: audioOutputPath)  // Assume reasonable confidence
        }
        outputEnd()
        stopListening()
        exit(0)
    }

    // MARK: - SFSpeechRecognizerDelegate

    func speechRecognizer(_ speechRecognizer: SFSpeechRecognizer, availabilityDidChange available: Bool) {
        if !available {
            outputError("Speech recognizer became unavailable")
            stopListening()
            exit(1)
        }
    }
}

// MARK: - Main

let args = CommandLine.arguments

// Parse --locale argument
var localeArg: String? = nil
if let localeIndex = args.firstIndex(of: "--locale"), localeIndex + 1 < args.count {
    localeArg = args[localeIndex + 1]
}

// Parse --audio-output argument
var audioOutputArg: String? = nil
if let audioIndex = args.firstIndex(of: "--audio-output"), audioIndex + 1 < args.count {
    audioOutputArg = args[audioIndex + 1]
}

// Handle --check flag
if args.contains("--check") {
    let recognizer = SpeechRecognizerCLI(locale: localeArg, audioOutput: nil)
    exit(recognizer.checkAvailability() ? 0 : 1)
}

// Main flow: request authorization and start listening
let recognizer = SpeechRecognizerCLI(locale: localeArg, audioOutput: audioOutputArg)

// Handle SIGTERM (sent when Node.js kills the process)
// Output final transcript before exiting
signal(SIGTERM) { _ in
    recognizer.handleTermination()
}

signal(SIGINT) { _ in
    recognizer.handleTermination()
}

recognizer.requestAuthorization { authorized in
    if authorized {
        recognizer.startListening()
    } else {
        exit(1)
    }
}

// Keep the run loop alive
RunLoop.main.run()
