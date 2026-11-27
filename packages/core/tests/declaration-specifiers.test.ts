import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import ts from '@typescript/typescript6';
import { declarationSpecifiers } from '../src/files/declaration-specifiers';

/** The same question asked of the compiler's parser: the oracle the tokenizer is held to. */
function parsedSpecifiers(file: string, source: string): string[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    let literal: ts.Node | undefined;
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      literal = node.moduleSpecifier;
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      literal = node.argument.literal;
    } else if (ts.isExternalModuleReference(node)) {
      literal = node.expression;
    } else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      literal = node.name;
    }
    if (literal && ts.isStringLiteral(literal)) {
      found.push(`${literal.getStart(parsed) + 1}:${literal.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found.sort();
}

function declarationFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...declarationFiles(path));
    else if (/\.d\.[cm]?ts$/.test(entry.name)) files.push(path);
  }
  return files;
}

describe('the modules a declaration file names', () => {
  test('a specifier is read by its position, never from a string, comment or template', () => {
    const source = [
      '/// <reference types="node" />',
      '/// <reference path="./ambient.d.ts" />',
      "type InString = \"import('./in-string')\"; // from './in-line-comment'",
      // A template literal type with a substitution, spelled in two parts so it stays plain text here.
      "type InTemplate = `from './in-template' $" +
        "{ { a: 'from' } extends infer X ? string : never } import('./after-substitution')`;",
      "/* import './in-block-comment' */",
      "export type { A } from './named';",
      "export * from './star';",
      "import './side-effect';",
      "export declare const typed: import('./typed').V;",
      "declare module './augmented' { }",
      "import required = require('./required');",
      "export declare const from: 'not-a-specifier';",
      "export interface Options { module: 'esm'; import: 'x' }",
    ].join('\n');
    const found = declarationSpecifiers(source);
    expect(found.map(({ kind, text }) => `${kind} ${text}`)).toEqual([
      'reference-types node',
      'reference-path ./ambient.d.ts',
      'module ./named',
      'module ./star',
      'module ./side-effect',
      'module ./typed',
      'module ./augmented',
      'module ./required',
    ]);
    // The offsets are the text between the quotes: what a rewrite replaces.
    for (const specifier of found) {
      expect(source.slice(specifier.start, specifier.end)).toBe(specifier.text);
    }
  });

  test('the tokenizer finds exactly what the compiler parser finds in real declarations', () => {
    const packages = ['zod', 'ky', '@typescript/typescript6'].map((name) =>
      realpathSync(join(import.meta.dir, '../node_modules', name)),
    );
    let files = 0;
    let specifiers = 0;
    const disagreements: string[] = [];
    for (const file of packages.flatMap(declarationFiles)) {
      const source = readFileSync(file, 'utf8');
      const expected = parsedSpecifiers(file, source);
      const actual = declarationSpecifiers(source)
        .filter((specifier) => specifier.kind === 'module')
        .map((specifier) => `${specifier.start}:${specifier.text}`)
        .sort();
      files += 1;
      specifiers += expected.length;
      if (actual.join('\n') !== expected.join('\n')) disagreements.push(file);
    }
    // The comparison is over a real corpus, not an empty one.
    expect(files).toBeGreaterThan(100);
    expect(specifiers).toBeGreaterThan(500);
    expect(disagreements).toEqual([]);
  });
});
