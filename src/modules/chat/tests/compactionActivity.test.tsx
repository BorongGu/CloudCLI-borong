import assert from 'node:assert/strict';

import { useEffect } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import '@/modules/i18n';
import ActivityIndicator from '@/modules/chat/composer/ActivityIndicator';
import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';
import { useSessionProtection } from '@/shared/hooks/useSessionProtection';
import type { ServerEvent } from '@/shared/types';

afterEach(() => { cleanup();vi.useRealTimers(); });

test('compression has an independent notice and clock through interleaved status updates, then resumes the run timer', async () => {
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-26T00:00:00Z'));
  let receive: (event: ServerEvent) => void = () => {};
  const subscribe = (listener: typeof receive) => { receive = listener;return () => {}; };
  const abort = vi.fn();
  let sync: ReturnType<typeof useSessionProtection>['syncProcessingSessions'] = () => {};
  function Harness() {
    const protection = useSessionProtection();
    useEffect(() => { sync = protection.syncProcessingSessions; }, [protection.syncProcessingSessions]);
    useChatRealtimeHandlers({
      subscribe, isActive: true, provider: 'codex', selectedSession: null, currentSessionId: 'viewed',
      setTokenBudget: () => {}, pendingPermissionRequests: [], setPendingPermissionRequests: () => {},
      streamTimerRef: { current: null }, accumulatedStreamRef: { current: '' }, lastSeqRef: { current: new Map() },
      statusCheckSentAtRef: { current: new Map() }, requestLatestMessages: async () => {}, sessionStore: {} as SessionStore,
      onSessionProcessing: protection.markSessionProcessing, onSessionIdle: protection.markSessionIdle,
    });
    return <ActivityIndicator activity={protection.processingSessions.get('viewed') || null} onAbort={abort} />;
  }
  const view = render(<Harness />);
  const status = (phase: 'running' | 'done', sessionId = 'viewed'): ServerEvent => ({ kind: 'status', text: 'context_compaction', compact: { phase }, sessionId, canInterrupt: true }) as ServerEvent;
  await act(async () => { receive({ kind: 'status', text: 'Thinking', sessionId: 'viewed' } as ServerEvent); });
  await act(async () => { vi.advanceTimersByTime(5000);receive(status('running')); });
  assert.ok(view.container.querySelector('[data-compaction-indicator]'));
  assert.equal(view.container.querySelector('[data-activity-spinner]'), null);
  assert.ok(view.getByRole('button', { name: /Stop|停止/ }));
  await act(async () => { vi.advanceTimersByTime(5000);receive(status('done', 'other-session')); });
  await act(async () => { receive({ kind: 'status', text: 'Analyzing', sessionId: 'viewed' } as ServerEvent); });
  assert.ok(view.container.querySelector('[data-compaction-indicator]'));
  assert.match(view.container.textContent || '', /5s/);
  fireEvent.click(view.getByRole('button', { name: /Stop|停止/ }));
  assert.equal(abort.mock.calls.length, 1);
  await act(async () => { receive(status('done')); });
  assert.doesNotMatch(view.container.textContent || '', /Compacting/);
  assert.match(view.container.textContent || '', /10s/);
  assert.ok(view.getByRole('button', { name: /Stop|停止/ }));
  assert.ok(view.container.querySelector('[data-activity-spinner]'));

  await act(async () => { vi.advanceTimersByTime(5000);sync([{ sessionId: 'viewed', statusText: 'Compacting' }]); });
  assert.ok(view.container.querySelector('[data-compaction-indicator]'));
  await act(async () => { sync([{ sessionId: 'viewed', statusText: 'Thinking' }]); });
  assert.equal(view.container.querySelector('[data-compaction-indicator]'), null);
  assert.match(view.container.textContent || '', /15s/);
});
