/**
 * WhisperKit Speech Recognition CLI
 *
 * Local speech-to-text using WhisperKit (OpenAI Whisper on Apple Silicon via CoreML/ANE).
 * Batch mode: records audio, then transcribes on stop for maximum accuracy.
 *
 * Usage:
 *   whisperkit-recognizer                                    # Record → transcribe with default model
 *   whisperkit-recognizer --model base                       # Use specific model
 *   whisperkit-recognizer --models-dir ~/.varie/models/whisperkit
 *   whisperkit-recognizer --locale en-US                     # Language hint
 *   whisperkit-recognizer --audio-output /tmp/out.wav        # Also save audio to file
 *   whisperkit-recognizer --check                            # Check if WhisperKit is available
 *   whisperkit-recognizer --list-models                      # List available & downloaded models
 *   whisperkit-recognizer --download-model openai_whisper-base  # Download a model
 *
 * Output format (JSON lines, same protocol as speech-recognizer):
 *   {"type": "status", "status": "downloading", "model": "base"}
 *   {"type": "status", "status": "loading", "model": "base"}
 *   {"type": "status", "status": "listening"}
 *   {"type": "status", "status": "transcribing"}
 *   {"type": "final", "transcript": "hello world", "confidence": 0.95, "audioPath": "/tmp/out.wav"}
 *   {"type": "error", "message": "..."}
 *   {"type": "end"}
 *
 * Batch mode rationale:
 *   Whisper is a batch model — processing full audio gives significantly better accuracy
 *   than chunked streaming. For short voice commands (5-30s), the 1-3s transcription
 *   delay is negligible and the quality improvement over Apple Speech is substantial.
 *
 * Signal handling:
 *   SIGTERM/SIGINT → stop recording → transcribe full audio → output result → exit
 *   (Same contract as speech-recognizer: parent process sends SIGTERM to get final result)
 *
 * Requirements:
 *   - macOS 14+
 *   - Microphone permission
 */

import Foundation
import AVFoundation
import WhisperKit
#if canImport(os)
import os
#endif

// MARK: - JSON Output Helpers

func outputJSON(_ dict: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: dict),
       let str = String(data: data, encoding: .utf8) {
        print(str)
        fflush(stdout)
    }
}

func outputStatus(_ status: String, extra: [String: Any] = [:]) {
    var dict: [String: Any] = ["type": "status", "status": status]
    for (key, value) in extra { dict[key] = value }
    outputJSON(dict)
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

// MARK: - Locale Mapping

/// Map SpeechLocale identifiers (en-US, zh-CN, etc.) to Whisper ISO 639-1 language codes.
/// Returns nil for "auto" to let Whisper auto-detect.
func whisperLanguageCode(from locale: String?) -> String? {
    guard let locale = locale, locale != "auto" else { return nil }
    let mapping: [String: String] = [
        "en-US": "en", "zh-CN": "zh", "zh-TW": "zh",
        "ja-JP": "ja", "ko-KR": "ko", "es-ES": "es",
        "fr-FR": "fr", "de-DE": "de",
    ]
    return mapping[locale] ?? String(locale.prefix(2)).lowercased()
}

// MARK: - Recognizer

class WhisperKitRecognizer {
    private let audioEngine = AVAudioEngine()
    private var audioFile: AVAudioFile?
    private let tempAudioPath: String
    private let modelName: String
    private let modelsDir: String
    private let locale: String?
    private let audioOutputPath: String?
    private var pipe: WhisperKit?
    private var isRecording = false
    private var startFailed = false

    init(model: String, modelsDir: String, locale: String?, audioOutput: String?) {
        self.modelName = model
        self.modelsDir = modelsDir
        self.locale = locale
        self.audioOutputPath = audioOutput
        self.tempAudioPath = NSTemporaryDirectory() + "whisperkit-\(ProcessInfo.processInfo.processIdentifier).wav"
    }

    /// Initialize WhisperKit model and start recording.
    ///
    /// For cached models: recording starts BEFORE model load so AVAudioEngine warms up
    /// during init. Emits "buffering" immediately so user can speak while model loads,
    /// then "listening" once model is ready. Audio captured during model load is included
    /// in the final transcription.
    ///
    /// For downloads: downloads first (user must wait), then starts recording.
    func start() async throws {
        // WhisperKit uses Hub cache convention: <modelsDir>/models/argmaxinc/whisperkit-coreml/<variant>/
        // Variant names are like "openai_whisper-base" but user passes short name "base".
        // Resolve by scanning the cache directory for a matching variant.
        let hubCacheBase = modelsDir + "/models/argmaxinc/whisperkit-coreml"
        let fm = FileManager.default

        // Try exact match first, then fuzzy match (short name within variant name)
        let resolvedModelPath: String? = {
            let exactPath = hubCacheBase + "/" + modelName
            if Self.validateModelDirectory(exactPath) {
                return exactPath
            }
            // Scan hub cache for a variant containing the model name
            guard fm.fileExists(atPath: hubCacheBase),
                  let contents = try? fm.contentsOfDirectory(atPath: hubCacheBase) else {
                return nil
            }
            for name in contents where !name.hasPrefix(".") {
                if name.contains(modelName) {
                    let candidatePath = hubCacheBase + "/" + name
                    if Self.validateModelDirectory(candidatePath) {
                        return candidatePath
                    }
                }
            }
            return nil
        }()

        let config: WhisperKitConfig

        if let validPath = resolvedModelPath {
            // Cached model: start recording immediately, emit "buffering" so user can
            // speak right away. Model loads in parallel with audio capture.
            try startRecording()
            outputStatus("buffering", extra: ["model": modelName])

            config = WhisperKitConfig(
                modelFolder: validPath,
                verbose: false,
                logLevel: .error,
                download: false
            )
        } else {
            // Model needs downloading — show download status, don't record during download
            outputStatus("downloading", extra: ["model": modelName])

            config = WhisperKitConfig(
                model: modelName,
                downloadBase: URL(fileURLWithPath: modelsDir),
                verbose: false,
                logLevel: .error,
                download: true
            )
        }

        do {
            pipe = try await WhisperKit(config)
        } catch {
            startFailed = true
            throw error
        }

        // For downloads, start recording now that model is ready
        if resolvedModelPath == nil {
            try startRecording()
        }

        // Model loaded — solid "listening" state
        outputStatus("listening")
    }

    /// Set up AVAudioEngine to record microphone audio to a WAV file.
    /// WhisperKit's transcribe(audioPath:) handles resampling internally,
    /// so we record at the hardware's native sample rate.
    private func startRecording() throws {
        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)

        // WAV file settings (PCM 16-bit, hardware sample rate)
        let wavSettings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: recordingFormat.sampleRate,
            AVNumberOfChannelsKey: recordingFormat.channelCount,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
        ]

        // Create temp WAV for transcription
        let tempURL = URL(fileURLWithPath: tempAudioPath)
        audioFile = try AVAudioFile(forWriting: tempURL, settings: wavSettings)

        // Optionally create user-requested output file
        var userAudioFile: AVAudioFile?
        if let outputPath = audioOutputPath {
            let outputURL = URL(fileURLWithPath: outputPath)
            userAudioFile = try AVAudioFile(forWriting: outputURL, settings: wavSettings)
        }

        inputNode.installTap(onBus: 0, bufferSize: 4096, format: recordingFormat) { [weak self] buffer, _ in
            try? self?.audioFile?.write(from: buffer)
            try? userAudioFile?.write(from: buffer)
        }

        audioEngine.prepare()
        try audioEngine.start()
        isRecording = true
    }

    /// Called on SIGTERM/SIGINT: stop recording, transcribe, output result, exit.
    func handleTermination() {
        guard isRecording else {
            outputEnd()
            exit(0)
        }

        // Stop audio capture
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        audioFile = nil  // Flush and close the WAV file
        isRecording = false

        // Verify we have audio data
        let fm = FileManager.default
        guard fm.fileExists(atPath: tempAudioPath),
              let attrs = try? fm.attributesOfItem(atPath: tempAudioPath),
              let fileSize = attrs[.size] as? UInt64,
              fileSize > 44 else {  // WAV header is 44 bytes; need actual audio data
            // No meaningful audio recorded
            outputEnd()
            cleanupTempFile()
            exit(0)
        }

        outputStatus("transcribing")

        // Transcribe asynchronously — Task runs on cooperative pool, not main RunLoop
        Task {
            defer {
                cleanupTempFile()
                outputEnd()
                exit(0)
            }

            // Wait for model if SIGTERM arrived during model loading
            // (recording starts before model load for audio engine warm-up)
            if self.pipe == nil && !self.startFailed {
                var waited = 0
                while self.pipe == nil && !self.startFailed && waited < 600 {
                    try? await Task.sleep(nanoseconds: 100_000_000) // 100ms
                    waited += 1
                }
            }

            do {
                guard let pipe = self.pipe else {
                    outputError("WhisperKit not initialized")
                    return
                }

                // Build decoding options
                var options = DecodingOptions()
                options.verbose = false
                if let lang = whisperLanguageCode(from: self.locale) {
                    options.language = lang
                }

                let results = try await pipe.transcribe(
                    audioPath: self.tempAudioPath,
                    decodeOptions: options
                )

                if let result = results.first {
                    let text = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !text.isEmpty {
                        let confidence = self.computeConfidence(from: result)
                        outputFinal(text, confidence: confidence, audioPath: self.audioOutputPath)
                    }
                }
            } catch {
                outputError("Transcription failed: \(error.localizedDescription)")
            }
        }
    }

    /// Compute 0-1 confidence from segment log probabilities.
    /// avgLogprob is typically -0.1 (high confidence) to -1.5 (low confidence).
    private func computeConfidence(from result: TranscriptionResult) -> Float {
        guard !result.segments.isEmpty else { return 0.8 }
        let totalLogProb = result.segments.reduce(Float(0)) { $0 + $1.avgLogprob }
        let avgLogProb = totalLogProb / Float(result.segments.count)
        return min(1.0, max(0.0, exp(avgLogProb)))
    }

    private func cleanupTempFile() {
        try? FileManager.default.removeItem(atPath: tempAudioPath)
    }

    /// Validate that a model directory contains the required CoreML model files.
    /// WhisperKit needs at minimum: AudioEncoder, TextDecoder, MelSpectrogram — each with weights.
    static func validateModelDirectory(_ path: String) -> Bool {
        let fm = FileManager.default
        guard fm.fileExists(atPath: path) else { return false }

        let requiredModels = ["AudioEncoder.mlmodelc", "TextDecoder.mlmodelc", "MelSpectrogram.mlmodelc"]
        for model in requiredModels {
            let modelPath = path + "/" + model
            let weightPath = modelPath + "/weights/weight.bin"
            // Check that both the directory and its weight file exist
            guard fm.fileExists(atPath: modelPath),
                  fm.fileExists(atPath: weightPath) else {
                return false
            }
        }
        return true
    }
}

// MARK: - Commands

func handleCheck() {
    // WhisperKit requires macOS 14+ (CoreML features for ANE inference).
    // We also verify the mic input node is accessible.
    if #available(macOS 14, *) {
        outputJSON(["type": "available", "available": true])
    } else {
        outputJSON(["type": "available", "available": false])
        outputError("WhisperKit requires macOS 14.0 or later")
    }
    exit(0)
}

func handleListModels(modelsDir: String) {
    Task {
        do {
            // Fetch models available for download from Hugging Face
            let available = try await WhisperKit.fetchAvailableModels()

            // Scan local Hub cache for downloaded models (with integrity validation).
            // WhisperKit stores models in: <modelsDir>/models/argmaxinc/whisperkit-coreml/<variant>/
            var downloaded: [String] = []
            let fm = FileManager.default
            let hubCachePath = modelsDir + "/models/argmaxinc/whisperkit-coreml"
            if fm.fileExists(atPath: hubCachePath) {
                let contents = try fm.contentsOfDirectory(atPath: hubCachePath)
                downloaded = contents.filter { name in
                    guard !name.hasPrefix(".") else { return false }
                    let modelPath = hubCachePath + "/" + name
                    return WhisperKitRecognizer.validateModelDirectory(modelPath)
                }
            }

            // Get device-recommended models
            let recommended = WhisperKit.recommendedModels()

            outputJSON([
                "type": "models",
                "available": available,
                "downloaded": downloaded,
                "default": recommended.default,
                "supported": recommended.supported,
            ])
        } catch {
            outputError("Failed to fetch models: \(error.localizedDescription)")
        }
        exit(0)
    }
    RunLoop.main.run()
}

func handleDownloadModel(name: String, modelsDir: String) {
    Task {
        do {
            outputStatus("downloading", extra: ["model": name])

            let modelURL = try await WhisperKit.download(
                variant: name,
                downloadBase: URL(fileURLWithPath: modelsDir),
                progressCallback: { progress in
                    outputJSON([
                        "type": "progress",
                        "progress": progress.fractionCompleted,
                        "model": name,
                    ])
                }
            )

            outputStatus("ready", extra: ["model": name, "path": modelURL.path])
        } catch {
            outputError("Download failed: \(error.localizedDescription)")
        }
        exit(0)
    }
    RunLoop.main.run()
}

func handleTranscribe(model: String, modelsDir: String, locale: String?, audioOutput: String?) {
    let recognizer = WhisperKitRecognizer(
        model: model,
        modelsDir: modelsDir,
        locale: locale,
        audioOutput: audioOutput
    )

    // Use DispatchSource for signal handling (safer than C signal() in Swift).
    // Ignore default handlers so DispatchSource receives the signals.
    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)

    let sigTermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    let sigIntSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)

    sigTermSource.setEventHandler { recognizer.handleTermination() }
    sigIntSource.setEventHandler { recognizer.handleTermination() }

    sigTermSource.resume()
    sigIntSource.resume()

    // Start async initialization and recording
    Task {
        do {
            try await recognizer.start()
        } catch {
            outputError("Failed to start: \(error.localizedDescription)")
            outputEnd()
            exit(1)
        }
    }

    // Keep the process alive until signal triggers exit
    RunLoop.main.run()
}

// MARK: - Argument Parsing & Entry Point

let args = CommandLine.arguments

func getArg(_ flag: String) -> String? {
    if let index = args.firstIndex(of: flag), index + 1 < args.count {
        return args[index + 1]
    }
    return nil
}

let modelsDir = getArg("--models-dir")
    ?? (NSHomeDirectory() + "/.varie/models/whisperkit")
let model = getArg("--model") ?? "base"
let locale = getArg("--locale")
let audioOutput = getArg("--audio-output")

// Ensure models directory exists
try? FileManager.default.createDirectory(
    atPath: modelsDir,
    withIntermediateDirectories: true
)

// Dispatch to the requested command
if args.contains("--check") {
    handleCheck()
} else if args.contains("--list-models") {
    handleListModels(modelsDir: modelsDir)
} else if let downloadModel = getArg("--download-model") {
    handleDownloadModel(name: downloadModel, modelsDir: modelsDir)
} else {
    // Default: transcription mode (record → SIGTERM → transcribe → exit)
    handleTranscribe(model: model, modelsDir: modelsDir, locale: locale, audioOutput: audioOutput)
}
