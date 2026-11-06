import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import { ContextTransferDialog } from '@/modules/context-transfer/ContextTransferDialog';
import { api, contextTransferApi } from '@/shared/api';
import type { ContextTransferCommand, ContextTransferRequest } from '@/shared/types';

vi.mock('@/shared/api', () => ({ api: { recentConversations: vi.fn(), providers: { models: vi.fn() } }, contextTransferApi: { latest: vi.fn(), create: vi.fn(), read: vi.fn(), cancel: vi.fn(), retry: vi.fn() } }));
const source: ContextTransferCommand = { sessionId: 'source', title: '缓存设计', provider: 'codex', model: 'source-model', effort: 'high', permissionMode: 'default', command: 'handoff', instruction: '' };
const result = (status: ContextTransferRequest['status'] = 'completed'): ContextTransferRequest => ({ id: 'request', input: { sourceSessionId: 'source', requestId: 'request-id', scope: 'recent_topic', granularity: 'fine', mode: 'start', instruction: 'Continue.', permissionMode: 'default', target: { kind: 'new', provider: 'claude', model: 'claude-model' } }, status, targetSessionId: status === 'completed' ? 'recipient' : null, packageId: null, error: null });
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(contextTransferApi.latest).mockResolvedValue(null);
  vi.mocked(contextTransferApi.create).mockResolvedValue(result());
  vi.mocked(contextTransferApi.read).mockResolvedValue(result('analyzing'));
  vi.mocked(contextTransferApi.cancel).mockResolvedValue(result('cancelled'));
  vi.mocked(api.providers.models).mockImplementation(async provider => new Response(JSON.stringify({ success: true, data: { models: { DEFAULT: `${provider}-model`, OPTIONS: [{ value: `${provider}-model`, label: `${provider} Frontier` }] } } })));
  vi.mocked(api.recentConversations).mockResolvedValue(new Response(JSON.stringify({ data: { conversations: [
    { sessionId: 'source', sessionTitle: '当前源会话', provider: 'codex', projectDisplayName: 'Workspace' },
    { sessionId: 'existing', sessionTitle: '缓存审查', provider: 'opencode', projectDisplayName: 'Workspace' },
  ], hasMore: false } })));
});

it('submits all four independent choices through the model picker and opens the resulting session', async () => {
  const navigate = vi.fn(); render(<ContextTransferDialog source={source} onClose={() => {}} onNavigate={navigate} />);
  fireEvent.change(screen.getByLabelText('话题范围'), { target: { value: 'all_topics' } });
  fireEvent.change(screen.getByLabelText('接收 Harness'), { target: { value: 'claude' } });
  await waitFor(() => expect(screen.getByRole('button', { name: '接收模型与推理强度' }).textContent).toContain('claude Frontier'));
  expect(contextTransferApi.create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '整理并传递' }));
  await screen.findByText('上下文已交付');
  expect(contextTransferApi.create).toHaveBeenCalledWith(expect.objectContaining({ sourceSessionId: 'source', sourceModel: 'source-model', sourceEffort: 'high', scope: 'all_topics', granularity: 'fine', mode: 'start', target: { kind: 'new', provider: 'claude', model: 'claude-model', effort: 'default' } }));
  fireEvent.click(screen.getByRole('button', { name: '打开接收会话' })); expect(navigate).toHaveBeenCalledWith('recipient');
});

it('defaults /context to coarse next-turn input and selects an existing conversation by title', async () => {
  render(<ContextTransferDialog source={{ ...source, command: 'context', instruction: '融合这些结论' }} onClose={() => {}} onNavigate={() => {}} />);
  fireEvent.change(screen.getByLabelText('接收方'), { target: { value: 'existing' } });
  await screen.findByRole('option', { name: '缓存审查 · opencode · Workspace' });
  expect(screen.queryByRole('option', { name: /当前源会话/ })).toBeNull();
  fireEvent.change(screen.getByLabelText('接收会话'), { target: { value: 'existing' } });
  fireEvent.click(screen.getByRole('button', { name: '整理并传递' }));
  await waitFor(() => expect(contextTransferApi.create).toHaveBeenCalledWith(expect.objectContaining({ scope: 'recent_topic', granularity: 'coarse', mode: 'attach', instruction: '融合这些结论', target: { kind: 'existing', sessionId: 'existing' } })));
});

it('retains choices and idempotency key when creating a request fails', async () => {
  vi.mocked(contextTransferApi.create).mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValueOnce(result());
  render(<ContextTransferDialog source={source} onClose={() => {}} onNavigate={() => {}} />);
  await waitFor(() => expect((screen.getByRole('button', { name: '整理并传递' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '整理并传递' })); await screen.findByText('Connection lost');
  fireEvent.click(screen.getByRole('button', { name: '整理并传递' })); await screen.findByText('上下文已交付');
  expect(vi.mocked(contextTransferApi.create).mock.calls[0]).toEqual(vi.mocked(contextTransferApi.create).mock.calls[1]);
});

it('restores pending work after reopening, observes the source stream and cancels without creating a second request', async () => {
  vi.mocked(contextTransferApi.latest).mockResolvedValue(result('queued'));
  const observe = vi.fn(); render(<ContextTransferDialog source={source} onClose={() => {}} onNavigate={() => {}} onSourceActivity={observe} />);
  await screen.findByText('当前 agent 正在整理上下文');
  expect(observe).toHaveBeenCalledWith('source'); expect(contextTransferApi.create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '取消传递' })); await screen.findByText('已取消传递');
  expect(contextTransferApi.cancel).toHaveBeenCalledWith('request');
});
