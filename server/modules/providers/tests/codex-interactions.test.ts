import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { CodexQuestions } from '@/modules/providers/list/codex/codex-questions.provider.js';
import { createCodexSteeringService } from '@/modules/providers/services/codex-steering.service.js';
import type { sessionsDb } from '@/modules/database/index.js';
type SessionRow = NonNullable<ReturnType<typeof sessionsDb.getSessionById>>;

class Client extends EventEmitter {
  calls: Array<{ method: string; params: any }> = [];
  replies: any[] = [];
  active = true;
  failure = '';
  history: any[] = [];
  retained: any[] = [];
  async call(method: string, params: any) {
    this.calls.push({ method, params });
    if (method === 'thread/items/list') return { data: this.history };
    if (method === 'thread/turns/list') return { data: this.active ? [{ id: 'turn-live', status: 'inProgress' }] : [] };
    if (this.failure) throw new Error(this.failure);
    return { turnId: 'turn-live' };
  }
  respond(id: string | number, result: any) { this.replies.push({ id, result }); }
  pendingRequests() { return this.retained; }
  notify(method: string, params: any) { this.emit('notification', { method, params: { threadId: 'native', ...params } }); }
}
const lookup = () => ({ session_id: 'app', provider: 'codex', provider_session_id: 'native', project_path: '/tmp' } as SessionRow);

test('working input steers the mapped native turn without interrupting or creating another turn', async () => {
  const client = new Client();
  const result = await createCodexSteeringService(client, lookup).steer('app', 'Please check tests first');
  assert.equal(result.turnId, 'turn-live');
  assert.deepEqual(client.calls[1], { method: 'turn/steer', params: {
    threadId: 'native', expectedTurnId: 'turn-live', input: [{ type: 'text', text: 'Please check tests first' }],
  } });
  assert.equal(client.calls.length, 2);
});

test('a settled turn reports a retryable queue precondition; a timed out input is never replayed', async () => {
  const client = new Client(); const service = createCodexSteeringService(client, lookup);
  client.active = false;
  await assert.rejects(service.steer('app', 'next'), (error: any) => error.statusCode === 409 && error.code === 'CODEX_NO_ACTIVE_TURN');
  client.active = true; client.failure = 'Codex request timed out';
  await assert.rejects(service.steer('app', 'next'), /timed out/);
  assert.equal(client.calls.filter(call => call.method === 'turn/steer').length, 1);
  client.failure = 'no active turn';
  await assert.rejects(service.steer('app', 'next'), (error: any) => error.code === 'CODEX_NO_ACTIVE_TURN');
});

test('mid-turn inputs enforce provider and upload-store boundaries', async () => {
  const client = new Client();
  await createCodexSteeringService(client, lookup).steer('app', 'inspect', [{ path: '/etc/passwd', name: 'secrets.txt' }]);
  assert.deepEqual(client.calls[1].params.input, [{ type: 'text', text: 'inspect' }]);
  await assert.rejects(createCodexSteeringService(client, () => null).steer('missing', 'x'), (error: any) => error.statusCode === 404);
  await assert.rejects(createCodexSteeringService(client, () => ({ ...lookup(), provider: 'opencode' })).steer('app', 'x'), (error: any) => error.statusCode === 400);
});

const nativeRequest = (id: number | string = 7, isBlocking = false) => ({ id, method: 'item/tool/requestUserInput', params: {
  threadId: 'native', turnId: 'turn-live', isBlocking,
  questions: [{ id: 'route', question: 'Where should it run?', header: 'Host', options: [{ label: 'Mac, laptop', description: 'Portable' }], isOther: true }],
} });

test('native questions replay after refresh and answer on the original RPC id', () => {
  const client = new Client(); const bridge = new CodexQuestions(client); const events: any[] = [];
  client.retained = [nativeRequest('native-request')];
  bridge.bind('app', 'native', { send: event => events.push(event) });
  assert.equal(bridge.listPending('app').length, 1);
  assert.equal(events[0].context.isBlocking, false);
  assert.equal(bridge.listPending('other').length, 0);
  bridge.resolve('codex:rpc:native-request', { allow: true, updatedInput: { answers: { route: 'Mac, laptop' } } });
  assert.deepEqual(client.replies, [{ id: 'native-request', result: { answers: { route: { answers: ['Mac, laptop'] } } } }]);
  assert.equal(events.at(-1).kind, 'permission_resolved');
  assert.equal(bridge.listPending('app').length, 0);
  bridge.resolve('codex:rpc:native-request', { allow: true });
  assert.equal(client.replies.length, 1);
});

test('resolution from another native client and disconnect retract pending cards', () => {
  const client = new Client(); const bridge = new CodexQuestions(client); const events: any[] = [];
  bridge.bind('app', 'native', { send: event => events.push(event) });
  client.emit('serverRequest', nativeRequest(8, true));
  client.notify('serverRequest/resolved', { requestId: 8 });
  assert.equal(bridge.listPending('app').length, 0);
  client.emit('serverRequest', nativeRequest(9));client.emit('disconnect', new Error('lost'));
  assert.equal(events.at(-1).kind, 'permission_cancelled');
});

test('async question cards keep the working turn running and clear when its native answer arrives', () => {
  const client = new Client(); const bridge = new CodexQuestions(client); const events: any[] = [];
  bridge.bind('app', 'native', { send: event => events.push(event) });
  client.notify('item/completed', { item: { id: 'call-123', type: 'agentMessage', questions: [{ title: 'Which host?', options: ['Mac', 'Linux'] }] } });
  const question = bridge.listPending('app')[0];
  assert.equal(question.context.nativeAsync, true); assert.equal(question.context.isBlocking, false);
  client.notify('item/completed', { item: { type: 'userMessage', content: [{ type: 'text', text: '<send_user_message_question_reply>' + JSON.stringify([
    { answer: 'Mac', question: 'Which host?', questionItemId: JSON.stringify(['request_user_input_async', 'call-123', 0]) },
  ]) + '</send_user_message_question_reply>' }] } });
  assert.equal(bridge.listPending('app').length, 0);
  assert.equal(client.calls.some(call => call.method === 'turn/interrupt'), false);
});

test('history recovery restores only unanswered asynchronous questions', async () => {
  const client = new Client();
  client.history = [
    { item: { id: 'unanswered', type: 'agentMessage', questions: [{ title: 'Still waiting?', options: null }] } },
    { item: { type: 'userMessage', content: [{ type: 'text', text: '<send_user_message_question_reply>[{"questionItemId":"[\\"request_user_input_async\\",\\"answered\\",0]","answer":"yes"}]</send_user_message_question_reply>' }] } },
    { item: { id: 'answered', type: 'agentMessage', questions: [{ title: 'Already answered?', options: ['yes'] }] } },
  ];
  const bridge = new CodexQuestions(client);bridge.bind('app', 'native', { send() {} });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(bridge.listPending('app').map(request => request.context.itemId), ['unanswered']);
});

test('a session subscription restores unanswered questions after the native turn has ended', async () => {
  const client = new Client();client.active = false;
  client.history = [{ item: { id: 'pending-after-completion', type: 'agentMessage', questions: [{ title: 'Keep the preview running?', options: ['Keep it'] }] } }];
  const bridge = new CodexQuestions(client);const frames: any[] = [];
  await bridge.restorePending('app', 'native', { send: frame => frames.push(frame) });
  assert.equal(bridge.listPending('app')[0].context.itemId, 'pending-after-completion');
  assert.equal(frames[0].kind, 'permission_request');
  assert.ok(client.calls.every(call => call.method === 'thread/items/list'));
  bridge.resolve('codex:async:pending-after-completion', { allow: true });
  await bridge.restorePending('app', 'native', { send: frame => frames.push(frame) });
  assert.deepEqual(bridge.listPending('app'), []);
});

test('history restoration preserves a runtime binding established during the read', async () => {
  const client = new Client();let release!: () => void;
  const reading = new Promise<void>(resolve => { release = resolve; });
  const call = client.call.bind(client);
  client.call = async (method, params) => { if (method === 'thread/items/list') await reading;return call(method, params); };
  const bridge = new CodexQuestions(client);const live: any[] = [];
  const restoring = bridge.restorePending('app', 'native', { send() {} });
  bridge.bind('app', 'native', { send: event => live.push(event) });release();await restoring;
  client.notify('item/completed', { item: { id: 'later-question', type: 'agentMessage', questions: [{ title: 'Later question' }] } });
  assert.equal(live.at(-1)?.requestId, 'codex:async:later-question');
});


test('a transient transport loss leaves an unanswered async question recoverable', async () => {
  const client = new Client();
  client.history = [{ item: { id: 'recoverable', type: 'agentMessage', questions: [{ title: 'Choose a host', options: ['Mac'] }] } }];
  const bridge = new CodexQuestions(client);const writer = { send() {} };
  bridge.bind('app', 'native', writer);await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(bridge.listPending('app').length, 1);
  client.emit('disconnect', new Error('temporary disconnect'));bridge.release('native');
  assert.equal(bridge.listPending('app').length, 0);
  bridge.bind('app', 'native', writer);await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(bridge.listPending('app')[0].context.itemId, 'recoverable');
});
