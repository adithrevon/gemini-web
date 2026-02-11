import SwiftUI

struct SidebarView: View {
    let instances: [InstanceState]
    let activeInstanceId: String?
    let connected: Bool
    let onSelectInstance: (String) -> Void
    let onNewChat: (String) -> Void
    let onNewProject: () -> Void
    let onTerminate: (String) -> Void
    let onOpenSettings: () -> Void

    private var groupedInstances: [String: [InstanceState]] {
        Dictionary(grouping: instances) { $0.projectPath }
    }

    var body: some View {
        List {
            // Offline banner
            if !connected {
                OfflineBannerView(onOpenSettings: onOpenSettings)
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            }

            // New project button (only when connected)
            if connected {
                Button {
                    onNewProject()
                } label: {
                    Label("New Project", systemImage: "plus.circle.fill")
                        .foregroundStyle(Color.accentColor)
                }
                .buttonStyle(.plain)
            }

            // Grouped instances by project
            ForEach(groupedInstances.keys.sorted(), id: \.self) { projectPath in
                if let projectInstances = groupedInstances[projectPath] {
                    Section {
                        ForEach(projectInstances) { instance in
                            InstanceRowView(
                                instance: instance,
                                isActive: instance.id == activeInstanceId,
                                onSelect: {
                                    onSelectInstance(instance.id)
                                }
                            )
                            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                Button(role: .destructive) {
                                    onTerminate(instance.id)
                                } label: {
                                    Label("Close", systemImage: "xmark.circle")
                                }
                            }
                            .contextMenu {
                                Button(role: .destructive) {
                                    onTerminate(instance.id)
                                } label: {
                                    Label("Close Chat", systemImage: "xmark.circle")
                                }
                            }
                        }

                        // New chat in this project
                        Button {
                            onNewChat(projectPath)
                        } label: {
                            Label("New Chat", systemImage: "plus")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                    } header: {
                        HStack(spacing: Spacing.xs) {
                            Image(systemName: "folder.fill")
                                .font(.caption)
                                .foregroundStyle(Color.accentColor.opacity(0.8))
                            Text(projectName(from: projectPath))
                                .font(.sectionHeader)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.top, Spacing.xs)
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .navigationTitle("Chats")
        .toolbar {
            #if os(iOS)
            ToolbarItem(placement: .navigationBarTrailing) {
                Button { onOpenSettings() } label: { Image(systemName: "gear") }
            }
            #else
            ToolbarItem(placement: .primaryAction) {
                Button { onOpenSettings() } label: { Image(systemName: "gear") }
            }
            #endif
        }
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }

    private func projectName(from path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? path
    }
}

struct InstanceRowView: View {
    let instance: InstanceState
    let isActive: Bool
    let onSelect: () -> Void

    private var statusColor: Color {
        switch instance.status {
        case .connected: return .statusConnected
        case .connecting: return .statusConnecting
        case .disconnected, .error: return .statusError
        }
    }

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: Spacing.sm) {
                // Provider icon + status indicator
                ZStack(alignment: .bottomTrailing) {
                    Image(systemName: instance.provider.icon)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(width: 16, height: 16)
                    Circle()
                        .fill(statusColor)
                        .frame(width: 6, height: 6)
                        .offset(x: 2, y: 2)
                }

                // Chat label
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    Text(chatLabel)
                        .font(.subheadline)
                        .lineLimit(1)

                    if let error = instance.error {
                        Text(error)
                            .font(.caption2)
                            .foregroundStyle(Color.statusError)
                            .lineLimit(1)
                    }
                }

                Spacer()
            }
            .padding(.vertical, Spacing.xs)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(
            isActive
                ? Color.accentColor.opacity(0.12)
                : nil
        )
    }

    private var chatLabel: String {
        if instance.history.isEmpty {
            return "New Chat"
        }
        // Get first user message as label
        for message in instance.history {
            if case .user(let text) = message {
                return String(text.prefix(40))
            }
        }
        return "Chat"
    }
}

#Preview {
    NavigationStack {
        SidebarView(
            instances: [
                InstanceState(
                    id: "1",
                    projectPath: "/Users/test/my-project",
                    status: .connected,
                    history: [.user("Hello there, can you help me?")],
                    pending: [],
                    streamingState: .idle,
                    isTrustedFolder: false,
                    currentModel: AppConstants.defaultModel,
                    availableModels: [],
                    error: nil
                ),
                InstanceState(
                    id: "2",
                    projectPath: "/Users/test/my-project",
                    status: .connecting,
                    history: [],
                    pending: [],
                    streamingState: .idle,
                    isTrustedFolder: false,
                    currentModel: AppConstants.defaultModel,
                    availableModels: [],
                    error: nil
                ),
                InstanceState(
                    id: "3",
                    projectPath: "/Users/test/another-project",
                    status: .error,
                    history: [],
                    pending: [],
                    streamingState: .idle,
                    isTrustedFolder: false,
                    currentModel: AppConstants.defaultModel,
                    availableModels: [],
                    error: "Connection failed"
                )
            ],
            activeInstanceId: "1",
            connected: false,
            onSelectInstance: { _ in },
            onNewChat: { _ in },
            onNewProject: { },
            onTerminate: { _ in },
            onOpenSettings: { }
        )
    }
}
