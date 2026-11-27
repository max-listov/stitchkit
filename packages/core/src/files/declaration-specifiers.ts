/**
 * Every module a declaration file names.
 *
 * A declaration tree is resolved again by each consumer, under that consumer's
 * module resolution, so what it names has to be checked and sometimes rewritten
 * after the compiler emitted it. The compiler's own parser is not a stable API
 * across its major versions, and a declaration file does not need one: the
 * places a module can be named are few and positional — `from '…'`,
 * `import '…'`, `import('…')`, `require('…')`, `declare module '…'` and the
 * `/// <reference … />` directives. So this is a tokenizer that knows strings,
 * comments and template literal types, and reads a specifier by what precedes
 * it. Text that merely looks like an import inside a string type, a comment or a
 * template is not a token and is never reported.
 *
 * The rewrite of a declaration tree lives here too, once: the client package
 * build and this package's own build both make relative specifiers name the
 * `.js` file a declaration stands for.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** One module named by a declaration file. `start`–`end` is the specifier text between its quotes. */
export interface DeclarationSpecifier {
  /** How it is named: an import or export, or a `/// <reference path|types>` directive. */
  kind: 'module' | 'reference-path' | 'reference-types';
  text: string;
  start: number;
  end: number;
}

interface Token {
  kind: 'word' | 'string' | 'punctuation';
  text: string;
  start: number;
  end: number;
}

const REFERENCE = /^\/\/\/\s*<reference\s+(path|types)\s*=\s*(["'])([^"']*)\2/;

/** Split declaration source into tokens, reporting reference directives on the way. */
function tokenize(source: string, references: DeclarationSpecifier[]): Token[] {
  const tokens: Token[] = [];
  // Brace depth at which each open `${` of a template literal started.
  const substitutions: number[] = [];
  let braces = 0;
  let index = 0;

  /** Consume template text up to its closing backtick or the next `${`. */
  const readTemplate = (): void => {
    while (index < source.length) {
      const char = source[index];
      if (char === '\\') {
        index += 2;
      } else if (char === '`') {
        index += 1;
        return;
      } else if (char === '$' && source[index + 1] === '{') {
        index += 2;
        substitutions.push(braces);
        braces += 1;
        return;
      } else {
        index += 1;
      }
    }
  };

  const readLineComment = (): void => {
    const lineEnd = source.indexOf('\n', index);
    const end = lineEnd === -1 ? source.length : lineEnd;
    const match = REFERENCE.exec(source.slice(index, end));
    if (match) {
      const text = match[3] ?? '';
      const start = index + match[0].length - 1 - text.length;
      references.push({
        kind: match[1] === 'path' ? 'reference-path' : 'reference-types',
        text,
        start,
        end: start + text.length,
      });
    }
    index = end;
  };

  const readString = (quote: string): void => {
    const start = index;
    index += 1;
    let text = '';
    while (index < source.length && source[index] !== quote) {
      if (source[index] === '\\') {
        text += source[index + 1] ?? '';
        index += 2;
      } else {
        text += source[index];
        index += 1;
      }
    }
    index += 1;
    tokens.push({ kind: 'string', text, start, end: index });
  };

  while (index < source.length) {
    const char = source[index] ?? '';
    if (char === '/' && source[index + 1] === '/') {
      readLineComment();
    } else if (char === '/' && source[index + 1] === '*') {
      const close = source.indexOf('*/', index + 2);
      index = close === -1 ? source.length : close + 2;
    } else if (char === '"' || char === "'") {
      readString(char);
    } else if (char === '`') {
      index += 1;
      readTemplate();
      tokens.push({ kind: 'punctuation', text: '`', start: index, end: index });
    } else if (char === '{') {
      braces += 1;
      index += 1;
      tokens.push({ kind: 'punctuation', text: char, start: index - 1, end: index });
    } else if (char === '}') {
      braces -= 1;
      index += 1;
      // The brace that closes a `${` hands control back to the template text.
      if (substitutions.at(-1) === braces) {
        substitutions.pop();
        readTemplate();
      }
      tokens.push({ kind: 'punctuation', text: char, start: index - 1, end: index });
    } else if (/[A-Za-z_$]/.test(char)) {
      const start = index;
      while (index < source.length && /[\w$]/.test(source[index] ?? '')) index += 1;
      tokens.push({ kind: 'word', text: source.slice(start, index), start, end: index });
    } else if (/\s/.test(char)) {
      index += 1;
    } else {
      tokens.push({ kind: 'punctuation', text: char, start: index, end: index + 1 });
      index += 1;
    }
  }
  return tokens;
}

/** Whether the string token at `position` stands where a module specifier stands. */
function isModuleSpecifier(tokens: readonly Token[], position: number): boolean {
  const before = tokens[position - 1];
  const earlier = tokens[position - 2];
  if (before?.kind === 'word') {
    if (before.text === 'from' || before.text === 'import') return true;
    return before.text === 'module' && earlier?.kind === 'word' && earlier.text === 'declare';
  }
  return (
    before?.text === '(' &&
    earlier?.kind === 'word' &&
    (earlier.text === 'import' || earlier.text === 'require')
  );
}

/** Every module specifier and reference directive in one declaration file, in source order. */
export function declarationSpecifiers(source: string): DeclarationSpecifier[] {
  const found: DeclarationSpecifier[] = [];
  const tokens = tokenize(source, found);
  tokens.forEach((token, position) => {
    if (token.kind !== 'string' || !isModuleSpecifier(tokens, position)) return;
    found.push({
      kind: 'module',
      text: token.text,
      start: token.start + 1,
      end: token.end - 1,
    });
  });
  return found.sort((left, right) => left.start - right.start);
}

/** Whether a specifier is relative to the file that names it. */
export function isRelativeSpecifier(specifier: string): boolean {
  return /^\.\.?(?:\/|$)/.test(specifier);
}

/** Source or output extension of a relative specifier → the output it names and its declaration. */
const EXTENSIONS: readonly (readonly [string, string, string])[] = [
  ['.ts', '.js', '.d.ts'],
  ['.tsx', '.js', '.d.ts'],
  ['.mts', '.mjs', '.d.mts'],
  ['.cts', '.cjs', '.d.cts'],
  ['.js', '.js', '.d.ts'],
  ['.jsx', '.js', '.d.ts'],
  ['.mjs', '.mjs', '.d.mts'],
  ['.cjs', '.cjs', '.d.cts'],
];

/**
 * The specifier of the JavaScript file a relative declaration import stands
 * for, resolved against the emitted tree `file` is part of: `./x` and `./x.ts`
 * become `./x.js`, a directory becomes its `index.js`. `undefined` when the
 * tree holds no declaration for it.
 */
export function declarationOutputSpecifier(
  file: string,
  specifier: string,
): string | undefined {
  const target = resolve(dirname(file), specifier);
  for (const [extension, output, declaration] of EXTENSIONS) {
    if (!specifier.endsWith(extension)) continue;
    const stem = target.slice(0, -extension.length);
    if (existsSync(`${stem}${declaration}`)) {
      return `${specifier.slice(0, -extension.length)}${output}`;
    }
  }
  if (existsSync(`${target}.d.ts`)) return `${specifier}.js`;
  if (existsSync(join(target, 'index.d.ts')))
    return `${specifier.replace(/\/$/, '')}/index.js`;
  return undefined;
}

function declarationFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...declarationFiles(path));
    else if (/\.d\.[cm]?ts$/.test(entry.name)) files.push(path);
  }
  return files.sort();
}

/**
 * Rewrite a declaration tree in place. `rewrite` sees every specifier of
 * every declaration file and returns the text it should carry, or `undefined`
 * to leave it; it refuses a specifier by throwing. Returns how many files and
 * specifiers changed.
 */
export function rewriteDeclarationTree(
  directory: string,
  rewrite: (specifier: DeclarationSpecifier, file: string) => string | undefined,
): { files: number; specifiers: number } {
  let files = 0;
  let specifiers = 0;
  for (const file of declarationFiles(directory)) {
    const source = readFileSync(file, 'utf8');
    let output = source;
    let changed = 0;
    // Last first: an earlier offset stays valid while later text changes length.
    for (const specifier of declarationSpecifiers(source).reverse()) {
      const text = rewrite(specifier, file);
      if (text === undefined || text === specifier.text) continue;
      output = `${output.slice(0, specifier.start)}${text}${output.slice(specifier.end)}`;
      changed += 1;
    }
    if (changed === 0) continue;
    writeFileSync(file, output);
    files += 1;
    specifiers += changed;
  }
  return { files, specifiers };
}
