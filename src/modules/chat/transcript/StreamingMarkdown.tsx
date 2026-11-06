import { useMemo, useState } from 'react';

import { MarkdownBody } from '@/modules/chat/transcript/Markdown';
import { splitStreamingMarkdown } from '@/modules/chat/utils/streamingMarkdown';
import { useProgressiveText } from '@/modules/chat/hooks/useProgressiveText';
import { MarkdownWorkspaceContext } from '@/modules/chat/context/MarkdownWorkspaceContext';

type StreamingMarkdownProps = {
  /** Groups supplies its project so artifact links and images resolve in the shared workspace. */
  workspaceProjectId?: string;
  content: string;
  /** Provider delta streams can request block splitting from their first snapshot. */
  isStreaming: boolean;
  className?: string;
  /** Public guest chat uses prose-only navigation and image rendering. */
  restricted?: boolean;
};

/**
 * Chat and guest-chat render saved replies and growing Codex/OpenCode snapshots here.
 * Saved content appears immediately. Appended text is paced over short frames,
 * with a brief ink fade on new inline groups. Safe block splitting memoizes the
 * settled prefix while Markdown parses the growing tail. Keeping this component
 * and its split through completion preserves the reply's existing DOM.
 */
export default function StreamingMarkdown({
  workspaceProjectId,
  content,
  isStreaming,
  className,
  restricted = false,
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

  const rendered = (
    <div className={className}>
      {settled && <MarkdownBody restricted={restricted}>{settled}</MarkdownBody>}
      {pending && <MarkdownBody restricted={restricted} inkFrom={inkFrom}>{pending}</MarkdownBody>}
    </div>
  );
  return workspaceProjectId ? <MarkdownWorkspaceContext.Provider value={{ projectId: workspaceProjectId }}>{rendered}</MarkdownWorkspaceContext.Provider> : rendered;
}
