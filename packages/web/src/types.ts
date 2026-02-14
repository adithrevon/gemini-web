// ---------------------------------------------------------------------------
// Shared types for claude-web server
// All SSE event shapes and command payloads must match the iOS app contract.
// ---------------------------------------------------------------------------

// --- Provider ---
// Claude-only now (Gemini removed)

// --- Streaming state ---

export type StreamingState =
  | 'idle'
  | 'responding'
  | 'tool'
  | 'waiting_for_confirmation';

// --- Model ---

export interface ModelOption {
  value: string;
  label: string;
  description: string | null;
  isAuto: boolean;
}

// --- Message history items ---

export interface UserMessage {
  type: 'user';
  text: string;
}

export interface GeminiMessage {
  type: 'gemini';
  text: string;
}

export interface ToolCallInfo {
  callId: string;
  name: string;
  description: string;
  status: string;
  resultDisplay: string | null;
  confirmationDetails: ConfirmationDetails | null;
  correlationId: string | null;
}

export interface ToolGroupMessage {
  type: 'tool_group';
  tools: ToolCallInfo[];
}

export type HistoryMessage = UserMessage | GeminiMessage | ToolGroupMessage;

export interface ConfirmationDetails {
  type: string;
  title?: string;
  command?: string;
  rootCommand?: string;
  prompt?: string;
  toolDisplayName?: string;
  toolName?: string;
  fileName?: string;
  filePath?: string;
  fileDiff?: string;
}

// --- Usage Metrics & TODOs ---

export interface UsageMetrics {
  // Tokens
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalTokens: number;

  // Cost (Claude only)
  totalCostUsd?: number;

  // API performance
  totalApiCalls: number;
  totalApiErrors: number;
  totalApiLatencyMs: number;

  // Tool usage
  totalToolCalls: number;
  totalToolSuccess: number;
  totalToolFail: number;

  // Session info (Claude-specific)
  numTurns?: number;
  durationMs?: number;

  // Per-model stats (Gemini-specific)
  modelBreakdown?: Record<
    string,
    {
      requests: number;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
    }
  >;
}

export interface TodoItem {
  id: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  description: string;
  createdAt: string;
  completedAt?: string;
}

export interface TodoList {
  items: TodoItem[];
  lastUpdated: string;
}

// --- Bridge update payload (sent via SSE) ---
// DEPRECATED: Will be removed in favor of event-based architecture
// Kept temporarily for backward compatibility during migration
export interface BridgeUpdatePayload {
  instanceId: string;
  sessionId?: string; // Gemini session ID from CLI (for resume)
  projectPath: string;
  history: HistoryMessage[];
  pending: HistoryMessage[];
  streamingState: StreamingState;
  isTrustedFolder: boolean;
  currentModel: string;
  availableModels: ModelOption[];
  hasPreviewAccess: boolean;
  usageMetrics?: UsageMetrics;
  todos?: TodoList;
  planModeActive?: boolean; // Claude-specific
}

// --- Claude Event Types (Event-Based Architecture) ---

export interface ToolInfo {
  callId: string;
  name: string;
  input: Record<string, unknown>;
  description: string;
}

export type ClaudeEvent =
  | { type: 'claude:text_delta'; instanceId: string; text: string; seq: number }
  | { type: 'claude:text_complete'; instanceId: string; text: string; seq: number }
  | {
      type: 'claude:tool_added';
      instanceId: string;
      tool: ToolInfo;
      confirmationDetails?: ConfirmationDetails;
      seq: number;
    }
  | {
      type: 'claude:tool_status';
      instanceId: string;
      toolId: string;
      status: string;
      seq: number;
    }
  | {
      type: 'claude:tool_result';
      instanceId: string;
      toolId: string;
      result: any;
      seq: number;
    }
  | {
      type: 'claude:streaming_state';
      instanceId: string;
      state: StreamingState;
      seq: number;
    }
  | {
      type: 'claude:models_available';
      instanceId: string;
      models: ModelOption[];
      seq: number;
    }
  | {
      type: 'claude:session_complete';
      instanceId: string;
      sessionId: string;
      seq: number;
    };

// Special server events
export interface ServerRestartedEvent {
  type: 'server:restarted';
  message: string;
  seq: number;
}

// --- SSE event types ---

export interface SessionStateEvent {
  type: 'session_state';
  sessionId: string;
  instances: string[]; // Just instance IDs
}

export interface BridgeUpdateEvent {
  type: 'bridge:update';
  payload: BridgeUpdatePayload;
}

export interface BridgeErrorEvent {
  type: 'bridge:error';
  instanceId: string;
  error: string;
}

export type SseEvent =
  | SessionStateEvent
  | BridgeUpdateEvent
  | BridgeErrorEvent
  | ClaudeEvent
  | ServerRestartedEvent;

// --- Session & instance info ---
// Simplified: iOS maintains detailed state, server just tracks IDs

// --- Command payloads (from iOS app) ---

export interface SpawnInstanceCommand {
  type: 'spawnInstance';
  projectPath: string;
}

export interface TerminateInstanceCommand {
  type: 'terminateInstance';
  instanceId: string;
}

export interface InterruptCommand {
  type: 'interrupt';
  instanceId: string;
}

export interface SubmitCommand {
  type: 'submit';
  instanceId: string;
  text: string;
}

export interface ConfirmCommand {
  type: 'confirm';
  instanceId: string;
  callId: string;
  outcome: string;
  correlationId?: string;
}

export interface SetModelCommand {
  type: 'setModel';
  instanceId: string;
  model: string;
}

export type Command =
  | SpawnInstanceCommand
  | TerminateInstanceCommand
  | InterruptCommand
  | SubmitCommand
  | ConfirmCommand
  | SetModelCommand;

// --- Command response payloads ---

export interface SpawnInstanceResponse {
  instanceId: string;
  resolvedPath: string;
}

export interface OkResponse {
  ok: true;
}

export interface ErrorResponse {
  error: string;
}

// --- Server config ---

export interface ServerConfig {
  port: number;
  wsPath: string;
  spawnTimeoutMs: number;
  debug: boolean;
  cliLog: boolean;
  rootDir: string;
}

// --- Directory browsing ---

export interface DirectoryEntry {
  name: string;
  path: string;
}

export interface DirectoryListing {
  path: string;
  parent: string;
  directories: DirectoryEntry[];
  isProject: boolean;
  name: string;
}

export interface PathValidation {
  valid: boolean;
  path: string;
  name: string;
  isProject: boolean;
  error?: string;
}

// --- Session Persistence ---

export interface PersistedInstance {
  id: string;
  sessionId: string; // Which client owns this instance
  projectPath: string;
  yolo: boolean; // Sudo/bypass permissions mode
  claudeSessionId?: string; // For Claude SDK resume
}

export interface PersistedSession {
  id: string;
  instances: PersistedInstance[];
}

export interface PersistedData {
  version: 1;
  lastUpdated: string;
  sessions: PersistedSession[];
}
