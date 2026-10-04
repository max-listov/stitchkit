import type { ZodObject, ZodType, z } from 'zod';
import type { HttpMethod, ToolTransport } from '../contract/define';
import type { McpCallContext, RuntimeContext } from '../contract/runtime-context';
import type {
  EndpointMcpPolicy,
  EndpointToolAnnotations,
  EndpointUiMeta,
} from '../contract/tool-options';
import type { LocalStepDurability } from '../durability/contract';

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
  step?: LocalStepDurability['step'];
  sleep?: LocalStepDurability['sleep'];
  waitFor?: LocalStepDurability['waitFor'];
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

export interface RuntimeToolDefinitionBase<
  TInput extends ZodObject,
  TMcp extends EndpointMcpPolicy | undefined = undefined,
> {
  name: string;
  description: string;
  identity: RuntimeToolIdentity;
  input: TInput;
  /** Default: MCP and AGENT. CLI is always explicit opt-in. */
  transports?: readonly ToolTransport[];
  annotations?: EndpointToolAnnotations;
  ui?: EndpointUiMeta;
  /** Opt-in multi-round input gate on the MCP transport only. */
  mcp?: TMcp;
}

/** Executable contract shared by CLI and SDK adapters; presentation belongs to the adapter. */
export interface RuntimeToolExecutionWithOutput<
  TInput extends ZodObject,
  TOutput extends ZodType,
  TMcp extends EndpointMcpPolicy | undefined = undefined,
> extends RuntimeToolDefinitionBase<TInput, TMcp> {
  output: TOutput;
  handler: (
    context: RuntimeToolHandlerContext<TInput, TMcp>,
  ) => z.output<TOutput> | Promise<z.output<TOutput>>;
}

export interface RuntimeToolDefinitionWithoutOutput<
  TInput extends ZodObject,
  TMcp extends EndpointMcpPolicy | undefined = undefined,
> extends RuntimeToolDefinitionBase<TInput, TMcp> {
  output?: never;
  handler: (context: RuntimeToolHandlerContext<TInput, TMcp>) => void | Promise<void>;
  present?: never;
}

/**
 * Heterogeneous registration preserves each definition's validated input shape.
 * Its erased handler cannot be called directly: the canonical mount supplies
 * schema-parsed input before execution. Construction uses the generic contracts.
 */
export type RuntimeToolExecution =
  | (Omit<
      RuntimeToolExecutionWithOutput<ZodObject, ZodType, EndpointMcpPolicy | undefined>,
      'handler'
    > & {
      handler: (
        context: never,
      ) => ReturnType<
        RuntimeToolExecutionWithOutput<
          ZodObject,
          ZodType,
          EndpointMcpPolicy | undefined
        >['handler']
      >;
    })
  | (Omit<
      RuntimeToolDefinitionWithoutOutput<ZodObject, EndpointMcpPolicy | undefined>,
      'handler'
    > & {
      handler: (
        context: never,
      ) => ReturnType<
        RuntimeToolDefinitionWithoutOutput<ZodObject, EndpointMcpPolicy | undefined>['handler']
      >;
    });
