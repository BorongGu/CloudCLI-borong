import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { GuestCodexClient } from '@/modules/guest-chat/guest-codex.client.js';

type Message = { id: string; role: 'user' | 'assistant'; text: string; reasoning?: string; images: string[]; createdAt: number };
type Session = { id: string; title: string; nativeId?: string; turnId?: string; busy: boolean; status: string;
  error: string | null; messages: Message[]; updatedAt: number; revision: number; requests: string[] };
type Client = Pick<GuestCodexClient, 'initialize' | 'call' | 'close'> & { on: (event: string, listener: (...args: any[]) => void) => unknown };
const MODEL = 'gpt-6-astra';
const EFFORT = 'high';
const INSTRUCTIONS = '你是中文答疑助手。帮助用户理解题目、分析图片并作答。先给清楚的答案，再给必要的推导；信息不足时在正文中追问。数学公式使用 $...$ 和 $$...$$。你可以使用内置网页搜索获取公开资料；涉及最新信息或用户要求查证时，主动搜索，并在回答中用 Markdown 链接标注来源。结合本对话中的文字、图片和检索结果回答。';

/** Guest HTTP routes use this store, which accepts only locally allocated conversation IDs. */
export async function createGuestChatService(directory: string, client: Client = new GuestCodexClient()) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(path.join(directory, 'images'), { recursive: true, mode: 0o700 });
  const filename = path.join(directory, 'chats.json');
  const sessions = new Map<string, Session>();
  const loaded = new Set<string>();
  const nativeSessions = new Map<string, Session>();
  const ownedImages = new Set<string>();
  const uploads = new Map<string, { createdAt: number; hash: string }>();
  const uploading = new Map<string, Promise<{ id: string }>>();
  const textParts = new Map<string, Map<string, string>>();
  const replies = new Map<string, Message>();
  const summaries = new Map<string, Map<string, string>>();
  const listeners = new Set<(id: string) => void>();
  const preparing = new Map<string, Promise<boolean>>();
  const starts = new Map<string, Promise<void>>();
  const accepting = new Map<string, Promise<void>>();
  let persistence = Promise.resolve();
  let saveTimer: NodeJS.Timeout | undefined;
  try {
    for (const session of JSON.parse(await readFile(filename, 'utf8')) as Session[]) {
      if (session.busy) { session.error = '连接已恢复，可以继续提问。';session.revision++; }
      session.busy = false;session.turnId = undefined;session.status = '';sessions.set(session.id, session);
      if (session.nativeId) nativeSessions.set(session.nativeId, session);
      for (const message of session.messages) for (const image of message.images) ownedImages.add(image);
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try {
    for (const [id, metadata] of JSON.parse(await readFile(path.join(directory, 'uploads.json'), 'utf8'))) {
      if (/^[a-f0-9-]{36}\.(png|jpeg|webp)$/.test(id)) uploads.set(id, metadata);
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

  async function pruneUploads() {
    for (const [id, metadata] of uploads) {
      if (ownedImages.has(id)) uploads.delete(id);
      else if (metadata.createdAt < Date.now() - 86400_000) {
        uploads.delete(id);await rm(path.join(directory, 'images', id), { force: true });
      }
    }
  }
  await pruneUploads();

  function persist(): Promise<void> {
    clearTimeout(saveTimer);saveTimer = undefined;
    const snapshot = JSON.stringify([...sessions.values()]);
    const uploadSnapshot = JSON.stringify([...uploads]);
    persistence = persistence.catch(() => {}).then(async () => {
      await writeFile(filename + '.next', snapshot, { mode: 0o600 });await rename(filename + '.next', filename);
      const uploadFile = path.join(directory, 'uploads.json');
      await writeFile(uploadFile + '.next', uploadSnapshot, { mode: 0o600 });await rename(uploadFile + '.next', uploadFile);
    });
    return persistence;
  }
  function changed(session: Session, immediate = false): void {
    session.revision++;session.updatedAt = Date.now();
    for (const listener of listeners) listener(session.id);
    if (immediate) void persist().catch(() => {});
    else if (!saveTimer) saveTimer = setTimeout(() => { void persist().catch(() => {}); }, 500);
  }
  function get(id: string): Session {
    const session = sessions.get(id);
    if (!session) throw Object.assign(new Error('对话不存在。'), { status: 404 });
    return session;
  }
  function view(session: Session) {
    return { id: session.id, title: session.title, busy: session.busy, status: session.status, error: session.error,
      messages: session.messages, updatedAt: session.updatedAt, revision: session.revision, model: MODEL, effort: EFFORT };
  }
  function fail(session: Session, error: unknown): void {
    session.busy = false;session.turnId = undefined;session.status = '';
    session.error = (error instanceof Error ? error.message : '回答中断，请重试。').slice(0, 600)
      .replace(/(?:Bearer\s+|(?:sk-|eyJ))[A-Za-z0-9_.-]+/g, '[credential]');
    changed(session, true);
  }
  function replyFor(session: Session): Message {
    let reply = replies.get(session.id);
    if (!reply) { reply = { id: randomUUID(), role: 'assistant', text: '', images: [], createdAt: Date.now() };replies.set(session.id, reply);session.messages.push(reply); }
    return reply;
  }
  function prepare(session: Session): Promise<boolean> {
    if (loaded.has(session.id)) return Promise.resolve(false);
    const existing = preparing.get(session.id);if (existing) return existing;
    const pending = (async () => {
      await client.initialize();
      const parameters = {
        model: MODEL, cwd: '/workspace', approvalPolicy: 'never', sandbox: 'read-only', developerInstructions: INSTRUCTIONS,
        config: { model_reasoning_effort: EFFORT, web_search: 'live' },
      };
      let recreated = false;let result;
      try {
        result = await client.call(session.nativeId ? 'thread/resume' : 'thread/start', {
          ...parameters, ...(session.nativeId ? { threadId: session.nativeId } : { allowProviderModelFallback: false }),
        });
      } catch (error) {
        // Codex only writes a rollout once a turn starts; old prewarmed empty threads vanish on restart.
        const emptyNativeHistory = !session.messages.some(message => message.role === 'assistant' && (message.text || message.reasoning));
        if (!session.nativeId || !emptyNativeHistory || !/no rollout found for thread id/i.test(error instanceof Error ? error.message : '')) throw error;
        session.status = '正在恢复会话';changed(session);
        result = await client.call('thread/start', { ...parameters, allowProviderModelFallback: false });recreated = true;
        nativeSessions.delete(session.nativeId);
      }
      session.nativeId = result.thread.id;nativeSessions.set(result.thread.id, session);loaded.add(session.id);await persist();
      return recreated;
    })().finally(() => preparing.delete(session.id));
    preparing.set(session.id, pending);return pending;
  }

  client.on('disconnect', () => {
    loaded.clear();
    for (const session of sessions.values()) if (session.busy) fail(session, new Error('模型连接已断开，已保留对话。请继续提问。'));
  });
  client.on('notification', (event: any) => {
    const p = event.params || {};
    const session = nativeSessions.get(p.threadId);
    if (!session?.busy) return;
    if (event.method === 'turn/started') { session.turnId = p.turn.id;session.status = '思考中';changed(session); }
    if ((event.method === 'item/started' || event.method === 'item/completed') && p.item?.type === 'webSearch') {
      session.status = event.method === 'item/started' ? '正在搜索网页' : '正在整理搜索结果';changed(session);
    }
    if (event.method === 'item/agentMessage/delta' || (event.method === 'item/completed' && p.item?.type === 'agentMessage')) {
      const parts = textParts.get(session.id) || new Map<string, string>();textParts.set(session.id, parts);
      const id = p.itemId || p.item?.id;
      if (!id) return;
      parts.set(id, p.item ? p.item.text || '' : (parts.get(id) || '') + (p.delta || ''));
      const reply = replyFor(session);
      reply.text = [...parts.values()].filter(Boolean).join('\n\n');session.status = '正在回答';changed(session);
    }
    // Display the provider's user-facing summary, separate from the final answer.
    if (event.method === 'item/reasoning/summaryTextDelta' || (event.method === 'item/completed' && p.item?.type === 'reasoning')) {
      const parts = summaries.get(session.id) || new Map<string, string>();summaries.set(session.id, parts);
      if (p.item) {
        if (Array.isArray(p.item.summary)) p.item.summary.forEach((text: string, index: number) => parts.set(`${p.item.id}:${index}`, text));
      } else { const key = `${p.itemId}:${p.summaryIndex || 0}`;parts.set(key, (parts.get(key) || '') + (p.delta || '')); }
      const text = [...parts.values()].filter(Boolean).join('\n\n');
      if (text) { replyFor(session).reasoning = text;session.status = '思考中';changed(session); }
    }
    if (event.method === 'turn/completed') {
      if (p.turn.status === 'failed') fail(session, new Error(p.turn.error?.message || '模型暂时繁忙，请重试。'));
      else { session.busy = false;session.turnId = undefined;session.status = '';changed(session, true); }
    }
    if (event.method === 'error') {
      if (!p.willRetry) fail(session, new Error(p.error?.message || '模型暂时繁忙，请重试。'));
      else { session.status = '正在重新连接';changed(session); }
    }
  });

  return {
    warm: async () => { await client.initialize();await client.call('account/read', { refreshToken: false }); },
    subscribe: (listener: (id: string) => void) => { listeners.add(listener);return () => { listeners.delete(listener); }; },
    list: () => [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(({ id, title, updatedAt, busy }) => ({ id, title, updatedAt, busy })),
    read: (id: string) => view(get(id)),
    async upload(requestId: string, mime: string, bytes: Buffer): Promise<{ id: string }> {
      const id = requestId + '.' + mime.slice('image/'.length);
      const previous = uploading.get(id);if (previous) { await previous; }
      const pending = (async () => {
        const hash = createHash('sha256').update(bytes).digest('hex');
        if (uploads.has(id) || ownedImages.has(id)) {
          const saved = uploads.get(id)?.hash || createHash('sha256').update(await readFile(path.join(directory, 'images', id))).digest('hex');
          if (saved !== hash) throw Object.assign(new Error('图片内容已变化，请重新选择图片。'), { status: 409 });
          return { id };
        }
        await pruneUploads();
        if (uploads.size + uploading.size >= 100) throw Object.assign(new Error('待发送图片较多，请稍后再试。'), { status: 429 });
        await writeFile(path.join(directory, 'images', id), bytes, { mode: 0o600 });
        uploads.set(id, { createdAt: Date.now(), hash });await persist();return { id };
      })();
      uploading.set(id, pending);
      try { return await pending; } finally { if (uploading.get(id) === pending) uploading.delete(id); }
    },
    async create() {
      if (sessions.size >= 100) throw Object.assign(new Error('对话数量已达上限，请继续使用已有对话。'), { status: 409 });
      const session: Session = { id: randomUUID(), title: '新对话', busy: false, status: '', error: null, messages: [], updatedAt: Date.now(), revision: 1, requests: [] };
      // Allocate the native thread on the first message so empty UI sessions survive every service restart.
      sessions.set(session.id, session);await persist();return view(session);
    },
    async send(id: string, text: string, images: string[], requestId: string, imageIds: string[] = []) {
      const session = get(id);
      const acceptanceKey = `${id}/${requestId}`;
      const inFlight = accepting.get(acceptanceKey);if (inFlight) await inFlight;
      if (session.requests.includes(requestId)) return view(session);
      if (session.busy) throw Object.assign(new Error('请等待当前回答完成，或点击停止。'), { status: 409 });
      if (session.messages.length >= 500) throw Object.assign(new Error('这段对话已很长，请新建对话继续。'), { status: 409 });
      if (imageIds.some(image => !ownedImages.has(image) && !uploads.has(image))) throw Object.assign(new Error('图片已过期，请重新上传。'), { status: 400 });
      let release!: () => void;
      accepting.set(acceptanceKey, new Promise<void>(resolve => { release = resolve; }));
      // Reserve the turn before awaiting disk or model work, so concurrent sends stay serialized.
      session.busy = true;session.status = '正在连接模型';session.error = null;session.requests.push(requestId);
      textParts.delete(id);replies.delete(id);summaries.delete(id);
      let accepted = false;
      try {
        const attachments: string[] = [...imageIds];
        const modelImages = [...images];
        for (const imageId of imageIds) {
          const bytes = await readFile(path.join(directory, 'images', imageId));
          modelImages.push(`data:image/${imageId.split('.').at(-1)};base64,${bytes.toString('base64')}`);
          ownedImages.add(imageId);uploads.delete(imageId);
        }
        for (const image of images) {
          const match = image.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/)!;
          const imageId = randomUUID() + '.' + match[1];
          await writeFile(path.join(directory, 'images', imageId), Buffer.from(match[2], 'base64'), { mode: 0o600 });attachments.push(imageId);ownedImages.add(imageId);
        }
        session.messages.push({ id: requestId, role: 'user', text, images: attachments, createdAt: Date.now() });
        if (session.messages.length === 1) session.title = (text || '图片提问').slice(0, 40);
        changed(session);await persist();accepted = true;
        const start = (async () => {
          const recreated = await prepare(session);
          const input: Array<{ type: 'text'; text: string } | { type: 'image'; url: string }> = [
            { type: 'text', text: text || '请分析这张图片中的题目并作答。' }, ...modelImages.map(url => ({ type: 'image' as const, url })),
          ];
          if (recreated) {
            const previousQuestions: typeof input = [];
            for (const message of session.messages.slice(0, -1)) if (message.role === 'user') {
              previousQuestions.push({ type: 'text', text: `此前尚未回答的问题：${message.text || '请分析所附图片。'}` });
              for (const imageId of message.images) {
                const bytes = await readFile(path.join(directory, 'images', imageId));
                previousQuestions.push({ type: 'image', url: `data:image/${imageId.split('.').at(-1)};base64,${bytes.toString('base64')}` });
              }
            }
            input.unshift(...previousQuestions);
          }
          const turn = await client.call('turn/start', { threadId: session.nativeId, model: MODEL, effort: EFFORT,
            summary: 'auto',
            input,
          });
          if (session.busy) session.turnId = turn.turn.id;
        })().catch(error => fail(session, error)).finally(() => starts.delete(id));
        starts.set(id, start);
      } catch (error) {
        if (!accepted) { session.requests = session.requests.filter(value => value !== requestId);session.messages = session.messages.filter(message => message.id !== requestId); }
        fail(session, error);throw error;
      } finally { accepting.delete(acceptanceKey);release(); }
      return view(session);
    },
    async stop(id: string) {
      const session = get(id);await starts.get(id);
      if (session.busy && session.nativeId && session.turnId) await client.call('turn/interrupt', { threadId: session.nativeId, turnId: session.turnId });
      return view(session);
    },
    async image(id: string) {
      if (!/^[a-f0-9-]{36}\.(png|jpeg|webp)$/.test(id) || (!ownedImages.has(id) && !uploads.has(id))) {
        throw Object.assign(new Error('图片不存在。'), { status: 404 });
      }
      return { bytes: await readFile(path.join(directory, 'images', id)), mime: 'image/' + id.split('.').at(-1) };
    },
    async close() { client.close();await Promise.allSettled([...starts.values(), ...preparing.values(), ...uploading.values(), ...accepting.values()]);await persist();listeners.clear(); },
  };
}
