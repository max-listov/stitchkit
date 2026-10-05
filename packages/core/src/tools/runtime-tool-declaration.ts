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

/**
 * The one declaration of a runtime tool, with no SDK declaration in it. The
 * `present` slot is the adapters' extension point: an adapter names the
 * presenters it understands as the fourth type argument (the MCP presenters of
 * `stitchkit/tools/mcp`, the MCP and Agent presenters of `stitchkit/tools`), and
 * the neutral default admits none. Execution never reads it.
 */
export interface RuntimeToolDefinitionWithOutput<
  TInput extends ZodObject,
  TOutput extends ZodType,
  TMcp extends EndpointMcpPolicy | undefined = undefined,
  TPresent = undefined,
> extends RuntimeToolDefinitionBase<TInput, TMcp> {
  output: TOutput;
  handler: (
    context: RuntimeToolHandlerContext<TInput, TMcp>,
  ) => z.output<TOutput> | Promise<z.output<TOutput>>;
  present?: TPresent;
}

/**
 * A runtime tool that declares no `output` schema; its handler returns nothing and has no
 * `present` slot.
 */
export interface RuntimeToolDefinitionWithoutOutput<
  TInput extends ZodObject,
  TMcp extends EndpointMcpPolicy | undefined = undefined,
> extends RuntimeToolDefinitionBase<TInput, TMcp> {
  output?: never;
  handler: (context: RuntimeToolHandlerContext<TInput, TMcp>) => void | Promise<void>;
  present?: never;
}

/**
 * The input every registered handler is shaped for: any object the canonical runner parsed.
 */
type RegisteredHandlerContext = RuntimeToolHandlerContext<
  ZodObject,
  EndpointMcpPolicy | undefined
>;

/**
 * Heterogeneous registration of runtime tools (`runtimeTools: [...]`), where every
 * tool has its own input schema. Each registered handler is declared as a METHOD:
 * a method parameter is compared bivariantly, so a handler constructed against
 * its own schema is accepted, and an inline handler is contextually typed by the
 * loose parsed-object context instead of being erased. The canonical runner parses
 * the input against the tool's schema before it calls the handler.
 *
 * `present` is whatever presenters the declaring adapter attached; the mount that
 * reads them narrows what it finds, because each presenter was typed against its
 * own tool when it was declared.
 */
export type RuntimeToolDefinition =
  | (Omit<
      RuntimeToolDefinitionWithOutput<
        ZodObject,
        ZodType,
        EndpointMcpPolicy | undefined,
        unknown
      >,
      'handler'
    > & {
      handler(context: RegisteredHandlerContext): unknown;
    })
  | (Omit<
      RuntimeToolDefinitionWithoutOutput<ZodObject, EndpointMcpPolicy | undefined>,
      'handler'
    > & {
      handler(context: RegisteredHandlerContext): void | Promise<void>;
    });
