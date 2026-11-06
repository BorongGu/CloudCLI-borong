import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Pause, Play, Send } from 'lucide-react';

import { groupsApi } from '@/shared/api';
import { createClientRequestId } from '@/shared/utils';
import type { OrbitGroupMessage, OrbitGroupPostInput, OrbitGroupSnapshot } from '@/shared/types';

const FIELD = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm';
const KIND_LABELS = { send: '消息', publish: '公开信息', request: '请求信息', reply: '回复', task: '小组任务' };
const STATUS_LABELS = { queued: '排队中', running: '执行中', completed: '本轮结束', failed: '执行失败', interrupted: '已中断' };

/** Used by GroupsPage for task dispatch, peer communication, publications and delivery status. */
export function GroupWorkspace({ snapshot, refresh }: { snapshot: OrbitGroupSnapshot; refresh: () => Promise<void> }) {
  const { group, members, messages, publications, deliveries } = snapshot;
  // Composer state retains task-specific instructions and the selected communication operation.
  const [draft, setDraft] = useState({ mode: 'task' as 'task' | OrbitGroupPostInput['kind'], content: '', to: '*', title: '', replyTo: '', assignments: {} as Record<string, string> });
  // A user-selected wakeup allowance controls how many subsequent member turns can start.
  const [turns, setTurns] = useState(20);
  // This tab switches between the conversational timeline and durable publications.
  const [tab, setTab] = useState<'messages' | 'publications'>('messages');
  // Submission state preserves drafts on failure and prevents duplicate UI actions.
  const [submission, setSubmission] = useState({ busy: false, error: '' });
  const pending = useRef<{ fingerprint: string; id: string } | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const names = new Map(members.map(member => [member.id, member.name]));
  const displayName = (id: string | null) => id ? names.get(id) || id : '你';

  const control = async (input: { paused: boolean; turns?: number; retry?: boolean }) => {
    setSubmission({ busy: true, error: '' });
    try { await groupsApi.control(group.id, input); await refresh(); setSubmission({ busy: false, error: '' }); }
    catch (error) { setSubmission({ busy: false, error: error instanceof Error ? error.message : String(error) }); }
  };

  const renderMessage = (message: OrbitGroupMessage) => <article key={message.id} className="rounded-xl border border-border bg-background p-4">
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><strong className="text-foreground">{displayName(message.senderId)}</strong><span>{message.recipientId ? `→ ${displayName(message.recipientId)}` : '→ 小组'}</span><span className="rounded bg-muted px-2 py-0.5">{KIND_LABELS[message.kind]}</span><time className="ml-auto">{message.createdAt}</time></div>
    {message.replyTo && <p className="mt-2 truncate text-xs text-muted-foreground">回复：{messages.find(item => item.id === message.replyTo)?.content || message.replyTo}</p>}
    {message.title && <h3 className="mt-3 font-medium">{message.title}</h3>}
    <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed">{message.content}</p>
    {Object.entries(message.assignments).filter(([, value]) => value).map(([id, value]) => <p key={id} className="mt-2 whitespace-pre-wrap rounded-lg bg-muted/40 p-2 text-sm"><strong>{displayName(id)}：</strong>{value}</p>)}
    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      {deliveries.filter(delivery => delivery.messageId === message.id).map(delivery => <span key={delivery.memberId} title={delivery.error || undefined} className={delivery.status === 'failed' || delivery.status === 'interrupted' ? 'text-amber-600' : ''}>{displayName(delivery.memberId)} · {STATUS_LABELS[delivery.status]}</span>)}
      {message.senderId && <button className="ml-auto hover:text-foreground" onClick={() => { setDraft(old => ({ ...old, mode: 'reply', replyTo: message.id })); composer.current?.focus(); }}>回复</button>}
    </div>
    {deliveries.filter(delivery => delivery.messageId === message.id && delivery.error).map(delivery => <p key={delivery.memberId} className="mt-2 text-xs text-amber-600">{displayName(delivery.memberId)}：{delivery.error}</p>)}
  </article>;

  return <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 p-4 md:p-7">
    <header className="flex flex-wrap items-center gap-3"><div className="min-w-0 flex-1 basis-full sm:basis-auto"><h1 className="text-xl font-semibold">{group.name}</h1><p className="mt-1 break-all text-xs text-muted-foreground">{group.projectPath}</p></div>
      <span className="text-xs text-muted-foreground">{group.paused ? '派发已暂停' : group.turnsRemaining ? `剩余 ${group.turnsRemaining} 次成员运行` : '本次运行额度已用完'}</span>
      <button disabled={submission.busy} className="flex items-center gap-1 rounded-lg border border-border px-3 py-2 text-xs" onClick={() => void control(group.paused || !group.turnsRemaining ? { paused: false, turns } : { paused: true })}>
        {group.paused || !group.turnsRemaining ? <Play size={14} /> : <Pause size={14} />}{group.paused || !group.turnsRemaining ? '继续派发' : '暂停派发'}
      </button>
    </header>
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{members.map(member => <Link key={member.id} to={`/session/${member.sessionId}`} className="flex items-center gap-3 rounded-xl border border-border p-3 hover:bg-muted/50">
      <span className={`h-2 w-2 shrink-0 rounded-full ${member.busy ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`} /><div className="min-w-0 flex-1"><strong className="text-sm">{member.name}</strong><p className="truncate text-xs text-muted-foreground">{member.provider} · {member.model || '默认模型'}</p></div><ArrowUpRight size={15} />
    </Link>)}</div>
    <form className="space-y-3 rounded-xl border border-border bg-muted/20 p-4" onSubmit={async event => {
      event.preventDefault();
      if (!draft.content.trim() || submission.busy) return;
      setSubmission({ busy: true, error: '' });
      const fingerprint = JSON.stringify({ draft, turns });
      if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, id: createClientRequestId() };
      const requestId = pending.current.id;
      try {
        if (draft.mode === 'task') await groupsApi.dispatch(group.id, { content: draft.content, assignments: draft.assignments, turns, requestId });
        else await groupsApi.post(group.id, { kind: draft.mode, content: draft.content, requestId,
          ...(['send', 'request'].includes(draft.mode) ? { to: draft.to } : {}),
          ...(draft.mode === 'publish' ? { title: draft.title } : {}), ...(draft.mode === 'reply' ? { replyTo: draft.replyTo } : {}),
        });
        pending.current = null;
        setDraft(old => ({ ...old, content: '', title: '', replyTo: '', mode: old.mode === 'reply' ? 'send' : old.mode }));
        setSubmission({ busy: false, error: '' });
        await refresh();
      } catch (error) { setSubmission({ busy: false, error: error instanceof Error ? error.message : String(error) }); }
    }}>
      <div className="flex flex-wrap items-center gap-2"><select aria-label="操作" className="rounded-lg border border-border bg-background px-3 py-2 text-sm" value={draft.mode} onChange={event => setDraft(old => ({ ...old, mode: event.target.value as typeof old.mode, to: event.target.value === 'request' ? members[0].id : old.to }))}>
        <option value="task">派发小组任务</option><option value="send">发送消息</option><option value="publish">Publish 公开信息</option><option value="request">请求信息</option>{draft.replyTo && <option value="reply">回复消息</option>}
      </select>
      {['send', 'request'].includes(draft.mode) && <select aria-label="接收者" className="rounded-lg border border-border bg-background px-3 py-2 text-sm" value={draft.to} onChange={event => setDraft(old => ({ ...old, to: event.target.value }))}>
        {draft.mode === 'send' && <option value="*">全体成员</option>}{members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
      </select>}
      <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">运行额度<input aria-label="运行额度" className="w-20 rounded border border-border bg-background px-2 py-1" type="number" min={2} max={1000} value={turns} onChange={event => setTurns(Number(event.target.value))} /></label></div>
      {draft.mode === 'reply' && <p className="text-xs text-muted-foreground">回复：{messages.find(item => item.id === draft.replyTo)?.content || draft.replyTo}</p>}
      {draft.mode === 'publish' && <input aria-label="信息标题" className={FIELD} placeholder="标题（可选）" value={draft.title} onChange={event => setDraft(old => ({ ...old, title: event.target.value }))} />}
      <textarea ref={composer} aria-label="内容" required maxLength={16000} rows={4} className={FIELD} value={draft.content} onChange={event => setDraft(old => ({ ...old, content: event.target.value }))} placeholder={draft.mode === 'task' ? '共同任务、背景材料、期望结果，以及这次想采用的协作方式…' : '写下想交流或公开的信息…'} />
      {draft.mode === 'task' && <div className="grid gap-3 md:grid-cols-3">{members.map(member => <label key={member.id} className="space-y-1"><span className="text-xs">给 {member.name} 的补充说明</span><textarea aria-label={`给 ${member.name} 的补充说明`} rows={3} maxLength={8000} className={FIELD} value={draft.assignments[member.id] || ''} onChange={event => setDraft(old => ({ ...old, assignments: { ...old.assignments, [member.id]: event.target.value } }))} placeholder="本次分工、关注点或特别要求（可选）" /></label>)}</div>}
      <div className="flex flex-wrap items-center justify-between gap-3"><p className="max-w-xl text-xs leading-relaxed text-muted-foreground">{draft.mode === 'publish' ? '公开信息供全体成员读取，并随下一次小组运行一起送达。' : draft.mode === 'task' ? '共同任务与各人说明一起送达全体成员。运行额度包括后续消息唤醒。' : '消息排到接收者空闲时执行，沿用小组剩余运行额度。'}</p><button disabled={submission.busy} className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"><Send size={15} />{submission.busy ? '正在发送…' : draft.mode === 'task' ? '派发给全体成员' : '发送'}</button></div>
      {submission.error && <p role="alert" className="text-sm text-red-500">{submission.error}</p>}
    </form>
    {deliveries.some(delivery => ['failed', 'interrupted'].includes(delivery.status)) && <div className="flex flex-wrap items-center gap-3 rounded-lg bg-amber-500/10 p-3 text-sm"><span className="flex-1">部分投递需要处理。可打开成员会话查看进度，再重新投递。</span><button disabled={submission.busy} className="underline" onClick={() => void control({ paused: false, turns, retry: true })}>重试失败的投递</button></div>}
    <nav className="flex gap-5 border-b border-border text-sm"><button className={`pb-3 ${tab === 'messages' ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground'}`} onClick={() => setTab('messages')}>最近动态</button><button className={`pb-3 ${tab === 'publications' ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground'}`} onClick={() => setTab('publications')}>公开信息 · {publications.length}</button></nav>
    <div className="space-y-3">{(tab === 'messages' ? messages : publications).length ? (tab === 'messages' ? messages : publications).slice().reverse().map(renderMessage) : <p className="py-8 text-center text-sm text-muted-foreground">{tab === 'messages' ? '写下共同任务，开启这次协作。' : '成员 publish 的关键信息会保存在这里。'}</p>}</div>
  </div>;
}
