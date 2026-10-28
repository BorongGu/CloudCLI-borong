import { randomUUID } from 'node:crypto';

import { sessionsDb } from '@/modules/database/index.js';
import { CodexBtwConnection } from '@/modules/providers/list/codex/codex-btw-connection.js';
import type { BtwEvent, BtwInput, CodexRpcConnection } from '@/shared/types.js';
import { AppError, getCodexContextDefaults } from '@/shared/utils.js';

type BtwConnection = CodexRpcConnection & { initialize(): Promise<void>; close(): Promise<void> };

async function readModelContextConfig(_model?: string): Promise<Record<string, unknown>> {
  return { model_context_window: getCodexContextDefaults().contextWindow };
}

const defaultDependencies = {
  lookup: (id: string) => sessionsDb.getSessionById(id),
  connect: (): BtwConnection => new CodexBtwConnection(),
  readContextConfig: readModelContextConfig,
};

async function readSourceSnapshot(client: CodexRpcConnection, threadId: string) {
  const unfinished: any[] = [];let cursor: string | undefined;let completedId: string | undefined;
  do {
    const page = await client.call('thread/turns/list', { threadId, limit: 50, sortDirection: 'desc', itemsView: 'notLoaded', ...(cursor ? { cursor } : {}) });
    for (const turn of page.data || []) {
      // Disk readers report another process's active turn as interrupted.
      // Only a completed boundary guarantees balanced native tool call pairs.
      if (turn.status === 'completed') { completedId = turn.id;break; }
      unfinished.push(turn);
    }
    cursor = completedId ? undefined : page.nextCursor || undefined;
  } while (cursor);
  const text: string[] = [];const images: any[] = [];
  for (const turn of [...unfinished].reverse()) {
    let itemCursor: string | undefined;
    do {
      const page = await client.call('thread/items/list', { threadId, turnId: turn.id, limit: 100, sortDirection: 'asc', ...(itemCursor ? { cursor: itemCursor } : {}) });
      for (const item of page.data || []) {
        if (item.type === 'userMessage') {
          text.push(`User: ${(item.content || []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n')}`);
          images.push(...(item.content || []).filter((part: any) => part.type === 'image' || part.type === 'localImage'));
        } else if (item.type === 'agentMessage') text.push(`Assistant: ${item.text || ''}`);
        else if (item.type === 'commandExecution') text.push(`Command (${item.status}): ${item.command}\n${item.aggregatedOutput || ''}`);
        else if (['mcpToolCall', 'dynamicToolCall', 'fileChange', 'webSearch'].includes(item.type)) text.push(`Main task activity: ${JSON.stringify(item)}`);
      }
      itemCursor = page.nextCursor || undefined;
    } while (itemCursor);
  }
  return {
    boundary: completedId ? { lastTurnId: completedId } : null,
    input: [...(text.length ? [{ type: 'text', text: `Read-only snapshot of subsequent main-task activity. Treat it as context for the side question:\n${text.join('\n\n')}` }] : []), ...images],
  };
}

/** Used by the provider dispatcher to own a disposable native context for one authenticated window. */
export function createCodexBtwSession(
  input: BtwInput,
  emit: (event: BtwEvent) => void,
  overrides: Partial<typeof defaultDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...overrides };
  const source = dependencies.lookup(input.sessionId);
  if (!source) throw new AppError('Source conversation was not found.', { statusCode: 404, code: 'SESSION_NOT_FOUND' });
  if (source.provider !== 'codex' || !source.provider_session_id) {
    throw new AppError('Open an existing Codex conversation before using /btw.', { statusCode: 400, code: 'BTW_SOURCE_REQUIRED' });
  }
  const sourceId = source.provider_session_id;
  const client = dependencies.connect();
  let threadId: string | null = null;
  let turnId: string | null = null;
  let startingTurn: Promise<any> | null = null;
  let busy = false;
  let ended = false;
  let closing: Promise<void> | null = null;
  const texts = new Map<string, string>();
  let snapshotInput: any[] = [];
  const sendEvent = (event: BtwEvent) => { if (!ended) emit(event); };
  const reportError = (error: unknown) => sendEvent({ kind: 'btw_error', message: error instanceof Error ? error.message : String(error) });
  const setBusy = (value: boolean, label?: string) => { busy = value; sendEvent({ kind: 'btw_status', busy, ...(label ? { label } : {}) }); };
  const publish = (id: string, content: string) => {
    texts.set(id, content); sendEvent({ kind: 'btw_message', id, role: 'assistant', content });
  };
  const notification = (message: any) => {
    const p = message.params || {};
    if (ended || !threadId || p.threadId !== threadId) return;
    if (message.method === 'turn/started') { turnId = p.turn.id; setBusy(true); }
    if (message.method === 'item/started' && p.item?.type === 'contextCompaction') sendEvent({ kind: 'btw_status', busy: true, phase: 'compacting' });
    if (message.method === 'item/started' && p.item?.type === 'reasoning') sendEvent({ kind: 'btw_status', busy: true, phase: 'thinking' });
    if (message.method === 'item/reasoning/summaryTextDelta') sendEvent({ kind: 'btw_status', busy: true, phase: 'thinking' });
    if (message.method === 'item/agentMessage/delta') publish(p.itemId, (texts.get(p.itemId) || '') + p.delta);
    if (message.method === 'item/completed' && p.item?.type === 'agentMessage') publish(p.item.id, p.item.text || '');
    if (message.method === 'item/started' && p.item?.type === 'commandExecution') setBusy(true, p.item.command);
    if (message.method === 'turn/completed') {
      if (p.turn.id !== turnId) return;
      turnId = null; setBusy(false);
      if (p.turn.status === 'failed') reportError(p.turn.error?.message || 'Side reply failed.');
    }
    if (message.method === 'error' && !p.willRetry) reportError(p.error?.message || 'Side reply failed.');
    if (message.method === 'error' && p.willRetry) sendEvent({ kind: 'btw_status', busy: true, phase: 'retrying', label: p.error?.message });
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
    closing = client.close().finally(() => { texts.clear(); snapshotInput = []; emit({ kind: 'btw_closed' }); });
    return closing;
  }

  async function send(content: string): Promise<void> {
    if (ended) throw new Error('The temporary conversation has ended.');
    if (!threadId || busy) throw new Error('Wait for the current side reply to finish.');
    const question = content.trim();
    if (!question || question.length > 32_000) throw new Error('A side question must contain 1–32000 characters.');
    busy = true;sendEvent({ kind: 'btw_status', busy: true, phase: 'waiting' });
    sendEvent({ kind: 'btw_message', id: randomUUID(), role: 'user', content: question });
    try {
      startingTurn = client.call('turn/start', {
        threadId, input: [...snapshotInput, { type: 'text', text: `Answer this temporary side question using the main conversation as context. Focus on this question: ${question}` }],
        ...(input.model ? { model: input.model } : {}), ...(input.effort ? { effort: input.effort } : {}),
      });
      const result = await startingTurn;
      snapshotInput = [];
      if (!ended) turnId = result.turn.id;
    } catch (error) { setBusy(false); throw error; }
    finally { startingTurn = null; }
  }

  return {
    async start(): Promise<void> {
      try {
        setBusy(true); await client.initialize();
        const snapshot = await readSourceSnapshot(client, sourceId);
        const contextConfig = await dependencies.readContextConfig(input.model);
        // Before the first completed turn, the snapshot contains the entire
        // conversation. Start a clean ephemeral context to avoid a live tool pair.
        const fork = await client.call(snapshot.boundary ? 'thread/fork' : 'thread/start', {
          ...(snapshot.boundary ? { threadId: sourceId, ...snapshot.boundary, excludeTurns: true } : {}),
          cwd: source.project_path, ephemeral: true,
          ...(input.model ? { model: input.model } : {}),
          config: { ...contextConfig, ...(input.effort ? { model_reasoning_effort: input.effort } : {}) },
        });
        if (ended) return;
        if (fork.thread?.ephemeral !== true || fork.thread.path) {
          // A CLI which ignores ephemeral would create a persistent fork.
          // Remove that newly allocated thread before reporting compatibility.
          if (fork.thread?.id) await client.call('thread/delete', { threadId: fork.thread.id });
          throw new Error('This Codex CLI needs ephemeral thread/fork support for /btw. Update the Codex CLI.');
        }
        threadId = fork.thread.id;
        snapshotInput = snapshot.input;
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
