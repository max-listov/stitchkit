import { describe, expect, test } from 'bun:test';
import { WORK_ORIGIN_ENV, WorkLaunchError } from '../src/entrypoints/service-host/work';
import { parseLinuxLineage, parsePsLineage } from '../src/service-host/work/host';
import {
  checkWorkMembershipWith,
  inheritedWorkWith,
} from '../src/service-host/work/membership';
import { encodeWorkOrigin } from '../src/service-host/work/origin';
import { createFakeWorkHost, FAKE_INSTANCE } from './support/fake-work-host';

const UNIT = 'agent-host-session-7.scope';
const scope = { kind: 'transient-scope', manager: 'system', unit: UNIT } as const;
const ROOT = 500;
const root = { kind: 'process-root', root: { pid: ROOT, instance: FAKE_INSTANCE } } as const;
const OTHER_INSTANCE = { ...FAKE_INSTANCE, startId: '999' };

describe('service-host/work membership in a transient scope', () => {
  test('the unit as a path component is membership, in the scope or a sub-group below it', async () => {
    const { host, state } = createFakeWorkHost();
    state.processes.set(10, { cgroup: `0::/work.slice/${UNIT}\n` });
    state.processes.set(11, { cgroup: `0::/work.slice/${UNIT}/payload/worker\n` });
    // A reader inside its own cgroup namespace sees the path from its root.
    state.processes.set(12, { cgroup: `0::/${UNIT}\n` });
    for (const pid of [10, 11, 12])
      expect(await checkWorkMembershipWith(host, { pid, boundary: scope })).toEqual({
        state: 'member',
        via: 'cgroup',
      });
  });

  test('another scope, a longer name and the launcher own service are outside', async () => {
    const { host, state } = createFakeWorkHost();
    const outside = [
      '/work.slice/agent-host.service',
      '/work.slice/agent-host-session-8.scope',
      `/work.slice/x-${UNIT}`,
      `/work.slice/${UNIT}.d`,
    ];
    for (const [index, cgroup] of outside.entries()) {
      state.processes.set(20 + index, { cgroup: `0::${cgroup}\n` });
      expect(
        await checkWorkMembershipWith(host, { pid: 20 + index, boundary: scope }),
      ).toEqual({
        state: 'outside',
        observed: { cgroup },
      });
    }
  });

  test('an ended, unreaped process is gone, not outside the scope it was removed with', async () => {
    const { host, state } = createFakeWorkHost();
    state.processes.set(40, { cgroup: `0::/work.slice/${UNIT} (deleted)\n`, ended: true });
    expect(await checkWorkMembershipWith(host, { pid: 40, boundary: scope })).toEqual({
      state: 'gone',
    });
    // Negative control: the same entry while the process runs is read as observed.
    state.processes.set(41, { cgroup: '0::/work.slice/other.scope\n' });
    expect(await checkWorkMembershipWith(host, { pid: 41, boundary: scope })).toEqual({
      state: 'outside',
      observed: { cgroup: '/work.slice/other.scope' },
    });
  });

  test('a hidden live process is unavailable, an absent one is gone, never the reverse', async () => {
    const { host, state } = createFakeWorkHost();
    state.processes.set(30, { cgroup: null });
    const hidden = await checkWorkMembershipWith(host, { pid: 30, boundary: scope });
    expect(hidden.state === 'unavailable' && hidden.reason).toBe('proc-unreadable');
    expect(await checkWorkMembershipWith(host, { pid: 31, boundary: scope })).toEqual({
      state: 'gone',
    });

    state.processes.set(32, { cgroup: '12:memory:/legacy\n1:name=systemd:/legacy\n' });
    const legacy = await checkWorkMembershipWith(host, { pid: 32, boundary: scope });
    expect(legacy.state === 'unavailable' && legacy.reason).toBe('cgroup-v2-required');

    const denied = createFakeWorkHost();
    denied.host.readText = async () => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    };
    const refused = await checkWorkMembershipWith(denied.host, { pid: 33, boundary: scope });
    expect(refused.state === 'unavailable' && refused.reason).toBe('proc-unreadable');

    const mac = createFakeWorkHost({ platform: 'darwin' });
    const unsupported = await checkWorkMembershipWith(mac.host, { pid: 34, boundary: scope });
    expect(unsupported.state === 'unavailable' && unsupported.reason).toBe(
      'platform-unsupported',
    );
    await expect(checkWorkMembershipWith(host, { pid: 0, boundary: scope })).rejects.toThrow();
  });
});

describe('service-host/work membership under a process root', () => {
  function tree() {
    const fake = createFakeWorkHost();
    const { processes } = fake.state;
    processes.set(1, { lineage: { ppid: 0, pgid: 1 } });
    processes.set(400, { lineage: { ppid: 1, pgid: 400 } });
    processes.set(ROOT, { lineage: { ppid: 400, pgid: ROOT }, instance: FAKE_INSTANCE });
    processes.set(501, { lineage: { ppid: ROOT, pgid: ROOT } });
    processes.set(502, { lineage: { ppid: 501, pgid: ROOT } });
    // Left the group with its own session; its parent chain still reaches the root.
    processes.set(503, { lineage: { ppid: 502, pgid: 503 } });
    // Left the group and lost its parent: nothing ties it to the root any more.
    processes.set(504, { lineage: { ppid: 1, pgid: 504 } });
    // Inherited the variable, started by the launcher itself, outside the root.
    processes.set(600, { lineage: { ppid: 400, pgid: 400 } });
    return fake;
  }

  test('the root, its group and its descendants are members, each by its own evidence', async () => {
    const { host } = tree();
    const check = (pid: number) => checkWorkMembershipWith(host, { pid, boundary: root });
    expect(await check(ROOT)).toEqual({ state: 'member', via: 'root' });
    expect(await check(501)).toEqual({ state: 'member', via: 'process-group' });
    expect(await check(502)).toEqual({ state: 'member', via: 'process-group' });
    expect(await check(503)).toEqual({ state: 'member', via: 'ancestry' });
  });

  test('a process outside the root is outside with what was observed', async () => {
    const { host } = tree();
    expect(await checkWorkMembershipWith(host, { pid: 600, boundary: root })).toEqual({
      state: 'outside',
      observed: { pgid: 400, ancestors: [400] },
    });
    // The documented limit of a process root: a reparented session leader is lost.
    expect(await checkWorkMembershipWith(host, { pid: 504, boundary: root })).toEqual({
      state: 'outside',
      observed: { pgid: 504, ancestors: [] },
    });
    expect(await checkWorkMembershipWith(host, { pid: 700, boundary: root })).toEqual({
      state: 'gone',
    });
  });

  test('a reused root pid proves nothing, and a dead root keeps only its group', async () => {
    const reused = tree();
    reused.state.processes.set(ROOT, {
      lineage: { ppid: 1, pgid: ROOT },
      instance: OTHER_INSTANCE,
    });
    for (const pid of [ROOT, 501, 503]) {
      const answer = await checkWorkMembershipWith(reused.host, { pid, boundary: root });
      expect(answer.state).toBe('outside');
    }

    const dead = tree();
    dead.state.processes.delete(ROOT);
    dead.state.processes.set(503, { lineage: { ppid: 1, pgid: 503 } });
    const check = (pid: number) => checkWorkMembershipWith(dead.host, { pid, boundary: root });
    expect(await check(ROOT)).toEqual({ state: 'gone' });
    expect(await check(501)).toEqual({ state: 'member', via: 'process-group' });
    expect((await check(503)).state).toBe('outside');
  });

  test('an unobservable live root and a failing process table are unavailable', async () => {
    const blind = tree();
    blind.state.processes.set(ROOT, { lineage: { ppid: 400, pgid: ROOT } });
    const unobservable = await checkWorkMembershipWith(blind.host, {
      pid: 501,
      boundary: root,
    });
    expect(unobservable.state === 'unavailable' && unobservable.reason).toBe(
      'root-unobservable',
    );

    const broken = tree();
    broken.host.lineage = async () => {
      throw new Error('ps failed');
    };
    const failed = await checkWorkMembershipWith(broken.host, { pid: 501, boundary: root });
    expect(failed.state === 'unavailable' && failed.reason).toBe('process-table-failed');

    const other = tree();
    other.state.platform = 'win32';
    const unsupported = await checkWorkMembershipWith(other.host, {
      pid: 501,
      boundary: root,
    });
    expect(unsupported.state === 'unavailable' && unsupported.reason).toBe(
      'platform-unsupported',
    );
  });

  test('process table lines are read past a command name with spaces and parentheses', () => {
    expect(parseLinuxLineage('501 (a (b) c) S 500 499 498 0 -1 4194304')).toEqual({
      ppid: 500,
      pgid: 499,
    });
    expect(parseLinuxLineage('501 no-name S')).toBeNull();
    expect(parsePsLineage('  500   499\n')).toEqual({ ppid: 500, pgid: 499 });
    expect(parsePsLineage('')).toBeNull();
  });
});

describe('service-host/work inherited work', () => {
  const origin = encodeWorkOrigin({
    v: 1,
    work: { launcher: 'agent-host', id: 'session-7' },
    boundary: scope,
  });

  test('the variable names the work only for a process inside the boundary', async () => {
    const { host, state } = createFakeWorkHost({ env: { [WORK_ORIGIN_ENV]: origin } });
    state.processes.set(40, { cgroup: `0::/work.slice/${UNIT}\n` });
    state.processes.set(41, { cgroup: '0::/work.slice/agent-host.service\n' });
    expect(await inheritedWorkWith(host, 40)).toEqual({
      launcher: 'agent-host',
      id: 'session-7',
    });
    // Same variable, outside the scope: the claim is not believed.
    expect(await inheritedWorkWith(host, 41)).toBeNull();
    expect(await inheritedWorkWith(createFakeWorkHost().host, 40)).toBeNull();
  });

  test('an unanswerable boundary and an unreadable variable throw, they are not "no parent"', async () => {
    const hidden = createFakeWorkHost({ env: { [WORK_ORIGIN_ENV]: origin } });
    hidden.state.processes.set(42, { cgroup: null });
    const reasons: string[] = [];
    for (const run of [
      () => inheritedWorkWith(hidden.host, 42),
      () =>
        inheritedWorkWith(createFakeWorkHost({ env: { [WORK_ORIGIN_ENV]: '{' } }).host, 42),
    ]) {
      try {
        await run();
      } catch (error) {
        if (!(error instanceof WorkLaunchError)) throw error;
        reasons.push(error.reason);
      }
    }
    expect(reasons).toEqual(['membership-unavailable', 'origin-unreadable']);
  });
});
