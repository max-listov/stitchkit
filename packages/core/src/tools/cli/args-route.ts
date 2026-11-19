/**
 * The shell grammar of argv: which tokens are options, which options belong to
 * the framework rather than to a command, and which command an invocation
 * selects before any of its own arguments are read.
 */
import { isReservedBoolWord, parseReservedBool, separateBoolValue } from './args-fields';

/**
 * Whether the token after an option that expects a value is another option
 * rather than that value: `--name`, `--name=value`, `--` itself, or a
 * single-letter short form (`-f`, `-f=value`).
 *
 * Everything else that merely starts with `-` is the value — a negative
 * number, a search pattern `-foo`. Rejecting those as "misplaced options" made
 * ordinary values unpassable except inline, while the mistake it was meant to
 * catch (`--grep --json`) is still caught: a long option is always an option.
 */
export function isOptionToken(token: string): boolean {
  return token.startsWith('--') || /^-[A-Za-z](?:=|$)/.test(token);
}

/**
 * Whether a free-standing token is an option rather than a positional: any
 * long form, or `-` followed by a letter (`-f`, and `-n100`, which is refused
 * as unknown rather than read as a value nobody meant).
 *
 * `-` followed by anything else is positional — a message body `- item`, a
 * negative number, `-` for stdin — instead of an "Unknown option" the caller
 * can only escape with `--`.
 */
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

/** Read a setting before validation. Any enabled help or schema request takes precedence. */
export function readCliBooleanFlag(argv: readonly string[], name: string): boolean {
  const request = name === 'help' || name === 'schema';
  for (const [index, token] of argv.entries()) {
    if (token === '--') break;
    if (token === undefined) continue;
    if (name === 'help' && token === '-h') return true;
    const option = classifyLongOptionToken(token);
    if (option?.name !== name || option.globalKind !== 'boolean') continue;
    const enabled =
      option.value === undefined
        ? (separateBoolValue(argv[index + 1]) ?? true)
        : isReservedBoolWord(option.value) && parseReservedBool(name, option.value);
    if (enabled || !request) return enabled;
  }
  return false;
}

/** Removing an intervening token cannot make a positional true/false a flag's value. */
export function preserveCliBooleanBoundary(prefix: string[], next: string | undefined): void {
  if (separateBoolValue(next) === undefined) return;
  const last = prefix.at(-1);
  const option = last === undefined ? undefined : classifyLongOptionToken(last);
  if (option?.globalKind === 'boolean' && !option.inline) {
    // -h keeps both forms of bare help: a top-level filter or a command request.
    prefix[prefix.length - 1] = last === '--help' ? '-h' : `${last}=true`;
  }
}

export interface CliArgvRoute {
  command?: string;
  commandArgv: string[];
  topLevelHelp: boolean;
  version: boolean;
  /** `--help <substring>` — narrow the command list instead of printing it whole. */
  helpFilter?: string;
  error?: string;
}

const HELP_TOKENS = new Set(['--help', '-h', 'help']);

export function isCliVersionToken(token: string | undefined): boolean {
  return token === '--version' || token === 'version';
}

/** Exact shell tokens owned by the framework, including inline option values. */
export function isReservedCliCommandName(name: string): boolean {
  return (
    name === '--' ||
    HELP_TOKENS.has(name) ||
    isCliVersionToken(name) ||
    classifyLongOptionToken(name)?.globalKind !== undefined
  );
}

/**
 * The substring after a help token, in any of the forms a person types it.
 *
 * `--help=false` is NOT one of them: `--help` is a reserved boolean and the
 * inline form has always been its negation, so a boolean word keeps the meaning
 * it had. Only a value that is not one narrows the listing.
 */
function helpFilterFrom(
  token: string | undefined,
  rest: readonly string[],
): string | undefined {
  if (token?.startsWith('--help=')) {
    const value = token.slice('--help='.length).trim();
    if (value.length === 0 || isReservedBoolWord(value)) return undefined;
    return value;
  }
  if (token === undefined || !HELP_TOKENS.has(token)) return undefined;
  const next = rest[0];
  return next !== undefined && !next.startsWith('-') ? next : undefined;
}

function isTopHelpOption(token: string): boolean {
  return (
    token === '--help' ||
    token === '-h' ||
    (token.startsWith('--help=') && !isReservedBoolWord(token.slice('--help='.length)))
  );
}

/** Find the end of the framework options without looking past a command or a separator. */
function leadingGlobalCount(argv: readonly string[], hasDefault: boolean): number {
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === undefined || isTopHelpOption(token)) break;
    const option = classifyLongOptionToken(token);
    if (!option?.globalKind) break;
    index++;
    if (option.inline) continue;

    const value = argv[index];
    if (value === undefined) break;
    if (option.globalKind === 'boolean') {
      if (separateBoolValue(value) !== undefined) index++;
    } else {
      // A mistyped value still occupies its slot for routing. The argument
      // parser reports the missing value, or the named command can show help.
      if (
        value === '--' ||
        value === '--help' ||
        value === '-h' ||
        value === '--version' ||
        (hasDefault && value === 'version')
      ) {
        break;
      }
      // Keep the default router's historical slot. Otherwise a framework
      // option in that position still owns its own subsequent value.
      if (hasDefault || !classifyLongOptionToken(value)?.globalKind) index++;
    }
  }
  return index;
}

/**
 * Route recognised leading globals to the explicit command. A CLI with a default
 * also routes a global-only invocation and command-local leading flags to that default.
 */
export function routeCliArgv(argv: string[], defaultCommand?: string): CliArgvRoute {
  const index = leadingGlobalCount(argv, defaultCommand !== undefined);
  const token = argv[index];
  if (token === '--' && (index > 0 || defaultCommand !== undefined)) {
    return {
      commandArgv: [],
      topLevelHelp: false,
      version: false,
      error: 'A command is required before "--"',
    };
  }
  if (defaultCommand !== undefined) {
    if (token !== undefined && isTopHelpOption(token)) {
      const helpFilter = helpFilterFrom(token, argv.slice(index + 1));
      return {
        commandArgv: [],
        topLevelHelp: true,
        version: false,
        ...(helpFilter !== undefined && { helpFilter }),
      };
    }
    if (isCliVersionToken(token)) {
      return { commandArgv: [], topLevelHelp: false, version: true };
    }
    if (token === undefined || (token.startsWith('-') && token !== '-')) {
      return {
        command: defaultCommand,
        commandArgv: argv.slice(),
        topLevelHelp: false,
        version: false,
      };
    }
  }

  // With no command after the prefix, keep the first-token route and its diagnostic.
  const commandIndex = token === undefined ? 0 : index;
  const command = argv[commandIndex];
  const rest = argv.slice(commandIndex + 1);
  const prefix = argv.slice(0, commandIndex);
  preserveCliBooleanBoundary(prefix, rest[0]);
  // A default CLI historically reads plain `help <filter>` from commandArgv[0].
  // With leading globals in that slot, expose the filter from the command's own tail.
  const helpFilter =
    commandIndex > 0 || defaultCommand === undefined
      ? helpFilterFrom(command, rest)
      : undefined;
  return {
    command,
    commandArgv: prefix.concat(rest),
    topLevelHelp: false,
    version: false,
    ...(helpFilter !== undefined && { helpFilter }),
  };
}
