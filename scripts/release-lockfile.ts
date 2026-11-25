import { join } from 'node:path';
import { packageDirectory, ReleaseTargetSchema } from './release-train';
import type { ReleaseTreeReader } from './starter-lockfile';

/** The published workspace packages, whose versions `bun pm pack` reads from `bun.lock`. */
export const WORKSPACE_PACKAGE_DIRS = ReleaseTargetSchema.options.map(packageDirectory);

/** The `version` `bun.lock` records for one workspace, or `null` when it lists none. */
export function lockedWorkspaceVersion(lock: string, directory: string): string | null {
  const escaped = directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const entry = new RegExp(`"${escaped}": \\{[^{}]*?"version": "([^"]+)"`).exec(lock);
  return entry?.[1] ?? null;
}

/**
 * Every workspace version in `bun.lock` equals its manifest.
 *
 * `bun pm pack` writes a `workspace:^` dependency from the version the
 * LOCKFILE records for that workspace, not from its `package.json`, and
 * `bun install --frozen-lockfile` does not treat a bumped manifest version as
 * drift. So a version bump without an install ships a sibling package pinned to
 * the previous release. Run `bun install` after a bump; this refuses the
 * release until then.
 */
export function assertLockfileWorkspaceVersions(
  lock: string,
  manifests: Record<string, string>,
): void {
  const stale = Object.entries(manifests).flatMap(([directory, version]) => {
    const locked = lockedWorkspaceVersion(lock, directory);
    return locked === version
      ? []
      : [`${directory}: bun.lock ${locked ?? 'none'}, package.json ${version}`];
  });
  if (stale.length > 0) {
    throw new Error(
      `bun.lock records workspace versions its manifests no longer carry — run \`bun install\`:\n  ${stale.join('\n  ')}`,
    );
  }
}

/** The dependency fields `bun.lock` copies from each workspace manifest. */
const LOCKED_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

/** `bun.lock` is JSON with trailing commas. */
function parseLock(lock: string): unknown {
  return JSON.parse(lock.replace(/,(\s*[}\]])/g, '$1'));
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

/**
 * Every dependency a workspace manifest declares, `bun.lock` records as declared — the ranges of
 * each field and the optional peers. `bun install --frozen-lockfile` reads the lock and accepts a
 * manifest that gained a peer it never wrote, so the next `bun install` writes it into whatever
 * commit runs one; in a release that is the metadata-only commit. Returns one line per difference.
 */
export function lockfileManifestDrift(
  lock: string,
  manifests: Readonly<Record<string, string>>,
): string[] {
  const workspaces = record(record(parseLock(lock)).workspaces);
  return Object.entries(manifests).flatMap(([directory, source]) => {
    const manifest = record(JSON.parse(source));
    const locked = record(workspaces[directory]);
    const drift: string[] = [];
    for (const field of LOCKED_FIELDS) {
      const declared = record(manifest[field]);
      const recorded = record(locked[field]);
      for (const name of new Set([...Object.keys(declared), ...Object.keys(recorded)]))
        if (declared[name] !== recorded[name])
          drift.push(
            `${directory} ${field} ${name}: package.json ${JSON.stringify(declared[name] ?? null)}, bun.lock ${JSON.stringify(recorded[name] ?? null)}`,
          );
    }
    const optional = Object.entries(record(manifest.peerDependenciesMeta))
      .filter(([, meta]) => record(meta).optional === true)
      .map(([name]) => name)
      .sort();
    const lockedOptional = (Array.isArray(locked.optionalPeers) ? locked.optionalPeers : [])
      .map(String)
      .sort();
    if (JSON.stringify(optional) !== JSON.stringify(lockedOptional))
      drift.push(
        `${directory} optionalPeers: package.json ${JSON.stringify(optional)}, bun.lock ${JSON.stringify(lockedOptional)}`,
      );
    return drift;
  });
}

/** Refuse a lockfile that does not record what its workspace manifests declare. */
export function assertLockfileMatchesManifests(
  lock: string,
  manifests: Readonly<Record<string, string>>,
): void {
  const drift = lockfileManifestDrift(lock, manifests);
  if (drift.length > 0)
    throw new Error(
      `bun.lock does not record what the workspace manifests declare — run \`bun install --lockfile-only\` and commit the lock with the manifest change:\n  ${drift.join('\n  ')}`,
    );
}

/** The `version` field of a package manifest, or a refusal that names the file. */
export function manifestVersion(source: string, packageDir: string): string {
  const manifest: unknown = JSON.parse(source);
  const version =
    typeof manifest === 'object' &&
    manifest !== null &&
    Object.hasOwn(manifest, 'version') &&
    typeof Reflect.get(manifest, 'version') === 'string'
      ? Reflect.get(manifest, 'version')
      : null;
  if (version === null) throw new Error(`${packageDir}/package.json has no string version`);
  return version;
}

/** Every workspace `bun.lock` records — the root (`""`) and each package — by its directory. */
export const LOCKED_WORKSPACES: readonly string[] = ['', ...WORKSPACE_PACKAGE_DIRS];

/** Each locked workspace's manifest, as `read` holds it. */
export async function workspaceManifests(
  read: ReleaseTreeReader,
): Promise<Record<string, string>> {
  const manifests: Record<string, string> = {};
  for (const directory of LOCKED_WORKSPACES)
    manifests[directory] = await read(
      directory === '' ? 'package.json' : `${directory}/package.json`,
    );
  return manifests;
}

/** Refuse a tree whose `bun.lock` does not record what its workspace manifests declare. */
export async function assertTreeLockfileMatchesManifests(
  read: ReleaseTreeReader,
): Promise<void> {
  assertLockfileMatchesManifests(await read('bun.lock'), await workspaceManifests(read));
}

// The `lockfile` gate step: `bun install --frozen-lockfile` accepts a manifest the lock never recorded.
if (import.meta.main) {
  const root = join(import.meta.dir, '..');
  await assertTreeLockfileMatchesManifests((path) => Bun.file(join(root, path)).text());
  process.stderr.write('[lockfile] bun.lock records every workspace manifest\n');
}
