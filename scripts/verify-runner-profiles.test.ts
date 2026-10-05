import { expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyCoreSourceFixture } from './core-source-fixture';
import { readGreenGates } from './gate-memo';
import { FAST_STEPS, PROFILES, releaseProfile, VERIFY_STEPS } from './verify-profiles';

type Scenario = 'stable' | 'drift' | 'failure';
async function fixture(scenario: Scenario) {
  const scratch = await mkdtemp(join(tmpdir(), 'verify-profile-cli-'));
  const root = join(scratch, 'repo');
  await mkdir(root);
  await cp(import.meta.dir, join(root, 'scripts'), { recursive: true });
  await copyCoreSourceFixture(root);
  await symlink(join(import.meta.dir, '../node_modules'), join(root, 'node_modules'));
  await writeFile(join(root, '.gitignore'), 'node_modules\n.runs\n');
  await writeFile(join(root, 'input.txt'), 'original');
  await writeFile(join(root, '.runs'), '');
  await writeFile(
    join(root, 'release-train.json'),
    JSON.stringify({ schemaVersion: 1, releases: [{ target: 'tui', version: '0.1.1' }] }),
  );
  await writeFile(
    join(root, 'fixture.ts'),
    `
    import { appendFileSync, writeFileSync } from 'node:fs';
    const step = Bun.argv[2]; appendFileSync('.runs', step+'\\n');
    if (step === 'check' && ${JSON.stringify(scenario)} === 'failure') throw new Error('controlled step failure');
    if (step === 'build' && ${JSON.stringify(scenario)} === 'drift') writeFileSync('input.txt', 'changed by build');
  `,
  );
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      scripts: Object.fromEntries(
        [...new Set([...VERIFY_STEPS, ...PROFILES.candidate.steps, 'starter-head-lane'])].map(
          (step) => [step, `bun fixture.ts ${step}`],
        ),
      ),
    }),
  );
  const init = Bun.spawn(['git', 'init', '--quiet'], { cwd: root });
  expect(await init.exited).toBe(0);
  const memo = join(scratch, 'memo');
  const env = { ...Bun.env, STITCHKIT_GATE_MEMO_DIR: memo };
  async function run(flags: string[]) {
    const child = Bun.spawn(
      [process.execPath, join(root, 'scripts/verify.ts'), ...flags, '--if-changed'],
      {
        cwd: root,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 15_000,
        killSignal: 'SIGKILL',
      },
    );
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, output: out + err };
  }
  return {
    scratch,
    root,
    run,
    history: (gate: string) => readGreenGates(gate, join(memo, 'green-gates.json')),
  };
}

const FAST = FAST_STEPS.join('\n');
const runs = async (root: string) =>
  (await readFile(join(root, '.runs'), 'utf8')).trim().split('\n');

test('the fast subset is remembered by tree and reused by every profile it covers', async () => {
  const f = await fixture('stable');
  try {
    expect((await f.run(['--fast'])).code).toBe(0);
    expect(await f.history(PROFILES.fast.gate)).toHaveLength(1);
    for (const flag of ['--fast', '--candidate']) {
      const rerun = await f.run([flag]);
      expect(rerun.output).toContain('skipping');
    }
    // Neither the skip nor the candidate profile ran a step or wrote a record.
    expect(await runs(f.root)).toEqual([...FAST_STEPS]);
    expect(await f.history(PROFILES.candidate.gate)).toHaveLength(0);
  } finally {
    await rm(f.scratch, { recursive: true, force: true });
  }
}, 30_000);

test('candidate runs structural checks and the metadata tests, and certifies nothing', async () => {
  const f = await fixture('stable');
  try {
    expect((await f.run(['--candidate'])).code).toBe(0);
    expect(await runs(f.root)).toEqual(['lockfile', 'lint', 'check', 'test:release-metadata']);
    expect(await f.history(PROFILES.candidate.gate)).toHaveLength(0);
    expect(await f.history(PROFILES.fast.gate)).toHaveLength(0);
    expect((await f.run(['--candidate'])).output).not.toContain('skipping');
  } finally {
    await rm(f.scratch, { recursive: true, force: true });
  }
}, 30_000);

test('release and full runs certify the fast subset and always run their heavy steps again', async () => {
  for (const [flag, heavy] of [
    ['--release', ['build', 'tui-packed-lane']],
    ['', VERIFY_STEPS.slice(VERIFY_STEPS.indexOf('test') + 1)],
  ] as const) {
    const f = await fixture('stable');
    try {
      const args = flag ? [flag] : [];
      const result = await f.run(args);
      expect(result.code, result.output).toBe(0);
      // The sequential prefix keeps its order; heavy lanes run side by side, so only their set is fixed.
      const first = await runs(f.root);
      expect(first.slice(0, FAST_STEPS.length)).toEqual([...FAST_STEPS]);
      expect(first.slice(FAST_STEPS.length).sort()).toEqual([...heavy].sort());
      expect(await f.history(PROFILES.fast.gate)).toHaveLength(1);
      expect(await f.history(flag ? 'verify:release:tui' : PROFILES.full.gate)).toHaveLength(
        0,
      );
      const second = await f.run(args);
      expect(second.output).toContain('--if-changed reuses only the fast subset');
      expect(second.output).not.toContain('skipping');
      expect(await runs(f.root)).toHaveLength(2 * (FAST_STEPS.length + heavy.length));
      // The fast attestation a heavy run wrote answers for the fast profile.
      expect((await f.run(['--fast'])).output).toContain('skipping');
    } finally {
      await rm(f.scratch, { recursive: true, force: true });
    }
  }
}, 60_000);

test('the head profile runs every time and certifies nothing', async () => {
  const f = await fixture('stable');
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await f.run(['--head']);
      expect(result.code, result.output).toBe(0);
      expect(result.output).not.toContain('skipping');
    }
    expect(await runs(f.root)).toEqual(['starter-head-lane', 'starter-head-lane']);
    expect(await f.history(PROFILES.fast.gate)).toHaveLength(0);
    expect(await f.history(PROFILES.head.gate)).toHaveLength(0);
  } finally {
    await rm(f.scratch, { recursive: true, force: true });
  }
}, 30_000);

test('build drift and a failed step save no memo', async () => {
  for (const scenario of ['drift', 'failure'] satisfies Scenario[]) {
    const f = await fixture(scenario);
    try {
      const result = await f.run([]);
      expect(result.code === 0).toBe(scenario !== 'failure');
      expect(await f.history(PROFILES.full.gate)).toHaveLength(0);
      expect(await f.history(PROFILES.fast.gate)).toHaveLength(0);
      expect(result.output).toContain(
        scenario === 'failure' ? 'controlled step failure' : 'inputs changed',
      );
    } finally {
      await rm(f.scratch, { recursive: true, force: true });
    }
  }
}, 60_000);

test('any edit to the tree runs the fast subset again', async () => {
  const f = await fixture('stable');
  try {
    expect((await f.run(['--fast'])).code).toBe(0);
    await writeFile(join(f.root, 'input.txt'), 'edited');
    const rerun = await f.run(['--fast']);
    expect(rerun.output).not.toContain('skipping');
    expect((await runs(f.root)).join('\n')).toBe(`${FAST}\n${FAST}`);
    expect(await f.history(PROFILES.fast.gate)).toHaveLength(2);
  } finally {
    await rm(f.scratch, { recursive: true, force: true });
  }
}, 30_000);

test('actual CLI never reuses Git-only memo for symlink targets changed between runs', async () => {
  const f = await fixture('stable');
  try {
    const target = join(f.root, 'ignored/payload');
    await mkdir(join(f.root, 'ignored'));
    await writeFile(join(f.root, '.gitignore'), 'node_modules\n.runs\nignored/\n');
    await writeFile(target, 'first');
    await symlink(target, join(f.root, 'input-link'));
    await writeFile(
      join(f.root, 'fixture.ts'),
      `import { appendFileSync, readFileSync } from 'node:fs';\nappendFileSync('.runs', Bun.argv[2] + ':' + readFileSync('input-link','utf8') + '\\n');`,
    );
    const first = await f.run(['--fast']);
    expect(first.code).toBe(0);
    expect(first.output).toContain('symlink targets are not attested');
    expect(await f.history(PROFILES.fast.gate)).toHaveLength(0);
    await writeFile(target, 'second');
    const second = await f.run(['--fast']);
    expect(second.code).toBe(0);
    expect(second.output).not.toContain('skipping');
    expect((await readFile(join(f.root, '.runs'), 'utf8')).trim().split('\n')).toEqual([
      ...FAST_STEPS.map((step) => `${step}:first`),
      ...FAST_STEPS.map((step) => `${step}:second`),
    ]);
    expect(await f.history(PROFILES.fast.gate)).toHaveLength(0);
  } finally {
    await rm(f.scratch, { recursive: true, force: true });
  }
}, 15_000);

test('the release profile takes its lanes from the CI evidence lanes of the train', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'release-profile-lanes-'));
  try {
    const profileFor = async (releases: Array<{ target: string; version: string }>) => {
      await writeFile(
        join(scratch, 'release-train.json'),
        JSON.stringify({ schemaVersion: 1, releases }),
      );
      return releaseProfile(scratch);
    };
    const core = await profileFor([
      { target: 'core', version: '1.0.0' },
      { target: 'tui', version: '0.1.0' },
    ]);
    expect(core.gate).toBe('verify:release:core+tui');
    expect(core.steps).toEqual([
      ...FAST_STEPS,
      'build',
      'test:postgres-stores',
      'smoke:next-ssr',
      'smoke:node',
      'consumer-lane',
      'tui-packed-lane',
      'agent-template-lane',
      'telegram-bot-template-lane',
      'generated-templates-lane',
      'starter-head-lane',
      'supervised-lane',
    ]);
    const starter = await profileFor([{ target: 'create-stitchkit', version: '0.9.0' }]);
    expect(starter.steps).toEqual([
      ...FAST_STEPS,
      'build',
      'agent-template-lane',
      'telegram-bot-template-lane',
      'generated-templates-lane',
      'starter-lane',
      'supervised-lane',
    ]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
