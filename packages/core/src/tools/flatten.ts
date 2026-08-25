import { isRecord } from '../internal/typed';
import { mergePropertySchemas, stringValues, type VariantProperty } from './flatten-join';

export type ToolPresentationSchema = Record<string, unknown>;

interface Discriminator {
  key: string;
  values: string[][];
}

/** Return a recursively rebuilt JSON value, never sharing mutable nodes with the source. */
function rebuild(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rebuild);
  if (!isRecord(value)) return value;

  const node: ToolPresentationSchema = {};
  for (const [key, child] of Object.entries(value)) node[key] = rebuild(child);
  return flattenNode(node);
}

function objectVariants(node: ToolPresentationSchema): ToolPresentationSchema[] | null {
  if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) return null;
  const variants = node.oneOf.filter(isRecord);
  if (variants.length !== node.oneOf.length) return null;
  if (variants.some((variant) => variant.type !== 'object' || !isRecord(variant.properties))) {
    return null;
  }
  return variants;
}

/** Find a common string const/enum whose branch values do not overlap. */
function findDiscriminator(variants: ToolPresentationSchema[]): Discriminator | null {
  const [first] = variants;
  if (!first || !isRecord(first.properties)) return null;

  for (const key of Object.keys(first.properties).sort()) {
    const values: string[][] = [];
    const seen = new Set<string>();
    let valid = true;
    for (const variant of variants) {
      if (!requiredKeys(variant).has(key)) {
        valid = false;
        break;
      }
      const properties = variant.properties;
      const field = isRecord(properties) ? properties[key] : undefined;
      const branchValues = isRecord(field) ? stringValues(field) : null;
      if (!branchValues || branchValues.length === 0) {
        valid = false;
        break;
      }
      for (const value of branchValues) {
        if (seen.has(value)) {
          valid = false;
          break;
        }
        seen.add(value);
      }
      if (!valid) break;
      values.push(branchValues);
    }
    if (valid) return { key, values };
  }
  return null;
}

function requiredKeys(variant: ToolPresentationSchema): Set<string> {
  if (!Array.isArray(variant.required)) return new Set();
  return new Set(variant.required.filter((key): key is string => typeof key === 'string'));
}

function appendHint(schema: ToolPresentationSchema, hint: string): ToolPresentationSchema {
  const description = typeof schema.description === 'string' ? schema.description : undefined;
  return { ...schema, description: description ? `${description} ${hint}` : hint };
}

/** Flatten one structurally identifiable discriminated object union. */
function flattenNode(node: ToolPresentationSchema): ToolPresentationSchema {
  const variants = objectVariants(node);
  if (!variants) return node;
  const discriminator = findDiscriminator(variants);
  if (!discriminator) return node;

  const perKey = new Map<string, VariantProperty[]>();
  for (let index = 0; index < variants.length; index++) {
    const variant = variants[index];
    if (!variant) continue;
    const labels = discriminator.values[index] ?? [];
    const required = requiredKeys(variant);
    if (!isRecord(variant.properties)) continue;
    for (const [key, rawSchema] of Object.entries(variant.properties)) {
      if (key === discriminator.key || !isRecord(rawSchema)) continue;
      const entries = perKey.get(key) ?? [];
      entries.push({ schema: rawSchema, labels, required: required.has(key) });
      perKey.set(key, entries);
    }
  }

  const discriminatorProperties: VariantProperty[] = [];
  for (let index = 0; index < variants.length; index++) {
    const variant = variants[index];
    if (!variant || !isRecord(variant.properties)) continue;
    const schema = variant.properties[discriminator.key];
    if (!isRecord(schema)) continue;
    discriminatorProperties.push({
      schema,
      labels: discriminator.values[index] ?? [],
      required: true,
    });
  }
  const properties: ToolPresentationSchema = {
    [discriminator.key]: mergePropertySchemas(discriminatorProperties),
  };
  const required = [discriminator.key];

  for (const [key, entries] of perKey) {
    let merged = mergePropertySchemas(entries);
    const requiredEverywhere =
      entries.length === variants.length && entries.every((entry) => entry.required);
    if (requiredEverywhere) {
      required.push(key);
    } else {
      const requiredLabels = entries
        .filter((entry) => entry.required)
        .flatMap((entry) => entry.labels);
      const presentLabels = entries.flatMap((entry) => entry.labels);
      const labels = requiredLabels.length > 0 ? requiredLabels : presentLabels;
      const verb = requiredLabels.length > 0 ? 'Required' : 'Available';
      merged = appendHint(
        merged,
        `${verb} if ${discriminator.key} = ${[...new Set(labels)].join(' | ')}`,
      );
    }
    properties[key] = merged;
  }

  const result: ToolPresentationSchema = {};
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'oneOf' && key !== 'anyOf' && key !== 'properties' && key !== 'required') {
      result[key] = value;
    }
  }
  result.type = 'object';
  result.properties = properties;
  result.required = required;
  result.additionalProperties = variants.every(
    (variant) => variant.additionalProperties === false,
  )
    ? false
    : {};
  return result;
}

/**
 * Rebuild a JSON Schema and replace every structurally identifiable
 * discriminated object `oneOf` with one conservative object-shaped join.
 * Plain unions remain unions. The source document is never mutated.
 */
export function flattenToolJsonSchema(schema: ToolPresentationSchema): ToolPresentationSchema {
  const result = rebuild(schema);
  return isRecord(result) ? result : {};
}

/** Freeze every JSON object/array in a prepared presentation document. */
export function freezeToolJsonSchema(schema: ToolPresentationSchema): ToolPresentationSchema {
  for (const value of Object.values(schema)) freezeJsonValue(value);
  return Object.freeze(schema);
}

function freezeJsonValue(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) freezeJsonValue(item);
    Object.freeze(value);
  } else if (isRecord(value)) {
    freezeToolJsonSchema(value);
  }
}
