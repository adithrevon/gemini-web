// Types for the WebSocket bridge protocol between web UI and CLI

export interface AnsiToken {
  text?: string;
}

export type AnsiLine = AnsiToken[];

export interface TodoItem {
  status?: string;
  description?: string;
}

export interface ToolResultDisplay {
  fileDiff?: string;
  todos?: TodoItem[];
}

export interface ConfirmationDetails {
  type: 'exec' | 'info' | 'mcp' | 'edit' | 'ask_user' | 'exit_plan_mode';
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

export interface ToolCall {
  callId: string;
  name: string;
  description?: string;
  status?: 'pending' | 'executing' | 'success' | 'error' | 'confirming';
  resultDisplay?: string | AnsiLine[] | ToolResultDisplay;
  confirmationDetails?: ConfirmationDetails;
  correlationId?: string;
}

export interface ToolGroupMessage {
  type: 'tool_group';
  tools: ToolCall[];
}

export interface UserMessage {
  type: 'user';
  text: string;
}

// CLI sends 'gemini' or 'gemini_content' types, not 'assistant'
export interface GeminiMessage {
  type: 'gemini' | 'gemini_content';
  text: string;
}

export type Message = UserMessage | GeminiMessage | ToolGroupMessage;

export type StreamingState = 'idle' | 'responding' | 'tool';

export type InstanceStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

export interface ModelOption {
  value: string;
  label: string;
  description?: string;
  isAuto: boolean;
}

export interface BridgeUpdatePayload {
  instanceId: string;
  projectPath: string;
  history: Message[];
  pending: Message[];
  streamingState: StreamingState;
  isTrustedFolder: boolean;
  currentModel: string;
  availableModels: ModelOption[];
  hasPreviewAccess: boolean;
}

// WebSocket message types
export interface BridgeHelloMessage {
  type: 'bridge:hello';
  role: 'web' | 'cli';
}

export interface BridgeUpdateMessage {
  type: 'bridge:update';
  payload: BridgeUpdatePayload;
}

export interface BridgeCliStatusMessage {
  type: 'bridge:cli-status';
  connected: boolean;
  instanceId?: string;
  status?: InstanceStatus;
  error?: string;
}

export interface BridgeInstanceListMessage {
  type: 'bridge:instance-list';
  instances: Array<{
    id: string;
    projectPath: string;
    connected: boolean;
    status?: InstanceStatus;
    error?: string;
  }>;
}

export interface BridgeErrorMessage {
  type: 'bridge:error';
  instanceId?: string;
  error: string;
}

export interface SessionStateMessage {
  type: 'session_state';
  sessionId: string;
  activeInstanceId: string | null;
  instances: Array<{
    id: string;
    projectPath: string;
    connected: boolean;
    status?: InstanceStatus;
    error?: string;
  }>;
  snapshots: BridgeUpdatePayload[];
}

export interface SubmitMessage {
  type: 'submit';
  text: string;
  instanceId: string;
}

export interface ConfirmMessage {
  type: 'confirm';
  callId: string;
  outcome: 'proceed_once' | 'proceed_always' | 'cancel';
  payload?: unknown;
  correlationId?: string;
  instanceId: string;
}

export interface SetModelMessage {
  type: 'setModel';
  model: string;
  instanceId: string;
}

export interface SpawnInstanceMessage {
  type: 'spawnInstance';
  projectPath: string;
}

export interface TerminateInstanceMessage {
  type: 'terminateInstance';
  instanceId: string;
}

export interface SetActiveInstanceMessage {
  type: 'setActiveInstance';
  instanceId: string;
}

export type IncomingMessage =
  | BridgeUpdateMessage
  | BridgeCliStatusMessage
  | BridgeInstanceListMessage
  | BridgeErrorMessage
  | SessionStateMessage;
export type OutgoingMessage =
  | BridgeHelloMessage
  | SubmitMessage
  | ConfirmMessage
  | SetModelMessage
  | SpawnInstanceMessage
  | TerminateInstanceMessage
  | SetActiveInstanceMessage;
