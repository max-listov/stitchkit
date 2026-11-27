import { describe, expect, test } from 'bun:test';
import {
  readWorkOrigin,
  WORK_ORIGIN_ENV,
  WorkLaunchError,
  type WorkLaunchErrorReason,
  type WorkScopeLimits,
  type WorkScopePlacement,
} from '../src/entrypoints/service-host/work';
import { WORK_ROOT_FLAG, workRootEntry } from '../src/process/work-root';
import { workCommandWith } from '../src/service-host/work/command';
import { launchWorkWith } from '../src/service-host/work/launch';
import { probeWorkBoundaryWith } from '../src/service-host/work/probe';
import {
  callerSlice,
  classifyManagerFailure,
  parseSystemdVersion,
} from '../src/service-host/work/scope-command';
import { createFakeWorkHost } from './support/fake-work-host';

const owner = {
  launcher: 'agent-host',
  id: 'session-7',
  label: 'Session 100% %n $HOME',
  project: null,
  agent: null,
  parent: null,
};
const SERVICE_CGROUP = '0::/work.slice/work-agents.slice/agent-host.service\n';

/** A launcher running as root, as the system manager requires; a user-manager case sets `uid`. */
function scopeHost(overrides: Parameters<typeof createFakeWorkHost>[0] = {}) {
  const fake = createFakeWorkHost({ uid: 0, ...overrides });
  fake.state.files.set('/proc/self/cgroup', SERVICE_CGROUP);
  return fake;
}

async function reasonOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    if (error instanceof WorkLaunchError) return error.reason;
    throw error;
  }
  throw new Error('Expected a WorkLaunchError');
}

function placed(placement: WorkScopePlacement, host = scopeHost().host) {
  return workCommandWith(host, {
    owner,
    placement,
    executable: '/bin/sh',
    args: ['-c', 'echo $$ "$1"', 'sh', '$HOME'],
    env: { PATH: '/usr/bin:/bin' },
  });
}

describe('service-host/work scope command', () => {
  test('a scope command passes every argument unexpanded and names its unit', async () => {
    const command = await placed({
      kind: 'transient-scope',
      manager: 'system',
      slice: 'caller',
    });
    expect(command.executable).toBe('/usr/bin/systemd-run');
    expect(command.args).toEqual([
      '--scope',
      '--quiet',
      '--collect',
      '--expand-environment=no',
      '--unit=agent-host-session-7.scope',
      '--description=Session 100% %n $HOME',
      '--slice=work-agents.slice',
      '--',
      '/bin/sh',
      '-c',
      'echo $$ "$1"',
      'sh',
      '$HOME',
    ]);
    expect(command.unit).toEqual({ manager: 'system', name: 'agent-host-session-7.scope' });
    expect(command.work).toEqual({ launcher: 'agent-host', id: 'session-7' });
    expect(command.env.PATH).toBe('/usr/bin:/bin');
    expect(readWorkOrigin(command.env)).toEqual({
      v: 1,
      work: command.work,
      boundary: {
        kind: 'transient-scope',
        manager: 'system',
        unit: 'agent-host-session-7.scope',
      },
    });
  });

  test("slice 'caller' keeps the caller's own slice and a named slice replaces it", async () => {
    const caller = await placed({
      kind: 'transient-scope',
      manager: 'system',
      slice: 'caller',
    });
    const named = await placed({
      kind: 'transient-scope',
      manager: 'system',
      slice: 'build.slice',
    });
    expect(caller.args).toContain('--slice=work-agents.slice');
    expect(named.args).toContain('--slice=build.slice');
    expect(named.args).not.toContain('--slice=work-agents.slice');

    // Each manager owns its own part of the path.
    const session = '/user.slice/user-1000.slice/user@1000.service/app.slice/term.scope';
    expect(callerSlice(session, 'user')).toBe('app.slice');
    expect(callerSlice(session, 'system')).toBe('user-1000.slice');
    expect(callerSlice('/work.slice/agent-host.service', 'user')).toBeNull();
    expect(callerSlice('/', 'system')).toBeNull();

    const rootless = scopeHost();
    rootless.state.files.set('/proc/self/cgroup', '0::/\n');
    expect(
      await reasonOf(
        placed({ kind: 'transient-scope', manager: 'system', slice: 'caller' }, rootless.host),
      ),
    ).toBe('slice-unresolvable');
    await expect(
      placed({ kind: 'transient-scope', manager: 'system', slice: 'no-suffix' }),
    ).rejects.toThrow();
  });

  const LIMITS: Array<[keyof WorkScopeLimits, WorkScopeLimits, string]> = [
    ['memoryMaxMb', { memoryMaxMb: 512 }, '--property=MemoryMax=512M'],
    ['memorySwapMaxMb', { memorySwapMaxMb: 0 }, '--property=MemorySwapMax=0M'],
    ['cpuQuotaPercent', { cpuQuotaPercent: 250 }, '--property=CPUQuota=250%'],
    ['cpuWeight', { cpuWeight: 50 }, '--property=CPUWeight=50'],
    ['runtimeMaxSeconds', { runtimeMaxSeconds: 900 }, '--property=RuntimeMaxSec=900'],
  ];
  test.each(LIMITS)(
    'scope limit %s becomes its own unit property',
    async (_name, limits, property) => {
      const base = { kind: 'transient-scope', manager: 'system', slice: 'caller' } as const;
      const without = await placed(base);
      const withLimit = await placed({ ...base, limits });
      expect(without.args.some((arg) => arg.startsWith('--property='))).toBe(false);
      expect(withLimit.args.filter((arg) => arg.startsWith('--property='))).toEqual([
        property,
      ]);
      // A property is an option of systemd-run, never an argument of the command.
      expect(withLimit.args.indexOf(property)).toBeLessThan(withLimit.args.indexOf('--'));
    },
  );

  test('a limit outside its range and an unknown limit are refused', async () => {
    const base = { kind: 'transient-scope', manager: 'system', slice: 'caller' } as const;
    for (const limits of [{ cpuWeight: 0 }, { cpuWeight: 10_001 }, { memoryMaxMb: 0 }])
      await expect(placed({ ...base, limits })).rejects.toThrow();
    await expect(
      workCommandWith(scopeHost().host, {
        owner,
        placement: { ...base, limits: { ioWeight: 5 } },
        executable: '/bin/true',
        env: {},
      } as never),
    ).rejects.toThrow();
  });

  test('the user manager is reached through the runtime directory the caller owns', async () => {
    const declared = scopeHost({ uid: 1000, env: { XDG_RUNTIME_DIR: '/run/user/1000' } });
    declared.state.files.set(
      '/proc/self/cgroup',
      '0::/user.slice/user-1000.slice/user@1000.service/app.slice/term.scope\n',
    );
    const command = await placed(
      { kind: 'transient-scope', manager: 'user', slice: 'caller' },
      declared.host,
    );
    expect(command.args.slice(0, 2)).toEqual(['--user', '--scope']);
    expect(command.args).toContain('--slice=app.slice');
    expect(command.env.XDG_RUNTIME_DIR).toBe('/run/user/1000');

    const derived = scopeHost({ uid: 1000 });
    derived.state.directories.set('/run/user/1000', 1000);
    const viaDirectory = await placed(
      { kind: 'transient-scope', manager: 'user', slice: 'build.slice' },
      derived.host,
    );
    expect(viaDirectory.env.XDG_RUNTIME_DIR).toBe('/run/user/1000');
    const system = await placed({
      kind: 'transient-scope',
      manager: 'system',
      slice: 'caller',
    });
    expect(system.args[0]).toBe('--scope');
    expect(system.env.XDG_RUNTIME_DIR).toBeUndefined();

    const foreign = scopeHost({ uid: 1000 });
    foreign.state.directories.set('/run/user/1000', 0);
    for (const host of [foreign.host, scopeHost({ uid: 1000 }).host])
      expect(
        await reasonOf(
          placed({ kind: 'transient-scope', manager: 'user', slice: 'build.slice' }, host),
        ),
      ).toBe('user-manager-unreachable');
  });

  test('a systemd older than 254, an absent one and another platform are refused by name', async () => {
    const placement = { kind: 'transient-scope', manager: 'system', slice: 'caller' } as const;
    const old = scopeHost();
    old.state.answer = () => ({ exitCode: 0, stdout: 'systemd 253 (253.5-1)\n', stderr: '' });
    expect(await reasonOf(placed(placement, old.host))).toBe('systemd-too-old');
    expect(old.state.commands).toEqual([
      { executable: '/usr/bin/systemd-run', args: ['--version'], env: {} },
    ]);
    const edge = scopeHost();
    edge.state.answer = () => ({ exitCode: 0, stdout: 'systemd 254\n', stderr: '' });
    expect((await placed(placement, edge.host)).args).toContain('--expand-environment=no');

    const absent = scopeHost();
    absent.state.answer = () => {
      throw new Error('spawn ENOENT');
    };
    expect(await reasonOf(placed(placement, absent.host))).toBe('systemd-unavailable');
    const silent = scopeHost();
    silent.state.answer = () => ({ exitCode: 0, stdout: 'unexpected', stderr: '' });
    expect(await reasonOf(placed(placement, silent.host))).toBe('systemd-unavailable');
    expect(await reasonOf(placed(placement, scopeHost({ platform: 'darwin' }).host))).toBe(
      'platform-unsupported',
    );
    expect(parseSystemdVersion('systemd 259 (259.9-0ubuntu0.1)\n+PAM')).toBe(259);
    expect(parseSystemdVersion('systemd-run 259')).toBeNull();
  });

  test('what systemd prints is classified into a named refusal', () => {
    const printed: Array<[string, 'system' | 'user', WorkLaunchErrorReason]> = [
      [
        "System has not been booted with systemd as init system (PID 1). Can't operate.",
        'system',
        'systemd-unavailable',
      ],
      [
        'Failed to connect to system scope bus via local transport: Host is down',
        'system',
        'manager-unreachable',
      ],
      [
        'Failed to connect to user scope bus via local transport: No such file or directory',
        'user',
        'user-manager-unreachable',
      ],
      [
        'Failed to start transient scope unit: Unit a-b.scope was already loaded or has a fragment file.',
        'system',
        'unit-exists',
      ],
      ['Failed to start transient scope unit: Invalid argument', 'system', 'scope-refused'],
    ];
    for (const [stderr, manager, reason] of printed)
      expect(classifyManagerFailure(stderr, manager)).toBe(reason);
  });

  test('a probe names an unreachable manager and a live unit refuses the launch before any spawn', async () => {
    const placement = { kind: 'transient-scope', manager: 'system', slice: 'caller' } as const;
    expect(await probeWorkBoundaryWith(scopeHost().host, placement)).toEqual({
      state: 'available',
    });

    const down = scopeHost();
    down.state.answer = (_executable, args) =>
      args.includes('--version')
        ? { exitCode: 0, stdout: 'systemd 259\n', stderr: '' }
        : {
            exitCode: 1,
            stdout: '',
            stderr: 'Failed to connect to system scope bus via local transport: Host is down',
          };
    const unreachable = await probeWorkBoundaryWith(down.host, placement);
    expect(unreachable.state).toBe('unavailable');
    if (unreachable.state === 'unavailable') {
      expect(unreachable.reason).toBe('manager-unreachable');
      expect(unreachable.cause).toBeInstanceOf(WorkLaunchError);
    }

    const taken = scopeHost();
    taken.state.answer = (_executable, args) => {
      if (args.includes('--version'))
        return { exitCode: 0, stdout: 'systemd 259\n', stderr: '' };
      if (args.includes('--property=LoadState'))
        return { exitCode: 0, stdout: 'loaded\n', stderr: '' };
      return { exitCode: 0, stdout: '259\n', stderr: '' };
    };
    expect(
      await reasonOf(
        launchWorkWith(taken.host, {
          owner,
          placement,
          command: { executable: '/bin/true', timeoutMs: 1000 },
        }),
      ),
    ).toBe('unit-exists');
    // The refusal came from the manager's answer: nothing but manager queries ran.
    expect(taken.state.commands.map((command) => command.executable)).toEqual([
      '/usr/bin/systemd-run',
      '/usr/bin/systemctl',
      '/usr/bin/systemctl',
    ]);
    expect(taken.state.commands.at(-1)?.args).toEqual([
      'show',
      '--no-pager',
      '--property=LoadState',
      '--value',
      '--',
      'agent-host-session-7.scope',
    ]);
  });

  test('placement kind decides the wrapper: a process root is the package entry, not systemd', async () => {
    const fake = scopeHost();
    const root = await workCommandWith(fake.host, {
      owner,
      placement: { kind: 'process-root' },
      executable: '/bin/sleep',
      args: ['5'],
      env: { PATH: '/usr/bin' },
    });
    expect(root.executable).toBe(process.execPath);
    expect(root.args).toEqual([
      workRootEntry(),
      WORK_ROOT_FLAG,
      WORK_ORIGIN_ENV,
      JSON.stringify({ v: 1, work: { launcher: 'agent-host', id: 'session-7' } }),
      '--',
      '/bin/sleep',
      '5',
    ]);
    expect(root.unit).toBeNull();
    // The root writes the variable itself, once it knows its own instance.
    expect(root.env).toEqual({ PATH: '/usr/bin' });
    expect(fake.state.commands).toEqual([]);

    const scope = await placed({
      kind: 'transient-scope',
      manager: 'system',
      slice: 'caller',
    });
    expect(scope.executable).toBe('/usr/bin/systemd-run');

    for (const host of [
      scopeHost({ platform: 'win32' }).host,
      scopeHost({ canReplaceProcess: false }).host,
    ]) {
      expect(
        await reasonOf(
          workCommandWith(host, {
            owner,
            placement: { kind: 'process-root' },
            executable: '/bin/true',
            env: {},
          }),
        ),
      ).toBe('platform-unsupported');
      const probe = await probeWorkBoundaryWith(host, { kind: 'process-root' });
      expect(probe.state === 'unavailable' && probe.reason).toBe('platform-unsupported');
    }
  });

  test('the system manager refuses a non-root caller before anything is spawned, the user manager does not', async () => {
    const caller = scopeHost({ uid: 1000, env: { XDG_RUNTIME_DIR: '/run/user/1000' } });
    const system = {
      kind: 'transient-scope',
      manager: 'system',
      slice: 'build.slice',
    } as const;
    expect(await reasonOf(placed(system, caller.host))).toBe('manager-unauthorized');
    const probe = await probeWorkBoundaryWith(caller.host, system);
    expect(probe.state === 'unavailable' && probe.reason).toBe('manager-unauthorized');
    expect(
      caller.state.commands.some(
        (c) => c.executable === '/usr/bin/systemd-run' && !c.args.includes('--version'),
      ),
    ).toBe(false);
    // Negative control: the same caller on its own manager, and root on the system manager.
    expect(
      (await placed({ ...system, manager: 'user' }, caller.host)).args.slice(0, 2),
    ).toEqual(['--user', '--scope']);
    expect((await placed(system, scopeHost().host)).args[0]).toBe('--scope');
  });

  test("manager 'user' and 'system' address different managers in every command", async () => {
    const fake = scopeHost({ uid: 1000, env: { XDG_RUNTIME_DIR: '/run/user/1000' } });
    await probeWorkBoundaryWith(fake.host, {
      kind: 'transient-scope',
      manager: 'user',
      slice: 'build.slice',
    });
    const userQuery = fake.state.commands.find((c) => c.executable === '/usr/bin/systemctl');
    expect(userQuery?.args[0]).toBe('--user');
    expect(userQuery?.env).toEqual({ XDG_RUNTIME_DIR: '/run/user/1000' });

    const system = scopeHost({ env: { XDG_RUNTIME_DIR: '/run/user/1000' } });
    await probeWorkBoundaryWith(system.host, {
      kind: 'transient-scope',
      manager: 'system',
      slice: 'build.slice',
    });
    const systemQuery = system.state.commands.find(
      (c) => c.executable === '/usr/bin/systemctl',
    );
    expect(systemQuery?.args[0]).toBe('show');
    expect(systemQuery?.env).toEqual({});
  });
});
