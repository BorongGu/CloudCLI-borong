import type { Quota, State, Window } from './types.js';

/** Normalizes the Go usage endpoint; incomplete responses remain unknown. */
export function parseQuota(value: unknown, now: number): Quota | null {
  const usage = (value as { usage?: Record<string, unknown> } | null)?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const windows: Window[] = [];
  for (const name of ['rolling', 'weekly', 'monthly']) {
    const raw = usage[name] as { percent?: unknown; status?: unknown; resetsAt?: unknown } | undefined;
    if (!raw || typeof raw.percent !== 'number' || !Number.isFinite(raw.percent) || raw.percent < 0) return null;
    const reset = typeof raw.resetsAt === 'string' ? Date.parse(raw.resetsAt) : NaN;
    windows.push({ percent: raw.percent, status: typeof raw.status === 'string' ? raw.status : 'unknown', resetsAt: Number.isFinite(reset) ? reset : null });
  }
  return { checkedAt: now, rolling: windows[0], weekly: windows[1], monthly: windows[2] };
}

/** All exhausted windows must recover; the latest reset therefore governs. */
export function quotaBlockedUntil(quota: Quota | undefined, now: number): number {
  if (!quota) return 0;
  return Math.max(0, ...[quota.rolling, quota.weekly, quota.monthly].map(window => {
    if (window.percent < 100 && !/rate.?limited|exhausted|blocked|limit.?reached/i.test(window.status)) return 0;
    if (window.resetsAt !== null) return window.resetsAt > now ? window.resetsAt : 0;
    return quota.checkedAt + 60_000 > now ? quota.checkedAt + 60_000 : 0;
  }));
}

export function blockedUntil(state: State, id: string, model: string, now: number): number {
  const blocks = state.blocks[id] || {};
  return Math.max(quotaBlockedUntil(state.quotas[id], now), blocks['*']?.until || 0, blocks[model]?.until || 0);
}

/** Retry-After supports seconds or an HTTP date, independently of the quota API. */
export function retryAt(value: string | null, now: number): number {
  if (!value) return now + 60_000;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return now + Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) && date > now ? date : now + 60_000;
}
