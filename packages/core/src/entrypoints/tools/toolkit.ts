/**
 * `stitchkit/tools/toolkit` — one tool set served over MCP and to an AI SDK agent.
 *
 * The toolkit composes both adapters, so this subpath needs both optional peers,
 * `@modelcontextprotocol/server` and `ai`. A server that needs only one of them
 * imports `stitchkit/tools/mcp` or `stitchkit/tools/agent`. → ADR 0284.
 */
export { createToolkit, type Toolkit } from '../../tools/toolkit';
