import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import { useSessionProtection } from '@/shared/hooks/useSessionProtection';

afterEach(() => { vi.useRealTimers(); });

test('a server-confirmed run clears on the next idle poll even when it started recently', () => {
  const { result } = renderHook(() => useSessionProtection());
  act(() => result.current.syncProcessingSessions([{ sessionId: 'opencode', startedAt: Date.now() }]));
  assert.equal(result.current.isSessionProcessing('opencode'), true);
  act(() => result.current.syncProcessingSessions([]));
  assert.equal(result.current.isSessionProcessing('opencode'), false);
});

test('a local send keeps its startup grace, then clears promptly after server confirmation', () => {
  const { result } = renderHook(() => useSessionProtection());
  act(() => result.current.markSessionProcessing('codex'));
  act(() => result.current.syncProcessingSessions([]));
  assert.equal(result.current.isSessionProcessing('codex'), true);
  act(() => result.current.syncProcessingSessions([{ sessionId: 'codex', startedAt: Date.now() }]));
  act(() => result.current.syncProcessingSessions([]));
  assert.equal(result.current.isSessionProcessing('codex'), false);
});

test('unconfirmed starts expire and server-confirmed background tasks clear on idle', () => {
  vi.useFakeTimers();
  const { result } = renderHook(() => useSessionProtection());
  act(() => result.current.markSessionProcessing('pending'));
  act(() => { vi.advanceTimersByTime(10_001);result.current.syncProcessingSessions([]); });
  assert.equal(result.current.isSessionProcessing('pending'), false);
  act(() => result.current.syncProcessingSessions([{ sessionId: 'background', startedAt: Date.now(), background: true }]));
  assert.equal(result.current.processingSessions.has('background'), true);
  act(() => result.current.syncProcessingSessions([]));
  assert.equal(result.current.processingSessions.has('background'), false);
});
