import SwiftUI
import Speech
import AVFoundation
import Combine
import SpeechRecognitionKit

struct ComposerView: View {

    // MARK: Public API

    let disabled: Bool
    let streamingState: StreamingState
    let maxLines: Int
    let modelSelector: ModelSelectorConfig?
    let provider: Provider?
    let planModeActive: Bool
    let onTogglePlanMode: (() -> Void)?

    let onSubmit: (String) -> Void
    let onInterrupt: (() -> Void)?

    // MARK: Internal State

    @State private var text: String = ""
    @State private var draftBeforeRecording: String = ""

    @FocusState private var isFocused: Bool?

    @State private var isRecording: Bool = false
    @State private var isPaused: Bool = false

    @StateObject private var speech = SpeechRecognitionService()

    // MARK: Derived State

    private var isEmpty: Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var isStreaming: Bool {
        streamingState == .responding || streamingState == .tool
    }

    private var expanded: Bool {
        (isFocused == true) || !isEmpty || isRecording || isPaused || isStreaming
    }

    private var canSubmit: Bool {
        !isEmpty && !disabled && !isStreaming
    }

    private var canUseMic: Bool {
        speech.isModelLoaded && !disabled && !isStreaming && !isRecording
    }

    private var canInterrupt: Bool {
        isStreaming && onInterrupt != nil
    }

    // MARK: Body

    var body: some View {
        VStack(spacing: 0) {

            Divider().opacity(0.4)

            VStack(spacing: 8) {

                inputRow

                if expanded {
                    bottomControls
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, expanded ? 12 : 8)
            .background(.ultraThinMaterial)
            .animation(.spring(response: 0.35, dampingFraction: 0.85), value: expanded)
            .contentShape(Rectangle())
            .onTapGesture {
                if !disabled && !isStreaming && !isRecording {
                    isFocused = true
                }
            }
        }
        .onChange(of: speech.transcript) { _, new in
            guard isRecording else { return }
            DispatchQueue.main.async {
                text = draftBeforeRecording + new
            }
        }
        .onAppear { speech.preloadModel() }
    }

    // MARK: Input Row

    private var inputRow: some View {
        HStack(alignment: .bottom, spacing: 8) {
            growingTextField
            // Trailing action: stop while streaming, otherwise mic when collapsed
            if isStreaming {
                stopButton
                    .transition(.scale.combined(with: .opacity))
            } else if !expanded {
                micButton
                    .transition(.scale.combined(with: .opacity))
            }
        }
    }

    // MARK: Growing TextField

    private var growingTextField: some View {
        ZStack(alignment: .leading) {

            if text.isEmpty {
                Text(isRecording ? "Listening…" : "Message")
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
            }

            TextField("", text: $text, axis: .vertical)
                .lineLimit(1...maxLines)
                .focused($isFocused, equals: true)
                .disabled(disabled || isStreaming || isRecording)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(
                    RoundedRectangle(cornerRadius: 20)
                        .fill(Color.clear)
                )
                .textFieldStyle(.plain)
                .autocorrectionDisabled()
        }
    }

    // MARK: Bottom Controls

    private var bottomControls: some View {
        HStack {

            if isRecording || isPaused {
                recordingControls
            } else {
                micAndSendControls
            }
        }
    }

    // MARK: Mic + Send (typing state)

    private var micAndSendControls: some View {
        HStack(spacing: 12) {
            if let config = modelSelector {
                ModelSelectorView(
                    currentModel: config.currentModel,
                    availableModels: config.availableModels,
                    disabled: config.disabled
                ) { model in
                    config.onSelect(model)
                }
            }

            // Claude-specific: Plan mode toggle
            if provider == .claude, let onToggle = onTogglePlanMode {
                ClaudePlanModeToggle(
                    isActive: Binding(
                        get: { planModeActive },
                        set: { _ in onToggle() }
                    )
                )
            }

            Spacer()

            if !isStreaming {
                micButton
            }
            if !isEmpty {
                sendButton
            }
        }
    }

    // MARK: Recording Controls

    private var recordingControls: some View {
        HStack(spacing: 12) {
            Spacer()

            cancelRecording

            confirmRecording

            sendButton
        }
    }

    // MARK: Buttons

    private var micButton: some View {
        Button(action: startRecording) {
            Image(systemName: "mic.fill")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 44, height: 44)
                .background(canUseMic ? Color.accentColor : Color.gray)
                .clipShape(Circle())
        }
        .disabled(!canUseMic)
    }

    private var sendButton: some View {
        Button(action: submit) {
            Image(systemName: "arrow.up")
                .font(.system(size: 18, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 44, height: 44)
                .background(canSubmit ? Color.accentColor : Color.gray.opacity(0.4))
                .clipShape(Circle())
        }
        .disabled(!canSubmit)
    }

    private var stopButton: some View {
        Button(action: { onInterrupt?() }) {
            Image(systemName: "stop.fill")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 44, height: 44)
                .background(Color.red)
                .clipShape(Circle())
        }
        .disabled(!canInterrupt)
    }

    private var cancelRecording: some View {
        Button(action: cancelRecordingAction) {
            Image(systemName: "xmark")
                .font(.system(size: 16, weight: .bold))
                .frame(width: 36, height: 36)
                .background(Color.gray.opacity(0.2))
                .clipShape(Circle())
        }
    }

    private var confirmRecording: some View {
        Button(action: confirmRecordingAction) {
            Image(systemName: "checkmark")
                .font(.system(size: 16, weight: .bold))
                .frame(width: 36, height: 36)
                .background(Color.green.opacity(0.2))
                .clipShape(Circle())
        }
    }

    // MARK: Actions

    private func submit() {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        if isRecording || isPaused {
            speech.stopTranscribing()
            isRecording = false
            isPaused = false
        }

        onSubmit(trimmed)

        text = ""
        isFocused = nil
    }

    private func startRecording() {
        guard canUseMic else { return }

        draftBeforeRecording = text

        speech.requestAuthorization { ok in
            guard ok else { return }

            DispatchQueue.main.async {
                isRecording = true
                isPaused = false
                isFocused = nil
            }

            speech.startTranscribing()
        }
    }

    private func cancelRecordingAction() {
        speech.stopTranscribing()

        DispatchQueue.main.async {
            text = draftBeforeRecording
            isRecording = false
            isPaused = false
        }
    }

    private func confirmRecordingAction() {
        speech.stopTranscribing()

        DispatchQueue.main.async {
            isRecording = false
            isPaused = false
        }
    }
}

// MARK: - Model Selector Config

struct ModelSelectorConfig {
    let currentModel: String
    let availableModels: [ModelOption]
    let disabled: Bool
    let onSelect: (String) -> Void
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
