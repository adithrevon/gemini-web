import SwiftUI

struct ContentView: View {
    @State private var store = SessionStore()
    @State private var showNewChat = false
    @State private var showSettings = false
    @State private var pendingProjectPath: String?
    @State private var pendingInstanceId: String?
    @State private var columnVisibility: NavigationSplitViewVisibility = .automatic
    @State private var navigationPath = NavigationPath()
    
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    
    private var hasActiveChat: Bool {
        store.activeInstance != nil && !showNewChat
    }
    
    private var hasMessages: Bool {
        guard let instance = store.activeInstance else { return false }
        return !instance.history.isEmpty || !instance.pending.isEmpty
    }
    
    private var isDisabled: Bool {
        !store.connected || store.activeInstance == nil || store.activeInstance?.status != .connected
    }
    
    private var displayStatus: InstanceStatus? {
        if showNewChat {
            if pendingProjectPath != nil {
                if let id = pendingInstanceId, let inst = store.instances[id] {
                    return inst.status
                }
                return .connecting
            }
            return nil
        }
        return store.activeInstance?.status
    }
    
    private var displayProjectPath: String? {
        if showNewChat {
            return pendingProjectPath ?? store.instances[pendingInstanceId ?? ""]?.projectPath
        }
        return store.activeInstance?.projectPath
    }
    
    private var newChatDisabled: Bool {
        guard showNewChat else { return isDisabled }
        guard pendingProjectPath != nil else { return true }
        guard let id = pendingInstanceId, let inst = store.instances[id] else { return true }
        return inst.status != .connected
    }
    
    private var recentProjects: [String] {
        if let pending = pendingProjectPath {
            return [pending] + store.recentProjects.filter { $0 != pending }
        }
        return store.recentProjects
    }
    
    var body: some View {
        Group {
            if horizontalSizeClass == .compact {
                // iPhone: Use NavigationStack with proper navigation
                iPhoneLayout
            } else {
                // iPad/Mac: Use NavigationSplitView
                iPadMacLayout
            }
        }
        .sheet(isPresented: $showSettings) {
            SettingsView()
        }
        .onAppear {
            store.connect()
        }
    }
    
    // MARK: - iPhone Layout
    
    @ViewBuilder
    private var iPhoneLayout: some View {
        NavigationStack(path: $navigationPath) {
            // Main list view
            List {
                // New project button - navigates to new chat
                NavigationLink(value: "newProject") {
                    Label("New Project", systemImage: "plus.circle")
                }
                
                // Grouped instances by project
                ForEach(store.sortedInstances.map(\.projectPath).uniqued(), id: \.self) { projectPath in
                    let projectInstances = store.sortedInstances.filter { $0.projectPath == projectPath }
                    
                    Section {
                        ForEach(projectInstances) { instance in
                            NavigationLink(value: instance.id) {
                                InstanceRowLabel(instance: instance, isActive: instance.id == store.activeInstanceId)
                            }
                        }
                        
                        // New chat in this project
                        Button {
                            handleNewChatFromProject(projectPath)
                            navigationPath.append("detail")
                        } label: {
                            Label("New Chat", systemImage: "plus")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
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
            .listStyle(.sidebar)
            .navigationTitle("Chats")
            #if os(iOS)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        showSettings = true
                    } label: {
                        Image(systemName: "gear")
                    }
                }
            }
            #endif
            .navigationDestination(for: String.self) { value in
                if value == "newProject" {
                    // Show NewChatView for new project
                    NewChatView(
                        recentProjects: recentProjects,
                        initialProject: nil,
                        composerDisabled: newChatDisabled,
                        status: displayStatus,
                        projectPath: displayProjectPath,
                        availableModels: store.activeInstance?.availableModels ?? [],
                        currentModel: store.activeInstance?.currentModel ?? "auto-gemini-2.5",
                        onProjectSelected: handleProjectSelected,
                        onSubmitMessage: { msg in
                            if let instanceId = pendingInstanceId {
                                handleStartChat(msg)
                                // Replace NewChatView with chat detail
                                navigationPath.removeLast()
                                navigationPath.append(instanceId)
                            }
                        },
                        onModelChange: { model in
                            store.sendSetModel(model)
                        },
                        onRetry: handleRetry
                    )
                    .navigationTitle("New Chat")
                    #if os(iOS)
                    .navigationBarTitleDisplayMode(.inline)
                    #endif
                } else if value == "detail" {
                    // Show new chat view with pending project
                    NewChatView(
                        recentProjects: recentProjects,
                        initialProject: pendingProjectPath,
                        composerDisabled: newChatDisabled,
                        status: displayStatus,
                        projectPath: displayProjectPath,
                        availableModels: store.activeInstance?.availableModels ?? [],
                        currentModel: store.activeInstance?.currentModel ?? "auto-gemini-2.5",
                        onProjectSelected: handleProjectSelected,
                        onSubmitMessage: { msg in
                            if let instanceId = pendingInstanceId {
                                handleStartChat(msg)
                                // Replace NewChatView with chat detail
                                navigationPath.removeLast()
                                navigationPath.append(instanceId)
                            }
                        },
                        onModelChange: { model in
                            store.sendSetModel(model)
                        },
                        onRetry: handleRetry
                    )
                    .navigationTitle("New Chat")
                    #if os(iOS)
                    .navigationBarTitleDisplayMode(.inline)
                    #endif
                } else {
                    // It's an instance ID
                    if let instance = store.instances[value] {
                        chatDetailView(instance: instance)
                            .onAppear {
                                store.setActiveInstance(value)
                                showNewChat = false
                            }
                    }
                }
            }
        }
    }
    
    // MARK: - iPad/Mac Layout
    
    @ViewBuilder
    private var iPadMacLayout: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            SidebarView(
                instances: store.sortedInstances,
                activeInstanceId: store.activeInstanceId,
                onSelectInstance: { id in
                    store.setActiveInstance(id)
                    showNewChat = false
                },
                onNewChat: { projectPath in
                    handleNewChatFromProject(projectPath)
                },
                onNewProject: {
                    handleNewProject()
                }
            )
            .toolbar {
                #if os(iOS)
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        showSettings = true
                    } label: {
                        Image(systemName: "gear")
                    }
                }
                #else
                ToolbarItem {
                    Button {
                        showSettings = true
                    } label: {
                        Image(systemName: "gear")
                    }
                }
                #endif
            }
        } detail: {
            if showNewChat || !hasActiveChat {
                NewChatView(
                    recentProjects: recentProjects,
                    initialProject: pendingProjectPath,
                    composerDisabled: newChatDisabled,
                    status: displayStatus,
                    projectPath: displayProjectPath,
                    availableModels: store.activeInstance?.availableModels ?? [],
                    currentModel: store.activeInstance?.currentModel ?? "auto-gemini-2.5",
                    onProjectSelected: handleProjectSelected,
                    onSubmitMessage: handleStartChat,
                    onModelChange: { model in
                        store.sendSetModel(model)
                    },
                    onRetry: handleRetry
                )
            } else if let instance = store.activeInstance {
                chatDetailView(instance: instance)
            } else {
                ContentUnavailableView(
                    "No Chat Selected",
                    systemImage: "bubble.left.and.bubble.right",
                    description: Text("Select a chat from the sidebar or start a new one")
                )
            }
        }
    }
    
    // MARK: - Shared Views
    
    @ViewBuilder
    private func chatDetailView(instance: InstanceState) -> some View {
        VStack(spacing: 0) {
            if !instance.history.isEmpty || !instance.pending.isEmpty {
                MessageListView(
                    history: instance.history,
                    pending: instance.pending,
                    streamingState: instance.streamingState,
                    isTrustedFolder: instance.isTrustedFolder,
                    onConfirm: { callId, outcome, correlationId in
                        store.sendConfirm(callId: callId, outcome: outcome, correlationId: correlationId)
                    }
                )
            } else {
                Spacer()
                Text("Start a conversation")
                    .foregroundStyle(.secondary)
                Spacer()
            }
            
            ComposerView(
                disabled: isDisabled,
                status: instance.status,
                projectPath: instance.projectPath,
                currentModel: instance.currentModel,
                availableModels: instance.availableModels,
                onSubmit: { text in
                    store.sendSubmit(text)
                },
                onModelChange: { model in
                    store.sendSetModel(model)
                },
                onRetry: handleRetry
            )
        }
        .navigationTitle(projectName(from: instance.projectPath))
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }
    
    // MARK: - Handlers
    
    private func handleProjectSelected(_ projectPath: String) {
        pendingProjectPath = projectPath
        Task {
            let instanceId = await store.spawnInstance(projectPath: projectPath)
            if pendingProjectPath == projectPath {
                pendingInstanceId = instanceId
            }
        }
    }
    
    private func handleStartChat(_ message: String) {
        guard let instance = showNewChat ? store.instances[pendingInstanceId ?? ""] : store.activeInstance else { return }
        guard instance.status == .connected else { return }
        
        if showNewChat, let id = pendingInstanceId {
            store.setActiveInstance(id)
        }
        
        store.sendSubmit(message)
        showNewChat = false
    }
    
    private func handleNewChatFromProject(_ projectPath: String) {
        pendingInstanceId = nil
        showNewChat = true
        handleProjectSelected(projectPath)
    }
    
    private func handleNewProject() {
        pendingProjectPath = nil
        pendingInstanceId = nil
        showNewChat = true
    }
    
    private func handleRetry() {
        let instance = showNewChat ? store.instances[pendingInstanceId ?? ""] : store.activeInstance
        guard let instance = instance, let projectPath = Optional(instance.projectPath), instance.status == .error else { return }
        
        store.terminateInstance(instance.id)
        Task {
            let newId = await store.spawnInstance(projectPath: projectPath)
            if showNewChat {
                pendingInstanceId = newId
            }
        }
    }
    
    private func projectName(from path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? path
    }
}

// MARK: - Helper Views

struct InstanceRowLabel: View {
    let instance: InstanceState
    let isActive: Bool
    
    var body: some View {
        HStack {
            Circle()
                .fill(statusColor)
                .frame(width: 8, height: 8)
            
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
        }
    }
    
    private var chatLabel: String {
        if instance.history.isEmpty {
            return "New Chat"
        }
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

// MARK: - Array Extension for unique elements

extension Array where Element: Hashable {
    func uniqued() -> [Element] {
        var seen = Set<Element>()
        return filter { seen.insert($0).inserted }
    }
}

#Preview {
    ContentView()
}
