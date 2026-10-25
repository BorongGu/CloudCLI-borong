import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { SharedCodex } from '../list/codex/codex-shared-sdk.js';
import { SharedCodexConnection } from '../list/codex/codex-shared-connection.js';
import { executeCodexGoal, parseCodexGoalCommand } from '../list/codex/codex-goals.provider.js';

class FakeConnection extends EventEmitter {
  calls: Array<{ method: string; params: any }> = [];
  active = false;
  failSteer = false;
  autoComplete = true;
  disconnectTurn = false;
  async call(method: string, params: any): Promise<any> {
    this.calls.push({ method, params });
    if (method === 'thread/start' || method === 'thread/resume') return {
      thread: { id: 'native', status: { type: this.active ? 'active' : 'idle' } },
    };
    if (method === 'thread/turns/list') return { data: [{ id: 'existing-turn', status: 'inProgress' }] };
    if (method === 'turn/steer' && this.failSteer) throw new Error('no active turn');
    if (method === 'turn/start' || method === 'turn/steer') {
      const turnId = method === 'turn/steer' ? 'existing-turn' : 'new-turn';
      setTimeout(() => {
        if (this.disconnectTurn) { this.emit('disconnect', new Error('transport lost')); return; }
        this.notify('item/started', { turnId, item: { id: 'answer', type: 'agentMessage', text: '' } });
        this.notify('item/agentMessage/delta', { turnId, itemId: 'answer', delta: 'first ' });
        this.notify('item/agentMessage/delta', { turnId, itemId: 'answer', delta: 'second' });
        this.notify('item/completed', { turnId, item: { id: 'answer', type: 'agentMessage', text: 'first second' } });
        // Unrelated threads must never end this request or leak their output.
        this.emit('notification', { method: 'turn/completed', params: { threadId: 'other', turn: { id: turnId, status: 'completed' } } });
        if (this.autoComplete) this.notify('turn/completed', { turn: { id: turnId, status: 'completed' } });
      }, 1);
      return { turn: { id: turnId }, turnId };
    }
    if (method === 'turn/interrupt') {
      this.notify('turn/completed', { turn: { id: params.turnId, status: 'interrupted' } });
      return {};
    }
    throw new Error(method);
  }
  notify(method: string, params: any) {
    this.emit('notification', { method, params: { threadId: 'native', ...params } });
  }
}

class GoalConnection extends FakeConnection {
  goal: any = null;
  rounds = 2;
  async call(method: string, params: any): Promise<any> {
    if (method.startsWith('thread/goal/')) {
      this.calls.push({ method, params });
      if (method === 'thread/goal/get') return { goal: this.goal };
      if (method === 'thread/goal/clear') { this.goal = null; this.notify('thread/goal/cleared', {}); return {}; }
      this.goal = { objective: params.objective || this.goal?.objective, status: params.status, tokensUsed: 0, timeUsedSeconds: 0 };
      this.notify('thread/goal/updated', { goal: this.goal });
      if (params.status === 'active') setTimeout(() => this.round(1), 5);
      return { goal: this.goal };
    }
    return super.call(method, params);
  }
  round(index: number) {
    const turnId = 'goal-turn-' + index;
    this.notify('turn/started', { turn: { id: turnId } });
    this.notify('item/completed', { turnId, item: { id: 'goal-answer-' + index, type: 'agentMessage', text: 'round ' + index } });
    if (index === this.rounds) {
      this.goal = { ...this.goal, status: 'complete' };
      this.notify('thread/goal/updated', { goal: this.goal });
    }
    this.notify('turn/completed', { turn: { id: turnId, status: 'completed' } });
    if (index < this.rounds) setTimeout(() => this.round(index + 1), 15);
  }
}

test('native goal commands preserve multi-line objectives and recognize lifecycle controls', () => {
  assert.deepEqual(parseCodexGoalCommand('/goal'), { action: 'get' });
  for (const action of ['pause', 'resume', 'clear']) assert.deepEqual(parseCodexGoalCommand('/goal ' + action), { action });
  assert.deepEqual(parseCodexGoalCommand('/goal first\nsecond'), { action: 'set', objective: 'first\nsecond' });
  assert.equal(parseCodexGoalCommand('/goals text'), null);
  assert.throws(() => parseCodexGoalCommand('/goal ' + 'x'.repeat(4001)));
});

test('native goals stream successive automatic turns until goal completion', async () => {
  const client = new GoalConnection();
  const thread = new SharedCodex(client).resumeThread('native');
  const { events } = await thread.runStreamed('/goal objective', { goalCommand: { action: 'set', objective: 'objective' } });
  const seen = [];
  for await (const event of events) seen.push(event);
  assert.equal(seen.filter(e => e.type === 'turn.completed').length, 2);
  assert.deepEqual(seen.filter(e => e.type === 'item.completed').map(e => e.item.text), ['round 1', 'round 2']);
  assert.ok(seen.some(e => e.type === 'goal.updated' && e.goal.status === 'complete'));
  assert.equal(client.calls.some(c => c.method === 'turn/start' || c.method === 'turn/steer'), false);
  assert.equal(client.listenerCount('notification'), 0);
});

test('pausing a goal between turns releases the observer without starting another turn', async () => {
  const client = new GoalConnection();client.rounds = 0;
  // Only the first round is emitted; the goal remains active until paused.
  client.round = function(index) {
    this.notify('turn/started', { turn: { id: 'paused-turn' } });
    this.notify('turn/completed', { turn: { id: 'paused-turn', status: 'completed' } });
  };
  const thread = new SharedCodex(client).resumeThread('native');
  const { events } = await thread.runStreamed('', { goalCommand: { action: 'set', objective: 'objective' } });
  for await (const event of events) {
    if (event.type === 'turn.completed') await executeCodexGoal(client, 'native', { action: 'pause' });
  }
  assert.equal(client.goal.status, 'paused');assert.equal(client.listenerCount('notification'), 0);
});

test('goal resume uses native state and starts no duplicate user turn', async () => {
  const client = new GoalConnection();client.goal = { objective: 'original objective', status: 'paused' };client.rounds = 1;
  const { events } = await new SharedCodex(client).resumeThread('native').runStreamed('', { goalCommand: { action: 'resume' } });
  for await (const _event of events) { /* Drain the native continuation. */ }
  const resume = client.calls.find(c => c.method === 'thread/goal/set')!;
  assert.equal(resume.params.objective, undefined);assert.equal(client.goal.objective, 'original objective');
  assert.equal(client.calls.some(c => c.method === 'turn/start'), false);
});

async function collect(client: FakeConnection, resumed = true, input: any = 'hello') {
  const sdk = new SharedCodex(client);
  const options = { model: 'gpt-6.1-sol', workingDirectory: '/workspace', sandboxMode: 'danger-full-access', approvalPolicy: 'never' } as const;
  const thread = resumed ? sdk.resumeThread('native', options) : sdk.startThread(options);
  const result = await thread.runStreamed(input);
  const events = [];
  for await (const event of result.events) events.push(event);
  return events;
}

test('resumes a daemon-owned thread and streams stable message ids', async () => {
  const client = new FakeConnection();
  const events = await collect(client);
  assert.equal(client.calls[0].method, 'thread/resume');
  assert.equal(client.calls[0].params.excludeTurns, true);
  const turn = client.calls.find(call => call.method === 'turn/start')!;
  assert.deepEqual(turn.params.sandboxPolicy, { type: 'dangerFullAccess' });
  assert.equal(turn.params.approvalPolicy, 'never');
  assert.equal(turn.params.model, 'gpt-6.1-sol');
  assert.deepEqual(events.filter(e => e.type === 'item.updated').map(e => [e.item.id, e.item.text]), [['answer', 'first '], ['answer', 'first second']]);
  assert.equal(events.filter(e => e.type === 'turn.completed').length, 1);
  assert.equal(client.listenerCount('notification'), 0);
});

test('steers the existing active turn through the same app-server', async () => {
  const client = new FakeConnection(); client.active = true;
  await collect(client);
  const steer = client.calls.find(call => call.method === 'turn/steer')!;
  assert.equal(steer.params.expectedTurnId, 'existing-turn');
  assert.deepEqual(steer.params.input, [{ type: 'text', text: 'hello' }]);
  assert.equal(client.calls.some(call => call.method === 'turn/start'), false);
});

test('starts a new turn when the previously active turn has finished', async () => {
  const client = new FakeConnection(); client.active = true; client.failSteer = true;
  await collect(client);
  assert.ok(client.calls.some(call => call.method === 'turn/start'));
});

test('creates native threads and translates image attachments', async () => {
  const client = new FakeConnection();
  await collect(client, false, [{ type: 'text', text: 'image' }, { type: 'local_image', path: '/tmp/photo.png' }]);
  assert.equal(client.calls[0].method, 'thread/start');
  assert.deepEqual(client.calls.find(call => call.method === 'turn/start')!.params.input[1], { type: 'localImage', path: '/tmp/photo.png' });
});

test('interrupts through RPC and removes per-turn listeners', async () => {
  const client = new FakeConnection(); client.autoComplete = false;
  const controller = new AbortController();
  const thread = new SharedCodex(client).resumeThread('native');
  const { events } = await thread.runStreamed('hello', { signal: controller.signal });
  for await (const event of events) {
    if (event.type === 'item.updated') controller.abort();
  }
  assert.ok(client.calls.some(call => call.method === 'turn/interrupt' && call.params.turnId === 'new-turn'));
  assert.equal(client.listenerCount('notification'), 0);
});

test('surfaces daemon disconnects instead of hanging a browser run', async () => {
  const client = new FakeConnection(); client.disconnectTurn = true;
  const events = await collect(client);
  assert.equal(events.at(-1)!.type, 'turn.failed');
  assert.equal(events.at(-1)!.error.message, 'transport lost');
});

test('Unix transport initializes once and reconnects after a daemon socket closes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-codex-'));
  const socketPath = path.join(root, 'daemon.sock');
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  let initializeCount = 0;
  wss.on('connection', socket => socket.on('message', raw => {
    const message = JSON.parse(String(raw));
    if (message.method === 'initialize') initializeCount++;
    if (message.id !== undefined) socket.send(JSON.stringify({ id: message.id, result: { ok: true } }));
  }));
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  const connection = new SharedCodexConnection(socketPath);
  try {
    await Promise.all([connection.call('thread/read', {}), connection.call('model/list', {})]);
    assert.equal(initializeCount, 1);
    const closed = new Promise<void>(resolve => connection.once('disconnect', resolve));
    for (const socket of wss.clients) socket.close();
    await closed;
    await connection.call('thread/read', {});
    assert.equal(initializeCount, 2);
  } finally {
    connection.close();
    for (const socket of wss.clients) socket.terminate();
    wss.close(); server.close(); await fs.rm(root, { recursive: true, force: true });
  }
});
