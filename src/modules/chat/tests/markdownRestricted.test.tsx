import { render } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import StreamingMarkdown from '@/modules/chat/transcript/StreamingMarkdown';

vi.mock('@/modules/command-palette', () => ({ usePaletteOps: () => ({ openFileInEditor: vi.fn(), openDirectory: vi.fn() }) }));

test('guest replies retain CloudCLI math, emphasis and table breaks while omitting workspace navigation and image fetches', () => {
  const source = '**答案**：$x=2$。\n\n$$a^2+b^2=c^2$$\n\n|项|说明|\n|---|---|\n|A|第一行<br>第二行|\n\n[私有文件](/home/company/notes.md)\n\n![remote](https://example.com/track.png)';
  const { container } = render(<StreamingMarkdown content={source} isStreaming={false} restricted />);
  expect(container.querySelector('strong')?.textContent).toBe('答案');
  expect(container.querySelectorAll('.katex').length).toBe(2);
  expect(container.querySelector('td br')).toBeTruthy();
  expect(container.querySelectorAll('img, a').length).toBe(0);
  expect(container.textContent).toContain('私有文件');
});
