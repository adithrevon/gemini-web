interface ConnectionStatusProps {
  connected: boolean;
  cliConnected: boolean;
}

export function ConnectionStatus({ connected, cliConnected }: ConnectionStatusProps) {
  let statusClass = 'connection-status--disconnected';
  let statusText = 'Disconnected';

  if (!connected) {
    statusClass = 'connection-status--connecting';
    statusText = 'Connecting...';
  } else if (cliConnected) {
    statusClass = 'connection-status--connected';
    statusText = 'CLI connected';
  } else {
    statusClass = 'connection-status--connecting';
    statusText = 'Waiting for CLI...';
  }

  return (
    <div className={`connection-status ${statusClass}`}>
      <span className="connection-status__dot" />
      <span>{statusText}</span>
    </div>
  );
}
