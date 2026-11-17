import { isRecord } from '../../internal/typed';

/**
 * The catalog stamp's name and wire forms, with no dependency beyond a type guard — the MCP
 * client of `tools/connections` reads stamps too, and must not pull the JSON Schema machinery
 * that computing one needs (`catalog.ts`).
 */

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
 * The HTTP response header carrying the same stamp, as the same JSON object, on the responses
 * of a served surface — `initialize` included. The SDK assembles the `initialize` result
 * itself and leaves no `_meta` to fill, and the header is what lets a client decide whether its
 * stored catalog is current before it asks for `tools/list`.
 */
export const MCP_CATALOG_HEADER = 'stitchkit-catalog';

/**
 * What the server says its advertised catalog currently is.
 *
 * `digest` changes whenever any advertised tool's name, description, input
 * schema, output schema, annotations or UI resource change — and only then. `tools` is the
 * count, carried because it makes a mismatch legible without a second lookup
 * ("they advertise 41, I hold 39").
 */
export interface McpCatalogStamp {
  digest: string;
  tools: number;
}

/** The `_meta` fragment a stamped tool or result carries. */
export function mcpCatalogMeta(stamp: McpCatalogStamp): Record<string, unknown> {
  return { [MCP_CATALOG_META_KEY]: { ...stamp } };
}

/** The header value for a stamp — the `_meta` object, serialised. */
export function mcpCatalogHeaderValue(stamp: McpCatalogStamp): string {
  return JSON.stringify({ digest: stamp.digest, tools: stamp.tools });
}

/**
 * Read a catalog stamp out of a peer's `_meta`, or `null` when there is none.
 *
 * Parsed, not trusted: this arrives over the wire from another process, and the
 * fact that it describes a catalog does not exempt it from being validated.
 */
export function readMcpCatalogStamp(meta: unknown): McpCatalogStamp | null {
  if (!isRecord(meta)) return null;
  return parseCatalogStamp(meta[MCP_CATALOG_META_KEY]);
}

/** Read the stamp a response header carries, or `null` when it is absent or malformed. */
export function readMcpCatalogHeader(value: string | null): McpCatalogStamp | null {
  if (value === null) return null;
  try {
    return parseCatalogStamp(JSON.parse(value));
  } catch {
    return null;
  }
}

function parseCatalogStamp(value: unknown): McpCatalogStamp | null {
  if (!isRecord(value)) return null;
  const { digest, tools } = value;
  if (typeof digest !== 'string' || digest.length === 0) return null;
  if (typeof tools !== 'number' || !Number.isInteger(tools) || tools < 0) return null;
  return { digest, tools };
}
