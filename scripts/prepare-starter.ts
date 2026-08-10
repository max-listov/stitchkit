import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { ensureLocalEnvironment } from '../packages/create-stitchkit/template/scripts/local-env';

const repositoryRoot = resolve(import.meta.dir, '..');
const templateRoot = resolve(repositoryRoot, 'packages/create-stitchkit/template');

// Self-heal first — the template ships no `.env`; a fresh checkout gets one
// rendered from `.env.example`, and a developer's existing file is kept.
ensureLocalEnvironment(templateRoot);
const environment = parse(await readFile(resolve(templateRoot, '.env'), 'utf8'));

async function run(command: string[], env = Bun.env): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: templateRoot,
    env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${command.join(' ')} failed with exit code ${exitCode}`);
  }
}

await run(['bun', 'install', '--frozen-lockfile']);
await run(['bun', 'run', 'db:generate'], { ...Bun.env, ...environment });
