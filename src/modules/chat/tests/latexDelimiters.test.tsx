import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import { test, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { normalizeLatexDelimiters } from '@/modules/chat/utils/latexDelimiters';
import { splitStreamingMarkdown } from '@/modules/chat/utils/streamingMarkdown';

/**
 * Issue #1123: Codex writes math with the LaTeX delimiters `\(…\)` and
 * `\[…\]`, which remark-math does not recognize — CommonMark ate the backslash
 * and the transcript showed `(x = …)` instead of a formula. These render the
 * reporter's sample through the real chat <Markdown> and pin the cases a naive
 * global replace would break.
 */

vi.mock('@/modules/command-palette', () => ({
  usePaletteOps: () => ({ openFileInEditor: vi.fn(), openDirectory: vi.fn() }),
}));

const { Markdown, MarkdownBody } = await import('@/modules/chat/transcript/Markdown');

const REPORTER_SAMPLE = String.raw`Inline: \(\boldsymbol{x}=[\beta_c,\beta_t,P_{\mathrm{gg}}]^{\mathrm{T}}\)

Display:
\[
\widehat{T}_{\mathrm{eq}} = \widehat{\mathcal{F}}_{\mathrm{HP}}\left(\boldsymbol{\xi}_{\mathrm{HP}};\Theta_{\mathrm{HP}}\right)
\]
`;

const renderChatMarkdown = (markdown: string): HTMLElement => {
  const { container } = render(<Markdown>{markdown}</Markdown>);
  return container;
};

test("the reporter's sample renders as math, not as literal delimiters", () => {
  const container = renderChatMarkdown(REPORTER_SAMPLE);

  assert.equal(container.querySelectorAll('.katex').length, 2);
  assert.equal(container.querySelectorAll('.katex-display').length, 1);
  assert.ok(!container.textContent?.includes('\\('), 'a raw \\( delimiter reached the DOM');
  assert.ok(!container.textContent?.includes('\\['), 'a raw \\[ delimiter reached the DOM');
  // The annotation carries the TeX source, so the commands the reporter listed
  // as lost are provably in the formula rather than in the surrounding text.
  const annotations = [...container.querySelectorAll('annotation')].map((node) => node.textContent);
  assert.ok(annotations[0]?.includes('\\boldsymbol{x}'));
  assert.ok(annotations[1]?.includes('\\widehat{T}_{\\mathrm{eq}}'));
});

test('a one-line \\[x\\] still renders as a display equation', () => {
  const container = renderChatMarkdown(String.raw`\[a^2 + b^2 = c^2\]`);
  assert.equal(container.querySelectorAll('.katex-display').length, 1);
});

test('LaTeX inside code stays literal', () => {
  const container = renderChatMarkdown(
    [
      'Fenced:',
      '',
      '```text',
      String.raw`\(x\) and \[y\]`,
      '```',
      '',
      'Inline code: `\\[y\\]`',
      '',
      'Indented:',
      '',
      String.raw`    \(z\)`,
    ].join('\n'),
  );

  assert.equal(container.querySelectorAll('.katex').length, 0);
  assert.ok(container.textContent?.includes('\\(x\\) and \\[y\\]'));
  assert.ok(container.textContent?.includes('\\[y\\]'));
  assert.ok(container.textContent?.includes('\\(z\\)'));
});

test('dollar amounts and $$ math keep the behaviour singleDollarTextMath was turned off for', () => {
  const prices = renderChatMarkdown('It costs $5 and $7 in total.');
  assert.equal(prices.querySelectorAll('.katex').length, 0);
  assert.ok(prices.textContent?.includes('$5 and $7'));

  const list = renderChatMarkdown('Prices: $5, $10 and $15.');
  assert.equal(list.querySelectorAll('.katex').length, 0);
  assert.ok(list.textContent?.includes('$5, $10 and $15'));

  const displayDollars = renderChatMarkdown('Energy:\n\n$$\nE = mc^2\n$$\n');
  assert.equal(displayDollars.querySelectorAll('.katex-display').length, 1);
});

test('single $…$ math renders inline without becoming a display block', () => {
  const container = renderChatMarkdown(
    String.raw`用连续存活概率 $c_{t+1} = c_t(1 - d_{t+1})$ 替代硬终止，观测 $\hat{\bar{o}}_t$ 与策略 $\pi_\theta(\hat{\bar{o}}_t + \eta_t, g_t)$。`,
  );

  assert.equal(container.querySelectorAll('.katex').length, 3);
  assert.equal(container.querySelectorAll('.katex-display').length, 0);
  assert.ok(!container.textContent?.includes('$'), 'a raw $ delimiter reached the DOM');
  const annotations = [...container.querySelectorAll('annotation')].map((node) => node.textContent);
  assert.ok(annotations[0]?.includes('c_{t+1}'));
  assert.ok(annotations[2]?.includes('\\pi_\\theta'));
});

test('single $…$ stays literal in code, next to spaces and when escaped', () => {
  const spaced = renderChatMarkdown('Not math: $ x$ nor $x $ nor a lone $x');
  assert.equal(spaced.querySelectorAll('.katex').length, 0);

  const escaped = renderChatMarkdown(String.raw`Escaped \$x$ stays text.`);
  assert.equal(escaped.querySelectorAll('.katex').length, 0);
  assert.ok(escaped.textContent?.includes('$x$'));

  const code = renderChatMarkdown('Inline `$x$` and fenced:\n\n```text\n$y$\n```');
  assert.equal(code.querySelectorAll('.katex').length, 0);
  assert.ok(code.textContent?.includes('$x$'));
  assert.ok(code.textContent?.includes('$y$'));
});

test('single $…$ never crosses a paragraph break', () => {
  const container = renderChatMarkdown('Opens $a\n\nand closes b$ later.');
  assert.equal(container.querySelectorAll('.katex').length, 0);
  assert.ok(container.textContent?.includes('$a'));
});

test('$$ display math and $…$ inline math render side by side', () => {
  const container = renderChatMarkdown('Inline $a$ first.\n\n$$\nb = c\n$$\n\nAfter $d$.');
  assert.equal(container.querySelectorAll('.katex').length, 3);
  assert.equal(container.querySelectorAll('.katex-display').length, 1);
});

test('an escaped backslash does not open math and an unmatched opener stays text', () => {
  assert.equal(normalizeLatexDelimiters(String.raw`a \\(b\) c`), String.raw`a \\(b\) c`);
  assert.equal(normalizeLatexDelimiters(String.raw`open at C:\(dir) only`), String.raw`open at C:\(dir) only`);

  const container = renderChatMarkdown(String.raw`Path C:\(dir) is fine.`);
  assert.equal(container.querySelectorAll('.katex').length, 0);
});

/**
 * The streaming half of the acceptance criteria: the two documents
 * StreamingMarkdown renders must look like the one document the reopened
 * session renders. Mirrors streamingMarkdownRenderEquivalence.test.tsx, but
 * through <MarkdownBody> so the normalizer is in the path.
 */
const normalizeBlockWhitespace = (html: string): string => html.replace(/>\n</g, '><');

const renderWhole = (content: string): string =>
  normalizeBlockWhitespace(renderToStaticMarkup(<MarkdownBody>{content}</MarkdownBody>));

const renderSplit = (content: string): string => {
  const { settled, pending } = splitStreamingMarkdown(content);
  return normalizeBlockWhitespace(
    renderToStaticMarkup(
      <>
        {settled ? <MarkdownBody key="s">{settled}</MarkdownBody> : null}
        {pending ? <MarkdownBody key="p">{pending}</MarkdownBody> : null}
      </>,
    ),
  );
};

const assertRendersIdentically = (content: string, label: string) => {
  const { settled, pending } = splitStreamingMarkdown(content);
  assert.equal(settled + pending, content, `${label}: split lost or duplicated text`);
  assert.equal(renderSplit(content), renderWhole(content), `${label}: split renders differently`);
};

const STREAMING_FIXTURES: Array<[string, string]> = [
  ['display latex', 'Before.\n\n' + String.raw`\[` + '\na = b\n' + String.raw`\]` + '\n\nAfter'],
  ['display latex with a blank line inside', 'Before.\n\n' + String.raw`\[` + '\n\na = b\n\n' + String.raw`\]` + '\n\nAfter'],
  ['inline latex after a paragraph', 'Intro.\n\n' + String.raw`Then \(x^2\) inline` + '\n\nEnd'],
  ['inline dollar math', 'Intro.\n\nThen $x^2 + y^2 = z^2$ inline.\n\nEnd'],
  ['display dollars and inline dollars', 'Before $a$.\n\n$$\nb = c\n$$\n\nAfter $d$'],
];

for (const [label, content] of STREAMING_FIXTURES) {
  test(`every streaming prefix renders identically: ${label}`, () => {
    for (let end = 1; end <= content.length; end += 1) {
      assertRendersIdentically(content.slice(0, end), `${label} @${end}`);
    }
  });
}

test("the reporter's sample renders the same split as whole", () => {
  assertRendersIdentically(REPORTER_SAMPLE, "reporter's sample");
});
