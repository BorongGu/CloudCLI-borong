import { afterEach, describe, expect, it } from 'vitest';

import { captureChatScrollAnchor, restoreChatScrollAnchor } from '@/shared/utils';

function viewport() {
  const container = document.createElement('div');
  const row = document.createElement('div');
  row.dataset.messageTimestamp = '2026-11-06T00:00:00Z';
  container.append(row);
  document.body.append(container);
  let rowTop = 500;
  container.scrollTop = 520;
  Object.defineProperty(container, 'scrollHeight', { get: () => rowTop + 2000 });
  container.getBoundingClientRect = () => ({ top: 0, bottom: 600 }) as DOMRect;
  row.getBoundingClientRect = () => ({ top: rowTop - container.scrollTop, bottom: rowTop + 800 - container.scrollTop }) as DOMRect;
  return { container, moveRow: (delta: number) => { rowTop += delta; } };
}

afterEach(() => { document.body.innerHTML = ''; });

describe('chat layout compensation during touch inertia', () => {
  it('keeps native touch movement when the content geometry stays unchanged', () => {
    const { container } = viewport();
    const anchor = captureChatScrollAnchor(container);
    container.scrollTop -= 12.5;
    restoreChatScrollAnchor(container, anchor, true);
    expect(container.scrollTop).toBe(507.5);
  });

  it('adds only the layout shift while the reader keeps moving in either direction', () => {
    for (const movement of [-14.25, 18.5]) {
      const { container, moveRow } = viewport();
      const anchor = captureChatScrollAnchor(container);
      container.scrollTop += movement;
      moveRow(300.5);
      restoreChatScrollAnchor(container, anchor, true);
      expect(container.scrollTop).toBe(520 + movement + 300.5);
    }
  });

  it('preserves inertia when preceding content shrinks', () => {
    const { container, moveRow } = viewport();
    const anchor = captureChatScrollAnchor(container);
    container.scrollTop -= 9.25;
    moveRow(-80.5);
    restoreChatScrollAnchor(container, anchor, true);
    expect(container.scrollTop).toBe(430.25);
  });

  it('retains the viewport restoration path when the browser already anchored a prepend', () => {
    const { container, moveRow } = viewport();
    const anchor = captureChatScrollAnchor(container);
    moveRow(300.5);
    container.scrollTop += 300.5;
    restoreChatScrollAnchor(container, anchor);
    expect(container.scrollTop).toBe(820.5);
  });
});
