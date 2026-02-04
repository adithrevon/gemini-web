interface AgentMessageProps {
  text: string;
}

export function AgentMessage({ text }: AgentMessageProps) {
  return <div className="message-agent">{text}</div>;
}
