import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';

import { createCodexGoalsService } from '@/modules/providers/services/codex-goals.service.js';

test('goal service resolves the native id and preserves usage on pause/resume', async () => {
  const calls: any[] = [];
  const client = Object.assign(new EventEmitter(), { async call(method: string, params: any) {
    calls.push({ method, params }); return { goal: { status: params.status || 'active', tokensUsed: 123 } };
  } });
  const service = createCodexGoalsService(client, () => ({ provider: 'codex', provider_session_id: 'native-id' }) as never);
  assert.equal((await service.execute('app-id', { action: 'get' })).goal!.tokensUsed, 123);
  await service.execute('app-id', { action: 'pause' });await service.execute('app-id', { action: 'resume' });
  assert.deepEqual(calls.map(c => c.params), [{ threadId: 'native-id' }, { threadId: 'native-id', status: 'paused' },
    { threadId: 'native-id', limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' }, { threadId: 'native-id', status: 'active' }]);
  await service.execute('app-id', { action: 'clear' });assert.equal(calls.at(-1).method, 'thread/goal/clear');
});

test('pause stops native goal continuation before interrupting the current turn', async () => {
  const calls: string[] = [];
  const client = Object.assign(new EventEmitter(), { async call(method: string, params: any) {
    calls.push(method);
    if (method === 'thread/turns/list') return { data: [{ id: 'running-turn', status: 'inProgress' }] };
    if (method === 'turn/interrupt') assert.deepEqual(params, { threadId: 'native-id', turnId: 'running-turn' });
    return { goal: { status: 'paused', tokensUsed: 123 } };
  } });
  const service = createCodexGoalsService(client, () => ({ provider: 'codex', provider_session_id: 'native-id' }) as never);
  assert.equal((await service.execute('app-id', { action: 'pause' })).goal!.tokensUsed, 123);
  assert.deepEqual(calls, ['thread/goal/set', 'thread/turns/list', 'turn/interrupt']);
});

test('pause succeeds when the turn finishes during the interrupt request', async () => {
  const client = Object.assign(new EventEmitter(), { async call(method: string) {
    if (method === 'thread/turns/list') return { data: [{ id: 'done-turn', status: 'inProgress' }] };
    if (method === 'turn/interrupt') throw new Error('no active turn');
    return { goal: { status: 'paused' } };
  } });
  const service = createCodexGoalsService(client, () => ({ provider: 'codex', provider_session_id: 'native-id' }) as never);
  assert.equal((await service.execute('app-id', { action: 'pause' })).goal!.status, 'paused');
});

test('new app sessions report an empty goal and reject premature resume', async () => {
  let calls = 0;
  const client = Object.assign(new EventEmitter(), { async call() { calls++; return {}; } });
  const service = createCodexGoalsService(client, () => ({ provider: 'codex', provider_session_id: null }) as never);
  assert.deepEqual(await service.execute('new-app-id', { action: 'get' }), { goal: null });
  await assert.rejects(service.execute('new-app-id', { action: 'resume' }), /Start the goal/);
  assert.equal(calls, 0);
});

test('goal service validates session existence and provider before native access', async () => {
  const client = Object.assign(new EventEmitter(), { async call() { throw new Error('unexpected native call'); } });
  await assert.rejects(createCodexGoalsService(client, () => null).execute('missing', { action: 'get' }), /not found/);
  await assert.rejects(createCodexGoalsService(client, () => ({ provider: 'opencode' }) as never).execute('other', { action: 'clear' }), /Codex sessions/);
});
