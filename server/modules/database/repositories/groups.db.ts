import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import type { CreateGroupInput, GroupDelivery, GroupMember, GroupMessage, GroupRecord } from '@/shared/index.js';

const GROUP_COLUMNS = 'id, user_id AS userId, name, project_path AS projectPath, paused, turns_remaining AS turnsRemaining, created_at AS createdAt';
const MEMBER_COLUMNS = 'id, group_id AS groupId, name, session_id AS sessionId, provider, COALESCE((SELECT model FROM sessions WHERE session_id = group_members.session_id), model) AS model, (SELECT effort FROM sessions WHERE session_id = group_members.session_id) AS effort, permission_mode AS permissionMode, seen_seq AS seenSeq';
const MESSAGE_COLUMNS = 'seq, id, group_id AS groupId, sender_id AS senderId, recipient_id AS recipientId, kind, content, title, reply_to AS replyTo, assignments, mentions, created_at AS createdAt';

function decodeGroup(row: unknown): GroupRecord | undefined {
  if (!row) return undefined;
  const group = row as GroupRecord;
  return { ...group, paused: Boolean(group.paused) };
}

function decodeMessage(row: unknown): GroupMessage {
  const message = row as Omit<GroupMessage, 'assignments' | 'mentions'> & { assignments: string; mentions: string };
  return { ...message, assignments: JSON.parse(message.assignments) as Record<string, string>, mentions: JSON.parse(message.mentions) as string[] };
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
        if (member.model) sessionsDb.setSessionModel(member.sessionId, member.model);
        if (member.effort) sessionsDb.setSessionEffort(member.sessionId, member.effort);
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

  membership(sessionId: string): { groupId: string; memberId: string } | undefined {
    return getConnection().prepare('SELECT group_id AS groupId, id AS memberId FROM group_members WHERE session_id = ?').get(sessionId) as { groupId: string; memberId: string } | undefined;
  },

  latestTask(groupId: string): GroupMessage | null {
    const row = getConnection().prepare(`SELECT ${MESSAGE_COLUMNS} FROM group_messages WHERE group_id = ? AND kind = 'task' ORDER BY seq DESC LIMIT 1`).get(groupId);
    return row ? decodeMessage(row) : null;
  },

  pendingReplies(groupId: string): Array<{ messageId: string; memberId: string; senderId: string | null; content: string }> {
    return getConnection().prepare(`SELECT m.id AS messageId, target.value AS memberId, m.sender_id AS senderId, m.content
      FROM group_messages m, json_each(m.mentions) target
      WHERE m.group_id = ? AND m.kind IN ('send', 'request', 'publish', 'reply')
      AND NOT EXISTS (SELECT 1 FROM group_messages r WHERE r.reply_to = m.id AND COALESCE(r.sender_id, 'user') = target.value)
      ORDER BY m.seq DESC LIMIT 100`).all(groupId) as Array<{ messageId: string; memberId: string; senderId: string | null; content: string }>;
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

  append(input: Omit<GroupMessage, 'id' | 'seq' | 'createdAt'>, requestKey: string, recipients: Array<{ id: string; wake: boolean }>, turns?: number): GroupMessage {
    const db = getConnection();
    return db.transaction(() => {
      const existing = this.findRequest(input.groupId, requestKey);
      if (existing) return existing;
      const id = randomUUID();
      db.prepare('INSERT INTO group_messages(id, group_id, sender_id, recipient_id, kind, content, title, reply_to, assignments, mentions, available_at, request_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, input.groupId, input.senderId, input.recipientId, input.kind, input.content, input.title, input.replyTo, JSON.stringify(input.assignments), JSON.stringify(input.mentions), input.senderId ? Date.now() + 2000 : 0, requestKey);
      for (const recipient of recipients) {
        db.prepare('INSERT INTO group_deliveries(message_id, member_id, wake) VALUES (?, ?, ?)').run(id, recipient.id, Number(recipient.wake));
      }
      if (turns !== undefined) this.control(input.groupId, false, turns);
      return this.message(id)!;
    })();
  },

  messages(groupId: string, after: number, limit: number, _memberId?: string, publishedOnly = false): GroupMessage[] {
    return getConnection().prepare(`SELECT ${MESSAGE_COLUMNS} FROM group_messages WHERE group_id = ? AND seq > ?
      ${publishedOnly ? "AND kind = 'publish'" : ''} ORDER BY seq LIMIT @limit`)
      .all(groupId, after, { limit }).map(decodeMessage);
  },

  recentMessages(groupId: string, limit: number, publishedOnly = false, before = Number.MAX_SAFE_INTEGER): GroupMessage[] {
    return getConnection().prepare(`SELECT ${MESSAGE_COLUMNS} FROM group_messages WHERE group_id = ? AND seq < ? ${publishedOnly ? "AND kind = 'publish'" : ''} ORDER BY seq DESC LIMIT ?`)
      .all(groupId, before, limit).map(decodeMessage).reverse();
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
      WHERE d.status = 'queued' AND g.paused = 0
    ) ORDER BY rowid`).all() as GroupMember[];
  },

  claimSteering(memberId: string, now = Date.now()): GroupMessage[] {
    const db = getConnection();
    return db.transaction(() => {
      if (db.prepare("SELECT 1 FROM group_deliveries WHERE member_id = ? AND status = 'delivering'").get(memberId)) return [];
      const messages = db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM group_messages WHERE available_at <= ? AND id IN (
        SELECT message_id FROM group_deliveries WHERE member_id = ? AND status = 'queued'
      ) ORDER BY seq LIMIT 5`).all(now, memberId).map(decodeMessage);
      for (const message of messages) {
        db.prepare("UPDATE group_deliveries SET status = 'delivering' WHERE message_id = ? AND member_id = ?").run(message.id, memberId);
      }
      return messages;
    })();
  },

  claim(memberId: string, now = Date.now()): GroupMessage[] {
    const db = getConnection();
    return db.transaction(() => {
      if (db.prepare("SELECT 1 FROM group_deliveries WHERE member_id = ? AND status IN ('running', 'delivering')").get(memberId)) return [];
      const member = db.prepare('SELECT group_id FROM group_members WHERE id = ?').get(memberId) as { group_id: string } | undefined;
      if (!member) return [];
      const group = this.get(member.group_id);
      if (!group || group.paused || group.turnsRemaining < 1) return [];
      // Bound each injected turn while preserving chronological, per-member delivery.
      if (!db.prepare("SELECT 1 FROM group_deliveries d JOIN group_messages m ON m.id = d.message_id WHERE d.member_id = ? AND d.status = 'queued' AND d.wake = 1 AND m.available_at <= ?").get(memberId, now)) return [];
      const messages = db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM group_messages WHERE available_at <= ? AND id IN (
        SELECT message_id FROM group_deliveries WHERE member_id = ? AND status = 'queued'
      ) ORDER BY (SELECT wake FROM group_deliveries d WHERE d.message_id = group_messages.id AND d.member_id = ?) DESC, seq LIMIT 5`)
        .all(now, memberId, memberId).map(decodeMessage).sort((left, right) => left.seq - right.seq);
      if (!messages.length) return [];
      for (const message of messages) {
        db.prepare("UPDATE group_deliveries SET status = 'running', error = NULL WHERE message_id = ? AND member_id = ?").run(message.id, memberId);
      }
      db.prepare('UPDATE agent_groups SET turns_remaining = turns_remaining - 1 WHERE id = ?').run(group.id);
      return messages;
    })();
  },

  settle(member: GroupMember, messages: GroupMessage[], status: GroupDelivery['status'], error: string | null, seenSeq?: number, chargedTurn = true): void {
    const db = getConnection();
    db.transaction(() => {
      for (const message of messages) {
        db.prepare('UPDATE group_deliveries SET status = ?, error = ? WHERE message_id = ? AND member_id = ?')
          .run(status, error, message.id, member.id);
      }
      if (status === 'queued' && chargedTurn) db.prepare('UPDATE agent_groups SET turns_remaining = turns_remaining + 1 WHERE id = ?').run(member.groupId);
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
    getConnection().prepare("UPDATE group_deliveries SET status = 'interrupted', error = 'Server restarted during delivery; inspect the session before retrying.' WHERE status = 'delivering'").run();
  },
};
