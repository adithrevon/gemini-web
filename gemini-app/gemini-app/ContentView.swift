import SwiftUI
import os.log

private let logger = Logger(subsystem: Bundle.main.bundleIdentifier ?? "gemini-app", category: "ContentView")

struct ContentView: View {
    @State private var store = SessionStore()
    @State private var inAppNotificationManager = InAppNotificationManager()
    @State private var showNewChat = false
    @State private var showSettings = false
    @State private var pendingProjectPath: String?
    @State private var pendingInstanceId: String?
    @State private var pendingProvider: Provider = .gemini
    @State private var pendingYolo: Bool = false
    @State private var pendingModel: String?
    @State private var columnVisibility: NavigationSplitViewVisibility = .automatic
    @State private var navigationPath = NavigationPath()

    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    private var hasActiveChat: Bool {
        store.activeInstance != nil && !showNewChat
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
        ZStack {
            Group {
                if horizontalSizeClass == .compact {
                    iPhoneLayout
                } else {
                    iPadMacLayout
                }
            }

            NotificationBadge(
                manager: inAppNotificationManager,
                onNotificationTap: { instanceId in
                    store.activeInstanceId = instanceId
                    showNewChat = false
                    navigationPath = NavigationPath()
                    navigationPath.append(instanceId)
                    store.setActiveInstance(instanceId)
                }
            )
            .onChange(of: store.activeInstanceId) { _, newInstanceId in
                if let newInstanceId = newInstanceId {
                    inAppNotificationManager.notifications.removeAll { $0.instanceId == newInstanceId }
                }
            }
        }
        .sheet(isPresented: $showSettings) {
            SettingsView(onServerChanged: {
                store.switchServer()
            })
        }
        .onAppear {
            store.connect()
            store.setInAppNotificationManager(inAppNotificationManager)
        }
        .onOpenURL { url in
            handleNotificationDeepLink(url)
        }
    }

    // MARK: - iPhone Layout

    @ViewBuilder
    private var iPhoneLayout: some View {
        NavigationStack(path: $navigationPath) {
            SidebarView(
                instances: store.sortedInstances,
                activeInstanceId: store.activeInstanceId,
                onSelectInstance: { id in
                    store.setActiveInstance(id)
                    showNewChat = false
                    navigationPath.append(id)
                },
                onNewChat: { projectPath in
                    handleNewChatFromProject(projectPath)
                    navigationPath.append("newChat")
                },
                onNewProject: {
                    handleNewProject()
                    navigationPath.append("newChat")
                },
                onTerminate: { instanceId in
                    store.terminateInstance(instanceId)
                }
            )
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button { showSettings = true } label: { Image(systemName: "gear") }
                }
            }
            .navigationDestination(for: String.self) { value in
                if value == "newChat" {
                    newChatScreen
                } else if let instance = store.instances[value] {
                    chatDetailView(instance: instance)
                        .onAppear {
                            store.setActiveInstance(value)
                            showNewChat = false
                        }
                }
            }
        }
    }

    private var newChatScreen: some View {
        NewChatView(
            recentProjects: recentProjects,
            initialProject: pendingProjectPath,
            initialProvider: pendingProvider,
            composerDisabled: newChatDisabled,
            status: displayStatus,
            onProjectSelected: { path, provider, yolo, model in
                handleProjectSelected(path, provider: provider, yolo: yolo, model: model)
            },
            onSubmitMessage: { msg in
                if let instanceId = pendingInstanceId {
                    handleStartChat(msg)
                    navigationPath.removeLast()
                    navigationPath.append(instanceId)
                }
            },
            onCancel: {
                handleCancelNewChat()
                navigationPath.removeLast()
            },
            sessionStore: store
        )
        .navigationTitle("New Chat")
        .navigationBarTitleDisplayMode(.inline)
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
                },
                onTerminate: { instanceId in
                    store.terminateInstance(instanceId)
                }
            )
        } detail: {
            if showNewChat || !hasActiveChat {
                newChatScreen
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

    // MARK: - Chat Detail

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
                Text("Start a conversation").foregroundStyle(.secondary)
                Spacer()
            }

            ComposerView(
                disabled: isDisabled,
                streamingState: instance.streamingState,
                onSubmit: { text in store.sendSubmit(text) },
                onInterrupt: { store.sendInterrupt() }
            )
        }
        .ignoresSafeArea(.container, edges: .bottom)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 2) {
                    Text(projectName(from: instance.projectPath))
                        .font(.subheadline.weight(.semibold))
                }
            }
        }
    }

    // MARK: - Handlers

    private func handleProjectSelected(_ projectPath: String, provider: Provider = .gemini, yolo: Bool = false, model: String? = nil) {
        if let oldId = pendingInstanceId,
           let oldInst = store.instances[oldId],
           oldInst.history.isEmpty {
            store.terminateInstance(oldId)
            pendingInstanceId = nil
        }

        showNewChat = true
        pendingProjectPath = projectPath
        pendingProvider = provider
        pendingYolo = yolo
        pendingModel = model

        Task {
            let instanceId = await store.spawnInstance(projectPath: projectPath, provider: provider, yolo: yolo)
            if pendingProjectPath == projectPath && pendingProvider == provider {
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

        if let model = pendingModel, model != pendingProvider.defaultModel {
            store.sendSetModel(model)
        }
        pendingModel = nil

        store.sendSubmit(message)
        showNewChat = false
    }

    private func handleNewChatFromProject(_ projectPath: String) {
        pendingInstanceId = nil
        pendingProjectPath = projectPath
        pendingProvider = .gemini
        showNewChat = true
    }

    private func handleNewProject() {
        pendingProjectPath = nil
        pendingInstanceId = nil
        pendingProvider = .gemini
        showNewChat = true
    }

    private func handleCancelNewChat() {
        if let instanceId = pendingInstanceId,
           let instance = store.instances[instanceId],
           instance.history.isEmpty {
            store.terminateInstance(instanceId)
        }
        pendingInstanceId = nil
        pendingProjectPath = nil
        showNewChat = false
    }

    private func handleNotificationDeepLink(_ url: URL) {
        guard url.scheme == "gemini-app" else { return }

        let components = URLComponents(url: url, resolvingAgainstBaseURL: true)
        guard let queryItems = components?.queryItems else { return }

        var instanceId: String?
        var action: String?

        for item in queryItems {
            if item.name == "id" { instanceId = item.value }
            else if item.name == "action" { action = item.value }
        }

        guard let instanceId else { return }

        store.setActiveInstance(instanceId)
        showNewChat = false
    }

    private func projectName(from path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? path
    }
}

#Preview {
    ContentView()
}
