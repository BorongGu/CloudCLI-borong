import { useMemo, useState } from 'react';

import { MarkdownBody } from '@/modules/chat/transcript/Markdown';
import { splitStreamingMarkdown } from '@/modules/chat/utils/streamingMarkdown';
import { useProgressiveText } from '@/modules/chat/hooks/useProgressiveText';

type StreamingMarkdownProps = {
  content: string;
  /** Provider delta streams can request block splitting from their first snapshot. */
  isStreaming: boolean;
  className?: string;
};

/**
 * Chat renders both saved replies and growing Codex/OpenCode snapshots here.
 * Saved content appears immediately. Appended text is paced over short frames,
 * with a brief ink fade on new inline groups. Safe block splitting memoizes the
 * settled prefix while Markdown parses the growing tail. Keeping this component
 * and its split through completion preserves the reply's existing DOM.
 */
export default function StreamingMarkdown({
  content,
  isStreaming,
  className,
}: StreamingMarkdownProps) {
  const displayed = useProgressiveText(content);
  // Retain the last append boundary so unrelated renders keep Markdown's memo stable.
  const [ink, setInk] = useState({ content: displayed, from: displayed.length, growing: false });
  let currentInk = ink;
  if (displayed !== ink.content) {
    const appended = displayed.startsWith(ink.content);
    currentInk = { content: displayed, from: appended ? ink.content.length : displayed.length, growing: appended };
    setInk(currentInk);
  }
  const split = isStreaming || currentInk.growing;
  const { settled, pending } = useMemo(
    () => (split ? splitStreamingMarkdown(displayed) : { settled: displayed, pending: '' }),
    [displayed, split],
  );
  const inkFrom = currentInk.growing ? Math.max(0, currentInk.from - settled.length) : undefined;

  return (
    <div className={className}>
      {settled && <MarkdownBody>{settled}</MarkdownBody>}
      {pending && <MarkdownBody inkFrom={inkFrom}>{pending}</MarkdownBody>}
    </div>
  );
}
