import { isRecord } from '../internal/typed';

const DRAFT_07_MARKER = 'draft-07';

/** Draft-07 keeps reusable subschemas in `definitions`; 2020-12 renamed it `$defs`. */
const DRAFT_07_KEYWORD = 'definitions';
const DEFS_KEYWORD = '$defs';

/** Keywords whose value is one subschema. */
const SCHEMA_KEYWORDS = [
  'items',
  'additionalItems',
  'additionalProperties',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
  'unevaluatedItems',
  'unevaluatedProperties',
];
/** Keywords whose value is a list of subschemas. */
const SCHEMA_LIST_KEYWORDS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
/** Keywords whose value maps a name to a subschema. */
const SCHEMA_MAP_KEYWORDS = [
  'properties',
  'patternProperties',
  'dependentSchemas',
  DRAFT_07_KEYWORD,
  DEFS_KEYWORD,
];

/** True when a document says, in its own `$schema`, that it is draft-07. */
export function declaresDraft07(dialect: unknown): boolean {
  return typeof dialect === 'string' && dialect.includes(DRAFT_07_MARKER);
}

function rewriteDefinitionPointers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteDefinitionPointers);
  if (!isRecord(value)) return value;
  const rewritten: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    rewritten[key] =
      key === '$ref' && typeof child === 'string' && child.startsWith(`#/${DRAFT_07_KEYWORD}/`)
        ? `#/${DEFS_KEYWORD}/${child.slice(`#/${DRAFT_07_KEYWORD}/`.length)}`
        : rewriteDefinitionPointers(child);
  }
  return rewritten;
}

function mapValues(value: unknown, rewrite: (child: unknown) => unknown): unknown {
  if (!isRecord(value)) return value;
  const rewritten: Record<string, unknown> = {};
  for (const [name, child] of Object.entries(value)) rewritten[name] = rewrite(child);
  return rewritten;
}

/**
 * Spell every positional array the 2020-12 way. Draft-07 writes a tuple as an
 * `items` list with the rest in `additionalItems`; 2020-12 writes it as
 * `prefixItems` with the rest in `items`, and an `items` list is not a schema
 * there at all. The walk follows schema keywords only, so a `default`, `const`
 * or a property that happens to be called "items" is left as written.
 */
function withPositionalItems(schema: unknown): unknown {
  if (!isRecord(schema)) return schema;
  const rewritten: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(schema)) {
    if (SCHEMA_KEYWORDS.includes(key)) rewritten[key] = withPositionalItems(child);
    else if (SCHEMA_LIST_KEYWORDS.includes(key) && Array.isArray(child)) {
      rewritten[key] = child.map(withPositionalItems);
    } else if (SCHEMA_MAP_KEYWORDS.includes(key)) {
      rewritten[key] = mapValues(child, withPositionalItems);
    } else rewritten[key] = child;
  }
  const { items, additionalItems } = rewritten;
  if (!Array.isArray(items)) return rewritten;
  const positional: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(rewritten)) {
    if (key === 'items') positional.prefixItems = items;
    else if (key !== 'additionalItems') positional[key] = child;
  }
  if (additionalItems !== undefined) positional.items = additionalItems;
  return positional;
}

/**
 * Write a document in the keywords of 2020-12, the dialect an MCP client reads
 * tool schemas in. Two draft-07 keywords mean something else there or nothing:
 * reusable subschemas move from `definitions` to `$defs` with their pointers,
 * and a tuple's `items` list becomes `prefixItems`.
 *
 * A document that names one dialect and uses another's keyword is not a style
 * question: a reader registers subschemas from the keyword its dialect declares
 * and cannot resolve `#/definitions/x`, and a reader that validates the schema
 * itself refuses an `items` list and drops the whole tool.
 *
 * Only the top-level `definitions` moves. A `definitions` deeper in the
 * document may be a property literally called "definitions", and guessing which
 * is worse than leaving it where the author put it.
 */
export function withDraft2020Keywords(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const positional = withPositionalItems(schema);
  if (!isRecord(positional)) return schema;
  const definitions = positional[DRAFT_07_KEYWORD];
  if (!isRecord(definitions) || DEFS_KEYWORD in positional) return positional;
  const rewritten: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(positional)) {
    if (key === DRAFT_07_KEYWORD) continue;
    rewritten[key] = rewriteDefinitionPointers(value);
  }
  rewritten[DEFS_KEYWORD] = rewriteDefinitionPointers(definitions);
  return rewritten;
}
