import { z } from 'zod';
import { isRecord } from '../internal/typed';
import {
  flattenToolJsonSchema,
  freezeToolJsonSchema,
  type ToolPresentationSchema,
} from './flatten';
import { toJsonSchema } from './json-schema';
import { withDefsDialect } from './json-schema-dialect';

export interface ToolPresentationConfig {
  paramsSchema?: z.ZodType;
  inputSchema?: z.ZodType;
  extendSchema?: Record<string, z.ZodType>;
  flattenUnionInput?: boolean;
  unrepresentable?: 'throw' | 'any';
}

function withoutDialect(schema: ToolPresentationSchema): ToolPresentationSchema {
  const result: ToolPresentationSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key !== '$schema') result[key] = value;
  }
  return result;
}

function hasLocalReference(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasLocalReference);
  if (!isRecord(value)) return false;
  if (typeof value.$ref === 'string' && value.$ref.startsWith('#')) return true;
  return Object.values(value).some(hasLocalReference);
}

/**
 * Definition names carry their namespace as a prefix rather than living inside a
 * per-namespace wrapper. A nested `definitions` block is a valid JSON Pointer
 * target and an unreadable one: a reader that looks for definitions where the
 * dialect puts them — at the document root — never finds `#/definitions/input/
 * definitions/x`, and our own MCP client was one such reader.
 */
const NAMESPACE_SEPARATOR = '__';

const DEFINITION_KEYWORDS = ['definitions', '$defs'];

interface RewriteTargets {
  /** Set when a reference points at the document root rather than a definition. */
  rootReferenced: boolean;
}

function rewriteReference(
  reference: string,
  namespace: string,
  targets: RewriteTargets,
): string {
  if (reference === '#' || reference === '#/') {
    targets.rootReferenced = true;
    return `#/definitions/${namespace}`;
  }
  const segments = reference.slice(2).split('/');
  const [keyword, name, ...rest] = segments;
  if (keyword !== undefined && name !== undefined && DEFINITION_KEYWORDS.includes(keyword)) {
    const renamed = `${namespace}${NAMESPACE_SEPARATOR}${name}`;
    return ['#', 'definitions', renamed, ...rest].join('/');
  }
  targets.rootReferenced = true;
  return `#/definitions/${namespace}/${segments.join('/')}`;
}

function rewriteLocalReferences(
  value: unknown,
  namespace: string,
  targets: RewriteTargets,
): unknown {
  if (Array.isArray(value)) {
    return value.map((child) => rewriteLocalReferences(child, namespace, targets));
  }
  if (!isRecord(value)) return value;
  const rewritten: ToolPresentationSchema = {};
  for (const [key, child] of Object.entries(value)) {
    rewritten[key] =
      key === '$ref' && typeof child === 'string' && child.startsWith('#')
        ? rewriteReference(child, namespace, targets)
        : rewriteLocalReferences(child, namespace, targets);
  }
  return rewritten;
}

/**
 * Keep component-local `#` references local after params/input are merged, with
 * every definition hoisted to the document root under a namespaced name.
 */
function namespaceLocalReferences(
  schema: ToolPresentationSchema | undefined,
  namespace: string,
): ToolPresentationSchema | undefined {
  if (!schema || !hasLocalReference(schema)) return schema;
  const targets: RewriteTargets = { rootReferenced: false };
  const rewritten = rewriteLocalReferences(schema, namespace, targets);
  if (!isRecord(rewritten)) return schema;

  const definitions: Record<string, unknown> = {};
  const body: ToolPresentationSchema = {};
  for (const [key, value] of Object.entries(rewritten)) {
    if (DEFINITION_KEYWORDS.includes(key)) {
      if (isRecord(value)) {
        for (const [name, definition] of Object.entries(value)) {
          definitions[`${namespace}${NAMESPACE_SEPARATOR}${name}`] = definition;
        }
      }
      continue;
    }
    body[key] = value;
  }
  if (targets.rootReferenced) definitions[namespace] = withoutDialect(body);
  if (Object.keys(definitions).length === 0) return body;
  return { ...body, definitions };
}

function objectProperties(schema: ToolPresentationSchema): ToolPresentationSchema | null {
  return schema.type === 'object' && isRecord(schema.properties) ? schema.properties : null;
}

function requiredKeys(schema: ToolPresentationSchema): string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === 'string')
    : [];
}

/**
 * Definitions belong to the document, not to a branch of it: a `#/definitions/x`
 * reference is resolved from the root, so an `allOf` merge has to lift both
 * branches' definitions up with it.
 */
function hoistDefinitions(schema: ToolPresentationSchema): ToolPresentationSchema {
  const branches = Array.isArray(schema.allOf) ? schema.allOf : [];
  const definitions: Record<string, unknown> = {};
  const lifted = branches.map((branch) => {
    if (!isRecord(branch) || !isRecord(branch.definitions)) return branch;
    Object.assign(definitions, branch.definitions);
    const rest: ToolPresentationSchema = {};
    for (const [key, value] of Object.entries(branch)) {
      if (key !== 'definitions') rest[key] = value;
    }
    return rest;
  });
  if (Object.keys(definitions).length === 0) return schema;
  return { ...schema, allOf: lifted, definitions };
}

function mergeObjectSchemas(
  left: ToolPresentationSchema,
  right: ToolPresentationSchema,
  rightOwnsUnknownKeys: boolean,
): ToolPresentationSchema {
  const leftProperties = objectProperties(left);
  const rightProperties = objectProperties(right);
  if (!leftProperties || !rightProperties) return hoistDefinitions({ allOf: [left, right] });

  const conflicts = Object.keys(leftProperties).filter((key) => key in rightProperties);
  if (conflicts.length > 0) {
    throw new Error(
      `Schema merge conflict: ${conflicts.join(', ')} appear in both params and input`,
    );
  }

  const merged: ToolPresentationSchema = {
    type: 'object',
    properties: { ...leftProperties, ...rightProperties },
    required: [...new Set([...requiredKeys(left), ...requiredKeys(right)])],
  };
  const leftDefinitions = isRecord(left.definitions) ? left.definitions : {};
  const rightDefinitions = isRecord(right.definitions) ? right.definitions : {};
  const definitions = { ...leftDefinitions, ...rightDefinitions };
  if (Object.keys(definitions).length > 0) merged.definitions = definitions;
  const unknownKeys = rightOwnsUnknownKeys
    ? right.additionalProperties
    : left.additionalProperties;
  if (unknownKeys !== undefined) merged.additionalProperties = unknownKeys;
  return merged;
}

function schemaFromZod(
  schema: z.ZodType | undefined,
  unrepresentable: 'throw' | 'any',
  flatten: boolean,
): ToolPresentationSchema | undefined {
  if (!schema) return undefined;
  const json = toJsonSchema(schema, 'input', unrepresentable, 'draft-07');
  return flatten ? flattenToolJsonSchema(json) : json;
}

/** Build the one model-facing document shared by MCP, agents and manifests. */
export function buildToolPresentationSchema(
  config: ToolPresentationConfig,
): ToolPresentationSchema {
  const unrepresentable = config.unrepresentable ?? 'any';
  const flatten = config.flattenUnionInput ?? false;
  const params = namespaceLocalReferences(
    schemaFromZod(config.paramsSchema, unrepresentable, flatten),
    'params',
  );
  const input = namespaceLocalReferences(
    schemaFromZod(config.inputSchema, unrepresentable, flatten),
    'input',
  );

  let presentation: ToolPresentationSchema;
  if (params && input) {
    presentation = mergeObjectSchemas(withoutDialect(params), withoutDialect(input), true);
  } else if (input) {
    presentation = input;
  } else if (params) {
    presentation = params;
  } else {
    presentation = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {},
    };
  }

  if (config.extendSchema) {
    const extra = namespaceLocalReferences(
      schemaFromZod(z.object(config.extendSchema), unrepresentable, flatten),
      'extend',
    );
    if (extra) {
      presentation = mergeObjectSchemas(
        withoutDialect(extra),
        withoutDialect(presentation),
        true,
      );
    }
  }

  if (presentation.$schema === undefined) {
    presentation = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      ...presentation,
    };
  }
  return freezeToolJsonSchema(presentation);
}

export function isObjectPresentationSchema(schema: ToolPresentationSchema): boolean {
  return schema.type === 'object' && isRecord(schema.properties);
}

/**
 * Metadata passed to the Zod identity carrier.
 *
 * The SDK supplies its own dialect and it is 2020-12, so the document has to
 * speak 2020-12: a draft-07 `definitions` block under a 2020-12 `$schema` is a
 * document that says one thing and does another, and a client that believes the
 * stamp cannot resolve a single `#/definitions/...` pointer in it.
 */
export function presentationMetadata(schema: ToolPresentationSchema): ToolPresentationSchema {
  return withDefsDialect(withoutDialect(schema));
}
