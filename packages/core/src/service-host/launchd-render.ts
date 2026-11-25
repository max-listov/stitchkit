import { z } from 'zod';
import {
  assertPlistXmlSafe,
  escapePlistXml,
  renderPlistDocument,
  renderPlistStringElement,
} from './plist-xml';

/** Failure classifications thrown by {@link LaunchdJobError}. */
export type LaunchdJobErrorCode =
  | 'INVALID_CONFIG'
  | 'INVALID_PLIST'
  | 'FOREIGN_FRAGMENT'
  | 'COMMAND_FAILED'
  | 'START_TIMEOUT'
  | 'PROGRAM_MISMATCH'
  | 'UNSTABLE_CANDIDATE';

/**
 * Structured error thrown by launchd plist rendering, validation, inspection,
 * and reload operations. Carries rollback evidence when a candidate rollout fails.
 */
export class LaunchdJobError extends Error {
  readonly code: LaunchdJobErrorCode;
  readonly rolledBack: boolean;
  readonly rollbackError: unknown;

  constructor(
    code: LaunchdJobErrorCode,
    message: string,
    options?: ErrorOptions & { rolledBack?: boolean; rollbackError?: unknown },
  ) {
    super(message, options);
    this.name = 'LaunchdJobError';
    this.code = code;
    this.rolledBack = options?.rolledBack ?? false;
    this.rollbackError = options?.rollbackError;
  }
}

/** Structured `KeepAlive` dictionary supported by macOS LaunchAgent plists. */
export const LaunchdKeepAliveSchema = z.strictObject({
  successfulExit: z.boolean().optional(),
  crashed: z.boolean().optional(),
  networkState: z.boolean().optional(),
});

/** Supported `LimitLoadToSessionType` values for macOS launchd plists. */
export const LaunchdSessionTypeSchema = z.enum([
  'Aqua',
  'Background',
  'LoginWindow',
  'StandardIO',
  'System',
]);

/** Valid `LimitLoadToSessionType` session name. */
export type LaunchdSessionType = z.infer<typeof LaunchdSessionTypeSchema>;

function isValidIdentifierToken(value: string): boolean {
  return !value.includes('/') && !value.includes('\\') && !/\s/.test(value);
}

/** Zod schema for rendering a macOS LaunchAgent `.plist` XML document. */
export const LaunchdPlistConfigSchema = z
  .strictObject({
    label: z.string().min(1),
    programArguments: z.array(z.string()).min(1),
    environmentVariables: z.record(z.string(), z.string()).optional(),
    workingDirectory: z.string().min(1).optional(),
    keepAlive: z.union([z.boolean(), LaunchdKeepAliveSchema]).default(true),
    runAtLoad: z.boolean().default(true),
    standardOutPath: z.string().min(1).optional(),
    standardErrorPath: z.string().min(1).optional(),
    throttleInterval: z.number().int().nonnegative().optional(),
    processType: z.enum(['Background', 'Standard', 'Adaptive', 'Interactive']).optional(),
    associatedBundleIdentifiers: z
      .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
      .optional(),
    limitLoadToSessionType: LaunchdSessionTypeSchema.optional(),
  })
  .check((ctx) => {
    const value = ctx.value;
    if ((value.programArguments[0] ?? '').length === 0) {
      ctx.issues.push({
        code: 'custom',
        input: value.programArguments,
        path: ['programArguments', 0],
        message: 'programArguments[0] must be a non-empty executable path',
      });
    }
    if (!isValidIdentifierToken(value.label)) {
      ctx.issues.push({
        code: 'custom',
        input: value.label,
        path: ['label'],
        message: 'LaunchAgent label must not contain whitespace or path separators',
      });
    }
    const associated = value.associatedBundleIdentifiers;
    if (typeof associated === 'string') {
      if (!isValidIdentifierToken(associated)) {
        ctx.issues.push({
          code: 'custom',
          input: associated,
          path: ['associatedBundleIdentifiers'],
          message:
            'associatedBundleIdentifiers must not contain whitespace or path separators',
        });
      }
    } else if (Array.isArray(associated)) {
      for (let index = 0; index < associated.length; index += 1) {
        const entry = associated[index];
        if (entry !== undefined && !isValidIdentifierToken(entry)) {
          ctx.issues.push({
            code: 'custom',
            input: entry,
            path: ['associatedBundleIdentifiers', index],
            message:
              'associatedBundleIdentifiers entries must not contain whitespace or path separators',
          });
        }
      }
    }
  });

/** Input configuration accepted by {@link renderLaunchdPlist}. */
export type LaunchdPlistConfig = z.input<typeof LaunchdPlistConfigSchema>;

/** Parsed status of a job reported by `launchctl print gui/<uid>/<label>`. */
export interface LaunchdJobInspection {
  loaded: boolean;
  state: string | null;
  program: string | null;
  pid: number | null;
  path: string | null;
  lastExitCode: number | null;
}

const configError = (message: string): Error => new LaunchdJobError('INVALID_CONFIG', message);

/**
 * `launchctl print` shows arguments and environment values unescaped, so a line
 * break inside one reads as a property of the job — `\n\t}\n\tprogram = …` closes
 * the block and names another program. Such a value is refused; a multi-line
 * script goes to a file the job runs.
 */
function assertSingleLine(field: string, value: string): void {
  if (value.includes('\n'))
    throw configError(
      `${field} must not contain a line break: launchctl print shows it unescaped`,
    );
}

function xmlString(field: string, value: string, allowWhitespaceControls = false): string {
  return renderPlistStringElement(field, value, {
    allowWhitespaceControls,
    createError: configError,
  });
}

/**
 * Render a deterministic Apple XML 1.0 LaunchAgent `.plist` with strict XML
 * escaping (including `&#13;` for carriage return) and rejection of NUL /
 * invalid control characters and malformed environment variable keys.
 */
export function renderLaunchdPlist(config: LaunchdPlistConfig): string {
  const parsedResult = LaunchdPlistConfigSchema.safeParse(config);
  if (!parsedResult.success) {
    throw new LaunchdJobError(
      'INVALID_CONFIG',
      `Invalid launchd plist configuration: ${parsedResult.error.message}`,
      { cause: parsedResult.error },
    );
  }
  const parsed = parsedResult.data;
  const entries: string[] = [`    <key>Label</key>\n    ${xmlString('label', parsed.label)}`];

  if (parsed.associatedBundleIdentifiers !== undefined) {
    if (typeof parsed.associatedBundleIdentifiers === 'string') {
      entries.push(
        `    <key>AssociatedBundleIdentifiers</key>\n    ${xmlString('associatedBundleIdentifiers', parsed.associatedBundleIdentifiers)}`,
      );
    } else {
      const idLines = parsed.associatedBundleIdentifiers.map(
        (id, index) => `      ${xmlString(`associatedBundleIdentifiers[${index}]`, id)}`,
      );
      entries.push(
        `    <key>AssociatedBundleIdentifiers</key>\n    <array>\n${idLines.join('\n')}\n    </array>`,
      );
    }
  }

  const argLines = parsed.programArguments.map((arg, index) => {
    assertSingleLine(`programArguments[${index}]`, arg);
    return `      ${xmlString(`programArguments[${index}]`, arg, index > 0)}`;
  });
  entries.push(
    `    <key>ProgramArguments</key>\n    <array>\n${argLines.join('\n')}\n    </array>`,
  );

  if (parsed.workingDirectory !== undefined) {
    entries.push(
      `    <key>WorkingDirectory</key>\n    ${xmlString('workingDirectory', parsed.workingDirectory)}`,
    );
  }

  if (parsed.environmentVariables !== undefined) {
    const keys = Object.keys(parsed.environmentVariables).sort();
    if (keys.length > 0) {
      const envLines: string[] = [];
      for (const key of keys) {
        const value = parsed.environmentVariables[key];
        if (value === undefined) continue;
        if (key.length === 0 || key.includes('=')) {
          throw new LaunchdJobError(
            'INVALID_CONFIG',
            `Invalid launchd environment variable key: ${JSON.stringify(key)}`,
          );
        }
        assertPlistXmlSafe(`environmentVariables.${key}`, key, false, configError);
        envLines.push(`      <key>${escapePlistXml(key)}</key>`);
        assertSingleLine(`environmentVariables.${key}`, value);
        envLines.push(`      ${xmlString(`environmentVariables.${key}`, value, true)}`);
      }
      entries.push(
        `    <key>EnvironmentVariables</key>\n    <dict>\n${envLines.join('\n')}\n    </dict>`,
      );
    }
  }

  if (typeof parsed.keepAlive === 'boolean') {
    entries.push(`    <key>KeepAlive</key>\n    <${parsed.keepAlive ? 'true' : 'false'}/>`);
  } else {
    const keepLines: string[] = [];
    if (parsed.keepAlive.successfulExit !== undefined) {
      keepLines.push(
        `      <key>SuccessfulExit</key>\n      <${parsed.keepAlive.successfulExit ? 'true' : 'false'}/>`,
      );
    }
    if (parsed.keepAlive.crashed !== undefined) {
      keepLines.push(
        `      <key>Crashed</key>\n      <${parsed.keepAlive.crashed ? 'true' : 'false'}/>`,
      );
    }
    if (parsed.keepAlive.networkState !== undefined) {
      keepLines.push(
        `      <key>NetworkState</key>\n      <${parsed.keepAlive.networkState ? 'true' : 'false'}/>`,
      );
    }
    entries.push(`    <key>KeepAlive</key>\n    <dict>\n${keepLines.join('\n')}\n    </dict>`);
  }

  entries.push(`    <key>RunAtLoad</key>\n    <${parsed.runAtLoad ? 'true' : 'false'}/>`);

  if (parsed.standardOutPath !== undefined) {
    entries.push(
      `    <key>StandardOutPath</key>\n    ${xmlString('standardOutPath', parsed.standardOutPath)}`,
    );
  }
  if (parsed.standardErrorPath !== undefined) {
    entries.push(
      `    <key>StandardErrorPath</key>\n    ${xmlString('standardErrorPath', parsed.standardErrorPath)}`,
    );
  }
  if (parsed.throttleInterval !== undefined) {
    entries.push(
      `    <key>ThrottleInterval</key>\n    <integer>${parsed.throttleInterval}</integer>`,
    );
  }
  if (parsed.processType !== undefined) {
    entries.push(
      `    <key>ProcessType</key>\n    ${xmlString('processType', parsed.processType)}`,
    );
  }
  if (parsed.limitLoadToSessionType !== undefined) {
    entries.push(
      `    <key>LimitLoadToSessionType</key>\n    ${xmlString('limitLoadToSessionType', parsed.limitLoadToSessionType)}`,
    );
  }

  return renderPlistDocument(entries);
}

/**
 * Parse the stdout of `launchctl print gui/<uid>/<label>`, matching only
 * single-tab top-level job properties (`state`, `program`, `pid`, `path`,
 * `last exit code`) so values inside nested dictionaries (`environment`,
 * `arguments`) containing `{` or `}` cannot corrupt the parser. A value with a
 * line break can still forge a property inside a block, so each property keeps
 * the value on its own side of the blocks: launchd prints `state`, `program` and
 * `path` above them (the first value wins) and `pid` and `last exit code` below
 * them (the last value wins).
 */
export function parseLaunchctlPrint(stdout: string): LaunchdJobInspection {
  let inJob = false;
  let inNestedBlock = false;
  let state: string | null = null;
  let program: string | null = null;
  let pid: number | null = null;
  let path: string | null = null;
  let lastExitCode: number | null = null;

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.length === 0) continue;

    if (!inJob) {
      if (!line.startsWith('\t') && line.endsWith('{')) {
        inJob = true;
      }
      continue;
    }

    if (inNestedBlock) {
      if (line === '\t}') inNestedBlock = false;
      continue;
    }

    if (line === '}') {
      inJob = false;
      continue;
    }

    if (!line.startsWith('\t') || line.startsWith('\t\t')) continue;

    const body = line.slice(1);
    if (body.endsWith('{')) {
      inNestedBlock = true;
      continue;
    }

    const eq = body.indexOf(' = ');
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    const value = body.slice(eq + 3).trim();
    if (key === 'state' && value.length > 0) state ??= value;
    else if (key === 'program' && value.length > 0) program ??= value;
    else if (key === 'path' && value.length > 0) path ??= value;
    else if (key === 'pid' && /^\d+$/.test(value)) {
      const parsedPid = Number(value);
      if (Number.isSafeInteger(parsedPid) && parsedPid > 0) pid = parsedPid;
    } else if (key === 'last exit code' && /^-?\d+$/.test(value)) {
      const parsedCode = Number(value);
      if (Number.isSafeInteger(parsedCode)) lastExitCode = parsedCode;
    }
  }

  return {
    loaded: true,
    state,
    program,
    pid,
    path,
    lastExitCode,
  };
}
