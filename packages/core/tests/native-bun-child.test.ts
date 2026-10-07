import { expect, test } from 'bun:test';
import { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { spawnOwnedCommand } from '../src/process/owned-child';
import { reapAfterEachTest, trackProcess } from './support/process-reaper';

reapAfterEachTest();

const spawnShell = (script: string) => {
  const child = spawnOwnedCommand({
    executable: 'sh',
    args: ['-c', script],
    env: { PATH: '/usr/bin:/bin' },
    group: true,
  });
  trackProcess(child.pid);
  return child;
};

test('under Bun a command is launched through Bun.spawn, not node:child_process', () => {
  const child = spawnShell('exit 0');
  expect(child).not.toBeInstanceOf(ChildProcess);
  expect(child.pid).toBeGreaterThan(0);
});

test('the Bun child reports exit and signal like a Node child, close after its pipes', async () => {
  const exited = spawnShell('echo out; echo err >&2; exit 3');
  const events: string[] = [];
  exited.on('exit', (code, signal) => events.push(`exit:${code}:${signal}`));
  exited.on('close', () => events.push('close'));
  exited.stdin.end();
  const chunks: Buffer[] = [];
  for await (const chunk of exited.stdout) chunks.push(Buffer.from(chunk));
  await once(exited, 'close');
  expect(Buffer.concat(chunks).toString()).toBe('out\n');
  expect(events).toEqual(['exit:3:null', 'close']);

  const killed = spawnShell('sleep 30');
  const [code, signal] = await new Promise<[number | null, string | null]>((resolve) => {
    killed.on('exit', (exitCode, termination) => resolve([exitCode, termination]));
    killed.kill('SIGKILL');
  });
  expect([code, signal]).toEqual([null, 'SIGKILL']);
  expect(killed.kill('SIGKILL')).toBe(false);
});

test('a pipe nobody reads is drained so the child still closes', async () => {
  const child = spawnShell('head -c 300000 /dev/zero');
  child.stdin.end();
  await once(child, 'close');
  expect(child.exitCode).toBe(0);
});

test('a missing executable is an error event, then close', async () => {
  const child = spawnOwnedCommand({
    executable: '/nonexistent/stitchkit',
    args: [],
    group: true,
  });
  const events: string[] = [];
  child.on('error', (error) => events.push(`error:${'code' in error ? error.code : ''}`));
  await new Promise<void>((resolve) =>
    child.on('close', () => {
      events.push('close');
      resolve();
    }),
  );
  expect(events).toEqual(['error:ENOENT', 'close']);
});

test('destroying stdin closes the pipe, so a reader of it sees the end', async () => {
  const child = spawnShell('cat');
  child.stdout.resume();
  child.stdin.write('x');
  child.stdin.destroy();
  await new Promise<void>((resolve) => child.on('close', () => resolve()));
  expect(child.exitCode).toBe(0);
});

test('a spawn failure Node throws synchronously is thrown, not reported', () => {
  expect(() =>
    spawnOwnedCommand({ executable: '/etc/passwd/x', args: [], group: true }),
  ).toThrow(expect.objectContaining({ code: 'ENOTDIR' }));
});
