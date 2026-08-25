import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The repository ignores what its own template workspace produces.
 *
 * `packages/create-stitchkit/template` is not inert data — it is a working
 * project, and `bun run build`, `bun run e2e` and `bun run acceptance:local`
 * are run there. Every one of those writes output INTO the repository tree.
 *
 * The rules that hide that output are written in the template's `_gitignore`,
 * and git here never reads them: the file only becomes `.gitignore` after a
 * project is generated from it. So `test-results/` filled with Playwright
 * artifacts during a run and showed up as untracked repository content, a build
 * stamp was staged, and `*.log` was never covered at all — the root list had
 * `_.log`, which matches a file literally called `_.log`.
 *
 * One list, two readers. This asks git itself rather than comparing spellings,
 * because what matters is whether the path is ignored, not how it is written.
 */
const root = resolve(import.meta.dir, '..');
const templateDirectory = 'packages/create-stitchkit/template';

/** A path that the pattern must cover, for each pattern the template declares. */
function sampleFor(pattern: string): string {
  const bare = pattern.replace(/\/$/, '');
  if (bare.startsWith('*')) return `${templateDirectory}/artefact${bare.slice(1)}`;
  return pattern.endsWith('/')
    ? `${templateDirectory}/${bare}/artefact`
    : `${templateDirectory}/${bare}`;
}

function isIgnored(path: string): boolean {
  const child = Bun.spawnSync(['git', 'check-ignore', '--quiet', '--', path], { cwd: root });
  return child.exitCode === 0;
}

describe("the repository ignores its template workspace's output", () => {
  const patterns = readFileSync(resolve(root, templateDirectory, '_gitignore'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  test('the template declares rules to check', () => {
    expect(patterns.length).toBeGreaterThan(0);
  });

  test('every rule a generated project gets, this repository has too', () => {
    const uncovered = patterns.filter((pattern) => !isIgnored(sampleFor(pattern)));
    expect(uncovered).toEqual([]);
  });

  test('the checker can fail', () => {
    // Without this the test above would pass with `git check-ignore` broken,
    // missing, or answering 0 for everything.
    expect(isIgnored(`${templateDirectory}/package.json`)).toBeFalse();
  });
});
