import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** A package doc sync is a no-op when bytes agree, preserving input generation. */
export async function syncPackageReadme(root = join(import.meta.dir, '..')) {
  const source = await readFile(join(root, 'README.md'));
  const target = join(root, 'packages/core/README.md');
  let current: Buffer | undefined;
  try {
    current = await readFile(target);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  if (!current?.equals(source)) await writeFile(target, source);
}

if (import.meta.main) await syncPackageReadme();
