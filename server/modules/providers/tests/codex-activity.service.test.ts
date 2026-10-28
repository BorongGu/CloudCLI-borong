import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createCodexActivityService } from '@/modules/providers/services/codex-activity.service.js';

class Client extends EventEmitter {
  calls: Array<{ method: string; params: any }> = [];
  active = true;
  offline = false;
  async call(method: string, params: any): Promise<any> {
    this.calls.push({ method, params });
    if (this.offline) throw new Error('Native service offline');
    if (method === 'thread/loaded/list') return params.cursor
      ? { data: ['ephemeral', 'disappeared', 'running'], nextCursor: null }
      : { data: ['running', 'idle'], nextCursor: 'next' };
    if (method === 'thread/read') {
      if (params.threadId === 'disappeared') throw new Error('Thread was unloaded');
      return { thread: { id: params.threadId, status: { type: this.active && params.threadId !== 'idle' ? 'active' : 'idle' }, ephemeral: params.threadId === 'ephemeral' } };
    }
    if (method === 'thread/turns/list') return { data: [{ id: 'turn', startedAt: 1_793_180_000 }] };
    throw new Error(`Unexpected mutation: ${method}`);
  }
}

test('native activity paginates loaded threads and reports only persistent active turns', async () => {
  const client = new Client();const service = createCodexActivityService(client);
  assert.deepEqual(await service.listRunningSessions(), [{ providerSessionId: 'running', startedAt: 1_793_180_000_000 }]);
  assert.equal(client.calls.filter(call => call.method === 'thread/read' && call.params.threadId === 'running').length, 1);
  assert.equal(client.calls.filter(call => call.method === 'thread/turns/list').length, 1);
  assert.ok(client.calls.filter(call => call.method === 'thread/read').every(call => call.params.includeTurns === false));
});

test('concurrent readers share a status read and a completed turn disappears on the next read', async () => {
  const client = new Client();const service = createCodexActivityService(client);
  const reads = await Promise.all([service.listRunningSessions(), service.listRunningSessions()]);
  assert.deepEqual(reads[0], reads[1]);assert.equal(client.calls.filter(call => call.method === 'thread/loaded/list').length, 2);
  client.active = false;assert.deepEqual(await service.listRunningSessions(), []);
});

test('an offline native daemon recovers on the next status read', async () => {
  const client = new Client();const service = createCodexActivityService(client);
  client.offline = true;assert.deepEqual(await service.listRunningSessions(), []);
  client.offline = false;assert.equal((await service.listRunningSessions()).length, 1);
});
