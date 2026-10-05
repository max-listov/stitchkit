import type { CallToolResult } from '@modelcontextprotocol/server';

/**
 * Preserve the SDK's required content and metadata despite its extension index.
 * Validation and error state belong to the canonical runner, never a presenter.
 */
export type RuntimeMcpPresentation = CallToolResult & {
  structuredContent?: never;
  isError?: never;
};

/**
 * The MCP presenters a tool declaration may carry as its `present` extension.
 * Declared as methods so a presenter written for one tool's output registers
 * beside the others; the canonical runner validates the output before it calls one.
 */
export interface RuntimeMcpToolPresenters<TOutput> {
  mcp?(output: TOutput): RuntimeMcpPresentation | Promise<RuntimeMcpPresentation>;
}
