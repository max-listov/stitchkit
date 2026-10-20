import { afterEach, expect, test } from 'bun:test';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withExclusiveLock } from '../src/entrypoints/files';
import { reapAfterEachTest, trackProcess } from './support/process-reaper';

reapAfterEachTest();

/*
 * A process image replaced in place — `execve`, which is how `bun --watch` restarts — keeps its
 * PID and kernel start time, so the owner record of a lock the earlier image held still matches
 * this process exactly. The descriptor that image held the lock with did not survive, and a lock
 * no descriptor of this process holds is not held by this process.
 */

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'stitchkit-process-image-'));
  directories.push(dir);
  return dir;
}

const entrypoint = new URL('../src/entrypoints/files.ts', import.meta.url).href;

test('a lock an earlier image of this process left is taken at once', async () => {
  const dir = await directory();
  const owner = await withExclusiveLock(join(dir, 'probe.lock'), (held) => held.owner);
  if (!owner.process) throw new Error('Native process identity is required by this control');
  const path = join(dir, 'state.lock');
  // Exactly what the earlier image wrote: this PID, this boot, this start tick.
  await writeFile(path, `${JSON.stringify(owner)}\n`);
  const lock = await withExclusiveLock(path, (held) => held, { timeoutMs: 0 });
  expect(lock.reclaimed).toBe(true);
  expect(lock.owner.pid).toBe(process.pid);
});

test('a lock another caller in this process holds is waited for, never taken', async () => {
  const path = join(await directory(), 'state.lock');
  await withExclusiveLock(path, async (held) => {
    const before = await readFile(path, 'utf8');
    await expect(withExclusiveLock(path, () => 'second', { timeoutMs: 50 })).rejects.toThrow(
      'liveness alive, identity matched',
    );
    expect(await readFile(path, 'utf8')).toBe(before);
    await held.assertHeld();
  });
});

test('a lock a worker thread of this process holds is never taken from it', async () => {
  const dir = await directory();
  const path = join(dir, 'state.lock');
  const script = join(dir, 'holder.ts');
  await writeFile(
    script,
    `import { withExclusiveLock } from ${JSON.stringify(entrypoint)};
    await withExclusiveLock(${JSON.stringify(path)}, async () => {
      postMessage('held');
      await new Promise((resolve) => { onmessage = resolve; });
    });
    postMessage('released');`,
  );
  const worker = new Worker(script);
  const next = () =>
    new Promise<unknown>((resolve, reject) => {
      worker.onmessage = (event) => resolve(event.data);
      worker.onerror = reject;
    });
  try {
    expect(await next()).toBe('held');
    await expect(withExclusiveLock(path, () => 'main', { timeoutMs: 50 })).rejects.toThrow(
      'liveness alive, identity matched',
    );
    const released = next();
    worker.postMessage('release');
    expect(await released).toBe('released');
    expect(await withExclusiveLock(path, (held) => held.reclaimed, { timeoutMs: 0 })).toBe(
      false,
    );
  } finally {
    worker.terminate();
  }
});

test('bun --watch: the restarted image takes the lock its predecessor held, under the same PID', async () => {
  const dir = await directory();
  const path = join(dir, 'state.lock');
  const script = join(dir, 'app.ts');
  // The first image holds the lock for good; every later one must get it without waiting, and
  // a refusal is reported as a line too, so the test fails on its text rather than on a timeout.
  await writeFile(
    script,
    `import { withExclusiveLock } from ${JSON.stringify(entrypoint)};
    await withExclusiveLock(${JSON.stringify(path)}, async (held) => {
      console.log(JSON.stringify({ pid: process.pid, reclaimed: held.reclaimed }));
      await new Promise(() => {});
    }, { timeoutMs: 0 }).catch((error) => {
      console.log(JSON.stringify({ pid: process.pid, refused: String(error) }));
    });`,
  );
  const child = Bun.spawn([process.execPath, '--watch', '--no-clear-screen', script], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  trackProcess(child.pid);
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = '';
  const nextImage = async (): Promise<unknown> => {
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.startsWith('{')) return JSON.parse(line);
        continue;
      }
      const { value, done } = await reader.read();
      if (done)
        throw new Error(`watched app exited: ${await new Response(child.stderr).text()}`);
      buffered += value;
    }
  };
  try {
    const first = await nextImage();
    expect(first).toEqual({ pid: child.pid, reclaimed: false });
    await appendFile(script, '\n// restart\n');
    const second = await nextImage();
    expect(second).toEqual({ pid: child.pid, reclaimed: true });
  } finally {
    child.kill('SIGKILL');
    await child.exited;
  }
}, 15_000);
