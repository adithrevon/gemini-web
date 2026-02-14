import Foundation

// MARK: - Streaming State

enum StreamingState: String, Codable {
    case idle
    case responding
    case tool
    case waiting_for_confirmation
}

enum InstanceStatus: String, Codable {
    case connecting
    case connected
    case disconnected
    case error
}

struct ModelOption: Codable, Identifiable, Hashable {
    let value: String
    let label: String
    let description: String?
    let isAuto: Bool

    var id: String { value }
}

struct AnsiToken: Codable {
    let text: String?
}

typealias AnsiLine = [AnsiToken]

struct TodoItem: Codable, Identifiable {
    let id: String
    let subject: String
    let description: String?
    let status: String
    let blockedBy: [String]?
    let blocks: [String]?
    let createdAt: String?
    let completedAt: String?
}

struct TodoList: Codable {
    let items: [TodoItem]
    let lastUpdated: String
}

struct ModelUsageStats: Codable {
    let requests: Int
    let inputTokens: Int
    let outputTokens: Int
    let cachedTokens: Int
}

struct UsageMetrics: Codable {
    let totalInputTokens: Int?
    let totalOutputTokens: Int?
    let totalCachedTokens: Int?
    let totalTokens: Int?
    let totalCostUsd: Double?
    let totalApiCalls: Int?
    let totalApiErrors: Int?
    let totalApiLatencyMs: Int?
    let totalToolCalls: Int?
    let totalToolSuccess: Int?
    let totalToolFail: Int?
    let numTurns: Int?
    let durationMs: Int?
    let modelBreakdown: [String: ModelUsageStats]?
}

// MARK: - Usage Limits (Claude)

struct UsageLimits: Codable {
    let fiveHour: UsageLimitData
    let sevenDay: UsageLimitData

    enum CodingKeys: String, CodingKey {
        case fiveHour = "five_hour"
        case sevenDay = "seven_day"
    }
}

struct UsageLimitData: Codable {
    let utilization: Double
    let resetsAt: String

    enum CodingKeys: String, CodingKey {
        case utilization
        case resetsAt = "resets_at"
    }
}

struct ToolResultDisplay: Codable {
    let fileDiff: String?
    let todos: [TodoItem]?
}

struct ConfirmationDetails: Codable {
    let type: String
    let title: String?
    let command: String?
    let rootCommand: String?
    let prompt: String?
    let toolDisplayName: String?
    let toolName: String?
    let fileName: String?
    let filePath: String?
    let fileDiff: String?
}

struct ToolCall: Codable, Identifiable {
    let callId: String
    let name: String
    let description: String?
    var status: String?
    var resultDisplay: ToolResult?
    var confirmationDetails: ConfirmationDetails?
    let correlationId: String?

    var id: String { callId }

    var renderedResult: String? {
        guard let resultDisplay else { return nil }
        switch resultDisplay {
        case .text(let text):
            return text
        case .ansi(let lines):
            return lines.map { line in
                line.map { $0.text ?? "" }.joined()
            }.joined(separator: "\n")
        case .display(let display):
            if let fileDiff = display.fileDiff {
                return fileDiff
            }
            if let todos = display.todos {
                return todos.map { todo in
                    let status = todo.status ?? "pending"
                    let description = todo.description ?? ""
                    return "[\(status)] \(description)"
                }.joined(separator: "\n")
            }
            return nil
        case .json(let value):
            return value.toPrettyString()
        }
    }
}

enum ToolResult: Codable {
    case text(String)
    case ansi([[AnsiToken]])
    case display(ToolResultDisplay)
    case json(JSONValue)

    init(from decoder: Decoder) throws {
        if let text = try? decoder.singleValueContainer().decode(String.self) {
            self = .text(text)
            return
        }
        if let ansi = try? decoder.singleValueContainer().decode([[AnsiToken]].self) {
            self = .ansi(ansi)
            return
        }
        if let display = try? decoder.singleValueContainer().decode(ToolResultDisplay.self) {
            self = .display(display)
            return
        }
        if let value = try? decoder.singleValueContainer().decode(JSONValue.self) {
            self = .json(value)
            return
        }
        self = .json(.null)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .text(let text):
            try container.encode(text)
        case .ansi(let lines):
            try container.encode(lines)
        case .display(let display):
            try container.encode(display)
        case .json(let value):
            try container.encode(value)
        }
    }
}

indirect enum JSONValue: Codable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .null
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value):
            try container.encode(value)
        case .number(let value):
            try container.encode(value)
        case .bool(let value):
            try container.encode(value)
        case .object(let value):
            try container.encode(value)
        case .array(let value):
            try container.encode(value)
        case .null:
            try container.encodeNil()
        }
    }

    func toPrettyString() -> String {
        guard JSONSerialization.isValidJSONObject(toAny()) else {
            return ""
        }
        do {
            let data = try JSONSerialization.data(withJSONObject: toAny(), options: [.prettyPrinted, .sortedKeys])
            return String(data: data, encoding: .utf8) ?? ""
        } catch {
            return ""
        }
    }

    private func toAny() -> Any {
        switch self {
        case .string(let value):
            return value
        case .number(let value):
            return value
        case .bool(let value):
            return value
        case .object(let value):
            return value.mapValues { $0.toAny() }
        case .array(let value):
            return value.map { $0.toAny() }
        case .null:
            return NSNull()
        }
    }
}

struct BridgeUpdatePayload: Decodable {
    let instanceId: String
    let projectPath: String
    let history: [Message]?
    let pending: [Message]?
    let streamingState: StreamingState?
    let isTrustedFolder: Bool?
    let currentModel: String?
    let availableModels: [ModelOption]?
    let hasPreviewAccess: Bool?
    let usageMetrics: UsageMetrics?
    let todos: TodoList?
}

// MARK: - Session State (new event-based format)

struct InstanceMetadata: Decodable {
    let id: String
    let projectPath: String
    let yolo: Bool
}

struct SessionStateMessage: Decodable {
    let type: String
    let sessionId: String
    let instances: [InstanceMetadata]
}

// MARK: - Claude Event Types

struct ClaudeToolInfo: Decodable {
    let callId: String
    let name: String
    let input: [String: JSONValue]?
    let description: String
}

struct ClaudeTextDeltaEvent: Decodable {
    let instanceId: String
    let text: String
    let seq: Int
}

struct ClaudeTextCompleteEvent: Decodable {
    let instanceId: String
    let text: String
    let seq: Int
}

struct ClaudeToolAddedEvent: Decodable {
    let instanceId: String
    let tool: ClaudeToolInfo
    let confirmationDetails: ConfirmationDetails?
    let seq: Int
}

struct ClaudeToolStatusEvent: Decodable {
    let instanceId: String
    let toolId: String
    let status: String
    let seq: Int
}

struct ClaudeToolResultEvent: Decodable {
    let instanceId: String
    let toolId: String
    let result: JSONValue?
    let seq: Int
}

struct ClaudeStreamingStateEvent: Decodable {
    let instanceId: String
    let state: StreamingState
    let seq: Int
}

struct ClaudeModelsAvailableEvent: Decodable {
    let instanceId: String
    let models: [ModelOption]
    let seq: Int
}

struct ClaudeSessionCompleteEvent: Decodable {
    let instanceId: String
    let sessionId: String
    let seq: Int
}

struct ServerRestartedEvent: Decodable {
    let message: String
    let seq: Int
}

// MARK: - Legacy types (kept for backward compat)

struct BridgeUpdateMessage: Decodable {
    let type: String
    let payload: BridgeUpdatePayload
}

struct BridgeErrorMessage: Decodable {
    let type: String
    let instanceId: String?
    let error: String
}

enum Message: Codable {
    case user(String)
    case gemini(String)
    case geminiContent(String)
    case toolGroup([ToolCall])

    private enum CodingKeys: String, CodingKey {
        case type
        case text
        case tools
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "user":
            let text = try container.decode(String.self, forKey: .text)
            self = .user(text)
        case "gemini":
            let text = try container.decode(String.self, forKey: .text)
            self = .gemini(text)
        case "gemini_content":
            let text = try container.decode(String.self, forKey: .text)
            self = .geminiContent(text)
        case "tool_group":
            let tools = try container.decode([ToolCall].self, forKey: .tools)
            self = .toolGroup(tools)
        default:
            self = .gemini("")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .user(let text):
            try container.encode("user", forKey: .type)
            try container.encode(text, forKey: .text)
        case .gemini(let text):
            try container.encode("gemini", forKey: .type)
            try container.encode(text, forKey: .text)
        case .geminiContent(let text):
            try container.encode("gemini_content", forKey: .type)
            try container.encode(text, forKey: .text)
        case .toolGroup(let tools):
            try container.encode("tool_group", forKey: .type)
            try container.encode(tools, forKey: .tools)
        }
    }
}

enum IncomingMessage: Decodable {
    // Session lifecycle
    case sessionState(SessionStateMessage)
    case bridgeError(BridgeErrorMessage)

    // Claude events (event-based architecture)
    case claudeTextDelta(ClaudeTextDeltaEvent)
    case claudeTextComplete(ClaudeTextCompleteEvent)
    case claudeToolAdded(ClaudeToolAddedEvent)
    case claudeToolStatus(ClaudeToolStatusEvent)
    case claudeToolResult(ClaudeToolResultEvent)
    case claudeStreamingState(ClaudeStreamingStateEvent)
    case claudeModelsAvailable(ClaudeModelsAvailableEvent)
    case claudeSessionComplete(ClaudeSessionCompleteEvent)
    case serverRestarted(ServerRestartedEvent)

    // Legacy (kept for backward compat)
    case bridgeUpdate(BridgeUpdateMessage)
    case unknown(String)

    private enum CodingKeys: String, CodingKey {
        case type
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "session_state":
            self = .sessionState(try SessionStateMessage(from: decoder))
        case "bridge:error":
            self = .bridgeError(try BridgeErrorMessage(from: decoder))
        case "claude:text_delta":
            self = .claudeTextDelta(try ClaudeTextDeltaEvent(from: decoder))
        case "claude:text_complete":
            self = .claudeTextComplete(try ClaudeTextCompleteEvent(from: decoder))
        case "claude:tool_added":
            self = .claudeToolAdded(try ClaudeToolAddedEvent(from: decoder))
        case "claude:tool_status":
            self = .claudeToolStatus(try ClaudeToolStatusEvent(from: decoder))
        case "claude:tool_result":
            self = .claudeToolResult(try ClaudeToolResultEvent(from: decoder))
        case "claude:streaming_state":
            self = .claudeStreamingState(try ClaudeStreamingStateEvent(from: decoder))
        case "claude:models_available":
            self = .claudeModelsAvailable(try ClaudeModelsAvailableEvent(from: decoder))
        case "claude:session_complete":
            self = .claudeSessionComplete(try ClaudeSessionCompleteEvent(from: decoder))
        case "server:restarted":
            self = .serverRestarted(try ServerRestartedEvent(from: decoder))
        case "bridge:update":
            self = .bridgeUpdate(try BridgeUpdateMessage(from: decoder))
        default:
            self = .unknown(type)
        }
    }
}

enum ConfirmOutcome: String, Encodable {
    case proceed_once
    case proceed_always
    case cancel
}

enum OutgoingMessage: Encodable {
    case submit(instanceId: String, text: String)
    case confirm(instanceId: String, callId: String, outcome: ConfirmOutcome, correlationId: String?)
    case setModel(instanceId: String, model: String)
    case togglePlanMode(instanceId: String)
    case toggleYolo(instanceId: String, yolo: Bool)
    case spawnInstance(projectPath: String, yolo: Bool = false)
    case terminateInstance(instanceId: String)
    case setActiveInstance(instanceId: String)
    case interrupt(instanceId: String)

    private enum CodingKeys: String, CodingKey {
        case type
        case instanceId
        case text
        case callId
        case outcome
        case correlationId
        case model
        case projectPath
        case yolo
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .submit(let instanceId, let text):
            try container.encode("submit", forKey: .type)
            try container.encode(instanceId, forKey: .instanceId)
            try container.encode(text, forKey: .text)
        case .confirm(let instanceId, let callId, let outcome, let correlationId):
            try container.encode("confirm", forKey: .type)
            try container.encode(instanceId, forKey: .instanceId)
            try container.encode(callId, forKey: .callId)
            try container.encode(outcome, forKey: .outcome)
            try container.encodeIfPresent(correlationId, forKey: .correlationId)
        case .setModel(let instanceId, let model):
            try container.encode("setModel", forKey: .type)
            try container.encode(instanceId, forKey: .instanceId)
            try container.encode(model, forKey: .model)
        case .togglePlanMode(let instanceId):
            try container.encode("togglePlanMode", forKey: .type)
            try container.encode(instanceId, forKey: .instanceId)
        case .toggleYolo(let instanceId, let yolo):
            try container.encode("toggleYolo", forKey: .type)
            try container.encode(instanceId, forKey: .instanceId)
            try container.encode(yolo, forKey: .yolo)
        case .spawnInstance(let projectPath, let yolo):
            try container.encode("spawnInstance", forKey: .type)
            try container.encode(projectPath, forKey: .projectPath)
            try container.encode(yolo, forKey: .yolo)
        case .terminateInstance(let instanceId):
            try container.encode("terminateInstance", forKey: .type)
            try container.encode(instanceId, forKey: .instanceId)
        case .setActiveInstance(let instanceId):
            try container.encode("setActiveInstance", forKey: .type)
            try container.encode(instanceId, forKey: .instanceId)
        case .interrupt(let instanceId):
            try container.encode("interrupt", forKey: .type)
            try container.encode(instanceId, forKey: .instanceId)
        }
    }
}

struct SpawnInstanceResponse: Decodable {
    let instanceId: String?
    let resolvedPath: String?
}

struct InstanceState: Identifiable {
    let id: String
    var projectPath: String
    var status: InstanceStatus
    var history: [Message]
    var pending: [Message]
    var streamingState: StreamingState
    var isTrustedFolder: Bool
    var currentModel: String
    var availableModels: [ModelOption]
    var error: String?
    var usageMetrics: UsageMetrics?
    var todos: TodoList?
    var planModeActive: Bool = false
    var yolo: Bool = false
    var isSudoTransitioning: Bool = false
    var isTextAccumulating: Bool = false
}

// MARK: - Directory Browsing

struct DirectoryEntry: Codable, Identifiable {
    let name: String
    let path: String

    var id: String { path }
}

struct DirectoryListing: Codable {
    let path: String
    let parent: String
    let directories: [DirectoryEntry]
    let isProject: Bool
    let name: String
}

struct PathValidation: Codable {
    let valid: Bool
    let path: String
    let name: String?
    let isProject: Bool
    var error: String?
}
