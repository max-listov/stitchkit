/**
 * `stitchkit/tools/agent` — mount a contract's operations as AI SDK tools.
 *
 * Its own subpath because the AI SDK (`ai`) is an optional peer: an application
 * that exposes its operations over HTTP and CLI imports `stitchkit/tools` and
 * installs neither the AI SDK nor the MCP server SDK. → ADR 0284.
 */
export { type AgentContext, type AgentMountConfig, mountAgent } from '../../tools/agent';
