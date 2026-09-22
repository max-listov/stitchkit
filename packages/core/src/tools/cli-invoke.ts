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
 * Native commands (`config.commands`) are in it when, and only when, they
 * declare `output`. The two halves of a native definition are not the same kind
 * of thing: one returns a validated value the frame prints, the other prints
 * itself and returns `void`. Only the second cannot be run where there is no
 * stdout, and excluding both because of it cost a consumer a working `describe`
 * line for no reason the type could not already tell apart.
 *
 * `present` is not called on this path: it is stdout formatting, and there is
 * no stdout. `exitCode` is, through the same function the command line uses, so
 * a script branching on the code cannot see the two paths disagree. Anything
 * the handler does write is captured and returned on the result rather than
 * leaking into a caller's stream of answers.
 */
import type { ZodObject, z } from 'zod';
import type { ServiceDef, StitchLogger } from '../server/types';
import type { CliRunOptions } from './cli-args';
import {
  type CliCommandDefinition,
  cliCommandReturnsResult,
  cliCommandSuccessExitCode,
  executeCliCommand,
} from './cli-command';
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
  /** CLI-only executable commands, dispatched before the managed surface. */
  commands?: readonly CliCommandDefinition[];
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

/**
 * The application's global options, validated by the schema that declared them.
 *
 * `{}` is not a safe stand-in for "none given": a schema with `.default()`
 * fields turns an empty object into a populated one, and those values are what
 * `resolveAuth` and `context` read.
 */
function parseCliGlobals<TGlobals extends ZodObject>(
  schema: TGlobals | undefined,
  globals: Record<string, unknown> | undefined,
): z.output<TGlobals> {
  if (!schema) return (globals ?? {}) as z.output<TGlobals>;
  return schema.parse(globals ?? {});
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
  /**
   * What a native handler wrote, when it wrote anything.
   *
   * A command that declares `output` is not supposed to write — the frame
   * prints for it — but it holds the writers and may log. In process there is
   * nowhere for that text to go: printing it would interleave with a caller's
   * own output and corrupt a stream of JSON lines, and dropping it would lose a
   * diagnostic silently. So it comes back here, and the caller decides.
   */
  written?: { stdout?: string; stderr?: string };
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
  globals?: Record<string, unknown>,
): Promise<CliInvoker> {
  // Parsed through the application's own schema, exactly as `createCli` parses
  // what it lifts out of argv. Handing the raw object through would skip every
  // declared default, and those defaults reach `resolveAuth` and `context` —
  // so a line of a stream would run as a different identity, or against a
  // different base URL, than the same call typed at a prompt. That is the one
  // divergence this whole seam exists to prevent.
  const typedGlobals = parseCliGlobals(config.globalOptions, globals);
  const auth = await (config.resolveAuth ? config.resolveAuth(typedGlobals) : config.auth);
  // Only the half that returns a value. A printing command stays unreachable
  // here and answers NOT_FOUND, which is the honest answer: it has no result to
  // give and running it would write into a caller that never asked for output.
  const natives = new Map<string, CliCommandDefinition>(
    (config.commands ?? [])
      .filter(cliCommandReturnsResult)
      .map((definition) => [definition.name, definition]),
  );
  const nativeHelp = new Map(
    [...natives].map(([name, definition]) => [
      name,
      { description: definition.description, argumentSchema: {}, presentationSchema: {} },
    ]),
  );
  const { tools, help } = buildCliSurface(config, auth, new Map(), new Set());
  const runTool = createToolRunner({
    source: 'cli',
    context: { ...config.context?.(auth, typedGlobals), signal: config.signal },
    hooks: config.hooks,
    lifecycle: config.lifecycle,
    errorHint: config.errorHint,
    coerceJsonArgs: config.coerceJsonArgs,
  });
  return {
    commands: [...nativeHelp, ...help].map(([name, presentation]) => ({
      name,
      description: presentation.description,
    })),
    invoke: async (command, args) => {
      const native = natives.get(command);
      if (native) return runNativeCommand(native, args, config, typedGlobals);
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
 * The run options a native command sees in process.
 *
 * Every terminal-shaped switch is off, because none of them has a meaning
 * without a terminal: `--json` chooses a printing format, `--wait` and
 * `--output-dir` are already refused for native commands on the command line,
 * and `--help` and `--dry-run` print instead of executing. A handler reading
 * these gets the same answer it would get from a bare invocation.
 */
const IN_PROCESS_RUN_OPTIONS: Readonly<CliRunOptions> = Object.freeze({
  json: false,
  wait: false,
  quiet: true,
  dryRun: false,
  help: false,
});

async function runNativeCommand<
  TAuth,
  TContext extends Record<string, unknown>,
  TGlobals extends ZodObject,
>(
  definition: CliCommandDefinition,
  args: Record<string, unknown>,
  config: CliInvokerConfig<TAuth, TContext, TGlobals>,
  globals: Readonly<Record<string, unknown>>,
): Promise<CliInvocationResult> {
  let out = '';
  let err = '';
  const result = await executeCliCommand(
    definition,
    args,
    IN_PROCESS_RUN_OPTIONS,
    {
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
    },
    config.coerceJsonArgs ?? true,
    globals,
  );
  let invocation = cliInvocationResult(result, definition.name, config);
  if (invocation.ok) {
    try {
      invocation = {
        ...invocation,
        exitCode: cliCommandSuccessExitCode(definition, result.ok ? result.data : undefined),
      };
    } catch (error) {
      invocation = cliInvocationResult(toolResultFromError(error), definition.name, config);
    }
  }
  if (out === '' && err === '') return invocation;
  return {
    ...invocation,
    written: { ...(out !== '' && { stdout: out }), ...(err !== '' && { stderr: err }) },
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
