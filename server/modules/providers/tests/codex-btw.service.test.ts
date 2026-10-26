import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createCodexBtwSession } from '@/modules/providers/services/codex-btw.service.js';
import type { CodexBtwEvent } from '@/shared/types.js';

class FakeConnection extends EventEmitter {
  calls: Array<{ method: string; params: any }> = [];
  closed = false;
  ephemeral = true;
  forkGate: Promise<void> | null = null;
  startGate: Promise<void> | null = null;
  async initialize() {}
  async call(method: string, params: any) {
    this.calls.push({ method, params });
    if (method === 'thread/fork') {
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
  const client = new FakeConnection();const events: CodexBtwEvent[] = [];
  const conversation = createCodexBtwSession({ sessionId: 'parent-app', question, model: 'gpt-6.1-sol', effort: 'low' }, event => events.push(event), {
    lookup: () => ({ provider: 'codex', provider_session_id: 'parent-native', project_path: '/workspace' }) as never,
    connect: () => client,
  });
  return { client, events, conversation };
}

test('BTW forks the parent ephemerally and runs questions only on that fork', async () => {
  const { client, conversation, events } = setup('Which file did we change?');
  await conversation.start();
  const fork = client.calls[0];assert.equal(fork.method, 'thread/fork');
  assert.equal(fork.params.threadId, 'parent-native');assert.equal(fork.params.ephemeral, true);
  assert.equal(fork.params.excludeTurns, true);assert.equal(fork.params.cwd, '/workspace');
  assert.equal(client.calls[1].params.threadId, 'temporary-fork');
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
