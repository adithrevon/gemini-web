// ---------------------------------------------------------------------------
// Shared types for gemini-web server
// All SSE event shapes and command payloads must match the iOS app contract.
// ---------------------------------------------------------------------------

// --- Provider ---

export type ProviderName = 'gemini' | 'claude';

// --- Instance & Session status ---

export type InstanceStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export type StreamingState = 'idle' | 'responding' | 'tool' | 'waiting_for_confirmation';

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

// --- Bridge update payload (sent via SSE) ---

export interface BridgeUpdatePayload {
  instanceId: string;
  projectPath: string;
  history: HistoryMessage[];
  pending: HistoryMessage[];
  streamingState: StreamingState;
  isTrustedFolder: boolean;
  currentModel: string;
  availableModels: ModelOption[];
  hasPreviewAccess: boolean;
}

// --- SSE event types ---

export interface SessionStateEvent {
  type: 'session_state';
  sessionId: string;
  activeInstanceId: string | null;
  instances: SessionInstanceInfo[];
  snapshots: BridgeUpdatePayload[];
}

export interface BridgeUpdateEvent {
  type: 'bridge:update';
  payload: BridgeUpdatePayload;
}

export interface BridgeCliStatusEvent {
  type: 'bridge:cli-status';
  connected: boolean;
  instanceId: string;
  status: InstanceStatus;
  error?: string | null;
}

export interface BridgeInstanceListEvent {
  type: 'bridge:instance-list';
  instances: SessionInstanceInfo[];
}

export interface BridgeErrorEvent {
  type: 'bridge:error';
  instanceId: string;
  error: string;
}

export type SseEvent =
  | SessionStateEvent
  | BridgeUpdateEvent
  | BridgeCliStatusEvent
  | BridgeInstanceListEvent
  | BridgeErrorEvent;

// --- Session & instance info ---

export interface SessionInstanceInfo {
  id: string;
  projectPath: string;
  connected: boolean;
  status: InstanceStatus;
  error: string | null;
  provider: ProviderName;
}

// --- Command payloads (from iOS app) ---

export interface SpawnInstanceCommand {
  type: 'spawnInstance';
  projectPath: string;
  provider?: string;
}

export interface TerminateInstanceCommand {
  type: 'terminateInstance';
  instanceId: string;
}

export interface SetActiveInstanceCommand {
  type: 'setActiveInstance';
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
  | SetActiveInstanceCommand
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
