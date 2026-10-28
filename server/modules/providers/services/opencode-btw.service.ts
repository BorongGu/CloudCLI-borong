import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';

import { sessionsDb } from '@/modules/database/index.js';
import { OpenCodeBtwConnection } from '@/modules/providers/list/opencode/opencode-btw-connection.js';
import type { BtwEvent, BtwInput, BtwSession } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

type Connection = Pick<OpenCodeBtwConnection, 'initialize' | 'request' | 'close'> & Pick<EventEmitter, 'on' | 'off'>;

/** Used by the provider dispatcher to run OpenCode side questions in a private native fork/store. */
export function createOpenCodeBtwSession(input: BtwInput, emit: (event: BtwEvent) => void, dependencies = {
  lookup: (id: string) => sessionsDb.getSessionById(id),
  connect: (id: string, cwd: string): Connection => new OpenCodeBtwConnection(id, cwd),
}): BtwSession {
  const source = dependencies.lookup(input.sessionId);
  if (!source) throw new AppError('Source conversation was not found.', { statusCode: 404, code: 'SESSION_NOT_FOUND' });
  if (source.provider !== 'opencode' || !source.provider_session_id || !source.project_path) {
    throw new AppError('Open an existing OpenCode conversation before using /btw.', { statusCode: 400, code: 'BTW_SOURCE_REQUIRED' });
  }
  const client = dependencies.connect(source.provider_session_id, source.project_path);
  let id: string | null = null;let ended = false;let busy = false;let observedRun = false;
  let starting: Promise<any> | null = null;let closing: Promise<void> | null = null;
  const roles = new Map<string, string>();
  const inheritedMessageIds = new Set<string>();
  const parts = new Map<string, { messageID: string; type: string; text?: string }>();
  const sendEvent = (event: BtwEvent) => { if (!ended) emit(event); };
  const setBusy = (value: boolean, label?: string, phase?: 'waiting' | 'thinking' | 'working' | 'retrying') => {
    busy = value;sendEvent({ kind: 'btw_status', busy, ...(label ? { label } : {}), ...(phase ? { phase } : {}) });
  };
  const reportError = (error: unknown) => sendEvent({ kind: 'btw_error', message: error instanceof Error ? error.message : String(error) });
  const publishPart = (partId: string) => {
    const part = parts.get(partId);
    if (part?.type === 'text' && roles.get(part.messageID) === 'assistant') {
      sendEvent({ kind: 'btw_message', id: `${part.messageID}_${partId}`, role: 'assistant', content: part.text || '' });
    }
  };
  const notification = (event: any) => {
    const p = event.properties || {};
    if (ended || !id || (p.sessionID || p.part?.sessionID || p.info?.sessionID) !== id) return;
    const messageId = event.type === 'message.updated' ? p.info?.id : p.part?.messageID || p.messageID;
    // Fork-copy events can arrive after the HTTP response and even after the first side prompt.
    if (inheritedMessageIds.has(messageId)) return;
    if (event.type === 'message.updated') {
      roles.set(p.info.id, p.info.role);
      if (p.info.role === 'assistant') observedRun = true;
      for (const [partId, part] of parts) if (part.messageID === p.info.id) publishPart(partId);
    }
    if (event.type === 'message.part.updated') {
      parts.set(p.part.id, p.part);publishPart(p.part.id);
      if (p.part.type === 'tool' && p.part.state?.status === 'running') setBusy(true, p.part.state.title || p.part.tool, 'working');
      if (p.part.type === 'reasoning') setBusy(true, undefined, 'thinking');
    }
    if (event.type === 'message.part.delta' && p.field === 'text') {
      const part = parts.get(p.partID);
      if (part) { part.text = (part.text || '') + p.delta;publishPart(p.partID); }
    }
    if (event.type === 'session.status') {
      if (p.status?.type === 'busy') { observedRun = true;setBusy(true, undefined, 'waiting'); }
      if (p.status?.type === 'retry') setBusy(true, p.status.message, 'retrying');
      if (p.status?.type === 'idle' && observedRun) { observedRun = false;setBusy(false); }
    }
    if (event.type === 'session.idle' && observedRun) { observedRun = false;setBusy(false); }
    if (event.type === 'session.error') {
      observedRun = false;setBusy(false);if (p.error?.name !== 'MessageAbortedError') reportError(p.error?.data?.message || p.error?.message || p.error?.name || 'OpenCode side reply failed.');
    }
    if (event.type === 'permission.asked') {
      void client.request('POST', `/permission/${encodeURIComponent(p.id)}/reply`, {
        reply: input.permissionMode === 'bypassPermissions' ? 'once' : 'reject',
      }).catch(reportError);
    }
    if (event.type === 'question.asked') void client.request('POST', `/question/${encodeURIComponent(p.id)}/reject`).catch(reportError);
  };
  const disconnected = (error: unknown) => { reportError(error);void close(); };
  client.on('notification', notification);client.on('disconnect', disconnected);

  function close(): Promise<void> {
    if (closing) return closing;
    ended = true;client.off('notification', notification);client.off('disconnect', disconnected);
    closing = client.close().finally(() => { roles.clear();parts.clear();inheritedMessageIds.clear();emit({ kind: 'btw_closed' }); });
    return closing;
  }
  async function send(content: string): Promise<void> {
    if (ended) throw new Error('The temporary conversation has ended.');
    if (!id || busy) throw new Error('Wait for the current side reply to finish.');
    const question = content.trim();if (!question || question.length > 32_000) throw new Error('A side question must contain 1–32000 characters.');
    setBusy(true, undefined, 'waiting');observedRun = false;
    sendEvent({ kind: 'btw_message', id: randomUUID(), role: 'user', content: question });
    const model = input.model?.split('/');
    try {
      starting = client.request('POST', `/session/${encodeURIComponent(id)}/prompt_async`, {
        parts: [{ type: 'text', text: question }],
        ...(model && model.length >= 2 ? { model: { providerID: model[0], modelID: model.slice(1).join('/') } } : {}),
        ...(input.effort && input.effort !== 'default' ? { variant: input.effort } : {}),
        ...(input.permissionMode === 'plan' ? { agent: 'plan' } : {}),
        system: 'This is a temporary side conversation. Use the inherited conversation as background and answer the current side question. Ask clarifying questions in ordinary replies.',
      });
      await starting;
    } catch (error) { setBusy(false);throw error; }
    finally { starting = null; }
  }
  return {
    async start() {
      try {
        setBusy(true);const fork = await client.initialize();if (ended) return;
        const history = await client.request('GET', `/session/${encodeURIComponent(fork.id)}/message`);
        if (ended) return;
        if (!Array.isArray(history)) throw new Error('OpenCode could not identify the inherited side-conversation messages.');
        for (const message of history) if (typeof message?.info?.id === 'string') inheritedMessageIds.add(message.info.id);
        id = fork.id;sendEvent({ kind: 'btw_ready', threadId: id, model: input.model || '' });setBusy(false);
        if (input.question?.trim()) await send(input.question);
      } catch (error) { reportError(error);await close(); }
    },
    send,
    async stop() { await starting?.catch(() => {});if (id && busy && !ended) await client.request('POST', `/session/${encodeURIComponent(id)}/abort`); },
    close,
  };
}
