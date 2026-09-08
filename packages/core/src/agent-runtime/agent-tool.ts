import type { ZodObject, ZodType, z } from 'zod';

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
  transports: readonly ['AGENT'];
  handler(context: unknown): unknown;
}

interface AgentToolSourceDefinition<TInput extends ZodObject, TOutput extends ZodType>
  extends Omit<AgentToolDefinition<TInput, TOutput>, 'handler'> {
  handler(context: {
    input: z.output<TInput>;
  }): z.output<TOutput> | Promise<z.output<TOutput>>;
}

export function defineAgentTool<TInput extends ZodObject, TOutput extends ZodType>(
  definition: AgentToolSourceDefinition<TInput, TOutput>,
): AgentToolDefinition<TInput, TOutput> {
  return {
    ...definition,
    handler: (context) => definition.handler(context as { input: z.output<TInput> }),
  };
}
