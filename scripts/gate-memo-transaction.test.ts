import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withExclusiveLock } from '../packages/core/src/internal/with-exclusive-lock';
import { forgetGreenGate, greenGateKey, readGreenGates, writeGreenGate } from './gate-memo';

const record = { tree: 'one', toolchain: 'bun:test', at: 'now', commit: '(no commit)' };

async function waitForFile(path: string): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!(await Bun.file(path).exists())) {
    if (performance.now() > deadline) throw new Error('Fixture readiness deadline expired');
    await Bun.sleep(5);
  }
}

test('separate processes serialize independent writes and bound shared history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate-memo-processes-'));
  const children: ReturnType<typeof Bun.spawn>[] = [];
  try {
    const path = join(root, 'memo.json');
    const worker = join(root, 'worker.ts');
    await writeFile(
      worker,
      `
      import { writeGreenGate } from ${JSON.stringify(join(import.meta.dir, 'gate-memo.ts'))};
      const [root, id] = Bun.argv.slice(2);
      await Bun.write(root + '/ready-' + id, 'ready');
      while (!await Bun.file(root + '/start').exists()) await Bun.sleep(5);
      const record = {tree: id, toolchain:'bun:test', at:'now', commit:'(no commit)'};
      await writeGreenGate('gate-' + id, record, root + '/memo.json');
      await writeGreenGate('shared', record, root + '/memo.json');
    `,
    );
    for (let index = 0; index < 10; index += 1)
      children.push(
        Bun.spawn([process.execPath, worker, root, String(index)], { stderr: 'pipe' }),
      );
    await Promise.all(children.map((_, index) => waitForFile(join(root, `ready-${index}`))));
    await writeFile(join(root, 'start'), 'start');
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

test('write/forget cannot resurrect a revoked record or lose an independent update', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate-memo-forget-'));
  try {
    const path = join(root, 'memo.json');
    for (let index = 0; index < 10; index += 1) {
      await writeGreenGate('victim', record, path);
      await Promise.all([
        writeGreenGate('other', { ...record, tree: String(index) }, path),
        forgetGreenGate('victim', greenGateKey(record), path),
      ]);
      expect(await readGreenGates('victim', path)).toEqual([]);
      expect((await readGreenGates('other', path))[0]?.tree).toBe(String(index));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
    const worker = join(root, 'crash.ts');
    await writeFile(
      worker,
      `
      import { mock } from 'bun:test';
      const fs = await import('node:fs/promises');
      const actualOpen = fs.open;
      mock.module('node:fs/promises', () => ({ ...fs, open: async (name, ...args) => {
        const handle = await actualOpen(name, ...args);
        if (!String(name).includes('/.memo.json.')) return handle;
        return {
          writeFile: async (...data) => {
            await handle.writeFile(...data);
            await Bun.write(${JSON.stringify(join(root, 'ready'))}, 'ready');
            await new Promise(() => {});
          },
          chmod: handle.chmod.bind(handle), sync: handle.sync.bind(handle),
          close: handle.close.bind(handle),
        };
      }}));
      const { writeGreenGate } = await import(${JSON.stringify(join(import.meta.dir, 'gate-memo.ts'))});
      await writeGreenGate('crashed', ${JSON.stringify(record)}, ${JSON.stringify(path)});
    `,
    );
    child = Bun.spawn([process.execPath, worker], { stderr: 'pipe' });
    await waitForFile(join(root, 'ready'));
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
    const worker = join(root, 'timeout.ts');
    const owner = join(
      import.meta.dir,
      '../packages/core/src/internal/with-exclusive-lock.ts',
    );
    await writeFile(
      worker,
      `
      import { mock } from 'bun:test';
      const { withExclusiveLock: actual } = await import(${JSON.stringify(owner)});
      mock.module(${JSON.stringify(owner)}, () => ({
        withExclusiveLock: (path, run, options) => actual(path, run, {...options, timeoutMs:30}),
      }));
      const { writeGreenGate } = await import(${JSON.stringify(join(import.meta.dir, 'gate-memo.ts'))});
      try { await writeGreenGate('blocked', ${JSON.stringify(record)}, ${JSON.stringify(path)}); }
      catch(error) {
        console.log(JSON.stringify({code:error.code,label:error.label,message:error.message}));
        process.exit(0);
      }
      throw new Error('A live transaction lock was bypassed');
    `,
    );
    await withExclusiveLock(`${path}.lock`, async () => {
      const running = Bun.spawn([process.execPath, worker], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
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
    const unknownOwner = Bun.spawn([process.execPath, worker], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
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
