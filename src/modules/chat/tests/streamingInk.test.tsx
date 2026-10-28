import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import StreamingMarkdown from '@/modules/chat/transcript/StreamingMarkdown';
import { Markdown } from '@/modules/chat/transcript/Markdown';

// Pacing has its own frame-clock tests; exercise actual Markdown and DOM identity here.
vi.mock('@/modules/chat/hooks/useProgressiveText', () => ({ useProgressiveText: (content: string) => content }));
vi.mock('@/modules/command-palette', () => ({ usePaletteOps: () => ({ openFileInEditor: vi.fn(), openDirectory: vi.fn() }) }));
afterEach(() => vi.restoreAllMocks());

// Splitting Markdown changes only whitespace text nodes between block elements.
const canonicalMarkup = (element: HTMLElement) => {
  const clone = element.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('[data-stream-ink]').forEach(span => span.replaceWith(...span.childNodes));
  return clone.innerHTML.replace(/>\s+</g, '><');
};

describe('streaming ink', () => {
  it('animates new inline groups in native snapshots while retaining previously rendered groups', () => {
    const animated: Element[] = [];
    Element.prototype.animate ??= (() => ({ cancel: () => undefined }) as unknown as Animation);
    const animate = vi.spyOn(Element.prototype, 'animate').mockImplementation(function (this: Element) {
      animated.push(this); return { cancel: vi.fn() } as unknown as Animation;
    });
    const history = '已经显示的历史内容完整呈现。'.repeat(4);
    const view = render(<StreamingMarkdown content={history} isStreaming={false} />);
    expect(animated.length).toBe(0);
    const first = history + '新增文字如墨水一样逐渐显现，同时保留已有内容。'.repeat(3);
    view.rerender(<StreamingMarkdown content={first} isStreaming={false} />);
    expect(animated.length).toBeGreaterThan(0);
    const retained = view.container.querySelector('[data-stream-ink]');
    const previousGroups = new Set(view.container.querySelectorAll('[data-stream-ink]'));
    animated.length = 0; animate.mockClear();
    const second = first + '继续接收新的文字内容，维持连续的输出节奏。'.repeat(3);
    view.rerender(<StreamingMarkdown content={second} isStreaming={false} />);
    expect(view.container.textContent).toBe(second);
    expect(view.container.querySelector('[data-stream-ink]')).toBe(retained);
    expect(animated.length).toBeGreaterThan(0);
    expect(animated.every(element => !previousGroups.has(element))).toBe(true);
  });

  it('retains emphasis, table breaks, formulas and literal code during growth and completion', () => {
    const source = '前文。\n\n| 方法 | 特点 |\n| --- | --- |\n| PPO | **0 阶梯度**<br>优势 $A_t$ 加权 |\n\n```html\n<br>\n```\n\n继续输出 👩🏽‍💻 e\u0301。';
    const view = render(<StreamingMarkdown content="前文。" isStreaming />);
    view.rerender(<StreamingMarkdown content={source} isStreaming />);
    const whole = render(<Markdown>{source}</Markdown>);
    expect(canonicalMarkup(view.container)).toBe(canonicalMarkup(whole.container));
    expect(view.container.querySelectorAll('strong').length).toBe(1);
    expect(view.container.querySelectorAll('td br').length).toBe(1);
    expect(view.container.querySelector('.katex annotation')?.textContent).toBe('A_t');
    expect(view.container.querySelectorAll('pre [data-stream-ink], .katex [data-stream-ink]').length).toBe(0);
    const lastGroup = Array.from(view.container.querySelectorAll('[data-stream-ink]')).slice(-1)[0];
    view.rerender(<StreamingMarkdown content={source} isStreaming={false} />);
    expect(Array.from(view.container.querySelectorAll('[data-stream-ink]')).slice(-1)[0]).toBe(lastGroup);
    expect(canonicalMarkup(view.container)).toBe(canonicalMarkup(whole.container));
  });
});
