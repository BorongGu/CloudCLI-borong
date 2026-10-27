import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createBtwRegistry } from '@/modules/websocket/services/btw-registry.service.js';
import { handleBtwConnection } from '@/modules/websocket/services/btw-websocket.service.js';
import type { BtwEvent, BtwInput } from '@/shared/types.js';

function socket(registry: ReturnType<typeof createBtwRegistry>, userId = 'user') {
  const ws = Object.assign(new EventEmitter(), { readyState: 1, frames: [] as any[],
    send(data: string) { this.frames.push(JSON.parse(data)); } });
  handleBtwConnection(ws as never, { user: { id: userId } } as never, registry);
  return ws;
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const send = (ws: ReturnType<typeof socket>, data: unknown) => ws.emit('message', JSON.stringify(data));
const disconnect = (ws: ReturnType<typeof socket>) => { ws.readyState = 3;ws.emit('close'); };
function fixture(retentionMs?: number) {
  const calls: string[] = [];const inputs: BtwInput[] = [];let emit: (event: BtwEvent) => void = () => {};
  const registry = createBtwRegistry((input, publish) => {
    inputs.push(input);emit = publish;
    return { async start() { calls.push('start');publish({ kind: 'btw_ready', threadId: 'native-fork', model: input.model || '' }); },
      async send(content) { calls.push(content); }, async stop() { calls.push('stop'); },
      async close() { calls.push('close');publish({ kind: 'btw_closed' }); } };
  }, retentionMs);
  return { registry, calls, inputs, emit: (event: BtwEvent) => emit(event) };
}

test('the side socket validates input, keeps one fork and explicitly finishes it', async () => {
  const f = fixture();const ws = socket(f.registry);
  send(ws, { type: 'start', conversationId: 'window', sessionId: 'parent', question: 'A question', model: 'gpt-6.1-sol' });await settle();
  assert.equal(f.inputs[0].sessionId, 'parent');
  send(ws, { type: 'start', sessionId: 'another-parent' });await settle();
  assert.equal(f.calls.filter(c => c === 'start').length, 1);assert.equal(ws.frames.at(-1).kind, 'btw_error');
  send(ws, { type: 'send', content: 'follow up' });await settle();
  send(ws, { type: 'stop' });await settle();
  send(ws, { type: 'finish' });await settle();disconnect(ws);await settle();
  assert.deepEqual(f.calls, ['start', 'follow up', 'stop', 'close']);
  assert.equal(ws.frames.filter(event => event.kind === 'btw_closed').length, 1);
});

test('refresh resumes one fork, replays the latest item and catches up with background output', async () => {
  const f = fixture();const first = socket(f.registry);
  send(first, { type: 'start', conversationId: 'window', sessionId: 'parent', question: 'Ask once' });await settle();
  f.emit({ kind: 'btw_message', id: 'q', role: 'user', content: 'Ask once' });
  f.emit({ kind: 'btw_message', id: 'a', role: 'assistant', content: 'Partial' });
  disconnect(first);assert.deepEqual(f.calls, ['start']);
  f.emit({ kind: 'btw_message', id: 'a', role: 'assistant', content: 'Completed while refreshing' });
  f.emit({ kind: 'btw_status', busy: false });
  const next = socket(f.registry);send(next, { type: 'resume', conversationId: 'window' });await settle();
  assert.equal(next.frames.find(event => event.kind === 'btw_ready').threadId, 'native-fork');
  assert.deepEqual(next.frames.filter(event => event.kind === 'btw_message').map(event => event.content), ['Ask once', 'Completed while refreshing']);
  assert.equal(next.frames.at(-1).busy, false);assert.equal(f.inputs.length, 1);
  send(next, { type: 'send', content: 'Keep the same context' });await settle();
  assert.deepEqual(f.calls, ['start', 'Keep the same context']);
  send(next, { type: 'finish' });await settle();
});

test('an idempotent start racing a refresh attaches while native startup is pending', async () => {
  let launches = 0;let finishStart: () => void = () => {};
  const registry = createBtwRegistry((_input, emit) => {
    launches++;
    return { start: () => new Promise<void>(resolve => { finishStart = () => { emit({ kind: 'btw_ready', threadId: 'slow-fork', model: '' });resolve(); }; }),
      async send() {}, async stop() {}, async close() { emit({ kind: 'btw_closed' }); } };
  });
  const first = socket(registry);const input = { type: 'start', conversationId: 'window', sessionId: 'parent' };
  send(first, input);await settle();disconnect(first);
  const next = socket(registry);send(next, input);await settle();assert.equal(launches, 1);
  finishStart();await settle();assert.equal(next.frames.at(-1).threadId, 'slow-fork');
  send(next, { type: 'finish' });await settle();
});

test('retention is cancelled on reattach and expires only after the last viewer disconnects', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(1000);const first = socket(f.registry);
  send(first, { type: 'start', conversationId: 'window', sessionId: 'parent' });await settle();disconnect(first);
  t.mock.timers.tick(900);const next = socket(f.registry);send(next, { type: 'resume', conversationId: 'window' });await settle();
  t.mock.timers.tick(1000);assert.deepEqual(f.calls, ['start']);
  const third = socket(f.registry);send(third, { type: 'resume', conversationId: 'window' });await settle();disconnect(next);
  t.mock.timers.tick(1000);assert.deepEqual(f.calls, ['start']);disconnect(third);
  t.mock.timers.tick(1000);await settle();assert.deepEqual(f.calls, ['start', 'close']);
  const expired = socket(f.registry);send(expired, { type: 'resume', conversationId: 'window' });await settle();
  assert.equal(expired.frames.at(-1).kind, 'btw_closed');assert.match(expired.frames.at(-2).message, /expired/);
  assert.equal(f.inputs.length, 1);
});

test('a reconnect stays scoped to its authenticated user', async () => {
  const f = fixture();const first = socket(f.registry, 'owner');
  send(first, { type: 'start', conversationId: 'window', sessionId: 'parent' });await settle();
  const other = socket(f.registry, 'other');send(other, { type: 'resume', conversationId: 'window' });await settle();
  assert.equal(other.frames.some(event => event.kind === 'btw_ready'), false);
  assert.equal(other.frames.at(-1).kind, 'btw_closed');assert.deepEqual(f.calls, ['start']);
  send(first, { type: 'finish' });await settle();
});

test('invalid or excessive side questions are rejected before launching a process', async () => {
  const f = fixture();const ws = socket(f.registry);
  for (const data of [{ type: 'start', sessionId: '' }, { type: 'start', sessionId: 'parent', question: 42 },
    { type: 'start', sessionId: 'parent', question: 'x'.repeat(32001) },
    { type: 'start', sessionId: 'parent', conversationId: {} }, { type: 'resume', conversationId: '' }]) send(ws, data);
  await settle();assert.equal(f.inputs.length, 0);assert.equal(ws.frames.length, 5);
});
