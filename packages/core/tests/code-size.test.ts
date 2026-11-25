/**
 * Size is a smell with a declared exception list, not a style preference.
 *
 * A closure of fifteen hundred lines holds its state where no test can reach a
 * part of it, so every test of it runs the whole thing; a file of two thousand
 * lines is read by nobody end to end. The limits are the repository's own
 * (a function of 200 lines, a file of 500), and what is over them is named in
 * `code-size-exceptions.json` with the reason it stays and the line ceiling it
 * may not pass — so the list shrinks by review, an exception cannot keep growing
 * behind its entry, and a new offender is a red test rather than a slow drift.
 */
import { describe, expect, test } from 'bun:test';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import ts from '@typescript/typescript6';
import { z } from 'zod';

const SRC = resolve(import.meta.dir, '../src');
const REPOSITORY = resolve(import.meta.dir, '../../..');
/** Tooling roots: the repository scripts and the core package's own scripts and fixtures. */
const SCRIPT_ROOTS = [join(REPOSITORY, 'scripts'), join(REPOSITORY, 'packages/core/scripts')];
export const MAX_FUNCTION_LINES = 200;
export const MAX_FILE_LINES = 500;

/** One reviewed exception: why it stays over the limit, and the size it may not pass. */
const ExceptionSchema = z.strictObject({
  maxLines: z.number().int().positive(),
  reason: z.string().min(10),
});
type Exception = z.infer<typeof ExceptionSchema>;

const ExceptionsSchema = z.strictObject({
  files: z.record(z.string(), ExceptionSchema),
  functions: z.record(z.string(), ExceptionSchema),
  /** Oversized tooling files, keyed by repository-relative path. */
  scriptFiles: z.record(z.string(), ExceptionSchema),
  /** Oversized tooling functions, keyed by repository-relative `path#name`. */
  scriptFunctions: z.record(z.string(), ExceptionSchema),
});

/** Exceptions whose measured size passed their reviewed ceiling, as `key (lines > maxLines)`. */
export function overCeiling(
  measured: ReadonlyArray<{ key: string; lines: number }>,
  declared: Readonly<Record<string, Exception>>,
): string[] {
  return measured.flatMap(({ key, lines }) => {
    const exception = declared[key];
    return exception && lines > exception.maxLines
      ? [`${key} (${lines} > ${exception.maxLines})`]
      : [];
  });
}

function* sources(dir: string, pattern = /\.tsx?$/): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path, pattern);
    else if (pattern.test(name) && !name.endsWith('.d.ts')) yield path;
  }
}

const SCRIPT_SOURCE = /\.(tsx?|mjs|cjs|js)$/;

/** Lines of a text: a final newline ends the last line rather than starting another. */
export function lineCount(text: string): number {
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
}

/** Files under `directory` longer than the file limit, keyed by `directory`-relative path. */
export function oversizedFiles(
  directory: string,
  pattern: RegExp,
): Array<{ key: string; lines: number }> {
  return [...sources(directory, pattern)].flatMap((file) => {
    const lines = lineCount(readFileSync(file, 'utf8'));
    return lines > MAX_FILE_LINES ? [{ key: relative(directory, file), lines }] : [];
  });
}

function functionName(node: ts.Node): string | undefined {
  if (
    (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
    node.name &&
    ts.isIdentifier(node.name)
  ) {
    return node.name.text;
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name))
      return parent.name.text;
    if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name))
      return parent.name.text;
    // A callback has no name of its own — `describe('x', () => …)`, `items.map((item) => …)` —
    // so it is named by the call it is passed to and, when there is one, that call's label.
    if (
      ts.isCallExpression(parent) &&
      parent.arguments.some((argument) => argument === node)
    ) {
      const label = parent.arguments[0];
      const callee = parent.expression.getText();
      return label && ts.isStringLiteralLike(label)
        ? `${callee}(${label.text})`
        : `${callee}(…)`;
    }
  }
  return undefined;
}

/** Oversized functions and files of one source text, as `path` / `path#name` keys. */
export function oversized(
  path: string,
  text: string,
): {
  files: Array<{ key: string; lines: number }>;
  functions: Array<{ key: string; lines: number }>;
} {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const lineOf = (position: number) => source.getLineAndCharacterOfPosition(position).line;
  const functions: Array<{ key: string; lines: number }> = [];
  const visit = (node: ts.Node): void => {
    const name = functionName(node);
    if (name !== undefined) {
      const lines = lineOf(node.getEnd()) - lineOf(node.getStart(source)) + 1;
      if (lines > MAX_FUNCTION_LINES) functions.push({ key: `${path}#${name}`, lines });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const lines = lineCount(text);
  return { files: lines > MAX_FILE_LINES ? [{ key: path, lines }] : [], functions };
}

const exceptions = ExceptionsSchema.parse(
  JSON.parse(readFileSync(`${import.meta.dir}/fixtures/code-size-exceptions.json`, 'utf8')),
);
const found = {
  files: [] as Array<{ key: string; lines: number }>,
  functions: [] as Array<{ key: string; lines: number }>,
  scriptFiles: SCRIPT_ROOTS.flatMap((root) =>
    oversizedFiles(root, SCRIPT_SOURCE).map(({ key, lines }) => ({
      key: relative(REPOSITORY, join(root, key)),
      lines,
    })),
  ),
  scriptFunctions: SCRIPT_ROOTS.flatMap((root) =>
    [...sources(root, SCRIPT_SOURCE)].flatMap(
      (file) => oversized(relative(REPOSITORY, file), readFileSync(file, 'utf8')).functions,
    ),
  ),
};
for (const file of sources(SRC)) {
  const result = oversized(relative(SRC, file), readFileSync(file, 'utf8'));
  found.files.push(...result.files);
  found.functions.push(...result.functions);
}

describe('code size', () => {
  test(`no function over ${MAX_FUNCTION_LINES} lines outside the declared exceptions`, () => {
    expect(
      found.functions
        .filter(({ key }) => !(key in exceptions.functions))
        .map(({ key, lines }) => `${key} (${lines} lines)`),
    ).toEqual([]);
  });

  test(`no file over ${MAX_FILE_LINES} lines outside the declared exceptions`, () => {
    expect(
      found.files.filter(({ key }) => !(key in exceptions.files)).map(({ key }) => key),
    ).toEqual([]);
  });

  test(`no script or fixture function over ${MAX_FUNCTION_LINES} lines outside the declared exceptions`, () => {
    expect(
      found.scriptFunctions
        .filter(({ key }) => !(key in exceptions.scriptFunctions))
        .map(({ key, lines }) => `${key} (${lines} lines)`),
    ).toEqual([]);
  });

  test(`no script or fixture file over ${MAX_FILE_LINES} lines outside the declared exceptions`, () => {
    expect(
      found.scriptFiles
        .filter(({ key }) => !(key in exceptions.scriptFiles))
        .map(({ key }) => key),
    ).toEqual([]);
  });

  test('no exception grows past its reviewed ceiling', () => {
    expect([
      ...overCeiling(found.functions, exceptions.functions),
      ...overCeiling(found.files, exceptions.files),
      ...overCeiling(found.scriptFiles, exceptions.scriptFiles),
      ...overCeiling(found.scriptFunctions, exceptions.scriptFunctions),
    ]).toEqual([]);
  });

  test('every exception is still needed, so the list only shrinks by review', () => {
    const unused = (
      measured: ReadonlyArray<{ key: string }>,
      declared: Readonly<Record<string, Exception>>,
    ): string[] => {
      const keys = new Set(measured.map(({ key }) => key));
      return Object.keys(declared).filter((key) => !keys.has(key));
    };
    expect(unused(found.functions, exceptions.functions)).toEqual([]);
    expect(unused(found.files, exceptions.files)).toEqual([]);
    expect(unused(found.scriptFiles, exceptions.scriptFiles)).toEqual([]);
    expect(unused(found.scriptFunctions, exceptions.scriptFunctions)).toEqual([]);
  });

  test('an exception one line over its ceiling is reported and one at it is not (negative control)', () => {
    const declared = { 'a.ts': { maxLines: 600, reason: 'a reviewed exception' } };
    expect(overCeiling([{ key: 'a.ts', lines: 600 }], declared)).toEqual([]);
    expect(overCeiling([{ key: 'a.ts', lines: 601 }], declared)).toEqual(['a.ts (601 > 600)']);
    expect(overCeiling([{ key: 'b.ts', lines: 9_999 }], declared)).toEqual([]);
  });

  test('a planted file of 501 lines is found and one of 500 is not (negative control)', () => {
    const directory = mkdtempSync(join(tmpdir(), 'stitchkit-size-'));
    try {
      const lines = (count: number) => `${Array(count).fill('export {};').join('\n')}\n`;
      writeFileSync(join(directory, 'at-limit.ts'), lines(MAX_FILE_LINES));
      writeFileSync(join(directory, 'over-limit.mjs'), lines(MAX_FILE_LINES + 1));
      writeFileSync(join(directory, 'over-limit.json'), lines(MAX_FILE_LINES + 1));
      expect(oversizedFiles(directory, SCRIPT_SOURCE)).toEqual([
        { key: 'over-limit.mjs', lines: MAX_FILE_LINES + 1 },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('an oversized function and file are found (negative control)', () => {
    const body = Array.from(
      { length: MAX_FUNCTION_LINES + 5 },
      (_, index) => `  const a${index} = ${index};`,
    );
    const text = [
      'export function huge() {',
      ...body,
      '}',
      ...Array(MAX_FILE_LINES).fill(''),
    ].join('\n');
    const result = oversized('synthetic.ts', text);
    expect(result.files.map(({ key }) => key)).toEqual(['synthetic.ts']);
    expect(result.functions.map(({ key }) => key)).toEqual(['synthetic.ts#huge']);
  });

  test('an oversized callback is found by the call it is passed to (negative control)', () => {
    const body = Array.from(
      { length: MAX_FUNCTION_LINES + 5 },
      (_, index) => `  test('t${index}', () => {});`,
    );
    const short = 'items.map((item) => item);';
    const text = [`describe('a suite', () => {`, ...body, '});', short].join('\n');
    expect(oversized('synthetic.test.ts', text).functions.map(({ key }) => key)).toEqual([
      'synthetic.test.ts#describe(a suite)',
    ]);
    const unlabelled = ['items.forEach((item) => {', ...body, '});'].join('\n');
    expect(oversized('synthetic.ts', unlabelled).functions.map(({ key }) => key)).toEqual([
      'synthetic.ts#items.forEach(…)',
    ]);
  });
});
