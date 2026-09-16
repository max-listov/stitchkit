import { type ZodObject, z } from 'zod';
import type { RuntimeContext } from '../../contract';
import { declaresDraft07, withDefsDialect } from '../json-schema-dialect';
import type { RuntimeToolDefinition } from '../runtime-tool';
import { ConnectionAuthorizationRequiredError } from './errors';

/** A connection's optional principal-scoped credential resolver. */
export type ConnectionTokenProvider = (
  context?: RuntimeContext,
) => string | undefined | Promise<string | undefined>;

interface TeardownTarget {
  teardown(): void;
}

/**
 * Resolve credentials for this invocation. No credential or authenticated
 * session is shared across mounts or principals. Authorization failure tears
 * down the client before propagating; the next call resolves credentials again.
 */
export async function withConnectionToken<T>(
  params: {
    instanceId: string;
    provider?: ConnectionTokenProvider;
    client?: TeardownTarget;
    context?: RuntimeContext;
  },
  body: (token: string | undefined) => Promise<T>,
): Promise<T> {
  const token = await params.provider?.(params.context);
  try {
    return await body(token);
  } catch (error) {
    if (error instanceof ConnectionAuthorizationRequiredError) {
      params.client?.teardown();
    }
    throw error;
  }
}

/**
 * Turn a discovered JSON Schema into a `ZodObject`, falling back to a permissive
 * object when the external schema is absent or not an object. This is the typed
 * boundary: the schema crosses from an untrusted foreign document into Zod here
 * and nowhere else.
 */
export function zodObjectFromJsonSchema(
  schema: Record<string, unknown> | undefined,
): ZodObject {
  if (!schema || Object.keys(schema).length === 0) return z.looseObject({});
  const parsed = z.fromJSONSchema(reconcileDefinitionKeyword(schema));
  if (parsed instanceof z.ZodObject) return parsed;
  return z.looseObject({});
}

/**
 * A served document whose `$schema` is 2020-12 while its reusable subschemas sit
 * in draft-07's `definitions` cannot resolve its own pointers: the reader
 * registers `$defs` and then looks up `#/definitions/x`. Our own MCP mount
 * served exactly that for every version before this one, so believing the stamp
 * would lose the connection rather than the tool. Where the document says
 * draft-07 it is consistent and is left alone.
 */
function reconcileDefinitionKeyword(schema: Record<string, unknown>): Record<string, unknown> {
  return declaresDraft07(schema.$schema) ? schema : withDefsDialect(schema);
}

/** Normalise a tool name into the characters every provider accepts. */
export function sanitizeToolName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'operation';
}

/** One discovered tool the mount could not turn into a definition. */
export interface SkippedConnectionTool {
  connection: string;
  tool: string;
  reason: string;
}

export type ConnectionToolSkipReporter = (skipped: SkippedConnectionTool) => void;

/** Default report: name the tool and the reason, and keep the connection. */
export function reportSkippedConnectionTool(skipped: SkippedConnectionTool): void {
  console.warn(
    `[stitchkit] connection "${skipped.connection}": tool "${skipped.tool}" not mounted — ${skipped.reason}`,
  );
}

/**
 * Build one definition per discovered entry, surviving the ones that cannot be
 * built. A mount is all-or-nothing only if it is written that way, and a foreign
 * surface of two hundred tools should not be lost to one unconvertible schema —
 * the refusal is reported and named, which is what a caller can act on.
 */
export function mountToolsTolerantly<TEntry>(
  entries: readonly TEntry[],
  connection: string,
  nameOf: (entry: TEntry) => string,
  build: (entry: TEntry) => RuntimeToolDefinition,
  onSkipped: ConnectionToolSkipReporter,
): RuntimeToolDefinition[] {
  const mounted: RuntimeToolDefinition[] = [];
  for (const entry of entries) {
    try {
      mounted.push(build(entry));
    } catch (error) {
      onSkipped({
        connection,
        tool: nameOf(entry),
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return mounted;
}
