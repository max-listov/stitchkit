import { expect, test } from 'bun:test';
import { canonicalJson } from '../src/entrypoints/primitives';
import { serializeCanonicalJson } from '../src/internal/canonical-json';

test('canonical JSON keeps UTF-16 and lexical integer keys, array order and optional members', () => {
  const value = {
    '2': 2,
    '10': 10,
    '\uE000': 'bmp',
    '\u{10000}': 'pair',
    optional: undefined,
    nested: [{ b: false, a: null }, 2, 1],
  };
  expect(canonicalJson(value)).toBe(
    '{"10":10,"2":2,"nested":[{"a":null,"b":false},2,1],"𐀀":"pair","":"bmp"}',
  );
  expect(canonicalJson(value)).toBe(serializeCanonicalJson(value));
  expect(canonicalJson(Object.assign(Object.create(null), { a: 1 }))).toBe('{"a":1}');
});

test('canonical JSON refuses invalid data without invoking accessors', () => {
  let invoked = 0;
  const accessor = Object.defineProperty({}, 'a', {
    enumerable: true,
    get() {
      invoked++;
      return 1;
    },
  });
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const bad = [
    undefined,
    [undefined],
    Array(1),
    // biome-ignore lint/suspicious/noSparseArray: deliberate invalid-JSON negative control
    [, 1],
    NaN,
    Infinity,
    -0,
    1n,
    Symbol('x'),
    () => 1,
    new Date(),
    cycle,
    accessor,
    {
      toJSON() {
        return 1;
      },
    },
    { [Symbol('key')]: 1 },
    Object.defineProperty({}, 'x', { value: 1 }),
  ];
  for (const value of bad) expect(() => canonicalJson(value)).toThrow(TypeError);
  expect(invoked).toBe(0);
  expect(serializeCanonicalJson([undefined])).toBe('[null]'); // Historical internal normalization unchanged.
});

test('canonical JSON depth, nodes and UTF-8 bytes limits change admission', () => {
  const value = { x: ['😀'] };
  const size = new TextEncoder().encode(canonicalJson(value)).length;
  expect(() => canonicalJson(value, { maxDepth: 1 })).toThrow();
  expect(canonicalJson(value, { maxDepth: 2 })).toBe('{"x":["😀"]}');
  expect(() => canonicalJson(value, { maxNodes: 2 })).toThrow();
  expect(canonicalJson(value, { maxNodes: 3 })).toBe('{"x":["😀"]}');
  expect(() => canonicalJson(value, { maxBytes: size - 1 })).toThrow();
  expect(canonicalJson(value, { maxBytes: size })).toBe('{"x":["😀"]}');
});

test('canonical JSON is independent of locale collation', () => {
  expect(canonicalJson({ ä: 1, z: 2 })).toBe('{"z":2,"ä":1}');
});
