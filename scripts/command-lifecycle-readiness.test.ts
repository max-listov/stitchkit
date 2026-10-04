import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const fixture = join(
  import.meta.dir,
  '../packages/core/scripts/consumer-lane/fixtures/minimal/src/command-lifecycle.mjs',
);
// The executable JS consumer fixture is an untyped boundary, validated here.
const { verifyBlockedGroup } = z
  .object({
    verifyBlockedGroup: z.custom<(root: string, delayMs: number) => Promise<void>>(
      (value) => typeof value === 'function',
    ),
  })
  .parse(await import(fixture));

test('helper readiness follows its actual first write after a slow startup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stitchkit-helper-readiness-'));
  try {
    await verifyBlockedGroup(root, 400);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('helper that never becomes ready fails at the bounded command deadline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stitchkit-helper-unready-'));
  try {
    await expect(verifyBlockedGroup(root, 4000)).rejects.toThrow('Command deadline exceeded');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 5000);
