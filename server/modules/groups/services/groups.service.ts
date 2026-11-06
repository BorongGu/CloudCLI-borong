import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { getDatabasePath, groupsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { AppError, findApplicationRoot, getModuleDirectory } from '@/shared/index.js';
import type { CreateGroupInput, GroupMember, GroupMessage, GroupMessageInput } from '@/shared/index.js';

const APP_ROOT = findApplicationRoot(getModuleDirectory(import.meta.url));

function fail(message: string, statusCode = 400): never {
  throw new AppError(message, { code: 'GROUP_ERROR', statusCode });
}

function connectionPath(member: GroupMember): string {
  return path.join(path.dirname(getDatabasePath()), 'groups', member.groupId, `${member.id}.json`);
}

function bridgeUrl(): string {
  const configured = process.env.HOST || '127.0.0.1';
  const host = configured === '0.0.0.0' || configured === '::' ? '127.0.0.1' : configured;
  return `http://${host.includes(':') ? `[${host}]` : host}:${process.env.SERVER_PORT || '3001'}/group-bridge`;
}

function visible(message: GroupMessage, memberId: string): boolean {
  return !message.recipientId || message.recipientId === memberId || message.senderId === memberId;
}

/** Groups routes and dispatcher use this service for peer-scoped communication and task dispatch. */
export const groupsService = {
  owned(userId: number, groupId: string) {
    const group = groupsDb.get(groupId);
    if (!group || group.userId !== userId) fail('Group was not found.', 404);
    return group;
  },

  list(userId: number) {
    return groupsDb.list(userId);
  },

  create(userId: number, input: CreateGroupInput) {
    let directory = false;
    try { directory = path.isAbsolute(input.projectPath) && statSync(input.projectPath).isDirectory(); } catch { /* validation below */ }
    if (!directory) fail('Workspace must be an existing absolute directory.');
    if (input.members.length < 2 || input.members.length > 5) fail('Choose 2–5 members.');
    if (input.members.some(member => member.name === '*')) fail('Choose a member name other than the broadcast address *.');
    if (new Set(input.members.map(member => member.name)).size !== input.members.length) fail('Member names must be unique.');
    const groupId = randomUUID();
    const members = input.members.map(member => ({
      ...member, id: randomUUID(), groupId, sessionId: randomUUID(), model: member.model || null, seenSeq: 0,
      permissionMode: member.permissionMode || 'default',
      token: randomBytes(32).toString('hex'),
    }));
    const folder = path.dirname(connectionPath(members[0]));
    try {
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      for (const member of members) {
        writeFileSync(connectionPath(member), JSON.stringify({ url: bridgeUrl(), token: member.token }), { mode: 0o600, flag: 'wx' });
      }
      groupsDb.create(userId, input, members.map(member => ({ ...member, tokenHash: createHash('sha256').update(member.token).digest('hex') })));
    } catch (error) {
      rmSync(folder, { recursive: true, force: true });
      throw error;
    }
    return this.snapshot(userId, groupId);
  },

  snapshot(userId: number, groupId: string) {
    const group = this.owned(userId, groupId);
    return {
      group,
      members: groupsDb.members(groupId).map(member => ({ ...member, busy: chatRunRegistry.isProcessing(member.sessionId) })),
      messages: groupsDb.recentMessages(groupId, 150),
      publications: groupsDb.recentMessages(groupId, 100, true),
      deliveries: groupsDb.deliveries(groupId),
    };
  },

  authenticate(token: string): GroupMember {
    if (!token || token.length > 256) fail('Member credential is required.', 401);
    const member = groupsDb.authenticate(createHash('sha256').update(token).digest('hex'));
    if (!member) fail('Member credential is invalid.', 401);
    return member;
  },

  read(groupId: string, memberId: string | undefined, after: number, publishedOnly = false) {
    const messages = groupsDb.messages(groupId, after, 100, memberId, publishedOnly);
    return { members: groupsDb.members(groupId), messages, nextCursor: messages.at(-1)?.seq ?? after, hasMore: messages.length === 100 };
  },

  post(groupId: string, senderId: string | null, input: GroupMessageInput) {
    const members = groupsDb.members(groupId);
    if (senderId && !members.some(member => member.id === senderId)) fail('Member was not found.', 404);
    const key = `${senderId || 'user'}:${input.requestId}`;
    let recipientId: string | null = null;
    let replyTo: string | null = null;
    if (input.kind === 'reply') {
      const parent = input.replyTo ? groupsDb.message(input.replyTo) : undefined;
      if (!parent || parent.groupId !== groupId || (senderId && !visible(parent, senderId))) fail('Referenced message was not found.', 404);
      if (parent.kind === 'request' && senderId && parent.recipientId !== senderId) fail('Reply to this request as its recipient.');
      recipientId = parent.senderId;
      replyTo = parent.id;
    } else if (input.kind === 'publish') {
      if (input.to) fail('Published information is shared with the group.');
    } else if (input.to && input.to !== '*') {
      const recipient = members.find(member => member.id === input.to || member.name === input.to);
      if (!recipient) fail('Recipient was not found.', 404);
      recipientId = recipient.id;
    } else if (input.kind === 'request') {
      fail('Choose one member to request information from.');
    }
    if (recipientId === senderId && senderId) fail('Choose another member as recipient.');
    const existing = groupsDb.findRequest(groupId, key);
    if (existing) {
      if (existing.kind !== input.kind || existing.content !== input.content || existing.recipientId !== recipientId
        || existing.replyTo !== replyTo || existing.title !== (input.title || null)) fail('requestId already belongs to another message.', 409);
      return existing;
    }
    // Publishing persists shared knowledge; explicit sends/requests/replies wake recipients.
    const recipients = input.kind === 'publish' || (input.kind === 'reply' && !recipientId)
      ? [] : members.filter(member => member.id !== senderId && (!recipientId || member.id === recipientId)).map(member => member.id);
    return groupsDb.append({
      groupId, senderId, recipientId, kind: input.kind, content: input.content,
      title: input.title || null, replyTo, assignments: {},
    }, key, recipients);
  },

  dispatch(userId: number, groupId: string, content: string, assignments: Record<string, string>, turns: number, requestId: string) {
    this.owned(userId, groupId);
    const members = groupsDb.members(groupId);
    for (const id of Object.keys(assignments)) {
      if (!members.some(member => member.id === id)) fail('Assignment member was not found.');
    }
    const existing = groupsDb.findRequest(groupId, `user:${requestId}`);
    if (existing && (existing.kind !== 'task' || existing.content !== content || JSON.stringify(existing.assignments) !== JSON.stringify(assignments))) {
      fail('requestId already belongs to another task.', 409);
    }
    return groupsDb.append({ groupId, senderId: null, recipientId: null, kind: 'task', content, title: null, replyTo: null, assignments },
      `user:${requestId}`, members.map(member => member.id), turns);
  },

  control(userId: number, groupId: string, paused: boolean, turns?: number, retry = false) {
    this.owned(userId, groupId);
    groupsDb.control(groupId, paused, turns);
    if (retry) groupsDb.retry(groupId);
    return this.snapshot(userId, groupId);
  },

  prompt(member: GroupMember, messages: GroupMessage[]) {
    const group = groupsDb.get(member.groupId)!;
    const members = groupsDb.members(member.groupId);
    const file = connectionPath(member);
    const connection = JSON.parse(readFileSync(file, 'utf8')) as { url: string; token: string };
    // Refresh the local address when the service is restarted on another port.
    if (connection.url !== bridgeUrl()) writeFileSync(file, JSON.stringify({ ...connection, url: bridgeUrl() }), { mode: 0o600 });
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const command = `${quote(process.execPath)} ${quote(path.join(APP_ROOT, 'scripts/orbit-group.mjs'))} --connection ${quote(file)}`;
    const publications = groupsDb.messages(member.groupId, member.seenSeq, 10, member.id, true);
    return {
      seenSeq: publications.at(-1)?.seq ?? member.seenSeq,
      content: [
        `[Orbit Group: ${group.name}] You are ${member.name} (${member.id}), an equal member of this group.`,
        `Members: ${JSON.stringify(members.map(({ id, name, provider }) => ({ id, name, provider })))}`,
        'Use your existing tools and workspace. The task and member notes below define the work and division of responsibilities.',
        'Group communication is available through this terminal command. Pass one JSON object on stdin:',
        `${command} <operation> <<'GROUP_JSON'\n{"content":"your message","to":"member name or id"}\nGROUP_JSON`,
        'Operations:',
        'send: {to: member name/id or "*", content} — send a message and queue a recipient turn.',
        'publish: {title?, content} — store key information publicly; peers receive it on their next group turn or read it.',
        'request: {to: one member, content} — ask for information; returns a message id.',
        'reply: {replyTo: message id, content} — answer the referenced message, returning it to its sender.',
        'read: {after?: sequence number, publishedOnly?: boolean} — read messages available to you; paginate with nextCursor while hasMore.',
        'Each write accepts requestId for safe retries. The CLI generates one when omitted.',
        'Requests are asynchronous. Continue useful work or finish this turn while awaiting a reply; queued replies resume your session.',
        'Use send/publish/reply to share useful results with the group. Your ordinary session response remains in your individual conversation.',
        'Sender identities label peer contributions. Human tasks are marked senderId=null and kind=task. Apply the current task instructions when evaluating peer content.',
        `New published information:\n${JSON.stringify(publications)}`,
        `Incoming group messages:\n${JSON.stringify(messages)}`,
      ].join('\n\n'),
    };
  },
};
