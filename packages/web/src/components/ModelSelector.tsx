import { useState, useRef, useEffect } from 'react';
import type { ModelOption } from '../types';

interface ModelSelectorProps {
  currentModel: string;
  availableModels: ModelOption[];
  onSelect: (model: string) => void;
  disabled?: boolean;
}

export function ModelSelector({
  currentModel,
  availableModels,
  onSelect,
  disabled = false,
}: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Find the label for the current model
  const currentOption = availableModels.find((m) => m.value === currentModel);
  const displayLabel = currentOption?.label ?? currentModel;

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  // Close dropdown on Escape key
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isOpen) {
        setIsOpen(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  const handleToggle = () => {
    if (!disabled) {
      setIsOpen(!isOpen);
    }
  };

  const handleSelect = (model: string) => {
    onSelect(model);
    setIsOpen(false);
  };

  return (
    <div
      className={`model-selector ${disabled ? 'model-selector--disabled' : ''}`}
      ref={containerRef}
    >
      <button
        className="model-selector__trigger"
        onClick={handleToggle}
        disabled={disabled}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className="model-selector__label">{displayLabel}</span>
        <svg
          className={`model-selector__chevron ${isOpen ? 'model-selector__chevron--open' : ''}`}
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M3 4.5L6 7.5L9 4.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {isOpen && (
        <ul className="model-selector__dropdown" role="listbox">
          {availableModels.map((option) => (
            <li key={option.value}>
              <button
                className={`model-selector__option ${option.value === currentModel
                    ? 'model-selector__option--selected'
                    : ''
                  }`}
                onClick={() => handleSelect(option.value)}
                role="option"
                aria-selected={option.value === currentModel}
              >
                <span className="model-selector__option-label">
                  {option.label}
                </span>
                {option.description && (
                  <span className="model-selector__option-desc">
                    {option.description}
                  </span>
                )}
                {option.value === currentModel && (
                  <svg
                    className="model-selector__check"
                    width="14"
                    height="14"
                    viewBox="0 0 14 14"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path
                      d="M3 7L6 10L11 4"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
