/**
 * Type definitions for Claude bridge
 */

// Strong types instead of strings
export type ToolStatus = 'running' | 'success' | 'error' | 'confirming' | 'cancelled';
export type StreamingState = 'idle' | 'responding' | 'tool' | 'waiting_for_confirmation';

// Known tool input types (discriminated union)
export type KnownToolInput =
  | { tool: 'Bash'; command: string; description?: string; timeout?: number }
  | { tool: 'Read'; file_path: string; offset?: number; limit?: number }
  | { tool: 'Write'; file_path: string; content: string }
  | { tool: 'Edit'; file_path: string; old_string: string; new_string: string; replace_all?: boolean }
  | { tool: 'Glob'; pattern: string; path?: string }
  | { tool: 'Grep'; pattern: string; path?: string; output_mode?: string; '-i'?: boolean }
  | { tool: 'WebSearch'; query: string; allowed_domains?: string[]; blocked_domains?: string[] }
  | { tool: 'WebFetch'; url: string; prompt: string }
  | { tool: 'Task'; prompt: string; subagent_type: string; description: string; model?: string }
  | { tool: 'TodoWrite'; tasks: Array<{ status: string; description: string }> };

// Tool input with fallback for unknown tools
export type ToolInput = KnownToolInput | { tool: string; [key: string]: unknown };

export interface PendingToolUse {
  callId: string;
  name: string;
  description: string;
  status: ToolStatus;
  input: ToolInput;
  resultDisplay: string | null;
  confirmationDetails: ConfirmationDetails | null;
}

export interface ParsedStreamEvent {
  type: 'text_start' | 'text_delta' | 'tool_start' | 'block_stop';
  text?: string;
  toolInfo?: { name: string; id: string };
}

export interface ParsedMessage {
  textParts: string[];
  toolUses: Array<{ id: string; name: string; input: ToolInput }>;
}

export interface ToolResult {
  toolId: string;
  isError: boolean;
  content: string | Array<{ type: string; text?: string }>;
}

export interface ModelOption {
  value: string;
  label: string;
  description: string | null;
  isAuto: boolean;
}

export interface ConfirmationDetails {
  type: 'exec' | 'edit';
  title: string;
  command?: string;
  toolDisplayName: string;
  toolName: string;
  fileName?: string;
  filePath?: string;
  fileDiff?: string;
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

// SDK-related types
export interface SDKModel {
  value: string;
  displayName: string;
  description?: string;
}
