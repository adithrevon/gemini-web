import SwiftUI

struct ContentView: View {
    @State private var store = SessionStore()
    @State private var showNewChat = false
    @State private var showSettings = false
    @State private var pendingProjectPath: String?
    @State private var pendingInstanceId: String?
    @State private var columnVisibility: NavigationSplitViewVisibility = .automatic
    
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
                VStack(spacing: 0) {
                    if hasMessages {
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
            } else {
                ContentUnavailableView(
                    "No Chat Selected",
                    systemImage: "bubble.left.and.bubble.right",
                    description: Text("Select a chat from the sidebar or start a new one")
                )
            }
        }
        .sheet(isPresented: $showSettings) {
            SettingsView()
        }
        .onAppear {
            store.connect()
        }
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
}

#Preview {
    ContentView()
}
