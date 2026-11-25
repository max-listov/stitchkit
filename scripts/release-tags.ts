import { git } from './local-git';
import { RELEASE_TARGETS, type ReleaseTarget, ReleaseTargetSchema } from './release-train';

/**
 * The local release tags of a target. Every check that compares a release with the published ones
 * reads them through here, and a clone that holds none is refused: no tags means the clone was
 * made without them, never that nothing was published. A clone fetches them with
 * `git fetch origin --tags`; a workflow job checks out with `fetch-depth: 0`
 * (`scripts/workflow-tags.test.ts` holds every job that reaches this to it). A caller for whom
 * the target may never have been released passes `firstRelease`: then only a clone with no
 * release tag of any target is refused.
 */
export async function releaseTags(
  root: string,
  target: ReleaseTarget,
  options: { firstRelease?: boolean } = {},
): Promise<string[]> {
  const { tagPrefix, packageName } = RELEASE_TARGETS[target];
  const list = async (prefix: string) =>
    (await git(root, ['tag', '--list', `${prefix}*`]))
      .split('\n')
      .map((tag) => tag.trim())
      .filter((tag) => tag !== '');
  const tags = await list(tagPrefix);
  if (tags.length > 0) return tags;
  if (options.firstRelease) {
    for (const other of ReleaseTargetSchema.options)
      if ((await list(RELEASE_TARGETS[other].tagPrefix)).length > 0) return [];
  }
  if (tags.length === 0)
    throw new Error(
      `No local release tags matching "${tagPrefix}*" in ${root}: this check compares with the published ${packageName} releases. Run \`git fetch origin --tags\` in a clone; a GitHub Actions job checks out with \`fetch-depth: 0\`.`,
    );
  return tags;
}
