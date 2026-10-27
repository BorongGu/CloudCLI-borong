import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

import { clearRunningSessionCompletions, isSessionCompleted, markSessionCompletionRead, observeSessionCompletion } from '@/shared/utils';

beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.useRealTimers(); });
const reply = (sessionId = 'session') => observeSessionCompletion({ sessionId, kind: 'text', role: 'assistant', content: 'Final answer' });
const finish = (extra = {}) => observeSessionCompletion({ sessionId: 'session', kind: 'complete', success: true, ...extra });

test('a successful final reply is recorded and survives a fresh module load', async () => {
  reply();assert.equal(isSessionCompleted('session'), false);
  finish();assert.equal(isSessionCompleted('session'), true);
  vi.resetModules();
  const restored = await import('@/shared/utils');assert.equal(restored.isSessionCompleted('session'), true);
});

test('empty completion, failure and interruption leave completion clear', () => {
  finish();assert.equal(isSessionCompleted('session'), false);
  reply();finish({ success: false });assert.equal(isSessionCompleted('session'), false);
  reply();finish({ aborted: true });assert.equal(isSessionCompleted('session'), false);
  reply();observeSessionCompletion({ sessionId: 'session', kind: 'error', content: 'Capacity error' });
  finish({ success: undefined });assert.equal(isSessionCompleted('session'), false);
});

test('replayed terminal events and metadata preserve the completion check', () => {
  reply();finish();finish();
  for (const event of [{ kind: 'session_upserted' }, { kind: 'status', text: 'token_budget' }, { kind: 'status', text: 'codex_goal' }, { kind: 'chat_subscribed', isProcessing: false }]) {
    observeSessionCompletion({ sessionId: 'session', ...event });
    assert.equal(isSessionCompleted('session'), true);
  }
});

test('a new question or authoritative running poll clears the old completion', () => {
  reply();finish();observeSessionCompletion({ sessionId: 'session', kind: 'text', role: 'user', content: 'Next task' });
  assert.equal(isSessionCompleted('session'), false);
  reply();finish();clearRunningSessionCompletions(['session']);assert.equal(isSessionCompleted('session'), false);
});

test('a recovered provider and streamed assistant text can complete successfully', () => {
  observeSessionCompletion({ sessionId: 'session', kind: 'error', content: 'Retrying' });
  observeSessionCompletion({ sessionId: 'session', kind: 'stream_delta', content: 'Recovered answer' });
  finish();assert.equal(isSessionCompleted('session'), true);
});

test('an in-flight poll describing the previous run preserves a completion that arrived while it was fetching', () => {
  vi.useFakeTimers();vi.setSystemTime(1000);reply();finish();
  clearRunningSessionCompletions(['session'], 999);assert.equal(isSessionCompleted('session'), true);
  clearRunningSessionCompletions(['session'], 1001);assert.equal(isSessionCompleted('session'), false);
});

test('opening a session acknowledges its final reply and suppresses the same terminal replay', async () => {
  const terminal = { id: 'terminal-one', timestamp: '2026-10-27T10:00:00.000Z' };
  reply();finish(terminal);
  assert.equal(isSessionCompleted('session'), true);
  markSessionCompletionRead('session');
  assert.equal(isSessionCompleted('session'), false);
  reply();finish(terminal);
  assert.equal(isSessionCompleted('session'), false);

  vi.resetModules();
  const restored = await import('@/shared/utils');
  restored.observeSessionCompletion({ sessionId: 'session', kind: 'text', role: 'assistant', content: 'Replayed answer' });
  restored.observeSessionCompletion({ sessionId: 'session', kind: 'complete', success: true, ...terminal });
  assert.equal(restored.isSessionCompleted('session'), false);

  restored.observeSessionCompletion({ sessionId: 'session', kind: 'text', role: 'user', content: 'Next question' });
  restored.observeSessionCompletion({ sessionId: 'session', kind: 'text', role: 'assistant', content: 'New final answer' });
  restored.observeSessionCompletion({ sessionId: 'session', kind: 'complete', success: true, id: 'terminal-two', timestamp: terminal.timestamp });
  assert.equal(restored.isSessionCompleted('session'), true);
});

test('a visible final reply is read immediately while another session stays unread', () => {
  reply();
  observeSessionCompletion({ sessionId: 'session', kind: 'complete', success: true, id: 'visible-terminal' }, 'session');
  assert.equal(isSessionCompleted('session'), false);
  reply('other');
  observeSessionCompletion({ sessionId: 'other', kind: 'complete', success: true, id: 'background-terminal' }, 'session');
  assert.equal(isSessionCompleted('other'), true);
});

test('legacy completion snapshots migrate when read and suppress older timestamped replays', () => {
  localStorage.setItem('cloudcli-completed-sessions', JSON.stringify([['legacy', 1000]]));
  assert.equal(isSessionCompleted('legacy'), true);
  markSessionCompletionRead('legacy');
  assert.equal(isSessionCompleted('legacy'), false);
  reply('legacy');
  observeSessionCompletion({ sessionId: 'legacy', kind: 'complete', success: true, timestamp: '2020-01-01T00:00:00.000Z' });
  assert.equal(isSessionCompleted('legacy'), false);
});
