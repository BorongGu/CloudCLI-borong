import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { useProjectsState } from '@/modules/project-workspace/hooks/useProjectsState';
import type { ProjectSession, ServerEvent } from '@/shared/types';
import { isSessionCompleted } from '@/shared/utils';

vi.mock('@/shared/api', () => ({ api: {
  projects: async () => ({ ok: true, json: async () => [{ projectId: 'project', fullPath: '/repo', displayName: 'Repo',
    sessions: [{ id: 'viewed', provider: 'codex' }, { id: 'other', provider: 'opencode' }] }] }),
  projectTaskmaster: async () => ({ ok: false }),
  sessionDetails: async () => ({ ok: false }),
} }));

let dispatch: (event: ServerEvent) => void;
const subscribe = (listener: typeof dispatch) => { dispatch = listener;return () => {}; };
const emit = (event: Record<string, unknown>) => act(() => dispatch(event as ServerEvent));
async function fixture() {
  const view = renderHook(() => useProjectsState({ sessionId: 'viewed', navigate: vi.fn(), subscribe,
    isMobile: false, isSessionProcessing: () => false }));
  await waitFor(() => assert.equal(view.result.current.selectedSession?.id, 'viewed'));
  return view;
}
beforeEach(() => { localStorage.clear(); });

test.each(['codex', 'opencode'])('%s history, streaming and metadata synchronization leave idle reminders clear', async provider => {
  const { result } = await fixture();
  for (let i = 0; i < 3; i++) {
    for (const kind of ['session_upserted', 'status', 'text', 'stream_delta', 'tool_use', 'tool_result', 'complete']) {
      emit({ kind, provider, sessionId: 'other', success: true,
        session: { id: 'other', summary: 'Synchronized title', lastActivity: new Date().toISOString() } });
    }
  }
  assert.equal(result.current.sidebarSharedProps.attentionSessionIds.size, 0);
});

test('only outstanding request ids keep a reminder after another device answers', async () => {
  const { result } = await fixture();
  for (const requestId of ['first', 'second']) emit({ kind: 'permission_request', sessionId: 'other', requestId });
  assert.equal(result.current.sidebarSharedProps.attentionSessionIds.has('other'), true);
  emit({ kind: 'permission_resolved', sessionId: 'other', requestId: 'first' });
  assert.equal(result.current.sidebarSharedProps.attentionSessionIds.has('other'), true);
  emit({ kind: 'permission_cancelled', sessionId: 'other', requestId: 'second' });
  assert.equal(result.current.sidebarSharedProps.attentionSessionIds.has('other'), false);
});

test('reconnect snapshots clear resolved prompts while keeping explicit errors until viewed or recovered', async () => {
  const { result } = await fixture();
  emit({ kind: 'chat_subscribed', sessionId: 'other', pendingPermissions: [{ requestId: 'pending' }] });
  assert.equal(result.current.sidebarSharedProps.attentionSessionIds.has('other'), true);
  emit({ kind: 'chat_subscribed', sessionId: 'other', pendingPermissions: [] });
  assert.equal(result.current.sidebarSharedProps.attentionSessionIds.has('other'), false);
  emit({ kind: 'error', sessionId: 'other', content: 'Model is at capacity' });
  emit({ kind: 'chat_subscribed', sessionId: 'other', pendingPermissions: [] });
  assert.equal(result.current.sidebarSharedProps.attentionSessionIds.has('other'), true);
  emit({ kind: 'complete', sessionId: 'other', success: true });
  assert.equal(result.current.sidebarSharedProps.attentionSessionIds.has('other'), false);
  emit({ kind: 'error', sessionId: 'other', content: 'Provider failed' });
  act(() => result.current.handleSessionSelect({ id: 'other', provider: 'opencode' } as ProjectSession));
  assert.equal(result.current.sidebarSharedProps.attentionSessionIds.has('other'), false);
  emit({ kind: 'session_upserted', sessionId: 'other', session: { id: 'other', summary: 'Metadata refresh' } });
  assert.equal(result.current.sidebarSharedProps.attentionSessionIds.size, 0);
});

test('opening a background final reply clears its check and a later unread reply restores it', async () => {
  const { result } = await fixture();
  const finish = (terminalId: string) => {
    emit({ kind: 'text', sessionId: 'other', role: 'assistant', content: 'Final reply' });
    emit({ kind: 'complete', sessionId: 'other', success: true, id: terminalId });
  };
  finish('first');
  assert.equal(isSessionCompleted('other'), true);
  act(() => result.current.handleSessionSelect({ id: 'other', provider: 'opencode' } as ProjectSession));
  assert.equal(isSessionCompleted('other'), false);
  act(() => result.current.handleSessionSelect({ id: 'viewed', provider: 'codex' } as ProjectSession));
  finish('first');
  assert.equal(isSessionCompleted('other'), false);
  finish('second');
  assert.equal(isSessionCompleted('other'), true);
});

test('visible sessions acknowledge final replies and returning to a hidden tab clears its check', async () => {
  await fixture();
  const finish = (terminalId: string) => {
    emit({ kind: 'text', sessionId: 'viewed', role: 'assistant', content: 'Final reply' });
    emit({ kind: 'complete', sessionId: 'viewed', success: true, id: terminalId });
  };
  finish('visible');
  assert.equal(isSessionCompleted('viewed'), false);
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  finish('hidden');
  assert.equal(isSessionCompleted('viewed'), true);
  visibility.mockReturnValue('visible');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  assert.equal(isSessionCompleted('viewed'), false);
});
