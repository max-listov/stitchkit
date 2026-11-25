/**
 * An order key between any two keys, through `stitchkit/primitives`.
 *
 * The properties a list's positions rest on: the key falls strictly between its bounds in the
 * order JavaScript and a `COLLATE "C"` database compare, there is always room for another, keys at
 * the ends stay short, and keys made by the `fractional-indexing` package — which consuming apps
 * already store — read as well-formed and come out the same. The vectors below were produced by
 * `fractional-indexing@4.0.0` `generateKeyBetween` with its default alphabets (2026-11-24).
 */
import { describe, expect, test } from 'bun:test';
import {
  isOrderKey,
  OrderKeyError,
  OrderKeySchema,
  orderKeyBetween,
} from '../src/entrypoints/primitives';

/** A seeded generator: the same inserts on every run. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Insert into a sorted array of keys at `index` (0 … length), asserting the key's place. */
function insertAt(keys: string[], index: number): string {
  const low = index === 0 ? null : (keys[index - 1] ?? null);
  const high = index === keys.length ? null : (keys[index] ?? null);
  const key = orderKeyBetween(low, high);
  if (low !== null && !(low < key)) throw new Error(`${key} is not after ${low}`);
  if (high !== null && !(key < high)) throw new Error(`${key} is not before ${high}`);
  if (!isOrderKey(key)) throw new Error(`${key} is not well-formed`);
  keys.splice(index, 0, key);
  return key;
}

describe('orderKeyBetween', () => {
  test('a key always falls strictly between its bounds, and the byte order is the string order', () => {
    const random = seeded(20261124);
    const keys: string[] = [];
    for (let step = 0; step < 20_000; step += 1)
      insertAt(keys, Math.floor(random() * (keys.length + 1)));
    expect(keys).toHaveLength(20_000);
    expect(new Set(keys).size).toBe(20_000);
    const bytes = keys.toSorted((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    expect(bytes).toEqual(keys);
  });

  test('appending and prepending ten thousand times keeps keys at the ends short', () => {
    const keys: string[] = [];
    for (let step = 0; step < 10_000; step += 1) insertAt(keys, keys.length);
    for (let step = 0; step < 10_000; step += 1) insertAt(keys, 0);
    expect(Math.max(...keys.map((key) => key.length))).toBeLessThanOrEqual(4);
  });

  test('a gap is never closed: two thousand inserts into one gap grow the key by about one character in five', () => {
    let low = orderKeyBetween(null, null);
    const high = orderKeyBetween(low, null);
    for (let step = 0; step < 2_000; step += 1) {
      const key = orderKeyBetween(low, high);
      expect(low < key && key < high).toBe(true);
      low = key;
    }
    // About one character per five inserts; the package makes keys of the same length here.
    expect(low.length).toBe(402);
  });

  test('the first key of an empty list leaves room on both sides', () => {
    const first = orderKeyBetween(null, null);
    expect(first).toBe('a0');
    expect(orderKeyBetween(null, first) < first).toBe(true);
    expect(first < orderKeyBetween(first, null)).toBe(true);
  });

  test('keys come out as the fractional-indexing package makes them', () => {
    const vectors: [string | null, string | null, string][] = [
      [null, null, 'a0'],
      ['a0', null, 'a1'],
      [null, 'a0', 'Zz'],
      ['a0', 'a1', 'a0V'],
      ['a0V', 'a1', 'a0l'],
      ['a0', 'a0V', 'a0G'],
      ['az', null, 'b00'],
      [null, 'b00', 'az'],
      ['Zz', 'a0', 'ZzV'],
      ['a1', 'a2', 'a1V'],
      ['a0zzz', 'a1', 'a0zzzV'],
      ['a0', 'a01', 'a00V'],
      ['bzz', null, 'c000'],
      ['A00000000000000000000000001', null, 'A00000000000000000000000002'],
      ['zzzzzzzzzzzzzzzzzzzzzzzzzzz', null, 'zzzzzzzzzzzzzzzzzzzzzzzzzzzV'],
    ];
    for (const [low, high, expected] of vectors)
      expect(orderKeyBetween(low, high)).toBe(expected);
  });

  test('below the integer next to the smallest, the key is well-formed where the package’s is not', () => {
    // `fractional-indexing` answers the bare smallest integer `A` + 26 zeros, which it then
    // refuses as a bound; here the key carries a fraction and stays usable.
    const key = orderKeyBetween(null, 'A00000000000000000000000001');
    expect(key).toBe('A00000000000000000000000000V');
    expect(isOrderKey(key)).toBe(true);
    expect(orderKeyBetween(null, key) < key).toBe(true);
  });
});

describe('refusals', () => {
  test('control: a key ending in the lowest digit, a foreign character or a bad head is not an order key', () => {
    expect(isOrderKey('a0')).toBe(true);
    expect(isOrderKey('a0V')).toBe(true);
    // Between `a0` and `a00` there would be no key at all: such a key is never made nor taken.
    expect(isOrderKey('a00')).toBe(false);
    expect(isOrderKey('')).toBe(false);
    expect(isOrderKey('a')).toBe(false);
    expect(isOrderKey('a 0')).toBe(false);
    expect(isOrderKey('a0~')).toBe(false);
    expect(isOrderKey('0a')).toBe(false);
    expect(isOrderKey('A00000000000000000000000000')).toBe(false);
    expect(OrderKeySchema.safeParse('a0V').success).toBe(true);
    expect(OrderKeySchema.safeParse('a00').success).toBe(false);
  });

  test('bounds out of order, equal or malformed throw a typed reason instead of a key', () => {
    const reason = (low: string | null, high: string | null) => {
      try {
        orderKeyBetween(low, high);
      } catch (error) {
        if (error instanceof OrderKeyError) return error.reason;
        throw error;
      }
      return 'none';
    };
    expect(reason('a1', 'a0')).toBe('order');
    expect(reason('a0', 'a0')).toBe('order');
    expect(reason('a0', 'a00')).toBe('malformed');
    expect(reason('nope', null)).toBe('malformed');
    expect(reason(null, 'a0 ')).toBe('malformed');
    expect(reason('a0', 'a1')).toBe('none');
  });
});
