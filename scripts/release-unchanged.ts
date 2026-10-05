import { git } from './local-git';
import { comparePreOneVersions } from './release-notes';
import {
  RELEASE_TARGETS,
  type ReleaseTarget,
  ReleaseTargetSchema,
  type ReleaseTrain,
} from './release-train';
import type { ReleaseTreeReader } from './starter-lockfile';

/** The newest tag of a target whose version is below `version`. */
export function previousReleaseTag(
  tags: readonly string[],
  target: ReleaseTarget,
  version: string,
): string | undefined {
  const prefix = RELEASE_TARGETS[target].tagPrefix;
  const versions = tags.flatMap((tag) => {
    const match = tag.startsWith(prefix)
      ? /^(\d+\.\d+\.\d+)$/.exec(tag.slice(prefix.length))
      : null;
    return match?.[1] === undefined ? [] : [match[1]];
  });
  const earlier = versions
    .filter((candidate) => comparePreOneVersions(candidate, version) < 0)
    .sort(comparePreOneVersions)
    .at(-1);
  return earlier === undefined ? undefined : `${prefix}${earlier}`;
}

/**
 * Tracked files, relative to the repository, that can change what a target's
 * tarball holds: its directory minus the paths that never ship, plus the
 * repository files that build it. The manifest is judged separately because
 * its version always changes.
 */
export function packedClosurePathspecs(target: ReleaseTarget): string[] {
  const info = RELEASE_TARGETS[target];
  return [
    info.directory,
    ...info.externalInputs,
    `:(exclude)${info.directory}/package.json`,
    ...info.unpackedPaths.map((path) => `:(exclude)${info.directory}/${path}`),
  ];
}

/** Key-sorted JSON, so two manifests that differ only in key order compare equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function manifestObject(source: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(source);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('package manifest is not an object');
  }
  return Object.fromEntries(Object.entries(parsed));
}

function withoutVersion(manifest: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'version'));
}

const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];

/**
 * Whether the packed manifest differs: any field but `version`, or a
 * `workspace:` dependency whose sibling carries another version, because
 * `bun pm pack` writes the sibling's version into the tarball.
 */
async function manifestChanged(
  target: ReleaseTarget,
  previousTag: string,
  root: string,
  read: ReleaseTreeReader,
): Promise<boolean> {
  const path = `${RELEASE_TARGETS[target].directory}/package.json`;
  const before = manifestObject(await git(root, ['show', `${previousTag}:${path}`]));
  const after = manifestObject(await read(path));
  if (canonical(withoutVersion(before)) !== canonical(withoutVersion(after))) return true;
  for (const sibling of ReleaseTargetSchema.options) {
    const info = RELEASE_TARGETS[sibling];
    const usesSibling = DEPENDENCY_FIELDS.some((field) => {
      const dependencies = after[field];
      return (
        typeof dependencies === 'object' &&
        dependencies !== null &&
        String(Reflect.get(dependencies, info.packageName)).startsWith('workspace:')
      );
    });
    if (!usesSibling) continue;
    const siblingPath = `${info.directory}/package.json`;
    const previous = manifestObject(
      await git(root, ['show', `${previousTag}:${siblingPath}`]),
    );
    const current = manifestObject(await read(siblingPath));
    if (previous.version !== current.version) return true;
  }
  return false;
}

/** Files of the packed closure that differ from `previousTag`: the working tree, or `ref` when given. */
export async function changedPackedFiles(
  root: string,
  target: ReleaseTarget,
  previousTag: string,
  ref?: string,
): Promise<string[]> {
  const specs = packedClosurePathspecs(target);
  const tracked = await git(root, [
    'diff',
    '--name-only',
    previousTag,
    ...(ref === undefined ? [] : [ref]),
    '--',
    ...specs,
  ]);
  const untracked =
    ref === undefined
      ? await git(root, ['ls-files', '--others', '--exclude-standard', '--', ...specs])
      : '';
  return `${tracked}\n${untracked}`.split('\n').filter((line) => line !== '');
}

/**
 * Refuse a train that would publish a package byte-for-byte equal to its
 * previous release except for the version and the changelog. An npm version is
 * permanent: such a release gives every consumer an update that changes
 * nothing, and the changelog line it needs is an invented one.
 */
export async function assertPackagesChanged(
  root: string,
  train: ReleaseTrain,
  read: ReleaseTreeReader,
  ref?: string,
): Promise<void> {
  for (const entry of train.releases) {
    const info = RELEASE_TARGETS[entry.target];
    const tags = (await git(root, ['tag', '--list', `${info.tagPrefix}*`])).split('\n');
    const previous = previousReleaseTag(tags, entry.target, entry.version);
    if (previous === undefined) continue;
    if (await manifestChanged(entry.target, previous, root, read)) continue;
    if ((await changedPackedFiles(root, entry.target, previous, ref)).length > 0) continue;
    throw new Error(
      `${info.packageName}@${entry.version} would publish the same files as ${previous}: nothing in its packed closure changed except the version and the changelog. A published npm version is permanent — release it with the next change consumers receive, or measure the release pipeline without publishing (docs/architecture/release-process.md#measuring-the-pipeline).`,
    );
  }
}
