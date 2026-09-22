/**
 * Running one already-parsed operation, in this process.
 *
 * The most common way an agent drives a CLI is not one command — it is a
 * stream: a JSON line per operation, an answer per line. The framework owned
 * the parsing, the routing, the JSON mode, the exit codes and the error shape,
 * and handed out no way to say "run this parsed call and give me its result".
 * So a consumer's stream loop spawned the binary again per line: three
 * conversions of the same data (arguments back into `--flag value` strings,
 * nested objects through `JSON.stringify` into an argv slot, the result parsed
 * back out of stdout text) plus a process start each time — measured at 0.15 s,
 * which is thirty seconds for a two-hundred-line manifest before any work
 * happens. The ban on nesting one stream inside another existed for the same
 * reason and disappears with it.
 *
 * `createCliInvoker` compiles the managed surface once and executes against it.
 * `createCli` is built on this same function, so the stream and the command
 * line cannot answer differently: one surface, one runner, one exit table.
 *
 * Native commands (`config.commands`) are deliberately outside it. They write
 * to stdout and stderr by construction — that is what they are — and an
 * operation that prints is not an operation whose result can be returned.
 */
import type { ZodObject, z } from 'zod';
import type { ServiceDef, StitchLogger } from '../server/types';
import { cliExitCode, type ExitCodeMap } from './cli-format';
import {
  applyCliPresentationPolicy,
  assertCliPoliciesResolved,
  type CliCommandPresentation,
  type CliPresentationPolicyConfig,
} from './cli-policy';
import {
  type ErrorHintFn,
  type ToolCallHooks,
  type ToolLifecycle,
  type ToolResult,
  toolErrorFromResult,
  toolResultFromError,
} from './execute';
import { createToolRunner, type MountableTool } from './mount';
import type { RuntimeToolDefinition } from './runtime-tool';
import { collectToolSurface } from './surface';

export type CliSurfaceSource<TAuth, TValue> =
  | readonly TValue[]
  | ((auth: Awaited<TAuth> | undefined) => readonly TValue[]);

/**
 * What an invocation needs to exist: the surface, the identity behind it and
 * the policies every call runs under. Everything about a terminal — argv,
 * writers, `--wait`, downloads — belongs to `CliConfig`, which extends this.
 */
export interface CliInvokerConfig<
  TAuth = unknown,
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TGlobals extends ZodObject = ZodObject,
> extends CliPresentationPolicyConfig {
  /** Program name — used in diagnostics. */
  name: string;
  /** Contract services exposed as commands — may depend on the resolved identity. */
  services?: CliSurfaceSource<TAuth, ServiceDef>;
  /** Pathless managed operations. CLI exposure always requires `transports: ['CLI']`. */
  runtimeTools?: CliSurfaceSource<TAuth, RuntimeToolDefinition>;
  auth?: TAuth | Promise<TAuth>;
  resolveAuth?: (globals: z.output<TGlobals>) => TAuth | Promise<TAuth>;
  globalOptions?: TGlobals;
  context?: (auth: Awaited<TAuth> | undefined, globals: z.output<TGlobals>) => TContext;
  signal?: AbortSignal;
  hooks?: ToolCallHooks;
  lifecycle?: ToolLifecycle;
  logger?: StitchLogger;
  coerceJsonArgs?: boolean;
  errorHint?: ErrorHintFn;
  exitCodes?: ExitCodeMap;
  passthrough?: Record<string, string>;
}

/** What one parsed invocation produced — never printed, never exited on. */
export interface CliInvocationResult {
  ok: boolean;
  /** The exit code the printed path would give this same result. */
  exitCode: number;
  /** The validated handler output, on success. */
  data?: unknown;
  /** The refusal, in the shape the CLI prints on failure. */
  error?: {
    code: string;
    message: string;
    details?: unknown;
    hint?: string;
    retryable?: boolean;
  };
}

/** One resolved managed command. */
export interface CliInvokerCommand {
  name: string;
  description: string;
}

/** The compiled surface: what can be run, and how to run it. */
export interface CliInvoker {
  /** Every managed command, in surface order. */
  readonly commands: readonly CliInvokerCommand[];
  /**
   * Run one parsed call. Never writes, never exits. An unknown command is a
   * `NOT_FOUND` result rather than a throw, because a stream must answer the
   * line that was wrong and keep reading the ones that follow.
   */
  invoke(command: string, args: Record<string, unknown>): Promise<CliInvocationResult>;
}

/** The internal shape `createCli` needs back — the surface plus its runner. */
export interface ResolvedCliSurface {
  tools: Map<string, MountableTool>;
  help: Map<string, CliCommandPresentation>;
  auth: unknown;
}

/**
 * Shape a `ToolResult` into an invocation result — the same error body the CLI
 * prints, and the same exit code, produced without printing either.
 */
export function cliInvocationResult(
  result: ToolResult,
  toolName: string,
  config: { errorHint?: ErrorHintFn; exitCodes?: ExitCodeMap },
): CliInvocationResult {
  if (result.ok) return { ok: true, exitCode: 0, data: result.data };
  const normalized = toolErrorFromResult(result);
  const hints: string[] = [];
  if (result.hint) hints.push(result.hint);
  const global = config.errorHint?.(toolName, result.code);
  if (global) hints.push(global);
  return {
    ok: false,
    exitCode: cliExitCode(result, config.exitCodes),
    error: {
      code: result.code,
      message: normalized.message,
      ...(result.details !== undefined && { details: result.details }),
      ...(hints.length > 0 && { hint: hints.join(' ') }),
      ...(result.retryable !== undefined && { retryable: result.retryable }),
    },
  };
}

/**
 * Compile the managed surface and return a dispatcher over it.
 *
 * Identity resolves once, not per call: a stream of two hundred operations must
 * not resolve auth two hundred times, and a CLI invocation speaks as one
 * identity by construction.
 */
export async function createCliInvoker<
  TAuth = unknown,
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TGlobals extends ZodObject = ZodObject,
>(
  config: CliInvokerConfig<TAuth, TContext, TGlobals>,
  globals: z.output<TGlobals> = {} as z.output<TGlobals>,
): Promise<CliInvoker> {
  const auth = await (config.resolveAuth ? config.resolveAuth(globals) : config.auth);
  const { tools, help } = buildCliSurface(config, auth, new Map(), new Set());
  const runTool = createToolRunner({
    source: 'cli',
    context: { ...config.context?.(auth, globals), signal: config.signal },
    hooks: config.hooks,
    lifecycle: config.lifecycle,
    errorHint: config.errorHint,
    coerceJsonArgs: config.coerceJsonArgs,
  });
  return {
    commands: [...help].map(([name, presentation]) => ({
      name,
      description: presentation.description,
    })),
    invoke: async (command, args) => {
      const tool = tools.get(command);
      if (!tool) {
        return cliInvocationResult(
          {
            ok: false,
            code: 'NOT_FOUND',
            details: { message: `Unknown command "${command}"` },
          },
          command,
          config,
        );
      }
      let result: ToolResult;
      try {
        result = await runTool(tool, args);
      } catch (error) {
        result = toolResultFromError(error);
      }
      return cliInvocationResult(result, command, config);
    },
  };
}

/**
 * Walk the declared surface into executable tools and their presentation.
 *
 * Shared with `createCli`, which starts from its native commands rather than an
 * empty map — the uniqueness and shape checks have to see both halves, or a
 * managed command could silently shadow a native one.
 */
export function buildCliSurface<
  TAuth,
  TContext extends Record<string, unknown>,
  TGlobals extends ZodObject,
>(
  config: CliInvokerConfig<TAuth, TContext, TGlobals>,
  auth: Awaited<TAuth> | undefined,
  nativeHelp: Map<string, CliCommandPresentation>,
  applicationGlobalNames: ReadonlySet<string>,
  assertShape?: (
    name: string,
    descriptor: CliCommandPresentation,
    exists: boolean,
    passthroughField: string | undefined,
    globalNames: ReadonlySet<string>,
  ) => void,
): { tools: Map<string, MountableTool>; help: Map<string, CliCommandPresentation> } {
  const services =
    typeof config.services === 'function' ? config.services(auth) : (config.services ?? []);
  const runtimeTools =
    typeof config.runtimeTools === 'function'
      ? config.runtimeTools(auth)
      : (config.runtimeTools ?? []);
  const tools = new Map<string, MountableTool>();
  const help = new Map(nativeHelp);
  for (const { mountable } of collectToolSurface({
    surface: { services, runtimeTools },
    transport: 'CLI',
  })) {
    const descriptor = applyCliPresentationPolicy(
      mountable.name,
      managedCliDescriptor(mountable),
      config,
    );
    assertShape?.(
      mountable.name,
      descriptor,
      help.has(mountable.name),
      config.passthrough?.[mountable.name],
      applicationGlobalNames,
    );
    tools.set(mountable.name, mountable);
    help.set(mountable.name, descriptor);
  }
  assertCliPoliciesResolved(help, config);
  return { tools, help };
}

/** How a managed tool presents itself — the same shape a native command builds. */
export function managedCliDescriptor(
  tool: MountableTool,
): Omit<CliCommandPresentation, 'aliases' | 'positionals'> {
  return {
    description: tool.method.desc,
    argumentSchema: tool.argumentSchema,
    presentationSchema: tool.presentationSchema,
  };
}
