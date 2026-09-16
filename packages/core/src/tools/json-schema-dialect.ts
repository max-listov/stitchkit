import { isRecord } from '../internal/typed';

const DRAFT_07_MARKER = 'draft-07';

/** Draft-07 keeps reusable subschemas in `definitions`; 2020-12 renamed it `$defs`. */
const DRAFT_07_KEYWORD = 'definitions';
const DEFS_KEYWORD = '$defs';

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

/**
 * Move a document's top-level `definitions` to `$defs`, carrying its pointers.
 *
 * A JSON Schema document that names one dialect and uses another's keyword is
 * not a style question: a reader registers reusable subschemas from the keyword
 * the dialect declares and then cannot resolve `#/definitions/x` at all. Both
 * halves of this framework met that document — the MCP SDK stamps 2020-12 onto
 * the metadata it is handed, and our own MCP client obeyed the stamp.
 *
 * Only the top level moves. A `definitions` deeper in the document may be a
 * property literally called "definitions", and guessing which is worse than
 * leaving it where the author put it.
 */
export function withDefsDialect(schema: Record<string, unknown>): Record<string, unknown> {
  const definitions = schema[DRAFT_07_KEYWORD];
  if (!isRecord(definitions) || DEFS_KEYWORD in schema) return schema;
  const rewritten: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === DRAFT_07_KEYWORD) continue;
    rewritten[key] = rewriteDefinitionPointers(value);
  }
  rewritten[DEFS_KEYWORD] = rewriteDefinitionPointers(definitions);
  return rewritten;
}
