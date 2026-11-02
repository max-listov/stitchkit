import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertNoFixtureInBuild } from './fixture-boundary';

async function buildWith(content: string | undefined): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fixture-boundary-'));
  if (content !== undefined) {
    await mkdir(join(root, '.next/server/app'), { recursive: true });
    await writeFile(join(root, '.next/server/app/page.js'), content);
  }
  return root;
}

describe('assertNoFixtureInBuild', () => {
  test('a clean build passes', async () => {
    const root = await buildWith('export const page = 1');
    await assertNoFixtureInBuild(root);
    await rm(root, { recursive: true });
  });

  test('a build that carries the fixture is named', async () => {
    const root = await buildWith('const m = "stitchkit-admin-fixture"');
    await expect(assertNoFixtureInBuild(root)).rejects.toThrow('.next/server/app/page.js');
    await rm(root, { recursive: true });
  });

  test('a build with no files is not a clean build', async () => {
    const root = await buildWith(undefined);
    await expect(assertNoFixtureInBuild(root)).rejects.toThrow('no built files');
    await rm(root, { recursive: true });
  });
});
