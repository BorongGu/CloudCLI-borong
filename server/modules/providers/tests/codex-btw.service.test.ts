import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createCodexBtwSession } from '@/modules/providers/services/codex-btw.service.js';
import type { BtwEvent } from '@/shared/types.js';

class FakeConnection extends EventEmitter {
  calls: Array<{ method: string; params: any }> = [];
  closed = false;
  ephemeral = true;
  forkGate: Promise<void> | null = null;
  startGate: Promise<void> | null = null;
  turns: any[] = [{ id: 'completed-turn', status: 'completed' }];
  items: any[] = [];
  async initialize() {}
  async call(method: string, params: any) {
    this.calls.push({ method, params });
    if (method === 'thread/turns/list') return { data: this.turns };
    if (method === 'thread/items/list') return { data: this.items };
    if (method === 'thread/fork' || method === 'thread/start') {
      await this.forkGate;
      return { thread: { id: 'temporary-fork', ephemeral: this.ephemeral, path: this.ephemeral ? null : '/tmp/new-fork.jsonl' }, model: 'gpt-6.1-sol' };
    }
    if (method === 'turn/start') {
      await this.startGate;
      this.emit('notification', { method: 'turn/started', params: { threadId: params.threadId, turn: { id: 'side-turn' } } });
      return { turn: { id: 'side-turn' } };
    }
    return {};
  }
  async close() { this.closed = true; }
}
function setup(question = '') {
  const client = new FakeConnection();const events: BtwEvent[] = [];
  const conversation = createCodexBtwSession({ sessionId: 'parent-app', question, model: 'gpt-6.1-sol', effort: 'low' }, event => events.push(event), {
    lookup: () => ({ provider: 'codex', provider_session_id: 'parent-native', project_path: '/workspace' }) as never,
    connect: () => client,
    readContextConfig: async () => ({ model_context_window: 500000, model_auto_compact_token_limit: 450000 }),
  });
  return { client, events, conversation };
}

test('BTW forks the parent ephemerally and runs questions only on that fork', async () => {
  const { client, conversation, events } = setup('Which file did we change?');
  await conversation.start();
  const fork = client.calls.find(call => call.method === 'thread/fork')!;
  assert.equal(fork.params.lastTurnId, 'completed-turn');
  assert.equal(fork.params.config.model_context_window, 500000);
  assert.equal(fork.params.threadId, 'parent-native');assert.equal(fork.params.ephemeral, true);
  assert.equal(fork.params.excludeTurns, true);assert.equal(fork.params.cwd, '/workspace');
  assert.equal(client.calls.find(call => call.method === 'turn/start')!.params.threadId, 'temporary-fork');
  assert.ok(client.calls.every(c => c.method !== 'thread/goal/set' && c.method !== 'thread/resume'));
  assert.ok(events.some(e => e.kind === 'btw_message' && e.role === 'user'));
  await conversation.close();assert.equal(client.closed, true);
});

test('stream snapshots reuse native item ids; a follow-up uses the same temporary context', async () => {
  const { client, conversation, events } = setup('Question');await conversation.start();
  const emit = (method: string, params: any) => client.emit('notification', { method, params: { threadId: 'temporary-fork', ...params } });
  emit('item/agentMessage/delta', { itemId: 'answer', delta: 'Hello' });
  emit('item/agentMessage/delta', { itemId: 'answer', delta: ' world' });
  emit('item/completed', { item: { type: 'agentMessage', id: 'answer', text: 'Hello world' } });
  const replies = events.filter(e => e.kind === 'btw_message' && e.role === 'assistant');
  assert.deepEqual(replies.map(e => e.kind === 'btw_message' && [e.id, e.content]), [['answer', 'Hello'], ['answer', 'Hello world'], ['answer', 'Hello world']]);
  emit('turn/completed', { turn: { id: 'side-turn', status: 'completed' } });
  await conversation.send('Follow up');
  assert.equal(client.calls.filter(c => c.method === 'turn/start').length, 2);
  await conversation.stop();assert.deepEqual(client.calls.at(-1), { method: 'turn/interrupt', params: { threadId: 'temporary-fork', turnId: 'side-turn' } });
  await conversation.close();
});

test('closing during fork creation reaps the owned server and suppresses late ready events', async () => {
  const { client, conversation, events } = setup();let release!: () => void;
  client.forkGate = new Promise(resolve => { release = resolve; });
  const starting = conversation.start();await new Promise(resolve => setImmediate(resolve));
  await conversation.close();assert.equal(client.closed, true);
  release();await starting;
  assert.equal(events.filter(e => e.kind === 'btw_closed').length, 1);
  assert.ok(events.every(e => e.kind !== 'btw_ready'));
  await assert.rejects(conversation.send('late'), /ended/);
});

test('a CLI that creates a persistent fork has that new thread removed before closing', async () => {
  const { client, conversation, events } = setup();client.ephemeral = false;
  await conversation.start();
  assert.deepEqual(client.calls.at(-1), { method: 'thread/delete', params: { threadId: 'temporary-fork' } });
  assert.equal(client.closed, true);assert.ok(events.some(e => e.kind === 'btw_error'));
});

test('provider failures and disconnects close the temporary runtime', async () => {
  const { client, conversation, events } = setup();await conversation.start();
  client.emit('disconnect', new Error('connection lost'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.closed, true);assert.equal(client.listenerCount('notification'), 0);
  assert.ok(events.some(e => e.kind === 'btw_error' && e.message === 'connection lost'));
});

test('Stop waits for a just-submitted turn id before interrupting', async () => {
  const { client, conversation } = setup();await conversation.start();
  let release!: () => void;client.startGate = new Promise(resolve => { release = resolve; });
  const sending = conversation.send('Question');
  const stopping = conversation.stop();
  assert.equal(client.calls.filter(c => c.method === 'turn/interrupt').length, 0);
  release();await sending;await stopping;
  assert.deepEqual(client.calls.at(-1), { method: 'turn/interrupt', params: { threadId: 'temporary-fork', turnId: 'side-turn' } });
  await conversation.close();
});

test('an unfinished main turn becomes read-only context after a completed fork boundary', async () => {
  const { client, conversation } = setup('Side question');
  client.turns = [{ id: 'active-turn', status: 'interrupted' }, { id: 'completed-turn', status: 'completed' }];
  client.items = [
    { type: 'userMessage', content: [{ type: 'text', text: 'Current main task' }, { type: 'localImage', path: '/image.png' }] },
    { type: 'dynamicToolCall', id: 'pending-tool', status: 'inProgress', tool: 'shell' },
    { type: 'agentMessage', text: 'Current findings' },
  ];
  await conversation.start();
  const fork = client.calls.find(call => call.method === 'thread/fork')!;
  assert.equal(fork.params.lastTurnId, 'completed-turn');
  const first = client.calls.find(call => call.method === 'turn/start')!.params.input;
  assert.ok(first[0].text.includes('Current main task'));
  assert.ok(first[0].text.includes('pending-tool'));
  assert.ok(first[0].text.includes('Current findings'));
  assert.deepEqual(first[1], { type: 'localImage', path: '/image.png' });
  assert.ok(first.at(-1).text.endsWith('Side question'));
  client.emit('notification', { method: 'turn/completed', params: { threadId: 'temporary-fork', turn: { id: 'side-turn', status: 'completed' } } });
  await conversation.send('Follow up');
  assert.equal(client.calls.filter(call => call.method === 'turn/start').at(-1)!.params.input.length, 1);
  await conversation.close();
});

test('a first in-progress turn starts a clean ephemeral context with the full user snapshot', async () => {
  const { client, conversation } = setup('Side question');
  client.turns = [{ id: 'first-active-turn', status: 'interrupted' }];
  client.items = [{ type: 'userMessage', content: [{ type: 'text', text: 'First task' }] }];
  await conversation.start();
  assert.equal(client.calls.some(call => call.method === 'thread/fork'), false);
  assert.equal(client.calls.find(call => call.method === 'thread/start')!.params.ephemeral, true);
  assert.ok(client.calls.find(call => call.method === 'turn/start')!.params.input[0].text.includes('First task'));
  await conversation.close();
});
