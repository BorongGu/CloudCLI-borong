import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, it, vi } from 'vitest';

import TokenUsageSummary from '@/modules/chat/composer/TokenUsageSummary';
import { api } from '@/shared/api';
import type { ProviderUsageSnapshot } from '@/shared/types';

vi.mock('@/shared/api', () => ({ api: { providers: { usage: vi.fn() } } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => `${key}${values ? ' ' + Object.values(values).join(' ') : ''}` }) }));

const data: ProviderUsageSnapshot = {
  context: { used: 96_000, limit: 475_000, model: 'gpt-6.1-sol', updatedAt: '2026-10-26T03:00:00Z' },
  fetchedAt: '2026-10-26T03:00:00Z',
  accounts: [
    { id: 'codex', provider: 'codex', label: 'Codex', plan: 'prolite', enabled: true, active: true, status: 'ok', checkedAt: '2026-10-26T03:00:00Z', error: null,
      windows: [{ id: 'codex:primary', usedPercent: 11, windowMinutes: 10080, resetsAt: '2026-11-01T00:00:00Z' }] },
    { id: 'go:one', provider: 'opencode', label: '我的账号', plan: 'Go', enabled: true, active: false, status: 'ok', checkedAt: '2026-10-26T03:00:00Z', error: null,
      windows: [{ id: 'monthly', usedPercent: 55, windowMinutes: 43200, resetsAt: '2026-11-09T00:00:00Z' }] },
  ],
};
const response = (payload: ProviderUsageSnapshot) => ({ ok: true, json: async () => ({ data: payload }) }) as Response;

beforeEach(() => { vi.mocked(api.providers.usage).mockReset(); vi.mocked(api.providers.usage).mockResolvedValue(response(data)); });

describe('context and subscription usage', () => {
  it('shows context capacity separately from cumulative session tokens and both subscription quotas', async () => {
    render(<TokenUsageSummary usage={{ used: 286_000_000 }} provider="codex" sessionId="chat" model="gpt-6.1-sol" />);
    const context = screen.getByRole('button', { name: 'usage.contextTrigger' });
    await waitFor(() => assert.match(context.textContent || '', /96K.*475K/));
    assert.doesNotMatch(context.textContent || '', /286M/);
    fireEvent.click(screen.getByRole('button', { name: 'usage.trigger' }));
    const dialog = screen.getByRole('dialog', { name: 'usage.heading' });
    assert.match(dialog.textContent || '', /Pro Lite/);
    assert.match(dialog.textContent || '', /OpenCode Go · 我的账号/);
    assert.match(dialog.textContent || '', /89%/);
    assert.match(dialog.textContent || '', /45%/);
    assert.match(dialog.textContent || '', /286M/);
    assert.ok(screen.getByRole('progressbar', { name: 'usage.context' }));
    assert.match(screen.getByRole('button', { name: 'usage.trigger' }).textContent || '', /usage.remaining 89%/);
    assert.equal(screen.getByRole('progressbar', { name: 'Codex usage.weekly' }).getAttribute('aria-valuenow'), '89');
    assert.equal(screen.getByRole('progressbar', { name: '我的账号 usage.monthly' }).getAttribute('aria-valuenow'), '45');
  });

  it('clears the prior context immediately on a session switch and ignores its late response', async () => {
    let resolveOld!: (response: Response) => void;
    vi.mocked(api.providers.usage).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    const view = render(<TokenUsageSummary usage={null} provider="codex" sessionId="old" />);
    view.rerender(<TokenUsageSummary usage={null} provider="opencode" sessionId="new" />);
    await waitFor(() => assert.equal(vi.mocked(api.providers.usage).mock.calls.length, 2));
    await act(async () => { resolveOld(response({ ...data, context: { ...data.context, used: 200_000 } })); });
    const context = screen.getByRole('button', { name: 'usage.contextTrigger' });
    await waitFor(() => assert.match(context.textContent || '', /96K/));
    assert.doesNotMatch(context.textContent || '', /200K/);
  });

  it('keeps reported values when a manual refresh fails and offers a retry', async () => {
    render(<TokenUsageSummary usage={null} provider="codex" sessionId="chat" />);
    await waitFor(() => assert.match(screen.getByRole('button', { name: 'usage.contextTrigger' }).textContent || '', /96K/));
    fireEvent.click(screen.getByRole('button', { name: 'usage.trigger' }));
    vi.mocked(api.providers.usage).mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(screen.getByRole('button', { name: 'usage.refresh' }));
    await screen.findByText('usage.unavailable');
    assert.match(screen.getByRole('dialog').textContent || '', /45%/);
    assert.equal(vi.mocked(api.providers.usage).mock.lastCall?.[0].refresh, 1);
  });

  it('renders unknown context and missing quota values as pending', async () => {
    vi.mocked(api.providers.usage).mockResolvedValue(response({ ...data, context: { used: null, limit: null, model: null, updatedAt: null }, accounts: [] }));
    render(<TokenUsageSummary usage={{ used: 100_000_000 }} provider="codex" />);
    fireEvent.click(screen.getByRole('button', { name: 'usage.trigger' }));
    await screen.findByText('usage.pendingContext');
    assert.match(screen.getByRole('button', { name: 'usage.contextTrigger' }).textContent || '', /—.*—/);
    assert.equal(screen.getByRole('progressbar', { name: 'usage.context' }).getAttribute('aria-valuenow'), null);
  });
});
