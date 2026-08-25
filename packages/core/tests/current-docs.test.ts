import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Glob } from 'bun';

const root = join(import.meta.dir, '../../..');
const currentFiles = [
  'README.md',
  'packages/core/README.md',
  'packages/create-stitchkit/README.md',
  'packages/create-stitchkit/template/README.md',
  'skills/stitchkit/SKILL.md',
];
const currentDirectories = [
  'docs/api',
  'docs/guide',
  'packages/create-stitchkit/template/docs',
];

function currentDocumentation(): Array<{ path: string; source: string }> {
  const paths = [...currentFiles];
  const glob = new Glob('**/*.md');
  for (const directory of currentDirectories) {
    for (const file of glob.scanSync({ cwd: join(root, directory), absolute: true })) {
      const path = relative(root, file);
      if (path === 'docs/guide/upgrading.md') continue;
      paths.push(path);
    }
  }
  return paths.map((path) => ({ path, source: readFileSync(join(root, path), 'utf8') }));
}

describe('current-facing documentation', () => {
  test('contains no removed split-ownership server lifecycle snippets', () => {
    const removedPatterns = [
      /rawRoutes:\s*\[\s*socket\.route\s*\]/,
      /socket:\s*socket\.route/,
      /server\.stop\(\)/,
      /await\s+socket\.io\.close\(\)/,
      /handle\.close\(\)/,
    ];
    const offenders: string[] = [];
    for (const document of currentDocumentation()) {
      if (removedPatterns.some((pattern) => pattern.test(document.source))) {
        offenders.push(document.path);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('does not publish a hardcoded test count', () => {
    const offenders = currentDocumentation()
      .filter((document) => /\b\d[\d,]* tests?\b/i.test(document.source))
      .map((document) => document.path);
    expect(offenders).toEqual([]);
  });
});

/**
 * The package README is a MIRROR of the root one, and mirrors get checked.
 *
 * `prepack` copies the root README into the package on every publish, so the
 * checked-in copy is generated content that happens to be tracked — and unlike
 * its two siblings from the same `prepack` (`llms.txt`, `llms-full.txt`, both
 * gitignored) nothing noticed when it drifted. CI compares only the PACKED copy,
 * which is produced from the root moments earlier and therefore always agrees;
 * the tracked one could sit stale indefinitely.
 */
test('the package README mirrors the root one byte for byte', () => {
  const source = readFileSync(join(root, 'README.md'), 'utf8');
  const mirrored = readFileSync(join(root, 'packages/core/README.md'), 'utf8');
  expect(mirrored).toBe(source);
});
