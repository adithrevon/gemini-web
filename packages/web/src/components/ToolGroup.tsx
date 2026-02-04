import type { ToolCall as ToolCallType } from '../types';
import { ToolCall } from './ToolCall';
import { ConfirmationBox } from './ConfirmationBox';

interface ToolGroupProps {
  tools: ToolCallType[];
  isTrustedFolder: boolean;
  onConfirm: (
    callId: string,
    outcome: 'proceed_once' | 'proceed_always' | 'cancel',
    correlationId?: string
  ) => void;
}

export function ToolGroup({ tools, isTrustedFolder, onConfirm }: ToolGroupProps) {
  // Separate confirming tools for rendering confirmation boxes AFTER tool cards
  const confirmingTools = tools.filter(
    (tool) => String(tool.status).toLowerCase() === 'confirming'
  );

  return (
    <div className="tool-group">
      {/* Render all tool cards first */}
      {tools.map((tool) => (
        <ToolCall key={tool.callId} tool={tool} />
      ))}
      {/* Render confirmation boxes AFTER tool cards (fixed ordering) */}
      {confirmingTools.map((tool) => (
        <ConfirmationBox
          key={`confirm-${tool.callId}`}
          callId={tool.callId}
          details={tool.confirmationDetails}
          correlationId={tool.correlationId}
          isTrustedFolder={isTrustedFolder}
          onConfirm={onConfirm}
        />
      ))}
    </div>
  );
}
