import { join } from 'node:path';

export async function run(command: string[]): Promise<void> {
  const process = Bun.spawn(command, {
    cwd: join(import.meta.dir, '..'),
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(`${command.join(' ')} exited with ${exitCode}`);
}

export async function output(command: string[]): Promise<string> {
  const process = Bun.spawn(command, {
    cwd: join(import.meta.dir, '..'),
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const value = await new Response(process.stdout).text();
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(`${command.join(' ')} exited with ${exitCode}`);
  return value.trim();
}
