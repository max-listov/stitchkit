import { createHash } from 'node:crypto';
import { compareCodeUnits, serializeCanonicalJson } from '../../internal/canonical-json';
import { toJsonSchema } from '../../json-schema/json-schema';
import { publishedToolAnnotations } from '../read-operation';
import { type McpCatalogStamp, mcpCatalogMeta } from './catalog-stamp';
import type { PreparedMcpServerSurface, PreparedMcpTool } from './prepare';

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
    // The stamp hashes what `tools/list` publishes, not what was declared.
    annotations: publishedToolAnnotations(mountable.method) ?? null,
    // A client keeps a listed catalog by this digest, so everything `tools/list` publishes
    // about the tool is in it — the MCP Apps resource included.
    ui: mountable.method.ui ?? null,
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
  ].sort((left, right) => compareCodeUnits(left.mountable.name, right.mountable.name));
  const bytes = serializeCanonicalJson(descriptors.map(toolFingerprint));
  const stamp: McpCatalogStamp = {
    digest: createHash('sha256').update(bytes).digest('hex').slice(0, 16),
    tools: descriptors.length,
  };
  stampCache.set(surface, stamp);
  return stamp;
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
