import { useState } from 'react';
import type { ToolCall as ToolCallType, AnsiLine, ToolResultDisplay } from '../types';

interface ToolCallProps {
  tool: ToolCallType;
}

function renderAnsiOutput(output: AnsiLine[]): string {
  return output
    .map((line) =>
      line.map((token) => token.text ?? '').join('')
    )
    .join('\n');
}

function renderResultDisplay(result: ToolCallType['resultDisplay']): string {
  if (!result) return '';
  if (typeof result === 'string') {
    return result;
  }
  if (Array.isArray(result)) {
    return renderAnsiOutput(result);
  }
  const rd = result as ToolResultDisplay;
  if (rd.fileDiff) {
    return rd.fileDiff;
  }
  if (rd.todos) {
    return rd.todos
      .map((todo) => `[${todo.status ?? 'pending'}] ${todo.description ?? ''}`)
      .join('\n');
  }
  return JSON.stringify(result, null, 2);
}

export function ToolCall({ tool }: ToolCallProps) {
  const [expanded, setExpanded] = useState(false);

  const status = (tool.status ?? 'pending').toLowerCase();
  const statusClass = `tool-call--${status}`;
  const expandedClass = expanded ? 'tool-call--expanded' : '';
  const resultText = renderResultDisplay(tool.resultDisplay);
  const hasContent = Boolean(tool.description || resultText);

  return (
    <div className={`tool-call ${statusClass} ${expandedClass}`}>
      <div className="tool-call__header">
        {hasContent && (
          <button
            className="tool-call__expand-btn"
            onClick={() => setExpanded(!expanded)}
            aria-label={expanded ? 'Collapse' : 'Expand'}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        )}
        {!hasContent && <div style={{ width: 20 }} />}
        <span className="tool-call__name">{tool.name}</span>
        <span className={`tool-call__status tool-call__status--${status}`}>
          {tool.status ?? 'pending'}
        </span>
      </div>
      {hasContent && (
        <div className="tool-call__content">
          {tool.description && (
            <div className="tool-call__desc">{tool.description}</div>
          )}
          {resultText && (
            <pre className="tool-call__output">{resultText}</pre>
          )}
        </div>
      )}
    </div>
  );
}
