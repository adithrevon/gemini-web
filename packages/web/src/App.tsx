import { useState, useCallback, useRef, useEffect } from 'react';
import { useSession } from './useSession';
import {
  Composer,
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
  } = useSession();

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showNewChat, setShowNewChat] = useState(false);
  const [pendingProjectPath, setPendingProjectPath] = useState<string | null>(
    null,
  );
  const [pendingInstanceId, setPendingInstanceId] = useState<string | null>(
    null,
  );
  const pendingSelectionRef = useRef<string | null>(null);
  const pendingAliasRef = useRef<string | null>(null);

  const handleProjectSelected = useCallback(
    async (projectPath: string) => {
      pendingSelectionRef.current = projectPath;
      pendingAliasRef.current = null;
      setPendingProjectPath(projectPath);
      const instanceId = await spawnInstance(projectPath);
      if (pendingSelectionRef.current === projectPath) {
        setPendingInstanceId(instanceId);
      }
    },
    [spawnInstance],
  );

  // Handle starting a new chat from the NewChatView
  const handleStartChat = useCallback(
    (initialMessage: string) => {
      if (!activeInstance || activeInstance.status !== 'connected') {
        return;
      }
      sendSubmit(initialMessage);
      setShowNewChat(false);
      setSidebarOpen(false);
    },
    [activeInstance, sendSubmit],
  );

  // Handle new chat button from sidebar (under existing project)
  const handleNewChatFromProject = useCallback(
    (projectPath: string) => {
      setPendingInstanceId(null);
      setShowNewChat(true);
      setSidebarOpen(false);
      void handleProjectSelected(projectPath);
    },
    [handleProjectSelected],
  );

  // Handle new project button
  const handleNewProject = useCallback(() => {
    setPendingProjectPath(null);
    setPendingInstanceId(null);
    setShowNewChat(true);
    setSidebarOpen(false);
  }, []);

  // Determine layout state
  const hasActiveChat = activeInstance && !showNewChat;
  const hasMessages =
    activeInstance &&
    (activeInstance.history.length > 0 || activeInstance.pending.length > 0);
  const isDisabled =
    !connected || !activeInstance || activeInstance.status !== 'connected';
  const hasSelectedProject = Boolean(pendingProjectPath);
  const newChatInstanceId = showNewChat ? pendingInstanceId : activeInstanceId;
  const newChatInstance = newChatInstanceId
    ? instances.get(newChatInstanceId)
    : null;
  const newChatReady =
    connected &&
    hasSelectedProject &&
    newChatInstance &&
    newChatInstance.status === 'connected';
  const newChatDisabled = !newChatReady;
  const statusInstance = showNewChat ? newChatInstance : activeInstance;
  const statusProjectPath = showNewChat
    ? (pendingProjectPath ?? statusInstance?.projectPath)
    : statusInstance?.projectPath;
  const displayStatus = showNewChat
    ? hasSelectedProject
      ? (statusInstance?.status ?? 'connecting')
      : undefined
    : statusInstance?.status;
  const aliasToHide = pendingAliasRef.current;
  const filteredRecents = aliasToHide
    ? recentProjects.filter((p) => p !== aliasToHide)
    : recentProjects;

  useEffect(() => {
    if (!showNewChat) return;
    if (!pendingProjectPath || !statusInstance?.projectPath) return;
    if (pendingProjectPath !== statusInstance.projectPath) {
      pendingAliasRef.current = pendingProjectPath;
      setPendingProjectPath(statusInstance.projectPath);
      pendingSelectionRef.current = statusInstance.projectPath;
    }
  }, [pendingProjectPath, showNewChat, statusInstance?.projectPath]);

  const handleRetry = useCallback(() => {
    if (!statusInstance || !statusInstance.projectPath) return;
    if (statusInstance.status !== 'error') return;
    terminateInstance(statusInstance.id);
    void spawnInstance(statusInstance.projectPath);
  }, [statusInstance, spawnInstance, terminateInstance]);

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
                        ...filteredRecents.filter(
                          (p) => p !== pendingProjectPath,
                        ),
                      ]
                    : filteredRecents
                }
                initialProject={pendingProjectPath ?? undefined}
                onProjectSelected={handleProjectSelected}
                onSubmitMessage={handleStartChat}
                projectSelectorDisabled={false}
                composerDisabled={newChatDisabled}
                status={displayStatus}
                projectPath={statusProjectPath}
                onRetry={handleRetry}
                availableModels={defaultModels}
                currentModel="auto-gemini-2.5"
                onModelChange={() => {}} // Model will be set after instance spawns
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
                status={displayStatus}
                projectPath={statusProjectPath}
                onRetry={handleRetry}
              />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
