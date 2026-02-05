import SwiftUI

struct SidebarView: View {
    let instances: [InstanceState]
    let activeInstanceId: String?
    let onSelectInstance: (String) -> Void
    let onNewChat: (String) -> Void
    let onNewProject: () -> Void
    
    private var groupedInstances: [String: [InstanceState]] {
        Dictionary(grouping: instances) { $0.projectPath }
    }
    
    var body: some View {
        List {
            // New project button
            Button {
                onNewProject()
            } label: {
                Label("New Project", systemImage: "plus.circle")
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
                        }
                        
                        // New chat in this project
                        Button {
                            onNewChat(projectPath)
                        } label: {
                            Label("New Chat", systemImage: "plus")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                    } header: {
                        HStack {
                            Image(systemName: "folder")
                                .font(.caption)
                            Text(projectName(from: projectPath))
                                .font(.caption)
                                .fontWeight(.medium)
                        }
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .navigationTitle("Chats")
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
    
    var body: some View {
        Button(action: onSelect) {
            HStack {
                // Status indicator
                Circle()
                    .fill(statusColor)
                    .frame(width: 8, height: 8)
                
                // Chat label
                VStack(alignment: .leading, spacing: 2) {
                    Text(chatLabel)
                        .font(.subheadline)
                        .lineLimit(1)
                    
                    if let error = instance.error {
                        Text(error)
                            .font(.caption2)
                            .foregroundStyle(.red)
                            .lineLimit(1)
                    }
                }
                
                Spacer()
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(isActive ? Color.accentColor.opacity(0.15) : nil)
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
    
    private var statusColor: Color {
        switch instance.status {
        case .connected: return .green
        case .connecting: return .orange
        case .disconnected, .error: return .red
        }
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
                    currentModel: "auto-gemini-2.5",
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
                    currentModel: "auto-gemini-2.5",
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
                    currentModel: "auto-gemini-2.5",
                    availableModels: [],
                    error: "Connection failed"
                )
            ],
            activeInstanceId: "1",
            onSelectInstance: { _ in },
            onNewChat: { _ in },
            onNewProject: { }
        )
    }
}
