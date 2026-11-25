import { describe, expect, test } from 'bun:test';
import {
  renderSystemdServiceUnit,
  type SystemdServiceUnitConfig,
  SystemdUnitError,
} from '../src/entrypoints/service-host';

describe('service-host systemd unit rendering', () => {
  test('escapes %, \\, ", and $ in ExecStart while preserving literal $ in Environment', () => {
    const unit = renderSystemdServiceUnit({
      description: 'Worker 100% ready for %u',
      scope: 'system',
      execStart: ['/usr/local/bin/daemon', '--flag', '100% $HOME "quoted" \\path', ''],
      execStartPre: [['/usr/bin/env', 'CHECK=$VAL', 'RATE=50%']],
      workingDirectory: '/var/lib/daemon/100%',
      environment: {
        API_PRICE: '$99',
        FORMAT: '100% "ok" \\dir',
        HOME_REF: '%h/data',
      },
      environmentFile: ['-/etc/daemon/env', '/etc/daemon/extra.env'],
      user: 'daemon-svc',
      group: 'daemon-svc',
      type: 'simple',
      restart: 'always',
      restartSec: 3,
      timeoutStopSec: '15s',
      killMode: 'mixed',
      oomScoreAdjust: -500,
      oomPolicy: 'stop',
      ioAccounting: true,
      umask: '0027',
      noNewPrivileges: true,
      runtimeDirectory: ['daemon-svc', 'daemon-svc/sockets'],
      limitNOFILE: 65536,
      after: ['network-online.target'],
      wants: ['network-online.target'],
      wantedBy: ['multi-user.target'],
    });

    expect(unit).toContain('Description=Worker 100%% ready for %%u\n');
    expect(unit).toContain(
      'ExecStart=/usr/local/bin/daemon --flag "100%% $$HOME \\"quoted\\" \\\\path" ""\n',
    );
    expect(unit).toContain('ExecStartPre=/usr/bin/env CHECK=$$VAL RATE=50%%\n');
    expect(unit).toContain('WorkingDirectory=/var/lib/daemon/100%%\n');
    expect(unit).toContain('Environment="API_PRICE=$99"\n');
    expect(unit).toContain('Environment="FORMAT=100%% \\"ok\\" \\\\dir"\n');
    expect(unit).toContain('Environment="HOME_REF=%%h/data"\n');
    expect(unit).toContain('EnvironmentFile=-/etc/daemon/env\n');
    expect(unit).toContain('EnvironmentFile=/etc/daemon/extra.env\n');
    expect(unit).toContain('User=daemon-svc\n');
    expect(unit).toContain('Group=daemon-svc\n');
    expect(unit).toContain('Type=simple\n');
    expect(unit).toContain('Restart=always\n');
    expect(unit).toContain('RestartSec=3\n');
    expect(unit).toContain('TimeoutStopSec=15s\n');
    expect(unit).toContain('KillMode=mixed\n');
    expect(unit).toContain('OOMScoreAdjust=-500\n');
    expect(unit).toContain('OOMPolicy=stop\n');
    expect(unit).toContain('IOAccounting=yes\n');
    expect(unit).toContain('UMask=0027\n');
    expect(unit).toContain('NoNewPrivileges=yes\n');
    expect(unit).toContain('RuntimeDirectory=daemon-svc daemon-svc/sockets\n');
    expect(unit).toContain('LimitNOFILE=65536\n');
    expect(unit).toContain('After=network-online.target\n');
    expect(unit).toContain('Wants=network-online.target\n');
    expect(unit).toContain('WantedBy=multi-user.target\n');
  });

  test('supports explicit %h preservation when allowHomeSpecifier is true while treating %% as an atomic literal pair', () => {
    const unit = renderSystemdServiceUnit({
      description: 'User daemon in %h (100% %u %%h)',
      scope: 'user',
      allowHomeSpecifier: true,
      execStart: ['%h/.local/bin/daemon', '--dir', '%h/state', '--lit', '%%h', '--pct', '50%'],
      workingDirectory: '%h/.local/share/daemon',
      environment: {
        STATE_DIR: '%h/state/$PORT/100%',
        LITERAL_DOUBLE: '%%h',
      },
    });

    expect(unit).toContain('Description=User daemon in %h (100%% %%u %%%%h)\n');
    expect(unit).toContain(
      'ExecStart=%h/.local/bin/daemon --dir %h/state --lit %%%%h --pct 50%%\n',
    );
    expect(unit).toContain('WorkingDirectory=%h/.local/share/daemon\n');
    expect(unit).toContain('Environment="STATE_DIR=%h/state/$PORT/100%%"\n');
    expect(unit).toContain('Environment="LITERAL_DOUBLE=%%%%h"\n');
    expect(unit).toContain('WantedBy=default.target\n');
  });

  test('refuses directive injection, trailing backslash continuations, invalid whitespace, empty execStartPre[0], and user-scope User/Group', () => {
    const cases: SystemdServiceUnitConfig[] = [
      { description: 'Bad\nExecStartPost=/bin/evil', execStart: ['/usr/bin/true'] },
      { description: 'Bad\rExecStartPost=/bin/evil', execStart: ['/usr/bin/true'] },
      { description: 'Bad\0desc', execStart: ['/usr/bin/true'] },
      { description: 'Trailing backslash\\', execStart: ['/usr/bin/true'] },
      { description: 'ok', execStart: ['/usr/bin/true', 'arg\nExecStartPost=/bin/evil'] },
      { description: 'ok', execStart: ['/usr/bin/true'], execStartPre: [['']] },
      {
        description: 'ok',
        execStart: ['/usr/bin/true'],
        environment: { GOOD: 'val\nExecStart=/bin/evil' },
      },
      {
        description: 'ok',
        execStart: ['/usr/bin/true'],
        environment: { 'BAD=KEY': 'val' },
      },
      {
        description: 'ok',
        execStart: ['/usr/bin/true'],
        workingDirectory: '/tmp\nUser=root',
      },
      {
        description: 'ok',
        execStart: ['/usr/bin/true'],
        workingDirectory: '/tmp/trail\\',
      },
      { description: 'ok', execStart: ['/usr/bin/true'], after: ['a.target b.target'] },
      { description: 'ok', execStart: ['/usr/bin/true'], wants: ['a.target\tb.target'] },
      { description: 'ok', execStart: ['/usr/bin/true'], wantedBy: ['multi user.target'] },
      { description: 'ok', execStart: ['/usr/bin/true'], runtimeDirectory: 'dir with space' },
      { description: 'ok', execStart: ['/usr/bin/true'], user: 'bad user' },
      { description: 'ok', execStart: ['/usr/bin/true'], group: 'bad group' },
      { description: 'ok', execStart: ['/usr/bin/true'], restartSec: '2s extra' },
      { description: 'ok', execStart: ['/usr/bin/true'], timeoutStopSec: '5s extra' },
      {
        description: 'user unit',
        scope: 'user',
        execStart: ['/usr/bin/true'],
        user: 'example-user',
      },
    ];

    for (const input of cases) {
      expect(() => renderSystemdServiceUnit(input)).toThrow(SystemdUnitError);
    }
  });

  test("refuses an executable that begins with one of systemd's exec prefixes", () => {
    // systemd reads the prefix before it unquotes the token, so `"-/bin/x"` still means
    // "ignore the failure" and `"+/bin/x"` still means "run with full privileges".
    for (const prefixed of [
      '-/opt/app/daemon',
      '@/opt/app/daemon',
      ':/opt/app/daemon',
      '+/opt/app/daemon',
      '!/opt/app/daemon',
      '!!/opt/app/daemon',
    ]) {
      expect(() =>
        renderSystemdServiceUnit({
          description: 'Example',
          scope: 'system',
          execStart: [prefixed],
        }),
      ).toThrow(SystemdUnitError);
      expect(() =>
        renderSystemdServiceUnit({
          description: 'Example',
          scope: 'system',
          execStart: ['/opt/app/daemon'],
          execStartPre: [[prefixed]],
        }),
      ).toThrow(SystemdUnitError);
    }
    // A later argument is data: the same characters there are passed to the program as written.
    expect(
      renderSystemdServiceUnit({
        description: 'Example',
        scope: 'system',
        execStart: ['/opt/app/daemon', '-v', '+x', '@host'],
      }),
    ).toContain('ExecStart=/opt/app/daemon -v +x @host');
  });
});
