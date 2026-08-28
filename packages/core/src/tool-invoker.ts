/**
 * Peer-free in-process contract tool dispatch.
 *
 * This entrypoint deliberately excludes MCP and AI SDK adapters. It exposes
 * the same canonical runner used by those mounts for consumers that only need
 * local validated invocation.
 */
export {
  createToolInvoker,
  type ToolInvocationOptions,
  type ToolInvoker,
  type ToolInvokerConfig,
  type ToolInvokerTransport,
} from './tools/invoker';
