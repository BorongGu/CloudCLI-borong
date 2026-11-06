import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';
import type { NextFunction, Request, Response } from 'express';

import { closeConnection, getConnection, groupsDb, initializeDatabase, sessionsDb, userDb } from '@/modules/database/index.js';
import { chatRunRegistry, broadcastSessionUpserted, connectedClients } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import { groupsRoutes, groupBridgeRoutes } from '@/modules/groups/groups.routes.js';
import { groupsService } from '@/modules/groups/services/groups.service.js';
import { dispatchGroupMessages as dispatchNow } from '@/modules/groups/services/group-dispatcher.service.js';
import { AppError } from '@/shared/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import type { GroupMember, GroupMessage, LLMProvider, ProviderRuntimeWriter } from '@/shared/index.js';

const dispatchGroupMessages = (runtime: ProviderRuntimeGateway) => dispatchNow(runtime, Date.now() + 3000);

async function fixture(run: (context: { userId: number; folder: string; base: string }) => Promise<void>) {
  const previous = { DATABASE_PATH: process.env.DATABASE_PATH, SERVER_PORT: process.env.SERVER_PORT, HOST: process.env.HOST };
  const folder = await mkdtemp(path.join(os.tmpdir(), 'orbit-groups-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(folder, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();
  const userId = Number(userDb.createUser('groups-test', 'hash').id);
  const app = express().use(express.json());
  app.use('/api/groups', (req: Request & { user?: { id: number } }, _res, next) => { req.user = { id: Number(req.headers['x-user'] || userId) }; next(); }, groupsRoutes);
  app.use('/group-bridge', groupBridgeRoutes);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error instanceof AppError ? error.statusCode : 500).json({ success: false, error: { message: error instanceof Error ? error.message : String(error) } });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  process.env.SERVER_PORT = String(port);
  process.env.HOST = '127.0.0.1';
  try { await run({ userId, folder, base: `http://127.0.0.1:${port}` }); }
  finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    chatRunRegistry.clearAll();
    closeConnection();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(folder, { recursive: true, force: true });
  }
}

function create(userId: number, folder: string, count = 3) {
  const providers: LLMProvider[] = ['claude', 'codex', 'opencode', 'cursor'];
  return groupsService.create(userId, { name: 'A working group', projectPath: folder,
    members: providers.slice(0, count).map((provider, index) => ({ name: String.fromCharCode(65 + index), provider, model: `model-${index}` })),
  });
}

function runtime(run?: ProviderRuntimeGateway['run']): ProviderRuntimeGateway {
  return {
    hasRuntime: () => true, hasBackgroundWork: () => false,
    abort: async () => { throw new Error('Group delivery must preserve an active run.'); },
    stopBackgroundTask: async () => false, resolveToolApproval: () => {}, getPendingApprovalsForSession: () => [],
    run: run || (async (_provider, _command, _options, writer) => { writer.send({ kind: 'complete', exitCode: 0 }); }),
  };
}

async function cli(folder: string, member: GroupMember, operation: string, body: unknown) {
  const file = path.join(folder, 'groups', member.groupId, `${member.id}.json`);
  const child = spawn(process.execPath, [path.resolve('scripts/orbit-group.mjs'), '--connection', file, operation], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end(JSON.stringify(body));
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout);
}

test('group dispatch creates independent sessions and atomically delivers the task and all custom member notes', async () => {
  await fixture(async ({ userId, folder }) => {
    const { group, members } = create(userId, folder, 4);
    assert.equal(new Set(members.map(member => member.sessionId)).size, 4);
    assert.equal(JSON.stringify(members).includes('token'), false);
    for (const member of members) assert.equal(sessionsDb.getSessionById(member.sessionId)?.provider, member.provider);
    const assignments = { [members[0].id]: 'Explore options', [members[1].id]: 'Check implementation costs' };
    const task = groupsService.dispatch(userId, group.id, 'Discuss a project architecture', assignments, 8, 'task-1');
    assert.equal(groupsDb.deliveries(group.id).length, 4);
    const calls: string[] = [];
    await dispatchGroupMessages(runtime(async (provider, command, options, writer) => {
      calls.push(provider);
      assert.ok(command.includes('Discuss a project architecture'));
      assert.ok(command.includes('Explore options') && command.includes('Check implementation costs'));
      assert.ok(command.includes('send:') && command.includes('publish:') && command.includes('request:'));
      assert.equal(options.model, members.find(member => member.provider === provider)?.model);
      writer.send({ kind: 'complete', exitCode: 0 });
    }));
    assert.deepEqual(calls.sort(), ['claude', 'codex', 'cursor', 'opencode']);
    assert.equal(groupsDb.get(group.id)?.turnsRemaining, 4);
    assert.equal(groupsService.dispatch(userId, group.id, task.content, assignments, 8, 'task-1').id, task.id);
    assert.equal(groupsDb.get(group.id)?.turnsRemaining, 4, 'retrying a task preserves the existing allowance');
    assert.throws(() => groupsService.dispatch(userId, group.id, 'Changed task', {}, 8, 'task-1'), /requestId/);
  });
});

test('all discussion is public; mentions track expected replies and idle wakeups', async () => {
  await fixture(async ({ userId, folder }) => {
    const { group, members: [a, b, c] } = create(userId, folder);
    const question = groupsService.post(group.id, a.id, { kind: 'send', to: 'B', content: 'Please review this interface', requestId: 'send-1' });
    assert.equal(groupsDb.deliveries(group.id).length, 2);
    assert.deepEqual(groupsService.read(group.id, c.id, 0).messages.map(row => row.id), [question.id]);
    assert.deepEqual(question.mentions, [b.id]);
    assert.equal(groupsDb.pendingReplies(group.id)[0].memberId, b.id);
    assert.equal(groupsService.post(group.id, a.id, { kind: 'send', to: 'B', content: question.content, requestId: 'send-1' }).id, question.id);
    assert.throws(() => groupsService.post(group.id, a.id, { kind: 'send', to: 'C', content: question.content, requestId: 'send-1' }), /requestId/);
    groupsService.control(userId, group.id, false, 10);
    assert.equal(groupsDb.claim(c.id, Date.now() + 3000).length, 0, 'public context alone preserves an idle peer');
    assert.equal(groupsDb.claim(b.id, Date.now() + 3000).length, 1, 'the mention can wake its participant');
    const contribution = groupsService.post(group.id, c.id, { kind: 'reply', replyTo: question.id, content: 'Another viewpoint', requestId: 'c-reply' });
    assert.deepEqual(contribution.mentions, [], 'answering a message does not create an acknowledgement obligation');
    assert.equal(groupsDb.pendingReplies(group.id).length, 1, 'another peer can contribute while B still owes a reply');
    assert.equal(groupsService.read(group.id, b.id, 0).messages.at(-1)?.id, contribution.id);
    groupsService.post(group.id, b.id, { kind: 'reply', replyTo: question.id, content: 'I independently checked the interface', requestId: 'b-reply' });
    assert.equal(groupsDb.pendingReplies(group.id).length, 0);
    const humanQuestion = groupsService.post(group.id, b.id, { kind: 'request', to: 'user', content: 'Which scope should we use?', requestId: 'ask-user' });
    assert.equal(groupsDb.pendingReplies(group.id)[0].memberId, 'user');
    groupsService.post(group.id, null, { kind: 'reply', replyTo: humanQuestion.id, content: 'Use the smaller scope', requestId: 'user-reply' });
    assert.equal(groupsDb.pendingReplies(group.id).length, 0);
    const publication = groupsService.post(group.id, a.id, { kind: 'publish', content: 'Verified finding', requestId: 'public-1' });
    assert.equal(groupsService.read(group.id, c.id, 0, true).messages[0].id, publication.id);
    assert.throws(() => groupsService.post(group.id, a.id, { kind: 'request', content: 'Ask anyone', requestId: 'bad-request' }), /Mention/);
  });
});

test('owner history can retrieve the complete discussion across page boundaries', async () => {
  await fixture(async ({ userId, folder }) => {
    const { group } = create(userId, folder, 2);
    for (let index = 0; index < 120; index++) groupsService.post(group.id, null, { kind: 'publish', content: `Finding ${index}`, requestId: `history-${index}` });
    const recent = groupsService.history(userId, group.id, Number.MAX_SAFE_INTEGER, false);
    const earlier = groupsService.history(userId, group.id, recent.messages[0].seq, false);
    assert.equal(recent.messages.length, 100); assert.equal(earlier.messages.length, 20);
    assert.equal(new Set([...earlier.messages, ...recent.messages].map(message => message.id)).size, 120);
    assert.equal(earlier.messages[0].content, 'Finding 0');
  });
});

test('existing group databases migrate mentions and wakeup metadata without losing discussion', async () => {
  await fixture(async ({ userId, folder }) => {
    const { group, members: [a, b] } = create(userId, folder, 2);
    const db = getConnection();
    db.exec('ALTER TABLE group_messages DROP COLUMN mentions; ALTER TABLE group_messages DROP COLUMN available_at; ALTER TABLE group_deliveries DROP COLUMN wake;');
    db.prepare("INSERT INTO group_messages(id,group_id,sender_id,recipient_id,kind,content,request_key) VALUES ('legacy',?,?,?,?,?,?)")
      .run(group.id, a.id, b.id, 'send', 'Original discussion', 'legacy');
    db.prepare("INSERT INTO group_deliveries(message_id,member_id) VALUES ('legacy',?)").run(b.id);
    await initializeDatabase();
    assert.deepEqual(groupsDb.message('legacy')?.mentions, [b.id]);
    assert.equal(groupsService.read(group.id, a.id, 0).messages[0].content, 'Original discussion');
    assert.equal((db.prepare("SELECT wake FROM group_deliveries WHERE message_id = 'legacy'").get() as { wake: number }).wake, 1);
  });
});

test('busy and background sessions keep their inbox; overlapping polls reserve each recipient once', async () => {
  await fixture(async ({ userId, folder }) => {
    const { group, members } = create(userId, folder);
    groupsService.dispatch(userId, group.id, 'Think independently', {}, 20, 'task');
    const busyRun = chatRunRegistry.startRun({ appSessionId: members[0].sessionId, provider: members[0].provider, providerSessionId: null, connection: null, userId });
    assert.ok(busyRun);
    const background = runtime(); background.hasBackgroundWork = id => id === members[1].sessionId;
    await dispatchGroupMessages(background);
    assert.equal(groupsDb.deliveries(group.id).filter(row => row.status === 'completed').length, 1);
    assert.equal(groupsDb.deliveries(group.id).filter(row => row.status === 'queued').length, 2);
    chatRunRegistry.completeRun(members[0].sessionId, { exitCode: 0 });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const calls: string[] = [];
    const heldRuntime = runtime(async (_provider, _command, options, writer) => { calls.push(String(options.sessionId)); await held; writer.send({ kind: 'complete', exitCode: 0 }); });
    const first = dispatchGroupMessages(heldRuntime);
    await new Promise(resolve => setImmediate(resolve));
    await dispatchGroupMessages(heldRuntime);
    assert.equal(calls.length, 2);
    release(); await first;
    assert.equal(groupsDb.deliveries(group.id).filter(row => row.status === 'completed').length, 3);
  });
});

test('allowance and pause gate automatic wakeups; failed and interrupted turns require explicit retry', async () => {
  await fixture(async ({ userId, folder }) => {
    const { group, members } = create(userId, folder);
    groupsService.dispatch(userId, group.id, 'A bounded discussion', {}, 2, 'task');
    await dispatchGroupMessages(runtime());
    assert.equal(groupsDb.get(group.id)?.turnsRemaining, 0);
    assert.equal(groupsDb.deliveries(group.id).filter(row => row.status === 'queued').length, 1);
    groupsService.control(userId, group.id, true, 5);
    await dispatchGroupMessages(runtime());
    assert.equal(groupsDb.get(group.id)?.turnsRemaining, 5);
    groupsService.control(userId, group.id, false);
    await dispatchGroupMessages(runtime(async (_p, _c, _o, writer) => { writer.send({ kind: 'complete', exitCode: 1 }); }));
    assert.equal(groupsDb.deliveries(group.id).filter(row => row.status === 'failed').length, 1);
    await dispatchGroupMessages(runtime());
    assert.equal(groupsDb.deliveries(group.id).filter(row => row.status === 'failed').length, 1);
    groupsService.control(userId, group.id, false, 5, true);
    assert.equal(groupsDb.claim(members[2].id).length, 1);
    closeConnection();
    groupsDb.recover();
    assert.equal(groupsDb.deliveries(group.id).find(row => row.memberId === members[2].id)?.status, 'interrupted');
    await dispatchGroupMessages(runtime());
    assert.equal(groupsDb.deliveries(group.id).find(row => row.memberId === members[2].id)?.status, 'interrupted');
    groupsService.control(userId, group.id, false, 5, true);
    await dispatchGroupMessages(runtime());
    assert.ok(groupsDb.deliveries(group.id).every(row => row.status === 'completed'));
  });
});

test('the authenticated HTTP API validates input, isolates group owners and scopes member credentials', async () => {
  await fixture(async ({ userId, folder, base }) => {
    const { group, members: [a] } = create(userId, folder);
    const other = create(userId, folder);
    const request = (endpoint: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert.equal((await fetch(`${base}/api/groups/${group.id}`, { headers: { 'x-user': String(userId + 1) } })).status, 404);
    assert.equal((await request('/api/groups', { name: 'Bad', projectPath: folder, members: [{ name: 'One', provider: 'codex' }] })).status, 400);
    assert.equal((await request(`/api/groups/${group.id}/messages`, { kind: 'send', content: '', requestId: 'x' })).status, 400);
    assert.equal((await request('/group-bridge/read', {})).status, 401);
    const connection = JSON.parse(await readFile(path.join(folder, 'groups', group.id, `${a.id}.json`), 'utf8'));
    const result = await request('/group-bridge/publish', { groupId: other.group.id, senderId: other.members[0].id, content: 'Identity comes from the credential', requestId: 'identity' }, { authorization: `Bearer ${connection.token}` });
    assert.equal(result.status, 200);
    const body = await result.json() as { data: GroupMessage };
    assert.equal(body.data.groupId, group.id); assert.equal(body.data.senderId, a.id);
    assert.equal(groupsDb.recentMessages(other.group.id, 100).length, 0);
    const foreign = groupsService.post(other.group.id, null, { kind: 'send', content: 'Other group', requestId: 'other' });
    assert.equal((await request('/group-bridge/reply', { replyTo: foreign.id, content: 'Cross group', requestId: 'foreign' }, { authorization: `Bearer ${connection.token}` })).status, 404);
    assert.equal((await request(`/api/groups/${group.id}/dispatch`, { content: 'Task', assignments: {}, turns: -1, requestId: 'bad' })).status, 400);
  });
});

test('three provider sessions use the real CLI and HTTP bridge to request, reply, publish and resume', async () => {
  await fixture(async ({ userId, folder }) => {
    const { group, members: [a, b, c] } = create(userId, folder);
    groupsService.dispatch(userId, group.id, 'Discuss an interface', { [a.id]: 'Ask B about the interface', [b.id]: 'Answer A', [c.id]: 'Share context' }, 15, 'task');
    const executed: Array<{ member: string; incoming: string[] }> = [];
    const peerRuntime = runtime(async (_provider, command, options, writer: ProviderRuntimeWriter) => {
      const member = [a, b, c].find(item => item.sessionId === options.sessionId)!;
      const incoming = JSON.parse(command.split('Incoming group messages:\n')[1]) as GroupMessage[];
      executed.push({ member: member.name, incoming: incoming.map(item => item.kind) });
      if (member.id === a.id && incoming.some(item => item.kind === 'task')) {
        await cli(folder, a, 'request', { to: 'B', content: 'What API shape fits?', requestId: 'a-request' });
      }
      if (member.id === b.id) {
        for (const request of incoming.filter(item => item.kind === 'request')) {
          await cli(folder, b, 'reply', { replyTo: request.id, content: 'Use send, publish, request, reply and read.', requestId: 'b-reply' });
        }
      }
      if (member.id === c.id && incoming.some(item => item.kind === 'task')) {
        await cli(folder, c, 'publish', { title: 'Context', content: 'Keep responsibilities in the task input.', requestId: 'c-publish' });
      }
      if (member.id === a.id && incoming.some(item => item.kind === 'reply')) {
        const shared = await cli(folder, a, 'read', { publishedOnly: true });
        assert.equal(shared.messages[0].content, 'Keep responsibilities in the task input.');
        await cli(folder, a, 'publish', { title: 'Proposed interface', content: 'Five primitives with task-specific instructions.', requestId: 'a-publish' });
      }
      writer.send({ kind: 'complete', exitCode: 0 });
    });
    await dispatchGroupMessages(peerRuntime);
    await dispatchGroupMessages(peerRuntime);
    await dispatchGroupMessages(peerRuntime);
    assert.ok(executed.some(call => call.member === 'B' && call.incoming.includes('request')));
    assert.ok(executed.some(call => call.member === 'A' && call.incoming.includes('reply')));
    assert.equal(groupsService.read(group.id, undefined, 0, true).messages.length, 2);
    assert.ok(groupsDb.deliveries(group.id).some(row => row.status === 'completed'));
    assert.equal(executed.length, 5);
  });
});

test('peer messages enter an active native turn while its initial task is running, without consuming a new turn', async () => {
  await fixture(async ({ userId, folder }) => {
    const { group, members: [a, b] } = create(userId, folder, 2);
    groupsService.dispatch(userId, group.id, 'Work together', {}, 2, 'task');
    groupsDb.claim(a.id); groupsDb.claim(b.id);
    assert.equal(groupsDb.get(group.id)?.turnsRemaining, 0);
    const sent = groupsService.post(group.id, a.id, { kind: 'request', to: b.id, content: 'Use this finding during your current work', requestId: 'urgent' });
    const calls: string[] = [];
    let accept!: () => void;
    const gate = new Promise<void>(resolve => { accept = resolve; });
    const live = runtime(async () => { throw new Error('An existing turn should receive the message'); });
    live.steer = async (_provider, sessionId, content) => { calls.push(sessionId); assert.ok(content.includes(sent.content)); await gate; return { status: 'accepted', turnId: 'native-turn' }; };
    const first = dispatchGroupMessages(live);
    await new Promise(resolve => setImmediate(resolve));
    await dispatchGroupMessages(live);
    assert.equal(calls.length, 1);
    assert.equal(groupsDb.deliveries(group.id).find(row => row.messageId === sent.id)?.status, 'delivering');
    accept(); await first;
    assert.equal(groupsDb.deliveries(group.id).find(row => row.messageId === sent.id)?.status, 'delivered');
    assert.equal(groupsDb.get(group.id)?.turnsRemaining, 0);
  });
});

test('idle steering falls back to one new turn; ambiguous failures remain inspectable', async () => {
  await fixture(async ({ userId, folder }) => {
    const { group, members: [a, b] } = create(userId, folder, 2);
    groupsService.control(userId, group.id, false, 5);
    const sent = groupsService.post(group.id, a.id, { kind: 'send', to: b.id, content: 'Please inspect this', requestId: 'idle' });
    const idle = runtime(); idle.steer = async () => ({ status: 'idle' });
    await dispatchGroupMessages(idle);
    assert.equal(groupsDb.deliveries(group.id).find(row => row.messageId === sent.id)?.status, 'completed');
    assert.equal(groupsDb.get(group.id)?.turnsRemaining, 4);
    const uncertain = groupsService.post(group.id, a.id, { kind: 'send', to: b.id, content: 'Another finding', requestId: 'uncertain' });
    idle.steer = async () => { throw new Error('Connection timed out after write'); };
    await dispatchGroupMessages(idle);
    assert.equal(groupsDb.deliveries(group.id).find(row => row.messageId === uncertain.id)?.status, 'failed');
    assert.equal(groupsDb.get(group.id)?.turnsRemaining, 4);
  });
});


test('group sessions stay out of ordinary conversations, search and sidebar broadcasts', async () => {
  await fixture(async ({ userId, folder }) => {
    const { group, members } = create(userId, folder);
    sessionsDb.createAppSession('ordinary', 'codex', folder, 'Ordinary chat');
    assert.deepEqual(sessionsDb.getAllSessions().map(row => row.session_id), ['ordinary']);
    assert.deepEqual(sessionsDb.getRecentSessionsPage(20, 0).sessions.map(row => row.session_id), ['ordinary']);
    assert.equal(sessionsDb.getRecentSessionsPage(20, 0).total, 1);
    assert.equal(sessionsDb.countSessionsByProjectPath(folder), 1);
    assert.deepEqual(sessionsDb.getSessionsByProjectPathPage(folder, 20, 0).map(row => row.session_id), ['ordinary']);
    let broadcasts = 0;
    const client = { readyState: 1, send: () => { broadcasts++; } } as never;
    connectedClients.add(client);
    try { await broadcastSessionUpserted(members[0].sessionId); assert.equal(broadcasts, 0); }
    finally { connectedClients.delete(client); }
    assert.deepEqual(sessionsService.getSessionDetailsById(members[0].sessionId).group, { groupId: group.id, memberId: members[0].id });
    groupsService.updateMember(userId, group.id, members[0].id, 'new-model', 'high');
    const updated = groupsDb.members(group.id)[0];
    assert.equal(updated.model, 'new-model'); assert.equal(updated.effort, 'high');
    sessionsDb.setSessionModel(members[0].sessionId, 'changed-from-console');
    assert.equal(groupsDb.members(group.id)[0].model, 'changed-from-console');
  });
});

test('short peer bursts coalesce before steering, and the group instruction requires independent considered replies', async () => {
  await fixture(async ({ userId, folder }) => {
    const { group, members: [a, b] } = create(userId, folder, 2);
    groupsService.control(userId, group.id, false, 10);
    for (let i = 0; i < 3; i++) groupsService.post(group.id, a.id, { kind: 'send', to: b.id, content: `Finding ${i}`, requestId: `burst-${i}` });
    let count = 0;
    const live = runtime();
    live.steer = async (_provider, _sessionId, content) => { count++; assert.ok(content.includes('Finding 0') && content.includes('Finding 2')); return { status: 'accepted' }; };
    await dispatchNow(live, Date.now()); assert.equal(count, 0);
    await dispatchNow(live, Date.now() + 3000); assert.equal(count, 1);
    const state = groupsService.snapshot(userId, group.id);
    assert.match(state.systemPrompt, /Independently examine evidence/);
    assert.match(state.systemPrompt, /Combine related points/);
    assert.match(state.systemPrompt, /Base agreement on your own assessment/);
  });
});
