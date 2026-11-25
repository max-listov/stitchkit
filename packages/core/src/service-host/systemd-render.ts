import { z } from 'zod';
import {
  assertCleanValue,
  EXEC_PREFIX,
  EXEC_PREFIX_MESSAGE,
  formatBindReadOnlyPath,
  formatRelativeManagedDirectory,
  formatSystemdDuration,
  formatSystemdEnvironmentLine,
  formatSystemdExecLine,
  formatSystemdScalar,
  OCTAL_MODE_PATTERN,
  SystemdAddressFamilySchema,
  SystemdBindReadOnlyPathSchema,
  SystemdScopeSchema,
  SystemdSuccessExitStatusItemSchema,
  SystemdTimeoutSchema,
  SystemdTimespanSchema,
  SystemdUnitError,
  toStringList,
} from './systemd-render-shared';

/**
 * Zod schema for rendering a systemd `.service` unit file with strict escaping
 * and typed service-hardening options.
 */
export const SystemdServiceUnitConfigSchema = z
  .strictObject({
    description: z.string().min(1),
    scope: SystemdScopeSchema.default('system'),
    execStart: z.array(z.string()).min(1),
    execStartPre: z.array(z.array(z.string()).min(1)).optional(),
    workingDirectory: z.string().min(1).optional(),
    environment: z.record(z.string(), z.string()).optional(),
    environmentFile: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
    user: z.string().min(1).optional(),
    group: z.string().min(1).optional(),
    dynamicUser: z.boolean().optional(),
    type: z.enum(['simple', 'exec', 'forking', 'oneshot', 'notify']).optional(),
    restart: z
      .enum([
        'no',
        'on-success',
        'on-failure',
        'on-abnormal',
        'on-watchdog',
        'on-abort',
        'always',
      ])
      .optional(),
    restartSec: z.union([z.number().nonnegative(), z.string().min(1)]).optional(),
    /** `[Unit]` `StartLimitIntervalSec=`; `0` disables start rate-limiting. */
    startLimitIntervalSec: SystemdTimespanSchema.optional(),
    /** `[Service]` `SuccessExitStatus=` exit codes (`0..255`) or POSIX signal names. */
    successExitStatus: z.array(SystemdSuccessExitStatusItemSchema).min(1).optional(),
    /** `[Service]` `TimeoutStartSec=` deadline (`0`, seconds, timespan, or `'infinity'`). */
    timeoutStartSec: SystemdTimeoutSchema.optional(),
    timeoutStopSec: z.union([z.number().positive(), z.string().min(1)]).optional(),
    killMode: z.enum(['control-group', 'mixed', 'process', 'none']).optional(),
    oomScoreAdjust: z.number().int().min(-1000).max(1000).optional(),
    oomPolicy: z.enum(['continue', 'stop', 'kill']).optional(),
    ioAccounting: z.boolean().optional(),
    nice: z.number().int().min(-20).max(19).optional(),
    ioSchedulingClass: z.enum(['none', 'realtime', 'best-effort', 'idle']).optional(),
    umask: z.string().regex(OCTAL_MODE_PATTERN).optional(),
    noNewPrivileges: z.boolean().optional(),
    privateNetwork: z.boolean().optional(),
    privateTmp: z.boolean().optional(),
    protectSystem: z.union([z.boolean(), z.enum(['full', 'strict'])]).optional(),
    protectHome: z.union([z.boolean(), z.enum(['read-only', 'tmpfs'])]).optional(),
    restrictAddressFamilies: z.array(SystemdAddressFamilySchema).min(1).optional(),
    bindReadOnlyPaths: z.array(SystemdBindReadOnlyPathSchema).min(1).optional(),
    runtimeDirectory: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
    runtimeDirectoryMode: z.string().regex(OCTAL_MODE_PATTERN).optional(),
    stateDirectory: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    stateDirectoryMode: z.string().regex(OCTAL_MODE_PATTERN).optional(),
    limitNOFILE: z.union([z.number().int().positive(), z.literal('infinity')]).optional(),
    after: z.array(z.string().min(1)).optional(),
    wants: z.array(z.string().min(1)).optional(),
    /** Target(s) in `[Install]`. Pass `[]` to omit `[Install]` (e.g. timer-driven services). */
    wantedBy: z.array(z.string().min(1)).optional(),
    /**
     * Explicitly preserve `%h` (systemd home-directory specifier) unescaped while
     * still escaping every other `%` as `%%` (and `%%` as `%%%%`). Defaults to `false`.
     */
    allowHomeSpecifier: z.boolean().default(false),
  })
  .check((ctx) => {
    const value = ctx.value;
    if ((value.execStart[0] ?? '').length === 0) {
      ctx.issues.push({
        code: 'custom',
        input: value.execStart,
        path: ['execStart', 0],
        message: 'execStart[0] must be a non-empty executable path',
      });
    } else if (EXEC_PREFIX.test(value.execStart[0] ?? '')) {
      ctx.issues.push({
        code: 'custom',
        input: value.execStart,
        path: ['execStart', 0],
        message: EXEC_PREFIX_MESSAGE,
      });
    }
    if (value.execStartPre !== undefined) {
      for (let index = 0; index < value.execStartPre.length; index += 1) {
        const cmd = value.execStartPre[index];
        if ((cmd?.[0] ?? '').length === 0) {
          ctx.issues.push({
            code: 'custom',
            input: cmd,
            path: ['execStartPre', index, 0],
            message: `execStartPre[${index}][0] must be a non-empty executable path`,
          });
        } else if (EXEC_PREFIX.test(cmd?.[0] ?? '')) {
          ctx.issues.push({
            code: 'custom',
            input: cmd,
            path: ['execStartPre', index, 0],
            message: EXEC_PREFIX_MESSAGE,
          });
        }
      }
    }
    if (value.scope === 'user' && (value.user !== undefined || value.group !== undefined)) {
      ctx.issues.push({
        code: 'custom',
        input: value,
        path: ['scope'],
        message: "systemd user units cannot declare 'user' or 'group'",
      });
    }
    if (value.scope === 'user' && value.dynamicUser !== undefined) {
      ctx.issues.push({
        code: 'custom',
        input: value,
        path: ['dynamicUser'],
        message: "systemd user units cannot declare 'dynamicUser'",
      });
    }
    if (
      value.type === 'oneshot' &&
      (value.restart === 'always' || value.restart === 'on-success')
    ) {
      ctx.issues.push({
        code: 'custom',
        input: value,
        path: ['restart'],
        message: `systemd refuses Type=oneshot with Restart=${value.restart}`,
      });
    }
    if (
      value.restrictAddressFamilies?.includes('none') &&
      value.restrictAddressFamilies.length > 1
    ) {
      ctx.issues.push({
        code: 'custom',
        input: value.restrictAddressFamilies,
        path: ['restrictAddressFamilies'],
        message: "restrictAddressFamilies cannot combine 'none' with AF_* families",
      });
    }
  });

/** Input configuration accepted by {@link renderSystemdServiceUnit}. */
export type SystemdServiceUnitConfig = z.input<typeof SystemdServiceUnitConfigSchema>;

type ParsedServiceUnit = z.output<typeof SystemdServiceUnitConfigSchema>;

function renderUnitSection(parsed: ParsedServiceUnit, allowHome: boolean): string[] {
  const unitLines: string[] = [
    '[Unit]',
    `Description=${formatSystemdScalar('description', parsed.description, allowHome)}`,
  ];
  if (parsed.after && parsed.after.length > 0) {
    const items = parsed.after.map((item, i) =>
      formatSystemdScalar(`after[${i}]`, item, false, true),
    );
    unitLines.push(`After=${items.join(' ')}`);
  }
  if (parsed.wants && parsed.wants.length > 0) {
    const items = parsed.wants.map((item, i) =>
      formatSystemdScalar(`wants[${i}]`, item, false, true),
    );
    unitLines.push(`Wants=${items.join(' ')}`);
  }
  if (parsed.startLimitIntervalSec !== undefined) {
    unitLines.push(
      `StartLimitIntervalSec=${formatSystemdDuration('startLimitIntervalSec', parsed.startLimitIntervalSec)}`,
    );
  }
  return unitLines;
}

function formatTriStateBoolean(value: boolean | string): string {
  return typeof value === 'boolean' ? (value ? 'yes' : 'no') : value;
}

function renderServiceSection(parsed: ParsedServiceUnit, allowHome: boolean): string[] {
  const serviceLines: string[] = ['[Service]'];
  if (parsed.type !== undefined) serviceLines.push(`Type=${parsed.type}`);
  if (parsed.dynamicUser !== undefined) {
    serviceLines.push(`DynamicUser=${parsed.dynamicUser ? 'yes' : 'no'}`);
  }
  if (parsed.user !== undefined) {
    serviceLines.push(`User=${formatSystemdScalar('user', parsed.user, false, true)}`);
  }
  if (parsed.group !== undefined) {
    serviceLines.push(`Group=${formatSystemdScalar('group', parsed.group, false, true)}`);
  }
  if (parsed.workingDirectory !== undefined) {
    serviceLines.push(
      `WorkingDirectory=${formatSystemdScalar('workingDirectory', parsed.workingDirectory, allowHome)}`,
    );
  }
  if (parsed.runtimeDirectory !== undefined) {
    const dirs = toStringList(parsed.runtimeDirectory).map((dir, i) =>
      formatSystemdScalar(`runtimeDirectory[${i}]`, dir, false, true),
    );
    if (dirs.length > 0) serviceLines.push(`RuntimeDirectory=${dirs.join(' ')}`);
  }
  if (parsed.runtimeDirectoryMode !== undefined) {
    serviceLines.push(`RuntimeDirectoryMode=${parsed.runtimeDirectoryMode}`);
  }
  if (parsed.stateDirectory !== undefined) {
    const dirs = toStringList(parsed.stateDirectory).map((dir, i) =>
      formatRelativeManagedDirectory(`stateDirectory[${i}]`, dir),
    );
    if (dirs.length > 0) serviceLines.push(`StateDirectory=${dirs.join(' ')}`);
  }
  if (parsed.stateDirectoryMode !== undefined) {
    serviceLines.push(`StateDirectoryMode=${parsed.stateDirectoryMode}`);
  }
  for (const [index, envFile] of toStringList(parsed.environmentFile).entries()) {
    serviceLines.push(
      `EnvironmentFile=${formatSystemdScalar(`environmentFile[${index}]`, envFile, allowHome)}`,
    );
  }
  if (parsed.environment !== undefined) {
    const sortedKeys = Object.keys(parsed.environment).sort();
    for (const key of sortedKeys) {
      const value = parsed.environment[key];
      if (value !== undefined) {
        serviceLines.push(formatSystemdEnvironmentLine(key, value, allowHome));
      }
    }
  }
  if (parsed.execStartPre !== undefined) {
    for (const [index, cmd] of parsed.execStartPre.entries()) {
      serviceLines.push(
        `ExecStartPre=${formatSystemdExecLine(`execStartPre[${index}]`, cmd, allowHome)}`,
      );
    }
  }
  serviceLines.push(
    `ExecStart=${formatSystemdExecLine('execStart', parsed.execStart, allowHome)}`,
  );
  const restart = parsed.restart ?? (parsed.type === 'oneshot' ? undefined : 'on-failure');
  if (restart !== undefined) serviceLines.push(`Restart=${restart}`);
  if (parsed.restartSec !== undefined) {
    serviceLines.push(
      `RestartSec=${formatSystemdScalar('restartSec', String(parsed.restartSec), false, true)}`,
    );
  }
  if (parsed.successExitStatus !== undefined) {
    const items = parsed.successExitStatus.map((item, i) => {
      const text = String(item);
      assertCleanValue(`successExitStatus[${i}]`, text);
      return text;
    });
    serviceLines.push(`SuccessExitStatus=${items.join(' ')}`);
  }
  if (parsed.timeoutStartSec !== undefined) {
    serviceLines.push(
      `TimeoutStartSec=${formatSystemdDuration('timeoutStartSec', parsed.timeoutStartSec)}`,
    );
  }
  if (parsed.timeoutStopSec !== undefined) {
    serviceLines.push(
      `TimeoutStopSec=${formatSystemdScalar('timeoutStopSec', String(parsed.timeoutStopSec), false, true)}`,
    );
  }
  if (parsed.killMode !== undefined) serviceLines.push(`KillMode=${parsed.killMode}`);
  if (parsed.oomScoreAdjust !== undefined) {
    serviceLines.push(`OOMScoreAdjust=${parsed.oomScoreAdjust}`);
  }
  if (parsed.oomPolicy !== undefined) serviceLines.push(`OOMPolicy=${parsed.oomPolicy}`);
  if (parsed.ioAccounting !== undefined) {
    serviceLines.push(`IOAccounting=${parsed.ioAccounting ? 'yes' : 'no'}`);
  }
  if (parsed.nice !== undefined) serviceLines.push(`Nice=${parsed.nice}`);
  if (parsed.ioSchedulingClass !== undefined) {
    serviceLines.push(`IOSchedulingClass=${parsed.ioSchedulingClass}`);
  }
  if (parsed.umask !== undefined) serviceLines.push(`UMask=${parsed.umask}`);
  if (parsed.noNewPrivileges !== undefined) {
    serviceLines.push(`NoNewPrivileges=${parsed.noNewPrivileges ? 'yes' : 'no'}`);
  }
  if (parsed.privateNetwork !== undefined) {
    serviceLines.push(`PrivateNetwork=${parsed.privateNetwork ? 'yes' : 'no'}`);
  }
  if (parsed.privateTmp !== undefined) {
    serviceLines.push(`PrivateTmp=${parsed.privateTmp ? 'yes' : 'no'}`);
  }
  if (parsed.protectSystem !== undefined) {
    serviceLines.push(`ProtectSystem=${formatTriStateBoolean(parsed.protectSystem)}`);
  }
  if (parsed.protectHome !== undefined) {
    serviceLines.push(`ProtectHome=${formatTriStateBoolean(parsed.protectHome)}`);
  }
  if (parsed.restrictAddressFamilies !== undefined) {
    serviceLines.push(`RestrictAddressFamilies=${parsed.restrictAddressFamilies.join(' ')}`);
  }
  if (parsed.bindReadOnlyPaths !== undefined) {
    for (const [index, entry] of parsed.bindReadOnlyPaths.entries()) {
      serviceLines.push(
        `BindReadOnlyPaths=${formatBindReadOnlyPath(`bindReadOnlyPaths[${index}]`, entry)}`,
      );
    }
  }
  if (parsed.limitNOFILE !== undefined) {
    serviceLines.push(`LimitNOFILE=${parsed.limitNOFILE}`);
  }
  return serviceLines;
}

function renderInstallSection(parsed: ParsedServiceUnit): string[] | undefined {
  if (parsed.wantedBy !== undefined && parsed.wantedBy.length === 0) return undefined;
  const wantedBy =
    parsed.wantedBy ?? (parsed.scope === 'user' ? ['default.target'] : ['multi-user.target']);
  const targets = wantedBy.map((item, i) =>
    formatSystemdScalar(`wantedBy[${i}]`, item, false, true),
  );
  return ['[Install]', `WantedBy=${targets.join(' ')}`];
}

/**
 * Render a deterministic systemd `.service` unit file with strict escaping for
 * `%` (`%%`, with explicit `%h` opt-in via `allowHomeSpecifier`), `\` (`\\`),
 * `"` (`\"`), and `$` (`$$` in `ExecStart*`, literal `$` in `Environment`),
 * refusing newline/CR/NUL directive injection and trailing-backslash continuations.
 */
export function renderSystemdServiceUnit(config: SystemdServiceUnitConfig): string {
  const parsedResult = SystemdServiceUnitConfigSchema.safeParse(config);
  if (!parsedResult.success) {
    throw new SystemdUnitError(
      'INVALID_CONFIG',
      `Invalid systemd unit configuration: ${parsedResult.error.message}`,
      { cause: parsedResult.error },
    );
  }
  const parsed = parsedResult.data;
  const allowHome = parsed.allowHomeSpecifier;
  const sections: string[] = [
    renderUnitSection(parsed, allowHome).join('\n'),
    renderServiceSection(parsed, allowHome).join('\n'),
  ];
  const install = renderInstallSection(parsed);
  if (install !== undefined) sections.push(install.join('\n'));
  return `${sections.join('\n\n')}\n`;
}
