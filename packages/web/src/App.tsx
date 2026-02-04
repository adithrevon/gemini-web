import { useWebSocket } from './useWebSocket';
import { Composer, ConnectionStatus, MessageList } from './components';

export default function App() {
  const {
    connected,
    cliConnected,
    history,
    pending,
    streamingState,
    isTrustedFolder,
    currentModel,
    availableModels,
    sendSubmit,
    sendConfirm,
    sendSetModel,
  } = useWebSocket();

  // Determine if we're in the initial centered state (no messages sent yet)
  const hasMessages = history.length > 0 || pending.length > 0;
  const isDisabled = !connected || !cliConnected;
  const layoutClass = hasMessages ? 'app--conversation' : 'app--centered';

  return (
    <div className={`app ${layoutClass}`}>
      {hasMessages && (
        <MessageList
          history={history}
          pending={pending}
          streamingState={streamingState}
          isTrustedFolder={isTrustedFolder}
          onConfirm={sendConfirm}
        />
      )}
      <div className="composer-wrapper">
        <Composer
          onSubmit={sendSubmit}
          disabled={isDisabled}
          currentModel={currentModel}
          availableModels={availableModels}
          onModelChange={sendSetModel}
        />
        <ConnectionStatus connected={connected} cliConnected={cliConnected} />
      </div>
    </div>
  );
}

