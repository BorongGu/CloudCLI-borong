import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { codexQuestions } from '@/modules/providers/list/codex/codex-questions.provider.js';
import { codexRuntime } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import { SharedCodex, SharedCodexThread } from '@/modules/providers/list/codex/codex-shared-sdk.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

const CAPACITY = 'Selected model is at capacity. Please try a different model.';
class ErrorConnection extends EventEmitter {
  constructor(private readonly retry = false, private readonly completion = true, private readonly recover = false) { super(); }
  async call(method: string): Promise<any> {
    if (method === 'thread/resume') return { thread: { id: 'native', status: { type: 'idle' } } };
    if (method === 'thread/goal/get') return { goal: null };
    if (method === 'turn/start') {
      setImmediate(() => {
        this.emit('notification', { method: 'error', params: { threadId: 'other', turnId: 'turn', willRetry: false, error: { message: 'Unrelated' } } });
        if (this.retry) this.notify('error', { willRetry: true, error: { message: CAPACITY } });
        if (this.recover) {
          this.notify('item/completed', { item: { id: 'answer', type: 'agentMessage', text: 'Recovered' } });
          this.notify('turn/completed', { turn: { id: 'turn', status: 'completed' } });
          return;
        }
        this.notify('error', { willRetry: false, error: { message: CAPACITY } });
        // Some native failures end with just the error; others repeat it in turn/completed.
        if (this.completion) this.notify('turn/completed', { turn: { id: 'turn', status: 'failed', error: { message: CAPACITY } } });
      });
      return { turn: { id: 'turn' } };
    }
    throw new Error(method);
  }
  private notify(method: string, params: any) { this.emit('notification', { method, params: { threadId: 'native', turnId: 'turn', ...params } }); }
}

test('a native terminal error ends the stream and removes listeners with one failure event', async () => {
  const client = new ErrorConnection(false, false);const seen = [];
  const { events } = await new SharedCodex(client).resumeThread('native').runStreamed('Question');
  for await (const event of events) seen.push(event);
  assert.deepEqual(seen.filter(event => event.type === 'turn.failed').map(event => event.error.message), [CAPACITY]);
  assert.equal(client.listenerCount('notification'), 0);
});

test('retryable capacity errors keep observing until the native turn recovers', async () => {
  const client = new ErrorConnection(true, true, true);const seen = [];
  const { events } = await new SharedCodex(client).resumeThread('native').runStreamed('Question');
  for await (const event of events) seen.push(event);
  assert.equal(seen.some(event => event.type === 'error' && event.message === CAPACITY), true);
  assert.equal(seen.some(event => event.type === 'turn.failed'), false);
  assert.equal(seen.at(-1)?.type, 'turn.completed');
});

test('capacity errors reach the web transcript once and the run completes with failure', async t => {
  const client = new ErrorConnection(true);const messages: NormalizedMessage[] = [];
  const provider = new CodexSessionsProvider();
  t.mock.method(codexQuestions, 'bind', () => {});
  t.mock.method(SharedCodex.prototype, 'resumeThread', () => new SharedCodexThread(client, 'native'));
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => 'native', resolveResumeModel: async () => 'test-model',
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
    normalizeMessage: (raw, id) => provider.normalizeMessage(raw, id), isProviderInstalled: async () => true,
  };
  await codexRuntime.run('Question', { sessionId: 'app', cwd: process.cwd() }, { isWebSocketWriter: true, send: message => { messages.push(message as NormalizedMessage); } }, context);
  assert.deepEqual(messages.filter(message => message.kind === 'error').map(message => message.content), [CAPACITY]);
  assert.equal(messages.at(-1)?.kind, 'complete');assert.equal(messages.at(-1)?.exitCode, 1);
});
