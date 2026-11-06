import { useTranslation } from 'react-i18next';

import type { ProviderUsageAccount } from '@/shared/types';

/** Chat and Groups render the same account windows, reset times and freshness indicators. */
export function SubscriptionUsageAccounts({ accounts }: { accounts: ProviderUsageAccount[] }) {
  const { t } = useTranslation('chat');
  const date = (value: string) => new Date(value).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const planLabel = (plan: string) => ({ prolite: 'Pro Lite', pro: 'Pro', plus: 'Plus', team: 'Team', business: 'Business', enterprise: 'Enterprise', free: 'Free' }[plan] || plan);
  const windowLabel = (minutes: number | null) => minutes === 43200 ? t('usage.monthly') : minutes === 10080 ? t('usage.weekly')
    : minutes !== null && minutes >= 60 ? t('usage.hours', { count: Math.round(minutes / 60 * 10) / 10 })
      : minutes !== null ? t('usage.minutes', { count: minutes }) : t('usage.quota');
  return <>{accounts.map(account => <section key={account.id} className="min-w-0" aria-label={`${account.provider === 'codex' ? 'Codex' : 'OpenCode Go'} ${account.label}`}>
    <div className="flex flex-wrap items-center gap-2 text-xs font-medium"><span>{account.provider === 'codex' ? 'Codex' : `OpenCode Go · ${account.label}`}</span>{account.plan && <span className="font-normal text-muted-foreground">{planLabel(account.plan)}</span>}{account.active && <span className="ml-auto rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">{t('usage.current')}</span>}{!account.enabled && <span className="text-muted-foreground">{t('usage.disabled')}</span>}</div>
    {account.windows.map(window => {
      const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent));
      const label = windowLabel(window.windowMinutes);
      const value = t('usage.remaining', { percent: `${Math.round(remaining * 10) / 10}%` });
      return <div key={window.id} className="mt-2.5">
        <div className="flex justify-between gap-2 text-[11px]"><span className="text-muted-foreground">{window.label ? `${window.label} · ` : ''}{label}</span><span>{value}</span></div>
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={`${account.label} ${label}`} aria-valuenow={remaining} aria-valuetext={value} aria-valuemin={0} aria-valuemax={100}><div className="h-full rounded-full bg-primary/70" style={{ width: `${remaining}%` }} /></div>
        {window.resetsAt && <p className="mt-1 text-[10px] text-muted-foreground/70">{t('usage.resets', { date: date(window.resetsAt) })}</p>}
      </div>;
    })}
    {account.status !== 'ok' && <p className="mt-2 text-[11px] text-muted-foreground">{t(`usage.${account.status === 'stale' ? 'stale' : account.error === 'not_configured' ? 'notConfigured' : account.error === 'api_key' ? 'apiKey' : 'unavailable'}`)}</p>}
    {account.checkedAt && <p className="mt-2 text-[10px] text-muted-foreground/60">{t('usage.updated', { date: date(account.checkedAt) })}</p>}
  </section>)}</>;
}
