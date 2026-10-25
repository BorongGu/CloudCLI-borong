import assert from 'node:assert/strict';

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { CodexGoalPanel } from '@/modules/chat/composer/CodexGoalPanel';

const state = vi.hoisted(() => ({ listeners: new Set<(event: any) => void>(), sent: [] as any[] }));
const subscribe = vi.hoisted(() => (listener: (event: any) => void) => { state.listeners.add(listener);return () => state.listeners.delete(listener); });
const sendMessage = vi.hoisted(() => (message: any) => { state.sent.push(message);return true; });
vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe, sendMessage }) }));
let goal: any;
beforeEach(() => {
  goal = { objective: 'A native goal', status: 'active', tokensUsed: 100, timeUsedSeconds: 65 };
  state.sent.length = 0;state.listeners.clear();
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.body) {
      const { action } = JSON.parse(String(init.body));
      goal = action === 'clear' ? null : { ...goal, status: action === 'pause' ? 'paused' : 'active' };
    }
    return new Response(JSON.stringify({ success: true, data: { goal } }), { headers: { 'Content-Type': 'application/json' } });
  }));
});
afterEach(() => { cleanup();vi.unstubAllGlobals(); });

test('native goal status and controls persist across a remount', async () => {
  const view = render(<CodexGoalPanel sessionId="session" />);
  await view.findByText('A native goal');
  assert.equal(state.sent[0].sessions[0].watchGoal, true);
  fireEvent.click(view.getByRole('button', { name: /Pause|暂停/ }));
  await waitFor(() => assert.equal(goal.status, 'paused'));
  await view.findByRole('button', { name: /Resume|恢复/ });
  view.unmount();const reopened = render(<CodexGoalPanel sessionId="session" />);
  await reopened.findByRole('button', { name: /Resume|恢复/ });
  fireEvent.click(reopened.getByRole('button', { name: /Resume|恢复/ }));
  await reopened.findByRole('button', { name: /Pause|暂停/ });
  const clear = reopened.getByRole('button', { name: /Clear|清除/ }) as HTMLButtonElement;
  await waitFor(() => assert.equal(clear.disabled, false));
  fireEvent.click(clear);
  await waitFor(() => assert.equal(Boolean(reopened.queryByTestId('codex-goal-panel')), false));
});
test('goal updates and reconnection are consumed without replacing the session', async () => {
  const view = render(<CodexGoalPanel sessionId="session" />);await view.findByText('A native goal');
  await act(async () => { for (const listener of state.listeners) listener({ kind: 'status', text: 'codex_goal', sessionId: 'session', goal: { ...goal, tokensUsed: 321 } }); });
  assert.match(view.getByTestId('codex-goal-panel').textContent!, /321/);
  await act(async () => { for (const listener of state.listeners) listener({ kind: 'websocket_reconnected' }); });
  await waitFor(() => assert.equal(state.sent.length, 2));
});
test('navigation clears the displayed goal while the next session loads', async () => {
  const view = render(<CodexGoalPanel sessionId="first" />);await view.findByText('A native goal');
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  view.rerender(<CodexGoalPanel sessionId="second" />);
  assert.equal(view.queryByText('A native goal'), null);
});
