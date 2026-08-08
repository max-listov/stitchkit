import { resolve } from 'node:path';
import { ensureLocalEnvironment } from './local-env';

const root = resolve(import.meta.dir, '..');
async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: root,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command.join(' ')} failed with exit code ${exitCode}`);
}

await ensureLocalEnvironment(root);

await run(['bun', 'run', 'db:setup']);
await run(['pm2', 'startOrReload', 'ecosystem.dev.config.cjs', '--update-env']);

console.log('Stitchkit Starter development processes are running');
console.log('Web: http://localhost:3210/en');
console.log('API: http://localhost:3211');
