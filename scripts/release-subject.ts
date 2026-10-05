import { git } from './local-git';
import {
  type ReleaseTarget,
  type ReleaseTrain,
  ReleaseTrainSchema,
  releasePlanForTag,
  releaseTrainEntry,
} from './release-train';
import type { ReleaseTreeReader } from './starter-lockfile';

/** The subject of the one commit that carries a train's version, changelog and train metadata. */
const RELEASE_SUBJECT = /^release\(train\):/;
/** A conventional commit subject: `type(scope)!: summary`. */
const CONVENTIONAL_SUBJECT = /^[a-z]+(?:\([^)\s]+\))?!?: \S/;

export function isReleaseCommitSubject(subject: string): boolean {
  return RELEASE_SUBJECT.test(subject.trim());
}

/**
 * Files a release commit may change. The commit carries metadata only: the
 * versions, the changelogs, the train, the lockfile, the promoted migration
 * sections and the maturity-cadence sentences that rolling a changelog moves.
 * Everything else is a feature or fix commit with its own conventional subject.
 */
const RELEASE_METADATA_PATHS: readonly RegExp[] = [
  /^release-train\.json$/,
  /^bun\.lock$/,
  /^CHANGELOG\.md$/,
  /^packages\/[^/]+\/package\.json$/,
  /^packages\/[^/]+\/(?:CHANGELOG|UPGRADING)\.md$/,
  /^docs\/guide\/(?:upgrading|getting-started)\.md$/,
  /^scripts\/surface-cadence\.test\.ts$/,
];

/** Refuse an empty release commit and any file that is not release metadata. */
export function assertReleaseMetadataOnly(sha: string, files: readonly string[]): void {
  if (files.length === 0) {
    throw new Error(
      `release commit ${sha.slice(0, 7)} is empty — it must carry the version, changelog and train metadata`,
    );
  }
  const foreign = files.filter(
    (file) => !RELEASE_METADATA_PATHS.some((path) => path.test(file)),
  );
  if (foreign.length > 0) {
    throw new Error(
      `release commit ${sha.slice(0, 7)} carries more than release metadata (${foreign.slice(0, 5).join(', ')}${foreign.length > 5 ? ', …' : ''}). Commit each feature or fix on its own with its own subject and body; the release commit holds versions, changelogs, the train and the lockfile only.`,
    );
  }
}

export interface CommitFacts {
  sha: string;
  subject: string;
  files: readonly string[];
}

/** First-parent commits from `head` back, newest first. */
export type FirstParentHistory = (head: string) => Promise<readonly CommitFacts[]>;

/** How far below the tagged head the release commit may sit. */
const HISTORY_WINDOW = 50;

const COMMIT_START = '\x1e';
const FIELD = '\x1f';

export function firstParentHistory(root: string): FirstParentHistory {
  return async (head) => {
    const log = await git(root, [
      '-c',
      'core.quotepath=off',
      'log',
      '--first-parent',
      `-n${HISTORY_WINDOW}`,
      `--format=${COMMIT_START}%H${FIELD}%s`,
      '--name-only',
      head,
    ]);
    return log
      .split(COMMIT_START)
      .filter((block) => block.trim() !== '')
      .map((block) => {
        const [first = '', ...rest] = block.split('\n');
        const [sha = '', subject = ''] = first.split(FIELD);
        return {
          sha,
          subject,
          files: rest.map((line) => line.trim()).filter((line) => line !== ''),
        };
      });
  };
}

/**
 * Whether `head` is a release commit, or fix commits stacked on one, that no tag contains yet.
 * That head is what the tag will name and what the publishing workflow downloads artifacts
 * for, so CI builds them for it: a repair of a red candidate keeps its own conventional type
 * and must not lose the publication evidence the release commit carried.
 */
export async function stacksOnUnpublishedRelease(input: {
  head: string;
  history: FirstParentHistory;
  isTagged: (sha: string) => Promise<boolean>;
}): Promise<boolean> {
  const commits = await input.history(input.head);
  const releaseIndex = commits.findIndex((commit) => isReleaseCommitSubject(commit.subject));
  const release = commits[releaseIndex];
  if (!release) return false;
  if (
    !commits
      .slice(0, releaseIndex)
      .every((commit) => CONVENTIONAL_SUBJECT.test(commit.subject))
  )
    return false;
  return !(await input.isTagged(release.sha));
}

/**
 * The tag sits on the release commit of that exact train, or on fix commits
 * stacked directly on it. The release commit is what the tag names: it
 * carries `release(train): … in X.Y.Z` and release metadata only. Anything
 * above it is a repair of a red candidate and keeps its own conventional
 * type, because exact-SHA CI has to be green for the tagged head itself.
 * Empty commits are refused wherever they stand.
 *
 * The version is not matched against the subject: the manifests and the train
 * decide it, and the train must select the tag's target at the tag's version.
 */
export async function assertReleaseSubjectForTag(input: {
  root: string;
  tag: string;
  head: string;
  read?: ReleaseTreeReader;
  history: FirstParentHistory;
}): Promise<void> {
  const plan = releasePlanForTag(input.tag);
  const train = ReleaseTrainSchema.parse(
    JSON.parse(
      input.read
        ? await input.read('release-train.json')
        : await git(input.root, ['show', `${input.head}:release-train.json`]),
    ),
  );
  assertTrainSelects(train, plan.target, plan.version);

  const commits = await input.history(input.head);
  const releaseIndex = commits.findIndex((commit) => isReleaseCommitSubject(commit.subject));
  const subject = commits[0]?.subject.trim() ?? '';
  if (releaseIndex === -1) {
    throw new Error(
      `release tag must point at a "release(train): … in ${plan.version}" commit, or at fix commits stacked on one — its subject is ${subject === '' ? '(empty)' : JSON.stringify(subject)}. Land fixes first, make the release commit last, wait for green, then tag.`,
    );
  }
  for (const fixup of commits.slice(0, releaseIndex)) {
    if (!CONVENTIONAL_SUBJECT.test(fixup.subject)) {
      throw new Error(
        `commit ${fixup.sha.slice(0, 7)} above the release commit has no conventional subject: ${JSON.stringify(fixup.subject)}`,
      );
    }
    if (fixup.files.length === 0) {
      throw new Error(`commit ${fixup.sha.slice(0, 7)} above the release commit is empty`);
    }
  }
  const release = commits[releaseIndex];
  if (release) assertReleaseMetadataOnly(release.sha, release.files);
}

function assertTrainSelects(
  train: ReleaseTrain,
  target: ReleaseTarget,
  version: string,
): void {
  const entry = releaseTrainEntry(train, target);
  if (!entry || entry.version !== version) {
    throw new Error(`release train does not select ${target}@${version}`);
  }
}

/** Fail unless the tag points at the current release head of the default branch. */
export function assertTagOnReleaseHead(tagSha: string, remoteHeadSha: string): void {
  if (!tagSha || !remoteHeadSha || tagSha !== remoteHeadSha) {
    throw new Error(
      `release tag must point at the current origin/master SHA (tag ${tagSha || '(none)'}, master ${remoteHeadSha || '(none)'})`,
    );
  }
}
