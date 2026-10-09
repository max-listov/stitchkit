import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from './local-git';
import { askReleaseCi, CiRunListSchema, selectSuccessfulCiRun } from './release-ci';
import { output, run } from './release-command';
import { assertTrainCarriesItsCompanions, readFromReleaseTags } from './release-companions';
import { parseTrainArguments, prepareTrain } from './release-prepare';
import { ciAlreadyAnsweredFor, classifyPrePush, prePushMetadataGate } from './release-prepush';
import { starterHeadDecision } from './release-starter-head';
import {
  assertReleaseSubjectForTag,
  assertTagOnReleaseHead,
  firstParentHistory,
  unpublishedReleaseCommitAtHead,
} from './release-subject';
import {
  assertDefaultBranchAtOrigin,
  type ReleaseCommands,
  releaseTrain,
} from './release-tagging';
import {
  ReleaseTrainSchema,
  readReleaseTrain,
  releasePlanForTag,
  releaseTagForTarget,
} from './release-train';
import { assertPackagesChanged } from './release-unchanged';
import {
  assertTrainDoesNotOutrunTheStarter,
  MATURITY_TABLE_PATH,
  readFromCommit,
  releaseCandidateIdentity,
  validateReleaseCommit,
  validateReleaseTag,
} from './release-validate';
import { readFromWorkingTree } from './starter-lockfile';
import { stableBreakingCadence, stableCadenceSentence } from './surface-cadence';

/**
 * Idempotent publish decision: absent → publish; identical tarball → skip
 * (a re-run of the workflow); a DIFFERENT published tarball is fraud/mistake
 * and must never be skipped silently.
 */
export function decidePublishAction(
  artifactShasum: string,
  publishedShasum: string | null,
): 'publish' | 'skip' {
  if (!artifactShasum) throw new Error('artifact shasum is required');
  if (publishedShasum === null || publishedShasum === '') return 'publish';
  if (publishedShasum === artifactShasum) return 'skip';
  throw new Error('version already exists on npm with a DIFFERENT tarball — refusing');
}

/** Resolve each pushed release tree to its metadata commit without losing the actual tip SHA. */
async function releaseCommitsIn(
  root: string,
  branchHeads: readonly string[],
): Promise<{ sha: string; subject: string; metadataSha?: string }[]> {
  const commits: { sha: string; subject: string; metadataSha?: string }[] = [];
  const history = firstParentHistory(root);
  for (const sha of branchHeads) {
    const release = await unpublishedReleaseCommitAtHead({
      head: sha,
      history,
      isTagged: async (commit) =>
        (await git(root, ['tag', '--contains', commit])).trim() !== '',
    });
    if (!release) continue;
    commits.push({
      sha,
      subject: release.subject,
      ...(release.sha === sha ? {} : { metadataSha: release.sha }),
    });
  }
  return commits;
}

async function commitFiles(root: string, sha: string): Promise<string[]> {
  const files = await git(root, [
    '-c',
    'core.quotepath=off',
    'diff-tree',
    '--no-commit-id',
    '--name-only',
    '-r',
    sha,
  ]);
  return files.split('\n').filter((line) => line !== '');
}

/**
 * The same metadata gate the push runs, against the working tree, before
 * anything expensive. It derives the tags from `release-train.json`, which
 * catches a train that names a version the manifest does not carry, and a
 * package whose packed files equal its previous release, while the cost of
 * being wrong is still a one-line edit.
 */
async function checkWorkingTree(root: string): Promise<void> {
  const train = await readReleaseTrain(root);
  const read = readFromWorkingTree(root);
  await assertTrainDoesNotOutrunTheStarter(root, train, read);
  await assertTrainCarriesItsCompanions(train, read, readFromReleaseTags(root));
  const checked: string[] = [];
  for (const entry of train.releases) {
    const tag = releaseTagForTarget(entry.target, entry.version);
    if (entry.target === 'core') {
      // Observed cadence is informational; metadata validation remains mandatory.
      const cadence = stableBreakingCadence({
        changelog: await readFile(join(root, 'CHANGELOG.md'), 'utf8'),
        guide: await readFile(join(root, MATURITY_TABLE_PATH), 'utf8'),
        version: entry.version,
      });
      process.stderr.write(`[release] ${entry.version}: ${stableCadenceSentence(cadence)}\n`);
    }
    await validateReleaseTag(root, tag);
    checked.push(tag);
  }
  await assertPackagesChanged(root, train, read);
  process.stderr.write(
    `[release] working tree carries release metadata for ${checked.join(', ')}\n`,
  );
}

/** The identity of every release the candidate commit would publish, as JSON. */
async function candidateIdentities(root: string, argument: string): Promise<string> {
  const sha = (await git(root, ['rev-parse', `${argument}^{commit}`])).trim();
  const [release] = await releaseCommitsIn(root, [sha]);
  if (!release) throw new Error(`no unpublished release commit found at ${sha}`);
  // The mutable starter registry check ran before the release commit was
  // pushed; repeating it would make candidate registration depend on packages
  // published by the very same train.
  await validateReleaseCommit(root, release, {
    checkStarterLockfile: false,
    changedFiles: (commit) => commitFiles(root, commit),
  });
  const train = ReleaseTrainSchema.parse(
    JSON.parse(await readFromCommit(root, sha)('release-train.json')),
  );
  const releases = train.releases.map((entry) =>
    releaseCandidateIdentity(
      releasePlanForTag(releaseTagForTarget(entry.target, entry.version)),
      sha,
    ),
  );
  return JSON.stringify({ schemaVersion: 1, sha, releases });
}

async function prePush(root: string): Promise<void> {
  const plan = classifyPrePush(await Bun.stdin.text());
  const history = firstParentHistory(root);
  const { profile, releaseCommits } = await prePushMetadataGate(plan, {
    validateTag: async (tag, sha) => {
      await validateReleaseTag(root, tag);
      await assertReleaseSubjectForTag({
        root,
        tag,
        head: sha,
        read: readFromCommit(root, sha),
        history,
      });
    },
    releaseCommits: (heads) => releaseCommitsIn(root, heads),
    validateCommit: (commit) =>
      validateReleaseCommit(root, commit, {
        changedFiles: (sha) => commitFiles(root, sha),
        compareWithPublished: true,
      }).then(() => undefined),
  });
  // Before the machinery, and never memoised: the scan reads the real index,
  // which the memo's tree hash does not describe. A local refusal is the only
  // refusal that keeps content out of a public repository.
  await run(['bun', 'scripts/check-publication-privacy.ts']);
  if (profile === 'candidate') {
    process.stderr.write(
      '[gate] release candidate: lockfile, lint, types and the release-metadata tests run here; full exact-SHA CI must pass every unit test and selected lane before master/tag.\n',
    );
    await run(['bun', 'scripts/verify.ts', '--candidate', '--if-changed']);
  }
  if (profile === 'fast') {
    process.stderr.write(
      '[gate] ordinary push: lint, types and tests run here; the packed lanes, smokes and consumer lane run on CI, which is the authority for publication either way.\n',
    );
    await run(['bun', 'scripts/verify.ts', '--fast', '--if-changed']);
  }
  if (profile === 'full') {
    const landing = releaseCommits
      .filter((commit) => plan.defaultBranchHeads.includes(commit.sha))
      .map((commit) => commit.sha);
    const answered = await ciAlreadyAnsweredFor(landing, (sha) => askReleaseCi(root, sha));
    if (answered.green) {
      process.stderr.write(
        `[gate] release commit already gated by CI: ${answered.because}. Fast-forwarding master publishes a tree CI has answered for on this exact SHA.\n`,
      );
      return;
    }
    process.stderr.write(`[gate] running the release gate locally: ${answered.because}\n`);
    await run(['bun', 'scripts/verify.ts', '--release', '--if-changed']);
  }
}

async function main(): Promise<void> {
  const [command, argument] = Bun.argv.slice(2);
  const root = join(import.meta.dir, '..');
  if (command === 'preflight' || command === 'release-metadata') {
    if (!argument) throw new Error(`Usage: release-plan.ts ${command} <tag>`);
    const plan = await validateReleaseTag(root, argument, {
      checkStarterLockfile: command === 'preflight',
    });
    process.stdout.write(JSON.stringify(plan));
    return;
  }
  if (command === 'check') return checkWorkingTree(root);
  if (command === 'prepare') {
    const releases = parseTrainArguments(Bun.argv.slice(3));
    if (releases.length === 0)
      throw new Error('Usage: release-plan.ts prepare <target>@X.Y.Z…');
    await prepareTrain(root, releases, new Date().toISOString().slice(0, 10));
    return;
  }
  if (command === 'candidate') {
    if (!argument) throw new Error('Usage: release-plan.ts candidate <sha>');
    process.stdout.write(await candidateIdentities(root, argument));
    return;
  }
  if (command === 'pre-push') return prePush(root);
  if (command === 'assert-origin' || command === 'release') {
    const commands: ReleaseCommands = {
      root,
      run,
      output,
      validateTag: (tag) => validateReleaseTag(root, tag),
      validateSubject: (head, tag) =>
        assertReleaseSubjectForTag({ root, tag, head, history: firstParentHistory(root) }),
      askCi: (sha) => askReleaseCi(root, sha),
    };
    if (command === 'assert-origin') {
      await assertDefaultBranchAtOrigin(commands);
      return;
    }
    if (argument !== 'train') throw new Error('Usage: release-plan.ts release train');
    await releaseTrain(commands);
    return;
  }
  if (command === 'assert-subject') {
    const [, head, tag] = Bun.argv.slice(2);
    if (!head || !tag) throw new Error('Usage: release-plan.ts assert-subject <sha> <tag>');
    await assertReleaseSubjectForTag({ root, tag, head, history: firstParentHistory(root) });
    return;
  }
  if (command === 'assert-head') {
    const [, tagSha, remoteHeadSha] = Bun.argv.slice(2);
    assertTagOnReleaseHead(tagSha ?? '', remoteHeadSha ?? '');
    return;
  }
  if (command === 'select-ci-run') {
    if (!argument) throw new Error('Usage: release-plan.ts select-ci-run <sha> < runs.json');
    const runs = CiRunListSchema.parse(JSON.parse(await Bun.stdin.text()));
    process.stdout.write(String(selectSuccessfulCiRun(runs, argument)));
    return;
  }
  if (command === 'publish-action') {
    const [, artifactShasum, publishedShasum] = Bun.argv.slice(2);
    process.stdout.write(decidePublishAction(artifactShasum ?? '', publishedShasum ?? null));
    return;
  }
  if (command === 'starter-head') {
    process.stdout.write(await starterHeadDecision(root));
    return;
  }
  throw new Error(
    'Usage: release-plan.ts <check|prepare TARGET@X.Y.Z…|preflight TAG|release-metadata TAG|candidate SHA|pre-push|assert-origin|release train|assert-subject SHA TAG|assert-head TAG_SHA HEAD_SHA|select-ci-run SHA|publish-action ARTIFACT_SHA [PUBLISHED_SHA]|starter-head>',
  );
}

if (import.meta.main) {
  await main();
}
