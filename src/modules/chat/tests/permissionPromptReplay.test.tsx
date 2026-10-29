import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { test } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import type { ServerEvent, ProjectSession, PendingPermissionRequest, MarkSessionProcessing } from '@/shared/types';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';

/**
 * Answering a permission prompt resolves it over the inbound socket only, but
 * the `permission_request` frame stays in the run's replay buffer. A mid-run
 * page refresh replays the whole buffer, so without a retracting
 * `permission_resolved` frame the already-answered prompt resurrected on every
 * refresh (and lingered forever in a second tab watching the same run).
 */

const renderHandlers = (onSessionProcessing?: MarkSessionProcessing) => {
  let listener: ((event: ServerEvent) => void) | null = null;
  let pending: PendingPermissionRequest[] = [];

  renderHook(() => useChatRealtimeHandlers({
    isActive: true,
    subscribe: (fn) => {
      listener = fn;
      return () => { listener = null; };
    },
    provider: 'claude',
    selectedSession: { id: 'viewed-session' } as ProjectSession,
    currentSessionId: 'viewed-session',
    setTokenBudget: () => {},
    pendingPermissionRequests: [],
    setPendingPermissionRequests: (next) => {
      pending = typeof next === 'function' ? next(pending) : next;
    },
    streamTimerRef: { current: null },
    accumulatedStreamRef: { current: '' },
    lastSeqRef: { current: new Map() },
    statusCheckSentAtRef: { current: new Map() },
    requestLatestMessages: async () => {},
    onSessionProcessing,
    sessionStore: { appendRealtime: () => {} } as unknown as SessionStore,
  }));

  const dispatch = (event: ServerEvent) => listener?.(event);
  return { dispatch, getPending: () => pending };
};

const requestEvent = (requestId: string, seq: number): ServerEvent => ({
  kind: 'permission_request',
  requestId,
  toolName: 'AskUserQuestion',
  input: { questions: [] },
  sessionId: 'viewed-session',
  seq,
} as unknown as ServerEvent);

const resolvedEvent = (requestId: string, seq: number): ServerEvent => ({
  kind: 'permission_resolved',
  requestId,
  sessionId: 'viewed-session',
  seq,
} as unknown as ServerEvent);

test('a replayed request followed by its resolution leaves no pending prompt', () => {
  const { dispatch, getPending } = renderHandlers();

  // Reconnect after a mid-run refresh: the ack carries no pending approvals,
  // then the replay re-delivers the answered request and its resolution.
  dispatch({
    kind: 'chat_subscribed',
    sessionId: 'viewed-session',
    isProcessing: true,
    pendingPermissions: [],
  } as unknown as ServerEvent);
  dispatch(requestEvent('req-answered', 1));
  dispatch(resolvedEvent('req-answered', 2));

  assert.deepEqual(getPending(), []);
});

test('an unanswered request stays pending through a resolution for another id', () => {
  const { dispatch, getPending } = renderHandlers();

  dispatch(requestEvent('req-open', 1));
  dispatch(resolvedEvent('req-other', 2));

  const pending = getPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].requestId, 'req-open');
});

test('an idempotent answer acknowledgement clears a stale phone card even without a replay sequence', () => {
  const { dispatch, getPending } = renderHandlers();
  dispatch(requestEvent('answered-on-mac', 1));
  dispatch({ kind: 'permission_resolved', requestId: 'answered-on-mac', sessionId: 'viewed-session' } as ServerEvent);
  assert.deepEqual(getPending(), []);
});

test('a recovered nonblocking question remains actionable while its completed session stays idle', () => {
  const processing: unknown[] = [];
  const { dispatch, getPending } = renderHandlers((sessionId) => processing.push(sessionId));
  dispatch({ ...requestEvent('idle-async-question', 1), context: { provider: 'codex', isBlocking: false } } as ServerEvent);
  assert.equal(getPending()[0]?.requestId, 'idle-async-question');
  assert.deepEqual(processing, []);
});

test('a reattached run restores interrupt availability after status-only native detection', () => {
  const observed: unknown[] = [];
  const { dispatch } = renderHandlers((sessionId, activity) => observed.push({ sessionId, activity }));
  dispatch({ kind: 'chat_subscribed', sessionId: 'viewed-session', isProcessing: true, pendingPermissions: [] } as unknown as ServerEvent);
  assert.deepEqual(observed, [{ sessionId: 'viewed-session', activity: { canInterrupt: true } }]);
});
