import { isRecord } from '../internal/typed';
import {
  encodePointerSegment,
  isObjectSchemaType,
  resolveJsonPointer,
  stripWithSchema,
  unwrapSingletonAllOf,
} from './provider-json-schema-strip';

const OPENAI_UNSUPPORTED_KEYWORDS = new Set(['propertyNames', '$schema', 'examples']);

const ANTHROPIC_STRIP_TO_DESCRIPTION = new Set([
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'pattern',
  'propertyNames',
  'minProperties',
  'maxProperties',
]);

const REGEX_LOOKAROUND = /\(\?[=!<]/u;

function flattenStrictAnyOf(branches: readonly unknown[]): unknown[] {
  const flat: unknown[] = [];
  for (const branch of branches) {
    if (isRecord(branch) && Array.isArray(branch.anyOf) && Object.keys(branch).length === 1) {
      flat.push(...flattenStrictAnyOf(branch.anyOf));
    } else {
      flat.push(branch);
    }
  }
  return flat;
}

function makeStrictNullable(propSchema: Record<string, unknown>): Record<string, unknown> {
  if (propSchema.const !== undefined) {
    return propSchema.const === null ? propSchema : { anyOf: [propSchema, { type: 'null' }] };
  }
  if (Array.isArray(propSchema.enum)) {
    const nextEnum = propSchema.enum.includes(null)
      ? propSchema.enum
      : [...propSchema.enum, null];
    if (typeof propSchema.type === 'string') {
      return propSchema.type === 'null'
        ? { ...propSchema, enum: nextEnum }
        : { ...propSchema, type: [propSchema.type, 'null'], enum: nextEnum };
    }
    if (Array.isArray(propSchema.type)) {
      const nextType = propSchema.type.includes('null')
        ? propSchema.type
        : [...propSchema.type, 'null'];
      return { ...propSchema, type: nextType, enum: nextEnum };
    }
    return { ...propSchema, enum: nextEnum };
  }
  if (typeof propSchema.type === 'string') {
    return propSchema.type === 'null'
      ? propSchema
      : { ...propSchema, type: [propSchema.type, 'null'] };
  }
  if (Array.isArray(propSchema.type)) {
    return propSchema.type.includes('null')
      ? propSchema
      : { ...propSchema, type: [...propSchema.type, 'null'] };
  }
  if (Array.isArray(propSchema.anyOf)) {
    const flat = flattenStrictAnyOf(propSchema.anyOf);
    const alreadyNullable = flat.some((branch) => isRecord(branch) && branch.type === 'null');
    return alreadyNullable
      ? { ...propSchema, anyOf: flat }
      : { ...propSchema, anyOf: [...flat, { type: 'null' }] };
  }
  return { anyOf: [propSchema, { type: 'null' }] };
}

/**
 * Normalize a JSON Schema for OpenAI Responses `text.format` (`json_schema`) and strict tools:
 * - Unwraps Zod 4 singleton `allOf` around `$ref`,
 * - Strips unsupported keywords (`propertyNames`, `$schema`, lookaround `pattern`),
 * - When `strict` is true, rewrites `oneOf` to `anyOf`, refuses dynamic record schemas
 *   (`additionalProperties` objects), enforces `additionalProperties: false` and marks every
 *   declared property `required` (making optional properties nullable so the contract stays
 *   faithful), and closes empty `{ type: 'object' }` schemas without `properties`.
 */
export function normalizeOpenAiJsonSchema(
  schema: Record<string, unknown>,
  strict: boolean,
): Record<string, unknown> {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!isRecord(value)) return value;
    const unwrapped = unwrapSingletonAllOf(value);
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(unwrapped)) {
      if (OPENAI_UNSUPPORTED_KEYWORDS.has(key)) continue;
      if (key === 'pattern' && typeof entry === 'string' && REGEX_LOOKAROUND.test(entry)) {
        continue;
      }
      if (strict && (key === 'oneOf' || key === 'anyOf') && Array.isArray(entry)) {
        const mapped = flattenStrictAnyOf(entry.map(visit));
        out.anyOf = Array.isArray(out.anyOf) ? [...out.anyOf, ...mapped] : mapped;
        continue;
      }
      out[key] = visit(entry);
    }
    if (strict && isObjectSchemaType(out.type)) {
      if (isRecord(out.additionalProperties)) {
        throw new TypeError(
          'OpenAI strict JSON Schema does not support dynamic record schemas (object additionalProperties); declare explicit object properties or disable strict mode',
        );
      }
      if (isRecord(out.properties)) {
        const existingRequired = new Set(
          Array.isArray(out.required)
            ? out.required.filter((item): item is string => typeof item === 'string')
            : [],
        );
        const nextProperties: Record<string, unknown> = {};
        const allKeys = Object.keys(out.properties);
        for (const propKey of allKeys) {
          const propSchema = out.properties[propKey];
          nextProperties[propKey] =
            !existingRequired.has(propKey) && isRecord(propSchema)
              ? makeStrictNullable(propSchema)
              : propSchema;
        }
        out.properties = nextProperties;
        out.required = allKeys;
        out.additionalProperties = false;
      } else {
        out.properties = {};
        out.required = [];
        out.additionalProperties = false;
      }
    }
    return out;
  };
  const normalized = visit(schema);
  return isRecord(normalized) ? normalized : {};
}

/**
 * Strip `null` values synthesized by OpenAI/OpenRouter strict JSON Schema optional-to-nullable
 * rewriting, omitting a `null` property ONLY where the original pre-strict JSON Schema declared
 * the property optional (not in `required`) and did NOT explicitly permit `null`.
 */
export function stripStrictOptionalNulls(
  parsed: unknown,
  originalInputSchema: unknown,
): unknown {
  if (!isRecord(originalInputSchema)) return parsed;
  return stripWithSchema(parsed, originalInputSchema, originalInputSchema);
}

function assertNoRecursiveRefs(root: Record<string, unknown>): void {
  const visiting = new Set<string>(['#']);
  const visited = new Set<string>();

  const walk = (node: unknown, skipDefContainers: boolean): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, false);
      return;
    }
    if (!isRecord(node)) return;
    if (typeof node.$ref === 'string') {
      const ref = node.$ref;
      if (visiting.has(ref)) {
        throw new TypeError(
          `Anthropic structured output schema contains recursive $ref "${ref}"`,
        );
      }
      if (!visited.has(ref)) {
        const target = resolveJsonPointer(root, ref);
        if (target !== undefined) {
          visiting.add(ref);
          walk(target, false);
          visiting.delete(ref);
        }
        visited.add(ref);
      }
    }
    for (const [key, entry] of Object.entries(node)) {
      if (skipDefContainers && (key === '$defs' || key === 'definitions')) continue;
      walk(entry, false);
    }
  };

  walk(root, true);
  visiting.delete('#');
  visited.add('#');

  for (const containerKey of ['$defs', 'definitions'] as const) {
    const container = root[containerKey];
    if (!isRecord(container)) continue;
    for (const [defName, defSchema] of Object.entries(container)) {
      const ref = `#/${containerKey}/${encodePointerSegment(defName)}`;
      if (visited.has(ref)) continue;
      visiting.add(ref);
      walk(defSchema, false);
      visiting.delete(ref);
      visited.add(ref);
    }
  }
}

/**
 * Prepare a JSON Schema for Anthropic's native `output_config.format` (`json_schema`) and
 * strict tools:
 * - Moves unsupported constraint keywords (`minLength`, `pattern`, `minimum`, …) into
 *   `description` notes so semantic intent survives without HTTP 400 rejections,
 * - Refuses dynamic record schemas (`additionalProperties` objects) fail-fast (I9) and sets
 *   `additionalProperties: false` on every object node (required by Anthropic grammar compiler),
 * - Rejects recursive `$ref` cycles via real DFS over `$defs`/`definitions` without
 *   false-positiving on shared non-cyclic `$ref` branches.
 */
export function prepareAnthropicJsonSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  assertNoRecursiveRefs(schema);

  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!isRecord(value)) return value;
    const unwrapped = unwrapSingletonAllOf(value);
    const out: Record<string, unknown> = {};
    const constraintNotes: string[] = [];
    for (const [key, entry] of Object.entries(unwrapped)) {
      if (key === '$schema') continue;
      if (ANTHROPIC_STRIP_TO_DESCRIPTION.has(key)) {
        constraintNotes.push(`${key}=${JSON.stringify(entry)}`);
        continue;
      }
      out[key] = visit(entry);
    }
    if (constraintNotes.length > 0) {
      const existing = typeof out.description === 'string' ? out.description : '';
      const suffix = `Constraints: ${constraintNotes.join(', ')}`;
      out.description = existing.length > 0 ? `${existing} (${suffix})` : suffix;
    }
    if (isObjectSchemaType(out.type)) {
      if (isRecord(out.additionalProperties)) {
        throw new TypeError(
          'Anthropic structured output JSON Schema does not support dynamic record schemas (object additionalProperties); declare explicit object properties instead',
        );
      }
      out.additionalProperties = false;
    }
    return out;
  };
  const prepared = visit(schema);
  return isRecord(prepared) ? prepared : {};
}
