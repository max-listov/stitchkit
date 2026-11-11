import type { ZodObject } from 'zod';
import { AppError } from '../../contract/errors';
import {
  contractStreamLifetimeExceeded,
  readContractStreamItems,
} from '../../contract/stream';
import { isAsyncIterable } from '../../internal/typed';
import { type ToolFailure, type ToolResult, toolResultFromError } from '../execute-result';
import { createToolRunner, formatToolError } from '../mount';
import type { CliRunOptions } from './args';
import type { CliResultPolicy } from './command';
import { cliExitCode, emitResult } from './format';
import type { ManagedSurface } from './managed-surface';
import { cliResultPolicy } from './policy';
import { type CliRoute, type CliSession, emitOptionsFor } from './session';
import type { CliStreamOperation } from './stream-surface';

type ResolvedManagedSurface<TAuth> = Extract<ManagedSurface<TAuth>, { resolved: true }>;

/** How a feed ended: completed, its reader left, it was cancelled, or it failed with this result. */
type StreamOutcome = 'completed' | 'reader-gone' | 'cancelled' | ToolFailure;

/**
 * Run one contract stream as a command: a line per item until the stream
 * completes, fails, is cancelled, or its reader goes away.
 *
 * The call opens through the shared tool runner — the same validation, the
 * same `lifecycle.beforeHandle` gate, the same hooks as every other command —
 * and what the handler returns is read under the contract's own stream
 * descriptor, exactly as the HTTP response reads it.
 */
export async function runStreamCommand<
  TAuth,
  TContext extends Record<string, unknown>,
  TGlobals extends ZodObject,
>(
  session: CliSession<TAuth, TContext, TGlobals>,
  route: CliRoute<TGlobals>,
  managed: ResolvedManagedSurface<TAuth>,
  stream: CliStreamOperation,
  { toolArgs, options }: { toolArgs: Record<string, unknown>; options: CliRunOptions },
): Promise<void> {
  const { config } = session;
  const { stdout, stderr, exit } = session.io;
  const command = stream.tool.name;
  if (options.wait || options.outputDir !== undefined || options.view !== undefined) {
    stderr(
      `--wait, --output-dir and aggregate views do not apply to stream command "${command}"\n`,
    );
    return exit(2);
  }
  const abort = new AbortController();
  let cancelled = false;
  const cancel = (): void => {
    cancelled = true;
    abort.abort(config.signal?.reason);
  };
  if (config.signal?.aborted) cancel();
  else config.signal?.addEventListener('abort', cancel, { once: true });
  const runTool = createToolRunner({
    source: 'cli',
    toolSurface: true,
    context: { ...config.context?.(managed.auth, route.typedGlobals), signal: abort.signal },
    hooks: config.hooks,
    lifecycle: config.lifecycle,
    coerceJsonArgs: config.coerceJsonArgs,
  });
  let opened: ToolResult;
  try {
    opened = await runTool(stream.tool, toolArgs);
  } catch (error) {
    opened = toolResultFromError(error);
  }
  const policy = cliResultPolicy(config, command);
  let outcome: StreamOutcome;
  if (!opened.ok) outcome = opened;
  else if (!isAsyncIterable(opened.data)) {
    outcome = toolResultFromError(
      new Error(`Stream command "${command}" handler did not return an async iterable`),
    );
  } else {
    outcome = await printStreamItems(
      opened.data,
      stream,
      abort,
      () => cancelled,
      (item) => session.io.stdoutWhileOpen(streamLine(command, item, policy, options)),
    );
  }
  config.signal?.removeEventListener('abort', cancel);
  if (outcome === 'completed' || outcome === 'reader-gone') return exit(0);
  // The application cancelled the invocation: nothing failed and nothing is
  // printed; the exit code is the one a cancelled call earns everywhere else.
  if (outcome === 'cancelled' || cancelled) {
    return exit(cliExitCode({ ok: false, code: 'REQUEST_ABORTED' }, config.exitCodes));
  }
  return exit(
    emitResult(outcome, { stdout, stderr }, emitOptionsFor(config, options.json, command)),
  );
}

/** One item as its stdout line: the command's own presentation, else compact JSON. */
function streamLine(
  command: string,
  item: unknown,
  policy: CliResultPolicy<unknown> | undefined,
  options: Readonly<CliRunOptions>,
): string {
  if (policy?.present === undefined) return `${JSON.stringify(item)}\n`;
  let line: unknown;
  try {
    line = policy.present({ result: item, options });
    if (typeof line !== 'string') throw new Error('CLI result presenter must return a string');
  } catch (error) {
    throw new AppError('CLI_PRESENTATION_FAILED', {
      message: 'A stream item was produced, but its presentation failed.',
      status: 500,
      details: { command, cause: formatToolError(toolResultFromError(error)) },
    });
  }
  return line;
}

/**
 * Read the source under its descriptor, handing each accepted item to `write`.
 * The source is always closed before this returns, however the feed ended.
 */
async function printStreamItems(
  source: AsyncIterable<unknown>,
  { descriptor }: CliStreamOperation,
  abort: AbortController,
  wasCancelled: () => boolean,
  write: (item: unknown) => boolean,
): Promise<StreamOutcome> {
  const iterator = source[Symbol.asyncIterator]();
  let lifetimeExpired = false;
  const lifetime =
    descriptor.lifetimeMs === undefined
      ? undefined
      : setTimeout(() => {
          lifetimeExpired = true;
          abort.abort(new Error('Stream lifetime expired'));
        }, descriptor.lifetimeMs);
  lifetime?.unref?.();
  try {
    for await (const { item } of readContractStreamItems(iterator, descriptor, abort.signal)) {
      if (!write(item)) return 'reader-gone';
    }
    return 'completed';
  } catch (error) {
    if (wasCancelled()) return 'cancelled';
    if (lifetimeExpired) {
      return toolResultFromError(contractStreamLifetimeExceeded());
    }
    return toolResultFromError(error);
  } finally {
    if (lifetime !== undefined) clearTimeout(lifetime);
    abort.abort();
    // The source's own cleanup is neither the feed's result nor its deadline: a
    // generator's `return()` queues behind a pending `next()`, so a source that
    // ignores its signal would hold the command for as long as it sleeps. It is
    // asked to close and not waited for; a close that throws changes nothing.
    void Promise.resolve()
      .then(() => iterator.return?.(undefined))
      .catch(() => undefined);
  }
}
