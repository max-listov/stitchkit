import type { ZodType, z } from 'zod';
import type {
  AgentCacheControl,
  AgentModelMessage,
  AgentModelProviderOptions,
  AgentToolModelOutput,
} from '../agent-parts/model';
import type { McpReportProgress } from '../contract/runtime-context';
import { isAsyncIterable, isRecord } from '../internal/typed';
import { toJsonSchema } from '../json-schema/json-schema';
import type { ServiceDef } from '../server/types';
import { inspectOnlyError, resolveToolAccess, type ToolAccess } from './access';
import { AgentToolError } from './agent-tool-error';
import type { ToolDurability, ToolDurabilityFactory } from './durability-port';
import { isToolExecutionControlError } from './execute';
import type { ErrorHintFn, ToolCallHooks } from './execute-hooks';
import { toolCauseFromResult, toolResultFromError } from './execute-result';
import { createToolRunner, formatToolError, type ToolExtend } from './mount';
import type { AgentToolRegistry } from './registry';
import { agentPresenterOf } from './runtime-tool';
import type { RuntimeToolDefinition } from './runtime-tool-declaration';
import { flattenToolJsonSchema, type ToolPresentationSchema } from './schema/flatten';
import { localVerdict } from './schema/json-schema-origin';
import { collectToolSurface } from './surface';

export interface AgentContext {
  [key: string]: unknown;
}

export interface AgentMountConfig {
  context?: AgentContext;
  /** Tool-call observability hooks. */
  hooks?: ToolCallHooks;
  /**
   * Required access policy for every mounted tool call — pass `{ gate }` with
   * `beforeHandle` (for example from `createAuthHook`), `{ open: 'public' | 'local-operator' | 'remote' }`,
   * or `{ inspect: true }` for read-only surface inspection that refuses every execution.
   */
  access: ToolAccess;
  extend?: ToolExtend;
  /** Coerce JSON-stringified arrays/objects in tool arguments. Default: true. */
  coerceJsonArgs?: boolean;
  /** Report output keys the contract schema removed — → ADR 0037. */
  onOutputStrip?: (toolName: string, paths: string[]) => void;
  /** Flatten discriminated union inputs into a single object. Default: false. */
  flattenUnionInput?: boolean;
  /**
   * Advertise every input, runtime tools included, with no `$ref`: references
   * written out, each recursive definition unrolled this many levels and
   * closed by an open node. For providers that refuse recursive schemas.
   * A tool's `tool.inputRecursionDepth` wins. Absent: references stay.
   */
  inputRecursionDepth?: number;
  /** The most levels the provider accepts in one input document; deeper nodes open. Absent: no limit. */
  inputNestingDepth?: number;
  /** Global error hint injected into every failed tool result. */
  errorHint?: ErrorHintFn;
  /** Framework-managed pathless operations mounted beside contract tools. */
  runtimeTools?: readonly RuntimeToolDefinition[];
  /**
   * A composed tool registry. Mutually exclusive with `runtimeTools`: one
   * declaration of the runtime surface, not two lists to reconcile.
   */
  registry?: AgentToolRegistry;
  /**
   * Make tool bodies restartable: `step` / `sleep` / `waitFor` appear in the
   * handler context, backed by whatever ledger the application already has.
   *
   * `agent-runtime` supplies its own durability through `AgentToolCall.durability`
   * and does not need this option; an application running its own loop declares
   * this factory instead.
   */
  durability?: ToolDurabilityFactory;
}

/** Per-invocation context handed directly to an `AgentTool` without an opaque side channel. */
export interface AgentToolCall {
  readonly toolCallId: string;
  readonly messages: readonly AgentModelMessage[];
  readonly abortSignal?: AbortSignal;
  readonly durability?: ToolDurability;
  readonly reportProgress?: McpReportProgress;
}

export interface AgentToolInputAvailableOptions<INPUT = unknown> {
  readonly input: INPUT;
  readonly toolCallId: string;
  readonly messages: readonly AgentModelMessage[];
  readonly abortSignal?: AbortSignal;
}

export interface AgentToolToModelOutputOptions<INPUT = unknown, OUTPUT = unknown> {
  readonly toolCallId: string;
  readonly input: INPUT;
  readonly output: OUTPUT;
}

export type AgentToolParseResult<INPUT> =
  | { readonly ok: true; readonly value: INPUT }
  | { readonly ok: false; readonly error: unknown };

/** Peer-free executable agent tool contract owned by `stitchkit/tools`. → ADR 0336. */
export interface AgentTool<INPUT = unknown, OUTPUT = unknown> {
  readonly description?: string;
  readonly inputSchema: ToolPresentationSchema;
  parseInput?(
    value: unknown,
  ): AgentToolParseResult<INPUT> | Promise<AgentToolParseResult<INPUT>>;
  execute?(
    input: INPUT,
    call: AgentToolCall,
  ): OUTPUT | AsyncIterable<OUTPUT> | Promise<OUTPUT | AsyncIterable<OUTPUT>>;
  /**
   * Bivariant predicate syntax so typed tools from `defineAgentTool` assign cleanly to
   * `AgentToolSet` (`Record<string, AgentTool>`) without casts.
   */
  needsApproval?:
    | boolean
    | { check(input: INPUT, call: AgentToolCall): boolean | PromiseLike<boolean> }['check'];
  onInputAvailable?(options: AgentToolInputAvailableOptions<INPUT>): void | PromiseLike<void>;
  toModelOutput?(
    options: AgentToolToModelOutputOptions<INPUT, OUTPUT>,
  ): AgentToolModelOutput | PromiseLike<AgentToolModelOutput>;
  readonly outputSchema?: z.ZodType<OUTPUT>;
  readonly strict?: boolean;
  readonly cacheControl?: AgentCacheControl;
  readonly providerOptions?: AgentModelProviderOptions;
}

export type AgentToolSet = Record<string, AgentTool>;

/** Declarative configuration for defining a standalone peer-free `AgentTool` from Zod schemas. */
export interface DefineAgentToolConfig<
  TInput extends ZodType,
  TOutput = unknown,
  TOutputInput = TOutput,
> {
  readonly description?: string;
  readonly input: TInput;
  readonly output?: ZodType<TOutput, TOutputInput> | undefined;
  readonly strict?: boolean;
  readonly cacheControl?: AgentCacheControl;
  readonly providerOptions?: AgentModelProviderOptions;
  readonly flattenUnionInput?: boolean;
  readonly needsApproval?:
    | boolean
    | ((input: z.output<TInput>, call: AgentToolCall) => boolean | PromiseLike<boolean>);
  onInputAvailable?(
    options: AgentToolInputAvailableOptions<z.output<TInput>>,
  ): void | PromiseLike<void>;
  toModelOutput?(
    options: AgentToolToModelOutputOptions<z.output<TInput>, TOutput>,
  ): AgentToolModelOutput | PromiseLike<AgentToolModelOutput>;
  execute?(
    input: z.output<TInput>,
    call: AgentToolCall,
  ):
    | TOutputInput
    | AsyncIterable<TOutputInput>
    | Promise<TOutputInput | AsyncIterable<TOutputInput>>;
}

const SELF_VALIDATED_NON_ITERABLE_EXECUTORS = new WeakSet<NonNullable<AgentTool['execute']>>();

function validateToolOutput<TOutput>(schema: ZodType<TOutput>, value: unknown): TOutput {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error('Tool output failed schema validation', { cause: parsed.error });
  }
  return parsed.data;
}

/**
 * Validate a tool's final output once at the step-loop finalization boundary when
 * `tool.outputSchema` is declared and was not already parsed inside `execute`
 * (streaming `AsyncIterable` returns and hand-constructed `AgentTool` literals).
 */
export function finalizeAgentToolOutput(
  tool: AgentTool,
  value: unknown,
  wasAsyncIterable: boolean,
): unknown {
  if (!tool.outputSchema) return value;
  if (
    !wasAsyncIterable &&
    typeof tool.execute === 'function' &&
    SELF_VALIDATED_NON_ITERABLE_EXECUTORS.has(tool.execute)
  ) {
    return value;
  }
  return validateToolOutput(tool.outputSchema, value);
}

function wrapToolExecute<TInput>(
  execute: (input: TInput, call: AgentToolCall) => unknown,
  outputSchema: ZodType<unknown>,
): NonNullable<AgentTool<TInput, unknown>['execute']> {
  return function (this: unknown, input: TInput, call: AgentToolCall) {
    const raw = execute.call(this, input, call);
    if (isAsyncIterable(raw)) {
      return raw;
    }
    if (raw instanceof Promise) {
      return raw.then((resolved) =>
        isAsyncIterable(resolved) ? resolved : validateToolOutput(outputSchema, resolved),
      );
    }
    return validateToolOutput(outputSchema, raw);
  };
}

/** Internal canonical Zod-to-input-JSON-Schema projection shared by `defineAgentTool` and `completeObject`. */
export function zodToAgentInputJsonSchema(schema: ZodType): Record<string, unknown> {
  return toJsonSchema(schema, 'input');
}

/**
 * Define one standalone peer-free `AgentTool` from a Zod input schema without importing
 * any external SDK (`ai`). → ADR 0336.
 */
export function defineAgentTool<TInput extends ZodType, TOutputSchema extends ZodType>(
  config: Omit<
    DefineAgentToolConfig<TInput, z.output<TOutputSchema>, z.input<TOutputSchema>>,
    'output'
  > & {
    readonly output: TOutputSchema;
  },
): AgentTool<z.output<TInput>, z.output<TOutputSchema>>;
export function defineAgentTool<TInput extends ZodType, TResult = unknown>(
  config: Omit<DefineAgentToolConfig<TInput>, 'output' | 'execute' | 'toModelOutput'> & {
    readonly output?: undefined;
    toModelOutput?(
      options: AgentToolToModelOutputOptions<
        z.output<TInput>,
        NoInfer<
          Awaited<TResult> extends infer R
            ? R extends AsyncIterable<infer TChunk>
              ? TChunk
              : R
            : never
        >
      >,
    ): AgentToolModelOutput | PromiseLike<AgentToolModelOutput>;
    execute?(input: z.output<TInput>, call: AgentToolCall): TResult;
  },
): AgentTool<
  z.output<TInput>,
  Awaited<TResult> extends infer R
    ? R extends AsyncIterable<infer TChunk>
      ? TChunk
      : R
    : never
>;
export function defineAgentTool<
  TInput extends ZodType,
  TOutput = unknown,
  TOutputInput = TOutput,
>(
  config: DefineAgentToolConfig<TInput, TOutput, TOutputInput>,
): AgentTool<z.output<TInput>, TOutput>;
export function defineAgentTool<TInput extends ZodType>(
  config: DefineAgentToolConfig<TInput, unknown, unknown>,
): AgentTool<z.output<TInput>, unknown> {
  const rawSchema = zodToAgentInputJsonSchema(config.input);
  const inputSchema: ToolPresentationSchema = config.flattenUnionInput
    ? flattenToolJsonSchema(rawSchema)
    : rawSchema;
  const parseInput = (value: unknown): AgentToolParseResult<z.output<TInput>> => {
    const parsed = config.input.safeParse(value);
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, error: parsed.error };
  };
  const execute =
    config.execute !== undefined && config.output !== undefined
      ? wrapToolExecute(config.execute, config.output)
      : config.execute;
  const tool: AgentTool<z.output<TInput>, unknown> = {
    ...(config.description !== undefined && { description: config.description }),
    inputSchema,
    parseInput,
    ...(config.output !== undefined && { outputSchema: config.output }),
    ...(config.strict !== undefined && { strict: config.strict }),
    ...(config.cacheControl !== undefined && { cacheControl: config.cacheControl }),
    ...(config.providerOptions !== undefined && { providerOptions: config.providerOptions }),
    ...(config.needsApproval !== undefined && { needsApproval: config.needsApproval }),
    ...(config.onInputAvailable !== undefined && {
      onInputAvailable: config.onInputAvailable,
    }),
    ...(config.toModelOutput !== undefined && { toModelOutput: config.toModelOutput }),
    ...(execute !== undefined && { execute }),
  };
  if (execute !== undefined && config.output !== undefined) {
    SELF_VALIDATED_NON_ITERABLE_EXECUTORS.add(execute);
  }
  return tool;
}

/** Internal builder shared by `mountAgentTools` and `mountAgent` so error messages name the caller. */
export function buildAgentTools(
  services: ServiceDef | ServiceDef[],
  config: AgentMountConfig,
  callerName: 'mountAgentTools' | 'mountAgent',
): AgentToolSet {
  const lifecycle = resolveToolAccess(callerName, config);
  const serviceList = Array.isArray(services) ? services : [services];
  if (config.registry && config.runtimeTools) {
    throw new Error(`${callerName} accepts either runtimeTools or a registry, not both`);
  }
  const runtimeTools = config.registry ? config.registry.tools : config.runtimeTools;
  const tools: AgentToolSet = {};
  const runTool = createToolRunner({
    source: 'agent',
    toolSurface: true,
    extend: config.extend,
    context: config.context,
    hooks: config.hooks,
    lifecycle,
    coerceJsonArgs: config.coerceJsonArgs,
    onOutputStrip: config.onOutputStrip,
  });

  for (const entry of collectToolSurface({
    surface: { services: serviceList, runtimeTools },
    transport: 'AGENT',
    extend: config.extend,
    flattenUnionInput: config.flattenUnionInput,
    inputRecursionDepth: config.inputRecursionDepth,
    inputNestingDepth: config.inputNestingDepth,
  })) {
    const { mountable } = entry;
    // Keep pre-execution input check at the object boundary so Zod `.transform()`,
    // `coerceJsonArgs`, tool hooks and `errorHint` run exactly once inside `execute`.
    const parseInput = (value: unknown): AgentToolParseResult<Record<string, unknown>> =>
      isRecord(value)
        ? { ok: true, value }
        : { ok: false, error: new Error('Tool arguments must be an object') };

    const execute = async (rawArgs: unknown, call: AgentToolCall): Promise<unknown> => {
      const inspectErr = inspectOnlyError(lifecycle);
      if (inspectErr) {
        const result = toolResultFromError(inspectErr);
        throw new AgentToolError(
          formatToolError(result, mountable.name, config.errorHint),
          toolCauseFromResult(result),
        );
      }
      const args = isRecord(rawArgs) ? rawArgs : {};
      // The runtime's own durability wins when present so its step ledger owns the run.
      const durability: ToolDurability | undefined =
        call.durability ?? config.durability?.(call.toolCallId, call.abortSignal);
      const callContext = {
        signal: call.abortSignal,
        toolCallId: call.toolCallId,
        ...(call.reportProgress && { reportProgress: call.reportProgress }),
      };
      const executeTool = durability
        ? createToolRunner({
            source: 'agent',
            toolSurface: true,
            extend: config.extend,
            context: {
              ...config.context,
              // Bound: a consumer-supplied class loses `this` when taken as a bare value.
              step: durability.step.bind(durability),
              sleep: durability.sleep.bind(durability),
              waitFor: durability.waitFor.bind(durability),
            },
            hooks: config.hooks,
            lifecycle,
            coerceJsonArgs: config.coerceJsonArgs,
            onOutputStrip: config.onOutputStrip,
          })
        : runTool;
      const result = await executeTool(mountable, args, callContext).catch((err: unknown) => {
        if (isToolExecutionControlError(err)) throw err;
        throw new AgentToolError(
          formatToolError(toolResultFromError(err), mountable.name, config.errorHint),
          err,
        );
      });
      if (result.ok) return result.data;
      throw new AgentToolError(
        formatToolError(result, mountable.name, config.errorHint),
        toolCauseFromResult(result),
      );
    };

    const presenter =
      entry.kind === 'runtime' ? agentPresenterOf(entry.definition) : undefined;
    if (entry.kind === 'runtime' && presenter) {
      const { definition } = entry;
      const output = definition.output;
      if (!output) {
        throw new Error(
          `Runtime tool "${definition.name}" presenter requires an output schema`,
        );
      }
      const mounted: AgentTool = {
        description: definition.description,
        inputSchema: mountable.presentationSchema,
        parseInput,
        outputSchema: output,
        execute,
        toModelOutput: async ({ output: rawOutput }) => {
          const parsed = output.safeParse(rawOutput);
          if (parsed.success) return presenter(parsed.data);
          if (localVerdict(output, parsed.error) === null) return presenter(rawOutput);
          return { type: 'text', value: JSON.stringify(rawOutput) };
        },
      };
      SELF_VALIDATED_NON_ITERABLE_EXECUTORS.add(execute);
      tools[definition.name] = mounted;
    } else {
      const output = entry.kind === 'runtime' ? entry.definition.output : undefined;
      const mounted: AgentTool = {
        description: mountable.method.desc,
        inputSchema: mountable.presentationSchema,
        parseInput,
        ...(output && { outputSchema: output }),
        execute,
      };
      if (output) SELF_VALIDATED_NON_ITERABLE_EXECUTORS.add(execute);
      tools[mountable.name] = mounted;
    }
  }

  return tools;
}

function isAgentMountConfig(
  value: ServiceDef | ServiceDef[] | AgentMountConfig,
): value is AgentMountConfig {
  return !Array.isArray(value) && 'access' in value;
}

/**
 * Project contract services and runtime tools into peer-free `AgentToolSet`.
 *
 * The single contract-to-agent projection: `stitchkit/agent-runtime` executes
 * this set directly, and `mountAgent` in `stitchkit/tools/agent` adapts it to
 * an AI SDK `ToolSet` for applications running their own SDK loop. → ADR 0336.
 */
export function mountAgentTools(config: AgentMountConfig): AgentToolSet;
export function mountAgentTools(
  services: ServiceDef | ServiceDef[],
  config: AgentMountConfig,
): AgentToolSet;
export function mountAgentTools(
  servicesOrConfig: ServiceDef | ServiceDef[] | AgentMountConfig,
  maybeConfig?: AgentMountConfig,
): AgentToolSet {
  if (maybeConfig === undefined) {
    if (!isAgentMountConfig(servicesOrConfig)) {
      throw new TypeError('mountAgentTools requires an AgentMountConfig');
    }
    return buildAgentTools([], servicesOrConfig, 'mountAgentTools');
  }
  if (isAgentMountConfig(servicesOrConfig)) {
    throw new TypeError(
      'mountAgentTools received config as the first argument alongside a second argument',
    );
  }
  return buildAgentTools(servicesOrConfig, maybeConfig, 'mountAgentTools');
}
