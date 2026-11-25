/**
 * A small TS/JS tokenizer: enough to find imports, identifiers and string literals
 * with comments skipped, without a compiler dependency. It does not parse; it
 * classifies characters the way a parser would before parsing.
 */
export type CoverageToken =
  | { readonly kind: 'word'; readonly text: string; readonly line: number }
  | { readonly kind: 'string'; readonly text: string; readonly line: number }
  | { readonly kind: 'punct'; readonly text: string; readonly line: number };

const WORD = /[A-Za-z0-9_$]/;
/** After these tokens a `/` starts a regular expression, not a division. */
const REGEX_AFTER = new Set([
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '~',
  '^',
  'return',
  'typeof',
  'case',
  'do',
  'else',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'yield',
  'await',
]);

/** Whether a `/` here begins a regular expression rather than a division or a closing tag. */
function startsRegex(tokens: readonly CoverageToken[]): boolean {
  const last = tokens.at(-1);
  if (last === undefined) return true;
  // `i++ / 2`, `i-- / 2`: a postfix operator ends an operand.
  const before = tokens.at(-2);
  if ((last.text === '+' || last.text === '-') && before?.text === last.text) return false;
  return last.kind !== 'string' && REGEX_AFTER.has(last.text);
}

/** Compute 1-based line number of `target` starting from known `(baseOffset, baseLine)`. */
function lineOfOffset(
  source: string,
  baseOffset: number,
  baseLine: number,
  target: number,
): number {
  let line = baseLine;
  for (let i = baseOffset; i < target; i += 1) if (source[i] === '\n') line += 1;
  return line;
}

/** Advance past a `${…}` expression, skipping strings, nested templates and comments. */
function skipInterpolation(source: string, from: number): number {
  let i = from;
  let depth = 1;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i + 2);
      i = end === -1 ? source.length : end + 1;
    } else if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (ch === "'" || ch === '"') {
      i += 1;
      while (i < source.length && source[i] !== ch && source[i] !== '\n') {
        i += source[i] === '\\' ? 2 : 1;
      }
      if (i < source.length) i += 1;
    } else if (ch === '`') {
      i += 1;
      while (i < source.length && source[i] !== '`') {
        if (source[i] === '\\') i += 2;
        else if (source[i] === '$' && source[i + 1] === '{')
          i = skipInterpolation(source, i + 2);
        else i += 1;
      }
      if (i < source.length) i += 1;
    } else if (ch === '{') {
      depth += 1;
      i += 1;
    } else if (ch === '}') {
      depth -= 1;
      i += 1;
    } else {
      i += 1;
    }
  }
  return i;
}

export function tokenize(source: string): CoverageToken[] {
  const tokens: CoverageToken[] = [];
  let line = 1;
  let at = 0;
  const advance = (to: number) => {
    for (let i = at; i < to; i += 1) if (source[i] === '\n') line += 1;
    at = to;
  };
  while (at < source.length) {
    const char = source[at] ?? '';
    const next = source[at + 1] ?? '';
    if (char === '\n' || char === ' ' || char === '\t' || char === '\r') {
      advance(at + 1);
    } else if (char === '/' && next === '/') {
      const end = source.indexOf('\n', at);
      advance(end === -1 ? source.length : end);
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', at + 2);
      advance(end === -1 ? source.length : end + 2);
    } else if (char === '"' || char === "'") {
      const start = line;
      let i = at + 1;
      let text = '';
      while (i < source.length && source[i] !== char && source[i] !== '\n') {
        if (source[i] === '\\') {
          text += source[i + 1] ?? '';
          i += 2;
        } else {
          text += source[i];
          i += 1;
        }
      }
      tokens.push({ kind: 'string', text, line: start });
      advance(i + 1);
    } else if (char === '`') {
      // A template: its literal text is one string token, and each `${…}` is
      // tokenized as code, so a key read inside an interpolation is still seen.
      const start = line;
      let i = at + 1;
      let text = '';
      const inner: CoverageToken[] = [];
      while (i < source.length && source[i] !== '`') {
        if (source[i] === '\\') {
          text += source[i + 1] ?? '';
          i += 2;
        } else if (source[i] === '$' && source[i + 1] === '{') {
          const from = i + 2;
          const exprLine = lineOfOffset(source, at, start, from);
          i = skipInterpolation(source, from);
          const bodyEnd = i > from && source[i - 1] === '}' ? i - 1 : i;
          for (const token of tokenize(source.slice(from, bodyEnd)))
            inner.push({ ...token, line: exprLine + token.line - 1 });
          text += '\u0000';
        } else {
          text += source[i];
          i += 1;
        }
      }
      tokens.push({ kind: 'string', text, line: start }, ...inner);
      advance(i + 1);
    } else if (char === '/' && startsRegex(tokens)) {
      let i = at + 1;
      let inClass = false;
      while (i < source.length && source[i] !== '\n') {
        if (source[i] === '\\') i += 1;
        else if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        else if (source[i] === '/' && !inClass) break;
        i += 1;
      }
      i += 1;
      while (i < source.length && WORD.test(source[i] ?? '')) i += 1;
      advance(i);
    } else if (WORD.test(char)) {
      let i = at;
      while (i < source.length && WORD.test(source[i] ?? '')) i += 1;
      tokens.push({ kind: 'word', text: source.slice(at, i), line });
      advance(i);
    } else {
      tokens.push({ kind: 'punct', text: char, line });
      advance(at + 1);
    }
  }
  return tokens;
}
