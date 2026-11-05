import assert from 'node:assert/strict';
import { randomUUID, scryptSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { WebSocket } from 'ws';

import { createGuestChatService } from '@/modules/guest-chat/guest-chat.service.js';
import { createGuestServer } from '@/modules/guest-chat/guest-chat.server.js';
import { allowedGuestDestination } from '@/modules/guest-chat/guest-egress.server.js';

class FakeCodex extends EventEmitter {
  calls: Array<{ method: string; params: any }> = [];
  async initialize() {}
  async call(method: string, params: any): Promise<any> {
    this.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: randomUUID() } };
    if (method === 'thread/resume') return { thread: { id: params.threadId } };
    if (method === 'turn/interrupt') this.emit('notification', { method: 'turn/completed', params: { threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted' } } });
    return { turn: { id: 'turn' } };
  }
  close() {}
}

async function setup(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'guest-chat-test-'));
  await writeFile(path.join(root, 'index.html'), '<h1>Guest</h1>');
  const client = new FakeCodex();const service = await createGuestChatService(root, client);
  const credentials = { username: 'family', passwordSalt: 'test-salt', passwordHash: scryptSync('strong-test-password', 'test-salt', 32).toString('hex'), sessionSecret: 's'.repeat(64) };
  const server = createGuestServer(service, credentials, root);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (url: string, data?: unknown, cookie = '', origin = base) => fetch(base + url, {
    method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const login = async () => {
    const response = await request('/api/login', { username: 'family', password: 'strong-test-password' });
    assert.equal(response.status, 200);const cookie = response.headers.get('set-cookie')!;
    assert.match(cookie, /Secure; HttpOnly; SameSite=Strict/);return cookie.split(';')[0];
  };
  t.after(async () => { await service.close();server.closeAllConnections();await new Promise<void>(resolve => server.close(() => resolve()));await rm(root, { recursive: true, force: true }); });
  return { root, client, service, server, request, login };
}

test('public guest routes enforce login, origin, cookie authenticity and logout revocation', async t => {
  const f = await setup(t);
  assert.equal((await f.request('/')).status, 200);
  assert.equal((await f.request('/api/chats')).status, 401);
  assert.equal((await f.request('/api/login', { username: 'family', password: 'wrong' })).status, 401);
  const cookie = await f.login();
  assert.equal((await f.request('/api/chats', {}, cookie, 'https://attacker.example')).status, 403);
  assert.equal((await f.request('/api/chats', undefined, cookie + 'forged')).status, 401);
  assert.equal((await f.request('/api/chats', undefined, cookie)).status, 200);
  assert.equal((await f.request('/api/logout', {}, cookie)).status, 200);
  assert.equal((await f.request('/api/chats', undefined, cookie)).status, 401);
});

test('authenticated guest has no company API, files, terminal, foreign session or caller-selected native parameters', async t => {
  const f = await setup(t);const cookie = await f.login();
  for (const route of ['/api/providers/sessions/recent', '/api/providers/sessions/running', '/api/files', '/api/auth/status', '/shell', '/ws', '/.codex/auth.json', '/assets/../guest.mjs']) {
    assert.equal((await f.request(route, undefined, cookie)).status, 404, route);
  }
  assert.equal((await f.request('/api/chats/' + randomUUID(), undefined, cookie)).status, 404);
  assert.equal((await f.request('/api/chats', { threadId: 'company-thread' }, cookie)).status, 400);
  const chat: any = await (await f.request('/api/chats', {}, cookie)).json();
  for (const extra of [{ model: 'other' }, { threadId: 'company' }, { cwd: '/home/potentia' }]) {
    assert.equal((await f.request(`/api/chats/${chat.id}/messages`, { text: 'Hello', images: [], requestId: randomUUID(), ...extra }, cookie)).status, 400);
  }
  assert.ok(f.client.calls.every(call => call.method === 'thread/start'));
});

test('live guest sockets require authentication and matching Origin, and push only the selected guest transcript', async t => {
  const f = await setup(t);const cookie = await f.login();const chat = await f.service.create();
  const base = `127.0.0.1:${(f.server.address() as { port: number }).port}`;
  for (const headers of [{ Origin: `http://${base}` }, { Cookie: cookie, Origin: 'https://attacker.example' }]) {
    const ws = new WebSocket(`ws://${base}/api/live/${chat.id}`, { headers });ws.on('error', () => {});
    const status = await new Promise<number>(resolve => ws.once('unexpected-response', (_req, res) => { resolve(res.statusCode!);res.resume();ws.terminate(); }));
    assert.ok([401, 403].includes(status));
  }
  const ws = new WebSocket(`ws://${base}/api/live/${chat.id}`, { headers: { Cookie: cookie, Origin: `http://${base}` } });
  t.after(() => ws.terminate());
  const first: any = await new Promise(resolve => ws.once('message', bytes => resolve(JSON.parse(String(bytes)))));
  assert.match(ws.extensions, /permessage-deflate/);
  assert.equal(first.id, chat.id);assert.deepEqual(first.messages, []);
  await f.service.send(chat.id, 'Explain', [], randomUUID());await new Promise(resolve => setTimeout(resolve, 20));
  const threadId = f.client.calls.find(call => call.method === 'turn/start')!.params.threadId;
  const update = new Promise<any>(resolve => ws.once('message', bytes => resolve(JSON.parse(String(bytes)))));
  f.client.emit('notification', { method: 'item/reasoning/summaryTextDelta', params: { threadId, itemId: 'reason', summaryIndex: 0, delta: '先检查题目条件。' } });
  f.client.emit('notification', { method: 'item/reasoning/textDelta', params: { threadId, itemId: 'reason', delta: 'raw reasoning should stay private' } });
  const next = await update;
  assert.equal(next.partial, true);assert.equal(next.messages.at(-1).reasoning, '先检查题目条件。');
  assert.equal(JSON.stringify(next).includes('raw reasoning'), false);assert.equal('nativeId' in next, false);
  ws.close();
});

test('guest send pins Astra/high, serializes turns, deduplicates retries and renders streamed completion', async t => {
  const f = await setup(t);const cookie = await f.login();
  const chat: any = await (await f.request('/api/chats', {}, cookie)).json();
  const data = { text: 'Explain 1+1', images: [], requestId: randomUUID() };
  assert.equal((await f.request(`/api/chats/${chat.id}/messages`, data, cookie)).status, 202);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await f.request(`/api/chats/${chat.id}/messages`, data, cookie)).status, 202);
  assert.equal((await f.request(`/api/chats/${chat.id}/messages`, { ...data, requestId: randomUUID() }, cookie)).status, 409);
  const turns = f.client.calls.filter(c => c.method === 'turn/start');assert.equal(turns.length, 1);
  assert.equal(turns[0].params.model, 'gpt-6-astra');assert.equal(turns[0].params.effort, 'high');
  const thread = f.client.calls.find(c => c.method === 'thread/start')!;
  assert.equal(thread.params.sandbox, 'read-only');assert.equal(thread.params.cwd, '/workspace');
  const threadId = turns[0].params.threadId;
  f.client.emit('notification', { method: 'item/agentMessage/delta', params: { threadId, itemId: 'answer', delta: '1+1=' } });
  f.client.emit('notification', { method: 'item/completed', params: { threadId, item: { type: 'agentMessage', id: 'answer', text: '1+1=2' } } });
  f.client.emit('notification', { method: 'turn/completed', params: { threadId, turn: { id: 'turn', status: 'completed' } } });
  const view: any = await (await f.request(`/api/chats/${chat.id}`, undefined, cookie)).json();
  assert.equal(view.busy, false);assert.equal(view.messages.length, 2);assert.equal(view.messages[1].text, '1+1=2');
  assert.equal('nativeId' in view, false);assert.equal('turnId' in view, false);
  assert.equal(JSON.stringify(view).includes(threadId), false);
});

test('images are bounded, authenticated and owned; external URLs and executable formats are rejected', async t => {
  const f = await setup(t);const cookie = await f.login();const chat = await f.service.create();
  const route = `/api/chats/${chat.id}/messages`;
  for (const image of ['https://internal.example/private.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,YWJj', 'data:image/jpeg;base64,' + 'A'.repeat(7_000_001)]) {
    assert.equal((await f.request(route, { text: '', images: [image], requestId: randomUUID() }, cookie)).status, 400);
  }
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6WlIAAAAASUVORK5CYII=';
  assert.equal((await f.request(route, { text: '', images: [png], requestId: randomUUID() }, cookie)).status, 202);
  const view = f.service.read(chat.id);const id = view.messages[0].images[0];
  assert.equal((await f.request('/api/images/' + id)).status, 401);
  assert.equal((await f.request('/api/images/' + id, undefined, cookie)).headers.get('content-type'), 'image/png');
  assert.equal((await f.request('/api/images/' + randomUUID() + '.png', undefined, cookie)).status, 404);
});

test('guest errors and stop clear working state, and its store resumes only allocated native threads', async t => {
  const f = await setup(t);const chat = await f.service.create();
  await f.service.send(chat.id, 'question', [], randomUUID());await new Promise(resolve => setTimeout(resolve, 20));
  const threadId = f.client.calls.find(c => c.method === 'turn/start')!.params.threadId;
  f.client.emit('notification', { method: 'error', params: { threadId, willRetry: false, error: { message: 'Selected model is at capacity.' } } });
  assert.equal(f.service.read(chat.id).busy, false);assert.match(f.service.read(chat.id).error!, /capacity/);
  await f.service.send(chat.id, 'continue', [], randomUUID());await f.service.stop(chat.id);
  assert.equal(f.service.read(chat.id).busy, false);
  await f.service.close();
  const client = new FakeCodex();const reopened = await createGuestChatService(f.root, client);
  assert.equal(reopened.list().length, 1);
  await reopened.send(chat.id, 'another', [], randomUUID());await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(client.calls[0].method, 'thread/resume');assert.equal(client.calls[0].params.threadId, threadId);
  await reopened.close();assert.ok(JSON.parse(await readFile(path.join(f.root, 'chats.json'), 'utf8')).length);
});

test('guest login rate limit and exact OpenAI egress allowlist fail closed', async t => {
  const f = await setup(t);
  for (let i = 0; i < 10; i++) assert.equal((await f.request('/api/login', { username: 'family', password: 'wrong' })).status, 401);
  assert.equal((await f.request('/api/login', { username: 'family', password: 'wrong' })).status, 429);
  assert.equal(allowedGuestDestination('chatgpt.com:443', '104.18.1.1'), true);
  for (const host of ['chatgpt.com.evil.test:443', '100.64.0.46:443', 'localhost:443', 'api.openai.com:80', 'evil.test:443']) assert.equal(allowedGuestDestination(host, '104.18.1.1'), false);
  for (const ip of ['127.0.0.1', '10.0.0.1', '100.64.0.46', '172.31.251.1', '192.168.1.1', '169.254.169.254', '::1']) assert.equal(allowedGuestDestination('chatgpt.com:443', ip), false);
  const pinned = { 'chatgpt.com': ['100.127.148.236'] };
  assert.equal(allowedGuestDestination('chatgpt.com:443', '100.127.148.236', pinned), true);
  assert.equal(allowedGuestDestination('chatgpt.com:443', '100.64.0.46', pinned), false);
  assert.equal(allowedGuestDestination('auth.openai.com:443', '100.127.148.236', pinned), false);
});

test('bootstrap combines authenticated history and selected transcript, with compressed JSON', async t => {
  const f = await setup(t);const first = await f.service.create();const second = await f.service.create();const cookie = await f.login();
  await f.service.send(first.id, '长题目'.repeat(1000), [], randomUUID());
  const response = await f.request(`/api/auth?chat=${first.id}`, undefined, cookie);
  assert.equal(response.headers.get('content-encoding'), 'gzip');
  const data: any = await response.json();assert.equal(data.chat.id, first.id);assert.equal(data.chats.length, 2);
  const publicData: any = await (await f.request(`/api/auth?chat=${second.id}`)).json();
  assert.equal(publicData.authenticated, false);assert.equal('chat' in publicData, false);
});

test('binary preuploads survive restart, enforce ownership and make lost-ack retries idempotent', async t => {
  const f = await setup(t);const cookie = await f.login();const chat = await f.service.create();
  const base = `http://127.0.0.1:${(f.server.address() as { port: number }).port}`;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6WlIAAAAASUVORK5CYII=', 'base64');
  const id = randomUUID();
  const upload = (data: Buffer, auth = cookie) => fetch(`${base}/api/uploads/${id}`, { method: 'POST', headers: { Origin: base, Cookie: auth, 'Content-Type': 'image/png' }, body: data });
  assert.equal((await upload(png, '')).status, 401);assert.equal((await upload(Buffer.from('invalid'))).status, 400);
  const response = await upload(png);assert.equal(response.status, 201);const image: any = await response.json();
  assert.deepEqual(await (await upload(png)).json(), image);
  assert.equal((await upload(Buffer.concat([png, Buffer.from('different')]))).status, 409);
  const imageResponse = await f.request(`/api/images/${image.id}`, undefined, cookie);assert.match(imageResponse.headers.get('cache-control')!, /private/);
  const request = { text: '', images: [], imageIds: [image.id], requestId: randomUUID() };
  assert.equal((await f.request(`/api/chats/${chat.id}/messages`, { ...request, imageIds: [randomUUID() + '.png'] }, cookie)).status, 400);
  assert.equal((await f.request(`/api/chats/${chat.id}/messages`, request, cookie)).status, 202);
  assert.equal((await f.request(`/api/chats/${chat.id}/messages`, request, cookie)).status, 202);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.service.read(chat.id).messages[0].id, request.requestId);
  assert.equal(f.client.calls.filter(call => call.method === 'turn/start').length, 1);
  assert.match(f.client.calls.find(call => call.method === 'turn/start')!.params.input[1].url, /^data:image\/png;base64,/);
  const pending = await f.service.upload(randomUUID(), 'image/png', png);
  await f.service.close();const restored = await createGuestChatService(f.root, new FakeCodex());
  assert.equal((await restored.image(pending.id)).bytes.length, png.length);await restored.close();
});

test('incremental streaming sends appended text instead of repeatedly retransmitting the entire answer', async t => {
  const f = await setup(t);const cookie = await f.login();const chat = await f.service.create();
  await f.service.send(chat.id, 'question', [], randomUUID());await new Promise(resolve => setTimeout(resolve, 20));
  const threadId = f.client.calls.find(call => call.method === 'turn/start')!.params.threadId;
  const emit = (delta: string) => f.client.emit('notification', { method: 'item/agentMessage/delta', params: { threadId, itemId: 'answer', delta } });
  emit('一段较长的内容'.repeat(1000));
  const base = `127.0.0.1:${(f.server.address() as { port: number }).port}`;
  const ws = new WebSocket(`ws://${base}/api/live/${chat.id}?delta=1`, { headers: { Cookie: cookie, Origin: `http://${base}` } });t.after(() => ws.terminate());
  const initial: any = await new Promise(resolve => ws.once('message', bytes => resolve(JSON.parse(String(bytes)))));
  const update = new Promise<string>(resolve => ws.once('message', bytes => resolve(String(bytes))));emit('新增文字');
  const wire = await update;const patch = JSON.parse(wire);
  assert.equal(patch.baseRevision, initial.revision);assert.equal(patch.type, 'patch');assert.equal(patch.messages[0].textAppend, '新增文字');assert.ok(Buffer.byteLength(wire) < 1000);
  ws.close();
});

test('simultaneous retries acknowledge the persisted question and start one model turn', async t => {
  const f = await setup(t);const chat = await f.service.create();const requestId = randomUUID();
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6WlIAAAAASUVORK5CYII=';
  const results = await Promise.all([f.service.send(chat.id, 'same question', [image], requestId), f.service.send(chat.id, 'same question', [image], requestId)]);
  for (const result of results) assert.equal(result.messages[0]?.id, requestId);
  await new Promise(resolve => setTimeout(resolve, 20));assert.equal(f.client.calls.filter(call => call.method === 'turn/start').length, 1);
});
