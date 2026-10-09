import {
  affectsLineOf,
  breakingItems,
  parseAffectsLine,
  UpgradeAffectsError,
  type UpgradeAffectsTarget,
} from '../packages/core/src/internal/upgrade-affects';
import { BREAKING_HEADING } from '../packages/core/src/internal/upgrade-plan';
import { git } from './local-git';
import { assertTrainCarriesItsCompanions, readFromReleaseTags } from './release-companions';
import {
  assertLockfileWorkspaceVersions,
  manifestVersion,
  WORKSPACE_PACKAGE_DIRS,
} from './release-lockfile';
import {
  assertBreakingAudience,
  assertMigrationSection,
  assertVersionCalibre,
  comparePreOneVersions,
  extractReleaseNotes,
} from './release-notes';
import { assertReleaseMetadataOnly, isReleaseCommitSubject } from './release-subject';
import {
  RELEASE_TARGETS,
  type ReleasePlan,
  type ReleaseTrain,
  ReleaseTrainSchema,
  releasePlanForTag,
  releaseTagForTarget,
  releaseTrainEntry,
} from './release-train';
import { assertPackagesChanged } from './release-unchanged';
import {
  assertStarterLockfileIsCurrent,
  type FetchLike,
  type ReleaseTreeReader,
  readFromWorkingTree,
  readStarterResolution,
} from './starter-lockfile';
import { assertBreakingReleaseMetadata, BREAKING_METADATA_SINCE } from './surface-cadence';

export interface ReleaseCandidateIdentity extends ReleasePlan {
  schemaVersion: 1;
  sha: string;
  tag: string;
  ci: {
    workflow: 'ci.yml';
    event: 'push';
    headSha: string;
  };
  publication: {
    workflow: 'release.yml';
    event: 'push';
    tag: string;
  };
}

/** Stable identity shared by an in-flight CI attempt and later publication. */
export function releaseCandidateIdentity(
  plan: ReleasePlan,
  sha: string,
): ReleaseCandidateIdentity {
  const tag = releaseTagForTarget(plan.target, plan.version);
  return {
    schemaVersion: 1,
    ...plan,
    sha,
    tag,
    ci: { workflow: 'ci.yml', event: 'push', headSha: sha },
    publication: { workflow: 'release.yml', event: 'push', tag },
  };
}

/**
 * How the release-metadata gate reaches the registry.
 *
 * Injectable so the WIRING can be checked without a network: a starter tag
 * reaches the registry and a core tag does not, and neither is visible from
 * the pieces.
 */
export interface ValidateReleaseTagOptions {
  fetch?: FetchLike;
  /**
   * The mutable registry check belongs to candidate creation. A tag workflow
   * consumes the exact candidate CI already approved and must remain rerunnable
   * after another package in the same train becomes public.
   */
  checkStarterLockfile?: boolean;
  /**
   * Which tree to judge. The working tree by default; a pre-push check reads
   * the commit being pushed, because that is what the push publishes.
   */
  read?: ReleaseTreeReader;
}

/** Where ADR 0103's maturity table lives — the one list of stable entrypoints. */
export const MATURITY_TABLE_PATH = 'docs/guide/getting-started.md';

/** The first core release whose breaking items must each carry an `**Affects:**` line. */
export const AFFECTS_LINE_SINCE = '0.107.1';

/** The entrypoints `stitchkit` publishes, from the `exports` of its manifest. */
export function publishedEntrypoints(manifest: string): Set<string> {
  const parsed: unknown = JSON.parse(manifest);
  const exports =
    typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'exports') : undefined;
  const names = new Set<string>();
  if (typeof exports !== 'object' || exports === null) return names;
  for (const key of Object.keys(exports))
    names.add(key === '.' ? 'stitchkit' : `stitchkit/${key.replace(/^\.\//, '')}`);
  return names;
}

/**
 * Every breaking item names what it touches in the one machine line
 * `stitchkit upgrade` matches against a project's imports. Prose cannot be
 * matched without guessing; the author knows the answer at release time. A named
 * entrypoint must be one the package publishes, unless the target is `*`: an
 * entrypoint the release removes.
 */
export function assertBreakingAffects(
  notes: string,
  version: string,
  entrypoints: ReadonlySet<string>,
): void {
  if (!BREAKING_HEADING.test(notes)) return;
  const start = notes.search(BREAKING_HEADING);
  const section = notes.slice(start).replace(/^[^\n]*\n/, '');
  const end = section.search(/^### /m);
  const body = end === -1 ? section : section.slice(0, end);
  const items = breakingItems(body);
  if (items.length === 0)
    throw new Error(
      `${version}: the "### ⚠️ Breaking changes" section has no items. Write each breaking change as a "- " item ending with its "**Affects:**" line.`,
    );
  for (const { markdown } of items) {
    const first = JSON.stringify(markdown.split('\n')[0]?.slice(0, 120));
    let targets: UpgradeAffectsTarget[];
    try {
      const line = affectsLineOf(markdown);
      if (line === undefined)
        throw new Error(
          `${version}: breaking item ${first} has no "**Affects:**" line. Name what it touches so \`stitchkit upgrade\` can tell a project whether it is affected, e.g. "**Affects:** \`stitchkit/files/packaging\` createNativePackaging(delivery: 'embedded')", "**Affects:** \`stitchkit/process\` behaviour" or "**Affects:** \`stitchkit/old-leaf\` *".`,
        );
      targets = parseAffectsLine(line);
    } catch (error) {
      if (!(error instanceof UpgradeAffectsError)) throw error;
      throw new Error(
        `${version}: breaking item ${first} has a malformed "**Affects:**" line: ${error.message}`,
      );
    }
    const unknown = targets.filter(
      (target) => target.kind !== 'any-import' && !entrypoints.has(target.entrypoint),
    );
    if (unknown.length > 0)
      throw new Error(
        `${version}: breaking item ${first} names ${unknown.map((target) => `\`${target.entrypoint}\``).join(', ')} in its "**Affects:**" line, which packages/core/package.json does not export. Name a published entrypoint, or write "\`<entrypoint>\` *" for one this release removes.`,
      );
  }
}

export async function validateReleaseTag(
  root: string,
  tag: string,
  options: ValidateReleaseTagOptions = {},
): Promise<ReleasePlan & { notes: string }> {
  const plan = releasePlanForTag(tag);
  const read = options.read ?? readFromWorkingTree(root);
  const packageVersion = manifestVersion(
    await read(`${plan.packageDir}/package.json`),
    plan.packageDir,
  );
  if (packageVersion !== plan.version) {
    throw new Error(
      `${tag} does not match ${plan.packageName} package version ${packageVersion}`,
    );
  }
  const changelog = await read(plan.changelog);
  const notes = extractReleaseNotes(changelog, plan.version);
  assertVersionCalibre(changelog, plan.version);
  assertBreakingAudience(notes, plan.version);
  // The stable-entrypoint metadata validation is the framework's: the maturity
  // table lists `stitchkit` entrypoints, and the other packages keep their own
  // changelogs. The guide is read only when there is something to judge.
  if (
    plan.target === 'core' &&
    BREAKING_HEADING.test(notes) &&
    comparePreOneVersions(plan.version, BREAKING_METADATA_SINCE) >= 0
  ) {
    assertBreakingReleaseMetadata({
      changelog,
      guide: await read(MATURITY_TABLE_PATH),
      version: plan.version,
    });
  }
  if (plan.target === 'core' && comparePreOneVersions(plan.version, AFFECTS_LINE_SINCE) >= 0)
    assertBreakingAffects(
      notes,
      plan.version,
      publishedEntrypoints(await read(`${plan.packageDir}/package.json`)),
    );
  // Each package has its own migration channel: the scaffolder's guide is for
  // the operator of a GENERATED project, a different reader from the framework's.
  const channel = RELEASE_TARGETS[plan.target].migration;
  assertMigrationSection(await read(channel.guidePath), plan.version, notes, channel);
  // A starter release is the range AND the lockfile. Only the release channel
  // checks this: outside a release a lockfile lagging its range is legitimate.
  if (plan.target === 'create-stitchkit' && options.checkStarterLockfile !== false) {
    await assertStarterLockfileIsCurrent(root, options.fetch, read);
  }
  const lock = await read('bun.lock');
  const manifests: Record<string, string> = {};
  for (const directory of WORKSPACE_PACKAGE_DIRS) {
    manifests[directory] = manifestVersion(await read(`${directory}/package.json`), directory);
  }
  assertLockfileWorkspaceVersions(lock, manifests);
  return { ...plan, notes };
}

/** Read one file out of a commit, so a pre-push check judges what is on the wire. */
export function readFromCommit(root: string, sha: string): ReleaseTreeReader {
  return (relativePath) => git(root, ['show', `${sha}:${relativePath}`]);
}

export interface ValidateReleaseCommitOptions extends ValidateReleaseTagOptions {
  /** The files the metadata commit changes. When given, it must hold release metadata only. */
  changedFiles?: (sha: string) => Promise<readonly string[]>;
  /**
   * Judge the train against the releases already tagged: refuse a package whose packed files
   * equal its previous release, and a train a published sibling's frozen range would refuse.
   * Push-time only — a past release commit is not re-judged by tags made after it.
   */
  compareWithPublished?: boolean;
}

/**
 * The metadata gate, run against a release COMMIT instead of a tag, at the
 * only moment it is still cheap to act on: a missing `**Who must act:**` line
 * is one file read in milliseconds, but after the push the commit is public
 * and repairing it costs a second full gate and a second CI run.
 *
 * The version comes from the tree being pushed: the manifest is what publishes.
 */
export async function validateReleaseCommit(
  root: string,
  commit: { sha: string; subject: string; metadataSha?: string },
  options: ValidateReleaseCommitOptions = {},
): Promise<ReleasePlan & { notes: string }> {
  if (!isReleaseCommitSubject(commit.subject)) {
    throw new Error(`not a release commit subject: ${JSON.stringify(commit.subject.trim())}`);
  }
  const read = options.read ?? readFromCommit(root, commit.sha);
  const metadataSha = commit.metadataSha ?? commit.sha;
  if (options.changedFiles) {
    assertReleaseMetadataOnly(metadataSha, await options.changedFiles(metadataSha));
  }
  const train = ReleaseTrainSchema.parse(JSON.parse(await read('release-train.json')));
  // Tree-local, so it holds everywhere the train is judged — including the
  // candidate path, which deliberately skips the mutable registry checks.
  await assertTrainDoesNotOutrunTheStarter(root, train, read);
  if (options.compareWithPublished) {
    await assertPackagesChanged(root, train, read, commit.sha);
    await assertTrainCarriesItsCompanions(train, read, readFromReleaseTags(root));
  }
  let first: (ReleasePlan & { notes: string }) | undefined;
  for (const release of train.releases) {
    const plan = await validateReleaseTag(
      root,
      releaseTagForTarget(release.target, release.version),
      { ...options, read },
    );
    first ??= plan;
  }
  if (!first) throw new Error('release train has no targets');
  return first;
}

/**
 * Refuse a train that publishes a framework the starter in it is required to pin.
 *
 * The starter's lockfile can only resolve a version npm already serves — it is
 * written by `bun install`, which fetches. So a train carrying both core@X and
 * the starter, where X satisfies the starter's range, states two things that
 * cannot both be true: the lockfile must resolve the newest version the range
 * allows (which becomes X the moment the train publishes it), and the lockfile
 * cannot name X before that publication. The answer is not a cleverer moment to
 * ask npm — the starter belongs in a LATER train than the framework it tracks.
 *
 * The check stays narrow on purpose: a starter deliberately targeting an older
 * minor is unaffected by a new minor of the framework, so the two ride together
 * without conflict.
 */
export async function assertTrainDoesNotOutrunTheStarter(
  root: string,
  train: ReleaseTrain,
  read: ReleaseTreeReader,
): Promise<void> {
  const core = releaseTrainEntry(train, 'core');
  const starter = releaseTrainEntry(train, 'create-stitchkit');
  if (!core || !starter) return;
  const { range } = await readStarterResolution(root, read);
  if (!Bun.semver.satisfies(core.version, range)) return;
  throw new Error(
    `This train publishes stitchkit ${core.version} and create-stitchkit ${starter.version} together, and the starter's range "${range}" allows ${core.version}. Its lockfile would have to resolve ${core.version} to be correct, and it cannot: a lockfile can only pin a framework npm already serves. Release the framework in this train, then run \`bun run update:starter\` and release the starter in the next one.`,
  );
}
