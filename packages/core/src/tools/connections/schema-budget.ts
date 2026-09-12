import type { RuntimeToolDefinition } from '../runtime-tool';

/**
 * Foreign JSON-schema accounting for the mount budget.
 *
 * `mountConnections` sees only `RuntimeToolDefinition`s, whose `input` is a Zod
 * object — the original foreign schema is gone by then. Each mount records the
 * byte size of the schema it discovered on the definition it produced, and the
 * budget check sums those entries across every connection. A WeakMap keeps the
 * accounting off the public type and lets the definitions be collected normally.
 */
const schemaBytes = new WeakMap<RuntimeToolDefinition, number>();

/** Record the byte size of the foreign schema behind one mounted tool. */
export function recordForeignSchemaBytes(tool: RuntimeToolDefinition, size: number): void {
  schemaBytes.set(tool, size);
}

/** The recorded foreign-schema byte size of one mounted tool. */
export function foreignSchemaBytes(tool: RuntimeToolDefinition): number {
  return schemaBytes.get(tool) ?? 0;
}

/** UTF-8 byte length of a foreign JSON schema, zero when there is none. */
export function jsonSchemaBytes(schema: Record<string, unknown> | undefined): number {
  if (!schema || Object.keys(schema).length === 0) return 0;
  return new TextEncoder().encode(JSON.stringify(schema)).byteLength;
}
