/**
 * The shell grammar of argv: which tokens are options, which options belong to
 * the framework rather than to a command, and which command an invocation
 * selects before any of its own arguments are read.
 */
import { isReservedBoolWord } from './args-fields';

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

const BOOL_OPTIONS = new Set(['json', 'wait', 'quiet', 'dry-run', 'help', 'ascending']);
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
  command?: string;
  commandArgv: string[];
  topLevelHelp: boolean;
  version: boolean;
  /** `--help <substring>` — narrow the command list instead of printing it whole. */
  helpFilter?: string;
  error?: string;
}

/**
 * Select a command without duplicating the framework-global option grammar.
 * With no default configured this returns the historical first-token routing
 * byte-for-byte. With a default, recognised leading globals may precede an
 * explicit command; a remaining option token belongs to the default command.
 */
const HELP_TOKENS = new Set(['--help', '-h', 'help']);

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

export function routeCliArgv(argv: string[], defaultCommand?: string): CliArgvRoute {
  if (defaultCommand === undefined) {
    const [command, ...commandArgv] = argv;
    const helpFilter = helpFilterFrom(command, commandArgv);
    return {
      command,
      commandArgv,
      topLevelHelp: false,
      version: false,
      ...(helpFilter !== undefined && { helpFilter }),
    };
  }

  const globals: string[] = [];
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === undefined) break;
    if (token === '--') {
      return {
        commandArgv: [],
        topLevelHelp: false,
        version: false,
        error: 'A command is required before "--"',
      };
    }
    // `--help=false` is the reserved boolean's negation and keeps that meaning;
    // only a non-boolean inline value asks the narrower question.
    const inlineHelpFilter =
      token.startsWith('--help=') && !isReservedBoolWord(token.slice('--help='.length));
    if (token === '--help' || token === '-h' || inlineHelpFilter) {
      const helpFilter = helpFilterFrom(token, argv.slice(index + 1));
      return {
        commandArgv: [],
        topLevelHelp: true,
        version: false,
        ...(helpFilter !== undefined && { helpFilter }),
      };
    }
    if (token === '--version' || token === 'version') {
      return { commandArgv: [], topLevelHelp: false, version: true };
    }
    if (!token.startsWith('-') || token === '-') {
      return {
        command: token,
        commandArgv: [...globals, ...argv.slice(index + 1)],
        topLevelHelp: false,
        version: false,
      };
    }
    if (!token.startsWith('--')) {
      return {
        command: defaultCommand,
        commandArgv: [...globals, ...argv.slice(index)],
        topLevelHelp: false,
        version: false,
      };
    }

    const option = classifyLongOptionToken(token);
    if (!option) {
      return {
        command: defaultCommand,
        commandArgv: [...globals, ...argv.slice(index)],
        topLevelHelp: false,
        version: false,
      };
    }
    if (option.globalKind === 'boolean') {
      globals.push(token);
      index += 1;
      continue;
    }
    if (option.globalKind === 'value') {
      globals.push(token);
      if (!option.inline) {
        const value = argv[index + 1];
        if (value === '--help' || value === '-h') {
          const helpFilter = helpFilterFrom(value, argv.slice(index + 2));
          return {
            commandArgv: [],
            topLevelHelp: true,
            version: false,
            ...(helpFilter !== undefined && { helpFilter }),
          };
        }
        if (value === '--version' || value === 'version') {
          return { commandArgv: [], topLevelHelp: false, version: true };
        }
        if (value !== undefined) globals.push(value);
        index += value === undefined ? 1 : 2;
      } else {
        index += 1;
      }
      continue;
    }
    return {
      command: defaultCommand,
      commandArgv: [...globals, ...argv.slice(index)],
      topLevelHelp: false,
      version: false,
    };
  }
  return {
    command: defaultCommand,
    commandArgv: globals,
    topLevelHelp: false,
    version: false,
  };
}
