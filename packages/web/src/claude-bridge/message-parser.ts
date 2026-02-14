/**
 * Parse SDK messages into internal types
 */

import type {
  SDKPartialAssistantMessage,
  SDKAssistantMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { ParsedStreamEvent, ParsedMessage, ToolResult, ToolInput } from './types.js';

export class MessageParser {
  parseStreamEvent(event: SDKPartialAssistantMessage): ParsedStreamEvent | null {
    const evt = event.event;
    if (!evt) return null;

    switch (evt.type) {
      case 'content_block_start':
        return this._handleContentBlockStart(evt);
      case 'content_block_delta':
        return this._handleContentBlockDelta(evt);
      case 'content_block_stop':
        return { type: 'block_stop' };
      default:
        return null;
    }
  }

  parseAssistantMessage(msg: SDKAssistantMessage): ParsedMessage {
    const content = msg.message?.content ?? [];
    const textParts: string[] = [];
    const toolUses: Array<{ id: string; name: string; input: ToolInput }> = [];

    for (const block of content) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text);
      } else if (block.type === 'tool_use') {
        toolUses.push({
          id: block.id,
          name: block.name,
          input: this._parseToolInput(block.name, block.input),
        });
      }
    }

    return { textParts, toolUses };
  }

  parseToolResults(msg: SDKUserMessage): ToolResult[] {
    const content = msg.message?.content ?? [];
    const results: ToolResult[] = [];

    for (const block of content) {
      if (block.type === 'tool_result') {
        results.push({
          toolId: block.tool_use_id,
          isError: block.is_error,
          content: block.content,
        });
      }
    }

    return results;
  }

  private _handleContentBlockStart(evt: any): ParsedStreamEvent | null {
    if (evt.content_block?.type === 'text') {
      return { type: 'text_start', text: evt.content_block.text || '' };
    }
    if (evt.content_block?.type === 'tool_use') {
      return {
        type: 'tool_start',
        toolInfo: {
          name: evt.content_block.name,
          id: evt.content_block.id,
        },
      };
    }
    return null;
  }

  private _handleContentBlockDelta(evt: any): ParsedStreamEvent | null {
    const delta = evt.delta;
    if (delta?.type === 'text_delta' && delta.text) {
      return { type: 'text_delta', text: delta.text };
    }
    return null;
  }

  private _parseToolInput(toolName: string, input: unknown): ToolInput {
    if (!input || typeof input !== 'object') {
      return { tool: toolName } as ToolInput;
    }

    const params = input as Record<string, unknown>;

    // Return properly typed input based on tool name
    switch (toolName) {
      case 'Bash':
        return {
          tool: 'Bash',
          command: String(params['command'] ?? ''),
          description: params['description'] ? String(params['description']) : undefined,
          timeout: params['timeout'] ? Number(params['timeout']) : undefined,
        };
      case 'Read':
        return {
          tool: 'Read',
          file_path: String(params['file_path'] ?? ''),
          offset: params['offset'] ? Number(params['offset']) : undefined,
          limit: params['limit'] ? Number(params['limit']) : undefined,
        };
      case 'Write':
        return {
          tool: 'Write',
          file_path: String(params['file_path'] ?? ''),
          content: String(params['content'] ?? ''),
        };
      case 'Edit':
        return {
          tool: 'Edit',
          file_path: String(params['file_path'] ?? ''),
          old_string: String(params['old_string'] ?? ''),
          new_string: String(params['new_string'] ?? ''),
          replace_all: params['replace_all'] ? Boolean(params['replace_all']) : undefined,
        };
      case 'Glob':
        return {
          tool: 'Glob',
          pattern: String(params['pattern'] ?? ''),
          path: params['path'] ? String(params['path']) : undefined,
        };
      case 'Grep':
        return {
          tool: 'Grep',
          pattern: String(params['pattern'] ?? ''),
          path: params['path'] ? String(params['path']) : undefined,
          output_mode: params['output_mode'] ? String(params['output_mode']) : undefined,
          '-i': params['-i'] ? Boolean(params['-i']) : undefined,
        };
      case 'WebSearch':
        return {
          tool: 'WebSearch',
          query: String(params['query'] ?? ''),
          allowed_domains: Array.isArray(params['allowed_domains'])
            ? (params['allowed_domains'] as string[])
            : undefined,
          blocked_domains: Array.isArray(params['blocked_domains'])
            ? (params['blocked_domains'] as string[])
            : undefined,
        };
      case 'WebFetch':
        return {
          tool: 'WebFetch',
          url: String(params['url'] ?? ''),
          prompt: String(params['prompt'] ?? ''),
        };
      case 'Task':
        return {
          tool: 'Task',
          prompt: String(params['prompt'] ?? ''),
          subagent_type: String(params['subagent_type'] ?? ''),
          description: String(params['description'] ?? ''),
          model: params['model'] ? String(params['model']) : undefined,
        };
      case 'TodoWrite':
        return {
          tool: 'TodoWrite',
          tasks: Array.isArray(params['tasks']) ? params['tasks'] as Array<{ status: string; description: string }> : [],
        };
      default:
        // Fallback for unknown tools
        return { tool: toolName, ...params } as ToolInput;
    }
  }
}
