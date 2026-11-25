/** Single-pass CLI invocation scanner: app globals, framework flags and command routing. */
import type { z } from 'zod';
import {
  brokenBooleanBoundaryError,
  type CliFrameworkOptions,
  classifyLongOptionToken,
  coerceAppGlobalMap,
  createFrameworkStepContext,
  deferScanError,
  type FrameworkStepContext,
  finalizeFrameworkView,
  isCliVersionToken,
  isOptionShapedToken,
  isOptionToken,
  isTopHelpOption,
  markCommandTokenRemoved,
  pushCommandToken,
  pushRestToken,
  readFrameworkOptionToken,
  recordAppGlobalError,
  reservedJsonTarget,
  tryReadAppGlobalToken,
  withoutCommandSeparations,
} from './args-classify';
import {
  describeSchemaFields,
  type FieldInfo,
  parseCliGlobalValues,
  separateBoolValue,
} from './args-fields';
import { CliArgumentError } from './argument-error';

export type { CliFrameworkOptions };

/** Options accepted by {@link scanCliInvocation}. */
export interface CliInvocationScanOptions<TGlobals extends z.ZodObject = z.ZodObject> {
  /** Application-owned global option schema lifted before `--`. */
  appGlobals?: TGlobals;
  /** Command selected when `argv` has no explicit command or starts with command flags. */
  defaultCommand?: string;
}

/** Result of one single-pass {@link scanCliInvocation} scan. */
export interface CliInvocationScan<TGlobals extends z.ZodObject = z.ZodObject> {
  /** Parsed framework flags. */
  framework: CliFrameworkOptions;
  /** Validated application global options (or `{}` when no `appGlobals` schema is given). */
  globals: z.output<TGlobals>;
  /** Selected command name, if any. */
  command?: string;
  /** Command-only tokens (application globals, framework flags and command name removed). */
  commandTokens: string[];
  /** Indices in `commandTokens` before which a framework or application global token was removed. */
  separatedBefore: ReadonlySet<number>;
  /** True when top-level help was requested. */
  topLevelHelp: boolean;
  /** Optional substring filter for top-level help. */
  helpFilter?: string;
  /** True when `--version` or `version` was requested before any command. */
  version: boolean;
}

/** What the projections pass to the shared scan beyond the public options. */
interface InternalCliScanOptions<TGlobals extends z.ZodObject>
  extends CliInvocationScanOptions<TGlobals> {
  /** Indices in `argv` that a caller already separated from the token before them. */
  separatedBefore?: ReadonlySet<number>;
  /** `argv` is one command's own argv: its name was already read, so no token routes. */
  afterCommand?: boolean;
}

/** Extended scan result consumed by thin projections (`routeCliArgv`, `extractCliGlobalOptions`). */
export interface InternalCliScan<TGlobals extends z.ZodObject = z.ZodObject>
  extends CliInvocationScan<TGlobals> {
  withoutGlobals: string[];
  withoutCommand: string[];
  /** Indices in `withoutCommand` before which the tokens were not adjacent on the line. */
  withoutCommandSeparatedBefore: ReadonlySet<number>;
  separatedBeforeGlobals: ReadonlySet<number>;
  deferredError?: CliArgumentError;
  appGlobalError?: CliArgumentError;
  /** A bare framework boolean separated from a boolean word: `withoutCommand` reads as adjacent. */
  boundaryError?: CliArgumentError;
  /** Indices in `withoutCommand` of each boolean word `boundaryError` names: not the flag's value. */
  boundarySeparatedBefore: ReadonlySet<number>;
  /** A lifted application global stood between a bare framework boolean and a boolean word: `withoutGlobals` reads as adjacent. */
  liftedBoundaryError?: CliArgumentError;
  separatorBeforeCommand: boolean;
  /** The first command option written where the command name belongs, on a CLI with no default command. */
  optionBeforeCommand?: CliArgumentError;
  leadingToken?: string;
  hadLeadingPrefix: boolean;
}

const EMPTY_FIELDS: ReadonlyMap<string, FieldInfo> = new Map();

/** The refusal of a command option written before the command name. */
function optionBeforeCommandError(token: string): CliArgumentError {
  const name = token.split('=')[0] ?? token;
  return new CliArgumentError(
    `${name} is an option of a command, not a command: put it after the command name (<command> ${token})`,
  );
}

/** Describe a bare option token (`--flag` or `-f`) that could consume the token after it. */
function bareOptionInfo(
  token: string | undefined,
): { name: string; frameworkBool: boolean } | undefined {
  if (token === undefined || token === '--' || token === '-h') return undefined;
  const opt = classifyLongOptionToken(token);
  if (opt) {
    return opt.inline
      ? undefined
      : { name: opt.name, frameworkBool: opt.globalKind === 'boolean' };
  }
  if (/^-[A-Za-z]$/.test(token)) return { name: token, frameworkBool: false };
  return undefined;
}

/**
 * A bare `--help` or `--schema` parted from a boolean word may have meant that word as its value:
 * the line asks for nothing, so its refusal is reported.
 */
function withdrawBrokenRequest(ctx: FrameworkStepContext, name: string): void {
  if (name === 'schema') {
    ctx.fw.schema = false;
    ctx.schemaInvalid = true;
  } else if (name === 'help') ctx.fw.help = false;
}

/** Single-pass scan shared by `scanCliInvocation`, `routeCliArgv` and `extractCliGlobalOptions`. */
export function scanCliArgv<TGlobals extends z.ZodObject = z.ZodObject>(
  argv: readonly string[],
  options: InternalCliScanOptions<TGlobals> = {},
): InternalCliScan<TGlobals> {
  const { appGlobals, defaultCommand } = options;
  const appFields = appGlobals ? describeSchemaFields(appGlobals) : EMPTY_FIELDS;
  const ctx = createFrameworkStepContext(argv, appFields, options.separatedBefore);
  ctx.commandFound = options.afterCommand === true;
  const appRaw = new Map<string, string[]>();
  const appJson = new Set<string>();
  const separatedBeforeGlobals = new Set<number>();
  let command: string | undefined;
  let topLevelHelp = false;
  let expectHelpFilter = false;
  let helpFilter: string | undefined;
  let version = false;
  let optionsEnded = false;
  let separatorBeforeCommand = false;
  let optionBeforeCommand: CliArgumentError | undefined;
  let leadingToken: string | undefined;
  let hadLeadingPrefix = false;
  let boundaryError: CliArgumentError | undefined;
  const boundarySeparatedBefore = new Set<number>();
  let liftedBoundaryError: CliArgumentError | undefined;
  // The bare option a lifted application global was removed after, until the next kept token.
  let liftedAfter: { name: string; frameworkBool: boolean } | undefined;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;
    const bareBefore = liftedAfter;
    liftedAfter = undefined;
    if (optionsEnded) {
      pushCommandToken(ctx, token, i);
      continue;
    }
    if (token === '--') {
      ctx.bareBool = undefined;
      optionsEnded = true;
      if (!ctx.commandFound && !topLevelHelp && !version) {
        // Lifting globals does not end the line's meaning: the separator stays where it
        // stood, so a router reading the lifted argv refuses it as this scan does.
        separatorBeforeCommand = true;
        deferScanError(ctx, new CliArgumentError('A command is required before "--"'));
        pushRestToken(ctx, token, i);
      } else {
        pushCommandToken(ctx, token, i);
      }
      continue;
    }
    const opt = classifyLongOptionToken(token);
    const appNext = tryReadAppGlobalToken(ctx, i, opt, appRaw, appJson);
    if (appNext >= 0) {
      liftedAfter = bareBefore ?? bareOptionInfo(ctx.withoutGlobals.at(-1));
      markCommandTokenRemoved(ctx);
      i = appNext;
      continue;
    }
    if (bareBefore !== undefined) {
      if (bareBefore.frameworkBool && separateBoolValue(token) !== undefined) {
        // The word was never the flag's value, nor a command name: the line is refused unless
        // help or `--schema` answers it, and a projection that keeps argv keeps the separation.
        liftedBoundaryError ??= brokenBooleanBoundaryError(bareBefore.name, token);
        withdrawBrokenRequest(ctx, bareBefore.name);
        deferScanError(ctx, liftedBoundaryError);
        separatedBeforeGlobals.add(ctx.withoutGlobals.length);
      } else if (!bareBefore.frameworkBool && !isOptionToken(token)) {
        separatedBeforeGlobals.add(ctx.withoutGlobals.length);
      }
    }
    if (
      !ctx.commandFound &&
      !topLevelHelp &&
      !version &&
      (isTopHelpOption(token) || token === 'help' || isCliVersionToken(token))
    ) {
      ctx.bareBool = undefined;
      leadingToken = token;
      hadLeadingPrefix = ctx.withoutGlobals.length > 0;
      ctx.withoutGlobals.push(token);
      if (isCliVersionToken(token)) version = true;
      else {
        topLevelHelp = true;
        if (token.startsWith('--help=')) {
          helpFilter = token.slice('--help='.length).trim() || undefined;
        } else expectHelpFilter = true;
      }
      continue;
    }
    if (token === '-h') {
      ctx.bareBool = undefined;
      ctx.fw.help = true;
      markCommandTokenRemoved(ctx);
      pushRestToken(ctx, token, i);
      continue;
    }
    const jsonTarget = reservedJsonTarget(opt);
    if (jsonTarget !== undefined) {
      ctx.bareBool = undefined;
      if (jsonTarget === 'schema') {
        ctx.fw.schema = false;
        ctx.schemaInvalid = true;
      } else if (jsonTarget === 'help') ctx.fw.help = false;
      deferScanError(
        ctx,
        new CliArgumentError(
          `--${jsonTarget} is a framework option and does not accept :=JSON`,
        ),
      );
      markCommandTokenRemoved(ctx);
      pushRestToken(ctx, token, i);
      continue;
    }
    if (opt?.globalKind !== undefined) {
      markCommandTokenRemoved(ctx);
      i = readFrameworkOptionToken(ctx, i, token, opt);
      continue;
    }
    if (topLevelHelp || version) {
      if (topLevelHelp && expectHelpFilter) {
        expectHelpFilter = false;
        if (!token.startsWith('-')) helpFilter = token;
      }
      pushRestToken(ctx, token, i);
      continue;
    }
    if (!ctx.commandFound) {
      if (defaultCommand !== undefined && isOptionShapedToken(token)) {
        command = defaultCommand;
        ctx.commandFound = true;
      } else if (isOptionShapedToken(token)) {
        // No command takes options before its name: the line is wrong, not a command
        // named after an option. The token stays in place for the projections that keep argv.
        optionBeforeCommand ??= optionBeforeCommandError(token);
        deferScanError(ctx, optionBeforeCommand);
        pushRestToken(ctx, token, i);
        continue;
      } else {
        command = token;
        ctx.commandFound = true;
        ctx.withoutGlobals.push(token);
        if (ctx.bareBool) ctx.bareBool.removedAfter = true;
        continue;
      }
    }
    if (ctx.bareBool?.removedAfter && separateBoolValue(token) !== undefined) {
      withdrawBrokenRequest(ctx, ctx.bareBool.name);
      boundaryError ??= brokenBooleanBoundaryError(ctx.bareBool.name, token);
      deferScanError(ctx, boundaryError);
      boundarySeparatedBefore.add(ctx.withoutCommand.length);
    }
    ctx.bareBool = undefined;
    pushCommandToken(ctx, token, i);
  }
  finalizeFrameworkView(ctx);
  let globals: z.output<TGlobals> = parseCliGlobalValues<TGlobals>(undefined, {});
  try {
    const rawGlobals = coerceAppGlobalMap(appRaw, appFields, appJson);
    globals = parseCliGlobalValues(appGlobals, rawGlobals);
  } catch (error) {
    if (error instanceof CliArgumentError) recordAppGlobalError(ctx, error);
    else throw error;
  }
  if (!ctx.commandFound && !topLevelHelp && !version && !separatorBeforeCommand) {
    if (defaultCommand !== undefined) command = defaultCommand;
    else if (ctx.deferredError === undefined || ctx.fw.help) topLevelHelp = true;
  }
  return {
    framework: ctx.fw,
    globals,
    ...(command !== undefined && { command }),
    commandTokens: ctx.commandTokens,
    separatedBefore: ctx.separatedBefore,
    topLevelHelp,
    ...(helpFilter !== undefined && { helpFilter }),
    version,
    withoutGlobals: ctx.withoutGlobals,
    withoutCommand: ctx.withoutCommand,
    withoutCommandSeparatedBefore: withoutCommandSeparations(ctx),
    separatedBeforeGlobals,
    ...(ctx.deferredError !== undefined && { deferredError: ctx.deferredError }),
    ...(ctx.appGlobalError !== undefined && { appGlobalError: ctx.appGlobalError }),
    ...(boundaryError !== undefined && { boundaryError }),
    boundarySeparatedBefore,
    ...(liftedBoundaryError !== undefined && { liftedBoundaryError }),
    separatorBeforeCommand,
    ...(optionBeforeCommand !== undefined && { optionBeforeCommand }),
    ...(leadingToken !== undefined && { leadingToken }),
    hadLeadingPrefix,
  };
}

/**
 * Whether the line is answered before any argument is read — top-level help, `--version`,
 * command help or `--schema`. Such a line reports no argument error; every projection asks
 * this one question.
 */
export function answersBeforeArguments(scan: InternalCliScan): boolean {
  return scan.topLevelHelp || scan.version || scan.framework.help || scan.framework.schema;
}

/** Single-pass CLI scan: globals, framework flags, route and argument errors. */
export function scanCliInvocation<TGlobals extends z.ZodObject = z.ZodObject>(
  argv: readonly string[],
  options?: CliInvocationScanOptions<TGlobals>,
): CliInvocationScan<TGlobals> {
  const res = scanCliArgv(argv, options);
  if (!answersBeforeArguments(res) && res.deferredError !== undefined) throw res.deferredError;
  return {
    framework: res.framework,
    globals: res.globals,
    ...(res.command !== undefined && { command: res.command }),
    commandTokens: res.commandTokens,
    separatedBefore: res.separatedBefore,
    topLevelHelp: res.topLevelHelp,
    ...(res.helpFilter !== undefined && { helpFilter: res.helpFilter }),
    version: res.version,
  };
}
