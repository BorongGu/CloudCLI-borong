import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ArrowUp, ImagePlus, LogOut, MessageSquare, Plus, Square, X } from 'lucide-react';

import { guestChatApi } from '@/shared/api';
import type { GuestChatSnapshot, GuestChatSummary } from '@/shared/types';
import { Button, Input } from '@/shared/ui';
import { copyTextToClipboard } from '@/shared/utils';
import '@/modules/guest-chat/guest-chat.css';

const GuestAnswer = lazy(() => import('@/modules/guest-chat/GuestAnswer'));

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
  const [draft, setDraft] = useState('');
  // Retain local upload previews until their question is accepted.
  const [images, setImages] = useState<string[]>([]);
  // An HTTP mutation has a separate pending state from the model's busy state.
  const [pending, setPending] = useState(false);
  // Inline feedback covers request failures, connection loss and successful copy.
  const [notice, setNotice] = useState('');
  const activeId = useRef<string | null>(null);
  const request = useRef<{ fingerprint: string; id: string } | null>(null);
  const scroller = useRef<HTMLElement>(null);
  const stick = useRef(true);
  const upload = useRef<HTMLInputElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);

  function report(error: unknown) {
    if ((error as { status?: number }).status === 401) setAuthenticated(false);
    setNotice(error instanceof Error ? error.message : '连接暂时中断，请重试。');
  }
  function select(next: GuestChatSnapshot) {
    activeId.current = next.id;stick.current = true;setChat(next);setDraft('');setImages([]);setNotice('');
    localStorage.setItem('guest-active-chat', next.id);
  }
  async function refreshList() { const result = await guestChatApi.list();setChats(result.chats);return result.chats; }

  useEffect(() => { void guestChatApi.auth().then(r => { if (r.username) setUsername(r.username);setAuthenticated(r.authenticated); }).catch(error => { setAuthenticated(false);report(error); }); }, []);
  useEffect(() => {
    if (!authenticated) return;
    let disposed = false;
    void import('@/modules/guest-chat/GuestAnswer');
    void (async () => {
      const list = await refreshList();
      const saved = localStorage.getItem('guest-active-chat');
      const chosen = list.find(c => c.id === saved) || list[0];
      const next = chosen ? await guestChatApi.read(chosen.id) : await guestChatApi.create();
      if (!disposed) { select(next);await refreshList(); }
    })().catch(report);
    return () => { disposed = true; };
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated || !chat?.id) return;
    let disposed = false;let live = false;let timer: ReturnType<typeof setTimeout>;let reconnect: ReturnType<typeof setTimeout>;
    let stopSocket = () => {};
    const id = chat.id;
    const receive = (next: GuestChatSnapshot) => {
      if (disposed || activeId.current !== id) return;
      setChat(previous => {
        if (previous?.id === next.id && previous.revision >= next.revision) return previous;
        if (next.partial && previous?.id === next.id) {
          const messages = [...previous.messages];
          for (const message of next.messages) { const index = messages.findIndex(item => item.id === message.id);if (index < 0) messages.push(message);else messages[index] = message; }
          return { ...next, partial: undefined, messages };
        }
        return next;
      });
      setNotice(previous => previous === '连接中断，正在重新连接…' ? '' : previous);
    };
    const connect = () => {
      if (disposed) return;
      stopSocket = guestChatApi.subscribe(id, receive, connected => {
        live = connected;
        if (!connected && !disposed) reconnect = setTimeout(connect, 2000);
      });
    };
    connect();
    const poll = async () => {
      let busy = false;
      try { const next = await guestChatApi.read(id);busy = next.busy;receive(next); }
      catch (error) {
        if (!disposed) { if ((error as { status?: number }).status === 401) setAuthenticated(false);else if (!live) setNotice('连接中断，正在重新连接…'); }
      }
      if (!disposed) timer = setTimeout(() => { void poll(); }, live ? 15_000 : document.hidden ? 3000 : busy ? 500 : 1800);
    };
    void poll();return () => { disposed = true;clearTimeout(timer);clearTimeout(reconnect);stopSocket(); };
  }, [authenticated, chat?.id]);

  useEffect(() => {
    const target = scroller.current;if (!target) return;
    const observer = new ResizeObserver(() => { if (stick.current) target.scrollTop = target.scrollHeight; });
    const content = target.firstElementChild;if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [authenticated, chat?.id]);

  async function login(event: React.FormEvent) {
    event.preventDefault();setPending(true);setNotice('');
    try { await guestChatApi.login(username, password);setPassword('');setAuthenticated(true); }
    catch (error) { report(error); } finally { setPending(false); }
  }
  async function addImages(files: File[]) {
    if (images.length + files.length > 3) { setNotice('每次最多上传 3 张图片。');return; }
    try {
      const urls = await Promise.all(files.map(file => new Promise<string>((resolve, reject) => {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5_000_000) return reject(new Error('请选择小于 5 MB 的 PNG、JPG 或 WebP 图片。'));
        const reader = new FileReader();reader.onload = () => resolve(String(reader.result));reader.onerror = () => reject(new Error('图片读取失败。'));reader.readAsDataURL(file);
      })));
      setImages(previous => [...previous, ...urls].slice(0, 3));setNotice('');
    } catch (error) { report(error); }
  }
  async function send() {
    if (!chat || pending || chat.busy || (!draft.trim() && !images.length)) return;
    const id = chat.id;const fingerprint = JSON.stringify([id, draft, images]);
    if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() };
    setPending(true);setNotice('');stick.current = true;
    try {
      const next = await guestChatApi.send(id, draft, images, request.current.id);
      if (activeId.current === id) { setChat(next);setDraft('');setImages([]);request.current = null; }
      await refreshList();composer.current?.focus();
    } catch (error) { report(error); } finally { setPending(false); }
  }

  if (authenticated !== true) return <main className="guest-login"><form onSubmit={login}>
    <div className="guest-brand"><MessageSquare size={23} /></div><h1>答疑助手</h1><p>文字、截图，随时提问。</p>
    <label htmlFor="guest-user">账号</label><Input id="guest-user" autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} required />
    <label htmlFor="guest-password">密码</label><Input id="guest-password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required />
    {notice && <p role="alert" className="guest-notice">{notice}</p>}
    <Button type="submit" className="guest-primary" disabled={pending || authenticated === null}>{pending ? '正在登录…' : '进入对话'}</Button>
    <small>GPT-6 Astra · High</small>
  </form></main>;

  return <div className="guest-shell">
    <header className="guest-header"><div className="guest-heading"><div className="guest-brand"><MessageSquare size={20} /></div><div><h1>答疑助手</h1><p>GPT-6 Astra · High</p></div></div>
      <div className="guest-actions"><select aria-label="我的对话" value={chat?.id || ''} disabled={pending} onChange={e => { const id = e.target.value;activeId.current = id;void guestChatApi.read(id).then(next => { if (activeId.current === id) select(next); }).catch(report); }}>
        {!chat && <option value="">加载中…</option>}{chats.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select>
        <Button variant="ghost" aria-label="新对话" title="新对话" disabled={pending} onClick={() => { setPending(true);void guestChatApi.create().then(async next => { select(next);await refreshList(); }).catch(report).finally(() => setPending(false)); }}><Plus /><span>新对话</span></Button>
        <Button variant="ghost" size="icon" aria-label="退出登录" title="退出登录" onClick={() => { void guestChatApi.logout().then(() => { activeId.current = null;setChat(null);setChats([]);setAuthenticated(false); }).catch(report); }}><LogOut /></Button>
      </div>
    </header>
    <main ref={scroller} className="guest-transcript" onScroll={e => { const el = e.currentTarget;stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; }}><div className="guest-content">
      {!chat?.messages.length && <div className="guest-empty"><h2>有什么题目想一起看看？</h2><p>输入问题，或上传 / 粘贴题目截图。</p></div>}
      {chat?.messages.map(message => <article key={message.id} className={`guest-message ${message.role}`}>
        {message.images.length > 0 && <div className="guest-images">{message.images.map(id => <a key={id} href={guestChatApi.image(id)} target="_blank" rel="noreferrer"><img src={guestChatApi.image(id)} alt="题目截图" /></a>)}</div>}
        {message.role === 'assistant' ? <><Suspense fallback={<div className="guest-question">{message.text || message.reasoning}</div>}><GuestAnswer message={message} busy={chat.busy && message === chat.messages.at(-1)} /></Suspense>
          <button className="guest-copy" onClick={() => { void copyTextToClipboard(message.text).then(ok => setNotice(ok ? '已复制回答' : '请长按选择文字复制。')); }}>复制回答</button></> : <div className="guest-question">{message.text}</div>}
      </article>)}
      {chat?.error && <div role="alert" className="guest-notice">{chat.error}</div>}
    </div></main>
    <footer className="guest-footer"><div className="guest-compose">
      {images.length > 0 && <div className="guest-previews">{images.map((url, index) => <div key={index}><img src={url} alt={`待发送图片 ${index + 1}`} /><button aria-label={`移除图片 ${index + 1}`} onClick={() => setImages(previous => previous.filter((_, i) => i !== index))}><X size={14} /></button></div>)}</div>}
      <textarea ref={composer} aria-label="输入问题" placeholder="输入问题，或粘贴截图…" value={draft} maxLength={32000} onChange={e => setDraft(e.target.value)}
        onPaste={e => { const files = [...e.clipboardData.files];if (files.length) { e.preventDefault();void addImages(files); } }}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && matchMedia('(pointer:fine)').matches) { e.preventDefault();void send(); } }} />
      <div className="guest-compose-bar"><input ref={upload} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={e => { void addImages([...e.target.files || []]);e.target.value = ''; }} />
        <Button variant="ghost" aria-label="上传图片" onClick={() => upload.current?.click()}><ImagePlus /><span>图片</span></Button>
        <span className="guest-status" role="status">{pending ? '发送中…' : chat?.busy ? <><i />{chat.status || '思考中'}</> : 'Enter 发送 · Shift+Enter 换行'}</span>
        {chat?.busy ? <Button variant="outline" onClick={() => { void guestChatApi.stop(chat.id).catch(report); }}><Square size={14} />停止</Button>
          : <Button className="guest-primary" aria-label="发送问题" disabled={pending || !chat || (!draft.trim() && !images.length)} onClick={() => { void send(); }}><ArrowUp /><span>发送</span></Button>}
      </div>
    </div>{notice && <p className="guest-feedback" role="status">{notice}</p>}</footer>
  </div>;
}
