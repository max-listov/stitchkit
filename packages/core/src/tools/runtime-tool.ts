import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from 'ai';
import type { ZodObject, ZodType, z } from 'zod';
import type {
  EndpointToolAnnotations,
  EndpointUiMeta,
  HttpMethod,
  RuntimeContext,
} from '../contract';
import type { OperationIdentity } from '../server/types';
import type { ToolOperation } from './execute';
import type { MountableTool } from './mount';
import { assertToolName } from './names';
import { buildToolPresentationSchema } from './presentation';

export type RuntimeToolTransport = 'MCP' | 'AGENT';

export interface RuntimeToolIdentity {
  serviceName: string;
  action: string;
  scope?: string;
  /** Semantic operation verb for lifecycle and RequestEvent attribution. */
  method: HttpMethod;
  meta?: Record<string, unknown>;
}

export type RuntimeToolHandlerContext<TInput extends ZodObject> = RuntimeContext & {
  params: undefined;
  input: z.output<TInput>;
};

export type RuntimeToolOutput<TOutput extends ZodType | undefined> = TOutput extends ZodType
  ? z.output<TOutput>
  : undefined;

/** Parsed application context plus the canonical runtime-tool input fields. */
export type RuntimeToolFactoryHandlerContext<
  TContext extends ZodObject,
  TInput extends ZodObject,
> = Omit<z.output<TContext>, 'input' | 'params'> & {
  params: undefined;
  input: z.output<TInput>;
};

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

export interface RuntimeToolDefinitionBase<TInput extends ZodObject> {
  name: string;
  description: string;
  identity: RuntimeToolIdentity;
  input: TInput;
  /** Default: both MCP and AGENT. */
  transports?: readonly RuntimeToolTransport[];
  annotations?: EndpointToolAnnotations;
  ui?: EndpointUiMeta;
}

export interface RuntimeToolDefinitionWithOutput<
  TInput extends ZodObject,
  TOutput extends ZodType,
> extends RuntimeToolDefinitionBase<TInput> {
  output: TOutput;
  handler: (
    context: RuntimeToolHandlerContext<TInput>,
  ) => z.output<TOutput> | Promise<z.output<TOutput>>;
  present?: RuntimeToolPresenters<z.output<TOutput>>;
}

export interface RuntimeToolDefinitionWithoutOutput<TInput extends ZodObject>
  extends RuntimeToolDefinitionBase<TInput> {
  output?: never;
  handler: (context: RuntimeToolHandlerContext<TInput>) => void | Promise<void>;
  present?: never;
}

export type RuntimeToolDefinition =
  | RuntimeToolDefinitionWithOutput<ZodObject, ZodType>
  | RuntimeToolDefinitionWithoutOutput<ZodObject>;

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
> = Omit<RuntimeToolDefinitionWithOutput<TInput, TOutput>, 'handler' | 'identity'> &
  RuntimeToolFactoryIdentityFields & {
    handler: (
      context: RuntimeToolFactoryHandlerContext<TContext, TInput>,
    ) => z.output<TOutput> | Promise<z.output<TOutput>>;
  };

export type RuntimeToolFactoryDefinitionWithoutOutput<
  TContext extends ZodObject,
  TInput extends ZodObject,
> = Omit<RuntimeToolDefinitionWithoutOutput<TInput>, 'handler' | 'identity'> &
  RuntimeToolFactoryIdentityFields & {
    handler: (
      context: RuntimeToolFactoryHandlerContext<TContext, TInput>,
    ) => void | Promise<void>;
  };

export interface RuntimeToolFactory<TContext extends ZodObject> {
  define<TInput extends ZodObject, TOutput extends ZodType>(
    definition: RuntimeToolFactoryDefinitionWithOutput<TContext, TInput, TOutput>,
  ): RuntimeToolDefinitionWithOutput<TInput, TOutput>;
  define<TInput extends ZodObject>(
    definition: RuntimeToolFactoryDefinitionWithoutOutput<TContext, TInput>,
  ): RuntimeToolDefinitionWithoutOutput<TInput>;
}

/** Typed identity helper; execution remains owned by the transport mounts. */
export function defineRuntimeTool<TInput extends ZodObject, TOutput extends ZodType>(
  definition: RuntimeToolDefinitionWithOutput<TInput, TOutput>,
): RuntimeToolDefinitionWithOutput<TInput, TOutput>;
export function defineRuntimeTool<TInput extends ZodObject>(
  definition: RuntimeToolDefinitionWithoutOutput<TInput>,
): RuntimeToolDefinitionWithoutOutput<TInput>;
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
  function parseContext<TInput extends ZodObject>(
    context: RuntimeToolHandlerContext<TInput>,
  ): RuntimeToolFactoryHandlerContext<TContext, TInput> {
    const parsed = config.context.parse(context);
    return { ...parsed, params: undefined, input: context.input };
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

export function runtimeToolSupports(
  definition: RuntimeToolDefinition,
  transport: RuntimeToolTransport,
): boolean {
  if (definition.transports?.length === 0) {
    throw new Error(`Runtime tool "${definition.name}" must expose at least one transport`);
  }
  return !definition.transports || definition.transports.includes(transport);
}

export function runtimeToolIdentity(definition: RuntimeToolDefinition): OperationIdentity {
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
  };
}

export function runtimeToolMountable(
  definition: RuntimeToolDefinition,
  assertName = true,
): MountableTool {
  if (assertName) {
    assertToolName(
      definition.name,
      definition.identity.serviceName,
      definition.identity.action,
    );
  }
  const method: ToolOperation = {
    ...runtimeToolIdentity(definition),
    inputSchema: definition.input,
    outputSchema: definition.output,
    handler: definition.handler,
  };
  return {
    method,
    name: definition.name,
    argumentSchema: definition.input,
    presentationSchema: buildToolPresentationSchema({
      inputSchema: definition.input,
      unrepresentable: 'any',
    }),
    shouldExtend: false,
  };
}
