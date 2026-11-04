import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli';

const created: string[] = [];

afterEach(async () => {
  await Promise.all(
    created.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function placeholderFiles(directory: string): Promise<string[]> {
  const matches: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) matches.push(...(await placeholderFiles(path)));
    else if ((await readFile(path)).includes('@app/')) matches.push(path);
  }
  return matches;
}

for (const example of [undefined, 'repository']) {
  test(`the CLI materialises the project scope throughout ${example ?? 'blank'} files`, async () => {
    const parent = await mkdtemp(join(tmpdir(), 'stitchkit-package-scope-'));
    created.push(parent);
    const destination = join(parent, 'demo-shop');
    const args = [destination, '--no-install'];
    if (example) args.push('--example', example);
    expect(await run(args)).toBe(0);
    expect(await placeholderFiles(destination)).toEqual([]);
    for (const name of ['backend', 'frontend', 'shared', 'db', 'config']) {
      expect(
        JSON.parse(await readFile(join(destination, 'packages', name, 'package.json'), 'utf8'))
          .name,
      ).toBe(`@demo-shop/${name}`);
    }
    const lockfile = await readFile(join(destination, 'bun.lock'), 'utf8');
    expect(lockfile).toContain('"@demo-shop/shared"');
    expect(lockfile).toContain('"@demo-shop/config"');
    const rootManifest = JSON.parse(await readFile(join(destination, 'package.json'), 'utf8'));
    expect(rootManifest.scripts['db:generate']).toContain('--filter @demo-shop/db');
    expect(rootManifest.scripts.build).toContain('--filter @demo-shop/backend');
    const dependency = example
      ? 'packages/backend/src/transport/repository-service.ts'
      : 'packages/backend/src/surface.ts';
    expect(await readFile(join(destination, dependency), 'utf8')).toContain('@demo-shop/');
  });
}
