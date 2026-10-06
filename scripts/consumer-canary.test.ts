import { afterAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ciCandidate,
  describeOutcomes,
  overrideFramework,
  parseCandidateChoice,
  requireConsumerCanary,
  tryCandidateOnConsumers,
} from './consumer-canary';
import {
  CONSUMER_CANARY_GATE,
  type ConsumerProfile,
  consumerProfilePath,
  decideCanary,
  readConsumerProfile,
} from './consumer-canary-policy';
import {
  gateMemoPath,
  toolchainFingerprint,
  worktreeTreeHash,
  writeGreenGate,
} from './gate-memo';

const scratch: string[] = [];
afterAll(async () => {
  for (const path of scratch) await rm(path, { recursive: true, force: true });
});
async function directory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(path);
  return path;
}

async function exec(command: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(command, { cwd, stdout: 'ignore', stderr: 'pipe' });
  const [reason, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${command.join(' ')} failed: ${reason}`);
}

/** A tarball of a package named `stitchkit` that exports one flag: the candidate under test. */
async function candidate(root: string, name: string, contract: boolean): Promise<string> {
  const dir = join(root, `candidate-${name}`);
  await mkdir(join(dir, 'package'), { recursive: true });
  await writeFile(
    join(dir, 'package/package.json'),
    JSON.stringify({ name: 'stitchkit', version: '9.9.9', type: 'module', main: 'index.js' }),
  );
  await writeFile(
    join(dir, 'package/index.js'),
    `export const keepsTheContract = ${contract};\n`,
  );
  const tarball = join(root, `stitchkit-${name}.tgz`);
  await exec(['tar', 'czf', tarball, '-C', dir, 'package'], root);
  return tarball;
}

/**
 * A consumer checkout: one committed test that depends on what `stitchkit` exports, pinned to a
 * tarball of its own the way a real consumer pins a published version; `alreadyRed` adds a test
 * that fails whatever `stitchkit` is.
 */
async function consumer(root: string, pinned: string, alreadyRed = false): Promise<string> {
  const path = join(root, 'consumer');
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, 'package.json'),
    JSON.stringify({
      name: 'consumer',
      private: true,
      type: 'module',
      devDependencies: { stitchkit: `file:${pinned}` },
    }),
  );
  await writeFile(
    join(path, 'contract.test.ts'),
    `import { expect, test } from 'bun:test';\nimport { keepsTheContract } from 'stitchkit';\n\ntest('the candidate keeps the contract this consumer relies on', () => {\n  expect(keepsTheContract).toBe(true);\n});\n`,
  );
  if (alreadyRed)
    await writeFile(
      join(path, 'independent.test.ts'),
      `import { expect, test } from 'bun:test';\n\ntest('a test that fails whatever the framework is', () => {\n  expect(1).toBe(2);\n});\n`,
    );
  await exec(['git', 'init', '--quiet'], path);
  await exec(['git', 'add', '.'], path);
  await exec(
    [
      'git',
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      'commit',
      '--quiet',
      '-m',
      'consumer',
    ],
    path,
  );
  return path;
}

function profile(path: string): ConsumerProfile {
  return {
    schemaVersion: 1,
    consumers: [
      {
        name: 'synthetic',
        path,
        install: ['bun', 'install'],
        test: ['bun', 'test'],
        timeoutMs: 120_000,
      },
    ],
  };
}

// The pair is the control: a canary that has only ever passed does not show it can fail.
test('a candidate that keeps the contract passes and one that breaks it fails by test name', async () => {
  const root = await directory('canary-synthetic-');
  const path = await consumer(root, await candidate(root, 'pinned', true));
  const kept = await tryCandidateOnConsumers(
    profile(path),
    await candidate(root, 'kept', true),
    await directory('canary-kept-'),
  );
  expect(kept).toMatchObject([{ name: 'synthetic', ok: true, failedTests: [] }]);

  const broken = await tryCandidateOnConsumers(
    profile(path),
    await candidate(root, 'broken', false),
    await directory('canary-broken-'),
  );
  expect(broken).toMatchObject([{ name: 'synthetic', ok: false }]);
  expect(broken[0]?.failedTests).toEqual([
    'the candidate keeps the contract this consumer relies on',
  ]);
  expect(describeOutcomes(broken)).toContain('FAIL  synthetic');
  expect(describeOutcomes(broken)).toContain(
    '- the candidate keeps the contract this consumer relies on',
  );
  // The consumer's own checkout is never touched: the candidate went into a clone.
  expect(await readFile(join(path, 'package.json'), 'utf8')).not.toContain('overrides');
}, 180_000);

test('a consumer that cannot install the candidate fails with the install output, not a pass', async () => {
  const root = await directory('canary-install-');
  const path = await consumer(root, await candidate(root, 'pinned', true));
  const failing = profile(path);
  const [only] = failing.consumers;
  if (!only) throw new Error('fixture has one consumer');
  const outcomes = await tryCandidateOnConsumers(
    {
      ...failing,
      consumers: [{ ...only, install: ['sh', '-c', 'echo no registry >&2; exit 4'] }],
    },
    await candidate(root, 'kept', true),
    root,
  );
  expect(outcomes[0]?.ok).toBe(false);
  expect(outcomes[0]?.detail).toContain('install');
  expect(outcomes[0]?.detail).toContain('no registry');
}, 120_000);

test('the override reaches the candidate through the consumer manifest and keeps its own overrides', async () => {
  const root = await directory('canary-override-');
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'c',
      overrides: { zod: '4.6.5' },
      dependencies: { stitchkit: '0.1.0' },
    }),
  );
  await overrideFramework(root, '/tmp/x.tgz');
  expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))).toEqual({
    name: 'c',
    overrides: { zod: '4.6.5', stitchkit: 'file:/tmp/x.tgz' },
    dependencies: { stitchkit: '0.1.0' },
  });
});

test('a missing profile is refused with the way out, and the path is machine configuration', async () => {
  await expect(readConsumerProfile('/nonexistent/canary-profile.json')).rejects.toThrow(
    /No consumer canary profile at \/nonexistent\/canary-profile\.json.*consumerCanaryWaiver|waiver/s,
  );
  expect(
    consumerProfilePath(
      { STITCHKIT_CONSUMER_CANARY_PROFILE: '/etc/p.json' },
      '/home/example-user',
    ),
  ).toBe('/etc/p.json');
  expect(consumerProfilePath({ XDG_CONFIG_HOME: '/cfg' }, '/home/example-user')).toBe(
    '/cfg/stitchkit/consumer-canary.json',
  );
  expect(consumerProfilePath({}, '/home/example-user')).toBe(
    '/home/example-user/.config/stitchkit/consumer-canary.json',
  );
});

test('the canary is required for a breaking framework release or a changed process contract only', () => {
  const base = {
    coreInTrain: true,
    coreNotes: '### Added\n- a thing',
    changedFiles: [] as string[],
  };
  expect(decideCanary({ ...base, coreInTrain: false }).required).toBe(false);
  expect(decideCanary(base).required).toBe(false);
  expect(
    decideCanary({ ...base, changedFiles: ['packages/core/src/server/x.ts'] }).required,
  ).toBe(false);
  expect(decideCanary({ ...base, coreNotes: '### ⚠️ Breaking changes\n- x' })).toMatchObject({
    required: true,
    because: 'the framework release is breaking',
  });
  expect(
    decideCanary({ ...base, changedFiles: ['packages/core/src/process/command-owner.ts'] }),
  ).toMatchObject({ required: true });
  expect(
    decideCanary({ ...base, changedFiles: ['packages/core/src/entrypoints/process.ts'] })
      .required,
  ).toBe(true);
});

/** A release repository as the tag step sees it: a train, a changelog and a clean tree. */
async function releaseRepository(breaking: boolean, waiver?: string): Promise<string> {
  const root = await directory('canary-release-');
  await writeFile(
    join(root, 'release-train.json'),
    JSON.stringify({
      schemaVersion: 1,
      releases: [{ target: 'core', version: '0.2.0' }],
      ...(waiver === undefined ? {} : { consumerCanaryWaiver: waiver }),
    }),
  );
  await writeFile(
    join(root, 'CHANGELOG.md'),
    `# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-10-06\n\n${breaking ? '### ⚠️ Breaking changes\n\n**Who must act:** callers of the thing.\n\n- `stitchkit/process` — the thing changed.\n' : '### Added\n\n- `stitchkit/tools` — a tool was added to the toolbox.\n'}`,
  );
  await exec(['git', 'init', '--quiet'], root);
  return root;
}

test('the tag step refuses a required canary with no record, and accepts a record or a waiver', async () => {
  const memo = await directory('canary-memo-');
  const saved = process.env.STITCHKIT_GATE_MEMO_DIR;
  process.env.STITCHKIT_GATE_MEMO_DIR = memo;
  try {
    const additive = await releaseRepository(false);
    await requireConsumerCanary(additive);

    const root = await releaseRepository(true);
    await expect(requireConsumerCanary(root)).rejects.toThrow(
      /canary is required.*breaking.*consumer-canary/s,
    );

    await writeGreenGate(
      CONSUMER_CANARY_GATE,
      {
        tree: await worktreeTreeHash(root),
        toolchain: await toolchainFingerprint(),
        at: '2026-10-06T00:00:00.000Z',
        commit: 'abc1234',
      },
      gateMemoPath(),
    );
    await requireConsumerCanary(root);

    // A different tree is a different answer: the record does not carry over.
    await writeFile(
      join(root, 'CHANGELOG.md'),
      `${await readFile(join(root, 'CHANGELOG.md'), 'utf8')}\n- more\n`,
    );
    await expect(requireConsumerCanary(root)).rejects.toThrow(
      /none is recorded for this tree/,
    );

    await requireConsumerCanary(
      await releaseRepository(true, 'the one failing consumer needs the documented migration'),
    );
  } finally {
    if (saved === undefined) delete process.env.STITCHKIT_GATE_MEMO_DIR;
    else process.env.STITCHKIT_GATE_MEMO_DIR = saved;
  }
}, 60_000);

test('a waiver without a reason is refused by the release train schema', async () => {
  const { ReleaseTrainSchema } = await import('./release-train');
  const train = { schemaVersion: 1, releases: [{ target: 'core', version: '0.2.0' }] };
  expect(
    ReleaseTrainSchema.safeParse({ ...train, consumerCanaryWaiver: 'skip' }).success,
  ).toBe(false);
  expect(
    ReleaseTrainSchema.safeParse({
      ...train,
      consumerCanaryWaiver: 'the consumer needs migration X',
    }).success,
  ).toBe(true);
});

test('a test the consumer already fails on its own version does not stop the release, a new one does', async () => {
  const root = await directory('canary-preexisting-');
  const path = await consumer(root, await candidate(root, 'pinned', true), true);

  const kept = await tryCandidateOnConsumers(
    profile(path),
    await candidate(root, 'kept', true),
    await directory('canary-red-kept-'),
  );
  expect(kept).toMatchObject([
    {
      ok: true,
      failedTests: [],
      preexisting: ['a test that fails whatever the framework is'],
    },
  ]);

  const broken = await tryCandidateOnConsumers(
    profile(path),
    await candidate(root, 'broken', false),
    await directory('canary-red-broken-'),
  );
  expect(broken).toMatchObject([
    {
      ok: false,
      failedTests: ['the candidate keeps the contract this consumer relies on'],
      preexisting: ['a test that fails whatever the framework is'],
    },
  ]);
}, 240_000);

/** A committed release repository, as the canary meets it before the tag. */
async function committedRelease(): Promise<string> {
  const root = await releaseRepository(false);
  await exec(['git', 'add', '.'], root);
  await exec(
    [
      'git',
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      'commit',
      '--quiet',
      '-m',
      'release',
    ],
    root,
  );
  return root;
}

test('only the tarball of a green exact-SHA CI run for a clean HEAD is a candidate', async () => {
  const root = await committedRelease();
  const sha = (await Bun.$`git -C ${root} rev-parse HEAD`.text()).trim();
  const destination = await directory('canary-ci-');
  const green = { id: 7, head_sha: sha, event: 'push', conclusion: 'success' };
  const download = async (runId: number, into: string) => {
    expect(runId).toBe(7);
    await writeFile(join(into, 'stitchkit-0.2.0.tgz'), 'tarball');
  };

  const found = await ciCandidate(root, destination, { askCi: async () => [green], download });
  expect(found).toMatchObject({
    certifies: true,
    tarball: join(destination, 'stitchkit-0.2.0.tgz'),
  });

  await expect(
    ciCandidate(root, destination, {
      askCi: async () => [{ ...green, conclusion: 'failure' }],
      download,
    }),
  ).rejects.toThrow(/no successful push CI run/);
  await expect(
    ciCandidate(root, destination, { askCi: async () => [], download }),
  ).rejects.toThrow(/no push CI run exists/);
  await expect(
    ciCandidate(root, await directory('canary-empty-'), {
      askCi: async () => [green],
      download: async () => undefined,
    }),
  ).rejects.toThrow(/holds no stitchkit tarball/);

  await writeFile(join(root, 'CHANGELOG.md'), 'edited after the CI run\n');
  await expect(
    ciCandidate(root, destination, { askCi: async () => [green], download }),
  ).rejects.toThrow(/tree is not clean/);
});

test('the candidate is the CI tarball by default, and a local or explicit one never certifies', () => {
  expect(parseCandidateChoice([])).toEqual({ kind: 'ci' });
  expect(parseCandidateChoice(['--local'])).toEqual({ kind: 'local' });
  expect(parseCandidateChoice(['--tarball', '/x.tgz'])).toEqual({
    kind: 'tarball',
    path: '/x.tgz',
  });
  expect(() => parseCandidateChoice(['--tarball'])).toThrow('Usage');
  expect(() => parseCandidateChoice(['--ci'])).toThrow('Usage');
});
