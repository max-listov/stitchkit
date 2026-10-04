import type { Tool } from 'ai';
import type { ZodObject, ZodType, z } from 'zod';
import type { HttpMethod } from '../contract/define';
import type { EndpointMcpPolicy } from '../contract/tool-options';
import type { OperationIdentity } from '../server/types';
import type { ToolOperation } from './execute';
import {
  projectRuntimeTool,
  type SurfaceAgentRuntimeToolDefinition,
} from './internal/surface-projector';
import type { MountableTool } from './mount';
import type {
  RuntimeToolDefinitionWithoutOutput,
  RuntimeToolExecution,
  RuntimeToolExecutionWithOutput,
  RuntimeToolFactoryHandlerContext,
  RuntimeToolHandlerContext,
  RuntimeToolIdentity,
} from './runtime-tool-execution';
import type { RuntimeMcpToolPresenters } from './runtime-tool-mcp';

export type {
  RuntimeMcpInput,
  RuntimeToolDefinitionBase,
  RuntimeToolDefinitionWithoutOutput,
  RuntimeToolFactoryHandlerContext,
  RuntimeToolHandlerContext,
  RuntimeToolIdentity,
  RuntimeToolOutput,
} from './runtime-tool-execution';
export type { RuntimeMcpPresentation } from './runtime-tool-mcp';

export type RuntimeAgentModelOutput = Awaited<
  ReturnType<NonNullable<Tool<unknown, unknown>['toModelOutput']>>
>;

export interface RuntimeToolPresenters<TOutput> extends RuntimeMcpToolPresenters<TOutput> {
  agent?: (output: TOutput) => RuntimeAgentModelOutput | PromiseLike<RuntimeAgentModelOutput>;
}

export interface RuntimeToolDefinitionWithOutput<
  TInput extends ZodObject,
  TOutput extends ZodType,
  TMcp extends EndpointMcpPolicy | undefined = undefined,
> extends RuntimeToolExecutionWithOutput<TInput, TOutput, TMcp> {
  present?: RuntimeToolPresenters<z.output<TOutput>>;
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

function runtimeToolIdentity(definition: RuntimeToolExecution): OperationIdentity {
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
  definition: RuntimeToolExecution,
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

/**
 * Agent-only public declarations use a peer-free structural tool definition.
 * Construction validates executable functions before this boundary restores
 * the richer internal definition consumed by the canonical mount. A named cast
 * boundary (ADR 0003): the checks above are what make the cast true.
 */
export function executableAgentRuntimeTools(
  tools: readonly SurfaceAgentRuntimeToolDefinition[],
): readonly RuntimeToolDefinition[] {
  for (const tool of tools) {
    if (typeof tool.handler !== 'function') {
      throw new TypeError(`Runtime tool "${tool.name}" must provide a handler`);
    }
    if (tool.present?.agent !== undefined && typeof tool.present.agent !== 'function') {
      throw new TypeError(`Runtime tool "${tool.name}" Agent presenter must be a function`);
    }
    if (tool.present?.agent !== undefined && tool.output === undefined) {
      throw new TypeError(
        `Runtime tool "${tool.name}" Agent presenter requires an output schema`,
      );
    }
  }
  return tools as readonly RuntimeToolDefinition[];
}
