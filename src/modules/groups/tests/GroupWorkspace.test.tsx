import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api, groupsApi } from '@/shared/api';
import type { OrbitGroupSnapshot } from '@/shared/types';
import { GroupWorkspace } from '@/modules/groups/GroupWorkspace';
import { CreateGroupForm } from '@/modules/groups/CreateGroupForm';

vi.mock('@/shared/api', () => ({ api: { providers: { models: vi.fn() } }, groupsApi: { post: vi.fn(), dispatch: vi.fn(), control: vi.fn(), create: vi.fn(), updateMember: vi.fn() } }));

function snapshot(): OrbitGroupSnapshot {
  return {
    group: { id: 'group', name: 'Design together', projectPath: '/workspace', paused: false, turnsRemaining: 12, createdAt: '' },
    members: [
      { id: 'a', name: 'A', provider: 'claude', sessionId: 'session-a', model: null, busy: false, permissionMode: 'default' },
      { id: 'b', name: 'B', provider: 'codex', sessionId: 'session-b', model: null, busy: false, permissionMode: 'default' },
      { id: 'c', name: 'C', provider: 'opencode', sessionId: 'session-c', model: null, busy: false, permissionMode: 'default' },
    ], messages: [], publications: [], deliveries: [],
  };
}

beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.providers.models).mockImplementation(async () => new Response(JSON.stringify({ success: true, data: { models: { DEFAULT: 'model-a', OPTIONS: [{ value: 'model-a', label: 'Model A', effort: { values: [{ value: 'high' }] } }, { value: 'model-b', label: 'Model B' }] } } }))); vi.mocked(groupsApi.updateMember).mockResolvedValue(snapshot()); });

describe('group primitives', () => {
  it('dispatches one task with custom notes for all three members', async () => {
    vi.mocked(groupsApi.dispatch).mockResolvedValue({ id: 'task' } as never);
    render(<MemoryRouter><GroupWorkspace snapshot={snapshot()} refresh={async () => {}} /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('内容'), { target: { value: 'Read this paper together' } });
    fireEvent.change(screen.getByLabelText('给 A 的补充说明'), { target: { value: 'Explain the key idea' } });
    fireEvent.change(screen.getByLabelText('给 B 的补充说明'), { target: { value: 'Look for implementation implications' } });
    fireEvent.change(screen.getByLabelText('给 C 的补充说明'), { target: { value: 'Suggest related ideas' } });
    fireEvent.click(screen.getByRole('button', { name: '派发给全体成员' }));
    await waitFor(() => expect(groupsApi.dispatch).toHaveBeenCalledOnce());
    expect(vi.mocked(groupsApi.dispatch).mock.calls[0]).toEqual(['group', expect.objectContaining({ content: 'Read this paper together', assignments: {
      a: 'Explain the key idea', b: 'Look for implementation implications', c: 'Suggest related ideas',
    }, turns: 20, requestId: expect.any(String) })]);
  });

  it('retains the draft and idempotency key when an HTTP send fails', async () => {
    vi.mocked(groupsApi.post).mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValueOnce({ id: 'sent' } as never);
    render(<MemoryRouter><GroupWorkspace snapshot={snapshot()} refresh={async () => {}} /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('操作'), { target: { value: 'request' } });
    fireEvent.change(screen.getByLabelText('期待回复'), { target: { value: 'b' } });
    fireEvent.change(screen.getByLabelText('内容'), { target: { value: 'Can you explain this result?' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByText('Connection lost');
    expect((screen.getByLabelText('内容') as HTMLTextAreaElement).value).toBe('Can you explain this result?');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(groupsApi.post).toHaveBeenCalledTimes(2));
    expect(vi.mocked(groupsApi.post).mock.calls[0]).toEqual(vi.mocked(groupsApi.post).mock.calls[1]);
    expect(vi.mocked(groupsApi.post).mock.calls[0][1]).toMatchObject({ kind: 'request', to: 'b' });
  });

  it('publishes a titled item and displays durable public information separately', async () => {
    vi.mocked(groupsApi.post).mockResolvedValue({ id: 'published' } as never);
    const state = snapshot();
    state.publications = [{ id: 'public', seq: 1, senderId: 'a', recipientId: null, kind: 'publish', title: 'A useful finding', content: 'Evidence to reuse', replyTo: null, assignments: {}, mentions: [], createdAt: '' }];
    render(<MemoryRouter><GroupWorkspace snapshot={state} refresh={async () => {}} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: '关键结论发布 · 1' }));
    expect(screen.getByText('Evidence to reuse')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('操作'), { target: { value: 'publish' } });
    fireEvent.change(screen.getByLabelText('结论标题'), { target: { value: 'Updated context' } });
    fireEvent.change(screen.getByLabelText('内容'), { target: { value: 'The shared interface is ready' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(groupsApi.post).toHaveBeenCalledOnce());
    expect(vi.mocked(groupsApi.post).mock.calls[0][1]).toMatchObject({ kind: 'publish', title: 'Updated context' });
    expect(vi.mocked(groupsApi.post).mock.calls[0][1].to).toBeUndefined();
  });

  it('creates configurable peers without making a model call or imposing role fields', async () => {
    const onCreate = vi.fn();
    vi.mocked(groupsApi.create).mockResolvedValue(snapshot());
    render(<CreateGroupForm onCreate={onCreate} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('小组名称'), { target: { value: 'Paper club' } });
    fireEvent.change(screen.getByLabelText('工作目录'), { target: { value: '/workspace' } });
    fireEvent.change(screen.getByLabelText('成员 3 Harness'), { target: { value: 'cursor' } });
    fireEvent.click(screen.getByRole('button', { name: '创建小组' }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
    expect(vi.mocked(groupsApi.create).mock.calls[0][0].members.map(member => member.provider)).toEqual(['claude', 'codex', 'cursor']);
    expect(groupsApi.dispatch).not.toHaveBeenCalled();
  });

  it('chooses catalog models through the normal model menu and keeps member links inside Groups', async () => {
    vi.mocked(groupsApi.create).mockResolvedValue(snapshot());
    const view = render(<CreateGroupForm onCreate={() => {}} onCancel={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '成员 1 模型与推理强度' }).textContent).toContain('Model A'));
    fireEvent.click(screen.getByRole('button', { name: '成员 1 模型与推理强度' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Model A' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Model B' }));
    fireEvent.change(screen.getByLabelText('小组名称'), { target: { value: 'Model selection' } });
    fireEvent.change(screen.getByLabelText('工作目录'), { target: { value: '/workspace' } });
    fireEvent.click(screen.getByRole('button', { name: '创建小组' }));
    await waitFor(() => expect(groupsApi.create).toHaveBeenCalledOnce());
    expect(vi.mocked(groupsApi.create).mock.calls[0][0].members[0]).toMatchObject({ model: 'model-b', effort: 'default' });
    view.unmount();
    render(<MemoryRouter><GroupWorkspace snapshot={snapshot()} refresh={async () => {}} /></MemoryRouter>);
    expect(screen.getByRole('link', { name: /A.*claude/ }).getAttribute('href')).toBe('/groups/group/members/a');
  });

  it('highlights questions for the user and replies in the public discussion', async () => {
    vi.mocked(groupsApi.post).mockResolvedValue({ id: 'reply' } as never);
    const state = snapshot();
    state.pendingReplies = [{ messageId: 'question', memberId: 'user', senderId: 'a', content: 'Which scope should we use?' }];
    render(<MemoryRouter><GroupWorkspace snapshot={state} refresh={async () => {}} /></MemoryRouter>);
    expect(screen.getByText('需要你回应 · 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /A：.*Which scope should we use/ }));
    fireEvent.change(screen.getByLabelText('内容'), { target: { value: 'Use the smaller scope' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(groupsApi.post).toHaveBeenCalledOnce());
    expect(vi.mocked(groupsApi.post).mock.calls[0][1]).toMatchObject({ kind: 'reply', replyTo: 'question', content: 'Use the smaller scope' });
  });
});
