/**
 * Every executable TypeScript file of the package is in its own type check.
 *
 * Bun runs a `.ts` file without checking it, so a script left out of
 * `tsconfig.json` drifts against the source it imports until it fails at run
 * time. Only consumer fixtures stay out: each is checked by its own lane
 * against the packed package, not against the source tree.
 */
import { expect, test } from 'bun:test';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from '@typescript/typescript6';

const PACKAGE = resolve(import.meta.dir, '..');
/** Consumer fixtures: type-checked by their lane against the packed package. */
const FIXTURE_ROOTS = [
  'scripts/consumer-lane/fixtures/',
  'scripts/consumer-lane/neutral-library/',
];

function* typescriptFiles(directory: string): Generator<string> {
  for (const name of readdirSync(directory)) {
    if (name === 'node_modules') continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) yield* typescriptFiles(path);
    else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) yield path;
  }
}

function checkedFiles(): Set<string> {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    join(PACKAGE, 'tsconfig.json'),
    undefined,
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      },
    },
  );
  if (!parsed) throw new Error('tsconfig.json did not parse');
  return new Set(parsed.fileNames.map((file) => relative(PACKAGE, file)));
}

test('every package script, at any depth, is in the package type check; fixtures are not', () => {
  const checked = checkedFiles();
  const scripts = [...typescriptFiles(join(PACKAGE, 'scripts'))].map((file) =>
    relative(PACKAGE, file),
  );
  const executable = scripts.filter(
    (file) => !FIXTURE_ROOTS.some((root) => file.startsWith(root)),
  );
  expect(executable.length).toBeGreaterThan(0);
  expect(executable.some((file) => file.startsWith('scripts/consumer-lane/'))).toBe(true);
  expect(executable.filter((file) => !checked.has(file))).toEqual([]);
  expect(scripts.filter((file) => checked.has(file) && !executable.includes(file))).toEqual(
    [],
  );
});
