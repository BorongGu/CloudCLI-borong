/**
 * Rewrites the LaTeX math delimiters `\(…\)`, `\[…\]` and single `$…$` into
 * the `$$…$$` form that remark-math actually understands.
 *
 * Models — Codex in particular — emit math with the LaTeX delimiters, but
 * `micromark-extension-math`, which backs remark-math, registers exactly one
 * construct and it sits on `$`. Nothing recognizes `\(`, and because CommonMark
 * reads `\(` and `\[` as backslash escapes the parser eats the backslash, so the
 * reader is left with `(x = …)` instead of a formula. Single `$…$` math, which
 * models emit constantly, is also left literal because `singleDollarTextMath`
 * is off in <Markdown> — deliberately, since remark-math cannot tell a formula
 * apart from a sentence like "costs $5 and $7".
 *
 * `$$` is the target for every notation: a `$$…$$` run inside a paragraph is
 * inline math and a `$$` alone on its line opens a display block, so all
 * notations survive the translation. The single-`$` pass re-applies the
 * heuristics the remark option could not (an opener is never followed by a
 * space or a digit, a closer is never preceded by a space or followed by a
 * digit, the pair never crosses a paragraph break), which keeps prices and
 * other currency literal while formulas render.
 *
 * Code is never rewritten: fenced blocks, indented blocks and inline code spans
 * are masked out before any delimiter is matched, so LaTeX quoted as an example
 * stays literal.
 */

/** An opening or closing code fence, per CommonMark: up to 3 spaces of indent. */
const CODE_FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;

/** The indent that starts an indented code block where a block may begin. */
const INDENTED_CODE_PATTERN = /^(?: {4}|\t)/;

/**
 * Every delimiter candidate. `\\` is matched first and discarded so a literal
 * escaped backslash (`\\(`) is never read as an opener.
 */
const LATEX_DELIMITER_PATTERN = /\\\\|\\[()[\]]/g;

/** Cheap bail-out: no opener, nothing to do. Runs on every rendered message. */
const LATEX_OPENER_PATTERN = /\\[([]/;

/** A blank line, which would end the paragraph a `$$…$$` inline run lives in. */
const BLANK_LINE_PATTERN = /\n[ \t]*\n/;

/**
 * Used by streamingMarkdown's boundary search: the line that opens a `\[ … \]`
 * display block, i.e. exactly the block normalizeLatexDelimiters turns into a
 * `$$` fence. The splitter must not cut inside one, or the two halves normalize
 * independently and each renders a stray bracket.
 */
export const LATEX_DISPLAY_OPEN_PATTERN = /^ {0,3}\\\[/;

/** Used by streamingMarkdown: the `\]` that closes such a block, anywhere on the line. */
export const LATEX_DISPLAY_CLOSE_PATTERN = /\\\]/;

type LatexDelimiter = {
  index: number;
  /** The bracket after the backslash, which says whether this opens or closes. */
  bracket: '(' | ')' | '[' | ']';
};

/** A slice of the source to overwrite, in ascending, non-overlapping order. */
type DelimiterEdit = { start: number; end: number; value: string };

/**
 * Used by chat's <Markdown> on every message body, after
 * normalizeInlineCodeFences has settled the code spans this reads.
 */
export function normalizeLatexDelimiters(text: string): string {
  // Cheap bail-out: with no LaTeX opener and no `$` there is nothing to do.
  // Runs on every rendered message.
  if (!text || typeof text !== 'string' || (!LATEX_OPENER_PATTERN.test(text) && !text.includes('$'))) {
    return text;
  }
  try {
    const codeMask = buildCodeMask(text);
    const edits = planDelimiterEdits(text, codeMask);
    if (edits.length === 0) {
      return text;
    }

    let result = '';
    let cursor = 0;
    for (const edit of edits) {
      result += text.slice(cursor, edit.start) + edit.value;
      cursor = edit.end;
    }
    return result + text.slice(cursor);
  } catch {
    return text;
  }
}

/**
 * Marks every character that CommonMark reads as code, so no delimiter inside
 * one is rewritten. Deliberately over-eager in one spot: an indented paragraph
 * inside a loose list is counted as indented code, which only means the LaTeX
 * there stays literal — never that prose is mangled.
 */
function buildCodeMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length);

  let offset = 0;
  let openFence: { marker: string; length: number } | null = null;
  // A blank line (or the document start) is what lets an indented code block begin.
  let blockCanStart = true;
  let inIndentedCode = false;

  for (const line of text.split('\n')) {
    const fence = CODE_FENCE_PATTERN.exec(line);
    let isCode = false;

    if (openFence) {
      isCode = true;
      if (fence && closesFence(openFence, fence[1], line)) {
        openFence = null;
      }
    } else if (fence) {
      openFence = { marker: fence[1][0], length: fence[1].length };
      isCode = true;
      inIndentedCode = false;
      blockCanStart = false;
    } else if (line.trim() === '') {
      blockCanStart = true;
    } else if ((blockCanStart || inIndentedCode) && INDENTED_CODE_PATTERN.test(line)) {
      isCode = true;
      inIndentedCode = true;
      blockCanStart = false;
    } else {
      inIndentedCode = false;
      blockCanStart = false;
    }

    if (isCode) {
      mask.fill(1, offset, offset + line.length);
    }
    offset += line.length + 1;
  }

  maskInlineCodeSpans(text, mask);
  return mask;
}

/** A closing fence uses the same marker, is at least as long and carries no info string. */
function closesFence(open: { marker: string; length: number }, sequence: string, line: string): boolean {
  if (sequence[0] !== open.marker || sequence.length < open.length) {
    return false;
  }
  return line.trim().replace(/^[`~]+/, '').trim() === '';
}

/** Adds each `` ` ``-delimited span outside a code block to the mask. */
function maskInlineCodeSpans(text: string, mask: Uint8Array): void {
  let index = 0;
  while (index < text.length) {
    if (mask[index] || text[index] !== '`') {
      index += 1;
      continue;
    }
    const runEnd = endOfBacktickRun(text, index);
    const closeAt = findBacktickRun(text, runEnd, runEnd - index, mask);
    if (closeAt < 0) {
      // No matching run: CommonMark leaves the backticks as literal text.
      index = runEnd;
      continue;
    }
    const spanEnd = closeAt + (runEnd - index);
    mask.fill(1, index, spanEnd);
    index = spanEnd;
  }
}

function endOfBacktickRun(text: string, from: number): number {
  let index = from;
  while (index < text.length && text[index] === '`') {
    index += 1;
  }
  return index;
}

/** The next unmasked run of exactly `length` backticks, or -1. */
function findBacktickRun(text: string, from: number, length: number, mask: Uint8Array): number {
  let index = from;
  while (index < text.length) {
    if (mask[index] || text[index] !== '`') {
      index += 1;
      continue;
    }
    const runEnd = endOfBacktickRun(text, index);
    if (runEnd - index === length) {
      return index;
    }
    index = runEnd;
  }
  return -1;
}

/**
 * Pairs every math delimiter left outside code and turns each pair into `$$`
 * edits. The three passes run over the original text and share a `claimed`
 * map — ranges spoken for by an existing `$$…$$` run or a `\(…\)`/`\[…\]`
 * pair — so the single-`$` pass never reaches inside another notation.
 */
function planDelimiterEdits(text: string, mask: Uint8Array): DelimiterEdit[] {
  const claimed = new Uint8Array(text.length);
  const edits = planBracketEdits(text, mask, claimed);
  claimDisplayDollarSpans(text, mask, claimed);
  const dollarEdits = planInlineDollarEdits(text, mask, claimed);
  return [...edits, ...dollarEdits].sort((a, b) => a.start - b.start);
}

/** Pairs the `\(…\)` and `\[…\]` delimiters and turns each pair into `$$` edits. */
function planBracketEdits(text: string, mask: Uint8Array, claimed: Uint8Array): DelimiterEdit[] {
  const delimiters: LatexDelimiter[] = [];
  LATEX_DELIMITER_PATTERN.lastIndex = 0;
  for (let match = LATEX_DELIMITER_PATTERN.exec(text); match; match = LATEX_DELIMITER_PATTERN.exec(text)) {
    if (match[0] !== '\\\\' && !mask[match.index]) {
      delimiters.push({ index: match.index, bracket: match[0][1] as LatexDelimiter['bracket'] });
    }
  }

  const edits: DelimiterEdit[] = [];
  let position = 0;
  while (position < delimiters.length) {
    const open = delimiters[position];
    if (open.bracket !== '(' && open.bracket !== '[') {
      position += 1;
      continue;
    }

    const closingBracket = open.bracket === '(' ? ')' : ']';
    let closePosition = -1;
    for (let candidate = position + 1; candidate < delimiters.length; candidate += 1) {
      if (delimiters[candidate].bracket === closingBracket) {
        closePosition = candidate;
        break;
      }
    }
    if (closePosition < 0) {
      // An unmatched opener is ordinary text (a Windows path, an escaped bracket).
      position += 1;
      continue;
    }

    const close = delimiters[closePosition];
    claimed.fill(1, open.index, close.index + 2);
    const content = text.slice(open.index + 2, close.index);
    // A `$$` inside would close the run being opened, and a code region between
    // the two delimiters means they are not really a pair.
    if (content.includes('$$') || spansCode(mask, open.index, close.index)) {
      position += 1;
      continue;
    }

    // `\[` already at the start of its line becomes a `$$` fence, which is what
    // makes it a centered display equation; anywhere else it has to stay inline
    // so the surrounding list item, table cell or sentence is not torn apart.
    const isDisplayBlock = open.bracket === '[' && startsLine(text, open.index);
    if (isDisplayBlock) {
      edits.push({
        start: open.index,
        end: open.index + 2,
        value: restOfLineIsBlank(text, open.index + 2) ? '$$' : '$$\n',
      });
      edits.push({
        start: close.index,
        end: close.index + 2,
        value: startsLine(text, close.index) ? '$$' : '\n$$',
      });
    } else if (BLANK_LINE_PATTERN.test(content)) {
      // Inline math cannot cross a paragraph break; leave the pair alone.
      position += 1;
      continue;
    } else {
      // The spaces are stripped again by micromark, and they keep a `$` at the
      // edge of the formula from lengthening the delimiter run.
      edits.push({ start: open.index, end: open.index + 2, value: '$$ ' });
      edits.push({ start: close.index, end: close.index + 2, value: ' $$' });
    }

    position = closePosition + 1;
  }

  return edits;
}

/**
 * Marks every `$$…$$` run outside code as claimed so the single-`$` pass never
 * re-pairs the dollars of math that is already in remark-math's notation. An
 * unclosed `$$` claims the rest of the text: it is a display block still
 * streaming in, and nothing after it should pair either.
 */
function claimDisplayDollarSpans(text: string, mask: Uint8Array, claimed: Uint8Array): void {
  let index = 0;
  while (index < text.length - 1) {
    if (text[index] === '\\') {
      index += 2;
      continue;
    }
    if (mask[index] || claimed[index] || text[index] !== '$' || text[index + 1] !== '$') {
      index += 1;
      continue;
    }
    let cursor = index + 2;
    let close = -1;
    while (cursor < text.length - 1) {
      if (text[cursor] === '\\') {
        cursor += 2;
        continue;
      }
      if (text[cursor] === '$' && text[cursor + 1] === '$' && !mask[cursor]) {
        close = cursor;
        break;
      }
      cursor += 1;
    }
    if (close < 0) {
      claimed.fill(1, index);
      return;
    }
    claimed.fill(1, index, close + 2);
    index = close + 2;
  }
}

/**
 * Pairs single `$…$` delimiters into inline `$$ … $$` math. The guards are the
 * currency heuristics `singleDollarTextMath` cannot express: a `$` followed by
 * a digit never opens ("$5"), an opener is never followed by a space, a closer
 * is never preceded by a space or followed by a digit ("$x$5" stays text), and
 * a pair never crosses a paragraph break or a code span.
 */
function planInlineDollarEdits(text: string, mask: Uint8Array, claimed: Uint8Array): DelimiterEdit[] {
  const edits: DelimiterEdit[] = [];
  let index = 0;
  while (index < text.length - 1) {
    if (text[index] === '\\') {
      // An escaped `\$` is a literal dollar sign, never a delimiter.
      index += 2;
      continue;
    }
    if (text[index] !== '$' || mask[index] || claimed[index] || !isDollarOpener(text, index)) {
      index += 1;
      continue;
    }
    const close = findDollarCloser(text, index + 1, mask, claimed);
    if (close < 0) {
      index += 1;
      continue;
    }
    const content = text.slice(index + 1, close);
    if (!content || BLANK_LINE_PATTERN.test(content)) {
      // Empty math renders nothing and inline math cannot cross a paragraph
      // break; leave both literal.
      index += 1;
      continue;
    }
    // The spaces are stripped again by micromark, and they keep a `$` at the
    // edge of the formula from lengthening the delimiter run.
    edits.push({ start: index, end: index + 1, value: '$$ ' });
    edits.push({ start: close, end: close + 1, value: ' $$' });
    index = close + 1;
  }
  return edits;
}

/** A `$` opens inline math only when a non-space, non-digit character follows. */
function isDollarOpener(text: string, index: number): boolean {
  const next = text[index + 1];
  if (next === undefined || next === '$' || isBlank(next) || isDigit(next)) {
    return false;
  }
  return true;
}

/**
 * The next `$` that can close the run opened before `from`, or -1. Code and
 * claimed ranges end the search: a pair may not span either.
 */
function findDollarCloser(text: string, from: number, mask: Uint8Array, claimed: Uint8Array): number {
  let index = from;
  while (index < text.length) {
    if (text[index] === '\\') {
      index += 2;
      continue;
    }
    if (mask[index] || claimed[index]) {
      return -1;
    }
    if (text[index] === '$') {
      if (text[index + 1] === '$') {
        return -1;
      }
      const previous = text[index - 1];
      const next = text[index + 1];
      if (!isBlank(previous) && (next === undefined || !isDigit(next))) {
        return index;
      }
    }
    index += 1;
  }
  return -1;
}

function isBlank(character: string): boolean {
  return character === ' ' || character === '\t' || character === '\n' || character === '\r';
}

function isDigit(character: string): boolean {
  return character >= '0' && character <= '9';
}

function spansCode(mask: Uint8Array, from: number, to: number): boolean {
  for (let index = from; index < to; index += 1) {
    if (mask[index]) {
      return true;
    }
  }
  return false;
}

/** Only whitespace sits between the start of the line and `index`. */
function startsLine(text: string, index: number): boolean {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const character = text[cursor];
    if (character === '\n') {
      return true;
    }
    if (character !== ' ' && character !== '\t') {
      return false;
    }
  }
  return true;
}

/** Only whitespace sits between `from` and the end of its line. */
function restOfLineIsBlank(text: string, from: number): boolean {
  for (let cursor = from; cursor < text.length; cursor += 1) {
    const character = text[cursor];
    if (character === '\n') {
      return true;
    }
    if (character !== ' ' && character !== '\t') {
      return false;
    }
  }
  return true;
}
