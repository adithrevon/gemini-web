import { useState, useRef, useEffect, KeyboardEvent, ChangeEvent } from 'react';
import { ProjectSelector } from './ProjectSelector';
import type { ModelOption } from '../types';
import { ModelSelector } from './ModelSelector';

interface NewChatViewProps {
  recentProjects: string[];
  onStartChat: (projectPath: string, initialMessage: string) => void;
  disabled?: boolean;
  availableModels: ModelOption[];
  currentModel: string;
  onModelChange: (model: string) => void;
}

export function NewChatView({
  recentProjects,
  onStartChat,
  disabled = false,
  availableModels,
  currentModel,
  onModelChange,
}: NewChatViewProps) {
  const [selectedProject, setSelectedProject] = useState(
    recentProjects[0] || '',
  );
  const [message, setMessage] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus textarea on mount
  useEffect(() => {
    if (!disabled && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [disabled]);

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
    if (!trimmedMessage || !selectedProject || disabled) return;
    onStartChat(selectedProject, trimmedMessage);
    setMessage('');
  };

  const canSubmit = message.trim() && selectedProject && !disabled;

  return (
    <div className="new-chat-view">
      <div className="new-chat-view__header">
        <h1 className="new-chat-view__title">Let's build</h1>
        <ProjectSelector
          selectedProject={selectedProject}
          recentProjects={recentProjects}
          onSelect={setSelectedProject}
          disabled={disabled}
        />
      </div>

      <div className={`composer ${disabled ? 'composer--disabled' : ''}`}>
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
          disabled={disabled || !selectedProject}
          rows={1}
        />
        <div className="composer__toolbar">
          <ModelSelector
            currentModel={currentModel}
            availableModels={availableModels}
            onSelect={onModelChange}
            disabled={disabled}
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
  );
}
