import Foundation

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

struct TodoItem: Codable {
    let status: String?
    let description: String?
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

struct ToolCall: Decodable, Identifiable {
    let callId: String
    let name: String
    let description: String?
    let status: String?
    let resultDisplay: ToolResult?
    let confirmationDetails: ConfirmationDetails?
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

enum ToolResult: Decodable {
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
}

struct SessionInstanceInfo: Codable {
    let id: String
    let projectPath: String
    let connected: Bool
    let status: InstanceStatus?
    let error: String?
}

struct SessionStateMessage: Decodable {
    let type: String
    let sessionId: String
    let activeInstanceId: String?
    let instances: [SessionInstanceInfo]
    let snapshots: [BridgeUpdatePayload]
}

struct BridgeUpdateMessage: Decodable {
    let type: String
    let payload: BridgeUpdatePayload
}

struct BridgeCliStatusMessage: Decodable {
    let type: String
    let connected: Bool
    let instanceId: String?
    let status: InstanceStatus?
    let error: String?
}

struct BridgeInstanceListMessage: Decodable {
    let type: String
    let instances: [SessionInstanceInfo]
}

struct BridgeErrorMessage: Decodable {
    let type: String
    let instanceId: String?
    let error: String
}

enum Message: Decodable {
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
}

enum IncomingMessage: Decodable {
    case sessionState(SessionStateMessage)
    case bridgeUpdate(BridgeUpdateMessage)
    case cliStatus(BridgeCliStatusMessage)
    case instanceList(BridgeInstanceListMessage)
    case bridgeError(BridgeErrorMessage)
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
        case "bridge:update":
            self = .bridgeUpdate(try BridgeUpdateMessage(from: decoder))
        case "bridge:cli-status":
            self = .cliStatus(try BridgeCliStatusMessage(from: decoder))
        case "bridge:instance-list":
            self = .instanceList(try BridgeInstanceListMessage(from: decoder))
        case "bridge:error":
            self = .bridgeError(try BridgeErrorMessage(from: decoder))
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
    case spawnInstance(projectPath: String)
    case terminateInstance(instanceId: String)
    case setActiveInstance(instanceId: String)

    private enum CodingKeys: String, CodingKey {
        case type
        case instanceId
        case text
        case callId
        case outcome
        case correlationId
        case model
        case projectPath
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
        case .spawnInstance(let projectPath):
            try container.encode("spawnInstance", forKey: .type)
            try container.encode(projectPath, forKey: .projectPath)
        case .terminateInstance(let instanceId):
            try container.encode("terminateInstance", forKey: .type)
            try container.encode(instanceId, forKey: .instanceId)
        case .setActiveInstance(let instanceId):
            try container.encode("setActiveInstance", forKey: .type)
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
}
