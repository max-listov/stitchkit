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

/** The four sections a template manifest may name `stitchkit` in directly. */
const RESTORABLE_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

export interface RestoredReference {
  manifest: string;
  section: string;
  was: string;
}

/**
 * Put every dissolved `"stitchkit": "catalog:"` reference back.
 *
 * `bun update` rewrites a catalog reference into the literal range it resolved
 * to — `--latest` did it in all six manifests at once. The invariant survives
 * because a gate catches it, but the gate is a full lane away and the repair is
 * a manual revert nobody thinks to make. Restoring it where the damage happens
 * is what turns a papercut into a non-event.
 *
 * Only the four plain sections are restored. A nested `overrides` pin is not a
 * dissolved reference, it is a second opinion about the range, and rewriting it
 * would hide a decision instead of surfacing it — that one is left for
 * `assertCatalogIsTheOnlyStitchkitRange` to refuse by name.
 */
export async function restoreCatalogReferences(root: string): Promise<RestoredReference[]> {
  const manifests = ['package.json'];
  try {
    for (const entry of await readdir(join(root, 'packages'))) {
      manifests.push(join('packages', entry, 'package.json'));
    }
  } catch {
    // A tree with no `packages/` directory is repaired at its root alone.
  }
  // Every manifest is read AND parsed before any of them is written. A syntax
  // error found halfway through used to abort with the range already bumped,
  // the lockfile already rewritten and the references still dissolved — and the
  // command's whole promise is that the invariant is checked at the command
  // rather than a lane away, which a half-applied repair is the opposite of.
  const parsed: { relative: string; path: string; manifest: object }[] = [];
  for (const relative of manifests) {
    const path = join(root, relative);
    let source: string;
    try {
      source = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    parsed.push({ relative, path, manifest: parseManifest(source, path) });
  }

  const restored: RestoredReference[] = [];
  for (const { relative, path, manifest } of parsed) {
    let changed = false;
    for (const section of RESTORABLE_SECTIONS) {
      const block = Reflect.get(manifest, section);
      if (typeof block !== 'object' || block === null) continue;
      const range = Reflect.get(block, 'stitchkit');
      if (typeof range !== 'string' || range === 'catalog:') continue;
      Reflect.set(block, 'stitchkit', 'catalog:');
      restored.push({ manifest: relative, section, was: range });
      changed = true;
    }
    if (changed) await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return restored;
}
