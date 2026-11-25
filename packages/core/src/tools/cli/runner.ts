/**
 * Single CLI execution foundation shared by `createCli` (managed + stream)
 * and `createCliInvoker`: identity resolution with memoisation and the one
 * `createToolRunner` bridge.
 */
import type { ZodObject, z } from 'zod';
import type { ToolLifecycle } from '../execute-hooks';
import type { ToolResult } from '../execute-result';
import { createToolRunner } from '../mount';
import type { CliInvokerConfig } from './invoke';
import { projectCliUnixFailure } from './unix-outcome';

/** Refuse configuring both `auth` and `resolveAuth` at startup. */
export function assertCliAuthConfig<
  TAuth,
  TContext extends Record<string, unknown>,
  TGlobals extends ZodObject,
>(config: Pick<CliInvokerConfig<TAuth, TContext, TGlobals>, 'auth' | 'resolveAuth'>): void {
  if (config.auth !== undefined && config.resolveAuth !== undefined) {
    throw new Error('[stitchkit] createCli: use either auth or resolveAuth, not both');
  }
}

/**
 * Memoised identity resolver for one CLI invocation.
 *
 * Uses an async IIFE rather than `Promise.resolve(...)` so a synchronous throw
 * inside `resolveAuth` is captured in the memoised rejection instead of escaping
 * before assignment and running a second time.
 */
export function resolveCliIdentity<TAuth, TGlobals extends ZodObject>(
  config: Pick<
    CliInvokerConfig<TAuth, Record<string, unknown>, TGlobals>,
    'auth' | 'resolveAuth'
  >,
  typedGlobals: z.output<TGlobals>,
): () => Promise<Awaited<TAuth> | undefined> {
  let authPromise: Promise<Awaited<TAuth> | undefined> | undefined;
  return () => {
    authPromise ??= (async (): Promise<Awaited<TAuth> | undefined> =>
      config.resolveAuth ? await config.resolveAuth(typedGlobals) : await config.auth)();
    return authPromise;
  };
}

/**
 * Build the one tool runner every CLI path (`createCli`, stream commands and
 * `createCliInvoker`) executes managed operations through.
 *
 * Per-call context overrides (such as a stream command's local `AbortSignal`)
 * are passed on the runner's third `context` argument.
 */
export function createCliToolRunner<
  TAuth,
  TContext extends Record<string, unknown>,
  TGlobals extends ZodObject,
>(
  config: Pick<
    CliInvokerConfig<TAuth, TContext, TGlobals>,
    'context' | 'signal' | 'hooks' | 'coerceJsonArgs'
  >,
  lifecycle: ToolLifecycle,
  auth: Awaited<TAuth> | undefined,
  typedGlobals: z.output<TGlobals>,
) {
  const run = createToolRunner({
    source: 'cli',
    toolSurface: true,
    context: { ...config.context?.(auth, typedGlobals), signal: config.signal },
    hooks: config.hooks,
    lifecycle,
    coerceJsonArgs: config.coerceJsonArgs,
  });
  return async (
    tool: Parameters<typeof run>[0],
    rawArgs: Parameters<typeof run>[1],
    context?: Parameters<typeof run>[2],
    call?: Parameters<typeof run>[3],
  ): Promise<ToolResult> => {
    const result = await run(tool, rawArgs, context, call);
    return result.ok ? result : projectCliUnixFailure(result);
  };
}
