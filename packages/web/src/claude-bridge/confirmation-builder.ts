/**
 * Build confirmation details for tool execution
 */

import type { ConfirmationDetails, ToolInput } from './types.js';

export class ConfirmationBuilder {
  build(
    toolName: string,
    input: ToolInput,
    options: { decisionReason?: string }
  ): ConfirmationDetails {
    const params = input as Record<string, unknown>;

    const details: ConfirmationDetails = {
      type: toolName.includes('Bash') ? 'exec' : 'edit',
      title: options.decisionReason ?? `Use ${toolName}`,
      toolDisplayName: toolName,
      toolName: toolName.toLowerCase(),
    };

    // Add tool-specific fields
    if (input.tool === 'Bash') {
      details.command = String(params['command'] ?? '');
    }

    if (params['file_path']) {
      const filePath = String(params['file_path']);
      details.filePath = filePath;
      details.fileName = filePath.split('/').pop();
    }

    if (params['old_string'] != null && params['new_string'] != null) {
      details.fileDiff = `-${String(params['old_string'])}\n+${String(params['new_string'])}`;
    }

    return details;
  }
}
