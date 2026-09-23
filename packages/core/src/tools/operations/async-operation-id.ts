/**
 * The ID boundary every async-operation surface shares: the type-level tests
 * that an ID schema reads back what it writes, the runtime check that refuses
 * one which does not, and the parse that guards every adapter's return value.
 */
import { type ZodType, z } from 'zod';
import type { EndpointDef } from '../../contract/define';
import { isRecord } from '../../internal/typed';
import type { AsyncOperationCapability } from './async-operation-contract';

export type ContractAsyncOperationKeys<TEndpoints extends Record<string, EndpointDef>> =
  keyof TEndpoints & string;

export type EndpointInputSchema<TEndpoint> = TEndpoint extends {
  input: infer TSchema extends ZodType;
}
  ? TSchema
  : never;

export type EndpointOutputSchema<TEndpoint> = TEndpoint extends {
  output: infer TSchema extends ZodType;
}
  ? TSchema
  : never;

type TypesEqual<TLeft, TRight> = [TLeft] extends [TRight]
  ? [TRight] extends [TLeft]
    ? true
    : false
  : false;

export type StableSchema<TSchema extends ZodType> =
  TypesEqual<z.input<TSchema>, z.output<TSchema>> extends true ? TSchema : never;

export type SchemasEquivalent<TLeft extends ZodType, TRight extends ZodType> =
  TypesEqual<z.input<TLeft>, z.input<TRight>> extends true
    ? TypesEqual<z.output<TLeft>, z.output<TRight>>
    : false;

export function adapterResult<TSchema extends ZodType>(
  capability: AsyncOperationCapability,
  target: 'id' | 'input',
  schema: TSchema,
  value: unknown,
): z.output<TSchema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Async operation adapter for capability "${capability}" returned invalid ${target}`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

const NON_WIRE_STABLE_ZOD_TYPES = new Set([
  'catch',
  'default',
  'lazy',
  'pipe',
  'prefault',
  'readonly',
  'success',
  'transform',
]);

function hasOverwriteCheck(value: unknown): boolean {
  return (
    isRecord(value) &&
    isRecord(value._zod) &&
    isRecord(value._zod.def) &&
    value._zod.def.check === 'overwrite'
  );
}

/** Direct adapters parse an ID more than once, so their schema must preserve parsed values. */
export function assertWireStableIdSchema(schema: ZodType, boundary: string): void {
  const visited = new Set<object>();
  const pending: unknown[] = [schema];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== 'object' || value === null || visited.has(value)) continue;
    visited.add(value);
    if (value instanceof z.ZodType) {
      const definition = value._zod.def;
      if (
        NON_WIRE_STABLE_ZOD_TYPES.has(definition.type) ||
        ('coerce' in definition && definition.coerce === true) ||
        ('checks' in definition &&
          Array.isArray(definition.checks) &&
          definition.checks.some(hasOverwriteCheck))
      ) {
        throw new Error(
          `${boundary} must use a wire-stable ID schema without transforms, coercion, defaults or overwrites; use binding: "adapted" with explicit ID adapters`,
        );
      }
      pending.push(...Object.values(definition));
      continue;
    }
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (isRecord(value)) pending.push(...Object.values(value));
  }
}
