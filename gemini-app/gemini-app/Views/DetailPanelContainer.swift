import SwiftUI

struct DetailPanelContainer: View {
    let instance: InstanceState?
    @AppStorage("showDetailPanel") private var showPanel = true

    var body: some View {
        if showPanel, let instance = instance {
            VStack(spacing: 0) {
                switch instance.provider {
                case .claude:
                    ClaudeDetailPanel(instance: instance)
                case .gemini:
                    GeminiDetailPanel(instance: instance)
                }
            }
            .frame(width: 300)
            .background(Color(uiColor: .systemBackground))
        }
    }
}

// MARK: - Preview

#Preview("Claude Instance") {
    DetailPanelContainer(instance: InstanceState(
        id: "claude-test",
        projectPath: "/tmp/test",
        status: .connected,
        history: [],
        pending: [],
        streamingState: .idle,
        isTrustedFolder: true,
        currentModel: "claude-sonnet-4-5-20250929",
        availableModels: [],
        error: nil,
        provider: .claude,
        usageMetrics: UsageMetrics(
            totalInputTokens: 1500,
            totalOutputTokens: 800,
            totalCachedTokens: 200,
            totalTokens: 2500,
            totalCostUsd: 0.0125,
            totalApiCalls: 3,
            totalApiErrors: 0,
            totalApiLatencyMs: 1500,
            totalToolCalls: 5,
            totalToolSuccess: 5,
            totalToolFail: 0,
            numTurns: 3,
            durationMs: 45000,
            modelBreakdown: nil
        ),
        todos: TodoList(
            items: [
                TodoItem(
                    id: "1",
                    subject: "Review code",
                    description: "Check implementation",
                    status: "in_progress",
                    blockedBy: [],
                    blocks: [],
                    createdAt: "2026-02-12T10:00:00Z",
                    completedAt: nil
                )
            ],
            lastUpdated: "2026-02-12T10:00:00Z"
        ),
        planModeActive: false
    ))
}

#Preview("Gemini Instance") {
    DetailPanelContainer(instance: InstanceState(
        id: "gemini-test",
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
}

#Preview("No Instance") {
    DetailPanelContainer(instance: nil)
}
