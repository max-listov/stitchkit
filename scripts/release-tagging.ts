import { type CiRunSummary, requireSuccessfulReleaseCi } from './release-ci';
import { readReleaseTrain, releaseTagForTarget } from './release-train';

/** The command boundary of a release: git, GitHub and the metadata gates, injectable for tests. */
export interface ReleaseCommands {
  root: string;
  output(command: string[]): Promise<string>;
  run(command: string[]): Promise<void>;
  validateTag(tag: string): Promise<unknown>;
  /** The tagged head must be the release commit of the train, or fix commits stacked on it. */
  validateSubject(head: string, tag: string): Promise<void>;
  askCi(sha: string): Promise<readonly CiRunSummary[]>;
}

/** The default branch, fetched, and its head: the one place a release starts and is tagged from. */
export async function assertDefaultBranchAtOrigin(
  commands: ReleaseCommands,
): Promise<{ branch: string; head: string }> {
  const branch = await commands.output(['git', 'branch', '--show-current']);
  if (branch !== 'master' && branch !== 'main')
    throw new Error('Releases must run from master or main');
  await commands.run(['git', 'fetch', 'origin', branch]);
  const head = await commands.output(['git', 'rev-parse', 'HEAD']);
  if (head !== (await commands.output(['git', 'rev-parse', `origin/${branch}`])))
    throw new Error(`HEAD must equal origin/${branch}`);
  return { branch, head };
}

/**
 * Tag every target of the train on the head of the default branch.
 *
 * All metadata and remote evidence precede the first mutating tag operation:
 * each tag's metadata, the tagged head's shape and a green exact-SHA push run.
 */
export async function releaseTrain(commands: ReleaseCommands): Promise<void> {
  if ((await commands.output(['git', 'status', '--porcelain'])) !== '')
    throw new Error('Release metadata must be committed before tagging');
  const { head } = await assertDefaultBranchAtOrigin(commands);
  const train = await readReleaseTrain(commands.root);
  const tags = train.releases.map((entry) => releaseTagForTarget(entry.target, entry.version));
  for (const tag of tags) {
    await commands.validateTag(tag);
    await commands.validateSubject(head, tag);
  }
  await requireSuccessfulReleaseCi(head, commands.askCi);
  for (const tag of tags) await commands.run(['git', 'tag', tag, head]);
  await commands.run(['git', 'push', 'origin', ...tags.map((tag) => `refs/tags/${tag}`)]);
  await retireReleaseBranches(head, commands);
}

/**
 * A `release/…` branch exists to carry one candidate through its exact-SHA CI
 * run. Once its tip is contained in the released, tagged head the branch says
 * nothing the tag does not, so it is retired, locally and on origin. Only
 * branches already merged into the released head are removed, so nothing
 * unreleased goes with them. The tags are pushed by then, so a failure here is
 * reported and does not fail the release.
 */
async function retireReleaseBranches(head: string, commands: ReleaseCommands): Promise<void> {
  const merged = async (refs: string, format: string): Promise<string[]> =>
    (
      await commands.output([
        'git',
        'for-each-ref',
        `--format=${format}`,
        '--merged',
        head,
        refs,
      ])
    )
      .split('\n')
      .filter((name) => name !== '');
  // One at a time: a branch that cannot go (checked out elsewhere, already
  // gone) must not keep the rest.
  const retire = async (command: string[]): Promise<void> => {
    try {
      await commands.run(command);
    } catch (error) {
      process.stderr.write(
        `Release branch not retired: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  };
  try {
    for (const branch of await merged('refs/heads/release/', '%(refname:short)')) {
      await retire(['git', 'branch', '--delete', branch]);
    }
    await commands.run(['git', 'fetch', '--prune', 'origin']);
    for (const branch of await merged('refs/remotes/origin/release/', '%(refname:lstrip=3)')) {
      await retire(['git', 'push', 'origin', '--delete', branch]);
    }
  } catch (error) {
    process.stderr.write(
      `Release branches were not retired: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}
