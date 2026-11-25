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
import type { ServiceDef, StitchLogger } from '../../server/types';
import { resolveOptionalCliToolAccess, type ToolAccess } from '../access';
import type { ErrorHintFn, ToolCallHooks } from '../execute-hooks';
import { type ToolResult, toolResultFromError } from '../execute-result';
import { toolSurfaceOutputSchema } from '../internal/tool-view';
import type { MountableTool } from '../mount';
import type { RuntimeToolDefinition } from '../runtime-tool-declaration';
import { collectToolSurface } from '../surface';
import { parseCliGlobalValues } from './args-fields';
import {
  type CliCommandDefinition,
  cliCommandReturnsResult,
  executeNativeCommand,
  shapeCliInvocationResult,
} from './command';
import { invokerCommandShapeIssue, nativeCliDescriptor } from './command-shape';
import type { ExitCodeMap } from './format';
import {
  applyCliPresentationPolicy,
  assertCliPoliciesResolved,
  assertNoLegacyCliPolicyKeys,
  type CliCommandName,
  type CliCommandPresentation,
  type CliPresentationPolicyConfig,
  cliPassthroughField,
  cliResultPolicy,
} from './policy';
import { assertCliAuthConfig, createCliToolRunner, resolveCliIdentity } from './runner';
import { type CliStreamOperation, collectCliStreams } from './stream-surface';
import { unknownCliCommand } from './unavailable';

export type CliSurfaceSource<
  TAuth,
  TValue,
  TGlobals extends Record<string, unknown> = Record<string, unknown>,
> =
  | readonly TValue[]
  | ((auth: Awaited<TAuth> | undefined, globals: TGlobals) => readonly TValue[]);

type CliServicesFactory<TAuth, TGlobals extends ZodObject> = (
  auth: Awaited<TAuth> | undefined,
  globals: z.output<TGlobals>,
) => readonly ServiceDef[];

type CliRuntimeToolsFactory<TAuth, TGlobals extends ZodObject> = (
  auth: Awaited<TAuth> | undefined,
  globals: z.output<TGlobals>,
) => readonly RuntimeToolDefinition[];

interface CliInvokerBaseConfig<
  TAuth = unknown,
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TGlobals extends ZodObject = ZodObject,
  TServices extends readonly ServiceDef[] | undefined = readonly ServiceDef[],
  TRuntime extends
    | readonly RuntimeToolDefinition[]
    | undefined = readonly RuntimeToolDefinition[],
  TCommands extends
    | readonly CliCommandDefinition[]
    | undefined = readonly CliCommandDefinition[],
> extends CliPresentationPolicyConfig<CliCommandName<TServices, TRuntime, TCommands>> {
  /** Program name — used in diagnostics. */
  name: string;
  /** CLI-only executable commands, dispatched before the managed surface. */
  commands?: TCommands;
  /**
   * Identity for the single CLI invocation — resolved ONCE at startup (from an
   * env var / token file), like a stdio MCP server, not per call. A value or a
   * promise of one.
   */
  auth?: TAuth | Promise<TAuth>;
  /**
   * Lazily resolve identity only when a managed command/surface actually needs
   * it. Receives the application's global options, so `--caller <key>` can
   * select WHICH identity this invocation speaks as.
   */
  resolveAuth?: (globals: z.output<TGlobals>) => TAuth | Promise<TAuth>;
  /**
   * The application's OWN global options — invocation context that belongs to
   * no single operation: which identity key, which checkout, which profile.
   * Declared as a Zod object of optional fields; `createCli` lifts these flags
   * out of argv wherever they stand (before or after the command name),
   * validates them against this schema and keeps them out of every operation's
   * arguments. A name that collides with a framework option or with a field of
   * any command is a startup error, never silent shadowing.
   */
  globalOptions?: TGlobals;
  /**
   * Context merged into every handler. Typed against the app's context shape
   * when the CLI is built via `createToolkit<AppContext>()`.
   */
  context?: (auth: Awaited<TAuth> | undefined, globals: z.output<TGlobals>) => TContext;
  /** Explicit cancellation for this invocation; applications may bind SIGINT to it. */
  signal?: AbortSignal;
  /** Tool-call observability hooks — `afterToolCall` fires for every result,
   *  `onToolError` for the raw value behind a thrown one. */
  hooks?: ToolCallHooks;
  logger?: StitchLogger;
  /** Coerce JSON-stringified arrays/objects in arguments. Default: true. */
  coerceJsonArgs?: boolean;
  /** Global error hint appended to every failed command's error. */
  errorHint?: ErrorHintFn;
  /** Override exit codes per `ToolResult.code`, merged over the defaults. */
  exitCodes?: ExitCodeMap;
}

type CliSurfaceAccessConfig<
  TAuth,
  TGlobals extends ZodObject,
  TServices extends readonly ServiceDef[],
  TRuntime extends readonly RuntimeToolDefinition[],
> =
  | {
      /** Contract services exposed as commands — absent on a native-only CLI. */
      services?: never;
      /** Pathless managed operations — absent on a native-only CLI. */
      runtimeTools?: never;
      /** Optional on a native-only CLI (native commands do not run through the tool lifecycle). */
      access?: ToolAccess;
    }
  | {
      /** Contract services exposed as commands — may depend on resolved identity and globals. */
      services?: TServices | CliServicesFactory<TAuth, TGlobals>;
      /** Pathless managed operations. CLI exposure always requires `expose: ['CLI']`. */
      runtimeTools?: TRuntime | CliRuntimeToolsFactory<TAuth, TGlobals>;
      /**
       * Required access policy for every managed CLI command — pass `{ gate }` with
       * `beforeHandle` or explicitly mark the surface `{ open: 'public' | 'local-operator' | 'remote' }`.
       */
      access: ToolAccess;
    };

/**
 * What an invocation needs to exist: the surface, the identity behind it and
 * the policies every call runs under. Everything about a terminal — argv,
 * writers, `--wait`, downloads — belongs to `CliConfig`, which extends this.
 *
 * When `services` or `runtimeTools` are declared, `access` is required; a
 * native-only CLI (`commands` only) does not run the tool lifecycle and needs
 * no `access`.
 */
export type CliInvokerConfig<
  TAuth = unknown,
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TGlobals extends ZodObject = ZodObject,
  TServices extends readonly ServiceDef[] = readonly ServiceDef[],
  TRuntime extends readonly RuntimeToolDefinition[] = readonly RuntimeToolDefinition[],
  TCommands extends readonly CliCommandDefinition[] = readonly CliCommandDefinition[],
> = CliInvokerBaseConfig<TAuth, TContext, TGlobals, TServices, TRuntime, TCommands> &
  CliSurfaceAccessConfig<TAuth, TGlobals, TServices, TRuntime>;

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
   * `UNKNOWN_OPERATION` result rather than a throw, because a stream must answer the
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
  return shapeCliInvocationResult(result, toolName, config);
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
  TServices extends readonly ServiceDef[] = never,
  TRuntime extends readonly RuntimeToolDefinition[] = never,
  TCommands extends readonly CliCommandDefinition[] = never,
>(
  config: CliInvokerConfig<TAuth, TContext, TGlobals, TServices, TRuntime, TCommands>,
  globals?: Record<string, unknown>,
): Promise<CliInvoker> {
  const lifecycle = resolveOptionalCliToolAccess('createCliInvoker', config);
  assertNoLegacyCliPolicyKeys(config);
  assertCliAuthConfig(config);
  const typedGlobals = parseCliGlobalValues(config.globalOptions, globals);
  const auth = await resolveCliIdentity(config, typedGlobals)();
  // Only the half that returns a value is invocable in process. Every native
  // command is still validated and passed to `buildCliSurface` so duplicates
  // and invalid `commandSettings` fail at startup while `result` on native stays refused.
  const natives = new Map<string, CliCommandDefinition>();
  const allNativeHelp = new Map<string, CliCommandPresentation>();
  for (const definition of config.commands ?? []) {
    const descriptor = applyCliPresentationPolicy(
      definition.name,
      nativeCliDescriptor(definition),
      config,
    );
    invokerCommandShapeIssue(
      definition.name,
      descriptor,
      allNativeHelp.has(definition.name),
      cliPassthroughField(config, definition.name),
    );
    allNativeHelp.set(definition.name, descriptor);
    if (cliCommandReturnsResult(definition)) natives.set(definition.name, definition);
  }
  const { tools, help } = buildCliSurface(
    config,
    auth,
    typedGlobals,
    allNativeHelp,
    new Set(),
    invokerCommandShapeIssue,
  );
  const runTool = createCliToolRunner(config, lifecycle, auth, typedGlobals);
  return {
    commands: [
      ...[...natives].map(([name, definition]) => ({
        name,
        description: definition.description,
      })),
      ...[...help]
        .filter(
          ([name, presentation]) =>
            !allNativeHelp.has(name) && presentation.unavailableReason === undefined,
        )
        .map(([name, presentation]) => ({
          name,
          description: presentation.description,
        })),
    ],
    invoke: async (command, args) => {
      const native = natives.get(command);
      if (native) {
        return executeNativeCommand(
          native,
          args,
          config.coerceJsonArgs ?? true,
          typedGlobals,
          {
            mode: 'in-process',
            errorHint: config.errorHint,
            exitCodes: config.exitCodes,
          },
        );
      }
      const tool = tools.get(command);
      if (!tool) {
        return cliInvocationResult(unknownCliCommand(command), command, config);
      }
      let result: ToolResult;
      try {
        result = await runTool(tool, args);
      } catch (error) {
        result = toolResultFromError(error);
      }
      return shapeCliInvocationResult(
        result,
        command,
        config,
        cliResultPolicy(config, command),
      );
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
  typedGlobals: z.output<TGlobals>,
  nativeHelp: Map<string, CliCommandPresentation>,
  applicationGlobalNames: ReadonlySet<string>,
  shapeIssue?: (
    name: string,
    descriptor: CliCommandPresentation,
    exists: boolean,
    passthroughField: string | undefined,
    globalNames: ReadonlySet<string>,
  ) => string | undefined,
): {
  tools: Map<string, MountableTool>;
  streams: Map<string, CliStreamOperation>;
  help: Map<string, CliCommandPresentation>;
} {
  resolveOptionalCliToolAccess('buildCliSurface', config);
  assertNoLegacyCliPolicyKeys(config);
  const services =
    typeof config.services === 'function'
      ? config.services(auth, typedGlobals)
      : (config.services ?? []);
  const runtimeTools =
    typeof config.runtimeTools === 'function'
      ? config.runtimeTools(auth, typedGlobals)
      : (config.runtimeTools ?? []);
  const tools = new Map<string, MountableTool>();
  const help = new Map(nativeHelp);
  for (const { kind, mountable } of collectToolSurface({
    surface: { services, runtimeTools },
    transport: 'CLI',
  })) {
    const descriptor = applyCliPresentationPolicy(
      mountable.name,
      managedCliDescriptor(mountable),
      config,
    );
    const issue = shapeIssue?.(
      mountable.name,
      descriptor,
      help.has(mountable.name),
      cliPassthroughField(config, mountable.name),
      applicationGlobalNames,
    );
    if (issue !== undefined) {
      if (kind !== 'runtime') throw new Error(issue);
      help.set(mountable.name, { ...descriptor, unavailableReason: issue });
    } else {
      tools.set(mountable.name, mountable);
      help.set(mountable.name, descriptor);
    }
  }
  const streams = collectCliStreams(services);
  for (const [name, stream] of streams) {
    const descriptor = applyCliPresentationPolicy(
      name,
      {
        ...managedCliDescriptor(stream.tool),
        outputSchema: stream.descriptor.item,
        stream: true,
      },
      config,
    );
    const issue = shapeIssue?.(
      name,
      descriptor,
      help.has(name),
      cliPassthroughField(config, name),
      applicationGlobalNames,
    );
    if (issue !== undefined) throw new Error(issue);
    help.set(name, descriptor);
  }
  assertCliPoliciesResolved(help, config);
  for (const [name, settings] of Object.entries(config.commandSettings ?? {})) {
    const policy = settings?.result;
    if (!policy) continue;
    if (!tools.has(name) && !streams.has(name)) {
      throw new Error(
        `[stitchkit] CLI result policy "${name}" targets a command that is not managed; a native command declares present and exitCode on defineCliCommand`,
      );
    }
    if (policy.output !== undefined && policy.output !== help.get(name)?.outputSchema) {
      throw new Error(
        `[stitchkit] CLI result policy "${name}" is typed against a schema that is not the one the command answers with; pass the command's own output schema to defineCliResult`,
      );
    }
    if (streams.has(name) && policy.exitCode !== undefined) {
      throw new Error(
        `[stitchkit] CLI result policy "${name}" declares exitCode for a stream command; a stream has no single result to classify`,
      );
    }
  }
  return { tools, streams, help };
}

/** How a managed tool presents itself — the same shape a native command builds. */
export function managedCliDescriptor(
  tool: MountableTool,
): Omit<CliCommandPresentation, 'aliases' | 'positionals'> {
  return {
    description: tool.method.desc,
    argumentSchema: tool.argumentSchema,
    presentationSchema: tool.presentationSchema,
    outputSchema: toolSurfaceOutputSchema(tool.method),
  };
}
