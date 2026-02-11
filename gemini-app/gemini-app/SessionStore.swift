import Foundation
import SwiftUI
import os.log

private let logger = Logger(subsystem: Bundle.main.bundleIdentifier ?? "gemini-app", category: "SessionStore")

/// Observable state store for session and instance management
@MainActor
@Observable
final class SessionStore: SessionServiceDelegate {
    
    // MARK: - Published State
    
    var connected: Bool = false
    var instances: [String: InstanceState] = [:]
    var activeInstanceId: String?
    var recentProjects: [String] = []
    
    // MARK: - Computed Properties
    
    var activeInstance: InstanceState? {
        guard let id = activeInstanceId else { return nil }
        return instances[id]
    }
    
    var sortedInstances: [InstanceState] {
        instances.values.sorted { $0.projectPath < $1.projectPath }
    }
    
    // MARK: - Private

    private let service = SessionService()
    private var appIsInBackground = false
    private var inAppNotificationManager: InAppNotificationManager?
    private var disconnectTask: Task<Void, Never>?
    private let disconnectGracePeriod: TimeInterval = 3.0
    
    // MARK: - Initialization
    
    init() {
        service.delegate = self
        recentProjects = service.loadRecentProjects()
        setupNotificationObservers()
    }

    private func setupNotificationObservers() {
        NotificationCenter.default.addObserver(
            forName: appMovedToBackgroundNotificationName,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.appIsInBackground = true
                logger.info("SessionStore: app moved to background")
            }
        }

        NotificationCenter.default.addObserver(
            forName: appMovedToForegroundNotificationName,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.appIsInBackground = false
                logger.info("SessionStore: app moved to foreground")
            }
        }
    }
    
    // MARK: - Notification Management

    func setInAppNotificationManager(_ manager: InAppNotificationManager) {
        inAppNotificationManager = manager
    }

    // MARK: - Connection

    func connect() {
        service.connect()
    }

    func disconnect() {
        service.disconnect()
        connected = false
        disconnectTask?.cancel()
        disconnectTask = nil
    }

    /// Called when server is changed - clears state and reconnects
    func switchServer() {
        disconnect()

        // Clear all instance state
        instances.removeAll()
        activeInstanceId = nil

        // Reload recent projects for the new server
        recentProjects = service.loadRecentProjects()

        // Reconnect to new server
        connect()
    }
    
    // MARK: - Instance Management
    
    func spawnInstance(projectPath: String, provider: Provider = .gemini, yolo: Bool = false) async -> String? {
        guard !projectPath.isEmpty else { return nil }

        do {
            let (instanceId, resolvedPath) = try await service.spawnInstance(projectPath: projectPath, provider: provider, yolo: yolo)

            // Create local instance state immediately
            instances[instanceId] = InstanceState(
                id: instanceId,
                projectPath: resolvedPath,
                status: .connecting,
                history: [],
                pending: [],
                streamingState: .idle,
                isTrustedFolder: false,
                currentModel: provider.defaultModel,
                availableModels: [],
                error: nil,
                provider: provider
            )

            activeInstanceId = instanceId
            return instanceId
        } catch {
            return nil
        }
    }
    
    func terminateInstance(_ instanceId: String) {
        guard !instanceId.isEmpty else { return }
        
        Task {
            try? await service.terminateInstance(instanceId)
        }
        
        instances.removeValue(forKey: instanceId)
        if activeInstanceId == instanceId {
            activeInstanceId = nil
        }
    }
    
    func setActiveInstance(_ instanceId: String?) {
        activeInstanceId = instanceId
        if let instanceId = instanceId {
            Task {
                try? await service.setActiveInstance(instanceId)
            }
        }
    }
    
    // MARK: - Directory Browsing

    func browseDirectory(_ path: String?) async -> DirectoryListing? {
        do {
            return try await service.browseDirectory(path)
        } catch {
            return nil
        }
    }

    func validatePath(_ path: String) async -> PathValidation? {
        do {
            return try await service.validatePath(path)
        } catch {
            return nil
        }
    }

    // MARK: - Message Sending
    
    func sendSubmit(_ text: String) {
        guard let instanceId = activeInstanceId else { return }
        
        Task {
            try? await service.submit(text: text, instanceId: instanceId)
        }
    }
    
    func sendConfirm(callId: String, outcome: ConfirmOutcome, correlationId: String?) {
        guard let instanceId = activeInstanceId else { return }
        
        Task {
            try? await service.confirm(callId: callId, outcome: outcome, correlationId: correlationId, instanceId: instanceId)
        }
    }
    
    func sendSetModel(_ model: String) {
        guard let instanceId = activeInstanceId else { return }

        Task {
            try? await service.setModel(model, instanceId: instanceId)
        }
    }

    func sendInterrupt() {
        guard let instanceId = activeInstanceId else { return }

        Task {
            try? await service.interrupt(instanceId)
        }
    }

    // MARK: - SessionServiceDelegate
    
    nonisolated func sessionServiceDidConnect(_ service: SessionService) {
        Task { @MainActor in
            disconnectTask?.cancel()
            disconnectTask = nil
            connected = true
        }
    }
    
    nonisolated func sessionService(_ service: SessionService, didReceive message: IncomingMessage) {
        Task { @MainActor in
            handleMessage(message)
        }
    }
    
    nonisolated func sessionService(_ service: SessionService, didDisconnect error: Error) {
        Task { @MainActor in
            scheduleDisconnect()
        }
    }
    
    // MARK: - Message Handling
    
    private func handleMessage(_ message: IncomingMessage) {
        if !connected {
            connected = true
        }
        disconnectTask?.cancel()
        disconnectTask = nil

        switch message {
        case .sessionState(let state):
            applySessionState(state)
            
        case .bridgeUpdate(let update):
            applyBridgeUpdate(update.payload)
            
        case .cliStatus(let status):
            applyCliStatus(status)
            
        case .instanceList(let list):
            applyInstanceList(list.instances)
            
        case .bridgeError(let error):
            applyError(error)
            
        case .unknown:
            break
        }
    }

    @MainActor
    private func scheduleDisconnect() {
        disconnectTask?.cancel()
        disconnectTask = Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: UInt64(self.disconnectGracePeriod * 1_000_000_000))
            await MainActor.run {
                self.connected = false
            }
        }
    }
    
    private func applySessionState(_ state: SessionStateMessage) {
        var newInstances: [String: InstanceState] = [:]

        // Apply instance info
        for info in state.instances {
            let status: InstanceStatus = info.status ?? (info.connected ? .connected : .disconnected)
            let provider = info.provider ?? instances[info.id]?.provider ?? .gemini
            newInstances[info.id] = InstanceState(
                id: info.id,
                projectPath: info.projectPath,
                status: status,
                history: [],
                pending: [],
                streamingState: .idle,
                isTrustedFolder: false,
                currentModel: provider.defaultModel,
                availableModels: [],
                error: info.error,
                provider: provider
            )
        }
        
        // Apply snapshots
        for snapshot in state.snapshots {
            let existing = newInstances[snapshot.instanceId]
            let provider = existing?.provider ?? .gemini
            newInstances[snapshot.instanceId] = InstanceState(
                id: snapshot.instanceId,
                projectPath: snapshot.projectPath,
                status: .connected,
                history: snapshot.history ?? [],
                pending: snapshot.pending ?? [],
                streamingState: snapshot.streamingState ?? .idle,
                isTrustedFolder: snapshot.isTrustedFolder ?? false,
                currentModel: snapshot.currentModel ?? existing?.currentModel ?? provider.defaultModel,
                availableModels: snapshot.availableModels ?? existing?.availableModels ?? [],
                error: nil,
                provider: provider
            )
            
            // Update recent projects
            if !snapshot.projectPath.isEmpty {
                service.addToRecentProjects(snapshot.projectPath)
                recentProjects = service.loadRecentProjects()
            }
        }
        
        instances = newInstances
        activeInstanceId = state.activeInstanceId ?? state.instances.first?.id ?? state.snapshots.first?.instanceId
    }
    
    private func applyBridgeUpdate(_ payload: BridgeUpdatePayload) {
        let existing = instances[payload.instanceId]
        let provider = existing?.provider ?? .gemini
        let oldStreamingState = existing?.streamingState
        let newStreamingState = payload.streamingState ?? .idle

        // Detect streaming state transitions for notification triggers
        let wasStreaming = oldStreamingState != .idle && oldStreamingState != nil
        let isNowIdle = newStreamingState == .idle
        let isNowWaitingForConfirmation = newStreamingState == .waiting_for_confirmation

        // Check if app is in background and a conversation completed
        if wasStreaming && isNowIdle && appIsInBackground {
            logger.info("Conversation completed while app in background for instance: \(payload.instanceId)")
            NotificationService.shared.scheduleConversationCompleteNotification(
                instanceId: payload.instanceId,
                projectPath: payload.projectPath
            )
        }

        // Show in-app notification if conversation completed and user is viewing different instance
        if wasStreaming && isNowIdle {
            let isViewingDifferentInstance = activeInstanceId != payload.instanceId && activeInstanceId != nil
            if isViewingDifferentInstance {
                logger.info("Showing in-app notification for completed conversation in instance: \(payload.instanceId)")
                let projectName = payload.projectPath.split(separator: "/").last.map(String.init) ?? payload.projectPath
                inAppNotificationManager?.show(
                    instanceId: payload.instanceId,
                    projectName: projectName,
                    title: "Conversation Complete"
                )
            } else if activeInstanceId == payload.instanceId {
                logger.info("Not showing notification - user is viewing this instance: \(payload.instanceId)")
            }
        }

        // Check if tool confirmation is needed
        if isNowWaitingForConfirmation && appIsInBackground {
            // Extract tool name from pending messages if available
            let toolName = extractToolNameFromPending(payload.pending)
            logger.info("Tool confirmation needed while app in background for instance: \(payload.instanceId)")
            NotificationService.shared.scheduleConfirmationNeededNotification(
                instanceId: payload.instanceId,
                toolName: toolName,
                projectPath: payload.projectPath
            )
        }

        // Show in-app notification for tool confirmation if viewing different instance
        if isNowWaitingForConfirmation {
            let isViewingDifferentInstance = activeInstanceId != payload.instanceId && activeInstanceId != nil
            if isViewingDifferentInstance {
                logger.info("Showing in-app notification for confirmation needed in instance: \(payload.instanceId)")
                let projectName = payload.projectPath.split(separator: "/").last.map(String.init) ?? payload.projectPath
                let toolName = extractToolNameFromPending(payload.pending)
                inAppNotificationManager?.show(
                    instanceId: payload.instanceId,
                    projectName: projectName,
                    title: "Action Required: \(toolName)"
                )
            }
        }

        instances[payload.instanceId] = InstanceState(
            id: payload.instanceId,
            projectPath: payload.projectPath,
            status: .connected,
            history: payload.history ?? [],
            pending: payload.pending ?? [],
            streamingState: newStreamingState,
            isTrustedFolder: payload.isTrustedFolder ?? false,
            currentModel: payload.currentModel ?? existing?.currentModel ?? provider.defaultModel,
            availableModels: payload.availableModels ?? existing?.availableModels ?? [],
            error: nil,
            provider: provider
        )

        if activeInstanceId == nil {
            activeInstanceId = payload.instanceId
        }

        if !payload.projectPath.isEmpty {
            service.addToRecentProjects(payload.projectPath)
            recentProjects = service.loadRecentProjects()
        }
    }
    
    private func applyCliStatus(_ status: BridgeCliStatusMessage) {
        guard let instanceId = status.instanceId else { return }
        
        let newStatus: InstanceStatus = status.status ?? (status.connected ? .connected : .disconnected)
        
        if var existing = instances[instanceId] {
            existing.status = newStatus
            existing.error = status.error ?? existing.error
            instances[instanceId] = existing
        } else if status.connected {
            let provider = instances[instanceId]?.provider ?? .gemini
            instances[instanceId] = InstanceState(
                id: instanceId,
                projectPath: "",
                status: newStatus,
                history: [],
                pending: [],
                streamingState: .idle,
                isTrustedFolder: false,
                currentModel: provider.defaultModel,
                availableModels: [],
                error: status.error,
                provider: provider
            )
        }
    }
    
    private func applyInstanceList(_ infoList: [SessionInstanceInfo]) {
        var seen = Set<String>()

        for info in infoList {
            seen.insert(info.id)
            let status: InstanceStatus = info.status ?? (info.connected ? .connected : .disconnected)
            let provider = info.provider ?? instances[info.id]?.provider ?? .gemini

            if var existing = instances[info.id] {
                existing.projectPath = info.projectPath
                existing.status = status
                existing.error = info.error ?? existing.error
                existing.provider = provider
                instances[info.id] = existing
            } else {
                instances[info.id] = InstanceState(
                    id: info.id,
                    projectPath: info.projectPath,
                    status: status,
                    history: [],
                    pending: [],
                    streamingState: .idle,
                    isTrustedFolder: false,
                    currentModel: provider.defaultModel,
                    availableModels: [],
                    error: info.error,
                    provider: provider
                )
            }
        }
        
        // Remove instances that are no longer in the list
        for id in instances.keys where !seen.contains(id) {
            instances.removeValue(forKey: id)
        }
        
        // Update active instance
        if let current = activeInstanceId, !seen.contains(current) {
            activeInstanceId = infoList.first?.id
        } else if activeInstanceId == nil {
            activeInstanceId = infoList.first?.id
        }
    }
    
    private func applyError(_ error: BridgeErrorMessage) {
        guard let instanceId = error.instanceId, var existing = instances[instanceId] else { return }
        existing.status = .error
        existing.error = error.error
        instances[instanceId] = existing
    }

    // MARK: - Helper Methods

    private func extractToolNameFromPending(_ pending: [Message]?) -> String {
        guard let pending = pending else { return "Tool" }

        for message in pending {
            if case .toolGroup(let tools) = message {
                // Get the first tool name from the tool group
                if let firstTool = tools.first {
                    return firstTool.name
                }
            }
        }

        return "Tool"
    }
}

// MARK: - InstanceState Extensions

extension InstanceState {
    var projectName: String {
        projectPath.split(separator: "/").last.map(String.init) ?? projectPath
    }
    
    var allMessages: [Message] {
        history + pending
    }
}

extension InstanceState: Equatable {
    static func == (lhs: InstanceState, rhs: InstanceState) -> Bool {
        lhs.id == rhs.id &&
        lhs.projectPath == rhs.projectPath &&
        lhs.status == rhs.status &&
        lhs.streamingState == rhs.streamingState &&
        lhs.currentModel == rhs.currentModel &&
        lhs.error == rhs.error
    }
}
