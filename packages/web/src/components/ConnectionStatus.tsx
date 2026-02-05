import type { InstanceStatus } from '../types';

interface ConnectionStatusProps {
  connected: boolean;
  hasActiveInstance: boolean;
  instanceStatus?: InstanceStatus;
  error?: string;
  waitingForProject?: boolean;
  projectPath?: string;
  onRetry?: () => void;
}

export function ConnectionStatus({
  connected,
  hasActiveInstance,
  instanceStatus,
  error,
  waitingForProject = false,
  projectPath,
  onRetry,
}: ConnectionStatusProps) {
  let statusClass = 'connection-status--disconnected';
  let statusText = 'Disconnected';

  if (!connected) {
    statusClass = 'connection-status--connecting';
    statusText = 'Reconnecting...';
  } else if (waitingForProject && !hasActiveInstance) {
    statusClass = 'connection-status--disconnected';
    statusText = 'Select a project to start';
  } else if (instanceStatus === 'connected') {
    statusClass = 'connection-status--connected';
    statusText = 'CLI connected';
  } else if (instanceStatus === 'connecting') {
    statusClass = 'connection-status--connecting';
    statusText = 'Starting CLI...';
  } else if (instanceStatus === 'error') {
    statusClass = 'connection-status--disconnected';
    statusText = error || 'CLI failed to connect';
  } else if (hasActiveInstance) {
    statusClass = 'connection-status--disconnected';
    statusText = 'CLI disconnected';
  } else {
    statusClass = 'connection-status--disconnected';
    statusText = 'Select a project to start';
  }

  const projectName = projectPath
    ? projectPath.split('/').filter(Boolean).pop() || projectPath
    : null;

  return (
    <div className={`connection-status ${statusClass}`}>
      <div className="connection-status__row">
        <span className="connection-status__dot" />
        <span className="connection-status__text">{statusText}</span>
        {instanceStatus === 'error' && onRetry ? (
          <button
            className="connection-status__retry"
            onClick={onRetry}
            type="button"
          >
            Retry
          </button>
        ) : null}
      </div>
      {projectName ? (
        <div className="connection-status__project" title={projectPath}>
          {projectName}
        </div>
      ) : null}
    </div>
  );
}
