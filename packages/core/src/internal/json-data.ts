import { jsonStringSize } from './json-string-size';

/**
 * Why `canonicalJson` refused a value. `depth`, `nodes` and `bytes` are the
 * caller's limits being exceeded; `cycle`, `negative-zero` and `not-json` say
 * the value is not JSON data at all.
 */
export type CanonicalJsonRefusal =
  | 'cycle'
  | 'negative-zero'
  | 'depth'
  | 'nodes'
  | 'bytes'
  | 'not-json';

export interface JsonDataLimits {
  maxDepth: number;
  maxNodes: number;
  maxBytes?: number;
  omitObjectUndefined: boolean;
  /**
   * Read the value as `z.json()` does: `-0` is admitted as `0` and an own
   * `__proto__` member is dropped. The agent store's digests were taken that way.
   */
  zodJson?: boolean;
}

/** Predicate form of {@link jsonDataRefusal}. */
export function isJsonData(
  value: unknown,
  limits: JsonDataLimits,
  snapshot?: { value?: unknown },
): boolean {
  return jsonDataRefusal(value, limits, snapshot) === undefined;
}

/**
 * Shared descriptor traversal; `undefined` admits the value and a reason names the first refusal.
 * A snapshot sink captures admitted data without rereading the caller;
 * predicate-only validation allocates no payload copy and skips absent byte accounting.
 * Limits bound admitted data, not arbitrary JavaScript executed inside Proxy traps.
 */
export function jsonDataRefusal(
  value: unknown,
  limits: JsonDataLimits,
  snapshot?: { value?: unknown },
): CanonicalJsonRefusal | undefined {
  let refusal: CanonicalJsonRefusal | undefined;
  const refuse = (reason: CanonicalJsonRefusal): false => {
    refusal ??= reason;
    return false;
  };
  const ancestors = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  const byteLimit = limits.maxBytes;
  const charge = (amount: number): boolean => {
    if (byteLimit === undefined) return true;
    bytes += amount;
    return bytes <= byteLimit || refuse('bytes');
  };
  const chargeText = (text: string): boolean =>
    byteLimit === undefined || charge(jsonStringSize(text, byteLimit - bytes));
  const visit = (item: unknown, depth: number, target?: object, key?: string): boolean => {
    if (++nodes > limits.maxNodes) return refuse('nodes');
    if (depth > limits.maxDepth) return refuse('depth');
    let captured = item;
    if (item === null) {
      if (!charge(4)) return false;
    } else if (typeof item === 'string') {
      if (!chargeText(item)) return false;
    } else if (typeof item === 'boolean') {
      if (!charge(item ? 4 : 5)) return false;
    } else if (typeof item === 'number') {
      if (!Number.isFinite(item)) return refuse('not-json');
      if (Object.is(item, -0)) {
        if (!limits.zodJson) return refuse('negative-zero');
        captured = 0;
      }
      if (byteLimit !== undefined && !charge(String(item).length)) return false;
    } else {
      if (typeof item !== 'object') return refuse('not-json');
      if (ancestors.has(item)) return refuse('cycle');
      const array = Array.isArray(item);
      const prototype = Object.getPrototypeOf(item);
      if (
        array
          ? prototype !== Array.prototype
          : prototype !== Object.prototype && prototype !== null
      )
        return refuse('not-json');
      let length = 0;
      if (array) {
        const descriptor = Object.getOwnPropertyDescriptor(item, 'length');
        if (!descriptor || !('value' in descriptor)) return refuse('not-json');
        const capturedLength: unknown = descriptor.value;
        if (
          typeof capturedLength !== 'number' ||
          !Number.isInteger(capturedLength) ||
          capturedLength < 0 ||
          capturedLength > 2 ** 32 - 1
        )
          return refuse('not-json');
        length = capturedLength;
        // Each dense element consumes a node and at least one byte, plus separators and brackets.
        if (length > limits.maxNodes - nodes) return refuse('nodes');
        if (byteLimit !== undefined && Math.max(2, length * 2 + 1) > byteLimit - bytes)
          return refuse('bytes');
      }
      const keys = Reflect.ownKeys(item);
      if (keys.length > limits.maxNodes - nodes + (array ? 1 : 0)) return refuse('nodes');
      if (array && keys.length !== length + 1) return refuse('not-json');
      if (!charge(2)) return false;
      const copy = target ? (array ? [] : {}) : undefined;
      ancestors.add(item);
      try {
        let members = 0;
        for (const memberKey of keys) {
          if (array && memberKey === 'length') continue;
          if (typeof memberKey !== 'string') return refuse('not-json');
          if (limits.zodJson && !array && memberKey === '__proto__') continue;
          if (array && (!/^(0|[1-9][0-9]*)$/.test(memberKey) || Number(memberKey) >= length))
            return refuse('not-json');
          const descriptor = Object.getOwnPropertyDescriptor(item, memberKey);
          if (!descriptor?.enumerable || !('value' in descriptor)) return refuse('not-json');
          const memberValue: unknown = descriptor.value;
          if (!array && limits.omitObjectUndefined && memberValue === undefined) {
            if (++nodes > limits.maxNodes) return refuse('nodes');
            continue;
          }
          if (members++ > 0 && !charge(1)) return false;
          if (!array && (!chargeText(memberKey) || !charge(1))) return false;
          if (!visit(memberValue, depth + 1, copy, memberKey)) return false;
        }
        captured = copy;
      } finally {
        ancestors.delete(item);
      }
    }
    if (target && key !== undefined)
      Object.defineProperty(target, key, {
        value: captured,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    return true;
  };
  try {
    return visit(value, 0, snapshot, 'value') ? undefined : (refusal ?? 'not-json');
  } catch {
    // Revoked proxies and refused reflective operations are invalid JSON data.
    return 'not-json';
  }
}
