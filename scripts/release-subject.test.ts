import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  assertReleaseMetadataOnly,
  assertReleaseSubjectForTag,
  type CommitFacts,
  firstParentHistory,
  isReleaseCommitSubject,
  stacksOnUnpublishedRelease,
  unpublishedReleaseCommitAtHead,
} from './release-subject';

const SHA = '1'.repeat(40);
const root = resolve(import.meta.dir, '..');
const METADATA = [
  'CHANGELOG.md',
  'release-train.json',
  'bun.lock',
  'packages/core/package.json',
];

const trainOf = (releases: { target: string; version: string }[]) => async () =>
  JSON.stringify({ schemaVersion: 1, releases });
const coreTrain = trainOf([{ target: 'core', version: '0.9.0' }]);

const commit = (sha: string, subject: string, files: string[]): CommitFacts => ({
  sha: sha.repeat(40),
  subject,
  files,
});
const RELEASE = commit('a', 'release(train): a thing in 0.9.0', METADATA);
const FEATURE = commit('b', 'feat(tools): a thing', ['packages/core/src/tools/a.ts']);

const tag = (history: CommitFacts[], read = coreTrain) =>
  assertReleaseSubjectForTag({
    root,
    tag: 'v0.9.0',
    head: history[0]?.sha ?? SHA,
    read,
    history: async () => history,
  });

describe('which commit a release tag may sit on', () => {
  test('only the train subject opens the release gates', () => {
    expect(isReleaseCommitSubject('release(train): a thing in 0.56.1')).toBe(true);
    expect(isReleaseCommitSubject('  release(train): a thing in 0.4.0  ')).toBe(true);
    for (const subject of [
      'release(core): cancellations in 0.56.1',
      'release(starter): a starter cut in 0.4.0',
      'fix(server): an error code map may be partial',
      'release: 0.4.0',
      'chore: mention release(train): in a body',
      '',
    ]) {
      expect(isReleaseCommitSubject(subject)).toBe(false);
    }
  });

  test('the release commit itself is the tagged head', async () => {
    await expect(tag([RELEASE, FEATURE])).resolves.toBeUndefined();
  });

  test('a fix commit with its own type may sit on the release commit', async () => {
    const fix = commit('c', 'fix(tools): repair the red candidate', [
      'packages/core/src/tools/a.ts',
    ]);
    const test = commit('d', 'test(tools): cover it', ['packages/core/tests/a.test.ts']);
    await expect(tag([test, fix, RELEASE, FEATURE])).resolves.toBeUndefined();
  });

  test('a head with no release commit below it is refused, naming the honest order', async () => {
    await expect(tag([FEATURE, commit('c', 'chore: x', ['a'])])).rejects.toThrow(
      'must point at a "release(train): … in 0.9.0" commit',
    );
    await expect(tag([commit('c', '', ['a'])])).rejects.toThrow('(empty)');
  });

  test('an empty commit is refused as head, above the release commit and as the release commit', async () => {
    const empty = commit('e', 'fix(tools): nothing', []);
    await expect(tag([empty, RELEASE])).rejects.toThrow(/above the release commit is empty/);
    await expect(tag([{ ...RELEASE, files: [] }])).rejects.toThrow(/is empty/);
    // The shape of a repeated release subject on top of a test commit.
    await expect(
      tag([{ ...RELEASE, sha: 'f'.repeat(40), files: [] }, RELEASE]),
    ).rejects.toThrow(/is empty/);
  });

  test('a commit above the release commit needs a conventional subject', async () => {
    const loose = commit('c', 'repair the thing', ['packages/core/src/tools/a.ts']);
    await expect(tag([loose, RELEASE])).rejects.toThrow(/no conventional subject/);
  });

  test('a release commit that carries features is refused', async () => {
    const everything = {
      ...RELEASE,
      files: [...METADATA, 'packages/core/src/tools/a.ts', 'docs/api/reference.md'],
    };
    await expect(tag([everything])).rejects.toThrow(/more than release metadata/);
  });

  test('a repeated release subject over source changes is not a release commit', async () => {
    const repair = commit('c', 'release(train): repair in 0.9.0', [
      'packages/core/tests/a.test.ts',
    ]);
    await expect(tag([repair, RELEASE])).rejects.toThrow(/more than release metadata/);
  });

  test('one train subject authorizes only exact manifest entries', async () => {
    const train = trainOf([
      { target: 'tui', version: '0.1.1' },
      { target: 'create-stitchkit', version: '0.4.4' },
    ]);
    const history = [
      commit('a', 'release(train): publish terminal and starter packages', METADATA),
    ];
    const run = (tagName: string) =>
      assertReleaseSubjectForTag({
        root,
        tag: tagName,
        head: SHA,
        read: train,
        history: async () => history,
      });
    await expect(run('stitchkit-tui-v0.1.1')).resolves.toBeUndefined();
    await expect(run('create-stitchkit-v0.4.4')).resolves.toBeUndefined();
    await expect(run('v0.70.1')).rejects.toThrow(/does not select core/);
    await expect(run('stitchkit-tui-v0.1.2')).rejects.toThrow(/does not select tui@0\.1\.2/);
  });
});

describe('whether a head stacks on a release no tag contains yet', () => {
  const FIX = commit('c', 'fix(core): repair a red candidate', ['packages/core/src/a.ts']);
  const asks = (history: CommitFacts[], tagged: boolean) =>
    stacksOnUnpublishedRelease({
      head: history[0]?.sha ?? SHA,
      history: async () => history,
      isTagged: async () => tagged,
    });

  test('the release commit itself and conventional fixes stacked on it count', async () => {
    expect(await asks([RELEASE, FEATURE], false)).toBe(true);
    expect(await asks([FIX, RELEASE, FEATURE], false)).toBe(true);
    await expect(
      unpublishedReleaseCommitAtHead({
        head: FIX.sha,
        history: async () => [FIX, RELEASE, FEATURE],
        isTagged: async () => false,
      }),
    ).resolves.toEqual(RELEASE);
  });

  test('a release a tag already contains is published, so what follows it is ordinary', async () => {
    expect(await asks([FIX, RELEASE, FEATURE], true)).toBe(false);
  });

  test('no release below the head, or a commit that is not conventional above it, does not', async () => {
    expect(await asks([FIX, FEATURE], false)).toBe(false);
    expect(await asks([commit('d', 'wip', ['a.ts']), RELEASE], false)).toBe(false);
  });
});

describe('which files a release commit may change', () => {
  test('metadata passes, anything else is named', () => {
    expect(() =>
      assertReleaseMetadataOnly(SHA, [
        ...METADATA,
        'packages/tui/CHANGELOG.md',
        'packages/create-stitchkit/UPGRADING.md',
        'docs/guide/upgrading.md',
        'docs/guide/getting-started.md',
        'scripts/surface-cadence.test.ts',
      ]),
    ).not.toThrow();
    for (const foreign of [
      'packages/core/src/a.ts',
      'docs/architecture/gates.md',
      'scripts/a.ts',
      'README.md',
    ]) {
      expect(() => assertReleaseMetadataOnly(SHA, ['CHANGELOG.md', foreign])).toThrow(foreign);
    }
    expect(() => assertReleaseMetadataOnly(SHA, [])).toThrow(/is empty/);
  });
});

describe('first-parent history read from a real repository', () => {
  const created: string[] = [];
  afterAll(async () => {
    for (const path of created) await rm(path, { recursive: true, force: true });
  });

  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd, stderr: 'pipe', stdout: 'pipe' });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };

  test('lists newest first with the files each commit changed, and an empty commit as empty', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'release-subject-'));
    created.push(repository);
    git(repository, 'init', '-q', '-b', 'master');
    git(repository, 'config', 'user.email', 'a@example.com');
    git(repository, 'config', 'user.name', 'a');
    git(repository, 'config', 'commit.gpgsign', 'false');
    const commitFile = async (path: string, subject: string) => {
      await mkdir(dirname(join(repository, path)), { recursive: true });
      await writeFile(join(repository, path), subject);
      git(repository, 'add', '--', path);
      git(repository, 'commit', '-q', '-m', subject);
    };
    await commitFile('packages/core/src/a.ts', 'feat(core): add a');
    await commitFile('CHANGELOG.md', 'release(train): add a in 0.9.0');
    git(repository, 'commit', '-q', '--allow-empty', '-m', 'fix(core): nothing');

    const history = await firstParentHistory(repository)('HEAD');
    expect(history.map((entry) => entry.subject)).toEqual([
      'fix(core): nothing',
      'release(train): add a in 0.9.0',
      'feat(core): add a',
    ]);
    expect(history.map((entry) => entry.files)).toEqual([
      [],
      ['CHANGELOG.md'],
      ['packages/core/src/a.ts'],
    ]);
    expect(history.every((entry) => /^[0-9a-f]{40}$/.test(entry.sha))).toBe(true);
  });
});
