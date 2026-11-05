import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

import { WebSocketServer } from 'ws';

import { createGuestChatService } from '@/modules/guest-chat/guest-chat.service.js';

type Credentials = { username: string; passwordSalt: string; passwordHash: string; sessionSecret: string };
const COOKIE = '__Host-cloudcli-guest';
const compress = promisify(gzip);
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png' };
const invalid = (message = '请求格式有误。', status = 400) => Object.assign(new Error(message), { status });

function exactObject(value: unknown, keys: string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw invalid();
  return value as Record<string, any>;
}

async function bytes(req: IncomingMessage, limit: number): Promise<Buffer> {
  if (Number(req.headers['content-length']) > limit) throw invalid('图片或文字过大。', 413);
  const chunks: Buffer[] = [];let size = 0;
  for await (const chunk of req) {
    size += chunk.length;if (size > limit) throw invalid('图片或文字过大。', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function body(req: IncomingMessage, limit: number): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw invalid();
  const data = await bytes(req, limit);
  try { return JSON.parse(data.toString('utf8')); } catch { throw invalid(); }
}

function validImageBytes(mime: string, data: Buffer): boolean {
  return data.length > 0 && data.length <= 5_000_000 && (mime === 'image/png' ? data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    : mime === 'image/jpeg' ? data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
      : mime === 'image/webp' && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP');
}

function validImage(image: unknown): image is string {
  if (typeof image !== 'string' || image.length > 7_000_000) return false;
  const match = image.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return false;
  return validImageBytes('image/' + match[1], Buffer.from(match[2], 'base64'));
}

/** The separate guest entrypoint and isolation tests use this allowlisted HTTP application. */
export function createGuestServer(service: Awaited<ReturnType<typeof createGuestChatService>>, credentials: Credentials, staticRoot: string) {
  const tickets = new Map<string, number>();
  const attempts = new Map<string, { count: number; until: number }>();
  const sign = (value: string) => createHmac('sha256', credentials.sessionSecret).update(value).digest('base64url');
  const authenticated = (req: IncomingMessage): boolean => {
    const value = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
    if (!value || value.length > 300) return false;
    const [expires, nonce, signature, extra] = value.split('.');
    if (extra || !signature || !nonce || Number(expires) <= Date.now() || tickets.get(nonce) !== Number(expires)) return false;
    const expected = Buffer.from(sign(`${expires}.${nonce}`));const supplied = Buffer.from(signature);
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  };
  function limited(key: string, maximum: number, duration: number): boolean {
    const now = Date.now();
    for (const [id, entry] of attempts) if (entry.until <= now) attempts.delete(id);
    const entry = attempts.get(key) || { count: 0, until: now + duration };
    entry.count++;attempts.set(key, entry);return entry.count > maximum;
  }
  const json = async (res: ServerResponse, status: number, value: unknown) => {
    let payload = Buffer.from(JSON.stringify(value));
    if (payload.length > 1024 && res.req.headers['accept-encoding']?.includes('gzip')) {
      payload = await compress(payload, { level: 3 });res.setHeader('Content-Encoding', 'gzip');
    }
    res.setHeader('Vary', 'Accept-Encoding');
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length });res.end(payload);
  };
  const bootstrap = (selected?: string | null) => {
    const chats = service.list();const chosen = chats.find(chat => chat.id === selected) || chats[0];
    return { authenticated: true, username: credentials.username, chats, chat: chosen ? service.read(chosen.id) : null };
  };
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');res.setHeader('X-Frame-Options', 'DENY');
    const host = /^[A-Za-z0-9.-]+(?::\d+)?$/.test(req.headers.host || '') ? req.headers.host : '';
    const liveOrigin = host ? ` wss://${host}` : '';
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'${liveOrigin}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`);
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    try {
      const url = new URL(req.url || '/', 'http://guest');
      const pathname = url.pathname;
      if (!['GET', 'POST'].includes(req.method || '')) return json(res, 405, { error: '请求方法有误。' });
      if (req.method === 'POST') {
        let origin: URL;
        try { origin = new URL(req.headers.origin || ''); } catch { throw invalid('请从登录页面提交。', 403); }
        const local = ['localhost', '127.0.0.1'].includes(origin.hostname);
        if (origin.host !== req.headers.host || (origin.protocol !== 'https:' && !local)) throw invalid('请求来源有误。', 403);
      }
      if (pathname === '/api/auth' && req.method === 'GET') return json(res, 200, authenticated(req) ? bootstrap(url.searchParams.get('chat')) : { authenticated: false, username: credentials.username });
      if (pathname === '/api/login' && req.method === 'POST') {
        const key = String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown');
        if (limited('global-login', 100, 600_000) || limited('login:' + key, 10, 600_000)) throw invalid('尝试次数较多，请稍后再登录。', 429);
        const data = exactObject(await body(req, 4096), ['username', 'password']);
        if (typeof data.password !== 'string' || data.password.length > 200) throw invalid('账号或密码有误。', 401);
        const hash = scryptSync(data.password, credentials.passwordSalt, 32);
        const expected = Buffer.from(credentials.passwordHash, 'hex');
        if (data.username !== credentials.username || expected.length !== hash.length || !timingSafeEqual(hash, expected)) throw invalid('账号或密码有误。', 401);
        const expires = Date.now() + 7 * 86400_000;const nonce = randomBytes(24).toString('base64url');
        for (const [key, expiry] of tickets) if (expiry <= Date.now()) tickets.delete(key);
        tickets.set(nonce, expires);
        const value = `${expires}.${nonce}`;
        res.setHeader('Set-Cookie', `${COOKIE}=${value}.${sign(value)}; Path=/; Max-Age=604800; Secure; HttpOnly; SameSite=Strict`);
        return json(res, 200, { ok: true, ...bootstrap() });
      }
      if (pathname.startsWith('/api/')) {
        if (!authenticated(req)) return json(res, 401, { error: '请先登录。' });
        if (pathname === '/api/logout' && req.method === 'POST') {
          const value = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
          if (value) tickets.delete(value.split('.')[1]);
          res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`);return json(res, 200, { ok: true });
        }
        if (pathname === '/api/chats') {
          if (req.method === 'GET') return json(res, 200, { chats: service.list() });
          exactObject(await body(req, 128), []);return json(res, 201, await service.create());
        }
        const upload = pathname.match(/^\/api\/uploads\/([a-f0-9-]{36})$/);
        if (upload && req.method === 'POST') {
          if (limited('uploads', 60, 60_000)) throw invalid('上传较频繁，请稍后再试。', 429);
          const mime = req.headers['content-type'] || '';
          const data = await bytes(req, 5_000_000);
          if (!validImageBytes(mime, data)) throw invalid('请选择小于 5 MB 的 PNG、JPG 或 WebP 图片。');
          return json(res, 201, await service.upload(upload[1], mime, data));
        }
        const match = pathname.match(/^\/api\/chats\/([a-f0-9-]{36})(?:\/(messages|stop))?$/);
        if (match) {
          if (!match[2] && req.method === 'GET') return json(res, 200, service.read(match[1]));
          if (match[2] === 'stop' && req.method === 'POST') { exactObject(await body(req, 128), []);return json(res, 200, await service.stop(match[1])); }
          if (match[2] === 'messages' && req.method === 'POST') {
            if (limited('messages', 30, 60_000)) throw invalid('发送较频繁，请稍等片刻。', 429);
            const data = exactObject(await body(req, 21_100_000), ['text', 'images', 'requestId', 'imageIds']);
            data.imageIds ??= [];
            if (typeof data.text !== 'string' || data.text.length > 32000 || !Array.isArray(data.images) || !Array.isArray(data.imageIds)
              || data.images.length + data.imageIds.length > 3 || !data.images.every(validImage)
              || (!data.text.trim() && !data.images.length && !data.imageIds.length)
              || !data.imageIds.every((id: unknown) => typeof id === 'string' && /^[a-f0-9-]{36}\.(png|jpeg|webp)$/.test(id))
              || typeof data.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(data.requestId)) throw invalid('请输入问题，或选择最多 3 张图片（每张小于 5 MB）。');
            return json(res, 202, await service.send(match[1], data.text.trim(), data.images, data.requestId, data.imageIds));
          }
        }
        const image = pathname.match(/^\/api\/images\/([a-f0-9-]{36}\.(?:png|jpeg|webp))$/);
        if (image && req.method === 'GET') { const result = await service.image(image[1]);res.setHeader('Cache-Control', 'private, max-age=86400, immutable');res.writeHead(200, { 'Content-Type': result.mime, 'Content-Length': result.bytes.length });return res.end(result.bytes); }
        return json(res, 404, { error: '页面不存在。' });
      }
      if (req.method === 'GET' && (pathname === '/' || /^\/assets\/[A-Za-z0-9_.-]+$/.test(pathname))) {
        const name = pathname === '/' ? 'index.html' : pathname.slice(1);
        let file: Buffer | undefined;
        for (const encoding of ['br', 'gzip']) {
          if (!req.headers['accept-encoding']?.includes(encoding)) continue;
          try { file = await readFile(path.join(staticRoot, name) + (encoding === 'br' ? '.br' : '.gz'));res.setHeader('Content-Encoding', encoding);break; }
          catch { /* Serve the original asset when no precompressed copy is present. */ }
        }
        file ??= await readFile(path.join(staticRoot, name));
        res.setHeader('Vary', 'Accept-Encoding');
        if (pathname.startsWith('/assets/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.writeHead(200, { 'Content-Type': MIME[path.extname(name)] || 'application/octet-stream' });return res.end(file);
      }
      return json(res, 404, { error: '页面不存在。' });
    } catch (error) {
      const status = (error as { status?: number }).status || ((error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500);
      if (!res.headersSent) json(res, status, { error: status === 500 ? '服务暂时繁忙，请重试。' : (error as Error).message });
      else res.end();
    }
  });
  server.requestTimeout = 180_000;server.headersTimeout = 15_000;
  server.keepAliveTimeout = 65_000;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: {
    threshold: 1024, serverNoContextTakeover: true, clientNoContextTakeover: true, concurrencyLimit: 2, zlibDeflateOptions: { level: 3 },
  } });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://guest');
    const match = url.pathname.match(/^\/api\/live\/([a-f0-9-]{36})$/);
    if (!match || !authenticated(req)) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');return; }
    try {
      const origin = new URL(req.headers.origin || '');
      if (origin.host !== req.headers.host || (origin.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(origin.hostname))) throw invalid();
      service.read(match[1]);
    } catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return; }
    sockets.handleUpgrade(req, socket, head, ws => {
      let timer: NodeJS.Timeout | undefined;
      let needsFullSnapshot = false;
      let previous: { revision: number; messages: ReturnType<typeof service.read>['messages'] } | undefined;
      const remember = (chat: ReturnType<typeof service.read>) => { previous = { revision: chat.revision, messages: chat.messages.slice(-2).map(message => ({ ...message })) }; };
      const send = (partial = false) => {
        if (ws.readyState !== 1) return;
        if (!authenticated(req)) { ws.close(1008);return; }
        // Slow connections retain a single latest snapshot instead of queuing every token.
        if (ws.bufferedAmount > 256 * 1024) {
          needsFullSnapshot = true;
          if (!timer) timer = setTimeout(() => { timer = undefined;send(); }, 100);
          return;
        }
        if (needsFullSnapshot) { partial = false;needsFullSnapshot = false; }
        const chat = service.read(match[1]);
        if (partial && previous && url.searchParams.get('delta') === '1') {
          const messages = chat.messages.slice(-2).flatMap(message => {
            const old = previous!.messages.find(item => item.id === message.id);
            if (!old) return [message];
            const patch: Record<string, string> = { id: message.id };
            for (const field of ['text', 'reasoning'] as const) {
              const value = message[field] || '';const before = old[field] || '';
              if (value !== before) patch[value.startsWith(before) ? `${field}Append` : field] = value.startsWith(before) ? value.slice(before.length) : value;
            }
            return Object.keys(patch).length > 1 ? [patch as unknown as typeof message] : [];
          });
          ws.send(JSON.stringify({ ...chat, partial: true, type: 'patch', baseRevision: previous.revision, messages }));
        } else ws.send(JSON.stringify(partial ? { ...chat, partial: true, messages: chat.messages.slice(-2) } : chat));
        remember(chat);
      };
      const initial = service.read(match[1]);
      if (url.searchParams.get('delta') === '1' && Number(url.searchParams.get('revision')) === initial.revision) remember(initial);
      else send();
      const unsubscribe = service.subscribe(id => {
        if (id === match[1] && !timer) timer = setTimeout(() => { timer = undefined;send(true); }, 40);
      });
      let alive = true;ws.on('pong', () => { alive = true; });
      const heartbeat = setInterval(() => {
        if (!alive) { ws.terminate();return; }
        if (!authenticated(req)) ws.close(1008);
        else { alive = false;ws.ping();ws.send(JSON.stringify({ type: 'heartbeat' })); }
      }, 20_000);
      ws.once('close', () => { clearTimeout(timer);clearInterval(heartbeat);unsubscribe(); });
      ws.on('error', () => {});
    });
  });
  server.once('close', () => { for (const ws of sockets.clients) ws.terminate();sockets.close(); });
  return server;
}
