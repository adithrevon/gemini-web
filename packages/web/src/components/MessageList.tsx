import { useRef, useEffect } from 'react';
import type { Message, StreamingState } from '../types';
import { UserMessage } from './UserMessage';
import { AgentMessage } from './AgentMessage';
import { ToolGroup } from './ToolGroup';
import { TypingIndicator } from './TypingIndicator';

interface MessageListProps {
  history: Message[];
  pending: Message[];
  streamingState: StreamingState;
  isTrustedFolder: boolean;
  onConfirm: (
    callId: string,
    outcome: 'proceed_once' | 'proceed_always' | 'cancel',
    correlationId?: string
  ) => void;
}

export function MessageList({
  history,
  pending,
  streamingState,
  isTrustedFolder,
  onConfirm,
}: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);

  // Track scroll position to determine auto-scroll behavior
  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const isNearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 48;
    shouldAutoScroll.current = isNearBottom;
  };

  // Auto-scroll when new messages arrive (if user was near bottom)
  useEffect(() => {
    const el = containerRef.current;
    if (el && shouldAutoScroll.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [history, pending, streamingState]);

  const allMessages = [...history, ...pending];

  return (
    <div className="messages" ref={containerRef} onScroll={handleScroll}>
      {allMessages.map((item, index) => {
        if (item.type === 'user') {
          return <UserMessage key={`user-${index}`} text={item.text} />;
        }
        // CLI sends 'gemini' or 'gemini_content' for agent messages
        if (item.type === 'gemini' || item.type === 'gemini_content') {
          return <AgentMessage key={`agent-${index}`} text={item.text} />;
        }
        if (item.type === 'tool_group') {
          return (
            <ToolGroup
              key={`tools-${index}`}
              tools={item.tools}
              isTrustedFolder={isTrustedFolder}
              onConfirm={onConfirm}
            />
          );
        }
        return null;
      })}
      {streamingState === 'responding' && <TypingIndicator />}
    </div>
  );
}
