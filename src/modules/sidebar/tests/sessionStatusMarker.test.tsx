import assert from 'node:assert/strict';

import { act, render } from '@testing-library/react';
import { beforeEach, test } from 'vitest';
import type { TFunction } from 'i18next';

import { SidebarSessionStatus } from '@/modules/sidebar/SidebarSessionStatus';
import { observeSessionCompletion } from '@/shared/utils';

beforeEach(() => { localStorage.clear(); });
const props = { sessionId: 'marker-session', isProcessing: false, hasBackgroundWork: false, needsAttention: false, isSelected: false,
  t: ((key: string) => key) as TFunction };

test('a successful reply produces a small check that switches back to a running dot on the next task', () => {
  const view = render(<SidebarSessionStatus {...props} />);assert.equal(view.queryByRole('status'), null);
  act(() => { observeSessionCompletion({ sessionId: props.sessionId, kind: 'stream_delta', content: 'Final output' });
    observeSessionCompletion({ sessionId: props.sessionId, kind: 'complete', success: true }); });
  assert.equal(view.getByRole('status').dataset.sessionStatus, 'completed');assert.ok(view.getByRole('status').querySelector('.lucide-check'));
  view.rerender(<SidebarSessionStatus {...props} isProcessing />);
  assert.equal(view.getByRole('status').dataset.sessionStatus, 'running');
  assert.equal(view.getByRole('status').className.includes('bg-primary/80'), true);
});

test('an unanswered prompt uses an outlined reminder while a selected session shows its running state', () => {
  const view = render(<SidebarSessionStatus {...props} needsAttention isProcessing />);
  assert.equal(view.getByRole('status').dataset.sessionStatus, 'attention');
  view.rerender(<SidebarSessionStatus {...props} needsAttention isProcessing isSelected />);
  assert.equal(view.getByRole('status').dataset.sessionStatus, 'running');
});
