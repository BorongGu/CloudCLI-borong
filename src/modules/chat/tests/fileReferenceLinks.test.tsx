import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { test, vi } from 'vitest';

/**
 * Regression guard: what a file reference in a chat message hands to the
 * editor. Both suffix helpers are anchored at the end of the string, so a
 * reference picked up from the link text — which, unlike the href, keeps the
 * whitespace around it — used to reach the API with `:12 ` still attached and
 * answer a 404.
 */

const openFileInEditor = vi.fn();
const openDirectory = vi.fn();

vi.mock('@/modules/command-palette', () => ({
  usePaletteOps: () => ({ openFileInEditor, openDirectory }),
}));

const { Markdown } = await import('@/modules/chat/transcript/Markdown');
const { default: StreamingMarkdown } = await import('@/modules/chat/transcript/StreamingMarkdown');

const clickReference = (markdown: string, linkText: string) => {
  openFileInEditor.mockReset();
  openDirectory.mockReset();
  render(<Markdown>{markdown}</Markdown>);
  fireEvent.click(screen.getByText(linkText));
};

test('a `path:line` reference opens the path without its suffix, at that line', () => {
  clickReference('See [src/foo.ts:130](src/foo.ts:130).', 'src/foo.ts:130');
  assert.deepEqual(openFileInEditor.mock.calls[0], ['src/foo.ts', 130]);
});

test('whitespace around a reference taken from the link text is dropped', () => {
  clickReference('See [`src/foo.ts:12` ]().', 'src/foo.ts:12');
  assert.deepEqual(openFileInEditor.mock.calls[0], ['src/foo.ts', 12]);
});

test('a directory reference goes to the file tree, not the editor', () => {
  clickReference('See [decisions/](decisions/).', 'decisions/');
  assert.equal(openFileInEditor.mock.calls.length, 0);
  assert.deepEqual(openDirectory.mock.calls[0], ['decisions/']);
});

test('a plain file reference opens with no line', () => {
  clickReference('See [src/foo.ts](src/foo.ts).', 'src/foo.ts');
  assert.deepEqual(openFileInEditor.mock.calls[0], ['src/foo.ts', null]);
});

test.each([false, true])('Codex file citations open the cited PDF (streaming: %s)', (isStreaming) => {
  const filename = '高斯模型 [*补充*]_附录 (1998).pdf';
  const file = `/Users/example/Zotero/storage/papers/${filename}`;
  const citation = `:codex-file-citation{path=${JSON.stringify(file)} purpose="source"}`;
  openFileInEditor.mockClear();
  const { container } = render(<StreamingMarkdown content={`相关论文。${citation}`} isStreaming={isStreaming} />);
  assert.equal(container.textContent, `相关论文。${filename}`);
  fireEvent.click(screen.getByRole('link', { name: filename }));
  assert.deepEqual(openFileInEditor.mock.calls, [[file, null]]);
});

test('a Windows output citation preserves the original file path', () => {
  const file = 'C:\\Users\\example\\report.pdf';
  clickReference(`:codex-file-citation{path=${JSON.stringify(file)} purpose="output"}`, 'report.pdf');
  assert.deepEqual(openFileInEditor.mock.calls, [[file, null]]);
});

test('code examples keep the directive literal and guest replies show a filename', () => {
  const citation = ':codex-file-citation{path="/tmp/report.pdf" purpose="source"}';
  const { container } = render(<StreamingMarkdown content={`Example: \`${citation}\`.\n\n${citation}`} isStreaming={false} restricted />);
  assert.equal(container.querySelector('code')?.textContent, citation);
  assert.equal(container.querySelectorAll('a').length, 0);
  assert.equal(screen.getByText('report.pdf').tagName, 'SPAN');
});
