import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { CanonicalJsonError, canonicalJson } from '../src/entrypoints/primitives';
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
  expect(createHash('sha256').update(canonicalJson(value)).digest('hex')).toBe(
    'cd9d0f2f03aaffa3528f44ffb60369f61205793b08357a33692f53fefa500ebd',
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

test('canonical JSON exact escaped literals charge both keys and values in UTF-8', () => {
  const cases = [
    { value: '\b\f\n\r\t\u0000\u001f"\\', text: '"\\b\\f\\n\\r\\t\\u0000\\u001f\\"\\\\"' },
    { value: '\u007f\u0080\u07ff\u0800\uffff', text: '"\u007f\u0080\u07ff\u0800\uffff"' },
    { value: '\ud800', text: '"\\ud800"' },
    { value: '\udfff', text: '"\\udfff"' },
    { value: '\ud800\udfff', text: '"𐏿"' },
    { value: '\ud800A\udfff', text: '"\\ud800A\\udfff"' },
    { value: '\u2028\u2029😀', text: '"\u2028\u2029😀"' },
  ];
  for (const { value, text } of cases) {
    const bytes = new TextEncoder().encode(text).byteLength;
    expect(canonicalJson(value, { maxBytes: bytes })).toBe(text);
    expect(() => canonicalJson(value, { maxBytes: bytes - 1 })).toThrow(TypeError);
    const keyed = { [value]: value };
    const keyedText = `{${text}:${text}}`;
    const keyedBytes = new TextEncoder().encode(keyedText).byteLength;
    expect(canonicalJson(keyed, { maxBytes: keyedBytes })).toBe(keyedText);
    expect(() => canonicalJson(keyed, { maxBytes: keyedBytes - 1 })).toThrow(TypeError);
  }
});

test('canonical JSON byte bounds agree with independent encoder over every UTF-16 code unit', () => {
  const value = Array.from({ length: 2 ** 16 }, (_, unit) => String.fromCharCode(unit)).join(
    '',
  );
  const expected = JSON.stringify(value);
  const bytes = new TextEncoder().encode(expected).byteLength;
  expect(canonicalJson(value, { maxBytes: bytes })).toBe(expected);
  expect(() => canonicalJson(value, { maxBytes: bytes - 1 })).toThrow(TypeError);
});

test('canonical JSON keeps numeric literals, omitted-member nodes and own __proto__ data', () => {
  const value: Record<string, unknown> = { '2': 2, '10': 10 };
  Object.defineProperty(value, '__proto__', { value: { safe: true }, enumerable: true });
  value.optional = undefined;
  expect(canonicalJson(value, { maxNodes: 6 })).toBe(
    '{"10":10,"2":2,"__proto__":{"safe":true}}',
  );
  expect(() => canonicalJson(value, { maxNodes: 5 })).toThrow(TypeError);
  expect(canonicalJson([Number.MIN_VALUE, 1e-7, 1e20, 1e21])).toBe(
    '[5e-324,1e-7,100000000000000000000,1e+21]',
  );
  expect(() => canonicalJson(-0)).toThrow(TypeError);
  expect(serializeCanonicalJson([-0, undefined])).toBe('[0,null]');
});

test('a refusal names whether a limit was exceeded or the value is not JSON', () => {
  const reason = (value: unknown, options?: Parameters<typeof canonicalJson>[1]): unknown => {
    try {
      canonicalJson(value, options);
    } catch (error) {
      if (error instanceof CanonicalJsonError) {
        expect(error).toBeInstanceOf(TypeError);
        return error.reason;
      }
      throw error;
    }
    return 'admitted';
  };
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const nested = { x: { y: 1 } };
  expect(reason(nested, { maxDepth: 1 })).toBe('depth');
  expect(reason(nested, { maxNodes: 2 })).toBe('nodes');
  expect(reason(nested, { maxBytes: 5 })).toBe('bytes');
  expect(reason(-0)).toBe('negative-zero');
  expect(reason(cycle)).toBe('cycle');
  expect(reason(Number.NaN)).toBe('not-json');
  expect(reason(new Date(0))).toBe('not-json');
  expect(reason(nested)).toBe('admitted');
});
