import { existsSync } from 'node:fs';
import { copyFile, readdir, readFile, rm, symlink } from 'node:fs/promises';
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
// The checked-in template is the development workspace (ADR 0066), while a
// generated project must keep the published catalog target. Link only this
// workspace's installed package to the core tree after the frozen install; the
// symlink lives in ignored node_modules and is never copied by the scaffolder.
const localCore = resolve(repositoryRoot, 'packages/core');
const templateCoreLinks = [resolve(templateRoot, 'node_modules/stitchkit')];
for (const workspace of await readdir(resolve(templateRoot, 'packages'), {
  withFileTypes: true,
})) {
  if (workspace.isDirectory()) {
    templateCoreLinks.push(
      resolve(templateRoot, 'packages', workspace.name, 'node_modules/stitchkit'),
    );
  }
}
for (const templateCore of templateCoreLinks) {
  if (!existsSync(templateCore)) continue;
  await rm(templateCore, { force: true, recursive: true });
  await symlink(localCore, templateCore, 'dir');
}
await run(['bun', 'run', 'db:generate'], templateRoot, { ...Bun.env, ...environment });
await run(['bun', 'install', '--frozen-lockfile'], agentTemplateRoot);
