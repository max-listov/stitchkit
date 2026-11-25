import { expect, setSystemTime, test } from 'bun:test';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { PolledJsonFile } from '../src/entrypoints/files';
import { reapAfterEachTest, trackProcess } from './support/process-reaper';

reapAfterEachTest();

const fixture = fileURLToPath(
  new URL('./fixtures/polled-json-coarse-clock.ts', import.meta.url),
);

/** Runs the coarse-clock fixture in its own process: it replaces `node:fs` for the run. */
async function coarseClockRun(): Promise<Record<string, unknown>> {
  const root = await mkdtemp(join(tmpdir(), 'polled-json-racy-'));
  try {
    const child = Bun.spawn([process.execPath, fixture, root], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    trackProcess(child.pid);
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exit !== 0) throw new Error(`fixture exited ${exit}: ${stderr}`);
    return JSON.parse(stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('a same-length rewrite whose size, mtime and ctime stay the same is seen by every polled reader', async () => {
  const run = await coarseClockRun();
  // readChanged, then read: each rewrite inside the tick of the read before it.
  expect(run.sync).toEqual([1, 2, 3]);
  expect(run.async).toEqual([[1], [2]]);
  // createPolledJsonConfigSource is what startConfigReloader polls.
  expect(run.config).toEqual([1, 2]);
  expect(run.reads).toEqual({
    // A file last changed long before its read: five more polls read no byte.
    oldReads: 1,
    // A young file is read again on each poll and, unchanged, still answers null.
    youngPolls: [null, null],
    youngReads: 3,
    // Once a read finds its stamp old, metadata answers again.
    settlingReads: 4,
    settledReads: 4,
  });
}, 30_000);

test('a file whose mtime is ahead of the clock settles by its ctime: polls read no byte once it is old', async () => {
  const root = await mkdtemp(join(tmpdir(), 'polled-json-future-'));
  try {
    const path = join(root, 'future.json');
    await writeFile(path, JSON.stringify({ v: 1 }));
    // `touch -d` an hour ahead: ctime is the kernel's present, mtime is not.
    const ahead = new Date(Date.now() + 3_600_000);
    await utimes(path, ahead, ahead);
    let reads = 0;
    const file = new PolledJsonFile(path, z.object({ v: z.number() }), {
      accept: () => {
        reads += 1;
        return true;
      },
    });
    setSystemTime(new Date(Date.now() + 10_000));
    expect(file.readChanged()).toMatchObject({ state: 'read', value: { v: 1 } });
    for (let poll = 0; poll < 5; poll += 1) expect(file.readChanged()).toBeNull();
    expect(reads).toBe(1);
  } finally {
    setSystemTime();
    await rm(root, { recursive: true, force: true });
  }
});
