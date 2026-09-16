import type { RuntimeToolTransport } from '../runtime-tool';
import type { ConnectionTokenProvider, ConnectionToolSkipReporter } from './runtime';

/** Where one external MCP server lives, plus static request headers. */
export interface McpConnectionTransport {
  url: string;
  headers?: Record<string, string>;
}

/** Discovered-tool filter: `allow` is a whitelist, `block` removes from it. */
export interface McpToolFilter {
  allow?: readonly string[];
  block?: readonly string[];
}

/** Declarative MCP client connection, before it is mounted. */
export interface McpClientConnectionConfig {
  name: string;
  transport: McpConnectionTransport;
  tools?: McpToolFilter;
  token?: ConnectionTokenProvider;
  /** Non-secret diagnostic discriminator when the same name/url is mounted twice. */
  instanceKey?: string;
  /** Extra hosts a request may name, beside the connection URL's own host. */
  allowHosts?: readonly string[];
  /** Per-request deadline in milliseconds; defaults to 30_000. */
  timeoutMs?: number;
  /** Response body ceiling in bytes; defaults to 1 MiB. */
  maxResponseBytes?: number;
  /**
   * Which surfaces this server's discovered tools appear on; default MCP and
   * AGENT. Naming `['CLI']` is how a whole server becomes a set of commands,
   * without the consumer rebuilding each discovered definition — and a
   * connection without it contributes nothing to the CLI, because CLI exposure
   * is explicit everywhere else in the framework too.
   */
  transports?: readonly RuntimeToolTransport[];
}

/** A defined MCP connection. */
export interface McpClientConnection extends McpClientConnectionConfig {
  kind: 'mcp';
}

/** Declarative OpenAPI connection; `spec` is an object, JSON text or JSON URL. */
export interface OpenApiConnectionConfig {
  name: string;
  spec: object | string;
  baseUrl?: string;
  token?: ConnectionTokenProvider;
  instanceKey?: string;
  allowHosts?: readonly string[];
  /** Per-request deadline in milliseconds; defaults to 30_000. */
  timeoutMs?: number;
  /** Response body ceiling in bytes; defaults to 1 MiB. */
  maxResponseBytes?: number;
  /** Which surfaces every mounted operation appears on; default MCP and AGENT. */
  transports?: readonly RuntimeToolTransport[];
}

/** A defined OpenAPI connection. */
export interface OpenApiConnection extends OpenApiConnectionConfig {
  kind: 'openapi';
}

/** Either connection kind accepted by {@link mountConnections}. */
export type ConnectionDefinition = McpClientConnection | OpenApiConnection;

/** The mount-level ceiling on how many foreign tools may be exposed. */
export interface ConnectionBudget {
  maxTools?: number;
  /** Sum of every foreign tool's JSON-schema bytes, across all connections. */
  maxSchemaBytes?: number;
}

/** Shared mount policy for every connection in one call. */
export interface ConnectionMountOptions {
  budget?: ConnectionBudget;
  /**
   * Called for each discovered tool that could not be mounted. Defaults to a
   * stderr line naming the connection, the tool and the reason; the rest of the
   * surface is mounted either way.
   */
  onSkippedTool?: ConnectionToolSkipReporter;
}
