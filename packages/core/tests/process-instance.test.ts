import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeLiveness } from '../src/internal/process-identity';
import {
  linuxProcessStart,
  type ProcessInstance,
  probeProcessOwnerWith,
  readProcessInstance,
} from '../src/internal/process-instance';

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

test('Linux kernel fixtures retain boot, PID and time namespace and refuse a foreign proc mount', async () => {
  if (process.platform !== 'linux') return;
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
});

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
