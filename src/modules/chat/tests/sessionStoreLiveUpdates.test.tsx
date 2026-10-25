import assert from 'node:assert/strict';
import { act, renderHook } from '@testing-library/react';
import { describe, it, vi } from 'vitest';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { NormalizedMessage } from '@/shared/types';

vi.mock('@/shared/api', () => ({ api: { providers: { sessionMessages: vi.fn() } } }));

const row = (id: string, content: string, timestamp = '2026-10-25T08:00:00Z'): NormalizedMessage => ({
  id, sessionId: 'chat', provider: 'codex', kind: 'text', role: 'assistant', content, timestamp,
});

describe('realtime item updates', () => {
  it('keeps one row through incremental Chinese text and completion', () => {
    const { result } = renderHook(() => useSessionStore());
    for (const content of ['', '收到', '收到，', '收到，测试', '收到，测试消息已成功发送。']) {
      act(() => result.current.appendRealtime('chat', row('answer', content)));
      const messages = result.current.getMessages('chat');
      assert.equal(messages.length, 1);
      assert.equal(messages[0].content, content);
    }
    assert.equal(result.current.getSessionSlot('chat')?.realtimeMessages.length, 1);
  });

  it('preserves item ordering across interleaved tool updates and event replay', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      result.current.appendRealtime('chat', row('commentary', 'Checking.'));
      result.current.appendRealtime('chat', { ...row('command', ''), kind: 'tool_use', toolId: 'command', toolName: 'Bash', status: 'in_progress' });
      result.current.appendRealtime('chat', row('answer', 'Done.'));
      result.current.appendRealtime('chat', { ...row('command', '', '2026-10-25T08:00:05Z'), kind: 'tool_use', toolId: 'command', toolName: 'Bash', status: 'completed' });
      result.current.appendRealtime('chat', row('answer', 'Done.'));
    });
    const messages = result.current.getMessages('chat');
    assert.deepEqual(messages.map(message => message.id), ['commentary', 'command', 'answer']);
    assert.equal(messages[1].status, 'completed');
    assert.equal(messages[1].timestamp, '2026-10-25T08:00:00Z');
  });

  it('keeps updates isolated to their session', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      result.current.appendRealtime('chat', row('answer', 'First session.'));
      result.current.appendRealtime('other', row('answer', 'Other session.'));
      result.current.appendRealtime('chat', row('answer', 'Updated first session.'));
    });
    assert.equal(result.current.getMessages('chat')[0].content, 'Updated first session.');
    assert.equal(result.current.getMessages('other')[0].content, 'Other session.');
  });
});
