import { getConnection } from '@/modules/database/connection.js';
import type { ContextDelivery, ContextPackage, ContextSnapshot } from '@/shared/index.js';

const DELIVERY_COLUMNS = 'id, package_id AS packageId, target_session_id AS targetSessionId, request_id AS requestId, mode, instruction, status, error, created_at AS createdAt';

/** Context transfer owns snapshots/packages; Providers atomically consumes pending attachments before a run. */
export const contextTransferDb = {
  saveSnapshot(userId: number, snapshot: ContextSnapshot): void {
    getConnection().prepare('INSERT INTO context_snapshots (id, user_id, source_session_id, payload, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(snapshot.id, userId, snapshot.sourceSessionId, JSON.stringify(snapshot), snapshot.createdAt);
  },
  snapshot(userId: number, id: string): ContextSnapshot | null {
    const row = getConnection().prepare('SELECT payload FROM context_snapshots WHERE id = ? AND user_id = ?').get(id, userId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : null;
  },
  savePackage(userId: number, value: ContextPackage): void {
    getConnection().prepare('INSERT INTO context_packages (id, user_id, snapshot_id, payload, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(value.id, userId, value.snapshotId, JSON.stringify(value), value.createdAt);
  },
  package(userId: number, id: string): ContextPackage | null {
    const row = getConnection().prepare('SELECT payload FROM context_packages WHERE id = ? AND user_id = ?').get(id, userId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : null;
  },
  insertDelivery(userId: number, delivery: ContextDelivery, prompt: string): void {
    getConnection().prepare(`INSERT INTO context_deliveries (id, user_id, package_id, target_session_id, request_id, mode, instruction, status, prompt, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(delivery.id, userId, delivery.packageId, delivery.targetSessionId, delivery.requestId, delivery.mode, delivery.instruction, delivery.status, prompt, delivery.createdAt);
  },
  delivery(userId: number, id: string): ContextDelivery | null {
    return getConnection().prepare(`SELECT ${DELIVERY_COLUMNS} FROM context_deliveries WHERE id = ? AND user_id = ?`).get(id, userId) as ContextDelivery || null;
  },
  byRequest(userId: number, requestId: string): ContextDelivery | null {
    return getConnection().prepare(`SELECT ${DELIVERY_COLUMNS} FROM context_deliveries WHERE user_id = ? AND request_id = ?`).get(userId, requestId) as ContextDelivery || null;
  },
  settle(id: string, status: ContextDelivery['status'], error: string | null = null): void {
    getConnection().prepare('UPDATE context_deliveries SET status = ?, error = ? WHERE id = ?').run(status, error, id);
  },
  cancel(userId: number, id: string): boolean {
    return getConnection().prepare("UPDATE context_deliveries SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'pending'").run(id, userId).changes > 0;
  },
  claim(sessionId: string): Array<{ id: string; prompt: string }> {
    const db = getConnection();
    return db.transaction(() => {
      const rows = db.prepare("SELECT id, prompt FROM context_deliveries WHERE target_session_id = ? AND mode IN ('attach', 'start') AND status = 'pending' ORDER BY created_at, rowid").all(sessionId) as Array<{ id: string; prompt: string }>;
      let characters = 0;
      const selected = rows.filter(row => { characters += row.prompt.length; return characters <= 240_000; });
      for (const row of selected) this.settle(row.id, 'submitting');
      return selected;
    })();
  },
  recover(): void {
    getConnection().prepare("UPDATE context_deliveries SET status = 'uncertain', error = 'Orbit restarted during submission; inspect the target session.' WHERE status = 'submitting'").run();
  },
  removeSnapshot(userId: number, id: string): string[] | null {
    const db = getConnection();
    return db.transaction(() => {
      const active = db.prepare("SELECT 1 FROM context_deliveries d JOIN context_packages p ON p.id = d.package_id WHERE p.snapshot_id = ? AND p.user_id = ? AND d.status = 'submitting'").get(id, userId);
      if (active) return null;
      const rows = db.prepare('SELECT id FROM context_packages WHERE snapshot_id = ? AND user_id = ?').all(id, userId) as Array<{ id: string }>;
      db.prepare('DELETE FROM context_snapshots WHERE id = ? AND user_id = ?').run(id, userId);
      return rows.map(row => row.id);
    })();
  },
};
