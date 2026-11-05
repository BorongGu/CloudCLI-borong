import { Reasoning, ReasoningContent, ReasoningTrigger, StreamingMarkdown } from '@/modules/chat';
import type { GuestChatMessage } from '@/shared/types';

/** GuestChat loads CloudCLI's answer renderer after login so its initial screen stays small. */
export default function GuestAnswer({ message, busy }: { message: GuestChatMessage; busy: boolean }) {
  return <>
    {message.reasoning && <Reasoning isStreaming={busy && !message.text} className="guest-reasoning">
      <ReasoningTrigger getThinkingMessage={streaming => streaming ? '思考中…' : '思考摘要'} />
      <ReasoningContent><StreamingMarkdown content={message.reasoning} isStreaming={busy && !message.text} restricted className="guest-prose" /></ReasoningContent>
    </Reasoning>}
    {message.text && <StreamingMarkdown content={message.text} isStreaming={busy} restricted className="guest-prose" />}
  </>;
}
