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

import { apiKeysDb, closeConnection, contextTransferDb, initializeDatabase, sessionsDb, userDb } from '@/modules/database/index.js';
import { createProviderRuntimeService } from '@/modules/providers/index.js';
import { contextTransferRoutes } from '@/modules/context-transfer/context-transfer.routes.js';
import { contextSnapshotService, createContextSnapshotService } from '@/modules/context-transfer/services/context-snapshot.service.js';
import { contextPackageService } from '@/modules/context-transfer/services/context-package.service.js';
import { createContextDeliveryService } from '@/modules/context-transfer/services/context-delivery.service.js';
import { AppError } from '@/shared/index.js';
import type { ContextBriefing, ContextPackageInput, ContextSnapshot, IProvider, NormalizedMessage } from '@/shared/index.js';

const message = (role: 'user' | 'assistant', content: string, extra: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  id: `${role}:${content}`, kind: 'text', role, content, provider: 'claude', sessionId: 'source', timestamp: '2026-11-06T10:00:00Z', ...extra,
});
const transcript = () => [
  message('user', 'Design a cache. Preserve encrypted values.'), message('assistant', 'Use SQLite as persistent storage.'),
  message('user', 'Implement that cache.'), message('assistant', 'wrote cache.ts', { kind: 'tool_use', toolName: 'Write', toolId: 'call1', toolInput: { file: 'cache.ts' }, toolResult: { content: 'saved' } }),
  message('user', 'New topic: plan a trip.'), message('assistant', 'Travel recommendation.'),
  message('user', 'Back to the cache. Verify it and hand off.'), message('assistant', 'Tests still need to run.'),
  message('assistant', 'private reasoning should stay out', { kind: 'thinking' as NormalizedMessage['kind'] }),
];

async function fixture(run: (state: { userId: number; otherId: number; folder: string; snapshot: ContextSnapshot }) => Promise<void>) {
  const previous = process.env.DATABASE_PATH;
  const folder = await mkdtemp(path.join(os.tmpdir(), 'orbit-context-'));
  closeConnection(); process.env.DATABASE_PATH = path.join(folder, 'auth.db'); await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();
  const userId = Number(userDb.createUser('owner', 'hash').id), otherId = Number(userDb.createUser('other', 'hash').id);
  sessionsDb.createAppSession('source', 'claude', folder, 'Source');
  sessionsDb.createAppSession('target', 'codex', folder, 'Target');
  try {
    const snapshots = createContextSnapshotService({ running: () => false, history: async () => ({ messages: transcript(), total: 9, hasMore: false, offset: 0, limit: null }) });
    const snapshot = await snapshots.prepare(userId, 'source');
    await run({ userId, otherId, folder, snapshot });
  } finally { closeConnection(); if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous; await rm(folder, { recursive: true, force: true }); }
}

function input(snapshot: ContextSnapshot, scope: ContextPackageInput['scope'] = { kind: 'all_topics' }, granularity: ContextPackageInput['granularity'] = 'coarse'): ContextPackageInput {
  const turns = scope.kind === 'all_topics' ? [1, 2, 3, 4] : [1, 2, 4];
  const briefing: ContextBriefing = { author: 'source agent', topics: turns.map(turn => ({ title: `Topic ${turn}`, summary: turn === 3 ? 'Travel plan' : 'Cache work', turns: [turn] })), items: [
    { kind: 'constraint', status: 'reported', text: 'Preserve encryption.', refs: ['r1'] },
    { kind: 'artifact', status: 'observed', text: 'cache.ts was written.', refs: ['r4'] },
    { kind: 'next_step', status: 'proposed', text: 'Run tests next.', refs: ['r8'] },
  ] };
  return { snapshotId: snapshot.id, scope, granularity, briefing, maxChars: 16_000 };
}
const recent = (): ContextPackageInput['scope'] => ({ kind: 'recent_topic', title: 'Cache implementation', confidence: 'high', rationale: 'The latest user resumes the earlier cache objective after a travel detour.', focus: [{ from: 4, to: 4 }], background: [{ from: 1, to: 2, reason: 'Original encryption requirement and implementation state.' }] });

test('single-session snapshots preserve tool evidence, exclude thinking and stay immutable after the source grows', async () => fixture(async ({ userId, otherId, snapshot }) => {
  assert.equal(snapshot.sourceSessionId, 'source'); assert.equal(snapshot.records.length, 8);
  assert.equal(snapshot.records[3].toolName, 'Write'); assert.deepEqual(snapshot.records[3].result, { content: 'saved' });
  assert.equal(contextTransferDb.snapshot(otherId, snapshot.id), null);
  const service = createContextSnapshotService({ running: () => true, history: async () => ({ messages: [...transcript(), message('user', 'A later task')], total: 10, hasMore: false, offset: 0, limit: null }) });
  const later = await service.prepare(userId, 'source');
  assert.notEqual(snapshot.fingerprint, later.fingerprint); assert.equal(later.sourceWasRunning, true);
  assert.equal(contextTransferDb.snapshot(userId, snapshot.id)?.records.length, 8);
  assert.ok(later.limitations.some(value => value.includes('working')));
}));

test('all-topic and recent-topic scope compose with both coarse and fine detail', async () => fixture(async ({ userId, snapshot }) => {
  for (const scope of [{ kind: 'all_topics' } as const, recent()]) for (const granularity of ['coarse', 'fine'] as const) {
    const value = await contextPackageService.create(userId, input(snapshot, scope, granularity));
    const records = contextPackageService.records(userId, value.id);
    assert.equal(records.length, scope.kind === 'all_topics' ? 8 : 6);
    assert.equal(records.some(row => row.content.includes('trip')), scope.kind === 'all_topics');
    assert.equal(value.inlineRefs.length > 0, granularity === 'fine');
    assert.equal(value.text.includes('Execution evidence'), granularity === 'fine');
    assert.ok(value.text.length <= value.maxChars);
    assert.deepEqual(JSON.parse(await readFile(value.bundlePath, 'utf8')).records, records);
    assert.equal((await readFile(value.recordsPath, 'utf8')).trim().split('\n').length, records.length);
  }
}));

test('topic validation retains all selected topics, the latest turn and evidence inside the scope', async () => fixture(async ({ userId, snapshot }) => {
  const missingTopic = input(snapshot); missingTopic.briefing.topics.pop();
  await assert.rejects(contextPackageService.create(userId, missingTopic), /cover every selected turn/);
  const wrongRef = input(snapshot, recent()); wrongRef.briefing.items[0].refs = ['r5'];
  await assert.rejects(contextPackageService.create(userId, wrongRef), /inside the selected scope/);
  const oldTopic = recent(); if (oldTopic.kind === 'recent_topic') oldTopic.focus = [{ from: 1, to: 2 }];
  await assert.rejects(contextPackageService.create(userId, input(snapshot, oldTopic)), /latest turn/);
  const forged = input(snapshot); forged.briefing.items[0].refs = ['r999'];
  await assert.rejects(contextPackageService.create(userId, forged), /evidence references/);
}));

test('small inline budgets keep the complete evidence separately and reject an oversized briefing', async () => fixture(async ({ userId, snapshot }) => {
  const changed = structuredClone(snapshot); changed.id += '-large'; changed.records[3].content = 'A'.repeat(20_000);
  contextTransferDb.saveSnapshot(userId, changed);
  const request = input(changed, recent(), 'fine'); request.maxChars = 4000;
  const value = await contextPackageService.create(userId, request);
  assert.ok(value.omittedRefs.includes('r4')); assert.ok(value.text.length <= 4000);
  assert.match(await readFile(value.recordsPath, 'utf8'), /A{20000}/);
  request.briefing.topics[0].summary = 'B'.repeat(5000);
  await assert.rejects(contextPackageService.create(userId, request), /complete briefing exceeds/);
}));

test('attachments are consumed once through the provider runtime without waking the target on creation', async () => fixture(async ({ userId, snapshot }) => {
  const value = await contextPackageService.create(userId, input(snapshot));
  let starts = 0;
  const deliveries = createContextDeliveryService({ start: async () => { starts++; return { started: true, error: null }; } });
  const request = { targetSessionId: 'target', mode: 'attach' as const, instruction: 'Use this background for the next question.', requestId: 'same' };
  const receipt = await deliveries.deliver(userId, value.id, request);
  assert.equal(receipt.status, 'pending'); assert.equal(starts, 0);
  assert.equal((await deliveries.deliver(userId, value.id, request)).id, receipt.id);
  await assert.rejects(deliveries.deliver(userId, value.id, { ...request, instruction: 'Different' }), /requestId/);
  const commands: string[] = [];
  const runtime = createProviderRuntimeService({ groupInstructions: () => undefined, resolveProvider: () => ({ id: 'codex', runtime: {
    async run(command: string, _options: unknown, writer: { send(data: unknown): void }) { commands.push(command); writer.send({ kind: 'complete', exitCode: 0 }); },
  } }) as unknown as IProvider });
  await Promise.all([runtime.run('codex', 'First question', { sessionId: 'target' }, { send() {} }), runtime.run('codex', 'Second question', { sessionId: 'target' }, { send() {} })]);
  assert.equal(commands.filter(command => command.includes('Orbit context transfer')).length, 1);
  assert.equal(deliveries.read(userId, receipt.id).status, 'delivered');
}));

test('explicit start protects busy work; live delivery records acceptance, unsupported input and ambiguous failures', async () => fixture(async ({ userId, snapshot }) => {
  const value = await contextPackageService.create(userId, input(snapshot));
  const request = { targetSessionId: 'target', mode: 'start' as const, instruction: 'Continue.', requestId: 'start' };
  const busy = createContextDeliveryService({ running: async () => true });
  await assert.rejects(busy.deliver(userId, value.id, request), /target is working/);
  let steers = 0;
  const live = createContextDeliveryService({ steer: async () => { steers++; return { status: 'accepted' }; } });
  const steer = { ...request, mode: 'steer' as const, requestId: 'live' };
  assert.equal((await live.deliver(userId, value.id, steer)).status, 'delivered');
  await live.deliver(userId, value.id, steer); assert.equal(steers, 1);
  const unsupported = createContextDeliveryService({ steer: async () => ({ status: 'unsupported' }) });
  assert.equal((await unsupported.deliver(userId, value.id, { ...steer, requestId: 'unsupported' })).status, 'failed');
  const timeout = createContextDeliveryService({ steer: async () => { throw new Error('timeout after submission'); } });
  const receipt = await timeout.deliver(userId, value.id, { ...steer, requestId: 'timeout' });
  assert.equal(receipt.status, 'uncertain');
  assert.equal(contextTransferDb.claim('target').length, 0);
}));

test('pending cancellation and restart recovery keep delivery states explicit', async () => fixture(async ({ userId, snapshot }) => {
  const value = await contextPackageService.create(userId, input(snapshot));
  const service = createContextDeliveryService();
  const receipt = await service.deliver(userId, value.id, { targetSessionId: 'target', mode: 'attach', instruction: 'Read later.', requestId: 'cancel' });
  assert.equal(service.cancel(userId, receipt.id).status, 'cancelled');
  assert.equal(contextTransferDb.claim('target').length, 0);
  const pending = await service.deliver(userId, value.id, { targetSessionId: 'target', mode: 'attach', instruction: 'Read later.', requestId: 'restart' });
  contextTransferDb.claim('target'); contextTransferDb.recover();
  assert.equal(service.read(userId, pending.id).status, 'uncertain');
  assert.equal(contextTransferDb.claim('target').length, 0);
}));

test('REST and universal CLI enforce authentication, ownership, pagination and scope parsing', async () => fixture(async ({ userId, otherId, folder, snapshot }) => {
  const app = express().use(express.json()).use('/api/context', contextTransferRoutes);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => res.status(error instanceof AppError ? error.statusCode : 500).json({ success: false, error: { message: String(error) } }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/context`;
  const key = apiKeysDb.createApiKey(userId, 'test').apiKey, otherKey = apiKeysDb.createApiKey(otherId, 'other').apiKey;
  try {
    assert.equal((await fetch(`${base}/snapshots/${snapshot.id}/records`)).status, 401);
    assert.equal((await fetch(`${base}/snapshots/${snapshot.id}/records`, { headers: { 'x-api-key': otherKey } })).status, 404);
    const response = await fetch(`${base}/snapshots/${snapshot.id}/records?limit=2&offset=2`, { headers: { 'x-api-key': key } });
    const page = (await response.json() as { data: { total: number; items: Array<{ ref: string }>; hasMore: boolean } }).data; assert.equal(page.total, 8); assert.equal(page.items[0].ref, 'r3'); assert.equal(page.hasMore, true);
    const malformed = await fetch(`${base}/packages`, { method: 'POST', headers: { 'x-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input(snapshot), granularity: 'made-up' }) });
    assert.equal(malformed.status, 400);
    const connection = path.join(folder, 'connection.json'); await writeFile(connection, JSON.stringify({ url: base, apiKey: key }), { mode: 0o600 });
    const child = spawn(process.execPath, [path.resolve('scripts/orbit-context.mjs'), '--connection', connection, 'create'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
    child.stdin.end(JSON.stringify(input(snapshot, recent(), 'fine')));
    const [code] = await once(child, 'exit'); assert.equal(code, 0, errors); assert.equal(JSON.parse(output).selectedRefs.length, 6);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}));

test('snapshots survive source deletion and their explicit removal cleans local exports and pending inputs', async () => fixture(async ({ userId, snapshot }) => {
  const value = await contextPackageService.create(userId, input(snapshot));
  const delivery = await createContextDeliveryService().deliver(userId, value.id, { targetSessionId: 'target', mode: 'attach', instruction: 'Context for later.', requestId: 'cleanup' });
  // Mirror the session repository's SQL deletion while retaining the independent export.
  const { getConnection } = await import('@/modules/database/index.js');
  getConnection().prepare('DELETE FROM sessions WHERE session_id = ?').run('source');
  assert.equal(contextPackageService.records(userId, value.id).length, 8);
  await contextSnapshotService.remove(userId, snapshot.id);
  assert.equal(contextTransferDb.snapshot(userId, snapshot.id), null);
  assert.equal(contextTransferDb.delivery(userId, delivery.id), null);
  await assert.rejects(readFile(value.bundlePath), /ENOENT/);
}));

test('provider failure records an uncertain attachment and preserves single submission', async () => fixture(async ({ userId, snapshot }) => {
  const value = await contextPackageService.create(userId, input(snapshot));
  const service = createContextDeliveryService();
  const receipt = await service.deliver(userId, value.id, { targetSessionId: 'target', mode: 'attach', instruction: 'Context.', requestId: 'crash' });
  const runtime = createProviderRuntimeService({ groupInstructions: () => undefined, resolveProvider: () => ({ id: 'codex', runtime: { async run() { throw new Error('Connection lost after send'); } } }) as unknown as IProvider });
  await assert.rejects(runtime.run('codex', 'Continue', { sessionId: 'target' }, { send() {} }), /Connection lost/);
  assert.equal(service.read(userId, receipt.id).status, 'uncertain');
  assert.equal(contextTransferDb.claim('target').length, 0);
}));
