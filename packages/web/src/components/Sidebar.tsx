import type { ReactNode } from 'react';

interface SidebarProps {
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}

export function Sidebar({ expanded, onToggle, children }: SidebarProps) {
  return (
    <>
      <button
        className="sidebar__toggle"
        onClick={onToggle}
        aria-label={expanded ? 'Close sidebar' : 'Open sidebar'}
        aria-expanded={expanded}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          {expanded ? (
            // X icon when expanded
            <>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </>
          ) : (
            // Hamburger icon when collapsed
            <>
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </>
          )}
        </svg>
      </button>
      <aside className={`sidebar ${expanded ? 'sidebar--expanded' : ''}`}>
        <div className="sidebar__content">{children}</div>
      </aside>
      {expanded && <div className="sidebar__overlay" onClick={onToggle} />}
    </>
  );
}
