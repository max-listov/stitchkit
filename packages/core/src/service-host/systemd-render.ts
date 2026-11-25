import { z } from 'zod';

/** Systemd manager scope: host-wide (`system`) or per-user (`user`). */
export const SystemdScopeSchema = z.enum(['system', 'user']);

/** Systemd manager scope inferred from {@link SystemdScopeSchema}. */
export type SystemdScope = z.infer<typeof SystemdScopeSchema>;

/** Failure classifications thrown by {@link SystemdUnitError}. */
export type SystemdUnitErrorCode =
  | 'INVALID_CONFIG'
  | 'FOREIGN_DROP_IN'
  | 'FOREIGN_FRAGMENT'
  | 'UNSUPPORTED_UNIT_TYPE'
  | 'COMMAND_FAILED'
  | 'START_TIMEOUT'
  | 'UNSTABLE_CANDIDATE';

/**
 * Structured error thrown by systemd unit rendering, validation, installation,
 * and reload operations. Carries rollback evidence when a candidate rollout
 * fails after writing the unit file.
 */
export class SystemdUnitError extends Error {
  readonly code: SystemdUnitErrorCode;
  readonly rolledBack: boolean;
  readonly rollbackError: unknown;
  readonly foreignDropIns: readonly string[] | undefined;

  constructor(
    code: SystemdUnitErrorCode,
    message: string,
    options?: ErrorOptions & {
      rolledBack?: boolean;
      rollbackError?: unknown;
      foreignDropIns?: readonly string[];
    },
  ) {
    super(message, options);
    this.name = 'SystemdUnitError';
    this.code = code;
    this.rolledBack = options?.rolledBack ?? false;
    this.rollbackError = options?.rollbackError;
    this.foreignDropIns = options?.foreignDropIns;
  }
}

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
// systemd reads these before it unquotes the executable: `-` ignores failure, `@` replaces
// argv[0], `:` skips variable substitution, `+` and `!` change the privileges of the command.
const EXEC_PREFIX = /^[-@:+!]/;
const EXEC_PREFIX_MESSAGE =
  "the executable must not start with one of systemd's prefixes (-, @, :, +, !): quoting does not disarm them";

function hasLineBreakOrNul(value: string): boolean {
  return value.includes('\n') || value.includes('\r') || value.includes('\0');
}

function assertCleanValue(field: string, value: string): void {
  if (hasLineBreakOrNul(value)) {
    throw new SystemdUnitError(
      'INVALID_CONFIG',
      `Systemd field '${field}' must not contain newline, carriage return, or NUL characters`,
    );
  }
}

function assertNoWhitespace(field: string, value: string): void {
  if (/\s/.test(value)) {
    throw new SystemdUnitError(
      'INVALID_CONFIG',
      `Systemd field '${field}' must not contain whitespace: ${JSON.stringify(value)}`,
    );
  }
}

function escapeSystemdSpecifiers(value: string, allowHomeSpecifier: boolean): string {
  if (!allowHomeSpecifier) return value.replaceAll('%', '%%');
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index];
    if (ch === '%') {
      const next = value[index + 1];
      if (next === '%') {
        // Treat '%%' as an atomic literal pair so '%%h' never becomes a '%h' expansion.
        result += '%%%%';
        index += 1;
      } else if (next === 'h') {
        result += '%h';
        index += 1;
      } else {
        result += '%%';
      }
    } else {
      result += ch;
    }
  }
  return result;
}

function formatSystemdExecToken(
  field: string,
  token: string,
  allowHomeSpecifier: boolean,
): string {
  assertCleanValue(field, token);
  const specEscaped = escapeSystemdSpecifiers(token, allowHomeSpecifier);
  // String.prototype.replaceAll treats '$$' as a single '$' in the replacement string,
  // so '$$$$' yields two literal '$' characters ('$$').
  const safeDollar = specEscaped.replaceAll('$', '$$$$');
  const needsQuotes = token.length === 0 || /[\s"'\\;]/.test(token);
  if (!needsQuotes) return safeDollar;
  const quoted = safeDollar.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `"${quoted}"`;
}

function formatSystemdExecLine(
  field: string,
  argv: readonly string[],
  allowHomeSpecifier: boolean,
): string {
  return argv
    .map((token, index) =>
      formatSystemdExecToken(`${field}[${index}]`, token, allowHomeSpecifier),
    )
    .join(' ');
}

function formatSystemdEnvironmentLine(
  key: string,
  value: string,
  allowHomeSpecifier: boolean,
): string {
  if (!ENV_KEY_PATTERN.test(key)) {
    throw new SystemdUnitError(
      'INVALID_CONFIG',
      `Invalid systemd environment variable name: ${JSON.stringify(key)}`,
    );
  }
  assertCleanValue(`environment.${key}`, value);
  // systemd expands % specifiers in Environment= but does NOT perform $VAR expansion.
  const specEscaped = escapeSystemdSpecifiers(value, allowHomeSpecifier);
  const quoted = specEscaped.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `Environment="${key}=${quoted}"`;
}

function formatSystemdScalar(
  field: string,
  value: string,
  allowHomeSpecifier: boolean,
  forbidWhitespace = false,
): string {
  assertCleanValue(field, value);
  if (value.endsWith('\\')) {
    throw new SystemdUnitError(
      'INVALID_CONFIG',
      `Systemd field '${field}' must not end with a trailing backslash (line continuation)`,
    );
  }
  if (forbidWhitespace) assertNoWhitespace(field, value);
  return escapeSystemdSpecifiers(value, allowHomeSpecifier);
}

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
      .default('on-failure'),
    restartSec: z.union([z.number().nonnegative(), z.string().min(1)]).optional(),
    timeoutStopSec: z.union([z.number().positive(), z.string().min(1)]).optional(),
    killMode: z.enum(['control-group', 'mixed', 'process', 'none']).optional(),
    oomScoreAdjust: z.number().int().min(-1000).max(1000).optional(),
    oomPolicy: z.enum(['continue', 'stop', 'kill']).optional(),
    ioAccounting: z.boolean().optional(),
    umask: z
      .string()
      .regex(/^0?[0-7]{3,4}$/)
      .optional(),
    noNewPrivileges: z.boolean().optional(),
    runtimeDirectory: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
    limitNOFILE: z.union([z.number().int().positive(), z.literal('infinity')]).optional(),
    after: z.array(z.string().min(1)).optional(),
    wants: z.array(z.string().min(1)).optional(),
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
  });

/** Input configuration accepted by {@link renderSystemdServiceUnit}. */
export type SystemdServiceUnitConfig = z.input<typeof SystemdServiceUnitConfigSchema>;

function toStringList(value: string | readonly string[] | undefined): readonly string[] {
  if (value === undefined) return [];
  return typeof value === 'string' ? [value] : value;
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

  const serviceLines: string[] = ['[Service]'];
  if (parsed.type !== undefined) serviceLines.push(`Type=${parsed.type}`);
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
  serviceLines.push(`Restart=${parsed.restart}`);
  if (parsed.restartSec !== undefined) {
    const text = String(parsed.restartSec);
    serviceLines.push(`RestartSec=${formatSystemdScalar('restartSec', text, false, true)}`);
  }
  if (parsed.timeoutStopSec !== undefined) {
    const text = String(parsed.timeoutStopSec);
    serviceLines.push(
      `TimeoutStopSec=${formatSystemdScalar('timeoutStopSec', text, false, true)}`,
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
  if (parsed.umask !== undefined) serviceLines.push(`UMask=${parsed.umask}`);
  if (parsed.noNewPrivileges !== undefined) {
    serviceLines.push(`NoNewPrivileges=${parsed.noNewPrivileges ? 'yes' : 'no'}`);
  }
  if (parsed.limitNOFILE !== undefined) {
    serviceLines.push(`LimitNOFILE=${parsed.limitNOFILE}`);
  }

  const wantedBy =
    parsed.wantedBy ?? (parsed.scope === 'user' ? ['default.target'] : ['multi-user.target']);
  const installLines: string[] = ['[Install]'];
  if (wantedBy.length > 0) {
    const targets = wantedBy.map((item, i) =>
      formatSystemdScalar(`wantedBy[${i}]`, item, false, true),
    );
    installLines.push(`WantedBy=${targets.join(' ')}`);
  }

  return `${unitLines.join('\n')}\n\n${serviceLines.join('\n')}\n\n${installLines.join('\n')}\n`;
}
