import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ZodObject, ZodType, z } from 'zod';
import type { EndpointMcpPolicy } from '../contract/tool-options';
import type {
  RuntimeToolExecution,
  RuntimeToolExecutionWithOutput,
} from './runtime-tool-execution';

/**
 * Preserve the SDK's required content and metadata despite its extension index.
 * Validation and error state belong to the canonical runner, never a presenter.
 */
export type RuntimeMcpPresentation = CallToolResult & {
  structuredContent?: never;
  isError?: never;
};

export interface RuntimeMcpToolPresenters<TOutput> {
  mcp?: (output: TOutput) => RuntimeMcpPresentation | Promise<RuntimeMcpPresentation>;
}

/** Schema-aware construction for an MCP tool without an AI SDK declaration. */
export interface RuntimeMcpToolDefinitionWithOutput<
  TInput extends ZodObject,
  TOutput extends ZodType,
  TMcp extends EndpointMcpPolicy | undefined = undefined,
> extends RuntimeToolExecutionWithOutput<TInput, TOutput, TMcp> {
  present?: RuntimeMcpToolPresenters<z.output<TOutput>>;
}

/**
 * Heterogeneous registration retains typed definitions. The canonical runner
 * parses input and output before invoking either erased function.
 */
export type RuntimeMcpToolDefinition = RuntimeToolExecution & {
  present?: RuntimeMcpToolPresenters<never>;
};
