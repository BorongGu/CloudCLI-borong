import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { BtwMessage, BtwRequest } from '@/shared/types';

type ConversationView = { messages: BtwMessage[]; ready: boolean; busy: boolean; busySince: number;
  closed: boolean; error: string; label: string; phase: string };
type SavedConversation = { registered: boolean; draft: string; view: ConversationView };

function readConversation(key: string): SavedConversation | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (value && typeof value.registered === 'boolean' && typeof value.draft === 'string'
      && value.view && Array.isArray(value.view.messages) && value.view.messages.every((message: any) =>
        typeof message.id === 'string' && typeof message.content === 'string' && ['user', 'assistant'].includes(message.role))
      && Number.isFinite(value.view.busySince)) return value;
  } catch { /* Browser storage is optional for the live conversation. */ }
  return null;
}

/** Each mounted BtwPanel retains its source's native conversation, transcript and draft across navigation and refresh. */
export function useBtwConversation(request: BtwRequest) {
  const storageKey = `cloudcli-btw-conversation:${request.key}`;
  // A single checkpoint restores the transcript, draft and attachment identity together.
  const [snapshot, setSnapshot] = useState<SavedConversation>(() => {
    const saved = readConversation(storageKey);
    return { registered: saved?.registered ?? false, draft: saved?.draft ?? '', view: {
      messages: saved?.view.messages ?? [], ready: false, busy: !saved?.view.closed,
      busySince: saved?.view.busySince ?? Date.now(), closed: saved?.view.closed ?? false,
      error: saved?.view.error ?? '', label: '', phase: saved?.registered ? 'reconnecting' : '',
    } };
  });
  const { view, draft } = snapshot;
  const socketRef = useRef<WebSocket | null>(null);
  const finishedRef = useRef(view.closed);
  const removedRef = useRef(false);
  const checkpointRef = useRef(snapshot);
  const updateSnapshot = useCallback((update: (current: SavedConversation) => SavedConversation) => {
    // Flush pagehide from the latest frame even when React is still batching its render.
    const next = update(checkpointRef.current);
    checkpointRef.current = next;
    setSnapshot(next);
  }, []);
  const setView = useCallback((update: (current: ConversationView) => ConversationView) => {
    updateSnapshot(current => ({ ...current, view: update(current.view) }));
  }, [updateSnapshot]);
  const setDraft = useCallback((content: string) => {
    updateSnapshot(current => ({ ...current, draft: content }));
  }, [updateSnapshot]);
  const persist = useCallback(() => {
    if (removedRef.current) return;
    try { sessionStorage.setItem(storageKey, JSON.stringify(checkpointRef.current)); }
    catch { /* A full browser store leaves the active native conversation usable. */ }
  }, [storageKey]);
  useEffect(() => {
    const timer = setTimeout(persist, 250);
    return () => { clearTimeout(timer); };
  }, [view, draft, persist]);

  useEffect(() => {
    removedRef.current = false;
    let disposed = false;
    let unloading = false;
    let retry: number | undefined;
    let retryDelay = 500;
    const connect = () => {
      window.clearTimeout(retry);
      if (disposed || unloading || finishedRef.current || socketRef.current?.readyState === WebSocket.OPEN
        || socketRef.current?.readyState === WebSocket.CONNECTING) return;
      const socket = new WebSocket(api.btwSocketUrl());
      socketRef.current = socket;
      socket.onopen = () => {
        if (disposed || unloading || finishedRef.current) { socket.close();return; }
        retryDelay = 500;
        socket.send(JSON.stringify(checkpointRef.current.registered
          ? { type: 'resume', conversationId: request.key }
          : { type: 'start', conversationId: request.key, sessionId: request.sessionId, question: request.question,
            model: request.model, effort: request.effort, permissionMode: request.permissionMode }));
      };
      socket.onmessage = event => {
        if (disposed || unloading || socketRef.current !== socket) return;
        let data: any;
        try { data = JSON.parse(String(event.data)); } catch { return; }
        if (data.kind === 'btw_attached' || data.kind === 'btw_ready') {
          updateSnapshot(current => ({ ...current, registered: true }));persist();
        }
        if (data.kind === 'btw_ready') setView(v => ({ ...v, ready: true, closed: false }));
        if (data.kind === 'btw_status') setView(v => ({ ...v, busy: Boolean(data.busy),
          busySince: Number.isFinite(data.busySince) ? data.busySince : data.busy && !v.busy ? Date.now() : v.busySince,
          label: data.label || '', phase: data.phase || '' }));
        if (data.kind === 'btw_error') setView(v => ({ ...v, error: String(data.message || '') }));
        if (data.kind === 'btw_closed') {
          finishedRef.current = true;setView(v => ({ ...v, busy: false, closed: true }));socket.close();
        }
        if (data.kind === 'btw_message' && typeof data.id === 'string' && typeof data.content === 'string'
          && (data.role === 'user' || data.role === 'assistant')) {
          const message: BtwMessage = { id: data.id, role: data.role, content: data.content };
          setView(v => {
            const messages = [...v.messages];const index = messages.findIndex(m => m.id === message.id);
            if (index < 0) messages.push(message); else messages[index] = message;
            return { ...v, messages, error: '' };
          });
        }
      };
      socket.onclose = () => {
        if (socketRef.current !== socket) return;
        socketRef.current = null;
        if (disposed || unloading || finishedRef.current) return;
        setView(v => ({ ...v, ready: false, busy: true, phase: 'reconnecting' }));
        retry = window.setTimeout(connect, retryDelay);retryDelay = Math.min(retryDelay * 2, 10_000);
      };
      socket.onerror = () => { socket.close(); };
    };
    const hide = () => { unloading = true;persist();window.clearTimeout(retry);socketRef.current?.close(); };
    const resume = () => {
      if (document.visibilityState === 'hidden') { persist();return; }
      unloading = false;connect();
    };
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', resume);
    window.addEventListener('online', resume);
    document.addEventListener('visibilitychange', resume);
    connect();
    return () => {
      disposed = true;window.clearTimeout(retry);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', resume);
      window.removeEventListener('online', resume);
      document.removeEventListener('visibilitychange', resume);
      const socket = socketRef.current;
      // A refresh detaches; component replacement or an explicit close finishes the old window.
      if (!unloading && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'finish' }));
      if (socket) {
        socket.onopen = () => socket.close();
        if (socket.readyState !== WebSocket.CONNECTING) socket.close();
      }
      socketRef.current = null;
      if (!unloading) { removedRef.current = true;try { sessionStorage.removeItem(storageKey); } catch {} }
    };
  }, [request, storageKey, persist, setView, updateSnapshot]);

  const send = useCallback((content: string) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || finishedRef.current) return false;
    socket.send(JSON.stringify({ type: 'send', content }));
    setView(v => ({ ...v, busy: true, busySince: Date.now(), error: '', label: '', phase: 'waiting' }));
    return true;
  }, [setView]);
  const stop = useCallback(() => {
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ type: 'stop' }));
  }, []);
  return { ...view, draft, setDraft, send, stop };
}
