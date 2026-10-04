import { cp, mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** A source runner still needs its owning package scope and private import assets. */
export async function copyCoreSourceFixture(root: string): Promise<void> {
  const source = fileURLToPath(new URL('../packages/core/', import.meta.url));
  const target = join(root, 'packages/core');
  const manifest = z
    .object({ imports: z.record(z.string(), z.string()) })
    .parse(JSON.parse(await readFile(join(source, 'package.json'), 'utf8')));
  await mkdir(target, { recursive: true });
  for (const relative of ['src', 'package.json', ...Object.values(manifest.imports)]) {
    await cp(join(source, relative), join(target, relative), { recursive: true });
  }
  try {
    await stat(join(source, 'native'));
  } catch (cause) {
    if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return;
    throw cause;
  }
  await cp(join(source, 'native'), join(target, 'native'), { recursive: true });
}
