import { render } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import GuestAnswer from '@/modules/guest-chat/GuestAnswer';
import type { GuestChatMessage } from '@/shared/types';

const renderText = vi.hoisted(() => vi.fn());
vi.mock('@/modules/chat', () => ({
  StreamingMarkdown: ({ content }: { content: string }) => { renderText(content);return <div>{content}</div>; },
  Reasoning: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ReasoningContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ReasoningTrigger: () => <button>摘要</button>,
}));

test('unchanged saved answers skip transcript renders while new output continues streaming', () => {
  const message: GuestChatMessage = { id: 'answer', role: 'assistant', text: '答案', images: [], createdAt: 1 };
  const { rerender } = render(<GuestAnswer message={message} busy={false} />);
  expect(renderText).toHaveBeenCalledTimes(1);
  rerender(<GuestAnswer message={{ ...message }} busy={false} />);
  expect(renderText).toHaveBeenCalledTimes(1);
  rerender(<GuestAnswer message={{ ...message, text: '答案继续' }} busy />);
  expect(renderText).toHaveBeenLastCalledWith('答案继续');expect(renderText).toHaveBeenCalledTimes(2);
});
