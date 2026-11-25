import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { builtByVerify, VERIFY_BUILT_ENV } from './lane-build';
import { PROFILES, splitProfile } from './verify-profiles';

const root = join(import.meta.dir, '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

test('only the verify run that built the tree lets a lane skip its build', () => {
  expect(builtByVerify({})).toBe(false);
  expect(builtByVerify({ [VERIFY_BUILT_ENV]: '0' })).toBe(false);
  expect(builtByVerify({ [VERIFY_BUILT_ENV]: '1' })).toBe(true);
});

test('a lane never reads the presence of dist as proof that the tree was built', () => {
  // A `dist` from an earlier run belongs to an earlier tree. The head profile has no build
  // step at all, so a lane that skipped on an existing `dist` certified code it never built.
  for (const lane of ['scripts/starter-lane.ts', 'scripts/supervised-lane.ts']) {
    const source = read(lane);
    expect(source, lane).toContain('builtByVerify(');
    expect(source, lane).not.toMatch(/dist\/[\w/.-]+'\)\)\.exists\(\)/);
  }
});

test('verify tells its lanes it built the tree only after its own build step', () => {
  const verify = read('scripts/verify.ts');
  expect(verify).toContain("if (step === 'build') process.env[VERIFY_BUILT_ENV] = '1';");
  // The head profile runs lanes without a sequential build: nothing sets the flag there.
  expect(splitProfile(PROFILES.head.steps).sequential).not.toContain('build');
  expect(splitProfile(PROFILES.full.steps).sequential).toContain('build');
});

test('the README the package ships is the README the repository shows', () => {
  // Lanes pack with `--ignore-scripts`, so the copy `prepack` would refresh is the committed one.
  expect(read('packages/core/README.md')).toBe(read('README.md'));
});
