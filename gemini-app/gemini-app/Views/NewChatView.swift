import SwiftUI

struct NewChatView: View {
    let recentProjects: [String]
    let initialProject: String?
    let composerDisabled: Bool
    let status: InstanceStatus?
    let projectPath: String?
    let availableModels: [ModelOption]
    let currentModel: String
    let onProjectSelected: (String) -> Void
    let onSubmitMessage: (String) -> Void
    let onModelChange: (String) -> Void
    let onRetry: (() -> Void)?
    
    @State private var selectedProject: String = ""
    @State private var message: String = ""
    @FocusState private var isFocused: Bool
    
    private var projectName: String? {
        projectPath?.split(separator: "/").last.map(String.init)
    }
    
    private var canSubmit: Bool {
        !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !selectedProject.isEmpty &&
        !composerDisabled
    }
    
    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            
            // Header
            VStack(spacing: 16) {
                Text("Let's build")
                    .font(.largeTitle)
                    .fontWeight(.bold)
                
                ProjectSelectorView(
                    selectedProject: $selectedProject,
                    recentProjects: recentProjects,
                    disabled: false,
                    onSelect: onProjectSelected
                )
                .frame(maxWidth: 400)
            }
            
            // Composer card
            VStack(spacing: 0) {
                // Text input
                TextField(
                    selectedProject.isEmpty ? "Select a project first..." : "Type message here...",
                    text: $message,
                    axis: .vertical
                )
                .textFieldStyle(.plain)
                .lineLimit(1...8)
                .focused($isFocused)
                .disabled(composerDisabled || selectedProject.isEmpty)
                .onSubmit {
                    if canSubmit {
                        submitMessage()
                    }
                }
                .padding(16)
                
                Divider()
                
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
                        disabled: composerDisabled,
                        onSelect: onModelChange
                    )
                    
                    // Send button
                    Button(action: submitMessage) {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.title2)
                            .foregroundStyle(canSubmit ? .blue : .gray)
                    }
                    .disabled(!canSubmit)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .background(Color.secondary.opacity(0.15))
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .frame(maxWidth: 600)
            
            Spacer()
            Spacer()
        }
        .padding()
        .onAppear {
            if let initial = initialProject {
                selectedProject = initial
            }
        }
        .onChange(of: initialProject) { _, newValue in
            if let newValue = newValue {
                selectedProject = newValue
            }
        }
    }
    
    private func submitMessage() {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !selectedProject.isEmpty else { return }
        onSubmitMessage(trimmed)
        message = ""
    }
    
    private func statusColor(_ status: InstanceStatus) -> Color {
        switch status {
        case .connected: return .green
        case .connecting: return .orange
        case .disconnected, .error: return .red
        }
    }
}

#Preview {
    NewChatView(
        recentProjects: [
            "/Users/test/my-project",
            "/Users/test/another-project"
        ],
        initialProject: nil,
        composerDisabled: false,
        status: nil,
        projectPath: nil,
        availableModels: [],
        currentModel: "auto-gemini-2.5",
        onProjectSelected: { _ in },
        onSubmitMessage: { _ in },
        onModelChange: { _ in },
        onRetry: nil
    )
}
