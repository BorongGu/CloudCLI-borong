import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import React from 'react';
import { beforeEach, test, vi } from 'vitest';

import type { Project, SessionWithProvider, SidebarProjectListProps } from '@/shared/types';

/**
 * Sidebar markers describe actionable prompts/errors and confirmed background
 * tasks. Recent timestamps alone leave an idle row clear.
 */

const recordedOptionsProps: Record<string, unknown>[] = [];

vi.mock('@/modules/sidebar/SessionOptions', () => ({
  default: (props: Record<string, unknown>) => {
    recordedOptionsProps.push(props);
    return null;
  },
}));

const { default: SidebarSessionItem } = await import('@/modules/sidebar/SidebarSessionItem');

const t = ((key: string) => key) as unknown as SidebarProjectListProps['t'];
const NOW = new Date('2026-08-21T10:00:00.000Z');
const noop = () => {};

const PROJECT = { projectId: 'project-1', name: 'project-1', displayName: 'project one', fullPath: '/tmp/project-1', sessions: [] } as unknown as Project;
// Touched a minute ago: this timestamp alone must leave an idle row clear.
const SESSION = { id: 's1', summary: 'session one', lastActivity: '2026-08-21T09:59:00.000Z', __provider: 'claude' } as unknown as SessionWithProvider;

const renderRow = (state: { isProcessing: boolean; hasBackgroundWork: boolean }) => render(
  React.createElement(SidebarSessionItem, {
    project: PROJECT,
    session: SESSION,
    selectedSession: null,
    needsAttention: false,
    currentTime: NOW,
    isEditing: false,
    renameDraft: '',
    onRenameDraftChange: noop,
    onStartEditingSession: noop,
    onCancelEditingSession: noop,
    onSaveEditingSession: noop,
    onProjectSelect: noop,
    onSessionSelect: noop,
    onDeleteSession: noop,
    t,
    ...state,
  }),
);

beforeEach(() => {
  recordedOptionsProps.length = 0;
});

test('recent activity leaves idle rows clear; confirmed background work receives a terracotta marker', () => {
  const idle = renderRow({ isProcessing: false, hasBackgroundWork: false });
  assert.equal(idle.container.querySelector('[role="status"]'), null);
  idle.unmount();

  const { container } = renderRow({ isProcessing: false, hasBackgroundWork: true });

  const dot = container.querySelector('[role="status"]');
  assert.ok(dot);
  assert.ok(dot.className.includes('bg-primary/80'));
  assert.equal(dot.className.includes('animate-pulse'), false);
  assert.equal(dot.getAttribute('aria-label'), 'tooltips.backgroundWorkIndicator');
  assert.equal(container.querySelectorAll('.animate-spin').length, 0);
  assert.equal(recordedOptionsProps.at(-1)?.isProcessing, false, 'the row is not locked the way a responding one is');
});

test('a response in flight shows the terracotta running marker and spinner', () => {
  const { container } = renderRow({ isProcessing: true, hasBackgroundWork: false });

  const marker = container.querySelector('[role="status"]');assert.ok(marker);
  assert.equal(marker.className.includes('bg-primary/80'), true);
  assert.equal(marker.getAttribute('aria-label'), 'tooltips.processingSessionIndicator');
  assert.equal(container.querySelectorAll('.animate-spin').length, 1);
  assert.equal(recordedOptionsProps[0].isProcessing, true);
});
