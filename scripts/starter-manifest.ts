import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function parseManifest(source: string, path: string): object {
  const manifest: unknown = JSON.parse(source);
  if (typeof manifest !== 'object' || manifest === null) {
    throw new Error(`Package manifest must be an object: ${path}`);
  }
  return manifest;
}

export async function readStarterStitchkitTarget(root: string): Promise<string> {
  const path = join(root, 'package.json');
  const manifest = parseManifest(await readFile(path, 'utf8'), path);
  if (!('catalog' in manifest) || typeof manifest.catalog !== 'object' || !manifest.catalog) {
    throw new Error(`Starter catalog is missing: ${path}`);
  }
  if (
    !('stitchkit' in manifest.catalog) ||
    typeof manifest.catalog.stitchkit !== 'string' ||
    !manifest.catalog.stitchkit
  ) {
    throw new Error(`Starter Stitchkit catalog target is missing: ${path}`);
  }
  return manifest.catalog.stitchkit;
}

export async function writeStarterStitchkitTarget(
  root: string,
  target: string,
): Promise<void> {
  const path = join(root, 'package.json');
  const manifest = parseManifest(await readFile(path, 'utf8'), path);
  if (!('catalog' in manifest) || typeof manifest.catalog !== 'object' || !manifest.catalog) {
    throw new Error(`Starter catalog is missing: ${path}`);
  }
  await writeFile(
    path,
    `${JSON.stringify(
      { ...manifest, catalog: { ...manifest.catalog, stitchkit: target } },
      null,
      2,
    )}\n`,
  );
}
