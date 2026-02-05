import Foundation
import SwiftUI

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
    
    // MARK: - Initialization
    
    init() {
        service.delegate = self
        recentProjects = service.loadRecentProjects()
    }
    
    // MARK: - Connection
    
    func connect() {
        service.connect()
    }
    
    func disconnect() {
        service.disconnect()
        connected = false
    }
    
    // MARK: - Instance Management
    
    func spawnInstance(projectPath: String) async -> String? {
        guard !projectPath.isEmpty else { return nil }
        
        do {
            let (instanceId, resolvedPath) = try await service.spawnInstance(projectPath: projectPath)
            
            // Create local instance state immediately
            instances[instanceId] = InstanceState(
                id: instanceId,
                projectPath: resolvedPath,
                status: .connecting,
                history: [],
                pending: [],
                streamingState: .idle,
                isTrustedFolder: false,
                currentModel: "auto-gemini-2.5",
                availableModels: [],
                error: nil
            )
            
            activeInstanceId = instanceId
            return instanceId
        } catch {
            print("[SessionStore] spawnInstance failed: \(error)")
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
    
    // MARK: - SessionServiceDelegate
    
    nonisolated func sessionServiceDidConnect(_ service: SessionService) {
        Task { @MainActor in
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
            connected = false
        }
    }
    
    // MARK: - Message Handling
    
    private func handleMessage(_ message: IncomingMessage) {
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
    
    private func applySessionState(_ state: SessionStateMessage) {
        var newInstances: [String: InstanceState] = [:]
        
        // Apply instance info
        for info in state.instances {
            let status: InstanceStatus = info.status ?? (info.connected ? .connected : .disconnected)
            newInstances[info.id] = InstanceState(
                id: info.id,
                projectPath: info.projectPath,
                status: status,
                history: [],
                pending: [],
                streamingState: .idle,
                isTrustedFolder: false,
                currentModel: "auto-gemini-2.5",
                availableModels: [],
                error: info.error
            )
        }
        
        // Apply snapshots
        for snapshot in state.snapshots {
            let existing = newInstances[snapshot.instanceId]
            newInstances[snapshot.instanceId] = InstanceState(
                id: snapshot.instanceId,
                projectPath: snapshot.projectPath,
                status: .connected,
                history: snapshot.history ?? [],
                pending: snapshot.pending ?? [],
                streamingState: snapshot.streamingState ?? .idle,
                isTrustedFolder: snapshot.isTrustedFolder ?? false,
                currentModel: snapshot.currentModel ?? existing?.currentModel ?? "auto-gemini-2.5",
                availableModels: snapshot.availableModels ?? existing?.availableModels ?? [],
                error: nil
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
        
        instances[payload.instanceId] = InstanceState(
            id: payload.instanceId,
            projectPath: payload.projectPath,
            status: .connected,
            history: payload.history ?? [],
            pending: payload.pending ?? [],
            streamingState: payload.streamingState ?? .idle,
            isTrustedFolder: payload.isTrustedFolder ?? false,
            currentModel: payload.currentModel ?? existing?.currentModel ?? "auto-gemini-2.5",
            availableModels: payload.availableModels ?? existing?.availableModels ?? [],
            error: nil
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
            instances[instanceId] = InstanceState(
                id: instanceId,
                projectPath: "",
                status: newStatus,
                history: [],
                pending: [],
                streamingState: .idle,
                isTrustedFolder: false,
                currentModel: "auto-gemini-2.5",
                availableModels: [],
                error: status.error
            )
        }
    }
    
    private func applyInstanceList(_ infoList: [SessionInstanceInfo]) {
        var seen = Set<String>()
        
        for info in infoList {
            seen.insert(info.id)
            let status: InstanceStatus = info.status ?? (info.connected ? .connected : .disconnected)
            
            if var existing = instances[info.id] {
                existing.projectPath = info.projectPath
                existing.status = status
                existing.error = info.error ?? existing.error
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
                    currentModel: "auto-gemini-2.5",
                    availableModels: [],
                    error: info.error
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
