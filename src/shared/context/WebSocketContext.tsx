import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '@/modules/auth';
import { IS_PLATFORM } from '@/shared/utils';
import { expireAuthSession, isAuthTokenExpired } from '@/shared/authToken';
import type { ServerEvent } from '@/shared/types';


type ServerEventListener = (event: ServerEvent) => void;

/**
 * Where the chat socket stands. `connecting` covers a handshake the provider
 * started on purpose (after sign-in, or with a refreshed token) and the time
 * signed out; `disconnected` a socket that closed on its own (it dropped, or an
 * attempt failed) until a reconnect opens again.
 */
type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

type WebSocketContextType = {
  ws: WebSocket | null;
  /** Returns whether the frame was handed to an open socket. */
  sendMessage: (message: unknown) => boolean;
  /**
   * Subscribes to every websocket frame. Returns an unsubscribe function.
   *
   * This is the primary consumption API: events are dispatched synchronously
   * to every listener, so rapid back-to-back frames cannot be coalesced or
   * dropped. Frames are deliberately not copied into React state; each
   * listener updates only the state owned by the feature that handles it.
   */
  subscribe: (listener: ServerEventListener) => () => void;
  isConnected: boolean;
  /**
   * Lets the UI tell a lost connection (`disconnected`, reconnecting every few
   * seconds) apart from the first handshake (`connecting`), so it can show the
   * former without flashing on every page load. A socket the provider replaces
   * on purpose, such as on a token refresh, reports `connecting` until the new
   * one opens, never `disconnected`.
   */
  connectionStatus: ConnectionStatus;
};

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};

const buildWebSocketUrl = (token: string | null) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (IS_PLATFORM) return `${protocol}//${window.location.host}/ws`; // Platform mode: Use same domain as the page (goes through proxy)
  if (!token) return null;
  if (isAuthTokenExpired(token)) {
    expireAuthSession();
    return null;
  }
  return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`; // OSS mode: Use same host:port that served the page
};

const useWebSocketProviderState = (): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  const unmountedRef = useRef(false); // Track if component is unmounted
  const hasConnectedRef = useRef(false); // Track if we've ever connected (to detect reconnects)
  /**
   * Listener registry for the subscribe API. A ref (not state) because the
   * set must be readable synchronously inside `onmessage` and never trigger
   * re-renders of the provider tree.
   */
  const listenersRef = useRef(new Set<ServerEventListener>());
  // Drives `isConnected` and the workspace header's "Reconnecting" indicator.
  // Three values rather than a boolean: a first handshake still in flight must
  // not read as a lost connection, or every page load would flash the indicator.
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting');
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const { isLoading: isAuthLoading, token, user } = useAuth();

  const dispatch = useCallback((event: ServerEvent) => {
    for (const listener of listenersRef.current) {
      try {
        listener(event);
      } catch (error) {
        console.error('WebSocket listener error:', error);
      }
    }
  }, []);

  // Named function expression so the reconnect timer below can call itself
  // without reading the `connect` binding while it is still initializing.
  const connect = useCallback(function connect() {
    if (unmountedRef.current) return; // Prevent connection if unmounted
    if (!IS_PLATFORM && (isAuthLoading || !user)) return;
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN
      || wsRef.current.readyState === WebSocket.CONNECTING)) return;
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    const scheduleReconnect = () => {
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = setTimeout(() => {
        reconnectTimeoutRef.current = null;
        connect();
      }, 3000);
    };
    try {
      // Construct WebSocket URL
      const wsUrl = buildWebSocketUrl(token);

      if (!wsUrl) return console.warn('No authentication token found for WebSocket connection');

      const websocket = new WebSocket(wsUrl);
      // Store connecting sockets too, so a token refresh can close them before
      // their handshake completes with stale credentials.
      wsRef.current = websocket;
      // A stalled mobile handshake must eventually free the retry path.
      const handshakeTimeout = setTimeout(() => {
        if (wsRef.current !== websocket || websocket.readyState !== WebSocket.CONNECTING) return;
        wsRef.current = null;
        setConnectionStatus('disconnected');
        websocket.close();
        scheduleReconnect();
      }, 10_000);

      websocket.onopen = () => {
        clearTimeout(handshakeTimeout);
        if (wsRef.current !== websocket) return;
        setConnectionStatus('connected');
        if (hasConnectedRef.current) {
          // This is a reconnect — signal so components can catch up on missed messages
          dispatch({ kind: 'websocket_reconnected', timestamp: Date.now() });
        }
        hasConnectedRef.current = true;
      };

      websocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as ServerEvent;
          dispatch(data);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      websocket.onclose = () => {
        clearTimeout(handshakeTimeout);
        if (wsRef.current !== websocket) {
          return;
        }
        // Also reached when the very first attempt fails, which is a lost
        // connection too. The effect cleanup detaches this handler before
        // closing a socket on purpose, so a token refresh never gets here.
        setConnectionStatus('disconnected');
        wsRef.current = null;

        // Attempt to reconnect after 3 seconds
        scheduleReconnect();
      };

      websocket.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

    } catch (error) {
      console.error('Error creating WebSocket connection:', error);
      setConnectionStatus('disconnected');
      scheduleReconnect();
    }
  }, [dispatch, isAuthLoading, token, user]); // reconnect with current authentication state

  // Declared after `connect` so the effect body does not reference it before
  // initialization. `connect` is memoized on [dispatch, isAuthLoading, token,
  // user] and `dispatch` is stable, so depending on it reconnects on exactly
  // the same transitions as the previous [isAuthLoading, token, user] list.
  useEffect(() => {
    // The cleanup below sets unmountedRef = true. Without this reset, every
    // re-run of the effect (e.g. on token refresh) would short-circuit connect()
    // at its unmounted guard and leave the socket permanently disconnected.
    unmountedRef.current = false;
    if (!IS_PLATFORM && (isAuthLoading || !user)) {
      return undefined;
    }
    connect();

    return () => {
      unmountedRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      const activeSocket = wsRef.current;
      if (activeSocket) {
        // Prevent the intentionally closed, old-token socket from scheduling
        // a reconnect after the refreshed-token effect has already started.
        activeSocket.onopen = null;
        activeSocket.onmessage = null;
        activeSocket.onclose = null;
        activeSocket.onerror = null;
        activeSocket.close();
        wsRef.current = null;
      }
      // What comes next is a socket with a refreshed token, or none after a
      // sign-out or session expiry. Either way it starts from a fresh
      // handshake: the socket closed here is no longer live, and a drop seen
      // before must not show as "Reconnecting" after the next sign-in.
      setConnectionStatus('connecting');
    };
  }, [connect, isAuthLoading, user]); // reconnect after authentication or token refresh

  useEffect(() => {
    // Safari can retain an OPEN socket after suspending the page. Replace
    // that transport on return; session replay restores the running output.
    let wasHidden = document.visibilityState === 'hidden';
    const recover = (event: Event) => {
      if (document.visibilityState === 'hidden') { wasHidden = true; return; }
      const replace = wasHidden || event.type === 'online'
        || (event.type === 'pageshow' && (event as PageTransitionEvent).persisted);
      wasHidden = false;
      if (replace && wsRef.current) {
        const previous = wsRef.current;
        wsRef.current = null;
        setConnectionStatus('disconnected');
        previous.close();
      }
      if (hasConnectedRef.current && (!wsRef.current
        || wsRef.current.readyState === WebSocket.CLOSED
        || wsRef.current.readyState === WebSocket.CLOSING)) {
        setConnectionStatus('disconnected');
      }
      connect();
    };
    document.addEventListener('visibilitychange', recover);
    window.addEventListener('pageshow', recover);
    window.addEventListener('online', recover);
    window.addEventListener('focus', recover);
    return () => {
      document.removeEventListener('visibilitychange', recover);
      window.removeEventListener('pageshow', recover);
      window.removeEventListener('online', recover);
      window.removeEventListener('focus', recover);
    };
  }, [connect]);

  const sendMessage = useCallback((message: unknown) => {
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify(message));
        return true;
      } catch (error) {
        console.error('WebSocket send failed:', error);
        wsRef.current = null;
        setConnectionStatus('disconnected');
        socket.close();
      }
    }
    setConnectionStatus('disconnected');
    connect();
    return false;
  }, [connect]);

  const subscribe = useCallback((listener: ServerEventListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const value: WebSocketContextType = useMemo(() =>
  ({
    ws: wsRef.current,
    sendMessage,
    subscribe,
    isConnected: connectionStatus === 'connected',
    connectionStatus,
  }), [sendMessage, subscribe, connectionStatus]);

  return value;
};

/** Mounted once by App; owns the single chat websocket that the chat, project-workspace and task-master modules subscribe to. */
export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const webSocketData = useWebSocketProviderState();

  return (
    <WebSocketContext.Provider value={webSocketData}>
      {children}
    </WebSocketContext.Provider>
  );
};

export default WebSocketContext;
