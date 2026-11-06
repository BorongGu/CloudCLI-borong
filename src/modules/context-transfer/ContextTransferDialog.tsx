import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Loader2, X } from 'lucide-react';

import { api, contextTransferApi } from '@/shared/api';
import { createClientRequestId } from '@/shared/utils';
import type { ContextTransferCommand, ContextTransferInput, ContextTransferRequest, LLMProvider } from '@/shared/types';
import { Dialog, DialogContent } from '@/shared/ui/Dialog';
import { ProviderModelPicker } from '@/shared/ui/ProviderModelPicker';

type Recipient = { sessionId: string; provider: LLMProvider; sessionTitle: string; projectDisplayName: string };
const FIELD = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm';
const ACTIVE = new Set(['queued', 'preparing', 'analyzing', 'ready', 'delivering']);
const LABELS = { queued: '等待当前会话空闲', preparing: '正在读取会话上下文', analyzing: '当前 agent 正在整理上下文', ready: '上下文已就绪，等待接收会话', delivering: '正在交付', completed: '上下文已交付', failed: '传递需要处理', cancelled: '已取消传递' };

/** Chat's /context and /handoff commands open this source-bound picker and durable progress view. */
export function ContextTransferDialog({ source, onClose, onNavigate, onSourceActivity }: {
  source: ContextTransferCommand; onClose: () => void; onNavigate: (id: string) => void; onSourceActivity?: (id: string) => void;
}) {
  // These are the user's independent scope/detail/recipient choices before starting the source-agent turn.
  const [form, setForm] = useState({ scope: 'recent_topic' as ContextTransferInput['scope'], granularity: source.command === 'handoff' ? 'fine' as const : 'coarse' as const,
    targetKind: 'new' as 'new' | 'existing', targetId: '', provider: source.provider, model: '', effort: 'default',
    mode: source.command === 'handoff' ? 'start' as ContextTransferInput['mode'] : 'attach' as ContextTransferInput['mode'],
    instruction: source.instruction || (source.command === 'handoff' ? '请根据移交的上下文接手当前任务，先核查现状，再继续推进。' : '请将这份上下文作为后续讨论的背景，结合现有信息独立判断。') });
  // The server owns request progress; reopening the command restores an active or failed request.
  const [request, setRequest] = useState<ContextTransferRequest | null>(null);
  // Keep recipient pagination independent from locally filtering loaded conversation titles.
  const [recipients, setRecipients] = useState<{ items: Recipient[]; offset: number; hasMore: boolean; loading: boolean }>({ items: [], offset: 0, hasMore: false, loading: true });
  // A local filter lets familiar conversation names be selected without typing an id.
  const [filter, setFilter] = useState('');
  // Request failures keep the user's choices and the same idempotency key available for retry.
  const [activity, setActivity] = useState({ restoring: true, submitting: false, error: '' });
  const pending = useRef<{ fingerprint: string; id: string } | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void contextTransferApi.latest(source.sessionId, controller.signal).then(value => {
      if (!controller.signal.aborted && value && (ACTIVE.has(value.status) || value.status === 'failed')) setRequest(value);
    }).catch(error => { if (!controller.signal.aborted) setActivity(previous => ({ ...previous, error: String(error.message) })); })
      .finally(() => { if (!controller.signal.aborted) setActivity(previous => ({ ...previous, restoring: false })); });
    return () => { mounted.current = false; controller.abort(); };
  }, [source.sessionId]);

  useEffect(() => {
    let active = true;
    void api.recentConversations({ limit: 100 }).then(async response => {
      if (!response.ok) throw new Error('接收会话读取失败，请重新打开面板。');
      const data = (await response.json()).data as { conversations: Recipient[]; hasMore: boolean };
      if (active) setRecipients({ items: data.conversations, offset: data.conversations.length, hasMore: data.hasMore, loading: false });
    }).catch(error => { if (active) { setRecipients(previous => ({ ...previous, loading: false })); setActivity(previous => ({ ...previous, error: String(error.message) })); } });
    return () => { active = false; };
  }, []);

  const requestId = request?.id;
  const requestStatus = request?.status;
  const requestActive = request && ACTIVE.has(request.status);
  useEffect(() => {
    if (requestStatus && ['analyzing', 'ready', 'completed', 'failed'].includes(requestStatus)) onSourceActivity?.(source.sessionId);
  }, [requestStatus, source.sessionId, onSourceActivity]);
  useEffect(() => {
    if (!requestId || !requestActive) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const value = await contextTransferApi.read(requestId, controller.signal); if (!controller.signal.aborted) { setRequest(value); setActivity(previous => ({ ...previous, error: '' })); } }
      catch (error) { if (!controller.signal.aborted) setActivity(previous => ({ ...previous, error: error instanceof Error ? error.message : String(error) })); }
      if (!controller.signal.aborted) timer = setTimeout(poll, 1500);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [requestId, requestActive]);

  const control = async (operation: 'cancel' | 'retry') => {
    setActivity(previous => ({ ...previous, submitting: true, error: '' }));
    try { const value = await contextTransferApi[operation](request!.id); if (mounted.current) setRequest(value); }
    catch (error) { if (mounted.current) setActivity(previous => ({ ...previous, error: error instanceof Error ? error.message : String(error) })); }
    finally { if (mounted.current) setActivity(previous => ({ ...previous, submitting: false })); }
  };
  const target = recipients.items.find(item => item.sessionId === form.targetId);
  const selectedProvider = form.targetKind === 'new' ? form.provider : target?.provider;
  const openSession = (id: string) => { onClose(); onNavigate(id); };

  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent data-context-transfer aria-label="传递会话上下文" className="max-h-[90dvh] w-[calc(100%_-_24px)] max-w-xl overflow-y-auto p-5">
    <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">{source.command === 'handoff' ? '交接任务' : '传递上下文'}</h2><button type="button" onClick={onClose} aria-label="关闭上下文传递" className="rounded p-1 text-muted-foreground"><X size={18} /></button></div>
    <p className="mt-1 truncate text-xs text-muted-foreground" title={source.title}>来源：{source.title} · {source.provider}</p>
    {request ? <div className="mt-5 space-y-4">
      <p className="flex items-center gap-2 text-sm font-medium" role="status">{requestActive && <Loader2 size={16} className="animate-spin" />}{LABELS[request.status]}</p>
      <p className="text-sm text-muted-foreground">{request.status === 'completed' ? request.input.mode === 'attach' ? '接收会话将在下一轮读取这份上下文。' : '接收 agent 已开始处理交接内容。' : requestActive ? '可以关闭面板继续使用 Orbit；再次输入 /context 或 /handoff 可查看进度。' : request.error || '可以调整选项，重新发起传递。'}</p>
      {requestActive && <button type="button" className="text-xs text-primary underline" onClick={() => openSession(source.sessionId)}>查看原会话的整理进度与工具确认</button>}
      {request.package && <details className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm">查看上下文摘要</summary><pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words font-sans text-xs leading-relaxed">{request.package.text}</pre></details>}
      <div className="flex flex-wrap gap-3">
        {request.targetSessionId && <button type="button" className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground" onClick={() => openSession(request.targetSessionId!)}>打开接收会话<ArrowRight size={15} /></button>}
        {request.status === 'failed' && <button type="button" disabled={activity.submitting} className="rounded-lg border border-border px-4 py-2 text-sm" onClick={() => void control('retry')}>重试传递</button>}
        {['queued', 'preparing', 'analyzing', 'ready'].includes(request.status) && <button type="button" disabled={activity.submitting} className="rounded-lg border border-border px-4 py-2 text-sm" onClick={() => void control('cancel')}>取消传递</button>}
        {!requestActive && <button type="button" className="rounded-lg border border-border px-4 py-2 text-sm" onClick={() => { setRequest(null); pending.current = null; }}>发起新的传递</button>}
      </div>
    </div> : <form className="mt-5 space-y-4" onSubmit={async event => {
      event.preventDefault();
      if (activity.restoring || activity.submitting) return;
      const fingerprint = JSON.stringify(form);
      if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, id: createClientRequestId() };
      setActivity(previous => ({ ...previous, submitting: true, error: '' }));
      try {
        const value = await contextTransferApi.create({ sourceSessionId: source.sessionId, requestId: pending.current.id, scope: form.scope, granularity: form.granularity,
          mode: form.mode, instruction: form.instruction, sourceModel: source.model || undefined, sourceEffort: source.effort || undefined, permissionMode: source.permissionMode,
          target: form.targetKind === 'new' ? { kind: 'new', provider: form.provider, model: form.model, effort: form.effort } : { kind: 'existing', sessionId: form.targetId } });
        if (mounted.current) setRequest(value);
      } catch (error) { if (mounted.current) setActivity(previous => ({ ...previous, error: error instanceof Error ? error.message : String(error) })); }
      finally { if (mounted.current) setActivity(previous => ({ ...previous, submitting: false })); }
    }}>
      <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1"><span className="text-xs text-muted-foreground">话题范围</span><select aria-label="话题范围" className={FIELD} value={form.scope} onChange={event => setForm(previous => ({ ...previous, scope: event.target.value as typeof form.scope }))}><option value="recent_topic">近期话题与必要前因</option><option value="all_topics">这个会话的全部话题</option></select></label>
      <label className="space-y-1"><span className="text-xs text-muted-foreground">传递粒度</span><select aria-label="传递粒度" className={FIELD} value={form.granularity} onChange={event => setForm(previous => ({ ...previous, granularity: event.target.value as typeof form.granularity }))}><option value="coarse">粗粒度 · 信息融合</option><option value="fine">细粒度 · 任务交接</option></select></label></div>
      <label className="block space-y-1"><span className="text-xs text-muted-foreground">接收方</span><select aria-label="接收方" className={FIELD} value={form.targetKind} onChange={event => setForm(previous => ({ ...previous, targetKind: event.target.value as typeof form.targetKind, mode: previous.mode === 'steer' ? 'attach' : previous.mode }))}><option value="new">创建新的接收会话</option><option value="existing">已有会话</option></select></label>
      {form.targetKind === 'new' ? <div className="space-y-3 rounded-lg border border-border p-3"><select aria-label="接收 Harness" className={FIELD} value={form.provider} onChange={event => setForm(previous => ({ ...previous, provider: event.target.value as LLMProvider, model: '', effort: 'default' }))}>{['claude', 'codex', 'opencode', 'cursor'].map(provider => <option key={provider} value={provider}>{provider}</option>)}</select>
        <ProviderModelPicker provider={form.provider} model={form.model} effort={form.effort} label="接收模型与推理强度" onChange={(model, effort) => setForm(previous => ({ ...previous, model, effort }))} /></div>
        : <div className="space-y-2"><input aria-label="筛选接收会话" className={FIELD} value={filter} placeholder="按会话或项目名称筛选" onChange={event => setFilter(event.target.value)} /><select aria-label="接收会话" required className={FIELD} value={form.targetId} onChange={event => setForm(previous => ({ ...previous, targetId: event.target.value, mode: previous.mode === 'steer' ? 'attach' : previous.mode }))}><option value="">{recipients.loading ? '读取会话中…' : '选择一个会话'}</option>{recipients.items.filter(item => item.sessionId !== source.sessionId && (item.sessionId === form.targetId || `${item.sessionTitle} ${item.projectDisplayName}`.toLowerCase().includes(filter.toLowerCase()))).map(item => <option key={item.sessionId} value={item.sessionId}>{item.sessionTitle || '未命名会话'} · {item.provider} · {item.projectDisplayName}</option>)}</select>
          {recipients.hasMore && <button type="button" disabled={recipients.loading} className="text-xs text-primary" onClick={async () => {
            setRecipients(previous => ({ ...previous, loading: true }));
            try { const response = await api.recentConversations({ offset: recipients.offset, limit: 100 }); if (!response.ok) throw new Error('读取更多会话失败。'); const data = (await response.json()).data; if (mounted.current) setRecipients(previous => ({ items: [...previous.items, ...data.conversations], offset: previous.offset + data.conversations.length, hasMore: data.hasMore, loading: false })); }
            catch (error) { if (mounted.current) { setRecipients(previous => ({ ...previous, loading: false })); setActivity(previous => ({ ...previous, error: String(error) })); } }
          }}>加载更多会话</button>}</div>}
      <label className="block space-y-1"><span className="text-xs text-muted-foreground">接收方式</span><select aria-label="接收方式" className={FIELD} value={form.mode} onChange={event => setForm(previous => ({ ...previous, mode: event.target.value as typeof form.mode }))}><option value="attach">附到下一轮，继续提问时读取</option><option value="start">开始接手，忙碌时等待空闲</option>{form.targetKind === 'existing' && selectedProvider === 'codex' && <option value="steer">加入正在进行的工作</option>}</select></label>
      <label className="block space-y-1"><span className="text-xs text-muted-foreground">给接收方的说明</span><textarea aria-label="接收说明" required maxLength={16000} rows={3} className={FIELD} value={form.instruction} onChange={event => setForm(previous => ({ ...previous, instruction: event.target.value }))} /></label>
      <p className="text-xs leading-relaxed text-muted-foreground">当前 agent 将使用本会话的模型整理一次上下文。近期话题会包含相关前因与最新决定；接收模型会独立核查并继续处理。</p>
      <button type="submit" disabled={activity.restoring || activity.submitting || (form.targetKind === 'new' ? !form.model : !form.targetId)} className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm text-primary-foreground disabled:opacity-50">{(activity.restoring || activity.submitting) && <Loader2 size={15} className="animate-spin" />}{activity.restoring ? '读取传递状态…' : activity.submitting ? '正在发起…' : '整理并传递'}</button>
    </form>}
    {activity.error && <p role="alert" className="mt-3 text-sm text-red-500">{activity.error}</p>}
  </DialogContent></Dialog>;
}
