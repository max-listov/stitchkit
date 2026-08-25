import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from 'ai';
import type { ZodObject, ZodType, z } from 'zod';
import type {
  EndpointMcpPolicy,
  EndpointToolAnnotations,
  EndpointUiMeta,
  HttpMethod,
  McpCallContext,
  RuntimeContext,
} from '../contract';
import type { OperationIdentity } from '../server/types';
import type { ToolOperation } from './execute';
import { projectRuntimeTool } from './internal/surface-projector';
import type { MountableTool } from './mount';

export type RuntimeToolTransport = 'MCP' | 'AGENT' | 'CLI';

export interface RuntimeToolIdentity {
  serviceName: string;
  action: string;
  scope?: string;
  /** Semantic operation verb for lifecycle and RequestEvent attribution. */
  method: HttpMethod;
  meta?: Record<string, unknown>;
}

export type RuntimeMcpInput<TMcp extends EndpointMcpPolicy | undefined> =
  TMcp extends EndpointMcpPolicy<infer TRequests>
    ? {
        mcpInput?: {
          [Request in TRequests[number] as Request['key']]: z.output<Request['schema']>;
        };
      }
    : unknown;

export type RuntimeToolHandlerContext<
  TInput extends ZodObject,
  TMcp extends EndpointMcpPolicy | undefined = undefined,
> = RuntimeContext & {
  params: undefined;
  input: z.output<TInput>;
} & RuntimeMcpInput<TMcp>;

export type RuntimeToolOutput<TOutput extends ZodType | undefined> = TOutput extends ZodType
  ? z.output<TOutput>
  : undefined;

/** Parsed application context plus the canonical runtime-tool input fields. */
export type RuntimeToolFactoryHandlerContext<
  TContext extends ZodObject,
  TInput extends ZodObject,
  TMcp extends EndpointMcpPolicy | undefined = undefined,
> = Omit<RuntimeContext, 'input' | 'params' | 'mcp'> &
  Omit<z.output<TContext>, 'input' | 'params' | 'mcp'> & {
    params: undefined;
    input: z.output<TInput>;
    mcp?: McpCallContext;
  } & RuntimeMcpInput<TMcp>;

/** MCP-owned fields; validation and error state are always supplied by Stitchkit. */
export type RuntimeMcpPresentation = Omit<CallToolResult, 'structuredContent' | 'isError'> & {
  structuredContent?: never;
  isError?: never;
};

export type RuntimeAgentModelOutput = Awaited<
  ReturnType<NonNullable<Tool<unknown, unknown>['toModelOutput']>>
>;

export interface RuntimeToolPresenters<TOutput> {
  mcp?: (output: TOutput) => RuntimeMcpPresentation | Promise<RuntimeMcpPresentation>;
  agent?: (output: TOutput) => RuntimeAgentModelOutput | PromiseLike<RuntimeAgentModelOutput>;
}

export interface RuntimeToolDefinitionBase<
  TInput extends ZodObject,
  TMcp extends EndpointMcpPolicy | undefined = undefined,
> {
  name: string;
  description: string;
  identity: RuntimeToolIdentity;
  input: TInput;
  /** Default: MCP and AGENT. CLI is always explicit opt-in. */
  transports?: readonly RuntimeToolTransport[];
  annotations?: EndpointToolAnnotations;
  ui?: EndpointUiMeta;
  /** Opt-in multi-round input gate on the MCP transport only. */
  mcp?: TMcp;
}

export interface RuntimeToolDefinitionWithOutput<
  TInput extends ZodObject,
  TOutput extends ZodType,
  TMcp extends EndpointMcpPolicy | undefined = undefined,
> extends RuntimeToolDefinitionBase<TInput, TMcp> {
  output: TOutput;
  handler: (
    context: RuntimeToolHandlerContext<TInput, TMcp>,
  ) => z.output<TOutput> | Promise<z.output<TOutput>>;
  present?: RuntimeToolPresenters<z.output<TOutput>>;
}

export interface RuntimeToolDefinitionWithoutOutput<
  TInput extends ZodObject,
  TMcp extends EndpointMcpPolicy | undefined = undefined,
> extends RuntimeToolDefinitionBase<TInput, TMcp> {
  output?: never;
  handler: (context: RuntimeToolHandlerContext<TInput, TMcp>) => void | Promise<void>;
  present?: never;
}

export type RuntimeToolDefinition =
  | RuntimeToolDefinitionWithOutput<ZodObject, ZodType, EndpointMcpPolicy | undefined>
  | RuntimeToolDefinitionWithoutOutput<ZodObject, EndpointMcpPolicy | undefined>;

export interface RuntimeToolFactoryConfig<TContext extends ZodObject> {
  serviceName: string;
  scope?: string;
  context: TContext;
  meta?: Record<string, unknown>;
}

export interface RuntimeToolFactoryIdentityFields {
  action: string;
  method: HttpMethod;
  meta?: Record<string, unknown>;
}

export type RuntimeToolFactoryDefinitionWithOutput<
  TContext extends ZodObject,
  TInput extends ZodObject,
  TOutput extends ZodType,
  TMcp extends EndpointMcpPolicy | undefined = undefined,
> = Omit<RuntimeToolDefinitionWithOutput<TInput, TOutput, TMcp>, 'handler' | 'identity'> &
  RuntimeToolFactoryIdentityFields & {
    handler: (
      context: RuntimeToolFactoryHandlerContext<TContext, TInput, TMcp>,
    ) => z.output<TOutput> | Promise<z.output<TOutput>>;
  };

export type RuntimeToolFactoryDefinitionWithoutOutput<
  TContext extends ZodObject,
  TInput extends ZodObject,
  TMcp extends EndpointMcpPolicy | undefined = undefined,
> = Omit<RuntimeToolDefinitionWithoutOutput<TInput, TMcp>, 'handler' | 'identity'> &
  RuntimeToolFactoryIdentityFields & {
    handler: (
      context: RuntimeToolFactoryHandlerContext<TContext, TInput, TMcp>,
    ) => void | Promise<void>;
  };

export interface RuntimeToolFactory<TContext extends ZodObject> {
  define<
    TInput extends ZodObject,
    TOutput extends ZodType,
    const TMcp extends EndpointMcpPolicy | undefined = undefined,
  >(
    definition: RuntimeToolFactoryDefinitionWithOutput<TContext, TInput, TOutput, TMcp>,
  ): RuntimeToolDefinitionWithOutput<TInput, TOutput, TMcp>;
  define<
    TInput extends ZodObject,
    const TMcp extends EndpointMcpPolicy | undefined = undefined,
  >(
    definition: RuntimeToolFactoryDefinitionWithoutOutput<TContext, TInput, TMcp>,
  ): RuntimeToolDefinitionWithoutOutput<TInput, TMcp>;
}

/** Typed identity helper; execution remains owned by the transport mounts. */
export function defineRuntimeTool<
  TInput extends ZodObject,
  TOutput extends ZodType,
  const TMcp extends EndpointMcpPolicy | undefined = undefined,
>(
  definition: RuntimeToolDefinitionWithOutput<TInput, TOutput, TMcp>,
): RuntimeToolDefinitionWithOutput<TInput, TOutput, TMcp>;
export function defineRuntimeTool<
  TInput extends ZodObject,
  const TMcp extends EndpointMcpPolicy | undefined = undefined,
>(
  definition: RuntimeToolDefinitionWithoutOutput<TInput, TMcp>,
): RuntimeToolDefinitionWithoutOutput<TInput, TMcp>;
export function defineRuntimeTool(definition: RuntimeToolDefinition): RuntimeToolDefinition {
  if (definition.transports?.length === 0) {
    throw new Error(`Runtime tool "${definition.name}" must expose at least one transport`);
  }
  return definition;
}

/**
 * Bind shared runtime-tool identity and validate application context once per
 * call while keeping execution in the canonical tool runner.
 */
export function createRuntimeToolFactory<TContext extends ZodObject>(
  config: RuntimeToolFactoryConfig<TContext>,
): RuntimeToolFactory<TContext> {
  function parseContext<
    TInput extends ZodObject,
    TMcp extends EndpointMcpPolicy | undefined = undefined,
  >(
    context: RuntimeToolHandlerContext<TInput, TMcp>,
  ): RuntimeToolFactoryHandlerContext<TContext, TInput, TMcp> {
    const parsed = config.context.parse(context);
    return {
      ...context,
      ...parsed,
      params: undefined,
      input: context.input,
      ...(context.mcp !== undefined && { mcp: context.mcp }),
    };
  }

  function define<TInput extends ZodObject, TOutput extends ZodType>(
    definition: RuntimeToolFactoryDefinitionWithOutput<TContext, TInput, TOutput>,
  ): RuntimeToolDefinitionWithOutput<TInput, TOutput>;
  function define<TInput extends ZodObject>(
    definition: RuntimeToolFactoryDefinitionWithoutOutput<TContext, TInput>,
  ): RuntimeToolDefinitionWithoutOutput<TInput>;
  function define(
    definition:
      | RuntimeToolFactoryDefinitionWithOutput<TContext, ZodObject, ZodType>
      | RuntimeToolFactoryDefinitionWithoutOutput<TContext, ZodObject>,
  ): RuntimeToolDefinition {
    if (definition.output !== undefined) {
      const { action, method, meta, handler, ...tool } = definition;
      const identity: RuntimeToolIdentity = {
        serviceName: config.serviceName,
        action,
        method,
        ...(config.scope !== undefined && { scope: config.scope }),
        ...((meta ?? config.meta) !== undefined && { meta: meta ?? config.meta }),
      };
      return defineRuntimeTool({
        ...tool,
        identity,
        handler: (context) => handler(parseContext(context)),
      });
    }

    const { action, method, meta, handler, ...tool } = definition;
    const identity: RuntimeToolIdentity = {
      serviceName: config.serviceName,
      action,
      method,
      ...(config.scope !== undefined && { scope: config.scope }),
      ...((meta ?? config.meta) !== undefined && { meta: meta ?? config.meta }),
    };
    return defineRuntimeTool({
      ...tool,
      identity,
      handler: (context) => handler(parseContext(context)),
    });
  }

  return { define };
}

function runtimeToolIdentity(definition: RuntimeToolDefinition): OperationIdentity {
  return {
    method: definition.identity.method,
    desc: definition.description,
    serviceName: definition.identity.serviceName,
    key: definition.identity.action,
    toolName: definition.name,
    scope: definition.identity.scope,
    meta: definition.identity.meta,
    annotations: definition.annotations,
    ui: definition.ui,
    mcp: definition.mcp,
  };
}

export function runtimeToolMountable(
  definition: RuntimeToolDefinition,
  assertName = true,
): MountableTool {
  const projected = projectRuntimeTool(definition, assertName);
  const method: ToolOperation = {
    ...runtimeToolIdentity(definition),
    inputSchema: definition.input,
    outputSchema: definition.output,
    handler: definition.handler,
  };
  return {
    method,
    name: projected.name,
    argumentSchema: definition.input,
    presentationSchema: projected.presentationSchema,
    shouldExtend: false,
  };
}
