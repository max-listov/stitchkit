import { git } from './local-git';
import { releaseTags } from './release-tags';
import {
  RELEASE_TARGETS,
  type ReleaseTarget,
  ReleaseTargetSchema,
  type ReleaseTrain,
  releaseTagForTarget,
  releaseTrainEntry,
  targetForTag,
} from './release-train';
import type { ReleaseTreeReader } from './starter-lockfile';

/** Manifest fields a consumer's install resolves; `devDependencies` never leave the repository. */
const PUBLISHED_DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies'] as const;
type PublishedDependencyField = (typeof PUBLISHED_DEPENDENCY_FIELDS)[number];

/** A file as a published tag holds it, or `undefined` when the tag does not exist. */
export type PublishedTreeReader = (tag: string, path: string) => Promise<string | undefined>;

/**
 * Reads from the repository's own release tags. Refuses when the repository holds no local tags
 * for the target's prefix at all: a fresh or tagless clone would otherwise silently skip companion
 * checks instead of asking for `git fetch origin --tags`.
 */
export function readFromReleaseTags(root: string): PublishedTreeReader {
  return async (tag, path) => {
    const parsed = targetForTag(tag);
    const known = parsed === undefined ? undefined : await releaseTags(root, parsed.target);
    if (known === undefined) {
      if ((await git(root, ['tag', '--list', tag])).trim() !== tag) return undefined;
    } else if (!known.includes(tag)) return undefined;
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

/** The `workspace:` spec a manifest gives `packageName` in a published field, and that field. */
function workspaceSpec(
  manifest: string,
  packageName: string,
): { spec: string; field: PublishedDependencyField } | undefined {
  const parsed: unknown = JSON.parse(manifest);
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  for (const field of PUBLISHED_DEPENDENCY_FIELDS) {
    const dependencies: unknown = Reflect.get(parsed, field);
    if (typeof dependencies !== 'object' || dependencies === null) continue;
    const spec: unknown = Reflect.get(dependencies, packageName);
    if (typeof spec === 'string' && spec.startsWith('workspace:')) return { spec, field };
  }
  return undefined;
}

/**
 * The packages of the same train that `target` publishes a range for (its `workspace:` dependency
 * or peer), at the version the train gives them. A train publishes whole: each tag publishes on its
 * own, so the publication of `target` waits until these are on npm — otherwise it would ship a range
 * nothing published satisfies, and a failed publication of its sibling would leave it so.
 */
export function trainRequirements(
  train: ReleaseTrain,
  target: ReleaseTarget,
  manifest: string,
): { packageName: string; version: string }[] {
  return train.releases.flatMap(({ target: sibling, version }) => {
    if (sibling === target) return [];
    const { packageName } = RELEASE_TARGETS[sibling];
    return workspaceSpec(manifest, packageName) === undefined
      ? []
      : [{ packageName, version }];
  });
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
  const [missing] = await missingCompanions(train, read, readPublished);
  if (missing) throw new Error(missing.refusal);
}

/** A package a train has to carry because a release in it leaves the range that package published. */
export interface RequiredCompanion {
  companion: ReleaseTarget;
  /** The companion's version before this train. */
  version: string;
  refusal: string;
  /** The release that requires the companion: the one its changelog names. */
  requiredBy: { target: ReleaseTarget; version: string };
  /** The range the companion publishes for `requiredBy` once it is packed beside it. */
  packed: { field: PublishedDependencyField; range: string };
}

/**
 * Every sibling a train has to carry, whether the train names it or not, each
 * with the refusal that says why and the range it packs in this train.
 * `prepare` adds the missing ones and says in each one's changelog which range
 * it now publishes.
 */
export async function requiredCompanions(
  train: ReleaseTrain,
  read: ReleaseTreeReader,
  readPublished: PublishedTreeReader,
): Promise<RequiredCompanion[]> {
  const required: RequiredCompanion[] = [];
  for (const released of train.releases) {
    for (const companion of ReleaseTargetSchema.options) {
      if (companion === released.target) continue;
      if (required.some((entry) => entry.companion === companion)) continue;
      const found = await companionRequirement(companion, released, read, readPublished);
      if (found) required.push(found);
    }
  }
  return required;
}

/** The required siblings the train does not carry; the release check refuses a train that lacks one. */
export async function missingCompanions(
  train: ReleaseTrain,
  read: ReleaseTreeReader,
  readPublished: PublishedTreeReader,
): Promise<RequiredCompanion[]> {
  return (await requiredCompanions(train, read, readPublished)).filter(
    (entry) => !releaseTrainEntry(train, entry.companion),
  );
}

async function companionRequirement(
  companion: ReleaseTarget,
  released: { target: ReleaseTarget; version: string },
  read: ReleaseTreeReader,
  readPublished: PublishedTreeReader,
): Promise<RequiredCompanion | undefined> {
  const packageName = RELEASE_TARGETS[released.target].packageName;
  const companionInfo = RELEASE_TARGETS[companion];
  const companionVersion = versionOf(await read(`${companionInfo.directory}/package.json`));
  const tag = releaseTagForTarget(companion, companionVersion);
  const publishedManifest = await readPublished(
    tag,
    `${companionInfo.directory}/package.json`,
  );
  if (publishedManifest === undefined) return undefined;
  const workspace = workspaceSpec(publishedManifest, packageName);
  if (workspace === undefined) return undefined;
  const siblingManifest = await readPublished(
    tag,
    `${RELEASE_TARGETS[released.target].directory}/package.json`,
  );
  if (siblingManifest === undefined) return undefined;
  const range = packedRange(workspace.spec, versionOf(siblingManifest));
  if (Bun.semver.satisfies(released.version, range)) return undefined;
  return {
    companion,
    version: companionVersion,
    refusal: `This train publishes ${packageName} ${released.version}, but the published ${companionInfo.packageName}@${companionVersion} accepts only "${range}" of it: a project installing ${companionInfo.packageName} would get a second, older ${packageName}. Release ${companionInfo.packageName} in the same train, so its range is packed from the current workspace.`,
    requiredBy: { target: released.target, version: released.version },
    packed: { field: workspace.field, range: packedRange(workspace.spec, released.version) },
  };
}
