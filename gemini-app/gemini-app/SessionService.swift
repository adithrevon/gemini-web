import Foundation
import os.log

private let logger = Logger(subsystem: Bundle.main.bundleIdentifier ?? "gemini-app", category: "SessionService")

/// Network service handling SSE streaming and HTTP commands to the Gemini Web server
@MainActor
final class SessionService: NSObject {

    // MARK: - Configuration

    private static let sessionIdKey = "gemini-app-session-id"
    private static let recentProjectsKey = "gemini-app-recent-projects"
    private static let serverURLKey = "gemini-app-server-url"
    private static let serverURLHistoryKey = "gemini-app-server-url-history"
    private static let reconnectDelay: TimeInterval = 1.0

    static var defaultServerURL: String {
        get { UserDefaults.standard.string(forKey: serverURLKey) ?? AppConstants.defaultServerURL }
        set {
            UserDefaults.standard.set(newValue, forKey: serverURLKey)
            addToServerURLHistory(newValue)
        }
    }

    static var serverURLHistory: [String] {
        get { (UserDefaults.standard.array(forKey: serverURLHistoryKey) as? [String]) ?? [AppConstants.defaultServerURL] }
        set { UserDefaults.standard.set(newValue, forKey: serverURLHistoryKey) }
    }

    static func addToServerURLHistory(_ url: String) {
        var history = serverURLHistory
        history.removeAll { $0 == url }
        history.insert(url, at: 0)
        if history.count > AppConstants.maxRecentProjects {
            history = Array(history.prefix(AppConstants.maxRecentProjects))
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

    /// Returns a server-specific key for storing recent projects
    private func recentProjectsKey(for serverURL: String) -> String {
        // Use a hash of the URL to keep key length reasonable
        let sanitized = serverURL.replacingOccurrences(of: "://", with: "-")
            .replacingOccurrences(of: "/", with: "-")
            .replacingOccurrences(of: ":", with: "-")
        return "\(Self.recentProjectsKey)-\(sanitized)"
    }

    func loadRecentProjects() -> [String] {
        let key = recentProjectsKey(for: Self.defaultServerURL)
        return (UserDefaults.standard.array(forKey: key) as? [String]) ?? []
    }

    func saveRecentProjects(_ projects: [String]) {
        let key = recentProjectsKey(for: Self.defaultServerURL)
        UserDefaults.standard.set(projects, forKey: key)
    }

    func addToRecentProjects(_ projectPath: String) {
        var projects = loadRecentProjects()
        projects.removeAll { $0 == projectPath }
        projects.insert(projectPath, at: 0)
        if projects.count > AppConstants.maxRecentProjects {
            projects = Array(projects.prefix(AppConstants.maxRecentProjects))
        }
        saveRecentProjects(projects)
    }

    // MARK: - Directory Browsing

    /// Browse directories on the server
    func browseDirectory(_ path: String?) async throws -> DirectoryListing {
        let browseURL = URL(string: Self.defaultServerURL)!.appendingPathComponent("api/browse")
        var components = URLComponents(url: browseURL, resolvingAgainstBaseURL: true)!
        if let path = path {
            components.queryItems = [URLQueryItem(name: "path", value: path)]
        }

        var request = URLRequest(url: components.url!)
        request.httpMethod = "GET"
        request.timeoutInterval = 10

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            throw SessionError.commandFailed
        }

        return try JSONDecoder().decode(DirectoryListing.self, from: data)
    }

    /// Validate that a path exists on the server
    func validatePath(_ path: String) async throws -> PathValidation {
        let validateURL = URL(string: Self.defaultServerURL)!.appendingPathComponent("api/validate-path")
        var components = URLComponents(url: validateURL, resolvingAgainstBaseURL: true)!
        components.queryItems = [URLQueryItem(name: "path", value: path)]

        var request = URLRequest(url: components.url!)
        request.httpMethod = "GET"
        request.timeoutInterval = 5

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            return PathValidation(valid: false, path: path, name: nil, isProject: false, error: "Path not found")
        }

        return try JSONDecoder().decode(PathValidation.self, from: data)
    }

    // MARK: - Server Validation

    /// Validates that a server URL is reachable and responds correctly
    static func validateServer(_ urlString: String) async -> Result<Void, ServerValidationError> {
        guard let url = URL(string: urlString) else {
            return .failure(.invalidURL)
        }

        let healthURL = url.appendingPathComponent("/health")
        var request = URLRequest(url: healthURL)
        request.httpMethod = "GET"
        request.timeoutInterval = 5

        do {
            let (_, response) = try await URLSession.shared.data(for: request)

            guard let httpResponse = response as? HTTPURLResponse else {
                return .failure(.invalidResponse)
            }

            if httpResponse.statusCode == 200 {
                return .success(())
            } else {
                return .failure(.serverError(httpResponse.statusCode))
            }
        } catch let error as URLError {
            switch error.code {
            case .cannotFindHost, .cannotConnectToHost:
                return .failure(.unreachable)
            case .timedOut:
                return .failure(.timeout)
            default:
                return .failure(.networkError(error.localizedDescription))
            }
        } catch {
            return .failure(.networkError(error.localizedDescription))
        }
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
        logger.info("Starting connection to \(Self.defaultServerURL)")
        do {
            let sid = try await ensureSession()
            logger.info("Session established: \(sid)")
            sessionId = sid
            connectSSE(sessionId: sid)
        } catch {
            logger.error("Connection failed: \(error.localizedDescription)")
            delegate?.sessionService(self, didDisconnect: error)
            scheduleReconnect()
        }
    }

    private func ensureSession() async throws -> String {
        let existingId = loadSessionId()
        let url = baseURL.appendingPathComponent("/api/session")

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 30

        if let existingId = existingId {
            let body = ["sessionId": existingId]
            request.httpBody = try JSONEncoder().encode(body)
        } else {
            request.httpBody = "{}".data(using: .utf8)
        }

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw SessionError.sessionCreationFailed
        }

        guard httpResponse.statusCode == 200 else {
            throw SessionError.sessionCreationFailed
        }

        struct SessionResponse: Codable {
            let sessionId: String?
        }

        let sessionResponse = try JSONDecoder().decode(SessionResponse.self, from: data)
        guard let sessionId = sessionResponse.sessionId else {
            throw SessionError.sessionCreationFailed
        }

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
            logger.warning("Failed to parse event: \(error.localizedDescription)")
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

    func interrupt(_ instanceId: String) async throws {
        try await sendCommand(.interrupt(instanceId: instanceId))
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

enum ServerValidationError: Error, LocalizedError {
    case invalidURL
    case unreachable
    case timeout
    case invalidResponse
    case serverError(Int)
    case networkError(String)

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "Invalid server URL"
        case .unreachable: return "Server is unreachable"
        case .timeout: return "Connection timed out"
        case .invalidResponse: return "Invalid server response"
        case .serverError(let code): return "Server error (HTTP \(code))"
        case .networkError(let message): return message
        }
    }
}
