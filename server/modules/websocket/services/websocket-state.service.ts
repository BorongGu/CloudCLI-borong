import type { RealtimeClientConnection } from '@/shared/types.js';
import { readObjectRecord } from '@/shared/utils.js';

/**
 * Numeric readyState for an open WebSocket connection.
 *
 * We keep this in module state so services that broadcast updates do not need
 * to import `ws` directly just to compare open/closed state.
 */
export const WS_OPEN_STATE = 1;

/**
 * Shared registry of active chat WebSocket connections.
 *
 * Project/session services publish realtime updates by iterating this set.
 */
export const connectedClients = new Set<RealtimeClientConnection>();

// Questions outlive individual turns. Keep their audience attached to the socket's
// session subscriptions even after the run and its replay buffer are released.
const sessionSubscriptions = new WeakMap<RealtimeClientConnection, Set<string>>();

/** Chat subscriptions register viewers for question updates across active and idle sessions. */
export function subscribeToSession(connection: RealtimeClientConnection, sessionId: string): void {
  let sessions = sessionSubscriptions.get(connection);
  if (!sessions) {
    sessions = new Set();
    sessionSubscriptions.set(connection, sessions);
  }
  sessions.add(sessionId);
}

/** Chat writers and native question recovery deliver each permission update to all session viewers once. */
export function broadcastSessionPermission(
  sessionId: string,
  message: unknown,
  additionalConnections: Iterable<RealtimeClientConnection> = [],
): void {
  const event = readObjectRecord(message);
  if (!event) return;
  const recipients = new Set(additionalConnections);
  for (const connection of connectedClients) {
    if (sessionSubscriptions.get(connection)?.has(sessionId)) recipients.add(connection);
  }
  const payload = JSON.stringify({ ...event, sessionId });
  for (const connection of recipients) {
    if (connection.readyState === WS_OPEN_STATE) connection.send(payload);
  }
}
