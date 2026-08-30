import { existsSync } from 'node:fs';
import { copyFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'dotenv';

const repositoryRoot = resolve(import.meta.dir, '..');
const templateRoot = resolve(repositoryRoot, 'packages/create-stitchkit/template');
const agentTemplateRoot = resolve(repositoryRoot, 'packages/create-stitchkit/templates/agent');

// The DEV WORKSPACE keeps the example under its pre-scaffold name
// (`_env.example` — the scaffolder renames it to `.env.example` in generated
// projects), so the template's own `local-env.ts` cannot self-heal here. A
// fresh checkout gets `.env` copied verbatim: the workspace identity IS the
// neutral one, so there is nothing to substitute. An existing `.env` (a
// developer's local credentials) is never touched.
const environmentPath = resolve(templateRoot, '.env');
if (!existsSync(environmentPath)) {
  await copyFile(resolve(templateRoot, '_env.example'), environmentPath);
}
const environment = parse(await readFile(environmentPath, 'utf8'));

async function run(command: string[], cwd: string, env = Bun.env): Promise<void> {
  const child = Bun.spawn(command, {
    cwd,
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

await run(['bun', 'install', '--frozen-lockfile'], templateRoot);
await run(['bun', 'run', 'db:generate'], templateRoot, { ...Bun.env, ...environment });
await run(['bun', 'install', '--frozen-lockfile'], agentTemplateRoot);
