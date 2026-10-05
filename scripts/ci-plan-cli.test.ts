import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CiPlanSchema, changedCiPaths, planCi } from './ci-plan';
import { writeStarterHeadFixture } from './starter-head-fixture';

async function git(root: string, args: string[], input?: string): Promise<string> {
  const child = Bun.spawn(['git', ...args], {
    cwd: root,
    stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(err);
  return out;
}

async function runPlanner(root: string, bin: string, base: string, head = '3'.repeat(40)) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'ci-plan.ts')], {
    cwd: root,
    env: {
      ...Bun.env,
      PATH: `${bin}:${Bun.env.PATH}`,
      CI_EVENT: 'push',
      CI_HEAD_SHA: head,
      CI_BASE_SHA: base,
    },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 5000,
    killSignal: 'SIGKILL',
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { out, err, code };
}

test('actual planner CLI asks the entire push range; a new branch conservatively covers its tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ci-plan-command-boundary-'));
  try {
    await writeStarterHeadFixture(root);
    const bin = join(root, 'bin');
    await mkdir(bin);
    const calls = join(root, 'calls.jsonl');
    await writeFile(
      join(bin, 'git'),
      `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
const args = Bun.argv.slice(2); appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args)+'\\n');
if (args[0] === 'log') console.log('fix: two packages');
else if (args[0] === 'diff' && args[4] === '${'1'.repeat(40)}') process.stdout.write(['packages/core/src/process/launch.ts', 'docs/guide/upgrading.md', ''].join(String.fromCharCode(0)));
else if (args[0] === 'ls-tree') process.stdout.write(['packages/core/src/process/launch.ts', 'packages/tui/src/index.ts', 'packages/create-stitchkit/template/project.json', ''].join(String.fromCharCode(0)));
else throw new Error('Unexpected diff boundary');
`,
      { mode: 0o755 },
    );
    await writeFile(join(bin, 'gh'), '#!/bin/sh\necho "[]"\n', { mode: 0o755 });
    for (const base of ['1'.repeat(40), '0'.repeat(40)]) {
      const { out, err, code } = await runPlanner(root, bin, base);
      expect(code, err).toBe(0);
      expect(err).toContain('no push CI run exists');
      const plan = CiPlanSchema.parse(JSON.parse(out));
      expect(plan.portable).toBe(true);
      expect(plan.tui).toBe(base.startsWith('0'));
      expect(plan.artifacts).toBe(false);
      expect(plan.starterModes).toEqual(base.startsWith('1') ? ['head'] : ['target', 'head']);
    }
    const actual = (await readFile(calls, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(actual).toEqual([
      ['log', '-1', '--format=%s', '3'.repeat(40)],
      ['diff', '--no-renames', '--name-only', '-z', '1'.repeat(40), '3'.repeat(40)],
      ['log', '-1', '--format=%s', '3'.repeat(40)],
      ['ls-tree', '-r', '--name-only', '-z', '3'.repeat(40)],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('actual planner CLI selects no evidence for a SHA whose push run already succeeded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ci-plan-answered-'));
  try {
    await writeStarterHeadFixture(root);
    const bin = join(root, 'bin');
    await mkdir(bin);
    const head = '3'.repeat(40);
    await writeFile(join(bin, 'git'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    await writeFile(
      join(bin, 'gh'),
      `#!/bin/sh\necho '[{"id":7,"head_sha":"${head}","event":"push","conclusion":"success"}]'\n`,
      { mode: 0o755 },
    );
    const { out, err, code } = await runPlanner(root, bin, '1'.repeat(40), head);
    expect(code, err).toBe(0);
    expect(err).toContain('selecting no evidence');
    expect(CiPlanSchema.parse(JSON.parse(out))).toMatchObject({
      targets: [],
      artifacts: false,
      starterModes: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('real rename across package boundaries covers both the removed and added path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ci-plan-real-rename-'));
  try {
    await git(root, ['init', '--quiet']);
    const blob = (await git(root, ['hash-object', '-w', '--stdin'], 'same bytes')).trim();
    const core = (await git(root, ['mktree'], `100644 blob ${blob}\towned.ts\n`)).trim();
    const packages = (await git(root, ['mktree'], `040000 tree ${core}\tcore\n`)).trim();
    const before = (await git(root, ['mktree'], `040000 tree ${packages}\tpackages\n`)).trim();
    const after = (await git(root, ['mktree'], `100644 blob ${blob}\tREADME.md\n`)).trim();
    // The baseline Git projection drops the removed package path for a detected rename.
    expect((await git(root, ['diff', '--name-only', before, after])).trim()).toBe('README.md');
    const paths = await changedCiPaths(after, before, (args) => git(root, args));
    expect(paths.sort()).toEqual(['README.md', 'packages/core/owned.ts']);
    const plan = planCi({ event: 'push', subject: 'ordinary fix', changedPaths: paths });
    expect(plan.portable).toBe(true);
    expect(plan.darwin).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const { label, leaf } of [
  { label: 'ASCII', leaf: 'owner.ts' },
  { label: 'Unicode', leaf: 'é-owner.ts' },
  { label: 'newline', leaf: 'line\nbreak.ts' },
  { label: 'tab and quote', leaf: 'tab\t"owner.ts' },
  { label: 'edge whitespace', leaf: ' leading-and-trailing.ts ' },
]) {
  test(`real Git path projection preserves ${label} in diff and new-branch coverage`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'ci-plan-real-path-'));
    try {
      await git(root, ['init', '--quiet']);
      await git(root, ['config', 'core.quotePath', 'true']);
      const blob = (await git(root, ['hash-object', '-w', '--stdin'], 'bytes')).trim();
      const empty = (await git(root, ['mktree'], '')).trim();
      const core = (
        await git(root, ['mktree', '-z'], `100644 blob ${blob}\t${leaf}\0`)
      ).trim();
      const packages = (await git(root, ['mktree'], `040000 tree ${core}\tcore\n`)).trim();
      const head = (await git(root, ['mktree'], `040000 tree ${packages}\tpackages\n`)).trim();
      const path = `packages/core/${leaf}`;
      if (label !== 'ASCII' && label !== 'edge whitespace') {
        expect(await git(root, ['diff', '--name-only', empty, head])).not.toBe(`${path}\n`);
      }
      for (const base of [empty, '0'.repeat(40)]) {
        const paths = await changedCiPaths(head, base, (args) => git(root, args));
        expect(paths).toEqual([path]);
        const plan = planCi({
          event: 'push',
          subject: 'ordinary fix',
          changedPaths: paths,
        });
        expect(plan.targets).toEqual(['core']);
        expect(plan.portable).toBe(true);
        expect(plan.darwin).toBe(true);
        expect(plan.starterModes).toEqual(['head']);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
