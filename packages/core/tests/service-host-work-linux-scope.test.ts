import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  checkWorkMembership,
  inheritedWork,
  launchWork,
  probeWorkBoundary,
  readWorkOrigin,
  WORK_ORIGIN_ENV,
  WorkLaunchError,
  type WorkScopePlacement,
  workCommand,
  workUnitName,
} from '../src/entrypoints/service-host/work';
import { probeLiveness } from '../src/internal/process-identity';
import { runNativeCommand } from '../src/process/command';
import { parseLinuxLineage } from '../src/service-host/work/host';
import { encodeWorkOrigin } from '../src/service-host/work/origin';
import { reapAfterEachTest, trackGroupLeader, trackWorkScope } from './support/process-reaper';
import { until } from './support/until';
import {
  createWorkPayload,
  removeWorkDirectories,
  TREE_MEMBERS,
} from './support/work-payload';

reapAfterEachTest();
afterEach(removeWorkDirectories);

const SYSTEM: WorkScopePlacement = {
  kind: 'transient-scope',
  manager: 'system',
  slice: 'caller',
};
// The test runner lives outside any user manager, so the user scope names its slice.
const USER: WorkScopePlacement = {
  kind: 'transient-scope',
  manager: 'user',
  slice: 'app.slice',
};

const available = {
  system: await probeWorkBoundary(SYSTEM),
  user: await probeWorkBoundary(USER),
};
/** A host that must have a working scope (CI) turns an unavailable one into a failure. */
const REQUIRED = process.env.STITCHKIT_REQUIRE_SYSTEMD_SCOPE === '1';

let sequence = 0;
function owner(manager: 'system' | 'user') {
  sequence += 1;
  const id = `p${process.pid}-${sequence}`;
  trackWorkScope({ manager, name: `stitchkit-test-${id}.scope` });
  return {
    launcher: 'stitchkit-test',
    id,
    label: 'Work boundary test 100% %n $HOME',
    project: 'example/app',
    agent: { harness: 'Example Harness', model: 'example-1', address: 'node:main' },
    parent: null,
  };
}

function systemctl(args: string[], env: Record<string, string> = {}) {
  return runNativeCommand({
    executable: '/usr/bin/systemctl',
    args,
    env: { PATH: '/usr/bin:/bin', ...env },
    capture: true,
    maxOutputBytes: 65_536,
    timeoutMs: 20_000,
    onLeaderStarted: trackGroupLeader,
  }).then((result) => ({
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout).trim(),
  }));
}

const lineage = (pid: number) => parseLinuxLineage(readFileSync(`/proc/${pid}/stat`, 'utf8'));

describe('service-host/work transient scope on a real systemd', () => {
  test('this host answers the scope probe by name', () => {
    for (const answer of [available.system, available.user]) {
      if (answer.state === 'available') continue;
      expect([
        'platform-unsupported',
        'systemd-unavailable',
        'systemd-too-old',
        'manager-unreachable',
        'manager-unauthorized',
        'user-manager-unreachable',
        'slice-unresolvable',
      ]).toContain(answer.reason);
      expect(answer.cause).toBeInstanceOf(WorkLaunchError);
    }
    if (REQUIRED) expect(available.system).toEqual({ state: 'available' });
  });

  test.skipIf(available.system.state !== 'available')(
    'a process and its descendants launched in a scope belong to it, a process outside with the inherited variable does not',
    async () => {
      const payload = await createWorkPayload();
      const launch = await launchWork({
        owner: owner('system'),
        placement: SYSTEM,
        command: payload.command,
      });
      try {
        const { boundary } = launch.origin;
        expect(boundary).toEqual({
          kind: 'transient-scope',
          manager: 'system',
          unit: launch.unit?.name ?? '',
        });
        expect(await payload.pid('root')).toBe(launch.root.pid);
        const pids = new Map<string, number>();
        for (const member of TREE_MEMBERS) pids.set(member, await payload.pid(member));
        for (const [member, pid] of pids)
          expect([member, await checkWorkMembership({ pid, boundary })]).toEqual([
            member,
            { state: 'member', via: 'cgroup' },
          ]);

        // The control a process-group check fails: the detached descendant left the root's
        // group and session, and only the scope still holds it.
        const rootGroup = lineage(launch.root.pid)?.pgid;
        expect(lineage(pids.get('child') ?? 0)?.pgid).toBe(rootGroup);
        expect(lineage(pids.get('detached') ?? 0)?.pgid).toBe(pids.get('detached'));
        expect(lineage(pids.get('detached') ?? 0)?.pgid).not.toBe(rootGroup);

        // From inside, the variable is believed; the launcher itself carries none.
        expect(JSON.parse(await payload.text('inherited.json'))).toEqual(launch.origin.work);
        expect(readWorkOrigin()).toBeNull();
        expect(await inheritedWork()).toBeNull();

        // Outside the scope with the very same variable: named, not a member.
        const variable = { [WORK_ORIGIN_ENV]: encodeWorkOrigin(launch.origin) };
        const outside = Promise.withResolvers<number>();
        const stopOutside = new AbortController();
        const sleeper = runNativeCommand({
          executable: '/usr/bin/sleep',
          args: ['300'],
          env: variable,
          signal: stopOutside.signal,
          onLeaderStarted: (event) => {
            trackGroupLeader(event);
            outside.resolve(event.pid);
          },
        }).catch(() => undefined);
        const outsidePid = await outside.promise;
        expect(readFileSync(`/proc/${outsidePid}/environ`, 'utf8')).toContain(
          `${WORK_ORIGIN_ENV}=${variable[WORK_ORIGIN_ENV]}`,
        );
        const answer = await checkWorkMembership({ pid: outsidePid, boundary });
        expect(answer.state).toBe('outside');
        if (answer.state === 'outside')
          expect(answer.observed).toEqual({
            cgroup: readFileSync('/proc/self/cgroup', 'utf8').trim().slice(3),
          });
        stopOutside.abort();
        await sleeper;
        const claimed = await runNativeCommand({
          executable: process.execPath,
          args: [payload.inheritedScript],
          env: { ...variable, PATH: '/usr/bin:/bin' },
          capture: true,
          maxOutputBytes: 65_536,
          timeoutMs: 30_000,
          onLeaderStarted: trackGroupLeader,
        });
        expect(new TextDecoder().decode(claimed.stdout).trim()).toBe('null');
      } finally {
        await launch.stop();
      }
    },
    60_000,
  );

  test.skipIf(available.system.state !== 'available')(
    'a monitor names the owner of a process from its control group alone, and finds none for a process launched without the boundary',
    async () => {
      // What a monitor holds: each launcher's owner records, and a pid it knows nothing about.
      const records = [owner('system'), owner('system')];
      const ownerOf = (pid: number) => {
        const unit = readFileSync(`/proc/${pid}/cgroup`, 'utf8')
          .trim()
          .split('/')
          .find((part) => part.endsWith('.scope'));
        return records.find((record) => workUnitName(record) === unit) ?? null;
      };
      const payload = await createWorkPayload();
      const [first, second] = records;
      if (first === undefined || second === undefined) throw new Error('two records expected');
      const launch = await launchWork({
        owner: second,
        placement: SYSTEM,
        command: payload.command,
      });
      try {
        // Every process of the work — the detached one too — resolves to its record: the
        // launcher, the project and the agent that asked for it.
        for (const member of TREE_MEMBERS)
          expect([member, ownerOf(await payload.pid(member))]).toEqual([member, second]);
        expect(ownerOf(launch.root.pid)).toMatchObject({
          launcher: 'stitchkit-test',
          project: 'example/app',
          agent: { harness: 'Example Harness', model: 'example-1', address: 'node:main' },
        });

        // The state before the boundary: a command started the ordinary way sits in its
        // launcher's own control group, one line among all the others, with no owner to name.
        const plain = Promise.withResolvers<number>();
        const stopPlain = new AbortController();
        const sleeper = runNativeCommand({
          executable: '/usr/bin/sleep',
          args: ['300'],
          signal: stopPlain.signal,
          onLeaderStarted: (event) => {
            trackGroupLeader(event);
            plain.resolve(event.pid);
          },
        }).catch(() => undefined);
        const plainPid = await plain.promise;
        expect(readFileSync(`/proc/${plainPid}/cgroup`, 'utf8')).toBe(
          readFileSync('/proc/self/cgroup', 'utf8'),
        );
        expect(ownerOf(plainPid)).toBeNull();
        stopPlain.abort();
        await sleeper;
      } finally {
        await launch.stop();
      }
    },
    60_000,
  );

  test.skipIf(available.system.state !== 'available')(
    'an argument with a dollar sign reaches the scope command as written, and systemd-run rewrites it without the flag',
    async () => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal text is the subject.
      const argument = '$HOME ${PATH} $$ %n';
      const payload = await createWorkPayload(argument);
      const launch = await launchWork({
        owner: owner('system'),
        placement: SYSTEM,
        command: payload.command,
      });
      try {
        expect(await payload.text('arg')).toBe(argument);
      } finally {
        await launch.stop();
      }

      // Negative control: the same systemd-run line minus the one flag rewrites the arguments.
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal text is the subject.
      const braced = '${HOME}';
      const run = async (keepFlag: boolean) => {
        const placed = await workCommand({
          owner: owner('system'),
          placement: SYSTEM,
          executable: '/usr/bin/printf',
          args: ['[%s]', braced, '$$'],
          env: { PATH: '/usr/bin:/bin', HOME: '/expanded-home' },
        });
        expect(placed.args).toContain('--expand-environment=no');
        const result = await runNativeCommand({
          executable: placed.executable,
          args: placed.args.filter((arg) => keepFlag || arg !== '--expand-environment=no'),
          env: placed.env,
          capture: true,
          maxOutputBytes: 65_536,
          timeoutMs: 20_000,
          onLeaderStarted: trackGroupLeader,
        });
        return new TextDecoder().decode(result.stdout);
      };
      expect(await run(true)).toBe(`[${braced}][$$]`);
      expect(await run(false)).toBe('[/expanded-home][$]');
    },
    60_000,
  );

  test.skipIf(available.system.state !== 'available')(
    'stop() ends the whole scope with its detached descendant, and a live id refuses a second launch',
    async () => {
      const payload = await createWorkPayload();
      const sameOwner = owner('system');
      const launch = await launchWork({
        owner: sameOwner,
        placement: SYSTEM,
        command: payload.command,
      });
      const unit = launch.unit?.name ?? '';
      try {
        const detached = await payload.pid('detached');
        const child = await payload.pid('child');
        expect((await systemctl(['is-active', '--', unit])).stdout).toBe('active');

        const second = await launchWork({
          owner: sameOwner,
          placement: SYSTEM,
          command: { executable: '/usr/bin/true', timeoutMs: 10_000 },
        }).then(
          () => null,
          (error: unknown) => error,
        );
        expect(second).toBeInstanceOf(WorkLaunchError);
        if (second instanceof WorkLaunchError) expect(second.reason).toBe('unit-exists');
        // The refused launch touched nothing: the first work is still whole.
        expect(
          await checkWorkMembership({ pid: detached, boundary: launch.origin.boundary }),
        ).toEqual({ state: 'member', via: 'cgroup' });

        await launch.stop();
        for (const pid of [launch.root.pid, child, detached])
          await until(async () => (await probeLiveness(pid)) === 'gone', `pid ${pid} to end`);
        expect(
          await checkWorkMembership({ pid: detached, boundary: launch.origin.boundary }),
        ).toEqual({ state: 'gone' });
        const state = await systemctl(['show', '--property=LoadState', '--value', '--', unit]);
        expect(state.stdout).toBe('not-found');
        // A second stop of a scope that is gone is not a failure.
        await launch.stop();

        // The name is free again: the same id launches once more.
        const again = await launchWork({
          owner: sameOwner,
          placement: SYSTEM,
          command: { executable: '/usr/bin/sleep', args: ['300'], timeoutMs: 30_000 },
        });
        expect(again.unit?.name).toBe(unit);
        expect(again.root.pid).not.toBe(launch.root.pid);
        await again.stop();
      } finally {
        await launch.stop();
      }
    },
    60_000,
  );

  test.skipIf(available.system.state !== 'available')(
    'the slice and a memory limit are properties of the live unit, and its description is the label',
    async () => {
      const callerSlice = readFileSync('/proc/self/cgroup', 'utf8')
        .trim()
        .split('/')
        .findLast((part) => part.endsWith('.slice'));
      const launch = await launchWork({
        owner: owner('system'),
        placement: { ...SYSTEM, limits: { memoryMaxMb: 256, cpuWeight: 50 } },
        command: { executable: '/usr/bin/sleep', args: ['300'], timeoutMs: 30_000 },
      });
      try {
        const shown = await systemctl([
          'show',
          '--property=Slice,MemoryMax,CPUWeight,Description',
          '--',
          launch.unit?.name ?? '',
        ]);
        expect(shown.stdout.split('\n').sort()).toEqual([
          'CPUWeight=50',
          'Description=Work boundary test 100% %n $HOME',
          `MemoryMax=${256 * 1024 * 1024}`,
          `Slice=${callerSlice}`,
        ]);
        expect(readFileSync(`/proc/${launch.root.pid}/cgroup`, 'utf8').trim()).toEndWith(
          `/${callerSlice}/${launch.unit?.name}`,
        );
      } finally {
        await launch.stop();
      }
    },
    60_000,
  );

  test.skipIf(available.system.state !== 'available')(
    'a command wrapped by workCommand is in its scope when another spawner starts it',
    async () => {
      const payload = await createWorkPayload();
      const placed = await workCommand({
        owner: owner('system'),
        placement: SYSTEM,
        executable: payload.command.executable,
        args: payload.command.args,
        env: payload.command.env,
      });
      const origin = readWorkOrigin(placed.env);
      if (origin === null) throw new Error('workCommand declared no origin');
      const stop = new AbortController();
      // Any spawner will do: here the plain runner stands in for a terminal multiplexer.
      const spawned = runNativeCommand({
        executable: placed.executable,
        args: placed.args,
        env: placed.env,
        signal: stop.signal,
        onLeaderStarted: trackGroupLeader,
      }).catch(() => undefined);
      try {
        for (const member of TREE_MEMBERS)
          expect(
            await checkWorkMembership({
              pid: await payload.pid(member),
              boundary: origin.boundary,
            }),
          ).toEqual({ state: 'member', via: 'cgroup' });
        expect(JSON.parse(await payload.text('inherited.json'))).toEqual(placed.work);
      } finally {
        await systemctl(['stop', '--', placed.unit?.name ?? '']);
        stop.abort();
        await spawned;
      }
    },
    60_000,
  );

  test.skipIf(available.user.state !== 'available')(
    "manager 'user' places the scope under the caller's user manager",
    async () => {
      const payload = await createWorkPayload();
      const launch = await launchWork({
        owner: owner('user'),
        placement: USER,
        command: payload.command,
      });
      try {
        expect(launch.origin.boundary).toMatchObject({ manager: 'user' });
        const cgroup = readFileSync(`/proc/${launch.root.pid}/cgroup`, 'utf8').trim();
        expect(cgroup).toMatch(
          new RegExp(
            `/user@${process.getuid?.()}\\.service/app\\.slice/${launch.unit?.name}$`,
          ),
        );
        for (const member of TREE_MEMBERS)
          expect(
            await checkWorkMembership({
              pid: await payload.pid(member),
              boundary: launch.origin.boundary,
            }),
          ).toEqual({ state: 'member', via: 'cgroup' });
        // The system manager does not know the unit: the two managers are different places.
        const system = await systemctl([
          'show',
          '--property=LoadState',
          '--value',
          '--',
          launch.unit?.name ?? '',
        ]);
        expect(system.stdout).toBe('not-found');
      } finally {
        await launch.stop();
      }
    },
    60_000,
  );
});
