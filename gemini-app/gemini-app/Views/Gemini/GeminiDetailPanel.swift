import SwiftUI

struct GeminiDetailPanel: View {
    let instance: InstanceState

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Image(systemName: "sparkles")
                    .foregroundStyle(.blue)
                Text("Gemini Tools")
                    .font(.headline)
            }
            .padding()

            Divider()

            // Placeholder for future Gemini-specific features
            VStack(spacing: 12) {
                Image(systemName: "wrench.and.screwdriver")
                    .font(.largeTitle)
                    .foregroundStyle(.secondary)

                Text("Coming Soon")
                    .font(.headline)
                    .foregroundStyle(.secondary)

                Text("Gemini-specific tools will appear here")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding()

            Spacer()
        }
    }
}

// MARK: - Preview

#Preview {
    GeminiDetailPanel(instance: InstanceState(
        id: "test",
        projectPath: "/tmp/test",
        status: .connected,
        history: [],
        pending: [],
        streamingState: .idle,
        isTrustedFolder: true,
        currentModel: "auto-gemini-2.5",
        availableModels: [],
        error: nil,
        provider: .gemini,
        usageMetrics: nil,
        todos: nil,
        planModeActive: false
    ))
    .frame(width: 300)
}
