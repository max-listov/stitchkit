/**
 * Size is a smell with a declared exception list, not a style preference.
 *
 * A closure of fifteen hundred lines holds its state where no test can reach a
 * part of it, so every test of it runs the whole thing; a file of two thousand
 * lines is read by nobody end to end. The limits are the repository's own
 * (a function of 200 lines, a file of 500), and what is over them is named in
 * `code-size-exceptions.json` with the reason it stays — so the list shrinks by
 * review, and a new offender is a red test rather than a slow drift.
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

const ExceptionsSchema = z.object({
  files: z.record(z.string(), z.string().min(10)),
  functions: z.record(z.string(), z.string().min(10)),
  /** Oversized tooling files, keyed by repository-relative path. */
  scriptFiles: z.record(z.string(), z.string().min(10)),
});

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

/** Files under `directory` longer than the file limit, as `directory`-relative paths. */
export function oversizedFiles(directory: string, pattern: RegExp): string[] {
  return [...sources(directory, pattern)]
    .filter((file) => lineCount(readFileSync(file, 'utf8')) > MAX_FILE_LINES)
    .map((file) => relative(directory, file));
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
  }
  return undefined;
}

/** Oversized functions and files of one source text, as `path` / `path#name` keys. */
export function oversized(
  path: string,
  text: string,
): { files: string[]; functions: Array<{ key: string; lines: number }> } {
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
  return { files: lineCount(text) > MAX_FILE_LINES ? [path] : [], functions };
}

const exceptions = ExceptionsSchema.parse(
  JSON.parse(readFileSync(`${import.meta.dir}/fixtures/code-size-exceptions.json`, 'utf8')),
);
const found = {
  files: [] as string[],
  functions: [] as Array<{ key: string; lines: number }>,
  scriptFiles: SCRIPT_ROOTS.flatMap((root) =>
    oversizedFiles(root, SCRIPT_SOURCE).map((file) => relative(REPOSITORY, join(root, file))),
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
    expect(found.files.filter((file) => !(file in exceptions.files))).toEqual([]);
  });

  test(`no script or fixture file over ${MAX_FILE_LINES} lines outside the declared exceptions`, () => {
    expect(found.scriptFiles.filter((file) => !(file in exceptions.scriptFiles))).toEqual([]);
  });

  test('every exception is still needed, so the list only shrinks by review', () => {
    const functionKeys = new Set(found.functions.map(({ key }) => key));
    expect(Object.keys(exceptions.functions).filter((key) => !functionKeys.has(key))).toEqual(
      [],
    );
    expect(
      Object.keys(exceptions.files).filter((file) => !found.files.includes(file)),
    ).toEqual([]);
    expect(
      Object.keys(exceptions.scriptFiles).filter((file) => !found.scriptFiles.includes(file)),
    ).toEqual([]);
  });

  test('a planted file of 501 lines is found and one of 500 is not (negative control)', () => {
    const directory = mkdtempSync(join(tmpdir(), 'stitchkit-size-'));
    try {
      const lines = (count: number) => `${Array(count).fill('export {};').join('\n')}\n`;
      writeFileSync(join(directory, 'at-limit.ts'), lines(MAX_FILE_LINES));
      writeFileSync(join(directory, 'over-limit.mjs'), lines(MAX_FILE_LINES + 1));
      writeFileSync(join(directory, 'over-limit.json'), lines(MAX_FILE_LINES + 1));
      expect(oversizedFiles(directory, SCRIPT_SOURCE)).toEqual(['over-limit.mjs']);
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
    expect(result.files).toEqual(['synthetic.ts']);
    expect(result.functions.map(({ key }) => key)).toEqual(['synthetic.ts#huge']);
  });
});
