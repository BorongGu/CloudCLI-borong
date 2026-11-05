import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ArrowUp, Check, ImagePlus, Loader2, LogOut, MessageSquare, Plus, RotateCw, Square, X } from 'lucide-react';

import { guestChatApi } from '@/shared/api';
import type { GuestChatBootstrap, GuestChatSnapshot, GuestChatSummary } from '@/shared/types';
import { Button, Input } from '@/shared/ui';
import { copyTextToClipboard } from '@/shared/utils';
import companions from '@/modules/guest-chat/assets/companions.webp';
import { useGuestAttachments } from '@/modules/guest-chat/hooks/useGuestAttachments';
import { GuestThemePicker } from '@/modules/guest-chat/GuestThemePicker';
import '@/modules/guest-chat/guest-chat.css';

const GuestAnswer = lazy(() => import('@/modules/guest-chat/GuestAnswer'));
type Outgoing = { id: string; text: string; imageIds: string[]; attachmentIds: string[]; previews: string[]; startedAt: number; error?: string };

/** The standalone guest entrypoint reuses CloudCLI controls and its tested streaming Markdown renderer. */
export function GuestChat() {
  // Gate all history and model calls on the dedicated guest login.
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  // Preserve the login form until the dedicated account authenticates.
  const [username, setUsername] = useState('');
  // Clear the password immediately after successful login.
  const [password, setPassword] = useState('');
  // The history picker lists only this isolated service's conversations.
  const [chats, setChats] = useState<GuestChatSummary[]>([]);
  // A snapshot survives brief network interruptions while polling reconnects.
  const [chat, setChat] = useState<GuestChatSnapshot | null>(null);
  // Preserve an unsent question and image previews through status updates.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // Optimistic questions remain visible through slow acknowledgements and safe retries.
  const [outgoing, setOutgoing] = useState<Record<string, Outgoing | undefined>>({});
  // A switching indicator distinguishes cached history from a fresh server snapshot.
  const [loadingId, setLoadingId] = useState<string | null>(null);
  // Selection stays stable while an uncached transcript loads or a request is retried.
  const [selectedId, setSelectedId] = useState('');
  // Connection feedback explains reconnects and the polling fallback.
  const [connection, setConnection] = useState('正在连接');
  // Elapsed time gives useful feedback during upload acknowledgement and model waits.
  const [now, setNow] = useState(() => Date.now());
  // An HTTP mutation has a separate pending state from the model's busy state.
  const [pending, setPending] = useState(false);
  // Inline feedback covers request failures, connection loss and successful copy.
  const [notice, setNotice] = useState('');
  const activeId = useRef<string | null>(null);
  const cache = useRef(new Map<string, GuestChatSnapshot>());
  const positions = useRef(new Map<string, number>());
  const readRequest = useRef<AbortController | null>(null);
  const sending = useRef(new Set<string>());
  const scroller = useRef<HTMLElement>(null);
  const stick = useRef(true);
  const upload = useRef<HTMLInputElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);

  function report(error: unknown) {
    if ((error as { status?: number }).status === 401) setAuthenticated(false);
    setNotice(error instanceof Error ? error.message : '连接暂时中断，请重试。');
  }
  const attachments = useGuestAttachments(report);
  const draft = drafts[selectedId] || '';
  const images = attachments.byChat[selectedId] || [];
  const queued = outgoing[selectedId];
  const posting = Boolean(queued && !queued.error);
  const ready = images.every(image => image.status === 'ready');
  const waiting = Boolean(queued || chat?.busy || loadingId);
  const startedAt = queued?.startedAt || chat?.messages.slice().reverse().find(message => message.role === 'user')?.createdAt || now;
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
  function setDraft(value: string) { setDrafts(previous => ({ ...previous, [selectedId]: value })); }
  function receive(next: GuestChatSnapshot) {
    const previous = cache.current.get(next.id);
    if (previous && previous.revision > next.revision) return;
    if (next.partial && previous) {
      const messages = [...previous.messages];
      for (const message of next.messages) { const index = messages.findIndex(item => item.id === message.id);if (index < 0) messages.push(message);else messages[index] = message; }
      next = { ...next, partial: undefined, messages };
    }
    cache.current.delete(next.id);cache.current.set(next.id, next);
    while (cache.current.size > 8) cache.current.delete(cache.current.keys().next().value!);
    setChats(list => [{ id: next.id, title: next.title, updatedAt: next.updatedAt, busy: next.busy }, ...list.filter(item => item.id !== next.id)].sort((a, b) => b.updatedAt - a.updatedAt));
    if (activeId.current === next.id) setChat(next);
  }
  function select(next: GuestChatSnapshot) {
    activeId.current = next.id;setSelectedId(next.id);stick.current = true;receive(next);setLoadingId(null);setNotice('');
    localStorage.setItem('guest-active-chat', next.id);
  }
  async function boot(result: GuestChatBootstrap) {
    if (result.username) setUsername(result.username);setAuthenticated(result.authenticated);
    if (!result.authenticated) return;
    void import('@/modules/guest-chat/GuestAnswer');
    setChats(result.chats || []);
    if (result.chat) select(result.chat);
    else { setPending(true);try { select(await guestChatApi.create()); } finally { setPending(false); } }
  }
  async function switchChat(id: string) {
    if (scroller.current && activeId.current) positions.current.set(activeId.current, scroller.current.scrollTop);
    readRequest.current?.abort();const controller = new AbortController();readRequest.current = controller;
    activeId.current = id;setSelectedId(id);setLoadingId(id);setNotice('');
    const saved = cache.current.get(id);setChat(saved || null);stick.current = !positions.current.has(id);
    localStorage.setItem('guest-active-chat', id);
    try { const next = await guestChatApi.read(id, controller.signal);if (!controller.signal.aborted) receive(next); }
    catch (error) { if (!controller.signal.aborted) report(error); }
    finally { if (activeId.current === id && !controller.signal.aborted) setLoadingId(null); }
  }
  useEffect(() => {
    const controller = new AbortController();
    void guestChatApi.auth(localStorage.getItem('guest-active-chat'), controller.signal).then(result => { if (!controller.signal.aborted) return boot(result); }).catch(error => { if (!controller.signal.aborted) { setAuthenticated(false);report(error); } });
    // Fetch the renderer alongside authentication instead of adding another network round trip afterwards.
    void import('@/modules/guest-chat/GuestAnswer');
    return () => { controller.abort();readRequest.current?.abort(); };
  }, []);
  useEffect(() => { if (!waiting) return;const timer = setInterval(() => setNow(Date.now()), 1000);return () => clearInterval(timer); }, [waiting]);

  useEffect(() => {
    if (!authenticated || !chat?.id) return;
    let disposed = false;let live = false;let polling = false;let timer: ReturnType<typeof setTimeout>;let reconnect: ReturnType<typeof setTimeout>;
    let stopSocket = () => {};
    const id = chat.id;
    const accept = (next: GuestChatSnapshot) => {
      if (disposed || activeId.current !== id) return;
      receive(next);
      setNotice(previous => previous === '连接中断，正在重新连接…' ? '' : previous);
    };
    const connect = () => {
      if (disposed) return;
      live = false;
      setConnection('正在连接');
      stopSocket = guestChatApi.subscribe(id, accept, connected => {
        live = connected;
        setConnection(connected ? '已连接' : '正在重连 · 自动同步中');
        if (!connected && !disposed) { reconnect = setTimeout(connect, 2000);clearTimeout(timer);void poll(); }
      }, cache.current.get(id));
    };
    connect();
    async function poll() {
      if (disposed || polling) return;
      if (live) { timer = setTimeout(() => { void poll(); }, 5000);return; }
      polling = true;
      let busy = false;
      try { const next = await guestChatApi.read(id);busy = next.busy;accept(next); }
      catch (error) {
        if (!disposed) { if ((error as { status?: number }).status === 401) setAuthenticated(false);else if (!live) setNotice('连接中断，正在重新连接…'); }
      }
      polling = false;
      if (!disposed) timer = setTimeout(() => { void poll(); }, live ? 5000 : document.hidden ? 5000 : busy ? 500 : 1800);
    }
    // The initial transcript comes from bootstrap/read; give the socket time to connect before fallback polling.
    timer = setTimeout(() => { void poll(); }, 4000);
    const wake = () => { if (!document.hidden) { stopSocket();clearTimeout(reconnect);clearTimeout(timer);connect();void poll(); } };
    window.addEventListener('online', wake);document.addEventListener('visibilitychange', wake);
    return () => { disposed = true;clearTimeout(timer);clearTimeout(reconnect);stopSocket();window.removeEventListener('online', wake);document.removeEventListener('visibilitychange', wake); };
  }, [authenticated, chat?.id]);

  useEffect(() => {
    const target = scroller.current;if (!target) return;
    const saved = positions.current.get(chat?.id || '');if (saved !== undefined) target.scrollTop = saved;else target.scrollTop = target.scrollHeight;
    const observer = new ResizeObserver(() => { if (stick.current) target.scrollTop = target.scrollHeight; });
    const content = target.firstElementChild;if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [authenticated, chat?.id]);

  async function login(event: React.FormEvent) {
    event.preventDefault();setPending(true);setNotice('');
    try { await boot(await guestChatApi.login(username, password));setPassword(''); }
    catch (error) { report(error); } finally { setPending(false); }
  }
  function addImages(files: File[]) { if (selectedId && !posting) attachments.add(selectedId, files); }
  async function send(retry?: Outgoing) {
    if (!chat || pending || sending.current.has(chat.id) || (!retry && (chat.busy || !ready || (!draft.trim() && !images.length)))) return;
    const id = chat.id;
    const previous = outgoing[id];
    const sameAttempt = previous?.error && previous.text === draft && JSON.stringify(previous.imageIds) === JSON.stringify(images.map(image => image.imageId));
    const message: Outgoing = retry || (sameAttempt ? previous : undefined) || { id: crypto.randomUUID(), text: draft, imageIds: images.map(image => image.imageId!), attachmentIds: images.map(image => image.id), previews: images.map(image => image.preview), startedAt: Date.now() };
    sending.current.add(id);setOutgoing(previous => ({ ...previous, [id]: { ...message, error: undefined } }));setNotice('');stick.current = true;
    try {
      const next = await guestChatApi.send(id, message.text, [], message.id, message.imageIds);receive(next);
      setDrafts(previous => previous[id] === message.text ? { ...previous, [id]: '' } : previous);
      attachments.commit(id, message.attachmentIds);setOutgoing(previous => ({ ...previous, [id]: undefined }));
    } catch (error) {
      // A streamed copy with the same ID proves acceptance even if its HTTP acknowledgement was lost.
      const accepted = cache.current.get(id)?.messages.some(item => item.id === message.id);
      if (accepted) {
        setDrafts(previous => previous[id] === message.text ? { ...previous, [id]: '' } : previous);attachments.commit(id, message.attachmentIds);setOutgoing(previous => ({ ...previous, [id]: undefined }));
      } else setOutgoing(previous => ({ ...previous, [id]: { ...message, error: error instanceof Error ? error.message : '发送失败，请重试。' } }));
      if ((error as { status?: number }).status === 401) report(error);
    } finally { sending.current.delete(id); }
  }

  if (authenticated !== true) return <main className="guest-login"><GuestThemePicker /><form onSubmit={login}>
    <div className="guest-brand"><MessageSquare size={23} /></div><h1>GPT-6 Astra</h1><p>文字、截图，随时提问。</p>
    <label htmlFor="guest-user">账号</label><Input id="guest-user" autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} required />
    <label htmlFor="guest-password">密码</label><Input id="guest-password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required />
    {notice && <p role="alert" className="guest-notice">{notice}</p>}
    <Button type="submit" className="guest-primary" disabled={pending || authenticated === null}>{authenticated === null ? '正在恢复连接…' : pending ? '正在登录…' : '进入对话'}</Button>
    <small>High · 深度思考</small>
  </form></main>;

  return <div className="guest-shell">
    <header className="guest-header"><div className="guest-heading"><div className="guest-brand"><MessageSquare size={20} /></div><div><h1>GPT-6 Astra</h1><p>High · 深度思考</p></div></div>
      <div className="guest-actions"><select aria-label="我的对话" value={selectedId} disabled={pending} onChange={e => { void switchChat(e.target.value); }}>
        {!selectedId && <option value="">加载中…</option>}{chats.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select>
        <GuestThemePicker />
        <Button variant="ghost" aria-label="新对话" title="新对话" disabled={pending} onClick={() => { readRequest.current?.abort();setPending(true);void guestChatApi.create().then(select).catch(report).finally(() => setPending(false)); }}>{pending ? <Loader2 className="guest-spin" /> : <Plus />}<span>{pending ? '创建中' : '新对话'}</span></Button>
        <Button variant="ghost" size="icon" aria-label="退出登录" title="退出登录" disabled={pending || Object.values(outgoing).some(message => message && !message.error)} onClick={() => { void guestChatApi.logout().then(() => { readRequest.current?.abort();activeId.current = null;cache.current.clear();positions.current.clear();attachments.reset();setDrafts({});setOutgoing({});setSelectedId('');setChat(null);setChats([]);setAuthenticated(false); }).catch(report); }}><LogOut /></Button>
      </div>
    </header>
    <main ref={scroller} className="guest-transcript" onScroll={e => { const el = e.currentTarget;stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; }}><div className="guest-content">
      {!chat ? <div className="guest-loading" role="status"><Loader2 className="guest-spin" /><span>{loadingId || pending ? '正在打开对话…' : '对话暂时未加载'}</span><div className="guest-skeleton" /><div className="guest-skeleton short" />{selectedId && <button onClick={() => { void switchChat(selectedId); }}>重新加载</button>}</div>
        : !chat.messages.length && !queued && <div className="guest-empty"><h2>把题目发给我</h2><p>输入文字，或上传题目截图。</p></div>}
      {chat && loadingId && <div className="guest-sync" role="status"><Loader2 className="guest-spin" size={12} />正在同步最新消息…</div>}
      {chat?.messages.map(message => <article key={message.id} className={`guest-message ${message.role}`}>
        {message.images.length > 0 && <div className="guest-images">{message.images.map(id => <a key={id} href={guestChatApi.image(id)} target="_blank" rel="noreferrer"><img src={images.find(image => image.imageId === id)?.preview || attachments.sentPreviews[id] || guestChatApi.image(id)} alt="题目截图" loading="lazy" decoding="async" /></a>)}</div>}
        {message.role === 'assistant' ? <><Suspense fallback={<div className="guest-question">{message.text || message.reasoning}</div>}><GuestAnswer message={message} busy={chat.busy && message === chat.messages.at(-1)} /></Suspense>
          <button className="guest-copy" onClick={() => { void copyTextToClipboard(message.text).then(ok => setNotice(ok ? '已复制回答' : '请长按选择文字复制。')); }}>复制回答</button></> : <div className="guest-question">{message.text}</div>}
      </article>)}
      {queued && !chat?.messages.some(message => message.id === queued.id) && <article className="guest-message user guest-outgoing">
        {queued.previews.length > 0 && <div className="guest-images">{queued.previews.map(url => <img key={url} src={url} alt="正在发送的图片" />)}</div>}
        <div className="guest-question">{queued.text}</div>
        <div className="guest-delivery" role="status">{queued.error ? <><span>{queued.error}</span><button onClick={() => { void send(queued); }}><RotateCw size={12} />重试发送</button></> : <><Loader2 className="guest-spin" size={12} />{elapsed >= 5 ? '正在确认送达' : '正在发送'} · {elapsed}s</>}</div>
      </article>}
      {chat?.busy && chat.messages.at(-1)?.role !== 'user' && !chat.messages.at(-1)?.text && <div className="guest-waiting" role="status"><Loader2 className="guest-spin" size={15} /><span>{chat.status || '正在思考'} · {elapsed}s</span><small>{elapsed >= 15 ? '正在准备回答，内容会实时显示' : '问题已送达，正在准备回答'}</small></div>}
      {chat?.busy && chat.messages.at(-1)?.role === 'user' && <div className="guest-waiting" role="status"><Loader2 className="guest-spin" size={15} /><span>{chat.status || '正在思考'} · {elapsed}s</span><small>问题已送达，内容会实时显示</small></div>}
      {chat?.error && <div role="alert" className="guest-notice">{chat.error}</div>}
    </div></main>
    <footer className="guest-footer"><div className="guest-compose-shell"><img className="guest-companions" src={companions} alt="" aria-hidden="true" width={112} height={56} loading="lazy" decoding="async" /><div className="guest-compose">
      {images.length > 0 && <div className="guest-previews">{images.map((image, index) => <div key={image.id} className="guest-attachment">
        <img src={image.preview} alt={`待发送图片 ${index + 1}`} />
        <button className="guest-remove-image" disabled={posting} aria-label={`移除图片 ${index + 1}`} onClick={() => attachments.remove(selectedId, image.id)}><X size={14} /></button>
        <div className="guest-upload-state" role="status">{image.status === 'error' ? <button title={image.error} aria-label={`重试图片 ${index + 1}`} onClick={() => attachments.retry(selectedId, image)}><RotateCw size={12} />重试</button>
          : image.status === 'ready' ? <><Check size={12} />已就绪</> : <><Loader2 className="guest-spin" size={11} />{image.status === 'preparing' ? '优化图片' : image.status === 'queued' ? '等待上传' : image.progress >= 99 ? '确认中' : `${image.progress}%`}</>}</div>
        {image.status === 'uploading' && <progress aria-label={`图片 ${index + 1} 上传进度`} value={image.progress} max={100} />}
      </div>)}</div>}
      {images.some(image => image.error) && <p className="guest-upload-error">{images.find(image => image.error)?.error}</p>}
      <textarea ref={composer} aria-label="输入问题" placeholder="发消息，或粘贴截图…" readOnly={posting} disabled={!selectedId} value={draft} maxLength={32000} onChange={e => setDraft(e.target.value)}
        onPaste={e => { const files = [...e.clipboardData.files];if (files.length) { e.preventDefault();void addImages(files); } }}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && matchMedia('(pointer:fine)').matches) { e.preventDefault();void send(); } }} />
      <div className="guest-compose-bar"><input ref={upload} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={e => { void addImages([...e.target.files || []]);e.target.value = ''; }} />
        <Button variant="ghost" aria-label="上传图片" disabled={!selectedId || posting} onClick={() => upload.current?.click()}><ImagePlus /><span>图片</span></Button>
        <span className="guest-status guest-status-visible" role="status">{pending ? <><Loader2 className="guest-spin" size={12} />处理中…</> : posting ? <><i />确认送达 · {elapsed}s</> : chat?.busy ? <><i />{chat.status || '思考中'} · {elapsed}s</> : images.length && !ready ? '图片准备中…' : connection}</span>
        {chat?.busy ? <Button variant="outline" disabled={pending} onClick={() => { setPending(true);void guestChatApi.stop(chat.id).then(receive).catch(report).finally(() => setPending(false)); }}><Square size={14} />停止</Button>
          : <Button className="guest-primary" aria-label="发送问题" disabled={pending || posting || !ready || !chat || (!draft.trim() && !images.length)} onClick={() => { void send(); }}>{posting ? <Loader2 className="guest-spin" /> : <ArrowUp />}<span>{posting ? '发送中' : '发送'}</span></Button>}
      </div>
    </div></div>{notice && <p className="guest-feedback" role="status">{notice}</p>}</footer>
  </div>;
}
