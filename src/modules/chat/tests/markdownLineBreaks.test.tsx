import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import { test, vi } from 'vitest';

import { Markdown } from '@/modules/chat/transcript/Markdown';
import StreamingMarkdown from '@/modules/chat/transcript/StreamingMarkdown';

vi.mock('@/modules/command-palette', () => ({ usePaletteOps: () => ({ openFileInEditor: vi.fn(), openDirectory: vi.fn() }) }));

test.each(['<br>', '<br/>', '<br />', '<BR>', '<BR />'])('%s renders a line break within a table cell', tag => {
  const source = `| 核心维度 | PPO |\n| --- | --- |\n| 底层哲学 | **盲人摸象（试错统计）**${tag}靠海量随机碰撞统计 |`;
  const { container } = render(<Markdown>{source}</Markdown>);
  const cells = container.querySelectorAll('td');
  assert.equal(cells.length, 2);
  assert.equal(cells[1].querySelectorAll('br').length, 1);
  assert.equal(cells[1].querySelector('strong')?.textContent, '盲人摸象（试错统计）');
  assert.equal(cells[1].textContent, '盲人摸象（试错统计）靠海量随机碰撞统计');
});

test('inline and standalone breaks retain consecutive lines', () => {
  const { container } = render(<Markdown>{'第一行<br>第二行<br/><br />第四行\n\n<br>\n段首换行'}</Markdown>);
  assert.equal(container.querySelectorAll('br').length, 4);
  assert.equal(container.textContent?.includes('<br'), false);
  assert.ok(container.textContent?.includes('段首换行'));
});

test('formulas and emphasis render on both sides of a table line break', () => {
  const { container } = render(<Markdown>{'| 梯度 | 世界模型 |\n| --- | --- |\n| **0 阶梯度**<br>标量优势 $A_t$ 加权 | **无世界模型**<br/>依赖物理仿真器 |'}</Markdown>);
  assert.equal(container.querySelectorAll('td br').length, 2);
  assert.equal(container.querySelectorAll('td strong').length, 2);
  assert.equal(container.querySelector('td .katex annotation')?.textContent, 'A_t');
});

test('code examples, escaped tags and other literal HTML retain their text', () => {
  const { container } = render(<Markdown>{'示例 `<br>`，转义 &lt;br&gt;。\n\n```html\n<br>\n<br/>\n```\n\n<span title="<br>">标签原文</span>\n\n<script>"<br>"</script>\n\n<img src="invalid" onerror="alert(1)">'}</Markdown>);
  assert.equal(container.querySelectorAll('br').length, 0);
  assert.equal(container.querySelectorAll('script, img, span[title]').length, 0);
  assert.ok(container.textContent?.includes('<br>'));
  assert.ok(container.querySelector('pre code')?.textContent?.includes('<br/>'));
  assert.ok(container.textContent?.includes('<span title="<br>">'));
});

test('streamed table prefixes and the final reply render the same line breaks', () => {
  const source = '前文。\n\n| 方法 | 特点 |\n| --- | --- |\n| PPO | **0 阶梯度**<br>优势 $A_t$ 加权 |\n| TD-MPC | **混合优化**<br/>在线规划 |\n\n完成。';
  for (let length = 1; length <= source.length; length++) {
    const prefix = source.slice(0, length);
    const streamed = render(<StreamingMarkdown content={prefix} isStreaming />);
    const complete = render(<Markdown>{prefix}</Markdown>);
    assert.equal(streamed.container.innerHTML, complete.container.innerHTML, `prefix ${length}`);
    streamed.unmount();complete.unmount();
  }
});
