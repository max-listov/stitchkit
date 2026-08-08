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
