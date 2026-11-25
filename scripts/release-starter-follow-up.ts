import { git } from './local-git';
import {
  deferralFor,
  followUpStarterVersion,
  STARTER_HEAD_REVIEW_PATH,
} from './release-starter-head';
import { releaseTags } from './release-tags';
import {
  RELEASE_TARGETS,
  type ReleaseTrain,
  releaseTagForTarget,
  releaseTrainEntry,
} from './release-train';
import { type ReleaseTreeReader, readStarterResolution } from './starter-lockfile';

/** A starter release the newest published core promised and that is not tagged yet. */
export interface PendingStarterFollowUp {
  /** The published core whose review deferred the starter. */
  coreVersion: string;
  /** The create-stitchkit version its review named as the next train. */
  starterVersion: string;
}

/**
 * Read the promise from the repository's own release tags: the review committed in the newest
 * `vX.Y.Z` tag, when it defers that version and names a `followUp` no `create-stitchkit-v*` tag
 * carries yet. The tag, not the tree, is the record — the follow-up train removes the review.
 * A clone without core tags is refused rather than read as "no promise".
 */
export async function pendingStarterFollowUp(
  root: string,
): Promise<PendingStarterFollowUp | undefined> {
  const prefix = RELEASE_TARGETS.core.tagPrefix;
  const versions = (await releaseTags(root, 'core'))
    .filter((tag) => /^\d+\.\d+\.\d+$/.test(tag.slice(prefix.length)))
    .map((tag) => tag.slice(prefix.length))
    .sort(Bun.semver.order);
  const coreVersion = versions.at(-1);
  if (coreVersion === undefined) {
    throw new Error(`No core release tag in ${root} names a version.`);
  }
  const coreTag = releaseTagForTarget('core', coreVersion);
  const listed = await git(root, [
    'ls-tree',
    '--name-only',
    coreTag,
    '--',
    STARTER_HEAD_REVIEW_PATH,
  ]);
  if (listed.trim() === '') return undefined;
  const review: unknown = JSON.parse(
    await git(root, ['show', `${coreTag}:${STARTER_HEAD_REVIEW_PATH}`]),
  );
  const deferral = deferralFor(coreVersion, review);
  if (deferral?.followUp === undefined) return undefined;
  const starterVersion = followUpStarterVersion(deferral.followUp);
  const starterTag = releaseTagForTarget('create-stitchkit', starterVersion);
  if ((await git(root, ['tag', '--list', starterTag])).trim() === starterTag) return undefined;
  return { coreVersion, starterVersion };
}

/**
 * The train after a deferral with `followUp` is that starter release (ADR 0322): it publishes
 * exactly the named create-stitchkit version, and its template targets the deferred core, so
 * new projects receive the fix it carries. Any other train is refused until it is tagged.
 */
export async function assertTrainHonoursStarterFollowUp(
  root: string,
  train: ReleaseTrain,
  read: ReleaseTreeReader,
  pending: PendingStarterFollowUp | undefined,
): Promise<void> {
  if (pending === undefined) return;
  const { coreVersion, starterVersion } = pending;
  const starter = releaseTrainEntry(train, 'create-stitchkit');
  if (starter?.version !== starterVersion) {
    const publishes = train.releases
      .map((entry) => `${entry.target}@${entry.version}`)
      .join(', ');
    throw new Error(
      `Core ${coreVersion} deferred its starter and named create-stitchkit@${starterVersion} as the next train (${STARTER_HEAD_REVIEW_PATH} in tag ${releaseTagForTarget('core', coreVersion)}); this train publishes ${publishes}. Release create-stitchkit@${starterVersion} first: run \`bun run update:starter\`, migrate the template, remove the review and tag it.`,
    );
  }
  const { range } = await readStarterResolution(root, read);
  if (!Bun.semver.satisfies(coreVersion, range)) {
    throw new Error(
      `create-stitchkit@${starterVersion} is the follow-up that brings core ${coreVersion} to new projects, and its template targets "${range}", which does not allow ${coreVersion}. Run \`bun run update:starter\`.`,
    );
  }
}
