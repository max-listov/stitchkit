import { git } from './local-git';
import {
  RELEASE_TARGETS,
  type ReleaseTarget,
  ReleaseTargetSchema,
  type ReleaseTrain,
  releaseTagForTarget,
  releaseTrainEntry,
} from './release-train';
import type { ReleaseTreeReader } from './starter-lockfile';

/** Manifest fields a consumer's install resolves; `devDependencies` never leave the repository. */
const PUBLISHED_DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies'];

/** A file as a published tag holds it, or `undefined` when the tag does not exist. */
export type PublishedTreeReader = (tag: string, path: string) => Promise<string | undefined>;

/** Reads from the repository's own release tags. */
export function readFromReleaseTags(root: string): PublishedTreeReader {
  return async (tag, path) => {
    if ((await git(root, ['tag', '--list', tag])).trim() !== tag) return undefined;
    return git(root, ['show', `${tag}:${path}`]);
  };
}

function versionOf(manifest: string): string {
  const parsed: unknown = JSON.parse(manifest);
  const version =
    typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'version') : undefined;
  if (typeof version !== 'string') throw new Error('package manifest has no version');
  return version;
}

/** The `workspace:` spec a manifest gives `packageName` in a published field, if any. */
function workspaceSpec(manifest: string, packageName: string): string | undefined {
  const parsed: unknown = JSON.parse(manifest);
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  for (const field of PUBLISHED_DEPENDENCY_FIELDS) {
    const dependencies: unknown = Reflect.get(parsed, field);
    if (typeof dependencies !== 'object' || dependencies === null) continue;
    const spec: unknown = Reflect.get(dependencies, packageName);
    if (typeof spec === 'string' && spec.startsWith('workspace:')) return spec;
  }
  return undefined;
}

/** The range `bun pm pack` wrote for a `workspace:` spec when the sibling stood at `version`. */
export function packedRange(spec: string, version: string): string {
  const declared = spec.slice('workspace:'.length);
  if (declared === '*') return version;
  if (declared === '^' || declared === '~') return `${declared}${version}`;
  return declared;
}

/**
 * Refuse a train that publishes a package outside the range a sibling already
 * published for it, unless that sibling rides in the same train.
 *
 * A `workspace:` dependency is frozen into a range when the sibling is packed,
 * so the published sibling keeps accepting only the versions that existed then.
 * Released alone, the new version falls outside it, and every project installing
 * the sibling gets a second, older copy of the package — two copies break
 * `instanceof` across the package boundary. Releasing the sibling with the new
 * version repacks its range from the current workspace.
 */
export async function assertTrainCarriesItsCompanions(
  train: ReleaseTrain,
  read: ReleaseTreeReader,
  readPublished: PublishedTreeReader,
): Promise<void> {
  for (const released of train.releases) {
    const packageName = RELEASE_TARGETS[released.target].packageName;
    for (const companion of ReleaseTargetSchema.options) {
      if (companion === released.target || releaseTrainEntry(train, companion)) continue;
      const refusal = await companionRefusal(
        companion,
        released,
        packageName,
        read,
        readPublished,
      );
      if (refusal) throw new Error(refusal);
    }
  }
}

async function companionRefusal(
  companion: ReleaseTarget,
  released: { target: ReleaseTarget; version: string },
  packageName: string,
  read: ReleaseTreeReader,
  readPublished: PublishedTreeReader,
): Promise<string | undefined> {
  const companionInfo = RELEASE_TARGETS[companion];
  const companionVersion = versionOf(await read(`${companionInfo.directory}/package.json`));
  const tag = releaseTagForTarget(companion, companionVersion);
  const publishedManifest = await readPublished(
    tag,
    `${companionInfo.directory}/package.json`,
  );
  if (publishedManifest === undefined) return undefined;
  const spec = workspaceSpec(publishedManifest, packageName);
  if (spec === undefined) return undefined;
  const siblingManifest = await readPublished(
    tag,
    `${RELEASE_TARGETS[released.target].directory}/package.json`,
  );
  if (siblingManifest === undefined) return undefined;
  const range = packedRange(spec, versionOf(siblingManifest));
  if (Bun.semver.satisfies(released.version, range)) return undefined;
  return `This train publishes ${packageName} ${released.version}, but the published ${companionInfo.packageName}@${companionVersion} accepts only "${range}" of it: a project installing ${companionInfo.packageName} would get a second, older ${packageName}. Release ${companionInfo.packageName} in the same train, so its range is packed from the current workspace.`;
}
