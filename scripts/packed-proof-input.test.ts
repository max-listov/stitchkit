import { expect, test } from 'bun:test';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('packed proof refuses source directories, including symlinked directories, before install', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packed-proof-input-'));
  try {
    const source = resolve(import.meta.dir, '../packages/core');
    const linked = join(root, 'directory.tgz');
    await symlink(source, linked);
    for (const artifact of [source, linked]) {
      const result = Bun.spawnSync(
        [
          'bun',
          resolve(source, 'scripts/consumer-lane/run-packed-proof.mjs'),
          artifact,
          'public-declarations',
        ],
        { stdout: 'pipe', stderr: 'pipe', timeout: 5_000 },
      );
      expect(result.exitCode).not.toBe(0);
      expect(new TextDecoder().decode(result.stderr)).toContain(
        'existing absolute archive file',
      );
      expect(new TextDecoder().decode(result.stdout)).not.toContain(': ok');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
