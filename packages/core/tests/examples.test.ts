/**
 * An example is documentation that cannot rot: a guide links it, a test runs
 * it, and the typecheck compiles it. A file here that no guide links is a
 * vestige nobody reads; one that no test imports is a code block with a `.ts`
 * extension, and it rots exactly like one. (The first sweep removed an example
 * that was only a re-export of an entrypoint, linked from nowhere.)
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const CORE = resolve(import.meta.dir, '..');
const EXAMPLES = join(CORE, 'examples');
const GUIDES = resolve(CORE, '../../docs/guide');

function* files(dir: string, pattern: RegExp): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path, pattern);
    else if (pattern.test(name)) yield path;
  }
}

/** Examples that a guide does not link or a test does not import. */
export function orphanedExamples(
  examples: readonly string[],
  guides: string,
  tests: string,
): string[] {
  return examples.flatMap((example) => {
    const problems: string[] = [];
    if (!guides.includes(`packages/core/examples/${example}`)) {
      problems.push(`${example}: no guide links it`);
    }
    if (!tests.includes(`../examples/${example.replace(/\.ts$/, '')}'`)) {
      problems.push(`${example}: no test imports it`);
    }
    return problems;
  });
}

const examples = [...files(EXAMPLES, /\.ts$/)].map((file) => relative(EXAMPLES, file)).sort();
const guides = [...files(GUIDES, /\.md$/)]
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');
const tests = [...files(import.meta.dir, /\.test\.ts$/)]
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');

describe('examples', () => {
  test('every example is linked from a guide and run by a test', () => {
    expect(examples.length).toBeGreaterThan(0);
    expect(orphanedExamples(examples, guides, tests)).toEqual([]);
  });

  test('an unlinked, untested example is refused (negative control)', () => {
    expect(orphanedExamples(['tools/nothing.ts'], guides, tests)).toEqual([
      'tools/nothing.ts: no guide links it',
      'tools/nothing.ts: no test imports it',
    ]);
  });
});
