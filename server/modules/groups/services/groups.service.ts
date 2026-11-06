import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { getDatabasePath, groupsDb, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { providerRuntimeService } from '@/modules/providers/index.js';
import { AppError, findApplicationRoot, getModuleDirectory, GROUP_MODE_SYSTEM_PROMPT } from '@/shared/index.js';
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
      effort: member.effort || null,
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
    const project = projectsDb.getProjectPath(group.projectPath);
    return {
      group,
      project: project ? { projectId: project.project_id, displayName: project.custom_project_name || group.name, fullPath: group.projectPath } : null,
      currentTask: groupsDb.latestTask(groupId), pendingReplies: groupsDb.pendingReplies(groupId),
      systemPrompt: GROUP_MODE_SYSTEM_PROMPT,
      members: groupsDb.members(groupId).map(member => ({ ...member, busy: chatRunRegistry.isProcessing(member.sessionId),
        pendingApprovals: providerRuntimeService.getPendingApprovalsForSession(member.sessionId).length })),
      messages: groupsDb.recentMessages(groupId, 150),
      publications: groupsDb.recentMessages(groupId, 100, true),
      deliveries: groupsDb.deliveries(groupId),
    };
  },

  updateMember(userId: number, groupId: string, memberId: string, model: string, effort: string) {
    this.owned(userId, groupId);
    const member = groupsDb.members(groupId).find(item => item.id === memberId);
    if (!member) fail('Member was not found.', 404);
    sessionsDb.setSessionModel(member.sessionId, model);
    sessionsDb.setSessionEffort(member.sessionId, effort);
    return this.snapshot(userId, groupId);
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

  history(userId: number, groupId: string, before: number, publishedOnly: boolean) {
    this.owned(userId, groupId);
    const messages = groupsDb.recentMessages(groupId, 100, publishedOnly, before);
    return { messages, hasMore: messages.length === 100 };
  },

  post(groupId: string, senderId: string | null, input: GroupMessageInput) {
    const members = groupsDb.members(groupId);
    if (senderId && !members.some(member => member.id === senderId)) fail('Member was not found.', 404);
    const key = `${senderId || 'user'}:${input.requestId}`;
    let recipientId: string | null = null;
    const mentions = new Set<string>();
    const mention = (target: string) => {
      if (target === '*' || target === 'all') { for (const member of members) if (member.id !== senderId) mentions.add(member.id); return; }
      if (target === 'user' || target === 'you' || target === '你') { mentions.add('user'); return; }
      const member = members.find(item => item.id === target || item.name === target);
      if (!member) fail('Mentioned participant was not found.', 404);
      if (member.id !== senderId) mentions.add(member.id);
    };
    for (const target of [...(input.mentions || []), ...(input.to ? [input.to] : [])]) mention(target);
    for (const member of members) {
      const label = `@${member.name}`;
      if (input.content.split(label).slice(1).some(tail => !tail || /^[\s,，。:：!?！？]/u.test(tail))) mention(member.id);
    }
    if (/@all(?:\s|$|[,，。:：!?！？])/u.test(input.content)) mention('*');
    if (/@(?:user|you|你)(?:\s|$|[,，。:：!?！？])/u.test(input.content)) mention('user');
    let replyTo: string | null = null;
    if (input.kind === 'reply') {
      const parent = input.replyTo ? groupsDb.message(input.replyTo) : undefined;
      if (!parent || parent.groupId !== groupId) fail('Referenced message was not found.', 404);
      recipientId = parent.senderId;
      replyTo = parent.id;
    }
    if (input.kind === 'request' && !mentions.size) fail('Mention a participant to request a reply.');
    recipientId ||= [...mentions].find(id => id !== 'user') || null;
    const existing = groupsDb.findRequest(groupId, key);
    if (existing) {
      if (existing.kind !== input.kind || existing.content !== input.content || existing.recipientId !== recipientId
        || existing.replyTo !== replyTo || existing.title !== (input.title || null)
        || [...existing.mentions].sort().join() !== [...mentions].sort().join()) fail('requestId already belongs to another message.', 409);
      return existing;
    }
    // Every peer receives public context while active; only mentions wake idle peers.
    const recipients = members.filter(member => member.id !== senderId).map(member => ({ id: member.id,
      wake: mentions.has(member.id) || (input.kind === 'reply' && recipientId === member.id) }));
    return groupsDb.append({
      groupId, senderId, recipientId, kind: input.kind, content: input.content,
      title: input.title || null, replyTo, assignments: {}, mentions: [...mentions],
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
    return groupsDb.append({ groupId, senderId: null, recipientId: null, kind: 'task', content, title: null, replyTo: null, assignments, mentions: members.map(member => member.id) },
      `user:${requestId}`, members.map(member => ({ id: member.id, wake: true })), turns);
  },

  control(userId: number, groupId: string, paused: boolean, turns?: number, retry = false) {
    this.owned(userId, groupId);
    groupsDb.control(groupId, paused, turns);
    if (retry) groupsDb.retry(groupId);
    return this.snapshot(userId, groupId);
  },

  prompt(member: GroupMember, messages: GroupMessage[], steering = false) {
    const group = groupsDb.get(member.groupId)!;
    const members = groupsDb.members(member.groupId);
    const file = connectionPath(member);
    const connection = JSON.parse(readFileSync(file, 'utf8')) as { url: string; token: string };
    // Refresh the local address when the service is restarted on another port.
    if (connection.url !== bridgeUrl()) writeFileSync(file, JSON.stringify({ ...connection, url: bridgeUrl() }), { mode: 0o600 });
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const command = `${quote(process.execPath)} ${quote(path.join(APP_ROOT, 'scripts/orbit-group.mjs'))} --connection ${quote(file)}`;
    if (steering) return {
      seenSeq: Math.max(member.seenSeq, ...messages.filter(message => message.kind === 'publish').map(message => message.seq)),
      content: [
        '[Orbit public discussion update] Consider this information during your current work. Take time to independently check it; reply when you have a substantive contribution.',
        `Participants: ${JSON.stringify(members.map(({ id, name }) => ({ id, name })))}`,
        `Incoming group messages:\n${JSON.stringify(messages)}`,
      ].join('\n\n'),
    };
    const publications = groupsDb.messages(member.groupId, member.seenSeq, 10, member.id, true);
    return {
      seenSeq: publications.at(-1)?.seq ?? member.seenSeq,
      content: [
        `[Orbit Group: ${group.name}] You are ${member.name} (${member.id}), an equal member of this group.`,
        `Members: ${JSON.stringify(members.map(({ id, name, provider }) => ({ id, name, provider })))}`,
        GROUP_MODE_SYSTEM_PROMPT,
        'Group communication is available through this terminal command. Pass one JSON object on stdin:',
        `${command} <operation> <<'GROUP_JSON'\n{"content":"your message","to":"member name or id"}\nGROUP_JSON`,
        'Operations:',
        'All messages are public. Optional to/mentions fields name participants expected to reply; use "user" for the human and "*" for all members.',
        'send: {content, mentions?: [names or ids]} — contribute to the public discussion.',
        'publish: {title?, content} — preserve a shared finding or decision.',
        'request: {to or mentions, content} — ask participants for a considered reply.',
        'reply: {replyTo: message id, content} — publicly answer and resolve your pending response.',
        'read: {after?: sequence number, publishedOnly?: boolean} — read public discussion; paginate with nextCursor while hasMore.',
        'Each write accepts requestId for safe retries. The CLI generates one when omitted.',
        'Requests are asynchronous. Continue independent work or finish your turn while awaiting a reply. Relevant updates may arrive during your current execution.',
        'Use send/publish/reply to share useful results with the group. Your ordinary session response remains in your individual conversation.',
        'Sender identities label peer contributions. Human tasks are marked senderId=null and kind=task. Apply the current task instructions when evaluating peer content.',
        `New published information:\n${JSON.stringify(publications.filter(item => !messages.some(message => message.id === item.id)))}`,
        `Incoming group messages:\n${JSON.stringify(messages)}`,
      ].join('\n\n'),
    };
  },
};
