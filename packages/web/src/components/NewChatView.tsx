import { useState, useRef, useEffect, KeyboardEvent, ChangeEvent } from 'react';
import { ProjectSelector } from './ProjectSelector';
import type { ModelOption, InstanceStatus } from '../types';
import { ModelSelector } from './ModelSelector';

interface NewChatViewProps {
  recentProjects: string[];
  onProjectSelected: (projectPath: string) => void;
  onSubmitMessage: (initialMessage: string) => void;
  projectSelectorDisabled?: boolean;
  composerDisabled?: boolean;
  status?: InstanceStatus;
  projectPath?: string;
  onRetry?: () => void;
  availableModels: ModelOption[];
  currentModel: string;
  onModelChange: (model: string) => void;
  initialProject?: string;
}

export function NewChatView({
  recentProjects,
  onProjectSelected,
  onSubmitMessage,
  projectSelectorDisabled = false,
  composerDisabled = false,
  status,
  projectPath,
  onRetry,
  availableModels,
  currentModel,
  onModelChange,
  initialProject,
}: NewChatViewProps) {
  const [selectedProject, setSelectedProject] = useState(initialProject || '');
  const [message, setMessage] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastInitialRef = useRef<string | null>(null);

  // Focus textarea on mount
  useEffect(() => {
    if (!composerDisabled && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [composerDisabled]);

  useEffect(() => {
    if (initialProject && initialProject !== lastInitialRef.current) {
      lastInitialRef.current = initialProject;
      setSelectedProject(initialProject);
      onProjectSelected(initialProject);
    }
  }, [initialProject, onProjectSelected]);

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setMessage(e.target.value);
    // Auto-resize
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleSubmit = () => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage || !selectedProject || composerDisabled) return;
    onSubmitMessage(trimmedMessage);
    setMessage('');
  };

  const canSubmit = message.trim() && selectedProject && !composerDisabled;

  const projectName = projectPath
    ? projectPath.split('/').filter(Boolean).pop() || projectPath
    : null;
  const showStatus = Boolean(status || projectName);
  const statusClass =
    status === 'connected'
      ? 'composer__status-dot--connected'
      : status === 'connecting'
        ? 'composer__status-dot--connecting'
        : status === 'error'
          ? 'composer__status-dot--error'
          : status === 'disconnected'
            ? 'composer__status-dot--error'
            : 'composer__status-dot--idle';

  return (
    <div className="new-chat-view">
      <div className="new-chat-view__header">
        <h1 className="new-chat-view__title">Let's build</h1>
        <ProjectSelector
          selectedProject={selectedProject}
          recentProjects={recentProjects}
          onSelect={(path) => {
            lastInitialRef.current = path;
            setSelectedProject(path);
            onProjectSelected(path);
          }}
          disabled={projectSelectorDisabled}
        />
      </div>

      <div
        className={`composer ${composerDisabled ? 'composer--disabled' : ''}`}
      >
        <textarea
          ref={textareaRef}
          className="composer__textarea"
          placeholder={
            selectedProject
              ? 'Type message here...'
              : 'Select a project first...'
          }
          value={message}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          disabled={composerDisabled || !selectedProject}
          rows={1}
        />
        <div className="composer__toolbar">
          {showStatus ? (
            <div className="composer__status" title={projectPath ?? undefined}>
              <span className={`composer__status-dot ${statusClass}`} />
              {projectName ? (
                <span className="composer__status-project">{projectName}</span>
              ) : null}
              {status === 'error' && onRetry ? (
                <button
                  className="composer__status-retry"
                  onClick={onRetry}
                  type="button"
                >
                  Retry
                </button>
              ) : null}
            </div>
          ) : (
            <div />
          )}
          <div className="composer__actions">
            <ModelSelector
              currentModel={currentModel}
              availableModels={availableModels}
              onSelect={onModelChange}
              disabled={composerDisabled}
            />
            <button
              className="composer__send"
              onClick={handleSubmit}
              disabled={!canSubmit}
              aria-label="Send message"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="12" y1="19" x2="12" y2="5" />
                <polyline points="5 12 12 5 19 12" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
