import { expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyCoreSourceFixture } from './core-source-fixture';
import { browserRuntimeFixture } from './gate-environment-fixtures';
import { readGreenGates } from './gate-memo';
import { FAST_STEPS, PROFILES, VERIFY_STEPS } from './verify-profiles';

type Scenario = 'stable' | 'drift' | 'unknown' | 'failure' | 'environment-change';
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
  const bin = join(scratch, 'bin');
  await mkdir(bin);
  const version = join(scratch, 'pg-version');
  await writeFile(version, '18.1');
  await writeFile(
    join(bin, 'sudo'),
    `#!/usr/bin/env bun\nimport { readFileSync } from 'node:fs';\nconsole.log(JSON.stringify({version:readFileSync(${JSON.stringify(version)},'utf8'), database:'postgres', user:'postgres', address:'local-socket', port:0}));\n`,
    { mode: 0o755 },
  );
  const browserRoot = join(scratch, 'browsers');
  await mkdir(browserRoot);
  for (const name of ['chromium', 'webkit'])
    await writeFile(join(browserRoot, name), 'synthetic executable');
  const { packageRoot } = await browserRuntimeFixture(join(scratch, 'browser-package'));
  await mkdir(join(root, 'packages/create-stitchkit'), { recursive: true });
  await cp(packageRoot, join(root, 'packages/create-stitchkit/template'), { recursive: true });
  await writeFile(
    join(root, 'fixture.ts'),
    `
    import { appendFileSync, writeFileSync } from 'node:fs';
    const step = Bun.argv[2]; appendFileSync('.runs', step+'\\n');
    if (step === 'check' && ${JSON.stringify(scenario)} === 'failure') throw new Error('controlled step failure');
    if (step === 'build' && ${JSON.stringify(scenario)} === 'drift') writeFileSync('input.txt', 'changed by build');
    if (step === 'build' && ${JSON.stringify(scenario)} === 'environment-change') writeFileSync(${JSON.stringify(version)}, '19.1');
  `,
  );
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      scripts: Object.fromEntries(
        [...VERIFY_STEPS, 'starter-head-lane'].map((step) => [step, `bun fixture.ts ${step}`]),
      ),
    }),
  );
  const init = Bun.spawn(['git', 'init', '--quiet'], { cwd: root });
  expect(await init.exited).toBe(0);
  const memo = join(scratch, 'memo');
  const env = {
    ...Bun.env,
    STARTER_TEST_DATABASE_ADMIN_URL: undefined,
    STITCHKIT_GATE_MEMO_DIR: memo,
    PATH: `${bin}:${Bun.env.PATH}`,
    PLAYWRIGHT_BROWSERS_PATH: scenario === 'unknown' ? join(scratch, 'missing') : browserRoot,
  };
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

test('actual candidate and release CLI execute their selected steps and reuse only their own evidence', async () => {
  for (const flag of ['--candidate', '--release']) {
    const f = await fixture('stable');
    try {
      const result = await f.run([flag]);
      expect(result.code, result.output).toBe(0);
      const expected =
        flag === '--candidate'
          ? ['lockfile', 'lint', 'check']
          : [...FAST_STEPS, 'build', 'tui-packed-lane'];
      expect((await readFile(join(f.root, '.runs'), 'utf8')).trim().split('\n')).toEqual(
        expected,
      );
      expect(
        await f.history(
          flag === '--candidate' ? PROFILES.candidate.gate : 'verify:release:tui',
        ),
      ).toHaveLength(1);
      expect(await f.history(PROFILES.fast.gate)).toHaveLength(flag === '--candidate' ? 0 : 1);
      expect((await f.run([flag])).output).toContain('skipping');
    } finally {
      await rm(f.scratch, { recursive: true, force: true });
    }
  }
}, 30_000);

test('actual full/head CLI distinguish stable heavy inputs from unknown required inputs', async () => {
  for (const flag of ['', '--head'])
    for (const scenario of ['stable', 'unknown'] satisfies Scenario[]) {
      const f = await fixture(scenario);
      try {
        const result = await f.run(flag ? [flag] : []);
        expect(result.code, result.output).toBe(0);
        const gate = flag ? PROFILES.head.gate : PROFILES.full.gate;
        expect(await f.history(gate)).toHaveLength(scenario === 'stable' ? 1 : 0);
        expect(await f.history(PROFILES.fast.gate)).toHaveLength(flag ? 0 : 1);
        const rerun = await f.run(flag ? [flag] : []);
        expect(rerun.code).toBe(0);
        expect(rerun.output.includes('skipping')).toBe(scenario === 'stable');
      } finally {
        await rm(f.scratch, { recursive: true, force: true });
      }
    }
}, 60_000);

test('actual full CLI refuses build drift, failed steps and external identities changed during the run', async () => {
  for (const scenario of ['drift', 'failure', 'environment-change'] satisfies Scenario[]) {
    const f = await fixture(scenario);
    try {
      const result = await f.run([]);
      expect(result.code === 0).toBe(scenario !== 'failure');
      expect(await f.history(PROFILES.full.gate)).toHaveLength(0);
      expect(await f.history(PROFILES.fast.gate)).toHaveLength(
        scenario === 'environment-change' ? 1 : 0,
      );
      expect(result.output).toContain(
        scenario === 'failure'
          ? 'controlled step failure'
          : scenario === 'drift'
            ? 'inputs changed'
            : 'external inputs changed',
      );
    } finally {
      await rm(f.scratch, { recursive: true, force: true });
    }
  }
}, 60_000);

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
