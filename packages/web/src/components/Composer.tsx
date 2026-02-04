import { useRef, useEffect, KeyboardEvent, ChangeEvent, useState } from 'react';
import type { ModelOption } from '../types';
import { ModelSelector } from './ModelSelector';

interface ComposerProps {
  onSubmit: (text: string) => void;
  disabled?: boolean;
  currentModel: string;
  availableModels: ModelOption[];
  onModelChange: (model: string) => void;
}

export function Composer({
  onSubmit,
  disabled = false,
  currentModel,
  availableModels,
  onModelChange,
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
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="19" x2="12" y2="5" />
            <polyline points="5 12 12 5 19 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
