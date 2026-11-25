import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeProcessInstance, probeProcessOwner } from '../src/entrypoints/process';
import { probeLiveness, probeLivenessSync } from '../src/internal/process-identity';
import {
  linuxProcessStart,
  type ProcessInstance,
  probeProcessOwnerSync,
  probeProcessOwnerSyncWith,
  probeProcessOwnerWith,
  readProcessInstance,
} from '../src/internal/process-instance';
import { trackProcess } from './support/process-reaper';
import { withZombie } from './support/zombie';

const identity: ProcessInstance = {
  platform: 'linux',
  bootId: 'boot',
  namespace: 'pid:[1];time:[1]',
  startId: '123',
};
function stat(pid: number) {
  return `${pid} (a strange (name)) S ${Array(18).fill('0').join(' ')} 98765 0`;
}

test('Linux birth is field 22 after the final parenthesis and mismatched PID or partial stat refuses', () => {
  expect(linuxProcessStart(stat(42), 42)).toBe('98765');
  expect(linuxProcessStart(stat(42), 43)).toBeNull();
  expect(linuxProcessStart('42 (name) S 1 2', 42)).toBeNull();
});

test.skipIf(process.platform !== 'linux')(
  'Linux kernel fixtures retain boot, PID and time namespace and refuse a foreign proc mount',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'stitchkit-proc-fixture-'));
    try {
      for (const dir of ['sys/kernel/random', 'self/ns', '42'])
        await mkdir(join(root, dir), { recursive: true });
      await writeFile(join(root, 'sys/kernel/random/boot_id'), 'boot-id\n');
      await writeFile(join(root, 'self/stat'), stat(process.pid));
      await writeFile(join(root, 'self/status'), `NStgid:\t${process.pid}\n`);
      await writeFile(join(root, '42/stat'), stat(42));
      await symlink('pid:[1]', join(root, 'self/ns/pid'));
      await symlink('time:[1]', join(root, 'self/ns/time'));
      expect(await readProcessInstance(42, root)).toEqual({
        platform: 'linux',
        bootId: 'boot-id',
        namespace: 'pid:[1];time:[1]',
        startId: '98765',
      });
      // A kernel before 5.6 has no time namespace: the identity keeps the PID namespace.
      await rm(join(root, 'self/ns/time'));
      expect((await readProcessInstance(42, root))?.namespace).toBe('pid:[1];');
      await symlink('time:[1]', join(root, 'self/ns/time'));
      await writeFile(join(root, 'self/stat'), stat(process.pid + 1));
      expect(await readProcessInstance(42, root)).toBeNull();
      expect(await readProcessInstance(43, root)).toBeNull();
      await writeFile(join(root, 'self/stat'), stat(process.pid));
      for (const status of [
        `NStgid:\t${process.pid}\t${process.pid}\n`,
        `NStgid:\t${process.pid + 1}\n`,
        'Name:\tmissing namespace evidence\n',
      ]) {
        await writeFile(join(root, 'self/status'), status);
        expect(await readProcessInstance(42, root)).toBeNull();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('unknown evidence never proves death; a boot mismatch does not depend on PID reachability', async () => {
  let probes = 0;
  const liveness = async (): Promise<'alive' | 'gone'> => {
    probes++;
    return 'alive';
  };
  const read = async (pid: number) => (pid === process.pid ? identity : null);
  expect(
    await probeProcessOwnerWith(42, { ...identity, bootId: 'old-boot' }, { read, liveness }),
  ).toEqual({ liveness: 'gone', identity: 'different-boot' });
  expect(probes).toBe(0);
  expect((await probeProcessOwnerWith(42, identity, { read, liveness })).liveness).toBe(
    'not-probed',
  );
  expect(
    (await probeProcessOwnerWith(42, identity, { read: async () => null, liveness })).liveness,
  ).toBe('not-probed');
  expect((await probeProcessOwnerWith(42, null, { read, liveness })).liveness).toBe(
    'not-probed',
  );
  expect((await probeProcessOwnerWith(42, undefined, { read, liveness })).identity).toBe(
    'legacy',
  );
});

test('EPERM and an unreadable process identity refuse; ESRCH is the distinct absence case', async () => {
  const denied = async (pid: number) =>
    probeLiveness(pid, () => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    });
  const absent = async (pid: number) =>
    probeLiveness(pid, () => {
      throw Object.assign(new Error('absent'), { code: 'ESRCH' });
    });
  const read = async (pid: number) => (pid === process.pid ? identity : null);
  expect(await denied(42)).toBe('alive');
  expect(await probeProcessOwnerWith(42, identity, { read, liveness: denied })).toMatchObject({
    liveness: 'not-probed',
    identity: 'unavailable',
  });
  expect(await probeProcessOwnerWith(42, identity, { read, liveness: absent })).toEqual({
    liveness: 'gone',
    identity: 'pid-gone',
  });
});

test('same-boot foreign namespace refuses before liveness while different-boot policy stays explicit', async () => {
  let calls = 0;
  const probes = {
    read: async () => identity,
    liveness: async (): Promise<'alive'> => {
      calls++;
      return 'alive';
    },
  };
  expect(
    await probeProcessOwnerWith(
      42,
      { ...identity, namespace: 'pid:[foreign];time:[foreign]' },
      probes,
    ),
  ).toMatchObject({
    identity: 'unavailable',
    liveness: 'not-probed',
    cause: new Error('Process namespaces differ'),
  });
  expect(calls).toBe(0);
  expect(
    await probeProcessOwnerWith(
      42,
      { ...identity, bootId: 'guest-boot', namespace: 'pid:[foreign];time:[foreign]' },
      probes,
    ),
  ).toEqual({
    identity: 'different-boot',
    liveness: 'gone',
  });
  expect(calls).toBe(0);
  expect(await probeProcessOwnerWith(42, { ...identity, startId: '0' }, probes)).toEqual({
    identity: 'reused-pid',
    liveness: 'gone',
  });
  expect(calls).toBe(1);
});

test('a zombie is gone to the asynchronous and the synchronous liveness probe alike', async () => {
  await withZombie(async (pid) => {
    expect(await probeLiveness(pid)).toBe('gone');
    expect(probeLivenessSync(pid)).toBe('gone');
  });
  // The negative control: this process is running.
  expect(await probeLiveness(process.pid)).toBe('alive');
  expect(probeLivenessSync(process.pid)).toBe('alive');
});

test('probeProcessOwner reports pid-gone when a PID exits between liveness and observe while keeping real unavailable failures', async () => {
  const enoent = Object.assign(new Error('ENOENT: /proc/42/stat'), { code: 'ENOENT' });
  const eperm = Object.assign(new Error('EPERM: /proc/42/stat'), { code: 'EPERM' });
  const selfFailure = new Error('unreadable /proc/self');

  // Positive control (async): first liveness sees alive, observe hits ENOENT as PID exits, second liveness confirms gone.
  let asyncCalls = 0;
  expect(
    await probeProcessOwnerWith(42, identity, {
      read: async () => null,
      liveness: async () => (++asyncCalls === 1 ? 'alive' : 'gone'),
      observe: async (pid) =>
        pid === process.pid
          ? { state: 'observed', instance: identity }
          : { state: 'unavailable', cause: enoent },
    }),
  ).toEqual({ liveness: 'gone', identity: 'pid-gone' });
  expect(asyncCalls).toBe(2);

  // Positive control (sync): identical TOCTOU window in probeProcessOwnerSyncWith.
  let syncCalls = 0;
  expect(
    probeProcessOwnerSyncWith(42, identity, {
      liveness: () => (++syncCalls === 1 ? 'alive' : 'gone'),
      observe: (pid) =>
        pid === process.pid
          ? { state: 'observed', instance: identity }
          : { state: 'unavailable', cause: enoent },
    }),
  ).toEqual({ liveness: 'gone', identity: 'pid-gone' });
  expect(syncCalls).toBe(2);

  // Negative control (async + sync): PID remains alive while observe fails (EPERM / broken /proc) -> unavailable with exact cause.
  let asyncDeniedCalls = 0;
  expect(
    await probeProcessOwnerWith(42, identity, {
      read: async () => null,
      liveness: async () => {
        asyncDeniedCalls++;
        return 'alive';
      },
      observe: async (pid) =>
        pid === process.pid
          ? { state: 'observed', instance: identity }
          : { state: 'unavailable', cause: eperm },
    }),
  ).toEqual({ liveness: 'not-probed', identity: 'unavailable', cause: eperm });
  expect(asyncDeniedCalls).toBe(2);

  let syncDeniedCalls = 0;
  expect(
    probeProcessOwnerSyncWith(42, identity, {
      liveness: () => {
        syncDeniedCalls++;
        return 'alive';
      },
      observe: (pid) =>
        pid === process.pid
          ? { state: 'observed', instance: identity }
          : { state: 'unavailable', cause: eperm },
    }),
  ).toEqual({ liveness: 'not-probed', identity: 'unavailable', cause: eperm });
  expect(syncDeniedCalls).toBe(2);

  // Negative control: unreadable /proc/self fails before liveness is ever queried and is never masked as pid-gone.
  let selfCheckLiveness = 0;
  expect(
    await probeProcessOwnerWith(42, identity, {
      read: async () => null,
      liveness: async () => {
        selfCheckLiveness++;
        return 'gone';
      },
      observe: async () => ({ state: 'unavailable', cause: selfFailure }),
    }),
  ).toEqual({ liveness: 'not-probed', identity: 'unavailable', cause: selfFailure });
  expect(
    probeProcessOwnerSyncWith(42, identity, {
      liveness: () => {
        selfCheckLiveness++;
        return 'gone';
      },
      observe: () => ({ state: 'unavailable', cause: selfFailure }),
    }),
  ).toEqual({ liveness: 'not-probed', identity: 'unavailable', cause: selfFailure });
  expect(selfCheckLiveness).toBe(0);
});

test('public probeProcessOwner and probeProcessOwnerSync transition from matched to pid-gone on a real exiting child', async () => {
  const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
  trackProcess(child.pid);
  try {
    const observed = await observeProcessInstance(child.pid);
    expect(observed.state).toBe('observed');
    if (observed.state !== 'observed') throw observed.cause;
    expect(await probeProcessOwner(child.pid, observed.instance)).toEqual({
      liveness: 'alive',
      identity: 'matched',
    });
    expect(probeProcessOwnerSync(child.pid, observed.instance)).toEqual({
      liveness: 'alive',
      identity: 'matched',
    });
    child.kill('SIGKILL');
    await child.exited;
    expect(await probeProcessOwner(child.pid, observed.instance)).toEqual({
      liveness: 'gone',
      identity: 'pid-gone',
    });
    expect(probeProcessOwnerSync(child.pid, observed.instance)).toEqual({
      liveness: 'gone',
      identity: 'pid-gone',
    });
  } finally {
    try {
      child.kill('SIGKILL');
    } catch {
      // Child already exited.
    }
    await child.exited;
  }
});
