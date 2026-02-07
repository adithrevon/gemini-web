import SwiftUI
import Speech
import AVFoundation
import Combine

struct ComposerView: View {
    let disabled: Bool
    let streamingState: StreamingState
    let onSubmit: (String) -> Void
    let onInterrupt: (() -> Void)?

    @State private var text = ""
    @FocusState private var isFocused: Bool
    @StateObject private var speechRecognizer = SpeechRecognizer()
    @State private var isRecording = false

    private var canSubmit: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !disabled
    }

    private var isEmpty: Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var isStreaming: Bool {
        streamingState != .idle
    }

    var body: some View {
        VStack(spacing: 0) {
            Divider()
                .opacity(0.5)

            // Unified composer area - entire area is tappable
            HStack(alignment: .center, spacing: Spacing.md) {
                // Text field - vertically centered
                TextField("Message", text: $text, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...8)
                    .focused($isFocused)
                    .disabled(disabled || isRecording)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.sentences)
                    .onSubmit {
                        if canSubmit {
                            submitMessage()
                        }
                    }

                // Stop, Send or Mic button
                if isStreaming {
                    // Show stop button when Gemini is responding
                    Button {
                        onInterrupt?()
                    } label: {
                        Image(systemName: "stop.circle.fill")
                            .font(.system(size: 32, weight: .medium))
                            .symbolRenderingMode(.hierarchical)
                            .foregroundStyle(Color.statusError)
                    }
                    .buttonStyle(.plain)
                } else if isEmpty && !isRecording && speechRecognizer.isAvailable {
                    Button {
                        startRecording()
                    } label: {
                        Image(systemName: "mic.circle.fill")
                            .font(.system(size: 32, weight: .medium))
                            .symbolRenderingMode(.hierarchical)
                            .foregroundStyle(disabled ? Color.secondary.opacity(0.5) : Color.accentColor)
                    }
                    .disabled(disabled)
                    .buttonStyle(.plain)
                } else if isRecording {
                    HStack(spacing: Spacing.sm) {
                        Button {
                            cancelRecording()
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 28, weight: .medium))
                                .foregroundStyle(Color.secondary)
                        }
                        .buttonStyle(.plain)

                        Button {
                            stopAndSend()
                        } label: {
                            Image(systemName: "arrow.up.circle.fill")
                                .font(.system(size: 32, weight: .medium))
                                .symbolRenderingMode(.hierarchical)
                                .foregroundStyle(Color.accentColor)
                        }
                        .buttonStyle(.plain)
                    }
                } else {
                    Button(action: submitMessage) {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 32, weight: .medium))
                            .symbolRenderingMode(.hierarchical)
                            .foregroundStyle(canSubmit ? Color.accentColor : Color.secondary.opacity(0.5))
                    }
                    .disabled(!canSubmit)
                    .buttonStyle(.plain)
                }
            }
            .animation(AppAnimation.quick, value: isEmpty)
            .animation(AppAnimation.quick, value: isRecording)
            .animation(AppAnimation.quick, value: isStreaming)
            .padding(.horizontal, Spacing.lg)
            .padding(.top, Spacing.md)
            .padding(.bottom, Spacing.lg) // More bottom padding for home indicator
            .background(.regularMaterial)
            .contentShape(Rectangle()) // Make entire area tappable
            .onTapGesture {
                isFocused = true
            }
        }
        .onChange(of: speechRecognizer.transcript) { _, newValue in
            if isRecording {
                text = newValue
            }
        }
    }

    private func submitMessage() {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        onSubmit(trimmed)
        text = ""
        isFocused = false
    }

    private func startRecording() {
        speechRecognizer.requestAuthorization { authorized in
            if authorized {
                isRecording = true
                text = ""
                speechRecognizer.startTranscribing()
            }
        }
    }

    private func cancelRecording() {
        speechRecognizer.stopTranscribing()
        isRecording = false
        text = ""
    }

    private func stopAndSend() {
        speechRecognizer.stopTranscribing()
        isRecording = false
        if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            submitMessage()
        }
    }
}

// MARK: - Speech Recognizer

class SpeechRecognizer: ObservableObject {
    @Published var transcript = ""
    @Published var isAvailable = true

    private var audioEngine: AVAudioEngine?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private let speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))

    func requestAuthorization(completion: @escaping (Bool) -> Void) {
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                switch status {
                case .authorized:
                    AVAudioApplication.requestRecordPermission { granted in
                        DispatchQueue.main.async {
                            completion(granted)
                        }
                    }
                default:
                    completion(false)
                }
            }
        }
    }

    func startTranscribing() {
        DispatchQueue.main.async {
            self.transcript = ""
        }

        let audioSession = AVAudioSession.sharedInstance()
        do {
            try audioSession.setCategory(.record, mode: .measurement, options: .duckOthers)
            try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            DispatchQueue.main.async {
                self.isAvailable = false
            }
            return
        }

        let audioEngine = AVAudioEngine()
        self.audioEngine = audioEngine

        let recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        self.recognitionRequest = recognitionRequest
        recognitionRequest.shouldReportPartialResults = true

        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)

        guard recordingFormat.sampleRate > 0 && recordingFormat.channelCount > 0 else {
            DispatchQueue.main.async {
                self.isAvailable = false
            }
            return
        }

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { buffer, _ in
            recognitionRequest.append(buffer)
        }

        audioEngine.prepare()

        do {
            try audioEngine.start()
        } catch {
            DispatchQueue.main.async {
                self.isAvailable = false
            }
            return
        }

        recognitionTask = speechRecognizer?.recognitionTask(with: recognitionRequest) { [weak self] result, error in
            guard let self = self else { return }

            if let result = result {
                DispatchQueue.main.async {
                    self.transcript = result.bestTranscription.formattedString
                }
            }

            if error != nil || result?.isFinal == true {
                self.stopTranscribing()
            }
        }
    }

    func stopTranscribing() {
        audioEngine?.stop()
        audioEngine?.inputNode.removeTap(onBus: 0)
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()

        audioEngine = nil
        recognitionRequest = nil
        recognitionTask = nil

        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

// MARK: - Model Selector

struct ModelSelectorView: View {
    let currentModel: String
    let availableModels: [ModelOption]
    let disabled: Bool
    let onSelect: (String) -> Void

    private var displayModels: [ModelOption] {
        if availableModels.isEmpty {
            return [
                ModelOption(value: AppConstants.defaultModel, label: "Auto (Gemini 2.5)", description: "Let CLI decide", isAuto: true),
                ModelOption(value: "gemini-2.5-pro", label: "Gemini 2.5 Pro", description: nil, isAuto: false),
                ModelOption(value: "gemini-2.5-flash", label: "Gemini 2.5 Flash", description: nil, isAuto: false)
            ]
        }
        return availableModels
    }

    private var currentLabel: String {
        displayModels.first { $0.value == currentModel }?.label ?? currentModel
    }

    var body: some View {
        Menu {
            ForEach(displayModels) { model in
                Button {
                    onSelect(model.value)
                } label: {
                    HStack {
                        VStack(alignment: .leading) {
                            Text(model.label)
                            if let desc = model.description {
                                Text(desc)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        if model.value == currentModel {
                            Image(systemName: "checkmark")
                                .foregroundStyle(Color.accentColor)
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: Spacing.xs) {
                Image(systemName: "cpu")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(currentLabel)
                    .font(.caption)
                    .foregroundStyle(.primary)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .padding(.vertical, Spacing.sm)
            .padding(.horizontal, Spacing.md)
            .background(Color.surfaceSecondary.opacity(0.8))
            .clipShape(Capsule())
        }
        .menuStyle(.borderlessButton)
        .disabled(disabled)
    }
}

// MARK: - Status Indicator (for toolbar)

struct StatusIndicatorView: View {
    let status: InstanceStatus

    private var statusColor: Color {
        switch status {
        case .connected: return .statusConnected
        case .connecting: return .statusConnecting
        case .disconnected, .error: return .statusError
        }
    }

    @State private var isPulsing = false

    var body: some View {
        Circle()
            .fill(statusColor)
            .frame(width: 8, height: 8)
            .scaleEffect(status == .connecting && isPulsing ? 1.4 : 1.0)
            .opacity(status == .connecting && isPulsing ? 0.5 : 1.0)
            .animation(
                status == .connecting
                    ? .easeInOut(duration: 0.8).repeatForever(autoreverses: true)
                    : .default,
                value: isPulsing
            )
            .onAppear {
                if status == .connecting {
                    isPulsing = true
                }
            }
            .onChange(of: status) { _, newStatus in
                isPulsing = newStatus == .connecting
            }
    }
}

#Preview {
    VStack {
        Spacer()
        ComposerView(
            disabled: false,
            streamingState: .idle,
            onSubmit: { _ in },
            onInterrupt: nil
        )
    }
}
