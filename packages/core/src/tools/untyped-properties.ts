/**
 * A property a model is shown must say what it is.
 *
 * A tool schema is the only instruction an LLM gets about the shape of its
 * arguments. A property that carries a `description` and no `type` / `enum` /
 * `anyOf` / `$ref` tells it nothing, and the failure is invisible from both
 * ends: the schema converts, the mount succeeds, the tool is advertised, and the
 * model then guesses — retrying the same wrong guess, because nothing in the
 * error tells it what the right one would be. That is a real production
 * incident, not a hypothetical (→ ADR 0044).
 *
 * This is a check a **consuming project** runs on its own contracts, because
 * that is where the shape lives; the framework ships no contracts of its own.
 * `validateMcpSchemas` already walks a project's services with the live mount's
 * options, so it is the honest home for it.
 */
import { isRecord } from '../internal/typed';

/** One property the model would be shown with no idea what it is. */
export interface UntypedProperty {
  /** Dotted path from the tool's argument root, e.g. `operations.partIndex`. */
  path: string;
  /** Its `description`, when it has one — usually the only clue present. */
  description?: string;
}

/** Keywords any one of which tells a model what a value may be. */
const TYPE_KEYWORDS = ['type', 'enum', 'const', 'anyOf', 'oneOf', 'allOf', '$ref', 'not'];

function saysWhatItIs(schema: Record<string, unknown>): boolean {
  return TYPE_KEYWORDS.some((keyword) => schema[keyword] !== undefined);
}

/**
 * Every property in a JSON Schema that carries no type information, deep.
 *
 * Walks `properties`, `items`, `additionalProperties`, `$defs` / `definitions`
 * and the `allOf` / `anyOf` / `oneOf` branches — an intersection root emits
 * `allOf` with no root `properties` at all, so reading the top level alone would
 * inspect nothing and pass.
 */
export function findUntypedProperties(schema: unknown, prefix = ''): UntypedProperty[] {
  if (!isRecord(schema)) return [];
  const found: UntypedProperty[] = [];

  const properties = schema.properties;
  if (isRecord(properties)) {
    for (const [key, value] of Object.entries(properties)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (isRecord(value)) {
        if (!saysWhatItIs(value)) {
          const description = value.description;
          found.push({
            path,
            ...(typeof description === 'string' && { description }),
          });
        }
        found.push(...findUntypedProperties(value, path));
      }
    }
  }

  for (const key of ['items', 'additionalProperties']) {
    const child = schema[key];
    if (isRecord(child)) found.push(...findUntypedProperties(child, prefix));
    // draft-07 spells a tuple `items: [...]`; the MCP SDK emits draft-07.
    if (Array.isArray(child)) {
      for (const entry of child) {
        if (isRecord(entry)) found.push(...findUntypedProperties(entry, prefix));
      }
    }
  }
  for (const key of ['prefixItems']) {
    const child = schema[key];
    if (Array.isArray(child)) {
      for (const entry of child) {
        if (isRecord(entry)) found.push(...findUntypedProperties(entry, prefix));
      }
    }
  }
  const patterned = schema.patternProperties;
  if (isRecord(patterned)) {
    for (const value of Object.values(patterned)) {
      if (isRecord(value)) found.push(...findUntypedProperties(value, prefix));
    }
  }
  // `$defs` (draft 2020-12) and `definitions` (draft-07) are maps of name →
  // schema, not schemas: the SDK emits one container, we emit the other, and a
  // `$ref`'d shape is where a property most easily hides.
  for (const key of ['$defs', 'definitions']) {
    const container = schema[key];
    if (!isRecord(container)) continue;
    for (const definition of Object.values(container)) {
      if (isRecord(definition)) found.push(...findUntypedProperties(definition, prefix));
    }
  }
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    const branches = schema[key];
    if (Array.isArray(branches)) {
      for (const branch of branches) found.push(...findUntypedProperties(branch, prefix));
    }
  }

  return found;
}
