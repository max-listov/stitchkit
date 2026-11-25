/** Thin `routeCliArgv` projection over the single-pass invocation scanner. */
import type { CliArgvRoute, CliRouteOptions } from './args-classify';
import { answersBeforeArguments, scanCliArgv } from './args-scan';

/**
 * Route recognised leading globals to the explicit command. A CLI with a default
 * also routes a global-only invocation and command-local leading flags to that default.
 * A line `createCli` refuses before any command runs comes back with `error` and no command.
 */
export function routeCliArgv(argv: string[], options: CliRouteOptions = {}): CliArgvRoute {
  const { defaultCommand } = options;
  const result = scanCliArgv(argv, {
    defaultCommand,
    separatedBefore: options.separatedBefore,
  });
  const refuse = (error: string): CliArgvRoute => ({
    commandArgv: [],
    topLevelHelp: false,
    version: false,
    error,
  });
  // A line `createCli` refuses before any command runs, with the first refusal it reports.
  // Help, `--version` and `--schema` still answer such a line, as `createCli` answers it.
  const early = answersBeforeArguments(result);
  if (!early && result.deferredError !== undefined)
    return refuse(result.deferredError.message);
  if (defaultCommand !== undefined && result.leadingToken !== undefined) {
    if (result.version) return { commandArgv: [], topLevelHelp: false, version: true };
    if (result.topLevelHelp && result.leadingToken !== 'help') {
      return {
        commandArgv: [],
        topLevelHelp: true,
        version: false,
        ...(result.helpFilter !== undefined && { helpFilter: result.helpFilter }),
      };
    }
  }
  // Removing the command joins a bare boolean flag to the word after it, and such a line was
  // refused above unless help or `--schema` answers it: the word stays separated, so the parser
  // does not read it as the flag's value.
  const separated = new Set([
    ...result.withoutCommandSeparatedBefore,
    ...result.boundarySeparatedBefore,
  ]);
  const boundaries = separated.size > 0 ? { separatedBefore: separated } : {};
  if (result.leadingToken !== undefined) {
    const exposeFilter =
      result.topLevelHelp &&
      (result.hadLeadingPrefix || defaultCommand === undefined) &&
      result.helpFilter !== undefined;
    return {
      command: result.leadingToken,
      commandArgv: result.withoutCommand,
      topLevelHelp: false,
      version: false,
      ...(exposeFilter && { helpFilter: result.helpFilter }),
      ...boundaries,
    };
  }
  return {
    ...(result.command !== undefined && { command: result.command }),
    commandArgv: result.withoutCommand,
    topLevelHelp: result.topLevelHelp,
    version: false,
    ...boundaries,
  };
}
