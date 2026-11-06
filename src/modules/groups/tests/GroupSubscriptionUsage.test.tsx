import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import { GroupSubscriptionUsage } from '@/modules/groups/GroupSubscriptionUsage';
import { api } from '@/shared/api';
import type { ProviderUsageAccount } from '@/shared/types';

vi.mock('@/shared/api', () => ({ api: { providers: { usage: vi.fn() } } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => `${key}${values ? ' ' + Object.values(values).join(' ') : ''}` }) }));
const accounts: ProviderUsageAccount[] = [
  { id: 'codex', provider: 'codex', label: 'Codex', plan: 'pro', enabled: true, active: false, status: 'ok', checkedAt: '2026-11-06T10:00:00Z', error: null, windows: [{ id: 'weekly', usedPercent: 20, windowMinutes: 10080, resetsAt: '2026-11-08T10:00:00Z' }] },
  ...['one', 'two'].map(id => ({ id, provider: 'opencode' as const, label: id, plan: 'Go', enabled: true, active: false, status: 'ok' as const, checkedAt: '2026-11-06T10:00:00Z', error: null, windows: [{ id: 'monthly', usedPercent: 55, windowMinutes: 43200, resetsAt: null }] })),
];
beforeEach(() => { vi.mocked(api.providers.usage).mockReset().mockResolvedValue({ ok: true, json: async () => ({ data: { accounts } }) } as Response); });

it('loads every subscription independently of group members and preserves readings after a failed refresh', async () => {
  render(<GroupSubscriptionUsage />);
  await screen.findByText('Go · two · 最低剩余 45%');
  expect(api.providers.usage).toHaveBeenCalledWith({}, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  fireEvent.click(screen.getByText('订阅额度'));
  expect(screen.getAllByRole('progressbar')).toHaveLength(3);
  expect(screen.getByRole('progressbar', { name: 'Codex usage.weekly' }).getAttribute('aria-valuenow')).toBe('80');
  vi.mocked(api.providers.usage).mockRejectedValueOnce(new Error('offline'));
  fireEvent.click(screen.getByRole('button', { name: '刷新订阅额度' }));
  await screen.findByText('刷新失败，可展开重试');
  expect(screen.getByText('Go · two · 最低剩余 45%')).toBeTruthy();
  expect(vi.mocked(api.providers.usage).mock.lastCall?.[0]).toEqual({ refresh: 1 });
});

it('releases pending polls on unmount', async () => {
  let finish!: (value: Response) => void;
  vi.mocked(api.providers.usage).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<GroupSubscriptionUsage />);
  await waitFor(() => expect(api.providers.usage).toHaveBeenCalledOnce());
  const signal = vi.mocked(api.providers.usage).mock.calls[0][1]?.signal;
  view.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => finish({ ok: true, json: async () => ({ data: { accounts } }) } as Response));
});
