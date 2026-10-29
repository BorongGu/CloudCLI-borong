import assert from 'node:assert/strict';

import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { TFunction } from 'i18next';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { SessionPinsProvider, useSessionPins } from '@/modules/sidebar/context/SessionPinsContext';
import SessionOptions from '@/modules/sidebar/SessionOptions';
import type { RecentConversationListItem } from '@/shared/types';

const calls = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn() }));
vi.mock('@/shared/api', () => ({ api: { user: { sessionPins: calls.read, setSessionPin: calls.save } } }));
vi.mock('@/shared/hooks/useProviderCapabilities', () => ({ useSessionForkingProviders: () => new Set() }));
vi.mock('@/modules/sidebar/hooks/useProviderSessionIdCopy', () => ({ useProviderSessionIdCopy: () => ({ copyState: 'idle', copyLabel: 'Copy', setOptionsOpen() {}, handleCopyAction() {}, isCopyPending: false, CopyStateIcon: () => null }) }));

const row = (sessionId: string): RecentConversationListItem => ({ sessionId, provider: 'codex', projectId: 'project', projectDisplayName: 'Project', sessionTitle: sessionId, lastActivity: null });
const response = (...ids: string[]) => ({ ok: true, json: async () => ({ sessions: ids.map(row) }) });
const wrapper = ({ children }: { children: ReactNode }) => <SessionPinsProvider>{children}</SessionPinsProvider>;
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

test('a running session menu can pin and unpin with the shared account state', async () => {
  calls.save.mockResolvedValueOnce(response('running-session')).mockResolvedValueOnce(response());
  const labels: Record<string, string> = { 'pins.pin': 'Pin session', 'pins.unpin': 'Unpin session' };
  const view = render(<SessionOptions sessionId="running-session" sessionName="Running session" provider="codex" projectId="project"
    isProcessing isEditing={false} renameDraft="" onRenameDraftChange={() => {}} onStartEditingSession={() => {}}
    onCancelEditingSession={() => {}} onSaveEditingSession={() => {}} onDeleteSession={() => {}}
    t={((key: string) => labels[key] || key) as TFunction} />, { wrapper });
  fireEvent.click(view.getByRole('button', { name: 'Session options for Running session' }));
  fireEvent.click(view.getByRole('menuitem', { name: 'Pin session' }));
  await waitFor(() => assert.equal(calls.save.mock.calls.length, 1));
  fireEvent.click(view.getByRole('button', { name: 'Session options for Running session' }));
  const unpin = await view.findByRole('menuitem', { name: 'Unpin session' });fireEvent.click(unpin);
  await waitFor(() => assert.deepEqual(calls.save.mock.calls, [['running-session', true], ['running-session', false]]));
});
