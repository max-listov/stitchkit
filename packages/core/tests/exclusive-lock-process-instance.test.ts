import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { withExclusiveLock } from '../src/entrypoints/files';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'stitchkit-process-lock-'));
  directories.push(dir);
  return join(dir, 'owner.lock');
}

test('previous boot with a reused live PID is reclaimed without consulting wall time', async () => {
  const path = await fixture();
  await writeFile(
    path,
    JSON.stringify({
      pid: process.pid,
      host: hostname(),
      acquiredAt: '2999-01-01T00:00:00.000Z',
      machine: 'fixture-machine',
      process: {
        platform: platform(),
        bootId: 'previous-boot',
        namespace: 'fixture',
        startId: '1',
      },
    }),
  );
  const held = await withExclusiveLock(
    path,
    async (lock) => {
      const record = JSON.parse(await readFile(path, 'utf8'));
      expect(record.process.bootId).not.toBe('previous-boot');
      expect(record.process.startId).toBeTruthy();
      return lock;
    },
    { machineIdentity: 'fixture-machine', timeoutMs: 0 },
  );
  expect(held.reclaimed).toBe(true);
});

async function currentOwner() {
  const path = await fixture();
  return withExclusiveLock(path, (lock) => lock.owner, { machineIdentity: 'fixture-machine' });
}

test('same-boot PID reuse is reclaimed but a matching live writer and foreign namespace are protected', async () => {
  const owner = await currentOwner();
  if (!owner.process) throw new Error('Current kernel process identity unavailable');
  for (const variation of [
    'same',
    'reused',
    'namespace',
    'foreign',
    'unknown',
    'malformed',
    'legacy',
  ]) {
    const path = await fixture();
    const record = {
      ...owner,
      acquiredAt: '1900-01-01T00:00:00.000Z',
      ...(variation === 'foreign' && { machine: 'another-machine' }),
      process:
        variation === 'unknown'
          ? null
          : variation === 'malformed'
            ? { bootId: 123 }
            : variation === 'legacy'
              ? undefined
              : {
                  ...owner.process,
                  ...(variation === 'reused' && { startId: `${owner.process.startId}0` }),
                  ...(variation === 'namespace' && { namespace: 'another-pid-namespace' }),
                },
    };
    await writeFile(path, JSON.stringify(record));
    const attempt = withExclusiveLock(path, (lock) => lock.reclaimed, {
      machineIdentity: 'fixture-machine',
      timeoutMs: 0,
      ownerlessGraceMs: 0,
    });
    if (variation === 'reused') expect(await attempt).toBe(true);
    else {
      await expect(attempt).rejects.toThrow('gave up');
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(
        JSON.parse(JSON.stringify(record)),
      );
    }
  }
});

test('an abandoned reclaim guard uses boot and process identity without removing a live guard', async () => {
  const owner = await currentOwner();
  if (!owner.process) throw new Error('Current kernel process identity unavailable');
  const stale = {
    ...owner,
    process: { ...owner.process, startId: `${owner.process.startId}0` },
  };
  const path = await fixture();
  await writeFile(path, JSON.stringify(stale));
  await writeFile(`${path}.reclaim`, JSON.stringify(owner));
  await expect(
    withExclusiveLock(path, () => undefined, {
      machineIdentity: 'fixture-machine',
      timeoutMs: 0,
    }),
  ).rejects.toThrow('gave up');
  expect(JSON.parse(await readFile(`${path}.reclaim`, 'utf8'))).toEqual(owner);
  await writeFile(
    `${path}.reclaim`,
    JSON.stringify({ ...stale, process: { ...stale.process, bootId: 'previous-boot' } }),
  );
  expect(
    await withExclusiveLock(path, (held) => held.reclaimed, {
      machineIdentity: 'fixture-machine',
      timeoutMs: 1000,
    }),
  ).toBe(true);
  await expect(readFile(`${path}.reclaim`)).rejects.toThrow();
});

test('concurrent processes reclaim one reused-PID lock and stale guard with only one writer', async () => {
  const owner = await currentOwner();
  if (!owner.process) throw new Error('Current kernel process identity unavailable');
  const path = await fixture();
  const stale = { ...owner, process: { ...owner.process, bootId: 'previous-boot' } };
  await writeFile(path, JSON.stringify(stale));
  await writeFile(`${path}.reclaim`, JSON.stringify(stale));
  const entrypoint = new URL('../src/entrypoints/files.ts', import.meta.url).href;
  const program = `
    import { withExclusiveLock } from ${JSON.stringify(entrypoint)};
    import { open, unlink } from 'node:fs/promises';
    await withExclusiveLock(${JSON.stringify(path)}, async () => {
      const sentinel = ${JSON.stringify(`${path}.writer`)};
      const handle = await open(sentinel, 'wx');
      await Bun.sleep(20);
      await handle.close();
      await unlink(sentinel);
    }, { machineIdentity: 'fixture-machine', timeoutMs: 4000 });
    console.log('one writer');
  `;
  const children = Array.from({ length: 8 }, () =>
    Bun.spawn([process.execPath, '--eval', program], { stdout: 'pipe', stderr: 'pipe' }),
  );
  const results = await Promise.all(
    children.map(async (child) => ({
      code: await child.exited,
      out: await new Response(child.stdout).text(),
      err: await new Response(child.stderr).text(),
    })),
  );
  for (const result of results) {
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(result.out.trim()).toBe('one writer');
  }
}, 15000);

test('a SIGKILLed modern owner is reclaimed and a new live owner is never displaced', async () => {
  const path = await fixture();
  const entrypoint = new URL('../src/entrypoints/files.ts', import.meta.url).href;
  const program = `
    import { withExclusiveLock } from ${JSON.stringify(entrypoint)};
    await withExclusiveLock(${JSON.stringify(path)}, async () => {
      console.log('held');
      await Bun.sleep(10000);
    }, { machineIdentity: 'fixture-machine' });
  `;
  const child = Bun.spawn([process.execPath, '--eval', program], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const chunk = await Promise.race([
      child.stdout.getReader().read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('child did not acquire')), 3000);
      }),
    ]);
    expect(new TextDecoder().decode(chunk.value)).toContain('held');
    await expect(
      withExclusiveLock(path, () => undefined, {
        machineIdentity: 'fixture-machine',
        timeoutMs: 0,
      }),
    ).rejects.toThrow('gave up');
    child.kill('SIGKILL');
    await child.exited;
    expect(
      await withExclusiveLock(path, (held) => held.reclaimed, {
        machineIdentity: 'fixture-machine',
        timeoutMs: 1000,
      }),
    ).toBe(true);
  } finally {
    clearTimeout(timer);
    child.kill();
    await child.exited;
  }
});
