import SwiftUI

struct ComposerView: View {
    let disabled: Bool
    let status: InstanceStatus?
    let projectPath: String?
    let currentModel: String
    let availableModels: [ModelOption]
    let onSubmit: (String) -> Void
    let onModelChange: (String) -> Void
    let onRetry: (() -> Void)?
    
    @State private var text = ""
    @FocusState private var isFocused: Bool
    
    private var projectName: String? {
        projectPath?.split(separator: "/").last.map(String.init)
    }
    
    private var canSubmit: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !disabled
    }
    
    var body: some View {
        VStack(spacing: 0) {
            // Text input
            HStack(alignment: .bottom, spacing: 12) {
                TextField("Type message here...", text: $text, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...8)
                    .focused($isFocused)
                    .disabled(disabled)
                    .onSubmit {
                        if canSubmit {
                            submitMessage()
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .background(Color.secondary.opacity(0.15))
                    .clipShape(RoundedRectangle(cornerRadius: 20))
                
                Button(action: submitMessage) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title)
                        .foregroundStyle(canSubmit ? .blue : .gray)
                }
                .disabled(!canSubmit)
            }
            .padding(.horizontal)
            .padding(.top, 8)
            
            // Toolbar
            HStack {
                // Status indicator
                if let status = status {
                    HStack(spacing: 6) {
                        Circle()
                            .fill(statusColor(status))
                            .frame(width: 8, height: 8)
                        
                        if let name = projectName {
                            Text(name)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        
                        if status == .error, let onRetry = onRetry {
                            Button("Retry", action: onRetry)
                                .font(.caption)
                                .foregroundStyle(.blue)
                        }
                    }
                    .padding(.vertical, 4)
                    .padding(.horizontal, 8)
                    .background(Color.secondary.opacity(0.15))
                    .clipShape(Capsule())
                }
                
                Spacer()
                
                // Model selector
                ModelSelectorView(
                    currentModel: currentModel,
                    availableModels: availableModels,
                    disabled: disabled,
                    onSelect: onModelChange
                )
            }
            .padding(.horizontal)
            .padding(.vertical, 8)
        }
        .background(.bar)
    }
    
    private func submitMessage() {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        onSubmit(trimmed)
        text = ""
    }
    
    private func statusColor(_ status: InstanceStatus) -> Color {
        switch status {
        case .connected: return .green
        case .connecting: return .orange
        case .disconnected, .error: return .red
        }
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
                ModelOption(value: "auto-gemini-2.5", label: "Auto (Gemini 2.5)", description: "Let CLI decide", isAuto: true),
                ModelOption(value: "gemini-2.5-pro", label: "gemini-2.5-pro", description: nil, isAuto: false),
                ModelOption(value: "gemini-2.5-flash", label: "gemini-2.5-flash", description: nil, isAuto: false)
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
                        Text(model.label)
                        if model.value == currentModel {
                            Image(systemName: "checkmark")
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "cpu")
                    .font(.caption)
                Text(currentLabel)
                    .font(.caption)
                Image(systemName: "chevron.down")
                    .font(.caption2)
            }
            .padding(.vertical, 6)
            .padding(.horizontal, 10)
            .background(Color.secondary.opacity(0.15))
            .clipShape(Capsule())
        }
        .disabled(disabled)
    }
}

#Preview {
    VStack {
        Spacer()
        ComposerView(
            disabled: false,
            status: .connected,
            projectPath: "/Users/test/my-project",
            currentModel: "auto-gemini-2.5",
            availableModels: [],
            onSubmit: { _ in },
            onModelChange: { _ in },
            onRetry: nil
        )
    }
}
