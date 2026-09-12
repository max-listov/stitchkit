import { type ZodObject, z } from 'zod';
import type { RuntimeContext } from '../../contract';
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
  const parsed = z.fromJSONSchema(schema);
  if (parsed instanceof z.ZodObject) return parsed;
  return z.looseObject({});
}

/** Normalise a tool name into the characters every provider accepts. */
export function sanitizeToolName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'operation';
}
