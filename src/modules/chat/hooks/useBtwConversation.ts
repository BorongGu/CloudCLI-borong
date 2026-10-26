import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { BtwMessage, BtwRequest } from '@/shared/types';

/** The chat BTW panel uses a separate socket so its lifecycle and output stay local to the window. */
export function useBtwConversation(request: BtwRequest) {
  // Keep only the temporary window's visible transcript and transport status.
  const [view, setView] = useState({ messages: [] as BtwMessage[], ready: false, busy: true, closed: false, error: '', label: '' });
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let disposed = false;
    const socket = new WebSocket(api.btwSocketUrl());
    socketRef.current = socket;
    socket.onopen = () => {
      if (!disposed) socket.send(JSON.stringify({ type: 'start', sessionId: request.sessionId, question: request.question,
        model: request.model, effort: request.effort }));
    };
    socket.onmessage = event => {
      if (disposed) return;
      let data: any;
      try { data = JSON.parse(String(event.data)); } catch { return; }
      if (data.kind === 'btw_ready') setView(v => ({ ...v, ready: true }));
      if (data.kind === 'btw_status') setView(v => ({ ...v, busy: Boolean(data.busy), label: data.label || '' }));
      if (data.kind === 'btw_error') setView(v => ({ ...v, error: String(data.message || '') }));
      if (data.kind === 'btw_closed') { setView(v => ({ ...v, busy: false, closed: true })); socket.close(); }
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
      if (!disposed) setView(v => ({ ...v, busy: false, closed: true }));
    };
    socket.onerror = () => {
      if (!disposed) setView(v => ({ ...v, busy: false, closed: true }));
      socket.close();
    };
    return () => {
      disposed = true;
      // Closing during the handshake closes the socket as soon as it opens.
      // An established connection also receives an explicit finish before close.
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'finish' }));
      socket.onopen = () => socket.close();
      if (socket.readyState !== WebSocket.CONNECTING) socket.close();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [request]);

  const send = useCallback((content: string) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ type: 'send', content }));
    setView(v => ({ ...v, busy: true, error: '', label: '' }));
    return true;
  }, []);
  const stop = useCallback(() => {
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ type: 'stop' }));
  }, []);
  return { ...view, send, stop };
}
