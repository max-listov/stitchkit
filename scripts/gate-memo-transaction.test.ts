import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withExclusiveLock } from '../packages/core/src/internal/with-exclusive-lock';
import { readGreenGates, writeGreenGate } from './gate-memo';

const record = { tree: 'one', toolchain: 'bun:test', at: 'now', commit: '(no commit)' };

/** A fixture program run by Bun; its stdout reports readiness and its stdin gates the start. */
function startFixture(name: string, ...args: string[]) {
  return Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures', name), ...args], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

async function ready(child: ReturnType<typeof startFixture>): Promise<void> {
  const reader = child.stdout.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  expect(new TextDecoder().decode(value)).toContain('ready');
}

test('separate processes serialize independent writes and bound shared history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate-memo-processes-'));
  const children: ReturnType<typeof startFixture>[] = [];
  try {
    const path = join(root, 'memo.json');
    for (let index = 0; index < 10; index += 1)
      children.push(startFixture('gate-memo-worker.ts', root, String(index)));
    await Promise.all(children.map(ready));
    for (const child of children) child.stdin.end();
    expect(await Promise.all(children.map((child) => child.exited))).toEqual(
      Array(10).fill(0),
    );
    for (let index = 0; index < 10; index += 1)
      expect(await readGreenGates(`gate-${index}`, path)).toHaveLength(1);
    const shared = await readGreenGates('shared', path);
    expect(shared).toHaveLength(8);
    expect(new Set(shared.map((entry) => entry.tree)).size).toBe(8);
  } finally {
    for (const child of children) {
      child.kill();
      await child.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test('readers see complete documents while replacements publish', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate-memo-readers-'));
  try {
    const path = join(root, 'memo.json');
    await writeGreenGate('initial', record, path);
    let finished = false;
    const writer = (async () => {
      try {
        for (let index = 0; index < 20; index += 1)
          await writeGreenGate(`gate-${index}`, { ...record, tree: 'x'.repeat(16384) }, path);
      } finally {
        finished = true;
      }
    })();
    let reads = 0;
    try {
      while (!finished) {
        const document: unknown = JSON.parse(await readFile(path, 'utf8'));
        expect(typeof document).toBe('object');
        expect(await readGreenGates('initial', path)).toHaveLength(1);
        reads += 1;
      }
    } finally {
      await writer;
    }
    expect(reads).toBeGreaterThan(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a killed writer before publication leaves old bytes and a reclaimable transaction lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate-memo-crash-'));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const path = join(root, 'memo.json');
    await writeGreenGate('initial', record, path);
    const before = await readFile(path, 'utf8');
    child = startFixture('gate-memo-crash-worker.ts', path);
    await ready(child);
    child.kill('SIGKILL');
    await child.exited;
    expect(await readFile(path, 'utf8')).toBe(before);
    await writeGreenGate('after-crash', record, path);
    expect(await readGreenGates('initial', path)).toHaveLength(1);
    expect(await readGreenGates('after-crash', path)).toHaveLength(1);
    expect(await readGreenGates('crashed', path)).toEqual([]);
  } finally {
    if (child) {
      child.kill();
      await child.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test('memo filesystem refusal is visible and never a partial proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate-memo-refusal-'));
  try {
    await mkdir(join(root, 'memo.json'));
    await expect(writeGreenGate('refused', record, join(root, 'memo.json'))).rejects.toThrow();
    expect(await readGreenGates('refused', join(root, 'memo.json'))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an occupied transaction returns the canonical lock timeout diagnosis', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate-memo-timeout-'));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const path = join(root, 'memo.json');
    await withExclusiveLock(`${path}.lock`, async () => {
      const running = startFixture('gate-memo-timeout-worker.ts', path);
      child = running;
      const output = await new Response(running.stdout).text();
      expect(await running.exited).toBe(0);
      expect(output).toContain('LOCK_TIMEOUT');
      expect(output).toContain('green gate memo');
      expect(output).toContain('gave up after 30 ms');
      expect(await Bun.file(`${path}.lock`).exists()).toBe(true);
    });
    expect(await readGreenGates('blocked', path)).toEqual([]);
    // Synthetic age qualifies policy only; a live delayed-owner experiment is
    // separate. Even a very old empty record cannot prove its creator dead.
    await writeFile(`${path}.lock`, '');
    const old = new Date(Date.now() - 60_000);
    await utimes(`${path}.lock`, old, old);
    const unknownOwner = startFixture('gate-memo-timeout-worker.ts', path);
    child = unknownOwner;
    const refusal = await new Response(unknownOwner.stdout).text();
    expect(await unknownOwner.exited).toBe(0);
    expect(refusal).toContain('LOCK_TIMEOUT');
    expect(refusal).toContain('a holder that recorded no owner');
    expect(await readFile(`${path}.lock`, 'utf8')).toBe('');
    expect(await readGreenGates('blocked', path)).toEqual([]);
  } finally {
    if (child) {
      child.kill();
      await child.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
