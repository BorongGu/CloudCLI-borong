import { useCallback, useEffect, useRef, useState } from 'react';
import { Gauge, RefreshCw } from 'lucide-react';

import { api } from '@/shared/api';
import type { ProviderUsageAccount } from '@/shared/types';
import { SubscriptionUsageAccounts } from '@/shared/ui/SubscriptionUsageAccounts';

/** GroupsPage keeps all connected subscriptions visible independently of group membership. */
export function GroupSubscriptionUsage() {
  // Retain the latest successful account readings while a refresh is pending or fails.
  const [state, setState] = useState<{ accounts: ProviderUsageAccount[]; loading: boolean; error: boolean }>({ accounts: [], loading: true, error: false });
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(async (force = false) => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 12_000);
    setState(previous => ({ ...previous, loading: true, error: false }));
    try {
      const response = await api.providers.usage(force ? { refresh: 1 } : {}, { signal: controller.signal });
      if (!response.ok) throw new Error('usage_unavailable');
      const body = await response.json();
      if (request.current === controller) setState({ accounts: body.data.accounts, loading: false, error: false });
    } catch {
      if (request.current === controller) setState(previous => ({ ...previous, loading: false, error: true }));
    } finally { window.clearTimeout(timeout); }
  }, []);
  useEffect(() => {
    const poll = () => { if (document.visibilityState !== 'hidden') void refresh(); };
    poll();
    const timer = window.setInterval(poll, 30_000);
    document.addEventListener('visibilitychange', poll);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', poll); request.current?.abort(); request.current = null; };
  }, [refresh]);
  const accounts = state.accounts.filter(account => account.error !== 'not_configured').map(account => ({ ...account, active: false }));
  return <details className="shrink-0 border-b border-border bg-muted/10 px-4 py-2" aria-label="订阅额度">
    <summary className="cursor-pointer text-xs marker:text-muted-foreground"><span className="inline-flex items-center gap-1.5 align-middle"><Gauge size={14} />订阅额度</span>
      {accounts.map(account => <span key={account.id} className="ml-3 inline-block py-1 align-middle text-muted-foreground">{account.provider === 'codex' ? 'Codex' : `Go · ${account.label}`} · {account.windows.length ? `最低剩余 ${Math.round(Math.max(0, Math.min(...account.windows.map(window => 100 - window.usedPercent))))}%` : '待获取'}{account.status === 'stale' ? '（缓存）' : ''}{!account.enabled ? '（已停用）' : ''}</span>)}
      {state.loading && !accounts.length && <span className="ml-3 text-muted-foreground">正在获取…</span>}
      {state.error && <span className="ml-3 text-amber-600">刷新失败，可展开重试</span>}
    </summary>
    <div className="flex justify-end py-2"><button type="button" onClick={() => void refresh(true)} disabled={state.loading} className="flex items-center gap-1 text-xs text-muted-foreground disabled:opacity-50" aria-label="刷新订阅额度"><RefreshCw size={12} className={state.loading ? 'animate-spin' : ''} />刷新</button></div>
    <div className="grid max-h-[40vh] gap-5 overflow-y-auto pb-3 sm:grid-cols-2 lg:grid-cols-3"><SubscriptionUsageAccounts accounts={accounts} />{!accounts.length && !state.loading && <p className="text-xs text-muted-foreground">暂无可显示的订阅额度。</p>}</div>
  </details>;
}
