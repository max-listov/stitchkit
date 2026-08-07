import { isRecord } from '../internal/typed';
import type { ToolPresentationSchema } from './flatten';

export interface VariantProperty {
  schema: ToolPresentationSchema;
  labels: string[];
  required: boolean;
}

const ANNOTATION_KEYS = new Set(['$schema', 'default', 'description', 'examples', 'title']);

const TYPE_KEYWORDS: Record<string, readonly string[]> = {
  array: [
    'contains',
    'items',
    'maxContains',
    'maxItems',
    'minContains',
    'minItems',
    'prefixItems',
    'uniqueItems',
  ],
  integer: ['exclusiveMaximum', 'exclusiveMinimum', 'maximum', 'minimum', 'multipleOf'],
  number: ['exclusiveMaximum', 'exclusiveMinimum', 'maximum', 'minimum', 'multipleOf'],
  object: [
    'additionalProperties',
    'dependentRequired',
    'dependentSchemas',
    'maxProperties',
    'minProperties',
    'patternProperties',
    'properties',
    'propertyNames',
    'required',
  ],
  string: [
    'contentEncoding',
    'contentMediaType',
    'format',
    'maxLength',
    'minLength',
    'pattern',
  ],
};

/** Remove nullable `anyOf` only while a DU property is projected. */
function nullableProjection(schema: ToolPresentationSchema): ToolPresentationSchema {
  if (!Array.isArray(schema.anyOf) || schema.anyOf.length !== 2) return schema;
  const branches = schema.anyOf.filter(isRecord);
  if (branches.length !== 2) return schema;
  const nullBranch = branches.find((branch) => branch.type === 'null');
  const value = branches.find(
    (branch) => typeof branch.type === 'string' && branch.type !== 'null',
  );
  if (!nullBranch || !value || Object.keys(nullBranch).some((key) => key !== 'type')) {
    return schema;
  }
  const type = value.type;
  if (typeof type !== 'string') return schema;
  const projected: ToolPresentationSchema = { type: [type, 'null'] };
  for (const key of [...ANNOTATION_KEYS, ...(TYPE_KEYWORDS[type] ?? [])]) {
    if (value[key] !== undefined) projected[key] = value[key];
    else if (schema[key] !== undefined) projected[key] = schema[key];
  }
  if (value.const !== undefined) projected.enum = [value.const, null];
  else if (Array.isArray(value.enum)) projected.enum = [...value.enum, null];
  return projected;
}

function withoutAnnotations(schema: ToolPresentationSchema): ToolPresentationSchema {
  const result: ToolPresentationSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!ANNOTATION_KEYS.has(key)) result[key] = value;
  }
  return result;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!isRecord(value)) return JSON.stringify(value) ?? 'undefined';
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(',')}}`;
}

function stringValues(schema: ToolPresentationSchema): string[] | null {
  if (typeof schema.const === 'string') return [schema.const];
  if (!Array.isArray(schema.enum)) return null;
  const values = schema.enum.filter((value): value is string => typeof value === 'string');
  return values.length === schema.enum.length ? values : null;
}

function typeNames(schema: ToolPresentationSchema): string[] | null {
  if (typeof schema.type === 'string') return [schema.type];
  if (Array.isArray(schema.type)) {
    const values = schema.type.filter((value): value is string => typeof value === 'string');
    if (values.length === schema.type.length) return values;
  }
  const values = stringValues(schema);
  if (values) return ['string'];
  if (typeof schema.const === 'number') return ['number'];
  if (typeof schema.const === 'boolean') return ['boolean'];
  return null;
}

function typeSchema(type: string, nullable: boolean): ToolPresentationSchema {
  const schema: ToolPresentationSchema = { type: nullable ? [type, 'null'] : type };
  if (type === 'array') schema.items = {};
  if (type === 'object') schema.additionalProperties = {};
  return schema;
}

function commonBaseType(schemas: ToolPresentationSchema[]): ToolPresentationSchema {
  const names = schemas.map(typeNames);
  if (names.some((value) => value === null)) return {};
  let nullable = false;
  const bases = new Set<string>();
  for (const branch of names) {
    if (!branch) return {};
    for (const name of branch) {
      if (name === 'null') nullable = true;
      else bases.add(name);
    }
  }
  if (bases.size === 1) {
    const [only] = bases;
    return only ? typeSchema(only, nullable) : {};
  }
  if ([...bases].every((name) => name === 'integer' || name === 'number')) {
    return typeSchema('number', nullable);
  }
  return {};
}

export function mergePropertySchemas(properties: VariantProperty[]): ToolPresentationSchema {
  const schemas = properties.map((property) => nullableProjection(property.schema));
  const structural = schemas.map(withoutAnnotations);
  const [first] = structural;
  let merged: ToolPresentationSchema;
  if (first && structural.every((schema) => stableJson(schema) === stableJson(first))) {
    merged = structuredClone(first);
  } else {
    const values = schemas.map(stringValues);
    const allStrings = values.every((value) => value !== null);
    merged = allStrings
      ? { type: 'string', enum: [...new Set(values.flatMap((value) => value ?? []))] }
      : commonBaseType(schemas);
  }
  const descriptions = [
    ...new Set(
      schemas
        .map((schema) => schema.description)
        .filter((value): value is string => typeof value === 'string'),
    ),
  ];
  if (descriptions.length === 1) merged.description = descriptions[0];
  return merged;
}
