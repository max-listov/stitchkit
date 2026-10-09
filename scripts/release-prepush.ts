import { type CiRunSummary, selectSuccessfulCiRun } from './release-ci';
import { targetForTag } from './release-train';

const ZERO_SHA = /^0+$/;

export interface ReleaseTagPush {
  tag: string;
  /** The SHA git is actually sending — NOT whatever the local tag name resolves to. */
  sha: string;
}

/** Branch refs a release may land on directly, and be tagged from. */
export const DEFAULT_BRANCH_REFS = ['refs/heads/master', 'refs/heads/main'];

export interface PrePushPlan {
  verify: boolean;
  releaseTags: ReleaseTagPush[];
  /** Local SHAs of the pushed branch tips — where a release commit can sit. */
  branchHeads: string[];
  /**
   * The subset of those tips going to a branch a tag can be cut from.
   *
   * Which branch a release commit lands on decides who gates it. On master it
   * is published the moment it is pushed, and a red CI run there is repaired
   * only by a NEW commit — so the expensive local gate runs first. On any
   * other branch CI gates that exact SHA before master ever sees it, so paying
   * the same eight minutes locally buys nothing.
   */
  defaultBranchHeads: string[];
  /** Every pushed branch ref belongs to the CI-enabled release namespace. */
  releaseBranchesOnly: boolean;
}

export function classifyPrePush(input: string): PrePushPlan {
  let verify = false;
  const releaseTags = new Map<string, string>();
  const branchHeads = new Set<string>();
  const defaultBranchHeads = new Set<string>();
  let releaseBranchesOnly = true;
  for (const line of input.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4) continue;
    // git speaks `<local ref> <local sha> <remote ref> <remote sha>`. The
    // REMOTE ref decides what this push changes: the local ref is `HEAD` for
    // `git push origin HEAD:master` and a bare SHA for `<sha>:refs/tags/…`.
    const [, localSha, remoteRef] = fields;
    if (!remoteRef || !localSha || ZERO_SHA.test(localSha)) continue;
    if (remoteRef.startsWith('refs/heads/')) {
      verify = true;
      branchHeads.add(localSha);
      if (!remoteRef.startsWith('refs/heads/release/')) releaseBranchesOnly = false;
      if (DEFAULT_BRANCH_REFS.includes(remoteRef)) defaultBranchHeads.add(localSha);
    }
    if (remoteRef.startsWith('refs/tags/')) {
      const tag = remoteRef.slice('refs/tags/'.length);
      // `git push origin <sha>:refs/tags/vX` sends a SHA the local tag name
      // may not point at — classify by what is on the wire.
      if (targetForTag(tag) !== undefined) releaseTags.set(tag, localSha);
    }
  }
  return {
    verify,
    releaseTags: [...releaseTags].map(([tag, sha]) => ({ tag, sha })),
    branchHeads: [...branchHeads],
    defaultBranchHeads: [...defaultBranchHeads],
    releaseBranchesOnly: verify && releaseBranchesOnly,
  };
}

/** What the local gate runs for one push. */
export type LocalGateProfile = 'none' | 'fast' | 'full' | 'candidate';

/**
 * Unproven default-branch releases retain the full gate. A release candidate
 * pays structural preflight; the same unit tests and every selected evidence
 * lane must pass in exact-SHA push CI before master/tag. Ordinary or mixed
 * branch pushes keep fast checks, and metadata/privacy always run first.
 */
export function localGateProfile(
  plan: PrePushPlan,
  releaseCommitShas: readonly string[],
): LocalGateProfile {
  if (!plan.verify) return 'none';
  const landsOnDefaultBranch = releaseCommitShas.some((sha) =>
    plan.defaultBranchHeads.includes(sha),
  );
  if (landsOnDefaultBranch) return 'full';
  const onlyReleaseCandidates =
    plan.releaseBranchesOnly &&
    plan.branchHeads.length > 0 &&
    plan.branchHeads.every((sha) => releaseCommitShas.includes(sha));
  return onlyReleaseCandidates ? 'candidate' : 'fast';
}

/** What the cheap half of a pre-push decided, and what it found on the way. */
export interface PrePushGateDecision {
  profile: LocalGateProfile;
  /** `sha` is the pushed tree; `metadataSha` names its lower release commit when repaired. */
  releaseCommits: readonly { sha: string; subject: string; metadataSha?: string }[];
}

/**
 * Cheap deterministic metadata first — for tags AND for release commits.
 *
 * The order is the whole guarantee, so it lives in one function that can be
 * observed rather than in the sequence of statements inside `main`. Both kinds
 * of release metadata are read before any expensive gate is chosen, because
 * both are one file and a regular expression, and because what they refuse
 * cannot be repaired in place once it is pushed.
 */
export async function prePushMetadataGate(
  plan: PrePushPlan,
  checks: {
    validateTag(tag: string, sha: string): Promise<void>;
    releaseCommits(
      branchHeads: readonly string[],
    ): Promise<{ sha: string; subject: string; metadataSha?: string }[]>;
    validateCommit(commit: {
      sha: string;
      subject: string;
      metadataSha?: string;
    }): Promise<void>;
  },
): Promise<PrePushGateDecision> {
  for (const { tag, sha } of plan.releaseTags) {
    await checks.validateTag(tag, sha);
  }
  const releaseCommits = plan.verify ? await checks.releaseCommits(plan.branchHeads) : [];
  for (const commit of releaseCommits) {
    await checks.validateCommit(commit);
  }
  return {
    profile: localGateProfile(
      plan,
      releaseCommits.map((commit) => commit.sha),
    ),
    releaseCommits,
  };
}

/**
 * Has CI already answered for these exact commits?
 *
 * A commit that reached master by fast-forward from a release branch has had
 * its run on this exact SHA, and that run also covers the lanes no local
 * kernel can run, so re-running the local gate re-answers a settled question.
 *
 * Three outcomes, not two: green, a named refusal, and "could not ask". The
 * last one is not green — the gate runs — but it says so, so a reader never
 * guesses whether the gate ran because the answer was no or because GitHub
 * was unreachable.
 */
export async function ciAlreadyAnsweredFor(
  shas: readonly string[],
  ask: (sha: string) => Promise<readonly CiRunSummary[]>,
): Promise<{ green: boolean; because: string }> {
  if (shas.length === 0) return { green: false, because: 'no release commit in this push' };
  for (const sha of shas) {
    let runs: readonly CiRunSummary[];
    try {
      runs = await ask(sha);
    } catch (error) {
      return {
        green: false,
        because: `could not ask GitHub about ${sha.slice(0, 7)} (${
          error instanceof Error ? error.message : String(error)
        })`,
      };
    }
    try {
      selectSuccessfulCiRun(runs, sha);
    } catch (error) {
      return { green: false, because: error instanceof Error ? error.message : String(error) };
    }
  }
  return {
    green: true,
    because: `a successful push run already exists for ${shas
      .map((sha) => sha.slice(0, 7))
      .join(', ')}`,
  };
}
