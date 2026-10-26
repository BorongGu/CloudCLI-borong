import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { handleBtwConnection } from '@/modules/websocket/services/btw-websocket.service.js';

function socket() { return Object.assign(new EventEmitter(), { readyState: 1, frames: [] as any[], send(data: string) { this.frames.push(JSON.parse(data)); } }); }
const settle = () => new Promise(resolve => setImmediate(resolve));

test('the side socket validates input, keeps one fork and closes it on disconnect', async () => {
  const ws = socket();const calls: string[] = [];let source;
  handleBtwConnection(ws as never, ((input: any, emit: any) => {
    source = input;return { async start() { calls.push('start'); }, async send(content: string) { calls.push(content); },
      async stop() { calls.push('stop'); }, async close() { calls.push('close');emit({ kind: 'btw_closed' }); } };
  }) as never);
  ws.emit('message', JSON.stringify({ type: 'start', sessionId: 'parent', question: 'A question', model: 'gpt-6.1-sol' }));await settle();
  assert.equal((source as any).sessionId, 'parent');
  ws.emit('message', JSON.stringify({ type: 'start', sessionId: 'another-parent' }));await settle();
  assert.equal(calls.filter(c => c === 'start').length, 1);
  assert.equal(ws.frames.at(-1).kind, 'btw_error');
  ws.emit('message', JSON.stringify({ type: 'send', content: 'follow up' }));await settle();
  ws.emit('message', JSON.stringify({ type: 'stop' }));await settle();
  ws.emit('close');await settle();
  assert.deepEqual(calls, ['start', 'follow up', 'stop', 'close']);
});

test('invalid or excessive side questions are rejected before launching a process', async () => {
  const ws = socket();let launches = 0;handleBtwConnection(ws as never, (() => { launches++;throw new Error('unexpected'); }) as never);
  for (const data of [{ type: 'start', sessionId: '' }, { type: 'start', sessionId: 'parent', question: 42 },
    { type: 'start', sessionId: 'parent', question: 'x'.repeat(32001) }]) ws.emit('message', JSON.stringify(data));
  await settle();assert.equal(launches, 0);assert.equal(ws.frames.length, 3);
});
