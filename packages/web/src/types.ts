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

export interface ModelOption {
  value: string;
  label: string;
  description?: string;
  isAuto: boolean;
}

export interface BridgeUpdatePayload {
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
}

export interface SubmitMessage {
  type: 'submit';
  text: string;
}

export interface ConfirmMessage {
  type: 'confirm';
  callId: string;
  outcome: 'proceed_once' | 'proceed_always' | 'cancel';
  payload?: unknown;
  correlationId?: string;
}

export interface SetModelMessage {
  type: 'setModel';
  model: string;
}

export type IncomingMessage = BridgeUpdateMessage | BridgeCliStatusMessage;
export type OutgoingMessage = BridgeHelloMessage | SubmitMessage | ConfirmMessage | SetModelMessage;
