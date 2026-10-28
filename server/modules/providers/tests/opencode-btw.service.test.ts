import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createBtwSession } from '@/modules/providers/services/btw.service.js';
import { createOpenCodeBtwSession } from '@/modules/providers/services/opencode-btw.service.js';
import type { BtwEvent } from '@/shared/types.js';

class FakeConnection extends EventEmitter {
  calls: Array<{ method: string; path: string; body: any }> = [];
  closed = false;
  preparing: Promise<void> | null = null;
  submitting: Promise<void> | null = null;
  readingHistory: Promise<void> | null = null;
  inheritedMessages: Array<{ info: { id: string; role: string } }> = [];
  async initialize() { await this.preparing;return { id: 'private-fork' }; }
  async request(method: string, path: string, body?: any) {
    this.calls.push({ method, path, body });
    if (method === 'GET' && path.endsWith('/message')) { await this.readingHistory;return this.inheritedMessages; }
    if (path.endsWith('/prompt_async')) await this.submitting;
  }
  async close() { this.closed = true; }
  frame(type: string, properties: any) { this.emit('notification', { type, properties: { sessionID: 'private-fork', ...properties } }); }
}

function setup(question = '') {
  const client = new FakeConnection();const events: BtwEvent[] = [];
  const session = createOpenCodeBtwSession({ sessionId: 'source', question, model: 'opencode-go/glm-5.3-flash', effort: 'high', permissionMode: 'bypassPermissions' }, event => events.push(event), {
    lookup: () => ({ provider: 'opencode', provider_session_id: 'native-source', project_path: '/workspace' }) as never,
    connect: (id, cwd) => { assert.equal(id, 'native-source');assert.equal(cwd, '/workspace');return client; },
  });
  return { client, events, session };
}

test('OpenCode streams stable part ids, preserves the selected Go model and allows follow-ups', async () => {
  const { client, events, session } = setup('Side question');await session.start();
  const prompt = client.calls.find(call => call.path.endsWith('/prompt_async'))!;
  assert.deepEqual(prompt.body.model, { providerID: 'opencode-go', modelID: 'glm-5.3-flash' });
  assert.equal(prompt.body.variant, 'high');
  assert.ok(prompt.path.includes('private-fork'));
  // An old initial idle frame must not enable another send before the new run starts.
  client.frame('session.idle', {});await assert.rejects(session.send('Too early'), /Wait/);
  client.frame('message.updated', { info: { id: 'answer', role: 'assistant' } });
  client.frame('message.part.updated', { part: { id: 'part', messageID: 'answer', type: 'text', text: '' } });
  client.frame('message.part.delta', { messageID: 'answer', partID: 'part', field: 'text', delta: 'Hello' });
  client.frame('message.part.updated', { part: { id: 'part', messageID: 'answer', type: 'text', text: 'Hello world' } });
  const replies = events.filter(event => event.kind === 'btw_message' && event.role === 'assistant');
  assert.ok(replies.every(event => event.kind === 'btw_message' && event.id === 'answer_part'));
  const last = replies.at(-1);assert.equal(last?.kind === 'btw_message' && last.content, 'Hello world');
  client.frame('session.idle', {});await session.send('Follow up');
  assert.equal(client.calls.filter(call => call.path.endsWith('/prompt_async')).length, 2);
  await session.close();assert.equal(client.closed, true);assert.equal(client.listenerCount('notification'), 0);
});

test('OpenCode Stop waits for submission and aborts the private fork', async () => {
  const { client, session } = setup();await session.start();
  let release!: () => void;client.submitting = new Promise(resolve => { release = resolve; });
  const sending = session.send('Question');const stopping = session.stop();
  assert.equal(client.calls.filter(call => call.path.endsWith('/prompt_async')).length, 1);release();await sending;await stopping;
  assert.equal(client.calls.at(-1)?.path, '/session/private-fork/abort');
  await session.close();
});

test('closing during OpenCode preparation suppresses late ready events and closes once', async () => {
  const { client, session, events } = setup();let release!: () => void;
  client.preparing = new Promise(resolve => { release = resolve; });
  const starting = session.start();await session.close();release();await starting;await session.close();
  assert.equal(events.filter(event => event.kind === 'btw_closed').length, 1);
  assert.equal(events.some(event => event.kind === 'btw_ready'), false);
  await assert.rejects(session.send('Late question'), /ended/);
});

test('OpenCode errors clear busy state and disconnects release the private runtime', async () => {
  const { client, session, events } = setup('Question');await session.start();
  client.frame('session.error', { error: { name: 'APIError', data: { message: 'Go provider unavailable' } } });
  assert.ok(events.some(event => event.kind === 'btw_error' && event.message === 'Go provider unavailable'));
  assert.ok(events.some(event => event.kind === 'btw_status' && !event.busy));
  client.emit('disconnect', new Error('Lost event stream'));await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.closed, true);
});

test('late fork-copy events keep inherited history as context without replaying it in BTW', async () => {
  const { client, events, session } = setup('Current side question');
  client.inheritedMessages = [{ info: { id: 'old-user', role: 'user' } }, { info: { id: 'old-answer', role: 'assistant' } }];
  await session.start();
  const beforeReplay = events.length;
  const replay = () => {
    client.frame('message.updated', { info: { id: 'old-answer', role: 'assistant' } });
    client.frame('message.part.updated', { part: { id: 'old-text', messageID: 'old-answer', type: 'text', text: 'Historical answer' } });
    client.frame('message.part.delta', { messageID: 'old-answer', partID: 'old-text', field: 'text', delta: ' replayed' });
    client.frame('message.part.updated', { part: { id: 'old-tool', messageID: 'old-answer', type: 'tool', state: { status: 'running', title: 'Historical tool' } } });
    client.frame('message.part.updated', { part: { id: 'old-reasoning', messageID: 'old-answer', type: 'reasoning', text: 'Historical reasoning' } });
  };
  replay();assert.equal(events.length, beforeReplay);
  client.frame('session.idle', {});await assert.rejects(session.send('Too early'), /Wait/);
  client.frame('message.updated', { info: { id: 'new-answer', role: 'assistant' } });
  client.frame('message.part.updated', { part: { id: 'new-text', messageID: 'new-answer', type: 'text', text: 'Only the side answer' } });
  client.frame('session.idle', {});await session.send('Follow up');
  replay();client.frame('session.idle', {});await assert.rejects(session.send('Still too early'), /Wait/);
  const replies = events.filter(event => event.kind === 'btw_message' && event.role === 'assistant');
  assert.deepEqual(replies, [{ kind: 'btw_message', id: 'new-answer_new-text', role: 'assistant', content: 'Only the side answer' }]);
  assert.deepEqual(client.inheritedMessages.map(message => message.info.id), ['old-user', 'old-answer']);
  assert.equal(client.calls.some(call => call.method === 'DELETE'), false);
  await session.close();
});

test('closing during the inherited history read suppresses late prompts and ready events', async () => {
  const { client, session, events } = setup('Never submitted');let release!: () => void;
  client.readingHistory = new Promise(resolve => { release = resolve; });
  const starting = session.start();await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.calls.at(-1)?.path, '/session/private-fork/message');
  await session.close();release();await starting;
  assert.equal(events.some(event => event.kind === 'btw_ready'), false);
  assert.equal(client.calls.some(call => call.path.endsWith('/prompt_async')), false);
  assert.equal(client.closed, true);
});

test('BTW dispatch uses the saved source provider for Codex and OpenCode', () => {
  for (const provider of ['codex', 'opencode']) {
    const called: string[] = [];const adapter = (name: string) => (() => { called.push(name);return {} as never; });
    createBtwSession({ sessionId: 'source' }, () => {}, {
      lookup: () => ({ provider }) as never, codex: adapter('codex'), opencode: adapter('opencode'),
    });
    assert.deepEqual(called, [provider]);
  }
});
