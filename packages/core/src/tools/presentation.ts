import { z } from 'zod';
import { isRecord } from '../internal/typed';
import {
  flattenToolJsonSchema,
  freezeToolJsonSchema,
  type ToolPresentationSchema,
} from './flatten';
import { toJsonSchema } from './json-schema';

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

function rewriteLocalReferences(value: unknown, namespace: string): unknown {
  if (Array.isArray(value)) {
    return value.map((child) => rewriteLocalReferences(child, namespace));
  }
  if (!isRecord(value)) return value;
  const rewritten: ToolPresentationSchema = {};
  for (const [key, child] of Object.entries(value)) {
    rewritten[key] =
      key === '$ref' && typeof child === 'string' && child.startsWith('#')
        ? `#/definitions/${namespace}${child.slice(1)}`
        : rewriteLocalReferences(child, namespace);
  }
  return rewritten;
}

/** Keep component-local `#` references local after params/input are merged. */
function namespaceLocalReferences(
  schema: ToolPresentationSchema | undefined,
  namespace: string,
): ToolPresentationSchema | undefined {
  if (!schema || !hasLocalReference(schema)) return schema;
  const rewritten = rewriteLocalReferences(schema, namespace);
  if (!isRecord(rewritten)) return schema;
  return { ...rewritten, definitions: { [namespace]: rewritten } };
}

function objectProperties(schema: ToolPresentationSchema): ToolPresentationSchema | null {
  return schema.type === 'object' && isRecord(schema.properties) ? schema.properties : null;
}

function requiredKeys(schema: ToolPresentationSchema): string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === 'string')
    : [];
}

function mergeObjectSchemas(
  left: ToolPresentationSchema,
  right: ToolPresentationSchema,
  rightOwnsUnknownKeys: boolean,
): ToolPresentationSchema {
  const leftProperties = objectProperties(left);
  const rightProperties = objectProperties(right);
  if (!leftProperties || !rightProperties) return { allOf: [left, right] };

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

/** Metadata passed to the Zod identity carrier; the SDK supplies its own dialect. */
export function presentationMetadata(schema: ToolPresentationSchema): ToolPresentationSchema {
  return withoutDialect(schema);
}
