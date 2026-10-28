import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowUp, MessageSquare, Square, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';

import { useBtwConversation } from '@/modules/chat/hooks/useBtwConversation';
import { useBtwPanelResize } from '@/modules/chat/hooks/useBtwPanelResize';
import { MarkdownWorkspaceContext } from '@/modules/chat/context/MarkdownWorkspaceContext';
import { Markdown } from '@/modules/chat/transcript/Markdown';
import type { BtwRequest } from '@/shared/types';

type BtwPanelProps = { request: BtwRequest; active?: boolean; onClose(): void };

const RESIZE_HANDLES = [
  { direction: 'n', className: 'inset-x-4 top-0 h-2 cursor-ns-resize' },
  { direction: 's', className: 'inset-x-4 bottom-0 h-2 cursor-ns-resize' },
  { direction: 'w', className: 'inset-y-4 left-0 w-2 cursor-ew-resize' },
  { direction: 'e', className: 'inset-y-4 right-0 w-2 cursor-ew-resize' },
  { direction: 'nw', className: 'left-0 top-0 h-4 w-4 cursor-nwse-resize' },
  { direction: 'ne', className: 'right-0 top-0 h-4 w-4 cursor-nesw-resize' },
  { direction: 'sw', className: 'bottom-0 left-0 h-4 w-4 cursor-nesw-resize' },
  { direction: 'se', className: 'bottom-0 right-0 h-4 w-4 cursor-nwse-resize' },
] as const;

/** ChatInterface keeps one panel per source session, showing the current session's window. */
export function BtwPanel({ request, active = true, onClose }: BtwPanelProps) {
  const { t } = useTranslation('chat');
  const titleId = useId();
  const { messages, ready, busy, busySince, closed, error, label, phase, draft, setDraft, send, stop } = useBtwConversation(request);
  const { panelRef, bounds, startResize, resizeWithKeyboard, clearSavedBounds } = useBtwPanelResize(request.key);
  const markdownWorkspaceValue = useMemo(() => ({ projectId: request.projectId ?? null }), [request.projectId]);
  // Elapsed time distinguishes an active provider request from a frozen panel.
  const [clock, setClock] = useState(Date.now);
  const elapsed = Math.max(0, Math.floor((clock - busySince) / 1000));
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const compositionEndRef = useRef(0);
  const close = () => { clearSavedBounds();onClose(); };
  useEffect(() => { if (active) inputRef.current?.focus(); }, [active]);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => { clearInterval(timer); };
  }, [busy]);
  useEffect(() => {
    if (followRef.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, busy, error, active]);
  const submit = () => {
    if (!draft.trim() || !ready || busy || closed) return;
    if (send(draft.trim())) { setDraft(''); followRef.current = true; }
  };
  // Keeping the component mounted preserves the source's socket while its window is hidden.
  if (!active) return null;
  return createPortal(<MarkdownWorkspaceContext.Provider value={markdownWorkspaceValue}><section ref={panelRef} role="dialog" aria-modal="false" aria-labelledby={titleId} data-btw-panel
    className="fixed right-3 z-[60] flex w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-xl sm:right-6 sm:w-[30rem]"
    style={{ bottom: 'calc(var(--keyboard-height, 0px) + 12px + env(safe-area-inset-bottom, 0px))',
      height: 'min(34rem, 72dvh)', maxHeight: 'calc(100dvh - var(--keyboard-height, 0px) - 2rem)',
      ...(bounds ? { ...bounds, right: 'auto', bottom: 'auto', maxHeight: 'none' } : {}) }}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}>
    <header className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-3">
      <MessageSquare aria-hidden className="h-4 w-4 text-primary/80" />
      <h2 id={titleId} className="text-sm font-medium">{t('btw.title')}</h2>
      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{t('btw.temporary')}</span>
      <button type="button" onClick={close} className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">{t('btw.finish')}</button>
      <button type="button" onClick={close} aria-label={t('btw.close')} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><X className="h-4 w-4" /></button>
    </header>
    <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4"
      onScroll={event => { const node = event.currentTarget; followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48; }}>
      {messages.length === 0 && <p className="text-sm leading-relaxed text-muted-foreground">{ready ? t('btw.empty') : t('btw.connecting')}</p>}
      {messages.map(message => <div key={message.id} data-btw-message={message.role} className={message.role === 'user'
        ? 'ml-8 break-words rounded-xl bg-muted/60 px-3 py-2 text-sm'
        : 'prose prose-sm max-w-none break-words font-serif text-foreground dark:prose-invert'}>
        <Markdown breaks={message.role === 'user'} className={message.role === 'user' ? 'prose prose-sm max-w-none text-foreground dark:prose-invert' : undefined}>{message.content}</Markdown>
      </div>)}
      {busy && <p role="status" title={label} className="flex gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">{phase ? t(`btw.phase.${phase}`) : label || t(ready ? 'btw.working' : 'btw.connecting')}</span>
        <span className="shrink-0 tabular-nums">{elapsed}s</span>
      </p>}
      {error && <p role="alert" className="whitespace-pre-wrap text-xs text-muted-foreground">{error}</p>}
      {closed && <p role="status" className="text-xs text-muted-foreground">{t('btw.ended')}</p>}
    </div>
    <form className="shrink-0 border-t border-border/60 p-3" onSubmit={event => { event.preventDefault(); submit(); }}>
      <textarea ref={inputRef} value={draft} onChange={event => setDraft(event.target.value)} rows={2} maxLength={32000}
        disabled={closed} aria-label={t('btw.input')} placeholder={t('btw.placeholder')}
        className="block max-h-28 w-full resize-none rounded-lg border border-border bg-muted/20 px-3 py-2 text-base leading-relaxed outline-none focus:border-primary/50 sm:text-sm"
        onCompositionEnd={() => { compositionEndRef.current = Date.now(); }}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing
            && event.keyCode !== 229 && Date.now() - compositionEndRef.current > 30) { event.preventDefault(); submit(); }
        }} />
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="truncate text-[11px] text-muted-foreground">{request.model}</span>
        {busy && ready ? <button type="button" onClick={stop} className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted">
          <Square className="h-3 w-3" />{t('btw.stop')}
        </button> : <button type="submit" disabled={!draft.trim() || !ready || busy || closed} aria-label={t('btw.send')}
          className="rounded-lg bg-primary px-3 py-1.5 text-primary-foreground disabled:opacity-40"><ArrowUp className="h-4 w-4" /></button>}
      </div>
    </form>
    <span aria-hidden className="pointer-events-none absolute bottom-1.5 right-1.5 h-2 w-2 rounded-br-sm border-b border-r border-muted-foreground/40" />
    {RESIZE_HANDLES.map(({ direction, className }) => <button key={direction} type="button" data-btw-resize={direction}
      aria-label={t('btw.resize', { direction: t(`btw.resizeDirection.${direction}`) })}
      title={t('btw.resize', { direction: t(`btw.resizeDirection.${direction}`) })}
      className={`absolute z-10 touch-none select-none bg-transparent p-0 focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary/50 ${className}`}
      onPointerDown={event => startResize(event, direction)}
      onKeyDown={event => { if (resizeWithKeyboard(event.key, direction, event.shiftKey)) { event.preventDefault(); event.stopPropagation(); } }} />)}
  </section></MarkdownWorkspaceContext.Provider>, document.body);
}
