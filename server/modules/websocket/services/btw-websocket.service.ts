import { randomUUID } from 'node:crypto';

import type { WebSocket } from 'ws';

import { btwRegistry } from '@/modules/websocket/services/btw-registry.service.js';
import { WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import type { AuthenticatedWebSocketRequest, BtwEvent } from '@/shared/types.js';
import { parseIncomingJsonObject } from '@/shared/utils.js';

/** The authenticated router attaches each BTW socket to a user-scoped, reconnectable temporary conversation. */
export function handleBtwConnection(ws: WebSocket, request?: AuthenticatedWebSocketRequest, registry = btwRegistry): void {
  const owner = String(request?.user?.id ?? request?.user?.userId ?? request?.user?.username ?? 'local');
  let conversationId: string | null = null;
  let detach: (() => void) | null = null;
  const emit = (event: BtwEvent) => {
    if (ws.readyState === WS_OPEN_STATE) ws.send(JSON.stringify(event));
  };
  ws.on('message', async raw => {
    try {
      const data = parseIncomingJsonObject(raw);
      if (!data) throw new Error('Invalid BTW message.');
      if (data.type === 'start') {
        if (conversationId) throw new Error('This side conversation has already started.');
        if (data.conversationId !== undefined && (typeof data.conversationId !== 'string' || !data.conversationId || data.conversationId.length > 200)) throw new Error('Invalid BTW window id.');
        if (typeof data.sessionId !== 'string' || !data.sessionId.trim()) throw new Error('A source conversation is required.');
        for (const field of ['question', 'model', 'effort', 'permissionMode']) {
          if (data[field] !== undefined && typeof data[field] !== 'string') throw new Error(`Invalid ${field}.`);
        }
        if (typeof data.question === 'string' && data.question.length > 32_000) throw new Error('Side question is too long.');
        if ((typeof data.model === 'string' && data.model.length > 200) || (typeof data.effort === 'string' && data.effort.length > 32)) throw new Error('Invalid model selection.');
        const id = typeof data.conversationId === 'string' ? data.conversationId : randomUUID();
        detach = registry.attach(owner, id, emit, { sessionId: data.sessionId.trim(), question: data.question as string | undefined,
          model: data.model as string | undefined, effort: data.effort as string | undefined,
          permissionMode: data.permissionMode as string | undefined });
        conversationId = id;
      } else if (data.type === 'resume') {
        if (conversationId) throw new Error('This side conversation has already started.');
        if (typeof data.conversationId !== 'string' || !data.conversationId || data.conversationId.length > 200) throw new Error('Invalid BTW window id.');
        try { detach = registry.attach(owner, data.conversationId, emit);conversationId = data.conversationId; }
        catch (error) {
          emit({ kind: 'btw_error', message: error instanceof Error ? error.message : String(error) });
          emit({ kind: 'btw_closed' });
        }
      } else if (data.type === 'finish') {
        if (conversationId) await registry.finish(owner, conversationId);
        else emit({ kind: 'btw_closed' });
      } else if (data.type === 'send') {
        if (!conversationId || typeof data.content !== 'string') throw new Error('Start the temporary conversation before sending a question.');
        await registry.send(owner, conversationId, data.content);
      } else if (data.type === 'stop') {
        if (conversationId) await registry.stop(owner, conversationId);
      } else throw new Error('Unknown BTW action.');
    } catch (error) {
      emit({ kind: 'btw_error', message: error instanceof Error ? error.message : String(error) });
    }
  });
  // Refresh and network loss detach the viewer; explicit finish owns native cleanup.
  ws.once('close', () => { detach?.(); });
  ws.once('error', () => { detach?.(); });
}
