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
        ZStack {
            // Main content
            Group {
                if horizontalSizeClass == .compact {
                    iPhoneLayout
                } else {
                    iPadMacLayout
                }
            }

            // Notification badge (top right)
            NotificationBadge(
                manager: inAppNotificationManager,
                onNotificationTap: { instanceId in
                    logger.info("Notification tapped in ContentView: \(instanceId)")
                    // Directly update active instance
                    store.activeInstanceId = instanceId
                    showNewChat = false

                    // Update navigation path for iPhone (compact layout)
                    navigationPath = NavigationPath()
                    navigationPath.append(instanceId)

                    // Also notify server
                    store.setActiveInstance(instanceId)
                    logger.info("Active instance set to: \(instanceId), showNewChat: \(showNewChat)")
                }
            )
            .onChange(of: store.activeInstanceId) { _, newInstanceId in
                // Clear notifications when navigating to that instance
                if let newInstanceId = newInstanceId {
                    inAppNotificationManager.notifications.removeAll { $0.instanceId == newInstanceId }
                    logger.info("Cleared notifications for instance: \(newInstanceId)")
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
            // Pass the notification manager to the store
            store.setInAppNotificationManager(inAppNotificationManager)
        }
        .onOpenURL { url in
            handleNotificationDeepLink(url)
        }
    }

    // MARK: - Notification Deep Linking

    private func handleNotificationDeepLink(_ url: URL) {
        // Handle deep links from notifications
        // Format: gemini-app://instance?id=<instanceId>&action=<action>
        guard url.scheme == "gemini-app" else { return }

        let components = URLComponents(url: url, resolvingAgainstBaseURL: true)
        guard let queryItems = components?.queryItems else { return }

        var instanceId: String?
        var action: String?

        for item in queryItems {
            if item.name == "id" {
                instanceId = item.value
            } else if item.name == "action" {
                action = item.value
            }
        }

        guard let instanceId = instanceId else { return }

        logger.info("Notification deep link: instanceId=\(instanceId), action=\(action ?? "none")")

        // Navigate to the instance
        store.setActiveInstance(instanceId)
        showNewChat = false

        // Handle specific actions
        if action == "confirmation_needed" {
            // The confirmation dialog will appear automatically when we navigate
            // since the instance will be in waiting_for_confirmation state
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
                #if os(iOS)
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        showSettings = true
                    } label: {
                        Image(systemName: "gear")
                    }
                }
                #endif
            }
            .navigationDestination(for: String.self) { value in
                if value == "newChat" {
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
                        },
                        sessionStore: store
                    )
                    .navigationTitle("New Chat")
                    #if os(iOS)
                    .navigationBarTitleDisplayMode(.inline)
                    #endif
                    .gesture(
                        DragGesture(minimumDistance: 50, coordinateSpace: .local)
                            .onEnded { value in
                                if value.translation.width > 100 && abs(value.translation.height) < 100 {
                                    if !navigationPath.isEmpty {
                                        withAnimation(.easeInOut(duration: 0.25)) {
                                            navigationPath.removeLast()
                                        }
                                    }
                                }
                            }
                    )
                } else {
                    // It's an instance ID
                    if let instance = store.instances[value] {
                        chatDetailView(instance: instance)
                            .onAppear {
                                store.setActiveInstance(value)
                                showNewChat = false
                            }
                            .gesture(
                                DragGesture(minimumDistance: 50, coordinateSpace: .local)
                                    .onEnded { value in
                                        if value.translation.width > 100 && abs(value.translation.height) < 100 {
                                            if !navigationPath.isEmpty {
                                                withAnimation(.easeInOut(duration: 0.25)) {
                                                    navigationPath.removeLast()
                                                }
                                            }
                                        }
                                    }
                            )
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
                },
                onTerminate: { instanceId in
                    store.terminateInstance(instanceId)
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
                    initialProvider: pendingProvider,
                    composerDisabled: newChatDisabled,
                    status: displayStatus,
                    onProjectSelected: { path, provider, yolo, model in
                        handleProjectSelected(path, provider: provider, yolo: yolo, model: model)
                    },
                    onSubmitMessage: handleStartChat,
                    onCancel: {
                        handleCancelNewChat()
                    },
                    sessionStore: store
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
                streamingState: instance.streamingState,
                onSubmit: { text in
                    store.sendSubmit(text)
                },
                onInterrupt: {
                    store.sendInterrupt()
                }
            )
        }
        #if os(iOS)
        .ignoresSafeArea(.container, edges: .bottom)
        .toolbarBackground(.hidden, for: .navigationBar)
        .navigationBarBackButtonHidden(horizontalSizeClass == .compact)
        .toolbar {
            if horizontalSizeClass == .compact {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button {
                        if !navigationPath.isEmpty {
                            withAnimation(.easeInOut(duration: 0.25)) {
                                navigationPath.removeLast()
                            }
                        }
                    } label: {
                        Image(systemName: "chevron.left")
                            .font(.body.weight(.medium))
                    }
                }
            }
            ToolbarItem(placement: .principal) {
                VStack(spacing: 2) {
                    HStack(spacing: Spacing.xs) {
                        Image(systemName: instance.provider.icon)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        StatusIndicatorView(status: instance.status)
                        Text(projectName(from: instance.projectPath))
                            .font(.subheadline.weight(.semibold))
                    }

                    ModelSelectorView(
                        currentModel: instance.currentModel,
                        availableModels: instance.availableModels,
                        disabled: isDisabled,
                        onSelect: { model in
                            store.sendSetModel(model)
                        }
                    )
                }
            }
        }
        #else
        .navigationTitle(projectName(from: instance.projectPath))
        #endif
    }

    // MARK: - Handlers

    private func handleProjectSelected(_ projectPath: String, provider: Provider = .gemini, yolo: Bool = false, model: String? = nil) {
        // If there's already a pending instance with no messages, terminate it first
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

        // Send setModel before first message if a non-default model was selected
        if let model = pendingModel, model != pendingProvider.defaultModel {
            store.sendSetModel(model)
        }
        pendingModel = nil

        store.sendSubmit(message)
        showNewChat = false
    }

    private func handleNewChatFromProject(_ projectPath: String) {
        // Show NewChatView with this project pre-selected, but don't auto-spawn.
        // Let the user pick a provider first. NewChatView will trigger onProjectSelected
        // once the user confirms project + provider.
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

    private func handleCancelNewChat() {
        // Terminate the pending instance if user navigates away without sending a message
        if let instanceId = pendingInstanceId {
            if let instance = store.instances[instanceId], instance.history.isEmpty {
                store.terminateInstance(instanceId)
            }
        }
        pendingInstanceId = nil
        pendingProjectPath = nil
        showNewChat = false
    }

    private func projectName(from path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? path
    }
}

// MARK: - Helper Views

struct InstanceRowLabel: View {
    let instance: InstanceState
    let isActive: Bool

    private var statusColor: Color {
        switch instance.status {
        case .connected: return .statusConnected
        case .connecting: return .statusConnecting
        case .disconnected, .error: return .statusError
        }
    }

    var body: some View {
        HStack(spacing: Spacing.sm) {
            Circle()
                .fill(statusColor)
                .frame(width: 8, height: 8)

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
