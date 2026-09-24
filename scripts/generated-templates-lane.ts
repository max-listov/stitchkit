/**
 * The single-package templates as a user receives them.
 *
 * Each template's own lane installs the template directory, where Stitchkit is
 * a `file:` dependency on this checkout. What a user runs is different: the
 * scaffolder rewrites that dependency, writes a fresh project and installs it
 * from the registry. Both templates shipped a manifest that `bun install`
 * refused — `catalog:` outside a workspace — and no lane saw it, because none
 * installed a generated project. This one does, then checks and tests it.
 *
 * It resolves the published Stitchkit the starter catalog names, so it runs in
 * the scaffolder's release profile, after that version is on the registry.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const cli = join(root, 'packages/create-stitchkit/src/cli.ts');
const TEMPLATES = ['agent', 'telegram-bot'] as const;

async function run(command: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(command, { cwd, stdout: 'inherit', stderr: 'inherit' });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${command.join(' ')} failed with exit code ${code}`);
}

const parent = await mkdtemp(join(tmpdir(), 'stitchkit-generated-'));
try {
  for (const template of TEMPLATES) {
    const destination = join(parent, `generated-${template}`);
    const started = performance.now();
    await run(['bun', cli, destination, '--template', template], parent);
    await run(['bun', 'run', 'check'], destination);
    await run(['bun', 'test'], destination);
    console.log(
      `[generated-templates-lane] ${template}: generated, installed, checked, tested in ${Math.round(performance.now() - started)} ms`,
    );
  }
} finally {
  await rm(parent, { recursive: true, force: true });
}
