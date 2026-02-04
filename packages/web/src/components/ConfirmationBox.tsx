import type { ConfirmationDetails } from '../types';

interface ConfirmationBoxProps {
  callId: string;
  details?: ConfirmationDetails;
  correlationId?: string;
  isTrustedFolder: boolean;
  onConfirm: (
    callId: string,
    outcome: 'proceed_once' | 'proceed_always' | 'cancel',
    correlationId?: string
  ) => void;
}

function formatDetails(details?: ConfirmationDetails): { title: string; body: string } {
  if (!details) {
    return { title: 'Action Required', body: '' };
  }

  if (details.type === 'exec') {
    return {
      title: details.title ?? 'Action Required',
      body: details.command ?? details.rootCommand ?? '',
    };
  }

  if (details.type === 'info') {
    return {
      title: details.title ?? 'Action Required',
      body: details.prompt ?? '',
    };
  }

  if (details.type === 'mcp') {
    return {
      title: details.title ?? 'Action Required',
      body: `Tool: ${details.toolDisplayName ?? details.toolName ?? ''}`,
    };
  }

  return { title: 'Action Required', body: '' };
}

export function ConfirmationBox({
  callId,
  details,
  correlationId,
  isTrustedFolder,
  onConfirm,
}: ConfirmationBoxProps) {
  const { title, body } = formatDetails(details);

  return (
    <div className="confirmation">
      <div className="confirmation__title">{title}</div>
      {body && <div className="confirmation__body">{body}</div>}
      <div className="confirmation__actions">
        <button
          className="confirmation__btn confirmation__btn--primary"
          onClick={() => onConfirm(callId, 'proceed_once', correlationId)}
        >
          Allow once
        </button>
        {isTrustedFolder && (
          <button
            className="confirmation__btn confirmation__btn--secondary"
            onClick={() => onConfirm(callId, 'proceed_always', correlationId)}
          >
            Allow for this session
          </button>
        )}
        <button
          className="confirmation__btn confirmation__btn--ghost"
          onClick={() => onConfirm(callId, 'cancel', correlationId)}
        >
          No, suggest changes
        </button>
      </div>
    </div>
  );
}
