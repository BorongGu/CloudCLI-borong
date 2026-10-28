import assert from 'node:assert/strict';
import test from 'node:test';

import { sessionsDb } from '@/modules/database/index.js';
import { createProviderUsageService } from '@/modules/providers/services/provider-usage.service.js';

const quota = (percent: number) => ({ usage: Object.fromEntries(['rolling', 'weekly', 'monthly'].map(name => [name, { percent, status: 'ok', resetsAt: '2026-11-01T00:00:00Z' }])) });

function fixture(provider = 'codex') {
  let now = Date.parse('2026-10-26T03:00:00Z');
  let failed = false;
  let requests = 0;
  const session = { session_id: 'chat', provider, provider_session_id: 'native', jsonl_path: '/transcript', model: 'gpt-6.1-sol' } as ReturnType<typeof sessionsDb.getSessionById>;
  const service = createProviderUsageService({
    now: () => now, home: () => '/test', getSession: id => id === 'chat' ? session : null,
    readTail: async () => JSON.stringify({ timestamp: '2026-10-26T03:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: {
      total_token_usage: { total_tokens: 286_000_000 }, last_token_usage: { total_tokens: 96_000 }, model_context_window: 475_000,
    } } }) + '\n{unfinished',
    readOpenCodeContext: () => ({ used: 99_159, model: 'opencode-go/deepseek-v4.1-flash', updatedAt: '2026-10-26T03:00:00Z' }),
    readJson: async filename => {
      if (filename.endsWith('state.json')) return { accounts: [
        { id: 'one', label: '本人', apiKey: 'secret-one', enabled: true, priority: 0 },
        { id: 'two', label: '爱人', apiKey: 'secret-two', enabled: true, priority: 1 },
      ], sessions: { native: { accountId: 'two' } } };
      if (filename.endsWith('models.json')) return { 'opencode-go': { models: { 'deepseek-v4.1-flash': { limit: { context: 1_000_000 } } } } };
      return {};
    },
    codexCall: async method => {
      if (failed) throw new Error('secret-one upstream error');
      if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'prolite' } };
      return { rateLimitsByLimitId: { codex: { primary: { usedPercent: 11, windowDurationMins: 10080, resetsAt: 1793516329 }, secondary: null } } };
    },
    fetch: async (_url, init) => {
      requests++;
      if (failed) throw new Error('secret-two upstream error');
      return new Response(JSON.stringify(quota(new Headers(init?.headers).get('Authorization')?.endsWith('secret-one') ? 55 : 12)));
    },
  });
  return { service, requests: () => requests, fail: () => { failed = true; now += 31_000; } };
}

test('context measures the latest request while subscription windows retain their actual duration', async () => {
  const { service } = fixture();
  const result = await service.getUsage({ sessionId: 'chat' });
  assert.equal(result.context.used, 96_000);
  assert.equal(result.context.limit, 475_000);
  assert.equal(result.accounts[0].windows[0].windowMinutes, 10080);
  assert.equal(result.accounts[0].windows[0].usedPercent, 11);
  assert.equal(result.accounts[0].plan, 'prolite');
  assert.equal(result.accounts[0].active, true);
  assert.equal(JSON.stringify(result).includes('secret-'), false);
});

test('Go accounts keep independent quota windows and identify the account bound to the native session', async () => {
  const { service } = fixture('opencode');
  const result = await service.getUsage({ sessionId: 'chat' });
  assert.equal(result.context.used, 99_159);
  assert.equal(result.context.limit, 1_000_000);
  const accounts = result.accounts.filter(account => account.provider === 'opencode');
  assert.deepEqual(accounts.map(account => account.windows.map(window => window.usedPercent)), [[55, 55, 55], [12, 12, 12]]);
  assert.deepEqual(accounts.map(account => account.active), [false, true]);
  assert.deepEqual(accounts[0].windows.map(window => window.windowMinutes), [300, 10080, 43200]);
});

test('concurrent clients share a quota read and manual refresh bypasses the short cache', async () => {
  const { service, requests } = fixture();
  await Promise.all([service.getUsage({}), service.getUsage({})]);
  assert.equal(requests(), 2);
  await service.getUsage({}); assert.equal(requests(), 2);
  await service.getUsage({ refresh: true }); assert.equal(requests(), 4);
});

test('a quota outage retains the last successful snapshot and exposes a sanitized stale state', async () => {
  const { service, fail } = fixture();
  const first = await service.getUsage({}); fail();
  const result = await service.getUsage({});
  assert.ok(result.accounts.every(account => account.status === 'stale'));
  assert.deepEqual(result.accounts.map(account => account.windows), first.accounts.map(account => account.windows));
  assert.equal(JSON.stringify(result).includes('secret-'), false);
  assert.deepEqual(result.accounts.map(account => account.checkedAt), first.accounts.map(account => account.checkedAt));
});

test('missing usage stays unknown with the Codex default window and an absent session returns 404', async () => {
  const service = createProviderUsageService({ home: () => '/test', getSession: () => null,
    readJson: async () => ({}), codexCall: async () => ({ account: { type: 'apiKey' } }),
  });
  const result = await service.getUsage({});
  assert.equal(result.context.used, null); assert.equal(result.context.limit, 475_000);
  assert.deepEqual(result.accounts.map(account => account.windows), [[], []]);
  assert.equal(result.accounts[0].error, 'api_key');
  await assert.rejects(service.getUsage({ sessionId: 'missing' }), { statusCode: 404 });
});


test('an OpenCode model from another provider leaves the Go accounts available without marking one current', async () => {
  const { service } = fixture('opencode');
  const result = await service.getUsage({ sessionId: 'chat', model: 'anthropic/claude-opus-4-8' });
  assert.ok(result.accounts.every(account => !account.active));
  assert.equal(result.accounts.filter(account => account.provider === 'opencode').length, 2);
});


test('all Codex models use 475K with old usage snapshots and with empty histories', async () => {
  for (const model of ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna', 'custom-codex-model']) {
    for (const hasHistory of [false, true]) {
      const service = createProviderUsageService({
        getSession: () => ({ provider: 'codex', model, jsonl_path: '/old-session' }) as never,
        readJson: async () => ({}), codexCall: async () => ({ account: { type: 'apiKey' } }),
        readTail: async () => hasHistory ? JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {
          model_context_window: 258_400, last_token_usage: { total_tokens: 96_000 },
        } } }) : '',
      });
      const { context } = await service.getUsage({ sessionId: 'chat', model });
      assert.equal(context.limit, 475_000, model);
      assert.equal(context.used, hasHistory ? 96_000 : null);
      assert.equal(context.model, model);
    }
  }
});
