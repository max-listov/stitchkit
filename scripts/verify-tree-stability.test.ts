import { expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGreenGates } from './gate-memo';

test('the actual runner never certifies a mixed tree, including mutation then restoration', async () => {
  for (const mode of [
    'stable',
    'ignored-churn',
    'drift',
    'restore',
    'generated',
    'transient',
  ]) {
    const scratch = await mkdtemp(join(tmpdir(), 'verify-stability-'));
    try {
      const root = join(scratch, 'repo');
      await mkdir(root);
      await cp(import.meta.dir, join(root, 'scripts'), { recursive: true });
      await mkdir(join(root, 'packages/core'), { recursive: true });
      await symlink(
        join(import.meta.dir, '../packages/core/src'),
        join(root, 'packages/core/src'),
      );
      await symlink(join(import.meta.dir, '../node_modules'), join(root, 'node_modules'));
      await writeFile(join(root, '.gitignore'), 'node_modules/\n.runs\ndist/\n');
      await writeFile(join(root, '.runs'), '');
      await writeFile(join(root, 'input.txt'), 'original');
      await writeFile(
        join(root, 'fixture.ts'),
        `
        import { appendFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
        const step = Bun.argv[2];
        appendFileSync('.runs', step + '\\n');
        if (step === 'lint' && ${JSON.stringify(mode)} === 'ignored-churn') {
          mkdirSync('dist', { recursive: true }); rmSync('dist', { recursive: true }); mkdirSync('dist');
        }
        if (step === 'lint' && ${JSON.stringify(mode)} === 'transient') {
          writeFileSync('transient.txt', 'a gate saw this'); rmSync('transient.txt');
        }
        if (step === 'lint' && ['drift', 'restore', 'generated'].includes(${JSON.stringify(mode)})) {
          writeFileSync('input.txt', 'mutated');
          if (${JSON.stringify(mode)} === 'generated') writeFileSync('generated.txt', 'new artifact');
        }
        if (step === 'check' && ${JSON.stringify(mode)} === 'restore') writeFileSync('input.txt', 'original');
      `,
      );
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({
          scripts: Object.fromEntries(
            ['lockfile', 'lint', 'check', 'test'].map((step) => [
              step,
              `bun fixture.ts ${step}`,
            ]),
          ),
        }),
      );
      const init = Bun.spawn(['git', 'init', '--quiet'], { cwd: root });
      expect(await init.exited).toBe(0);
      const stageFixture = Bun.spawn(['git', 'add', '--all', '.'], { cwd: root });
      expect(await stageFixture.exited).toBe(0);
      const memo = join(scratch, 'cache');
      async function run() {
        const child = Bun.spawn(
          [process.execPath, join(root, 'scripts/verify.ts'), '--fast', '--if-changed'],
          {
            cwd: root,
            env: { ...Bun.env, STITCHKIT_GATE_MEMO_DIR: memo },
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        const output = await new Response(child.stderr).text();
        expect(await child.exited).toBe(0);
        return output;
      }
      await run();
      expect(await readFile(join(root, '.runs'), 'utf8')).toBe(
        'lockfile\nlint\ncheck\ntest\n',
      );
      const history = await readGreenGates('verify:fast', join(memo, 'green-gates.json'));
      expect(history.length).toBe(['stable', 'ignored-churn'].includes(mode) ? 1 : 0);
      if (['stable', 'ignored-churn'].includes(mode)) {
        expect(await run()).toContain('skipping');
        expect(await readFile(join(root, '.runs'), 'utf8')).toBe(
          'lockfile\nlint\ncheck\ntest\n',
        );
      } else if (mode === 'restore') {
        expect(await run()).not.toContain('skipping');
        expect(
          (await readFile(join(root, '.runs'), 'utf8')).split('\n').filter(Boolean),
        ).toHaveLength(8);
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}, 30_000);
