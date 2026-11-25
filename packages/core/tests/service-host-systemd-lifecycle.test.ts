import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkSystemdUnit,
  createDefaultSystemdHostAdapter,
  installAndStartSystemdUnit,
  reloadSystemdUnit,
  renderSystemdServiceUnit,
  SystemdUnitError,
  systemdMainPid,
  systemdUnitActive,
} from '../src/entrypoints/service-host';

import {
  createFakeSystemdAdapter,
  linkOnFakeHost,
  NOT_FOUND_SHOW,
  showFor,
} from './support/fake-systemd-host';

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe('service-host systemd unit inspection, reload, and rollback', () => {
  test('checkSystemdUnit verifies digest, fragment path, UnitPath drop-ins at not-found, and fails on non-zero systemctl show', async () => {
    const unitPath = '/etc/systemd/system/example-daemon.service';
    const content = renderSystemdServiceUnit({
      description: 'Example daemon',
      scope: 'system',
      execStart: ['/usr/local/bin/example-daemon'],
    });

    // Case 1: LoadState=not-found with foreign drop-in discovered via UnitPath
    const notFoundCase = createFakeSystemdAdapter((_exe, args) => {
      if (args.includes('--property=UnitPath')) {
        return {
          exitCode: 0,
          stdout: '/etc/systemd/system /run/systemd/system /usr/local/lib/systemd/system\n',
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: NOT_FOUND_SHOW, stderr: '' };
    });
    notFoundCase.state.dirs.set('/usr/local/lib/systemd/system/example-daemon.service.d', [
      'override.conf',
    ]);

    const resNotFound = await checkSystemdUnit({
      unitName: 'example-daemon.service',
      unitPath,
      expectedContent: content,
      scope: 'system',
      adapter: notFoundCase.adapter,
    });
    expect(resNotFound.ok).toBe(false);
    expect(resNotFound.status).toBe('foreign-drop-in');
    expect(resNotFound.loadState).toBe('not-found');
    expect(resNotFound.foreignDropIns).toEqual([
      '/usr/local/lib/systemd/system/example-daemon.service.d/override.conf',
    ]);

    // Case 2: Non-zero systemctl show exit throws COMMAND_FAILED (never silently treated as not-found)
    const dbusDown = createFakeSystemdAdapter(() => ({
      exitCode: 1,
      stdout: '',
      stderr: 'Failed to connect to bus: No such file or directory',
    }));
    await expect(
      checkSystemdUnit({
        unitName: 'example-daemon.service',
        unitPath,
        expectedContent: content,
        scope: 'system',
        adapter: dbusDown.adapter,
      }),
    ).rejects.toMatchObject({ code: 'COMMAND_FAILED' });

    // Case 3: Loaded unit matches content & fragment path with zero drop-ins
    const okCase = createFakeSystemdAdapter((_exe, args) => {
      if (args.includes('--property=UnitPath')) {
        return { exitCode: 0, stdout: '/etc/systemd/system\n', stderr: '' };
      }
      return {
        exitCode: 0,
        stdout: [
          'LoadState=loaded',
          `FragmentPath=${unitPath}`,
          'DropInPaths=',
          'ActiveState=active',
          'SubState=running',
          'MainPID=4242',
        ].join('\n'),
        stderr: '',
      };
    });
    okCase.state.files.set(unitPath, content);

    const resOk = await checkSystemdUnit({
      unitName: 'example-daemon.service',
      unitPath,
      expectedContent: content,
      scope: 'system',
      adapter: okCase.adapter,
    });
    expect(resOk.ok).toBe(true);
    expect(resOk.status).toBe('matches');
    expect(resOk.actualDigest).toBe(sha256(content));
    expect(resOk.mainPid).toBe(4242);

    // Case 4: Digest mismatch
    okCase.state.files.set(unitPath, `${content}# drift\n`);
    const resDrift = await checkSystemdUnit({
      unitName: 'example-daemon.service',
      unitPath,
      expectedContent: content,
      scope: 'system',
      adapter: okCase.adapter,
    });
    expect(resDrift.ok).toBe(false);
    expect(resDrift.status).toBe('digest-mismatch');
  });

  test('rejects flag-like and control-character unit names and passes -- before unitName', async () => {
    const { adapter, state } = createFakeSystemdAdapter((_exe, args) => {
      if (args.includes('is-active')) return { exitCode: 0, stdout: 'active\n', stderr: '' };
      return { exitCode: 0, stdout: '9876\n', stderr: '' };
    });

    for (const bad of ['-H', '--root', '.', 'a\x07b', 'a/b']) {
      await expect(
        systemdUnitActive({ unitName: bad, scope: 'user', adapter }),
      ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    }

    expect(
      await systemdUnitActive({ unitName: 'agent.service', scope: 'user', adapter }),
    ).toBe(true);
    expect(await systemdMainPid({ unitName: 'agent.service', scope: 'user', adapter })).toBe(
      9876,
    );
    expect(state.commands[0]?.args).toEqual(['--user', 'is-active', '--', 'agent.service']);
    expect(state.commands[1]?.args).toEqual([
      '--user',
      'show',
      '--no-pager',
      '--property=MainPID',
      '--value',
      '--',
      'agent.service',
    ]);
  });

  test('installAndStartSystemdUnit refuses before writing if a foreign drop-in exists', async () => {
    const unitPath = '/etc/systemd/system/example.service';
    const content = renderSystemdServiceUnit({
      description: 'Example',
      scope: 'system',
      execStart: ['/usr/bin/example'],
    });
    const { adapter, state } = createFakeSystemdAdapter((_exe, args) => {
      if (args.includes('--property=UnitPath')) {
        return { exitCode: 0, stdout: '/etc/systemd/system\n', stderr: '' };
      }
      return { exitCode: 0, stdout: NOT_FOUND_SHOW, stderr: '' };
    });
    state.dirs.set('/etc/systemd/system/example.service.d', ['99-foreign.conf']);

    await expect(
      installAndStartSystemdUnit({
        unitName: 'example.service',
        unitPath,
        content,
        scope: 'system',
        adapter,
      }),
    ).rejects.toMatchObject({ code: 'FOREIGN_DROP_IN', rolledBack: false });
    expect(state.files.has(unitPath)).toBe(false);
  });

  test('reloadSystemdUnit rolls back on crash-looping MainPID change and reports rollback failure when rollback also fails', async () => {
    const unitPath = '/etc/systemd/system/example.service';
    const oldUnit = renderSystemdServiceUnit({
      description: 'Old v1',
      scope: 'system',
      execStart: ['/opt/app/v1/daemon'],
    });
    const newUnit = renderSystemdServiceUnit({
      description: 'New v2',
      scope: 'system',
      execStart: ['/opt/app/v2/daemon'],
    });

    // Crash-looping candidate stays active=true but changes MainPID mid-window
    let pidPolls = 0;
    const crashLoop = createFakeSystemdAdapter((_exe, args, state) => {
      if (args.includes('--property=UnitPath')) {
        return { exitCode: 0, stdout: '/etc/systemd/system\n', stderr: '' };
      }
      if (args.includes('is-active')) return { exitCode: 0, stdout: 'active\n', stderr: '' };
      if (args.includes('--property=MainPID')) {
        pidPolls += 1;
        return { exitCode: 0, stdout: pidPolls <= 2 ? '2002\n' : '2099\n', stderr: '' };
      }
      return { exitCode: 0, stdout: showFor(state, unitPath), stderr: '' };
    });
    crashLoop.state.files.set(unitPath, oldUnit);

    await expect(
      reloadSystemdUnit({
        unitName: 'example.service',
        unitPath,
        content: newUnit,
        scope: 'system',
        stabilityMs: 1_000,
        pollIntervalMs: 250,
        adapter: crashLoop.adapter,
      }),
    ).rejects.toMatchObject({ code: 'UNSTABLE_CANDIDATE', rolledBack: true });
    expect(crashLoop.state.files.get(unitPath)).toBe(oldUnit);

    // When rollback itself fails, rolledBack is false and message includes rollback reason
    let restartCalls = 0;
    const failedRollback = createFakeSystemdAdapter((_exe, args, state) => {
      if (args.includes('--property=UnitPath')) {
        return { exitCode: 0, stdout: '/etc/systemd/system\n', stderr: '' };
      }
      if (args.includes('restart')) {
        restartCalls += 1;
        return {
          exitCode: 1,
          stdout: '',
          stderr: restartCalls === 1 ? 'candidate start failed' : 'rollback restart failed',
        };
      }
      return { exitCode: 0, stdout: showFor(state, unitPath), stderr: '' };
    });
    failedRollback.state.files.set(unitPath, oldUnit);

    let caught: unknown;
    try {
      await reloadSystemdUnit({
        unitName: 'example.service',
        unitPath,
        content: newUnit,
        scope: 'system',
        adapter: failedRollback.adapter,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SystemdUnitError);
    if (caught instanceof SystemdUnitError) {
      expect(caught.rolledBack).toBe(false);
      expect(caught.message).toContain('rollback also failed');
    }
  });

  test('installAndStartSystemdUnit removes the links enable made on fresh-install rollback, succeeds when stable, and validates wait bounds', async () => {
    const unitPath = '/home/example-user/.config/systemd/user/worker.service';
    const content = renderSystemdServiceUnit({
      description: 'Worker',
      scope: 'user',
      execStart: ['/home/example-user/.local/bin/worker'],
    });

    const wantsLink =
      '/home/example-user/.config/systemd/user/default.target.wants/worker.service';
    const timeoutCase = createFakeSystemdAdapter((_exe, args, state) => {
      if (args.includes('enable')) linkOnFakeHost(state, wantsLink, unitPath);
      if (args.includes('--property=UnitPath')) {
        return {
          exitCode: 0,
          stdout: '/home/example-user/.config/systemd/user\n',
          stderr: '',
        };
      }
      if (args.includes('is-active'))
        return { exitCode: 3, stdout: 'activating\n', stderr: '' };
      if (args.includes('--property=MainPID'))
        return { exitCode: 0, stdout: '0\n', stderr: '' };
      return { exitCode: 0, stdout: showFor(state, unitPath), stderr: '' };
    });

    await expect(
      installAndStartSystemdUnit({
        unitName: 'worker.service',
        unitPath,
        content,
        scope: 'user',
        mode: 0o600,
        enable: true,
        startupTimeoutMs: 400,
        pollIntervalMs: 100,
        adapter: timeoutCase.adapter,
      }),
    ).rejects.toMatchObject({ code: 'START_TIMEOUT', rolledBack: true });

    expect(timeoutCase.state.files.has(unitPath)).toBe(false);
    const cmds = timeoutCase.state.commands.map((c) => c.args.join(' '));
    expect(cmds).toContain('--user enable -- worker.service');
    expect(timeoutCase.state.links.has(wantsLink)).toBe(false);

    // Invalid timeout above MAX_WAIT_MS throws SystemdUnitError('INVALID_CONFIG')
    await expect(
      reloadSystemdUnit({
        unitName: 'worker.service',
        unitPath,
        content,
        scope: 'user',
        startupTimeoutMs: 999_999,
        adapter: timeoutCase.adapter,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });

    // Stable reload succeeds
    const stableCase = createFakeSystemdAdapter((_exe, args, state) => {
      if (args.includes('--property=UnitPath')) {
        return {
          exitCode: 0,
          stdout: '/home/example-user/.config/systemd/user\n',
          stderr: '',
        };
      }
      if (args.includes('is-active')) return { exitCode: 0, stdout: 'active\n', stderr: '' };
      if (args.includes('--property=MainPID'))
        return { exitCode: 0, stdout: '7777\n', stderr: '' };
      return { exitCode: 0, stdout: showFor(state, unitPath), stderr: '' };
    });

    const ok = await reloadSystemdUnit({
      unitName: 'worker.service',
      unitPath,
      content,
      scope: 'user',
      stabilityMs: 1_000,
      pollIntervalMs: 250,
      adapter: stableCase.adapter,
    });
    expect(ok.mainPid).toBe(7777);
    expect(ok.digest).toBe(sha256(content));
    expect(ok.stableForMs).toBeGreaterThanOrEqual(1_000);
  });

  test('a unit of the same name loaded from another directory is refused, before and after the write', async () => {
    const unitPath = '/usr/lib/systemd/system/example.service';
    const shadow = '/etc/systemd/system/example.service';
    const content = renderSystemdServiceUnit({
      description: 'Example',
      scope: 'system',
      execStart: ['/opt/app/daemon'],
    });
    const shadowShow = `LoadState=loaded\nFragmentPath=${shadow}\nDropInPaths=\nActiveState=active\nSubState=running\nMainPID=7\n`;

    // Already shadowed: nothing is written and nothing is restarted.
    const before = createFakeSystemdAdapter((_exe, args) => {
      if (args.includes('--property=UnitPath')) {
        return {
          exitCode: 0,
          stdout: '/etc/systemd/system /usr/lib/systemd/system\n',
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: shadowShow, stderr: '' };
    });
    await expect(
      installAndStartSystemdUnit({
        unitName: 'example.service',
        unitPath,
        content,
        scope: 'system',
        adapter: before.adapter,
      }),
    ).rejects.toMatchObject({ code: 'FOREIGN_FRAGMENT', rolledBack: false });
    expect(before.state.files.has(unitPath)).toBe(false);
    expect(before.state.commands.some((command) => command.args.includes('restart'))).toBe(
      false,
    );

    // Shadowed only once systemd reloads: the file is taken back and the foreign unit is
    // never restarted under our name.
    let reloaded = false;
    const after = createFakeSystemdAdapter((_exe, args, state) => {
      if (args.includes('--property=UnitPath')) {
        return {
          exitCode: 0,
          stdout: '/etc/systemd/system /usr/lib/systemd/system\n',
          stderr: '',
        };
      }
      if (args.includes('daemon-reload')) {
        reloaded = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args.includes('is-active')) return { exitCode: 0, stdout: 'active\n', stderr: '' };
      if (args.includes('--property=MainPID'))
        return { exitCode: 0, stdout: '7\n', stderr: '' };
      return {
        exitCode: 0,
        stdout: reloaded && state.files.has(unitPath) ? shadowShow : NOT_FOUND_SHOW,
        stderr: '',
      };
    });
    await expect(
      installAndStartSystemdUnit({
        unitName: 'example.service',
        unitPath,
        content,
        scope: 'system',
        stabilityMs: 0,
        adapter: after.adapter,
      }),
    ).rejects.toMatchObject({ code: 'FOREIGN_FRAGMENT', rolledBack: true });
    expect(after.state.files.has(unitPath)).toBe(false);
    expect(after.state.commands.some((command) => command.args.includes('restart'))).toBe(
      false,
    );
  });

  test('a masked unit and a oneshot unit are refused before anything is written', async () => {
    const unitPath = '/etc/systemd/system/example.service';
    const masked = createFakeSystemdAdapter((_exe, args) => {
      if (args.includes('--property=UnitPath')) {
        return { exitCode: 0, stdout: '/etc/systemd/system\n', stderr: '' };
      }
      return {
        exitCode: 0,
        stdout:
          'LoadState=masked\nFragmentPath=/dev/null\nDropInPaths=\nActiveState=inactive\nSubState=dead\nMainPID=0\n',
        stderr: '',
      };
    });
    await expect(
      installAndStartSystemdUnit({
        unitName: 'example.service',
        unitPath,
        content: renderSystemdServiceUnit({
          description: 'Example',
          scope: 'system',
          execStart: ['/opt/app/daemon'],
        }),
        scope: 'system',
        adapter: masked.adapter,
      }),
    ).rejects.toMatchObject({ code: 'FOREIGN_FRAGMENT', rolledBack: false });
    expect(masked.state.files.has(unitPath)).toBe(false);

    const oneshot = createFakeSystemdAdapter((_exe, args, state) => {
      if (args.includes('--property=UnitPath')) {
        return { exitCode: 0, stdout: '/etc/systemd/system\n', stderr: '' };
      }
      return { exitCode: 0, stdout: showFor(state, unitPath), stderr: '' };
    });
    await expect(
      installAndStartSystemdUnit({
        unitName: 'example.service',
        unitPath,
        content: renderSystemdServiceUnit({
          description: 'Migration',
          scope: 'system',
          type: 'oneshot',
          execStart: ['/opt/app/migrate'],
        }),
        scope: 'system',
        adapter: oneshot.adapter,
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_UNIT_TYPE', rolledBack: false });
    expect(oneshot.state.files.has(unitPath)).toBe(false);
  });

  test('rollback writes the bytes that were there and leaves a stopped unit stopped', async () => {
    const unitPath = '/etc/systemd/system/example.service';
    const oldUnit = renderSystemdServiceUnit({
      description: 'Old',
      scope: 'system',
      execStart: ['/opt/app/v1/daemon'],
    });
    const written: Array<string | Uint8Array> = [];
    const stopped = createFakeSystemdAdapter((_exe, args, state) => {
      if (args.includes('--property=UnitPath')) {
        return { exitCode: 0, stdout: '/etc/systemd/system\n', stderr: '' };
      }
      if (args.includes('restart')) return { exitCode: 1, stdout: '', stderr: 'exec failed' };
      return { exitCode: 0, stdout: showFor(state, unitPath, 'inactive'), stderr: '' };
    });
    stopped.state.files.set(unitPath, oldUnit);
    const write = stopped.adapter.writeFileAtomic;
    stopped.adapter.writeFileAtomic = async (path, content, options) => {
      written.push(content);
      await write(path, content, options);
    };

    await expect(
      reloadSystemdUnit({
        unitName: 'example.service',
        unitPath,
        content: renderSystemdServiceUnit({
          description: 'New',
          scope: 'system',
          execStart: ['/opt/app/v2/daemon'],
        }),
        scope: 'system',
        adapter: stopped.adapter,
      }),
    ).rejects.toMatchObject({ code: 'COMMAND_FAILED', rolledBack: true });

    // The candidate went in as text; what came back is the byte array that was read.
    expect(written).toHaveLength(2);
    expect(written[1]).toBeInstanceOf(Uint8Array);
    expect(written[1]).toEqual(new TextEncoder().encode(oldUnit));
    const afterFailure = stopped.state.commands
      .slice(
        stopped.state.commands.findIndex((command) => command.args.includes('restart')) + 1,
      )
      .map((command) => command.args.filter((arg) => !arg.startsWith('--')).join(' '));
    expect(afterFailure).toEqual(['daemon-reload', 'stop example.service']);
  });

  test('checkSystemdUnit allows trusted host-wide service.d/*.conf, rejects untrusted/traversal/unit drop-ins, and scans template drop-ins', async () => {
    const unitPath = '/etc/systemd/system/worker@alpha.service';
    const content = renderSystemdServiceUnit({
      description: 'Template worker',
      scope: 'system',
      execStart: ['/usr/local/bin/worker'],
    });

    const loadedWithDropIns = (dropIns: string) => {
      const fake = createFakeSystemdAdapter((_exe, args) => {
        if (args.includes('--property=UnitPath')) {
          return {
            exitCode: 0,
            stdout: '/etc/systemd/system /run/systemd/system /usr/lib/systemd/system\n',
            stderr: '',
          };
        }
        return {
          exitCode: 0,
          stdout: [
            'LoadState=loaded',
            `FragmentPath=${unitPath}`,
            `DropInPaths=${dropIns}`,
            'ActiveState=active',
            'SubState=running',
            'MainPID=5151',
          ].join('\n'),
          stderr: '',
        };
      });
      fake.state.files.set(unitPath, content);
      return fake;
    };

    // Trusted host-wide service.d/*.conf is allowed
    const allowed = loadedWithDropIns(
      '/etc/systemd/system/service.d/10-limits.conf /usr/lib/systemd/system/service.d/20-env.conf',
    );
    const allowedResult = await checkSystemdUnit({
      unitName: 'worker@alpha.service',
      unitPath,
      expectedContent: content,
      scope: 'system',
      adapter: allowed.adapter,
    });
    expect(allowedResult.ok).toBe(true);
    expect(allowedResult.status).toBe('matches');
    expect(allowedResult.foreignDropIns).toEqual([]);

    // Untrusted directory, traversal, non-normalized path, non-.conf, and unit-specific drop-ins are rejected
    for (const badDropIn of [
      '/tmp/evil/service.d/10-limits.conf',
      '/etc/systemd/system/service.d/../worker@alpha.service.d/override.conf',
      '/etc/systemd/system//service.d/10-limits.conf',
      '/etc/systemd/system/./service.d/10-limits.conf',
      '/etc/systemd/system/foo-service.d/10-limits.conf',
      '/etc/systemd/system/service.d/10-limits.txt',
      '/etc/systemd/system/worker@alpha.service.d/override.conf',
    ]) {
      const rejected = loadedWithDropIns(badDropIn);
      const res = await checkSystemdUnit({
        unitName: 'worker@alpha.service',
        unitPath,
        expectedContent: content,
        scope: 'system',
        adapter: rejected.adapter,
      });
      expect(res.ok).toBe(false);
      expect(res.status).toBe('foreign-drop-in');
      expect(res.foreignDropIns).toEqual([badDropIn]);
    }

    // Non-.service unit (e.g. .timer) does NOT allow service.d/*.conf
    const timerDropIn = loadedWithDropIns('/etc/systemd/system/service.d/10-limits.conf');
    const timerRes = await checkSystemdUnit({
      unitName: 'worker.timer',
      unitPath,
      expectedContent: content,
      scope: 'system',
      adapter: timerDropIn.adapter,
    });
    expect(timerRes.ok).toBe(false);
    expect(timerRes.status).toBe('foreign-drop-in');
    expect(timerRes.foreignDropIns).toEqual(['/etc/systemd/system/service.d/10-limits.conf']);

    // Template drop-in (worker@.service.d/*.conf) is scanned at LoadState=not-found
    const templateDropIn = createFakeSystemdAdapter((_exe, args) => {
      if (args.includes('--property=UnitPath')) {
        return { exitCode: 0, stdout: '/etc/systemd/system\n', stderr: '' };
      }
      return { exitCode: 0, stdout: NOT_FOUND_SHOW, stderr: '' };
    });
    templateDropIn.state.dirs.set('/etc/systemd/system/worker@.service.d', ['override.conf']);
    const templateRes = await checkSystemdUnit({
      unitName: 'worker@alpha.service',
      unitPath,
      expectedContent: content,
      scope: 'system',
      adapter: templateDropIn.adapter,
    });
    expect(templateRes.ok).toBe(false);
    expect(templateRes.status).toBe('foreign-drop-in');
    expect(templateRes.foreignDropIns).toEqual([
      '/etc/systemd/system/worker@.service.d/override.conf',
    ]);
  });

  test('checkSystemdUnit supports expectedDigest, fails closed on UnitPath error, and handles LoadState=masked (/dev/null)', async () => {
    const unitPath = '/etc/systemd/system/example.service';
    const content = renderSystemdServiceUnit({
      description: 'Digest test',
      scope: 'system',
      execStart: ['/usr/bin/example'],
    });
    const digest = sha256(content);

    const okCase = createFakeSystemdAdapter((_exe, args) => {
      if (args.includes('--property=UnitPath')) {
        return { exitCode: 0, stdout: '/etc/systemd/system\n', stderr: '' };
      }
      return {
        exitCode: 0,
        stdout: [
          'LoadState=loaded',
          `FragmentPath=${unitPath}`,
          'DropInPaths=',
          'ActiveState=active',
          'SubState=running',
          'MainPID=3333',
        ].join('\n'),
        stderr: '',
      };
    });
    okCase.state.files.set(unitPath, content);

    // expectedDigest works as alternative to expectedContent
    const byDigest = await checkSystemdUnit({
      unitName: 'example.service',
      unitPath,
      expectedDigest: digest,
      scope: 'system',
      adapter: okCase.adapter,
    });
    expect(byDigest.ok).toBe(true);
    expect(byDigest.status).toBe('matches');
    expect(byDigest.expectedDigest).toBe(digest);

    // Passing both, neither, or invalid hex throws INVALID_CONFIG
    await expect(
      checkSystemdUnit({
        unitName: 'example.service',
        unitPath,
        expectedContent: content,
        expectedDigest: digest,
        scope: 'system',
        adapter: okCase.adapter,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(
      checkSystemdUnit({
        unitName: 'example.service',
        unitPath,
        scope: 'system',
        adapter: okCase.adapter,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(
      checkSystemdUnit({
        unitName: 'example.service',
        unitPath,
        expectedDigest: 'not-a-sha256',
        scope: 'system',
        adapter: okCase.adapter,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });

    // Non-zero systemctl show --property=UnitPath fails closed with COMMAND_FAILED
    const unitPathFails = createFakeSystemdAdapter((_exe, args) => {
      if (args.includes('--property=UnitPath')) {
        return { exitCode: 1, stdout: '', stderr: 'bus disconnected' };
      }
      return { exitCode: 0, stdout: NOT_FOUND_SHOW, stderr: '' };
    });
    await expect(
      checkSystemdUnit({
        unitName: 'example.service',
        unitPath,
        expectedContent: content,
        scope: 'system',
        adapter: unitPathFails.adapter,
      }),
    ).rejects.toMatchObject({ code: 'COMMAND_FAILED' });

    // Real default adapter readFile returns null on /dev/null symlink (LoadState=masked)
    const dir = mkdtempSync(join(tmpdir(), 'stitchkit-systemd-masked-'));
    try {
      const maskedLink = join(dir, 'masked.service');
      symlinkSync('/dev/null', maskedLink);
      const defaultAdapter = createDefaultSystemdHostAdapter();
      expect(await defaultAdapter.readFile(maskedLink)).toBeNull();

      const maskedCase = createFakeSystemdAdapter((_exe, args) => {
        if (args.includes('--property=UnitPath')) {
          return { exitCode: 0, stdout: `${dir}\n`, stderr: '' };
        }
        return {
          exitCode: 0,
          stdout: [
            'LoadState=masked',
            'FragmentPath=/dev/null',
            'DropInPaths=',
            'ActiveState=inactive',
            'SubState=dead',
            'MainPID=0',
          ].join('\n'),
          stderr: '',
        };
      });
      const maskedResult = await checkSystemdUnit({
        unitName: 'masked.service',
        unitPath: maskedLink,
        expectedContent: content,
        scope: 'system',
        adapter: {
          ...maskedCase.adapter,
          readFile: (path) => defaultAdapter.readFile(path),
        },
      });
      expect(maskedResult.ok).toBe(false);
      expect(maskedResult.loadState).toBe('masked');
      expect(maskedResult.actualDigest).toBeNull();
      expect(maskedResult.status).toBe('fragment-mismatch');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('installAndStartSystemdUnit does not stop a foreign unit when FOREIGN_FRAGMENT fails before restart', async () => {
    const unitPath = '/etc/systemd/system/example.service';
    const content = renderSystemdServiceUnit({
      description: 'Example',
      scope: 'system',
      execStart: ['/usr/bin/example'],
    });
    let showCalls = 0;
    const fake = createFakeSystemdAdapter((_exe, args) => {
      if (args.includes('--property=UnitPath')) {
        return { exitCode: 0, stdout: '/etc/systemd/system\n', stderr: '' };
      }
      if (args.includes('show')) {
        showCalls += 1;
        if (showCalls === 1) return { exitCode: 0, stdout: NOT_FOUND_SHOW, stderr: '' };
        return {
          exitCode: 0,
          stdout: [
            'LoadState=loaded',
            'FragmentPath=/lib/systemd/system/example.service',
            'DropInPaths=',
            'ActiveState=active',
            'SubState=running',
            'MainPID=555',
          ].join('\n'),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await expect(
      installAndStartSystemdUnit({
        unitName: 'example.service',
        unitPath,
        content,
        scope: 'system',
        adapter: fake.adapter,
      }),
    ).rejects.toMatchObject({ code: 'FOREIGN_FRAGMENT', rolledBack: true });
    expect(fake.state.commands.some((cmd) => cmd.args.includes('stop'))).toBe(false);
  });

  test('reloadSystemdUnit rollback does not stop or restart when FOREIGN_FRAGMENT fails before restart with existing unitPath (both wasActive polarities) and still rolls back active/inactive on UNSTABLE_CANDIDATE', async () => {
    const unitPath = '/etc/systemd/system/example.service';
    const oldUnit = renderSystemdServiceUnit({
      description: 'Old',
      scope: 'system',
      execStart: ['/opt/app/v1/daemon'],
    });
    const newUnit = renderSystemdServiceUnit({
      description: 'New',
      scope: 'system',
      execStart: ['/opt/app/v2/daemon'],
    });

    for (const initialActiveState of ['inactive', 'active'] as const) {
      let showCalls = 0;
      const fake = createFakeSystemdAdapter((_exe, args, state) => {
        if (args.includes('--property=UnitPath')) {
          return { exitCode: 0, stdout: '/etc/systemd/system\n', stderr: '' };
        }
        if (args.includes('show')) {
          showCalls += 1;
          if (showCalls === 1) {
            return {
              exitCode: 0,
              stdout: showFor(state, unitPath, initialActiveState),
              stderr: '',
            };
          }
          return {
            exitCode: 0,
            stdout: [
              'LoadState=loaded',
              'FragmentPath=/lib/systemd/system/example.service',
              'DropInPaths=',
              `ActiveState=${initialActiveState}`,
              `SubState=${initialActiveState === 'active' ? 'running' : 'dead'}`,
              `MainPID=${initialActiveState === 'active' ? 555 : 0}`,
            ].join('\n'),
            stderr: '',
          };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });
      fake.state.files.set(unitPath, oldUnit);

      await expect(
        reloadSystemdUnit({
          unitName: 'example.service',
          unitPath,
          content: newUnit,
          scope: 'system',
          adapter: fake.adapter,
        }),
      ).rejects.toMatchObject({ code: 'FOREIGN_FRAGMENT', rolledBack: true });

      expect(fake.state.files.get(unitPath)).toBe(oldUnit);
      expect(
        fake.state.commands.some(
          (cmd) => cmd.args.includes('stop') || cmd.args.includes('restart'),
        ),
        `initialActiveState=${initialActiveState}`,
      ).toBe(false);
    }

    // Positive control: once restart HAS happened, UNSTABLE_CANDIDATE rollback still invokes restart/stop according to wasActive.
    for (const initialActiveState of ['active', 'inactive'] as const) {
      let isActiveCalls = 0;
      const unstable = createFakeSystemdAdapter((_exe, args, state) => {
        if (args.includes('--property=UnitPath')) {
          return { exitCode: 0, stdout: '/etc/systemd/system\n', stderr: '' };
        }
        if (args.includes('is-active')) {
          isActiveCalls += 1;
          // Active on first startup poll, then crashes during stability window
          return {
            exitCode: isActiveCalls === 1 ? 0 : 3,
            stdout: isActiveCalls === 1 ? 'active\n' : 'failed\n',
            stderr: '',
          };
        }
        if (args.includes('--property=MainPID')) {
          return { exitCode: 0, stdout: '4242\n', stderr: '' };
        }
        if (args.includes('show')) {
          return {
            exitCode: 0,
            stdout: showFor(state, unitPath, initialActiveState),
            stderr: '',
          };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });
      unstable.state.files.set(unitPath, oldUnit);

      await expect(
        reloadSystemdUnit({
          unitName: 'example.service',
          unitPath,
          content: newUnit,
          scope: 'system',
          stabilityMs: 200,
          pollIntervalMs: 100,
          startupTimeoutMs: 500,
          adapter: unstable.adapter,
        }),
      ).rejects.toMatchObject({ code: 'UNSTABLE_CANDIDATE', rolledBack: true });

      expect(unstable.state.files.get(unitPath)).toBe(oldUnit);
      const firstRestartIdx = unstable.state.commands.findIndex((cmd) =>
        cmd.args.includes('restart'),
      );
      expect(firstRestartIdx).toBeGreaterThanOrEqual(0);
      const rollbackCommands = unstable.state.commands
        .slice(firstRestartIdx + 1)
        .filter(
          (cmd) =>
            cmd.args.includes('daemon-reload') ||
            cmd.args.includes('restart') ||
            cmd.args.includes('stop'),
        )
        .map((cmd) => cmd.args.filter((arg) => !arg.startsWith('--')).join(' '));
      expect(rollbackCommands).toEqual([
        'daemon-reload',
        `${initialActiveState === 'active' ? 'restart' : 'stop'} example.service`,
      ]);
    }
  });
});
