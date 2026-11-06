import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Pause, Play, Send } from 'lucide-react';

import { groupsApi } from '@/shared/api';
import { ProviderModelPicker } from '@/shared/ui/ProviderModelPicker';
import { StreamingMarkdown } from '@/modules/chat';
import { createClientRequestId } from '@/shared/utils';
import type { OrbitGroupMessage, OrbitGroupPostInput, OrbitGroupSnapshot } from '@/shared/types';

const FIELD = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm';
const KIND_LABELS = { send: '消息', publish: '关键结论发布', request: '请求信息', reply: '回复', task: '小组任务' };
const STATUS_LABELS = { queued: '等待投递', delivering: '正在送入当前执行', delivered: '已送入当前执行', running: '执行中', completed: '本轮结束', failed: '执行失败', interrupted: '已中断' };

/** Used by GroupsPage for task dispatch, peer communication, publications and delivery status. */
export function GroupWorkspace({ snapshot, refresh }: { snapshot: OrbitGroupSnapshot; refresh: () => Promise<void> }) {
  const { group, members, deliveries } = snapshot;
  // Older pages remain available while polling refreshes the recent group activity.
  const [history, setHistory] = useState<{ messages: OrbitGroupMessage[]; publications: OrbitGroupMessage[]; exhausted: string[]; loading: boolean }>({ messages: [], publications: [], exhausted: [], loading: false });
  const messages = [...new Map([...history.messages, ...snapshot.messages].map(message => [message.id, message])).values()].sort((a, b) => a.seq - b.seq);
  const publications = [...new Map([...history.publications, ...snapshot.publications].map(message => [message.id, message])).values()].sort((a, b) => a.seq - b.seq);
  // Composer state retains task-specific instructions and the selected communication operation.
  const [draft, setDraft] = useState({ mode: (snapshot.currentTask ? 'send' : 'task') as 'task' | OrbitGroupPostInput['kind'], content: '', to: '', title: '', replyTo: '', assignments: {} as Record<string, string> });
  // A user-selected wakeup allowance controls how many subsequent member turns can start.
  const [turns, setTurns] = useState(20);
  // This tab switches between the conversational timeline and durable publications.
  const [tab, setTab] = useState<'messages' | 'publications' | 'pending'>('messages');
  // Submission state preserves drafts on failure and prevents duplicate UI actions.
  const [submission, setSubmission] = useState({ busy: false, error: '' });
  const pending = useRef<{ fingerprint: string; id: string } | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const names = new Map(members.map(member => [member.id, member.name]));
  const displayName = (id: string | null) => id && id !== 'user' ? names.get(id) || id : '你';
  const expectedReplies = snapshot.pendingReplies || [];
  const awaitingUser = expectedReplies.filter(item => item.memberId === 'user');
  const approvalMembers = members.filter(member => (member.pendingApprovals || 0) > 0);
  const reply = (id: string) => { setDraft(old => ({ ...old, mode: 'reply', replyTo: id })); composer.current?.focus(); };
  const updateModel = async (memberId: string, model: string, effort: string) => {
    try { await groupsApi.updateMember(group.id, memberId, model, effort); await refresh(); }
    catch (error) { setSubmission({ busy: false, error: error instanceof Error ? error.message : String(error) }); }
  };

  const control = async (input: { paused: boolean; turns?: number; retry?: boolean }) => {
    setSubmission({ busy: true, error: '' });
    try { await groupsApi.control(group.id, input); await refresh(); setSubmission({ busy: false, error: '' }); }
    catch (error) { setSubmission({ busy: false, error: error instanceof Error ? error.message : String(error) }); }
  };

  const renderMessage = (message: OrbitGroupMessage) => <article key={message.id} className="rounded-xl border border-border bg-background p-4">
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><strong className="text-foreground">{displayName(message.senderId)}</strong><span>公开讨论</span>{message.mentions?.map(id => <span key={id} className="text-primary">@{displayName(id)}</span>)}<span className="rounded bg-muted px-2 py-0.5">{KIND_LABELS[message.kind]}</span><time className="ml-auto">{message.createdAt}</time></div>
    {message.replyTo && <p className="mt-2 truncate text-xs text-muted-foreground">回复：{messages.find(item => item.id === message.replyTo)?.content || message.replyTo}</p>}
    {message.title && <h3 className="mt-3 font-medium">{message.title}</h3>}
    <StreamingMarkdown workspaceProjectId={snapshot.project?.projectId} isStreaming={false} className="mt-2 break-words text-sm leading-relaxed" content={message.content} />
    {Object.entries(message.assignments).filter(([, value]) => value).map(([id, value]) => <p key={id} className="mt-2 whitespace-pre-wrap rounded-lg bg-muted/40 p-2 text-sm"><strong>{displayName(id)}：</strong>{value}</p>)}
    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      {deliveries.filter(delivery => delivery.messageId === message.id).map(delivery => <span key={delivery.memberId} title={delivery.error || undefined} className={delivery.status === 'failed' || delivery.status === 'interrupted' ? 'text-amber-600' : ''}>{displayName(delivery.memberId)} · {delivery.status === 'queued' && message.kind !== 'task' && !message.mentions?.includes(delivery.memberId) && !(message.kind === 'reply' && message.recipientId === delivery.memberId) && !members.find(member => member.id === delivery.memberId)?.busy ? '供后续查阅' : STATUS_LABELS[delivery.status]}</span>)}
      {message.senderId && <button className="ml-auto hover:text-foreground" onClick={() => reply(message.id)}>回复</button>}
    </div>
    {deliveries.filter(delivery => delivery.messageId === message.id && delivery.error).map(delivery => <p key={delivery.memberId} className="mt-2 text-xs text-amber-600">{displayName(delivery.memberId)}：{delivery.error}</p>)}
  </article>;

  return <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 p-4 md:p-7">
    <header className="flex flex-wrap items-center gap-3"><div className="min-w-0 flex-1 basis-full sm:basis-auto"><h1 className="text-xl font-semibold">{group.name}</h1><p className="mt-1 break-all text-xs text-muted-foreground">{group.projectPath}</p></div>
      <span className="text-xs text-muted-foreground">{group.paused ? '派发已暂停' : group.turnsRemaining ? `剩余 ${group.turnsRemaining} 次自动启动` : '自动启动次数已用完'}</span>
      <button disabled={submission.busy} className="flex items-center gap-1 rounded-lg border border-border px-3 py-2 text-xs" onClick={() => void control(group.paused || !group.turnsRemaining ? { paused: false, turns } : { paused: true })}>
        {group.paused || !group.turnsRemaining ? <Play size={14} /> : <Pause size={14} />}{group.paused || !group.turnsRemaining ? '继续派发' : '暂停派发'}
      </button>
    </header>
    {snapshot.currentTask && <details className="rounded-xl border border-border p-4">
      <summary className="cursor-pointer text-sm font-medium">当前任务 · {snapshot.currentTask.content.slice(0, 100)}</summary>
      <div className="mt-3"><StreamingMarkdown workspaceProjectId={snapshot.project?.projectId} isStreaming={false} content={snapshot.currentTask.content} className="text-sm" /></div>
      {Object.entries(snapshot.currentTask.assignments).filter(([, value]) => value).map(([id, value]) => <p key={id} className="mt-2 whitespace-pre-wrap text-sm"><strong>{displayName(id)}：</strong>{value}</p>)}
    </details>}
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">{members.map(member => <div key={member.id} className="space-y-3 rounded-xl border border-border p-3">
      <Link to={`/groups/${group.id}/members/${member.id}`} className="flex items-center gap-3 hover:text-primary">
        <span className={`h-2 w-2 shrink-0 rounded-full ${member.busy ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`} />
        <div className="min-w-0 flex-1"><strong className="text-sm">{member.name}</strong><p className="text-xs text-muted-foreground">{member.provider} · {member.pendingApprovals ? '等待你确认' : member.busy ? '正在工作' : '空闲'} · 完整记录</p></div><ArrowUpRight size={15} />
      </Link>
      <ProviderModelPicker provider={member.provider} model={member.model} effort={member.effort} label={`${member.name} 模型与推理强度`} onChange={(model, effort) => void updateModel(member.id, model, effort)} />
      {snapshot.currentTask?.assignments[member.id] && <p className="hidden text-xs text-muted-foreground sm:line-clamp-2">{snapshot.currentTask.assignments[member.id]}</p>}
    </div>)}</div>
    {(awaitingUser.length > 0 || approvalMembers.length > 0) && <section className="space-y-2 rounded-xl border border-primary/30 bg-primary/5 p-4"><strong className="text-sm">需要你回应 · {awaitingUser.length + approvalMembers.reduce((sum, member) => sum + (member.pendingApprovals || 0), 0)}</strong>{awaitingUser.map(item => <button key={item.messageId} onClick={() => reply(item.messageId)} className="block w-full truncate text-left text-sm"><span className="font-medium">{displayName(item.senderId)}：</span>{item.content}</button>)}{approvalMembers.map(member => <Link key={member.id} className="block text-sm" to={`/groups/${group.id}/members/${member.id}`}>{member.name} 有 {member.pendingApprovals} 项待确认 · 打开成员控制台</Link>)}</section>}
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
          ...(['send', 'request'].includes(draft.mode) && draft.to ? { to: draft.to } : {}),
          ...(draft.mode === 'publish' ? { title: draft.title } : {}), ...(draft.mode === 'reply' ? { replyTo: draft.replyTo } : {}),
        });
        pending.current = null;
        setDraft(old => ({ ...old, content: '', title: '', replyTo: '', mode: old.mode === 'reply' || old.mode === 'task' ? 'send' : old.mode }));
        setSubmission({ busy: false, error: '' });
        await refresh();
      } catch (error) { setSubmission({ busy: false, error: error instanceof Error ? error.message : String(error) }); }
    }}>
      <div className="flex flex-wrap items-center gap-2"><select aria-label="操作" className="rounded-lg border border-border bg-background px-3 py-2 text-sm" value={draft.mode} onChange={event => setDraft(old => ({ ...old, mode: event.target.value as typeof old.mode, to: event.target.value === 'request' ? members[0].id : old.to }))}>
        <option value="task">{snapshot.currentTask ? '更新小组任务' : '派发小组任务'}</option><option value="send">公开讨论</option><option value="publish">关键结论发布</option><option value="request">请求信息</option>{draft.replyTo && <option value="reply">回复消息</option>}
      </select>
      {['send', 'request'].includes(draft.mode) && <select aria-label="期待回复" className="rounded-lg border border-border bg-background px-3 py-2 text-sm" value={draft.to} onChange={event => setDraft(old => ({ ...old, to: event.target.value }))}>
        {draft.mode === 'send' && <option value="">公开发言</option>}<option value="*">@all · 请全体参与</option>{members.map(member => <option key={member.id} value={member.id}>@{member.name}</option>)}
      </select>}
      </div>
      {draft.mode === 'reply' && <p className="text-xs text-muted-foreground">回复：{messages.find(item => item.id === draft.replyTo)?.content || draft.replyTo}</p>}
      {draft.mode === 'publish' && <input aria-label="结论标题" className={FIELD} placeholder="标题（可选）" value={draft.title} onChange={event => setDraft(old => ({ ...old, title: event.target.value }))} />}
      <textarea ref={composer} aria-label="内容" required maxLength={16000} rows={4} className={FIELD} value={draft.content} onChange={event => setDraft(old => ({ ...old, content: event.target.value }))} placeholder={draft.mode === 'task' ? '共同任务、背景材料、期望结果，以及这次想采用的协作方式…' : '写下想交流或公开的信息…'} />
      {draft.mode === 'task' && <div className="grid gap-3 md:grid-cols-3">{members.map(member => <label key={member.id} className="space-y-1"><span className="text-xs">给 {member.name} 的补充说明</span><textarea aria-label={`给 ${member.name} 的补充说明`} rows={3} maxLength={8000} className={FIELD} value={draft.assignments[member.id] || ''} onChange={event => setDraft(old => ({ ...old, assignments: { ...old.assignments, [member.id]: event.target.value } }))} placeholder="本次分工、关注点或特别要求（可选）" /></label>)}</div>}
      <div className="flex flex-wrap items-center justify-between gap-3"><p className="max-w-xl text-xs leading-relaxed text-muted-foreground">{draft.mode === 'publish' ? '保存经过核查的关键发现与结论，供全组共同参考。' : draft.mode === 'task' ? '正式更新共同目标与分工，并通知全体成员。' : '所有发言公开可见。@ 表示期待回复；成员先独立核查，再给出有实质内容的回应。'}</p><button disabled={submission.busy} className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"><Send size={15} />{submission.busy ? '正在发送…' : draft.mode === 'task' ? snapshot.currentTask ? '更新任务并通知全组' : '派发给全体成员' : '发送'}</button></div>
      {submission.error && <p role="alert" className="text-sm text-red-500">{submission.error}</p>}
    </form>
    {deliveries.some(delivery => ['failed', 'interrupted'].includes(delivery.status)) && <div className="flex flex-wrap items-center gap-3 rounded-lg bg-amber-500/10 p-3 text-sm"><span className="flex-1">部分投递需要处理。可打开成员会话查看进度，再重新投递。</span><button disabled={submission.busy} className="underline" onClick={() => void control({ paused: false, turns, retry: true })}>重试失败的投递</button></div>}
    <details className="rounded-lg border border-border p-3 text-xs text-muted-foreground"><summary className="cursor-pointer">自动运行设置与 Group 提示词</summary>
      <label className="mt-3 flex items-center gap-2">自动运行次数上限<input aria-label="自动运行次数上限" className="w-20 rounded border border-border bg-background px-2 py-1" type="number" min={members.length} max={1000} value={turns} onChange={event => setTurns(Number(event.target.value))} /></label>
      <p className="mt-2">每启动一位空闲成员计 1 次。初始派发给 3 位成员计 3 次；运行中追加信息沿用当前执行。新任务与“继续派发”使用这里的上限。</p>
      {snapshot.systemPrompt && <pre className="mt-3 whitespace-pre-wrap leading-relaxed">{snapshot.systemPrompt}</pre>}
    </details>
    <nav className="flex gap-5 border-b border-border text-sm"><button className={`pb-3 ${tab === 'messages' ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground'}`} onClick={() => setTab('messages')}>公开讨论</button><button className={`pb-3 ${tab === 'publications' ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground'}`} onClick={() => setTab('publications')}>关键结论发布 · {publications.length}</button><button className={`pb-3 ${tab === 'pending' ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground'}`} onClick={() => setTab('pending')}>待回复 · {expectedReplies.length}</button></nav>
    <div className="space-y-3">{tab === 'pending' ? expectedReplies.map(item => <button key={`${item.messageId}:${item.memberId}`} onClick={() => reply(item.messageId)} className="block w-full rounded-xl border border-border p-4 text-left text-sm"><span className="mb-2 block font-medium">{displayName(item.senderId)} → @{displayName(item.memberId)} · 待回复</span>{item.content}</button>)
      : (tab === 'messages' ? messages : publications).length ? (tab === 'messages' ? messages : publications).slice().reverse().map(renderMessage) : <p className="py-8 text-center text-sm text-muted-foreground">{tab === 'messages' ? '写下共同任务，开启这次协作。' : '通过 publish 发布的关键结论会保存在这里。'}</p>}</div>
    {tab !== 'pending' && !history.exhausted.includes(tab) && (tab === 'messages' ? messages : publications).length >= 100 && <button className="py-3 text-sm text-muted-foreground" disabled={history.loading} onClick={async () => {
      const selected = tab;
      setHistory(old => ({ ...old, loading: true }));
      try {
        const result = await groupsApi.history(group.id, (selected === 'messages' ? messages : publications)[0].seq, selected === 'publications');
        setHistory(old => ({ ...old, [selected]: [...result.messages, ...old[selected]], loading: false, exhausted: result.hasMore ? old.exhausted : [...old.exhausted, selected] }));
      } catch (error) { setHistory(old => ({ ...old, loading: false })); setSubmission({ busy: false, error: String(error) }); }
    }}>{history.loading ? '正在读取…' : '查看更早记录'}</button>}
  </div>;
}
