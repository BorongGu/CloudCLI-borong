/** Convert a selected DOM fragment into readable paragraphs, lists and table cells. */
function selectionText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const value = node.textContent ?? '';
    // Rehype inserts formatting newlines between blocks; those blocks already supply their boundaries.
    if (!value.trim() && /[\r\n]/.test(value) && !node.parentElement?.closest('pre, code')) {
      const blocks = 'div, p, pre, blockquote, h1, h2, h3, h4, h5, h6, table, thead, tbody, tr, th, td, ul, ol, li';
      if ([node.previousSibling, node.nextSibling].some(sibling => sibling instanceof Element && sibling.matches(blocks))) return '';
    }
    return value;
  }
  if (!(node instanceof Element) && !(node instanceof DocumentFragment)) return '';
  const content = Array.from(node.childNodes, selectionText).join('');
  if (!(node instanceof Element)) return content;
  if (node.tagName === 'BR') return '\n';
  if (node.matches('td, th')) return content.trimEnd() + '\t';
  if (node.tagName === 'TR') return content.trimEnd() + '\n';
  if (node.tagName === 'LI') return '- ' + content.trim() + '\n';
  if (node.matches('div, p, section, article, blockquote, pre, h1, h2, h3, h4, h5, h6, ul, ol, table')) {
    return content.replace(/\n+$/, '') + '\n\n';
  }
  return content;
}

/** Markdown installs this once so native copy also works across streamed blocks, messages and BTW panels. */
export function copyMathSelection(event: ClipboardEvent): void {
  if (event.defaultPrevented || !event.clipboardData) return;
  if (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable="true"]')) return;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return;
  const formulas = Array.from(document.querySelectorAll<HTMLElement>('.katex'));
  const ranges = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange());
  if (!ranges.some(range => formulas.some(math => range.intersectsNode(math)))) return;

  const plain: string[] = [];
  const html: string[] = [];
  for (const range of ranges) {
    // Selecting a fraction or script copies its complete source rather than a fragment of its layout tree.
    for (const math of formulas) {
      if (!range.intersectsNode(math)) continue;
      const whole = math.closest('.katex-display') ?? math;
      if (whole.contains(range.startContainer)) range.setStartBefore(whole);
      if (whole.contains(range.endContainer)) range.setEndAfter(whole);
    }
    const fragment = range.cloneContents();
    for (const math of fragment.querySelectorAll('.katex')) {
      const source = math.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
      if (source === undefined || source === null) continue;
      const display = math.closest('.katex-display');
      if (display) {
        const block = document.createElement('div');
        block.textContent = `$$\n${source}\n$$`;
        display.replaceWith(block);
      } else math.replaceWith(document.createTextNode(`$${source}$`));
    }
    fragment.querySelectorAll('button, script, style, [aria-hidden="true"], .sr-only').forEach(node => node.remove());
    plain.push(selectionText(fragment).replace(/^\n+|\n+$/g, ''));
    const wrapper = document.createElement('div');
    wrapper.append(fragment);
    html.push(wrapper.innerHTML);
  }
  event.clipboardData.setData('text/plain', plain.join('\n'));
  event.clipboardData.setData('text/html', html.join('<br>'));
  event.preventDefault();
}
