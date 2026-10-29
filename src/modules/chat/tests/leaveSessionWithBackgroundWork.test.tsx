import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project, ProjectSession, SessionActivityMap } from '@/shared/types';

/**
 * Clearing the selection (new chat, project switch) resets the pane — unless
 * the viewed session is mid-response, when the selection is only lagging the
 * router and the view must survive. A session whose turn has ended with
 * background work still running is not mid-response: it is a real session
 * the user is leaving, and the pane must follow.
 */

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionTokenUsage: () => Promise.resolve({ ok: false, json: async () => ({}) }),
    },
  },
}));

const project: Project = {
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
};
const session: ProjectSession = { id: 'session-a', summary: 'A', lastActivity: '2026-01-01T00:00:00.000Z', messageCount: 1 } as ProjectSession;

const store = {
  fetchFromServer: vi.fn(async () => ({ fetchedAt: 1, status: 'idle' as const, total: 0, hasMore: false, offset: 0 })),
  fetchMore: vi.fn(),
  appendRealtime: vi.fn(),
  refreshLatestFromServer: vi.fn(),
  setActiveSession: vi.fn(),
  isStale: vi.fn(() => false),
  updateStreaming: vi.fn(),
  finalizeStreaming: vi.fn(),
  getMessages: vi.fn(() => []),
  getSessionSlot: vi.fn(() => ({ fetchedAt: 1, status: 'idle' as const, total: 0, hasMore: false, offset: 0 })),
};

async function renderWith(processingSessions: SessionActivityMap) {
  const { useChatSessionState } = await import('@/modules/chat/hooks/useChatSessionState');
  const resetStreamingState = vi.fn();
  const hook = renderHook(
    ({ selectedSession }: { selectedSession: ProjectSession | null }) =>
      useChatSessionState({
        isActive: true,
        selectedProject: project,
        selectedSession,
        ws: null,
        sendMessage: vi.fn(),
        resetStreamingState,
        statusCheckSentAtRef: { current: new Map() },
        lastSeqRef: { current: new Map() },
        sessionStore: store as never,
        processingSessions,
      }),
    { initialProps: { selectedSession: session as ProjectSession | null } },
  );
  assert.equal(hook.result.current.currentSessionId, 'session-a');
  resetStreamingState.mockClear();
  await act(async () => {
    hook.rerender({ selectedSession: null });
  });
  return { hook, resetStreamingState };
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

test('leaving a session whose turn has ended, with its background work running, resets the pane', async () => {
  const { hook, resetStreamingState } = await renderWith(new Map([
    ['session-a', { statusText: null, canInterrupt: false, startedAt: 1, background: true, tasks: [] }],
  ]));

  assert.equal(hook.result.current.currentSessionId, null);
  assert.equal(resetStreamingState.mock.calls.length, 1);
});

test('a session mid-response keeps its view while the selection catches up', async () => {
  const { hook, resetStreamingState } = await renderWith(new Map([
    ['session-a', { statusText: null, canInterrupt: true, startedAt: 1 }],
  ]));

  assert.equal(hook.result.current.currentSessionId, 'session-a');
  assert.equal(resetStreamingState.mock.calls.length, 0);
});

test('returning to an idle session reconciles questions through the existing socket and detaches resume listeners on unmount', async () => {
  const { useChatSessionState } = await import('@/modules/chat/hooks/useChatSessionState');
  const sendMessage = vi.fn();
  const options = {
    isActive: false, selectedProject: project, selectedSession: { ...session, provider: 'codex' as const },
    ws: { readyState: 1 } as WebSocket, sendMessage, resetStreamingState: vi.fn(),
    statusCheckSentAtRef: { current: new Map<string, number>() },
    lastSeqRef: { current: new Map([[session.id, 9]]) }, sessionStore: store as never,
  };
  const hook = renderHook(() => useChatSessionState(options));
  sendMessage.mockClear();
  for (const event of ['focus', 'pageshow']) act(() => { window.dispatchEvent(new Event(event)); });
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  assert.equal(sendMessage.mock.calls.length, 3);
  assert.deepEqual(sendMessage.mock.calls[0][0], {
    type: 'chat.subscribe', sessions: [{ sessionId: session.id, lastSeq: 9, watchNative: true }],
  });
  hook.unmount();
  act(() => { window.dispatchEvent(new Event('focus')); });
  assert.equal(sendMessage.mock.calls.length, 3);
});
