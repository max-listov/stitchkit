import { type ZodObject, z } from 'zod';
import type { RuntimeContext } from '../../contract/runtime-context';
import { isRecord } from '../../internal/typed';
import { declaresDraft07, withDraft2020Keywords } from '../../json-schema/dialect';
import {
  assertKnownJsonSchemaKeywords,
  type ForeignSchemaDialect,
  REMOTE_STRIPPED_KEYWORDS,
  SCHEMA_KEYWORDS,
  SCHEMA_LIST_KEYWORDS,
  SCHEMA_MAP_KEYWORDS,
} from '../../json-schema/keywords';
import { withServedFormats } from '../../json-schema/string-format';
import type { RuntimeToolDefinition } from '../runtime-tool';
import {
  markJsonSchemaObjectGuards,
  markRemoteSchemaVerdict,
} from '../schema/json-schema-origin';
import { ConnectionAuthorizationRequiredError } from './errors';
import { toRootZodObject } from './foreign-schema';
import {
  hasNonObjectKeywords,
  hasObjectKeywords,
  joinTopLevelAllOf,
  joinTopLevelUnion,
  prepareRootRef,
  resolveLocalRef,
} from './foreign-schema-join';

export type { ForeignSchemaDialect };

/** Options controlling dialect-aware foreign JSON Schema ingestion. */
export interface ForeignSchemaOptions {
  dialect?: ForeignSchemaDialect;
}

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
 * A served document whose `$schema` is 2020-12 (or absent) while it is written in
 * draft-07 keywords says one thing and does another: the reader registers `$defs`
 * and then looks up `#/definitions/x`, and reads a tuple's `items` list as no
 * schema at all. Where the document says draft-07 it is consistent and is left alone.
 */
function reconcileDialect(schema: Record<string, unknown>): Record<string, unknown> {
  return declaresDraft07(schema.$schema) ? schema : withDraft2020Keywords(schema);
}

function normalizeForeignNode(node: unknown, dialect: ForeignSchemaDialect): unknown {
  if (!isRecord(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (REMOTE_STRIPPED_KEYWORDS.has(key)) continue;
    if (dialect !== 'openapi-3.0' && key === 'nullable') continue;
    if (SCHEMA_KEYWORDS.includes(key)) {
      out[key] = Array.isArray(value)
        ? value.map((item) => normalizeForeignNode(item, dialect))
        : normalizeForeignNode(value, dialect);
    } else if (SCHEMA_LIST_KEYWORDS.includes(key) && Array.isArray(value)) {
      out[key] = value.map((item) => normalizeForeignNode(item, dialect));
    } else if (SCHEMA_MAP_KEYWORDS.includes(key) && isRecord(value)) {
      const mapped: Record<string, unknown> = {};
      for (const [entryKey, entryVal] of Object.entries(value)) {
        mapped[entryKey] = normalizeForeignNode(entryVal, dialect);
      }
      out[key] = mapped;
    } else {
      out[key] = value;
    }
  }
  if (dialect !== 'openapi-3.0' && node.nullable === true) {
    if (typeof out.type === 'string') {
      if (out.type !== 'null') out.type = [out.type, 'null'];
      if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null];
      return out;
    }
    if (Array.isArray(out.type)) {
      if (!out.type.includes('null')) out.type = [...out.type, 'null'];
      if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null];
      return out;
    }
    if (Array.isArray(out.anyOf)) {
      return { ...out, anyOf: [...out.anyOf, { type: 'null' }] };
    }
    return { anyOf: [out, { type: 'null' }] };
  }
  return out;
}

function isObjectJsonSchema(
  root: Record<string, unknown>,
  node: Record<string, unknown>,
  seen = new Set<string>(),
): boolean {
  if (typeof node.$ref === 'string') {
    const resolved = resolveLocalRef(root, node, seen);
    return resolved !== undefined && isObjectJsonSchema(root, resolved, seen);
  }
  if (node.type !== undefined) return node.type === 'object';
  if (hasObjectKeywords(node)) return true;
  if (Array.isArray(node.allOf) && node.allOf.length > 0) {
    const branches = node.allOf.filter(isRecord);
    if (branches.some((branch) => branch.type !== undefined && branch.type !== 'object')) {
      return false;
    }
    return branches.some((branch) => isObjectJsonSchema(root, branch, new Set(seen)));
  }
  return false;
}

function isUnconstrainedRoot(schema: Record<string, unknown>): boolean {
  return (
    schema.type === undefined &&
    schema.$ref === undefined &&
    !Array.isArray(schema.allOf) &&
    !Array.isArray(schema.oneOf) &&
    !Array.isArray(schema.anyOf) &&
    !hasObjectKeywords(schema) &&
    !hasNonObjectKeywords(schema)
  );
}

function prepareForeignSchema(
  schema: Record<string, unknown>,
  dialect: ForeignSchemaDialect,
):
  | {
      joined: Record<string, unknown>;
      defaultTarget: 'openapi-3.0' | 'draft-7' | 'draft-2020-12';
    }
  | undefined {
  assertKnownJsonSchemaKeywords(schema, dialect);
  const reconciled = dialect === 'openapi-3.0' ? schema : reconcileDialect(schema);
  const normalized = normalizeForeignNode(reconciled, dialect);
  if (!isRecord(normalized)) return undefined;
  const refPrep = prepareRootRef(normalized);
  let joined = joinTopLevelAllOf(refPrep.schema, refPrep.schema, refPrep.seen);
  joined = joinTopLevelUnion(joined, joined, refPrep.seen);
  if (
    joined.type === undefined &&
    joined.$ref === undefined &&
    !hasNonObjectKeywords(joined) &&
    hasObjectKeywords(joined)
  ) {
    joined = { type: 'object', ...joined };
  }
  const defaultTarget =
    dialect === 'openapi-3.0'
      ? 'openapi-3.0'
      : declaresDraft07(joined.$schema)
        ? 'draft-7'
        : 'draft-2020-12';
  return { joined, defaultTarget };
}

/**
 * Turn a discovered JSON Schema into a `ZodObject`, keeping root object keywords
 * (`allOf`, `minProperties`, `maxProperties`, `propertyNames`, `patternProperties`,
 * `oneOf`/`anyOf`) intact. Absent or unconstrained schemas yield a permissive object;
 * irreconcilable or non-object schemas throw cleanly instead of degrading silently.
 */
export function zodObjectFromJsonSchema(
  schema: Record<string, unknown> | undefined,
  options: ForeignSchemaOptions = {},
): ZodObject {
  if (!schema || Object.keys(schema).length === 0) return z.looseObject({});
  const dialect: ForeignSchemaDialect = options.dialect ?? '2020-12';
  const prepared = prepareForeignSchema(schema, dialect);
  if (!prepared) return z.looseObject({});
  if (isUnconstrainedRoot(prepared.joined)) {
    const empty = z.looseObject({});
    markRemoteSchemaVerdict(empty);
    return empty;
  }
  const parsed = z.fromJSONSchema(withServedFormats(prepared.joined), {
    defaultTarget: prepared.defaultTarget,
  });
  const recovered = toRootZodObject(parsed, prepared.joined);
  if (!recovered) {
    throw new Error('Tool input JSON Schema must be an object schema');
  }
  markJsonSchemaObjectGuards(recovered);
  markRemoteSchemaVerdict(recovered);
  return recovered;
}

/**
 * Turn a discovered object output JSON Schema into a `ZodObject` via `toRootZodObject`.
 * Refuses empty, unconstrained, or non-object schemas while preserving root object
 * keywords (`readOnly`, `minProperties`, `patternProperties`, `additionalProperties`)
 * and MCP re-export metadata.
 */
export function zodOutputFromJsonSchema(
  schema: Record<string, unknown>,
  options: ForeignSchemaOptions = {},
): ZodObject {
  if (Object.keys(schema).length === 0) {
    throw new Error('Output JSON Schema must be an object schema');
  }
  const dialect: ForeignSchemaDialect = options.dialect ?? '2020-12';
  const prepared = prepareForeignSchema(schema, dialect);
  if (!prepared || !isObjectJsonSchema(prepared.joined, prepared.joined)) {
    throw new Error('Output JSON Schema must be an object schema');
  }
  const parsed = z.fromJSONSchema(withServedFormats(prepared.joined), {
    defaultTarget: prepared.defaultTarget,
  });
  const recovered = toRootZodObject(parsed, prepared.joined);
  if (!recovered) {
    throw new Error('Output JSON Schema must be an object schema');
  }
  markJsonSchemaObjectGuards(recovered);
  markRemoteSchemaVerdict(recovered);
  return recovered;
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
