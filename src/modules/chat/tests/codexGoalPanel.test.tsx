import assert from 'node:assert/strict';

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { FormEvent } from 'react';
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
  assert.equal(state.sent[0].sessions[0].replay, false);
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

test('pause applies its response immediately and ignores an older in-flight refresh', async () => {
  const view = render(<CodexGoalPanel sessionId="session" />);
  await view.findByText('A native goal');
  let completeRead!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (!init?.body) return new Promise<Response>(resolve => { completeRead = resolve; });
    return new Response(JSON.stringify({ data: { goal: { ...goal, status: 'paused', tokensUsed: 420 } } }));
  }));
  await act(async () => { for (const listener of state.listeners) listener({ kind: 'websocket_reconnected' }); });
  fireEvent.click(view.getByRole('button', { name: /Pause|暂停/ }));
  await view.findByRole('button', { name: /Resume|恢复/ });
  await act(async () => { completeRead(new Response(JSON.stringify({ data: { goal: { ...goal, tokensUsed: 0 } } }))); });
  assert.ok(view.getByRole('button', { name: /Resume|恢复/ }));
  assert.match(view.getByTestId('codex-goal-panel').textContent!, /420/);
  assert.equal(state.sent.length, 1);
});

test('a live goal update supersedes an older HTTP snapshot', async () => {
  let completeRead!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { completeRead = resolve; })));
  const view = render(<CodexGoalPanel sessionId="session" />);
  await act(async () => {
    for (const listener of state.listeners) listener({ kind: 'status', text: 'codex_goal', sessionId: 'session', goal: { ...goal, tokensUsed: 999 } });
    completeRead(new Response(JSON.stringify({ data: { goal } })));
  });
  assert.match(view.getByTestId('codex-goal-panel').textContent!, /999/);
});

test('the compact objective expands on demand while goal updates keep that choice', async () => {
  const view = render(<CodexGoalPanel sessionId="session" />);
  const objective = await view.findByRole('button', { name: 'A native goal' });
  const detailsId = objective.getAttribute('aria-controls')!;
  assert.equal(objective.getAttribute('aria-expanded'), 'false');
  assert.equal(document.getElementById(detailsId), null);
  fireEvent.click(objective);
  assert.equal(objective.getAttribute('aria-expanded'), 'true');
  assert.match(document.getElementById(detailsId)?.textContent ?? '', /A native goal/);
  await act(async () => { for (const listener of state.listeners) listener({ kind: 'status', text: 'codex_goal', sessionId: 'session', goal: { ...goal, tokensUsed: 321 } }); });
  assert.equal(objective.getAttribute('aria-expanded'), 'true');
  fireEvent.click(objective);
  assert.equal(objective.getAttribute('aria-expanded'), 'false');
  assert.equal(document.getElementById(detailsId), null);
});

test('goal controls inside the composer act without sending a chat message', async () => {
  const submit = vi.fn((event: FormEvent) => event.preventDefault());
  const view = render(<form onSubmit={submit}><CodexGoalPanel sessionId="session" /></form>);
  fireEvent.click(await view.findByRole('button', { name: 'A native goal' }));
  fireEvent.click(view.getByRole('button', { name: /Pause|暂停/ }));
  fireEvent.click(await view.findByRole('button', { name: /Resume|恢复/ }));
  const pause = await view.findByRole('button', { name: /Pause|暂停/ });
  await waitFor(() => assert.equal((pause as HTMLButtonElement).disabled, false));
  fireEvent.click(view.getByRole('button', { name: /Clear|清除/ }));
  await waitFor(() => assert.equal(Boolean(view.queryByTestId('codex-goal-panel')), false));
  assert.equal(submit.mock.calls.length, 0);
});
