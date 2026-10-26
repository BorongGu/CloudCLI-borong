import type { WebSocket } from 'ws';

import { createBtwSession } from '@/modules/providers/index.js';
import { WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import type { BtwEvent, BtwSession } from '@/shared/types.js';
import { parseIncomingJsonObject } from '@/shared/utils.js';

/** Used by the authenticated websocket router; a window's socket owns its temporary conversation. */
export function handleBtwConnection(ws: WebSocket, createSession = createBtwSession): void {
  let session: BtwSession | null = null;
  const emit = (event: BtwEvent) => {
    if (ws.readyState === WS_OPEN_STATE) ws.send(JSON.stringify(event));
  };
  ws.on('message', async raw => {
    try {
      const data = parseIncomingJsonObject(raw);
      if (!data) throw new Error('Invalid BTW message.');
      if (data.type === 'start') {
        if (session) throw new Error('This side conversation has already started.');
        if (typeof data.sessionId !== 'string' || !data.sessionId.trim()) throw new Error('A source conversation is required.');
        for (const field of ['question', 'model', 'effort', 'permissionMode']) {
          if (data[field] !== undefined && typeof data[field] !== 'string') throw new Error(`Invalid ${field}.`);
        }
        if (typeof data.question === 'string' && data.question.length > 32_000) throw new Error('Side question is too long.');
        if ((typeof data.model === 'string' && data.model.length > 200) || (typeof data.effort === 'string' && data.effort.length > 32)) throw new Error('Invalid model selection.');
        session = createSession({ sessionId: data.sessionId.trim(), question: data.question as string | undefined,
          model: data.model as string | undefined, effort: data.effort as string | undefined,
          permissionMode: data.permissionMode as string | undefined }, emit);
        await session.start();
      } else if (data.type === 'finish') {
        if (session) await session.close();
        else emit({ kind: 'btw_closed' });
      } else if (data.type === 'send') {
        if (!session || typeof data.content !== 'string') throw new Error('Start the temporary conversation before sending a question.');
        await session.send(data.content);
      } else if (data.type === 'stop') {
        await session?.stop();
      } else throw new Error('Unknown BTW action.');
    } catch (error) {
      emit({ kind: 'btw_error', message: error instanceof Error ? error.message : String(error) });
    }
  });
  // A refresh, closed tab, lost heartbeat or network disconnect reaps the same child.
  ws.once('close', () => { void session?.close(); });
  ws.once('error', () => { void session?.close(); });
}
