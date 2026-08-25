import { readdir, readFile, writeFile } from 'node:fs/promises';
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

/**
 * Every section a manifest can pin a dependency in — including the two the
 * first version of this scan forgot, which is how "every place" became a
 * promise the code did not keep.
 */
const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
  'overrides',
  'resolutions',
] as const;

/**
 * Every `stitchkit` range inside one dependency section, at any depth.
 *
 * `overrides` and `resolutions` nest: `{ overrides: { "some-package": {
 * "stitchkit": "0.58.0" } } }` pins the range for one dependency's subtree and
 * is invisible to a scan that reads only the section's own keys. That is a
 * second number able to disagree with the catalog, which is the whole thing
 * this file exists to prevent — so the walk goes all the way down.
 */
function rangesWithin(block: unknown, found: string[]): void {
  if (typeof block !== 'object' || block === null) return;
  for (const [name, value] of Object.entries(block)) {
    if (name === 'stitchkit' && typeof value === 'string') found.push(value);
    else rangesWithin(value, found);
  }
}

/**
 * Every place a manifest could name the Stitchkit range, ignoring the catalog
 * block itself — which is the one place allowed to hold the number.
 */
export function pinnedStitchkitRanges(manifest: unknown): string[] {
  const found: string[] = [];
  for (const section of DEPENDENCY_SECTIONS) {
    const block =
      typeof manifest === 'object' && manifest !== null
        ? Reflect.get(manifest, section)
        : undefined;
    rangesWithin(block, found);
  }
  return found;
}

/**
 * The catalog is the ONLY place that names the range — checked over every
 * manifest in the tree, not over a list written by hand.
 *
 * The rule matters because a starter release moves one number, and a copy of it
 * anywhere else is a second number that can disagree. What made this a gate
 * rather than a convention: a plain `bun update --latest` rewrites `catalog:`
 * into a literal range in every manifest at once, silently — and the check that
 * existed named three manifests out of six, so the two most recent ones were
 * not covered at all.
 */
export async function assertCatalogIsTheOnlyStitchkitRange(root: string): Promise<void> {
  const manifests = ['package.json'];
  try {
    for (const entry of await readdir(join(root, 'packages'))) {
      manifests.push(join('packages', entry, 'package.json'));
    }
  } catch {
    // A tree with no `packages/` directory is checked at its root alone.
  }
  for (const relative of manifests) {
    const path = join(root, relative);
    let source: string;
    try {
      source = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    for (const range of pinnedStitchkitRanges(parseManifest(source, path))) {
      if (range === 'catalog:') continue;
      throw new Error(
        `${relative} names the Stitchkit range directly as "${range}". Only catalog.stitchkit may hold it; every dependency entry says "catalog:".`,
      );
    }
  }
}
