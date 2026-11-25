import type { ZodObject } from 'zod';
import { inspectOnlyError, isInspectOnlyLifecycle } from '../access';
import { type ToolResult, toolResultFromError } from '../execute-result';
import type { MountableTool } from '../mount';
import { isRepeatableRead } from '../read-operation';
import type { parseCliArgs } from './args';
import { CliArgumentError } from './argument-error';
import { emitCliViewOrResult } from './command';
import { DEFAULT_DOWNLOAD_MAX_BYTES, saveResultMedia } from './download';
import { cliExitCode, DEFAULT_EXIT_CODES, emitResult } from './format';
import { filterCommands, renderCommandHelp, renderTopHelp } from './help';
import { buildManagedSurface, type ManagedSurface } from './managed-surface';
import { cliResultPolicy, cliWaitConfig } from './policy';
import { prepareInvocation } from './prepare';
import { runStreamCommand } from './run-stream';
import { createCliToolRunner } from './runner';
import {
  type CliRoute,
  type CliSession,
  emitOptionsFor,
  renderCommandSchema,
} from './session';
import { unavailableCommand, unknownCliCommand } from './unavailable';
import { assertViewColumns } from './view-columns';
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
  const { command, topLevelHelp, helpRequested, schemaRequested } = route;
  const managed = await buildManagedSurface(
    session,
    route.typedGlobals,
    !topLevelHelp &&
      !helpRequested &&
      !schemaRequested &&
      !isInspectOnlyLifecycle(session.lifecycle),
  );
  if (topLevelHelp || command === undefined)
    return respondTopLevelHelp(session, route, managed);
  if (!managed.resolved) {
    // Every native command already dispatched above, so this name could only
    // have come from the surface that failed to resolve. Report THAT, with the
    // exit code its error class declares.
    return exit(
      emitResult(
        managed.failure,
        { stdout, stderr },
        emitOptionsFor(config, route.framework.json, command),
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
  const filter = route.helpFilter;
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
    // The exit table `createCliInvoker` answers an unknown name with: one code for one fact.
    return exit(cliExitCode(unknownCliCommand(command), config.exitCodes));
  }
  if (route.helpRequested) {
    stdout(renderCommandHelp(config.name, command, descriptor, applicationOptions));
    return exit(0);
  }
  if (route.schemaRequested) {
    stdout(renderCommandSchema(command, descriptor));
    return exit(0);
  }
  const inspectErr = inspectOnlyError(session.lifecycle);
  if (inspectErr) {
    return exit(
      emitResult(
        toolResultFromError(inspectErr),
        { stdout, stderr },
        emitOptionsFor(config, route.framework.json, command),
      ),
    );
  }
  if (descriptor.unavailableReason !== undefined) {
    return exit(
      emitResult(
        unavailableCommand(descriptor.unavailableReason),
        { stdout, stderr },
        emitOptionsFor(config, route.framework.json, command),
      ),
    );
  }
  const stream = managed.streams.get(command);
  const tool = managed.tools.get(command);
  if (!tool && !stream) throw new Error('[stitchkit] managed CLI executable invariant failed');
  const prepared = await prepareInvocation(
    command,
    route.commandTokens,
    route.separatedBefore,
    route.framework,
    descriptor,
    config,
    readStdin,
  );
  if (!prepared.ok) {
    stderr(`${prepared.message}\n`);
    return exit(2);
  }
  const { toolArgs, options } = prepared;

  if (options.wait && !cliWaitConfig(config, command)) {
    stderr(`--wait is not configured for command "${command}"\n`);
    return exit(2);
  }
  if (options.waitTimeout !== undefined && !options.wait) {
    stderr('--wait-timeout requires --wait\n');
    return exit(2);
  }

  if (options.dryRun) {
    stdout(`${JSON.stringify({ command, args: toolArgs }, null, 2)}\n`);
    return exit(0);
  }

  if (stream) return runStreamCommand(session, route, managed, stream, { toolArgs, options });
  if (!tool) throw new Error('[stitchkit] managed CLI executable invariant failed');
  if (options.view !== undefined && !options.wait) {
    try {
      assertViewColumns(options.view, descriptor.outputSchema);
    } catch (error) {
      if (!(error instanceof CliArgumentError)) throw error;
      stderr(`${error.message}\n`);
      return exit(2);
    }
  }
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
  const runTool = createCliToolRunner(
    config,
    session.lifecycle,
    managed.auth,
    route.typedGlobals,
  );
  let result: ToolResult;
  try {
    result = await runTool(tool, toolArgs);
  } catch (err) {
    result = toolResultFromError(err);
  }

  const waitConfig = cliWaitConfig(config, command);
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

/** Saved media, the optional view, then the result and its exit code. */
async function emitManagedResult<
  TAuth,
  TContext extends Record<string, unknown>,
  TGlobals extends ZodObject,
>(
  session: CliSession<TAuth, TContext, TGlobals>,
  command: string,
  result: ToolResult,
  options: CliRunOptions,
  repeatable: boolean,
): Promise<void> {
  const { config } = session;
  const { stdout, stderr, exit } = session.io;
  const emit = { ...emitOptionsFor(config, options.json, command), repeatable };
  // A failed call reports its own error and exit code: nothing of it is saved, and
  // an aggregate over an error is not an answer to the question that was asked.
  if (!result.ok) return exit(emitResult(result, { stdout, stderr }, emit));

  // `result` stays the operation's answer, which a result policy judges. `shown` is
  // what stdout prints: saved inline files become links to where they are, a view
  // replaces the payload.
  let shown = result;
  let mediaExitCode = 0;
  if (options.outputDir !== undefined) {
    const saved = await saveResultMedia(result.data, {
      dir: options.outputDir,
      download: config.download,
      allowPrivateHosts: config.allowPrivateDownloadHosts ?? false,
      maxBytes: config.maxDownloadBytes ?? DEFAULT_DOWNLOAD_MAX_BYTES,
      timeoutMs: config.downloadTimeoutMs,
      quiet: options.quiet,
      stderr,
    });
    shown = { ...result, data: saved.data };
    if (!saved.ok) mediaExitCode = 1;
  }

  return exit(
    emitCliViewOrResult(
      cliResultPolicy(config, command),
      result,
      options,
      { stdout, stderr },
      emit,
      shown,
      mediaExitCode,
    ),
  );
}
