import { afterAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CiRunListSchema, type CiRunSummary } from './release-ci';
import { assertReleaseSubjectForTag, type CommitFacts } from './release-subject';
import { type ReleaseCommands, releaseTrain } from './release-tagging';
import { readFromWorkingTree } from './starter-lockfile';

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});
const SHA = 'a'.repeat(40);
const green = { id: 1, head_sha: SHA, event: 'push', conclusion: 'success' };

const METADATA = ['CHANGELOG.md', 'release-train.json', 'bun.lock'];
const releaseCommit: CommitFacts = {
  sha: SHA,
  subject: 'release(train): packages in 0.1.1',
  files: METADATA,
};

async function fixture(
  runs: readonly CiRunSummary[] | Error,
  history: readonly CommitFacts[] = [releaseCommit],
) {
  const root = await mkdtemp(join(tmpdir(), 'release-tag-boundary-'));
  roots.push(root);
  await mkdir(join(root, 'packages/core'), { recursive: true });
  await writeFile(
    join(root, 'packages/core/package.json'),
    JSON.stringify({ version: '0.1.1' }),
  );
  await writeFile(
    join(root, 'release-train.json'),
    JSON.stringify({
      schemaVersion: 1,
      releases: [
        { target: 'core', version: '0.1.1' },
        { target: 'tui', version: '0.2.2' },
      ],
    }),
  );
  const calls: string[][] = [];
  const execution: ReleaseCommands = {
    root,
    run: async (command) => {
      calls.push(command);
    },
    output: async (command) => {
      if (command[1] === 'branch') return 'master';
      if (command[1] === 'status' || command[1] === 'for-each-ref') return '';
      if (command[1] === 'rev-parse') return SHA;
      throw new Error(`Unexpected command ${command.join(' ')}`);
    },
    validateTag: async (tag) => {
      calls.push(['metadata', tag]);
    },
    validateSubject: (head, tag) =>
      assertReleaseSubjectForTag({
        root,
        tag,
        head,
        read: readFromWorkingTree(root),
        history: async () => history,
      }),
    askCi: async (sha) => {
      calls.push(['ci', sha]);
      if (runs instanceof Error) throw runs;
      return runs;
    },
  };
  return { calls, execution, invoke: () => releaseTrain(execution) };
}

test('the entrypoint refuses unsupported CI before every tag/push/retirement', async () => {
  for (const runs of [
    [],
    [{ ...green, conclusion: null }],
    [{ ...green, conclusion: 'failure' }],
    [{ ...green, conclusion: 'cancelled' }],
    [{ ...green, event: 'pull_request' }],
    [{ ...green, event: 'schedule' }],
    [{ ...green, head_sha: 'b'.repeat(40) }],
    new Error('API refused'),
  ]) {
    const { calls, invoke } = await fixture(runs);
    await expect(invoke()).rejects.toThrow();
    expect(
      calls.filter((call) =>
        ['tag', 'push', 'for-each-ref', 'branch'].includes(call[1] ?? ''),
      ),
    ).toEqual([]);
    expect(calls.filter((call) => call[0] === 'ci')).toEqual([['ci', SHA]]);
  }
});

test('the entrypoint accepts exact successful push reruns and tags every target', async () => {
  const { calls, invoke } = await fixture([{ ...green, id: 2, conclusion: 'failure' }, green]);
  await invoke();
  const firstTag = calls.findIndex((call) => call[1] === 'tag');
  const ci = calls.findIndex((call) => call[0] === 'ci');
  expect(ci).toBeGreaterThan(0);
  expect(firstTag).toBeGreaterThan(ci);
  expect(calls.slice(0, ci).filter((call) => call[0] === 'metadata')).toHaveLength(2);
  expect(calls.filter((call) => call[1] === 'tag')).toEqual([
    ['git', 'tag', 'v0.1.1', SHA],
    ['git', 'tag', 'stitchkit-tui-v0.2.2', SHA],
  ]);
});

test('a head that is not a release commit stops before CI is asked and before any tag', async () => {
  const { calls, invoke } = await fixture(
    [green],
    [
      {
        sha: SHA,
        subject: 'test(server): align shutdown timing',
        files: ['packages/core/tests/a.test.ts'],
      },
    ],
  );
  await expect(invoke()).rejects.toThrow('must point at a "release(train)');
  expect(calls.map((call) => call[0])).not.toContain('ci');
  expect(calls.map((call) => call[1])).not.toContain('tag');
});

test('a dirty tree stops the release before any remote question', async () => {
  const { calls, execution, invoke } = await fixture([green]);
  const output = execution.output;
  execution.output = async (command) =>
    command[1] === 'status' ? ' M CHANGELOG.md' : output(command);
  await expect(invoke()).rejects.toThrow('must be committed before tagging');
  expect(calls).toEqual([]);
});

test('failure of the second package metadata leaves zero tags and never asks CI', async () => {
  const { calls, execution, invoke } = await fixture([green]);
  execution.validateTag = async (tag) => {
    calls.push(['metadata', tag]);
    if (tag.startsWith('stitchkit-tui')) throw new Error('second metadata refused');
  };
  await expect(invoke()).rejects.toThrow('second metadata refused');
  expect(calls.map((call) => call[1])).not.toContain('tag');
  expect(calls.map((call) => call[1])).not.toContain('push');
  expect(calls.map((call) => call[0])).not.toContain('ci');
});

test('CI disk/API boundary rejects malformed summaries', () => {
  expect(CiRunListSchema.safeParse([green]).success).toBe(true);
  for (const bad of [null, {}, [{ ...green, id: -1 }], [{ ...green, conclusion: undefined }]])
    expect(CiRunListSchema.safeParse(bad).success).toBe(false);
});
