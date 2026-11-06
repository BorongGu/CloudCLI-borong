import assert from 'node:assert/strict';
import { render, cleanup } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

vi.mock('@/modules/command-palette', () => ({ usePaletteOps: () => ({ openFileInEditor: vi.fn(), openDirectory: vi.fn() }) }));
const { Markdown } = await import('@/modules/chat/transcript/Markdown');
const { default: StreamingMarkdown } = await import('@/modules/chat/transcript/StreamingMarkdown');

afterEach(() => { cleanup(); window.getSelection()?.removeAllRanges(); });

function copy(range: Range) {
  const selection = window.getSelection()!;
  selection.removeAllRanges(); selection.addRange(range);
  const data = new Map<string, string>();
  const event = new Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { setData: (type: string, value: string) => data.set(type, value) } });
  document.dispatchEvent(event);
  return { event, data };
}

test('native selection copies inline and display formulas once, preserving source and paragraph boundaries', () => {
  const source = String.raw`延迟 **$450\text{--}550\text{ms}$**。

$$
\frac{a+b}{c}
$$

下一段。`;
  const { container } = render(<Markdown>{source}</Markdown>);
  const range = document.createRange(); range.selectNodeContents(container);
  const { event, data } = copy(range);
  assert.equal(event.defaultPrevented, true);
  assert.equal(data.get('text/plain'), String.raw`延迟 $450\text{--}550\text{ms}$。

$$
\frac{a+b}{c}
$$

下一段。`);
  assert.doesNotMatch(data.get('text/html')!, /katex|MathML|annotation|aria-hidden/);
  assert.ok(data.get('text/html')!.includes('<strong>$450'));
  assert.equal(container.querySelectorAll('.katex').length, 2, 'copy leaves the displayed formulas intact');
});

test('selecting part of the visual fraction recovers its complete formula', () => {
  const { container } = render(<Markdown>{String.raw`结果 $\frac{x_1}{y^2}$ 完成。`}</Markdown>);
  const glyph = [...container.querySelectorAll('.katex-html span')].find(el => el.childNodes.length === 1 && el.firstChild?.nodeType === Node.TEXT_NODE && el.textContent === 'x')!;
  const range = document.createRange(); range.selectNodeContents(glyph);
  assert.equal(copy(range).data.get('text/plain'), String.raw`$\frac{x_1}{y^2}$`);
});

test('a selection crossing streamed messages retains only selected text and each formula once', () => {
  const { container } = render(<>
    <StreamingMarkdown isStreaming={false} content={String.raw`前面 $x_1$ 后面。`} className="first" />
    <Markdown className="last">{String.raw`第二条 $y^2$ 结束。`}</Markdown>
  </>);
  const start = container.querySelector('.first .mb-2')!.firstChild!;
  const end = container.querySelector('.last .mb-2')!.lastChild!;
  const range = document.createRange(); range.setStart(start, 1); range.setEnd(end, 2);
  assert.equal(copy(range).data.get('text/plain'), '面 $x_1$ 后面。\n\n第二条 $y^2$ 结');
});

test('plain text selection and literal math code keep the browser copy behavior', () => {
  const { container } = render(<Markdown>{'普通文字，代码 `$x$`。'}</Markdown>);
  const range = document.createRange(); range.selectNodeContents(container);
  const { event, data } = copy(range);
  assert.equal(event.defaultPrevented, false);
  assert.equal(data.size, 0);
});

test('table selection keeps columns while replacing the formula layout with its source', () => {
  const { container } = render(<Markdown>{'| 值 | 公式 |\n| --- | --- |\n| A | $x_1$ |'}</Markdown>);
  const range = document.createRange(); range.selectNodeContents(container.querySelector('table')!);
  assert.equal(copy(range).data.get('text/plain'), '值\t公式\nA\t$x_1$');
});

test('copying adjacent plain text leaves an unselected formula out of the clipboard', () => {
  const { container } = render(<Markdown>{'前文 $x$ 后文。'}</Markdown>);
  const range = document.createRange();range.selectNodeContents(container.querySelector('.mb-2')!.firstChild!);
  assert.equal(copy(range).event.defaultPrevented, false);
});
