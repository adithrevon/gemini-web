import Foundation

/// Network service handling SSE streaming and HTTP commands to the Gemini Web server
@MainActor
final class SessionService: NSObject {
    
    // MARK: - Configuration
    
    private static let sessionIdKey = "gemini-app-session-id"
    private static let recentProjectsKey = "gemini-app-recent-projects"
    private static let serverURLKey = "gemini-app-server-url"
    private static let serverURLHistoryKey = "gemini-app-server-url-history"
    private static let maxRecentProjects = 10
    private static let reconnectDelay: TimeInterval = 1.0
    
    static var defaultServerURL: String {
        get { UserDefaults.standard.string(forKey: serverURLKey) ?? "http://127.0.0.1:7337" }
        set {
            UserDefaults.standard.set(newValue, forKey: serverURLKey)
            addToServerURLHistory(newValue)
        }
    }
    
    static var serverURLHistory: [String] {
        get { (UserDefaults.standard.array(forKey: serverURLHistoryKey) as? [String]) ?? ["http://127.0.0.1:7337"] }
        set { UserDefaults.standard.set(newValue, forKey: serverURLHistoryKey) }
    }
    
    static func addToServerURLHistory(_ url: String) {
        var history = serverURLHistory
        history.removeAll { $0 == url }
        history.insert(url, at: 0)
        if history.count > 10 {
            history = Array(history.prefix(10))
        }
        serverURLHistory = history
    }
    
    // MARK: - Properties
    
    private var sessionId: String?
    private var sseClient: SSEClient?
    private var reconnectTask: Task<Void, Never>?
    private var isConnecting = false
    
    weak var delegate: SessionServiceDelegate?
    
    private var baseURL: URL {
        URL(string: Self.defaultServerURL)!
    }
    
    // MARK: - Session Persistence
    
    private func loadSessionId() -> String? {
        UserDefaults.standard.string(forKey: Self.sessionIdKey)
    }
    
    private func saveSessionId(_ id: String) {
        UserDefaults.standard.set(id, forKey: Self.sessionIdKey)
    }
    
    func loadRecentProjects() -> [String] {
        (UserDefaults.standard.array(forKey: Self.recentProjectsKey) as? [String]) ?? []
    }
    
    func saveRecentProjects(_ projects: [String]) {
        UserDefaults.standard.set(projects, forKey: Self.recentProjectsKey)
    }
    
    func addToRecentProjects(_ projectPath: String) {
        var projects = loadRecentProjects()
        projects.removeAll { $0 == projectPath }
        projects.insert(projectPath, at: 0)
        if projects.count > Self.maxRecentProjects {
            projects = Array(projects.prefix(Self.maxRecentProjects))
        }
        saveRecentProjects(projects)
    }
    
    // MARK: - Connection Management
    
    func connect() {
        guard !isConnecting else { return }
        isConnecting = true
        
        Task {
            await startConnection()
        }
    }
    
    func disconnect() {
        reconnectTask?.cancel()
        reconnectTask = nil
        sseClient?.disconnect()
        sseClient = nil
        isConnecting = false
        sessionId = nil
    }
    
    private func startConnection() async {
        print("╔══════════════════════════════════════════════════════════════")
        print("║ [SessionService] Starting connection")
        print("║ Server URL: \(Self.defaultServerURL)")
        print("║ Base URL: \(baseURL)")
        print("╚══════════════════════════════════════════════════════════════")
        do {
            let sid = try await ensureSession()
            print("[SessionService] ✅ Got session ID: \(sid)")
            sessionId = sid
            connectSSE(sessionId: sid)
        } catch {
            print("[SessionService] ❌ Connection failed: \(error.localizedDescription)")
            await diagnoseNetworkIssue(error: error)
            delegate?.sessionService(self, didDisconnect: error)
            scheduleReconnect()
        }
    }
    
    private func diagnoseNetworkIssue(error: Error) async {
        print("\n╔══════════════════════════════════════════════════════════════")
        print("║ [SessionService] 🔍 NETWORK DIAGNOSTICS")
        print("╠══════════════════════════════════════════════════════════════")
        
        // Check if general internet is reachable
        print("║ Testing general internet (google.com)...")
        do {
            let googleURL = URL(string: "https://www.google.com")!
            var request = URLRequest(url: googleURL)
            request.timeoutInterval = 5
            let (_, response) = try await URLSession.shared.data(for: request)
            if let httpResponse = response as? HTTPURLResponse {
                print("║ ✅ Internet reachable - Google returned: \(httpResponse.statusCode)")
            }
        } catch {
            print("║ ❌ Internet NOT reachable - Google failed: \(error.localizedDescription)")
        }
        
        // Check if our server is reachable
        print("║ Testing server endpoint: \(baseURL)")
        do {
            var request = URLRequest(url: baseURL)
            request.httpMethod = "HEAD"
            request.timeoutInterval = 5
            let (_, response) = try await URLSession.shared.data(for: request)
            if let httpResponse = response as? HTTPURLResponse {
                print("║ ✅ Server reachable - Status: \(httpResponse.statusCode)")
            }
        } catch {
            print("║ ❌ Server NOT reachable: \(error.localizedDescription)")
        }
        
        print("╚══════════════════════════════════════════════════════════════\n")
    }
    
    private func ensureSession() async throws -> String {
        let existingId = loadSessionId()
        let url = baseURL.appendingPathComponent("/api/session")
        
        print("[SessionService] 📡 POST \(url)")
        print("[SessionService] Existing session ID: \(existingId ?? "none")")
        
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 30
        
        if let existingId = existingId {
            let body = ["sessionId": existingId]
            request.httpBody = try JSONEncoder().encode(body)
            print("[SessionService] Request body: {sessionId: \"\(existingId)\"}")
        } else {
            request.httpBody = "{}".data(using: .utf8)
            print("[SessionService] Request body: {}")
        }
        
        let (data, response) = try await URLSession.shared.data(for: request)
        
        guard let httpResponse = response as? HTTPURLResponse else {
            print("[SessionService] ❌ Invalid response type")
            throw SessionError.sessionCreationFailed
        }
        
        print("[SessionService] Response status: \(httpResponse.statusCode)")
        
        guard httpResponse.statusCode == 200 else {
            print("[SessionService] ❌ Non-200 status code")
            if let responseBody = String(data: data, encoding: .utf8) {
                print("[SessionService] Response body: \(responseBody)")
            }
            throw SessionError.sessionCreationFailed
        }
        
        struct SessionResponse: Codable {
            let sessionId: String?
        }
        
        let sessionResponse = try JSONDecoder().decode(SessionResponse.self, from: data)
        guard let sessionId = sessionResponse.sessionId else {
            print("[SessionService] ❌ No sessionId in response")
            throw SessionError.sessionCreationFailed
        }
        
        print("[SessionService] ✅ Session created: \(sessionId)")
        saveSessionId(sessionId)
        return sessionId
    }
    
    private func connectSSE(sessionId: String) {
        let url = baseURL.appendingPathComponent("/api/session/\(sessionId)/events")
        let client = SSEClient(url: url)
        self.sseClient = client
        
        client.onOpen = { [weak self] in
            guard let self = self else { return }
            self.delegate?.sessionServiceDidConnect(self)
        }
        
        client.onMessage = { [weak self] jsonString in
            guard let self = self else { return }
            self.processEvent(jsonString)
        }
        
        client.onError = { [weak self] error in
            guard let self = self else { return }
            self.delegate?.sessionService(self, didDisconnect: error ?? SessionError.sseConnectionFailed)
            self.scheduleReconnect()
        }
        
        client.connect()
    }
    
    private func scheduleReconnect() {
        reconnectTask?.cancel()
        reconnectTask = Task {
            try? await Task.sleep(nanoseconds: UInt64(Self.reconnectDelay * 1_000_000_000))
            if !Task.isCancelled {
                await startConnection()
            }
        }
    }
    
    private func processEvent(_ jsonString: String) {
        guard let data = jsonString.data(using: .utf8) else { return }
        
        do {
            let message = try JSONDecoder().decode(IncomingMessage.self, from: data)
            delegate?.sessionService(self, didReceive: message)
        } catch {
            print("[SessionService] Failed to parse event: \(error)")
        }
    }
    
    // MARK: - Commands
    
    private func sendCommand(_ message: OutgoingMessage) async throws {
        guard let sessionId = sessionId else {
            throw SessionError.noSession
        }
        
        var request = URLRequest(url: baseURL.appendingPathComponent("/api/session/\(sessionId)/command"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(message)
        
        let (_, response) = try await URLSession.shared.data(for: request)
        
        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            throw SessionError.commandFailed
        }
    }
    
    func spawnInstance(projectPath: String) async throws -> (instanceId: String, resolvedPath: String) {
        guard let sessionId = sessionId else {
            throw SessionError.noSession
        }
        
        var request = URLRequest(url: baseURL.appendingPathComponent("/api/session/\(sessionId)/command"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(OutgoingMessage.spawnInstance(projectPath: projectPath))
        
        let (data, response) = try await URLSession.shared.data(for: request)
        
        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            throw SessionError.commandFailed
        }
        
        let spawnResponse = try JSONDecoder().decode(SpawnInstanceResponse.self, from: data)
        guard let instanceId = spawnResponse.instanceId else {
            throw SessionError.spawnFailed
        }
        
        return (instanceId, spawnResponse.resolvedPath ?? projectPath)
    }
    
    func submit(text: String, instanceId: String) async throws {
        try await sendCommand(.submit(instanceId: instanceId, text: text))
    }
    
    func confirm(callId: String, outcome: ConfirmOutcome, correlationId: String?, instanceId: String) async throws {
        try await sendCommand(.confirm(instanceId: instanceId, callId: callId, outcome: outcome, correlationId: correlationId))
    }
    
    func setModel(_ model: String, instanceId: String) async throws {
        try await sendCommand(.setModel(instanceId: instanceId, model: model))
    }
    
    func terminateInstance(_ instanceId: String) async throws {
        try await sendCommand(.terminateInstance(instanceId: instanceId))
    }
    
    func setActiveInstance(_ instanceId: String) async throws {
        try await sendCommand(.setActiveInstance(instanceId: instanceId))
    }
}

// MARK: - Delegate Protocol

@MainActor
protocol SessionServiceDelegate: AnyObject {
    func sessionServiceDidConnect(_ service: SessionService)
    func sessionService(_ service: SessionService, didReceive message: IncomingMessage)
    func sessionService(_ service: SessionService, didDisconnect error: Error)
}

// MARK: - Errors

enum SessionError: Error, LocalizedError {
    case sessionCreationFailed
    case sseConnectionFailed
    case noSession
    case commandFailed
    case spawnFailed
    
    var errorDescription: String? {
        switch self {
        case .sessionCreationFailed: return "Failed to create session"
        case .sseConnectionFailed: return "Failed to connect to event stream"
        case .noSession: return "No active session"
        case .commandFailed: return "Command failed"
        case .spawnFailed: return "Failed to spawn CLI instance"
        }
    }
}
