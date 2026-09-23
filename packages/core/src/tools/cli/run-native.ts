import type { ZodObject } from 'zod';
import {
  type CliCommandDefinition,
  executeCliCommand,
  prepareCliCommandEmission,
} from './command';
import { emitResult } from './format';
import { renderCommandHelp } from './help';
import { prepareInvocation } from './prepare';
import { type CliRoute, type CliSession, emitOptionsFor } from './session';

/**
 * A command the application wrote itself. It never waits, downloads or needs the
 * managed surface, so it is answered before any identity is resolved.
 */
export async function runNativeCommand<
  TAuth,
  TContext extends Record<string, unknown>,
  TGlobals extends ZodObject,
>(
  session: CliSession<TAuth, TContext, TGlobals>,
  route: CliRoute<TGlobals>,
  command: string,
  native: CliCommandDefinition,
): Promise<void> {
  const { config, applicationOptions, nativeHelp } = session;
  const { stdout, stderr, exit, readStdin } = session.io;
  const { commandArgv, helpRequested, globals } = route;
  const descriptor = nativeHelp.get(command);
  if (!descriptor) throw new Error('[stitchkit] native CLI descriptor invariant failed');
  if (helpRequested) {
    stdout(renderCommandHelp(config.name, command, descriptor, applicationOptions));
    return exit(0);
  }
  const prepared = await prepareInvocation(
    command,
    commandArgv,
    descriptor,
    config,
    readStdin,
  );
  if (!prepared.ok) {
    stderr(`${prepared.message}\n`);
    return exit(2);
  }
  const { toolArgs, options } = prepared;
  if (options.help) {
    stdout(renderCommandHelp(config.name, command, descriptor, applicationOptions));
    return exit(0);
  }
  if (options.wait) {
    stderr(`--wait is not configured for native command "${command}"\n`);
    return exit(2);
  }
  if (options.waitTimeout !== undefined) {
    stderr('--wait-timeout requires --wait\n');
    return exit(2);
  }
  if (options.outputDir !== undefined) {
    stderr('--output-dir is not configured for native commands\n');
    return exit(2);
  }
  if (options.dryRun) {
    stdout(`${JSON.stringify({ command, args: toolArgs }, null, 2)}\n`);
    return exit(0);
  }
  const result = await executeCliCommand(
    native,
    toolArgs,
    options,
    { stdout, stderr },
    config.coerceJsonArgs ?? true,
    globals,
  );
  const emission = prepareCliCommandEmission(native, result, options);
  let emittedExitCode: number;
  if (emission.result.ok && emission.presentation !== undefined) {
    stdout(emission.presentation);
    emittedExitCode = 0;
  } else {
    emittedExitCode = emitResult(
      emission.result,
      { stdout, stderr },
      emitOptionsFor(config, options.json, command),
    );
  }
  return exit(emission.result.ok ? emission.successExitCode : emittedExitCode);
}
