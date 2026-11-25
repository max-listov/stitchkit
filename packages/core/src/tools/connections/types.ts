import type { ToolTransport } from '../../contract/define';
import type { EndpointToolAnnotations } from '../../contract/tool-options';
import type { McpCatalogStamp } from '../mcp/catalog-stamp';
import type { ConnectionTokenProvider, ConnectionToolSkipReporter } from './runtime';

/** One tool discovered from an external MCP server's `tools/list`. */
export interface DiscoveredMcpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  /** The server's own hints about the tool; whether it only reads is the one the CLI acts on. */
  annotations?: EndpointToolAnnotations;
}

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

/** The policy phase of a connection operation. */
export type ConnectionPhase = 'discovery' | 'call';

/** Fixed operation names carried by safe connection failures. */
export type ConnectionOperation =
  | 'initialize'
  | 'notifications/initialized'
  | 'tools/list'
  | 'tools/call'
  | 'endpoint'
  | 'request'
  | 'openapi/spec'
  | 'openapi/call';

/** Positive finite integer bounds for one logical operation. */
export interface ConnectionOperationLimits {
  /**
   * Deadline in milliseconds, including transport negotiation and body reads. Defaults to the
   * connection's shared `timeoutMs`; with neither set, discovery allows 300_000 and a call 30_000.
   */
  timeoutMs?: number;
  /**
   * End the operation when nothing arrives for this many milliseconds — response headers and
   * every body chunk restart it, so a slow transfer that keeps delivering is not cut off.
   * Discovery with no declared `timeoutMs` (here or shared) defaults to 30_000; otherwise, and
   * for a call, there is none unless set — a tool may compute in silence before it answers.
   * Fails with `ConnectionTimeoutError` whose `deadline` is `'idle'`.
   */
  idleTimeoutMs?: number;
  /** Raw response-body byte ceiling, including SSE framing. */
  maxResponseBytes?: number;
}

/** Phase-specific overrides of a connection's shared response bounds. */
export interface McpConnectionLimits {
  discovery?: ConnectionOperationLimits;
  call?: ConnectionOperationLimits;
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
  /**
   * Shared logical-operation deadline for both phases. Unset, discovery allows 300_000
   * milliseconds (its idle deadline ends a dead one) and a call 30_000.
   */
  timeoutMs?: number;
  /** Response body ceiling in bytes; defaults to 1 MiB. */
  maxResponseBytes?: number;
  /** Discovery and call overrides; omitted fields inherit the shared bounds. */
  limits?: McpConnectionLimits;
  /**
   * Where the discovered catalog is kept between processes. When the server stamps its
   * catalog (a Stitchkit server does), a stored catalog with the live stamp is mounted without
   * asking for `tools/list`; any other answer lists and stores again.
   */
  catalog?: McpConnectionCatalogStore;
  /**
   * Which surfaces this server's discovered tools appear on; default MCP and
   * AGENT. Naming `['CLI']` is how a whole server becomes a set of commands,
   * without the consumer rebuilding each discovered definition — and a
   * connection without it contributes nothing to the CLI, because CLI exposure
   * is explicit everywhere else in the framework too.
   */
  expose?: readonly ToolTransport[];
}

/** One stored `tools/list` result and the catalog stamp it was listed under. */
export interface McpConnectionCatalogEntry {
  stamp: McpCatalogStamp;
  /** The `tools/list` result exactly as received, before any `tools` filter. */
  result: unknown;
}

/**
 * The application's storage for a connection's discovered catalog — a file, a database row.
 * A failing `load` or `store` costs a `tools/list`, never the mount; a loaded entry is
 * validated before it is used.
 */
export interface McpConnectionCatalogStore {
  load():
    | McpConnectionCatalogEntry
    | undefined
    | Promise<McpConnectionCatalogEntry | undefined>;
  store(entry: McpConnectionCatalogEntry): void | Promise<void>;
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
  expose?: readonly ToolTransport[];
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
