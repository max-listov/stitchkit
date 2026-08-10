import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findNeutralIdentity } from './neutral-identity';

describe('neutral identity sweep', () => {
  test('reports every marker outside the allowlist and stays silent inside it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sk-identity-'));
    try {
      await mkdir(join(root, 'docs'));
      await mkdir(join(root, 'node_modules/dep'), { recursive: true });
      await writeFile(join(root, 'bun.lock'), '{"name": "stitchkit-starter"}');
      await writeFile(join(root, 'docs/readme.md'), '# Stitchkit Starter guide');
      await writeFile(join(root, 'ok.ts'), 'export const name = "acme";');
      await writeFile(join(root, 'db.txt'), 'postgresql://x/stitchkit_starter');
      await writeFile(join(root, 'node_modules/dep/skip.md'), 'Stitchkit Starter');
      const offenders = await findNeutralIdentity(root, ['bun.lock']);
      expect(offenders).toEqual([
        'db.txt — stitchkit_starter',
        'docs/readme.md — Stitchkit Starter',
      ]);
      expect(
        await findNeutralIdentity(root, ['bun.lock', 'db.txt', 'docs/readme.md']),
      ).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
