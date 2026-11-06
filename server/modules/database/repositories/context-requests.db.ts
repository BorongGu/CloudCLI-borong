import { getConnection } from '@/modules/database/connection.js';
import type { ContextRequest, ContextRequestInput } from '@/shared/index.js';

const COLUMNS = 'id, input, status, snapshot_id AS snapshotId, package_id AS packageId, target_session_id AS targetSessionId, delivery_id AS deliveryId, delivery_key AS deliveryKey, error, created_at AS createdAt';
function decode(row: unknown): ContextRequest | null {
  if (!row) return null;
  const data = row as Omit<ContextRequest, 'input'> & { input: string };
  return { ...data, input: JSON.parse(data.input) as ContextRequestInput };
}

/** The context-request service uses persisted claims and scoped credentials across browser reconnects. */
export const contextRequestsDb = {
  create(userId: number, id: string, input: ContextRequestInput, tokenHash: string): ContextRequest {
    getConnection().prepare('INSERT INTO context_requests (id, user_id, source_session_id, request_id, input, token_hash, token_expires_at, delivery_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, userId, input.sourceSessionId, input.requestId, JSON.stringify(input), tokenHash, new Date(Date.now() + 86400000).toISOString(), `context-request:${id}`, new Date().toISOString());
    return this.get(userId, id)!;
  },
  get(userId: number, id: string): ContextRequest | null {
    return decode(getConnection().prepare(`SELECT ${COLUMNS} FROM context_requests WHERE user_id = ? AND id = ?`).get(userId, id));
  },
  byRequest(userId: number, requestId: string): ContextRequest | null {
    return decode(getConnection().prepare(`SELECT ${COLUMNS} FROM context_requests WHERE user_id = ? AND request_id = ?`).get(userId, requestId));
  },
  latest(userId: number, sourceSessionId: string): ContextRequest | null {
    return decode(getConnection().prepare(`SELECT ${COLUMNS} FROM context_requests WHERE user_id = ? AND source_session_id = ? ORDER BY rowid DESC LIMIT 1`).get(userId, sourceSessionId));
  },
  active(sourceSessionId: string): boolean {
    return Boolean(getConnection().prepare("SELECT 1 FROM context_requests WHERE source_session_id = ? AND status IN ('queued','preparing','analyzing','ready','delivering')").get(sourceSessionId));
  },
  pending(): Array<{ userId: number; request: ContextRequest }> {
    const rows = getConnection().prepare(`SELECT user_id AS userId, ${COLUMNS} FROM context_requests WHERE status IN ('queued','preparing','analyzing','ready','delivering') ORDER BY rowid`).all() as Array<{ userId: number }>;
    return rows.map(row => ({ userId: row.userId, request: decode(row)! }));
  },
  authenticate(id: string, tokenHash: string): number | null {
    const row = getConnection().prepare("SELECT r.user_id AS userId FROM context_requests r JOIN users u ON u.id = r.user_id WHERE r.id = ? AND r.token_hash = ? AND r.token_expires_at > ? AND u.is_active = 1 AND (r.status IN ('analyzing','ready','delivering','completed') OR (r.status = 'failed' AND r.package_id IS NOT NULL))").get(id, tokenHash, new Date().toISOString()) as { userId: number } | undefined;
    return row?.userId ?? null;
  },
  update(id: string, fields: Partial<Pick<ContextRequest, 'status' | 'snapshotId' | 'packageId' | 'targetSessionId' | 'deliveryId' | 'deliveryKey' | 'error'>>, expected?: ContextRequest['status']): boolean {
    const columns = { status: 'status', snapshotId: 'snapshot_id', packageId: 'package_id', targetSessionId: 'target_session_id', deliveryId: 'delivery_id', deliveryKey: 'delivery_key', error: 'error' };
    const entries = Object.entries(fields) as Array<[keyof typeof columns, string | null]>;
    return getConnection().prepare(`UPDATE context_requests SET ${entries.map(([key]) => `${columns[key]} = ?`).join(', ')} WHERE id = ?${expected ? ' AND status = ?' : ''}`)
      .run(...entries.map(([, value]) => value), id, ...(expected ? [expected] : [])).changes > 0;
  },
  rotateToken(id: string, hash: string): void { getConnection().prepare('UPDATE context_requests SET token_hash = ?, token_expires_at = ? WHERE id = ?').run(hash, new Date(Date.now() + 86400000).toISOString(), id); },
  recover(): void { getConnection().prepare("UPDATE context_requests SET status = 'queued' WHERE status = 'preparing'").run(); },
};
