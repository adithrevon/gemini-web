import { useState, useCallback } from 'react';
import { useWebSocket } from './useWebSocket';
import {
  Composer,
  ConnectionStatus,
  MessageList,
  Sidebar,
  ProjectList,
  NewChatView,
} from './components';

export default function App() {
  const {
    connected,
    instances,
    activeInstanceId,
    activeInstance,
    recentProjects,
    setActiveInstance,
    sendSubmit,
    sendConfirm,
    sendSetModel,
    spawnInstance,
    terminateInstance,
  } = useWebSocket();

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showNewChat, setShowNewChat] = useState(false);
  const [pendingProjectPath, setPendingProjectPath] = useState<string | null>(
    null,
  );

  // Handle starting a new chat from the NewChatView
  const handleStartChat = useCallback(
    (projectPath: string, initialMessage: string) => {
      // Spawn a new instance and queue the initial message
      setPendingProjectPath(projectPath);
      spawnInstance(projectPath);
      // The initial message will be sent once the instance connects
      // For now, we'll store it and send when we get the first update
      sessionStorage.setItem('pendingMessage', initialMessage);
      setShowNewChat(false);
      setSidebarOpen(false);
    },
    [spawnInstance],
  );

  // Handle new chat button from sidebar (under existing project)
  const handleNewChatFromProject = useCallback((projectPath: string) => {
    setPendingProjectPath(projectPath);
    setShowNewChat(true);
    setSidebarOpen(false);
  }, []);

  // Handle new project button
  const handleNewProject = useCallback(() => {
    setPendingProjectPath(null);
    setShowNewChat(true);
    setSidebarOpen(false);
  }, []);

  // Check if there's a pending message to send
  const pendingMessage = sessionStorage.getItem('pendingMessage');
  if (pendingMessage && activeInstance?.status === 'connected') {
    sessionStorage.removeItem('pendingMessage');
    // Small delay to ensure the instance is ready
    setTimeout(() => sendSubmit(pendingMessage), 100);
  }

  // Determine layout state
  const hasActiveChat = activeInstance && !showNewChat;
  const hasMessages =
    activeInstance &&
    (activeInstance.history.length > 0 || activeInstance.pending.length > 0);
  const isDisabled =
    !connected || !activeInstance || activeInstance.status !== 'connected';

  // Default available models for new chat view
  const defaultModels = [
    {
      value: 'auto-gemini-2.5',
      label: 'Auto (Gemini 2.5)',
      description: 'Let CLI decide',
      isAuto: true,
    },
    { value: 'gemini-2.5-pro', label: 'gemini-2.5-pro', isAuto: false },
    { value: 'gemini-2.5-flash', label: 'gemini-2.5-flash', isAuto: false },
  ];

  return (
    <div className="app-layout">
      <Sidebar
        expanded={sidebarOpen}
        onToggle={() => setSidebarOpen(!sidebarOpen)}
      >
        <ProjectList
          instances={instances}
          activeInstanceId={activeInstanceId}
          onSelectInstance={(id) => {
            setActiveInstance(id);
            setShowNewChat(false);
            setSidebarOpen(false);
          }}
          onNewChat={handleNewChatFromProject}
          onNewProject={handleNewProject}
        />
      </Sidebar>

      <main className="main-content">
        {showNewChat || !hasActiveChat ? (
          // New chat view - centered with project selector
          <div className="app app--centered">
            <div className="composer-wrapper">
              <NewChatView
                recentProjects={
                  pendingProjectPath
                    ? [
                        pendingProjectPath,
                        ...recentProjects.filter(
                          (p) => p !== pendingProjectPath,
                        ),
                      ]
                    : recentProjects
                }
                onStartChat={handleStartChat}
                disabled={false}
                availableModels={defaultModels}
                currentModel="auto-gemini-2.5"
                onModelChange={() => {}} // Model will be set after instance spawns
              />
              <ConnectionStatus
                connected={connected}
                cliConnected={instances.size > 0}
              />
            </div>
          </div>
        ) : (
          // Active chat view
          <div
            className={`app ${hasMessages ? 'app--conversation' : 'app--centered'}`}
          >
            {hasMessages && (
              <MessageList
                history={activeInstance.history}
                pending={activeInstance.pending}
                streamingState={activeInstance.streamingState}
                isTrustedFolder={activeInstance.isTrustedFolder}
                onConfirm={sendConfirm}
              />
            )}
            <div className="composer-wrapper">
              <Composer
                onSubmit={sendSubmit}
                disabled={isDisabled}
                currentModel={activeInstance?.currentModel ?? 'auto-gemini-2.5'}
                availableModels={
                  activeInstance?.availableModels ?? defaultModels
                }
                onModelChange={sendSetModel}
              />
              <ConnectionStatus
                connected={connected}
                cliConnected={activeInstance?.status === 'connected'}
              />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
