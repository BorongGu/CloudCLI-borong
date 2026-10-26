import { useEffect, useId, useRef, useState } from 'react';
import { ArrowUp, MessageSquare, Square, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';

import { useBtwConversation } from '@/modules/chat/hooks/useBtwConversation';
import { Markdown } from '@/modules/chat/transcript/Markdown';
import type { BtwRequest } from '@/shared/types';

type BtwPanelProps = { request: BtwRequest; onClose(): void };

/** ChatInterface opens this smaller nonmodal window for temporary Codex side questions. */
export function BtwPanel({ request, onClose }: BtwPanelProps) {
  const { t } = useTranslation('chat');
  const titleId = useId();
  const { messages, ready, busy, closed, error, label, send, stop } = useBtwConversation(request);
  // Keep the next side question editable while a reply streams above it.
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const compositionEndRef = useRef(0);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    if (followRef.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, busy, error]);
  const submit = () => {
    if (!draft.trim() || !ready || busy || closed) return;
    if (send(draft.trim())) { setDraft(''); followRef.current = true; }
  };
  return createPortal(<section role="dialog" aria-modal="false" aria-labelledby={titleId} data-btw-panel
    className="fixed right-3 z-[60] flex w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-xl sm:right-6 sm:w-[30rem]"
    style={{ bottom: 'calc(var(--keyboard-height, 0px) + 12px + env(safe-area-inset-bottom, 0px))',
      height: 'min(34rem, 72dvh)', maxHeight: 'calc(100dvh - var(--keyboard-height, 0px) - 2rem)' }}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
    <header className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-3">
      <MessageSquare aria-hidden className="h-4 w-4 text-primary/80" />
      <h2 id={titleId} className="text-sm font-medium">{t('btw.title')}</h2>
      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{t('btw.temporary')}</span>
      <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">{t('btw.finish')}</button>
      <button type="button" onClick={onClose} aria-label={t('btw.close')} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><X className="h-4 w-4" /></button>
    </header>
    <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4"
      onScroll={event => { const node = event.currentTarget; followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48; }}>
      {messages.length === 0 && <p className="text-sm leading-relaxed text-muted-foreground">{ready ? t('btw.empty') : t('btw.connecting')}</p>}
      {messages.map(message => <div key={message.id} data-btw-message={message.role} className={message.role === 'user'
        ? 'ml-8 whitespace-pre-wrap break-words rounded-xl bg-muted/60 px-3 py-2 text-sm'
        : 'prose prose-sm max-w-none break-words font-serif text-foreground dark:prose-invert'}>
        {message.role === 'assistant' ? <Markdown>{message.content}</Markdown> : message.content}
      </div>)}
      {busy && <p role="status" className="truncate text-xs text-muted-foreground">{label || t(ready ? 'btw.working' : 'btw.connecting')}</p>}
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
  </section>, document.body);
}
