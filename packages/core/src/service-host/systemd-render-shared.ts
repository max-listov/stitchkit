import { z } from 'zod';
import { isAbsoluteNormalPath } from './host-adapter';

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

export const OCTAL_MODE_PATTERN = /^[0-7]{3,4}$/;
export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
// systemd reads these before it unquotes the executable: `-` ignores failure, `@` replaces
// argv[0], `:` skips variable substitution, `+` and `!` change the privileges of the command.
export const EXEC_PREFIX = /^[-@:+!]/;
export const EXEC_PREFIX_MESSAGE =
  "the executable must not start with one of systemd's prefixes (-, @, :, +, !): quoting does not disarm them";

/**
 * Valid systemd monotonic timespan token (e.g. `15min`, `1h`, `30s`, `500ms`, `1.5s`, `0`).
 * Rejects newlines, specifiers, quotes, and arbitrary trailing tokens.
 */
const SYSTEMD_TIMESPAN_UNIT =
  '(?:usec|us|msec|ms|seconds|second|sec|s|minutes|minute|min|m|hours|hour|hr|h|days|day|d|weeks|week|w|months|month|M|years|year|y)';
export const SYSTEMD_TIMESPAN_PATTERN = new RegExp(
  `^\\d+(?:\\.\\d+)?${SYSTEMD_TIMESPAN_UNIT}?(?:\\s+\\d+(?:\\.\\d+)?${SYSTEMD_TIMESPAN_UNIT}?)*$`,
);

/** POSIX signals accepted by systemd `SuccessExitStatus=` alongside exit codes 0..255. */
export const SYSTEMD_SIGNAL_PATTERN =
  /^(?:SIG)?(?:HUP|INT|QUIT|ILL|TRAP|ABRT|BUS|FPE|KILL|USR1|SEGV|USR2|PIPE|ALRM|TERM|CHLD|CONT|STOP|TSTP|TTIN|TTOU|URG|XCPU|XFSZ|VTALRM|PROF|WINCH|IO|PWR|SYS)$/;

/** Upper bound matching systemd's 64-bit microsecond duration representation (in whole seconds). */
export const MAX_SYSTEMD_INTERVAL_SECONDS = 18_446_744_073_708;

export const SystemdIntervalSecondsSchema = z
  .number()
  .nonnegative()
  .max(MAX_SYSTEMD_INTERVAL_SECONDS);

export const SystemdTimespanSchema = z.union([
  SystemdIntervalSecondsSchema,
  z.string().regex(SYSTEMD_TIMESPAN_PATTERN, 'must be a valid systemd timespan'),
]);

export const SystemdTimeoutSchema = z.union([
  SystemdIntervalSecondsSchema,
  z.literal('infinity'),
  z.string().regex(SYSTEMD_TIMESPAN_PATTERN, 'must be a valid systemd timespan or "infinity"'),
]);

export const SystemdBindReadOnlyPathSchema = z.union([
  z.string().min(1),
  z.strictObject({
    source: z.string().min(1),
    target: z.string().min(1).optional(),
    ignoreMissing: z.boolean().optional(),
  }),
]);

/** One `BindReadOnlyPaths=` entry: either a path string or `{ source, target?, ignoreMissing? }`. */
export type SystemdBindReadOnlyPath = z.input<typeof SystemdBindReadOnlyPathSchema>;

export const SystemdSuccessExitStatusItemSchema = z.union([
  z.number().int().min(0).max(255),
  z.string().regex(SYSTEMD_SIGNAL_PATTERN, 'must be an exit code 0..255 or POSIX signal name'),
]);

export const SystemdAddressFamilySchema = z.union([
  z.literal('none'),
  z.string().regex(/^AF_[A-Z0-9_]+$/, 'must be "none" or an AF_* address family'),
]);

export function hasLineBreakOrNul(value: string): boolean {
  return value.includes('\n') || value.includes('\r') || value.includes('\0');
}

export function assertCleanValue(field: string, value: string): void {
  if (hasLineBreakOrNul(value)) {
    throw new SystemdUnitError(
      'INVALID_CONFIG',
      `Systemd field '${field}' must not contain newline, carriage return, or NUL characters`,
    );
  }
}

export function assertNoWhitespace(field: string, value: string): void {
  if (/\s/.test(value)) {
    throw new SystemdUnitError(
      'INVALID_CONFIG',
      `Systemd field '${field}' must not contain whitespace: ${JSON.stringify(value)}`,
    );
  }
}

export function escapeSystemdSpecifiers(value: string, allowHomeSpecifier: boolean): string {
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

export function formatSystemdExecToken(
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

export function formatSystemdExecLine(
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

export function formatSystemdEnvironmentLine(
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

export function formatSystemdScalar(
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

/** Format a finite non-negative duration number without scientific notation or rounding positive sub-µs values to 0. */
export function formatSystemdNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  if (value > 0 && value < 1e-6) {
    throw new SystemdUnitError(
      'INVALID_CONFIG',
      `Systemd numeric duration ${value} is below microsecond precision and would round to 0`,
    );
  }
  return value.toFixed(6).replace(/\.?0+$/, '');
}

export function formatSystemdDuration(
  field: string,
  value: number | string,
  forbidWhitespace = false,
): string {
  if (typeof value === 'number') return formatSystemdNumber(value);
  return formatSystemdScalar(field, value, false, forbidWhitespace);
}

export function toStringList(
  value: string | readonly string[] | undefined,
): readonly string[] {
  if (value === undefined) return [];
  return typeof value === 'string' ? [value] : value;
}

/** Validate and escape a relative directory name for `StateDirectory=` / `RuntimeDirectory=`. */
export function formatRelativeManagedDirectory(field: string, value: string): string {
  assertCleanValue(field, value);
  assertNoWhitespace(field, value);
  if (
    value.startsWith('/') ||
    value.endsWith('\\') ||
    value.includes(':') ||
    value.includes('\\') ||
    value.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')
  ) {
    throw new SystemdUnitError(
      'INVALID_CONFIG',
      `Systemd field '${field}' must be a relative normal directory name without ':', whitespace, or '..': ${JSON.stringify(value)}`,
    );
  }
  return escapeSystemdSpecifiers(value, false);
}

const BIND_FORBIDDEN_CHARS = /[\s:"'\\]/;

function assertBindPathSegment(field: string, path: string): string {
  assertCleanValue(field, path);
  if (!isAbsoluteNormalPath(path) || BIND_FORBIDDEN_CHARS.test(path)) {
    throw new SystemdUnitError(
      'INVALID_CONFIG',
      `Systemd field '${field}' must be an absolute normal path without whitespace, ':', quotes, or backslashes: ${JSON.stringify(path)}`,
    );
  }
  return escapeSystemdSpecifiers(path, false);
}

/** Validate and render a single `BindReadOnlyPaths=` entry. */
export function formatBindReadOnlyPath(field: string, entry: SystemdBindReadOnlyPath): string {
  if (typeof entry === 'string') {
    return assertBindPathSegment(field, entry);
  }
  const source = assertBindPathSegment(`${field}.source`, entry.source);
  const target =
    entry.target !== undefined
      ? `:${assertBindPathSegment(`${field}.target`, entry.target)}`
      : '';
  return `${entry.ignoreMissing ? '-' : ''}${source}${target}`;
}
