import assert from 'node:assert/strict';
import { act, renderHook } from '@testing-library/react';
import { describe, it, vi } from 'vitest';

import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import { api } from '@/shared/api';
import type { NormalizedMessage } from '@/shared/types';

vi.mock('@/shared/api', () => ({ api: { providers: { sessionMessages: vi.fn() } } }));

const row = (id: string, content: string, timestamp = '2026-10-25T08:00:00Z'): NormalizedMessage => ({
  id, sessionId: 'chat', provider: 'codex', kind: 'text', role: 'assistant', content, timestamp,
});

describe('realtime item updates', () => {
  it('replaces a partial reply after reconnect with the complete persisted native item', async () => {
    const { result } = renderHook(() => useSessionStore());
    const nativeId = 'msg_native-answer';
    const fullReply = '按这段话的语义，我理解是 trial：某一次完整结构搭建过程。\n\n我们的字段同时保留两层身份：\n\n- task_example_id：任务编号。\n- trial_index：采集次数。\n\n因此可以还原完整搭建。';
    const partial = row(nativeId, fullReply.slice(0, -12));
    const persisted = row(nativeId, fullReply, '2026-10-25T08:00:10Z');
    vi.mocked(api.providers.sessionMessages).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { messages: [persisted], total: 1, hasMore: false } }),
    } as Response);

    act(() => result.current.appendRealtime('chat', partial));
    await act(async () => { await result.current.refreshLatestFromServer('chat'); });

    assert.deepEqual(result.current.getMessages('chat'), [persisted]);
    assert.equal(result.current.getSessionSlot('chat')?.realtimeMessages.length, 0);

    // An already buffered pre-disconnect update can arrive after the refresh.
    act(() => result.current.appendRealtime('chat', partial));
    assert.deepEqual(result.current.getMessages('chat'), [persisted]);
  });

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

describe('delta stream render identity', () => {
  it('retains its timestamp and render key through completion, then starts a distinct turn', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => result.current.updateStreaming('chat', '开始', 'claude'));
    const first = result.current.getMessages('chat')[0];
    act(() => result.current.updateStreaming('chat', '开始继续生成', 'claude'));
    const update = result.current.getMessages('chat')[0];
    assert.equal(update.renderId, first.renderId);
    assert.equal(update.timestamp, first.timestamp);
    act(() => result.current.finalizeStreaming('chat'));
    const finished = result.current.getMessages('chat')[0];
    assert.equal(finished.renderId, first.renderId);
    assert.equal(finished.timestamp, first.timestamp);
    assert.equal(finished.kind, 'text');
    act(() => result.current.updateStreaming('chat', '下一轮', 'claude'));
    const next = result.current.getMessages('chat')[1];
    assert.notEqual(next.renderId, finished.renderId);
  });
});
