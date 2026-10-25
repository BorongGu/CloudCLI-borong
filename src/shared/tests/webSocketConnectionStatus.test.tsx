import assert from 'node:assert/strict';

import { act, render } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

/**
 * Issue #582: when the chat socket dropped, nothing in the UI changed, so a
 * message typed during the outage was lost without the user noticing. The
 * provider now reports `connectionStatus`, which tells a lost connection
 * (`disconnected`) apart from the first handshake (`connecting`, which must not
 * flash a warning on every page load) and from the socket it swaps on purpose
 * when the auth token is refreshed (which must not read as lost either).
 */

type FakeAuth = { user: { id: number } | null; token: string | null; isLoading: boolean };

// Mutable so a test can hand the provider a refreshed token or sign the user
// out. `user` keeps one identity throughout; a fresh object would rebuild
// `connect` on every render.
const AUTH = vi.hoisted(() => {
  const user = { id: 1 };
  return { user, current: { user, token: 'token-1', isLoading: false } as FakeAuth };
});

vi.mock('@/modules/auth', () => ({
  useAuth: () => AUTH.current,
}));

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  sent: string[] = [];

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(message: string) { this.sent.push(message); }

  // A real socket closed by the page still fires `close`; firing it here means
  // a swap that forgot to detach its handler would be caught.
  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  serverOpens() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  /** The network or the server ends the socket (or refuses the handshake). */
  serverDrops() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

const { WebSocketProvider, useWebSocket } = await import('@/shared/context/WebSocketContext');

/** Every status the provider rendered, in order, so a one-render flash is caught too. */
let seen: string[] = [];
let isConnected: boolean | null = null;
let connection: ReturnType<typeof useWebSocket>;

function RecordStatus() {
  const value = useWebSocket();
  seen.push(String(value.connectionStatus));
  useEffect(() => {
    connection = value;
    isConnected = value.isConnected;
  });
  return null;
}

const renderProvider = () => render(<WebSocketProvider><RecordStatus /></WebSocketProvider>);
const socket = (index: number) => FakeWebSocket.instances[index] as FakeWebSocket;
const lastStatus = () => seen[seen.length - 1];

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  seen = [];
  isConnected = null;
  AUTH.current = { user: AUTH.user, token: 'token-1', isLoading: false };
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('the first handshake reads as connecting, never as a lost connection', () => {
  renderProvider();
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(lastStatus(), 'connecting');
  assert.equal(isConnected, false);

  act(() => socket(0).serverOpens());
  assert.equal(lastStatus(), 'connected');
  assert.equal(isConnected, true);
  assert.ok(!seen.includes('disconnected'), `statuses seen: ${seen.join(', ')}`);
});

test('a dropped socket reads as disconnected through every failed retry, until one opens', () => {
  renderProvider();
  act(() => socket(0).serverOpens());

  act(() => socket(0).serverDrops());
  assert.equal(lastStatus(), 'disconnected');
  assert.equal(isConnected, false);

  // The retry is still handshaking: the connection is not back yet.
  act(() => { vi.advanceTimersByTime(3000); });
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(lastStatus(), 'disconnected');

  // The server is still unreachable.
  act(() => socket(1).serverDrops());
  assert.equal(lastStatus(), 'disconnected');

  act(() => { vi.advanceTimersByTime(3000); });
  assert.equal(FakeWebSocket.instances.length, 3);
  act(() => socket(2).serverOpens());
  assert.equal(lastStatus(), 'connected');
  assert.equal(isConnected, true);
});

test('a first attempt that fails reads as disconnected', () => {
  renderProvider();
  act(() => socket(0).serverDrops());
  assert.equal(lastStatus(), 'disconnected');

  act(() => { vi.advanceTimersByTime(3000); });
  act(() => socket(1).serverOpens());
  assert.equal(lastStatus(), 'connected');
});

test('a token refresh swaps the socket without ever reading as a lost connection', () => {
  const view = renderProvider();
  act(() => socket(0).serverOpens());

  AUTH.current = { ...AUTH.current, token: 'token-2' };
  view.rerender(<WebSocketProvider><RecordStatus /></WebSocketProvider>);

  assert.equal(FakeWebSocket.instances.length, 2, 'the refreshed token opened a new socket');
  assert.equal(socket(0).readyState, FakeWebSocket.CLOSED, 'the old-token socket was closed');
  assert.match(socket(1).url, /token=token-2/);
  // The new socket is still handshaking: not live yet, but not lost either.
  assert.equal(lastStatus(), 'connecting');
  assert.equal(isConnected, false);

  // No reconnect was scheduled for the socket closed on purpose.
  act(() => { vi.advanceTimersByTime(3000); });
  assert.equal(FakeWebSocket.instances.length, 2);

  act(() => socket(1).serverOpens());
  assert.equal(lastStatus(), 'connected');
  assert.ok(!seen.includes('disconnected'), `statuses seen: ${seen.join(', ')}`);
});

test('signing out while the socket is down does not carry the drop into the next sign-in', () => {
  const view = renderProvider();
  act(() => socket(0).serverOpens());
  act(() => socket(0).serverDrops());
  assert.equal(lastStatus(), 'disconnected');

  // The session expires (or the user signs out) during the outage.
  AUTH.current = { user: null, token: null, isLoading: false };
  view.rerender(<WebSocketProvider><RecordStatus /></WebSocketProvider>);
  assert.equal(lastStatus(), 'connecting', 'no connection is lost while nobody is signed in');
  act(() => { vi.advanceTimersByTime(3000); });
  assert.equal(FakeWebSocket.instances.length, 1, 'no reconnect while signed out');

  // Signing in again starts a fresh handshake, which must not read as lost.
  seen = [];
  AUTH.current = { user: AUTH.user, token: 'token-2', isLoading: false };
  view.rerender(<WebSocketProvider><RecordStatus /></WebSocketProvider>);
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.ok(!seen.includes('disconnected'), `statuses seen after sign-in: ${seen.join(', ')}`);
  assert.equal(lastStatus(), 'connecting');

  act(() => socket(1).serverOpens());
  assert.equal(lastStatus(), 'connected');
});

test('signing out while connected stops reporting a live connection', () => {
  const view = renderProvider();
  act(() => socket(0).serverOpens());
  assert.equal(isConnected, true);

  AUTH.current = { user: null, token: null, isLoading: false };
  view.rerender(<WebSocketProvider><RecordStatus /></WebSocketProvider>);
  assert.equal(socket(0).readyState, FakeWebSocket.CLOSED, 'the socket was closed on sign-out');
  assert.equal(lastStatus(), 'connecting');
  assert.equal(isConnected, false, 'isConnected no longer reports the closed socket as live');
});

test('a send during disconnection reports failure and immediately starts one reconnect', () => {
  renderProvider();
  act(() => socket(0).serverOpens());
  act(() => socket(0).serverDrops());
  let sent: boolean | undefined;
  act(() => { sent = connection.sendMessage({ type: 'chat.send', content: 'keep my draft' }); });
  assert.equal(sent, false);
  assert.equal(FakeWebSocket.instances.length, 2);
  act(() => { connection.sendMessage({ type: 'chat.subscribe' }); vi.advanceTimersByTime(3000); });
  assert.equal(FakeWebSocket.instances.length, 2, 'one handshake is already in flight');
  assert.deepEqual(socket(1).sent, [], 'failed sends stay with their caller');
  act(() => socket(1).serverOpens());
  act(() => { sent = connection.sendMessage({ type: 'chat.send', content: 'retry' }); });
  assert.equal(sent, true);
  assert.equal(socket(1).sent.length, 1);
});

test('returning to a visible mobile page replaces even a stale OPEN socket', () => {
  renderProvider();
  act(() => socket(0).serverOpens());
  const visibility = vi.spyOn(document, 'visibilityState', 'get');
  visibility.mockReturnValue('hidden');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  assert.equal(FakeWebSocket.instances.length, 1);
  visibility.mockReturnValue('visible');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  assert.equal(socket(0).readyState, FakeWebSocket.CLOSED);
  assert.equal(FakeWebSocket.instances.length, 2);
  act(() => window.dispatchEvent(new Event('focus')));
  assert.equal(FakeWebSocket.instances.length, 2);
  act(() => socket(1).serverOpens());
  assert.equal(isConnected, true);
  visibility.mockRestore();
});

test('a stalled handshake expires and retries instead of blocking mobile recovery', () => {
  renderProvider();
  act(() => vi.advanceTimersByTime(10_000));
  assert.equal(socket(0).readyState, FakeWebSocket.CLOSED);
  assert.equal(lastStatus(), 'disconnected');
  act(() => vi.advanceTimersByTime(3000));
  assert.equal(FakeWebSocket.instances.length, 2);
  act(() => socket(1).serverOpens());
  assert.equal(isConnected, true);
});

test('an online event recovers before a suspended reconnect timer resumes', () => {
  renderProvider();
  act(() => socket(0).serverOpens());
  act(() => socket(0).serverDrops());
  act(() => window.dispatchEvent(new Event('online')));
  assert.equal(FakeWebSocket.instances.length, 2);
  act(() => socket(1).serverOpens());
  act(() => vi.advanceTimersByTime(3000));
  assert.equal(FakeWebSocket.instances.length, 2);
});
