/**
 * Guard: an example's declaration cannot fall behind the template's.
 *
 * An example overlays the template, so its declaration is the template's with a
 * wider environment. Kept by hand it drifts the moment a role changes — and the
 * only thing that noticed was the packed lane, minutes into a run.
 */
import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import {
  declarationPath,
  EXAMPLES,
  renderExampleDeclaration,
} from './sync-example-declarations';

for (const example of EXAMPLES) {
  test(`the ${example} example declaration matches the template`, async () => {
    expect(await readFile(declarationPath(example), 'utf8')).toBe(
      await renderExampleDeclaration(example),
    );
  });

  test(`the ${example} example declares the variables its own features add`, async () => {
    const rendered = await renderExampleDeclaration(example);
    // Proves the render really merges the overlay rather than copying the
    // template's environment verbatim.
    expect(rendered).toContain('GITHUB_REPOSITORY');
  });
}

test('actual declaration CLI preserves no-op generation, repairs stale/missing files and exposes IO refusals', async () => {
  const { cp, mkdir, mkdtemp, rm, writeFile, stat } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { worktreeInputGeneration } = await import('./gate-input-generation');
  const scratch = await mkdtemp(join(tmpdir(), 'declaration-writer-cli-'));
  try {
    await mkdir(join(scratch, 'scripts'));
    await cp(
      join(import.meta.dir, 'sync-example-declarations.ts'),
      join(scratch, 'scripts/sync-example-declarations.ts'),
    );
    const scaffolder = join(scratch, 'packages/create-stitchkit');
    for (const path of [
      'template/scripts',
      'template/packages/config/src',
      'examples/repository/packages/config/src',
    ])
      await mkdir(join(scaffolder, path), { recursive: true });
    await writeFile(
      join(scaffolder, 'template/project.json'),
      JSON.stringify({ schemaVersion: 1, name: 'fixture' }),
    );
    await writeFile(
      join(scaffolder, 'template/scripts/declaration.ts'),
      'export function renderEnvVariables(input) { return input; }\n',
    );
    await writeFile(
      join(scaffolder, 'template/packages/config/src/variables.ts'),
      "export const applicationVariables = { APP: 'required' };\n",
    );
    await writeFile(
      join(scaffolder, 'examples/repository/packages/config/src/features.ts'),
      "export const featureServerSchema = { FEATURE: 'optional' };\n",
    );
    const init = Bun.spawn(['git', 'init', '--quiet'], { cwd: scratch });
    expect(await init.exited).toBe(0);
    const file = join(scaffolder, 'examples/repository/project.json');
    async function run() {
      const child = Bun.spawn(
        [process.execPath, join(scratch, 'scripts/sync-example-declarations.ts')],
        { cwd: scratch, stdout: 'pipe', stderr: 'pipe', timeout: 5000, killSignal: 'SIGKILL' },
      );
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { code, output: out + err };
    }
    expect((await run()).code).toBe(0); // Missing declaration gets written.
    const expected = await readFile(file, 'utf8');
    expect(JSON.parse(expected).env.variables).toEqual({
      APP: 'required',
      FEATURE: 'optional',
    });
    const initial = await worktreeInputGeneration(scratch);
    const before = await stat(file, { bigint: true });
    expect(await run()).toEqual({ code: 0, output: '' });
    expect(await worktreeInputGeneration(scratch)).toBe(initial);
    expect((await stat(file, { bigint: true })).mtimeNs).toBe(before.mtimeNs);
    await writeFile(file, '{}\n');
    expect((await run()).code).toBe(0);
    expect(await readFile(file, 'utf8')).toBe(expected);
    await rm(file);
    await mkdir(file); // Deterministic IO refusal, also under root.
    const refused = await run();
    expect(refused.code).not.toBe(0);
    expect(refused.output).toMatch(/EISDIR|directory/);
    await rm(file, { recursive: true });
    await writeFile(
      join(scaffolder, 'examples/repository/packages/config/src/features.ts'),
      `import { rmSync } from 'node:fs';
export const featureServerSchema = {};
rmSync(${JSON.stringify(join(scaffolder, 'examples/repository'))}, { recursive: true });
`,
    );
    const writeRefused = await run();
    expect(writeRefused.code).not.toBe(0);
    expect(writeRefused.output).toMatch(/ENOENT/);
    expect(writeRefused.output).toContain('Declaration write refused');
    // Missing source is a read failure, not a declaration to synthesize.
    const readRefused = await run();
    expect(readRefused.code).not.toBe(0);
    expect(readRefused.output).toMatch(/Cannot find module|ENOENT/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}, 15_000);
