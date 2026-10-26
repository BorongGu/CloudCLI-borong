import assert from 'node:assert/strict';

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import type { LLMProvider } from '@/shared/types';

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let requests: Array<{ url: string; body: any }>;
let failure = false;
const PROJECT = { projectId: 'project', displayName: 'Workspace', fullPath: '/tmp/workspace' };
const SESSION = { id: 'session-existing' };
beforeEach(() => {
  localStorage.clear();requests = [];failure = false;
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = String(url);requests.push({ url: target, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (target === '/api/commands/list') return response({ builtIn: [], custom: [] });
    if (target.endsWith('/goal')) return failure ? response({ error: { message: 'Native goal rejected' } }, 400) : response({ success: true, data: { goal: { objective: 'test objective', status: 'paused' } } });
    if (target.includes('/files')) return response([]);
    return response({ success: true, data: { skills: [] } });
  }));
});
afterEach(() => { cleanup();vi.unstubAllGlobals(); });

function composer(isLoading = false, provider: LLMProvider = 'codex') {
  const sent: any[] = [];
  const sideQuestions: string[] = [];
  const view = renderHook(() => useChatComposerState({
    selectedProject: PROJECT, selectedSession: SESSION,
    currentSessionId: 'session-existing', provider, permissionMode: 'bypassPermissions', cyclePermissionMode: () => {},
    resolvePermissionModeForProvider: () => 'bypassPermissions',
    currentProviderModel: 'gpt-6.1-sol', currentProviderEffort: 'low', isLoading, canAbortSession: isLoading,
    tokenBudget: null, sendMessage: message => { sent.push(message);return true; }, onSessionEstablished: () => {},
    scrollToBottom: () => {}, addMessage: () => {}, setIsUserScrolledUp: () => {}, setPendingPermissionRequests: () => {},
    onOpenBtw: question => { sideQuestions.push(question); },
  }));
  return { ...view, sent, sideQuestions };
}
async function submit(view: ReturnType<typeof composer>, input: string) {
  await act(async () => { view.result.current.setInput(input); });
  await act(async () => { await view.result.current.handleSubmit({ preventDefault() {} } as never); });
}

test('Codex exposes /goal and sends an idle objective to the native runtime', async () => {
  const view = composer();await waitFor(() => assert.equal(view.result.current.slashCommandsCount, 2));
  await submit(view, '/goal finish the migration\nand verify tests');
  assert.equal(view.sent.find(e => e.type === 'chat.send').content, '/goal finish the migration\nand verify tests');
  assert.equal(requests.some(r => r.url === '/api/commands/execute'), false);
});
for (const action of ['pause', 'resume', 'clear']) test(`/goal ${action} executes immediately during a running turn`, async () => {
  const view = composer(true);await submit(view, '/goal ' + action);
  assert.equal(requests.find(r => r.url.endsWith('/goal'))!.body.action, action);
  assert.equal(view.sent.length, 0);assert.equal(view.result.current.input, '');
  assert.equal(requests.some(r => r.url.includes('queued')), false);
});
test('rejected goal controls preserve the input for retry', async () => {
  failure = true;const view = composer(true);await submit(view, '/goal pause');
  assert.equal(view.result.current.input, '/goal pause');assert.equal(view.sent.length, 0);
});
test('other providers retain their ordinary /goal text behavior', async () => {
  const view = composer(false, 'opencode');await submit(view, '/goal ordinary text');
  assert.equal(requests.some(r => r.url.endsWith('/goal')), false);
  assert.equal(view.sent.find(e => e.type === 'chat.send').content, '/goal ordinary text');
});

test('/btw opens a separate window during work before queueing or steering', async () => {
  const view = composer(true);await submit(view, '/btw what did we change?');
  assert.deepEqual(view.sideQuestions, ['what did we change?']);
  assert.deepEqual(view.sent, []);
  assert.equal(requests.some(r => /steer|queued|commands\/execute/.test(r.url)), false);
  assert.equal(view.result.current.input, '');
});

test('/btw alone opens an empty side window', async () => {
  const view = composer();await submit(view, '/btw');
  assert.deepEqual(view.sideQuestions, ['']);assert.deepEqual(view.sent, []);
});

test('selecting /btw from the command menu opens its window immediately', async () => {
  const view = composer(true);
  await act(async () => { view.result.current.setInput('/btw'); });
  await act(async () => { view.result.current.handleCommandSelect({ name: '/btw', type: 'built-in', metadata: { type: 'native-btw' } }, 0, false); });
  await waitFor(() => assert.deepEqual(view.sideQuestions, ['']));
  assert.equal(requests.some(r => r.url === '/api/commands/execute'), false);
});

test('Enter uses the exact /btw command while the menu still shows the previous query', async () => {
  const view = composer(true);await waitFor(() => assert.equal(view.result.current.slashCommandsCount, 2));
  await act(async () => { view.result.current.handleToggleCommandMenu();view.result.current.setInput('/btw'); });
  await act(async () => { view.result.current.handleCommandSelect({ name: '/goal', type: 'built-in', metadata: { type: 'codex-goal' } }, 0, true); });
  await act(async () => { view.result.current.handleKeyDown({ key: 'Enter', preventDefault() {}, nativeEvent: {} } as never); });
  await waitFor(() => assert.deepEqual(view.sideQuestions, ['']));
  assert.equal(view.result.current.input, '');
});

test('OpenCode exposes /btw and opens it during work before queuing', async () => {
  const view = composer(true, 'opencode');await waitFor(() => assert.equal(view.result.current.slashCommandsCount, 1));
  await submit(view, '/btw summarize the current changes');
  assert.deepEqual(view.sideQuestions, ['summarize the current changes']);assert.deepEqual(view.sent, []);
  assert.equal(requests.some(request => /steer|queued|commands\/execute/.test(request.url)), false);
});
