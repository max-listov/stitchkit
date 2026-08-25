/**
 * Memoise a pure function of its input, so a deployment serving N addresses builds
 * each answer once rather than once per request.
 *
 * This is the price of deriving the public origin from the request instead of
 * the build: `robots.txt`, `sitemap.xml` and page metadata stopped being
 * prerendered constants. They are still constants *per address*, and this is
 * where that is spent — one render per address, not one per hit.
 *
 * Bounded and least-recently-used on purpose: part of every key comes from a
 * request header, and a forged `Host` must not be able to grow the cache
 * without limit. The key is derived by `keyOf` so the builder keeps its real
 * types — nothing is stringified and parsed back.
 */
export function cacheByOrigin<Input, Value>(
  keyOf: (input: Input) => string,
  build: (input: Input) => Value,
  limit = 64,
): (input: Input) => Value {
  // The value is boxed so that a builder returning `undefined` is still a hit.
  // Testing the stored value for `undefined` would rebuild it on every request
  // while the cache kept growing an entry per key.
  const entries = new Map<string, { value: Value }>();
  return (input) => {
    const key = keyOf(input);
    const hit = entries.get(key);
    if (hit) {
      entries.delete(key);
      entries.set(key, hit);
      return hit.value;
    }
    const built = { value: build(input) };
    entries.set(key, built);
    if (entries.size > limit) {
      const oldest = entries.keys().next();
      if (!oldest.done) entries.delete(oldest.value);
    }
    return built.value;
  };
}
