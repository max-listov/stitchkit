import { describe, expect, test } from 'bun:test';
import {
  ciAlreadyAnsweredFor,
  classifyPrePush,
  localGateProfile,
  prePushMetadataGate,
} from './release-prepush';

const SHA = '1'.repeat(40);
const ZERO = '0'.repeat(40);

describe('pre-push classification', () => {
  test('classifies branch, tag, deletion and mixed pushes without duplicate gates', () => {
    expect(classifyPrePush(`refs/heads/topic ${SHA} refs/heads/topic ${ZERO}\n`)).toEqual({
      verify: true,
      releaseTags: [],
      branchHeads: [SHA],
      defaultBranchHeads: [],
      releaseBranchesOnly: false,
    });
    expect(classifyPrePush(`refs/tags/v1.2.3 ${ZERO} refs/tags/v1.2.3 ${SHA}\n`)).toEqual({
      verify: false,
      releaseTags: [],
      branchHeads: [],
      defaultBranchHeads: [],
      releaseBranchesOnly: false,
    });
    expect(
      classifyPrePush(
        `refs/heads/main ${SHA} refs/heads/main ${ZERO}\nrefs/tags/v1.2.3 ${SHA} refs/tags/v1.2.3 ${ZERO}\n`,
      ),
    ).toEqual({
      verify: true,
      releaseTags: [{ tag: 'v1.2.3', sha: SHA }],
      branchHeads: [SHA],
      defaultBranchHeads: [SHA],
      releaseBranchesOnly: false,
    });
  });

  test('a pushed branch tip is reported so a release push can prove the starter on HEAD', () => {
    // `verify` alone cannot tell WHICH commit is being pushed, and the packed
    // HEAD starter lane is worth its minutes only on the one release push.
    const other = '2'.repeat(40);
    expect(
      classifyPrePush(
        `HEAD ${SHA} refs/heads/master ${ZERO}\nHEAD ${other} refs/heads/topic ${ZERO}\n`,
      ).branchHeads,
    ).toEqual([SHA, other]);
    expect(
      classifyPrePush(`refs/heads/master ${SHA} refs/heads/master ${ZERO}\n`.repeat(2))
        .branchHeads,
    ).toEqual([SHA]);
  });
});

describe('the local gate runs where a red CI run cannot be paid for', () => {
  const toMaster = {
    verify: true,
    releaseTags: [],
    branchHeads: [SHA],
    defaultBranchHeads: [SHA],
    releaseBranchesOnly: false,
  };
  const toReleaseBranch = {
    verify: true,
    releaseTags: [],
    branchHeads: [SHA],
    defaultBranchHeads: [],
    releaseBranchesOnly: true,
  };

  test('an ordinary push runs the fast half', () => {
    expect(localGateProfile(toMaster, [])).toBe('fast');
  });

  test('a release commit pushed to master runs everything', () => {
    // This is the one commit whose red run cannot be repaired in place: the tag
    // must sit on a `release(...)` commit AND on the branch head, so a red run
    // costs a whole new release commit. That asymmetry is the entire argument
    // for the expensive local gate — not a general distrust of CI.
    expect(localGateProfile(toMaster, [SHA])).toBe('full');
  });

  test('the same commit pushed to a release branch leaves the gate to CI', () => {
    // Nothing is published by that push. CI runs on the exact SHA, master is
    // fast-forwarded to it only once that run is green, and a red one is
    // repaired by a new candidate commit before tagging. It
    // is the same commit and the same tree; only where it lands differs, and
    // that is exactly what the old boolean could not say.
    expect(localGateProfile(toReleaseBranch, [SHA])).toBe('candidate');
  });

  test('a release commit riding along to master still runs everything', () => {
    // Pushing several branches at once must not let the release commit's own
    // landing go ungated because a topic branch was in the same push.
    expect(
      localGateProfile(
        {
          verify: true,
          releaseTags: [],
          branchHeads: [SHA, '2'.repeat(40)],
          defaultBranchHeads: [SHA],
          releaseBranchesOnly: false,
        },
        [SHA],
      ),
    ).toBe('full');
  });

  test('a tag-only push gates on metadata alone', () => {
    // By the time a tag is pushed its commit already has a green exact-SHA run;
    // repeating the tree gate here would check a tree CI has already answered
    // for.
    expect(
      localGateProfile(
        {
          verify: false,
          releaseTags: [{ tag: 'v1.0.0', sha: SHA }],
          branchHeads: [],
          defaultBranchHeads: [],
          releaseBranchesOnly: false,
        },
        [],
      ),
    ).toBe('none');
  });
});

describe('CI answering for the exact SHA replaces the local release gate', () => {
  const green = [{ id: 7, head_sha: SHA, event: 'push', conclusion: 'success' }];

  test('a green push run for the SHA means the gate has already run', async () => {
    const answered = await ciAlreadyAnsweredFor([SHA], async () => green);
    expect(answered.green).toBe(true);
    expect(answered.because).toContain(SHA.slice(0, 7));
  });

  test('a red run is not an answer, and says which', async () => {
    const answered = await ciAlreadyAnsweredFor([SHA], async () => [
      { id: 7, head_sha: SHA, event: 'push', conclusion: 'failure' },
    ]);
    expect(answered.green).toBe(false);
    expect(answered.because).toContain('failure');
  });

  test('a pull-request run for the same SHA is not the push run the release needs', async () => {
    const answered = await ciAlreadyAnsweredFor([SHA], async () => [
      { id: 7, head_sha: SHA, event: 'pull_request', conclusion: 'success' },
    ]);
    expect(answered.green).toBe(false);
  });

  test('unreachable GitHub is not green, and does not look like a red run', async () => {
    // The distinction the gate line prints: it ran because the answer was no,
    // or because nobody could ask. Collapsing those is how a skipped gate
    // becomes unexplainable.
    const answered = await ciAlreadyAnsweredFor([SHA], async () => {
      throw new Error('gh: not authenticated');
    });
    expect(answered.green).toBe(false);
    expect(answered.because).toContain('could not ask GitHub');
  });

  test('every landing commit must be answered for, not just the first', async () => {
    const other = '2'.repeat(40);
    const answered = await ciAlreadyAnsweredFor([SHA, other], async (sha) =>
      sha === SHA ? green : [],
    );
    expect(answered.green).toBe(false);
    expect(answered.because).toContain(other);
  });

  test('nothing landing means nothing has been answered for', async () => {
    expect((await ciAlreadyAnsweredFor([], async () => green)).green).toBe(false);
  });
});

describe('the cheap metadata check runs before the expensive gate', () => {
  const order: string[] = [];
  const recording = (releaseCommits: { sha: string; subject: string }[]) => ({
    validateTag: async (tag: string) => {
      order.push(`tag:${tag}`);
    },
    releaseCommits: async () => releaseCommits,
    validateCommit: async (commit: { sha: string; subject: string }) => {
      order.push(`commit:${commit.sha}`);
    },
  });

  test('a pushed release commit is validated, and the profile is the expensive one', async () => {
    order.length = 0;
    const decision = await prePushMetadataGate(
      {
        verify: true,
        releaseTags: [],
        branchHeads: [SHA],
        defaultBranchHeads: [SHA],
        releaseBranchesOnly: false,
      },
      recording([{ sha: SHA, subject: 'release(train): a thing in 9.9.0' }]),
    );
    // The regression this whole change exists for: before it, nothing here
    // read the release commit's changelog and `order` stayed empty.
    expect(order).toEqual([`commit:${SHA}`]);
    expect(decision.profile).toBe('full');
    expect(decision.releaseCommits).toHaveLength(1);
  });

  test('a repair tip validates its lower metadata commit and profiles the pushed tree', async () => {
    order.length = 0;
    const metadataSha = '2'.repeat(40);
    const decision = await prePushMetadataGate(
      {
        verify: true,
        releaseTags: [],
        branchHeads: [SHA],
        defaultBranchHeads: [],
        releaseBranchesOnly: true,
      },
      {
        validateTag: async () => undefined,
        releaseCommits: async () => [
          {
            sha: SHA,
            metadataSha,
            subject: 'release(train): a repaired thing in 9.9.0',
          },
        ],
        validateCommit: async (commit) => {
          order.push(`commit:${commit.metadataSha}->${commit.sha}`);
        },
      },
    );
    expect(order).toEqual([`commit:${metadataSha}->${SHA}`]);
    expect(decision.profile).toBe('candidate');
    expect(decision.releaseCommits).toEqual([
      {
        sha: SHA,
        metadataSha,
        subject: 'release(train): a repaired thing in 9.9.0',
      },
    ]);
  });

  test('a refusal stops the push before any gate is chosen', async () => {
    const checks = recording([{ sha: SHA, subject: 'release(train): a thing in 9.9.0' }]);
    await expect(
      prePushMetadataGate(
        {
          verify: true,
          releaseTags: [],
          branchHeads: [SHA],
          defaultBranchHeads: [SHA],
          releaseBranchesOnly: false,
        },
        {
          ...checks,
          validateCommit: () => Promise.reject(new Error('no Who must act line')),
        },
      ),
    ).rejects.toThrow('no Who must act line');
  });

  test('an ordinary push reads no release metadata and stays fast', async () => {
    order.length = 0;
    const decision = await prePushMetadataGate(
      {
        verify: true,
        releaseTags: [],
        branchHeads: [SHA],
        defaultBranchHeads: [SHA],
        releaseBranchesOnly: false,
      },
      recording([]),
    );
    expect(order).toEqual([]);
    expect(decision.profile).toBe('fast');
  });

  test('a tag push still checks the tag, and checks it first', async () => {
    order.length = 0;
    const decision = await prePushMetadataGate(
      {
        verify: true,
        releaseTags: [{ tag: 'v9.9.0', sha: SHA }],
        branchHeads: [SHA],
        defaultBranchHeads: [SHA],
        releaseBranchesOnly: false,
      },
      recording([{ sha: SHA, subject: 'release(train): a thing in 9.9.0' }]),
    );
    expect(order).toEqual(['tag:v9.9.0', `commit:${SHA}`]);
    expect(decision.profile).toBe('full');
  });
});

test('only release tips in the remote release namespace earn the candidate preflight', () => {
  const candidate = classifyPrePush(`HEAD ${SHA} refs/heads/release/9.9.0 ${ZERO}\n`);
  expect(candidate.releaseBranchesOnly).toBe(true);
  expect(localGateProfile(candidate, [SHA])).toBe('candidate');
  expect(localGateProfile(candidate, [])).toBe('fast');
  const topic = classifyPrePush(`refs/heads/release/9.9.0 ${SHA} refs/heads/topic ${ZERO}\n`);
  expect(topic.releaseBranchesOnly).toBe(false);
  expect(localGateProfile(topic, [SHA])).toBe('fast');
  const mixed = classifyPrePush(
    `HEAD ${SHA} refs/heads/release/9.9.0 ${ZERO}\nHEAD ${'2'.repeat(40)} refs/heads/topic ${ZERO}\n`,
  );
  expect(localGateProfile(mixed, [SHA])).toBe('fast');
  const sameShaTopic = classifyPrePush(
    `HEAD ${SHA} refs/heads/release/9.9.0 ${ZERO}\nHEAD ${SHA} refs/heads/topic ${ZERO}\n`,
  );
  expect(localGateProfile(sameShaTopic, [SHA])).toBe('fast');
  const landing = classifyPrePush(
    `HEAD ${SHA} refs/heads/release/9.9.0 ${ZERO}\nHEAD ${SHA} refs/heads/master ${ZERO}\n`,
  );
  expect(localGateProfile(landing, [SHA])).toBe('full');
});
