import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProcessInstance } from '../src/entrypoints/process';
import { createServer as createStitchkitServer } from '../src/entrypoints/server';
import {
  createDefaultProcessIdentityAdapter,
  type ProcessIdentityAdapter,
  parseProcNetUnixListeningSockets,
  verifySupervisedProcess,
} from '../src/entrypoints/service-host';
import { createProcfsIdentityAdapter, SS_CANDIDATES } from '../src/service-host/identity';
import { parseUnixSocketListeners } from '../src/service-host/identity-unix-socket';
import { reapAfterEachTest, trackProcess } from './support/process-reaper';

reapAfterEachTest();

/** A child that listens at `path`, optionally unlinks the name, says `ready` and waits. */
async function holdListener(path: string, unlinkName: boolean) {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      '-e',
      [
        "import { createServer } from 'node:net';",
        "import { unlinkSync } from 'node:fs';",
        'const path = process.env.STITCHKIT_TEST_UNIX_PATH;',
        'const server = createServer();',
        'await new Promise((resolve) => server.listen(path, resolve));',
        "if (process.env.STITCHKIT_TEST_UNLINK === '1') unlinkSync(path);",
        "process.stdout.write('ready\\n');",
        'await new Promise(() => {});',
      ].join('\n'),
    ],
    env: {
      ...process.env,
      STITCHKIT_TEST_UNIX_PATH: path,
      STITCHKIT_TEST_UNLINK: unlinkName ? '1' : '0',
    },
    stdout: 'pipe',
    stderr: 'inherit',
  });
  trackProcess(child.pid);
  const reader = child.stdout.getReader();
  const first = await reader.read();
  reader.releaseLock();
  expect(new TextDecoder().decode(first.value)).toContain('ready');
  return child;
}

const INSTANCE_A: ProcessInstance = {
  platform: 'linux',
  bootId: '11111111-2222-3333-4444-555555555555',
  namespace: 'pid:[4026531836];time:[4026531834]',
  startId: '123456',
};

const SAMPLE_PROC_NET_UNIX = [
  'Num       RefCount Protocol Flags    Type St Inode Path',
  '0000000000000001: 00000003 00000000 00000000 0001 03 10001 /run/daemon/service.sock',
  '0000000000000002: 00000002 00000000 00010000 0001 01 20002 /run/daemon/service.sock',
  '0000000000000003: 00000002 00000000 00010000 0001 01 30003 /run/daemon/with space.sock',
  '0000000000000004: 00000002 00000000 00000000 0001 01 40004 /run/daemon/bound-not-listening.sock',
  '0000000000000005: 00000002 00000000 00010000 0001 01 50005 @example-abstract-sock',
  '0000000000000006: 00000002 00000000 00010000 0001 01 0 /run/daemon/zero-inode.sock',
].join('\n');

/**
 * The fake kernel: a path reaches every socket whose `/proc/net/unix` line names it, with
 * `/var/run` standing for the symlink to `/run`. It answers from the listing the check just
 * read, so a test that changes the listing between snapshots changes the nodes with it.
 */
function createFakeIdentityAdapter(
  overrides: Partial<ProcessIdentityAdapter> = {},
): ProcessIdentityAdapter {
  let listing = '';
  const adapter: ProcessIdentityAdapter = {
    async observeProcessInstance() {
      return { state: 'observed', instance: INSTANCE_A };
    },
    async probeProcessOwner() {
      return { liveness: 'alive', identity: 'matched' };
    },
    async readProcessExe() {
      return '/opt/daemon/releases/v2/bin/daemon';
    },
    async resolveExecutablePath(path) {
      return path;
    },
    async readProcessArgv() {
      return [
        '/opt/daemon/releases/v2/bin/daemon',
        '--serve',
        '--socket',
        '/run/daemon/service.sock',
      ];
    },
    async readProcNetUnix() {
      return SAMPLE_PROC_NET_UNIX;
    },
    async readProcessSocketInodes() {
      return new Set(['20002', '50005', '99999']);
    },
    async readSocketInodesAtPath(socketPath) {
      const resolved = socketPath.replace(/^\/var\/run\//, '/run/');
      const inodes = new Set<string>();
      for (const line of listing.split('\n')) {
        const match = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\d+)\s+(.*)$/.exec(line);
        if (match?.[1] !== undefined && match[2] === resolved) inodes.add(match[1]);
      }
      return inodes;
    },
    ...overrides,
  };
  const readProcNetUnix = adapter.readProcNetUnix;
  adapter.readProcNetUnix = async () => {
    listing = await readProcNetUnix();
    return listing;
  };
  return adapter;
}

describe('service-host /proc/net/unix parsing', () => {
  test('extracts listening Unix sockets (St=01 with SO_ACCEPTCON, non-zero inode), preserving spaces and @abstract names', () => {
    const sockets = parseProcNetUnixListeningSockets(SAMPLE_PROC_NET_UNIX);
    expect(sockets).toEqual([
      {
        flagsHex: '00010000',
        typeHex: '0001',
        stateHex: '01',
        listening: true,
        inode: '20002',
        path: '/run/daemon/service.sock',
      },
      {
        flagsHex: '00010000',
        typeHex: '0001',
        stateHex: '01',
        listening: true,
        inode: '30003',
        path: '/run/daemon/with space.sock',
      },
      {
        flagsHex: '00010000',
        typeHex: '0001',
        stateHex: '01',
        listening: true,
        inode: '50005',
        path: '@example-abstract-sock',
      },
    ]);
  });
});

describe('service-host supervised process verification', () => {
  test('verifies live PID, exe, argv (prefix), canonicalized and @abstract Unix sockets, and confirms owner AFTER checks', async () => {
    const callOrder: string[] = [];
    const adapter = createFakeIdentityAdapter({
      async observeProcessInstance(pid) {
        callOrder.push(`observe:${pid}`);
        return { state: 'observed', instance: INSTANCE_A };
      },
      async readProcessExe(pid) {
        callOrder.push(`exe:${pid}`);
        return '/opt/daemon/releases/v2/bin/daemon';
      },
      async readProcessArgv(pid) {
        callOrder.push(`argv:${pid}`);
        return [
          '/opt/daemon/releases/v2/bin/daemon',
          '--serve',
          '--socket',
          '/run/daemon/service.sock',
        ];
      },
      async readProcNetUnix() {
        callOrder.push('proc-net-unix');
        return SAMPLE_PROC_NET_UNIX;
      },
      async readProcessSocketInodes(pid) {
        callOrder.push(`fd:${pid}`);
        return new Set(['20002', '50005']);
      },
      async probeProcessOwner(pid, recorded) {
        callOrder.push(`probe:${pid}:${recorded?.startId}`);
        return { liveness: 'alive', identity: 'matched' };
      },
    });

    // /var/run/daemon/service.sock canonicalizes to /run/daemon/service.sock
    const verified = await verifySupervisedProcess({
      pid: 4242,
      expectedExe: '/opt/daemon/releases/v2/bin/daemon',
      expectedArgv: ['/opt/daemon/releases/v2/bin/daemon', '--serve'],
      argvMatch: 'prefix',
      socketPath: '/var/run/daemon/service.sock',
      adapter,
    });

    expect(verified).toEqual({
      status: 'verified',
      pid: 4242,
      instance: INSTANCE_A,
      exe: '/opt/daemon/releases/v2/bin/daemon',
      argv: [
        '/opt/daemon/releases/v2/bin/daemon',
        '--serve',
        '--socket',
        '/run/daemon/service.sock',
      ],
      socketInode: '20002',
    });

    // TOCTOU invariant: probeProcessOwner MUST run AFTER exe, argv, and socket fd inspection,
    // followed by a confirming /proc/net/unix snapshot.
    const probeIndex = callOrder.findIndex((step) => step.startsWith('probe:'));
    expect(probeIndex).toBeGreaterThan(-1);
    expect(callOrder.indexOf('exe:4242')).toBeLessThan(probeIndex);
    expect(callOrder.indexOf('argv:4242')).toBeLessThan(probeIndex);
    expect(callOrder.indexOf('fd:4242')).toBeLessThan(probeIndex);
    expect(callOrder.lastIndexOf('proc-net-unix')).toBeGreaterThan(probeIndex);

    // Abstract @name socket compares literally without canonicalization
    const abstractVerified = await verifySupervisedProcess({
      pid: 4242,
      socketPath: '@example-abstract-sock',
      adapter,
    });
    expect(abstractVerified.status).toBe('verified');
    if (abstractVerified.status === 'verified') {
      expect(abstractVerified.socketInode).toBe('50005');
    }
  });

  test('detects PID reuse TOCTOU when probeProcessOwner reports reused-pid after exe and socket checks', async () => {
    const adapter = createFakeIdentityAdapter({
      async probeProcessOwner() {
        return { liveness: 'gone', identity: 'reused-pid' };
      },
    });

    const result = await verifySupervisedProcess({
      pid: 4242,
      expectedExe: '/opt/daemon/releases/v2/bin/daemon',
      expectedArgv: [
        '/opt/daemon/releases/v2/bin/daemon',
        '--serve',
        '--socket',
        '/run/daemon/service.sock',
      ],
      socketPath: '/run/daemon/service.sock',
      adapter,
    });

    expect(result.status).toBe('runtime-conflict');
    if (result.status === 'runtime-conflict') {
      expect(result.reason).toBe('pid-reused');
    }
  });

  test('distinguishes runtime-unavailable (socket not listening / restarting) from runtime-conflict (foreign socket owner)', async () => {
    const restarting = await verifySupervisedProcess({
      pid: 4242,
      expectedExe: '/opt/daemon/releases/v2/bin/daemon',
      socketPath: '/run/daemon/not-bound-yet.sock',
      adapter: createFakeIdentityAdapter(),
    });
    expect(restarting.status).toBe('runtime-unavailable');
    if (restarting.status === 'runtime-unavailable') {
      expect(restarting.reason).toBe('socket-not-listening');
    }

    const foreignHolder = await verifySupervisedProcess({
      pid: 4242,
      expectedExe: '/opt/daemon/releases/v2/bin/daemon',
      socketPath: '/run/daemon/service.sock',
      adapter: createFakeIdentityAdapter({
        async readProcessSocketInodes() {
          return new Set(['77777']);
        },
      }),
    });
    expect(foreignHolder.status).toBe('runtime-conflict');
    if (foreignHolder.status === 'runtime-conflict') {
      expect(foreignHolder.reason).toBe('socket-owned-by-other-process');
    }
  });

  test('reports runtime-conflict on exe mismatch or argv mismatch (exact vs prefix)', async () => {
    const exeConflict = await verifySupervisedProcess({
      pid: 4242,
      expectedExe: '/opt/daemon/releases/v3/bin/daemon',
      adapter: createFakeIdentityAdapter(),
    });
    expect(exeConflict.status).toBe('runtime-conflict');
    if (exeConflict.status === 'runtime-conflict') {
      expect(exeConflict.reason).toBe('exe-mismatch');
    }

    const argvExactConflict = await verifySupervisedProcess({
      pid: 4242,
      expectedArgv: ['/opt/daemon/releases/v2/bin/daemon', '--serve'],
      adapter: createFakeIdentityAdapter(),
    });
    expect(argvExactConflict.status).toBe('runtime-conflict');
    if (argvExactConflict.status === 'runtime-conflict') {
      expect(argvExactConflict.reason).toBe('argv-mismatch');
    }
  });

  test('classifies ENOENT at Step 1 as process-gone, EPERM as process-unobservable, and checks recordedInstance', async () => {
    const unobservable = await verifySupervisedProcess({
      pid: 4242,
      adapter: createFakeIdentityAdapter({
        async observeProcessInstance() {
          return {
            state: 'unavailable',
            cause: Object.assign(new Error('EPERM'), { code: 'EPERM' }),
          };
        },
      }),
    });
    expect(unobservable.status).toBe('runtime-unavailable');
    if (unobservable.status === 'runtime-unavailable') {
      expect(unobservable.reason).toBe('process-unobservable');
    }

    const goneAtStep1 = await verifySupervisedProcess({
      pid: 4242,
      adapter: createFakeIdentityAdapter({
        async observeProcessInstance() {
          return {
            state: 'unavailable',
            cause: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
          };
        },
      }),
    });
    expect(goneAtStep1.status).toBe('runtime-unavailable');
    if (goneAtStep1.status === 'runtime-unavailable') {
      expect(goneAtStep1.reason).toBe('process-gone');
    }

    const staleRecorded: ProcessInstance = { ...INSTANCE_A, startId: '999999' };
    const staleResult = await verifySupervisedProcess({
      pid: 4242,
      recordedInstance: staleRecorded,
      adapter: createFakeIdentityAdapter(),
    });
    expect(staleResult.status).toBe('runtime-conflict');
    if (staleResult.status === 'runtime-conflict') {
      expect(staleResult.reason).toBe('pid-reused');
    }
  });

  test('verifies current process, symlinked socketPath, and nonexistent PID on live Linux /proc', async () => {
    if (platform() !== 'linux') return;
    const dir = mkdtempSync(join(tmpdir(), 'stitchkit-identity-sock-'));
    const realSocketPath = join(dir, 'live.sock');
    const symlinkDir = `${dir}-link`;
    symlinkSync(dir, symlinkDir);
    const symlinkSocketPath = join(symlinkDir, 'live.sock');
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(realSocketPath, resolve));
    try {
      const ownExe = readlinkSync(`/proc/${process.pid}/exe`);
      const adapter = createDefaultProcessIdentityAdapter('/proc');
      const verifiedViaSymlink = await verifySupervisedProcess({
        pid: process.pid,
        expectedExe: ownExe,
        socketPath: symlinkSocketPath,
        adapter,
      });
      expect(verifiedViaSymlink.status).toBe('verified');
      if (verifiedViaSymlink.status === 'verified') {
        expect(verifiedViaSymlink.exe).toBe(ownExe);
        expect(verifiedViaSymlink.socketInode).toMatch(/^\d+$/);
      }

      const missingPid = await verifySupervisedProcess({
        pid: 2_000_000_000,
        adapter,
      });
      expect(missingPid.status).toBe('runtime-unavailable');
      if (missingPid.status === 'runtime-unavailable') {
        expect(missingPid.reason).toBe('process-gone');
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(symlinkDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a listener whose name was unlinked does not own the path another process took', async () => {
    if (platform() !== 'linux') return;
    const dir = mkdtempSync(join(tmpdir(), 'stitchkit-identity-stale-'));
    const path = join(dir, 'taken.sock');
    try {
      // `/proc/net/unix` keeps the bound name of a listener after its file is gone, so both
      // children stand there under `path`. Only the second is behind the file at `path` now.
      const stale = await holdListener(path, true);
      const owner = await holdListener(path, false);
      const adapter = createDefaultProcessIdentityAdapter('/proc');

      const staleResult = await verifySupervisedProcess({
        pid: stale.pid,
        socketPath: path,
        adapter,
      });
      expect(staleResult).toMatchObject({
        status: 'runtime-conflict',
        reason: 'socket-owned-by-other-process',
      });
      const ownerResult = await verifySupervisedProcess({
        pid: owner.pid,
        socketPath: path,
        adapter,
      });
      expect(ownerResult.status).toBe('verified');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('a Stitchkit unix server owns the path it publishes, whatever name it bound', async () => {
    if (platform() !== 'linux') return;
    const dir = mkdtempSync(join(tmpdir(), 'stitchkit-identity-own-'));
    chmodSync(dir, 0o700);
    const path = join(dir, 'app.sock');
    // The server binds a staging name and links the published one to the same node, so the
    // kernel never lists `app.sock` at all: the node is the only thing the two names share.
    const server = createStitchkitServer({ unix: path, services: [] });
    try {
      const verified = await verifySupervisedProcess({
        pid: process.pid,
        socketPath: path,
        adapter: createDefaultProcessIdentityAdapter('/proc'),
      });
      expect(verified.status).toBe('verified');
    } finally {
      await server.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reads each listening socket from ss with its name and, when bound to a path, its node', () => {
    const output = [
      'u_str LISTEN 0      512    /run/app/.sk-79226b 31169303            * 0     users:(("bun",pid=1422792,fd=7))   <-> ino:1542550 dev:0/2049 peers:',
      'u_str LISTEN 0      4096   /run/dir with space/x.sock 20002         * 0     <-> ino:77 dev:1/5 peers:',
      'u_str LISTEN 0      128    @abstract-name 50005                      * 0     <->',
      'u_seq LISTEN 0      128    * 60006                                    * 0     <->',
    ].join('\n');
    expect(parseUnixSocketListeners(output)).toEqual([
      { inode: '31169303', name: '/run/app/.sk-79226b', node: { ino: 1542550n, dev: 2049n } },
      {
        inode: '20002',
        name: '/run/dir with space/x.sock',
        node: { ino: 77n, dev: (1n << 20n) | 5n },
      },
      { inode: '50005', name: '@abstract-name' },
      { inode: '60006', name: '*' },
    ]);
  });

  test('parses non-zero-padded hex state (St=1) in /proc/net/unix', () => {
    const content = [
      'Num       RefCount Protocol Flags    Type St Inode Path',
      '0000000000000001: 00000002 00000000 00010000 0001 1 60006 /run/daemon/unpadded.sock',
      '0000000000000002: 00000002 00000000 00010000 0001 3 60007 /run/daemon/connected.sock',
    ].join('\n');
    expect(parseProcNetUnixListeningSockets(content)).toEqual([
      {
        flagsHex: '00010000',
        typeHex: '0001',
        stateHex: '1',
        listening: true,
        inode: '60006',
        path: '/run/daemon/unpadded.sock',
      },
    ]);
  });

  test('Step 2 exe/argv mismatch probes process owner first so pid-reused and process-gone are classified accurately', async () => {
    const exeReused = await verifySupervisedProcess({
      pid: 4242,
      expectedExe: '/opt/daemon/expected',
      adapter: createFakeIdentityAdapter({
        async readProcessExe() {
          return '/usr/bin/unrelated';
        },
        async probeProcessOwner() {
          return { liveness: 'gone', identity: 'reused-pid' };
        },
      }),
    });
    expect(exeReused).toEqual({ status: 'runtime-conflict', reason: 'pid-reused', pid: 4242 });

    const argvGone = await verifySupervisedProcess({
      pid: 4242,
      expectedArgv: ['/opt/daemon/expected'],
      adapter: createFakeIdentityAdapter({
        async readProcessArgv() {
          return ['/usr/bin/other'];
        },
        async probeProcessOwner() {
          return { liveness: 'gone', identity: 'pid-gone' };
        },
      }),
    });
    expect(argvGone).toEqual({
      status: 'runtime-unavailable',
      reason: 'process-gone',
      pid: 4242,
    });
  });

  test('Step 3 handles in-process socket reload via second /proc/net/unix snapshot (with and without fd re-read) and socket disappearance', async () => {
    const unixWithInode = (inode: string) =>
      [
        'Num       RefCount Protocol Flags    Type St Inode Path',
        `0000000000000002: 00000002 00000000 00010000 0001 01 ${inode} /run/daemon/service.sock`,
      ].join('\n');

    // Case A: process already holds new inode 20099; snapshot #1 saw stale 20002, snapshot #2 sees 20099
    let procCallsA = 0;
    const reloadA = await verifySupervisedProcess({
      pid: 4242,
      socketPath: '/run/daemon/service.sock',
      adapter: createFakeIdentityAdapter({
        async readProcNetUnix() {
          procCallsA += 1;
          return procCallsA === 1 ? unixWithInode('20002') : unixWithInode('20099');
        },
        async readProcessSocketInodes() {
          return new Set(['20099']);
        },
      }),
    });
    expect(reloadA.status).toBe('verified');
    if (reloadA.status === 'verified') expect(reloadA.socketInode).toBe('20099');

    // Case B: inode changed between snapshot #1 (20002) and #2 (20099) AND fd table updated after #1 -> 1 fd re-read succeeds
    let procCallsB = 0;
    let fdCallsB = 0;
    const reloadB = await verifySupervisedProcess({
      pid: 4242,
      socketPath: '/run/daemon/service.sock',
      adapter: createFakeIdentityAdapter({
        async readProcNetUnix() {
          procCallsB += 1;
          return procCallsB === 1 ? unixWithInode('20002') : unixWithInode('20099');
        },
        async readProcessSocketInodes() {
          fdCallsB += 1;
          return fdCallsB === 1 ? new Set(['11111']) : new Set(['20099']);
        },
      }),
    });
    expect(fdCallsB).toBe(2);
    expect(reloadB.status).toBe('verified');
    if (reloadB.status === 'verified') expect(reloadB.socketInode).toBe('20099');

    // Case C: socket vanished between snapshot #1 and snapshot #2 -> socket-not-listening
    let procCallsC = 0;
    const vanished = await verifySupervisedProcess({
      pid: 4242,
      socketPath: '/run/daemon/service.sock',
      adapter: createFakeIdentityAdapter({
        async readProcNetUnix() {
          procCallsC += 1;
          return procCallsC === 1
            ? unixWithInode('20002')
            : 'Num       RefCount Protocol Flags    Type St Inode Path\n';
        },
        async readProcessSocketInodes() {
          return new Set(['77777']);
        },
      }),
    });
    expect(vanished).toMatchObject({
      status: 'runtime-unavailable',
      reason: 'socket-not-listening',
    });
  });

  test('post-Step-4 /proc/net/unix confirmation catches socket disappearance or takeover after probeProcessOwner', async () => {
    const unixWithInode = (inode: string) =>
      [
        'Num       RefCount Protocol Flags    Type St Inode Path',
        `0000000000000002: 00000002 00000000 00010000 0001 01 ${inode} /run/daemon/service.sock`,
      ].join('\n');

    let procCallsDrop = 0;
    const droppedAfterProbe = await verifySupervisedProcess({
      pid: 4242,
      socketPath: '/run/daemon/service.sock',
      adapter: createFakeIdentityAdapter({
        async readProcNetUnix() {
          procCallsDrop += 1;
          return procCallsDrop === 1
            ? unixWithInode('20002')
            : 'Num       RefCount Protocol Flags    Type St Inode Path\n';
        },
        async readProcessSocketInodes() {
          return new Set(['20002']);
        },
      }),
    });
    expect(droppedAfterProbe).toMatchObject({
      status: 'runtime-unavailable',
      reason: 'socket-not-listening',
    });

    let procCallsTakeover = 0;
    const takenOverAfterProbe = await verifySupervisedProcess({
      pid: 4242,
      socketPath: '/run/daemon/service.sock',
      adapter: createFakeIdentityAdapter({
        async readProcNetUnix() {
          procCallsTakeover += 1;
          return procCallsTakeover === 1 ? unixWithInode('20002') : unixWithInode('88888');
        },
        async readProcessSocketInodes() {
          return new Set(['20002']);
        },
      }),
    });
    expect(takenOverAfterProbe).toMatchObject({
      status: 'runtime-conflict',
      reason: 'socket-owned-by-other-process',
      listeningInodes: ['88888'],
    });

    // (a) PID-reuse between Step 4 and Step 4b: new process on same PID owns new inode on socketPath -> MUST be pid-reused, NOT verified!
    let procCallsReuse = 0;
    let fdCallsReuse = 0;
    let probeCallsReuse = 0;
    const pidReusedInStep4b = await verifySupervisedProcess({
      pid: 4242,
      socketPath: '/run/daemon/service.sock',
      adapter: createFakeIdentityAdapter({
        async readProcNetUnix() {
          procCallsReuse += 1;
          return procCallsReuse === 1 ? unixWithInode('20002') : unixWithInode('77777');
        },
        async readProcessSocketInodes() {
          fdCallsReuse += 1;
          return fdCallsReuse === 1 ? new Set(['20002']) : new Set(['77777']);
        },
        async probeProcessOwner() {
          probeCallsReuse += 1;
          return probeCallsReuse === 1
            ? { liveness: 'alive', identity: 'matched' }
            : { liveness: 'gone', identity: 'reused-pid' };
        },
      }),
    });
    expect(probeCallsReuse).toBe(2);
    expect(pidReusedInStep4b).toEqual({
      status: 'runtime-conflict',
      reason: 'pid-reused',
      pid: 4242,
    });

    // (b) Legitimate in-process reload between Step 4 and Step 4b: probeProcessOwner confirms matched -> verified with new inode
    let procCallsReload = 0;
    let fdCallsReload = 0;
    let probeCallsReload = 0;
    const legitReloadInStep4b = await verifySupervisedProcess({
      pid: 4242,
      socketPath: '/run/daemon/service.sock',
      adapter: createFakeIdentityAdapter({
        async readProcNetUnix() {
          procCallsReload += 1;
          return procCallsReload === 1 ? unixWithInode('20002') : unixWithInode('99901');
        },
        async readProcessSocketInodes() {
          fdCallsReload += 1;
          return fdCallsReload === 1 ? new Set(['20002']) : new Set(['99901']);
        },
        async probeProcessOwner() {
          probeCallsReload += 1;
          return { liveness: 'alive', identity: 'matched' };
        },
      }),
    });
    expect(probeCallsReload).toBe(2);
    expect(legitReloadInStep4b.status).toBe('verified');
    if (legitReloadInStep4b.status === 'verified') {
      expect(legitReloadInStep4b.socketInode).toBe('99901');
    }
  });
});

describe('service-host socket ownership when the socket listing cannot be read', () => {
  test('a failing socket listing is socket-unverifiable with its cause, not process-unobservable', async () => {
    const listingFailure = new Error('ss could not run');
    for (const failing of ['readSocketInodesAtPath', 'readProcNetUnix'] as const) {
      const result = await verifySupervisedProcess({
        pid: 4242,
        socketPath: '/run/daemon/service.sock',
        adapter: createFakeIdentityAdapter({
          async [failing]() {
            throw listingFailure;
          },
        }),
      });
      expect(result, failing).toEqual({
        status: 'runtime-unavailable',
        reason: 'socket-unverifiable',
        pid: 4242,
        socketPath: '/run/daemon/service.sock',
        cause: listingFailure,
      });
    }
  });

  test('the default adapter runs ss by its absolute path: a PATH without ss still verifies', async () => {
    if (platform() !== 'linux') return;
    const dir = mkdtempSync(join(tmpdir(), 'stitchkit-identity-path-'));
    const path = join(dir, 'agent.sock');
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(path, resolve));
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = '/nonexistent';
      const result = await verifySupervisedProcess({
        pid: process.pid,
        socketPath: path,
        adapter: createDefaultProcessIdentityAdapter('/proc'),
      });
      expect(result.status).toBe('verified');
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a host without ss answers socket-unverifiable naming the paths it looked at', async () => {
    if (platform() !== 'linux') return;
    const dir = mkdtempSync(join(tmpdir(), 'stitchkit-identity-noss-'));
    const path = join(dir, 'agent.sock');
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(path, resolve));
    try {
      const missing = [join(dir, 'usr-bin-ss'), join(dir, 'usr-sbin-ss')];
      const result = await verifySupervisedProcess({
        pid: process.pid,
        socketPath: path,
        adapter: createProcfsIdentityAdapter({ procRoot: '/proc', ssCandidates: missing }),
      });
      expect(result).toMatchObject({
        status: 'runtime-unavailable',
        reason: 'socket-unverifiable',
        socketPath: path,
      });
      if (result.status === 'runtime-unavailable') {
        expect(String(result.cause)).toContain(missing.join(', '));
      }
      // Positive control: the same socket with the host's own ss.
      const verified = await verifySupervisedProcess({
        pid: process.pid,
        socketPath: path,
        adapter: createProcfsIdentityAdapter({
          procRoot: '/proc',
          ssCandidates: SS_CANDIDATES,
        }),
      });
      expect(verified.status).toBe('verified');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
