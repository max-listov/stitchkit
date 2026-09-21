import { createHash } from 'node:crypto';
import { compareCodepoints, serializeCanonicalJson } from '../internal/canonical-json';
import { isRecord } from '../internal/typed';
import { toJsonSchema } from './json-schema';
import type { PreparedMcpServerSurface, PreparedMcpTool } from './mcp-prepare';

/**
 * The `_meta` key carrying the catalog stamp, on every advertised tool and on
 * every tool result.
 *
 * Namespaced, because `_meta` is shared ground: a host, the official SDK and
 * the application all write into it, and a bare `catalog` would eventually mean
 * two things at once.
 */
export const MCP_CATALOG_META_KEY = 'stitchkit/catalog';

/**
 * What the server says its advertised catalog currently is.
 *
 * `digest` changes whenever any advertised tool's name, description, input
 * schema, output schema or annotations change — and only then. `tools` is the
 * count, carried because it makes a mismatch legible without a second lookup
 * ("they advertise 41, I hold 39").
 */
export interface McpCatalogStamp {
  digest: string;
  tools: number;
}

/**
 * Prepared surfaces are immutable and long-lived, and every request to a
 * stateless handler builds its server from the same one — so the JSON Schema
 * conversions behind a stamp are paid once per surface, not once per request.
 */
const stampCache = new WeakMap<PreparedMcpServerSurface, McpCatalogStamp>();

function toolFingerprint(descriptor: PreparedMcpTool): unknown {
  const { mountable } = descriptor;
  return {
    name: mountable.name,
    description: mountable.method.desc,
    input: descriptor.inputSchema,
    // `'any'` rather than `'throw'`: a stamp must never be the thing that fails
    // a server the SDK would have been willing to advertise.
    output: descriptor.outputSchema
      ? toJsonSchema(descriptor.outputSchema, 'output', 'any')
      : null,
    annotations: mountable.method.annotations ?? null,
  };
}

/**
 * Fingerprint one advertised MCP catalog.
 *
 * The problem this answers is not a broken server — it is a **consumer holding
 * an old idea of the contract and unable to find out**. A long-lived session
 * lists the tools once; the server is redeployed with a renamed field; every
 * later call is refused, and the refusal looks to the consumer like a fault in
 * the source, because a stale catalog is invisible from inside. The fix has to
 * ride on responses the consumer is already receiving, so it can compare what
 * it holds against what is live without asking anything extra.
 *
 * `notifications/tools/list_changed` is the push-shaped answer, and this
 * framework's MCP HTTP handler cannot send it: it is stateless by construction
 * (`createMcpHandler` builds a fresh server per request and keeps no session),
 * so there is no retained stream to notify. The stamp works precisely because
 * it needs no session.
 */
export function mcpCatalogStamp(surface: PreparedMcpServerSurface): McpCatalogStamp {
  const cached = stampCache.get(surface);
  if (cached) return cached;
  const descriptors = [
    ...surface.contractTools,
    ...surface.runtimeTools.map((entry) => entry.descriptor),
  ].sort((left, right) => compareCodepoints(left.mountable.name, right.mountable.name));
  const bytes = serializeCanonicalJson(descriptors.map(toolFingerprint));
  const stamp: McpCatalogStamp = {
    digest: createHash('sha256').update(bytes).digest('hex').slice(0, 16),
    tools: descriptors.length,
  };
  stampCache.set(surface, stamp);
  return stamp;
}

/** The `_meta` fragment a stamped tool or result carries. */
export function mcpCatalogMeta(stamp: McpCatalogStamp): Record<string, unknown> {
  return { [MCP_CATALOG_META_KEY]: { ...stamp } };
}

/**
 * Read a catalog stamp out of a peer's `_meta`, or `null` when there is none.
 *
 * Parsed, not trusted: this arrives over the wire from another process, and the
 * fact that it describes a catalog does not exempt it from being validated.
 */
export function readMcpCatalogStamp(meta: unknown): McpCatalogStamp | null {
  if (!isRecord(meta)) return null;
  const value: unknown = meta[MCP_CATALOG_META_KEY];
  if (!isRecord(value)) return null;
  const { digest, tools } = value;
  if (typeof digest !== 'string' || digest.length === 0) return null;
  if (typeof tools !== 'number' || !Number.isInteger(tools) || tools < 0) return null;
  return { digest, tools };
}

/**
 * Attach the stamp to a tool registration, so `tools/list` carries the catalog
 * the listing came from — the value a consumer stores alongside the tools.
 */
export function stampToolRegistration<TConfig extends { _meta?: Record<string, unknown> }>(
  config: TConfig,
  stamp: McpCatalogStamp | undefined,
): TConfig {
  if (!stamp) return config;
  return { ...config, _meta: { ...config._meta, ...mcpCatalogMeta(stamp) } };
}

/**
 * Attach the stamp to a tool result.
 *
 * This is the half that matters. A consumer compares it against the stamp it
 * stored at listing time, on a response it was going to receive anyway, and so
 * learns its catalog is stale WITHOUT asking — including on the refusal that a
 * stale catalog causes, which is exactly when the question gets asked.
 */
export function stampToolResult<TResult extends { _meta?: Record<string, unknown> }>(
  result: TResult,
  stamp: McpCatalogStamp | undefined,
): TResult {
  if (!stamp) return result;
  return { ...result, _meta: { ...result._meta, ...mcpCatalogMeta(stamp) } };
}
