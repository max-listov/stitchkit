import { z } from 'zod';
import { isRecord } from '../internal/typed';
import { SCHEMA_KEYWORDS, SCHEMA_LIST_KEYWORDS, SCHEMA_MAP_KEYWORDS } from './dialect';

/** The string formats of the JSON Schema validation vocabulary (2020-12, §7.3). */
export const STANDARD_STRING_FORMATS: ReadonlySet<string> = new Set([
  'date-time',
  'date',
  'time',
  'duration',
  'email',
  'idn-email',
  'hostname',
  'idn-hostname',
  'ipv4',
  'ipv6',
  'uri',
  'uri-reference',
  'iri',
  'iri-reference',
  'uuid',
  'uri-template',
  'json-pointer',
  'relative-json-pointer',
  'regex',
]);

/**
 * The annotation a served `format` rides through Zod in. Zod's reader keeps a
 * keyword it does not know as metadata and writes it back; `format` it knows, and
 * keeps only as far as it has a check of that name.
 */
const SERVED_FORMAT = 'x-stitchkit-served-format';

/**
 * Copy every `format` of a foreign document into an annotation Zod carries.
 *
 * Read into Zod, `uri-reference` becomes `uri`, `time` a bare expression, and
 * `idn-email`, `iri`, `json-pointer` and the rest nothing at all; a format next to
 * a `pattern` loses its name whichever it is. The word is the server's statement
 * about its own argument, so it is carried beside the schema and written back by
 * `keepFormatName`. The walk follows schema keywords only: a `default`, an `enum`
 * value or a property called "format" is left as written.
 */
export function withServedFormats(schema: Record<string, unknown>): Record<string, unknown> {
  const carried: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(schema)) {
    if (SCHEMA_KEYWORDS.includes(key)) carried[key] = carriedSchema(child);
    else if (SCHEMA_LIST_KEYWORDS.includes(key) && Array.isArray(child)) {
      carried[key] = child.map(carriedSchema);
    } else if (SCHEMA_MAP_KEYWORDS.includes(key) && isRecord(child)) {
      carried[key] = Object.fromEntries(
        Object.entries(child).map(([name, member]) => [name, carriedSchema(member)]),
      );
    } else carried[key] = child;
  }
  if (typeof schema.format === 'string') carried[SERVED_FORMAT] = schema.format;
  return carried;
}

function carriedSchema(schema: unknown): unknown {
  return isRecord(schema) ? withServedFormats(schema) : schema;
}

type JsonNode = z.core.JSONSchema.BaseSchema;

/** The expression Zod's reader checks a format by, from the format's name alone. */
const readerExpressions = new Map<string, string | undefined>();
function readerExpression(format: string): string | undefined {
  if (!readerExpressions.has(format)) {
    const read = z.fromJSONSchema({ type: 'string', format });
    readerExpressions.set(format, z.toJSONSchema(read).pattern);
  }
  return readerExpressions.get(format);
}

/** What Zod would write for this string if no `.regex()` followed its format. */
function beforePatterns(schema: z.core.$ZodTypes): JsonNode | undefined {
  const def = schema._zod.def;
  if (def.type !== 'string') return undefined;
  const checks = def.checks ?? [];
  const named = checks.filter((check) => !(check instanceof z.core.$ZodCheckRegex));
  if (named.length === checks.length) return undefined;
  return z.toJSONSchema(z.core.clone(schema, { ...def, checks: named }));
}

function isPatternOnly(member: JsonNode): boolean {
  return (
    typeof member.pattern === 'string' &&
    Object.keys(member).every((key) => key === 'pattern' || key === 'type')
  );
}

/**
 * Write a format's name on a string and take out the expression the name implies.
 * A reader derives that expression from the name again, so beside another pattern
 * it is the same statement twice — and written on every trip it would be once more.
 */
function nameFormat(json: JsonNode, format: string, implied: string | undefined): void {
  json.format = format;
  if (implied === undefined || json.allOf === undefined) return;
  const kept: JsonNode[] = [];
  for (const member of json.allOf) {
    if (isPatternOnly(member) && kept.some((other) => other.pattern === member.pattern))
      continue;
    kept.push(member);
  }
  const own = kept.filter((member) => isPatternOnly(member) && member.pattern !== implied);
  const stated = own.length === 0 ? kept : kept.filter((member) => member.pattern !== implied);
  const [only] = stated;
  if (stated.length === 1 && only !== undefined && isPatternOnly(only)) {
    delete json.allOf;
    json.pattern = only.pattern;
  } else json.allOf = stated;
}

/**
 * Keep the name of a format on the document Zod writes.
 *
 * Zod lets a `.regex()` take the place of the format it follows: `z.uuid().regex(p)`
 * is written as two patterns and no `format`, and every string restored from a
 * served document that states both keywords is exactly that schema. So a format a
 * server declared did not survive the trip through Zod, and a reader was shown the
 * expression instead of the name.
 *
 * A served format is written back as the server spelled it. An authored string is
 * named when the name says all its format check does — `z.uuid().regex(p)`. Where
 * the check is narrower or wider than its name (`z.uuidv4()`, `z.guid()`, a
 * datetime that takes only `Z`) or the word is a producer's own (`starts_with`),
 * the document stays as Zod wrote it: there the expression is the meaning.
 */
export function keepFormatName(ctx: {
  zodSchema: z.core.$ZodTypes;
  jsonSchema: JsonNode;
}): void {
  const { zodSchema, jsonSchema } = ctx;
  const served = jsonSchema[SERVED_FORMAT];
  delete jsonSchema[SERVED_FORMAT];
  if (typeof served !== 'string') {
    if (jsonSchema.format !== undefined) return;
    const named = beforePatterns(zodSchema);
    if (named?.format === undefined || !STANDARD_STRING_FORMATS.has(named.format)) return;
    if (named.pattern !== readerExpression(named.format)) return;
    nameFormat(jsonSchema, named.format, named.pattern);
    return;
  }
  // `"type": ["string", "null"]` is read as a union; the format belongs to its
  // typed members, where the same field written as `anyOf` already carries it.
  if (jsonSchema.anyOf === undefined) {
    nameFormat(jsonSchema, served, readerExpression(served));
    return;
  }
  for (const member of jsonSchema.anyOf) {
    if (member.type !== 'null' && member.format === undefined) {
      nameFormat(member, served, readerExpression(served));
    }
  }
}
