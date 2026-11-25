import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * The four files `starterHeadDecision` reads, for a scratch repository that stands in for this
 * one: an additive core release, so the decision is `'run'` unless a test records a review. A core
 * or starter manifest the scratch repository already carries is kept, and the changelog and the
 * starter target are written to match the core version.
 */
export async function writeStarterHeadFixture(root: string): Promise<void> {
  const manifest = join(root, 'packages/core/package.json');
  await mkdir(join(root, 'packages/core'), { recursive: true });
  await mkdir(join(root, 'packages/create-stitchkit/template'), { recursive: true });
  if (!existsSync(manifest)) await writeFile(manifest, JSON.stringify({ version: '1.0.0' }));
  const starterManifest = join(root, 'packages/create-stitchkit/package.json');
  if (!existsSync(starterManifest)) {
    await writeFile(starterManifest, JSON.stringify({ version: '0.1.0' }));
  }
  const { version } = z
    .object({ version: z.string() })
    .parse(JSON.parse(await readFile(manifest, 'utf8')));
  await writeFile(
    join(root, 'packages/create-stitchkit/template/package.json'),
    JSON.stringify({ catalog: { stitchkit: `^${version}` } }),
  );
  await writeFile(
    join(root, 'CHANGELOG.md'),
    [
      `## [${version}] - 2026-01-01`,
      '',
      '### Added',
      '',
      '- A feature that adds one more public name.',
      '',
    ].join('\n'),
  );
}
