import Foundation
import SwiftUI
import os.log

private let logger = Logger(subsystem: Bundle.main.bundleIdentifier ?? "gemini-app", category: "SessionStore")

// MARK: - Persistence Types

struct PersistedInstanceState: Codable {
    let id: String
    let projectPath: String
    let history: [Message]
    let currentModel: String
    let yolo: Bool
    let planModeActive: Bool
}

struct PersistedAppState: Codable {
    let version: Int
    let activeInstanceId: String?
    let instances: [PersistedInstanceState]
}

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
    private var persistTask: Task<Void, Never>?
    private let persistDebounceInterval: TimeInterval = 1.0
    
    // MARK: - Initialization
    
    init() {
        service.delegate = self
        recentProjects = service.loadRecentProjects()
        restoreFromDisk()
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
                self?.saveToDiskNow()
                logger.info("SessionStore: app moved to background, state saved")
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
    
    func spawnInstance(projectPath: String, yolo: Bool = false) async -> String? {
        guard !projectPath.isEmpty else { return nil }

        do {
            let (instanceId, resolvedPath) = try await service.spawnInstance(projectPath: projectPath, yolo: yolo)

            // Create local instance state immediately
            instances[instanceId] = InstanceState(
                id: instanceId,
                projectPath: resolvedPath,
                status: .connecting,
                history: [],
                pending: [],
                streamingState: .idle,
                isTrustedFolder: false,
                currentModel: "",
                availableModels: [],
                error: nil,
                yolo: yolo,
                isSudoTransitioning: false
            )

            activeInstanceId = instanceId
            scheduleSaveToDisk()
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
        scheduleSaveToDisk()
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

        // Add user message to history immediately (server won't echo it back)
        if var instance = instances[instanceId] {
            instance.history.append(.user(text))
            instances[instanceId] = instance
        }

        scheduleSaveToDisk()

        Task {
            try? await service.submit(text: text, instanceId: instanceId)
        }
    }
    
    func sendConfirm(callId: String, outcome: ConfirmOutcome, correlationId: String?) {
        guard let instanceId = activeInstanceId else { return }

        // Optimistic UI update: immediately reflect the user's choice
        if var instance = instances[instanceId] {
            updateTool(in: &instance, callId: callId) { tool in
                tool.status = outcome == .cancel ? "denied" : "approved"
            }
            instances[instanceId] = instance
        }

        Task {
            do {
                try await service.confirm(callId: callId, outcome: outcome, correlationId: correlationId, instanceId: instanceId)
            } catch {
                // Revert to confirming so the user can retry
                logger.error("Failed to send confirm: \(error.localizedDescription)")
                if var instance = instances[instanceId] {
                    updateTool(in: &instance, callId: callId) { tool in
                        tool.status = "confirming"
                    }
                    instances[instanceId] = instance
                }
            }
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

    func togglePlanMode() {
        guard let instanceId = activeInstanceId else { return }

        // Toggle the local state
        if var instance = instances[instanceId] {
            instance.planModeActive.toggle()
            instances[instanceId] = instance

            // Send command to backend
            Task {
                try? await service.togglePlanMode(instanceId: instanceId)
            }
        }
    }

    func toggleSudo(_ newValue: Bool) {
        guard let instanceId = activeInstanceId,
              var instance = instances[instanceId] else { return }

        // Set transitioning state
        instance.isSudoTransitioning = true
        instance.yolo = newValue
        instances[instanceId] = instance

        Task {
            do {
                // Send toggleYolo command to backend
                try await service.toggleYolo(newValue, instanceId: instanceId)

                // Update local state (backend will send state update via SSE)
                if var updatedInstance = instances[instanceId] {
                    updatedInstance.isSudoTransitioning = false
                    updatedInstance.yolo = newValue
                    instances[instanceId] = updatedInstance
                }
            } catch {
                // Failed to toggle - restore state
                if var failedInstance = instances[instanceId] {
                    failedInstance.isSudoTransitioning = false
                    failedInstance.yolo = !newValue // Revert to original value
                    instances[instanceId] = failedInstance
                }
            }
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

        // Claude events (event-based architecture)
        case .claudeTextDelta(let event):
            handleTextDelta(event)
        case .claudeTextComplete(let event):
            handleTextComplete(event)
        case .claudeToolAdded(let event):
            handleToolAdded(event)
        case .claudeToolStatus(let event):
            handleToolStatus(event)
        case .claudeToolResult(let event):
            handleToolResult(event)
        case .claudeStreamingState(let event):
            handleStreamingStateChange(event)
        case .claudeModelsAvailable(let event):
            handleModelsAvailable(event)
        case .claudeSessionComplete(let event):
            handleSessionComplete(event)
        case .serverRestarted:
            logger.info("Server restarted, event buffer lost")

        // Legacy (backward compat)
        case .bridgeUpdate(let update):
            applyBridgeUpdate(update.payload)
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

    // MARK: - Session State

    private func applySessionState(_ state: SessionStateMessage) {
        let serverInstanceIds = Set(state.instances.map { $0.id })

        // Remove instances that no longer exist on server
        for id in instances.keys where !serverInstanceIds.contains(id) {
            instances.removeValue(forKey: id)
        }

        // Update or create entries for server instances
        for meta in state.instances {
            if var existing = instances[meta.id] {
                // Existing local instance: mark connected, update metadata from server
                existing.status = .connected
                if existing.projectPath.isEmpty {
                    existing.projectPath = meta.projectPath
                }
                existing.yolo = meta.yolo
                instances[meta.id] = existing
            } else {
                // New instance from server: create with metadata, empty history
                instances[meta.id] = InstanceState(
                    id: meta.id,
                    projectPath: meta.projectPath,
                    status: .connected,
                    history: [],
                    pending: [],
                    streamingState: .idle,
                    isTrustedFolder: false,
                    currentModel: "",
                    availableModels: [],
                    planModeActive: false,
                    yolo: meta.yolo
                )
            }
        }

        // Update active instance if needed
        if let current = activeInstanceId, !serverInstanceIds.contains(current) {
            activeInstanceId = state.instances.first?.id
        } else if activeInstanceId == nil {
            activeInstanceId = state.instances.first?.id
        }
    }

    // MARK: - Claude Event Handlers

    private func handleTextDelta(_ event: ClaudeTextDeltaEvent) {
        guard var instance = instances[event.instanceId] else { return }
        instance.status = .connected

        if instance.isTextAccumulating, let lastIdx = instance.pending.indices.last,
           case .gemini(let existing) = instance.pending[lastIdx] {
            // Append to current text block
            instance.pending[lastIdx] = .gemini(existing + event.text)
        } else {
            // Start new text block
            instance.pending.append(.gemini(event.text))
            instance.isTextAccumulating = true
        }

        instances[event.instanceId] = instance
    }

    private func handleTextComplete(_ event: ClaudeTextCompleteEvent) {
        guard var instance = instances[event.instanceId] else { return }

        if instance.isTextAccumulating, let lastIdx = instance.pending.indices.last,
           case .gemini = instance.pending[lastIdx] {
            // Replace accumulated text with the definitive complete text
            instance.pending[lastIdx] = .gemini(event.text)
        } else {
            // No prior deltas (edge case) — just add the complete text
            instance.pending.append(.gemini(event.text))
        }
        instance.isTextAccumulating = false

        instances[event.instanceId] = instance
    }

    private func handleToolAdded(_ event: ClaudeToolAddedEvent) {
        guard var instance = instances[event.instanceId] else { return }
        instance.isTextAccumulating = false

        // Check if a tool with this callId already exists (dedup: assistant message
        // emits tool_added without confirmationDetails, then _canUseTool emits it
        // again with confirmationDetails for the same callId).
        if let existing = findTool(in: instance, callId: event.tool.callId),
           event.confirmationDetails != nil {
            // Update the existing entry with confirmation info instead of duplicating.
            // Don't set status here — the separate tool_status event handles that.
            updateTool(in: &instance, callId: event.tool.callId) { tool in
                tool.confirmationDetails = event.confirmationDetails
            }
            instances[event.instanceId] = instance
            return
        }

        let tool = ToolCall(
            callId: event.tool.callId,
            name: event.tool.name,
            description: event.tool.description,
            status: nil,
            resultDisplay: nil,
            confirmationDetails: event.confirmationDetails,
            correlationId: nil
        )

        // Append to existing tool group or start a new one
        if let lastIdx = instance.pending.indices.last,
           case .toolGroup(var tools) = instance.pending[lastIdx] {
            tools.append(tool)
            instance.pending[lastIdx] = .toolGroup(tools)
        } else {
            instance.pending.append(.toolGroup([tool]))
        }

        instances[event.instanceId] = instance
    }

    private func handleToolStatus(_ event: ClaudeToolStatusEvent) {
        guard var instance = instances[event.instanceId] else { return }

        updateTool(in: &instance, callId: event.toolId) { tool in
            tool.status = event.status
        }

        instances[event.instanceId] = instance
    }

    private func handleToolResult(_ event: ClaudeToolResultEvent) {
        guard var instance = instances[event.instanceId] else { return }

        updateTool(in: &instance, callId: event.toolId) { tool in
            if let result = event.result {
                tool.resultDisplay = .json(result)
            }
            if tool.status == nil || tool.status == "pending" || tool.status == "running" {
                tool.status = "success"
            }
        }

        instances[event.instanceId] = instance
    }

    private func handleStreamingStateChange(_ event: ClaudeStreamingStateEvent) {
        guard var instance = instances[event.instanceId] else { return }

        let oldState = instance.streamingState
        let newState = event.state
        instance.streamingState = newState

        // When idle, flush pending to history
        if newState == .idle {
            instance.history.append(contentsOf: instance.pending)
            instance.pending.removeAll()
            instance.isTextAccumulating = false
        }

        instances[event.instanceId] = instance

        // Persist after idle transition (conversation turn complete)
        if newState == .idle {
            scheduleSaveToDisk()
        }

        // --- Notification logic ---
        let wasStreaming = oldState != .idle
        let isNowIdle = newState == .idle
        let isNowWaitingForConfirmation = newState == .waiting_for_confirmation
        let projectPath = instance.projectPath

        // Background notification: conversation completed
        if wasStreaming && isNowIdle && appIsInBackground {
            NotificationService.shared.scheduleConversationCompleteNotification(
                instanceId: event.instanceId,
                projectPath: projectPath
            )
        }

        // In-app notification: conversation completed while viewing different instance
        if wasStreaming && isNowIdle {
            let isViewingDifferentInstance = activeInstanceId != event.instanceId && activeInstanceId != nil
            if isViewingDifferentInstance {
                let projectName = projectPath.split(separator: "/").last.map(String.init) ?? projectPath
                inAppNotificationManager?.show(
                    instanceId: event.instanceId,
                    projectName: projectName,
                    title: "Conversation Complete"
                )
            }
        }

        // Background notification: tool confirmation needed
        if isNowWaitingForConfirmation && appIsInBackground {
            let toolName = extractToolNameFromPending(instance.pending)
            NotificationService.shared.scheduleConfirmationNeededNotification(
                instanceId: event.instanceId,
                toolName: toolName,
                projectPath: projectPath
            )
        }

        // In-app notification: tool confirmation while viewing different instance
        if isNowWaitingForConfirmation {
            let isViewingDifferentInstance = activeInstanceId != event.instanceId && activeInstanceId != nil
            if isViewingDifferentInstance {
                let projectName = projectPath.split(separator: "/").last.map(String.init) ?? projectPath
                let toolName = extractToolNameFromPending(instance.pending)
                inAppNotificationManager?.show(
                    instanceId: event.instanceId,
                    projectName: projectName,
                    title: "Action Required: \(toolName)"
                )
            }
        }
    }

    private func handleModelsAvailable(_ event: ClaudeModelsAvailableEvent) {
        guard var instance = instances[event.instanceId] else { return }
        instance.availableModels = event.models
        instance.status = .connected
        instances[event.instanceId] = instance
    }

    private func handleSessionComplete(_ event: ClaudeSessionCompleteEvent) {
        // Session complete means the SDK turn is done.
        // The sessionId is stored for resume on reconnect.
        // streaming_state: idle should have already flushed pending.
        logger.debug("Session complete for instance: \(event.instanceId), SDK session: \(event.sessionId)")
    }

    // MARK: - Legacy Handlers

    private func applyBridgeUpdate(_ payload: BridgeUpdatePayload) {
        let existing = instances[payload.instanceId]

        instances[payload.instanceId] = InstanceState(
            id: payload.instanceId,
            projectPath: payload.projectPath,
            status: .connected,
            history: payload.history ?? [],
            pending: payload.pending ?? [],
            streamingState: payload.streamingState ?? .idle,
            isTrustedFolder: payload.isTrustedFolder ?? false,
            currentModel: payload.currentModel ?? existing?.currentModel ?? "",
            availableModels: payload.availableModels ?? existing?.availableModels ?? [],
            error: nil,
            usageMetrics: payload.usageMetrics,
            todos: payload.todos,
            planModeActive: existing?.planModeActive ?? false
        )

        if activeInstanceId == nil {
            activeInstanceId = payload.instanceId
        }

        if !payload.projectPath.isEmpty {
            service.addToRecentProjects(payload.projectPath)
            recentProjects = service.loadRecentProjects()
        }
    }

    private func applyError(_ error: BridgeErrorMessage) {
        guard let instanceId = error.instanceId, var existing = instances[instanceId] else { return }
        existing.status = .error
        existing.error = error.error
        instances[instanceId] = existing
    }

    // MARK: - Helper Methods

    /// Check if a tool with the given callId exists in pending or history.
    private func findTool(in instance: InstanceState, callId: String) -> ToolCall? {
        for message in instance.pending {
            if case .toolGroup(let tools) = message,
               let tool = tools.first(where: { $0.callId == callId }) {
                return tool
            }
        }
        for message in instance.history {
            if case .toolGroup(let tools) = message,
               let tool = tools.first(where: { $0.callId == callId }) {
                return tool
            }
        }
        return nil
    }

    /// Find and mutate a ToolCall in the instance's pending messages by callId.
    private func updateTool(in instance: inout InstanceState, callId: String, update: (inout ToolCall) -> Void) {
        for i in instance.pending.indices {
            if case .toolGroup(var tools) = instance.pending[i] {
                if let toolIdx = tools.firstIndex(where: { $0.callId == callId }) {
                    update(&tools[toolIdx])
                    instance.pending[i] = .toolGroup(tools)
                    return
                }
            }
        }
        // Also search history (tool results can arrive after idle in rare cases)
        for i in instance.history.indices {
            if case .toolGroup(var tools) = instance.history[i] {
                if let toolIdx = tools.firstIndex(where: { $0.callId == callId }) {
                    update(&tools[toolIdx])
                    instance.history[i] = .toolGroup(tools)
                    return
                }
            }
        }
    }

    private func extractToolNameFromPending(_ pending: [Message]) -> String {
        for message in pending.reversed() {
            if case .toolGroup(let tools) = message {
                if let lastTool = tools.last {
                    return lastTool.name
                }
            }
        }
        return "Tool"
    }

    // MARK: - Local Persistence

    private static var persistenceURL: URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let dir = appSupport.appendingPathComponent("gemini-app")
        if !FileManager.default.fileExists(atPath: dir.path) {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        return dir.appendingPathComponent("instances.json")
    }

    private func scheduleSaveToDisk() {
        persistTask?.cancel()
        persistTask = Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: UInt64(self.persistDebounceInterval * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self.saveToDiskNow()
        }
    }

    private func saveToDiskNow() {
        let persisted = PersistedAppState(
            version: 1,
            activeInstanceId: activeInstanceId,
            instances: instances.values.map { inst in
                PersistedInstanceState(
                    id: inst.id,
                    projectPath: inst.projectPath,
                    history: inst.history,
                    currentModel: inst.currentModel,
                    yolo: inst.yolo,
                    planModeActive: inst.planModeActive
                )
            }
        )

        do {
            let data = try JSONEncoder().encode(persisted)
            try data.write(to: Self.persistenceURL, options: .atomic)
            logger.debug("Saved \(self.instances.count) instances to disk")
        } catch {
            logger.error("Failed to save instances to disk: \(error.localizedDescription)")
        }
    }

    private func restoreFromDisk() {
        let url = Self.persistenceURL
        guard FileManager.default.fileExists(atPath: url.path) else {
            logger.debug("No persisted state file found")
            return
        }

        do {
            let data = try Data(contentsOf: url)
            let persisted = try JSONDecoder().decode(PersistedAppState.self, from: data)

            for inst in persisted.instances {
                instances[inst.id] = InstanceState(
                    id: inst.id,
                    projectPath: inst.projectPath,
                    status: .disconnected,
                    history: inst.history,
                    pending: [],
                    streamingState: .idle,
                    isTrustedFolder: false,
                    currentModel: inst.currentModel,
                    availableModels: [],
                    planModeActive: inst.planModeActive,
                    yolo: inst.yolo
                )
            }

            activeInstanceId = persisted.activeInstanceId
            logger.info("Restored \(persisted.instances.count) instances from disk")
        } catch {
            logger.error("Failed to restore instances from disk: \(error.localizedDescription)")
        }
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
