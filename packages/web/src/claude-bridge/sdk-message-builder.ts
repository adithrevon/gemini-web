/**
 * Build SDK messages
 */

import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export class SDKMessageBuilder {
  static userMessage(text: string, sessionId: string): SDKUserMessage {
    return {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
      },
      parent_tool_use_id: null,
      session_id: sessionId,
    };
  }
}
