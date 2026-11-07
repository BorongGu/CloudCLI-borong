import type { Extension } from 'mdast-util-from-markdown';
import type { State, Tokenizer, TokenType } from 'micromark-util-types';
// Load the parser's augmentation of unified's extension data.
import type {} from 'remark-parse';
import type { Processor } from 'unified';

const OPENING = ':codex-file-citation{';
const TOKEN = 'codexFileCitation' as TokenType;
const QUOTE = '"'.charCodeAt(0);
const ESCAPE = '\\'.charCodeAt(0);
const CLOSE = '}'.charCodeAt(0);

// Consume the citation before Markdown can interpret punctuation in the path.
const tokenizeCitation: Tokenizer = (effects, ok, nok) => {
  let offset = 0;
  let quoted = false;
  let escaped = false;

  const attributes: State = (code) => {
    // Micromark represents line endings with codes below its tab sentinel.
    if (code === null || code < -2) return nok(code);
    effects.consume(code);
    if (escaped) {
      escaped = false;
    } else if (quoted && code === ESCAPE) {
      escaped = true;
    } else if (code === QUOTE) {
      quoted = !quoted;
    } else if (!quoted && code === CLOSE) {
      effects.exit(TOKEN);
      return ok;
    }
    return attributes;
  };

  const opening: State = (code) => {
    if (code !== OPENING.charCodeAt(offset)) return nok(code);
    if (offset === 0) effects.enter(TOKEN);
    effects.consume(code);
    offset += 1;
    return offset === OPENING.length ? attributes : opening;
  };

  return opening;
};

function readCitationPath(attributes: string): string | undefined {
  const input = attributes.trim();
  const attribute = /[ \t]*([a-z_][\w-]*)[ \t]*=[ \t]*(?:"((?:[^"\\]|\\.)*)"|([^\s{}"=]+))/iy;
  let path: string | undefined;
  while (attribute.lastIndex < input.length) {
    const match = attribute.exec(input);
    if (!match) return undefined;
    if (match[1] === 'path') {
      path = match[2]?.replace(/\\(["\\])/g, '$1') ?? match[3];
    }
  }
  return path?.trim() ? path : undefined;
}

const fromMarkdown: Extension = {
  exit: {
    [TOKEN](token) {
      const source = this.sliceSerialize(token);
      const path = readCitationPath(source.slice(OPENING.length, -1));
      if (path) {
        const external = /^https?:\/\//i.test(path);
        const filename = path.split(/[\\/]/).pop() || path;
        this.enter({
          type: 'link',
          url: external ? path : '',
          children: [{ type: 'text', value: filename }],
          data: external ? undefined : { hProperties: { 'data-codex-file-path': path } },
        }, token);
      } else {
        this.enter({ type: 'text', value: source }, token);
      }
      this.exit(token);
    },
  },
};

/** Markdown uses this inline syntax to turn Codex's file references into links. */
export function remarkCodexFileCitations(this: Processor) {
  const data = this.data();
  (data.micromarkExtensions ??= []).push({
    text: { [OPENING.charCodeAt(0)]: { name: TOKEN, tokenize: tokenizeCitation } },
  });
  (data.fromMarkdownExtensions ??= []).push(fromMarkdown);
}
