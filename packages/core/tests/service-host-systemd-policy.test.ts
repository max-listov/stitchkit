/**
 * Systemd service policy directives (restart limit, success exit status, hardening,
 * state/runtime directories, oneshot/no-install, scheduling), `.timer` unit rendering,
 * real `systemd-analyze verify` checks on Linux, and `.service` + `.timer` pair inspection,
 * idempotent installation, and two-file rollback.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkSystemdTimerPair,
  installSystemdTimerPair,
  renderSystemdServiceUnit,
  renderSystemdTimerUnit,
  SystemdUnitError,
} from '../src/entrypoints/service-host';
import {
  createFakeSystemdAdapter,
  linkOnFakeHost,
  NOT_FOUND_SHOW,
  showFor,
} from './support/fake-systemd-host';

const hasSystemdAnalyze =
  process.platform === 'linux' &&
  spawnSync('systemd-analyze', ['--version'], { stdio: 'ignore' }).status === 0;

function showPairUnit(
  state: ReturnType<typeof createFakeSystemdAdapter>['state'],
  unitPath: string,
  options?: {
    activeState?: string;
    unitFileState?: string;
    needDaemonReload?: boolean;
  },
): string {
  if (!state.files.has(unitPath)) return NOT_FOUND_SHOW;
  return [
    'LoadState=loaded',
    `FragmentPath=${unitPath}`,
    'DropInPaths=',
    `ActiveState=${options?.activeState ?? 'inactive'}`,
    'SubState=dead',
    'MainPID=0',
    `UnitFileState=${options?.unitFileState ?? 'disabled'}`,
    `NeedDaemonReload=${options?.needDaemonReload ? 'yes' : 'no'}`,
  ].join('\n');
}

describe('service-host systemd restart, success-exit, hardening, and timer policy', () => {
  test('renders StartLimitIntervalSec=0 and SuccessExitStatus= with validation and omission defaults', () => {
    const bare = renderSystemdServiceUnit({
      description: 'Plain daemon',
      scope: 'user',
      execStart: ['/usr/local/bin/daemon'],
    });
    expect(bare).not.toContain('StartLimitIntervalSec=');
    expect(bare).not.toContain('SuccessExitStatus=');

    const configured = renderSystemdServiceUnit({
      description: 'Managed agent daemon',
      scope: 'user',
      execStart: ['/usr/local/bin/daemon', '--serve'],
      restart: 'on-failure',
      restartSec: 5,
      startLimitIntervalSec: 0,
      successExitStatus: [143],
    });
    expect(configured).toContain(
      '[Unit]\nDescription=Managed agent daemon\nStartLimitIntervalSec=0\n',
    );
    expect(configured).toContain('SuccessExitStatus=143\n');

    const multi = renderSystemdServiceUnit({
      description: 'Multi status daemon',
      scope: 'system',
      execStart: ['/usr/local/bin/daemon'],
      startLimitIntervalSec: '5min',
      successExitStatus: [0, 143, 'SIGTERM', 'SIGHUP'],
    });
    expect(multi).toContain('StartLimitIntervalSec=5min\n');
    expect(multi).toContain('SuccessExitStatus=0 143 SIGTERM SIGHUP\n');

    for (const bad of [
      { startLimitIntervalSec: -1 },
      { startLimitIntervalSec: 'not-a-duration' },
      { successExitStatus: [] },
      { successExitStatus: [-1] },
      { successExitStatus: [256] },
      { successExitStatus: ['SIGNOPE'] },
      { successExitStatus: ['143\nExecStart=/bin/sh'] },
    ]) {
      expect(() =>
        renderSystemdServiceUnit({
          description: 'Invalid',
          scope: 'system',
          execStart: ['/usr/bin/true'],
          ...bad,
        } as Parameters<typeof renderSystemdServiceUnit>[0]),
      ).toThrow(SystemdUnitError);
    }
  });

  test('renders hardened system daemon, dynamic-user collector, isolated backup/prune oneshots, and timer units', () => {
    const daemon = renderSystemdServiceUnit({
      description: 'Host monitor daemon',
      scope: 'system',
      execStart: ['/opt/monitor/bin/agent', '--serve'],
      user: 'monitor',
      group: 'monitor',
      timeoutStartSec: 60,
      restart: 'always',
      restartSec: 5,
      startLimitIntervalSec: 0,
      successExitStatus: [143],
      runtimeDirectory: 'host-monitor',
      runtimeDirectoryMode: '0750',
      stateDirectory: 'host-monitor',
      stateDirectoryMode: '0750',
      protectSystem: 'strict',
      protectHome: true,
      privateTmp: true,
      restrictAddressFamilies: ['AF_UNIX', 'AF_INET', 'AF_INET6'],
    });
    expect(daemon).toContain('TimeoutStartSec=60\n');
    expect(daemon).toContain('RuntimeDirectory=host-monitor\n');
    expect(daemon).toContain('RuntimeDirectoryMode=0750\n');
    expect(daemon).toContain('StateDirectory=host-monitor\n');
    expect(daemon).toContain('StateDirectoryMode=0750\n');
    expect(daemon).toContain('ProtectSystem=strict\n');
    expect(daemon).toContain('ProtectHome=yes\n');
    expect(daemon).toContain('PrivateTmp=yes\n');
    expect(daemon).toContain('RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\n');

    const collector = renderSystemdServiceUnit({
      description: 'Host collector',
      scope: 'system',
      type: 'oneshot',
      execStart: ['/opt/monitor/bin/collect'],
      dynamicUser: true,
      bindReadOnlyPaths: [
        { source: '/run/host-monitor', ignoreMissing: true },
        '/etc/host-monitor',
      ],
      privateNetwork: true,
      protectSystem: 'strict',
      protectHome: 'read-only',
      restrictAddressFamilies: ['none'],
      nice: 10,
      ioSchedulingClass: 'best-effort',
      wantedBy: [],
    });
    expect(collector).toContain('Type=oneshot\n');
    expect(collector).not.toContain('Restart=');
    expect(collector).not.toContain('[Install]');
    expect(collector).toContain('DynamicUser=yes\n');
    expect(collector).toContain('BindReadOnlyPaths=-/run/host-monitor\n');
    expect(collector).toContain('BindReadOnlyPaths=/etc/host-monitor\n');
    expect(collector).toContain('PrivateNetwork=yes\n');
    expect(collector).toContain('ProtectHome=read-only\n');
    expect(collector).toContain('RestrictAddressFamilies=none\n');
    expect(collector).toContain('Nice=10\n');
    expect(collector).toContain('IOSchedulingClass=best-effort\n');

    const prune = renderSystemdServiceUnit({
      description: 'Host prune',
      scope: 'system',
      type: 'oneshot',
      execStart: ['/opt/monitor/bin/prune'],
      timeoutStartSec: 'infinity',
      nice: 19,
      ioSchedulingClass: 'idle',
      wantedBy: [],
    });
    expect(prune).toContain('TimeoutStartSec=infinity\n');
    expect(prune).toContain('Nice=19\n');
    expect(prune).toContain('IOSchedulingClass=idle\n');
    expect(prune).not.toContain('[Install]');

    const calendarTimer = renderSystemdTimerUnit({
      description: 'Nightly backup timer',
      scope: 'system',
      unit: 'host-backup.service',
      onCalendar: ['*-*-* 02:00:00', 'Sun *-*-* 04:30:00'],
      persistent: true,
      accuracySec: '1min',
      randomizedDelaySec: 300,
    });
    expect(calendarTimer).toContain('[Timer]\nUnit=host-backup.service\n');
    expect(calendarTimer).toContain(
      'OnCalendar=*-*-* 02:00:00\nOnCalendar=Sun *-*-* 04:30:00\n',
    );
    expect(calendarTimer).toContain('AccuracySec=1min\n');
    expect(calendarTimer).toContain('RandomizedDelaySec=300\n');
    expect(calendarTimer).toContain('Persistent=yes\n');
    expect(calendarTimer).toContain('[Install]\nWantedBy=timers.target\n');

    const monotonicTimer = renderSystemdTimerUnit({
      description: 'Periodic collector timer for %h',
      scope: 'system',
      after: ['network-online.target'],
      wants: ['network-online.target'],
      onBootSec: 30,
      onStartupSec: 15,
      onActiveSec: '10min',
      onUnitActiveSec: '5min',
      onUnitInactiveSec: 120,
      allowHomeSpecifier: true,
      wantedBy: [],
    });
    expect(monotonicTimer).toContain('Description=Periodic collector timer for %h\n');
    expect(monotonicTimer).toContain('After=network-online.target\n');
    expect(monotonicTimer).toContain('Wants=network-online.target\n');
    expect(monotonicTimer).toContain('OnBootSec=30\n');
    expect(monotonicTimer).toContain('OnStartupSec=15\n');
    expect(monotonicTimer).toContain('OnActiveSec=10min\n');
    expect(monotonicTimer).toContain('OnUnitActiveSec=5min\n');
    expect(monotonicTimer).toContain('OnUnitInactiveSec=120\n');
    expect(monotonicTimer).not.toContain('[Install]');

    // Without allowHomeSpecifier, %h is escaped to %%h.
    const escapedTimer = renderSystemdTimerUnit({
      description: 'Escaped %h timer',
      scope: 'system',
      onBootSec: 10,
    });
    expect(escapedTimer).toContain('Description=Escaped %%h timer\n');
  });

  test('rejects invalid hardening, oneshot restart, dynamicUser in user scope, and invalid timer configs', () => {
    const baseService = {
      description: 'Test',
      scope: 'system' as const,
      execStart: ['/usr/bin/true'],
    };
    for (const invalid of [
      { ...baseService, type: 'oneshot', restart: 'always' },
      { ...baseService, type: 'oneshot', restart: 'on-success' },
      { ...baseService, scope: 'user', dynamicUser: true },
      { ...baseService, runtimeDirectoryMode: '07777' },
      { ...baseService, runtimeDirectoryMode: 'rwx' },
      { ...baseService, stateDirectory: '../escape' },
      { ...baseService, stateDirectory: '/abs/path' },
      { ...baseService, bindReadOnlyPaths: ['relative/path'] },
      { ...baseService, bindReadOnlyPaths: ['/etc/a:b'] },
      { ...baseService, bindReadOnlyPaths: ['/etc/a\nExecStart=/bin/sh'] },
      { ...baseService, restrictAddressFamilies: ['none', 'AF_UNIX'] },
      { ...baseService, restrictAddressFamilies: ['INET'] },
      { ...baseService, restrictAddressFamilies: ['AF_unix'] },
      { ...baseService, restrictAddressFamilies: [] },
      { ...baseService, nice: -21 },
      { ...baseService, nice: 20 },
      { ...baseService, nice: 1.5 },
      { ...baseService, ioSchedulingClass: 'fastest' },
    ]) {
      expect(() =>
        renderSystemdServiceUnit(invalid as Parameters<typeof renderSystemdServiceUnit>[0]),
      ).toThrow(SystemdUnitError);
    }

    // oneshot with restart: 'on-failure' is valid in systemd
    expect(
      renderSystemdServiceUnit({ ...baseService, type: 'oneshot', restart: 'on-failure' }),
    ).toContain('Restart=on-failure\n');

    for (const badTimer of [
      { description: 'No trigger', scope: 'system' },
      {
        description: 'Persistent without calendar',
        scope: 'system',
        onBootSec: 10,
        persistent: true,
      },
      { description: 'Infinity monotonic', scope: 'system', onUnitActiveSec: 'infinity' },
      { description: 'Wrong unit suffix', scope: 'system', onBootSec: 10, unit: 'foo.timer' },
      { description: 'Empty calendar', scope: 'system', onCalendar: '   ' },
      {
        description: 'Newline in calendar',
        scope: 'system',
        onCalendar: 'daily\nUnit=evil.service',
      },
      {
        description: 'Sub-microsecond float rounds to zero',
        scope: 'system',
        onBootSec: 1e-7,
      },
    ]) {
      expect(() =>
        renderSystemdTimerUnit(badTimer as Parameters<typeof renderSystemdTimerUnit>[0]),
      ).toThrow(SystemdUnitError);
    }
  });

  test.if(hasSystemdAnalyze)(
    'rendered hardened daemon, oneshot services, and timers pass real systemd-analyze verify',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'sk-systemd-verify-'));
      try {
        const daemonPath = join(dir, 'sk-test-daemon.service');
        const oneshotPath = join(dir, 'sk-test-job.service');
        const timerPath = join(dir, 'sk-test-job.timer');

        writeFileSync(
          daemonPath,
          renderSystemdServiceUnit({
            description: 'Verify daemon',
            scope: 'system',
            execStart: ['/bin/true'],
            restart: 'on-failure',
            restartSec: 5,
            startLimitIntervalSec: 0,
            successExitStatus: [143],
            timeoutStartSec: 60,
            runtimeDirectory: 'sk-test',
            runtimeDirectoryMode: '0750',
            stateDirectory: 'sk-test',
            stateDirectoryMode: '0750',
            protectSystem: 'strict',
            protectHome: true,
            privateTmp: true,
            restrictAddressFamilies: ['AF_UNIX', 'AF_INET', 'AF_INET6'],
          }),
        );
        writeFileSync(
          oneshotPath,
          renderSystemdServiceUnit({
            description: 'Verify oneshot',
            scope: 'system',
            type: 'oneshot',
            execStart: ['/bin/true'],
            dynamicUser: true,
            bindReadOnlyPaths: [{ source: '/etc', ignoreMissing: true }],
            privateNetwork: true,
            protectSystem: 'strict',
            protectHome: 'read-only',
            restrictAddressFamilies: ['none'],
            nice: 10,
            ioSchedulingClass: 'best-effort',
            wantedBy: [],
          }),
        );
        writeFileSync(
          timerPath,
          renderSystemdTimerUnit({
            description: 'Verify timer',
            scope: 'system',
            unit: 'sk-test-job.service',
            onCalendar: '*-*-* 02:00:00',
            onBootSec: 30,
            accuracySec: '1min',
            randomizedDelaySec: 60,
            persistent: true,
          }),
        );

        const proc = spawnSync(
          'systemd-analyze',
          ['verify', daemonPath, oneshotPath, timerPath],
          {
            encoding: 'utf8',
          },
        );
        expect(proc.status, `${proc.stdout}\n${proc.stderr}`).toBe(0);
        expect(proc.stderr).not.toMatch(/Unknown key|Failed to parse|Invalid/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test('installSystemdTimerPair is idempotent, respects NeedDaemonReload, restarts active timer on schedule change, and never starts the service', async () => {
    const servicePath = '/etc/systemd/system/job.service';
    const timerPath = '/etc/systemd/system/job.timer';
    const serviceContent = renderSystemdServiceUnit({
      description: 'Job',
      scope: 'system',
      type: 'oneshot',
      execStart: ['/usr/bin/true'],
      wantedBy: [],
    });
    const timerV1 = renderSystemdTimerUnit({
      description: 'Job timer v1',
      scope: 'system',
      onCalendar: 'daily',
      persistent: true,
    });
    const timerV2 = renderSystemdTimerUnit({
      description: 'Job timer v2',
      scope: 'system',
      onCalendar: 'hourly',
      persistent: true,
    });

    let timerActive = false;
    let timerEnabled = false;
    let needReload = false;

    const fake = createFakeSystemdAdapter((_exe, args, state) => {
      if (args.includes('--property=UnitPath')) {
        return { exitCode: 0, stdout: '/etc/systemd/system\n', stderr: '' };
      }
      if (args.includes('daemon-reload')) {
        needReload = false;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args.includes('enable')) {
        timerEnabled = true;
        linkOnFakeHost(state, '/etc/systemd/system/timers.target.wants/job.timer', timerPath);
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args.includes('start') || args.includes('restart')) {
        expect(args.at(-1)).toBe('job.timer');
        timerActive = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args.includes('is-active')) {
        return {
          exitCode: timerActive ? 0 : 3,
          stdout: timerActive ? 'active\n' : 'inactive\n',
          stderr: '',
        };
      }
      const unit = args.at(-1);
      if (unit === 'job.service') {
        return {
          exitCode: 0,
          stdout: showPairUnit(state, servicePath, { needDaemonReload: needReload }),
          stderr: '',
        };
      }
      return {
        exitCode: 0,
        stdout: showPairUnit(state, timerPath, {
          activeState: timerActive ? 'active' : 'inactive',
          unitFileState: timerEnabled ? 'enabled' : 'disabled',
          needDaemonReload: needReload,
        }),
        stderr: '',
      };
    });

    // 1. Fresh install
    const first = await installSystemdTimerPair({
      serviceUnitName: 'job.service',
      serviceUnitPath: servicePath,
      serviceContent,
      timerUnitName: 'job.timer',
      timerUnitPath: timerPath,
      timerContent: timerV1,
      scope: 'system',
      adapter: fake.adapter,
    });
    expect(first).toMatchObject({ changed: true, timerActive: true, timerEnabled: true });
    expect(
      fake.state.commands.some(
        (cmd) =>
          (cmd.args.includes('start') || cmd.args.includes('restart')) &&
          cmd.args.includes('job.service'),
      ),
    ).toBe(false);

    // 2. Idempotent second run -> no-op
    const commandsAfterFirst = fake.state.commands.length;
    const second = await installSystemdTimerPair({
      serviceUnitName: 'job.service',
      serviceUnitPath: servicePath,
      serviceContent,
      timerUnitName: 'job.timer',
      timerUnitPath: timerPath,
      timerContent: timerV1,
      scope: 'system',
      adapter: fake.adapter,
    });
    expect(second).toMatchObject({ changed: false, timerActive: true, timerEnabled: true });
    const noopCommands = fake.state.commands.slice(commandsAfterFirst);
    expect(
      noopCommands.some((cmd) =>
        ['daemon-reload', 'enable', 'start', 'restart'].some((verb) =>
          cmd.args.includes(verb),
        ),
      ),
    ).toBe(false);

    // 3. NeedDaemonReload=yes on matching files must NOT be treated as no-op
    needReload = true;
    const reloadCmdsBefore = fake.state.commands.length;
    const afterReloadNeeded = await installSystemdTimerPair({
      serviceUnitName: 'job.service',
      serviceUnitPath: servicePath,
      serviceContent,
      timerUnitName: 'job.timer',
      timerUnitPath: timerPath,
      timerContent: timerV1,
      scope: 'system',
      adapter: fake.adapter,
    });
    expect(afterReloadNeeded.changed).toBe(true);
    const reloadCmds = fake.state.commands
      .slice(reloadCmdsBefore)
      .map((c) => c.args.join(' '));
    expect(reloadCmds).toContain('daemon-reload');
    expect(reloadCmds).toContain('restart -- job.timer');

    // 4. Schedule change on active timer runs restart on .timer
    const scheduleCmdsBefore = fake.state.commands.length;
    const updated = await installSystemdTimerPair({
      serviceUnitName: 'job.service',
      serviceUnitPath: servicePath,
      serviceContent,
      timerUnitName: 'job.timer',
      timerUnitPath: timerPath,
      timerContent: timerV2,
      scope: 'system',
      adapter: fake.adapter,
    });
    expect(updated.changed).toBe(true);
    const scheduleCmds = fake.state.commands
      .slice(scheduleCmdsBefore)
      .map((c) => c.args.join(' '));
    expect(scheduleCmds).toContain('daemon-reload');
    expect(scheduleCmds).toContain('restart -- job.timer');

    // 5. checkSystemdTimerPair reports ok=true with content, digest, and unitSearchDirs
    const check = await checkSystemdTimerPair({
      serviceUnitName: 'job.service',
      serviceUnitPath: servicePath,
      expectedServiceContent: serviceContent,
      timerUnitName: 'job.timer',
      timerUnitPath: timerPath,
      expectedTimerContent: timerV2,
      scope: 'system',
      adapter: fake.adapter,
    });
    expect(check).toMatchObject({ ok: true, timerActive: true, timerEnabled: true });

    const digestCheck = await checkSystemdTimerPair({
      serviceUnitName: 'job.service',
      serviceUnitPath: servicePath,
      expectedServiceDigest: updated.serviceDigest,
      timerUnitName: 'job.timer',
      timerUnitPath: timerPath,
      expectedTimerDigest: updated.timerDigest,
      scope: 'system',
      adapter: fake.adapter,
    });
    expect(digestCheck.ok).toBe(true);
    const badDigestCheck = await checkSystemdTimerPair({
      serviceUnitName: 'job.service',
      serviceUnitPath: servicePath,
      expectedServiceDigest: '0'.repeat(64),
      timerUnitName: 'job.timer',
      timerUnitPath: timerPath,
      expectedTimerDigest: '0'.repeat(64),
      scope: 'system',
      adapter: fake.adapter,
    });
    expect(badDigestCheck.ok).toBe(false);
    expect(badDigestCheck.service.status).toBe('digest-mismatch');
    expect(badDigestCheck.timer.status).toBe('digest-mismatch');

    // Foreign drop-in in custom unitSearchDirs is surfaced by checkSystemdTimerPair and refused by installSystemdTimerPair
    fake.state.dirs.set('/run/systemd/system/job.timer.d', ['override.conf']);
    const foreignDropInCheck = await checkSystemdTimerPair({
      serviceUnitName: 'job.service',
      serviceUnitPath: servicePath,
      expectedServiceDigest: updated.serviceDigest,
      timerUnitName: 'job.timer',
      timerUnitPath: timerPath,
      expectedTimerDigest: updated.timerDigest,
      scope: 'system',
      unitSearchDirs: ['/run/systemd/system'],
      adapter: fake.adapter,
    });
    expect(foreignDropInCheck.ok).toBe(false);
    expect(foreignDropInCheck.timer.foreignDropIns).toContain(
      '/run/systemd/system/job.timer.d/override.conf',
    );
    await expect(
      installSystemdTimerPair({
        serviceUnitName: 'job.service',
        serviceUnitPath: servicePath,
        serviceContent,
        timerUnitName: 'job.timer',
        timerUnitPath: timerPath,
        timerContent: timerV2,
        scope: 'system',
        unitSearchDirs: ['/run/systemd/system'],
        adapter: fake.adapter,
      }),
    ).rejects.toMatchObject({ code: 'FOREIGN_DROP_IN', rolledBack: false });
    fake.state.dirs.delete('/run/systemd/system/job.timer.d');

    // 6. Mode mismatch triggers rewrite with requested mode (I9: InstallSystemdTimerPairOptions.mode)
    const modeChanged = await installSystemdTimerPair({
      serviceUnitName: 'job.service',
      serviceUnitPath: servicePath,
      serviceContent,
      timerUnitName: 'job.timer',
      timerUnitPath: timerPath,
      timerContent: timerV2,
      scope: 'system',
      mode: 0o640,
      adapter: fake.adapter,
    });
    expect(modeChanged.changed).toBe(true);
    expect(fake.state.modes.get(servicePath)).toBe(0o640);
    expect(fake.state.modes.get(timerPath)).toBe(0o640);
  });

  test('installSystemdTimerPair validates Unit= linkage, all (enable, start) combos, foreign refusals, and rolls back both files on failure', async () => {
    const servicePath = '/etc/systemd/system/backup.service';
    const timerPath = '/etc/systemd/system/backup.timer';
    const serviceContent = renderSystemdServiceUnit({
      description: 'Backup',
      scope: 'system',
      type: 'oneshot',
      execStart: ['/usr/bin/true'],
      wantedBy: [],
    });
    const wrongTargetTimer = renderSystemdTimerUnit({
      description: 'Wrong target',
      scope: 'system',
      unit: 'other.service',
      onCalendar: 'daily',
    });
    const validTimer = renderSystemdTimerUnit({
      description: 'Backup timer',
      scope: 'system',
      onCalendar: 'daily',
    });

    // Unit= mismatch refused before any host call
    const untouched = createFakeSystemdAdapter(() => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));
    await expect(
      installSystemdTimerPair({
        serviceUnitName: 'backup.service',
        serviceUnitPath: servicePath,
        serviceContent,
        timerUnitName: 'backup.timer',
        timerUnitPath: timerPath,
        timerContent: wrongTargetTimer,
        scope: 'system',
        adapter: untouched.adapter,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(untouched.state.commands).toHaveLength(0);

    // enable: false, start: false installs files + daemon-reload only
    const quietFake = createFakeSystemdAdapter((_exe, args, state) => {
      if (args.includes('--property=UnitPath')) {
        return { exitCode: 0, stdout: '/etc/systemd/system\n', stderr: '' };
      }
      const unit = args.at(-1);
      const path = unit === 'backup.service' ? servicePath : timerPath;
      return { exitCode: 0, stdout: showFor(state, path, 'inactive', 'disabled'), stderr: '' };
    });
    const quietResult = await installSystemdTimerPair({
      serviceUnitName: 'backup.service',
      serviceUnitPath: servicePath,
      serviceContent,
      timerUnitName: 'backup.timer',
      timerUnitPath: timerPath,
      timerContent: validTimer,
      scope: 'system',
      enable: false,
      start: false,
      adapter: quietFake.adapter,
    });
    expect(quietResult).toMatchObject({
      changed: true,
      timerActive: false,
      timerEnabled: false,
    });
    expect(
      quietFake.state.commands.some((c) =>
        ['enable', 'start', 'restart'].some((verb) => c.args.includes(verb)),
      ),
    ).toBe(false);

    // Rollback on second file write failure restores first file
    const oldService = `${serviceContent}# old\n`;
    const writeFailFake = createFakeSystemdAdapter((_exe, args, state) => {
      if (args.includes('--property=UnitPath')) {
        return { exitCode: 0, stdout: '/etc/systemd/system\n', stderr: '' };
      }
      const unit = args.at(-1);
      const path = unit === 'backup.service' ? servicePath : timerPath;
      return { exitCode: 0, stdout: showFor(state, path, 'inactive', 'disabled'), stderr: '' };
    });
    writeFailFake.state.files.set(servicePath, oldService);
    const origWrite = writeFailFake.adapter.writeFileAtomic;
    writeFailFake.adapter.writeFileAtomic = async (path, content, options) => {
      if (path === timerPath) throw new Error('ENOSPC');
      await origWrite(path, content, options);
    };
    await expect(
      installSystemdTimerPair({
        serviceUnitName: 'backup.service',
        serviceUnitPath: servicePath,
        serviceContent,
        timerUnitName: 'backup.timer',
        timerUnitPath: timerPath,
        timerContent: validTimer,
        scope: 'system',
        adapter: writeFailFake.adapter,
      }),
    ).rejects.toMatchObject({ code: 'COMMAND_FAILED', rolledBack: true });
    expect(writeFailFake.state.files.get(servicePath)).toBe(oldService);
    expect(writeFailFake.state.files.has(timerPath)).toBe(false);

    // Rollback on start failure restores mixed state (existing service + fresh timer + enable link)
    const startFailFake = createFakeSystemdAdapter((_exe, args, state) => {
      if (args.includes('--property=UnitPath')) {
        return { exitCode: 0, stdout: '/etc/systemd/system\n', stderr: '' };
      }
      if (args.includes('enable')) {
        linkOnFakeHost(
          state,
          '/etc/systemd/system/timers.target.wants/backup.timer',
          timerPath,
        );
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args.includes('start')) {
        return { exitCode: 1, stdout: '', stderr: 'Failed to start backup.timer' };
      }
      const unit = args.at(-1);
      const path = unit === 'backup.service' ? servicePath : timerPath;
      return { exitCode: 0, stdout: showFor(state, path, 'inactive', 'disabled'), stderr: '' };
    });
    startFailFake.state.files.set(servicePath, oldService);
    await expect(
      installSystemdTimerPair({
        serviceUnitName: 'backup.service',
        serviceUnitPath: servicePath,
        serviceContent,
        timerUnitName: 'backup.timer',
        timerUnitPath: timerPath,
        timerContent: validTimer,
        scope: 'system',
        adapter: startFailFake.adapter,
      }),
    ).rejects.toMatchObject({ code: 'COMMAND_FAILED', rolledBack: true });
    expect(startFailFake.state.files.get(servicePath)).toBe(oldService);
    expect(startFailFake.state.files.has(timerPath)).toBe(false);
    expect(
      startFailFake.state.links.has('/etc/systemd/system/timers.target.wants/backup.timer'),
    ).toBe(false);

    // (enable: true, start: false) enables without starting; (enable: false, start: true) starts without enabling
    for (const combo of [
      { enable: true, start: false, expectEnable: true, expectStart: false },
      { enable: false, start: true, expectEnable: false, expectStart: true },
    ]) {
      let enabled = false;
      let active = false;
      const comboFake = createFakeSystemdAdapter((_exe, args, state) => {
        if (args.includes('--property=UnitPath'))
          return { exitCode: 0, stdout: '/etc/systemd/system\n', stderr: '' };
        if (args.includes('enable')) {
          enabled = true;
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (args.includes('start') || args.includes('restart')) {
          active = true;
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (args.includes('is-active')) {
          return {
            exitCode: active ? 0 : 3,
            stdout: active ? 'active\n' : 'inactive\n',
            stderr: '',
          };
        }
        const unit = args.at(-1);
        const path = unit === 'backup.service' ? servicePath : timerPath;
        return {
          exitCode: 0,
          stdout: showFor(
            state,
            path,
            active ? 'active' : 'inactive',
            enabled ? 'enabled' : 'disabled',
          ),
          stderr: '',
        };
      });
      const res = await installSystemdTimerPair({
        serviceUnitName: 'backup.service',
        serviceUnitPath: servicePath,
        serviceContent,
        timerUnitName: 'backup.timer',
        timerUnitPath: timerPath,
        timerContent: validTimer,
        scope: 'system',
        enable: combo.enable,
        start: combo.start,
        adapter: comboFake.adapter,
      });
      expect(res.timerEnabled).toBe(combo.expectEnable);
      expect(res.timerActive).toBe(combo.expectStart);
      expect(comboFake.state.commands.some((c) => c.args.includes('enable'))).toBe(
        combo.expectEnable,
      );
      expect(comboFake.state.commands.some((c) => c.args.includes('start'))).toBe(
        combo.expectStart,
      );
    }

    // Foreign symlink at timerPath is refused before any write
    const symFake = createFakeSystemdAdapter((_exe, args, state) => {
      if (args.includes('--property=UnitPath'))
        return { exitCode: 0, stdout: '/etc/systemd/system\n', stderr: '' };
      const unit = args.at(-1);
      const path = unit === 'backup.service' ? servicePath : timerPath;
      return { exitCode: 0, stdout: showFor(state, path, 'inactive', 'disabled'), stderr: '' };
    });
    linkOnFakeHost(symFake.state, timerPath, '/usr/lib/systemd/system/vendor.timer');
    await expect(
      installSystemdTimerPair({
        serviceUnitName: 'backup.service',
        serviceUnitPath: servicePath,
        serviceContent,
        timerUnitName: 'backup.timer',
        timerUnitPath: timerPath,
        timerContent: validTimer,
        scope: 'system',
        adapter: symFake.adapter,
      }),
    ).rejects.toMatchObject({ code: 'FOREIGN_FRAGMENT', rolledBack: false });
    expect(symFake.state.files.has(servicePath)).toBe(false);

    // Matching files already on disk but not yet loaded (LoadState=not-found, NeedDaemonReload=no)
    // must run daemon-reload instead of skipping it and failing with FOREIGN_FRAGMENT.
    let reloaded = false;
    let unloadedActive = false;
    const unloadedFake = createFakeSystemdAdapter((_exe, args, state) => {
      if (args.includes('--property=UnitPath'))
        return { exitCode: 0, stdout: '/etc/systemd/system\n', stderr: '' };
      if (args.includes('daemon-reload')) {
        reloaded = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args.includes('start')) {
        unloadedActive = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args.includes('is-active')) {
        return {
          exitCode: unloadedActive ? 0 : 3,
          stdout: unloadedActive ? 'active\n' : 'inactive\n',
          stderr: '',
        };
      }
      const unit = args.at(-1);
      const path = unit === 'backup.service' ? servicePath : timerPath;
      if (!reloaded) {
        return {
          exitCode: 0,
          stdout: [
            'LoadState=not-found',
            'ActiveState=inactive',
            'SubState=dead',
            'UnitFileState=disabled',
            'FragmentPath=',
            'NeedDaemonReload=no',
          ].join('\n'),
          stderr: '',
        };
      }
      return {
        exitCode: 0,
        stdout: showFor(state, path, unloadedActive ? 'active' : 'inactive', 'enabled'),
        stderr: '',
      };
    });
    unloadedFake.state.files.set(servicePath, serviceContent);
    unloadedFake.state.modes.set(servicePath, 0o644);
    unloadedFake.state.files.set(timerPath, validTimer);
    unloadedFake.state.modes.set(timerPath, 0o644);
    const loadedRes = await installSystemdTimerPair({
      serviceUnitName: 'backup.service',
      serviceUnitPath: servicePath,
      serviceContent,
      timerUnitName: 'backup.timer',
      timerUnitPath: timerPath,
      timerContent: validTimer,
      scope: 'system',
      adapter: unloadedFake.adapter,
    });
    expect(loadedRes).toMatchObject({ changed: true, timerActive: true, timerEnabled: true });
    expect(unloadedFake.state.commands.some((c) => c.args.includes('daemon-reload'))).toBe(
      true,
    );

    // Rollback of an EXISTING timer (previousTimerBytes !== null) restores prior bytes, enablement, and active state
    const oldTimer = renderSystemdTimerUnit({
      description: 'Old backup timer',
      scope: 'system',
      onCalendar: 'weekly',
    });
    let rollbackRestarted = false;
    const existingRollbackFake = createFakeSystemdAdapter((_exe, args, state) => {
      if (args.includes('--property=UnitPath'))
        return { exitCode: 0, stdout: '/etc/systemd/system\n', stderr: '' };
      if (args.includes('restart')) {
        if (!rollbackRestarted) {
          rollbackRestarted = true;
          return { exitCode: 1, stdout: '', stderr: 'New schedule failed' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args.includes('is-enabled')) {
        return { exitCode: 0, stdout: 'enabled\n', stderr: '' };
      }
      const unit = args.at(-1);
      const path = unit === 'backup.service' ? servicePath : timerPath;
      return { exitCode: 0, stdout: showFor(state, path, 'active', 'enabled'), stderr: '' };
    });
    existingRollbackFake.state.files.set(servicePath, oldService);
    existingRollbackFake.state.modes.set(servicePath, 0o644);
    existingRollbackFake.state.files.set(timerPath, oldTimer);
    existingRollbackFake.state.modes.set(timerPath, 0o644);
    await expect(
      installSystemdTimerPair({
        serviceUnitName: 'backup.service',
        serviceUnitPath: servicePath,
        serviceContent,
        timerUnitName: 'backup.timer',
        timerUnitPath: timerPath,
        timerContent: validTimer,
        scope: 'system',
        adapter: existingRollbackFake.adapter,
      }),
    ).rejects.toMatchObject({ code: 'COMMAND_FAILED', rolledBack: true });
    expect(existingRollbackFake.state.files.get(servicePath)).toBe(oldService);
    expect(existingRollbackFake.state.files.get(timerPath)).toBe(oldTimer);
  });
});
