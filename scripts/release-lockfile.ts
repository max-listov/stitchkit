import { packageDirectory, ReleaseTargetSchema } from './release-train';

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
