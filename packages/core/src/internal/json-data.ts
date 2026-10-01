/** Validation shared by durable JSON and canonical JSON; serialization has one separate owner. */
export function isJsonData(
  value: unknown,
  limits: {
    maxDepth: number;
    maxNodes: number;
    maxBytes: number;
    omitObjectUndefined: boolean;
  },
): boolean {
  const ancestors = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  const charge = (amount: number): boolean => {
    bytes += amount;
    return bytes <= limits.maxBytes;
  };
  const textSize = (text: string): number => {
    if (text.length > limits.maxBytes) return limits.maxBytes + 1;
    return new TextEncoder().encode(JSON.stringify(text)).byteLength;
  };
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > limits.maxNodes || depth > limits.maxDepth) return false;
    if (item === null) return charge(4);
    if (typeof item === 'string') return charge(textSize(item));
    if (typeof item === 'boolean') return charge(item ? 4 : 5);
    if (typeof item === 'number')
      return Number.isFinite(item) && !Object.is(item, -0) && charge(String(item).length);
    if (typeof item !== 'object' || ancestors.has(item)) return false;
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (
      array
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    )
      return false;
    // Refuse oversized arrays before enumerating them, including huge sparse arrays.
    if (array && item.length > limits.maxNodes - nodes) return false;
    const keys = Reflect.ownKeys(item);
    if (keys.length > limits.maxNodes - nodes + (array ? 1 : 0)) return false;
    if (array && keys.length !== item.length + 1) return false;
    ancestors.add(item);
    try {
      if (!charge(2)) return false;
      let members = 0;
      for (const key of keys) {
        if (array && key === 'length') continue;
        if (typeof key !== 'string') return false;
        if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length))
          return false;
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor?.enumerable || !('value' in descriptor)) return false;
        if (!array && limits.omitObjectUndefined && descriptor.value === undefined) {
          if (++nodes > limits.maxNodes) return false;
          continue;
        }
        if (members++ > 0 && !charge(1)) return false;
        if (!array && !charge(textSize(key) + 1)) return false;
        if (!visit(descriptor.value, depth + 1)) return false;
      }
      return true;
    } finally {
      ancestors.delete(item);
    }
  };
  return visit(value, 0);
}
