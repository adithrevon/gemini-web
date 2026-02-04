interface UserMessageProps {
  text: string;
}

export function UserMessage({ text }: UserMessageProps) {
  return (
    <div className="message-user">
      <div className="message-user__bubble">{text}</div>
    </div>
  );
}
