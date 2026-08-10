/**
 * The single Zod → JSON Schema conversion point for the tools layer.
 *
 * MCP and agent both ultimately turn a contract schema into JSON Schema. This
 * is the one place stitchkit converts — with the options that match what the
 * transport SDKs emit, so a build-time validity probe tests the same thing the
 * SDK will later emit, not a divergent code path.
 */
import { z } from 'zod';

/** Conversion direction — `input` for tool arguments, `output` for results. */
export type JsonSchemaIo = 'input' | 'output';

/**
 * Convert a Zod schema to JSON Schema (draft-2020-12, the dialect OpenAPI 3.1
 * uses). `unrepresentable` controls a construct JSON Schema cannot represent
 * (`z.date()`, `z.bigint()`, `z.map()`, …):
 *
 *  - `'throw'` (default) — throws for the whole schema. The tools layer wants
 *    this: it mirrors what the MCP SDK does, so a build-time probe catches an
 *    incompatible schema instead of shipping a tool the SDK would later reject.
 *  - `'any'` — degrades only the offending field to `{}` and keeps the rest.
 *    The OpenAPI generator wants this: one `z.date()` field must not collapse a
 *    whole endpoint's schema to `{}`.
 */
export function toJsonSchema(
  schema: z.ZodType,
  io: JsonSchemaIo,
  unrepresentable: 'throw' | 'any' = 'throw',
  target: 'draft-07' | 'draft-2020-12' = 'draft-2020-12',
): Record<string, unknown> {
  return z.toJSONSchema(schema, {
    io,
    target,
    unrepresentable,
    cycles: 'ref',
  });
}

/** One top-level property of an object JSON Schema. */
export interface JsonSchemaField {
  /** Property name. */
  name: string;
  /** The property's own JSON Schema sub-document. */
  schema: Record<string, unknown>;
  /** Whether the property is in the schema's `required` list. */
  required: boolean;
  /** `description` (a Zod `.describe()`), when present. */
  description?: string;
}

/** True for a record we can index — narrows `unknown` JSON Schema nodes. */
function isObjectNode(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Extract the top-level object properties of a JSON Schema as a flat field list
 * — the shared traversal behind CLI `--help` flag tables and OpenAPI
 * `parameters`. Returns `[]` for a non-object schema (a union, a scalar); the
 * caller decides how to degrade.
 */
export function jsonSchemaFields(jsonSchema: Record<string, unknown>): JsonSchemaField[] {
  const properties = jsonSchema.properties;
  if (!isObjectNode(properties)) {
    // `allOf` (an intersection): every member applies, so a field required by
    // ANY member stays required. `oneOf`/`anyOf` (alternatives): a field is
    // required only when EVERY alternative requires it.
    const conjunctive = Array.isArray(jsonSchema.allOf);
    const members = conjunctive
      ? jsonSchema.allOf
      : Array.isArray(jsonSchema.oneOf)
        ? jsonSchema.oneOf
        : Array.isArray(jsonSchema.anyOf)
          ? jsonSchema.anyOf
          : [];
    const byName = new Map<string, JsonSchemaField>();
    for (const member of Array.isArray(members) ? members : []) {
      if (!isObjectNode(member)) continue;
      for (const field of jsonSchemaFields(member)) {
        const existing = byName.get(field.name);
        const required = existing
          ? conjunctive
            ? existing.required || field.required
            : existing.required && field.required
          : field.required;
        byName.set(field.name, existing ? { ...field, required } : field);
      }
    }
    return [...byName.values()];
  }
  const required = new Set(
    Array.isArray(jsonSchema.required)
      ? jsonSchema.required.filter((k): k is string => typeof k === 'string')
      : [],
  );
  const fields: JsonSchemaField[] = [];
  for (const [name, raw] of Object.entries(properties)) {
    const schema = isObjectNode(raw) ? raw : {};
    const description =
      typeof schema.description === 'string' ? schema.description : undefined;
    fields.push({
      name,
      schema,
      required: required.has(name),
      ...(description && { description }),
    });
  }
  return fields;
}
