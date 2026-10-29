import assert from 'node:assert/strict';

import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { AskUserQuestionPanel } from '@/modules/chat/tools/InteractiveRenderers/AskUserQuestionPanel';
import { resetChatDrafts } from '@/shared/chatDrafts';
import type { PendingPermissionRequest } from '@/shared/types';

let requests: Array<{ url: string; body: any }>;
let nativeError: { code: string; message: string; status: number } | null;
let gate: Promise<void> | null;
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
beforeEach(() => {
  localStorage.clear();resetChatDrafts();requests = [];nativeError = null;gate = null;
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = String(url);const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ url: target, body });
    if (target.endsWith('/steer')) {
      await gate;
      return nativeError ? response({ error: nativeError }, nativeError.status) : response({ success: true, data: { turnId: 'live' } });
    }
    if (target.endsWith('/queued-message')) return response({ success: true, queuedMessage: body.queuedMessage, appended: false });
    if (target.endsWith('/drafts')) return response({ success: true, drafts: [] });
    if (target.includes('/files')) return response([]);
    if (target.endsWith('/commands/list')) return response({ builtIn: [], custom: [] });
    return response({ success: true, data: { skills: [] } });
  }));
});
afterEach(() => { cleanup();resetChatDrafts();vi.unstubAllGlobals(); });

const PROJECT = { projectId: 'project', displayName: 'Project', fullPath: '/tmp' };
const SESSION = { id: 'app' };

function composer(pendingPermissionRequests: PendingPermissionRequest[] = [], isLoading = true) {
  const sent: any[] = [];const messages: any[] = [];
  const view = renderHook(() => useChatComposerState({
    selectedProject: PROJECT, selectedSession: SESSION,
    currentSessionId: 'app', provider: 'codex', permissionMode: 'bypassPermissions', cyclePermissionMode() {},
    resolvePermissionModeForProvider: () => 'bypassPermissions', currentProviderModel: 'gpt-6.1-sol', currentProviderEffort: 'low',
    isLoading, canAbortSession: isLoading, tokenBudget: null,
    sendMessage: message => { sent.push(message);return true; }, addMessage: message => messages.push(message),
    scrollToBottom() {}, setIsUserScrolledUp() {}, pendingPermissionRequests, setPendingPermissionRequests() {},
  }));
  return { ...view, sent, messages };
}
async function type(view: ReturnType<typeof composer>, input: string) { await act(async () => { view.result.current.setInput(input); }); }
async function submit(view: ReturnType<typeof composer>) { await act(async () => { await view.result.current.handleSubmit({ preventDefault() {} } as never); }); }

test('Enter during working adds input to the native turn and keeps the task running', async () => {
  const view = composer();await type(view, 'Please inspect the tests first');await submit(view);
  assert.equal(requests.find(request => request.url.endsWith('/steer'))!.body.content, 'Please inspect the tests first');
  assert.equal(requests.some(request => request.url.includes('queued-message')), false);
  assert.equal(view.sent.some(message => message.type === 'chat.abort'), false);
  assert.equal(view.result.current.input, '');assert.equal(view.messages.at(-1).type, 'user');
});

test('Tab explicitly queues the next message while Codex is working', async () => {
  const view = composer();await type(view, 'Afterward run the full suite');
  await act(async () => { view.result.current.handleKeyDown({ key: 'Tab', preventDefault() {} } as never); });
  await waitFor(() => assert.equal(view.result.current.queuedDraft?.content, 'Afterward run the full suite'));
  assert.equal(requests.some(request => request.url.endsWith('/steer')), false);
});

test('a just-finished turn falls back to the durable queue', async () => {
  nativeError = { code: 'CODEX_NO_ACTIVE_TURN', message: 'Finished', status: 409 };
  const view = composer();await type(view, 'next task');await submit(view);
  assert.equal(view.result.current.queuedDraft?.content, 'next task');assert.equal(view.result.current.input, '');
});

test('a rejected or timed-out steer preserves the message and avoids a second submission', async () => {
  nativeError = { code: 'TIMEOUT', message: 'The request timed out', status: 504 };
  const view = composer();await type(view, 'keep this instruction');await submit(view);
  assert.equal(view.result.current.input, 'keep this instruction');
  assert.equal(requests.filter(request => request.url.endsWith('/steer')).length, 1);
  assert.equal(requests.some(request => request.url.includes('queued-message')), false);
  assert.equal(view.messages.at(-1).type, 'error');
});

test('text typed while steering is in flight stays in the composer', async () => {
  let release!: () => void;gate = new Promise(resolve => { release = resolve; });
  const view = composer();await type(view, 'first instruction');
  let pending: Promise<unknown>;
  act(() => { pending = view.result.current.handleSubmit({ preventDefault() {} } as never); });
  await waitFor(() => assert.ok(requests.some(request => request.url.endsWith('/steer'))));
  await type(view, 'second instruction');await act(async () => { release();await pending; });
  assert.equal(view.result.current.input, 'second instruction');
});

const asyncQuestion: PendingPermissionRequest = {
  requestId: 'codex:async:call-123', toolName: 'AskUserQuestion', sessionId: 'app',
  input: { questions: [{ id: '0', question: 'Which host?', options: [{ label: 'Mac' }, { label: 'Linux' }] }] },
  context: { provider: 'codex', nativeAsync: true, isBlocking: false, itemId: 'call-123' },
};

test('answering an asynchronous question steers a structured native reply and retains the separate draft', async () => {
  const view = composer([asyncQuestion]);await type(view, 'my separate follow-up');
  await act(async () => { await view.result.current.handlePermissionDecision(asyncQuestion.requestId, { allow: true, updatedInput: { answers: { '0': 'Mac' } } }); });
  const text = requests.find(request => request.url.endsWith('/steer'))!.body.content;
  const replies = JSON.parse(text.split('<send_user_message_question_reply>')[1].split('</send_user_message_question_reply>')[0]);
  assert.deepEqual(JSON.parse(replies[0].questionItemId), ['request_user_input_async', 'call-123', 0]);
  assert.equal(replies[0].answer, 'Mac');assert.equal(view.result.current.input, 'my separate follow-up');
  assert.equal(view.sent.find(message => message.type === 'chat.permission-response')?.sessionId, 'app');
  assert.equal(view.sent.some(message => message.type === 'chat.abort'), false);
});

test('an asynchronous question answered after completion starts the next native chat turn', async () => {
  const view = composer([asyncQuestion], false);await type(view, 'separate draft');
  await act(async () => { await view.result.current.handlePermissionDecision(asyncQuestion.requestId, { allow: true, updatedInput: { answers: { '0': 'Linux' } } }); });
  assert.ok(view.sent.find(message => message.type === 'chat.send').content.includes('send_user_message_question_reply'));
  assert.equal(view.result.current.input, 'separate draft');
});

test('question choices return native ids and the nonblocking status appears in the card', () => {
  const decisions: any[] = [];
  render(<AskUserQuestionPanel request={asyncQuestion} onDecision={(id, decision) => decisions.push({ id, decision })} />);
  fireEvent.click(screen.getByRole('button', { name: /Mac/ }));fireEvent.click(screen.getByRole('button', { name: /Submit/ }));
  assert.equal(decisions[0].decision.updatedInput.answers['0'], 'Mac');assert.ok(screen.getByText(/Work continues|任务继续执行/));
});

test('native free-text questions display an editable answer field immediately', () => {
  const decisions: any[] = [];
  render(<AskUserQuestionPanel request={{ ...asyncQuestion, input: { questions: [{ id: 'name', question: 'Workspace name?', options: [], isSecret: true }] } }} onDecision={(id, decision) => decisions.push({ id, decision })} />);
  const field = document.querySelector('input[aria-label="Workspace name?"]')!;
  assert.equal(field.getAttribute('type'), 'password');
  fireEvent.change(field, { target: { value: 'project-alpha' } });fireEvent.click(screen.getByRole('button', { name: /Submit/ }));
  assert.equal(decisions[0].decision.updatedInput.answers.name, 'project-alpha');
});
