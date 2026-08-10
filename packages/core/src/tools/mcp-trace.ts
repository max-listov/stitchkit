import {
  BAGGAGE_META_KEY,
  type ServerContext,
  TRACEPARENT_META_KEY,
  TRACESTATE_META_KEY,
} from '@modelcontextprotocol/server';
import {
  getRequestContext,
  type RequestContext,
  runWithRequestContext,
} from '../observability/context';
import { resolvePropagationContext } from '../observability/trace';

/** Run one SDK-dispatched MCP request inside an isolated propagation context. */
export function runInMcpRequestContext<T>(
  context: ServerContext,
  toolName: string,
  body: () => Promise<T>,
): Promise<T> {
  const ambient = getRequestContext();
  const metadata = context.mcpReq._meta;
  const propagation = metadata
    ? {
        traceparent: metadata[TRACEPARENT_META_KEY],
        tracestate: metadata[TRACESTATE_META_KEY],
        baggage: metadata[BAGGAGE_META_KEY],
      }
    : undefined;
  const request: RequestContext = {
    ...(ambient ?? {
      source: 'mcp',
      method: 'MCP',
      path: `/mcp/${toolName}`,
      startedAt: process.hrtime.bigint(),
    }),
    trace: resolvePropagationContext(propagation, ambient?.trace),
    source: 'mcp',
    method: 'MCP',
    path: `/mcp/${toolName}`,
    startedAt: process.hrtime.bigint(),
    dimensions: ambient?.dimensions ? { ...ambient.dimensions } : undefined,
    error: undefined,
  };
  return runWithRequestContext(request, body);
}
