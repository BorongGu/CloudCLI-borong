import assert from 'node:assert/strict';

import { cleanup, render } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

vi.mock('@/modules/command-palette', () => ({ usePaletteOps: () => ({ openFileInEditor: vi.fn(), openDirectory: vi.fn() }) }));

const { Markdown } = await import('@/modules/chat/transcript/Markdown');
afterEach(cleanup);

for (const [source, expected] of [
  ['这是**中文重点**，和普通正文。', '中文重点'],
  ['这里是**“中文引号”**的重点。', '“中文引号”'],
  ['这里是**中文（括号）**后面紧跟正文。', '中文（括号）'],
  ['**这些是完整句子。**后面继续说明。', '这些是完整句子。'],
  ['这里是**`context_window`**的解释。', 'context_window'],
  ['**GPT-6.1 Sol** and **OpenCode**', 'GPT-6.1 Sol'],
]) test(`chat renders strong emphasis: ${source}`, () => {
  const { container } = render(<Markdown>{source}</Markdown>);
  assert.ok([...container.querySelectorAll('strong')].some(node => node.textContent === expected));
  assert.equal(container.textContent?.includes('**'), false);
});

test('bold text around math renders both strong emphasis and the original formula', () => {
  const { container } = render(<Markdown>{'使用**变量 $x_t$**表示观测，再计算**方差（$\\sigma^2$）**。'}</Markdown>);
  assert.equal(container.querySelectorAll('strong').length, 2);
  assert.equal(container.querySelectorAll('strong .katex').length, 2);
  assert.deepEqual([...container.querySelectorAll('annotation')].map(node => node.textContent), ['x_t', '\\sigma^2']);
});

test('escaped markers, code samples, nested emphasis and GFM keep their meaning', () => {
  const source = ['代码 `**保持原文**`，转义 \\*\\*字面星号\\*\\*。', '', '**强调 *斜体*** 和 ~~删除线~~。', '', '```md', '**代码里的星号**', '```'].join('\n');
  const { container } = render(<Markdown>{source}</Markdown>);
  assert.equal(container.querySelector('strong em')?.textContent, '斜体');
  assert.equal(container.querySelector('del')?.textContent, '删除线');
  assert.equal(container.querySelector('code strong'), null);
  assert.ok(container.textContent?.includes('**保持原文**'));
  assert.ok(container.textContent?.includes('**字面星号**'));
  assert.ok(container.textContent?.includes('**代码里的星号**'));
});
