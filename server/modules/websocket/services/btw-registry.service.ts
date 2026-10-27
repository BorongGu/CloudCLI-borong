import { createBtwSession } from '@/modules/providers/index.js';
import type { BtwEvent, BtwInput, BtwSession } from '@/shared/types.js';

type Conversation = {
  session: BtwSession;
  sourceId: string;
  listeners: Set<(event: BtwEvent) => void>;
  messages: Map<string, Extract<BtwEvent, { kind: 'btw_message' }>>;
  ready?: Extract<BtwEvent, { kind: 'btw_ready' }>;
  status: Extract<BtwEvent, { kind: 'btw_status' }>;
  error?: Extract<BtwEvent, { kind: 'btw_error' }>;
  closed: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

/** The BTW socket handler uses this registry to reconnect a user's window to its existing native fork. */
export function createBtwRegistry(createSession = createBtwSession, retentionMs = 30 * 60_000) {
  const conversations = new Map<string, Conversation>();
  const key = (owner: string, id: string) => JSON.stringify([owner, id]);
  const find = (owner: string, id: string) => {
    const entry = conversations.get(key(owner, id));
    if (!entry) throw new Error('This temporary conversation has expired. Open a new /btw window.');
    return entry;
  };
  const publish = (entry: Conversation, event: BtwEvent) => {
    if (event.kind === 'btw_ready') entry.ready = event;
    if (event.kind === 'btw_message') { entry.messages.set(event.id, event);entry.error = undefined; }
    if (event.kind === 'btw_error') entry.error = event;
    if (event.kind === 'btw_status') {
      event = { ...event, busySince: event.busy && !entry.status.busy ? Date.now() : entry.status.busySince };
      entry.status = event;
    }
    if (event.kind === 'btw_closed') {
      if (entry.closed) return;
      entry.closed = true;
    }
    for (const listener of entry.listeners) listener(event);
  };
  const finish = async (owner: string, id: string) => {
    const entry = conversations.get(key(owner, id));
    if (!entry) return;
    conversations.delete(key(owner, id));
    clearTimeout(entry.timer);
    try { await entry.session.close(); }
    finally { publish(entry, { kind: 'btw_closed' });entry.listeners.clear();entry.messages.clear(); }
  };
  return {
    attach(owner: string, id: string, emit: (event: BtwEvent) => void, input?: BtwInput) {
      let entry = conversations.get(key(owner, id));
      if (entry && input && entry.sourceId !== input.sessionId) throw new Error('This BTW window belongs to another source conversation.');
      if (!entry) {
        if (!input) find(owner, id);
        const fresh: Conversation = { session: null as unknown as BtwSession, sourceId: input!.sessionId,
          listeners: new Set(), messages: new Map(), closed: false,
          status: { kind: 'btw_status', busy: true, busySince: Date.now() } };
        fresh.session = createSession(input!, event => publish(fresh, event));
        entry = fresh;
        conversations.set(key(owner, id), entry);
        // Register first so a refresh racing native startup attaches to this same fork.
        void Promise.resolve().then(() => { if (!fresh.closed) return fresh.session.start(); }).catch(error => {
          publish(fresh, { kind: 'btw_error', message: error instanceof Error ? error.message : String(error) });
          void fresh.session.close().finally(() => publish(fresh, { kind: 'btw_closed' })).catch(() => {});
        });
      }
      const current = entry;
      clearTimeout(current.timer);
      current.listeners.add(emit);
      emit({ kind: 'btw_attached', conversationId: id });
      if (current.ready) emit(current.ready);
      for (const message of current.messages.values()) emit(message);
      emit(current.status);
      if (current.error) emit(current.error);
      if (current.closed) emit({ kind: 'btw_closed' });
      return () => {
        current.listeners.delete(emit);
        if (current.listeners.size || conversations.get(key(owner, id)) !== current) return;
        clearTimeout(current.timer);
        current.timer = setTimeout(() => { void finish(owner, id).catch(() => {}); }, retentionMs);
        current.timer.unref();
      };
    },
    async send(owner: string, id: string, content: string) { await find(owner, id).session.send(content); },
    async stop(owner: string, id: string) { await find(owner, id).session.stop(); },
    finish,
  };
}

/** Shared by all authenticated BTW sockets so a refreshed tab can resume its previous connection. */
export const btwRegistry = createBtwRegistry();
