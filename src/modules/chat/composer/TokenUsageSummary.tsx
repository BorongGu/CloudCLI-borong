import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ActivityIcon, Gauge, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useComposerMenuAnchor } from '@/modules/chat/hooks/useComposerMenuAnchor';
import { api } from '@/shared/api';
import type { LLMProvider, ProviderUsageSnapshot, ProviderUsageWindow } from '@/shared/types';

type TokenUsageSummaryProps = {
  usage: Record<string, unknown> | null;
  onClick?: () => void;
  provider?: LLMProvider;
  sessionId?: string | null;
  model?: string;
};

const formatTokenCount = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}K`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
};

/** ChatComposer uses this compact context readout and subscription panel on phones and desktops. */
function TokenUsageSummary({ usage, onClick, provider, sessionId, model }: TokenUsageSummaryProps) {
  const { t } = useTranslation('chat');
  const key = `${provider}:${sessionId || ''}:${model || ''}`;
  // Keep each response attached to its session/model so a late request cannot paint another conversation's context.
  const [snapshot, setSnapshot] = useState<{ key: string; data: ProviderUsageSnapshot | null; loading: boolean; error: boolean }>({ key, data: null, loading: false, error: false });
  // The panel's open state is independent of typing in the composer.
  const [isOpen, setIsOpen] = useState(false);
  // Cancel superseded polls and release the request when switching sessions or unmounting.
  const requestRef = useRef<AbortController | null>(null);
  const close = useCallback(() => setIsOpen(false), []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close, 360);

  const refresh = useCallback(async (force = false) => {
    if (provider !== 'codex' && provider !== 'opencode') return;
    requestRef.current?.abort();
    const controller = new AbortController(); requestRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 12_000);
    setSnapshot(previous => ({ key, data: previous.key === key ? previous.data : null, loading: true, error: false }));
    try {
      const response = await api.providers.usage({ provider, sessionId: sessionId || undefined, model, ...(force ? { refresh: 1 } : {}) }, { signal: controller.signal });
      if (!response.ok) throw new Error('usage_unavailable');
      const body = await response.json();
      if (requestRef.current === controller) setSnapshot({ key, data: body.data, loading: false, error: false });
    } catch {
      if (requestRef.current === controller) setSnapshot(previous => ({ key, data: previous.key === key ? previous.data : null, loading: false, error: true }));
    } finally { window.clearTimeout(timeout); }
  }, [key, model, provider, sessionId]);

  useEffect(() => {
    if (provider !== 'codex' && provider !== 'opencode') return;
    const poll = () => { if (document.visibilityState !== 'hidden') void refresh(); };
    poll();
    const interval = window.setInterval(poll, 30_000);
    document.addEventListener('visibilitychange', poll);
    return () => { window.clearInterval(interval); document.removeEventListener('visibilitychange', poll); requestRef.current?.abort(); requestRef.current = null; };
  }, [provider, refresh, usage?.used]);

  const data = snapshot.key === key ? snapshot.data : null;
  const used = data?.context.used ?? null;
  const limit = data?.context.limit ?? null;
  const percent = used !== null && limit ? used / limit * 100 : null;
  const activeAccount = data?.accounts.find(account => account.active)
    || data?.accounts.find(account => account.provider === provider);
  const primary = activeAccount?.windows[0];
  const windowLabel = (window: ProviderUsageWindow) => {
    const minutes = window.windowMinutes;
    if (minutes === 43200) return t('usage.monthly');
    if (minutes === 10080) return t('usage.weekly');
    if (minutes !== null && minutes >= 60) return t('usage.hours', { count: Math.round(minutes / 60 * 10) / 10 });
    if (minutes !== null) return t('usage.minutes', { count: minutes });
    return t('usage.quota');
  };
  const number = (value: number) => `${Math.round(value * 10) / 10}%`;
  const remaining = (window: ProviderUsageWindow) => Math.max(0, Math.min(100, 100 - window.usedPercent));
  const date = (value: string) => new Date(value).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const toggle = () => { updateAnchor(); setIsOpen(current => !current); };
  const planLabel = (plan: string) => ({ prolite: 'Pro Lite', pro: 'Pro', plus: 'Plus', team: 'Team', business: 'Business', enterprise: 'Enterprise', free: 'Free' }[plan] || plan);
  const buttonClass = 'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border/70 bg-background/70 px-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/25 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:px-2';

  // Other composer consumers can still open the existing cumulative token details.
  if (provider !== 'codex' && provider !== 'opencode') {
    const cumulative = Number(usage?.used) || 0;
    return <button type="button" onClick={onClick} className={buttonClass} aria-label={t('misc.showTokenUsage')}><ActivityIcon className="h-3.5 w-3.5 text-primary" /><span>{formatTokenCount(cumulative)}</span><span className="hidden sm:inline">tokens</span></button>;
  }

  return (
    <>
      <button type="button" onClick={toggle} className={buttonClass} aria-label={t('usage.contextTrigger')} aria-haspopup="dialog" aria-expanded={isOpen} title={percent === null ? t('usage.pendingContext') : `${t('usage.context')} ${number(percent)}`}>
        <ActivityIcon className="h-3.5 w-3.5 text-primary" />
        <span className="hidden text-[10px] text-muted-foreground md:inline">Ctx</span>
        <span className="whitespace-nowrap font-medium text-foreground">{used === null ? '—' : formatTokenCount(used)}<span className="px-0.5 text-muted-foreground/50">/</span>{limit ? formatTokenCount(limit) : '—'}</span>
      </button>
      <button ref={triggerRef} type="button" onClick={toggle} className={buttonClass} aria-label={t('usage.trigger')} aria-haspopup="dialog" aria-expanded={isOpen}>
        <Gauge className="h-3.5 w-3.5 text-primary" />
        <span className="hidden md:inline">{t('usage.quota')}</span>
        {primary && <span className="whitespace-nowrap text-foreground">{windowLabel(primary)} {t('usage.remaining', { percent: number(remaining(primary)) })}</span>}
      </button>
      {isOpen && anchor && createPortal(
        <div ref={menuRef} role="dialog" aria-label={t('usage.heading')} className="fixed z-[100] overflow-y-auto overscroll-contain rounded-xl border border-border bg-popover p-4 text-sm text-popover-foreground shadow-xl" style={{ ...anchor, right: Math.min(anchor.right, Math.max(8, window.innerWidth - 368)), maxWidth: 'calc(100vw - 16px)', width: 360 }}>
          <div className="mb-3 flex items-center justify-between gap-3">
            <span className="font-medium">{t('usage.heading')}</span>
            <button type="button" disabled={snapshot.loading} onClick={() => void refresh(true)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary disabled:opacity-50" aria-label={t('usage.refresh')}><RefreshCw className={`h-3 w-3 ${snapshot.loading ? 'animate-spin' : ''}`} />{t('usage.refresh')}</button>
          </div>
          <section className="rounded-lg border border-border/60 bg-muted/20 p-3" aria-label={t('usage.context')}>
            <div className="flex items-center justify-between text-xs"><span>{t('usage.context')}</span><span className="font-medium text-primary">{percent === null ? '—' : number(percent)}</span></div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={t('usage.context')} aria-valuenow={percent === null ? undefined : Math.min(100, percent)} aria-valuemin={0} aria-valuemax={100}><div className="h-full rounded-full bg-primary/75 transition-all" style={{ width: `${Math.min(100, percent ?? 0)}%` }} /></div>
            <p className="mt-2 text-xs text-muted-foreground">{used === null ? t('usage.pendingContext') : `${formatTokenCount(used)} / ${limit ? formatTokenCount(limit) : '—'} tokens`}</p>
            {data?.context.model && <p className="mt-1 break-all text-[11px] text-muted-foreground/70">{data.context.model}</p>}
            <button type="button" onClick={() => { close(); onClick?.(); }} className="mt-2 text-[11px] text-muted-foreground underline underline-offset-2 hover:text-primary">{t('usage.sessionTokens')}{usage?.used != null ? ` · ${formatTokenCount(Number(usage.used))}` : ''}</button>
          </section>
          {(data?.accounts || []).map(account => (
            <section key={account.id} className="mt-4" aria-label={`${account.provider === 'codex' ? 'Codex' : 'OpenCode Go'} ${account.label}`}>
              <div className="flex items-center gap-2 text-xs font-medium"><span>{account.provider === 'codex' ? 'Codex' : `OpenCode Go · ${account.label}`}</span>{account.plan && <span className="font-normal text-muted-foreground">{planLabel(account.plan)}</span>}{account.active && <span className="ml-auto rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">{t('usage.current')}</span>}{!account.enabled && <span className="text-muted-foreground">{t('usage.disabled')}</span>}</div>
              {account.windows.map(window => <div key={window.id} className="mt-2.5">
                <div className="flex justify-between gap-2 text-[11px]"><span className="text-muted-foreground">{window.label ? `${window.label} · ` : ''}{windowLabel(window)}</span><span>{t('usage.remaining', { percent: number(remaining(window)) })}</span></div>
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={`${account.label} ${windowLabel(window)}`} aria-valuenow={remaining(window)} aria-valuetext={t('usage.remaining', { percent: number(remaining(window)) })} aria-valuemin={0} aria-valuemax={100}><div className="h-full rounded-full bg-primary/70" style={{ width: `${remaining(window)}%` }} /></div>
                {window.resetsAt && <p className="mt-1 text-[10px] text-muted-foreground/70">{t('usage.resets', { date: date(window.resetsAt) })}</p>}
              </div>)}
              {account.status !== 'ok' && <p className="mt-2 text-[11px] text-muted-foreground">{t(`usage.${account.status === 'stale' ? 'stale' : account.error === 'not_configured' ? 'notConfigured' : account.error === 'api_key' ? 'apiKey' : 'unavailable'}`)}</p>}
              {account.checkedAt && <p className="mt-2 text-[10px] text-muted-foreground/60">{t('usage.updated', { date: date(account.checkedAt) })}</p>}
            </section>
          ))}
          {snapshot.loading && !data && <p className="mt-3 text-xs text-muted-foreground">{t('usage.loading')}</p>}
          {snapshot.error && <p className="mt-3 text-xs text-muted-foreground">{t('usage.unavailable')}</p>}
        </div>, document.body,
      )}
    </>
  );
}

export default memo(TokenUsageSummary);
