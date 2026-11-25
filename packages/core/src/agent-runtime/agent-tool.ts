import type { ZodObject, ZodType, z } from 'zod';

/** Static non-executable metadata for a built-in agent-only runtime tool. */
export interface AgentToolDescriptor<
  TInput extends ZodObject = ZodObject,
  TOutput extends ZodType = ZodType,
> {
  readonly name: string;
  readonly description: string;
  readonly identity: {
    readonly serviceName: string;
    readonly action: string;
    readonly scope?: string;
    readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    readonly meta?: Readonly<Record<string, unknown>>;
  };
  readonly input: TInput;
  readonly output: TOutput;
  readonly expose: readonly ['AGENT'];
}

/** Peer-neutral tool definition for surfaces exposed only to an agent model. */
export interface AgentToolDefinition<TInput extends ZodObject, TOutput extends ZodType> {
  name: string;
  description: string;
  identity: {
    serviceName: string;
    action: string;
    scope?: string;
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    meta?: Record<string, unknown>;
  };
  input: TInput;
  output: TOutput;
  expose: readonly ['AGENT'];
  handler(context: unknown): unknown;
}

/** Freeze a static agent tool descriptor so consumers inspecting catalogs cannot mutate shared metadata. */
export function defineAgentToolDescriptor<TInput extends ZodObject, TOutput extends ZodType>(
  descriptor: AgentToolDescriptor<TInput, TOutput>,
): AgentToolDescriptor<TInput, TOutput> {
  const identity = Object.freeze({
    ...descriptor.identity,
    ...(descriptor.identity.meta !== undefined && {
      meta: Object.freeze({ ...descriptor.identity.meta }),
    }),
  });
  const expose: readonly ['AGENT'] = Object.freeze(['AGENT'] as const);
  return Object.freeze({
    ...descriptor,
    identity,
    expose,
  });
}

/** Bind a frozen static descriptor to a run-scoped handler without duplicating schemas or metadata. */
export function bindAgentTool<TInput extends ZodObject, TOutput extends ZodType>(
  descriptor: AgentToolDescriptor<TInput, TOutput>,
  handler: (context: {
    input: z.output<TInput>;
  }) => z.output<TOutput> | Promise<z.output<TOutput>>,
): AgentToolDefinition<TInput, TOutput> {
  return {
    name: descriptor.name,
    description: descriptor.description,
    identity: {
      ...descriptor.identity,
      ...(descriptor.identity.meta !== undefined && {
        meta: { ...descriptor.identity.meta },
      }),
    },
    input: descriptor.input,
    output: descriptor.output,
    expose: descriptor.expose,
    // Boundary: `AgentToolDefinition.handler` accepts `unknown` after the tool runner parses `descriptor.input`.
    handler: (context) => handler(context as { input: z.output<TInput> }),
  };
}
