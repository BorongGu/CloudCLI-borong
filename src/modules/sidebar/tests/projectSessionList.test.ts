import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project, SessionWithProvider, SidebarProjectListProps } from '@/shared/types';

const getArchivedSessions = vi.fn();
const recentConversations = vi.fn();
const alertMock = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    archivedProjects: () => Promise.resolve({ ok: true, json: async () => ({ data: { projects: [] } }) }),
    getArchivedSessions: () => getArchivedSessions(),
    recentConversations: () => recentConversations(),
    migrateLegacyProjectStars: () => Promise.resolve({ ok: true, json: async () => ({}) }),
  },
}));

vi.mock('@/modules/sidebar/SessionOptions', () => ({ default: () => null }));

const { default: SidebarProjectSessions } = await import('@/modules/sidebar/SidebarProjectSessions');
const { useSidebarController } = await import('@/modules/sidebar/hooks/useSidebarController');

const NOW = new Date('2026-08-21T10:00:00.000Z');
const noop = () => {};

// Keys come back with their interpolation options appended (`key:count=2,total=3`),
// so a label or a message can be asserted together with the numbers it was given.
const t = ((key: string, options?: unknown) =>
  options && typeof options === 'object'
    ? `${key}:${Object.entries(options).map(([name, value]) => `${name}=${String(value)}`).join(',')}`
    : key) as unknown as SidebarProjectListProps['t'];

const PROJECT = {
  projectId: 'project-1',
  name: 'project-1',
  displayName: 'project one',
  fullPath: '/repo',
  sessions: [],
} as unknown as Project;

const session = (id: string): SessionWithProvider =>
  ({ id, summary: `session ${id}`, lastActivity: '2026-08-21T09:59:00.000Z', __provider: 'claude' }) as unknown as SessionWithProvider;

const SESSIONS = [session('s1'), session('s2'), session('s3')];
// Held outside the hook call: `projects` is an effect dependency in the
// controller, so rebuilding the array per render would re-run those effects
// forever instead of testing anything.
const PROJECTS = [PROJECT];

const NO_IDS: ReadonlySet<string> = new Set<string>();

type ListOverrides = {
  sessions?: SessionWithProvider[];
  activeSessions?: ReadonlySet<string>;
  hasMoreSessions?: boolean;
  onLoadMoreSessions?: (projectId: string) => void;
};

const renderSessions = (overrides: ListOverrides = {}) =>
  render(
    React.createElement(SidebarProjectSessions, {
      project: PROJECT,
      isExpanded: true,
      sessions: SESSIONS,
      selectedSession: null,
      initialSessionsLoaded: true,
      hasMoreSessions: false,
      isLoadingMoreSessions: false,
      activeSessions: NO_IDS,
      backgroundSessionIds: NO_IDS,
      attentionSessionIds: NO_IDS,
      currentTime: NOW,
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
      t,
      ...overrides,
    }),
  );

const buttonWithText = (container: HTMLElement, text: string): HTMLButtonElement | null =>
  [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === text) ?? null;

const jsonResponse = (data: unknown) => Promise.resolve({ ok: true, json: async () => ({ data }) });

beforeEach(() => {
  localStorage.clear();
  getArchivedSessions.mockReset();
  getArchivedSessions.mockImplementation(() => jsonResponse({ sessions: [] }));
  recentConversations.mockReset();
  recentConversations.mockImplementation(() => jsonResponse({ conversations: [], total: 0, hasMore: false }));
  alertMock.mockReset();
  vi.stubGlobal('alert', alertMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('an empty loaded page keeps access to remaining sessions', () => {
  const onLoadMoreSessions = vi.fn();
  const emptied = renderSessions({ sessions: [], hasMoreSessions: true, onLoadMoreSessions });

  assert.equal(
    emptied.container.textContent?.includes('sessions.noSessions'),
    false,
    'the server still has sessions, so the list must not say there are none',
  );
  const loadMore = buttonWithText(emptied.container, 'Load more sessions');
  assert.ok(loadMore, 'the rest of the sessions stay reachable without a refresh');
  fireEvent.click(loadMore);
  assert.deepEqual(onLoadMoreSessions.mock.calls, [['project-1']]);
  emptied.unmount();

  const reallyEmpty = renderSessions({ sessions: [], hasMoreSessions: false });
  assert.equal(reallyEmpty.container.textContent?.includes('sessions.noSessions'), true);
  assert.equal(buttonWithText(reallyEmpty.container, 'Load more sessions'), null);
});

type SessionActivity = {
  selectedProject?: Project | null;
  keepProjectsExpanded?: boolean;
  activeSessions: ReadonlySet<string>;
  backgroundSessionIds: ReadonlySet<string>;
};

const IDLE: SessionActivity = { activeSessions: NO_IDS, backgroundSessionIds: NO_IDS };

const renderController = (onSessionDelete = vi.fn(), initialActivity: SessionActivity = IDLE) =>
  renderHook(
    ({ activeSessions, backgroundSessionIds, keepProjectsExpanded, selectedProject = null }: SessionActivity) =>
      useSidebarController({
        projects: PROJECTS,
        selectedProject,
        selectedSession: null,
        activeSessions,
        backgroundSessionIds,
        isLoading: false,
        isMobile: false,
        t,
        onRefresh: noop,
        onProjectSelect: noop,
        onSessionSelect: noop,
        onSessionDelete,
        onLoadMoreSessions: noop,
        onProjectDelete: noop,
        setCurrentProject: noop,
        setSidebarVisible: noop,
        sidebarVisible: true,
        keepProjectsExpanded,
      }),
    { initialProps: initialActivity },
  );

test('project expansion remains an accordion by default', () => {
  const { result } = renderController();
  act(() => result.current.toggleProject('project-1'));
  act(() => result.current.toggleProject('project-2'));
  assert.equal(result.current.isProjectExpanded('project-1'), false);
  assert.equal(result.current.isProjectExpanded('project-2'), true);
});

test('opt-in multi-open groups survive reloads and toggle independently', () => {
  const first = renderController(vi.fn(), { ...IDLE, keepProjectsExpanded: true });
  act(() => first.result.current.toggleProject('project-1'));
  act(() => first.result.current.toggleProject('project-2'));
  assert.equal(first.result.current.isProjectExpanded('project-1'), true);
  assert.equal(first.result.current.isProjectExpanded('project-2'), true);
  first.unmount();
  const restored = renderController(vi.fn(), { ...IDLE, keepProjectsExpanded: true });
  assert.equal(restored.result.current.isProjectExpanded('project-1'), true);
  assert.equal(restored.result.current.isProjectExpanded('project-2'), true);
  act(() => restored.result.current.toggleProject('project-1'));
  assert.equal(restored.result.current.isProjectExpanded('project-1'), false);
  assert.equal(restored.result.current.isProjectExpanded('project-2'), true);
});

test('hydrating the preference restores groups before writing browser storage', () => {
  localStorage.setItem('cloudcli-expanded-projects', JSON.stringify(['saved-1', 'saved-2']));
  const controller = renderController();
  controller.rerender({ ...IDLE, keepProjectsExpanded: true });
  assert.equal(controller.result.current.isProjectExpanded('saved-1'), true);
  assert.equal(controller.result.current.isProjectExpanded('saved-2'), true);
  controller.rerender({ ...IDLE, keepProjectsExpanded: false });
  assert.equal(controller.result.current.isProjectExpanded('saved-2'), false);
  assert.deepEqual(JSON.parse(localStorage.getItem('cloudcli-expanded-projects')!), ['saved-1', 'saved-2']);
});

test('invalid saved expansion data does not break navigation', () => {
  localStorage.setItem('cloudcli-expanded-projects', 'invalid JSON');
  const { result } = renderController(vi.fn(), { ...IDLE, keepProjectsExpanded: true });
  act(() => result.current.toggleProject('project-1'));
  assert.equal(result.current.isProjectExpanded('project-1'), true);
});

test('only string project IDs are restored from browser storage', () => {
  localStorage.setItem('cloudcli-expanded-projects', JSON.stringify(['saved-1', 5, null, {}, 'saved-2']));
  const { result } = renderController(vi.fn(), { ...IDLE, keepProjectsExpanded: true });
  assert.equal(result.current.isProjectExpanded('saved-1'), true);
  assert.equal(result.current.isProjectExpanded('saved-2'), true);
  assert.deepEqual(JSON.parse(localStorage.getItem('cloudcli-expanded-projects')!), ['saved-1', 'saved-2']);
});


test('unavailable browser storage does not prevent opening projects', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage disabled'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage disabled'); });
  const { result } = renderController(vi.fn(), { ...IDLE, keepProjectsExpanded: true });
  act(() => result.current.toggleProject('project-1'));
  act(() => result.current.toggleProject('project-2'));
  assert.equal(result.current.isProjectExpanded('project-1'), true);
  assert.equal(result.current.isProjectExpanded('project-2'), true);
});

test('Running groups keep their independent collapse state in multi-open mode', () => {
  const { result } = renderController(vi.fn(), { ...IDLE, keepProjectsExpanded: true });
  act(() => result.current.toggleProject('project-1'));
  act(() => result.current.setSearchMode('running'));
  assert.equal(result.current.isProjectExpanded('project-1'), true);
  act(() => result.current.toggleProject('project-1'));
  assert.equal(result.current.isProjectExpanded('project-1'), false);
  act(() => result.current.setSearchMode('projects'));
  assert.equal(result.current.isProjectExpanded('project-1'), true);
});


test('a selected project intentionally collapsed before reload stays collapsed', () => {
  localStorage.setItem('cloudcli-expanded-projects', JSON.stringify(['other-project']));
  const controller = renderController(vi.fn(), { ...IDLE, keepProjectsExpanded: true, selectedProject: PROJECT });
  assert.equal(controller.result.current.isProjectExpanded(PROJECT.projectId), false);
  assert.equal(controller.result.current.isProjectExpanded('other-project'), true);
  assert.deepEqual(JSON.parse(localStorage.getItem('cloudcli-expanded-projects')!), ['other-project']);
  controller.rerender({ ...IDLE, keepProjectsExpanded: true, selectedProject: { ...PROJECT, projectId: 'new-selection' } });
  assert.equal(controller.result.current.isProjectExpanded('new-selection'), true);
});

test('an empty saved set also preserves a collapsed selection restored after mount', () => {
  localStorage.setItem('cloudcli-expanded-projects', '[]');
  const controller = renderController(vi.fn(), { ...IDLE, keepProjectsExpanded: true });
  controller.rerender({ ...IDLE, keepProjectsExpanded: true, selectedProject: PROJECT });
  assert.equal(controller.result.current.isProjectExpanded(PROJECT.projectId), false);
  assert.equal(localStorage.getItem('cloudcli-expanded-projects'), '[]');
});

test('without saved expansion, initial project selection still opens normally', () => {
  const controller = renderController(vi.fn(), { ...IDLE, keepProjectsExpanded: true, selectedProject: PROJECT });
  assert.equal(controller.result.current.isProjectExpanded(PROJECT.projectId), true);
});
