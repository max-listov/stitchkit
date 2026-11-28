import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildLinuxBubblewrapArgs } from '../src/agent-runtime/sandbox-process-linux';
import {
  buildSeatbeltProfile,
  createProcessSandbox,
  ProcessSandboxSpecSchema,
  probeProcessSandbox,
  SandboxError,
} from '../src/entrypoints/agent-runtime/sandbox';
import { runNativeCommand } from '../src/entrypoints/process';
import { reapAfterEachTest } from './support/process-reaper';

reapAfterEachTest();

const bwrapSupported =
  process.platform === 'linux' &&
  spawnSync('/usr/bin/bwrap', [
    '--unshare-all',
    '--ro-bind',
    '/usr',
    '/usr',
    '--ro-bind',
    '/lib',
    '/lib',
    '--ro-bind-try',
    '/lib64',
    '/lib64',
    '--',
    '/usr/bin/true',
  ]).status === 0;

const seatbeltSupported =
  process.platform === 'darwin' &&
  spawnSync('/usr/bin/sandbox-exec', [
    '-p',
    '(version 1)(allow default)',
    '--',
    '/usr/bin/true',
  ]).status === 0;

function listenUnixSocket(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function runWrapped(wrapped: {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
}) {
  return runNativeCommand({
    executable: wrapped.executable,
    args: [...wrapped.args],
    cwd: wrapped.cwd,
    env: { ...wrapped.env },
    envPolicy: 'declared-only',
    capture: true,
    maxOutputBytes: 256 * 1024,
    timeoutMs: 15_000,
  });
}

async function expectSandboxUnavailable(fn: () => Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(SandboxError);
  expect((thrown as SandboxError).code).toBe('SANDBOX_UNAVAILABLE');
}

describe('long-lived OS process sandbox', () => {
  test('validates ProcessSandboxSpec strictly and refuses writableDirs overlapping workspace in workspace-readonly', () => {
    expect(() =>
      ProcessSandboxSpecSchema.parse({
        profile: 'workspace-readonly',
        workspace: '/tmp/ws',
        writableDirs: ['/tmp/ws/sub'],
      }),
    ).toThrow();
    expect(() =>
      ProcessSandboxSpecSchema.parse({
        profile: 'workspace-strict',
        workspace: 'relative/path',
      }),
    ).toThrow();
    const valid = ProcessSandboxSpecSchema.parse({
      profile: 'workspace-readonly',
      workspace: '/tmp/ws',
      writableDirs: ['/tmp/profile'],
      denyPaths: ['/tmp/state/control/api.sock'],
    });
    expect(valid.profile).toBe('workspace-readonly');
  });

  test('fails closed with SANDBOX_UNAVAILABLE when bwrap binary is missing or platform is unsupported', async () => {
    const missingProbe = await probeProcessSandbox({
      platform: 'linux',
      bwrapExecutable: '/nonexistent/stitchkit-missing-bwrap',
    });
    expect(missingProbe.available).toBe(false);
    if (!missingProbe.available) {
      expect(missingProbe.backend).toBe('bwrap');
      expect(missingProbe.reason.length).toBeGreaterThan(0);
    }

    const sandbox = createProcessSandbox(
      {
        profile: 'workspace-strict',
        workspace: '/tmp',
        bwrapExecutable: '/nonexistent/stitchkit-missing-bwrap',
      },
      { platform: 'linux' },
    );
    await expectSandboxUnavailable(() =>
      sandbox.wrapCommand({ executable: '/bin/true', args: [], cwd: '/tmp', env: {} }),
    );

    const unsupported = createProcessSandbox(
      { profile: 'workspace-readonly', workspace: '/tmp' },
      { platform: 'win32' },
    );
    expect((await unsupported.probe()).available).toBe(false);
    await expectSandboxUnavailable(() =>
      unsupported.wrapCommand({ executable: '/bin/true', args: [], cwd: '/tmp', env: {} }),
    );
  });

  test('buildSeatbeltProfile denies writes to workspace in workspace-readonly and enforces denyPaths and network policy', () => {
    const roProfile = buildSeatbeltProfile({
      profile: 'workspace-readonly',
      workspace: '/Users/example-user/space-a',
      writableDirs: ['/Users/example-user/profile-a'],
      homeDir: '/Users/example-user/home-a',
      denyPaths: ['/Users/example-user/state/control/api.sock'],
      unixSockets: [{ hostPath: '/Users/example-user/space-a/mcp.sock' }],
      network: 'deny',
    });
    expect(roProfile).toContain('(deny file-write*)');
    expect(roProfile).toContain(
      '(allow file-write* (subpath "/Users/example-user/profile-a"))',
    );
    expect(roProfile).toContain('(allow file-write* (subpath "/Users/example-user/home-a"))');
    const denyWsRule = '(deny file-write* (subpath "/Users/example-user/space-a"))';
    const allowSockRule =
      '(allow file-read* file-write* (literal "/Users/example-user/space-a/mcp.sock"))';
    const denyControlRule =
      '(deny file-read* file-write* (literal "/Users/example-user/state/control/api.sock") (subpath "/Users/example-user/state/control/api.sock"))';
    expect(roProfile).toContain(denyWsRule);
    expect(roProfile).toContain(allowSockRule);
    expect(roProfile).toContain(denyControlRule);
    // SBPL is last-match-wins: explicit socket allow must follow workspace-readonly deny and precede denyPaths.
    expect(roProfile.indexOf(allowSockRule)).toBeGreaterThan(roProfile.indexOf(denyWsRule));
    expect(roProfile.indexOf(denyControlRule)).toBeGreaterThan(
      roProfile.indexOf(allowSockRule),
    );
    expect(roProfile).toContain('(deny network*)');
    expect(roProfile).toContain(
      '(allow network-outbound (remote unix-socket (path-literal "/Users/example-user/space-a/mcp.sock")))',
    );

    const strictProfile = buildSeatbeltProfile({
      profile: 'workspace-strict',
      workspace: '/Users/example-user/space-a',
      unixSockets: [
        {
          hostPath: '/Users/example-user/space-a/mcp.sock',
          mountPath: '/Users/example-user/space-a/mcp.sock',
        },
      ],
      network: 'allow',
    });
    expect(strictProfile).toContain(
      '(allow file-write* (subpath "/Users/example-user/space-a"))',
    );
    expect(strictProfile).not.toContain(
      '(deny file-write* (subpath "/Users/example-user/space-a"))',
    );
    expect(strictProfile).not.toContain('(deny network*)');

    // Negative control: remapping mountPath !== hostPath is unsupported by macOS Seatbelt and fails closed.
    expect(() =>
      buildSeatbeltProfile({
        profile: 'workspace-strict',
        workspace: '/Users/example-user/space-a',
        unixSockets: [
          {
            hostPath: '/Users/example-user/host.sock',
            mountPath: '/Users/example-user/remapped.sock',
          },
        ],
      }),
    ).toThrow(/cannot remap Unix socket mountPath/);
  });

  test('refuses symlink writableDirs and privateTmpDir that resolve into workspace under workspace-readonly, and cancels aborted probes promptly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sk-proc-sandbox-symlink-'));
    try {
      const workspace = join(root, 'workspace');
      const otherDir = join(root, 'other');
      const linkToWs = join(root, 'escape-link');
      const linkToOther = join(root, 'safe-link');
      await mkdir(workspace, { recursive: true });
      await mkdir(otherDir, { recursive: true });
      await symlink(workspace, linkToWs);
      await symlink(otherDir, linkToOther);

      expect(() =>
        ProcessSandboxSpecSchema.parse({
          profile: 'workspace-readonly',
          workspace,
          writableDirs: [linkToWs],
        }),
      ).toThrow(/overlap workspace/);
      expect(() =>
        ProcessSandboxSpecSchema.parse({
          profile: 'workspace-readonly',
          workspace,
          writableDirs: [join(linkToWs, 'future-child')],
        }),
      ).toThrow(/overlap workspace/);
      expect(() =>
        ProcessSandboxSpecSchema.parse({
          profile: 'workspace-readonly',
          workspace,
          privateTmpDir: linkToWs,
        }),
      ).toThrow(/overlap workspace/);
      expect(() =>
        ProcessSandboxSpecSchema.parse({
          profile: 'workspace-readonly',
          workspace,
          homeDir: linkToWs,
        }),
      ).toThrow(/overlap workspace/);

      // Positive control: symlink resolving outside workspace is accepted.
      expect(
        ProcessSandboxSpecSchema.parse({
          profile: 'workspace-readonly',
          workspace,
          writableDirs: [linkToOther],
        }).writableDirs,
      ).toEqual([linkToOther]);

      // Aborted signal rejects with the abort reason rather than misreporting SANDBOX_UNAVAILABLE.
      const controller = new AbortController();
      const abortMarker = new Error('probe-cancelled');
      controller.abort(abortMarker);
      await expect(
        probeProcessSandbox({ platform: 'linux', signal: controller.signal }),
      ).rejects.toBe(abortMarker);
      const sandbox = createProcessSandbox(
        { profile: 'workspace-strict', workspace },
        { platform: 'linux' },
      );
      await expect(
        sandbox.wrapCommand({
          executable: '/bin/true',
          args: [],
          cwd: workspace,
          env: {},
          signal: controller.signal,
        }),
      ).rejects.toBe(abortMarker);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('prevents ancestor homeDir tmpfs from hiding workspace in workspace-strict and forbids homeDir overlapping workspace in workspace-readonly', () => {
    // 1. workspace-readonly refuses homeDir ancestor, equal, or descendant of workspace.
    for (const badHome of ['/srv/tenant', '/srv/tenant/ws', '/srv/tenant/ws/home']) {
      expect(() =>
        ProcessSandboxSpecSchema.parse({
          profile: 'workspace-readonly',
          workspace: '/srv/tenant/ws',
          homeDir: badHome,
        }),
      ).toThrow(/homeDir must not overlap workspace/);
      expect(() =>
        buildLinuxBubblewrapArgs(
          {
            profile: 'workspace-readonly',
            workspace: '/srv/tenant/ws',
            homeDir: badHome,
          },
          { executable: '/bin/true', args: [], cwd: '/srv/tenant/ws', env: {} },
        ),
      ).toThrow(/homeDir must not overlap workspace/);
    }

    // 2. workspace-strict mounts --tmpfs homeDir BEFORE --bind workspace so workspace is never masked.
    const strictArgs = buildLinuxBubblewrapArgs(
      {
        profile: 'workspace-strict',
        workspace: '/srv/tenant/ws',
        homeDir: '/srv/tenant',
      },
      { executable: '/bin/true', args: [], cwd: '/srv/tenant/ws', env: {} },
    );
    const homeTmpfsIdx = strictArgs.indexOf('/srv/tenant');
    const wsBindIdx = strictArgs.indexOf('/srv/tenant/ws');
    expect(homeTmpfsIdx).toBeGreaterThan(0);
    expect(strictArgs[homeTmpfsIdx - 1]).toBe('--tmpfs');
    expect(wsBindIdx).toBeGreaterThan(homeTmpfsIdx);
    expect(strictArgs[wsBindIdx - 1]).toBe('--bind');

    // 3. workspace-readonly with non-overlapping workspace still mounts ancestor homeDir BEFORE child readOnlyPaths/writableDirs.
    const roWithChildBind = buildLinuxBubblewrapArgs(
      {
        profile: 'workspace-readonly',
        workspace: '/srv/other-ws',
        homeDir: '/srv/tenant',
        readOnlyPaths: ['/srv/tenant/bin'],
      },
      { executable: '/bin/true', args: [], cwd: '/srv/other-ws', env: {} },
    );
    const roHomeIdx = roWithChildBind.indexOf('/srv/tenant');
    const roBinIdx = roWithChildBind.indexOf('/srv/tenant/bin');
    expect(roHomeIdx).toBeGreaterThan(0);
    expect(roWithChildBind[roHomeIdx - 1]).toBe('--tmpfs');
    expect(roBinIdx).toBeGreaterThan(roHomeIdx);
    expect(roWithChildBind[roBinIdx - 1]).toBe('--ro-bind');

    // 4. homeDir '/' never emits '--tmpfs /' that would clobber system mounts.
    const rootHomeArgs = buildLinuxBubblewrapArgs(
      {
        profile: 'workspace-strict',
        workspace: '/srv/ws',
        homeDir: '/',
      },
      { executable: '/bin/true', args: [], cwd: '/srv/ws', env: {} },
    );
    const hasRootTmpfs = rootHomeArgs.some(
      (arg, idx) => arg === '--tmpfs' && rootHomeArgs[idx + 1] === '/',
    );
    expect(hasRootTmpfs).toBe(false);
  });

  describe.skipIf(!bwrapSupported)('real Linux Bubblewrap isolation', () => {
    test('workspace-strict preserves real workspace path and streaming stdio while hiding sibling space, control socket, host secrets and unallowed env', async () => {
      const root = await mkdtemp(join(tmpdir(), 'sk-proc-sandbox-'));
      const spaceA = join(root, 'space-a');
      const spaceB = join(root, 'space-b');
      const profileDir = join(root, 'profile');
      const controlDir = join(root, 'control');
      const insideDenySock = join(spaceA, 'hidden.sock');
      const controlSock = join(controlDir, 'api.sock');
      const mcpSock = join(root, 'space-a-mcp.sock');
      const hiddenServer = createServer();
      const controlServer = createServer();
      const mcpServer = createServer((socket) => {
        socket.end('MCP_PONG\n');
      });

      try {
        await mkdir(spaceA, { recursive: true });
        await mkdir(spaceB, { recursive: true });
        await mkdir(profileDir, { recursive: true });
        await mkdir(controlDir, { recursive: true });
        await writeFile(join(spaceB, 'secret.txt'), 'SIBLING_SECRET');
        await listenUnixSocket(hiddenServer, insideDenySock);
        await listenUnixSocket(controlServer, controlSock);
        await listenUnixSocket(mcpServer, mcpSock);

        const sandbox = createProcessSandbox({
          profile: 'workspace-strict',
          workspace: spaceA,
          writableDirs: [profileDir],
          readOnlyPaths: [dirname(process.execPath)],
          denyPaths: [insideDenySock, controlSock],
          unixSockets: [{ hostPath: mcpSock }],
          envAllowlist: ['ALLOWED_VAR', 'PATH'],
          homeDir: profileDir,
          network: 'deny',
        });

        const probe = await sandbox.probe();
        expect(probe).toEqual({
          available: true,
          backend: 'bwrap',
          executable: '/usr/bin/bwrap',
        });

        const checkScript = [
          'import { existsSync, writeFileSync, statSync } from "node:fs";',
          'import { createConnection } from "node:net";',
          'writeFileSync("created.txt", "ok");',
          'writeFileSync(process.env.HOME + "/profile.txt", "p-ok");',
          'const mcpReply = await new Promise((resolve) => {',
          '  const s = createConnection(process.argv[4]); let data = "";',
          '  s.on("data", (c) => { data += c.toString(); });',
          '  s.on("end", () => resolve(data.trim())); s.on("error", (e) => resolve("ERR:" + e.code));',
          '});',
          'console.log(JSON.stringify({ cwd: process.cwd(), home: process.env.HOME,',
          '  allowed: process.env.ALLOWED_VAR ?? null, leaked: process.env.HOST_SECRET ?? null,',
          '  siblingVisible: existsSync(process.argv[1]), controlVisible: existsSync(process.argv[2]),',
          '  hiddenIsSock: statSync(process.argv[3]).isSocket(), mcpReply }));',
        ].join('\n');

        const wrapped = await sandbox.wrapCommand({
          executable: process.execPath,
          args: [
            '-e',
            checkScript,
            join(spaceB, 'secret.txt'),
            controlSock,
            insideDenySock,
            mcpSock,
          ],
          cwd: spaceA,
          env: {
            PATH: '/usr/bin:/bin',
            ALLOWED_VAR: 'yes',
            HOST_SECRET: 'must-not-leak',
          },
        });

        const res = await runWrapped(wrapped);
        expect(res.exitCode).toBe(0);
        const report = JSON.parse(new TextDecoder().decode(res.stdout).trim()) as Record<
          string,
          unknown
        >;
        expect(report).toEqual({
          cwd: spaceA,
          home: profileDir,
          allowed: 'yes',
          leaked: null,
          siblingVisible: false,
          controlVisible: false,
          hiddenIsSock: false,
          mcpReply: 'MCP_PONG',
        });
        expect(await readFile(join(spaceA, 'created.txt'), 'utf8')).toBe('ok');
        expect(await readFile(join(profileDir, 'profile.txt'), 'utf8')).toBe('p-ok');
      } finally {
        hiddenServer.close();
        controlServer.close();
        mcpServer.close();
        await rm(root, { recursive: true, force: true });
      }
    });

    test('workspace-readonly permits reading workspace and writing writableDirs while refusing writes to workspace', async () => {
      const root = await mkdtemp(join(tmpdir(), 'sk-proc-sandbox-ro-'));
      const workspace = join(root, 'ws');
      const profileDir = join(root, 'profile');
      try {
        await mkdir(workspace, { recursive: true });
        await mkdir(profileDir, { recursive: true });
        await writeFile(join(workspace, 'readme.txt'), 'READ_ONLY_CONTENT');

        const sandbox = createProcessSandbox({
          profile: 'workspace-readonly',
          workspace,
          writableDirs: [profileDir],
          homeDir: profileDir,
          network: 'deny',
        });

        const wrapped = await sandbox.wrapCommand({
          executable: '/bin/sh',
          args: [
            '-c',
            'cat readme.txt && echo profile-ok > "$HOME/state.txt" && (echo fail > mutated.txt 2>/dev/null && exit 0 || exit 42)',
          ],
          cwd: workspace,
          env: { PATH: '/usr/bin:/bin' },
        });

        const res = await runWrapped(wrapped);
        expect(res.exitCode).toBe(42);
        expect(new TextDecoder().decode(res.stdout).trim()).toBe('READ_ONLY_CONTENT');
        expect(await readFile(join(profileDir, 'state.txt'), 'utf8')).toContain('profile-ok');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test('bind-mounts privateTmpDir, masks denyPaths under /bin, and falls back to workspace when cwd is outside mounted roots', async () => {
      const root = await mkdtemp(join(tmpdir(), 'sk-proc-sandbox-tmp-'));
      const workspace = join(root, 'ws');
      const privateTmp = join(root, 'priv-tmp');
      const unmountedHostDir = join(root, 'outside-host-dir');
      try {
        await mkdir(workspace, { recursive: true });
        await mkdir(privateTmp, { recursive: true });
        await mkdir(unmountedHostDir, { recursive: true });

        const sandbox = createProcessSandbox({
          profile: 'workspace-readonly',
          workspace,
          privateTmpDir: privateTmp,
          denyPaths: ['/bin/true'],
          network: 'deny',
        });

        const wrapped = await sandbox.wrapCommand({
          executable: '/bin/sh',
          args: [
            '-c',
            'pwd && echo tmp-ok > "$TMPDIR/out.txt" && [ ! -s /bin/true ] && echo masked-ok',
          ],
          cwd: unmountedHostDir,
          env: { PATH: '/usr/bin:/bin' },
        });
        expect(wrapped.args).toContain('--bind');
        expect(wrapped.args).toContain(privateTmp);
        expect(wrapped.args).toContain('/dev/null');
        expect(wrapped.args).toContain('/bin/true');
        expect(wrapped.cwd).toBe(workspace);

        const res = await runWrapped(wrapped);
        expect(res.exitCode, new TextDecoder().decode(res.stderr)).toBe(0);
        const lines = new TextDecoder().decode(res.stdout).trim().split('\n');
        expect(lines).toEqual([workspace, 'masked-ok']);
        expect((await readFile(join(privateTmp, 'out.txt'), 'utf8')).trim()).toBe('tmp-ok');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test('mounts ancestor homeDir tmpfs before workspace so workspace stays visible while host siblings stay hidden', async () => {
      const root = await mkdtemp(join(tmpdir(), 'sk-proc-sandbox-home-ancestor-'));
      const tenantHome = join(root, 'tenant');
      const workspace = join(tenantHome, 'ws');
      const hostSibling = join(tenantHome, 'host-secret.txt');
      try {
        await mkdir(workspace, { recursive: true });
        await writeFile(join(workspace, 'data.txt'), 'WS_VISIBLE\n');
        await writeFile(hostSibling, 'HIDDEN_SIBLING');

        const sandbox = createProcessSandbox({
          profile: 'workspace-strict',
          workspace,
          homeDir: tenantHome,
          network: 'deny',
        });

        const wrapped = await sandbox.wrapCommand({
          executable: '/bin/sh',
          args: [
            '-c',
            `cat data.txt && echo home-ok > "$HOME/ephemeral.txt" && echo ws-ok > written.txt && [ ! -e "${hostSibling}" ] && echo sibling-hidden`,
          ],
          cwd: workspace,
          env: { PATH: '/usr/bin:/bin' },
        });
        const res = await runWrapped(wrapped);
        expect(res.exitCode, new TextDecoder().decode(res.stderr)).toBe(0);
        const lines = new TextDecoder().decode(res.stdout).trim().split('\n');
        expect(lines).toEqual(['WS_VISIBLE', 'sibling-hidden']);
        expect((await readFile(join(workspace, 'written.txt'), 'utf8')).trim()).toBe('ws-ok');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe.skipIf(!seatbeltSupported)('real macOS Seatbelt read-only isolation', () => {
    test('workspace-readonly reads workspace and refuses writes to workspace under sandbox-exec', async () => {
      const root = await mkdtemp(join(tmpdir(), 'sk-seatbelt-ro-'));
      const workspace = join(root, 'ws');
      const profileDir = join(root, 'profile');
      try {
        await mkdir(workspace, { recursive: true });
        await mkdir(profileDir, { recursive: true });
        await writeFile(join(workspace, 'readme.txt'), 'MAC_RO_CONTENT');

        const sandbox = createProcessSandbox({
          profile: 'workspace-readonly',
          workspace,
          writableDirs: [profileDir],
          homeDir: profileDir,
          network: 'deny',
        });
        const wrapped = await sandbox.wrapCommand({
          executable: '/bin/sh',
          args: [
            '-c',
            'cat readme.txt && echo ok > "$HOME/state.txt" && (echo fail > mutated.txt 2>/dev/null && exit 0 || exit 42)',
          ],
          cwd: workspace,
          env: { PATH: '/usr/bin:/bin' },
        });
        const res = await runWrapped(wrapped);
        expect(res.exitCode).toBe(42);
        expect(new TextDecoder().decode(res.stdout).trim()).toBe('MAC_RO_CONTENT');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});
