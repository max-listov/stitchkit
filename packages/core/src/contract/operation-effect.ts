import { z } from 'zod';
import { mapObject, typedEntries } from '../internal/typed';
import type { ContractDef, EndpointDef } from './define';

/**
 * Closed effect classification for a contract operation.
 *
 * Strictly two values — `read` (no state mutation) and `write` (may mutate
 * state) — so read-only capability grants decide access directly from the
 * contract without guessing from HTTP methods or keeping a second map.
 */
export const OperationEffectSchema = z.enum(['read', 'write']);
/** Operation effect value (`'read'` or `'write'`) inferred from `OperationEffectSchema`. */
export type OperationEffect = z.infer<typeof OperationEffectSchema>;

function parseEndpointEffect(prefix: string, key: string, value: unknown): OperationEffect {
  const parsed = OperationEffectSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Contract "${prefix}": endpoint "${key}" has invalid effect "${String(value)}" — expected "read" or "write"`,
    );
  }
  return parsed.data;
}

/** Fail-fast runtime validation for `endpoint.effect` when provided. */
export function assertEndpointEffect(prefix: string, key: string, ep: EndpointDef): void {
  if (ep.effect === undefined) return;
  parseEndpointEffect(prefix, key, ep.effect);
}

/**
 * Project declared `effect` values from a contract, omitting operations that do
 * not declare one. Refuses invalid effect values on any operation.
 */
export function contractOperationEffects<T extends Record<string, EndpointDef>>(
  contract: ContractDef<T, string>,
): Partial<Record<keyof T, OperationEffect>> {
  return mapObject<T, Partial<Record<keyof T, OperationEffect>>>(
    contract.endpoints,
    (key, endpoint) => {
      if (endpoint.effect === undefined) return undefined;
      return parseEndpointEffect(contract.meta.prefix, String(key), endpoint.effect);
    },
  );
}

/**
 * Fail-closed projection of `effect` for every operation in a contract.
 * Throws listing every operation name that omits `effect`, and refuses invalid
 * values.
 */
export function requireContractOperationEffects<T extends Record<string, EndpointDef>>(
  contract: ContractDef<T, string>,
): Record<keyof T, OperationEffect> {
  const missing: string[] = [];
  for (const [key, endpoint] of typedEntries(contract.endpoints)) {
    if (endpoint.effect === undefined) {
      missing.push(String(key));
    } else {
      parseEndpointEffect(contract.meta.prefix, String(key), endpoint.effect);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Contract "${contract.meta.prefix}": missing operation effect for ${missing.join(', ')}`,
    );
  }
  return mapObject<T, Record<keyof T, OperationEffect>>(contract.endpoints, (key, endpoint) =>
    parseEndpointEffect(contract.meta.prefix, String(key), endpoint.effect),
  );
}
