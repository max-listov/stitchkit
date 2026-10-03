import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { type CiRunSummary, requireSuccessfulReleaseCi } from './release-ci';
import {
  packageDirectory,
  type ReleaseTarget,
  readReleaseTrain,
  releaseTagForTarget,
} from './release-train';

export interface ReleaseExecution {
  root: string;
  output(command: string[]): Promise<string>;
  run(command: string[]): Promise<void>;
  validateTag(tag: string): Promise<unknown>;
  validateSubject(subject: string, tag: string, version: string): Promise<void>;
  askCi(sha: string): Promise<readonly CiRunSummary[]>;
}

async function releaseHead(
  execution: ReleaseExecution,
): Promise<{ head: string; subject: string }> {
  const branch = await execution.output(['git', 'branch', '--show-current']);
  if (branch !== 'master' && branch !== 'main')
    throw new Error('Releases must run from master or main');
  if ((await execution.output(['git', 'status', '--porcelain'])) !== '')
    throw new Error('Release metadata must be committed before tagging');
  await execution.run(['git', 'fetch', 'origin', branch]);
  const head = await execution.output(['git', 'rev-parse', 'HEAD']);
  if (head !== (await execution.output(['git', 'rev-parse', `origin/${branch}`])))
    throw new Error(`HEAD must equal origin/${branch}`);
  return { head, subject: await execution.output(['git', 'log', '-1', '--format=%s', head]) };
}

async function tagValidatedRelease(
  entries: readonly { target: ReleaseTarget; version: string }[],
  head: string,
  subject: string,
  execution: ReleaseExecution,
): Promise<void> {
  const tags = entries.map((entry) => releaseTagForTarget(entry.target, entry.version));
  // All metadata and remote evidence precede the first mutating tag operation.
  for (const [index, entry] of entries.entries()) {
    const tag = tags[index];
    if (tag === undefined) throw new Error('Missing release tag');
    await execution.validateTag(tag);
    await execution.validateSubject(subject, tag, entry.version);
  }
  await requireSuccessfulReleaseCi(head, execution.askCi);
  for (const tag of tags) await execution.run(['git', 'tag', tag, head]);
  await execution.run(['git', 'push', 'origin', ...tags.map((tag) => `refs/tags/${tag}`)]);
  await retireReleaseBranches(head, execution);
}

export async function release(
  target: ReleaseTarget,
  execution: ReleaseExecution,
): Promise<void> {
  const { head, subject } = await releaseHead(execution);
  const directory = packageDirectory(target);
  const manifest = z
    .object({ version: z.string().min(1) })
    .parse(
      JSON.parse(await readFile(join(execution.root, directory, 'package.json'), 'utf8')),
    );
  await tagValidatedRelease([{ target, version: manifest.version }], head, subject, execution);
}

export async function releaseTrain(execution: ReleaseExecution): Promise<void> {
  const { head, subject } = await releaseHead(execution);
  const train = await readReleaseTrain(execution.root);
  if (!subject.startsWith('release(train): '))
    throw new Error('Train requires a release(train) commit');
  await tagValidatedRelease(train.releases, head, subject, execution);
}

/**
 * A `release/…` branch exists to carry one candidate through its exact-SHA CI
 * run. Once that commit is on the default branch and tagged, the branch says
 * nothing the tag does not — and twenty-nine of them had piled up, local and
 * remote. Only branches whose tip is already contained in the released head
 * are removed, so nothing unreleased goes with them. The tags are pushed by
 * then, so a failure here is reported and does not fail the release.
 */
async function retireReleaseBranches(
  head: string,
  execution: ReleaseExecution,
): Promise<void> {
  const merged = async (refs: string, format: string): Promise<string[]> =>
    (
      await execution.output([
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
      await execution.run(command);
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
    await execution.run(['git', 'fetch', '--prune', 'origin']);
    for (const branch of await merged('refs/remotes/origin/release/', '%(refname:lstrip=3)')) {
      await retire(['git', 'push', 'origin', '--delete', branch]);
    }
  } catch (error) {
    process.stderr.write(
      `Release branches were not retired: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}
