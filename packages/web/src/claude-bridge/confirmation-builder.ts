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

  /**
   * Build lightweight diff-only details for tool_added events
   * emitted from assistant messages (bypass/yolo mode).
   * Returns null if the tool has no displayable diff/file info.
   */
  buildDiffOnly(
    toolName: string,
    input: ToolInput,
  ): ConfirmationDetails | null {
    const params = input as Record<string, unknown>;
    const hasFilePath = !!params['file_path'];
    const hasDiff = params['old_string'] != null && params['new_string'] != null;
    const hasContent = !!params['content'];
    const hasCommand = !!params['command'];

    if (!hasFilePath && !hasDiff && !hasCommand) return null;

    const details: ConfirmationDetails = {
      type: hasCommand ? 'exec' : 'edit',
      title: `Use ${toolName}`,
      toolDisplayName: toolName,
      toolName: toolName.toLowerCase(),
    };

    if (hasCommand) {
      details.command = String(params['command']);
    }

    if (hasFilePath) {
      const filePath = String(params['file_path']);
      details.filePath = filePath;
      details.fileName = filePath.split('/').pop();
    }

    if (hasDiff) {
      details.fileDiff = `-${String(params['old_string'])}\n+${String(params['new_string'])}`;
    } else if (hasContent && hasFilePath) {
      // Write tool: show a preview of what's being written
      const content = String(params['content']);
      const preview = content.length > 500 ? content.slice(0, 500) + '\n...' : content;
      details.fileDiff = `+${preview.split('\n').join('\n+')}`;
    }

    return details;
  }
}
