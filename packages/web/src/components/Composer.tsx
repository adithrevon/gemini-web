import { useRef, useEffect, KeyboardEvent, ChangeEvent, useState } from 'react';
import type { ModelOption, InstanceStatus } from '../types';
import { ModelSelector } from './ModelSelector';

interface ComposerProps {
  onSubmit: (text: string) => void;
  disabled?: boolean;
  currentModel: string;
  availableModels: ModelOption[];
  onModelChange: (model: string) => void;
  status?: InstanceStatus;
  projectPath?: string;
  onRetry?: () => void;
}

export function Composer({
  onSubmit,
  disabled = false,
  currentModel,
  availableModels,
  onModelChange,
  status,
  projectPath,
  onRetry,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState('');

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    // Auto-resize textarea
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
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSubmit(trimmed);
    setValue('');
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  // Focus on mount when not disabled
  useEffect(() => {
    if (!disabled && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [disabled]);

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
    <div className={`composer ${disabled ? 'composer--disabled' : ''}`}>
      <textarea
        ref={textareaRef}
        className="composer__textarea"
        placeholder="Type message here"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        disabled={disabled}
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
            disabled={disabled}
          />
          <button
            className="composer__send"
            onClick={handleSubmit}
            disabled={disabled || !value.trim()}
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
