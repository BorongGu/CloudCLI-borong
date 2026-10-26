import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { codexQuestions } from '@/modules/providers/list/codex/codex-questions.provider.js';
import { codexRuntime } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import { SharedCodex, SharedCodexThread } from '@/modules/providers/list/codex/codex-shared-sdk.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

class CompactionConnection extends EventEmitter {
  constructor(private readonly outcome = 'completed', private readonly finishItem = true) { super(); }
  async call(method: string): Promise<any> {
    if (method === 'thread/resume') return { thread: { id: 'native', status: { type: 'idle' } } };
    if (method === 'thread/goal/get') return { goal: null };
    if (method === 'turn/start') {
      setImmediate(() => {
        const item = { id: 'compact', type: 'contextCompaction' };
        // Other turns and sessions must leave this run's label alone.
        this.emit('notification', { method: 'item/started', params: { threadId: 'other', turnId: 'turn', item } });
        this.notify('item/started', { turnId: 'old-turn', item });
        this.notify('item/started', { item });this.notify('item/started', { item });
        if (this.finishItem) {
          this.notify('item/completed', { item });
          this.notify('thread/compacted', {});
        }
        this.notify('turn/completed', { turn: { id: 'turn', status: this.outcome, error: this.outcome === 'failed' ? { message: 'Compaction failed' } : undefined } });
      });
      return { turn: { id: 'turn' } };
    }
    throw new Error(method);
  }
  private notify(method: string, params: any) {
    this.emit('notification', { method, params: { threadId: 'native', turnId: 'turn', ...params } });
  }
}

test('native compaction begins and ends exactly once through the main stream', async () => {
  const client = new CompactionConnection();
  const { events } = await new SharedCodex(client).resumeThread('native').runStreamed('Question');
  const seen = [];for await (const event of events) seen.push(event);
  assert.deepEqual(seen.filter(event => event.type === 'compaction.updated').map(event => event.compact.phase), ['running', 'done']);
  assert.equal(seen.at(-1)?.type, 'turn.completed');
  assert.equal(client.listenerCount('notification'), 0);
});

test('a terminal turn clears compaction even when its item completion is missing', async () => {
  const client = new CompactionConnection('failed', false);
  const { events } = await new SharedCodex(client).resumeThread('native').runStreamed('Question');
  const seen = [];for await (const event of events) seen.push(event);
  assert.deepEqual(seen.filter(event => event.type === 'compaction.updated').map(event => event.compact.phase), ['running', 'failed']);
  assert.equal(seen.at(-1)?.type, 'turn.failed');
});

test('the Codex runtime forwards compaction as interruptible session status', async t => {
  const client = new CompactionConnection();const messages: NormalizedMessage[] = [];
  t.mock.method(codexQuestions, 'bind', () => {});
  t.mock.method(SharedCodex.prototype, 'resumeThread', () => new SharedCodexThread(client, 'native'));
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => 'native', resolveResumeModel: async () => 'test-model',
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
    normalizeMessage: () => [], isProviderInstalled: async () => true,
  };
  await codexRuntime.run('Question', { sessionId: 'app', cwd: process.cwd() }, { isWebSocketWriter: true, send: message => { messages.push(message as NormalizedMessage); } }, context);
  const statuses = messages.filter(message => message.kind === 'status' && message.text === 'context_compaction');
  assert.deepEqual(statuses.map(message => message.compact?.phase), ['running', 'done']);
  assert.ok(statuses.every(message => message.provider === 'codex' && message.sessionId === 'native' && message.canInterrupt));
  assert.equal(messages.at(-1)?.kind, 'complete');
});
