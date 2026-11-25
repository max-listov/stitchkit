/**
 * Single source of truth for every JSON Schema keyword across draft-07,
 * 2020-12 (core, applicator, validation, unevaluated, format, content,
 * meta-data) and OpenAPI 3.0 Schema Object, plus the `x-*` extension rule.
 *
 * Traversal keyword lists (`dialect.ts`), type-presence checks
 * (`tools/schema/untyped-properties.ts`), CLI help rendering (`tools/cli/help.ts`),
 * and foreign schema admission (`tools/connections/runtime.ts`) all derive
 * from this one table.
 */
import { isRecord } from '../internal/typed';

/** How the foreign schema reader treats a keyword on one dialect path. */
export type KeywordOutcome = 'preserved' | 'normalized' | 'refused';

/** Vocabulary group a keyword belongs to. */
export type KeywordKind =
  | 'core'
  | 'applicator'
  | 'validation'
  | 'unevaluated'
  | 'format'
  | 'content'
  | 'metadata'
  | 'openapi';

/** How a keyword nests child subschemas during recursive traversal. */
export type SubschemaShape = 'single' | 'list' | 'map' | 'dependencies';

/** Dialect selected at the foreign schema boundary. */
export type ForeignSchemaDialect = 'mcp' | 'openapi-3.0' | '2020-12';

/** One row in {@link JSON_SCHEMA_KEYWORDS}. */
export interface KeywordRow {
  readonly kind: KeywordKind;
  readonly readMcp: KeywordOutcome;
  readonly readOpenApi: KeywordOutcome;
  readonly help: 'shown' | 'omitted';
  readonly reason: string;
  readonly subschema?: SubschemaShape;
  readonly typesValue?: true;
  readonly stripLocally?: true;
}

type Extra = Pick<KeywordRow, 'subschema' | 'typesValue' | 'stripLocally'>;
const P = (
  kind: KeywordKind,
  help: 'shown' | 'omitted',
  reason: string,
  extra?: Extra,
): KeywordRow => ({
  kind,
  readMcp: 'preserved',
  readOpenApi: 'preserved',
  help,
  reason,
  ...extra,
});
const N = (
  kind: KeywordKind,
  help: 'shown' | 'omitted',
  reason: string,
  extra?: Extra,
): KeywordRow => ({
  kind,
  readMcp: 'normalized',
  readOpenApi: 'normalized',
  help,
  reason,
  ...extra,
});
const R = (kind: KeywordKind, reason: string): KeywordRow => ({
  kind,
  readMcp: 'refused',
  readOpenApi: 'refused',
  help: 'omitted',
  reason,
});

/** Complete keyword table for draft-07, 2020-12 and OpenAPI 3.0 Schema Object. */
export const JSON_SCHEMA_KEYWORDS = {
  // Core (draft-07 + 2020-12)
  $schema: N('core', 'omitted', 'Dialect URI metadata'),
  $id: N('core', 'omitted', 'Schema identifier metadata'),
  $ref: P('core', 'omitted', 'Local pointer resolved by reader', { typesValue: true }),
  $defs: P('core', 'omitted', '2020-12 reusable subschema map', { subschema: 'map' }),
  definitions: P('core', 'omitted', 'draft-07 subschema map (rewritten to $defs)', {
    subschema: 'map',
  }),
  $comment: N('core', 'omitted', 'Author comment annotation'),
  $vocabulary: N('core', 'omitted', 'Meta-schema vocabulary map'),
  $anchor: R('core', 'Plain-name $anchor references are not resolved by the reader'),
  $dynamicRef: R('core', 'Dynamic scope references ($dynamicRef) are not supported'),
  $dynamicAnchor: R('core', 'Dynamic scope anchors ($dynamicAnchor) are not supported'),

  // Applicator (draft-07 + 2020-12)
  allOf: P('applicator', 'shown', 'Intersection of subschemas', {
    subschema: 'list',
    typesValue: true,
  }),
  anyOf: N(
    'applicator',
    'shown',
    'Top-level joined; nested union verdict deferred to remote',
    {
      subschema: 'list',
      typesValue: true,
    },
  ),
  oneOf: N('applicator', 'shown', 'Top-level joined; nested xor verdict deferred to remote', {
    subschema: 'list',
    typesValue: true,
  }),
  not: N('applicator', 'omitted', 'Stripped locally; negation judged by remote', {
    subschema: 'single',
    typesValue: true,
    stripLocally: true,
  }),
  if: N('applicator', 'omitted', 'Stripped locally; conditional judged by remote', {
    subschema: 'single',
    stripLocally: true,
  }),
  then: N('applicator', 'omitted', 'Stripped locally; conditional branch judged by remote', {
    subschema: 'single',
    stripLocally: true,
  }),
  else: N('applicator', 'omitted', 'Stripped locally; conditional branch judged by remote', {
    subschema: 'single',
    stripLocally: true,
  }),
  dependentSchemas: N(
    'applicator',
    'omitted',
    'Stripped locally; dependent schemas judged by remote',
    {
      subschema: 'map',
      stripLocally: true,
    },
  ),
  prefixItems: P('applicator', 'omitted', '2020-12 positional tuple items', {
    subschema: 'list',
  }),
  items: P('applicator', 'omitted', 'Array element schema', { subschema: 'single' }),
  additionalItems: P(
    'applicator',
    'omitted',
    'draft-07 tuple rest schema (rewritten to items)',
    {
      subschema: 'single',
    },
  ),
  contains: P('applicator', 'omitted', 'Array contains constraint', { subschema: 'single' }),
  properties: P('applicator', 'shown', 'Named object properties', { subschema: 'map' }),
  patternProperties: P('applicator', 'omitted', 'Regex-matched object properties', {
    subschema: 'map',
  }),
  additionalProperties: P('applicator', 'omitted', 'Catchall or strict property policy', {
    subschema: 'single',
  }),
  propertyNames: P('applicator', 'omitted', 'Object property name schema', {
    subschema: 'single',
  }),
  dependencies: N(
    'applicator',
    'omitted',
    'draft-07 dependencies stripped locally; judged by remote',
    {
      subschema: 'dependencies',
      stripLocally: true,
    },
  ),

  // Unevaluated (2020-12)
  unevaluatedItems: N(
    'unevaluated',
    'omitted',
    'Stripped locally; unevaluated items judged by remote',
    {
      subschema: 'single',
      stripLocally: true,
    },
  ),
  unevaluatedProperties: N(
    'unevaluated',
    'omitted',
    'Stripped locally; unevaluated properties judged by remote',
    { subschema: 'single', stripLocally: true },
  ),

  // Validation (draft-07 + 2020-12)
  type: P('validation', 'shown', 'Primitive or structural JSON type', { typesValue: true }),
  enum: P('validation', 'shown', 'Enumerated allowed values', { typesValue: true }),
  const: P('validation', 'omitted', 'Single literal allowed value', { typesValue: true }),
  multipleOf: P('validation', 'omitted', 'Numeric step constraint'),
  maximum: P(
    'validation',
    'shown',
    'Inclusive upper bound (safe integer ceiling omitted in CLI help)',
  ),
  exclusiveMaximum: P('validation', 'shown', 'Exclusive upper bound'),
  minimum: P(
    'validation',
    'shown',
    'Inclusive lower bound (safe integer floor omitted in CLI help)',
  ),
  exclusiveMinimum: P('validation', 'shown', 'Exclusive lower bound'),
  maxLength: P('validation', 'shown', 'Maximum string length'),
  minLength: P('validation', 'shown', 'Minimum string length'),
  pattern: N('validation', 'shown', 'Regex shown in help; remote owns format/pattern verdict'),
  maxItems: P('validation', 'shown', 'Maximum array item count'),
  minItems: P('validation', 'shown', 'Minimum array item count'),
  uniqueItems: P('validation', 'omitted', 'Unique array elements'),
  maxContains: P('validation', 'omitted', 'Maximum contains matches'),
  minContains: P('validation', 'omitted', 'Minimum contains matches'),
  maxProperties: P('validation', 'omitted', 'Maximum object key count'),
  minProperties: P('validation', 'omitted', 'Minimum object key count'),
  required: P('validation', 'shown', 'Required object properties'),
  dependentRequired: N(
    'validation',
    'omitted',
    'Stripped locally; dependentRequired judged by remote',
    { stripLocally: true },
  ),

  // Format (draft-07 + 2020-12)
  format: N('format', 'shown', 'Served format name shown in help; remote owns format verdict'),

  // Content (draft-07 + 2020-12)
  contentEncoding: N('content', 'omitted', 'Content encoding annotation judged by remote'),
  contentMediaType: N('content', 'omitted', 'Content media type annotation judged by remote'),
  contentSchema: N('content', 'omitted', 'Content subschema annotation judged by remote', {
    subschema: 'single',
  }),

  // Meta-data (draft-07 + 2020-12 + OpenAPI 3.0)
  title: N('metadata', 'omitted', 'Display title annotation'),
  description: N('metadata', 'shown', 'Field description in help'),
  default: N('metadata', 'omitted', 'Default value annotation'),
  deprecated: N('metadata', 'omitted', 'Deprecation annotation'),
  readOnly: N('metadata', 'omitted', 'Read-only annotation'),
  writeOnly: N('metadata', 'omitted', 'Write-only annotation'),
  examples: N('metadata', 'omitted', 'Example values annotation'),

  // OpenAPI 3.0 Schema Object extras
  nullable: {
    kind: 'openapi',
    readMcp: 'normalized',
    readOpenApi: 'preserved',
    help: 'omitted',
    reason: 'OpenAPI 3.0 native nullable; normalized to type union on MCP path',
  },
  discriminator: N('openapi', 'omitted', 'OpenAPI polymorphism discriminator metadata'),
  xml: N('openapi', 'omitted', 'OpenAPI XML serialization metadata'),
  externalDocs: N('openapi', 'omitted', 'OpenAPI external documentation link'),
  example: N('openapi', 'omitted', 'OpenAPI 3.0 single example'),
} as const satisfies Record<string, KeywordRow>;

export type KnownJsonSchemaKeyword = keyof typeof JSON_SCHEMA_KEYWORDS;

const EXTENSION_ROW: KeywordRow = N(
  'openapi',
  'omitted',
  'Specification extension annotation (x-*)',
);
const KEYWORD_MAP: ReadonlyMap<string, KeywordRow> = new Map<string, KeywordRow>(
  Object.entries(JSON_SCHEMA_KEYWORDS),
);

/** True for OpenAPI / JSON Schema vendor extension keywords (`x-*`). */
export function isSchemaExtensionKeyword(keyword: string): boolean {
  return keyword.startsWith('x-');
}

/** Look up a keyword row in the table or match the `x-*` extension rule. */
export function lookupJsonSchemaKeyword(keyword: string): KeywordRow | undefined {
  return (
    KEYWORD_MAP.get(keyword) ?? (isSchemaExtensionKeyword(keyword) ? EXTENSION_ROW : undefined)
  );
}

const entries: readonly [string, KeywordRow][] = [...KEYWORD_MAP.entries()];

/** Keywords whose value is one subschema — derived from {@link JSON_SCHEMA_KEYWORDS}. */
export const SCHEMA_KEYWORDS: readonly string[] = entries
  .filter(([, meta]) => meta.subschema === 'single')
  .map(([name]) => name);

/** Keywords whose value is a list of subschemas — derived from {@link JSON_SCHEMA_KEYWORDS}. */
export const SCHEMA_LIST_KEYWORDS: readonly string[] = entries
  .filter(([, meta]) => meta.subschema === 'list')
  .map(([name]) => name);

/** Keywords whose value maps names to subschemas — derived from {@link JSON_SCHEMA_KEYWORDS}. */
export const SCHEMA_MAP_KEYWORDS: readonly string[] = entries
  .filter(([, meta]) => meta.subschema === 'map')
  .map(([name]) => name);

/** Keywords any one of which tells a model what a value may be — derived from {@link JSON_SCHEMA_KEYWORDS}. */
export const TYPE_DEFINING_KEYWORDS: readonly string[] = entries
  .filter(([, meta]) => meta.typesValue === true)
  .map(([name]) => name);

/** Keywords shown in CLI help constraints — derived from {@link JSON_SCHEMA_KEYWORDS}. */
export const HELP_SHOWN_KEYWORDS: ReadonlySet<string> = new Set(
  entries.filter(([, meta]) => meta.help === 'shown').map(([name]) => name),
);

/** Keywords stripped locally during foreign schema ingestion — derived from {@link JSON_SCHEMA_KEYWORDS}. */
export const REMOTE_STRIPPED_KEYWORDS: ReadonlySet<string> = new Set(
  entries.filter(([, meta]) => meta.stripLocally === true).map(([name]) => name),
);

/**
 * Walk every schema node according to {@link JSON_SCHEMA_KEYWORDS} and throw
 * when an unknown keyword or a keyword refused for `dialect` is encountered.
 */
export function assertKnownJsonSchemaKeywords(
  schema: unknown,
  dialect: ForeignSchemaDialect,
): void {
  if (!isRecord(schema)) return;
  for (const [key, value] of Object.entries(schema)) {
    const meta = lookupJsonSchemaKeyword(key);
    if (!meta) {
      throw new Error(`Unsupported JSON Schema keyword "${key}"`);
    }
    const outcome = dialect === 'openapi-3.0' ? meta.readOpenApi : meta.readMcp;
    if (outcome === 'refused') {
      throw new Error(`JSON Schema keyword "${key}" is refused: ${meta.reason}`);
    }
    if (meta.subschema === 'single') {
      if (Array.isArray(value)) {
        for (const item of value) assertKnownJsonSchemaKeywords(item, dialect);
      } else {
        assertKnownJsonSchemaKeywords(value, dialect);
      }
    } else if (meta.subschema === 'list' && Array.isArray(value)) {
      for (const item of value) assertKnownJsonSchemaKeywords(item, dialect);
    } else if (meta.subschema === 'map' && isRecord(value)) {
      for (const child of Object.values(value)) assertKnownJsonSchemaKeywords(child, dialect);
    } else if (meta.subschema === 'dependencies' && isRecord(value)) {
      for (const child of Object.values(value)) {
        if (isRecord(child)) assertKnownJsonSchemaKeywords(child, dialect);
      }
    }
  }
}
