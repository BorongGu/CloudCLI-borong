import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import type { CreateGroupInput, GroupDelivery, GroupMember, GroupMessage, GroupRecord } from '@/shared/index.js';

const GROUP_COLUMNS = 'id, user_id AS userId, name, project_path AS projectPath, paused, turns_remaining AS turnsRemaining, created_at AS createdAt';
const MEMBER_COLUMNS = 'id, group_id AS groupId, name, session_id AS sessionId, provider, model, permission_mode AS permissionMode, seen_seq AS seenSeq';
const MESSAGE_COLUMNS = 'seq, id, group_id AS groupId, sender_id AS senderId, recipient_id AS recipientId, kind, content, title, reply_to AS replyTo, assignments, created_at AS createdAt';

function decodeGroup(row: unknown): GroupRecord | undefined {
  if (!row) return undefined;
  const group = row as GroupRecord;
  return { ...group, paused: Boolean(group.paused) };
}

function decodeMessage(row: unknown): GroupMessage {
  const message = row as Omit<GroupMessage, 'assignments'> & { assignments: string };
  return { ...message, assignments: JSON.parse(message.assignments) as Record<string, string> };
}

/** Used by Groups for atomic membership, immutable messages, and durable delivery state. */
export const groupsDb = {
  create(userId: number, input: CreateGroupInput, members: Array<GroupMember & { tokenHash: string }>): GroupRecord {
    const db = getConnection();
    const id = members[0].groupId;
    db.transaction(() => {
      db.prepare('INSERT INTO agent_groups(id, user_id, name, project_path) VALUES (?, ?, ?, ?)').run(id, userId, input.name, input.projectPath);
      for (const member of members) {
        sessionsDb.createAppSession(member.sessionId, member.provider, input.projectPath, `${input.name} · ${member.name}`);
        db.prepare('INSERT INTO group_members(id, group_id, name, session_id, provider, model, permission_mode, token_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(member.id, id, member.name, member.sessionId, member.provider, member.model, member.permissionMode, member.tokenHash);
      }
    })();
    return this.get(id)!;
  },

  get(id: string): GroupRecord | undefined {
    return decodeGroup(getConnection().prepare(`SELECT ${GROUP_COLUMNS} FROM agent_groups WHERE id = ?`).get(id));
  },

  list(userId: number): GroupRecord[] {
    return getConnection().prepare(`SELECT ${GROUP_COLUMNS} FROM agent_groups WHERE user_id = ? ORDER BY created_at DESC, id`).all(userId).map(row => decodeGroup(row)!);
  },

  members(groupId: string): GroupMember[] {
    return getConnection().prepare(`SELECT ${MEMBER_COLUMNS} FROM group_members WHERE group_id = ? ORDER BY rowid`).all(groupId) as GroupMember[];
  },

  authenticate(tokenHash: string): GroupMember | undefined {
    return getConnection().prepare(`SELECT ${MEMBER_COLUMNS} FROM group_members WHERE token_hash = ?`).get(tokenHash) as GroupMember | undefined;
  },

  message(id: string): GroupMessage | undefined {
    const row = getConnection().prepare(`SELECT ${MESSAGE_COLUMNS} FROM group_messages WHERE id = ?`).get(id);
    return row ? decodeMessage(row) : undefined;
  },

  findRequest(groupId: string, key: string): GroupMessage | undefined {
    const row = getConnection().prepare(`SELECT ${MESSAGE_COLUMNS} FROM group_messages WHERE group_id = ? AND request_key = ?`).get(groupId, key);
    return row ? decodeMessage(row) : undefined;
  },

  append(input: Omit<GroupMessage, 'id' | 'seq' | 'createdAt'>, requestKey: string, recipients: string[], turns?: number): GroupMessage {
    const db = getConnection();
    return db.transaction(() => {
      const existing = this.findRequest(input.groupId, requestKey);
      if (existing) return existing;
      const id = randomUUID();
      db.prepare('INSERT INTO group_messages(id, group_id, sender_id, recipient_id, kind, content, title, reply_to, assignments, request_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, input.groupId, input.senderId, input.recipientId, input.kind, input.content, input.title, input.replyTo, JSON.stringify(input.assignments), requestKey);
      for (const memberId of recipients) {
        db.prepare('INSERT INTO group_deliveries(message_id, member_id) VALUES (?, ?)').run(id, memberId);
      }
      if (turns !== undefined) this.control(input.groupId, false, turns);
      return this.message(id)!;
    })();
  },

  messages(groupId: string, after: number, limit: number, memberId?: string, publishedOnly = false): GroupMessage[] {
    return getConnection().prepare(`SELECT ${MESSAGE_COLUMNS} FROM group_messages WHERE group_id = ? AND seq > ?
      ${memberId ? 'AND (recipient_id IS NULL OR recipient_id = @memberId OR sender_id = @memberId)' : ''}
      ${publishedOnly ? "AND kind = 'publish'" : ''} ORDER BY seq LIMIT @limit`)
      .all(groupId, after, { ...(memberId ? { memberId } : {}), limit }).map(decodeMessage);
  },

  recentMessages(groupId: string, limit: number, publishedOnly = false): GroupMessage[] {
    return getConnection().prepare(`SELECT ${MESSAGE_COLUMNS} FROM group_messages WHERE group_id = ? ${publishedOnly ? "AND kind = 'publish'" : ''} ORDER BY seq DESC LIMIT ?`)
      .all(groupId, limit).map(decodeMessage).reverse();
  },

  deliveries(groupId: string): GroupDelivery[] {
    return getConnection().prepare(`SELECT d.message_id AS messageId, d.member_id AS memberId, d.status, d.error
      FROM group_deliveries d JOIN group_messages m ON m.id = d.message_id
      WHERE m.group_id = ? ORDER BY m.seq DESC LIMIT 500`).all(groupId) as GroupDelivery[];
  },

  candidates(): GroupMember[] {
    return getConnection().prepare(`SELECT ${MEMBER_COLUMNS} FROM group_members WHERE id IN (
      SELECT d.member_id FROM group_deliveries d JOIN group_members m ON m.id = d.member_id
      JOIN agent_groups g ON g.id = m.group_id
      WHERE d.status = 'queued' AND g.paused = 0 AND g.turns_remaining > 0
    ) ORDER BY rowid`).all() as GroupMember[];
  },

  claim(memberId: string): GroupMessage[] {
    const db = getConnection();
    return db.transaction(() => {
      if (db.prepare("SELECT 1 FROM group_deliveries WHERE member_id = ? AND status = 'running'").get(memberId)) return [];
      const member = db.prepare('SELECT group_id FROM group_members WHERE id = ?').get(memberId) as { group_id: string } | undefined;
      if (!member) return [];
      const group = this.get(member.group_id);
      if (!group || group.paused || group.turnsRemaining < 1) return [];
      // Bound each injected turn while preserving chronological, per-member delivery.
      const messages = db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM group_messages WHERE id IN (
        SELECT message_id FROM group_deliveries WHERE member_id = ? AND status = 'queued'
      ) ORDER BY seq LIMIT 5`).all(memberId).map(decodeMessage);
      if (!messages.length) return [];
      for (const message of messages) {
        db.prepare("UPDATE group_deliveries SET status = 'running', error = NULL WHERE message_id = ? AND member_id = ?").run(message.id, memberId);
      }
      db.prepare('UPDATE agent_groups SET turns_remaining = turns_remaining - 1 WHERE id = ?').run(group.id);
      return messages;
    })();
  },

  settle(member: GroupMember, messages: GroupMessage[], status: GroupDelivery['status'], error: string | null, seenSeq?: number): void {
    const db = getConnection();
    db.transaction(() => {
      for (const message of messages) {
        db.prepare('UPDATE group_deliveries SET status = ?, error = ? WHERE message_id = ? AND member_id = ?')
          .run(status, error, message.id, member.id);
      }
      if (status === 'queued') db.prepare('UPDATE agent_groups SET turns_remaining = turns_remaining + 1 WHERE id = ?').run(member.groupId);
      if (seenSeq !== undefined) db.prepare('UPDATE group_members SET seen_seq = MAX(seen_seq, ?) WHERE id = ?').run(seenSeq, member.id);
    })();
  },

  control(groupId: string, paused: boolean, turns?: number): void {
    getConnection().prepare(`UPDATE agent_groups SET paused = ?${turns === undefined ? '' : ', turns_remaining = ?'} WHERE id = ?`)
      .run(...(turns === undefined ? [Number(paused), groupId] : [Number(paused), turns, groupId]));
  },

  retry(groupId: string): void {
    getConnection().prepare(`UPDATE group_deliveries SET status = 'queued', error = NULL
      WHERE status IN ('failed', 'interrupted') AND member_id IN (SELECT id FROM group_members WHERE group_id = ?)`)
      .run(groupId);
  },

  recover(): void {
    getConnection().prepare("UPDATE group_deliveries SET status = 'interrupted', error = 'Server restarted during this turn; inspect the session before retrying.' WHERE status = 'running'").run();
  },
};
