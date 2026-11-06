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

import { closeConnection, contextRequestsDb, getConnection, initializeDatabase, sessionsDb, userDb } from '@/modules/database/index.js';
import { contextBridgeRoutes } from '@/modules/context-transfer/context-transfer.routes.js';
import { createContextRequestService } from '@/modules/context-transfer/services/context-request.service.js';
import { createContextSnapshotService } from '@/modules/context-transfer/services/context-snapshot.service.js';
import { AppError } from '@/shared/index.js';
import type { ContextPackageInput, ContextRequest, ContextRequestInput, LLMProvider, NormalizedMessage } from '@/shared/index.js';

const turn = (role: 'user' | 'assistant', content: string): NormalizedMessage => ({ id: `${role}:${content}`, role, content, kind: 'text', provider: 'codex', sessionId: 'source', timestamp: new Date().toISOString() });
const scriptedRuns: Promise<unknown>[] = [];
function scripted(run: (userId: number, request: ContextRequest, prompt: string) => Promise<{ started: boolean; error: string | null }>) {
  return (userId: number, request: ContextRequest, prompt: string) => { const promise = run(userId, request, prompt); scriptedRuns.push(promise); return promise; };
}
const history = [turn('user', 'Cache values must remain encrypted.'), turn('assistant', 'Use SQLite.'), turn('user', 'Continue implementing the cache.'), turn('assistant', 'cache.ts written; tests are pending.')];
function input(provider: LLMProvider = 'codex'): ContextRequestInput {
  return { sourceSessionId: 'source', requestId: 'test-request', scope: 'recent_topic', granularity: 'fine', mode: 'attach', instruction: 'Continue verifying the cache.', sourceModel: 'source-model', sourceEffort: 'high', permissionMode: 'default', target: { kind: 'new', provider, model: 'target-model', effort: 'high' } };
}
function packageInput(request: ContextRequest): ContextPackageInput {
  return { snapshotId: request.snapshotId!, scope: request.input.scope === 'all_topics' ? { kind: 'all_topics' } : { kind: 'recent_topic', title: 'Cache', rationale: 'Implementation continues the original requirement.', confidence: 'high', focus: [{ from: 2, to: 2 }], background: [{ from: 1, to: 1, reason: 'Encryption requirement.' }] }, granularity: request.input.granularity, maxChars: 16000,
    briefing: { author: 'source agent', topics: [{ title: 'Cache', summary: 'SQLite cache awaiting verification.', turns: [1, 2] }], items: [{ kind: 'constraint', status: 'reported', text: 'Preserve encryption.', refs: ['r1'] }, { kind: 'next_step', status: 'proposed', text: 'Run tests.', refs: ['r4'] }] } };
}
async function fixture(run: (state: { userId: number; folder: string; base: string; prepare: ReturnType<typeof createContextSnapshotService>['prepare'] }) => Promise<void>, provider: LLMProvider = 'codex') {
  const previous = { DATABASE_PATH: process.env.DATABASE_PATH, HOST: process.env.HOST, SERVER_PORT: process.env.SERVER_PORT };
  const folder = await mkdtemp(path.join(os.tmpdir(), 'orbit-context-request-'));
  closeConnection(); process.env.DATABASE_PATH = path.join(folder, 'auth.db'); await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase(); const userId = Number(userDb.createUser('request-owner', 'hash').id);
  sessionsDb.createAppSession('source', provider, folder, 'Cache source'); sessionsDb.assignProviderSessionId('source', 'native-source');
  sessionsDb.createAppSession('target', 'codex', folder, 'Existing target');
  const snapshots = createContextSnapshotService({ running: () => false, history: async () => ({ messages: history, total: history.length, hasMore: false, offset: 0, limit: null }) });
  const app = express().use(express.json()).use('/context-bridge', contextBridgeRoutes);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => res.status(error instanceof AppError ? error.statusCode : 500).json({ success: false, error: { message: error instanceof Error ? error.message : String(error) } }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  process.env.HOST = '127.0.0.1'; process.env.SERVER_PORT = String((server.address() as AddressInfo).port);
  try { await run({ userId, folder, base: `http://127.0.0.1:${process.env.SERVER_PORT}/context-bridge`, prepare: snapshots.prepare.bind(snapshots) }); }
  finally { await Promise.allSettled(scriptedRuns.splice(0)); await new Promise(resolve => setImmediate(resolve)); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); closeConnection(); for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await rm(folder, { recursive: true, force: true }); }
}
async function cli(folder: string, request: ContextRequest, body: unknown) {
  const child = spawn(process.execPath, [path.resolve('scripts/orbit-context.mjs'), '--connection', path.join(folder, 'context-requests', request.id, 'connection.json'), 'create'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = ''; child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { errors += value; });
  child.stdin.end(JSON.stringify(body)); const [code] = await once(child, 'exit'); assert.equal(code, 0, errors); return JSON.parse(output) as { id: string; selectedRecords: number };
}
async function until(check: () => boolean) { for (let attempt = 0; attempt < 100; attempt++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('Timed out waiting for the scripted source agent.'); }

for (const provider of ['claude', 'codex', 'opencode', 'cursor'] as const) test(`${provider} source authors a scoped package through the CLI and hands it to a new session`, async () => fixture(async ({ userId, folder, prepare }) => {
  let sourceTurns = 0;
  const service = createContextRequestService({ running: async () => new Set(), prepare, sourceTurn: scripted(async (_owner, request, prompt) => {
    sourceTurns++; assert.match(prompt, /Orbit context preparation/); assert.match(prompt, /scoped CLI/);
    assert.equal(request.input.sourceModel, 'source-model');
    const result = await cli(folder, service.read(userId, request.id), packageInput(service.read(userId, request.id)));
    assert.equal(result.selectedRecords, 4);
    return { started: true, error: null };
  }) });
  const request = await service.create(userId, input(provider));
  assert.equal((await service.create(userId, input(provider))).id, request.id);
  await service.tick(); await until(() => service.read(userId, request.id).status === 'ready');
  await service.tick();
  const done = service.view(userId, request.id);
  assert.equal(done.status, 'completed'); assert.equal(done.delivery?.status, 'pending'); assert.equal(sourceTurns, 1);
  const target = sessionsDb.getSessionById(done.targetSessionId!);
  assert.equal(target?.provider, provider); assert.equal(target?.model, 'target-model'); assert.equal(target?.effort, 'high');
  const repeated = await cli(folder, service.read(userId, request.id), packageInput(service.read(userId, request.id)));
  assert.equal(repeated.id, done.packageId, 'late CLI retries retrieve the same package after delivery');
  await service.tick(); assert.equal(sourceTurns, 1);
}, provider));

test('busy source/recipient waits, current source retains one active request, and cancelling revokes its bridge', async () => fixture(async ({ userId, folder, base, prepare }) => {
  const running = new Set(['source']); let sourceTurns = 0;
  const service = createContextRequestService({ running: async () => running, prepare, sourceTurn: scripted(async (_owner, request) => {
    sourceTurns++; await cli(folder, service.read(userId, request.id), packageInput(service.read(userId, request.id))); return { started: true, error: null };
  }) });
  const request = await service.create(userId, { ...input(), mode: 'start', target: { kind: 'existing', sessionId: 'target' } });
  await service.tick(); assert.equal(sourceTurns, 0); assert.equal(service.read(userId, request.id).status, 'queued');
  await assert.rejects(service.create(userId, { ...input(), requestId: 'overlap' }), /已有一项/);
  running.delete('source'); running.add('target'); await service.tick(); await until(() => service.read(userId, request.id).status === 'ready');
  await service.tick(); assert.equal(service.read(userId, request.id).status, 'ready');
  const connection = JSON.parse(await readFile(path.join(folder, 'context-requests', request.id, 'connection.json'), 'utf8')) as { token: string };
  const headers = { Authorization: `Bearer ${connection.token}` };
  assert.equal((await fetch(`${base}/${request.id}/snapshots/wrong/records`, { headers })).status, 403);
  service.cancel(userId, request.id);
  assert.equal((await fetch(`${base}/${request.id}/snapshots/${service.read(userId, request.id).snapshotId}/records`, { headers })).status, 401);
  assert.equal(sourceTurns, 1);
}));

test('a failed authoring turn can retry with the same choices and a fresh credential', async () => fixture(async ({ userId, folder, prepare }) => {
  let succeed = false;
  const service = createContextRequestService({ running: async () => new Set(), prepare, sourceTurn: scripted(async (_owner, request) => {
    if (succeed) await cli(folder, service.read(userId, request.id), packageInput(service.read(userId, request.id)));
    return { started: true, error: null };
  }) });
  const request = await service.create(userId, input());
  const oldCredential = await readFile(path.join(folder, 'context-requests', request.id, 'connection.json'), 'utf8');
  await service.tick(); await until(() => service.read(userId, request.id).status === 'failed');
  succeed = true; await service.retry(userId, request.id); await service.tick(); await until(() => service.read(userId, request.id).status === 'ready');
  assert.notEqual(await readFile(path.join(folder, 'context-requests', request.id, 'connection.json'), 'utf8'), oldCredential);
  await service.tick(); assert.equal(service.read(userId, request.id).status, 'completed');
}));

test('the bridge enforces chosen granularity and expired credentials while resuming a native source turn across restart', async () => fixture(async ({ userId, folder, base, prepare }) => {
  const running = new Set<string>();
  const service = createContextRequestService({ running: async () => running, prepare, sourceTurn: async () => { running.add('source'); return new Promise(() => {}); } });
  const request = await service.create(userId, input()); await service.tick();
  const current = service.read(userId, request.id);
  const connection = JSON.parse(await readFile(path.join(folder, 'context-requests', request.id, 'connection.json'), 'utf8')) as { token: string };
  const headers = { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${base}/${request.id}/packages`, { method: 'POST', headers, body: JSON.stringify({ ...packageInput(current), granularity: 'coarse' }) })).status, 400);
  contextRequestsDb.recover();
  const resumed = createContextRequestService({ running: async () => running, prepare }); await resumed.tick();
  assert.equal(resumed.read(userId, request.id).status, 'analyzing');
  getConnection().prepare('UPDATE context_requests SET token_expires_at = ? WHERE id = ?').run('2000-01-01', request.id);
  assert.equal((await fetch(`${base}/${request.id}/snapshots/${current.snapshotId}/records`, { headers })).status, 401);
}));

test('subsequent snapshots retain the substantive topic and skip earlier transfer bookkeeping', async () => fixture(async ({ userId }) => {
  const messages = [...history, turn('user', '[Orbit context preparation 00000000-0000-0000-0000-000000000000]\nInternal preparation.'), turn('assistant', 'Package generated.'), turn('user', 'Now verify the cache.'), turn('assistant', 'All tests passed.')];
  const service = createContextSnapshotService({ running: () => false, history: async () => ({ messages, total: messages.length, hasMore: false, offset: 0, limit: null }) });
  const snapshot = await service.prepare(userId, 'source');
  assert.equal(snapshot.records.length, 6); assert.equal(snapshot.records.at(-1)?.turn, 3); assert.equal(snapshot.records.some(row => row.content.includes('Internal preparation')), false);
}));
