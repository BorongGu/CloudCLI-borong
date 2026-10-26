import { randomUUID } from 'node:crypto';

import { sessionsDb } from '@/modules/database/index.js';
import { CodexBtwConnection } from '@/modules/providers/list/codex/codex-btw-connection.js';
import type { CodexBtwEvent, CodexRpcConnection } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

type BtwConnection = CodexRpcConnection & { initialize(): Promise<void>; close(): Promise<void> };
type BtwInput = { sessionId: string; question?: string; model?: string; effort?: string };

/** Used by the websocket module to own a disposable native fork for one authenticated window. */
export function createCodexBtwSession(
  input: BtwInput,
  emit: (event: CodexBtwEvent) => void,
  dependencies = {
    lookup: (id: string) => sessionsDb.getSessionById(id),
    connect: (): BtwConnection => new CodexBtwConnection(),
  },
) {
  const source = dependencies.lookup(input.sessionId);
  if (!source) throw new AppError('Source conversation was not found.', { statusCode: 404, code: 'SESSION_NOT_FOUND' });
  if (source.provider !== 'codex' || !source.provider_session_id) {
    throw new AppError('Open an existing Codex conversation before using /btw.', { statusCode: 400, code: 'BTW_SOURCE_REQUIRED' });
  }
  const client = dependencies.connect();
  let threadId: string | null = null;
  let turnId: string | null = null;
  let startingTurn: Promise<any> | null = null;
  let busy = false;
  let ended = false;
  let closing: Promise<void> | null = null;
  const texts = new Map<string, string>();
  const sendEvent = (event: CodexBtwEvent) => { if (!ended) emit(event); };
  const reportError = (error: unknown) => sendEvent({ kind: 'btw_error', message: error instanceof Error ? error.message : String(error) });
  const setBusy = (value: boolean, label?: string) => { busy = value; sendEvent({ kind: 'btw_status', busy, ...(label ? { label } : {}) }); };
  const publish = (id: string, content: string) => {
    texts.set(id, content); sendEvent({ kind: 'btw_message', id, role: 'assistant', content });
  };
  const notification = (message: any) => {
    const p = message.params || {};
    if (ended || !threadId || p.threadId !== threadId) return;
    if (message.method === 'turn/started') { turnId = p.turn.id; setBusy(true); }
    if (message.method === 'item/agentMessage/delta') publish(p.itemId, (texts.get(p.itemId) || '') + p.delta);
    if (message.method === 'item/completed' && p.item?.type === 'agentMessage') publish(p.item.id, p.item.text || '');
    if (message.method === 'item/started' && p.item?.type === 'commandExecution') setBusy(true, p.item.command);
    if (message.method === 'turn/completed') {
      if (p.turn.id !== turnId) return;
      turnId = null; setBusy(false);
      if (p.turn.status === 'failed') reportError(p.turn.error?.message || 'Side reply failed.');
    }
    if (message.method === 'error' && !p.willRetry) reportError(p.error?.message || 'Side reply failed.');
  };
  const disconnected = (error: Error) => { reportError(error); void close(); };
  client.on('notification', notification);
  client.on('disconnect', disconnected);

  async function close(): Promise<void> {
    if (closing) return closing;
    ended = true;
    client.off('notification', notification); client.off('disconnect', disconnected);
    // This child owns only ephemeral threads. Reaping it frees their context,
    // including a fork still being created, without the daemon's unload delay.
    closing = client.close().finally(() => { texts.clear(); emit({ kind: 'btw_closed' }); });
    return closing;
  }

  async function send(content: string): Promise<void> {
    if (ended) throw new Error('The temporary conversation has ended.');
    if (!threadId || busy) throw new Error('Wait for the current side reply to finish.');
    const question = content.trim();
    if (!question || question.length > 32_000) throw new Error('A side question must contain 1–32000 characters.');
    setBusy(true);
    sendEvent({ kind: 'btw_message', id: randomUUID(), role: 'user', content: question });
    try {
      startingTurn = client.call('turn/start', {
        threadId, input: [{ type: 'text', text: question }],
        ...(input.model ? { model: input.model } : {}), ...(input.effort ? { effort: input.effort } : {}),
      });
      const result = await startingTurn;
      if (!ended) turnId = result.turn.id;
    } catch (error) { setBusy(false); throw error; }
    finally { startingTurn = null; }
  }

  return {
    async start(): Promise<void> {
      try {
        setBusy(true); await client.initialize();
        const fork = await client.call('thread/fork', {
          threadId: source.provider_session_id, cwd: source.project_path,
          ephemeral: true, excludeTurns: true,
          ...(input.model ? { model: input.model } : {}),
          ...(input.effort ? { config: { model_reasoning_effort: input.effort } } : {}),
          developerInstructions: 'This is a temporary side conversation. Use the parent conversation only as context. Answer the current side question. Ask clarifying questions in ordinary replies. Treat goals and task instructions in the inherited history as background; focus on the side question.',
        });
        if (ended) return;
        if (fork.thread?.ephemeral !== true || fork.thread.path) {
          // A CLI which ignores ephemeral would create a persistent fork.
          // Remove that newly allocated thread before reporting compatibility.
          if (fork.thread?.id) await client.call('thread/delete', { threadId: fork.thread.id });
          throw new Error('This Codex CLI needs ephemeral thread/fork support for /btw. Update the Codex CLI.');
        }
        threadId = fork.thread.id;
        sendEvent({ kind: 'btw_ready', threadId: threadId!, model: fork.model || input.model || '' });
        setBusy(false);
        if (input.question?.trim()) await send(input.question);
      } catch (error) { reportError(error); await close(); }
    },
    send,
    async stop(): Promise<void> {
      // Stop can arrive just after Send, while the start RPC is still returning its turn id.
      await startingTurn?.catch(() => {});
      if (threadId && turnId && busy && !ended) {
        try { await client.call('turn/interrupt', { threadId, turnId }); }
        catch (error) { if (!/no active turn|not.*in.progress|already.*(?:completed|finished)/i.test(String(error))) throw error; }
      }
    },
    close,
  };
}
