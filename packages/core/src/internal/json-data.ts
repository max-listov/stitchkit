import { jsonStringSize } from './json-string-size';

/**
 * Shared descriptor traversal. A snapshot sink captures admitted data without rereading the caller;
 * predicate-only validation allocates no payload copy and skips absent byte accounting.
 * Limits bound admitted data, not arbitrary JavaScript executed inside Proxy traps.
 */
export function isJsonData(
  value: unknown,
  limits: {
    maxDepth: number;
    maxNodes: number;
    maxBytes?: number;
    omitObjectUndefined: boolean;
  },
  snapshot?: { value?: unknown },
): boolean {
  const ancestors = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  const byteLimit = limits.maxBytes;
  const charge = (amount: number): boolean => {
    if (byteLimit === undefined) return true;
    bytes += amount;
    return bytes <= byteLimit;
  };
  const chargeText = (text: string): boolean =>
    byteLimit === undefined || charge(jsonStringSize(text, byteLimit - bytes));
  const visit = (item: unknown, depth: number, target?: object, key?: string): boolean => {
    if (++nodes > limits.maxNodes || depth > limits.maxDepth) return false;
    let captured = item;
    if (item === null) {
      if (!charge(4)) return false;
    } else if (typeof item === 'string') {
      if (!chargeText(item)) return false;
    } else if (typeof item === 'boolean') {
      if (!charge(item ? 4 : 5)) return false;
    } else if (typeof item === 'number') {
      if (!Number.isFinite(item) || Object.is(item, -0)) return false;
      if (byteLimit !== undefined && !charge(String(item).length)) return false;
    } else {
      if (typeof item !== 'object' || ancestors.has(item)) return false;
      const array = Array.isArray(item);
      const prototype = Object.getPrototypeOf(item);
      if (
        array
          ? prototype !== Array.prototype
          : prototype !== Object.prototype && prototype !== null
      )
        return false;
      let length = 0;
      if (array) {
        const descriptor = Object.getOwnPropertyDescriptor(item, 'length');
        if (!descriptor || !('value' in descriptor)) return false;
        const capturedLength: unknown = descriptor.value;
        if (
          typeof capturedLength !== 'number' ||
          !Number.isInteger(capturedLength) ||
          capturedLength < 0 ||
          capturedLength > 2 ** 32 - 1
        )
          return false;
        length = capturedLength;
        // Each dense element consumes a node and at least one byte, plus separators and brackets.
        if (length > limits.maxNodes - nodes) return false;
        if (byteLimit !== undefined && Math.max(2, length * 2 + 1) > byteLimit - bytes)
          return false;
      }
      const keys = Reflect.ownKeys(item);
      if (keys.length > limits.maxNodes - nodes + (array ? 1 : 0)) return false;
      if (array && keys.length !== length + 1) return false;
      if (!charge(2)) return false;
      const copy = target ? (array ? [] : {}) : undefined;
      ancestors.add(item);
      try {
        let members = 0;
        for (const memberKey of keys) {
          if (array && memberKey === 'length') continue;
          if (typeof memberKey !== 'string') return false;
          if (array && (!/^(0|[1-9][0-9]*)$/.test(memberKey) || Number(memberKey) >= length))
            return false;
          const descriptor = Object.getOwnPropertyDescriptor(item, memberKey);
          if (!descriptor?.enumerable || !('value' in descriptor)) return false;
          const memberValue: unknown = descriptor.value;
          if (!array && limits.omitObjectUndefined && memberValue === undefined) {
            if (++nodes > limits.maxNodes) return false;
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
    return visit(value, 0, snapshot, 'value');
  } catch {
    // Revoked proxies and refused reflective operations are invalid JSON data.
    return false;
  }
}
