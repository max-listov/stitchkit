import { copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function ensureLocalEnvironment(root: string): Promise<void> {
  const destination = resolve(root, '.env');
  if (await Bun.file(destination).exists()) return;
  await copyFile(resolve(root, '_env'), destination);
}

if (import.meta.main) {
  await ensureLocalEnvironment(resolve(import.meta.dir, '..'));
}
