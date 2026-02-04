import { useState, useRef, useEffect } from 'react';

interface ProjectSelectorProps {
  selectedProject: string;
  recentProjects: string[];
  onSelect: (path: string) => void;
  disabled?: boolean;
}

export function ProjectSelector({
  selectedProject,
  recentProjects,
  onSelect,
  disabled = false,
}: ProjectSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [customPath, setCustomPath] = useState('');
  const [showCustomInput, setShowCustomInput] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
        setShowCustomInput(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Focus input when showing custom input
  useEffect(() => {
    if (showCustomInput && inputRef.current) {
      inputRef.current.focus();
    }
  }, [showCustomInput]);

  const displayName = selectedProject
    ? selectedProject.split('/').pop() || selectedProject
    : 'Select project...';

  const handleSelectProject = (path: string) => {
    onSelect(path);
    setIsOpen(false);
    setShowCustomInput(false);
  };

  const handleAddCustom = () => {
    if (customPath.trim()) {
      onSelect(customPath.trim());
      setCustomPath('');
      setIsOpen(false);
      setShowCustomInput(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleAddCustom();
    } else if (e.key === 'Escape') {
      setShowCustomInput(false);
      setIsOpen(false);
    }
  };

  return (
    <div
      className={`project-selector ${disabled ? 'project-selector--disabled' : ''}`}
      ref={containerRef}
    >
      <button
        className="project-selector__trigger"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        title={selectedProject}
      >
        <span className="project-selector__label">{displayName}</span>
        <svg
          className={`project-selector__chevron ${isOpen ? 'project-selector__chevron--open' : ''}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          width="14"
          height="14"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {isOpen && (
        <ul className="project-selector__dropdown">
          {recentProjects.map((path) => (
            <li key={path}>
              <button
                className={`project-selector__option ${
                  path === selectedProject
                    ? 'project-selector__option--selected'
                    : ''
                }`}
                onClick={() => handleSelectProject(path)}
              >
                <span className="project-selector__option-label">
                  {path.split('/').pop() || path}
                </span>
                <span className="project-selector__option-path">{path}</span>
                {path === selectedProject && (
                  <svg
                    className="project-selector__check"
                    viewBox="0 0 24 24"
                    width="16"
                    height="16"
                  >
                    <polyline
                      points="20 6 9 17 4 12"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    />
                  </svg>
                )}
              </button>
            </li>
          ))}

          {recentProjects.length > 0 && (
            <li className="project-selector__divider" />
          )}

          {showCustomInput ? (
            <li className="project-selector__custom-input">
              <input
                ref={inputRef}
                type="text"
                placeholder="/path/to/project"
                value={customPath}
                onChange={(e) => setCustomPath(e.target.value)}
                onKeyDown={handleKeyDown}
              />
              <button
                className="project-selector__custom-add"
                onClick={handleAddCustom}
                disabled={!customPath.trim()}
              >
                Add
              </button>
            </li>
          ) : (
            <li>
              <button
                className="project-selector__add-new"
                onClick={() => setShowCustomInput(true)}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                Add new project...
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
