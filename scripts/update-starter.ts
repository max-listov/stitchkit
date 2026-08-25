import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { newestSatisfying, publishedVersions } from './starter-lockfile';
import {
  assertCatalogIsTheOnlyStitchkitRange,
  readStarterStitchkitTarget,
  restoreCatalogReferences,
  writeStarterStitchkitTarget,
} from './starter-manifest';

/**
 * Update the template's dependencies without dissolving the one invariant it has.
 *
 * Two things made a raw `bun update` in the template the wrong tool, and both
 * were observed on the same day:
 *
 * 1. It rewrites every `"stitchkit": "catalog:"` reference into the literal
 *    range it resolved — six manifests at once under `--latest`. The gate
 *    catches it, but a full lane later, and the repair is a manual revert.
 * 2. `bun update stitchkit` answered 0.60.0 while the registry was already
 *    serving 0.60.1. An update with its own staleness is the worst possible
 *    context in which to see a dissolved catalog: the symptom looks like the
 *    normal shape of the file.
 *
 * So the framework range is set from the registry rather than negotiated, the
 * references are restored where the damage happens, and the invariant is
 * checked immediately — at the command, not a lane away.
 */

const template = join(import.meta.dir, '../packages/create-stitchkit/template');

/** Every `name -> version` the lockfile resolves, for an honest before/after. */
export function lockedResolutions(lock: string): Map<string, string> {
  const resolved = new Map<string, string>();
  const row = /^\s{4}"((?:@[^"/]+\/)?[^"@]+)":\s*\[\s*"(?:@[^"/]+\/)?[^"@]+@([^"]+)"/gm;
  for (const match of lock.matchAll(row)) {
    const [, name, version] = match;
    if (name && version) resolved.set(name, version);
  }
  return resolved;
}

/** What moved between two lockfile readings, in name order. */
export function resolutionChanges(
  before: Map<string, string>,
  after: Map<string, string>,
): { name: string; from: string | null; to: string | null }[] {
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  return names
    .map((name) => ({ name, from: before.get(name) ?? null, to: after.get(name) ?? null }))
    .filter((change) => change.from !== change.to);
}

/** The same range shape around a new version — a caret target stays a caret target. */
export function rangeLike(existing: string, version: string): string {
  const operator = /^([\^~]?)/.exec(existing)?.[1] ?? '';
  return `${operator}${version}`;
}

async function bun(args: string[]): Promise<void> {
  const child = Bun.spawn(['bun', ...args], {
    cwd: template,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`\`bun ${args.join(' ')}\` exited with ${code}`);
}

async function readLock(): Promise<Map<string, string>> {
  try {
    return lockedResolutions(await readFile(join(template, 'bun.lock'), 'utf8'));
  } catch {
    return new Map();
  }
}

async function main(): Promise<void> {
  const packages = Bun.argv.slice(2).filter((argument) => !argument.startsWith('-'));
  const flags = Bun.argv.slice(2).filter((argument) => argument.startsWith('-'));
  const latest = flags.includes('--latest');
  const unknown = flags.filter((flag) => flag !== '--latest');
  if (unknown.length > 0) {
    throw new Error(
      `Usage: update-starter.ts [--latest] [package...] (got ${unknown.join(' ')})`,
    );
  }

  const before = await readLock();

  if (packages.length === 0) {
    // The default job: move the framework, from the registry, deliberately.
    const current = await readStarterStitchkitTarget(template);
    const published = await publishedVersions('stitchkit');
    const newest = newestSatisfying('*', published);
    if (newest === null) throw new Error('npm publishes no non-prerelease stitchkit version');
    const target = rangeLike(current, newest);
    if (target !== current) {
      await writeStarterStitchkitTarget(template, target);
      process.stdout.write(`catalog.stitchkit ${current} -> ${target}\n`);
    } else {
      process.stdout.write(`catalog.stitchkit is already ${current}\n`);
    }
    await bun(['install']);
  } else {
    await bun(latest ? ['update', '--latest', ...packages] : ['update', ...packages]);
  }

  const restored = await restoreCatalogReferences(template);
  if (restored.length > 0) {
    for (const reference of restored) {
      process.stdout.write(
        `restored ${reference.manifest} ${reference.section}.stitchkit "${reference.was}" -> "catalog:"\n`,
      );
    }
    // The manifests moved, so the lockfile has to be told. Without this the
    // template installs from a lockfile describing ranges no manifest holds.
    await bun(['install']);
  }

  await assertCatalogIsTheOnlyStitchkitRange(template);

  const changes = resolutionChanges(before, await readLock());
  if (changes.length === 0) {
    process.stdout.write('nothing moved.\n');
    return;
  }
  // Printed in full, including what was not asked for: an update that quietly
  // drags a dozen transitive dependencies along is the kind of thing a reviewer
  // finds out about from a red lane rather than from the command they ran.
  process.stdout.write(
    `${changes.length} resolution${changes.length === 1 ? '' : 's'} moved:\n`,
  );
  for (const change of changes) {
    process.stdout.write(
      `  ${change.name} ${change.from ?? '(absent)'} -> ${change.to ?? '(removed)'}\n`,
    );
  }
}

if (import.meta.main) {
  await main();
}
