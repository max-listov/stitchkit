/**
 * Shell grammar classifier and single-token readers shared by `args-scan.ts`,
 * `args-route.ts` and `args-tokens.ts`. Leaf module with no cycle back to the scanner.
 */
import {
  appendCliOptionValue,
  type FieldInfo,
  isReservedBoolWord,
  parseReservedBool,
  separateBoolValue,
} from './args-fields';
import { appendCliFieldValue, cliFieldOption, coerceCliFieldValue } from './args-json';
import { type CliResultView, resolveCliView } from './args-view';
import { CliArgumentError } from './argument-error';

/**
 * Framework-owned CLI flags parsed out of an invocation:
 * `--json`, `--quiet`, `--help`/`-h`, `--schema`, `--dry-run`, `--wait`,
 * `--wait-timeout`, `--output-dir`, and aggregate/table/sort `--view` flags.
 */
export interface CliFrameworkOptions {
  json: boolean;
  quiet: boolean;
  help: boolean;
  schema: boolean;
  dryRun: boolean;
  wait: boolean;
  waitTimeout?: number;
  outputDir?: string;
  view?: CliResultView;
}

/** Whether the token after a value option is another option rather than its value. */
export function isOptionToken(token: string): boolean {
  return token.startsWith('--') || /^-[A-Za-z](?:=|$)/.test(token);
}

/** Whether a free-standing token is an option rather than a positional. */
export function looksLikeOption(token: string): boolean {
  return token.startsWith('--') || /^-[A-Za-z]/.test(token);
}

const BOOL_OPTIONS = new Set([
  'json',
  'wait',
  'quiet',
  'dry-run',
  'help',
  'schema',
  'ascending',
]);
export const VIEW_OPTIONS = new Set(['count-by', 'sum', 'by', 'top', 'table', 'sort']);
const VALUE_OPTIONS = new Set(['wait-timeout', 'output-dir', ...VIEW_OPTIONS]);
export const RESERVED_CLI_OPTIONS = new Set([...BOOL_OPTIONS, ...VALUE_OPTIONS]);

export interface CliLongOptionToken {
  name: string;
  value?: string;
  inline: boolean;
  globalKind?: 'boolean' | 'value';
}

/** One source of truth for long-option token shape and framework-global ownership. */
export function classifyLongOptionToken(token: string): CliLongOptionToken | undefined {
  if (!token.startsWith('--') || token === '--') return undefined;
  const equals = token.indexOf('=');
  const name = equals >= 0 ? token.slice(2, equals) : token.slice(2);
  return {
    name,
    value: equals >= 0 ? token.slice(equals + 1) : undefined,
    inline: equals >= 0,
    globalKind: BOOL_OPTIONS.has(name)
      ? 'boolean'
      : VALUE_OPTIONS.has(name)
        ? 'value'
        : undefined,
  };
}

export interface CliArgvRoute {
  /**
   * The command the line names. Without a `defaultCommand` a leading help or version token
   * (`help`, `--help`, `-h`, `version`, `--version`) comes back here as written, with
   * `topLevelHelp` and `version` false. With one, `--help`, `-h`, `version` and `--version` set
   * `topLevelHelp` or `version` instead, and `help` stays the command, its filter first in
   * `commandArgv`.
   */
  command?: string;
  commandArgv: string[];
  /** The line names no command and shows the command list; a leading help token: see `command`. */
  topLevelHelp: boolean;
  /** A version request that a `defaultCommand` would otherwise take; see `command`. */
  version: boolean;
  /** `--help <substring>` — narrow the command list instead of printing it whole. */
  helpFilter?: string;
  /** Why the line cannot be routed; `commandArgv` is empty and no command may run. */
  error?: string;
  /**
   * Indices in `commandArgv` before which the tokens were not adjacent on the line — pass it to
   * `parseCliArgs` with `commandArgv`; omitted when empty.
   */
  separatedBefore?: ReadonlySet<number>;
}

/** Options accepted by `routeCliArgv`. */
export interface CliRouteOptions {
  /** Command selected when `argv` has no explicit command or starts with command flags. */
  defaultCommand?: string;
  /** Indices in `argv` already separated from the token before them (`extractCliGlobalOptions`). */
  separatedBefore?: ReadonlySet<number>;
}

const HELP_TOKENS = new Set(['--help', '-h', 'help']);

export function isCliVersionToken(token: string | undefined): boolean {
  return token === '--version' || token === 'version';
}

/**
 * Whether a token stands in option syntax (`-x`, `--name`, `--name=value`): never a command
 * name, so a CLI without a default command refuses it where the command name belongs.
 */
export function isOptionShapedToken(token: string): boolean {
  return token.startsWith('-') && token !== '-';
}

/**
 * Names no command can take: the framework's own tokens, and anything in option syntax —
 * every projection reads a leading option as an option, never as a command.
 */
export function isReservedCliCommandName(name: string): boolean {
  return (
    isOptionShapedToken(name) ||
    name === '--' ||
    HELP_TOKENS.has(name) ||
    isCliVersionToken(name) ||
    classifyLongOptionToken(name)?.globalKind !== undefined
  );
}

/** Whether a leading token requests top-level help (not `--help=false`). */
export function isTopHelpOption(token: string): boolean {
  return (
    token === '--help' ||
    token === '-h' ||
    (token.startsWith('--help=') && !isReservedBoolWord(token.slice('--help='.length)))
  );
}

/** Whether a token after a missing framework value owns itself rather than the value slot. */
export function isOwnLeadingToken(
  token: string | undefined,
  appFields: ReadonlyMap<string, FieldInfo>,
): boolean {
  if (
    token === undefined ||
    token === '--' ||
    isTopHelpOption(token) ||
    isCliVersionToken(token)
  )
    return true;
  const opt = classifyLongOptionToken(token);
  if (!opt) return false;
  return opt.globalKind !== undefined || appFields.has(cliFieldOption(opt, appFields).name);
}

export interface FrameworkFlagState {
  fw: CliFrameworkOptions;
  fwFlags: Map<string, string[]>;
  viewFlags: Map<string, string>;
  ascending: boolean;
  schemaInvalid?: boolean;
}

export interface FrameworkOptionCallbacks {
  adjacent?: (index: number) => boolean;
  onError: (error: CliArgumentError) => void;
  onValueToken?: (token: string) => void;
  onMissingValue?: (next: string | undefined) => boolean;
  onBareBoolean?: (name: string) => void;
}

export interface FrameworkStepContext extends FrameworkFlagState {
  argv: readonly string[];
  appFields: ReadonlyMap<string, FieldInfo>;
  commandFound: boolean;
  bareBool?: { name: string; removedAfter: boolean };
  deferredError?: CliArgumentError;
  appGlobalError?: CliArgumentError;
  withoutGlobals: string[];
  withoutCommand: string[];
  /** The `argv` index each `withoutCommand` token was read from. */
  withoutCommandFrom: number[];
  commandTokens: string[];
  separatedBefore: Set<number>;
  removedAfterCmdToken: boolean;
  /** Indices in `argv` that a caller already separated from the token before them. */
  separatedInput: ReadonlySet<number>;
}

/** Record the first deferred framework error. */
export function deferScanError(ctx: FrameworkStepContext, error: CliArgumentError): void {
  ctx.deferredError ??= error;
}

/** Record an application-global error both for early-exit deferral and direct extraction. */
export function recordAppGlobalError(
  ctx: FrameworkStepContext,
  error: CliArgumentError,
): void {
  ctx.appGlobalError ??= error;
  deferScanError(ctx, error);
}

/** Append `argv[index]` to both projection buffers (`withoutGlobals`, `withoutCommand`). */
export function pushRestToken(ctx: FrameworkStepContext, token: string, index: number): void {
  ctx.withoutGlobals.push(token);
  ctx.withoutCommand.push(token);
  ctx.withoutCommandFrom.push(index);
}

/** Record a command token and note if a removed framework/app option preceded it. */
export function pushCommandToken(
  ctx: FrameworkStepContext,
  token: string,
  index: number,
): void {
  if (
    (ctx.removedAfterCmdToken || ctx.separatedInput.has(index)) &&
    ctx.commandTokens.length > 0
  ) {
    ctx.separatedBefore.add(ctx.commandTokens.length);
  }
  ctx.removedAfterCmdToken = false;
  ctx.commandTokens.push(token);
  pushRestToken(ctx, token, index);
}

/**
 * The caller's separations, re-indexed onto `withoutCommand`. Removing the command name itself
 * separates nothing a parser could misread: a bare framework boolean before it and a boolean
 * word after it is `boundaryError`, and a value option before it takes it as its value.
 */
export function withoutCommandSeparations(ctx: FrameworkStepContext): Set<number> {
  const separated = new Set<number>();
  ctx.withoutCommandFrom.forEach((from, at) => {
    if (at > 0 && ctx.separatedInput.has(from)) separated.add(at);
  });
  return separated;
}

/** Note that a framework or app-global token was stripped after the command started. */
export function markCommandTokenRemoved(ctx: FrameworkStepContext): void {
  if (ctx.commandFound) ctx.removedAfterCmdToken = true;
}

/** Try consuming an application global option at `index`; returns next index or `-1`. */
export function tryReadAppGlobalToken(
  ctx: FrameworkStepContext,
  index: number,
  opt: CliLongOptionToken | undefined,
  raw: Map<string, string[]>,
  jsonFields: Set<string>,
): number {
  if (!opt || opt.globalKind !== undefined) return -1;
  const appField = cliFieldOption(opt, ctx.appFields);
  const info = ctx.appFields.get(appField.name);
  if (!info) return -1;
  if (ctx.bareBool) ctx.bareBool.removedAfter = true;
  let { value } = opt;
  let nextIndex = index;
  if (value === undefined && info.kind === 'boolean') {
    const sep = separateBoolValue(ctx.argv[index + 1]);
    if (sep !== undefined) nextIndex++;
    value = String(sep ?? true);
  } else if (value === undefined) {
    const next = ctx.argv[index + 1];
    if (next === undefined || isOptionToken(next)) {
      recordAppGlobalError(ctx, new CliArgumentError(`--${opt.name} requires a value`));
      return nextIndex;
    }
    value = next;
    nextIndex++;
  } else if (info.kind === 'boolean' && !appField.json) {
    if (raw.has(appField.name)) {
      appendCliFieldValue(raw, jsonFields, appField.name, value, info, appField.json);
      return nextIndex;
    }
    try {
      parseReservedBool(appField.name, value);
    } catch (error) {
      if (error instanceof CliArgumentError) recordAppGlobalError(ctx, error);
      else throw error;
    }
  }
  appendCliFieldValue(raw, jsonFields, appField.name, value, info, appField.json);
  return nextIndex;
}

/** Name of the reserved framework option when an inline `:=JSON` assignment targets one. */
export function reservedJsonTarget(opt: CliLongOptionToken | undefined): string | undefined {
  if (!opt?.inline || !opt.name.endsWith(':')) return undefined;
  const target = opt.name.slice(0, -1);
  return RESERVED_CLI_OPTIONS.has(target) ? target : undefined;
}

/**
 * Single owner of all 15 framework flags (`--json`, `--quiet`, `--help`, `--schema`,
 * `--dry-run`, `--wait`, `--ascending`, `--wait-timeout`, `--output-dir`, and the
 * 6 view flags), shared by the invocation scanner and command tokeniser.
 */
export function consumeFrameworkOptionToken(
  argv: readonly string[],
  index: number,
  opt: CliLongOptionToken,
  state: FrameworkFlagState,
  callbacks: FrameworkOptionCallbacks,
): number {
  const adjacent = callbacks.adjacent ?? (() => true);
  const report = (error: CliArgumentError): void => {
    if (opt.name === 'schema') {
      state.fw.schema = false;
      state.schemaInvalid = true;
    } else if (opt.name === 'help') state.fw.help = false;
    callbacks.onError(error);
  };
  const record = (name: string, raw: string, kind: 'boolean' | 'string'): boolean => {
    try {
      appendCliOptionValue(state.fwFlags, name, raw, { kind });
      return true;
    } catch (error) {
      if (error instanceof CliArgumentError) {
        report(error);
        return false;
      }
      throw error;
    }
  };
  let nextIdx = index;
  if (opt.globalKind === 'boolean') {
    const following = argv[index + 1];
    if (
      !opt.inline &&
      !adjacent(index + 1) &&
      following !== undefined &&
      separateBoolValue(following) !== undefined
    ) {
      // The line put something between the flag and the word; reading the word as either
      // the value or a positional would say what the line did not. The flag stays as written,
      // bare, unless it is a request (help, `--schema`) the word may have switched off.
      report(brokenBooleanBoundaryError(opt.name, following));
      if (opt.name === 'help' || opt.name === 'schema') return nextIdx;
    }
    const nextTok = adjacent(index + 1) ? following : undefined;
    const sep = opt.inline ? undefined : separateBoolValue(nextTok);
    if (sep !== undefined && nextTok !== undefined) {
      nextIdx++;
      callbacks.onValueToken?.(nextTok);
    }
    const rawValue = opt.value ?? String(sep ?? true);
    if (opt.name !== 'help' && !record(opt.name, rawValue, 'boolean')) return nextIdx;
    let enabled: boolean;
    if (opt.inline) {
      try {
        enabled = parseReservedBool(opt.name, opt.value ?? '');
      } catch (error) {
        if (error instanceof CliArgumentError) {
          report(error);
          return nextIdx;
        }
        throw error;
      }
    } else {
      enabled = sep ?? true;
    }
    if (!opt.inline && sep === undefined) callbacks.onBareBoolean?.(opt.name);
    if (opt.name === 'dry-run') state.fw.dryRun = enabled;
    else if (opt.name === 'json') state.fw.json = enabled;
    else if (opt.name === 'wait') state.fw.wait = enabled;
    else if (opt.name === 'quiet') state.fw.quiet = enabled;
    else if (opt.name === 'ascending') state.ascending = enabled;
    else if (opt.name === 'schema') {
      state.fw.schema = !state.schemaInvalid && (state.fw.schema || enabled);
    } else if (opt.name === 'help') state.fw.help = state.fw.help || enabled;
    return nextIdx;
  }
  let value = opt.value;
  if (!opt.inline) {
    const next = adjacent(index + 1) ? argv[index + 1] : undefined;
    if (next === undefined || isOptionToken(next)) {
      report(new CliArgumentError(`--${opt.name} requires a value`));
      if (callbacks.onMissingValue?.(next)) nextIdx++;
    } else {
      value = next;
      nextIdx++;
      callbacks.onValueToken?.(next);
    }
  }
  if (value !== undefined) {
    if (!record(opt.name, value, 'string')) return nextIdx;
    if (opt.name === 'wait-timeout') {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) {
        report(new CliArgumentError('--wait-timeout must be a positive number'));
      } else {
        state.fw.waitTimeout = n;
      }
    } else if (VIEW_OPTIONS.has(opt.name)) state.viewFlags.set(opt.name, value);
    else state.fw.outputDir = value;
  }
  return nextIdx;
}

/** Consume one framework boolean or value flag and update scanner state. */
export function readFrameworkOptionToken(
  ctx: FrameworkStepContext,
  index: number,
  token: string,
  opt: CliLongOptionToken,
): number {
  ctx.bareBool = undefined;
  pushRestToken(ctx, token, index);
  return consumeFrameworkOptionToken(ctx.argv, index, opt, ctx, {
    adjacent: (at) => !ctx.separatedInput.has(at),
    onError: (error) => deferScanError(ctx, error),
    onValueToken: (valueToken) => pushRestToken(ctx, valueToken, index + 1),
    onBareBoolean: (name) => {
      ctx.bareBool = { name, removedAfter: false };
    },
    onMissingValue: (next) => {
      if (!ctx.commandFound && next !== undefined && !isOwnLeadingToken(next, ctx.appFields)) {
        pushRestToken(ctx, next, index + 1);
        return true;
      }
      return false;
    },
  });
}

/** Finalize view flags into `framework.view`, deferring combination errors. */
export function finalizeFrameworkView(ctx: FrameworkStepContext): void {
  if (ctx.viewFlags.size === 0 && !ctx.ascending) return;
  try {
    ctx.fw.view = resolveCliView(ctx.viewFlags, ctx.ascending);
  } catch (error) {
    if (error instanceof CliArgumentError) deferScanError(ctx, error);
    else throw error;
  }
}

/** Create fresh scanner state for one single-pass invocation walk. */
export function createFrameworkStepContext(
  argv: readonly string[],
  appFields: ReadonlyMap<string, FieldInfo>,
  separatedInput: ReadonlySet<number> = new Set(),
): FrameworkStepContext {
  return {
    argv,
    appFields,
    fwFlags: new Map(),
    viewFlags: new Map(),
    fw: { json: false, quiet: false, help: false, schema: false, dryRun: false, wait: false },
    ascending: false,
    commandFound: false,
    withoutGlobals: [],
    withoutCommand: [],
    withoutCommandFrom: [],
    commandTokens: [],
    separatedBefore: new Set(),
    removedAfterCmdToken: false,
    separatedInput,
  };
}

/** Coerce collected raw application global values before schema parsing. */
export function coerceAppGlobalMap(
  raw: ReadonlyMap<string, string[]>,
  fields: ReadonlyMap<string, FieldInfo>,
  jsonFields: ReadonlySet<string>,
): Record<string, unknown> {
  const coerced: Record<string, unknown> = {};
  for (const [name, values] of raw) {
    coerced[name] = coerceCliFieldValue(
      fields.get(name),
      values,
      `--${name}`,
      jsonFields.has(name),
    );
  }
  return coerced;
}

/** Refusal when a removed token sits between a bare boolean flag and `true`/`false`. */
export function brokenBooleanBoundaryError(flagName: string, word: string): CliArgumentError {
  const flag = flagName.startsWith('-') ? flagName : `--${flagName}`;
  return new CliArgumentError(
    `Bare ${flag} cannot be separated from "${word}" — use ${flag}=true, ${flag}=false or "-- ${word}"`,
  );
}
