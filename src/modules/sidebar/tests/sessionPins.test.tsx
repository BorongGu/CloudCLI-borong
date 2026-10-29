import assert from 'node:assert/strict';

import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import type { TFunction } from 'i18next';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { SessionPinsProvider, useSessionPins } from '@/modules/sidebar/context/SessionPinsContext';
import SessionOptions from '@/modules/sidebar/SessionOptions';
import SidebarProjectSessions from '@/modules/sidebar/SidebarProjectSessions';
import type { RecentConversationListItem } from '@/shared/types';

const calls = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn() }));
vi.mock('@/shared/api', () => ({ api: { user: { sessionPins: calls.read, setSessionPin: calls.save } } }));
vi.mock('@/shared/hooks/useProviderCapabilities', () => ({ useSessionForkingProviders: () => new Set() }));
vi.mock('@/modules/sidebar/hooks/useProviderSessionIdCopy', () => ({ useProviderSessionIdCopy: () => ({ copyState: 'idle', copyLabel: 'Copy', setOptionsOpen() {}, handleCopyAction() {}, isCopyPending: false, CopyStateIcon: () => null }) }));

const row = (sessionId: string): RecentConversationListItem => ({ sessionId, provider: 'codex', projectId: 'project', projectDisplayName: 'Project', sessionTitle: sessionId, lastActivity: null });
const response = (...ids: string[]) => ({ ok: true, json: async () => ({ sessions: ids.map(row) }) });
const wrapper = ({ children }: { children: ReactNode }) => <SessionPinsProvider>{children}</SessionPinsProvider>;
const noop = () => {};
const listProps: ComponentProps<typeof SidebarProjectSessions> = {
  project: { projectId: 'project', displayName: 'Project', fullPath: '/repo' },
  isExpanded: true,
  sessions: ['first-session', 'running-session', 'last-session'].map(id => ({ id, summary: id, __provider: 'codex' })),
  selectedSession: null,
  initialSessionsLoaded: true,
  hasMoreSessions: false,
  isLoadingMoreSessions: false,
  activeSessions: new Set(['running-session']),
  backgroundSessionIds: new Set(),
  attentionSessionIds: new Set(),
  currentTime: new Date('2026-10-29T08:00:00.000Z'),
  sessionRenameId: null,
  sessionRenameDraft: '',
  onRenameDraftChange: noop,
  onStartEditingSession: noop,
  onCancelEditingSession: noop,
  onSaveEditingSession: noop,
  onProjectSelect: noop,
  onSessionSelect: noop,
  onDeleteSession: noop,
  onLoadMoreSessions: noop,
  onNewSession: noop,
  t: ((key: string) => key) as TFunction,
};
const listedSessions = (container: HTMLElement) => [...container.querySelectorAll('a.sidebar-session-row')].map(link => link.getAttribute('href'));
beforeEach(() => { calls.read.mockReset().mockResolvedValue(response());calls.save.mockReset(); });
afterEach(cleanup);

test('pins load independently of sidebar pagination and refresh when another device changes them', async () => {
  calls.read.mockResolvedValueOnce(response('old-session')).mockResolvedValueOnce(response('phone-pin', 'old-session'));
  const { result } = renderHook(() => useSessionPins(), { wrapper });
  await waitFor(() => assert.equal(result.current?.conversations[0]?.sessionId, 'old-session'));
  act(() => { window.dispatchEvent(new Event('focus')); });
  await waitFor(() => assert.deepEqual(result.current?.conversations.map(row => row.sessionId), ['phone-pin', 'old-session']));
});

test('a slow initial read cannot erase a newly confirmed pin', async () => {
  let resolveRead!: (value: ReturnType<typeof response>) => void;
  calls.read.mockReturnValueOnce(new Promise(resolve => { resolveRead = resolve; }));
  calls.save.mockResolvedValue(response('new-pin'));
  const { result } = renderHook(() => useSessionPins(), { wrapper });
  act(() => { result.current!.setPinned('new-pin', true); });
  await waitFor(() => assert.equal(result.current?.pinnedIds.has('new-pin'), true));
  await act(async () => { resolveRead(response()); });
  assert.equal(result.current?.pinnedIds.has('new-pin'), true);
});

test('quick edits serialize and a failed save retains the confirmed list', async () => {
  calls.read.mockResolvedValue(response('existing'));
  let resolveSave!: (value: ReturnType<typeof response>) => void;
  calls.save.mockReturnValueOnce(new Promise(resolve => { resolveSave = resolve; })).mockResolvedValueOnce(response('second', 'first', 'existing'));
  const { result } = renderHook(() => useSessionPins(), { wrapper });
  await waitFor(() => assert.equal(result.current?.pinnedIds.has('existing'), true));
  act(() => { result.current!.setPinned('first', true);result.current!.setPinned('second', true);result.current!.setPinned('first', true); });
  await waitFor(() => assert.equal(calls.save.mock.calls.length, 1));
  assert.equal(result.current?.pendingIds.size, 2);
  await act(async () => { resolveSave(response('first', 'existing')); });
  await waitFor(() => assert.equal(result.current?.pendingIds.size, 0));
  assert.deepEqual(calls.save.mock.calls, [['first', true], ['second', true]]);
  calls.save.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'unavailable' }) });
  act(() => { result.current!.setPinned('second', false); });
  await waitFor(() => assert.equal(result.current?.error, 'save'));
  assert.equal(result.current?.pinnedIds.has('second'), true);
});

test('pinning moves a running session out of the project list and unpinning restores its original order', async () => {
  calls.save.mockResolvedValueOnce(response('running-session')).mockResolvedValueOnce(response());
  const labels: Record<string, string> = { 'pins.pin': 'Pin session', 'pins.unpin': 'Unpin session' };
  const view = render(<><SidebarProjectSessions {...listProps} /><SessionOptions sessionId="running-session" sessionName="Running session" provider="codex" projectId="project"
    isProcessing isEditing={false} renameDraft="" onRenameDraftChange={() => {}} onStartEditingSession={() => {}}
    onCancelEditingSession={() => {}} onSaveEditingSession={() => {}} onDeleteSession={() => {}}
    t={((key: string) => labels[key] || key) as TFunction} /></>, { wrapper });
  assert.deepEqual(listedSessions(view.container), ['/session/first-session', '/session/running-session', '/session/last-session']);
  fireEvent.click(view.getByRole('button', { name: 'Session options for Running session' }));
  fireEvent.click(view.getByRole('menuitem', { name: 'Pin session' }));
  await waitFor(() => assert.equal(calls.save.mock.calls.length, 1));
  await waitFor(() => assert.deepEqual(listedSessions(view.container), ['/session/first-session', '/session/last-session']));
  fireEvent.click(view.getByRole('button', { name: 'Session options for Running session' }));
  const unpin = await view.findByRole('menuitem', { name: 'Unpin session' });fireEvent.click(unpin);
  await waitFor(() => assert.deepEqual(calls.save.mock.calls, [['running-session', true], ['running-session', false]]));
  await waitFor(() => assert.deepEqual(listedSessions(view.container), ['/session/first-session', '/session/running-session', '/session/last-session']));
});

test('a page containing only pins keeps pagination, while running and search views retain matching sessions', async () => {
  calls.read.mockResolvedValue(response('first-session', 'running-session', 'last-session'));
  const onLoadMoreSessions = vi.fn();
  const view = render(<SidebarProjectSessions {...listProps} hasMoreSessions onLoadMoreSessions={onLoadMoreSessions} />, { wrapper });
  await waitFor(() => assert.equal(listedSessions(view.container).length, 0));
  assert.equal(view.queryByText('sessions.noSessions'), null);
  fireEvent.click(view.getByRole('button', { name: 'Load more sessions' }));
  assert.deepEqual(onLoadMoreSessions.mock.calls, [['project']]);
  view.rerender(<SidebarProjectSessions {...listProps} hidePinnedSessions={false} />);
  assert.equal(listedSessions(view.container).length, 3);
});
