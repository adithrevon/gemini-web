import Foundation
import AVFoundation
import CoreML
import FluidAudio
import os

private let log = Logger(subsystem: "com.prem.SpeechRecognitionKit", category: "ASR")

/// On-device speech recognition service using the Parakeet TDT CoreML model via FluidAudio.
///
/// Drop-in replacement for the existing `SpeechRecognizer` class. Exposes the same
/// `transcript` and `isAvailable` published properties, and `requestAuthorization`,
/// `startTranscribing`, `stopTranscribing` methods.
@MainActor
public class SpeechRecognitionService: ObservableObject {

    // MARK: - Public API

    @Published public private(set) var transcript = ""
    @Published public private(set) var isAvailable = true
    @Published public private(set) var isModelLoaded = false
    @Published public private(set) var isModelLoading = false

    // MARK: - Private State

    private let modelManager: ModelManager
    private var asrManager: AsrManager?
    private var models: AsrModels?
    private var initTask: Task<Void, Never>?
    private var transcribeTask: Task<Void, Never>?
    private var transcriptListenerTask: Task<Void, Never>?
    private let audioCapture = AudioCaptureEngine()
    private let sharedState = SharedTranscriptionState()

    // MARK: - Init

    public init(appGroupIdentifier: String = "group.com.prem.gemini-shared") {
        self.modelManager = ModelManager(appGroupIdentifier: appGroupIdentifier)
    }

    // MARK: - Preload

    /// Call early (e.g. on view appear) to start loading the CoreML model
    /// in the background. First run compiles models (~10-30s), subsequent runs are instant.
    public func preloadModel() {
        guard initTask == nil, asrManager == nil else { return }
        initTask = Task {
            await initializeIfNeeded()
        }
    }

    // MARK: - Authorization

    public nonisolated func requestAuthorization(completion: @escaping @MainActor (Bool) -> Void) {
        AVAudioApplication.requestRecordPermission { granted in
            Task { @MainActor in
                completion(granted)
            }
        }
    }

    // MARK: - Transcription Control

    public func startTranscribing() {
        transcript = ""
        sharedState.setActive(true)

        Task {
            if let existing = initTask {
                await existing.value
            } else {
                await initializeIfNeeded()
            }

            guard isModelLoaded, sharedState.isActive else {
                log.error("Model not loaded or transcription cancelled")
                return
            }

            startAudioCapture()
        }
    }

    public func stopTranscribing() {
        sharedState.setActive(false)
        audioCapture.stop()

        transcribeTask?.cancel()
        transcribeTask = nil
        transcriptListenerTask?.cancel()
        transcriptListenerTask = nil

        if let manager = asrManager {
            let remaining = sharedState.sampleBuffer.drain()
            if remaining.count > 1600 {
                nonisolated(unsafe) let unsafeManager = manager
                Task.detached {
                    do {
                        let result = try await unsafeManager.transcribe(remaining)
                        if !result.text.isEmpty {
                            log.info("Final transcript: '\(result.text)'")
                        }
                    } catch {
                        log.error("Final transcription error: \(error)")
                    }
                }
            }
        } else {
            sharedState.sampleBuffer.drain()
        }
    }

    // MARK: - Internal

    private func initializeIfNeeded() async {
        guard asrManager == nil else { return }

        isModelLoading = true
        do {
            // Use CPU+GPU only — avoid Neural Engine (E5RT) which crashes on iOS 26
            let mlConfig = MLModelConfiguration()
            mlConfig.computeUnits = .cpuAndGPU
            let loadedModels = try await AsrModels.downloadAndLoad(
                configuration: mlConfig, version: .v3
            )
            let manager = AsrManager(config: .default)
            try await manager.initialize(models: loadedModels)
            self.models = loadedModels
            self.asrManager = manager
            self.isModelLoaded = true
            log.info("ASR models loaded successfully")
        } catch {
            log.error("Failed to initialize ASR: \(error)")
            self.isAvailable = false
        }
        isModelLoading = false
    }

    private func startAudioCapture() {
        guard let manager = asrManager else {
            log.error("No asrManager in startAudioCapture")
            return
        }

        let sampleBuf = sharedState.sampleBuffer
        sampleBuf.drain()

        // Start audio capture on a dedicated non-actor queue to avoid
        // _dispatch_assert_queue_fail crash on iOS 26.
        audioCapture.start(sampleBuffer: sampleBuf)

        let (transcriptStream, continuation) = AsyncStream.makeStream(of: String.self)

        transcriptListenerTask = Task {
            for await text in transcriptStream {
                self.transcript = text
            }
        }

        let state = sharedState
        nonisolated(unsafe) let unsafeManager = manager

        transcribeTask = Task.detached {
            let audioConverter = AudioConverter()
            try? await Task.sleep(for: .seconds(2))

            while !Task.isCancelled && state.isActive {
                let sampleCount = sampleBuf.count
                let capturedRate = state.sampleRate
                let minSamples = max(Int(capturedRate), 16000)

                if sampleCount > minSamples && capturedRate > 0 {
                    let rawSamples = sampleBuf.snapshot()
                    do {
                        let resampled = try audioConverter.resample(rawSamples, from: capturedRate)
                        let result = try await unsafeManager.transcribe(resampled)
                        if !result.text.isEmpty {
                            continuation.yield(result.text)
                        }
                    } catch {
                        log.error("Transcription error: \(error)")
                    }
                }

                try? await Task.sleep(for: .milliseconds(800))
            }
            continuation.finish()
        }
    }
}

// MARK: - Audio Capture Engine

/// Manages AVAudioEngine on a dedicated dispatch queue. AVAudioEngine must not be
/// created or started in a @MainActor context on iOS 26 — doing so causes a
/// _dispatch_assert_queue_fail crash in the engine's internal threading.
final class AudioCaptureEngine: @unchecked Sendable {
    private let queue = DispatchQueue(label: "com.prem.SpeechRecognitionKit.audio", qos: .userInitiated)
    private var engine: AVAudioEngine?

    func start(sampleBuffer: SampleBuffer) {
        queue.async { [self] in
            let audioSession = AVAudioSession.sharedInstance()
            do {
                try audioSession.setCategory(.record, mode: .measurement, options: .duckOthers)
                try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
            } catch {
                log.error("Audio session error: \(error)")
                return
            }

            let engine = AVAudioEngine()
            let inputNode = engine.inputNode
            let inputFormat = inputNode.outputFormat(forBus: 0)

            guard inputFormat.sampleRate > 0 && inputFormat.channelCount > 0 else {
                log.error("Invalid audio input format")
                return
            }

            sampleBuffer.setSampleRate(inputFormat.sampleRate)

            inputNode.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { buffer, _ in
                guard let channelData = buffer.floatChannelData else { return }
                let count = Int(buffer.frameLength)
                guard count > 0 else { return }
                let samples = Array(UnsafeBufferPointer(start: channelData[0], count: count))
                sampleBuffer.append(samples)
            }

            engine.prepare()

            do {
                try engine.start()
            } catch {
                log.error("Audio engine start error: \(error)")
                return
            }

            self.engine = engine
        }
    }

    func stop() {
        queue.sync {
            engine?.stop()
            engine?.inputNode.removeTap(onBus: 0)
            engine = nil
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }
}

// MARK: - Shared Transcription State

/// Thread-safe shared state for cross-actor communication between the
/// @MainActor service, the detached transcription task, and the audio capture engine.
final class SharedTranscriptionState: @unchecked Sendable {
    let sampleBuffer = SampleBuffer()
    private let lock = NSLock()
    private var _isActive = false

    var isActive: Bool {
        lock.lock()
        let v = _isActive
        lock.unlock()
        return v
    }

    func setActive(_ value: Bool) {
        lock.lock()
        _isActive = value
        lock.unlock()
    }

    var sampleRate: Double {
        sampleBuffer.sampleRate
    }
}

// MARK: - Sample Buffer

/// Lock-protected buffer for accumulating Float32 audio samples.
/// Written from the audio render thread, read from async Tasks.
final class SampleBuffer: @unchecked Sendable {
    private var samples: [Float] = []
    private let lock = NSLock()
    private var _sampleRate: Double = 0

    var sampleRate: Double {
        lock.lock()
        let r = _sampleRate
        lock.unlock()
        return r
    }

    func setSampleRate(_ rate: Double) {
        lock.lock()
        _sampleRate = rate
        lock.unlock()
    }

    var count: Int {
        lock.lock()
        let c = samples.count
        lock.unlock()
        return c
    }

    func append(_ newSamples: [Float]) {
        lock.lock()
        samples.append(contentsOf: newSamples)
        lock.unlock()
    }

    func snapshot() -> [Float] {
        lock.lock()
        let copy = samples
        lock.unlock()
        return copy
    }

    @discardableResult
    func drain() -> [Float] {
        lock.lock()
        let copy = samples
        samples.removeAll(keepingCapacity: true)
        lock.unlock()
        return copy
    }
}
