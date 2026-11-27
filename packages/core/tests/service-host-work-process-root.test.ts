import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkWorkMembership,
  launchWork,
  probeWorkBoundary,
  readWorkOrigin,
  WORK_ORIGIN_ENV,
  WorkOriginSchema,
  workCommand,
} from '../src/entrypoints/service-host/work';
import { probeLiveness } from '../src/internal/process-identity';
import { observeProcessInstance } from '../src/internal/process-instance';
import { runNativeCommand } from '../src/process/command';
import { encodeWorkOrigin } from '../src/service-host/work/origin';
import { reapAfterEachTest, trackGroupLeader, trackPidFile } from './support/process-reaper';
import { until } from './support/until';
import {
  createWorkDirectory,
  createWorkPayload,
  removeWorkDirectories,
  TREE_MEMBERS,
} from './support/work-payload';

reapAfterEachTest();
afterEach(removeWorkDirectories);

const ROOT = { kind: 'process-root' } as const;
const posix = process.platform === 'linux' || process.platform === 'darwin';
const SRC = join(import.meta.dir, '../src/entrypoints');

let sequence = 0;
function owner() {
  sequence += 1;
  return {
    launcher: 'stitchkit-test',
    id: `root-${process.pid}-${sequence}`,
    label: 'Process root test',
    project: null,
    agent: null,
    parent: null,
  };
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe.skipIf(!posix)('service-host/work process root on a real process table', () => {
  test('this host can make a process root', async () => {
    expect(await probeWorkBoundary(ROOT)).toEqual({ state: 'available' });
  });

  test('a process and its descendants launched under a process root belong to it, a process outside with the inherited variable does not', async () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal text is the subject.
    const argument = '$HOME ${PATH} $$';
    const payload = await createWorkPayload(argument);
    const launch = await launchWork({
      owner: owner(),
      placement: ROOT,
      command: payload.command,
    });
    try {
      const { boundary } = launch.origin;
      expect(launch.unit).toBeNull();
      // The root replaced itself with the command: same pid, same process instance.
      expect(await payload.pid('root')).toBe(launch.root.pid);
      expect(await observeProcessInstance(launch.root.pid)).toEqual({
        state: 'observed',
        instance: launch.root.instance,
      });
      // What the root wrote into its own variable is exactly what the launcher reports.
      const held = readWorkOrigin({ [WORK_ORIGIN_ENV]: await payload.text('origin') });
      expect(held).toEqual(launch.origin);
      expect(await payload.text('arg')).toBe(argument);

      const evidence: Record<string, unknown> = {};
      for (const member of TREE_MEMBERS)
        evidence[member] = await checkWorkMembership({
          pid: await payload.pid(member),
          boundary,
        });
      expect(evidence).toEqual({
        root: { state: 'member', via: 'root' },
        child: { state: 'member', via: 'process-group' },
        grandchild: { state: 'member', via: 'process-group' },
        // It left the group; its parent chain still reaches the live root.
        detached: { state: 'member', via: 'ancestry' },
      });
      expect(JSON.parse(await payload.text('inherited.json'))).toEqual(launch.origin.work);

      const variable = { [WORK_ORIGIN_ENV]: encodeWorkOrigin(launch.origin) };
      const outside = Promise.withResolvers<number>();
      const stopOutside = new AbortController();
      const sleeper = runNativeCommand({
        executable: '/bin/sleep',
        args: ['300'],
        env: variable,
        signal: stopOutside.signal,
        onLeaderStarted: (event) => {
          trackGroupLeader(event);
          outside.resolve(event.pid);
        },
      }).catch(() => undefined);
      const outsidePid = await outside.promise;
      const answer = await checkWorkMembership({ pid: outsidePid, boundary });
      expect(answer.state).toBe('outside');
      if (answer.state === 'outside' && 'pgid' in answer.observed) {
        expect(answer.observed.pgid).toBe(outsidePid);
        expect(answer.observed.ancestors).toContain(process.pid);
        expect(answer.observed.ancestors).not.toContain(launch.root.pid);
      }
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
      expect(decode(claimed.stdout).trim()).toBe('null');
    } finally {
      await launch.stop();
    }
  }, 60_000);

  test('stop() ends the root group; a detached descendant that lost its parent is outside', async () => {
    const payload = await createWorkPayload();
    const launch = await launchWork({
      owner: owner(),
      placement: ROOT,
      command: payload.command,
    });
    try {
      const { boundary } = launch.origin;
      const pids = {
        child: await payload.pid('child'),
        grandchild: await payload.pid('grandchild'),
        detached: await payload.pid('detached'),
      };
      await payload.pid('root');
      await launch.stop();
      for (const pid of [launch.root.pid, pids.child, pids.grandchild])
        await until(async () => (await probeLiveness(pid)) === 'gone', `pid ${pid} to end`);
      expect(await checkWorkMembership({ pid: launch.root.pid, boundary })).toEqual({
        state: 'gone',
      });
      // The limit of a process root, stated in the guide: a scope would still hold this one.
      expect(await probeLiveness(pids.detached)).toBe('alive');
      const orphan = await checkWorkMembership({ pid: pids.detached, boundary });
      expect(orphan.state).toBe('outside');
    } finally {
      await launch.stop();
    }
  }, 60_000);

  test('a group member outlives the root and stays a member; a bare command name is found on its PATH', async () => {
    const dir = await createWorkDirectory();
    trackPidFile(join(dir, 'member.pid'));
    const launch = await launchWork({
      owner: owner(),
      placement: ROOT,
      command: {
        executable: 'sh',
        args: ['-c', 'sleep 300 >/dev/null 2>&1 & echo $! > "$0/member.pid"; sleep 0.3', dir],
        env: { PATH: '/usr/bin:/bin' },
        timeoutMs: 30_000,
        descendants: 'leave',
      },
    });
    try {
      const result = await launch.result;
      expect(result.exitCode).toBe(0);
      const member = Number((await Bun.file(join(dir, 'member.pid')).text()).trim());
      await until(
        async () => (await probeLiveness(launch.root.pid)) === 'gone',
        'the root to be reaped',
      );
      expect(
        await checkWorkMembership({ pid: member, boundary: launch.origin.boundary }),
      ).toEqual({ state: 'member', via: 'process-group' });
    } finally {
      await launch.stop();
    }
  }, 60_000);

  test('a root that cannot become its command says why and exits 127', async () => {
    const placed = await workCommand({
      owner: owner(),
      placement: ROOT,
      executable: 'stitchkit-no-such-command',
      env: { PATH: '/usr/bin:/bin' },
    });
    const result = await runNativeCommand({
      executable: placed.executable,
      args: placed.args,
      env: placed.env,
      capture: true,
      maxOutputBytes: 65_536,
      timeoutMs: 30_000,
      onLeaderStarted: trackGroupLeader,
    });
    expect(result.exitCode).toBe(127);
    expect(decode(result.stderr)).toBe(
      'stitchkit work root: Command not found on PATH: stitchkit-no-such-command\n',
    );
    expect(decode(result.stdout)).toBe('');
  }, 60_000);
});

const APPLICATION = (bootstrap: boolean) => `
${bootstrap ? `import { bootstrapPackageProcess } from ${JSON.stringify(join(SRC, 'process/bootstrap.ts'))};` : 'const bootstrapPackageProcess = () => false;'}
async function main() {
  if (process.argv[2] !== 'place') {
    console.error('unknown application command');
    process.exitCode = 64;
    return;
  }
  // The work module stays behind a dynamic import, as a lazily routed application keeps it.
  const { workCommand } = await import(${JSON.stringify(join(SRC, 'service-host/work.ts'))});
  const placed = await workCommand({
    owner: { launcher: 'stitchkit-test', id: 'bundle-' + process.pid, label: 'Bundled root', project: null, agent: null, parent: null },
    placement: { kind: 'process-root' },
    executable: '/bin/sh',
    args: ['-c', 'printf "%s\\\\n%s" "$$" "$${WORK_ORIGIN_ENV}"'],
    env: { PATH: '/usr/bin:/bin' },
  });
  console.log(JSON.stringify(placed));
}
if (!bootstrapPackageProcess()) await main();
`;

describe.skipIf(process.platform !== 'linux')(
  'service-host/work process root in a single-file bundle',
  () => {
    async function bundle(dir: string, name: string, bootstrap: boolean): Promise<string> {
      const entry = join(dir, `${name}.ts`);
      await writeFile(entry, APPLICATION(bootstrap));
      const built = await Bun.build({
        entrypoints: [entry],
        outdir: join(dir, name),
        target: 'bun',
      });
      if (!built.success) throw new AggregateError(built.logs, 'Bundle failed');
      expect(built.outputs.map((output) => output.kind)).toEqual(['entry-point']);
      return join(dir, name, `${name}.js`);
    }

    async function runPlaced(file: string) {
      const run = (args: string[]) =>
        runNativeCommand({
          executable: process.execPath,
          args,
          env: { PATH: '/usr/bin:/bin' },
          capture: true,
          maxOutputBytes: 1024 * 1024,
          timeoutMs: 30_000,
          onLeaderStarted: trackGroupLeader,
        });
      const placed = JSON.parse(decode((await run([file, 'place'])).stdout));
      expect(placed.args[0]).toBe(file);
      return run(placed.args);
    }

    test('the bootstrap carries the root into a lazily routed bundle, and without it the application answers instead', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'stitchkit-work-bundle-'));
      try {
        const rooted = await runPlaced(await bundle(dir, 'with-bootstrap', true));
        expect(rooted.exitCode).toBe(0);
        const [pid, variable] = decode(rooted.stdout).split('\n');
        const origin = WorkOriginSchema.parse(JSON.parse(variable ?? ''));
        expect(origin.boundary).toMatchObject({
          kind: 'process-root',
          root: { pid: Number(pid) },
        });

        // Negative control: the same application without the bootstrap routes the private
        // invocation to its own dispatcher, and no command runs.
        const unrooted = await runPlaced(await bundle(dir, 'without-bootstrap', false));
        expect(unrooted.exitCode).toBe(64);
        expect(decode(unrooted.stderr)).toBe('unknown application command\n');
        expect(decode(unrooted.stdout)).toBe('');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }, 120_000);
  },
);
