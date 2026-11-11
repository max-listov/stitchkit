import type { ZodObject } from 'zod';
import { type ToolFailure, type ToolResult, toolResultFromError } from '../execute-result';
import { createToolRunner, type MountableTool } from '../mount';
import { isRepeatableRead } from '../read-operation';
import type { parseCliArgs } from './args';
import { isReservedBoolWord } from './args-fields';
import { CliArgumentError } from './argument-error';
import { emitCliCommandResult } from './command';
import { DEFAULT_DOWNLOAD_MAX_BYTES, downloadResults } from './download';
import { DEFAULT_EXIT_CODES, emitPresentationFailure, emitResult } from './format';
import { filterCommands, renderCommandHelp, renderTopHelp } from './help';
import { buildManagedSurface, type ManagedSurface } from './managed-surface';
import { cliResultPolicy } from './policy';
import { prepareInvocation } from './prepare';
import { runStreamCommand } from './run-stream';
import {
  type CliRoute,
  type CliSession,
  emitOptionsFor,
  renderCommandSchema,
} from './session';
import { unavailableCommand, unavailableCommandJson } from './unavailable';
import { renderCliView, stringifyGroups } from './view';
import { pollUntilDone } from './wait';

type CliRunOptions = ReturnType<typeof parseCliArgs>['options'];
type ResolvedManagedSurface<TAuth> = Extract<ManagedSurface<TAuth>, { resolved: true }>;

/** Everything after the native commands: the top-level listing and managed commands. */
export async function runManagedInvocation<
  TAuth,
  TContext extends Record<string, unknown>,
  TGlobals extends ZodObject,
>(session: CliSession<TAuth, TContext, TGlobals>, route: CliRoute<TGlobals>): Promise<void> {
  const { config } = session;
  const { stdout, stderr, exit } = session.io;
  const { command, helpRequested, schemaRequested, beforeSeparator } = route;
  const topLevelHelp =
    route.route.topLevelHelp ||
    command === undefined ||
    command === 'help' ||
    command === '--help' ||
    command === '-h' ||
    // `--help=<substring>` is the same question written inline; without this it
    // routed as an unknown command name. `--help=false` stays what it always
    // was — the boolean negation — so the inline form keeps one meaning per
    // value rather than two.
    (command.startsWith('--help=') && !isReservedBoolWord(command.slice('--help='.length)));
  const managed = await buildManagedSurface(
    session,
    route.typedGlobals,
    !topLevelHelp && !helpRequested && !schemaRequested,
  );
  if (topLevelHelp) return respondTopLevelHelp(session, route, managed);
  if (!managed.resolved) {
    // Every native command already dispatched above, so this name could only
    // have come from the surface that failed to resolve. Report THAT, with the
    // exit code its error class declares.
    return exit(
      emitResult(
        managed.failure,
        { stdout, stderr },
        emitOptionsFor(config, beforeSeparator.includes('--json'), command ?? config.name),
      ),
    );
  }
  return runManagedCommand(session, route, command, managed);
}

function respondTopLevelHelp<
  TAuth,
  TContext extends Record<string, unknown>,
  TGlobals extends ZodObject,
>(
  session: CliSession<TAuth, TContext, TGlobals>,
  route: CliRoute<TGlobals>,
  managed: ManagedSurface<TAuth>,
): void {
  const { config, applicationOptions } = session;
  const { stdout, stderr, exit } = session.io;
  const { command, commandArgv } = route;
  const helpFilter =
    route.route.helpFilter ?? (command !== undefined ? commandArgv[0] : undefined);
  const filter =
    helpFilter !== undefined && !helpFilter.startsWith('-') ? helpFilter : undefined;
  // Nothing matched is a fact a script branches on, not an empty success —
  // an exit 0 over an empty list reads as "there are none", which is a
  // different statement from "none of these".
  if (filter !== undefined && filterCommands(managed.help, filter).size === 0) {
    stderr(
      `no command matches "${filter}" (${[...managed.help.values()].filter((entry) => entry.unavailableReason === undefined).length} available)\n` +
        (managed.resolved ? '' : `Managed commands are unavailable: ${managed.reason}\n`),
    );
    const codes = { ...DEFAULT_EXIT_CODES, ...config.exitCodes };
    exit(codes.NOT_FOUND ?? 4);
    return;
  }
  stdout(
    renderTopHelp({
      name: config.name,
      version: config.version,
      commands: managed.help,
      defaultCommand: config.defaultCommand,
      applicationOptions,
      ...(filter !== undefined && { filter }),
      ...(managed.resolved ? {} : { unavailable: managed.reason }),
    }),
  );
  exit(0);
}

/** Resolve, validate and answer the flags that stop before a call, then run it. */
async function runManagedCommand<
  TAuth,
  TContext extends Record<string, unknown>,
  TGlobals extends ZodObject,
>(
  session: CliSession<TAuth, TContext, TGlobals>,
  route: CliRoute<TGlobals>,
  command: string,
  managed: ResolvedManagedSurface<TAuth>,
): Promise<void> {
  const { config, applicationOptions } = session;
  const { stdout, stderr, exit, readStdin } = session.io;
  const descriptor = managed.help.get(command);
  if (!descriptor) {
    stderr(
      `Unknown command "${command}". Run "${config.name} --help" for the command list.\n`,
    );
    return exit(1);
  }
  if (route.helpRequested) {
    stdout(renderCommandHelp(config.name, command, descriptor, applicationOptions));
    return exit(0);
  }
  if (route.schemaRequested) {
    stdout(renderCommandSchema(command, descriptor));
    return exit(0);
  }
  if (descriptor.unavailableReason !== undefined) {
    return exit(
      emitResult(
        unavailableCommand(descriptor.unavailableReason),
        { stdout, stderr },
        emitOptionsFor(config, unavailableCommandJson(route.commandArgv), command),
      ),
    );
  }
  const stream = managed.streams.get(command);
  const tool = managed.tools.get(command);
  if (!tool && !stream) throw new Error('[stitchkit] managed CLI executable invariant failed');
  const prepared = await prepareInvocation(
    command,
    route.commandArgv,
    descriptor,
    config,
    readStdin,
  );
  if (!prepared.ok) {
    stderr(`${prepared.message}\n`);
    return exit(2);
  }
  const { toolArgs, options } = prepared;

  if (options.wait && !config.wait?.[command]) {
    stderr(`--wait is not configured for command "${command}"\n`);
    return exit(2);
  }
  if (options.waitTimeout !== undefined && !options.wait) {
    stderr('--wait-timeout requires --wait\n');
    return exit(2);
  }
  if (options.outputDir !== undefined && !config.download) {
    stderr('--output-dir is not configured for this CLI\n');
    return exit(2);
  }

  if (options.help) {
    stdout(renderCommandHelp(config.name, command, descriptor, applicationOptions));
    return exit(0);
  }

  if (options.dryRun) {
    stdout(`${JSON.stringify({ command, args: toolArgs }, null, 2)}\n`);
    return exit(0);
  }

  if (stream) return runStreamCommand(session, route, managed, stream, { toolArgs, options });
  if (!tool) throw new Error('[stitchkit] managed CLI executable invariant failed');
  const result = await executeManagedTool(session, route, command, managed, tool, {
    toolArgs,
    options,
  });
  return emitManagedResult(session, command, result, options, isRepeatableRead(tool.method));
}

/** One call through the shared tool runner, then `--wait` polling over the same runner. */
async function executeManagedTool<
  TAuth,
  TContext extends Record<string, unknown>,
  TGlobals extends ZodObject,
>(
  session: CliSession<TAuth, TContext, TGlobals>,
  route: CliRoute<TGlobals>,
  command: string,
  managed: ResolvedManagedSurface<TAuth>,
  tool: MountableTool,
  { toolArgs, options }: { toolArgs: Record<string, unknown>; options: CliRunOptions },
): Promise<ToolResult> {
  const { config } = session;
  const { stderr } = session.io;
  const runTool = createToolRunner({
    source: 'cli',
    toolSurface: true,
    context: { ...config.context?.(managed.auth, route.typedGlobals), signal: config.signal },
    hooks: config.hooks,
    lifecycle: config.lifecycle,
    coerceJsonArgs: config.coerceJsonArgs,
  });
  let result: ToolResult;
  try {
    result = await runTool(tool, toolArgs);
  } catch (err) {
    result = toolResultFromError(err);
  }

  const waitConfig = config.wait?.[command];
  if (options.wait && waitConfig) {
    result = await pollUntilDone({
      initial: result,
      wait: waitConfig,
      call: async (toolName, args) => {
        const unavailable = managed.help.get(toolName)?.unavailableReason;
        if (unavailable !== undefined) return unavailableCommand(unavailable);
        const pollTool = managed.tools.get(toolName);
        if (!pollTool) {
          return {
            ok: false,
            code: 'UNKNOWN_OPERATION',
            details: {
              message: `--wait: no command "${toolName}" to poll`,
              operation: toolName,
            },
          };
        }
        return runTool(pollTool, args);
      },
      timeoutSec: options.waitTimeout,
      onTick: options.quiet ? undefined : (attempt) => stderr(`waiting… (poll ${attempt})\n`),
      signal: config.signal,
    });
  }
  return result;
}

/** Downloads, the optional view, then the result and its exit code. */
async function emitManagedResult<
  TAuth,
  TContext extends Record<string, unknown>,
  TGlobals extends ZodObject,
>(
  session: CliSession<TAuth, TContext, TGlobals>,
  command: string,
  initial: ToolResult,
  options: CliRunOptions,
  repeatable: boolean,
): Promise<void> {
  const { config } = session;
  const { stdout, stderr, exit } = session.io;
  let result = initial;
  let downloadsOk = true;
  if (options.outputDir && result.ok && config.download) {
    downloadsOk = await downloadResults(
      config.download(result.data),
      options.outputDir,
      stderr,
      options.quiet,
      config.allowPrivateDownloadHosts ?? false,
      config.maxDownloadBytes ?? DEFAULT_DOWNLOAD_MAX_BYTES,
      config.downloadTimeoutMs,
    );
  }

  // A view replaces the payload, never the outcome: a failed call still reports
  // its own error and exit code, because an aggregate over an error is not an
  // answer to the question that was asked.
  if (options.view && result.ok) {
    let viewed: ReturnType<typeof renderCliView>;
    try {
      viewed = renderCliView(result.data, options.view);
    } catch (error) {
      const failure: ToolFailure =
        error instanceof CliArgumentError
          ? {
              ok: false,
              code: 'BAD_REQUEST',
              details: { message: error.message },
            }
          : toolResultFromError(error);
      return exit(
        emitPresentationFailure(
          result,
          failure,
          { stdout, stderr },
          { ...emitOptionsFor(config, options.json, command), repeatable },
        ),
      );
    }
    if (viewed.kind === 'text') {
      stdout(viewed.text);
      return exit(downloadsOk ? 0 : 1);
    }
    if (viewed.order) {
      stdout(`${stringifyGroups(viewed.data, viewed.order, options.json === true)}\n`);
      return exit(downloadsOk ? 0 : 1);
    }
    result = { ...result, data: viewed.data };
  }

  // The policy speaks only for the operation's own result: a view answers a
  // different question, and after `--wait` the result is the polled command's.
  const policy =
    options.view === undefined && !options.wait ? cliResultPolicy(config, command) : undefined;
  const exitCode = emitCliCommandResult(
    policy,
    result,
    options,
    { stdout, stderr },
    { ...emitOptionsFor(config, options.json, command), repeatable },
  );
  return exit(downloadsOk ? exitCode : 1);
}
