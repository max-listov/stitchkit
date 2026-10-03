import { afterAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CiRunListSchema, type CiRunSummary } from './release-ci';
import { assertReleaseSubjectForTag } from './release-plan';
import { type ReleaseExecution, release, releaseTrain } from './release-tagging';

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});
const SHA = 'a'.repeat(40);
const green = { id: 1, head_sha: SHA, event: 'push', conclusion: 'success' };

async function fixture(train: boolean, runs: readonly CiRunSummary[] | Error) {
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
  const execution: ReleaseExecution = {
    root,
    run: async (command) => {
      calls.push(command);
    },
    output: async (command) => {
      if (command[1] === 'branch') return 'master';
      if (command[1] === 'status' || command[1] === 'for-each-ref') return '';
      if (command[1] === 'rev-parse') return SHA;
      if (command[1] === 'log')
        return train ? 'release(train): packages in 0.1.1' : 'release(core): fix in 0.1.1';
      throw new Error(`Unexpected command ${command.join(' ')}`);
    },
    validateTag: async (tag) => {
      calls.push(['metadata', tag]);
    },
    validateSubject: (subject, tag, version) =>
      assertReleaseSubjectForTag(root, subject, tag, version),
    askCi: async (sha) => {
      calls.push(['ci', sha]);
      if (runs instanceof Error) throw runs;
      return runs;
    },
  };
  return {
    calls,
    execution,
    invoke: () => (train ? releaseTrain(execution) : release('core', execution)),
  };
}

for (const train of [false, true]) {
  test(`actual ${train ? 'train' : 'legacy'} entrypoint refuses unsupported CI before every tag/push/retirement`, async () => {
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
      const { calls, invoke } = await fixture(train, runs);
      await expect(invoke()).rejects.toThrow();
      expect(
        calls.filter((call) =>
          ['tag', 'push', 'for-each-ref', 'branch'].includes(call[1] ?? ''),
        ),
      ).toEqual([]);
      expect(calls.filter((call) => call[0] === 'ci')).toEqual([['ci', SHA]]);
    }
  });
  test(`actual ${train ? 'train' : 'legacy'} entrypoint accepts exact successful push reruns`, async () => {
    const { calls, invoke } = await fixture(train, [
      { ...green, id: 2, conclusion: 'failure' },
      green,
    ]);
    await invoke();
    const firstTag = calls.findIndex((call) => call[1] === 'tag');
    const ci = calls.findIndex((call) => call[0] === 'ci');
    expect(ci).toBeGreaterThan(0);
    expect(firstTag).toBeGreaterThan(ci);
    expect(calls.slice(0, ci).filter((call) => call[0] === 'metadata')).toHaveLength(
      train ? 2 : 1,
    );
    expect(calls.filter((call) => call[1] === 'tag')).toEqual(
      train
        ? [
            ['git', 'tag', 'v0.1.1', SHA],
            ['git', 'tag', 'stitchkit-tui-v0.2.2', SHA],
          ]
        : [['git', 'tag', 'v0.1.1', SHA]],
    );
  });
}

test('failure of the second package metadata leaves zero tags and never asks CI', async () => {
  const { calls, execution, invoke } = await fixture(true, [green]);
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
